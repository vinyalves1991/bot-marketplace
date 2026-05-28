<#
.SYNOPSIS
  Disparado pelo Task Scheduler 20 min após o boot do Windows.
  Executa o monitor OLX apenas se o PC estava desligado em um horário agendado
  (ou seja, se a última run foi há mais de 9 horas).

  A lógica de 9h é conservadora:
    - Run das 07:00 → próxima agendada às 16:00 (9h depois)
    - Run das 16:00 → próxima agendada às 07:00 do dia seguinte (15h depois)
  Se a última run foi há <9h, nenhum horário foi perdido → sai sem rodar.
#>

$lastRunFile = Join-Path $env:USERPROFILE ".monitor-olx-enjoei-last-run"
$now = Get-Date

# Evitar conflito com runs agendadas:
# Se estivermos dentro de 35 min antes de 07:00 ou 16:00, a task agendada
# vai disparar sozinha — não fazer catchup agora.
$minOfDay = $now.Hour * 60 + $now.Minute
$near0700 = ($minOfDay -ge (6*60+25) -and $minOfDay -le (7*60+35))   # 06:25–07:35
$near1600 = ($minOfDay -ge (15*60+25) -and $minOfDay -le (16*60+35)) # 15:25–16:35

if ($near0700 -or $near1600) {
    Write-Host "$(Get-Date -Format 'HH:mm') — Dentro da janela de run agendada (07h ou 16h). Catchup ignorado."
    exit 0
}

# Verificar quando foi a última execução
if (Test-Path $lastRunFile) {
    try {
        $lastRun = [datetime]::Parse((Get-Content $lastRunFile -Raw).Trim())
        $horas   = ($now - $lastRun).TotalHours
        Write-Host "Última run: $($lastRun.ToString('dd/MM HH:mm')) ($([math]::Round($horas, 1))h atrás)"
        if ($horas -lt 9) {
            Write-Host "Menos de 9h — nenhum horário perdido. Catchup desnecessário."
            exit 0
        }
        Write-Host "Mais de 9h — PC estava desligado num horário agendado. Disparando catchup."
    } catch {
        Write-Host "Não foi possível ler o timestamp ($($_.Exception.Message)) — disparando catchup por precaução."
    }
} else {
    Write-Host "Sem registro de run anterior — disparando catchup."
}

& (Join-Path $PSScriptRoot "run-local-olx-and-publish.ps1")
