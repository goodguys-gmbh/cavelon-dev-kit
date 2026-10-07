<#
.SYNOPSIS
Install cavelon, the Cavelon dev-kit's CLI and MCP server, on Windows.

.DESCRIPTION
In PowerShell (Windows PowerShell 5.1 or PowerShell 7):

    irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex

It downloads the standalone executable from the GitHub release, checks it
against the release's checksums.txt, and puts it into
%LOCALAPPDATA%\Programs\cavelon (no administrator, no Node.js). If that folder
is not on your user PATH, it adds it once and says so. Running it again
updates cavelon. It sends nothing anywhere but the downloads.

Piped into iex it takes its options from environment variables:
CAVELON_VERSION, CAVELON_INSTALL_DIR, CAVELON_NO_MODIFY_PATH=1, and
CAVELON_DOWNLOAD_URL, a folder that holds the release's files instead of the
GitHub release: a mirror's URL, or a local folder such as the bin folder of the
offline bundle.

.PARAMETER Version
A given release, such as 0.1.2, instead of the latest.

.PARAMETER InstallDir
The folder to install into instead of %LOCALAPPDATA%\Programs\cavelon.

.PARAMETER NoModifyPath
Never change the user PATH.
#>
param(
  [string]$Version = $env:CAVELON_VERSION,
  [string]$InstallDir = $env:CAVELON_INSTALL_DIR,
  [switch]$NoModifyPath = ($env:CAVELON_NO_MODIFY_PATH -in @('1', 'true', 'yes'))
)

# Everything runs in a function, so `irm | iex` leaves no variables behind in
# the session, and an error never closes the window (no `exit` there).
function Install-Cavelon {
  param([string]$Version, [string]$InstallDir, [bool]$NoModifyPath)

  $ErrorActionPreference = 'Stop'
  $repository = 'goodguys-gmbh/cavelon-dev-kit'

  # Windows PowerShell 5.1 turns a native program's stderr into errors, which
  # 'Stop' would make fatal; what matters is the exit code.
  function Invoke-Cavelon([string]$Exe, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $output = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
    [pscustomobject]@{ Code = $LASTEXITCODE; Text = (@($output) -join "`n").Trim() }
  }

  # --- the system -------------------------------------------------------------

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'install.ps1 is for Windows. On macOS and Linux: curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh'
  }
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { $asset = 'cavelon-windows-x64.exe' }
    # Windows 11 on Arm runs x64 programs.
    'ARM64' { $asset = 'cavelon-windows-x64.exe' }
    default { throw "There is no cavelon executable for Windows on $arch; run it through Node.js instead: npx -y @cavelon/cli --version" }
  }

  $Version = "$Version".Trim()
  if ($Version.StartsWith('v')) { $Version = $Version.Substring(1) }
  if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+') { throw "`"$Version`" is not a version; write it like 0.1.2." }
  if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\cavelon' }
  $InstallDir = [IO.Path]::GetFullPath($InstallDir)

  # --- where from -------------------------------------------------------------

  if ($env:CAVELON_DOWNLOAD_URL) {
    $base = $env:CAVELON_DOWNLOAD_URL.TrimEnd('/', '\')
  } elseif ($Version) {
    $base = "https://github.com/$repository/releases/download/v$Version"
  } else {
    $base = "https://github.com/$repository/releases/latest/download"
  }

  # A local folder (the offline bundle's bin) is copied from; PowerShell 7's
  # Invoke-WebRequest takes no file: URL.
  $local = $base -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://'
  function Get-ReleaseFile([string]$Name, [string]$OutFile) {
    if ($local) { Copy-Item -LiteralPath (Join-Path $base $Name) -Destination $OutFile }
    else { Invoke-WebRequest -UseBasicParsing -Uri "$base/$Name" -OutFile $OutFile }
  }

  # Windows PowerShell 5.1 may still offer TLS 1.0 only; GitHub needs 1.2.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("cavelon-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  # Windows PowerShell 5.1 downloads many times slower while it draws progress.
  $progress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    $suffix = if ($Version) { " $Version" } else { '' }
    Write-Host "Downloading $asset$suffix from $base ..."
    try {
      Get-ReleaseFile 'checksums.txt' (Join-Path $tmp 'checksums.txt')
    } catch {
      $hint = if ($Version) { " (is $Version a released version?)" } else { '' }
      throw "Could not download $base/checksums.txt$hint`: $($_.Exception.Message)"
    }
    $download = Join-Path $tmp $asset
    try {
      Get-ReleaseFile $asset $download
    } catch {
      throw "Could not download $base/$asset`: $($_.Exception.Message)"
    }

    $expected = $null
    foreach ($line in Get-Content (Join-Path $tmp 'checksums.txt')) {
      $fields = -split $line
      if ($fields.Count -ge 2 -and ($fields[1] -eq $asset -or $fields[1] -eq "*$asset")) { $expected = $fields[0]; break }
    }
    if (-not $expected) { throw "checksums.txt lists no $asset." }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash
    if ($actual -ne $expected) {
      throw "The download's SHA-256 checksum does not match checksums.txt (expected $expected, got $($actual.ToLowerInvariant())); nothing was installed."
    }
    $ran = Invoke-Cavelon $download @('--version')
    if ($ran.Code -ne 0) { throw "The downloaded cavelon does not run on this system: $($ran.Text)" }
    # The first line is the version; later releases add how cavelon was installed.
    $newVersion = ($ran.Text -split "`n")[0].Trim()

    # --- install --------------------------------------------------------------

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $target = Join-Path $InstallDir 'cavelon.exe'
    $old = Join-Path $InstallDir 'cavelon.exe.old'
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    $oldVersion = $null
    if (Test-Path -LiteralPath $target) {
      $ran = Invoke-Cavelon $target @('--version')
      if ($ran.Code -eq 0) { $oldVersion = ($ran.Text -split "`n")[0].Trim() } else { $oldVersion = 'an earlier version' }
      # A running cavelon (an agent's MCP server) cannot be overwritten, but it
      # can be renamed; the next run removes the old file.
      Move-Item -LiteralPath $target -Destination $old -Force
    }
    try {
      Move-Item -LiteralPath $download -Destination $target -Force
    } catch {
      if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination $target -Force }
      throw "Could not write $target`: $($_.Exception.Message)"
    }
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue

    if (-not $oldVersion) {
      Write-Host "Installed cavelon $newVersion to $target."
    } elseif ($oldVersion -eq $newVersion) {
      Write-Host "cavelon $newVersion is installed in $target and up to date."
    } else {
      Write-Host "Updated cavelon $oldVersion to $newVersion in $target."
    }
  } finally {
    $ProgressPreference = $progress
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # --- PATH -------------------------------------------------------------------

  $same = { param($entry) $entry -and ($entry.Trim().TrimEnd('\') -eq $InstallDir.TrimEnd('\')) }
  # The user PATH as stored, without expanding %VARIABLES% in it, so writing it
  # back keeps them.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $inUserPath = @($userPath -split ';' | Where-Object { & $same ([Environment]::ExpandEnvironmentVariables($_)) }).Count -gt 0
    if (-not $inUserPath) {
      if ($NoModifyPath) {
        Write-Host ''
        Write-Host "$InstallDir is not on your PATH. Add it under Settings > System > About > Advanced system settings > Environment Variables, or run $target."
      } else {
        $newPath = if ($userPath) { $userPath.TrimEnd(';') + ";$InstallDir" } else { $InstallDir }
        $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        # Setting a variable through .NET tells running programs, such as
        # Explorer, that the environment changed; new terminals then see the PATH.
        [Environment]::SetEnvironmentVariable('CAVELON_INSTALLER', '1', 'User')
        [Environment]::SetEnvironmentVariable('CAVELON_INSTALLER', $null, 'User')
        Write-Host ''
        Write-Host "Added $InstallDir to your user PATH. New terminals find cavelon; this one does too."
      }
    }
  } finally {
    $key.Close()
  }
  if (-not $NoModifyPath -and -not @($env:Path -split ';' | Where-Object { & $same $_ }).Count) {
    $env:Path = $env:Path.TrimEnd(';') + ";$InstallDir"
  }

  $found = Get-Command cavelon -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found -and $found.Source -ne $target) {
    Write-Host ''
    Write-Host "Another cavelon comes first on your PATH: $($found.Source). Remove it (npm uninstall -g @cavelon/cli if npm installed it), or run $target."
  }

  # --- next -------------------------------------------------------------------

  Write-Host ''
  if ((Invoke-Cavelon $target @('commands', '--json')).Text -match '"command":"setup"') {
    Write-Host 'Next: cavelon setup'
  } else {
    Write-Host 'Next: log in to your Cavelon instance, with its address:'
    Write-Host '  cavelon login --instance https://cavelon.example.com'
  }
}

try {
  Install-Cavelon -Version $Version -InstallDir $InstallDir -NoModifyPath $NoModifyPath.IsPresent
} catch {
  Write-Host "cavelon install: $($_.Exception.Message)" -ForegroundColor Red
  # Run as a file (powershell -File install.ps1), fail with an exit code; piped
  # into iex, return to the prompt instead of closing the window.
  if ($PSCommandPath) { exit 1 }
}
