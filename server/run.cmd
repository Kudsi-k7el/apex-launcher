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
REM This is the file the "Apex Launcher backend" scheduled task runs. Using a
REM script rather than a long command line keeps the quoting out of the
REM scheduler UI.
REM ---------------------------------------------------------------------------
cd /d "%~dp0"

REM A scheduled task that dies silently is a miserable thing to debug, so say
REM plainly what is missing rather than letting cmd.exe print its own message.
where node >nul 2>nul
if errorlevel 1 (
  echo Node was not found on PATH. Install Node 24 or newer from https://nodejs.org
  exit /b 1
)

set "APEX_HOST=127.0.0.1"
set "APEX_PORT=8787"
set "APEX_TRUST_PROXY=1"
node "%~dp0server.js"
