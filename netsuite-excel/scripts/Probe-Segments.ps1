#Requires -Version 7.1
<#
.SYNOPSIS
  Finds the field names for the formula filters (Subsidiary, Department, Class, Location, and custom segments
  such as Profit Center and Mode) on transaction lines, and how many posting lines use each.

.DESCRIPTION
  1) Reads 2,000 transaction lines with SELECT * (the newest and the oldest 1,000) and prints the union of their
     COLUMN NAMES only (no values). NetSuite omits empty fields from each row, so one row is not enough.
     Custom segments (cseg_*) show up only if the role may see them AND at least one sampled line uses them.
  2) For each candidate field: how many posting lines (book 1) have a value, how many distinct values,
     and up to 5 sample display names (BUILTIN.DF) so you can recognise e.g. "Profit Center" or "Mode".
  Read-only; sandbox only.
#>
[CmdletBinding()]
param(
    [string]$Vault = 'NetSuite',
    [string]$Item = 'Excel Addin Connection'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/NsCommon.ps1"

$conn = $null
try {
    $conn = Connect-NetSuite $Vault $Item

    # 1) Column names across 2,000 lines (values are not printed). Empty fields are omitted per row, so union them.
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($dir in 'DESC', 'ASC') {
        $r = Invoke-SuiteQL $conn "SELECT * FROM transactionline tl WHERE tl.mainline = 'F' ORDER BY tl.transaction $dir, tl.id" 1000
        if ($r.Status -ne 200) { throw "SELECT * on transactionline failed (HTTP $($r.Status)): $(Format-NsError $r)" }
        foreach ($row in (Get-Items $r.Body)) { foreach ($n in $row.PSObject.Properties.Name) { [void]$seen.Add($n) } }
    }
    $names = @($seen | Where-Object { $_ -ne 'links' } | Sort-Object)
    Write-Host "transactionline: $($names.Count) columns seen across 2,000 sampled lines."
    $std = @('subsidiary', 'department', 'class', 'location')
    $custom = @($names | Where-Object { $_ -like 'cseg*' })
    Write-Host "Standard segments seen: $(@($std | Where-Object { $names -contains $_ }) -join ', ')"
    Write-Host "All columns seen: $($names -join ', ')"
    Write-Host "Custom segments (cseg*): $(if ($custom.Count) { $custom -join ', ' } else { '(none visible to this role)' })"
    $hints = @($names | Where-Object { $_ -match 'profit|mode|segment|center|centre|^custcol' -and $_ -notlike 'cseg*' })
    if ($hints.Count) { Write-Host "Other columns that might be segments: $($hints -join ', ')" }

    # 2) Usage on posting lines, with sample display names
    Write-Host ''
    foreach ($f in @($std + $custom + $hints | Select-Object -Unique)) {
        $q = "SELECT COUNT(tl.$f) AS used, COUNT(DISTINCT tl.$f) AS distinct_values FROM transactionline tl " +
             "INNER JOIN transactionaccountingline tal ON tal.transaction = tl.transaction AND tal.transactionline = tl.id " +
             "WHERE tal.posting = 'T' AND tal.accountingbook = 1"
        $u = Invoke-SuiteQL $conn $q
        if ($u.Status -ne 200) { Write-Host "[FAIL] $f -> HTTP $($u.Status): $(Format-NsError $u)" -ForegroundColor Red; continue }
        $x = (Get-Items $u.Body)[0]
        $s = Invoke-SuiteQL $conn "SELECT BUILTIN.DF(tl.$f) AS label, COUNT(*) AS n FROM transactionline tl WHERE tl.$f IS NOT NULL GROUP BY BUILTIN.DF(tl.$f) ORDER BY COUNT(*) DESC" 5
        $labels = if ($s.Status -eq 200) { (@(Get-Items $s.Body) | ForEach-Object { Get-Prop $_ 'label' }) -join ' | ' } else { "(names unavailable: HTTP $($s.Status))" }
        Write-Host ("{0,-28} posting lines with a value: {1,7}   distinct values: {2,5}   e.g. {3}" -f $f, (Get-Prop $x 'used'), (Get-Prop $x 'distinct_values'), $labels)
    }
}
finally {
    $conn = $null
    [GC]::Collect()
}
