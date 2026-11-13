#Requires -Version 7.1
<#
.SYNOPSIS
  AR/AP Aging checks against the sandbox (no Node needed). Step 1: -Probe.

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

if (-not ($Probe -or $ProbeLines)) { throw 'Only the probes are implemented so far: ./Test-Aging.ps1 -Probe  or  -ProbeLines' }

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
