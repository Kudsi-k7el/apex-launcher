# Hosting the Apex website and accounts API

The backend is one zero-dependency Node process that does two jobs at once: it
serves the companion website **and** answers the `/auth/*` + `/profile` API that
the launcher signs in against. Because both live on one origin, the session
cookie just works and there is no CORS to configure.

That means "hosting the website" is really "keep one Node process running, with
TLS in front of it".

---

## What you need

| Thing | Why |
|---|---|
| **Node 24 or newer** | The database is Node's built-in `node:sqlite`. Older Node will refuse to start and say so. |
| **cloudflared** | Provides the public HTTPS address without opening any inbound port. |
| A domain on Cloudflare | For a stable hostname. Without one you get a random `*.trycloudflare.com` URL that changes on every restart. |

The launcher requires **HTTPS** for any address that is not `127.0.0.1`. Plain
HTTP to a public IP is refused on purpose, so a tunnel or a real certificate is
not optional once you go public.

---

## 1. Get the code onto the machine

Only two folders matter — `server/` and `website/`. The installer is a GitHub
Release asset, so `dist/` is not needed here at all.

```powershell
git clone https://github.com/Kudsi-k7el/apex-launcher C:\apex
```

(No git on the box? Use **Code → Download ZIP** on the repo page and extract it
to `C:\apex`.)

## 2. Try it locally first

```powershell
cd C:\apex
node server\server.js
```

Open <http://127.0.0.1:8787>. You should get the website, and
<http://127.0.0.1:8787/health> should answer with `"ok": true`.

## 3. Put it behind Cloudflare Tunnel

**Quick test, no account, no domain:**

```powershell
cloudflared tunnel --url http://127.0.0.1:8787
```

It prints a `https://something-random.trycloudflare.com` address. That address
changes every time you restart it, so it is a smoke test and nothing more.

**The real thing** (needs the domain added to a Cloudflare account):

```powershell
cloudflared tunnel login
cloudflared tunnel create apex
cloudflared tunnel route dns apex apex.example.com
```

Then write `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: apex
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-uuid>.json

ingress:
  - hostname: apex.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run it once in the foreground to confirm it works, then install it as a service
so it survives a reboot:

```powershell
cloudflared --config "%USERPROFILE%\.cloudflared\config.yml" service install
```

> If the installed service cannot find the config, point it at the file
> explicitly with `--config` as above, or copy `config.yml` next to wherever the
> service runs. Cloudflare's own docs are the reference here — this is the one
> step that could not be exercised while the project was built.

## 4. Keep the Node server running

`server\run.cmd` already carries the right settings — loopback only, and
trusting the proxy headers. That last part matters: Cloudflare terminates TLS, so
without it every visitor looks like `127.0.0.1` to the rate limiter, and the
session cookie is not marked `Secure`.

Create a scheduled task:

1. **Task Scheduler → Create Task**
2. **General** → *Run whether user is logged on or not* (and *Run with highest
   privileges* is fine, but not required).
3. **Triggers** → New → *At startup*.
4. **Actions** → Start a program → `C:\apex\server\run.cmd`.
5. **Settings** → tick *If the task fails, restart every* `1 minute`, and untick
   *Stop the task if it runs longer than*.

### Not opening any ports

Node listens on `127.0.0.1:8787` — loopback only. `cloudflared` makes an
**outbound** connection to Cloudflare and traffic comes back down that tunnel.
Nothing needs to be opened in Windows Firewall, and there is no directly exposed
API to attack.

---

## 5. Point the launcher at it

A released build has the server address compiled into it — there is no server
field in the launcher any more, on purpose, so a signed-in account cannot be
pointed at somebody else's API. The one source of truth is `DEFAULT_SERVER` in
`src/js/auth.js`, and `main.js` forces it onto every load.

So the launcher and the website have to live at the same address. If you move the
site to a new hostname, change `DEFAULT_SERVER`, bump the version and cut a
release; every install picks it up on the next launch.

For a local run the address is `http://127.0.0.1:8787`, which needs no TLS.

---

## 6. The admin console

Set `APEX_ADMIN_EMAIL` and `/admin` exists; leave it unset and `/admin` is an
ordinary 404 — not a locked door, no door:

```powershell
node server\server.js --admin-email you@example.com
# or, on a deployed machine, re-run the setup script:
.\server\setup.ps1 -AdminEmail you@example.com
```

The setup script writes `server\apex.env`, which `run.cmd` reads before starting
Node, so the setting survives `-Update`.

**There is no admin password.** Access is decided by one question: is the email
of the session making this request in `APEX_ADMIN_EMAIL`? Sign in with that
account — the same sign-in as the launcher and the website — and the console
opens. Any other account, signed in or not, gets nothing.

| Panel | What it answers |
|---|---|
| **Overview** | Account and session counts, a 14-day signup chart, and every kind of event the server has logged. |
| **Accounts** | Search by name, email, display name or id; open one to see its sessions, its activity, and its synced launcher profile. Disable, enable, reset the password, or delete it. |
| **Sessions** | Every live session with its account, address and user agent. Revoke one and that client is signed out on its next request. |
| **Audit log** | Signups, sign-ins, failed sign-ins, password changes and every action the console itself took — filterable by kind. |
| **Queries** | A read-only SQL console over the same database. |

Notes worth knowing:

- The SQL console is read-only because SQLite itself opened the connection
  read-only, not because a filter looks for suspicious words. A `DELETE` is
  refused by the engine. Five hundred rows at most, one statement at a time.
- Disabling an account also drops its live sessions, so a ban takes effect
  immediately rather than in thirty days.
- Resetting a password signs that account out everywhere.
- An administrator account cannot be disabled or deleted from the console, so
  there is no way to lock yourself out by clicking. To revoke an admin's access,
  take the address out of `APEX_ADMIN_EMAIL` and restart.
- Deleting an account needs its name typed in first.
- No password hash ever leaves the database. Every admin response goes through a
  row shape with the hash and salt already dropped.

---

## Operating it

**Check it is alive**

```powershell
curl.exe -s https://apex.example.com/health
```

**Where the accounts live**

```
C:\apex\server\data\apex.db      (+ -wal and -shm alongside it)
```

That one file *is* your user base. Back it up.

**Backing up** — stop the scheduled task first so nothing is mid-write, then
copy all three files (`.db`, `.db-wal`, `.db-shm`) somewhere else, then start the
task again.

**Changing the port or path** — everything has an environment variable, which is
easier to manage than a command line:

| Variable | Default | Purpose |
|---|---|---|
| `APEX_HOST` | `127.0.0.1` | Interface to bind. Leave on loopback behind a tunnel. |
| `APEX_PORT` | `8787` | Port. |
| `APEX_DB` | `server\data\apex.db` | Where the SQLite file goes. |
| `APEX_TRUST_PROXY` | off | Set to `1` behind Cloudflare/Caddy/nginx. |
| `APEX_ALLOW_ORIGINS` | empty | Comma-separated origins allowed to call the API cross-origin. Not needed when the site is served from this same server. |
| `APEX_ADMIN_EMAIL` | empty | Who may open `/admin`. Comma-separate for more than one; empty turns the console off entirely. Also `--admin-email`. |

**Rate limits** are per-IP once `APEX_TRUST_PROXY` is on: 40 credential requests
per 10 minutes per address, and failed logins are additionally limited to 10 per
15 minutes per email address.

---

## Checking a deployment is healthy

```powershell
curl.exe -s  https://apex.example.com/health                     # {"ok":true,...}
curl.exe -sI https://apex.example.com/ | Select-Object -First 1  # HTTP/2 200
```

Then, in a browser, sign up once on the site. If the account survives a page
reload, the cookie is being set correctly — which is the thing most likely to go
wrong behind a proxy.

With `APEX_ADMIN_EMAIL` set, <https://apex.example.com/admin> should show a
sign-in form, and signing in with an account that is *not* the administrator
should be politely refused rather than let in.
