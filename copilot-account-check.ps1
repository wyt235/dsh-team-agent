<#
.SYNOPSIS
  GitHub Copilot account check: which GitHub account the token belongs to,
  and which Copilot SKU (free / individual_pro / business) the token carries.

.DESCRIPTION
  1. GET https://api.github.com/user            -> login name of the token owner
  2. GET https://api.github.com/copilot_internal/v2/token  -> exchanged Copilot token
  3. Parse the semicolon fields of that token (tid, exp, sku, ...)
  Run in YOUR OWN PowerShell window (agent shells have no network here).
#>
param(
    [string]$Token
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

if (-not $Token) {
    $credFile = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
    $m = [regex]::Match((Get-Content $credFile -Raw), 'GITHUB_COPILOT_API_KEY:\s*(\S+)')
    if (-not $m.Success) { throw "No -Token given and GITHUB_COPILOT_API_KEY not found in $credFile" }
    $Token = $m.Groups[1].Value
    Write-Host "Using token from $credFile" -ForegroundColor DarkGray
}

$CopilotHeaders = @{
    'Authorization'          = "Bearer $Token"
    'Accept'                 = 'application/json'
    'User-Agent'             = 'GitHubCopilotChat/0.35.0'
    'Editor-Version'         = 'vscode/1.107.0'
    'Editor-Plugin-Version'  = 'copilot-chat/0.35.0'
    'Copilot-Integration-Id' = 'vscode-chat'
}

# 1. Which GitHub account?
Write-Host ''
Write-Host '== GitHub account ==' -ForegroundColor Cyan
try {
    $user = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $CopilotHeaders -TimeoutSec 20
    Write-Host ("  login : {0}" -f $user.login) -ForegroundColor Green
    Write-Host ("  name  : {0}" -f $user.name)
    Write-Host ("  email : {0}" -f $user.email)
} catch {
    Write-Host "  /user failed: $($_.Exception.Message)" -ForegroundColor Red
}

# 2. Exchange for the Copilot internal token and parse its fields
Write-Host ''
Write-Host '== Copilot subscription (from exchanged token) ==' -ForegroundColor Cyan
try {
    $ct = Invoke-RestMethod -Uri 'https://api.github.com/copilot_internal/v2/token' -Headers $CopilotHeaders -TimeoutSec 20
    $fields = @{}
    foreach ($pair in ($ct.token -split ';')) {
        $kv = $pair -split '=', 2
        if ($kv.Count -eq 2) { $fields[$kv[0]] = $kv[1] }
    }
    foreach ($k in $fields.Keys | Sort-Object) {
        $v = $fields[$k]
        if ($k -eq 'exp') { $v = "$v ($([DateTimeOffset]::FromUnixTimeSeconds([long]$v)).LocalDateTime)" }
        $color = if ($k -eq 'sku') { 'Green' } else { 'Gray' }
        Write-Host ("  {0,-12} = {1}" -f $k, $v) -ForegroundColor $color
    }
    Write-Host ''
    switch -Wildcard ($fields['sku']) {
        '*free*'     { Write-Host '  => This account is on Copilot FREE. No Claude models.' -ForegroundColor Yellow }
        '*pro*'      { Write-Host '  => This account is on Copilot PRO. Claude should be available.' -ForegroundColor Green }
        '*business*' { Write-Host '  => Copilot BUSINESS seat. Claude depends on org policy.' -ForegroundColor Green }
        default      { Write-Host "  => Unknown sku '$($fields['sku'])'." -ForegroundColor Yellow }
    }
} catch {
    Write-Host "  token exchange failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  If this is 403/404, the token may have no Copilot access at all.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'If the login above is NOT the account that has your Pro subscription,' -ForegroundColor Cyan
Write-Host 're-run copilot-device-login.ps1 and authorize with the correct account.' -ForegroundColor Cyan
