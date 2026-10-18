#Requires -Version 5.1
<#
    Apex Launcher backend - one-shot setup for a Windows server.

    Paste this into an ADMINISTRATOR PowerShell window on the machine that will
    host the website:

      irm https://raw.githubusercontent.com/Kudsi-k7el/apex-launcher/main/server/setup.ps1 | iex

    It installs whatever is missing, puts the code in C:\apex, registers the
    backend to start with Windows, and can bring up a Cloudflare Tunnel so the
    site has a public HTTPS address.

    Nothing here is destructive and every step checks before it acts, so running
    it a second time after a failure is safe - it picks up where it stopped.

    Running the file rather than piping it, these switches are available:

      -InstallDir C:\apex         where the code goes
      -Hostname apex.example.com  a permanent hostname (needs a Cloudflare login)
      -QuickTunnel                a temporary trycloudflare.com address instead
      -SkipTunnel                 backend only, no tunnel
      -AdminEmail you@example.com turns on the /admin console for that account
      -Update                     refresh the code, keeping the database

    The administrator's email is written to server\apex.env, which run.cmd reads
    before it starts Node. It is deliberately not part of the repository, and it
    survives -Update, so a code refresh never costs you the console.

    Note on ASCII: this file is deliberately written without any non-ASCII
    characters. Windows PowerShell 5.1 reads a .ps1 as ANSI unless it carries a
    UTF-8 byte-order mark, so an arrow or a curly quote here would arrive as
    mojibake exactly where it matters.
#>

[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\apex',
  [string]$Hostname = '',
  [switch]$QuickTunnel,
  [switch]$SkipTunnel,
  [string]$AdminEmail = '',
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoZip        = 'https://codeload.github.com/Kudsi-k7el/apex-launcher/zip/refs/heads/main'
$CloudflaredUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
$TaskName       = 'Apex Launcher backend'
$LocalUrl       = 'http://127.0.0.1:8787'

function Step { param($n, $m) Write-Host ''; Write-Host "[$n] $m" -ForegroundColor Cyan }
function Ok   { param($m)    Write-Host "  ok  $m" -ForegroundColor Green }
function Say  { param($m)    Write-Host "      $m" -ForegroundColor Gray }
function Warn { param($m)    Write-Host "  !!  $m" -ForegroundColor Yellow }
function Die  { param($m)    Write-Host ''; Write-Host "Stopped: $m" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

# Node is the only real prerequisite: the database is Node's own node:sqlite, so
# there is no npm install and nothing else to fetch.
function Get-NodeMajor {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
  try { return [int]((& node --version).Trim().TrimStart('v').Split('.')[0]) } catch { return 0 }
}

Write-Host ''
Write-Host 'Apex Launcher - backend setup' -ForegroundColor White

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Die 'run this in an Administrator window (right-click PowerShell, Run as administrator).'
}
Ok 'running as administrator'

# ---------------------------------------------------------------------------
Step 1 'Node.js'
# ---------------------------------------------------------------------------
if ((Get-NodeMajor) -ge 24) {
  Ok "already installed ($(& node --version))"
} else {
  $installed = $false

  # Prefer the official MSI over winget: it is the same installer Node publishes,
  # it does not depend on the Microsoft Store being present, and it is a fixed
  # URL rather than a package id whose meaning can change.
  Say 'finding the current Node LTS'
  $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $lts = $index |
    Where-Object { $_.lts -and ([int]($_.version.TrimStart('v').Split('.')[0]) -ge 24) } |
    Select-Object -First 1

  if ($lts) {
    $ver = $lts.version
    $msi = Join-Path $env:TEMP "node-$ver-x64.msi"
    Say "downloading Node $ver (about 30 MB)"
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-x64.msi" -OutFile $msi -UseBasicParsing
    Say 'installing (this takes a minute or two and shows no progress)'
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    Refresh-Path
    $installed = (Get-NodeMajor) -ge 24
  }

  if (-not $installed) {
    Die 'Node could not be installed automatically. Install the LTS from https://nodejs.org by hand, then run this script again - it will skip straight past this step.'
  }
  Ok "installed ($(& node --version))"
}

# ---------------------------------------------------------------------------
Step 2 "The code, in $InstallDir"
# ---------------------------------------------------------------------------
$HaveCode = Test-Path (Join-Path $InstallDir 'server\server.js')
if ($HaveCode -and -not $Update) {
  Ok 'already there - leaving it alone (pass -Update to refresh it)'
} else {
  $zip = Join-Path $env:TEMP 'apex-launcher.zip'
  $unpack = Join-Path $env:TEMP ('apex-unpack-' + [guid]::NewGuid().ToString('n'))
  Say 'downloading the repository'
  Invoke-WebRequest $RepoZip -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $unpack -Force
  # A GitHub zip always has one top-level folder named <repo>-<branch>; the
  # contents are what we want, not the folder.
  $inner = Get-ChildItem $unpack -Directory | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  if ($HaveCode) {
    # An update replaces code and nothing else. The database and apex.env are not
    # in the zip at all, so copying over the top of them cannot touch them - but
    # say it out loud, because this is the step where silence is frightening.
    Say 'refreshing the code (-Update); server\data and server\apex.env are kept'
  }
  Copy-Item (Join-Path $inner.FullName '*') $InstallDir -Recurse -Force
  Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path (Join-Path $InstallDir 'server\server.js'))) {
    Die "the download did not look like the repository. Remove $InstallDir and try again."
  }
  Ok "copied to $InstallDir"
}

$ServerDir = Join-Path $InstallDir 'server'
$RunCmd = Join-Path $ServerDir 'run.cmd'

# ---------------------------------------------------------------------------
Step 3 'Configuration'
# ---------------------------------------------------------------------------
# The one setting a deployed machine owns: which account may open /admin. It goes
# in a file the repository does not carry, which run.cmd reads before starting
# Node, so it survives every -Update and never lands in git.
$EnvFile = Join-Path $ServerDir 'apex.env'
if ($AdminEmail) {
  Set-Content -Path $EnvFile -Value "APEX_ADMIN_EMAIL=$AdminEmail" -Encoding ASCII
  Ok "admin console enabled for $AdminEmail"
  Say "  the console is at  http://127.0.0.1:8787/admin"
} elseif (Test-Path $EnvFile) {
  Ok "keeping the existing $EnvFile"
  foreach ($line in (Get-Content $EnvFile)) { Say "  $line" }
} else {
  Say 'no administrator configured, so the /admin console stays switched off'
  Say '  re-run with  -AdminEmail you@example.com  to turn it on'
}

# ---------------------------------------------------------------------------
Step 4 'cloudflared'
# ---------------------------------------------------------------------------
$Cloudflared = Join-Path $InstallDir 'bin\cloudflared.exe'
if ($SkipTunnel) {
  Say 'skipped (-SkipTunnel)'
} elseif (Test-Path $Cloudflared) {
  Ok 'already downloaded'
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $Cloudflared) | Out-Null
  Say 'downloading Cloudflare''s tunnel client (about 20 MB)'
  Invoke-WebRequest $CloudflaredUrl -OutFile $Cloudflared -UseBasicParsing
  Ok "saved to $Cloudflared"
}

# ---------------------------------------------------------------------------
Step 5 'Start the backend with Windows'
# ---------------------------------------------------------------------------
if (-not (Test-Path $RunCmd)) { Die "$RunCmd is missing - step 2 did not put the code where expected." }

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Ok 'the scheduled task is already registered - updating it'
  # Registering does not restart a task that is already running, so a code
  # refresh or a new apex.env would sit there unread until the next reboot.
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

$action = New-ScheduledTaskAction -Execute $RunCmd -WorkingDirectory $ServerDir
$trigger = New-ScheduledTaskTrigger -AtStartup
# SYSTEM rather than a named account: it needs no stored password, so the task
# keeps running after a reboot whether or not anybody logs in.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$settings.ExecutionTimeLimit = 'PT0S'   # PT0S means "no limit" to the Task Scheduler

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Ok "registered as '$TaskName' and started"

# ---------------------------------------------------------------------------
Step 6 'Is it answering?'
# ---------------------------------------------------------------------------
$health = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod "$LocalUrl/health" -TimeoutSec 2
    if ($health.ok) { break }
    $health = $null
  } catch { $health = $null }
}

if ($health) {
  Ok "$LocalUrl is serving (accounts so far: $($health.accounts))"
} else {
  Warn "$LocalUrl is not answering."
  Say 'The task history usually says why. Try:'
  Say "  Get-ScheduledTaskInfo -TaskName '$TaskName' | Format-List"
  Say "  & `"$RunCmd`"        # run it by hand to see the error"
  Say 'If node was only just installed, the machine may need a new PATH - reboot and it will come up.'
}

# ---------------------------------------------------------------------------
Step 7 'A public HTTPS address'
# ---------------------------------------------------------------------------
$PublicUrl = ''

if ($SkipTunnel) {
  Say 'skipped (-SkipTunnel)'
} elseif ($Hostname) {
  Say "setting up a permanent tunnel for $Hostname"
  & $Cloudflared tunnel login
  & $Cloudflared tunnel create apex

  # config.yml has to name the tunnel by id and point at the credentials file
  # cloudflared just wrote.
  $wanted = Join-Path $env:USERPROFILE '.cloudflared'
  $list = & $Cloudflared tunnel list --output json | ConvertFrom-Json
  $tunnel = $list | Where-Object { $_.name -eq 'apex' } | Select-Object -First 1
  if (-not $tunnel) { Die 'cloudflared did not produce a tunnel called apex - see the output above.' }

  $config = Join-Path $wanted 'config.yml'
  @(
    "# Written by server/setup.ps1",
    "tunnel: $($tunnel.id)",
    "credentials-file: $wanted\$($tunnel.id).json",
    '',
    'ingress:',
    "  - hostname: $Hostname",
    "    service: $LocalUrl",
    '  - service: http_status:404',
    ''
  ) | Set-Content -Path $config -Encoding ASCII

  & $Cloudflared tunnel route dns apex $Hostname
  # The Windows service runs as SYSTEM, whose profile is not ours, so the config
  # path is passed explicitly rather than left to be discovered.
  & $Cloudflared --config $config service install
  Ok "tunnel 'apex' installed as a service for $Hostname"
  $PublicUrl = "https://$Hostname"

} elseif ($QuickTunnel) {
  Say 'starting a temporary tunnel'
  $errlog = Join-Path $env:TEMP 'apex-tunnel.log'
  $outlog = Join-Path $env:TEMP 'apex-tunnel-out.log'
  Remove-Item $errlog, $outlog -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $Cloudflared `
    -ArgumentList 'tunnel', '--url', $LocalUrl, '--no-autoupdate' `
    -RedirectStandardError $errlog -RedirectStandardOutput $outlog -WindowStyle Hidden

  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $text = (Get-Content $errlog -Raw -ErrorAction SilentlyContinue) +
            (Get-Content $outlog -Raw -ErrorAction SilentlyContinue)
    $m = [regex]::Match([string]$text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) { $PublicUrl = $m.Value; break }
  }

  if ($PublicUrl) {
    Ok "temporary address: $PublicUrl"
    Warn 'this address changes every time cloudflared restarts, so it is for testing, not for the launcher.'
  } else {
    Warn "could not read the address out of $errlog - open it and look for the https:// line."
  }

} else {
  Say 'not configured. Two options:'
  Say '  cloudflared tunnel login   then re-run with  -Hostname apex.yourdomain.com'
  Say '  or re-run with  -QuickTunnel  for a throwaway trycloudflare.com address'
}

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Done.' -ForegroundColor White
Say "backend      $LocalUrl"
Say "code         $InstallDir"
Say "accounts     $InstallDir\server\data\apex.db   <- back this up"
if ($PublicUrl) {
  Say "public       $PublicUrl"
  Write-Host ''
  Write-Host "Check it from outside:  curl.exe -s $PublicUrl/health" -ForegroundColor Gray
}
Write-Host ''
Write-Host 'That is the whole install step - there is no npm install to run.' -ForegroundColor Gray
if (Test-Path $EnvFile) {
  Write-Host "Admin console:  http://127.0.0.1:8787/admin  (only $(Get-Content $EnvFile -Raw).Trim() gets in)" -ForegroundColor Gray
  Write-Host 'Reach it from outside at  <public address>/admin' -ForegroundColor Gray
}
Write-Host ''
