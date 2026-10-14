param(
  [Parameter(Mandatory)][string]$Path,
  [Parameter(Mandatory)][string]$ReadyFile,
  [Parameter(Mandatory)][int]$Milliseconds
)
$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [IO.File]::WriteAllText($ReadyFile, 'locked')
  Start-Sleep -Milliseconds $Milliseconds
} finally {
  $handle.Dispose()
}
