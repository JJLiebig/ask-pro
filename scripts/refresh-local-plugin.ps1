param(
  [string]$MarketplacePath = "",
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME/.codex" }),
  [string]$PluginName = "ask-pro"
)

$ErrorActionPreference = "Stop"

function Resolve-StrictPath([string]$Path) {
  return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Join-And-Normalize([string]$Base, [string[]]$Parts) {
  return [System.IO.Path]::GetFullPath((Join-Path -Path $Base -ChildPath ([System.IO.Path]::Combine($Parts))))
}

$repoRoot = Resolve-StrictPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($MarketplacePath)) {
  $codexMarketplace = Join-And-Normalize $CodexHome @(".tmp", "marketplaces", $PluginName, ".agents", "plugins", "marketplace.json")
  if (Test-Path -LiteralPath $codexMarketplace) {
    $MarketplacePath = $codexMarketplace
  } else {
    $MarketplacePath = "$HOME/.agents/plugins/marketplace.json"
  }
}
$marketplaceFile = Resolve-StrictPath $MarketplacePath
$marketplace = Get-Content -LiteralPath $marketplaceFile -Raw | ConvertFrom-Json
$marketplaceName = [string]$marketplace.name
if ([string]::IsNullOrWhiteSpace($marketplaceName)) {
  throw "Marketplace file must include a top-level name."
}

$plugin = @($marketplace.plugins) | Where-Object { $_.name -eq $PluginName } | Select-Object -First 1
if (-not $plugin) {
  throw "Plugin '$PluginName' was not found in $marketplaceFile."
}
if (($plugin.source.source -ne "local") -and ($plugin.source.source -ne "url")) {
  throw "Plugin '$PluginName' must come from a local or URL marketplace source."
}

$sourceRoot = Resolve-StrictPath $repoRoot
$manifestPath = Join-Path $sourceRoot ".codex-plugin/plugin.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Missing plugin manifest at $manifestPath."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne $PluginName) {
  throw "Plugin manifest name '$($manifest.name)' does not match requested plugin '$PluginName'."
}

$codexHomePath = [System.IO.Path]::GetFullPath($CodexHome)
$cacheRoot = Join-And-Normalize $codexHomePath @("plugins", "cache")
$pluginCacheRoot = Join-And-Normalize $cacheRoot @($marketplaceName, $PluginName)
$cacheVersion = $(if ($plugin.source.source -eq "local") { "local" } else { [string]$manifest.version })
if ([string]::IsNullOrWhiteSpace($cacheVersion)) {
  throw "Plugin '$PluginName' manifest must include a version."
}
$targetRoot = Join-And-Normalize $pluginCacheRoot @($cacheVersion)

$cacheRootWithSeparator = $cacheRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $pluginCacheRoot.StartsWith($cacheRootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Resolved plugin cache path is outside Codex plugin cache: $pluginCacheRoot"
}

if (Test-Path -LiteralPath $targetRoot) {
  Remove-Item -LiteralPath $targetRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null

$itemsToCopy = @(
  ".codex-plugin",
  "skills",
  "references",
  "README.md",
  "LICENSE",
  "package.json",
  "dist"
)

foreach ($item in $itemsToCopy) {
  $source = Join-Path $sourceRoot $item
  if (-not (Test-Path -LiteralPath $source)) {
    continue
  }
  Copy-Item -LiteralPath $source -Destination $targetRoot -Recurse -Force
}

Write-Host "Refreshed local Codex plugin cache:"
Write-Host "  source: $sourceRoot"
Write-Host "  target: $targetRoot"
Write-Host ""
Write-Host "Restart or reload Codex to pick up refreshed plugin skills."
