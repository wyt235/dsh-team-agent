<#
.SYNOPSIS
  GitHub Copilot device-flow login: prints a gho_ OAuth token to paste into
  DSH Settings > Models > github-copilot > API key.

.NOTES
  Mirrors pi-ai's github-copilot OAuth device flow (VS Code Copilot Chat public client id).
  Requires a GitHub account with an active Copilot subscription (free tier works).
  ASCII-only output so the file runs identically under powershell 5.1 (GBK) and pwsh 7.
#>

$ErrorActionPreference = 'Stop'

# CLIENT_ID from pi-ai source (base64 "SXYxLmI1MDdhMDhjODdlY2ZlOTg=")
$ClientId = 'Iv1.b507a08c87ecfe98'

function Post-Form($Url, $Body) {
    Invoke-RestMethod -Method Post -Uri $Url `
        -Headers @{ 'Accept' = 'application/json'; 'User-Agent' = 'GitHubCopilotChat/0.35.0' } `
        -ContentType 'application/x-www-form-urlencoded' `
        -Body $Body
}

# Step 1: request a device code
Write-Host 'Requesting device code from GitHub...' -ForegroundColor Cyan
$device = Post-Form 'https://github.com/login/device/code' @{
    client_id = $ClientId
    scope     = 'read:user'
}

if (-not $device.device_code -or -not $device.user_code) {
    throw "Unexpected device-code response: $($device | ConvertTo-Json -Compress)"
}

Write-Host ''
Write-Host '==================================================' -ForegroundColor Yellow
Write-Host "  1. Open in browser:  $($device.verification_uri)" -ForegroundColor Yellow
Write-Host "  2. Enter this code:  $($device.user_code)" -ForegroundColor Yellow
Write-Host '  3. Sign in with a GitHub account that has Copilot' -ForegroundColor Yellow
Write-Host '==================================================' -ForegroundColor Yellow
Write-Host ''

try { Start-Process $device.verification_uri } catch { }

# Step 2: poll until authorized
$interval = [math]::Max([int]$device.interval, 5)
$deadline = (Get-Date).AddSeconds([int]$device.expires_in)
Write-Host "Waiting for authorization (up to $([int]$device.expires_in)s, polling every ${interval}s)..."

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $interval
    $resp = Post-Form 'https://github.com/login/oauth/access_token' @{
        client_id   = $ClientId
        device_code = $device.device_code
        grant_type  = 'urn:ietf:params:oauth:grant-type:device_code'
    }

    if ($resp.access_token) {
        Write-Host ''
        Write-Host 'Authorized. Your GitHub Copilot token:' -ForegroundColor Green
        Write-Host ''
        Write-Host "  $($resp.access_token)" -ForegroundColor Green
        Write-Host ''
        Write-Host 'Paste it into DSH Settings > Models > github-copilot > API key, then save.' -ForegroundColor Cyan
        try { Set-Clipboard $resp.access_token; Write-Host '(copied to clipboard)' -ForegroundColor DarkGray } catch { }
        exit 0
    }

    switch ($resp.error) {
        'authorization_pending' { continue }
        'slow_down'             { $interval += 5; Write-Host "GitHub asked to slow down; interval now ${interval}s"; continue }
        default                 { throw "Device flow failed: $($resp.error) $($resp.error_description)" }
    }
}

throw 'Timed out: the device code expired. Re-run the script.'
