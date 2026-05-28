param(
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$taskName = "Monitor-OLX-Local-Publish"
$scriptPath = Join-Path $root "scripts\run-local-olx-and-publish.ps1"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarefa removida: $taskName"
  exit 0
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`"" `
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
