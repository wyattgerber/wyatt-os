#Requires -Version 7.1
<#
.SYNOPSIS
  Prepares the demo video's REAL data and narration on your PC, as one zip to upload to Claude.

.DESCRIPTION
  1) Captures the demo scenario (addin/preview/demo/scenario.json) from the NetSuite SANDBOX through the real
     API code: formulas, one drill-down and one report. Secrets come from 1Password into this process only.
  2) Records the narration with the Windows built-in voice (SAPI), one WAV per scene. Nothing to install.
  3) Zips both to api\out\demo-package.zip (gitignored: it contains real sandbox financial data).

  Needs Node 20+ and the 1Password app unlocked. Run from anywhere:  ./Export-DemoData.ps1
#>
[CmdletBinding()]
param(
    [string]$Vault = 'NetSuite',
    [string]$Item = 'Excel Addin Connection',
    [string]$User = (git config user.email),
    # Windows voice to prefer (first installed match wins), e.g. 'Zira', 'David', 'Mark'.
    [string[]]$Voice = @('Aria', 'Jenny', 'Zira', 'David', 'Mark')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js not found (node -v).' }
if ([string]::IsNullOrWhiteSpace($User)) { throw 'Pass -User <your work email>.' }

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$demoDir = Join-Path $root 'addin\preview\demo'
$outDir = Join-Path $root 'api\out\demo'
New-Item -ItemType Directory -Force $outDir | Out-Null
Get-ChildItem $outDir -File -ErrorAction SilentlyContinue | Remove-Item -Force

function Get-OpField([string]$Field) {
    $v = op read "op://$Vault/$Item/$Field" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not read 1Password field '$Field' (is the app unlocked?)." }
    return ($v -join "`n").Trim()
}

# ---- 1) real data ----
$names = 'NETSUITE_ACCOUNT_ID', 'NETSUITE_CLIENT_ID', 'NETSUITE_CERTIFICATE_ID', 'NETSUITE_PRIVATE_KEY', 'ALLOWED_USERS', 'CLI_USER_EMAIL', 'NETSUITE_MOCK'
$oldNodeOptions = $env:NODE_OPTIONS
try {
    $env:NETSUITE_ACCOUNT_ID = Get-OpField 'account_id'
    $env:NETSUITE_CLIENT_ID = Get-OpField 'client_id'
    $env:NETSUITE_CERTIFICATE_ID = Get-OpField 'certificate_id'
    $env:NETSUITE_PRIVATE_KEY = Get-OpField 'private_key'
    $env:ALLOWED_USERS = $User
    $env:CLI_USER_EMAIL = $User
    Remove-Item Env:NETSUITE_MOCK -ErrorAction SilentlyContinue
    $env:NODE_OPTIONS = (@($env:NODE_OPTIONS, '--use-system-ca') | Where-Object { $_ }) -join ' '   # corporate HTTPS inspection
    Write-Host 'Capturing demo data from the NetSuite sandbox...'
    node (Join-Path $demoDir 'capture.mjs') (Join-Path $outDir 'demo-data.json')
    if ($LASTEXITCODE -ne 0) { throw 'Capture failed (see the message above).' }
}
finally {
    foreach ($n in $names) { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
    $env:NODE_OPTIONS = $oldNodeOptions
}

# ---- 2) narration with the built-in Windows voice ----
$scenario = Get-Content (Join-Path $demoDir 'scenario.json') -Raw | ConvertFrom-Json
$speaker = New-Object -ComObject SAPI.SpVoice
$installed = @($speaker.GetVoices()) | ForEach-Object { $_.GetDescription() }
$chosen = $null
foreach ($want in $Voice) { $chosen = @($speaker.GetVoices()) | Where-Object { $_.GetDescription() -match $want } | Select-Object -First 1; if ($chosen) { break } }
if ($chosen) { $speaker.Voice = $chosen }
Write-Host "Narration voice: $($speaker.Voice.GetDescription())   (installed: $($installed -join '; '))"
$i = 0
foreach ($line in $scenario.narration) {
    $i++
    $wav = Join-Path $outDir ('narration-{0:00}.wav' -f $i)
    $stream = New-Object -ComObject SAPI.SpFileStream
    $stream.Open($wav, 3)            # 3 = create for write
    $speaker.AudioOutputStream = $stream
    [void]$speaker.Speak($line)
    $stream.Close()
}
Write-Host "Recorded $i narration clips."

# ---- 3) package ----
$zip = Join-Path $root 'api\out\demo-package.zip'
Compress-Archive -Path (Join-Path $outDir '*') -DestinationPath $zip -Force
Write-Host "`nDone. Upload this file to Claude: $zip"
Write-Host 'It contains real sandbox financial data: do not commit or share it.'
