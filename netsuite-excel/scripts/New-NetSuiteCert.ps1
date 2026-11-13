#Requires -Version 7.3
<#
.SYNOPSIS
  Creates the EC P-256 key + 730-day self-signed certificate for the NetSuite OAuth 2.0 M2M integration.

.DESCRIPTION
  * The PRIVATE key is never written to disk and never printed. It goes straight into a new 1Password
    item (via stdin, so it never appears in a process argument list).
  * Only the PUBLIC certificate (.pem) is written to disk -- that is the file you upload to NetSuite
    (Setup > Integration > OAuth 2.0 Client Credentials (M2M) Setup).
  * Refuses to run if the 1Password item already exists (archive/rename it first; no silent overwrite).

  Run in `pwsh` (PowerShell 7.3+), not ISE or Windows PowerShell 5.1.
  Prereqs: 1Password CLI signed in (`op signin`), and a vault named 'NetSuite'.

.NOTES
  UNVERIFIED (never run yet): the `op item create` stdin-template form and the field labels. If op rejects
  the template, the script stops before writing anything to disk.
#>
[CmdletBinding()]
param(
    [string]$Vault = 'NetSuite',
    [string]$ItemTitle = 'NetSuite Sandbox M2M',
    [string]$AccountId = '3816459-sb1',
    [ValidateRange(1, 730)][int]$ValidDays = 730,
    [string]$OutDir = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command op -ErrorAction SilentlyContinue)) { throw "1Password CLI ('op') not found. Install it, then run 'op signin'." }

op whoami *> $null
if ($LASTEXITCODE -ne 0) { throw "Not signed in to 1Password. Turn on Settings > Developer > 'Integrate with 1Password CLI', then run 'op signin'." }

# List-based checks: output is JSON metadata only (names/titles), never field values.
$vaultOut = op vault list --format json 2>&1
if ($LASTEXITCODE -ne 0) { throw "Could not list 1Password vaults: $($vaultOut -join ' ')" }
if (-not ($vaultOut | ConvertFrom-Json | Where-Object { $_.name -eq $Vault })) { throw "1Password vault '$Vault' not found. Create it first." }

$itemOut = op item list --vault $Vault --format json 2>&1
if ($LASTEXITCODE -ne 0) { throw "Could not list items in vault '$Vault': $($itemOut -join ' ')" }
$items = try { @($itemOut | ConvertFrom-Json) } catch { @() }  # an empty vault may print nothing or a plain message
if ($items | Where-Object { $_.title -eq $ItemTitle }) { throw "1Password item '$ItemTitle' already exists in vault '$Vault'. Archive or rename it before generating a new key." }

if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) { throw "OutDir '$OutDir' does not exist." }
$certPath = Join-Path $OutDir 'netsuite-sandbox-m2m-public.pem'
if (Test-Path -LiteralPath $certPath) { throw "'$certPath' already exists. Move it first." }

$ecdsa = $null
$template = $null
try {
    $ecdsa = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve]::NamedCurves.nistP256)
    $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=NetSuite Excel Integration (sandbox)', $ecdsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    $notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
    $notAfter = $notBefore.AddDays($ValidDays)
    $cert = $req.CreateSelfSigned($notBefore, $notAfter)

    $certPem = $cert.ExportCertificatePem()
    $template = @{
        title    = $ItemTitle
        category = 'API_CREDENTIAL'
        fields   = @(
            @{ id = 'private_key';    label = 'private_key';    type = 'CONCEALED'; value = $ecdsa.ExportPkcs8PrivateKeyPem() }
            @{ id = 'client_id';      label = 'client_id';      type = 'STRING';    value = 'PENDING' }
            @{ id = 'certificate_id'; label = 'certificate_id'; type = 'STRING';    value = 'PENDING' }
            @{ id = 'account_id';     label = 'account_id';     type = 'STRING';    value = $AccountId }
            @{ id = 'cert_expires';   label = 'cert_expires';   type = 'STRING';    value = $notAfter.UtcDateTime.ToString('yyyy-MM-dd') }
        )
    } | ConvertTo-Json -Depth 5 -Compress

    # Private key goes to 1Password over stdin. Output is discarded: it may echo field values.
    $template | op item create --vault $Vault *> $null
    if ($LASTEXITCODE -ne 0) { throw "op item create failed (exit $LASTEXITCODE). Nothing was written to disk." }

    Set-Content -LiteralPath $certPath -Value $certPem -Encoding ascii
    Write-Host ''
    Write-Host "Created 1Password item '$ItemTitle' in vault '$Vault' (private key stored there; not on disk)." -ForegroundColor Green
    Write-Host "Public certificate: $certPath"
    Write-Host "Certificate expires: $($notAfter.UtcDateTime.ToString('yyyy-MM-dd')) -- put a renewal reminder in your calendar."
    Write-Host ''
    Write-Host 'Next: enable REST Web Services + OAuth 2.0 in NetSuite, create the integration record (Client Credentials/M2M only),'
    Write-Host "save its Client ID to the 'client_id' field, upload the .pem under OAuth 2.0 Client Credentials (M2M) Setup,"
    Write-Host "and save the resulting Certificate ID to the 'certificate_id' field. Then run ./Test-NetSuite.ps1."
}
finally {
    $template = $null
    if ($ecdsa) { $ecdsa.Dispose() }
    [GC]::Collect()
}
