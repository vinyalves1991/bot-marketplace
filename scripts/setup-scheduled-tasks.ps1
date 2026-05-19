param(
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$taskName = "Monitor-Notebooks-Tenis"
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$scriptPath = Join-Path $root "scripts\run-monitors-and-notify.mjs"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarefa removida: $taskName"
  exit 0
}

$action = New-ScheduledTaskAction `
  -Execute $nodeExe `
  -Argument $scriptPath `
  -WorkingDirectory $root

$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At "07:00"),
  (New-ScheduledTaskTrigger -Daily -At "12:00"),
  (New-ScheduledTaskTrigger -Daily -At "20:00")
)

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -RunLevel Limited `
  -Force | Out-Null

Write-Host "Tarefa registrada: $taskName"
Write-Host "Triggers: 07:00, 12:00, 20:00"
Write-Host ""
Write-Host "Variaveis de ambiente necessarias (rode uma vez no terminal):"
Write-Host '  setx GMAIL_APP_PASSWORD "sua-senha-de-app"'
Write-Host '  setx GMAIL_USER "docrash@gmail.com"'
Write-Host '  setx NOTIFY_EMAIL_TO "docrash@gmail.com"'
Write-Host ""
Write-Host "Para remover: .\scripts\setup-scheduled-tasks.ps1 -Remove"
