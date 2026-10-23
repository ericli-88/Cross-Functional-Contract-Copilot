$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot
$Port = 3000

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
  $cmd = [string]$proc.CommandLine
  if ($cmd.Contains("dist/src/index.js") -or $cmd.Contains("dist\src\index.js")) {
    Write-Host "Stopping bot pid $($proc.ProcessId) ..."
    Stop-Process -Id $proc.ProcessId -Force
  } else {
    Write-Host "Port $Port is used by another process. Not stopping it."
    Write-Host $cmd
  }
} else {
  Write-Host "Bot is not listening on port $Port."
}

$tunnels = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  Where-Object { ([string]$_.CommandLine).Contains("--url") -and ([string]$_.CommandLine).Contains("localhost:$Port") }
foreach ($tunnel in $tunnels) {
  Write-Host "Stopping cloudflared pid $($tunnel.ProcessId) ..."
  Stop-Process -Id $tunnel.ProcessId -Force
}

Write-Host "Stopped project bot/tunnel if they were running."
