#requires -version 5.1
<#
Native PowerShell installer QA. Only the two HTTP commands are replaced.
SHA-256, ZIP extraction, destination handling and the installer are real.
No ExecutionPolicy change, network access, app launch, registry or API key.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$WorkingDirectory = [IO.Path]::GetTempPath()
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
    throw 'This test must use native Windows PowerShell 5.1.'
}
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).ProviderPath
$ArchivePath = (Resolve-Path -LiteralPath $ArchivePath).ProviderPath
if (-not [IO.Path]::IsPathRooted($WorkingDirectory)) { throw 'WorkingDirectory must be absolute.' }
$assetName = "AtelierPhoto-$Version-win-x64.zip"
if ([IO.Path]::GetFileName($ArchivePath) -cne $assetName) { throw 'The test needs the exact final release ZIP.' }
$originalArchiveHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
$originalInstallerHash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash
$parseTokens = $null
$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The production installer failed the native PowerShell parser.' }

# Hash the executable directly from the real ZIP using native .NET streaming.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
try {
    $entry = $zip.GetEntry('Atelier Photo.exe')
    if ($null -eq $entry) { throw 'The final ZIP has no root Atelier Photo.exe.' }
    $entryStream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $expectedExeHash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-', '') }
    finally { $sha.Dispose(); $entryStream.Dispose() }
} finally { $zip.Dispose() }

$taskRoot = Join-Path $WorkingDirectory ('atelier-terminal-qa-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $taskRoot -Force
try {
    $wrapperPath = Join-Path $taskRoot 'offline installer wrapper.ps1'
    # ASCII source is intentional: native Windows PowerShell 5.1 does not assume
    # UTF-8 for a script without a BOM. The production script retains its BOM.
    $wrapper = @'
#requires -version 5.1
[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$ArchivePath,
    [string]$Version,
    [string]$ExpectedArchiveHash,
    [string]$ExpectedExeHash,
    [ValidateSet('success','checksum','existing')][string]$Mode,
    [string]$CaseDirectory
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$repository = 'renaud-bxl/atelier-photo'
$assetName = "AtelierPhoto-$Version-win-x64.zip"
$apiURL = "https://api.github.com/repos/$repository/releases/latest"
$downloadBase = "https://github.com/$repository/releases/download/v$Version"
$destination = Join-Path $CaseDirectory 'installation target with spaces'
$null = New-Item -ItemType Directory -Path $CaseDirectory
# Each wrapper has its own disposable powershell.exe process. A single explicit
# global fixture avoids dynamic-scope collisions with installer local variables.
$global:AtelierInstallerQAFixture = @{
    Requests = [Collections.Generic.List[string]]::new()
    TemporaryDirectories = [Collections.Generic.List[string]]::new()
    Archive = $ArchivePath
    ExpectedHash = $ExpectedArchiveHash
    Mode = $Mode
    Version = $Version
    Asset = $assetName
    APIURL = $apiURL
    DownloadBase = $downloadBase
}

function Invoke-RestMethod {
    [CmdletBinding()]
    param([uri]$Uri, [hashtable]$Headers, [int]$TimeoutSec)
    if ($Uri.AbsoluteUri -cne $global:AtelierInstallerQAFixture.APIURL) { throw 'Unexpected REST endpoint; live requests are forbidden.' }
    if ($Headers['User-Agent'] -ne 'AtelierPhoto-Installer' -or $Headers.Accept -ne 'application/vnd.github+json' -or $Headers.Authorization) { throw 'Unexpected release headers.' }
    $global:AtelierInstallerQAFixture.Requests.Add($Uri.AbsoluteUri)
    return [pscustomobject]@{ tag_name = 'v' + $global:AtelierInstallerQAFixture.Version }
}

function Invoke-WebRequest {
    [CmdletBinding()]
    param([switch]$UseBasicParsing, [uri]$Uri, [string]$OutFile, [int]$TimeoutSec)
    if (-not $UseBasicParsing) { throw 'The installer must support native PowerShell 5.1 basic parsing.' }
    $global:AtelierInstallerQAFixture.Requests.Add($Uri.AbsoluteUri)
    $requestDirectory = Split-Path -Parent $OutFile
    if (-not $global:AtelierInstallerQAFixture.TemporaryDirectories.Contains($requestDirectory)) { $global:AtelierInstallerQAFixture.TemporaryDirectories.Add($requestDirectory) }
    if ($Uri.AbsoluteUri -ceq ($global:AtelierInstallerQAFixture.DownloadBase + '/SHA256SUMS')) {
        $checksum = if ($global:AtelierInstallerQAFixture.Mode -eq 'checksum') { '0' * 64 } else { $global:AtelierInstallerQAFixture.ExpectedHash }
        [IO.File]::WriteAllText($OutFile, $checksum + '  ' + $global:AtelierInstallerQAFixture.Asset + [Environment]::NewLine, [Text.Encoding]::ASCII)
    } elseif ($Uri.AbsoluteUri -ceq ($global:AtelierInstallerQAFixture.DownloadBase + '/' + $global:AtelierInstallerQAFixture.Asset)) {
        Copy-Item -LiteralPath $global:AtelierInstallerQAFixture.Archive -Destination $OutFile
    } else { throw 'Unexpected download endpoint; live requests are forbidden.' }
}

if ($Mode -eq 'existing') {
    $null = New-Item -ItemType Directory -Path $destination
    [IO.File]::WriteAllText((Join-Path $destination 'sentinel.txt'), 'preserve existing installation', [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $destination 'Atelier Photo.exe'), 'existing executable sentinel', [Text.Encoding]::ASCII)
    $before = @(Get-ChildItem -LiteralPath $destination -File | Sort-Object Name | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
}
$installerError = $null
try { & $InstallerPath -Repository $repository -Destination $destination }
catch { $installerError = $_.Exception.Message }

if ($Mode -eq 'success') {
    if ($installerError) { throw "Expected installation success: $installerError" }
    if (-not (Test-Path -LiteralPath (Join-Path $destination 'Atelier Photo.exe') -PathType Leaf)) { throw 'The installed executable is missing.' }
    $installedHash = (Get-FileHash -LiteralPath (Join-Path $destination 'Atelier Photo.exe') -Algorithm SHA256).Hash
    if ($installedHash -cne $ExpectedExeHash) { throw 'The installed executable differs from the real final ZIP.' }
    if ($global:AtelierInstallerQAFixture.Requests.Count -ne 3) { throw 'Success must use exactly the release, checksums and ZIP requests.' }
} elseif ($Mode -eq 'checksum') {
    if (-not $installerError -or $installerError -notmatch 'SHA-256') { throw 'Checksum mismatch must be rejected by the real installer.' }
    if (Test-Path -LiteralPath $destination) { throw 'Checksum rejection must not create the destination.' }
    if ($global:AtelierInstallerQAFixture.Requests.Count -ne 3) { throw 'The checksum case must verify the downloaded ZIP.' }
} else {
    if (-not $installerError -or $installerError -notmatch 'existe') { throw 'An existing destination must be rejected.' }
    if ($global:AtelierInstallerQAFixture.Requests.Count -ne 0) { throw 'An existing destination must be rejected before any download.' }
    $after = @(Get-ChildItem -LiteralPath $destination -File | Sort-Object Name | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
    if (@(Compare-Object -ReferenceObject $before -DifferenceObject $after).Count -ne 0) { throw 'An existing installation was changed.' }
}
if ($Mode -ne 'existing') {
    $expectedRequests = @($apiURL, "$downloadBase/SHA256SUMS", "$downloadBase/$assetName")
    for ($index = 0; $index -lt $expectedRequests.Count; $index++) {
        if ($global:AtelierInstallerQAFixture.Requests[$index] -cne $expectedRequests[$index]) { throw 'The installer requested the wrong release asset.' }
    }
}
foreach ($requestDirectory in $global:AtelierInstallerQAFixture.TemporaryDirectories) {
    if (Test-Path -LiteralPath $requestDirectory) { throw 'The installer left its temporary downloads behind.' }
}
Write-Host "ATELIER_TERMINAL_INSTALL_CASE_OK $Mode"
'@
    [IO.File]::WriteAllText($wrapperPath, $wrapper, [Text.Encoding]::ASCII)
    $wrapperTokens = $null
    $wrapperErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($wrapperPath, [ref]$wrapperTokens, [ref]$wrapperErrors)
    if ($wrapperErrors.Count -ne 0) { throw 'The isolated installer wrapper failed the native PowerShell parser.' }
    $powershell = Join-Path $PSHOME 'powershell.exe'
    foreach ($mode in @('success', 'checksum', 'existing')) {
        $caseDirectory = Join-Path $taskRoot ("case $mode with spaces")
        & $powershell -NoProfile -NonInteractive -File $wrapperPath -InstallerPath $InstallerPath -ArchivePath $ArchivePath -Version $Version -ExpectedArchiveHash $originalArchiveHash -ExpectedExeHash $expectedExeHash -Mode $mode -CaseDirectory $caseDirectory
        if ($LASTEXITCODE -ne 0) { throw "Native terminal installer case failed: $mode" }
    }
    if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -cne $originalArchiveHash) { throw 'The final ZIP was modified.' }
    if ((Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash -cne $originalInstallerHash) { throw 'The production installer was modified.' }
    Write-Host 'ATELIER_TERMINAL_INSTALL_OK native PowerShell 5.1; real ZIP/SHA256/extraction; checksum rejection; existing target preserved; no Internet.'
} finally {
    if (Test-Path -LiteralPath $taskRoot) { Remove-Item -LiteralPath $taskRoot -Recurse -Force }
}
