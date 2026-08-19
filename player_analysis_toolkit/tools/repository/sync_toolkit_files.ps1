[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,

    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot,

    [Parameter(Mandatory = $true)]
    [string[]]$Paths,

    [string]$BlockedRegex = ''
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($SourceRoot)
$destination = [System.IO.Path]::GetFullPath($DestinationRoot)

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "SourceRoot does not exist: $source"
}
if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
    throw "DestinationRoot does not exist: $destination"
}

$rows = foreach ($relativePath in $Paths) {
    $relative = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $sourcePath = [System.IO.Path]::GetFullPath((Join-Path $source $relative))
    $destinationPath = [System.IO.Path]::GetFullPath((Join-Path $destination $relative))
    if (-not $sourcePath.StartsWith($source + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Source path escapes SourceRoot: $relativePath"
    }
    if (-not $destinationPath.StartsWith($destination + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Destination path escapes DestinationRoot: $relativePath"
    }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Source file does not exist: $relativePath"
    }
    if ($BlockedRegex) {
        $text = [System.IO.File]::ReadAllText($sourcePath, [System.Text.Encoding]::UTF8)
        if ($text -match $BlockedRegex) {
            throw "Blocked content appears in source file: $relativePath"
        }
    }

    $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $destinationHash = if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
        (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    } else {
        $null
    }
    $action = if ($sourceHash -eq $destinationHash) { 'unchanged' } elseif ($destinationHash) { 'update' } else { 'add' }

    if ($action -ne 'unchanged' -and $PSCmdlet.ShouldProcess($destinationPath, "$action from $sourcePath")) {
        $parent = Split-Path -Parent $destinationPath
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
        [System.IO.File]::Copy($sourcePath, $destinationPath, $true)
    }

    [pscustomobject]@{
        path = $relativePath.Replace('\', '/')
        action = $action
        sha256 = $sourceHash
    }
}

$rows
