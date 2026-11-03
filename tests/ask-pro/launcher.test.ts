import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  );
});

type LauncherOutput = {
  entry: string;
  args: string[];
  launcher: string;
  initCwd: string;
  cwd: string;
  revision: number;
  dependencyResolved: boolean;
};

// An installed skill folder: the launcher plus the package files it bootstraps from. A prebuilt
// stand-in CLI keeps the test off the real build while still resolving installed dependencies.
async function installSkill(prefix: string) {
  // Real path: Node reports the launcher and CLI by real path (macOS temp folders are symlinked).
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(root);
  const skillRoot = path.join(root, "skill");
  const projectCwd = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex");
  const runtimes = path.join(stateDir, "runtimes");
  const launcher = path.join(skillRoot, "scripts", "ask-pro.mjs");
  const cli = path.join(skillRoot, "dist", "bin", "ask-pro-cli.js");
  await fs.mkdir(projectCwd);
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.copyFile(path.join(repoRoot, "scripts", "ask-pro.mjs"), launcher);
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  packageJson.version = "1.2.3";
  await fs.writeFile(
    path.join(skillRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    await fs.copyFile(path.join(repoRoot, file), path.join(skillRoot, file));
  }
  const writeCli = (revision: number) =>
    fs.writeFile(
      cli,
      [
        'import dotenv from "dotenv";',
        'import { fileURLToPath } from "node:url";',
        `console.log(JSON.stringify({ entry: fileURLToPath(import.meta.url), dependencyResolved: typeof dotenv.config === "function", args: process.argv.slice(2), launcher: process.env.ASK_PRO_SOURCE_CHECKOUT_LAUNCHER, initCwd: process.env.INIT_CWD, cwd: process.cwd(), revision: ${revision} }));`,
        "",
      ].join("\n"),
    );
  await writeCli(1);
  const env = {
    ...process.env,
    ASK_PRO_STATE_DIR: stateDir,
    CODEX_HOME: codexHome,
    INIT_CWD: path.join(root, "stale-init-cwd"),
  };
  const run = async (...args: string[]) => {
    const { stdout } = await execFileAsync(process.execPath, [launcher, "--", ...args], {
      cwd: projectCwd,
      env,
    });
    // stdout must carry only the CLI's own output, even on a first run that installs.
    expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
    return JSON.parse(stdout) as LauncherOutput;
  };
  const buildOf = (output: LauncherOutput) =>
    path.dirname(path.dirname(path.dirname(output.entry)));
  return { root, skillRoot, projectCwd, runtimes, codexHome, launcher, writeCli, run, buildOf };
}

describe("skill launcher", () => {
  test("builds once per installed content and removes other builds after an update", async () => {
    const skill = await installSkill("ask-pro-launcher-");
    const before = await snapshotFiles(skill.skillRoot);

    const [first, concurrent] = await Promise.all([skill.run("status"), skill.run("concurrent")]);
    const firstBuild = skill.buildOf(first);

    expect(concurrent.entry).toBe(first.entry);
    expect(first.dependencyResolved).toBe(true);
    const installRoot = path.dirname(firstBuild);
    expect(path.dirname(installRoot)).toBe(skill.runtimes);
    expect(path.basename(firstBuild)).toMatch(/^1\.2\.3-[a-f0-9]{16}$/);
    expect(first.args).toEqual(["status"]);
    expect(first.launcher).toContain(skill.launcher);
    expect(await fs.realpath(first.initCwd)).toBe(await fs.realpath(skill.projectCwd));
    expect(await fs.realpath(first.cwd)).toBe(await fs.realpath(skill.projectCwd));
    expect(await snapshotFiles(skill.skillRoot)).toEqual(before);

    // Leftovers from interrupted work, plus an old build a running ask-pro still uses.
    const abandoned = path.join(installRoot, "0.9.0-abandoned");
    const trash = path.join(installRoot, ".trash-leftover");
    const leased = path.join(installRoot, "0.9.0-leased");
    await fs.mkdir(abandoned);
    await fs.writeFile(
      path.join(abandoned, ".ask-pro-runtime-building"),
      JSON.stringify({ pid: 2 ** 30, createdAt: Date.now() }),
    );
    await fs.mkdir(trash);
    await fs.mkdir(leased);
    await fs.writeFile(path.join(leased, ".ask-pro-runtime-ready"), "");
    await fs.writeFile(
      path.join(leased, ".active-test.json"),
      JSON.stringify({ pid: process.pid }),
    );

    // Builds of another install that still exists, and of one that was removed.
    const otherInstall = await fakeInstall(skill.runtimes, "other", repoRoot);
    await fakeInstall(skill.runtimes, "removed", path.join(skill.root, "gone"));

    const reused = await skill.run("resume");
    expect(reused.entry).toBe(first.entry);
    expect(reused.args).toEqual(["resume"]);
    expect(await directories(installRoot)).toEqual(
      [path.basename(firstBuild), "0.9.0-leased"].sort(),
    );
    expect(await directories(skill.runtimes)).toEqual(
      [path.basename(installRoot), path.basename(otherInstall)].sort(),
    );

    await skill.writeCli(2);
    const updated = await skill.run("status");
    expect(updated.revision).toBe(2);
    expect(skill.buildOf(updated)).not.toBe(firstBuild);
    expect(await directories(installRoot)).toEqual(
      [path.basename(skill.buildOf(updated)), "0.9.0-leased"].sort(),
    );
    expect(await directories(otherInstall)).toEqual(["0.1.0-other"]);
  }, 180_000);

  test("removes the earlier plugin launcher's builds once no run uses them", async () => {
    const skill = await installSkill("ask-pro-launcher-legacy-");
    const legacyRuntimes = path.join(skill.codexHome, "plugin-runtimes", "ask-pro");
    const leased = path.join(legacyRuntimes, "0.1.0-leased");
    for (const build of ["0.1.0-old", "0.1.0-leased"]) {
      await fs.mkdir(path.join(legacyRuntimes, build), { recursive: true });
      await fs.writeFile(path.join(legacyRuntimes, build, ".ask-pro-runtime-ready"), "");
    }
    await fs.writeFile(path.join(leased, ".active-1.json"), JSON.stringify({ pid: process.pid }));

    await skill.run("status");
    expect(await directories(legacyRuntimes)).toEqual(["0.1.0-leased"]);

    await fs.rm(path.join(leased, ".active-1.json"));
    await skill.run("status");
    await expect(fs.stat(legacyRuntimes)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await directories(path.join(skill.codexHome, "plugin-runtimes"))).toEqual([]);
  }, 180_000);

  test.runIf(process.platform === "win32")(
    "skips an old build that is still open and removes it on a later run",
    async () => {
      const skill = await installSkill("ask-pro-launcher-locked-");
      const oldBuild = skill.buildOf(await skill.run("status"));

      // A process working inside the old build keeps Windows from moving or deleting it.
      const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: oldBuild,
        stdio: "ignore",
      });
      try {
        await skill.writeCli(2);
        const updated = await skill.run("status");
        const newBuild = skill.buildOf(updated);
        expect(updated.revision).toBe(2);
        expect(await directories(path.dirname(newBuild))).toEqual(
          [path.basename(oldBuild), path.basename(newBuild)].sort(),
        );
        await expect(
          fs.stat(path.join(oldBuild, "dist", "bin", "ask-pro-cli.js")),
        ).resolves.toBeTruthy();
      } finally {
        const exited = new Promise((resolve) => holder.once("exit", resolve));
        holder.kill();
        await exited;
      }

      const later = await skill.run("status");
      expect(later.revision).toBe(2);
      expect(await directories(path.dirname(oldBuild))).toEqual([
        path.basename(skill.buildOf(later)),
      ]);
    },
    180_000,
  );
});

// The runtime group the launcher keeps for a skill folder at `source`, with one finished build.
async function fakeInstall(runtimes: string, name: string, source: string): Promise<string> {
  const installRoot = path.join(runtimes, `install-${name}`);
  await fs.mkdir(path.join(installRoot, `0.1.0-${name}`), { recursive: true });
  await fs.writeFile(path.join(installRoot, ".source"), source);
  await fs.writeFile(path.join(installRoot, `0.1.0-${name}`, ".ask-pro-runtime-ready"), "");
  return installRoot;
}

async function directories(parent: string): Promise<string[]> {
  const entries = await fs.readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function snapshotFiles(root: string, current = root): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotFiles(root, fullPath));
    } else {
      snapshot[path.relative(root, fullPath)] = await fs.readFile(fullPath, "utf8");
    }
  }
  return snapshot;
}
