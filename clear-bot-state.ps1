param(
  [switch]$ClearOwners,
  [switch]$NoBackup
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $ProjectRoot "data"
$StatePath = Join-Path $DataDir "chat-bot-state.json"

if (-not (Test-Path -LiteralPath $StatePath)) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $State = [pscustomobject]@{
    contracts = @()
    owners = [pscustomobject]@{}
    lastContractSequence = 0
    processedMessageEvents = @()
  }
} else {
  if (-not $NoBackup) {
    $Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $BackupPath = Join-Path $DataDir "chat-bot-state.backup-$Stamp.json"
    Copy-Item -LiteralPath $StatePath -Destination $BackupPath
  }

  try {
    $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  } catch {
    $State = [pscustomobject]@{
      contracts = @()
      owners = [pscustomobject]@{}
      lastContractSequence = 0
      processedMessageEvents = @()
    }
  }
}

$Owners = if ($ClearOwners) { [pscustomobject]@{} } else { $State.owners }
if ($null -eq $Owners) { $Owners = [pscustomobject]@{} }

$CleanState = [ordered]@{
  contracts = @()
  owners = $Owners
  lastContractSequence = 0
  processedMessageEvents = @()
}

$Json = $CleanState | ConvertTo-Json -Depth 100
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($StatePath, $Json + [Environment]::NewLine, $Utf8NoBom)

Write-Host "Bot state cleared."
Write-Host "State file: $StatePath"
if ($BackupPath) {
  Write-Host "Backup file: $BackupPath"
}
Write-Host "Owners cleared: $($ClearOwners.IsPresent)"
