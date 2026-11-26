# Builds the portable release zip from the local green-release folder.
#
#   - copies GeoTagStudio.exe, exiftool.exe and exiftool_files
#   - never copies green-release\data (it holds the owner's map key and processing history)
#   - adds README.txt, LICENSE.txt and THIRD-PARTY-NOTICES.txt next to the program
#
# The program does not depend on the Microsoft Visual C++ runtime: every DLL it loads is a Windows
# component. So no vcruntime140.dll, msvcp140.dll and the like belong in the package.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\package-release.ps1 [-Version 0.1.0]
#
# The version is read from src-tauri\tauri.conf.json unless -Version is given.
# The result is release\GeoTagStudio-<version>-win-x64.zip with one top-level folder inside.

param(
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'green-release'
$output = Join-Path $root 'release'

if (-not $Version) {
    $config = Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
    $Version = $config.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') {
    throw "Unexpected version string: '$Version'"
}

# 1. everything the portable build needs must be present
$required = @(
    'GeoTagStudio.exe', 'exiftool.exe'
)
foreach ($name in $required) {
    if (-not (Test-Path (Join-Path $source $name))) {
        throw "Missing '$name' in $source. Build first and assemble green-release as described in the release guide under docs."
    }
}
if (-not (Test-Path (Join-Path $source 'exiftool_files\perl*.dll'))) {
    throw "exiftool_files is incomplete: no perl*.dll inside it. Copy the whole folder from the official ExifTool Windows package."
}

# VC++ runtime DLLs next to the program are not needed and are not packaged; say so if they turn up
$stray = @(Get-ChildItem $source -File | Where-Object { $_.Name -match '^(vcruntime|msvcp|concrt|vccorlib)140.*\.dll$' })
if ($stray.Count -gt 0) {
    Write-Warning ("VC++ runtime DLLs sit in {0} ({1}). The program does not need them, so they are left out of the package. See the release guide in docs." -f $source, ($stray.Name -join ', '))
}

# 2. stage the files in a folder named after the package
$folderName = "GeoTagStudio-$Version-win-x64"
$holding = Join-Path $env:TEMP ("GeoTagStudio-package-" + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $holding $folderName
New-Item -ItemType Directory -Path $stage | Out-Null

try {
    Copy-Item (Join-Path $source 'exiftool.exe') $stage
    Copy-Item (Join-Path $source 'exiftool_files') $stage -Recurse
    Copy-Item (Join-Path $source 'GeoTagStudio.exe') $stage

    # Notepad on older Windows 10 needs the byte order mark to read UTF-8 Chinese text, and shows
    # LF-only files as one long line.  So: byte order mark, and Windows line endings whatever the
    # checkout happened to produce.
    $utf8WithBom = New-Object System.Text.UTF8Encoding($true)
    $documents = @(
        @('packaging\README.txt', 'README.txt'),
        @('LICENSE', 'LICENSE.txt'),
        @('THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.txt')
    )
    foreach ($pair in $documents) {
        $text = [System.IO.File]::ReadAllText((Join-Path $root $pair[0]), [System.Text.Encoding]::UTF8)
        $text = $text -replace "`r?`n", "`r`n"
        [System.IO.File]::WriteAllText((Join-Path $stage $pair[1]), $text, $utf8WithBom)
    }

    # 3. zip: the user's own green-release\data (map key, processing history) must never be in
    #    here.  Only the top level matters: ExifTool itself ships folders called lib\Data.
    if (Get-ChildItem $stage | Where-Object { $_.Name -eq 'data' }) {
        throw "A 'data' folder ended up at the top level of the package."
    }

    New-Item -ItemType Directory -Path $output -Force | Out-Null
    $zip = Join-Path $output "$folderName.zip"
    if (Test-Path $zip) { Remove-Item $zip }

    # Entries are written by hand: the .NET Framework's CreateFromDirectory separates folders with a
    # backslash, which Windows Explorer accepts but other unzip tools do not.  A zip always uses '/'.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $backslash = [string][char]92
    $earliest = [datetime]::new(1980, 1, 1)
    $base = $stage.TrimEnd([char]92)
    $count = 0
    $stream = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
    try {
        $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in Get-ChildItem $stage -Recurse -File) {
                $entryName = "$folderName/" + $file.FullName.Substring($base.Length).TrimStart([char]92).Replace($backslash, '/')
                $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
                $when = $file.LastWriteTime
                if ($when -lt $earliest) { $when = $earliest }
                $entry.LastWriteTime = $when
                $inputStream = $file.OpenRead()
                $entryStream = $entry.Open()
                try { $inputStream.CopyTo($entryStream) }
                finally { $entryStream.Dispose(); $inputStream.Dispose() }
                $count++
            }
        }
        finally { $archive.Dispose() }
    }
    finally { $stream.Dispose() }

    $size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
    Write-Host "Created $zip ($size MB, $count files)"
}
finally {
    Remove-Item $holding -Recurse -Force -ErrorAction SilentlyContinue
}
