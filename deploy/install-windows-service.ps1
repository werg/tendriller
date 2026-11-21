# Register a Tendriller participant as a native Windows Service (requires Administrator PowerShell)
param(
  [Parameter(Mandatory=$true)][string]$AppDirectory,
  [string]$ServiceName = "TendrillerParticipant",
  [string]$NodeExe = (Get-Command node).Source
)
$ErrorActionPreference = "Stop"
$script = Join-Path (Resolve-Path $AppDirectory) "session.mjs"
if (-not (Test-Path $script)) { throw "Missing session.mjs in $AppDirectory" }
New-Service -Name $ServiceName -BinaryPathName "`"$NodeExe`" `"$script`"" -DisplayName "Tendriller Participant ($ServiceName)" -StartupType Automatic
Write-Host "Registered Windows service $ServiceName. Start with: Start-Service $ServiceName"
