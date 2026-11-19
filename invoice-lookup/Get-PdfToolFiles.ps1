<#
.SYNOPSIS
    Downloads the three PDF viewer library files used by the Vendor Invoice Lookup Suitelet
    (nts_vendor_doc_lookup_sl.js, see PDF VIEWER AND NOTES) and checks they are the exact,
    unmodified versions the Suitelet was tested with.

.DESCRIPTION
    Gets the official packages from the npm registry, checks each package against the
    registry's published integrity hash, unpacks it, and checks each file's SHA-256.
    If any check fails, it stops and copies nothing.

    Afterwards, upload the three files to the NetSuite File Cabinet folder
        SuiteScripts/AP Invoice Lookup/lib
    (sandbox first, then production), keeping the file names as they are.

    Needs Windows 10 (1803) or later, for the built-in tar.exe. No sign-in or secrets needed.

.EXAMPLE
    .\Get-PdfToolFiles.ps1
    .\Get-PdfToolFiles.ps1 -OutDir C:\Temp\pdf-tool-files
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path -Path (Get-Location) -ChildPath 'pdf-tool-files')
)

$ErrorActionPreference = 'Stop'

# Pinned versions. Keep in step with PDF_TOOL_FILES in nts_vendor_doc_lookup_sl.js.
$Packages = @(
    @{
        Name      = 'pdfjs-dist 3.11.174'
        Url       = 'https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-3.11.174.tgz'
        Integrity = 'sha512-TdTZPf1trZ8/UFu5Cx/GXB7GZM30LT+wWUNfsi6Bq8ePLnb+woNKtDymI2mxZYBpMbonNFqKmiz684DIfnd8dA=='
        Files     = @(
            @{ From = 'package/build/pdf.min.js';        To = 'pdf.min.js';        Sha256 = '5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946' },
            @{ From = 'package/build/pdf.worker.min.js'; To = 'pdf.worker.min.js'; Sha256 = 'feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b' }
        )
    },
    @{
        Name      = 'pdf-lib 1.17.1'
        Url       = 'https://registry.npmjs.org/pdf-lib/-/pdf-lib-1.17.1.tgz'
        Integrity = 'sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw=='
        Files     = @(
            @{ From = 'package/dist/pdf-lib.min.js'; To = 'pdf-lib.min.js'; Sha256 = '0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f' }
        )
    }
)

if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    throw 'tar.exe was not found. It comes with Windows 10 (1803) and later.'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$work = Join-Path -Path ([IO.Path]::GetTempPath()) -ChildPath ('pdf-tool-files-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    $ready = @()
    foreach ($pkg in $Packages) {
        Write-Host "Downloading $($pkg.Name)..."
        $tgz = Join-Path -Path $work -ChildPath ([IO.Path]::GetFileName($pkg.Url))
        Invoke-WebRequest -Uri $pkg.Url -OutFile $tgz -UseBasicParsing

        # The registry's integrity value is sha512-<base64 of the package's SHA-512>.
        $sha512 = [Security.Cryptography.SHA512]::Create()
        try { $hash = $sha512.ComputeHash([IO.File]::ReadAllBytes($tgz)) } finally { $sha512.Dispose() }
        $got = 'sha512-' + [Convert]::ToBase64String($hash)
        if ($got -ne $pkg.Integrity) {
            throw "$($pkg.Name): the download does not match the npm registry's integrity hash. Nothing was copied."
        }

        $unpack = Join-Path -Path $work -ChildPath ($pkg.Name -replace '[^A-Za-z0-9.-]', '_')
        New-Item -ItemType Directory -Path $unpack | Out-Null
        & tar.exe -xzf $tgz -C $unpack
        if ($LASTEXITCODE -ne 0) { throw "$($pkg.Name): could not unpack the download." }

        foreach ($f in $pkg.Files) {
            $src = Join-Path -Path $unpack -ChildPath $f.From
            if (-not (Test-Path -LiteralPath $src)) { throw "$($pkg.Name): $($f.From) is missing from the package." }
            $fileHash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($fileHash -ne $f.Sha256) { throw "$($f.To): SHA-256 does not match the tested file. Nothing was copied." }
            $ready += [pscustomobject]@{ Source = $src; File = $f.To; Sha256 = $fileHash }
        }
    }

    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    foreach ($r in $ready) { Copy-Item -LiteralPath $r.Source -Destination (Join-Path -Path $OutDir -ChildPath $r.File) -Force }

    Write-Host ''
    Write-Host "All checks passed. Files are in $OutDir" -ForegroundColor Green
    $ready | Select-Object File, Sha256 | Format-Table -AutoSize
    Write-Host 'Next: upload these three files to the File Cabinet folder SuiteScripts/AP Invoice Lookup/lib'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
