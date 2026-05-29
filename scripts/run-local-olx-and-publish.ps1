param(
  [int]$MaxPerCpu = 12,
  [switch]$NoNotify,
  [switch]$NoPush
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")

$env:OLX_DATA_DIR = Join-Path $root "data\olx"
$env:ENJOEI_DATA_DIR = Join-Path $root "data\enjoei"
$env:ENJOEI_NOTEBOOKS_DATA_DIR = Join-Path $root "data\enjoei-notebooks"
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

  & node (Join-Path $PSScriptRoot "generate-dashboard.mjs")
  $dashExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  if ($dashExit -ne 0) {
    throw "Geracao do dashboard falhou com exit code $dashExit."
  }

  if ($NoPush) {
    Write-Host "NoPush ativo: nao vou commitar nem publicar."
    $success = $true
    exit 0
  }

  # As operacoes git abaixo emitem avisos benignos em stderr — "LF will be
  # replaced by CRLF" ao indexar index.html, e o progresso do push. Sob
  # ErrorActionPreference='Stop' com a saida redirecionada, esse stderr vira erro
  # terminante e aborta ANTES do commit/push. O que importa e o exit code: rodamos
  # com 'Continue' e verificamos commit/push explicitamente.
  $ErrorActionPreference = 'Continue'
  git add data/olx index.html
  if (-not (git diff --staged --quiet)) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm")
    git commit -m "snapshots olx local $stamp"
    if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; throw "git commit falhou (exit $LASTEXITCODE)." }
    git push origin main
    if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; throw "git push falhou (exit $LASTEXITCODE)." }
  } else {
    Write-Host "Sem mudancas OLX para publicar."
  }
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
