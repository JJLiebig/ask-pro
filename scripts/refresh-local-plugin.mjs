#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const pluginName = args.pluginName ?? "ask-pro";
const codexHome = args.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const marketplacePath = args.marketplacePath ?? (await findCodexMarketplace(codexHome, pluginName));

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const marketplaceFile = path.resolve(marketplacePath);
const marketplace = JSON.parse(await fs.readFile(marketplaceFile, "utf8"));
const marketplaceName = String(marketplace.name ?? "").trim();
if (!marketplaceName) {
  throw new Error("Marketplace file must include a top-level name.");
}

const plugin = Array.isArray(marketplace.plugins)
  ? marketplace.plugins.find((entry) => entry?.name === pluginName)
  : null;
if (!plugin) {
  throw new Error(`Plugin '${pluginName}' was not found in ${marketplaceFile}.`);
}
if (plugin.source?.source === "local") {
  const configuredSourcePath = plugin.source?.path;
  if (typeof configuredSourcePath !== "string" || !configuredSourcePath.trim()) {
    throw new Error(`Plugin '${pluginName}' local source must include a path.`);
  }
  const configuredSourceRoot = resolveConfiguredSourceRoot(configuredSourcePath, marketplaceFile);
  if (!samePath(configuredSourceRoot, repoRoot)) {
    throw new Error(
      `Plugin '${pluginName}' marketplace path resolves to ${configuredSourceRoot}, not this checkout ${repoRoot}.`,
    );
  }
} else if (plugin.source?.source !== "url") {
  throw new Error(`Plugin '${pluginName}' must come from a local or URL marketplace source.`);
}

const manifestPath = path.join(repoRoot, ".codex-plugin", "plugin.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (manifest.name !== pluginName) {
  throw new Error(
    `Plugin manifest name '${manifest.name}' does not match requested plugin '${pluginName}'.`,
  );
}

const cacheRoot = path.resolve(codexHome, "plugins", "cache");
const pluginCacheRoot = path.resolve(cacheRoot, marketplaceName, pluginName);
const cacheVersion = plugin.source?.source === "local" ? "local" : manifest.version;
if (typeof cacheVersion !== "string" || !cacheVersion.trim()) {
  throw new Error(`Plugin '${pluginName}' manifest must include a version.`);
}
const targetRoot = path.resolve(pluginCacheRoot, cacheVersion);
assertInside(
  pluginCacheRoot,
  cacheRoot,
  "Resolved plugin cache path is outside Codex plugin cache",
);

const requiredDistEntry = path.join(repoRoot, "dist", "bin", "ask-pro-cli.js");
if (!(await exists(requiredDistEntry))) {
  throw new Error("dist is missing. Run `pnpm run build` before refreshing the plugin cache.");
}
const repoNodeModules = path.join(repoRoot, "node_modules");
if (!(await exists(repoNodeModules))) {
  throw new Error(
    "node_modules is missing. Run `pnpm install` before refreshing the plugin cache.",
  );
}

await removeNodeModulesLink(path.join(targetRoot, "node_modules"));
await fs.rm(targetRoot, { recursive: true, force: true });
await fs.mkdir(targetRoot, { recursive: true });

for (const item of [
  ".codex-plugin",
  "assets",
  "skills",
  "references",
  "README.md",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "dist",
]) {
  const source = path.join(repoRoot, item);
  if (!(await exists(source))) continue;
  await fs.cp(source, path.join(targetRoot, item), { recursive: true, force: true });
}

await fs.mkdir(path.join(targetRoot, "scripts"), { recursive: true });
await fs.cp(
  path.join(repoRoot, "scripts", "run-cached-cli.mjs"),
  path.join(targetRoot, "scripts", "run-cached-cli.mjs"),
  { force: true },
);
await fs.symlink(repoNodeModules, path.join(targetRoot, "node_modules"), "junction");

console.log("Refreshed local Codex plugin cache:");
console.log(`  source: ${repoRoot}`);
console.log(`  target: ${targetRoot}`);
console.log("");
console.log("Restart or reload Codex to pick up refreshed plugin skills.");

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (!arg.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected --name value argument, got '${arg}'.`);
    }
    i += 1;
    if (arg === "--marketplace-path") result.marketplacePath = value;
    else if (arg === "--codex-home") result.codexHome = value;
    else if (arg === "--plugin-name") result.pluginName = value;
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  return result;
}

function assertInside(child, parent, message) {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${message}: ${child}`);
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeNodeModulesLink(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      await fs.unlink(filePath);
    }
  } catch {
    // Missing or non-removable links are handled by the full target cleanup.
  }
}

async function findCodexMarketplace(codexHome, pluginName) {
  const codexMarketplace = path.join(
    codexHome,
    ".tmp",
    "marketplaces",
    pluginName,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  if (await exists(codexMarketplace)) return codexMarketplace;
  return path.join(os.homedir(), ".agents", "plugins", "marketplace.json");
}

function resolveConfiguredSourceRoot(sourcePath, marketplaceFile) {
  const candidates = [
    path.resolve(path.dirname(marketplaceFile), sourcePath),
    path.resolve(os.homedir(), sourcePath),
  ];
  return candidates.find((candidate) => samePath(candidate, repoRoot)) ?? candidates[0];
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
