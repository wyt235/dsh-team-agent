<#
.SYNOPSIS
  GitHub Copilot: list models available on your account and enable all catalog models.

.DESCRIPTION
  Replicates what pi-ai does after OAuth login:
    1. GET  /models                 -> which models your plan/policy actually allows
    2. POST /models/{id}/policy     -> { state: "enabled" } for every catalog model
  Run this in YOUR OWN PowerShell window (agent-sandboxed shells have no network here).

.PARAMETER Token
  The gho_/ghu_ Copilot OAuth token. If omitted, read from ~/.dsh/.credentials.yaml
  (GITHUB_COPILOT_API_KEY).
#>
param(
    [string]$Token,
    [string]$Proxy   # e.g. 'http://127.0.0.1:7890' to route through a local proxy
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

$Headers = @{
    'Authorization'          = "Bearer $Token"
    'Accept'                 = 'application/json'
    'User-Agent'             = 'GitHubCopilotChat/0.35.0'
    'Editor-Version'         = 'vscode/1.107.0'
    'Editor-Plugin-Version'  = 'copilot-chat/0.35.0'
    'Copilot-Integration-Id' = 'vscode-chat'
    'X-GitHub-Api-Version'   = '2026-06-01'
}
$Base = 'https://api.individual.githubcopilot.com'

$ProxyArgs = @{}
if ($Proxy) {
    $ProxyArgs['Proxy'] = $Proxy
    Write-Host "Routing through proxy: $Proxy" -ForegroundColor DarkGray
}

function Show-Models($Title) {
    Write-Host ''
    Write-Host "== $Title ==" -ForegroundColor Cyan
    $resp = Invoke-RestMethod -Uri "$Base/models" -Headers $Headers -TimeoutSec 30 @ProxyArgs
    foreach ($item in $resp.data) {
        $picker = $item.model_picker_enabled
        $policy = $item.policy.state
        $tools  = $item.capabilities.supports.tool_calls
        $line   = "  {0,-28} picker={1,-5} policy={2,-10} tools={3}" -f $item.id, $picker, $policy, $tools
        if ($picker -and $policy -ne 'disabled' -and $tools -ne $false) {
            Write-Host $line -ForegroundColor Green
        } else {
            Write-Host $line -ForegroundColor DarkGray
        }
    }
}

# Catalog ids from pi-ai (github-copilot.json)
$CatalogIds = @(
    'claude-haiku-4.5','claude-opus-4.5','claude-opus-4.6','claude-opus-4.7','claude-opus-4.8',
    'claude-opus-5','claude-sonnet-4','claude-sonnet-4.5','claude-sonnet-4.6','claude-sonnet-5',
    'claude-fable-5','gemini-2.5-pro','gemini-3-flash-preview','gemini-3.1-pro-preview',
    'gemini-3.5-flash','gpt-4.1','kimi-k2.7-code',
    'gpt-5-mini','gpt-5.2','gpt-5.2-codex','gpt-5.3-codex','gpt-5.4','gpt-5.4-mini','gpt-5.4-nano',
    'gpt-5.5','gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','mai-code-1-flash-picker'
)

Show-Models 'Models BEFORE enabling'

Write-Host ''
Write-Host 'Enabling all catalog models (accepting per-model policy)...' -ForegroundColor Cyan
foreach ($id in $CatalogIds) {
    try {
        $r = Invoke-WebRequest -Method Post -Uri "$Base/models/$id/policy" `
             -Headers ($Headers + @{ 'Content-Type' = 'application/json'; 'openai-intent' = 'chat-policy'; 'x-interaction-type' = 'chat-policy' }) `
             -Body '{"state":"enabled"}' -TimeoutSec 15 -UseBasicParsing
        Write-Host ("  {0,-28} -> {1}" -f $id, $r.StatusCode) -ForegroundColor Green
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        Write-Host ("  {0,-28} -> failed {1} {2}" -f $id, $code, $_.Exception.Message) -ForegroundColor DarkYellow
    }
}

Show-Models 'Models AFTER enabling (green = usable in DSH)'

Write-Host ''
Write-Host 'Pick a GREEN model id and set it in DSH: Settings > Models > github-copilot.' -ForegroundColor Cyan
Write-Host 'The ids you configured (claude-opus-4.6 etc.) must appear green above to work.' -ForegroundColor Cyan
