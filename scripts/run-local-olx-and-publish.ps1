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
  git fetch origin main
  git pull --rebase origin main

  if ($NoNotify) {
    & (Join-Path $PSScriptRoot "run-olx-monitor.ps1") -MaxPerCpu $MaxPerCpu
  } else {
    & node (Join-Path $PSScriptRoot "run-monitors-and-notify.mjs") --only-olx --olx-max-per-cpu $MaxPerCpu
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Monitor OLX local falhou com exit code $LASTEXITCODE."
  }

  & node (Join-Path $PSScriptRoot "generate-dashboard.mjs")
  if ($LASTEXITCODE -ne 0) {
    throw "Geracao do dashboard falhou com exit code $LASTEXITCODE."
  }

  if ($NoPush) {
    Write-Host "NoPush ativo: nao vou commitar nem publicar."
    $success = $true
    exit 0
  }

  git add data/olx index.html
  if (-not (git diff --staged --quiet)) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm")
    git commit -m "snapshots olx local $stamp"
    git push origin main
  } else {
    Write-Host "Sem mudancas OLX para publicar."
  }

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
