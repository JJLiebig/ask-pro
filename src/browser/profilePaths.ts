import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireProfileRunLock,
  isBrowserProfileInUse,
  isProcessAlive,
  releaseProfileRunLock,
} from "./profileState.js";

const RESOLVED_AGENT_ID_PATTERN = /^[a-z0-9._-]+-[a-f0-9]{10}$/;
const MIGRATION_MARKER = ".ask-pro-profile-migration";
type LegacyProfileIdentity = { dev: string; ino: string; birthtimeNs: string };

export function defaultAskProBrowserProfileDir(): string {
  return askProBrowserProfileDirForAgentId(null);
}

export function askProBrowserProfileDirForAgentId(
  agentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return profileDirUnder(askProStateDir(env), agentId);
}

export function legacyAskProBrowserProfileDirForAgentId(
  agentId: string | null | undefined,
  homeDir = os.homedir(),
): string {
  return profileDirUnder(path.join(homeDir, ".agents", "skills", "ask-pro"), agentId);
}

export async function ensureAskProBrowserProfileDir(
  agentId: string | null | undefined,
  options: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): Promise<string> {
  const target = askProBrowserProfileDirForAgentId(agentId, options.env);
  const legacy = legacyAskProBrowserProfileDirForAgentId(agentId, options.homeDir);
  const [targetExists, legacyExists] = await Promise.all([exists(target), exists(legacy)]);
  if (targetExists && legacyExists) {
    const recordedIdentity = await retainedLegacyIdentity(target);
    if (recordedIdentity) {
      const currentIdentity = await legacyProfileIdentity(legacy);
      if (currentIdentity && sameLegacyIdentity(currentIdentity, recordedIdentity)) {
        if (await waitForConcurrentMigration(target, legacy)) return target;
        if (await isBrowserProfileInUse(legacy)) {
          throw new Error(
            "Legacy ask-pro browser profile is in use; retry after its browser run exits.",
          );
        }
        return target;
      }
      throw new Error(
        `Both current and legacy ask-pro browser profiles exist; refusing to merge ${legacy} into ${target}.`,
      );
    }
    if (await waitForConcurrentMigration(target, legacy)) return target;
    if ((await exists(target)) && !(await exists(legacy))) return target;
    throw new Error(
      `Both current and legacy ask-pro browser profiles exist; refusing to merge ${legacy} into ${target}.`,
    );
  }
  if (targetExists || !legacyExists) return target;
  if (await isBrowserProfileInUse(legacy)) {
    throw new Error("Legacy ask-pro browser profile is in use; retry after its browser run exits.");
  }

  let migrationLock;
  try {
    migrationLock = await acquireProfileRunLock(legacy, {
      timeoutMs: 300_000,
      pollMs: 100,
      requireExistingProfile: true,
      staleLockMode: "fail",
    });
  } catch (error) {
    if ((await exists(target)) && !(await exists(legacy))) return target;
    throw new Error(
      "Legacy ask-pro browser profile could not be claimed; retry after other browser runs exit.",
      { cause: error },
    );
  }
  if (!migrationLock) throw new Error("Could not claim the legacy ask-pro browser profile.");
  let releasePath = migrationLock.path;

  try {
    if (await matchesRetainedLegacy(target, legacy)) return target;
    if (await isBrowserProfileInUse(legacy, { ignoreLockId: migrationLock.lockId })) {
      throw new Error(
        "Legacy ask-pro browser profile is in use; retry after its browser run exits.",
      );
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    let identityRequired = false;
    try {
      await fs.rename(legacy, target);
      releasePath = path.join(target, path.basename(migrationLock.path));
      return target;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && !isSharingDenied(error)) {
        if ((await exists(target)) && !(await exists(legacy))) return target;
        throw error;
      }
      identityRequired = code !== "EXDEV";
    }

    const legacyIdentity = await legacyProfileIdentity(legacy);
    if (identityRequired && !legacyIdentity) {
      throw new Error("Legacy ask-pro browser profile identity is unavailable; refusing to copy.");
    }
    const staging = `${target}.migrating-${process.pid}-${randomUUID()}`;
    try {
      await fs.cp(legacy, staging, { recursive: true, errorOnExist: true });
      await fs.writeFile(
        path.join(staging, MIGRATION_MARKER),
        JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
          migrationLockId: migrationLock.lockId,
          ...(legacyIdentity ? { legacyIdentity } : {}),
        }),
      );
      await fs.rename(staging, target);
      releasePath = path.join(target, path.basename(migrationLock.path));
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if ((await exists(target)) && !(await exists(legacy))) return target;
      if (await matchesRetainedLegacy(target, legacy)) return target;
      if (await waitForConcurrentMigration(target, legacy)) return target;
      if ((await exists(target)) && !(await exists(legacy))) return target;
      throw error;
    }
    try {
      await fs.rm(legacy, { recursive: true });
    } catch (error) {
      await releaseProfileRunLock(migrationLock.path, migrationLock.lockId);
      if (isSharingDenied(error) && legacyIdentity) return target;
      await fs.rm(path.join(target, MIGRATION_MARKER), { force: true });
      if (isSharingDenied(error)) {
        throw new Error(
          "Legacy ask-pro browser profile could not be removed and has no reliable identity; refusing to retain it.",
          { cause: error },
        );
      }
      throw error;
    }
    await fs.rm(path.join(target, MIGRATION_MARKER), { force: true });
    return target;
  } finally {
    await releaseProfileRunLock(releasePath, migrationLock.lockId);
  }
}

export function askProAgentIdForLegacyBrowserProfileDir(profileDir: string): string | null {
  return agentIdForProfileDir(profileDir, path.join(os.homedir(), ".agents", "skills", "ask-pro"));
}

export function isLegacyAskProManagedBrowserProfileDir(profileDir: string): boolean {
  const resolved = normalizeProfilePath(profileDir);
  if (resolved === normalizeProfilePath(legacyAskProBrowserProfileDirForAgentId(null))) return true;
  return askProAgentIdForLegacyBrowserProfileDir(profileDir) !== null;
}

function profileDirUnder(root: string, agentId: string | null | undefined): string {
  if (!agentId) return path.join(root, "browser-profile");
  if (!RESOLVED_AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("Stored ask-pro agent id is invalid.");
  }
  return path.join(root, "agents", agentId, "browser-profile");
}

export function isAskProManagedBrowserProfileDir(profileDir: string): boolean {
  const resolved = normalizeProfilePath(profileDir);
  const defaultProfile = normalizeProfilePath(askProBrowserProfileDirForAgentId(null));
  if (resolved === defaultProfile) return true;

  return askProAgentIdForManagedBrowserProfileDir(profileDir) !== null;
}

export function isAskProStatePath(profileDir: string): boolean {
  const resolved = normalizeProfilePath(profileDir);
  const stateRoot = normalizeProfilePath(askProStateDir());
  const relative = path.relative(stateRoot, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function askProAgentIdForManagedBrowserProfileDir(profileDir: string): string | null {
  return agentIdForProfileDir(profileDir, askProStateDir());
}

function agentIdForProfileDir(profileDir: string, stateRoot: string): string | null {
  const resolved = normalizeProfilePath(profileDir);
  const agentsRoot = normalizeProfilePath(path.join(stateRoot, "agents"));
  const relative = path.relative(agentsRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[1] !== "browser-profile") return null;
  const agentId = parts[0]!;
  return RESOLVED_AGENT_ID_PATTERN.test(agentId) ? agentId : null;
}

function askProStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim();
  return path.join(
    codexHome ? path.resolve(codexHome) : path.join(os.homedir(), ".codex"),
    "state",
    "ask-pro",
  );
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

async function legacyProfileIdentity(profileDir: string): Promise<LegacyProfileIdentity | null> {
  const info = await fs.stat(profileDir, { bigint: true }).catch(() => null);
  if (!info?.isDirectory() || info.dev <= 0n || info.ino <= 0n || info.birthtimeNs <= 0n) {
    return null;
  }
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    birthtimeNs: info.birthtimeNs.toString(),
  };
}

async function retainedLegacyIdentity(target: string): Promise<LegacyProfileIdentity | null> {
  const recorded = await fs
    .readFile(path.join(target, MIGRATION_MARKER), "utf8")
    .then((raw) => (JSON.parse(raw) as { legacyIdentity?: LegacyProfileIdentity }).legacyIdentity)
    .catch(() => null);
  if (
    !recorded ||
    ![recorded.dev, recorded.ino, recorded.birthtimeNs].every((value) => /^[1-9]\d*$/.test(value))
  ) {
    return null;
  }
  return recorded;
}

async function matchesRetainedLegacy(target: string, legacy: string): Promise<boolean> {
  const [recorded, current] = await Promise.all([
    retainedLegacyIdentity(target),
    legacyProfileIdentity(legacy),
  ]);
  return recorded !== null && current !== null && sameLegacyIdentity(recorded, current);
}

function sameLegacyIdentity(left: LegacyProfileIdentity, right: LegacyProfileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function isSharingDenied(error: unknown): boolean {
  return ["EACCES", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function waitForConcurrentMigration(target: string, legacy: string): Promise<boolean> {
  const marker = path.join(target, MIGRATION_MARKER);
  const owner = await fs
    .readFile(marker, "utf8")
    .then(
      (raw) => JSON.parse(raw) as { pid?: number; createdAt?: number; migrationLockId?: string },
    )
    .catch(() => null);
  if (
    !owner?.pid ||
    !Number.isFinite(owner.pid) ||
    !owner.createdAt ||
    !Number.isFinite(owner.createdAt) ||
    !owner.migrationLockId
  ) {
    return false;
  }
  while (
    isProcessAlive(owner.pid) &&
    Date.now() - owner.createdAt < 300_000 &&
    (await legacyHasMigrationLock(legacy, owner.migrationLockId))
  ) {
    if (!(await exists(legacy))) {
      await fs.rm(marker, { force: true }).catch(() => undefined);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (await exists(legacy)) return false;
  await fs.rm(marker, { force: true }).catch(() => undefined);
  return exists(target);
}

async function legacyHasMigrationLock(legacy: string, lockId: string): Promise<boolean> {
  const activeLockId = await fs
    .readFile(path.join(legacy, "ask-pro-automation.lock"), "utf8")
    .then((raw) => (JSON.parse(raw) as { lockId?: string }).lockId)
    .catch(() => null);
  return activeLockId === lockId;
}

export function resolveAskProAgentId(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.ASK_PRO_AGENT_ID;
  if (value === undefined) return null;
  const raw = value.trim();
  if (raw !== value) {
    throw new Error("ASK_PRO_AGENT_ID must not start or end with whitespace.");
  }
  if (!raw) {
    throw new Error("ASK_PRO_AGENT_ID must not be empty.");
  }
  if (!/^[a-z0-9._-]+$/.test(raw)) {
    throw new Error("ASK_PRO_AGENT_ID must use only lowercase letters, numbers, '.', '_', or '-'.");
  }
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 10);
  const prefix = raw.slice(0, 53).replace(/^[-_.]+|[-_.]+$/g, "") || "agent";
  return `${prefix}-${hash}`;
}

function normalizeProfilePath(profileDir: string): string {
  const resolved = path.resolve(profileDir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
