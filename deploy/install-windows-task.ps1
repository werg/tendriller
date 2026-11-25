# Current-user logon task, NOT a Windows SCM service. No password or elevation required.
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory=$true)][string]$AppDirectory,
  [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$TaskName = 'TendrillerAgent',
  [string]$NodeExe = (Get-Command node -CommandType Application -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
$directory = (Resolve-Path -LiteralPath $AppDirectory).Path
$node = (Resolve-Path -LiteralPath $NodeExe).Path
$launcher = Join-Path $directory 'node_modules\@tendriller\tools\bin\tendril.mjs'
foreach ($path in @($launcher, (Join-Path $directory 'tendriller.json'))) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing agent workspace file: $path" }
}
$version = & $node --version
if ($LASTEXITCODE -ne 0 -or ([Version]$version.TrimStart('v')).Major -lt 24) { throw 'The agent program requires Node 24 or newer.' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
# Windows paths cannot contain double quotes. Keep both paths individually quoted.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$launcher`" agent run" -WorkingDirectory $directory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($PSCmdlet.ShouldProcess($TaskName, 'Register current-user agent program logon task (no overwrite)')) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  Write-Host "Registered logon task $TaskName. Start-ScheduledTask -TaskName '$TaskName' starts it now. It runs only while this user is logged on."
}
