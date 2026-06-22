<#
.SYNOPSIS
  GitManager installer for Windows.

.DESCRIPTION
  Downloads the latest desktop installer from GitHub Releases and runs it. The
  NSIS installer upgrades an existing GitManager install in place.

  Run:
    irm https://raw.githubusercontent.com/grabskimm/git-manager/main/install.ps1 | iex

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
function Fail($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

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

# Prefer the NSIS .exe (assisted/in-place upgrade); fall back to the .msi.
$asset = $release.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1
$isMsi = $false
if (-not $asset) {
  $asset = $release.assets | Where-Object { $_.name -like "*.msi" } | Select-Object -First 1
  $isMsi = $true
}
if (-not $asset) { Fail "no Windows .exe or .msi asset found in the release" }

$dest = Join-Path $env:TEMP $asset.name
Info "Downloading $($asset.name)…"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers @{ "User-Agent" = "gitmanager-installer" }

Info "Running installer (upgrades any existing install)…"
if ($isMsi) {
  $installerArgs = @("/i", "`"$dest`"")
  if ($Silent) { $installerArgs += "/quiet" }
  $p = Start-Process -FilePath "msiexec.exe" -ArgumentList $installerArgs -Wait -PassThru
} else {
  $installerArgs = @()
  if ($Silent) { $installerArgs += "/S" }   # NSIS silent
  if ($installerArgs.Count -gt 0) {
    $p = Start-Process -FilePath $dest -ArgumentList $installerArgs -Wait -PassThru
  } else {
    $p = Start-Process -FilePath $dest -Wait -PassThru
  }
}

if ($p.ExitCode -ne 0) { Fail "installer exited with code $($p.ExitCode)" }
Info "Done. GitManager is installed — launch it from the Start menu."
