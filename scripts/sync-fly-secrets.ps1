param(
  [string]$EnvFile = "C:\Users\chris\primary-freight-dashboard\freight-dashboard\.env",
  [string]$AppName = "fivenines-ops"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Error "Env file not found at '$EnvFile'. Pass -EnvFile <path-to-.env>."
  exit 1
}

$parsed = @{}
foreach ($rawLine in Get-Content -LiteralPath $EnvFile) {
  $line = $rawLine.Trim()
  if (-not $line -or $line.StartsWith("#")) { continue }
  $eqIdx = $line.IndexOf("=")
  if ($eqIdx -lt 1) { continue }
  $k = $line.Substring(0, $eqIdx).Trim()
  if ($k.StartsWith("export ")) { $k = $k.Substring(7).Trim() }
  $v = $line.Substring($eqIdx + 1).Trim()
  if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
    if ($v.Length -ge 2) {
      $v = $v.Substring(1, $v.Length - 2)
    }
  }
  $parsed[$k] = $v
}

$taiKeyName = ("TAI", "API", "KEY") -join "_"
$keysToSync = @(
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TAI_WEBHOOK_SECRET",
  $taiKeyName
)

$secretPairs = New-Object System.Collections.Generic.List[string]
$syncedNames = New-Object System.Collections.Generic.List[string]
$missingNames = New-Object System.Collections.Generic.List[string]

foreach ($key in $keysToSync) {
  if ($parsed.ContainsKey($key) -and -not [string]::IsNullOrWhiteSpace($parsed[$key])) {
    $secretPairs.Add("$key=$($parsed[$key])")
    $syncedNames.Add($key)
  } else {
    $missingNames.Add($key)
  }
}

$secretPairs.Add("ALLOW_LIVE_TAI_WRITES=true")
$secretPairs.Add("TAI_WRITEBACK_POLLER_ENABLED=true")

if ($syncedNames.Count -eq 0) {
  Write-Error "None of the expected keys were found in '$EnvFile'."
  exit 1
}

Write-Host "Syncing secrets to Fly app '$AppName': $($syncedNames -join ', '), ALLOW_LIVE_TAI_WRITES, TAI_WRITEBACK_POLLER_ENABLED"
if ($missingNames.Count -gt 0) {
  Write-Warning "Not found (or empty) in '$EnvFile': $($missingNames -join ', ')"
}

& flyctl secrets set -a $AppName @secretPairs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host "Done syncing secrets to $AppName."
