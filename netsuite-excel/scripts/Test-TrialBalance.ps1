#Requires -Version 7.1
<#
.SYNOPSIS
  Runs the new posting-period Trial Balance SuiteQL against the sandbox (no Node needed) and checks it.

.DESCRIPTION
  !! The SQL below is a COPY of trialBalance in api/src/lib/catalog.ts (PowerShell cannot import it).
  !! Keep them identical; delete this script once the real runner (Invoke-LocalReport.ps1) can be used.

  Checks:  1) the period name matches exactly one monthly posting period (and shows the columns we rely on)
           2) fiscal-year start is found
           3) rows' count and sums equal NetSuite's own totals (same gate the API uses)
           4) total debits = total credits (a TB must balance)
  Writes the full TB to api\out\ (gitignored financial data). Compare it with the NetSuite Trial Balance report
  for the same period (same subsidiaries consolidated, book 1) -- that comparison is what makes the report "validated".

  Secrets come from 1Password; keep the app unlocked. The private key and token are never printed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9 .-]{1,30}$')][string]$Period,
    [string]$Vault = 'NetSuite',
    [string]$Item = 'Excel Addin Connection'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$inv = [System.Globalization.CultureInfo]::InvariantCulture

function ConvertTo-Base64Url([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function Get-OpField([string]$Field) {
    $v = op read "op://$Vault/$Item/$Field" 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($v)) { throw "Could not read 1Password field '$Field' (is the app unlocked?)." }
    return ($v -join "`n").Trim()
}
# NetSuite omits null columns from SuiteQL rows (e.g. SUM of no debits), so read properties defensively.
function Get-Prop($o, [string]$n) { $p = $o.PSObject.Properties[$n]; if ($p) { return $p.Value } else { return $null } }
function ConvertTo-Dec($v) {
    if ($null -eq $v -or "$v" -eq '') { return [decimal]0 }
    return [decimal]::Parse([string]::Format($inv, '{0}', $v), [System.Globalization.NumberStyles]::Float, $inv)
}

$pem = $null; $ecdsa = $null; $token = $null
try {
    $accountId = Get-OpField 'account_id'; $clientId = Get-OpField 'client_id'; $certId = Get-OpField 'certificate_id'; $pem = Get-OpField 'private_key'
    $base = "https://$($accountId.ToLowerInvariant().Replace('_', '-')).suitetalk.api.netsuite.com"
    if ($base -notmatch '-sb\d*\.suitetalk') { throw "Host $base is not a sandbox. This script only runs against sandboxes." }

    $ecdsa = [System.Security.Cryptography.ECDsa]::Create(); $ecdsa.ImportFromPem($pem)
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $h = @{ alg = 'ES256'; typ = 'JWT'; kid = $certId } | ConvertTo-Json -Compress
    $c = @{ iss = $clientId; scope = @('rest_webservices'); aud = "$base/services/rest/auth/oauth2/v1/token"; iat = $now; exp = $now + 3300 } | ConvertTo-Json -Compress
    $si = (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($h))) + '.' + (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($c)))
    $sig = $ecdsa.SignData([Text.Encoding]::UTF8.GetBytes($si), [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation)
    $tr = Invoke-RestMethod -Method Post -Uri "$base/services/rest/auth/oauth2/v1/token" -ContentType 'application/x-www-form-urlencoded' -SkipHttpErrorCheck -StatusCodeVariable ts -Body @{
        grant_type = 'client_credentials'; client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'; client_assertion = "$si." + (ConvertTo-Base64Url $sig) }
    if ($ts -ne 200) { throw "Token request failed (HTTP $ts)." }
    $token = $tr.access_token

    function Invoke-SuiteQL([string]$Sql, [int]$Limit = 1000, [int]$Offset = 0) {
        $r = Invoke-RestMethod -Method Post -Uri "$base/services/rest/query/v1/suiteql?limit=$Limit&offset=$Offset" -Headers @{ Authorization = "Bearer $token"; Prefer = 'transient' } `
            -ContentType 'application/json' -Body (@{ q = $Sql } | ConvertTo-Json -Compress) -SkipHttpErrorCheck -StatusCodeVariable sc
        [pscustomobject]@{ Status = $sc; Body = $r }
    }
    function Show-Fail([string]$What, $r) { Write-Host "[FAIL] $What - HTTP $($r.Status): $(if ($r.Body -is [string]) { $r.Body } else { $r.Body | ConvertTo-Json -Depth 5 -Compress })" -ForegroundColor Red }

    # ---- 1) the period ----
    $r = Invoke-SuiteQL "SELECT id, periodname, startdate, enddate, isyear, isquarter FROM accountingperiod WHERE periodname = '$Period'"
    if ($r.Status -ne 200) { Show-Fail 'Period lookup (accountingperiod columns may differ from my assumptions)' $r; exit 1 }
    Write-Host "Periods named '$Period':"; $r.Body.items | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.periodname; start = $_.startdate; end = $_.enddate; isyear = $_.isyear; isquarter = $_.isquarter } } | Format-Table -AutoSize | Out-String | Write-Host
    $monthly = @($r.Body.items | Where-Object { $_.isyear -eq 'F' -and $_.isquarter -eq 'F' })
    if ($monthly.Count -ne 1) { Write-Host "[FAIL] Expected exactly 1 monthly posting period named '$Period', found $($monthly.Count)." -ForegroundColor Red; exit 1 }
    Write-Host '[PASS] Period matches exactly one monthly posting period.' -ForegroundColor Green

    # ---- SQL (copy of catalog.ts tbParts/trialBalance) ----
    $per = "(SELECT p.pstart AS pstart, p.pend AS pend, (SELECT MAX(y.startdate) FROM accountingperiod y WHERE y.isyear = 'T' AND y.startdate <= p.pstart) AS fystart " +
           "FROM (SELECT MAX(tp.startdate) AS pstart, MAX(tp.enddate) AS pend FROM accountingperiod tp WHERE tp.periodname = '$Period' AND tp.isquarter = 'F' AND tp.isyear = 'F') p)"
    $plTypes = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'"
    $priorPL = "(a.accttype IN ($plTypes) AND pp.startdate < per.fystart)"
    $from = 'FROM transactionaccountingline tal INNER JOIN transaction t ON t.id = tal.transaction INNER JOIN accountingperiod pp ON pp.id = t.postingperiod INNER JOIN account a ON a.id = tal.account INNER JOIN ' + $per + ' per ON 1 = 1'
    $where = "tal.posting = 'T' AND tal.accountingbook = 1 AND per.fystart IS NOT NULL AND pp.enddate <= per.pend"
    $key = "CASE WHEN $priorPL THEN 0 ELSE tal.account END"
    $num = "CASE WHEN $priorPL THEN 'RE-CALC' ELSE a.acctnumber END"
    $name = "CASE WHEN $priorPL THEN 'Retained Earnings (calculated: prior-year P&L)' ELSE BUILTIN.DF(tal.account) END"
    $type = "CASE WHEN $priorPL THEN 'RetainedEarningsCalc' ELSE a.accttype END"
    $totalsSql = "SELECT COUNT(DISTINCT $key) AS cnt, ROUND(SUM(tal.debit), 2) AS debits, ROUND(SUM(tal.credit), 2) AS credits $from WHERE $where"
    $rowsSql = "SELECT $num AS acctnumber, $name AS acctname, $type AS accttype, ROUND(SUM(tal.debit), 2) AS debit, ROUND(SUM(tal.credit), 2) AS credit $from WHERE $where GROUP BY $key, $num, $name, $type ORDER BY $num, $key"

    # ---- 2) fiscal year start ----
    $fy = Invoke-SuiteQL "SELECT per.pstart AS pstart, per.pend AS pend, per.fystart AS fystart FROM $per per"
    if ($fy.Status -ne 200 -or -not $fy.Body.items[0].fystart) { Show-Fail 'Fiscal year start' $fy; exit 1 }
    Write-Host "[PASS] Period $($fy.Body.items[0].pstart) to $($fy.Body.items[0].pend); fiscal year start (P&L YTD begins): $($fy.Body.items[0].fystart)" -ForegroundColor Green

    # ---- 3) totals vs rows ----
    $t = Invoke-SuiteQL $totalsSql
    if ($t.Status -ne 200) { Show-Fail 'Totals query' $t; exit 1 }
    $tc = [int](ConvertTo-Dec $t.Body.items[0].cnt); $td = [math]::Round((ConvertTo-Dec $t.Body.items[0].debits), 2); $tcr = [math]::Round((ConvertTo-Dec $t.Body.items[0].credits), 2)
    $all = [System.Collections.Generic.List[object]]::new()
    for ($off = 0; $off -lt [math]::Max($tc, 1); $off += 1000) {
        $p = Invoke-SuiteQL $rowsSql 1000 $off
        if ($p.Status -ne 200) { Show-Fail "Rows query (offset $off)" $p; exit 1 }
        $p.Body.items | ForEach-Object { $all.Add($_) }
    }
    $rd = [decimal]0; $rc = [decimal]0
    foreach ($row in $all) { $rd += ConvertTo-Dec (Get-Prop $row 'debit'); $rc += ConvertTo-Dec (Get-Prop $row 'credit') }
    $gate = ($all.Count -eq $tc) -and ($rd -eq $td) -and ($rc -eq $tcr)
    Write-Host ("Rows={0} (NetSuite totals count={1}); row debits={2:N2} vs {3:N2}; row credits={4:N2} vs {5:N2}" -f $all.Count, $tc, $rd, $td, $rc, $tcr)
    Write-Host $(if ($gate) { '[PASS] Reconciliation gate: rows match NetSuite totals exactly.' } else { '[FAIL] Reconciliation gate: rows do NOT match NetSuite totals.' }) -ForegroundColor $(if ($gate) { 'Green' } else { 'Red' })

    # ---- 4) balanced ----
    $bal = ($td -eq $tcr)
    Write-Host $(if ($bal) { "[PASS] Balanced: debits = credits = $($td.ToString('N2', $inv))" } else { "[FAIL] NOT balanced: debits $($td.ToString('N2', $inv)) vs credits $($tcr.ToString('N2', $inv))" }) -ForegroundColor $(if ($bal) { 'Green' } else { 'Red' })

    Write-Host "`nTotals by account type (compare with NetSuite's Trial Balance report):"
    $all | Group-Object { Get-Prop $_ 'accttype' } | ForEach-Object {
        $d = [decimal]0; $c2 = [decimal]0; foreach ($x in $_.Group) { $d += ConvertTo-Dec (Get-Prop $x 'debit'); $c2 += ConvertTo-Dec (Get-Prop $x 'credit') }
        [pscustomobject]@{ Type = $_.Name; Accounts = $_.Count; Debit = $d.ToString('N2', $inv); Credit = $c2.ToString('N2', $inv) }
    } | Sort-Object Type | Format-Table -AutoSize | Out-String | Write-Host
    $re = @($all | Where-Object { (Get-Prop $_ 'acctnumber') -eq 'RE-CALC' })
    Write-Host $(if ($re.Count -eq 1) { "Retained Earnings (calculated) row: debit=$(Get-Prop $re[0] 'debit') credit=$(Get-Prop $re[0] 'credit')" } else { "No calculated Retained Earnings row (count=$($re.Count)): there is no prior-year P&L, or the fiscal-year logic did not apply." })

    $outDir = Join-Path $PSScriptRoot '..\api\out'
    New-Item -ItemType Directory -Force $outDir | Out-Null
    $csv = Join-Path $outDir ("tb-" + ($Period -replace '[^A-Za-z0-9]', '_') + '.csv')
    $all | ForEach-Object { [pscustomobject]@{ acctnumber = Get-Prop $_ 'acctnumber'; acctname = Get-Prop $_ 'acctname'; accttype = Get-Prop $_ 'accttype'; debit = Get-Prop $_ 'debit'; credit = Get-Prop $_ 'credit' } } | Export-Csv -LiteralPath $csv -NoTypeInformation
    Write-Host "`nFull TB written to $csv (gitignored financial data; do not share or commit)."
    if (-not ($gate -and $bal)) { exit 1 }
}
finally {
    $pem = $null; $token = $null
    if ($ecdsa) { $ecdsa.Dispose() }
    [GC]::Collect()
}
