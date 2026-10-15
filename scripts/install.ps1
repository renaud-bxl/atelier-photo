#requires -version 5.1
<## Atelier Photo : téléchargement et installation ZIP portable, dans le compte courant. ##>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Repository,
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\Atelier Photo')
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$machineArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($machineArchitecture -ne 'AMD64') { throw "Seule la version Windows x64 est préparée ; Windows ARM64 n'est pas validé." }
if (-not [IO.Path]::IsPathRooted($Destination)) { throw 'Le dossier de destination doit être un chemin absolu.' }
if (Test-Path -LiteralPath $Destination) { throw "Une installation existe déjà : $Destination. Déplacez-la avant de réinstaller." }
$taskTemporaryPath = Join-Path ([IO.Path]::GetTempPath()) ('atelier-photo-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskTemporaryPath | Out-Null
try {
    Write-Host 'Recherche de la dernière version publiée…'
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers @{ 'User-Agent' = 'AtelierPhoto-Installer'; Accept = 'application/vnd.github+json' } -TimeoutSec 60
    $tag = [string]$release.tag_name
    if ($tag -notmatch '^v?\d+\.\d+\.\d+$') { throw 'La dernière version doit avoir un tag stable vMAJEUR.MINEUR.CORRECTIF.' }
    $version = $tag -replace '^v', ''
    $assetName = "AtelierPhoto-$version-win-x64.zip"
    $base = "https://github.com/$Repository/releases/download/$tag"
    $checksumsPath = Join-Path $taskTemporaryPath 'SHA256SUMS'
    $archivePath = Join-Path $taskTemporaryPath $assetName
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $checksumsPath -TimeoutSec 120
    $escapedName = [regex]::Escape($assetName)
    $matchesForAsset = @(Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "^[A-Fa-f0-9]{64}\s{2}$escapedName`$" })
    if ($matchesForAsset.Count -ne 1) { throw "L'empreinte SHA-256 exacte de cette archive est absente ou ambiguë." }
    $expectedHash = $matchesForAsset[0].Substring(0, 64)
    Write-Host "Téléchargement de $assetName…"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$assetName" -OutFile $archivePath -TimeoutSec 600
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if (-not [string]::Equals($actualHash, $expectedHash, [StringComparison]::OrdinalIgnoreCase)) { throw "L'empreinte SHA-256 ne correspond pas. Installation annulée." }
    Write-Host 'Empreinte SHA-256 vérifiée.'
    $extractedPath = Join-Path $taskTemporaryPath 'extracted'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractedPath
    if (-not (Test-Path -LiteralPath (Join-Path $extractedPath 'Atelier Photo.exe'))) { throw "L'archive ne contient pas Atelier Photo.exe." }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Move-Item -LiteralPath $extractedPath -Destination $Destination
    Write-Host "Installation terminée : $Destination"
    Write-Host "Lancez Atelier Photo.exe dans ce dossier. Aucune politique de sécurité ni protection du système n'a été modifiée."
} finally {
    if (Test-Path -LiteralPath $taskTemporaryPath) { Remove-Item -LiteralPath $taskTemporaryPath -Recurse -Force }
}
