import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delay } from "./utils.js";

export type ProfileStateLogger = (message: string) => void;

const DEVTOOLS_ACTIVE_PORT_FILENAME = "DevToolsActivePort";
const DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS = [
  DEVTOOLS_ACTIVE_PORT_FILENAME,
  path.join("Default", DEVTOOLS_ACTIVE_PORT_FILENAME),
] as const;

const CHROME_PID_FILENAME = "chrome.pid";
const CHROME_STARTING_FILENAME = "chrome-starting";
const ASK_PRO_PROFILE_LOCK_FILENAME = "ask-pro-automation.lock";
const ASK_PRO_RUN_LEASE_DIRNAME = "ask-pro-browser-runs";

const execFileAsync = promisify(execFile);

export function getDevToolsActivePortPaths(userDataDir: string): string[] {
  return DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS.map((relative) => path.join(userDataDir, relative));
}

export async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      const raw = await readFile(candidate, "utf8");
      const firstLine = raw.split(/\r?\n/u)[0]?.trim();
      const port = Number.parseInt(firstLine ?? "", 10);
      if (Number.isFinite(port)) {
        return port;
      }
    } catch {
      // ignore missing/unreadable candidates
    }
  }
  return null;
}

export async function writeDevToolsActivePort(userDataDir: string, port: number): Promise<void> {
  const contents = `${port}\n/devtools/browser`;
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await mkdir(path.dirname(candidate), { recursive: true });
      await writeFile(candidate, contents, "utf8");
    } catch {
      // best effort
    }
  }
}

export async function readChromePid(userDataDir: string): Promise<number | null> {
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

export async function writeChromePid(userDataDir: string, pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    await mkdir(path.dirname(pidPath), { recursive: true });
    await writeFile(pidPath, `${Math.trunc(pid)}\n`, "utf8");
  } catch {
    // best effort
  }
}

export async function markChromeLaunchStarting(userDataDir: string): Promise<void> {
  const markerPath = path.join(userDataDir, CHROME_STARTING_FILENAME);
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, "", "utf8");
}

export async function hasChromeLaunchStarting(userDataDir: string): Promise<boolean> {
  try {
    await stat(path.join(userDataDir, CHROME_STARTING_FILENAME));
    return true;
  } catch {
    return false;
  }
}

export async function clearChromeLaunchStarting(userDataDir: string): Promise<void> {
  await rm(path.join(userDataDir, CHROME_STARTING_FILENAME), { force: true }).catch(
    () => undefined,
  );
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists but no permission"; treat as alive.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

export interface ProfileRunLock {
  path: string;
  lockId: string;
  release: () => Promise<void>;
}

interface ProfileRunLockRecord {
  pid: number;
  lockId: string;
  createdAt: string;
  sessionId?: string;
}

export interface ManagedChromeRunLease {
  path: string;
}

export async function createManagedChromeRunLease(
  userDataDir: string,
): Promise<ManagedChromeRunLease> {
  const leaseId = randomUUID();
  const leaseDir = path.join(userDataDir, ASK_PRO_RUN_LEASE_DIRNAME);
  const leasePath = path.join(leaseDir, `${process.pid}-${leaseId}.lease`);
  await mkdir(leaseDir, { recursive: true });
  await writeFile(leasePath, "", { encoding: "utf8", flag: "wx" });
  return { path: leasePath };
}

export async function releaseManagedChromeRunLeaseAndCountPeers(
  userDataDir: string,
  lease: ManagedChromeRunLease,
  logger?: ProfileStateLogger,
): Promise<number | null> {
  try {
    await rm(lease.path, { force: true });
  } catch (error) {
    logger?.(`Failed to release ask-pro browser run lease: ${String(error)}`);
    return null;
  }

  const leaseDir = path.join(userDataDir, ASK_PRO_RUN_LEASE_DIRNAME);
  let entries;
  try {
    entries = await readdir(leaseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    logger?.(`Failed to inspect ask-pro browser run leases: ${String(error)}`);
    return null;
  }

  let peers = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".lease")) continue;
    const leasePath = path.join(leaseDir, entry.name);
    const pid = Number(entry.name.match(/^(\d+)-/)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
      try {
        await rm(leasePath, { force: true });
      } catch (error) {
        logger?.(`Failed to remove stale ask-pro browser run lease: ${String(error)}`);
        return null;
      }
      continue;
    }
    peers += 1;
  }
  return peers;
}

function parseProfileRunLock(payload: string | null): ProfileRunLockRecord | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as ProfileRunLockRecord;
    if (!Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    if (!parsed.lockId || typeof parsed.lockId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function isBrowserProfileInUse(
  userDataDir: string,
  options: { ignoreLockId?: string } = {},
): Promise<boolean> {
  const lockPath = path.join(userDataDir, ASK_PRO_PROFILE_LOCK_FILENAME);
  let lockPayload: string | null;
  try {
    lockPayload = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    lockPayload = null;
  }
  let lock = parseProfileRunLock(lockPayload);
  if (lockPayload !== null && !lock) {
    await delay(200);
    try {
      lockPayload = await readFile(lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      lockPayload = null;
    }
    lock = parseProfileRunLock(lockPayload);
  }
  if (lock && lock.lockId !== options.ignoreLockId && isProcessAlive(lock.pid)) return true;

  const pid = await readChromePid(userDataDir);
  const port = await readDevToolsPort(userDataDir);
  const [owner, devTools] = await Promise.all([
    isChromeUsingUserDataDir(userDataDir),
    port ? verifyDevToolsReachable({ port, attempts: 1 }) : null,
  ]);
  if (owner === true || (pid && isProcessAlive(pid) && devTools?.ok)) return true;
  return owner === null;
}

export async function acquireProfileRunLock(
  userDataDir: string,
  options: {
    timeoutMs: number;
    pollMs?: number;
    logger?: ProfileStateLogger;
    sessionId?: string;
    requireExistingProfile?: boolean;
    staleLockMode?: "remove" | "fail";
  },
): Promise<ProfileRunLock | null> {
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  const pollMs =
    typeof options.pollMs === "number" && Number.isFinite(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : 1000;
  const lockPath = path.join(userDataDir, ASK_PRO_PROFILE_LOCK_FILENAME);
  const lockId = randomUUID();
  const startedAt = Date.now();
  let warned = false;

  for (;;) {
    try {
      const payload: ProfileRunLockRecord = {
        pid: process.pid,
        lockId,
        createdAt: new Date().toISOString(),
        sessionId: options.sessionId,
      };
      if (options.requireExistingProfile) {
        await stat(userDataDir);
      } else {
        await mkdir(path.dirname(lockPath), { recursive: true });
      }
      await writeFile(lockPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
      options.logger?.(`Acquired ask-pro profile lock at ${lockPath}`);
      return {
        path: lockPath,
        lockId,
        release: async () => releaseProfileRunLock(lockPath, lockId, options.logger),
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") {
        throw error;
      }
      let existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
      if (!existing) {
        // Likely partial write / corruption; re-read once, then delete (user preference: delete unreadable lockfiles).
        await delay(200);
        existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
        if (!existing) {
          if (options.staleLockMode === "fail") {
            throw new Error("ask-pro profile lock is unreadable; refusing stale lock removal.");
          }
          options.logger?.("ask-pro profile lock unreadable; deleting lockfile.");
          await rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
      }
      if (!existing || !isProcessAlive(existing.pid)) {
        if (options.staleLockMode === "fail") {
          throw new Error("ask-pro profile lock owner is not alive; refusing stale lock removal.");
        }
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (!warned) {
        const waited = Math.round(timeoutMs / 1000);
        options.logger?.(
          `ask-pro profile lock held by pid ${existing.pid}; waiting up to ${waited}s.`,
        );
        warned = true;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new Error(
          `ask-pro profile lock still held by pid ${existing.pid} after ${Math.round(elapsed / 1000)}s`,
        );
      }
      await delay(Math.min(pollMs, timeoutMs - elapsed));
    }
  }
}

export async function releaseProfileRunLock(
  lockPath: string,
  lockId: string,
  logger?: ProfileStateLogger,
): Promise<void> {
  try {
    const existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
    if (!existing || existing.lockId !== lockId) {
      return;
    }
    await rm(lockPath, { force: true });
    logger?.(`Released ask-pro profile lock ${lockPath}`);
  } catch {
    // best effort
  }
}

export async function verifyDevToolsReachable({
  port,
  host = "127.0.0.1",
  attempts = 3,
  timeoutMs = 3000,
}: {
  port: number;
  host?: string;
  attempts?: number;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const versionUrl = `http://${host}:${port}/json/version`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(versionUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { ok: true };
    } catch (error) {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: "unreachable" };
}

export async function shouldCleanupManualLoginProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    connectionClosedUnexpectedly?: boolean;
    host?: string;
    probe?: typeof verifyDevToolsReachable;
  } = {},
): Promise<boolean> {
  if (!options.connectionClosedUnexpectedly) {
    return true;
  }
  const port = await readDevToolsPort(userDataDir);
  if (!port) {
    return true;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port, host: options.host });
  if (probe.ok) {
    logger?.(`DevTools port ${port} still reachable; preserving manual-login profile state`);
    return false;
  }
  logger?.(`DevTools port ${port} unreachable (${probe.error}); clearing stale profile state`);
  return true;
}

export async function cleanupStaleProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: { lockRemovalMode?: "never" | "if_ask_pro_pid_dead" } = {},
): Promise<void> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await rm(candidate, { force: true });
      logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
    } catch {
      // ignore cleanup errors
    }
  }

  const lockRemovalMode = options.lockRemovalMode ?? "never";
  if (lockRemovalMode === "never") {
    return;
  }

  const pid = await readChromePid(userDataDir);
  if (!pid) {
    return;
  }
  if (isProcessAlive(pid)) {
    logger?.(`Chrome pid ${pid} still alive; skipping profile lock cleanup`);
    return;
  }

  // Extra safety: if Chrome is running with this profile (but with a different PID, e.g. user relaunched
  // without remote debugging), never delete lock files.
  if ((await isChromeUsingUserDataDir(userDataDir)) === true) {
    logger?.("Detected running Chrome using this profile; skipping profile lock cleanup");
    return;
  }

  const lockFiles = [
    path.join(userDataDir, "lockfile"),
    path.join(userDataDir, "SingletonLock"),
    path.join(userDataDir, "SingletonSocket"),
    path.join(userDataDir, "SingletonCookie"),
  ];
  for (const lock of lockFiles) {
    await rm(lock, { force: true }).catch(() => undefined);
  }
  logger?.("Cleaned up stale Chrome profile locks");
}

async function isChromeUsingUserDataDir(userDataDir: string): Promise<boolean | null> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; $match = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|chromium|msedge)\\.exe$' -and $_.CommandLine -and $_.CommandLine.Contains($env:ASK_PRO_PROFILE_SCAN_PATH) -and $_.CommandLine.Contains('--user-data-dir') } | Select-Object -First 1; if ($match) { 'match' } else { 'scan-ok' }",
        ],
        {
          env: { ...process.env, ASK_PRO_PROFILE_SCAN_PATH: userDataDir },
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      const result = String(stdout).trim();
      return result === "match" ? true : result === "scan-ok" ? false : null;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = String(stdout ?? "").split("\n");
    const needle = userDataDir;
    for (const line of lines) {
      if (!line) continue;
      const lower = line.toLowerCase();
      if (!lower.includes("chrome") && !lower.includes("chromium")) continue;
      if (line.includes(needle) && lower.includes("user-data-dir")) {
        return true;
      }
    }
  } catch {
    return null;
  }
  return false;
}
