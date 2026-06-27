param(
  [int]$MaxPerCpu = 12,
  [switch]$NoNotify,
  [switch]$NoPush,
  [int]$WaitForInternetSeconds = 300
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")

# A tarefa das 07:00 costuma rodar logo apos o PC ligar, quando o Wi-Fi/rede
# ainda nao conectou. Sem isso, o primeiro acesso de rede (git fetch / scraping)
# falharia de imediato. Aqui aguardamos a conectividade ficar disponivel (ate
# WaitForInternetSeconds) antes de comecar; assim que a rede sobe, seguimos.
function Wait-ForInternet {
  param([int]$TimeoutSeconds = 300, [int]$IntervalSeconds = 15)
  $probeHosts = @("github.com", "www.olx.com.br")
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($h in $probeHosts) {
      try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($h, 443, $null, $null)
        $connected = $async.AsyncWaitHandle.WaitOne(4000, $false) -and $client.Connected
        $client.Close()
        if ($connected) { return $true }
      } catch {
        try { $client.Close() } catch {}
      }
    }
    Write-Host "Sem conexao ainda; aguardando ${IntervalSeconds}s e tentando de novo..."
    Start-Sleep -Seconds $IntervalSeconds
  }
  return $false
}

if (-not (Wait-ForInternet -TimeoutSeconds $WaitForInternetSeconds)) {
  Write-Host "Internet indisponivel apos ${WaitForInternetSeconds}s de espera; abortando rodada (a proxima tentara de novo)."
  exit 0
}
Write-Host "Conexao disponivel. Iniciando rodada."

$env:OLX_DATA_DIR = Join-Path $root "data\olx"
$env:ENJOEI_DATA_DIR = Join-Path $root "data\enjoei"
$env:ENJOEI_NOTEBOOKS_DATA_DIR = Join-Path $root "data\enjoei-notebooks"
$env:DOCKSTATIONS_DATA_DIR = Join-Path $root "data\dockstations"
$env:FITBIT_DATA_DIR = Join-Path $root "data\fitbit"
$env:LIFEFACTORY_DATA_DIR = Join-Path $root "data\lifefactory"
$env:TELA_GALAXYBOOK3_DATA_DIR = Join-Path $root "data\tela-galaxybook3"
$env:MELANGER_DATA_DIR = Join-Path $root "data\melanger"
$env:GALAXY_BUDS4_PRO_DATA_DIR = Join-Path $root "data\galaxy-buds4-pro"
$env:OURA_RING5_DATA_DIR = Join-Path $root "data\oura-ring5"
$env:MERCADOLIVRE_PROFILE_DIR = Join-Path $root ".chrome-mercadolivre-profile"
$env:OLX_MAX_PER_CPU = "$MaxPerCpu"

$success = $false

Push-Location $root
try {
  # ── Guard anti-rebase-preso ───────────────────────────────────────────────
  # Se uma rodada anterior morreu no meio de um rebase (ex.: timeout de 20 min
  # da task agendada), o repositorio fica preso em "rebase in progress". Sem
  # limpar, o git commit/push abaixo rodaria sobre um HEAD destacado e corromperia
  # o historico — foi exatamente o que travou as publicacoes em 29/05.
  $gitDir = (git rev-parse --git-dir).Trim()
  if ((Test-Path (Join-Path $gitDir "rebase-merge")) -or (Test-Path (Join-Path $gitDir "rebase-apply"))) {
    Write-Host "Rebase incompleto de uma rodada anterior detectado — abortando para limpar o estado."
    git rebase --abort 2>$null
  }

  # ── Sincronizar com o remoto ──────────────────────────────────────────────
  # index.html e gerado e muda em toda rodada (local e CI), entao conflita com
  # frequencia no rebase. Como ele e regenerado logo abaixo a partir de data/,
  # resolvemos qualquer conflito automaticamente com -X theirs (os dados ficam em
  # pastas separadas — data/olx vs data/enjoei* — e nao conflitam entre si).
  # Qualquer falha inesperada: abortar e sair. NUNCA commitar com rebase pela metade.
  git fetch origin
  if ($LASTEXITCODE -ne 0) { throw "git fetch falhou (exit $LASTEXITCODE)." }

  git -c core.editor=true rebase -X theirs origin/main
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Rebase nao concluiu automaticamente — abortando para nao corromper o historico."
    git rebase --abort 2>$null
    throw "Falha ao sincronizar com origin/main; estado limpo. Rodada abortada (a proxima tentara de novo)."
  }

  # ── Monitor + dashboard (processos node) ──────────────────────────────────
  # Estes scripts node escrevem avisos em stderr (ex.: "Email nao enviado") sem
  # que isso seja uma falha fatal — eles sinalizam erro real apenas via exit code
  # (verificado logo abaixo). Sob $ErrorActionPreference='Stop', porem, qualquer
  # stderr de um comando nativo PODE virar erro terminante (especialmente se a
  # saida for redirecionada/mesclada), abortando a publicacao ANTES do commit e
  # do push — ou seja, perderiamos dados ja coletados so porque o email falhou.
  # Rodamos com 'Continue' e confiamos exclusivamente no $LASTEXITCODE.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  if ($NoNotify) {
    & (Join-Path $PSScriptRoot "run-olx-monitor.ps1") -MaxPerCpu $MaxPerCpu
  } else {
    & node (Join-Path $PSScriptRoot "run-monitors-and-notify.mjs") --only-olx --olx-max-per-cpu $MaxPerCpu
  }
  $monitorExit = $LASTEXITCODE
  if ($monitorExit -ne 0) {
    $ErrorActionPreference = $prevEAP
    throw "Monitor OLX local falhou com exit code $monitorExit."
  }

  if ($NoPush) {
    # Sem publicar: regenera o dashboard localmente apenas para inspecao.
    & node (Join-Path $PSScriptRoot "generate-dashboard.mjs")
    $dashExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($dashExit -ne 0) { throw "Geracao do dashboard falhou com exit code $dashExit." }
    Write-Host "NoPush ativo: dashboard regenerado, nada commitado/publicado."
    $success = $true
    exit 0
  }

  # As operacoes git abaixo emitem avisos benignos em stderr — "LF will be
  # replaced by CRLF" ao indexar index.html, e o progresso do push. Sob
  # ErrorActionPreference='Stop' com a saida redirecionada, esse stderr vira erro
  # terminante e aborta ANTES do commit/push. O que importa e o exit code: rodamos
  # com 'Continue' e verificamos commit/push explicitamente.
  $ErrorActionPreference = 'Continue'

  # (1) Commita os dados coletados localmente (OLX/dockstations/fitbit). O
  # dashboard NAO entra aqui — ele e gerado adiante, ja sincronizado com o CI.
  git add data/olx data/dockstations data/fitbit data/lifefactory data/tela-galaxybook3 data/melanger data/galaxy-buds4-pro data/oura-ring5 data/status data/mercadolivre-notebooks data/mercadolivre-galaxy-buds4-pro data/mercadolivre-dockstations data/mercadolivre-fitbit-air data/mercadolivre-lifefactory data/mercadolivre-tela-galaxybook3 data/mercadolivre-melanger data/mercadolivre-tenis-42
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm")
  $localCommitExists = $false
  if (-not (git diff --staged --quiet)) {
    git commit -m "snapshots olx local $stamp"
    if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; throw "git commit falhou (exit $LASTEXITCODE)." }
    $localCommitExists = $true
  }

  # (2) Publica. O dashboard e regenerado DENTRO do loop, sempre DEPOIS de
  # sincronizar com origin, para refletir tambem o que o CI (Enjoei) publicou
  # durante a nossa coleta. Antes, o dashboard era gerado com dados defasados e o
  # -X theirs fazia o index.html local sobrescrever o do CI — escondendo, p.ex., a
  # queda de preco de um tenis ja coletada pelo CI (incidente 03/06 16h). O push
  # tambem compete com o CI por main, entao re-sincronizamos a cada tentativa.
  $pushed = $false
  for ($attempt = 1; $attempt -le 4 -and -not $pushed; $attempt++) {
    git fetch origin
    if ($LASTEXITCODE -ne 0) { Write-Host "fetch falhou (tentativa $attempt/4); nova tentativa."; Start-Sleep -Seconds 3; continue }

    git -c core.editor=true rebase -X theirs origin/main
    if ($LASTEXITCODE -ne 0) {
      git rebase --abort 2>$null
      $ErrorActionPreference = $prevEAP
      throw "Rebase pre-push falhou; estado limpo. Rodada abortada (a proxima tentara de novo)."
    }

    # Regenera o dashboard com OLX local (ja commitado) + dados do CI recem-trazidos.
    & node (Join-Path $PSScriptRoot "generate-dashboard.mjs")
    if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; throw "Geracao do dashboard falhou (exit $LASTEXITCODE)." }
    git add index.html
    if (-not (git diff --staged --quiet)) {
      if ($localCommitExists) {
        git commit --amend --no-edit
      } else {
        git commit -m "dashboard local $stamp"
        $localCommitExists = $true
      }
      if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; throw "git commit (dashboard) falhou (exit $LASTEXITCODE)." }
    }

    # Nada a publicar (sem dados OLX novos e dashboard identico ao do origin).
    $ahead = [int](git rev-list --count "origin/main..HEAD")
    if ($ahead -eq 0) { Write-Host "Nada novo a publicar."; $pushed = $true; break }

    git push origin main
    if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
    Write-Host "Push rejeitado (tentativa $attempt/4) - re-sincronizando com origin/main."
  }
  if (-not $pushed) { $ErrorActionPreference = $prevEAP; throw "git push falhou apos 4 tentativas." }

  $ErrorActionPreference = $prevEAP

  $success = $true
} finally {
  Pop-Location
  # Registrar timestamp apenas quando a run completou sem erros.
  # O startup-catchup.ps1 usa este arquivo para decidir se deve rodar.
  if ($success) {
    (Get-Date -Format "o") | Set-Content (Join-Path $env:USERPROFILE ".monitor-olx-enjoei-last-run")
    Write-Host "Timestamp registrado: $(Get-Date -Format 'dd/MM HH:mm')"
  }
}
