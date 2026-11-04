import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { migrateLegacyAskProProfiles } from "../../src/browser/profileMigration.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const agentId = "review-t1-59cd6bada6";
const otherAgentId = "other-0123456789";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  );
});

// An isolated home with the state folders of earlier versions and of this one.
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-migration-")));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(root, "codex"),
    ASK_PRO_STATE_DIR: path.join(root, "state"),
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const codexState = path.join(env.CODEX_HOME, "state", "ask-pro");
  const skillFolder = path.join(home, ".agents", "skills", "ask-pro");
  const profile = (base: string, id: string | null = null) =>
    id ? path.join(base, "agents", id, "browser-profile") : path.join(base, "browser-profile");
  const writeProfile = async (dir: string, marker: string) => {
    await fs.mkdir(path.join(dir, "Default", "Network"), { recursive: true });
    await fs.writeFile(path.join(dir, "Local State"), marker);
    await fs.writeFile(path.join(dir, "Default", "Network", "Cookies"), `${marker}-cookies`);
  };
  const readMarker = (dir: string) => fs.readFile(path.join(dir, "Local State"), "utf8");
  // A separate ask-pro run: resolves the profile it would open, then exits.
  const script = path.join(root, "prepare.mts");
  await fs.writeFile(
    script,
    [
      `import { prepareAskProBrowserProfile } from ${JSON.stringify(
        pathToFileURL(path.join(process.cwd(), "src", "browser", "profileMigration.ts")).href,
      )};`,
      "console.log(await prepareAskProBrowserProfile(process.argv[2] || null));",
    ].join("\n"),
  );
  const tsx = pathToFileURL(
    path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
  ).href;
  const run = async (id: string | null = null) => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", tsx, script, ...(id ? [id] : [])],
      { env: { ...process.env, ...env } },
    );
    return stdout.trim();
  };
  return {
    root,
    state: env.ASK_PRO_STATE_DIR,
    codexState,
    skillFolder,
    profile,
    writeProfile,
    readMarker,
    run,
  };
}

// Older installs that still open the old path reach the moved profile through a link there.
async function forwards(from: string, to: string): Promise<boolean> {
  const info = await fs.lstat(from).catch(() => null);
  return Boolean(info?.isSymbolicLink()) && (await fs.realpath(from)) === (await fs.realpath(to));
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}

// A process that stays alive until killed, optionally working inside `cwd`.
async function holdProcess(cwd?: string) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd,
    stdio: "ignore",
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  return {
    pid: child.pid!,
    stop: async () => {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    },
  };
}

describe("browser profile migration", () => {
  test("moves every old profile into the state folder once", async () => {
    const t = await setup();
    await t.writeProfile(t.profile(t.codexState), "shared");
    await t.writeProfile(t.profile(t.codexState, agentId), "agent");
    await fs.mkdir(t.skillFolder, { recursive: true });
    await fs.writeFile(path.join(t.skillFolder, "SKILL.md"), "installed skill");
    await t.writeProfile(t.profile(t.skillFolder, otherAgentId), "oldest");

    expect(await t.run()).toBe(t.profile(t.state));

    expect(await t.readMarker(t.profile(t.state))).toBe("shared");
    expect(await t.readMarker(t.profile(t.state, agentId))).toBe("agent");
    expect(await t.readMarker(t.profile(t.state, otherAgentId))).toBe("oldest");
    expect(
      await fs.readFile(
        path.join(t.profile(t.state, agentId), "Default", "Network", "Cookies"),
        "utf8",
      ),
    ).toBe("agent-cookies");
    for (const [old, id] of [
      [t.codexState, null],
      [t.codexState, agentId],
      [t.skillFolder, otherAgentId],
    ] as const) {
      expect(await forwards(t.profile(old, id), t.profile(t.state, id))).toBe(true);
    }

    const log = vi.fn();
    const before = await fs.readdir(t.state, { recursive: true });
    await migrateLegacyAskProProfiles({ log });
    expect(await fs.readdir(t.state, { recursive: true })).toEqual(before);
    expect(log).not.toHaveBeenCalled();
  }, 30_000);

  test("keeps the current profile and leaves an old one alone when both exist", async () => {
    const t = await setup();
    await t.writeProfile(t.profile(t.state), "current");
    await t.writeProfile(t.profile(t.codexState), "old");
    const log = vi.fn();

    await migrateLegacyAskProProfiles({ log });
    await migrateLegacyAskProProfiles({ log });

    expect(await t.run()).toBe(t.profile(t.state));
    expect(await t.readMarker(t.profile(t.state))).toBe("current");
    expect(await t.readMarker(t.profile(t.codexState))).toBe("old");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain(t.profile(t.codexState));
  }, 30_000);

  test("uses an old profile while another run holds it and moves it on a later run", async () => {
    const t = await setup();
    const old = t.profile(t.codexState);
    await t.writeProfile(old, "old");
    // An even older copy must not take the busy profile's place.
    await t.writeProfile(t.profile(t.skillFolder), "oldest");
    const holder = await holdProcess();
    try {
      await fs.writeFile(
        path.join(old, "ask-pro-automation.lock"),
        JSON.stringify({ pid: holder.pid, lockId: "held", createdAt: new Date().toISOString() }),
      );
      expect(await t.run()).toBe(old);
      expect(await t.readMarker(old)).toBe("old");
      expect(await exists(t.profile(t.state))).toBe(false);
    } finally {
      await holder.stop();
    }

    expect(await t.run()).toBe(t.profile(t.state));
    expect(await t.readMarker(t.profile(t.state))).toBe("old");
    expect(await forwards(old, t.profile(t.state))).toBe(true);
    expect(await t.readMarker(t.profile(t.skillFolder))).toBe("oldest");
  }, 30_000);

  test.runIf(process.platform === "win32")(
    "uses an old profile Windows keeps open and moves it once released",
    async () => {
      const t = await setup();
      const old = t.profile(t.codexState);
      await t.writeProfile(old, "old");
      // Like Chrome, a process working inside the profile keeps Windows from moving it.
      const holder = await holdProcess(path.join(old, "Default"));
      try {
        expect(await t.run()).toBe(old);
        expect(await t.readMarker(old)).toBe("old");
        expect(await exists(t.profile(t.state))).toBe(false);
      } finally {
        await holder.stop();
      }

      expect(await t.run()).toBe(t.profile(t.state));
      expect(await t.readMarker(t.profile(t.state))).toBe("old");
      expect(await forwards(old, t.profile(t.state))).toBe(true);
    },
    30_000,
  );

  test("lets concurrent first runs share one move", async () => {
    const t = await setup();
    await t.writeProfile(t.profile(t.codexState), "shared");
    await t.writeProfile(t.profile(t.codexState, agentId), "agent");

    const results = await Promise.all([t.run(), t.run(agentId), t.run(), t.run(agentId)]);

    expect(results).toEqual([
      t.profile(t.state),
      t.profile(t.state, agentId),
      t.profile(t.state),
      t.profile(t.state, agentId),
    ]);
    expect(await t.readMarker(t.profile(t.state))).toBe("shared");
    expect(await t.readMarker(t.profile(t.state, agentId))).toBe("agent");
    expect(await forwards(t.profile(t.codexState), t.profile(t.state))).toBe(true);
  }, 60_000);

  test("copies, verifies, then removes an old profile on another volume", async () => {
    const t = await setup();
    const old = t.profile(t.codexState);
    await t.writeProfile(old, "old");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.resolve(String(from)) === old && path.resolve(String(to)) === t.profile(t.state)) {
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      }
      return rename(from, to);
    });

    await migrateLegacyAskProProfiles();

    expect(await t.readMarker(t.profile(t.state))).toBe("old");
    expect(
      await fs.readFile(path.join(t.profile(t.state), "Default", "Network", "Cookies"), "utf8"),
    ).toBe("old-cookies");
    expect(await forwards(old, t.profile(t.state))).toBe(true);
    expect(await fs.readdir(path.join(t.state, ".migration"))).not.toContainEqual(
      expect.stringMatching(/^copy-/),
    );
  }, 30_000);
});
