param(
    [Parameter(Mandatory = $true)][string]$ManifestDir,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Sha256
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# This changes WinGet policy and installs a package: only disposable hosted runners.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or !$env:RUNNER_TEMP) {
    throw 'Run this smoke test on a disposable Windows GitHub Actions runner.'
}
if ($Sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Expected executable SHA-256 is required.' }
$scratch = Join-Path $env:RUNNER_TEMP ('cavelon-winget-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $scratch | Out-Null
# Hosted Windows jobs run elevated. WinGet intentionally refuses elevated
# uninstall of user-scope portable packages, so use the matching machine scope.
$alias = Join-Path $env:ProgramFiles 'WinGet\Links\cavelon.exe'
if (Test-Path $alias) { throw 'Refusing to replace an existing Cavelon command.' }

function Find-WinGet {
    $command = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $package = Get-AppxPackage -Name Microsoft.DesktopAppInstaller | Select-Object -First 1
    if ($package) {
        $exe = Join-Path $package.InstallLocation 'winget.exe'
        if (Test-Path $exe) { return $exe }
    }
}

function Download-Verified([string]$Name, [string]$Digest) {
    $destination = Join-Path $scratch $Name
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri "https://github.com/microsoft/winget-cli/releases/download/v1.29.380/$Name" -OutFile $destination
    if ((Get-FileHash $destination -Algorithm SHA256).Hash -ne $Digest) { throw "WinGet bootstrap checksum mismatch: $Name" }
    return $destination
}

$winget = Find-WinGet
$installedWinGetVersion = [Version]'0.0.0'
if ($winget) {
    $reported = (& $winget --version | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $reported -match '^v?(\d+\.\d+\.\d+)') {
        $installedWinGetVersion = [Version]$Matches[1]
    }
}
# Hosted runners can carry an older client that rejects the current schema header.
if ($installedWinGetVersion -lt [Version]'1.29.380') {
    # Official Microsoft release assets, pinned by the GitHub release's digests.
    $bundle = Download-Verified 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle' '65dea9c01ce08ee7b763366b27c0e651f97db857c11ca9b9c301826c10092f2e'
    $archive = Download-Verified 'DesktopAppInstaller_Dependencies.zip' 'ba875afe9d190f61218985ac0292a99d1db710bf93e13c68944ca9d89f0d82d1'
    $dependencyDir = Join-Path $scratch 'dependencies'
    Expand-Archive -Path $archive -DestinationPath $dependencyDir
    $dependencies = @(Get-ChildItem (Join-Path $dependencyDir 'x64') -Recurse -File |
        Where-Object { $_.Extension -in '.appx', '.msix' } | ForEach-Object { $_.FullName })
    if (!$dependencies.Count) { throw 'WinGet bootstrap has no x64 dependencies.' }
    Add-AppxPackage -Path $bundle -DependencyPath $dependencies
    $winget = Find-WinGet
    if (!$winget) { throw 'The official WinGet package did not provide winget.exe.' }
}

function Invoke-WinGet([string[]]$Arguments) {
    & $winget @Arguments
    if ($LASTEXITCODE -ne 0) { throw "winget $($Arguments[0]) failed: $LASTEXITCODE" }
}

$wingetVersion = (& $winget --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'WinGet version check failed.' }
Write-Host "Native WinGet: $wingetVersion"
$env:CAVELON_CONFIG_DIR = Join-Path $scratch 'config'
$env:CAVELON_CACHE_DIR = Join-Path $scratch 'cache'
$env:CAVELON_NO_UPDATE_CHECK = '1'
$installed = $false
$policyEnabled = $false
try {
    Invoke-WinGet -Arguments @('validate', '--manifest', $ManifestDir, '--disable-interactivity')
    Invoke-WinGet -Arguments @('settings', '--enable', 'LocalManifestFiles')
    $policyEnabled = $true
    Invoke-WinGet -Arguments @('install', '--manifest', $ManifestDir, '--scope', 'machine', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    $installed = $true
    if (!(Test-Path $alias)) { throw 'WinGet did not create the cavelon command alias.' }
    if ((Get-FileHash $alias -Algorithm SHA256).Hash -ne $Sha256) { throw 'The installed command does not match the verified executable.' }
    $output = @(& $alias --version)
    if ($LASTEXITCODE -ne 0 -or $output[0] -ne $Version) { throw "WinGet installed an unexpected version: $output" }
    if (($output -join "`n") -notmatch 'installed with: winget') { throw 'The CLI did not recognize its WinGet installation.' }
    $output | Write-Host
} finally {
    try {
        if ($installed -or (Test-Path $alias)) {
            # Local portable registrations include their source suffix, so their
            # public package ID cannot be correlated before repository acceptance.
            $target = @((Get-Item -LiteralPath $alias).Target)[0]
            if (!$target) { throw 'The installed command alias has no package target.' }
            $productCode = Split-Path -Leaf (Split-Path -Parent $target)
            if ($productCode -notlike 'goodguys.Cavelon_*') { throw 'The command alias does not target the expected package.' }
            Invoke-WinGet -Arguments @('uninstall', '--product-code', $productCode, '--scope', 'machine', '--source', 'winget', '--disable-interactivity')
            if (Test-Path $alias) { throw 'WinGet uninstall left the command alias behind.' }
        }
    } finally {
        if ($policyEnabled) { Invoke-WinGet -Arguments @('settings', '--disable', 'LocalManifestFiles') }
    }
}
@{ version = $Version; winget_version = $wingetVersion; sha256 = $Sha256.ToLowerInvariant(); install_scope = 'machine';
   manifest_valid = $true; installed_command_hash_matches = $true; install_method_recognized = $true;
   uninstalled = $true; actual_person_ui_qualification = $false } |
    ConvertTo-Json | Set-Content (Join-Path $scratch 'evidence.json') -Encoding UTF8
Write-Host "WinGet validate, install, command hash/version and uninstall passed. Evidence: $scratch"
