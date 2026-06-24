<#
.SYNOPSIS
  GitManager installer for Windows.

.DESCRIPTION
  Downloads the latest desktop installer from GitHub Releases and runs it. The
  NSIS installer upgrades an existing GitManager install in place.

  Run:
    irm https://raw.githubusercontent.com/grabskimm/git-manager/main/scripts/install.ps1 | iex

.PARAMETER Version
  Install a specific tag (e.g. v1.2.3) instead of the latest release.

.PARAMETER Repo
  Override the source repo (default grabskimm/git-manager).

.PARAMETER Silent
  Install without prompts (NSIS /S).
#>
[CmdletBinding()]
param(
  [string]$Version = $env:GM_VERSION,
  [string]$Repo = $(if ($env:GM_REPO) { $env:GM_REPO } else { "grabskimm/git-manager" }),
  [switch]$Silent
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # faster Invoke-WebRequest downloads

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# A running GitManager (or an orphaned engine child from an older build) holds
# files open under the install dir, which can make the installer fail — or, with
# a corrupt download, crash with an opaque access violation (0xC0000005 /
# -1073741819). Stop anything running before we install.
function Stop-RunningGitManager {
  $names = @("GitManager", "gitmanager", "gitm")
  $procs = Get-Process -Name $names -ErrorAction SilentlyContinue
  if ($procs) {
    Info "Closing running GitManager ($($procs.Count) process(es))…"
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
}

# Verify the download against the asset's sha256 digest (GitHub returns it as
# "sha256:<hex>"). A truncated/corrupt installer is the most common cause of the
# installer crashing on launch, so fail loudly here instead of running a bad exe.
function Test-AssetDigest($path, $digest) {
  if (-not $digest -or $digest -notlike "sha256:*") { return }  # older API: no digest
  $expected = ($digest -replace "^sha256:", "").ToLower()
  $actual = (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) {
    Fail "download integrity check failed (sha256 mismatch). Expected $expected, got $actual. Re-run the installer; if it persists the release asset may be corrupt."
  }
  Info "Verified download (sha256 ok)."
}

$api = "https://api.github.com/repos/$Repo/releases"
$releaseUrl = if ($Version) { "$api/tags/$Version" } else { "$api/latest" }

# Optional token (GITHUB_TOKEN/GH_TOKEN) lifts the unauthenticated API rate limit
# (60/hr per IP) and allows private repos.
$headers = @{ "User-Agent" = "gitmanager-installer" }
$token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }
if ($token) { $headers["Authorization"] = "Bearer $token" }

Info "Fetching release metadata for $Repo…"
try {
  $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers
} catch {
  Fail "could not fetch release metadata (no published release yet, or the API rate limit was hit — set GITHUB_TOKEN to raise it): $($_.Exception.Message)"
}

# Prefer the NSIS .exe (assisted/in-place upgrade); keep the .msi as a fallback
# because the MSI installs more robustly when a previous/parallel install is in a
# bad state (which is exactly when the NSIS exe tends to crash).
$exeAsset = $release.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1
$msiAsset = $release.assets | Where-Object { $_.name -like "*.msi" } | Select-Object -First 1
if (-not $exeAsset -and -not $msiAsset) { Fail "no Windows .exe or .msi asset found in the release" }

# Download an asset to TEMP and verify its integrity. Returns the local path.
function Get-Installer($asset) {
  $dest = Join-Path $env:TEMP $asset.name
  Info "Downloading $($asset.name)…"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers @{ "User-Agent" = "gitmanager-installer" }
  Test-AssetDigest $dest $asset.digest
  return $dest
}

# Run an installer and return its exit code (0 = success).
function Invoke-Installer($path, $isMsi) {
  Stop-RunningGitManager
  if ($isMsi) {
    $installerArgs = @("/i", "`"$path`"")
    if ($Silent) { $installerArgs += "/quiet" }
    return (Start-Process -FilePath "msiexec.exe" -ArgumentList $installerArgs -Wait -PassThru).ExitCode
  }
  $installerArgs = @()
  if ($Silent) { $installerArgs += "/S" }   # NSIS silent
  if ($installerArgs.Count -gt 0) {
    return (Start-Process -FilePath $path -ArgumentList $installerArgs -Wait -PassThru).ExitCode
  }
  return (Start-Process -FilePath $path -Wait -PassThru).ExitCode
}

$code = $null
if ($exeAsset) {
  $dest = Get-Installer $exeAsset
  Info "Running installer (upgrades any existing install)…"
  $code = Invoke-Installer $dest $false
}

# A crash exit code (e.g. 0xC0000005 / -1073741819) or any non-zero from the NSIS
# exe → automatically retry with the MSI, which doesn't run the old uninstaller
# and survives a half-broken previous install.
if (($code -ne 0) -and $msiAsset) {
  if ($null -ne $code) { Warn "NSIS installer exited with code $code — retrying with the MSI…" }
  $dest = Get-Installer $msiAsset
  Info "Running MSI installer…"
  $code = Invoke-Installer $dest $true
}

if ($code -ne 0) { Fail "installer exited with code $code" }
Info "Done. GitManager is installed — launch it from the Start menu."
