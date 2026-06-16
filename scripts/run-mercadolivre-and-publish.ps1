param(
  [switch]$Visible,   # mostra a janela do Chrome (login/desafios); padrao = invisivel
  [switch]$NoPush     # coleta + regenera dashboard, sem commitar/publicar
)

# Rodamos SEMPRE sob 'Continue': comandos git/node sao nativos e emitem stderr
# benigno (progresso, avisos de CRLF). Sob 'Stop' no PowerShell 5.1 esse stderr
# vira erro terminante e mata o script antes de coletar. Verificamos $LASTEXITCODE
# explicitamente. Sem danca de $ErrorActionPreference (causava erro de null).
# Script em ASCII de proposito: acentos em .ps1 lido sem BOM no PS 5.1 quebram o parser.
$ErrorActionPreference = "Continue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:MERCADOLIVRE_PROFILE_DIR = Join-Path $root ".chrome-mercadolivre-profile"
Set-Location $root

function Fail($msg) { Write-Host "ERRO: $msg" -ForegroundColor Red; exit 1 }

Write-Host "=== Mercado Livre: coleta sob demanda ===" -ForegroundColor Cyan

# Guard anti-rebase-preso (uma rodada anterior pode ter morrido no meio de um rebase).
$gitDir = (git rev-parse --git-dir 2>$null | Out-String).Trim()
if ($gitDir -and ((Test-Path (Join-Path $gitDir "rebase-merge")) -or (Test-Path (Join-Path $gitDir "rebase-apply")))) {
  Write-Host "Rebase incompleto detectado - limpando."
  git rebase --abort 2>$null
}

Write-Host "[1/4] Sincronizando com o remoto..."
git fetch origin
if ($LASTEXITCODE -ne 0) { Fail "git fetch falhou exit $LASTEXITCODE." }
git -c core.editor=true rebase -X theirs origin/main
if ($LASTEXITCODE -ne 0) { git rebase --abort 2>$null; Fail "Falha ao sincronizar com origin/main." }

Write-Host "[2/4] Coletando Mercado Livre - invisivel, pode levar ~15-20 min..." -ForegroundColor Yellow
$mlArgs = @(); if ($Visible) { $mlArgs += "--visible" }
node (Join-Path $PSScriptRoot "monitor-mercadolivre-all.mjs") @mlArgs
$mlExit = $LASTEXITCODE
if ($mlExit -ne 0) { Write-Host "Aviso: coleta terminou com exit $mlExit - cobertura possivelmente parcial." -ForegroundColor Yellow }

Write-Host "[3/4] Regenerando dashboard..."
node (Join-Path $PSScriptRoot "generate-dashboard.mjs")
if ($LASTEXITCODE -ne 0) { Fail "Geracao do dashboard falhou exit $LASTEXITCODE." }

if ($NoPush) { Write-Host "NoPush ativo: dashboard regenerado, nada publicado." -ForegroundColor Yellow; exit 0 }

Write-Host "[4/4] Publicando..."
git add data/mercadolivre-notebooks data/mercadolivre-galaxy-buds4-pro data/mercadolivre-dockstations data/mercadolivre-fitbit-air data/mercadolivre-lifefactory data/mercadolivre-tela-galaxybook3 data/mercadolivre-melanger data/mercadolivre-tenis-42 index.html
if (git diff --staged --quiet) { Write-Host "Nada novo do Mercado Livre para publicar." -ForegroundColor Green; exit 0 }
$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm")
git commit -m "snapshots mercadolivre $stamp" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "git commit falhou exit $LASTEXITCODE." }

for ($attempt = 1; $attempt -le 4; $attempt++) {
  git push origin main
  if ($LASTEXITCODE -eq 0) { Write-Host "Publicado com sucesso." -ForegroundColor Green; exit 0 }
  Write-Host "Push rejeitado tentativa $attempt de 4 - re-sincronizando."
  git fetch origin
  git -c core.editor=true rebase -X theirs origin/main
  if ($LASTEXITCODE -ne 0) { git rebase --abort 2>$null; Fail "Rebase pre-push falhou; estado limpo." }
  node (Join-Path $PSScriptRoot "generate-dashboard.mjs")
  git add index.html
  if (-not (git diff --staged --quiet)) { git commit --amend --no-edit | Out-Null }
}
Fail "git push falhou apos 4 tentativas."
