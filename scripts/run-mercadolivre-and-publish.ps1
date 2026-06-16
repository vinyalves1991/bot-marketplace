param(
  [switch]$Visible,   # mostra a janela do Chrome (login/desafios); padrão = invisível
  [switch]$NoPush     # coleta + regenera dashboard, sem commitar/publicar
)

# As operações git/node abaixo são nativas e emitem stderr benigno (progresso do
# fetch, avisos de CRLF, etc.). Sob ErrorActionPreference='Stop' no PowerShell 5.1,
# esse stderr vira erro TERMINANTE e aborta o script ANTES de coletar — era a causa
# do "não deu certo" (o run morria no git fetch/rebase do topo). Rodamos sob
# 'Continue' e verificamos $LASTEXITCODE explicitamente (os `throw` continuam
# funcionando normalmente, pois throw é sempre terminante).
$ErrorActionPreference = "Continue"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$env:MERCADOLIVRE_PROFILE_DIR = Join-Path $root ".chrome-mercadolivre-profile"

Write-Host "=== Mercado Livre: coleta sob demanda ===" -ForegroundColor Cyan

Push-Location $root
try {
  # Guard anti-rebase-preso (mesmo cuidado do fluxo do OLX).
  $gitDir = (git rev-parse --git-dir).Trim()
  if ((Test-Path (Join-Path $gitDir "rebase-merge")) -or (Test-Path (Join-Path $gitDir "rebase-apply"))) {
    Write-Host "Rebase incompleto detectado — abortando para limpar o estado."
    git rebase --abort 2>$null
  }

  # Sincroniza com o remoto antes de coletar (index.html e dados podem ter mudado).
  git fetch origin
  if ($LASTEXITCODE -ne 0) { throw "git fetch falhou (exit $LASTEXITCODE)." }
  git -c core.editor=true rebase -X theirs origin/main
  if ($LASTEXITCODE -ne 0) {
    git rebase --abort 2>$null
    throw "Falha ao sincronizar com origin/main; estado limpo."
  }

  # Coleta o Mercado Livre. Sob 'Continue' para não abortar por stderr benigno
  # dos processos node; confiamos no exit code.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $mlArgs = @()
  if ($Visible) { $mlArgs += "--visible" }
  & node (Join-Path $PSScriptRoot "monitor-mercadolivre-all.mjs") @mlArgs
  $mlExit = $LASTEXITCODE
  if ($mlExit -ne 0) { Write-Host "Aviso: o monitor ML terminou com exit $mlExit (cobertura possivelmente parcial)." -ForegroundColor Yellow }

  # Regenera o dashboard com os dados frescos do ML (+ OLX/Enjoei já sincronizados).
  & node (Join-Path $PSScriptRoot "generate-dashboard.mjs")
  if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; throw "Geração do dashboard falhou (exit $LASTEXITCODE)." }

  if ($NoPush) {
    Write-Host "NoPush ativo: dashboard regenerado, nada publicado." -ForegroundColor Yellow
    $ErrorActionPreference = $prevEAP
    return
  }

  # Publica: commit dos dados ML + index.html, com re-sincronização a cada tentativa.
  git add data/mercadolivre-notebooks data/mercadolivre-galaxy-buds4-pro data/mercadolivre-dockstations data/mercadolivre-fitbit-air data/mercadolivre-lifefactory data/mercadolivre-tela-galaxybook3 data/mercadolivre-melanger data/mercadolivre-tenis-42 index.html
  if (git diff --staged --quiet) {
    Write-Host "Nada novo do Mercado Livre para publicar." -ForegroundColor Green
    $ErrorActionPreference = $prevEAP
    return
  }
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm")
  git commit -m "snapshots mercadolivre $stamp" | Out-Null
  if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; throw "git commit falhou (exit $LASTEXITCODE)." }

  $pushed = $false
  for ($attempt = 1; $attempt -le 4 -and -not $pushed; $attempt++) {
    git push origin main
    if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
    Write-Host "Push rejeitado (tentativa $attempt/4) — re-sincronizando."
    git fetch origin
    if ($LASTEXITCODE -ne 0) { Start-Sleep -Seconds 3; continue }
    git -c core.editor=true rebase -X theirs origin/main
    if ($LASTEXITCODE -ne 0) { git rebase --abort 2>$null; $ErrorActionPreference = $prevEAP; throw "Rebase pré-push falhou; estado limpo." }
    # Regenera o dashboard após o rebase (pode ter vindo dado novo do CI/OLX).
    & node (Join-Path $PSScriptRoot "generate-dashboard.mjs")
    git add index.html
    if (-not (git diff --staged --quiet)) { git commit --amend --no-edit | Out-Null }
  }
  $ErrorActionPreference = $prevEAP
  if (-not $pushed) { throw "git push falhou após 4 tentativas." }
  Write-Host "Publicado com sucesso." -ForegroundColor Green
} finally {
  Pop-Location
}
