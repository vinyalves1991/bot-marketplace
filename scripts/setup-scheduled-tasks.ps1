param(
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$root          = Resolve-Path (Join-Path $PSScriptRoot "..")
$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source

$taskNames  = @("Monitor-OLX-0700", "Monitor-OLX-1600", "Monitor-OLX-Catchup")
$legacyName = "Monitor-OLX-Local-Publish"  # nome antigo — removido automaticamente

if ($Remove) {
    foreach ($name in ($taskNames + $legacyName)) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Removido (se existia): $name"
    }
    Write-Host "Pronto. Nenhuma task ativa."
    exit 0
}

# Remover task legada caso exista
Unregister-ScheduledTask -TaskName $legacyName -Confirm:$false -ErrorAction SilentlyContinue

$mainScript    = Join-Path $root "scripts\run-local-olx-and-publish.ps1"
$catchupScript = Join-Path $root "scripts\startup-catchup.ps1"

$makeArg = { param($file)
    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$file`""
}

$mainAction = New-ScheduledTaskAction `
    -Execute $powershellExe `
    -Argument (& $makeArg $mainScript) `
    -WorkingDirectory $root

$catchupAction = New-ScheduledTaskAction `
    -Execute $powershellExe `
    -Argument (& $makeArg $catchupScript) `
    -WorkingDirectory $root

# Configurações das tasks principais:
# - Sem StartWhenAvailable: o catchup cuida de runs perdidas por desligamento
# - MultipleInstances IgnoreNew: evita rodar em paralelo se a anterior ainda estiver rodando
$mainSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -MultipleInstances IgnoreNew

# ── Task 1: 07:00 ────────────────────────────────────────────────────────────
$t0700 = New-ScheduledTaskTrigger -Daily -At "07:00"
Register-ScheduledTask `
    -TaskName "Monitor-OLX-0700" `
    -Action $mainAction `
    -Trigger $t0700 `
    -Settings $mainSettings `
    -RunLevel Limited `
    -Force | Out-Null

# ── Task 2: 16:00 ────────────────────────────────────────────────────────────
$t1600 = New-ScheduledTaskTrigger -Daily -At "16:00"
Register-ScheduledTask `
    -TaskName "Monitor-OLX-1600" `
    -Action $mainAction `
    -Trigger $t1600 `
    -Settings $mainSettings `
    -RunLevel Limited `
    -Force | Out-Null

# ── Task 3: Catchup pós-boot (20 min de delay) ───────────────────────────────
# Dispara 20 minutos após o Windows inicializar.
# O script startup-catchup.ps1 verifica se a última run foi há >9h antes de rodar.
$tBoot = New-ScheduledTaskTrigger -AtStartup
$tBoot.Delay = "PT20M"

$catchupSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName "Monitor-OLX-Catchup" `
    -Action $catchupAction `
    -Trigger $tBoot `
    -Settings $catchupSettings `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host ""
Write-Host "Tarefas registradas com sucesso:"
Write-Host "  Monitor-OLX-0700    — todo dia as 07:00 (se o PC estiver ligado)"
Write-Host "  Monitor-OLX-1600    — todo dia as 16:00 (se o PC estiver ligado)"
Write-Host "  Monitor-OLX-Catchup — 20 min apos o boot (so roda se ultima run > 9h atras)"
Write-Host ""
Write-Host "VARIAVEL DE AMBIENTE NECESSARIA — execute uma vez no terminal:"
Write-Host ""
Write-Host '  setx GMAIL_APP_PASSWORD "sua-senha-de-app-gmail"'
Write-Host ""
Write-Host "  (as demais — CALLMEBOT_PHONE, CALLMEBOT_APIKEY, GMAIL_USER — ja"
Write-Host "   tem valores padrao hardcoded no script e nao precisam ser definidas)"
Write-Host ""
Write-Host "Para remover todas as tarefas:"
Write-Host "  .\scripts\setup-scheduled-tasks.ps1 -Remove"
