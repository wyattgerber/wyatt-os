#Requires -Version 7.1
<#
.SYNOPSIS
  AR/AP Aging checks against the sandbox (no Node needed).

  ./Test-Aging.ps1 -Kind AR    (or AP)  runs the report SQL (copy in NsCommon.ps1, parity-tested) and checks:
     - reconciliation gate: rows' count and open total equal NetSuite's totals;
     - control tie: open total equals the AR/AP control-account balance (the API enforces this on every pull);
     - prints bucket totals (Current, 1-30, 31-60, 61-90, >90) and the no-name total, to compare with NetSuite's
       A/R or A/P Aging Summary run the SAME day (buckets move every day).
     Writes per-line and per-name CSVs to api\out (gitignored financial data).

.DESCRIPTION
  -Probe   Learns what the aging SQL can rely on, before it is trusted:
           A) which open-amount fields exist on `transaction`, and which transaction types carry them
              (count + total per type; one query per field so a missing field does not hide the others);
           B) what makes up the AR and AP control-account balances: every posting to accounts of type
              AcctRec / AcctPay, all time, grouped by transaction type. The aging must include every type
              listed there (e.g. journals posted to AR) or it can never tie to the control account.
  Output is counts and totals by transaction type only: no customer or vendor names.
#>
[CmdletBinding()]
param(
    [ValidateSet('AR', 'AP')][string]$Kind,
    [switch]$Probe,
    # Probe line-level open amounts and names on AR/AP lines (journals carry their own open amounts).
    [switch]$ProbeLines,
    [string]$Vault = 'NetSuite',
    [string]$Item = 'Excel Addin Connection'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/NsCommon.ps1"
$inv = [System.Globalization.CultureInfo]::InvariantCulture

if (-not ($Kind -or $Probe -or $ProbeLines)) { throw 'Use -Kind AR, -Kind AP, -Probe or -ProbeLines.' }

function Show-Table($items, [string[]]$Cols) {
    $items = @($items | Where-Object { $null -ne $_ })
    if ($items.Count -eq 0) { Write-Host '  (no rows: no transactions with a non-zero value)'; return }
    $items | ForEach-Object { $o = $_; $h = [ordered]@{}; foreach ($c in $Cols) { $h[$c] = Get-Prop $o $c }; [pscustomobject]$h } |
        Format-Table -AutoSize | Out-String | Write-Host
}

$conn = $null
try {
    $conn = Connect-NetSuite $Vault $Item
    $types = "'CustInvc', 'CustCred', 'CustPymt', 'CustDep', 'CustRfnd', 'VendBill', 'VendCred', 'VendPymt', 'Journal'"

    if ($Kind) {
        $q = Get-AgingSql $Kind
        $failed = $false
        $t = Invoke-SuiteQL $conn $q.Totals
        if ($t.Status -ne 200) { throw "Totals query failed (HTTP $($t.Status)): $(Format-NsError $t)" }
        $tr = (Get-Items $t.Body)[0]
        $cnt = [int](ConvertTo-Dec (Get-Prop $tr 'cnt')); $open = ConvertTo-Dec (Get-Prop $tr 'openamount'); $control = ConvertTo-Dec (Get-Prop $tr 'control')
        $rows = Get-AllRows $conn $q.Rows $cnt
        $sum = [decimal]0; foreach ($x in $rows) { $sum += ConvertTo-Dec (Get-Prop $x 'openamount') }
        $ok1 = ($rows.Count -eq $cnt) -and ($sum -eq $open)
        Write-Host ("[{0}] Reconciliation gate: {1} open items totalling {2} (NetSuite: {3} / {4})" -f $(if ($ok1) { 'PASS' } else { 'FAIL' }), $rows.Count, $sum.ToString('N2', $inv), $cnt, $open.ToString('N2', $inv)) -ForegroundColor $(if ($ok1) { 'Green' } else { 'Red' })
        $ok2 = ($open -eq $control)
        Write-Host ("[{0}] Control tie: aging total {1} = {2} control-account balance {3}" -f $(if ($ok2) { 'PASS' } else { 'FAIL' }), $open.ToString('N2', $inv), $Kind, $control.ToString('N2', $inv)) -ForegroundColor $(if ($ok2) { 'Green' } else { 'Red' })
        if (-not ($ok1 -and $ok2)) { $failed = $true }

        # Buckets exactly as the API derives them (deriveAging in catalog.ts): days past due from the due date
        # (transaction date if none) to today in US Eastern; 0 or less = Current.
        $tz = try { [TimeZoneInfo]::FindSystemTimeZoneById('America/New_York') } catch { [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time') }
        $today = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $tz).Date
        $b = [ordered]@{ 'Current' = [decimal]0; '1-30' = [decimal]0; '31-60' = [decimal]0; '61-90' = [decimal]0; '>90' = [decimal]0 }
        $byName = @{}
        foreach ($x in $rows) {
            $dueTxt = Get-Prop $x 'duedate'; if (-not $dueTxt) { $dueTxt = Get-Prop $x 'trandate' }
            $due = [DateTime]::ParseExact($dueTxt, 'yyyy-MM-dd', $inv)
            $days = [math]::Max(0, ($today - $due).Days)
            $k = if ($days -eq 0) { 'Current' } elseif ($days -le 30) { '1-30' } elseif ($days -le 60) { '31-60' } elseif ($days -le 90) { '61-90' } else { '>90' }
            $amt = ConvertTo-Dec (Get-Prop $x 'openamount'); $b[$k] += $amt
            $n = Get-Prop $x 'entityname'; if (-not $byName.ContainsKey($n)) { $byName[$n] = [decimal]0 }; $byName[$n] += $amt
        }
        Write-Host "`nBuckets as of $($today.ToString('yyyy-MM-dd')) (US Eastern) - compare with NetSuite's $Kind Aging Summary run the same day:"
        [pscustomobject]@{ Current = $b['Current'].ToString('N2', $inv); '1-30' = $b['1-30'].ToString('N2', $inv); '31-60' = $b['31-60'].ToString('N2', $inv); '61-90' = $b['61-90'].ToString('N2', $inv); '>90' = $b['>90'].ToString('N2', $inv); Total = $sum.ToString('N2', $inv) } |
            Format-Table -AutoSize | Out-String | Write-Host
        $nn = if ($byName.ContainsKey($q.NoName)) { $byName[$q.NoName] } else { [decimal]0 }
        Write-Host ("'{0}' total: {1}   |   names: {2}" -f $q.NoName, $nn.ToString('N2', $inv), $byName.Count)

        $outDir = Join-Path $PSScriptRoot '..\api\out'
        New-Item -ItemType Directory -Force $outDir | Out-Null
        $rows | ForEach-Object { [pscustomobject]@{ name = Get-Prop $_ 'entityname'; type = Get-Prop $_ 'trantype'; tranid = Get-Prop $_ 'tranid'; date = Get-Prop $_ 'trandate'; due = Get-Prop $_ 'duedate'; open = (ConvertTo-Dec (Get-Prop $_ 'openamount')).ToString('F2', $inv) } } |
            Export-Csv -LiteralPath (Join-Path $outDir "aging-$Kind.csv")
        $byName.GetEnumerator() | Sort-Object Name | ForEach-Object { [pscustomobject]@{ name = $_.Name; open = $_.Value.ToString('F2', $inv) } } |
            Export-Csv -LiteralPath (Join-Path $outDir "aging-$Kind-by-name.csv")
        Write-Host "Wrote aging-$Kind.csv and aging-$Kind-by-name.csv to $outDir (gitignored financial data; do not share or commit)."
        if ($failed) { exit 1 }
        return
    }

    if ($ProbeLines) {
        $join = "FROM transactionline tl INNER JOIN transaction t ON t.id = tl.transaction " +
                "INNER JOIN transactionaccountingline tal ON tal.transaction = tl.transaction AND tal.transactionline = tl.id " +
                "INNER JOIN account a ON a.id = tal.account " +
                "WHERE tal.posting = 'T' AND tal.accountingbook = 1 AND a.accttype IN ('AcctRec', 'AcctPay')"
        Write-Host "C) Line-level open-amount fields on AR/AP lines (non-zero values, by account type and transaction type):`n"
        foreach ($f in 'foreignamountunpaid', 'foreignamountpaid', 'foreignpaymentamountunused', 'foreignpaymentamountused', 'amountunpaid', 'foreignamountremaining') {
            $r = Invoke-SuiteQL $conn ("SELECT a.accttype AS kind, t.type AS trantype, COUNT(*) AS n, ROUND(SUM(tl.$f), 2) AS total $join " +
                "AND NVL(tl.$f, 0) <> 0 GROUP BY a.accttype, t.type ORDER BY a.accttype, t.type")
            if ($r.Status -eq 200) { Write-Host "[OK]   transactionline.$f" -ForegroundColor Green; Show-Table (Get-Items $r.Body) @('kind', 'trantype', 'n', 'total') }
            else { Write-Host "[FAIL] transactionline.$f -> HTTP $($r.Status): $(Format-NsError $r)`n" -ForegroundColor Red }
        }
        Write-Host "D) Do AR/AP lines name a customer/vendor? (transactionline.entity; needed to age journal lines by name)"
        $r = Invoke-SuiteQL $conn ("SELECT a.accttype AS kind, t.type AS trantype, COUNT(*) AS n, " +
            "SUM(CASE WHEN tl.entity IS NULL THEN 1 ELSE 0 END) AS no_entity, ROUND(SUM(tal.debit), 2) AS debits, ROUND(SUM(tal.credit), 2) AS credits " +
            "$join GROUP BY a.accttype, t.type ORDER BY a.accttype, t.type")
        if ($r.Status -eq 200) { Show-Table (Get-Items $r.Body) @('kind', 'trantype', 'n', 'no_entity', 'debits', 'credits') }
        else { Write-Host "[FAIL] transactionline.entity -> HTTP $($r.Status): $(Format-NsError $r)" -ForegroundColor Red }
        Write-Host 'Expected if my theory is right: AP journal lines open total 3,460,845.75 (credit); AR journal lines open net 1,448,859.63 (debit).'
        return
    }

    Write-Host "A) Open-amount fields on transaction (posting transactions with a non-zero value, by type):`n"
    foreach ($f in 'amountunpaid', 'foreignamountunpaid', 'amountremaining', 'foreignamountremaining', 'paymentamountunused', 'foreignpaymentamountunused') {
        $r = Invoke-SuiteQL $conn ("SELECT t.type AS trantype, COUNT(*) AS n, ROUND(SUM(t.$f), 2) AS total FROM transaction t " +
            "WHERE t.posting = 'T' AND t.type IN ($types) AND NVL(t.$f, 0) <> 0 GROUP BY t.type ORDER BY t.type")
        if ($r.Status -eq 200) { Write-Host "[OK]   $f" -ForegroundColor Green; Show-Table (Get-Items $r.Body) @('trantype', 'n', 'total') }
        else { Write-Host "[FAIL] $f -> HTTP $($r.Status): $(Format-NsError $r)`n" -ForegroundColor Red }
    }

    foreach ($kind in 'AcctRec', 'AcctPay') {
        Write-Host "B) What makes up the $kind control balance (all postings to $kind accounts, all time, by transaction type):"
        $r = Invoke-SuiteQL $conn ("SELECT t.type AS trantype, COUNT(*) AS lines, ROUND(SUM(tal.debit), 2) AS debits, ROUND(SUM(tal.credit), 2) AS credits " +
            "FROM transactionaccountingline tal INNER JOIN transaction t ON t.id = tal.transaction INNER JOIN account a ON a.id = tal.account " +
            "WHERE tal.posting = 'T' AND tal.accountingbook = 1 AND a.accttype = '$kind' GROUP BY t.type ORDER BY t.type")
        if ($r.Status -ne 200) { Write-Host "[FAIL] HTTP $($r.Status): $(Format-NsError $r)" -ForegroundColor Red; continue }
        $items = Get-Items $r.Body
        Show-Table $items @('trantype', 'lines', 'debits', 'credits')
        $d = [decimal]0; $c = [decimal]0
        foreach ($x in $items) { $d += ConvertTo-Dec (Get-Prop $x 'debits'); $c += ConvertTo-Dec (Get-Prop $x 'credits') }
        Write-Host ("  {0} control balance (debits - credits): {1}`n" -f $kind, ($d - $c).ToString('N2', $inv))
    }
}
finally {
    $conn = $null
    [GC]::Collect()
}
