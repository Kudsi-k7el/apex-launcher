@echo off
REM ---------------------------------------------------------------------------
REM Starts the Apex backend the way a deployed server wants it.
REM
REM   * loopback only - nothing on the internet talks to Node directly, so there
REM     is no port to open in Windows Firewall and no HTTP-exposed API;
REM   * APEX_TRUST_PROXY=1 - Cloudflare Tunnel (or Caddy/nginx) terminates TLS,
REM     so the scheme and the caller's IP arrive in headers. Without this the
REM     per-IP rate limit sees every visitor as 127.0.0.1 and the session cookie
REM     is not marked Secure.
REM
REM This is the file a Task Scheduler entry should run. Using a script rather
REM than a long command line keeps the quoting out of the scheduler UI.
REM ---------------------------------------------------------------------------
cd /d "%~dp0"
set "APEX_HOST=127.0.0.1"
set "APEX_PORT=8787"
set "APEX_TRUST_PROXY=1"
node "%~dp0server.js"
