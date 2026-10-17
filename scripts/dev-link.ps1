# Link the DSH runtime's packages into this checkout so that the plugin's bare
# imports (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis`)
# resolve while developing and testing here. Nothing is copied or installed: this
# creates one directory junction.
#
# Usage:
#   powershell -File scripts\dev-link.ps1
#   powershell -File scripts\dev-link.ps1 -ProfileNodeModules D:\other\profiles\node_modules
param(
  [string]$ProfileNodeModules = ""
)

$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
if (-not $ProfileNodeModules) {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
  $ProfileNodeModules = Join-Path $dshHome "profiles\node_modules"
}

$target = Join-Path $ProfileNodeModules "@deepseek-ai"
if (-not (Test-Path $target)) {
  throw "no DSH packages at $target - run DSH once so it installs its profile node_modules"
}

$modules = Join-Path $workspace "node_modules"
$link = Join-Path $modules "@deepseek-ai"
New-Item -ItemType Directory -Force -Path $modules | Out-Null

if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.LinkType -eq "Junction" -and $item.Target -contains $target) {
    Write-Host "already linked: $link -> $target"
    exit 0
  }
  throw "$link exists and is not the expected junction; remove it first"
}

New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "linked: $link -> $target"

# The client-half test renders the panel with the real React, so the workspace
# needs react / react-dom reachable by bare name too.
foreach ($package in @("react", "react-dom")) {
  $source = Join-Path (Split-Path -Parent $target) $package
  $destination = Join-Path $modules $package
  if (-not (Test-Path $source)) {
    Write-Host "skipped (not installed): $package"
    continue
  }
  if (Test-Path $destination) {
    Write-Host "already linked: $destination"
    continue
  }
  New-Item -ItemType Junction -Path $destination -Target $source | Out-Null
  Write-Host "linked: $destination -> $source"
}

Write-Host "now run: cd todo; node --test"
