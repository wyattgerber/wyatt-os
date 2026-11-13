#Requires -Version 7.1
<#
.SYNOPSIS
  Runs the new posting-period Trial Balance SuiteQL against the sandbox (no Node needed) and checks it.

.DESCRIPTION
  !! The SQL below is a COPY of trialBalance in api/src/lib/catalog.js (PowerShell cannot import it).
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
    [string]$Item = 'Excel Addin Connection',
    # Diagnostics: pass NetSuite's report footer (net debit total) to see the gap and which accounts could explain it.
    [decimal]$NetSuiteFooter = -1,
    [switch]$ShowEquity,
    # Probe how the retained-earnings account can be identified (account columns are unverified), then exit.
    [switch]$ProbeRetainedEarnings
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

    if ($ProbeRetainedEarnings) {
        Write-Host 'Probing the account table (each query is independent, so one bad column does not hide the others):'
        $probes = [ordered]@{
            'acctnumber/accttype of 3400'            = "SELECT id, acctnumber, accttype FROM account WHERE acctnumber = '3400'"
            'sspecacct (special account type) col'  = "SELECT id, acctnumber, sspecacct FROM account WHERE sspecacct = 'RetEarnings'"
            'distinct sspecacct values'             = "SELECT sspecacct, COUNT(*) AS n FROM account WHERE sspecacct IS NOT NULL GROUP BY sspecacct ORDER BY sspecacct"
            'accountsearchdisplayname col'          = "SELECT id, accountsearchdisplayname FROM account WHERE acctnumber = '3400'"
            'fullname col'                          = "SELECT id, fullname FROM account WHERE acctnumber = '3400'"
            'BUILTIN.DF on a derived id'            = "SELECT BUILTIN.DF(x.rid) AS nm FROM (SELECT MAX(id) AS rid FROM account WHERE acctnumber = '3400') x"
        }
        foreach ($k in $probes.Keys) {
            $pr = Invoke-SuiteQL $probes[$k]
            if ($pr.Status -eq 200) { Write-Host "[OK]   $k -> $($pr.Body.items | ConvertTo-Json -Compress -Depth 4)" -ForegroundColor Green }
            else { Write-Host "[FAIL] $k -> HTTP $($pr.Status): $(if ($pr.Body -is [string]) { $pr.Body } else { ($pr.Body.'o:errorDetails'.detail) })" -ForegroundColor Red }
        }
        exit 0
    }

    # ---- 1) the period ----
    $r = Invoke-SuiteQL "SELECT id, periodname, startdate, enddate, isyear, isquarter FROM accountingperiod WHERE periodname = '$Period'"
    if ($r.Status -ne 200) { Show-Fail 'Period lookup (accountingperiod columns may differ from my assumptions)' $r; exit 1 }
    Write-Host "Periods named '$Period':"; $r.Body.items | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.periodname; start = $_.startdate; end = $_.enddate; isyear = $_.isyear; isquarter = $_.isquarter } } | Format-Table -AutoSize | Out-String | Write-Host
    $monthly = @($r.Body.items | Where-Object { $_.isyear -eq 'F' -and $_.isquarter -eq 'F' })
    if ($monthly.Count -ne 1) { Write-Host "[FAIL] Expected exactly 1 monthly posting period named '$Period', found $($monthly.Count)." -ForegroundColor Red; exit 1 }
    Write-Host '[PASS] Period matches exactly one monthly posting period.' -ForegroundColor Green

    # ---- SQL (copy of catalog.js tbParts/trialBalance) ----
    $per = "(SELECT p.pstart AS pstart, p.pend AS pend, (SELECT MAX(y.startdate) FROM accountingperiod y WHERE y.isyear = 'T' AND y.startdate <= p.pstart) AS fystart " +
           "FROM (SELECT MAX(tp.startdate) AS pstart, MAX(tp.enddate) AS pend FROM accountingperiod tp WHERE tp.periodname = '$Period' AND tp.isquarter = 'F' AND tp.isyear = 'F') p)"
    $plTypes = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'"
    $priorPL = "(a.accttype IN ($plTypes) AND pp.startdate < per.fystart)"
    $from = 'FROM transactionaccountingline tal INNER JOIN transaction t ON t.id = tal.transaction INNER JOIN accountingperiod pp ON pp.id = t.postingperiod INNER JOIN account a ON a.id = tal.account INNER JOIN ' + $per + ' per ON 1 = 1 INNER JOIN (SELECT MAX(id) AS reid FROM account WHERE sspecacct = ''RetEarnings'') rx ON 1 = 1 INNER JOIN account rea ON rea.id = rx.reid'
    $where = "tal.posting = 'T' AND tal.accountingbook = 1 AND per.fystart IS NOT NULL AND pp.enddate <= per.pend"
    $key = "CASE WHEN $priorPL THEN rea.id ELSE a.id END"
    $num = "CASE WHEN $priorPL THEN rea.acctnumber ELSE a.acctnumber END"
    $name = "CASE WHEN $priorPL THEN rea.accountsearchdisplayname ELSE a.accountsearchdisplayname END"
    $type = "CASE WHEN $priorPL THEN rea.accttype ELSE a.accttype END"
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
    # NetSuite's Trial Balance report shows NET balances: debit column = accounts with a net debit, credit column = net credit.
    $netDr = [decimal]0; $netCr = [decimal]0
    foreach ($x in $all) {
        $net = (ConvertTo-Dec (Get-Prop $x 'debit')) - (ConvertTo-Dec (Get-Prop $x 'credit'))
        if ($net -gt 0) { $netDr += $net } else { $netCr += (-$net) }
    }
    Write-Host ("NET totals (compare with the footer of NetSuite's Trial Balance report): Debit {0:N2} | Credit {1:N2}" -f $netDr, $netCr)
    $req = Invoke-SuiteQL "SELECT acctnumber FROM account WHERE sspecacct = 'RetEarnings'"
    $reAcct = if ($req.Status -eq 200 -and $req.Body.items.Count -eq 1) { Get-Prop $req.Body.items[0] 'acctnumber' } else { $null }
    $re = @($all | Where-Object { $null -ne $reAcct -and (Get-Prop $_ 'acctnumber') -eq $reAcct })
    Write-Host $(if ($re.Count -eq 1) { "Retained-earnings account $reAcct (own balance + prior-year P&L): debit=$((ConvertTo-Dec (Get-Prop $re[0] 'debit')).ToString('N2', $inv)) credit=$((ConvertTo-Dec (Get-Prop $re[0] 'credit')).ToString('N2', $inv))" } else { "Retained-earnings account row not found (count=$($re.Count))." })

    $reNetAbs = $null
    if ($re.Count -eq 1) { $reNetAbs = [math]::Abs((ConvertTo-Dec (Get-Prop $re[0] 'debit')) - (ConvertTo-Dec (Get-Prop $re[0] 'credit'))) }
    if ($NetSuiteFooter -ge 0) {
        $diff = $netDr - $NetSuiteFooter
        Write-Host ("`nDIAGNOSTIC: mine {0:N2} - NetSuite footer {1:N2} = difference {2:N2}" -f $netDr, $NetSuiteFooter, $diff) -ForegroundColor Yellow
        if ($null -ne $reNetAbs) { Write-Host ("Retained-earnings account net = {0:N2}" -f $reNetAbs) }
        Write-Host 'Accounts whose |net| equals the difference, or RE-calc minus the difference:'
        foreach ($x in $all) {
            $n = [math]::Abs((ConvertTo-Dec (Get-Prop $x 'debit')) - (ConvertTo-Dec (Get-Prop $x 'credit')))
            $hit1 = [math]::Abs($n - [math]::Abs($diff)) -lt 0.005
            $hit2 = ($null -ne $reNetAbs) -and ([math]::Abs($n - ($reNetAbs - [math]::Abs($diff))) -lt 0.005)
            if ($n -gt 0 -and ($hit1 -or $hit2)) { Write-Host ("  {0} {1} ({2}) net={3:N2}  [{4}]" -f (Get-Prop $x 'acctnumber'), (Get-Prop $x 'acctname'), (Get-Prop $x 'accttype'), $n, $(if ($hit1) { 'equals difference' } else { 'equals RE-calc minus difference' })) }
        }
    }
    if ($ShowEquity) {
        Write-Host "`nEquity accounts (net = debit - credit):"
        $all | Where-Object { (Get-Prop $_ 'accttype') -eq 'Equity' } | ForEach-Object {
            [pscustomobject]@{ Account = Get-Prop $_ 'acctnumber'; Name = Get-Prop $_ 'acctname'; Net = ((ConvertTo-Dec (Get-Prop $_ 'debit')) - (ConvertTo-Dec (Get-Prop $_ 'credit'))).ToString('N2', $inv) }
        } | Format-Table -AutoSize | Out-String | Write-Host
    }

    $outDir = Join-Path $PSScriptRoot '..\api\out'
    New-Item -ItemType Directory -Force $outDir | Out-Null
    $csv = Join-Path $outDir ("tb-" + ($Period -replace '[^A-Za-z0-9]', '_') + '.csv')
    $all | ForEach-Object {
        $d = ConvertTo-Dec (Get-Prop $_ 'debit'); $c3 = ConvertTo-Dec (Get-Prop $_ 'credit')
        [pscustomobject]@{ acctnumber = Get-Prop $_ 'acctnumber'; acctname = Get-Prop $_ 'acctname'; accttype = Get-Prop $_ 'accttype'
            debit = $d.ToString('F2', $inv); credit = $c3.ToString('F2', $inv); net_dr_minus_cr = ($d - $c3).ToString('F2', $inv) }
    } | Export-Csv -LiteralPath $csv
    Write-Host "`nFull TB written to $csv (gitignored financial data; do not share or commit)."
    if (-not ($gate -and $bal)) { exit 1 }
}
finally {
    $pem = $null; $token = $null
    if ($ecdsa) { $ecdsa.Dispose() }
    [GC]::Collect()
}
