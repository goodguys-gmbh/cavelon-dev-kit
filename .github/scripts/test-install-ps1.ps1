# Test install.ps1 against a release folder served on 127.0.0.1 (serve.mjs), in
# the PowerShell running this (Windows PowerShell 5.1 or PowerShell 7): a fresh
# install through `irm | iex`, the user PATH, a re-run while cavelon is running,
# a checksum that does not match, and NoModifyPath.
#
#   .github/scripts/test-install-ps1.ps1 -Base <url> -Version <expected-version>
param(
  [Parameter(Mandatory)][string]$Base,
  [Parameter(Mandatory)][string]$Version
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }
$dir = Join-Path $env:RUNNER_TEMP "cavelon-$shell"
$exe = Join-Path $dir 'cavelon.exe'

function Assert([bool]$Condition, [string]$What) {
  if (-not $Condition) { throw "FAILED: $What" }
  Write-Host "  ok: $What"
}
function UserPath {
  [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
}
# What the installer writes with Write-Host, piped into iex as a person does.
function Install-Piped {
  & { irm "$Base/install.ps1" | iex } 6>&1 | Out-String
}
# Run install.ps1 as a file in a new process; Windows PowerShell 5.1 must not
# treat the child's output as errors.
function Install-File([string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'install.ps1') @Arguments *>&1 | Out-String | Write-Host
  $LASTEXITCODE
}
function Count-InUserPath([string]$Folder) {
  @((UserPath) -split ';' | Where-Object { $_.TrimEnd('\') -eq $Folder.TrimEnd('\') }).Count
}

$pathBefore = UserPath
$env:CAVELON_DOWNLOAD_URL = $Base
$env:CAVELON_INSTALL_DIR = $dir
try {
  Write-Host "== irm | iex, in $shell $($PSVersionTable.PSVersion)"
  $out = Install-Piped
  Write-Host $out
  Assert (@(& $exe --version)[0] -eq $Version) "installed $Version"
  Assert ($out -match "Installed cavelon $Version") 'said what it installed'
  Assert ($out -match 'Next: ') 'printed the next step'
  Assert ((Count-InUserPath $dir) -eq 1) 'added the folder to the user PATH once'
  Assert ((Get-Command cavelon).Source -eq $exe) 'this session finds cavelon'

  Write-Host '== run again while cavelon runs: an update, nothing added twice'
  # In a console of its own, `cavelon mcp` waits for input and keeps its file open.
  $running = Start-Process -FilePath $exe -ArgumentList 'mcp' -PassThru -WindowStyle Hidden
  try {
    Start-Sleep -Seconds 2
    Assert (-not $running.HasExited) 'cavelon mcp is running'
    $out = Install-Piped
    Write-Host $out
    Assert ($out -match 'up to date') 'said it is up to date'
    Assert ((Count-InUserPath $dir) -eq 1) 'the user PATH still names the folder once'
    Assert (@(& $exe --version)[0] -eq $Version) 'the new cavelon runs'
  } finally {
    Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue
  }

  Write-Host '== a checksum that does not match'
  $before = (Get-FileHash $exe).Hash
  $env:CAVELON_DOWNLOAD_URL = "$Base/tampered"
  $code = Install-File @()
  Assert ($code -eq 1) "exit code 1 (was $code)"
  Assert ((Get-FileHash $exe).Hash -eq $before) 'the installed cavelon is unchanged'
  $env:CAVELON_DOWNLOAD_URL = $Base

  Write-Host '== NoModifyPath, run as a file with parameters'
  $other = Join-Path $env:RUNNER_TEMP "cavelon-$shell-other"
  $code = Install-File @('-InstallDir', $other, '-NoModifyPath')
  Assert ($code -eq 0) "exit code 0 (was $code)"
  Assert (@(& (Join-Path $other 'cavelon.exe') --version)[0] -eq $Version) "installed into $other"
  Assert ((Count-InUserPath $other) -eq 0) 'did not change the user PATH'

  Write-Host "install.ps1 in ${shell}: all checks passed"
} finally {
  [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).SetValue('Path', $pathBefore, 'ExpandString')
  Remove-Item Env:CAVELON_DOWNLOAD_URL, Env:CAVELON_INSTALL_DIR -ErrorAction SilentlyContinue
}
