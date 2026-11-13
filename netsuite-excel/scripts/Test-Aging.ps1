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
    [string]$Vault = 'NetSuite',
    [string]$Item = 'Excel Addin Connection'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/NsCommon.ps1"
$inv = [System.Globalization.CultureInfo]::InvariantCulture

if (-not $Probe) { throw 'Only -Probe is implemented so far. Run: ./Test-Aging.ps1 -Probe' }

function Show-Table($items, [string[]]$Cols) {
    if (@($items).Count -eq 0) { Write-Host '  (no rows)'; return }
    @($items) | ForEach-Object { $o = $_; $h = [ordered]@{}; foreach ($c in $Cols) { $h[$c] = Get-Prop $o $c }; [pscustomobject]$h } |
        Format-Table -AutoSize | Out-String | Write-Host
}

$conn = $null
try {
    $conn = Connect-NetSuite $Vault $Item
    $types = "'CustInvc', 'CustCred', 'CustPymt', 'CustDep', 'CustRfnd', 'VendBill', 'VendCred', 'VendPymt', 'Journal'"

    Write-Host "A) Open-amount fields on transaction (posting transactions with a non-zero value, by type):`n"
    foreach ($f in 'amountunpaid', 'foreignamountunpaid', 'amountremaining', 'foreignamountremaining', 'paymentamountunused', 'foreignpaymentamountunused') {
        $r = Invoke-SuiteQL $conn ("SELECT t.type AS trantype, COUNT(*) AS n, ROUND(SUM(t.$f), 2) AS total FROM transaction t " +
            "WHERE t.posting = 'T' AND t.type IN ($types) AND NVL(t.$f, 0) <> 0 GROUP BY t.type ORDER BY t.type")
        if ($r.Status -eq 200) { Write-Host "[OK]   $f" -ForegroundColor Green; Show-Table (Get-Prop $r.Body 'items') @('trantype', 'n', 'total') }
        else { Write-Host "[FAIL] $f -> HTTP $($r.Status): $(Format-NsError $r)`n" -ForegroundColor Red }
    }

    foreach ($kind in 'AcctRec', 'AcctPay') {
        Write-Host "B) What makes up the $kind control balance (all postings to $kind accounts, all time, by transaction type):"
        $r = Invoke-SuiteQL $conn ("SELECT t.type AS trantype, COUNT(*) AS lines, ROUND(SUM(tal.debit), 2) AS debits, ROUND(SUM(tal.credit), 2) AS credits " +
            "FROM transactionaccountingline tal INNER JOIN transaction t ON t.id = tal.transaction INNER JOIN account a ON a.id = tal.account " +
            "WHERE tal.posting = 'T' AND tal.accountingbook = 1 AND a.accttype = '$kind' GROUP BY t.type ORDER BY t.type")
        if ($r.Status -ne 200) { Write-Host "[FAIL] HTTP $($r.Status): $(Format-NsError $r)" -ForegroundColor Red; continue }
        $items = @(Get-Prop $r.Body 'items')
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
