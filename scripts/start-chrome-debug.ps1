param(
  [string]$ProfileDirectory = "Default",
  [string]$UserDataDir = "$env:LOCALAPPDATA\Google\Chrome\User Data",
  [int]$Port = 9222,
  [string]$Url = "https://gemini.google.com/app",
  [int]$WaitSeconds = 60,
  [switch]$RestoreLastSession,
  [switch]$ListProfiles,
  [switch]$AutomationProfile,
  [switch]$OlxProfile,
  [switch]$ForceCloseProfile,
  [switch]$Background
)

$ErrorActionPreference = "Stop"

$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

if ($AutomationProfile) {
  $UserDataDir = Join-Path $workspaceRoot ".chrome-gemini-cdp-profile"
  $ProfileDirectory = "Default"
}

if ($OlxProfile) {
  $UserDataDir = Join-Path $workspaceRoot ".chrome-olx-profile"
  $ProfileDirectory = "Default"
}

$localState = Join-Path $userDataDir "Local State"

if ($ListProfiles) {
  if (-not (Test-Path -LiteralPath $localState)) {
    throw "Chrome Local State nao encontrado em $localState."
  }

  $json = Get-Content -LiteralPath $localState -Raw | ConvertFrom-Json
  $json.profile.info_cache.PSObject.Properties | ForEach-Object {
    [pscustomobject]@{
      Directory = $_.Name
      Name = $_.Value.name
      UserName = $_.Value.user_name
    }
  } | Format-Table -AutoSize
  exit 0
}

$chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path -LiteralPath $chrome)) {
  $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
}

if (-not (Test-Path -LiteralPath $chrome)) {
  throw "Chrome nao encontrado nos caminhos padrao."
}

$versionUrl = "http://127.0.0.1:$Port/json/version"
function Test-Cdp {
  try {
    Invoke-RestMethod -Uri $versionUrl -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-ChromeProcessesForUserDataDir([string]$dir) {
  $needle = ("--user-data-dir=`"{0}`"" -f $dir).ToLowerInvariant()
  Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) } |
    ForEach-Object {
      [pscustomobject]@{
        ProcessId = $_.ProcessId
        CommandLine = $_.CommandLine
      }
    }
}

try {
  if (-not (Test-Cdp)) {
    throw "CDP nao respondeu."
  }
  Write-Host "Chrome ja esta com depuracao remota ativa em 127.0.0.1:$Port."
  exit 0
} catch {
  Write-Host "Porta $Port ainda nao esta ativa."
}

if ($ForceCloseProfile) {
  $procs = @(Get-ChromeProcessesForUserDataDir -dir $UserDataDir)
  if ($procs.Count -gt 0) {
    Write-Host "Fechando instancias de Chrome que estao usando o perfil: $UserDataDir"
    $procs | ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      } catch {
        Write-Host "Aviso: nao foi possivel encerrar PID $($_.ProcessId): $($_.Exception.Message)"
      }
    }
    Start-Sleep -Seconds 2
  }
}

Write-Host "Se ja houver Chrome aberto usando o MESMO perfil sem depuracao remota, feche apenas essas janelas antes de continuar."
Write-Host "Abrindo Chrome com perfil '$ProfileDirectory' e depuracao remota local..."

$arguments = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$UserDataDir`"",
  "--profile-directory=`"$ProfileDirectory`""
)

if ($RestoreLastSession) {
  $arguments += "--restore-last-session"
}

if ($Background) {
  $arguments += @(
    "--window-position=-32000,-32000",
    "--window-size=1280,900",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding"
  )
}

if ($Url) {
  $arguments += $Url
}

$startParams = @{
  FilePath = $chrome
  ArgumentList = ($arguments -join " ")
}

if ($Background) {
  $startParams.WindowStyle = "Minimized"
}

$proc = Start-Process @startParams -PassThru

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-Cdp) {
    Write-Host "Chrome CDP ficou disponivel em $versionUrl (PID $($proc.Id))."
    exit 0
  }
  Start-Sleep -Seconds 1
}

$netstat = (& netstat -ano | Select-String -Pattern (":$Port\\s") | ForEach-Object { $_.ToString() }) -join "`n"
if (-not $netstat) { $netstat = "(nenhuma linha do netstat para :$Port)" }

throw @"
Chrome CDP nao ficou disponivel em $versionUrl apos ${WaitSeconds}s.
PID iniciado: $($proc.Id)
UserDataDir: $UserDataDir
netstat :${Port}:
$netstat
"@
