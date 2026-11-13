# Shared helpers for the NetSuite test scripts. Dot-source it:  . "$PSScriptRoot/NsCommon.ps1"
# Secrets come from 1Password; the private key is used once to get a token and then dropped. Nothing secret is printed.
#
# !! The SQL builders below are COPIES of api/src/lib/catalog.ts (PowerShell cannot import TypeScript).
# !! They are checked against catalog.ts mechanically; keep the BEGIN-SQL/END-SQL blocks to simple assignments.

$script:inv = [System.Globalization.CultureInfo]::InvariantCulture

function ConvertTo-Base64Url([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }

# NetSuite omits null columns from SuiteQL rows, so read properties defensively.
function Get-Prop($o, [string]$n) { $p = $o.PSObject.Properties[$n]; if ($p) { return $p.Value } else { return $null } }

# Exact decimal parse; NetSuite may send scientific notation (e.g. 4.221607343E7).
function ConvertTo-Dec($v) {
    if ($null -eq $v -or "$v" -eq '') { return [decimal]0 }
    return [decimal]::Parse([string]::Format($script:inv, '{0}', $v), [System.Globalization.NumberStyles]::Float, $script:inv)
}

function Connect-NetSuite([string]$Vault, [string]$Item) {
    function Get-OpField([string]$Field) {
        $v = op read "op://$Vault/$Item/$Field" 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($v)) { throw "Could not read 1Password field '$Field' (is the app unlocked?)." }
        return ($v -join "`n").Trim()
    }
    $ecdsa = $null; $pem = $null
    try {
        $accountId = Get-OpField 'account_id'; $clientId = Get-OpField 'client_id'; $certId = Get-OpField 'certificate_id'; $pem = Get-OpField 'private_key'
        $base = "https://$($accountId.ToLowerInvariant().Replace('_', '-')).suitetalk.api.netsuite.com"
        if ($base -notmatch '-sb\d*\.suitetalk') { throw "Host $base is not a sandbox. These test scripts only run against sandboxes." }
        $ecdsa = [System.Security.Cryptography.ECDsa]::Create(); $ecdsa.ImportFromPem($pem)
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $h = @{ alg = 'ES256'; typ = 'JWT'; kid = $certId } | ConvertTo-Json -Compress
        $c = @{ iss = $clientId; scope = @('rest_webservices'); aud = "$base/services/rest/auth/oauth2/v1/token"; iat = $now; exp = $now + 3300 } | ConvertTo-Json -Compress
        $si = (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($h))) + '.' + (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($c)))
        $sig = $ecdsa.SignData([Text.Encoding]::UTF8.GetBytes($si), [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation)
        $tr = Invoke-RestMethod -Method Post -Uri "$base/services/rest/auth/oauth2/v1/token" -ContentType 'application/x-www-form-urlencoded' -SkipHttpErrorCheck -StatusCodeVariable ts -Body @{
            grant_type = 'client_credentials'; client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'; client_assertion = "$si." + (ConvertTo-Base64Url $sig) }
        if ($ts -ne 200) { throw "Token request failed (HTTP $ts)." }
        return [pscustomobject]@{ Base = $base; Token = $tr.access_token }
    }
    finally {
        $pem = $null
        if ($ecdsa) { $ecdsa.Dispose() }
    }
}

function Invoke-SuiteQL($Conn, [string]$Sql, [int]$Limit = 1000, [int]$Offset = 0) {
    $r = Invoke-RestMethod -Method Post -Uri "$($Conn.Base)/services/rest/query/v1/suiteql?limit=$Limit&offset=$Offset" `
        -Headers @{ Authorization = "Bearer $($Conn.Token)"; Prefer = 'transient' } -ContentType 'application/json' `
        -Body (@{ q = $Sql } | ConvertTo-Json -Compress) -SkipHttpErrorCheck -StatusCodeVariable sc
    [pscustomobject]@{ Status = $sc; Body = $r }
}

function Format-NsError($r) {
    if ($r.Body -is [string]) { return $r.Body }
    $d = Get-Prop $r.Body 'o:errorDetails'
    if ($d) { return ($d | ForEach-Object { Get-Prop $_ 'detail' }) -join ' | ' }
    return ($r.Body | ConvertTo-Json -Depth 5 -Compress)
}

# Pages a row query exactly like the API: 1,000 per call, every page must be full except the last.
function Get-AllRows($Conn, [string]$Sql, [int]$Expected) {
    $all = [System.Collections.Generic.List[object]]::new()
    for ($off = 0; $off -lt $Expected; $off += 1000) {
        $p = Invoke-SuiteQL $Conn $Sql 1000 $off
        if ($p.Status -ne 200) { throw "Row query failed at offset $off (HTTP $($p.Status)): $(Format-NsError $p)" }
        $items = @(Get-Prop $p.Body 'items')
        $want = [math]::Min(1000, $Expected - $off)
        if ($items.Count -ne $want) { throw "Page at offset $off returned $($items.Count) rows, expected $want." }
        $items | ForEach-Object { $all.Add($_) }
    }
    return , $all
}

# ---------------- SQL builders (copies of catalog.ts) ----------------

function Get-LineSql([string]$From, [string]$To, [string]$ExtraWhere = '') {
    # BEGIN-SQL line
    $talFrom = 'FROM transactionaccountingline tal INNER JOIN transaction t ON t.id = tal.transaction'
    $talBase = "tal.posting = 'T' AND tal.accountingbook = 1"
    $rg = "(SELECT MAX(CASE WHEN tp.periodname = '$From' THEN tp.startdate END) AS rstart, " +
          "MAX(CASE WHEN tp.periodname = '$To' THEN tp.enddate END) AS rend FROM accountingperiod tp " +
          "WHERE tp.isquarter = 'F' AND tp.isyear = 'F' AND tp.periodname IN ('$From', '$To'))"
    $from = "$talFrom INNER JOIN accountingperiod pp ON pp.id = t.postingperiod " +
            "INNER JOIN $rg rg ON 1 = 1"
    $where = "$talBase AND pp.startdate >= rg.rstart AND pp.enddate <= rg.rend$ExtraWhere"
    $totalsSql = "SELECT COUNT(*) AS cnt, ROUND(SUM(tal.debit), 2) AS debits, ROUND(SUM(tal.credit), 2) AS credits $from WHERE $where"
    $rowsSql = "SELECT pp.periodname AS postingperiod, TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, t.type AS trantype, t.tranid AS tranid, " +
               "a.acctnumber AS acctnumber, a.accountsearchdisplayname AS acctname, BUILTIN.DF(t.entity) AS entityname, " +
               "BUILTIN.DF(tl.subsidiary) AS subsidiary, tl.memo AS memo, tal.debit AS debit, tal.credit AS credit " +
               "$from INNER JOIN account a ON a.id = tal.account " +
               "LEFT JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline " +
               "WHERE $where ORDER BY pp.startdate, t.trandate, t.id, tal.transactionline, tal.account"
    # END-SQL line
    return [pscustomobject]@{ Totals = $totalsSql; Rows = $rowsSql; From = $from; Where = $where; Range = $rg }
}

function Get-GlAccountFilter([string]$Account) {
    # BEGIN-SQL glacct
    $extra = " AND tal.account IN (SELECT id FROM account WHERE acctnumber = '$Account')"
    # END-SQL glacct
    return $extra
}

function Get-JournalFilter {
    # BEGIN-SQL je
    $extra = " AND t.type = 'Journal'"
    # END-SQL je
    return $extra
}

function Get-TbSql([string]$Period) {
    # BEGIN-SQL tb
    $per = "(SELECT p.pstart AS pstart, p.pend AS pend, (SELECT MAX(y.startdate) FROM accountingperiod y WHERE y.isyear = 'T' AND y.startdate <= p.pstart) AS fystart " +
           "FROM (SELECT MAX(tp.startdate) AS pstart, MAX(tp.enddate) AS pend FROM accountingperiod tp WHERE tp.periodname = '$Period' AND tp.isquarter = 'F' AND tp.isyear = 'F') p)"
    $plTypes = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'"
    $priorPL = "(a.accttype IN ($plTypes) AND pp.startdate < per.fystart)"
    $from = 'FROM transactionaccountingline tal INNER JOIN transaction t ON t.id = tal.transaction INNER JOIN accountingperiod pp ON pp.id = t.postingperiod INNER JOIN account a ON a.id = tal.account INNER JOIN ' + $per + " per ON 1 = 1 INNER JOIN (SELECT MAX(id) AS reid FROM account WHERE sspecacct = 'RetEarnings') rx ON 1 = 1 INNER JOIN account rea ON rea.id = rx.reid"
    $where = "tal.posting = 'T' AND tal.accountingbook = 1 AND per.fystart IS NOT NULL AND pp.enddate <= per.pend"
    $key = "CASE WHEN $priorPL THEN rea.id ELSE a.id END"
    $num = "CASE WHEN $priorPL THEN rea.acctnumber ELSE a.acctnumber END"
    $name = "CASE WHEN $priorPL THEN rea.accountsearchdisplayname ELSE a.accountsearchdisplayname END"
    $type = "CASE WHEN $priorPL THEN rea.accttype ELSE a.accttype END"
    $totalsSql = "SELECT COUNT(DISTINCT $key) AS cnt, ROUND(SUM(tal.debit), 2) AS debits, ROUND(SUM(tal.credit), 2) AS credits $from WHERE $where"
    $rowsSql = "SELECT $num AS acctnumber, $name AS acctname, $type AS accttype, ROUND(SUM(tal.debit), 2) AS debit, ROUND(SUM(tal.credit), 2) AS credit $from WHERE $where GROUP BY $key, $num, $name, $type ORDER BY $num, $key"
    # END-SQL tb
    return [pscustomobject]@{ Totals = $totalsSql; Rows = $rowsSql; Per = $per }
}
