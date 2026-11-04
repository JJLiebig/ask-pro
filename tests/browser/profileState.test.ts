import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createManagedChromeRunLease,
  acquireProfileRunLock,
  clearIdleBrowserProfileCaches,
  releaseManagedChromeRunLeaseAndCountPeers,
} from "../../src/browser/profileState.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("clears only idle profile caches, preserving sign-in data and live runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-profile-caches-"));
  tempDirs.push(root);
  for (const relative of ["browser-profile", "agents/test/browser-profile"]) {
    const profile = path.join(root, relative);
    const caches = ["Cache/data", "Code Cache/js/data"];
    const signIn = [
      "Network/Cookies",
      "Local Storage/leveldb/data",
      "IndexedDB/data",
      "Preferences",
    ];
    for (const file of [...caches, ...signIn]) {
      const target = path.join(profile, "Default", file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file);
    }
    const lock = await acquireProfileRunLock(profile, { timeoutMs: 1000 });
    if (!lock) throw new Error("Expected profile lock");
    try {
      await clearIdleBrowserProfileCaches(profile);
      for (const file of caches) {
        expect(await fs.readFile(path.join(profile, "Default", file), "utf8")).toBe(file);
      }
      const lease = await createManagedChromeRunLease(profile);
      await clearIdleBrowserProfileCaches(profile, { ignoreLockId: lock.lockId });
      for (const file of caches) {
        expect(await fs.readFile(path.join(profile, "Default", file), "utf8")).toBe(file);
      }
      await releaseManagedChromeRunLeaseAndCountPeers(profile, lease);
      await clearIdleBrowserProfileCaches(profile, { ignoreLockId: lock.lockId });
      for (const folder of ["Cache", "Code Cache"]) {
        await expect(fs.stat(path.join(profile, "Default", folder))).rejects.toThrow();
      }
      for (const file of signIn) {
        expect(await fs.readFile(path.join(profile, "Default", file), "utf8")).toBe(file);
      }
    } finally {
      await lock.release();
    }
  }
});

describe("managed Chrome run leases", () => {
  test("transfers cleanup to the last live run and prunes dead peers", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-leases-"));
    tempDirs.push(profileDir);

    const first = await createManagedChromeRunLease(profileDir);
    const second = await createManagedChromeRunLease(profileDir);
    await expect(releaseManagedChromeRunLeaseAndCountPeers(profileDir, first)).resolves.toBe(1);
    await expect(releaseManagedChromeRunLeaseAndCountPeers(profileDir, second)).resolves.toBe(0);

    const deadLeasePath = path.join(path.dirname(first.path), "2147483647-dead-controller.lease");
    await fs.writeFile(deadLeasePath, "");
    const live = await createManagedChromeRunLease(profileDir);
    await expect(releaseManagedChromeRunLeaseAndCountPeers(profileDir, live)).resolves.toBe(0);
    await expect(fs.stat(deadLeasePath)).rejects.toThrow();
  });
});
