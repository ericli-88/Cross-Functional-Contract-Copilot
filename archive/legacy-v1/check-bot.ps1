$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$Pnpm = "C:\Users\Eric Li\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
$Port = 3000

function Read-EnvValue($Key) {
  $line = Get-Content -LiteralPath (Join-Path $ProjectRoot ".env") |
    Where-Object { $_ -like "$Key=*" } |
    Select-Object -First 1
  if (-not $line) { return $null }
  return $line -replace "^$([regex]::Escape($Key))=", ""
}

Write-Host "Checking port $Port ..."
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
  Write-Host "Port $Port is listening. PID: $($proc.ProcessId)"
  Write-Host "Command: $($proc.CommandLine)"
} else {
  Write-Host "Port $Port is NOT listening."
}

try {
  $local = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 10
  Write-Host "Local healthz: PASS"
} catch {
  Write-Host "Local healthz: FAIL - $($_.Exception.Message)"
}

$publicBaseUrl = Read-EnvValue "PUBLIC_BASE_URL"
if ($publicBaseUrl) {
  try {
    $public = Invoke-RestMethod -Uri "$publicBaseUrl/healthz" -TimeoutSec 20
    Write-Host "Public healthz: PASS"
  } catch {
    Write-Host "Public healthz: FAIL - $($_.Exception.Message)"
  }

  $token = Read-EnvValue "FEISHU_VERIFICATION_TOKEN"
  if ($token) {
    try {
      $body = @{ token = $token; challenge = "check-bot"; type = "url_verification" } | ConvertTo-Json
      $verify = Invoke-RestMethod -Uri "$publicBaseUrl/feishu/events" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 20
      if ($verify.challenge -eq "check-bot") {
        Write-Host "Feishu callback verification: PASS"
      } else {
        Write-Host "Feishu callback verification: FAIL"
      }
    } catch {
      Write-Host "Feishu callback verification: FAIL - $($_.Exception.Message)"
    }
  }
  Write-Host "Feishu callback URL: $publicBaseUrl/feishu/events"
} else {
  Write-Host "PUBLIC_BASE_URL is missing in .env."
}

Write-Host ""
Write-Host "Running full diagnose ..."
& $Pnpm diagnose
