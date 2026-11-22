# Current-user logon task, NOT a Windows SCM service. No password or elevation required.
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory=$true)][string]$AppDirectory,
  [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$TaskName = 'TendrillerParticipant',
  [string]$NodeExe = (Get-Command node -CommandType Application -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
$directory = (Resolve-Path -LiteralPath $AppDirectory).Path
$node = (Resolve-Path -LiteralPath $NodeExe).Path
$launcher = Join-Path $directory 'deploy\participant.mjs'
$session = Join-Path $directory 'session.mjs'
foreach ($path in @($launcher, $session)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing participant file: $path" }
}
$version = & $node --version
if ($LASTEXITCODE -ne 0 -or ([Version]$version.TrimStart('v')).Major -lt 24) { throw 'The participant requires Node 24 or newer.' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
# Windows paths cannot contain double quotes. Keep both paths individually quoted.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$launcher`" --session `"$session`"" -WorkingDirectory $directory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($PSCmdlet.ShouldProcess($TaskName, 'Register current-user participant logon task (no overwrite)')) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  Write-Host "Registered logon task $TaskName. Start-ScheduledTask -TaskName '$TaskName' starts it now. It runs only while this user is logged on."
}
