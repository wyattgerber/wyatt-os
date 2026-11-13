#Requires -Version 7.1
<#
.SYNOPSIS
  Runs the GL Detail SuiteQL (posting-period range) against the sandbox (no Node needed) and checks it.

.DESCRIPTION
  1) Resolves the From/To period names to dates.
  2) Reconciliation gate (same as the API): row count and debit/credit sums equal NetSuite's own totals.
     The row query adds the account and transactionline joins, so this proves they neither drop nor duplicate lines.
  3) Balanced: debits = credits for the range (every transaction balances).
  4) Ties to the VALIDATED Trial Balance: for each account, GL net movement must equal
     TB(To period) - TB(period before From). Only possible when both are in the same fiscal year.
  5) Info: how many lines have a transaction date outside their posting period (why period basis matters).

  Writes the GL lines and a by-account summary to api\out\ (gitignored financial data; do not share or commit).
  Final check is yours: compare 2-3 accounts' debit/credit totals with NetSuite's General Ledger report.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9 .-]{1,30}$')][string]$FromPeriod,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9 .-]{1,30}$')][string]$ToPeriod,
    [string]$Vault = 'NetSuite',
    [string]$Item = 'Excel Addin Connection'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/NsCommon.ps1"
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$failed = $false
function Report([bool]$Ok, [string]$Msg) {
    Write-Host "[$(if ($Ok) { 'PASS' } else { 'FAIL' })] $Msg" -ForegroundColor $(if ($Ok) { 'Green' } else { 'Red' })
    if (-not $Ok) { $script:failed = $true }
}

$conn = $null
try {
    $conn = Connect-NetSuite $Vault $Item
    $sql = Get-LineSql $FromPeriod $ToPeriod

    # ---- 1) range ----
    $r = Invoke-SuiteQL $conn "SELECT rg.rstart AS rstart, rg.rend AS rend FROM $($sql.Range) rg"
    if ($r.Status -ne 200) { throw "Range lookup failed (HTTP $($r.Status)): $(Format-NsError $r)" }
    $rs = Get-Prop $r.Body.items[0] 'rstart'; $re = Get-Prop $r.Body.items[0] 'rend'
    Report ($null -ne $rs -and $null -ne $re) "Range '$FromPeriod' .. '$ToPeriod' resolves to $rs .. $re"
    if ($null -eq $rs -or $null -eq $re) { throw 'A period name did not match a monthly posting period.' }

    # ---- 2) gate ----
    $t = Invoke-SuiteQL $conn $sql.Totals
    if ($t.Status -ne 200) { throw "Totals query failed (HTTP $($t.Status)): $(Format-NsError $t)" }
    $tc = [int](ConvertTo-Dec (Get-Prop $t.Body.items[0] 'cnt'))
    $td = [math]::Round((ConvertTo-Dec (Get-Prop $t.Body.items[0] 'debits')), 2)
    $tcr = [math]::Round((ConvertTo-Dec (Get-Prop $t.Body.items[0] 'credits')), 2)
    $rows = Get-AllRows $conn $sql.Rows $tc
    $rd = [decimal]0; $rc = [decimal]0
    foreach ($x in $rows) { $rd += ConvertTo-Dec (Get-Prop $x 'debit'); $rc += ConvertTo-Dec (Get-Prop $x 'credit') }
    Write-Host ("Lines={0} (NetSuite count={1}); debits {2:N2} vs {3:N2}; credits {4:N2} vs {5:N2}" -f $rows.Count, $tc, $rd, $td, $rc, $tcr)
    Report (($rows.Count -eq $tc) -and ($rd -eq $td) -and ($rc -eq $tcr)) 'Reconciliation gate: rows match NetSuite totals exactly (joins neither drop nor duplicate lines).'

    # ---- 3) balanced ----
    Report ($td -eq $tcr) ("Balanced: debits {0:N2} = credits {1:N2}" -f $td, $tcr)

    # ---- by-account movement from the GL lines ----
    $gl = @{}
    foreach ($x in $rows) {
        $k = "$(Get-Prop $x 'acctnumber')|$(Get-Prop $x 'acctname')"
        if (-not $gl.ContainsKey($k)) { $gl[$k] = [pscustomobject]@{ Account = $k; Lines = 0; Debit = [decimal]0; Credit = [decimal]0 } }
        $gl[$k].Lines++; $gl[$k].Debit += ConvertTo-Dec (Get-Prop $x 'debit'); $gl[$k].Credit += ConvertTo-Dec (Get-Prop $x 'credit')
    }

    # ---- 4) tie to the validated Trial Balance ----
    $prevQ = Invoke-SuiteQL $conn ("SELECT tp.periodname AS periodname FROM accountingperiod tp WHERE tp.isquarter = 'F' AND tp.isyear = 'F' " +
        "AND tp.enddate < (SELECT rg.rstart FROM $($sql.Range) rg) ORDER BY tp.enddate DESC, tp.startdate DESC") 1
    $prev = if ($prevQ.Status -eq 200 -and @(Get-Prop $prevQ.Body 'items').Count -gt 0) { Get-Prop $prevQ.Body.items[0] 'periodname' } else { $null }
    $fyTo = Get-Prop (Invoke-SuiteQL $conn "SELECT per.fystart AS fystart FROM $((Get-TbSql $ToPeriod).Per) per").Body.items[0] 'fystart'
    $fyPrev = if ($prev) { Get-Prop (Invoke-SuiteQL $conn "SELECT per.fystart AS fystart FROM $((Get-TbSql $prev).Per) per").Body.items[0] 'fystart' } else { $null }
    if (-not $prev -or "$fyTo" -ne "$fyPrev") {
        Write-Host "[SKIP] TB tie: the period before '$FromPeriod' ($prev) is in a different fiscal year, so TB differences include the year-end roll. Pick a range that doesn't start in the fiscal year's first period." -ForegroundColor Yellow
    }
    else {
        $tbNet = {
            param($p)
            $q = Get-TbSql $p
            $tt = Invoke-SuiteQL $conn $q.Totals
            if ($tt.Status -ne 200) { throw "TB totals failed for $p (HTTP $($tt.Status)): $(Format-NsError $tt)" }
            $all = Get-AllRows $conn $q.Rows ([int](ConvertTo-Dec (Get-Prop $tt.Body.items[0] 'cnt')))
            $m = @{}
            foreach ($x in $all) { $m["$(Get-Prop $x 'acctnumber')|$(Get-Prop $x 'acctname')"] = (ConvertTo-Dec (Get-Prop $x 'debit')) - (ConvertTo-Dec (Get-Prop $x 'credit')) }
            return $m
        }
        $tbTo = & $tbNet $ToPeriod
        $tbPrev = & $tbNet $prev
        $keys = @($tbTo.Keys) + @($tbPrev.Keys) + @($gl.Keys) | Sort-Object -Unique
        $bad = foreach ($k in $keys) {
            $mv = $(if ($tbTo.ContainsKey($k)) { $tbTo[$k] } else { [decimal]0 }) - $(if ($tbPrev.ContainsKey($k)) { $tbPrev[$k] } else { [decimal]0 })
            $g = if ($gl.ContainsKey($k)) { $gl[$k].Debit - $gl[$k].Credit } else { [decimal]0 }
            if ($mv -ne $g) { [pscustomobject]@{ Account = $k; GL_net = $g.ToString('N2', $inv); TB_movement = $mv.ToString('N2', $inv) } }
        }
        Report (@($bad).Count -eq 0) "TB tie: every account's GL net = TB($ToPeriod) - TB($prev) ($($keys.Count) accounts compared)."
        if (@($bad).Count -gt 0) { Write-Host 'First mismatches:'; @($bad) | Select-Object -First 10 | Format-Table -AutoSize | Out-String | Write-Host }
    }

    # ---- 5) info: date vs period ----
    $o = Invoke-SuiteQL $conn "SELECT COUNT(*) AS n $($sql.From) WHERE $($sql.Where) AND (t.trandate < pp.startdate OR t.trandate > pp.enddate)"
    if ($o.Status -eq 200) { Write-Host "Info: $(Get-Prop $o.Body.items[0] 'n') of $tc lines have a transaction date outside their posting period (a date filter would have misplaced them)." }

    # ---- outputs ----
    $outDir = Join-Path $PSScriptRoot '..\api\out'
    New-Item -ItemType Directory -Force $outDir | Out-Null
    $tag = (($FromPeriod + '_to_' + $ToPeriod) -replace '[^A-Za-z0-9_]', '_')
    $rows | ForEach-Object {
        [pscustomobject]@{ period = Get-Prop $_ 'postingperiod'; date = Get-Prop $_ 'trandate'; type = Get-Prop $_ 'trantype'; tranid = Get-Prop $_ 'tranid'
            acctnumber = Get-Prop $_ 'acctnumber'; acctname = Get-Prop $_ 'acctname'; name = Get-Prop $_ 'entityname'; subsidiary = Get-Prop $_ 'subsidiary'
            memo = Get-Prop $_ 'memo'; debit = (ConvertTo-Dec (Get-Prop $_ 'debit')).ToString('F2', $inv); credit = (ConvertTo-Dec (Get-Prop $_ 'credit')).ToString('F2', $inv) }
    } | Export-Csv -LiteralPath (Join-Path $outDir "gl-$tag.csv")
    $gl.Values | Sort-Object Account | ForEach-Object {
        [pscustomobject]@{ account = $_.Account; lines = $_.Lines; debit = $_.Debit.ToString('F2', $inv); credit = $_.Credit.ToString('F2', $inv); net = ($_.Debit - $_.Credit).ToString('F2', $inv) }
    } | Export-Csv -LiteralPath (Join-Path $outDir "gl-$tag-by-account.csv")
    Write-Host "`nWrote gl-$tag.csv and gl-$tag-by-account.csv to $outDir (gitignored financial data; do not share or commit)."
}
finally {
    $conn = $null
    [GC]::Collect()
}
if ($failed) { exit 1 }
