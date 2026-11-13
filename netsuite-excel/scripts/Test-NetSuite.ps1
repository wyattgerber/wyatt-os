#Requires -Version 7.1
<#
.SYNOPSIS
  Proves the NetSuite sandbox integration works and is read-only.

.DESCRIPTION
  Test 1  Oct 2026 posting-line totals vs the reconciliation target, plus a breakdown by transaction type
          (use it to spot transaction types the API_User role cannot see).
  Test 2  Is the accountingperiod table visible? (Blocks the real trial balance.)
  Test 3a Writing a customer must be REJECTED.   (sandbox only)
  Test 3b Writing an account must be REJECTED.   (sandbox only)

  Secrets come from 1Password (op read). The private key and access token are never printed or written to disk.
  Run in `pwsh` 7.1+ with the 1Password CLI signed in.

.NOTES
  UNVERIFIED (never run yet). Expect to debug the first run together.
#>
[CmdletBinding()]
param(
    [string]$Vault = 'NetSuite',
    [string]$Item = 'NetSuite Sandbox M2M',
    [int]$ExpectedCount = 2230,
    [decimal]$ExpectedAmount = 42216073.43d,  # 'd' = real decimal literal; a plain 42216073.43 is a double and picks up float noise
    [string]$StartDate = '2026-10-01',
    [string]$EndDate = '2026-10-31',
    [switch]$SkipWriteTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$inv = [System.Globalization.CultureInfo]::InvariantCulture

function ConvertTo-Base64Url([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }

function Get-OpField([string]$Field) {
    $v = op read "op://$Vault/$Item/$Field" 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($v)) { throw "Could not read 1Password field '$Field' from '$Item' (vault '$Vault'). Is it filled in and are you signed in (op signin)?" }
    if ($v -eq 'PENDING') { throw "1Password field '$Field' is still PENDING. Fill it in first." }
    return ($v -join "`n").Trim()
}

function ConvertTo-Dec($v) {
    if ($null -eq $v -or "$v" -eq '') { return [decimal]0 }
    # NetSuite can return numbers in scientific notation (e.g. 3.572068025E7), so allow exponents.
    return [decimal]::Parse([string]::Format($inv, '{0}', $v), [System.Globalization.NumberStyles]::Float, $inv)
}

$results = [System.Collections.Generic.List[object]]::new()
function Add-Result([string]$Test, [string]$Status, [string]$Detail) {
    $results.Add([pscustomobject]@{ Test = $Test; Status = $Status; Detail = $Detail })
    $color = switch ($Status) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'Yellow' } }
    Write-Host ("[{0}] {1} - {2}" -f $Status, $Test, $Detail) -ForegroundColor $color
}

$pem = $null; $ecdsa = $null; $token = $null
try {
    $accountId = Get-OpField 'account_id'
    $clientId = Get-OpField 'client_id'
    $certId = Get-OpField 'certificate_id'
    $pem = Get-OpField 'private_key'

    $hostName = "$($accountId.ToLowerInvariant().Replace('_', '-')).suitetalk.api.netsuite.com"
    $base = "https://$hostName"
    $isSandbox = $hostName -match '-sb\d*\.suitetalk'
    Write-Host "Host: $base  (sandbox: $isSandbox)"

    # ---- OAuth 2.0 M2M: ES256 client-assertion JWT ----
    $ecdsa = [System.Security.Cryptography.ECDsa]::Create()
    $ecdsa.ImportFromPem($pem)
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = @{ alg = 'ES256'; typ = 'JWT'; kid = $certId } | ConvertTo-Json -Compress
    $claims = @{ iss = $clientId; scope = @('rest_webservices'); aud = "$base/services/rest/auth/oauth2/v1/token"; iat = $now; exp = $now + 3300 } | ConvertTo-Json -Compress
    $signingInput = (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($header))) + '.' + (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($claims)))
    $sig = $ecdsa.SignData([Text.Encoding]::UTF8.GetBytes($signingInput), [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation)
    $assertion = "$signingInput." + (ConvertTo-Base64Url $sig)

    $tokenResp = Invoke-RestMethod -Method Post -Uri "$base/services/rest/auth/oauth2/v1/token" -ContentType 'application/x-www-form-urlencoded' `
        -SkipHttpErrorCheck -StatusCodeVariable tokenStatus -Body @{
            grant_type            = 'client_credentials'
            client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
            client_assertion      = $assertion
        }
    if ($tokenStatus -ne 200) {
        $err = if ($tokenResp -is [string]) { $tokenResp } else { ($tokenResp | Select-Object error, error_description | ConvertTo-Json -Compress) }
        throw "Token request failed (HTTP $tokenStatus): $err"
    }
    $token = $tokenResp.access_token
    Add-Result 'Auth' 'PASS' 'Got an access token via client-credentials (M2M).'

    function Invoke-Ns([string]$Method, [string]$Path, $Body = $null, [hashtable]$ExtraHeaders = @{}) {
        $h = @{ Authorization = "Bearer $token" } + $ExtraHeaders
        $p = @{ Method = $Method; Uri = "$base$Path"; Headers = $h; SkipHttpErrorCheck = $true; StatusCodeVariable = 'sc'; ResponseHeadersVariable = 'rh' }
        if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 6 -Compress); $p.ContentType = 'application/json' }
        $r = Invoke-RestMethod @p
        [pscustomobject]@{ Status = $sc; Body = $r; Headers = $rh }
    }
    function Invoke-SuiteQL([string]$Sql, [int]$Limit = 1000) {
        Invoke-Ns 'POST' "/services/rest/query/v1/suiteql?limit=$Limit" @{ q = $Sql } @{ Prefer = 'transient' }
    }
    function Format-NsError($r) { if ($r.Body -is [string]) { $r.Body } else { ($r.Body | ConvertTo-Json -Depth 5 -Compress) } }

    # ---- Test 1: Oct 2026 totals + breakdown by type ----
    $from = "FROM transactionaccountingline tal INNER JOIN transaction t ON t.id = tal.transaction " +
            "WHERE tal.posting = 'T' AND tal.accountingbook = 1 AND t.trandate >= TO_DATE('$StartDate','YYYY-MM-DD') AND t.trandate <= TO_DATE('$EndDate','YYYY-MM-DD')"
    $t1 = Invoke-SuiteQL "SELECT COUNT(*) AS cnt, SUM(tal.debit) AS debits, SUM(tal.credit) AS credits $from"
    if ($t1.Status -ne 200) {
        Add-Result 'Test 1 totals' 'FAIL' "HTTP $($t1.Status): $(Format-NsError $t1)"
    }
    else {
        $row = $t1.Body.items[0]
        $cnt = [int](ConvertTo-Dec $row.cnt); $d = ConvertTo-Dec $row.debits; $c = ConvertTo-Dec $row.credits
        # NetSuite SUMs are floating point; compare at cents and show the raw values so any noise is visible.
        $dr = [math]::Round($d, 2); $cr = [math]::Round($c, 2)
        $ok = ($cnt -eq $ExpectedCount) -and ($dr -eq $ExpectedAmount) -and ($cr -eq $ExpectedAmount)
        Write-Host "Raw from NetSuite: cnt=$($row.cnt) debits=$($row.debits) credits=$($row.credits)"
        if (($d -ne $dr) -or ($c -ne $cr)) { Write-Host 'NOTE: raw sums have more than 2 decimals (floating-point noise). The API rounds totals to cents to compare.' -ForegroundColor Yellow }
        $detail = "lines=$cnt (expect $ExpectedCount), debits=$($dr.ToString('N2', $inv)), credits=$($cr.ToString('N2', $inv)) (expect $($ExpectedAmount.ToString('N2', $inv)))"
        Add-Result 'Test 1 totals' $(if ($ok) { 'PASS' } else { 'FAIL' }) $detail

        $br = Invoke-SuiteQL "SELECT t.type AS trantype, COUNT(*) AS cnt, SUM(tal.debit) AS debits, SUM(tal.credit) AS credits $from GROUP BY t.type ORDER BY t.type"
        if ($br.Status -eq 200) {
            Write-Host "`nBreakdown by transaction type:"
            $br.Body.items | ForEach-Object { [pscustomobject]@{ Type = $_.trantype; Lines = $_.cnt; Debits = $_.debits; Credits = $_.credits } } | Format-Table -AutoSize | Out-String | Write-Host
            if (-not $ok) { Write-Host "If totals are short, the API_User role probably lacks View on some transaction types. Compare these types with the NetSuite Trial Balance / a saved search grouped by type to find the missing ones.`n" -ForegroundColor Yellow }
        }
        else { Add-Result 'Test 1 breakdown' 'FAIL' "HTTP $($br.Status): $(Format-NsError $br)" }
    }

    # ---- Test 2: accountingperiod visible? ----
    $t2 = Invoke-SuiteQL 'SELECT id, periodname, startdate, enddate FROM accountingperiod ORDER BY startdate DESC' 5
    if ($t2.Status -eq 200 -and $t2.Body.items.Count -gt 0) { Add-Result 'Test 2 accountingperiod' 'PASS' "Visible ($($t2.Body.items.Count) sample rows). Newest: $($t2.Body.items[0].periodname)" }
    else { Add-Result 'Test 2 accountingperiod' 'FAIL' "Not visible or empty. HTTP $($t2.Status): $(Format-NsError $t2). Trial balance by posting period stays blocked." }

    # ---- Tests 3a/3b: writes must be rejected ----
    if ($SkipWriteTests) { Add-Result 'Test 3a/3b writes' 'SKIPPED' 'Skipped by -SkipWriteTests.' }
    elseif (-not $isSandbox) { Add-Result 'Test 3a/3b writes' 'SKIPPED' 'Host is not a sandbox; write tests only run against sandboxes.' }
    else {
        $writeTests = @(
            @{ Name = 'Test 3a customer write'; Path = '/services/rest/record/v1/customer'; Body = @{ companyName = 'ZZ-WRITE-TEST-DELETE-ME'; subsidiary = @{ id = '1' } } }
            @{ Name = 'Test 3b account write'; Path = '/services/rest/record/v1/account'; Body = @{ acctName = 'ZZ-WRITE-TEST-DELETE-ME'; acctNumber = '99999'; acctType = @{ id = 'Expense' } } }
        )
        foreach ($w in $writeTests) {
            $r = Invoke-Ns 'POST' $w.Path $w.Body
            $text = Format-NsError $r
            if ($r.Status -ge 200 -and $r.Status -lt 300) {
                Add-Result $w.Name 'FAIL' "WRITE SUCCEEDED (HTTP $($r.Status)). A test record was created in the sandbox -- delete it and remove the create permission from API_User NOW."
            }
            elseif (($r.Status -in 401, 403) -or ($text -match 'INSUFFICIENT_PERMISSION|permission')) { Add-Result $w.Name 'PASS' "Rejected for permissions (HTTP $($r.Status))." }
            else { Add-Result $w.Name 'INCONCLUSIVE' "Rejected with HTTP $($r.Status) but not clearly for permissions (could be a validation error): $text" }
        }
    }
}
finally {
    $pem = $null; $token = $null
    if ($ecdsa) { $ecdsa.Dispose() }
    [GC]::Collect()
}

Write-Host "`nSummary:"
$results | Format-Table Test, Status -AutoSize | Out-String | Write-Host
if ($results.Status -contains 'FAIL') { exit 1 }
