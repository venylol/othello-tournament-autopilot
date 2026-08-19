[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$source = [System.IO.Path]::GetFullPath($SourceRoot)
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$dataRelative = 'research/offbook_detection/data'
$datasets = @(
    'oq_sentinel_reference_level22_1600plus_v6_20260819',
    'oq_sentinel_elo_reference_level22_1600plus_v5_20260819'
)

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "SourceRoot does not exist: $source"
}
if (Test-Path -LiteralPath $output) {
    throw "OutputDirectory already exists: $output"
}
if (-not (Get-Command rg -ErrorAction SilentlyContinue)) {
    throw 'ripgrep (rg) is required for the privacy scan.'
}

$staging = Join-Path $output 'staging'
[System.IO.Directory]::CreateDirectory($staging) | Out-Null

foreach ($dataset in $datasets) {
    $sourceDirectory = Join-Path $source (Join-Path $dataRelative $dataset)
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
        throw "Dataset does not exist: $sourceDirectory"
    }
    Copy-Item -LiteralPath $sourceDirectory -Destination (Join-Path $staging $dataset) -Recurse
}

function Write-PublicJson {
    param([string]$Path, [object]$Value)
    [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 30), $utf8NoBom)
}

$sentinelName = $datasets[0]
$sentinelDirectory = Join-Path $staging $sentinelName
$sentinelSourceManifestPath = Join-Path $sentinelDirectory 'reference_source_manifest.json'
$sentinelSourceManifest = Get-Content -LiteralPath $sentinelSourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$sentinelSourceManifest.referenceDirectory = "$dataRelative/oq_elo_matchup400_reference_level22_1600plus_20260815"
$sentinelSourceManifest.deterministicOffbookAlgorithm.script = 'scripts/analysis/detect_offbook.py'
Write-PublicJson -Path $sentinelSourceManifestPath -Value $sentinelSourceManifest

$eloName = $datasets[1]
$eloDirectory = Join-Path $staging $eloName
$eloSourceManifestPath = Join-Path $eloDirectory 'reference_source_manifest.json'
$eloSourceManifest = Get-Content -LiteralPath $eloSourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$eloSourceManifest.sourceReferenceDirectory = "$dataRelative/oq_elo_matchup400_reference_level22_1600plus_20260815"
$eloSourceManifest.sentinelDerivedDirectory = "$dataRelative/$sentinelName"
$eloSourceManifest.engineContract.enginePath = 'Egaroucid_for_Console_7_8_1_AVX512_AMD.exe'
$eloSourceManifest.engineContract.sourceBundle = "$dataRelative/oq_elo_matchup400_reference_level22_1600plus_20260815/selected_account_bundle.json"
$eloSourceManifest.algorithmRecordSource.path = "$dataRelative/$sentinelName/directed_target_records.jsonl"
$eloSourceManifest.buildScripts[0].path = 'scripts/analysis/sentinel_elo_analysis.py'
$eloSourceManifest.buildScripts[1].path = 'src/player_analysis_toolkit/sentinel_elo.py'
$eloSourceManifest.config.path = 'sentinel_elo_reference_config.json'
Write-PublicJson -Path $eloSourceManifestPath -Value $eloSourceManifest

function Update-HashManifest {
    param([string]$DatasetDirectory, [string]$ReferenceDirectory = '')
    $manifestPath = Join-Path $DatasetDirectory 'reference_sha256_manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ReferenceDirectory -and $manifest.PSObject.Properties.Name -contains 'referenceDirectory') {
        $manifest.referenceDirectory = $ReferenceDirectory
    }
    foreach ($entry in $manifest.files) {
        $filePath = Join-Path $DatasetDirectory ([string]$entry.path)
        $item = Get-Item -LiteralPath $filePath
        $entry.bytes = [long]$item.Length
        $entry.sha256 = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Write-PublicJson -Path $manifestPath -Value $manifest
}

Update-HashManifest -DatasetDirectory $sentinelDirectory
Update-HashManifest -DatasetDirectory $eloDirectory -ReferenceDirectory "$dataRelative/$eloName"

$blockedRegex = '(?i)(C:\\\\Users\\\\[^\\\\]+\\\\(?:Desktop|Documents|Downloads)\\\\|BEGIN [A-Z ]*PRIVATE KEY|github_pat_|sk-[A-Za-z0-9])'
$blockedFiles = @(& rg -l -i --hidden --glob '!*.zip' -- $blockedRegex $staging 2>$null)
if ($blockedFiles.Count -gt 0) {
    throw "Blocked local identifier or path appears in staged data: $($blockedFiles[0])"
}

$assetRows = foreach ($dataset in $datasets) {
    $datasetDirectory = Join-Path $staging $dataset
    $zipPath = Join-Path $output ($dataset.Replace('_', '-') + '.zip')
    Compress-Archive -LiteralPath $datasetDirectory -DestinationPath $zipPath -CompressionLevel Optimal
    $files = @(Get-ChildItem -LiteralPath $datasetDirectory -Recurse -File)
    $zip = Get-Item -LiteralPath $zipPath
    [pscustomobject]@{
        name = $zip.Name
        installPath = 'player_analysis_toolkit/research/offbook_detection/data'
        sourceFiles = $files.Count
        sourceBytes = [long](($files | Measure-Object Length -Sum).Sum)
        assetBytes = [long]$zip.Length
        sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        privacyTransform = 'local absolute paths replaced with repository-relative paths'
    }
}

$releaseManifest = [ordered]@{
    schema = 'player-analysis-sentinel-public-release-assets-v2'
    createdAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    assets = @($assetRows)
}
Write-PublicJson -Path (Join-Path $output 'release-assets.json') -Value $releaseManifest
$sums = ($assetRows | ForEach-Object { "$($_.sha256)  $($_.name)" }) -join "`n"
[System.IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), $sums + "`n", $utf8NoBom)
$assetRows
