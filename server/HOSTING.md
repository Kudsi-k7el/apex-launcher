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

In the launcher: **Settings → Account → Server address**, or the URL field on
the sign-in gate. Enter `https://apex.example.com`.

A fresh install on someone else's machine still defaults to
`http://127.0.0.1:8787`, so they would have to type the public address once. If
you want it baked in as the default for everyone, that is a small change to
`DEFAULT_SERVER` in `auth.js` plus the two defaults in `main.js` — ask and it
will be done alongside a version bump, so the change ships in a release.

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
