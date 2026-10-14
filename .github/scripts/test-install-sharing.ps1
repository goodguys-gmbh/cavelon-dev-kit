# Real Windows sharing violations after the downloaded executable has run.
# Each injected move runs in a separate shell; the normal installer is unchanged.
param(
  [Parameter(Mandatory)][string]$Base,
  [Parameter(Mandatory)][string]$Version,
  [ValidateSet('suite', 'installer')][string]$Mode = 'suite',
  [ValidateSet('transient', 'persistent', 'denied')][string]$Scenario = 'transient',
  [string]$CaseDir
)
$ErrorActionPreference = 'Stop'
$shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

if ($Mode -eq 'installer') {
  $script:holder = $null
  $script:attempts = 0
  $attemptFile = Join-Path $CaseDir 'attempts.txt'
  $readyFile = Join-Path $CaseDir 'lock-ready.txt'
  # Intercept only the final move of a verified temporary download. The real
  # cmdlet still performs the move, so Windows supplies the sharing violation.
  function global:Move-Item {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Destination, [switch]$Force)
    if ([IO.Path]::GetFileName($LiteralPath) -eq 'cavelon-windows-x64.exe') {
      $script:attempts++
      [IO.File]::WriteAllText($attemptFile, [string]$script:attempts)
      if ($Scenario -eq 'denied') {
        throw [UnauthorizedAccessException]::new('Synthetic non-sharing move failure')
      }
      if ($script:attempts -eq 1) {
        $hold = if ($Scenario -eq 'transient') { 500 } else { 30000 }
        $helper = Join-Path $PSScriptRoot 'hold-installer-file.ps1'
        $script:holder = Start-Process -FilePath $shell -ArgumentList @(
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$helper`"",
          '-Path', "`"$LiteralPath`"", '-ReadyFile', "`"$readyFile`"", '-Milliseconds', $hold
        ) -PassThru -WindowStyle Hidden
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (-not (Test-Path -LiteralPath $readyFile)) {
          if ($script:holder.HasExited -or [DateTime]::UtcNow -ge $deadline) {
            throw 'The owned file-lock fixture did not become ready.'
          }
          Start-Sleep -Milliseconds 20
        }
      }
    }
    try {
      Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force -ErrorAction Stop
    } catch {
      $exception = $_.Exception
      $codes = @()
      while ($exception) {
        $codes += ($exception.HResult -band 0xffff)
        $exception = $exception.InnerException
      }
      Write-Host "Move failure codes: $($codes -join ',')"
      throw
    }
  }
  $env:CAVELON_DOWNLOAD_URL = $Base
  $env:CAVELON_CONFIG_DIR = Join-Path $CaseDir 'config'
  $env:CAVELON_NON_INTERACTIVE = '1'
  try {
    & (Join-Path $repo 'install.ps1') -Version $Version -InstallDir (Join-Path $CaseDir 'bin') -NoModifyPath -SkipAgentUpdate -NonInteractive
    $installExit = $LASTEXITCODE
  } finally {
    if ($script:holder -and -not $script:holder.HasExited) {
      Stop-Process -Id $script:holder.Id -Force
      $script:holder.WaitForExit()
    }
    Remove-Item Function:\Move-Item -ErrorAction SilentlyContinue
  }
  exit $installExit
}

function Assert-Sharing([bool]$Condition, [string]$What) {
  if (-not $Condition) { throw "FAILED: $What" }
  Write-Host "  ok: $What"
}

$root = Join-Path $env:RUNNER_TEMP ("cavelon-sharing-$shell-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  foreach ($scenarioName in @('transient', 'persistent', 'denied')) {
    Write-Host "== installer move with $scenarioName source failure"
    $case = Join-Path $root $scenarioName
    $bin = Join-Path $case 'bin'
    New-Item -ItemType Directory -Path $bin | Out-Null
    $target = Join-Path $bin 'cavelon.exe'
    $before = $null
    if ($scenarioName -ne 'transient') {
      # A different valid executable exercises backup/rollback without another
      # release download or editing the actual Cavelon executable's bytes.
      Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\where.exe') -Destination $target
      $before = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    }
    $ErrorActionPreference = 'Continue'
    $output = & $shell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Base $Base -Version $Version -Mode installer -Scenario $scenarioName -CaseDir $case *>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Write-Host $output
    $attempts = [int](Get-Content -LiteralPath (Join-Path $case 'attempts.txt'))
    if ($scenarioName -eq 'transient') {
      Assert-Sharing ($code -eq 0) "short sharing lock releases and installation succeeds (exit $code)"
      Assert-Sharing ($attempts -gt 1) 'the actual first sharing violation was observed'
      Assert-Sharing (@(& $target --version)[0] -eq $Version) 'the installed executable runs'
    } else {
      Assert-Sharing ($code -eq 1) "$scenarioName failure remains a failure"
      Assert-Sharing ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $before) 'rollback preserves the previous executable bytes'
      Assert-Sharing (-not (Test-Path -LiteralPath "$target.old")) 'rollback leaves no pending backup'
      if ($scenarioName -eq 'persistent') {
        Assert-Sharing ($attempts -gt 1 -and $attempts -le 10) 'persistent sharing retries stay bounded'
      } else {
        Assert-Sharing ($attempts -eq 1) 'permission errors are not retried'
      }
    }
  }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
