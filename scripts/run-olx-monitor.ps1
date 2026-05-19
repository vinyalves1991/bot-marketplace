param(
  [int]$Port = 9222,
  [int]$MaxPerCpu = 12,
  [switch]$OpenDetails,
  [switch]$Foreground,
  [switch]$ForceRestartChrome
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$versionUrl = "http://127.0.0.1:$Port/json/version"
function Get-NetstatForPort([int]$p) {
  $out = (& netstat -ano | Select-String -Pattern (":$p\\s") | ForEach-Object { $_.ToString() }) -join "`n"
  if ($out) { return $out }
  return "(nenhuma linha do netstat para :$p)"
}

function Test-Cdp {
  try {
    Invoke-RestMethod -Uri $versionUrl -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-Cdp)) {
  $chromeArgs = @{
    OlxProfile = $true
    Port = $Port
    Url = "https://www.olx.com.br"
    WaitSeconds = 90
  }
  if (-not $Foreground) {
    $chromeArgs.Background = $true
  }
  if ($ForceRestartChrome) {
    $chromeArgs.ForceCloseProfile = $true
  }
  & (Join-Path $PSScriptRoot "start-chrome-debug.ps1") @chromeArgs
}

$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  if (Test-Cdp) {
    break
  }
  Start-Sleep -Seconds 1
}

if (-not (Test-Cdp)) {
  $net = Get-NetstatForPort -p $Port
  throw "Chrome CDP nao ficou disponivel em $versionUrl. netstat :${Port}:`n$net"
}

$npmArgs = @(
  "run",
  "-s",
  "monitor:olx-notebooks-por-cpu",
  "--",
  "--current-chrome",
  "--max-per-cpu",
  "$MaxPerCpu",
  "--listing-only"
)

if ($OpenDetails) {
  $npmArgs = $npmArgs | Where-Object { $_ -ne "--listing-only" }
  $npmArgs += "--open-details"
}

Push-Location $root
try {
  & npm @npmArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Monitor OLX falhou com exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
