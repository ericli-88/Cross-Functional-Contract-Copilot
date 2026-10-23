param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$Node = "C:\Users\Eric Li\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Pnpm = "C:\Users\Eric Li\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
$Cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$Port = 3000
$BotLog = Join-Path $ProjectRoot "bot-server-current.log"
$BotErrLog = Join-Path $ProjectRoot "bot-server-current.err.log"
$TunnelLog = Join-Path $ProjectRoot "cloudflared.log"

function Assert-File($Path, $Name) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Name not found: $Path"
  }
}

function Get-PortProcess {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
}

function Is-ProjectBotProcess($Process) {
  if (-not $Process) { return $false }
  $cmd = [string]$Process.CommandLine
  return $cmd.Contains("dist/src/index.js") -or $cmd.Contains("dist\src\index.js")
}

function Stop-ProjectBotIfRunning {
  $proc = Get-PortProcess
  if ($proc -and (Is-ProjectBotProcess $proc)) {
    Write-Host "Stopping existing project bot on port $Port, pid $($proc.ProcessId) ..."
    Stop-Process -Id $proc.ProcessId -Force
    Start-Sleep -Seconds 2
  }
}

function Get-LatestTunnelUrl {
  if (-not (Test-Path -LiteralPath $TunnelLog)) { return $null }
  $line = Select-String -Path $TunnelLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -Last 1
  if (-not $line) { return $null }
  return [regex]::Match($line.Line, "https://[a-z0-9-]+\.trycloudflare\.com").Value
}

function Get-EnvValue($Key) {
  $envPath = Join-Path $ProjectRoot ".env"
  $line = [System.IO.File]::ReadAllLines($envPath, [System.Text.Encoding]::UTF8) |
    Where-Object { $_ -like "$Key=*" } |
    Select-Object -First 1
  if (-not $line) { return $null }
  return $line -replace "^$([regex]::Escape($Key))=", ""
}

function Set-EnvValue($Key, $Value) {
  $envPath = Join-Path $ProjectRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) {
    throw ".env not found: $envPath"
  }

  $lines = [System.IO.File]::ReadAllLines($envPath, [System.Text.Encoding]::UTF8)
  $found = $false
  $updated = foreach ($line in $lines) {
    if ($line -match "^$([regex]::Escape($Key))=") {
      $found = $true
      "$Key=$Value"
    } else {
      $line
    }
  }
  if (-not $found) {
    $updated += "$Key=$Value"
  }
  $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($envPath, [string[]]$updated, $Utf8NoBom)
}

function Test-PublicHealth($BaseUrl) {
  if (-not $BaseUrl) { return $false }
  try {
    $public = Invoke-RestMethod -Uri "$BaseUrl/healthz" -TimeoutSec 10
    return [bool]$public.ok
  } catch {
    return $false
  }
}

function Start-CloudflareTunnel {
  if (Test-Path -LiteralPath $TunnelLog) {
    Remove-Item -LiteralPath $TunnelLog -Force
  }
  $args = "tunnel --url http://localhost:$Port --logfile `"$TunnelLog`""
  Start-Process -FilePath $Cloudflared `
    -ArgumentList $args `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden
}

Assert-File $Node "Node"
Assert-File $Pnpm "pnpm"
Assert-File $Cloudflared "cloudflared"
Assert-File (Join-Path $ProjectRoot ".env") ".env"

if ($Restart) {
  Stop-ProjectBotIfRunning
}

Write-Host "Building TypeScript ..."
& $Pnpm build

$portProcess = Get-PortProcess
if ($portProcess) {
  if (Is-ProjectBotProcess $portProcess) {
    Write-Host "Bot is already running on port $Port, pid $($portProcess.ProcessId)."
  } else {
    throw "Port $Port is already used by pid $($portProcess.ProcessId): $($portProcess.CommandLine)"
  }
} else {
  Write-Host "Starting bot on port $Port ..."
  Start-Process -FilePath $Node `
    -ArgumentList @("dist/src/index.js") `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $BotLog `
    -RedirectStandardError $BotErrLog `
    -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

try {
  $local = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 10
  if (-not $local.ok) { throw "healthz did not return ok=true" }
  Write-Host "Local healthz OK: http://127.0.0.1:$Port/healthz"
} catch {
  throw "Local bot health check failed: $($_.Exception.Message)"
}

$existingTunnel = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  Where-Object { ([string]$_.CommandLine).Contains("--url") -and ([string]$_.CommandLine).Contains("localhost:$Port") } |
  Select-Object -First 1

if ($existingTunnel) {
  Write-Host "Cloudflare tunnel is already running, pid $($existingTunnel.ProcessId)."
  $envPublicUrl = Get-EnvValue "PUBLIC_BASE_URL"
  if (Test-PublicHealth $envPublicUrl) {
    $publicUrl = $envPublicUrl
  } else {
    Write-Host "Existing tunnel URL is not reachable. Restarting tunnel ..."
    Stop-Process -Id $existingTunnel.ProcessId -Force
    Start-Sleep -Seconds 2
    Start-CloudflareTunnel
  }
} else {
  Write-Host "Starting Cloudflare tunnel ..."
  Start-CloudflareTunnel
}

for ($i = 0; $i -lt 30; $i++) {
  if ($publicUrl -and (Test-PublicHealth $publicUrl)) { break }
  Start-Sleep -Seconds 2
  $publicUrl = Get-LatestTunnelUrl
  if ($publicUrl) {
    if (Test-PublicHealth $publicUrl) { break }
    $publicUrl = $null
  }
}

if (-not $publicUrl) {
  throw "Could not find a working trycloudflare URL. Check cloudflared.log."
}

Set-EnvValue "PUBLIC_BASE_URL" $publicUrl

$envPath = Join-Path $ProjectRoot ".env"
$tokenLine = [System.IO.File]::ReadAllLines($envPath, [System.Text.Encoding]::UTF8) |
  Where-Object { $_ -like "FEISHU_VERIFICATION_TOKEN=*" } |
  Select-Object -First 1
$token = $tokenLine -replace "^FEISHU_VERIFICATION_TOKEN=", ""
$body = @{ token = $token; challenge = "startup-check"; type = "url_verification" } | ConvertTo-Json
$verify = Invoke-RestMethod -Uri "$publicUrl/feishu/events" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 20
if ($verify.challenge -ne "startup-check") {
  throw "Public Feishu callback verification failed."
}

Write-Host ""
Write-Host "READY."
Write-Host "Feishu callback URL:"
Write-Host "$publicUrl/feishu/events"
Write-Host ""
Write-Host "Next: paste that URL into Feishu Developer Console -> Event and Callback -> Event Subscription -> Request URL."
Write-Host "Then save/publish, and test in the group with:"
$botMentionName = Get-EnvValue "FEISHU_BOT_MENTION_NAME"
if (-not $botMentionName) { $botMentionName = "your bot mention name" }
Write-Host "@$botMentionName + a Feishu contract document link"
