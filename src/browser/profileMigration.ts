import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  askProBrowserProfileDirForAgentId,
  askProBrowserProfileDirUnder,
  askProStateDir,
  isResolvedAskProAgentId,
  legacyAskProStateDirs,
} from "./profilePaths.js";
import {
  acquireProfileRunLock,
  isBrowserProfileInUse,
  isProcessAlive,
  releaseProfileRunLock,
} from "./profileState.js";

type MigrationOptions = { env?: NodeJS.ProcessEnv; log?: (message: string) => void };
type LegacyProfile = { root: string; legacy: string; target: string };

// Coordination files live in the current state folder: the migration lock, records of runs that
// still use an old profile, unfinished copies and the profiles already reported as leftovers.
const MIGRATION_DIR = ".migration";
const PROFILE_LOCK_FILENAME = "ask-pro-automation.lock";
const MIGRATION_LOCK_TIMEOUT_MS = 15 * 60_000;
const TRASH_PREFIX = ".ask-pro-trash-";

/**
 * Moves browser profiles left by earlier versions into the current state folder. A profile that
 * is in use stays where it is and moves on a later run. Never fails the caller.
 */
export async function migrateLegacyAskProProfiles(options: MigrationOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const stateDir = askProStateDir(env);
  try {
    const profiles = await findLegacyProfiles(env);
    if (profiles.length === 0) return;
    if (await someMissing(profiles.map((profile) => profile.target))) {
      await withMigrationLock(stateDir, async () => {
        // Only the newest old copy of each profile moves, even if it must wait for a later run.
        const claimed = new Set<string>();
        for (const profile of profiles) {
          if (claimed.has(profile.target)) continue;
          claimed.add(profile.target);
          if (!(await exists(profile.target))) await moveProfile(profile, stateDir);
        }
      });
    }
    await reportLeftovers(profiles, stateDir, options.log);
    await removeEmptyFolders(profiles);
  } catch {
    // retried on a later run
  }
}

/**
 * The browser profile this run uses: the current one, or an earlier version's profile that is
 * still in use and has not moved yet. The old location is then kept for the whole run.
 */
export async function prepareAskProBrowserProfile(
  agentId: string | null | undefined,
  options: MigrationOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  await migrateLegacyAskProProfiles(options);
  const target = askProBrowserProfileDirForAgentId(agentId, env);
  if (await exists(target)) return target;
  const stateDir = askProStateDir(env);
  const pick = async (record: boolean) => {
    if (await exists(target)) return target;
    for (const root of legacyAskProStateDirs(env)) {
      const legacy = askProBrowserProfileDirUnder(root, agentId);
      if (!(await exists(legacy))) continue;
      if (record) await recordLegacyUse(stateDir, legacy);
      return legacy;
    }
    return target;
  };
  // The record keeps a concurrent migration from moving the profile out from under this run.
  return withMigrationLock(stateDir, () => pick(true)).catch(() => pick(false));
}

async function findLegacyProfiles(env: NodeJS.ProcessEnv): Promise<LegacyProfile[]> {
  const stateDir = askProStateDir(env);
  const profiles: LegacyProfile[] = [];
  for (const root of legacyAskProStateDirs(env)) {
    const entries = await fs.readdir(root).catch(() => [] as string[]);
    if (entries.length === 0) continue;
    for (const entry of entries.filter((name) => name.startsWith(TRASH_PREFIX))) {
      await fs.rm(path.join(root, entry), { recursive: true, force: true }).catch(() => undefined);
    }
    const agentIds = entries.includes("agents")
      ? (await fs.readdir(path.join(root, "agents")).catch(() => [] as string[])).filter(
          isResolvedAskProAgentId,
        )
      : [];
    for (const agentId of [null, ...agentIds]) {
      const legacy = askProBrowserProfileDirUnder(root, agentId);
      if (await exists(legacy)) {
        profiles.push({ root, legacy, target: askProBrowserProfileDirUnder(stateDir, agentId) });
      }
    }
  }
  return profiles;
}

async function moveProfile(profile: LegacyProfile, stateDir: string): Promise<void> {
  const { legacy, target } = profile;
  if (await hasLiveLegacyUse(stateDir, legacy)) return;
  let lock;
  try {
    // Holding the profile's run lock keeps other ask-pro runs, old versions included, from
    // opening it mid-move.
    lock = await acquireProfileRunLock(legacy, { timeoutMs: 1, pollMs: 1 });
  } catch {
    return;
  }
  if (!lock) return;
  let lockPath = lock.path;
  try {
    if (await isBrowserProfileInUse(legacy, { ignoreLockId: lock.lockId })) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.rename(legacy, target);
      lockPath = path.join(target, PROFILE_LOCK_FILENAME);
      return;
    } catch (error) {
      // Anything but a move across volumes (on Windows: a profile Chrome still has open) is
      // retried on a later run.
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") return;
    }
    await copyProfile(legacy, target, stateDir);
    await removeFolder(legacy, profile.root);
  } catch {
    // retried on a later run
  } finally {
    await releaseProfileRunLock(lockPath, lock.lockId);
  }
}

async function copyProfile(legacy: string, target: string, stateDir: string): Promise<void> {
  const staging = path.join(stateDir, MIGRATION_DIR, `copy-${randomUUID()}`);
  const ownLock = path.join(legacy, PROFILE_LOCK_FILENAME);
  try {
    await fs.cp(legacy, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      filter: (source) => source !== ownLock,
    });
    const [expected, copied] = await Promise.all([listTree(legacy), listTree(staging)]);
    expected.delete(PROFILE_LOCK_FILENAME);
    if (
      expected.size !== copied.size ||
      [...expected].some(([name, kind]) => copied.get(name) !== kind)
    ) {
      throw new Error("ask-pro browser profile copy is incomplete.");
    }
    await fs.rename(staging, target);
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Relative path -> entry kind, with file sizes.
async function listTree(root: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const name = path.relative(root, full);
      if (entry.isDirectory()) {
        tree.set(name, "dir");
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        tree.set(name, `link:${await fs.readlink(full)}`);
      } else {
        tree.set(name, `file:${(await fs.lstat(full)).size}`);
      }
    }
  };
  await walk(root);
  return tree;
}

// Moves the folder aside in one step, so a partly deleted profile is never left behind. A folder
// that cannot be moved stays and is reported as a leftover.
async function removeFolder(folder: string, root: string): Promise<void> {
  const trash = path.join(root, `${TRASH_PREFIX}${randomUUID()}`);
  try {
    await fs.rename(folder, trash);
  } catch {
    return;
  }
  await fs.rm(trash, { recursive: true, force: true }).catch(() => undefined);
}

async function withMigrationLock<T>(stateDir: string, action: () => Promise<T>): Promise<T> {
  const dir = path.join(stateDir, MIGRATION_DIR);
  const lock = await acquireProfileRunLock(dir, {
    timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
    pollMs: 200,
  });
  try {
    // Copies left by an interrupted migration; none can be in progress while the lock is held.
    for (const entry of await fs.readdir(dir)) {
      if (entry.startsWith("copy-")) {
        await fs.rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return await action();
  } finally {
    await lock?.release();
  }
}

async function recordLegacyUse(stateDir: string, legacy: string): Promise<void> {
  const record = path.join(stateDir, MIGRATION_DIR, `in-use-${process.pid}-${randomUUID()}.json`);
  await fs.writeFile(record, JSON.stringify({ pid: process.pid, profile: legacy }));
  process.once("exit", () => rmSync(record, { force: true }));
}

async function hasLiveLegacyUse(stateDir: string, legacy: string): Promise<boolean> {
  const dir = path.join(stateDir, MIGRATION_DIR);
  let inUse = false;
  for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!entry.startsWith("in-use-")) continue;
    const record = path.join(dir, entry);
    const { pid, profile } = await fs
      .readFile(record, "utf8")
      .then((raw) => JSON.parse(raw) as { pid?: number; profile?: string })
      .catch(() => ({ pid: undefined, profile: undefined }));
    if (!pid || !isProcessAlive(pid)) {
      await fs.rm(record, { force: true }).catch(() => undefined);
    } else if (profile && samePath(profile, legacy)) {
      inUse = true;
    }
  }
  return inUse;
}

// Reports once per folder an old profile that stays behind because a current one already exists.
async function reportLeftovers(
  profiles: LegacyProfile[],
  stateDir: string,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  if (!log) return;
  const leftovers: LegacyProfile[] = [];
  for (const profile of profiles) {
    if ((await exists(profile.legacy)) && (await exists(profile.target))) leftovers.push(profile);
  }
  if (leftovers.length === 0) return;
  const file = path.join(stateDir, MIGRATION_DIR, "reported-leftovers.json");
  const reported = await fs
    .readFile(file, "utf8")
    .then((raw) => JSON.parse(raw) as string[])
    .catch(() => [] as string[]);
  const fresh = leftovers.filter((profile) => !reported.includes(profile.legacy));
  if (fresh.length === 0) return;
  for (const { legacy, target } of fresh) {
    log(
      `ask-pro uses ${target}. The older browser profile at ${legacy} is unused; you can delete it.`,
    );
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify([...reported, ...fresh.map((profile) => profile.legacy)]),
  );
}

// Removes old state folders the migration emptied. Folders that still hold anything stay.
async function removeEmptyFolders(profiles: LegacyProfile[]): Promise<void> {
  for (const root of new Set(profiles.map((profile) => profile.root))) {
    const agents = path.join(root, "agents");
    for (const agentId of await fs.readdir(agents).catch(() => [] as string[])) {
      if (isResolvedAskProAgentId(agentId)) {
        await fs.rmdir(path.join(agents, agentId)).catch(() => undefined);
      }
    }
    await fs.rmdir(agents).catch(() => undefined);
    await fs.rmdir(root).catch(() => undefined);
  }
}

async function someMissing(paths: string[]): Promise<boolean> {
  for (const candidate of paths) if (!(await exists(candidate))) return true;
  return false;
}

async function exists(candidate: string): Promise<boolean> {
  return fs.stat(candidate).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
