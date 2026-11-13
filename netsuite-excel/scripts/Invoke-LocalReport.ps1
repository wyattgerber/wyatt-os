#Requires -Version 7.1
<#
.SYNOPSIS
  Runs one report through the real API code against the NetSuite sandbox, from your PC (no Azure needed).

.DESCRIPTION
  Secrets are read from 1Password into environment variables of THIS process only, and cleared afterwards.
  Nothing secret is written to disk or printed. The full result (financial data) is written to api\out\
  which is gitignored -- do not copy it into the repo or share it.

  Needs Node 20+ (node -v). The API is plain JavaScript, so there is nothing to build or install.
  Keep the 1Password app unlocked. Do not call `op whoami` in this script (it breaks the next op call here).

.EXAMPLE
  ./Invoke-LocalReport.ps1 -Report gl_detail -Params @{ fromPeriod = 'Oct 2026'; toPeriod = 'Oct 2026' }
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('trial_balance', 'journal_entries', 'gl_detail', 'ar_aging', 'ap_aging')][string]$Report,
    [hashtable]$Params = @{},
    [string]$Vault = 'NetSuite',
    [string]$Item = 'Excel Addin Connection',
    [string]$User = (git config user.email),
    [string]$OutFile,
    # Corporate HTTPS inspection: make Node trust the Windows certificate store, like PowerShell does (Node 22.15+).
    [switch]$UseWindowsCertificates
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js not found. Install Node 20 or newer (node -v), then retry.' }
if (-not (Get-Command op -ErrorAction SilentlyContinue)) { throw "1Password CLI ('op') not found." }
if ([string]::IsNullOrWhiteSpace($User)) { throw 'Pass -User <your work email> (it must match what you sign in with; it is only used for the audit line here).' }

$apiDir = Join-Path $PSScriptRoot '..\api' | Resolve-Path
$cli = Join-Path $apiDir 'src\cli.js'   # plain JavaScript: no build or install needed to run a report

function Get-OpField([string]$Field) {
    $v = op read "op://$Vault/$Item/$Field" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not read 1Password field '$Field' (is the app unlocked?)." }
    $t = ($v -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($t) -or $t -eq 'PENDING') { throw "1Password field '$Field' is empty or PENDING." }
    return $t
}

if (-not $OutFile) { $OutFile = Join-Path $apiDir "out\$Report-$(Get-Date -Format 'yyyyMMdd-HHmmss').json" }
$envNames = 'NETSUITE_ACCOUNT_ID', 'NETSUITE_CLIENT_ID', 'NETSUITE_CERTIFICATE_ID', 'NETSUITE_PRIVATE_KEY', 'ALLOWED_USERS', 'CLI_USER_EMAIL', 'CLI_OUT', 'NETSUITE_MOCK'
try {
    $env:NETSUITE_ACCOUNT_ID = Get-OpField 'account_id'
    $env:NETSUITE_CLIENT_ID = Get-OpField 'client_id'
    $env:NETSUITE_CERTIFICATE_ID = Get-OpField 'certificate_id'
    $env:NETSUITE_PRIVATE_KEY = Get-OpField 'private_key'
    $env:ALLOWED_USERS = $User
    $env:CLI_USER_EMAIL = $User
    $env:CLI_OUT = $OutFile
    Remove-Item Env:NETSUITE_MOCK -ErrorAction SilentlyContinue   # real NetSuite, never mock

    $argList = @($cli, $Report) + ($Params.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" })
    $oldNodeOptions = $env:NODE_OPTIONS
    if ($UseWindowsCertificates) { $env:NODE_OPTIONS = (@($env:NODE_OPTIONS, '--use-system-ca') | Where-Object { $_ }) -join ' ' }
    try { node @argList } finally { $env:NODE_OPTIONS = $oldNodeOptions }
    $code = $LASTEXITCODE
}
finally {
    foreach ($n in $envNames) { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
}
exit $code
