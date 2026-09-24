import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function snapshotFiles(root: string, current = root): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotFiles(root, fullPath));
    } else {
      snapshot[path.relative(root, fullPath)] = (await fs.readFile(fullPath)).toString("base64");
    }
  }
  return snapshot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ask-pro cli", () => {
  test("documents the V1 switches", async () => {
    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      tsxLoader,
      cli,
      "--help",
    ]);

    expect(stdout).not.toContain("--extended");
    expect(stdout).toContain("--temporary");
    expect(stdout).toContain("--no-temporary");
    expect(stdout).toContain("--prompt-file");
    expect(stdout).toContain("--artifacts");
  }, 30000);

  test("creates a dry-run session", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
    const expiredDir = path.join(cwd, ".ask-pro", "sessions", "expired-session");
    await fs.mkdir(expiredDir, { recursive: true });
    await fs.writeFile(
      path.join(expiredDir, "status.json"),
      `${JSON.stringify({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })}\n`,
    );
    await fs.writeFile(path.join(expiredDir, "ANSWER.md"), "expired\n");

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "--files", "src/**/*.ts", "Review this."],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toMatch(/^ask_pro\n/);
    expect(stdout).toContain("  state: dry_run_complete\n");
    expect(stdout).toContain("  files: 1\n");
    expect(stdout).toContain("  action: resume\n");
    expect(stdout).toContain('  resume: "ask-pro --resume ');
    expect(stdout).not.toContain("session created");
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    expect(sessions).toHaveLength(1);
    await expect(fs.stat(expiredDir)).rejects.toMatchObject({ code: "ENOENT" });
    const statusRaw = await fs.readFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json"),
      "utf8",
    );
    expect(JSON.parse(statusRaw)).toMatchObject({ status: "DRY_RUN_COMPLETE", dryRun: true });
    expect(JSON.parse(statusRaw).resumeCommand).not.toContain("--no-temporary");
  }, 30000);

  test("creates a dry-run session from a prompt file", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-prompt-file-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "question.md"), "Line one\n\nLine two\n", "utf8");

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "--prompt-file", "question.md"],
      { cwd },
    );

    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const prompt = await fs.readFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "PROMPT.md"),
      "utf8",
    );
    expect(prompt).toContain("Line one\n\nLine two");
  }, 30000);

  test("creates an artifacts dry-run session only when requested", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-artifacts-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "--artifacts", "Return a package."],
      { cwd },
    );

    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const sessionDir = path.join(cwd, ".ask-pro", "sessions", sessions[0]!);
    const prompt = await fs.readFile(path.join(sessionDir, "PROMPT.md"), "utf8");
    const status = JSON.parse(await fs.readFile(path.join(sessionDir, "status.json"), "utf8"));
    expect(prompt).toContain("ask-pro-response.zip");
    expect(status.artifacts).toBe(true);
  }, 30000);

  test("rejects mixed question argument and prompt file", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-prompt-file-mixed-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "question.md"), "Prompt\n", "utf8");

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;

    await expect(
      execFileAsync(
        process.execPath,
        ["--import", tsxLoader, cli, "--dry-run", "--prompt-file", "question.md", "Inline"],
        { cwd },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("Use either a question argument or --prompt-file"),
    });
  }, 30000);

  test("prints session status as compact TOON", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-status-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      { cwd },
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toMatch(/^ask_pro\n/);
    expect(stdout).toContain("  state: dry_run_complete\n");
    expect(stdout).not.toContain("  thinking:");
    expect(stdout).toContain("  temporary: default\n");
    expect(stdout).toContain("  action: resume\n");
    expect(stdout).not.toContain("{");
  }, 30000);

  test("prints harvest answer without metadata wrapper", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-harvest-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "COMPLETED" }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "ANSWER.md"),
      "line one\n\n  ",
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--harvest"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toBe("line one\n\n  ");
  }, 30000);

  test("does not harvest non-answer-bearing sessions", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-harvest-pending-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--harvest"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("  state: dry_run_complete\n");
    expect(stdout).toContain("  action: resume\n");
    expect(stdout).not.toContain("placeholder");
  }, 30000);

  test("harvest recovers captured answers when status bookkeeping is stale", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-harvest-stale-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );

    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const sessionDir = path.join(cwd, ".ask-pro", "sessions", sessions[0]!);
    const statusPath = path.join(sessionDir, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "WAITING" }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(sessionDir, "ANSWER.md"), "Recovered answer\n", "utf8");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--harvest"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toBe("Recovered answer\n");
    const updated = JSON.parse(await fs.readFile(statusPath, "utf8"));
    expect(updated.status).toBe("HARVESTED");
  }, 30000);

  test("harvest stale-answer recovery only suppresses exact placeholders", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-harvest-placeholder-text-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      { cwd },
    );

    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const sessionDir = path.join(cwd, ".ask-pro", "sessions", sessions[0]!);
    const statusPath = path.join(sessionDir, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "WAITING" }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionDir, "ANSWER.md"),
      'Real answer: the phrase "no browser submission was performed" appears in docs only.\n',
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--harvest"],
      { cwd },
    );

    expect(stdout).toBe(
      'Real answer: the phrase "no browser submission was performed" appears in docs only.\n',
    );
  }, 30000);

  test.each(["preamble_without_artifacts", "stopped_without_answer"])(
    "harvest preserves caller recovery choice: %s",
    async (reason) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-harvest-incomplete-"));
      tempDirs.push(cwd);

      const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
      const tsxLoader = pathToFileURL(
        path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
      ).href;
      await execFileAsync(
        process.execPath,
        ["--import", tsxLoader, cli, "--dry-run", "Review this."],
        { cwd },
      );

      const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
      const sessionDir = path.join(cwd, ".ask-pro", "sessions", sessions[0]!);
      const statusPath = path.join(sessionDir, "status.json");
      const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
      await fs.writeFile(
        statusPath,
        `${JSON.stringify({ ...status, status: "INCOMPLETE_ANSWER", reason }, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(sessionDir, "ANSWER.md"),
        "I'll inspect the bundle and create the files.\n",
        "utf8",
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", tsxLoader, cli, "--harvest"],
        { cwd },
      );

      expect(stdout).toContain("  state: incomplete_answer\n");
      expect(stdout).toContain(`  reason: ${reason}\n`);
      if (reason === "stopped_without_answer") {
        expect(stdout).toContain("  action: choose_resume_or_retry\n");
        expect(stdout).toContain("--resume");
        expect(stdout).toContain(
          "Run the original request again without --resume to start a new chat.",
        );
      }
      const updated = JSON.parse(await fs.readFile(statusPath, "utf8"));
      expect(updated.status).toBe("INCOMPLETE_ANSWER");
    },
    30000,
  );

  test("harvest does not recover suspicious preambles from stale waiting status", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-harvest-stale-preamble-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      { cwd },
    );

    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const sessionDir = path.join(cwd, ".ask-pro", "sessions", sessions[0]!);
    const statusPath = path.join(sessionDir, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "WAITING" }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionDir, "ANSWER.md"),
      "I'll inspect the bundle and create the files.\n",
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--harvest"],
      { cwd },
    );

    expect(stdout).toContain("  state: waiting\n");
    const updated = JSON.parse(await fs.readFile(statusPath, "utf8"));
    expect(updated.status).toBe("WAITING");
  }, 30000);

  test("prints auth-gated status with login action", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-auth-status-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "browser.json"),
      `${JSON.stringify({ schemaVersion: 1, status: "needs_user_auth", profileDir: "C:/External/Profile" }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      statusPath,
      `${JSON.stringify(
        { ...status, status: "NEEDS_USER_AUTH", reason: "login_page_detected" },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("  state: needs_auth\n");
    expect(stdout).toContain("  action: human_login_then_resume\n");
    expect(stdout).not.toContain("  profile: ");
    expect(stdout).not.toContain("  profile_path: ");
    expect(stdout).toContain('  resume: "ask-pro --resume ');
  }, 30000);

  test("prints compact browser preflight fields when known", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-browser-status-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "browser.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "running",
          agentId: "agent-1234567890",
          profileDir: path.join(
            os.homedir(),
            ".codex",
            "state",
            "ask-pro",
            "agents",
            "agent-1234567890",
            "browser-profile",
          ),
          chromeMode: "launched",
          acceptLanguage: "en-US,en",
          runtime: { chromePort: 9222 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "WAITING" }, null, 2)}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("  state: waiting\n");
    expect(stdout).toContain("  profile: agent\n");
    expect(stdout).toContain('  profile_path: "');
    expect(stdout).toContain("agent-1234567890");
    expect(stdout).toContain("  chrome: launched\n");
    expect(stdout).toContain('  language: "en-US,en"\n');
  }, 30000);

  test("prints only saved non-temporary conversation URLs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-browser-url-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "--no-temporary", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "browser.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "running",
          temporary: false,
          runtime: { tabUrl: "https://chatgpt.com/c/recoverable-thread" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "WAITING", temporary: false }, null, 2)}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain('  conversation_url: "https://chatgpt.com/c/recoverable-thread"\n');

    await fs.writeFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "browser.json"),
      `${JSON.stringify({ temporary: false, runtime: { tabUrl: "https://chatgpt.com/c/WEB:provisional" } })}\n`,
      "utf8",
    );
    const provisional = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );
    expect(provisional.stdout).not.toContain("conversation_url");
  }, 30000);

  test("omits conversation url for temporary chat metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-temporary-url-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "--temporary", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "browser.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "running",
          temporary: true,
          runtime: { tabUrl: "https://chatgpt.com/c/temporary-thread" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "WAITING", temporary: true }, null, 2)}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).not.toContain("conversation_url");
  }, 30000);

  test("does not infer Chrome mode from runtime metadata alone", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-browser-runtime-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "browser.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "running",
          profileDir: path.join(os.homedir(), ".codex", "state", "ask-pro", "browser-profile"),
          runtime: { chromePort: 9222 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "WAITING" }, null, 2)}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("  profile: shared\n");
    expect(stdout).not.toContain("  chrome: reused_devtools\n");
  }, 30000);

  test("omits non-managed profile paths from status output", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-browser-unmanaged-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "browser.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "running",
          agentId: "review-t1-59cd6bada6",
          profileDir: "C:/External/Profile",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "WAITING" }, null, 2)}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).not.toContain("  profile: ");
    expect(stdout).not.toContain("  profile_path: ");
  }, 30000);

  test("prints resume command for waiting status", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-waiting-status-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "WAITING" }, null, 2)}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("  state: waiting\n");
    expect(stdout).toContain("  action: wait\n");
    expect(stdout).toContain('  resume: "ask-pro --resume ');
    expect(stdout).not.toContain("  answer: ");
  }, 30000);

  test("prints copy target as compact TOON", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-copy-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--copy"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toMatch(/^ask_pro\n/);
    expect(stdout).toContain("  state: dry_run_complete\n");
    expect(stdout).toContain("  action: resume\n");
    expect(stdout).toContain('  resume: "ask-pro --resume ');
    expect(stdout).not.toContain("  target: ");
  }, 30000);

  test("prints copy target only for answer-bearing sessions", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-copy-target-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "COMPLETED" }, null, 2)}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--copy"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("  state: completed\n");
    expect(stdout).toContain("  action: copy_target\n");
    expect(stdout).toContain("  target: ");
  }, 30000);

  test("does not print harvest command after session is harvested", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-harvested-status-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "COMPLETED" }, null, 2)}\n`,
      "utf8",
    );
    await execFileAsync(process.execPath, ["--import", tsxLoader, cli, "--harvest"], { cwd });

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("  state: harvested\n");
    expect(stdout).toContain("  action: read_answer\n");
    expect(stdout).toContain("  answer: ");
    expect(stdout).not.toContain("  harvest: ");
  }, 30000);

  test("prints answer path for completed status", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-ready-status-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
      },
    );
    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusPath = path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({ ...status, status: "COMPLETED" }, null, 2)}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--status"],
      { cwd },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("  state: completed\n");
    expect(stdout).toContain("  action: harvest\n");
    expect(stdout).toContain("  answer: ");
    expect(stdout).toContain('  harvest: "ask-pro --harvest ');
  }, 30000);

  test("prints errors as structured stdout", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-error-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;

    await expect(
      execFileAsync(process.execPath, ["--import", tsxLoader, cli, "--dry-run"], { cwd }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("ask_pro_error\n"),
      stderr: "",
    });
  }, 30000);

  test("preserves the temporary flag in dry-run resume command", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-resume-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "--temporary", "Review this."],
      { cwd },
    );

    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusRaw = await fs.readFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json"),
      "utf8",
    );
    expect(JSON.parse(statusRaw)).toMatchObject({
      temporary: true,
      resumeCommand: expect.stringContaining("--temporary --resume"),
    });
    expect(stdout).not.toContain("  thinking:");
    expect(stdout).toContain("  temporary: strict\n");
  }, 30000);

  test("preserves explicit no-temporary mode in dry-run resume command", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-no-temporary-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "--no-temporary", "Review this."],
      { cwd },
    );

    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusRaw = await fs.readFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json"),
      "utf8",
    );
    expect(JSON.parse(statusRaw)).toMatchObject({
      temporary: false,
      resumeCommand: expect.stringContaining("--no-temporary --resume"),
    });
    expect(stdout).toContain("  temporary: off\n");
  }, 30000);

  test("does not infer source checkout launcher from an unrelated npm start script", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-npm-start-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      { cwd, env: { ...process.env, npm_lifecycle_event: "start" } },
    );

    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusRaw = await fs.readFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json"),
      "utf8",
    );
    expect(JSON.parse(statusRaw)).toMatchObject({
      resumeCommand: expect.stringMatching(/^ask-pro --resume /),
    });
  }, 30000);

  test("uses source-checkout launcher in resume command when invoked through pnpm start", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-source-resume-"));
    tempDirs.push(cwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd,
        env: {
          ...process.env,
          ASK_PRO_SOURCE_CHECKOUT_LAUNCHER:
            'npm exec --yes pnpm@11.19.0 -- --dir "C:/Code/ask-pro" start --',
          INIT_CWD: cwd,
        },
      },
    );

    const sessions = await fs.readdir(path.join(cwd, ".ask-pro", "sessions"));
    const statusRaw = await fs.readFile(
      path.join(cwd, ".ask-pro", "sessions", sessions[0]!, "status.json"),
      "utf8",
    );
    expect(JSON.parse(statusRaw)).toMatchObject({
      resumeCommand: expect.stringMatching(
        /^npm exec --yes pnpm@11\.19\.0 -- --dir "C:\/Code\/ask-pro" start -- --cwd (?:".+"|'.+') --resume /,
      ),
      harvestCommand: expect.stringMatching(
        /^npm exec --yes pnpm@11\.19\.0 -- --dir "C:\/Code\/ask-pro" start -- --cwd (?:".+"|'.+') --harvest /,
      ),
    });
  }, 30000);

  test("source-checkout launcher uses INIT_CWD as the project directory", async () => {
    const projectCwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cli-source-cwd-"));
    tempDirs.push(projectCwd);

    const cli = path.join(process.cwd(), "bin", "ask-pro-cli.ts");
    const tsxLoader = pathToFileURL(
      path.join(process.cwd(), "node_modules", "tsx", "dist", "esm", "index.mjs"),
    ).href;
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cli, "--dry-run", "Review this."],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ASK_PRO_SOURCE_CHECKOUT_LAUNCHER:
            'npm exec --yes pnpm@11.19.0 -- --dir "C:/Code/ask-pro" start --',
          INIT_CWD: projectCwd,
        },
      },
    );

    const sessions = await fs.readdir(path.join(projectCwd, ".ask-pro", "sessions"));
    expect(sessions).toHaveLength(1);
  }, 30000);

  test("cached runner executes from a reusable content-addressed runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-cached-runtime-"));
    tempDirs.push(root);
    const projectCwd = path.join(root, "project");
    await fs.mkdir(projectCwd);
    const codexHome = path.join(root, "codex");
    const cacheRoot = path.join(codexHome, "plugins", "cache", "market", "ask-pro", "0.1.0");
    const cachedRunner = path.join(cacheRoot, "scripts", "run-cached-cli.mjs");
    const cachedCli = path.join(cacheRoot, "dist", "bin", "ask-pro-cli.js");
    await fs.mkdir(path.dirname(cachedRunner), { recursive: true });
    await fs.mkdir(path.dirname(cachedCli), { recursive: true });
    await fs.copyFile(path.join(process.cwd(), "scripts", "run-cached-cli.mjs"), cachedRunner);
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"),
    );
    packageJson.version = "1.2.3";
    await fs.writeFile(
      path.join(cacheRoot, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    await fs.copyFile(
      path.join(process.cwd(), "pnpm-lock.yaml"),
      path.join(cacheRoot, "pnpm-lock.yaml"),
    );
    await fs.copyFile(
      path.join(process.cwd(), "pnpm-workspace.yaml"),
      path.join(cacheRoot, "pnpm-workspace.yaml"),
    );
    const writeCli = (revision: number) =>
      fs.writeFile(
        cachedCli,
        [
          'import dotenv from "dotenv";',
          'import { fileURLToPath } from "node:url";',
          `console.log(JSON.stringify({ entry: fileURLToPath(import.meta.url), dependencyResolved: typeof dotenv.config === "function", args: process.argv.slice(2), launcher: process.env.ASK_PRO_SOURCE_CHECKOUT_LAUNCHER, codexHome: process.env.CODEX_HOME, initCwd: process.env.INIT_CWD, cwd: process.cwd(), revision: ${revision} }));`,
          "",
        ].join("\n"),
      );
    await writeCli(1);

    const before = await snapshotFiles(cacheRoot);
    const env = {
      ...process.env,
      CODEX_HOME: path.relative(projectCwd, codexHome),
      INIT_CWD: path.join(root, "stale-init-cwd"),
    };
    const parseRunnerOutput = (stdout: string) =>
      JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as {
        entry: string;
        args: string[];
        launcher: string;
        codexHome: string;
        initCwd: string;
        cwd: string;
        revision: number;
        dependencyResolved: boolean;
      };
    const [firstRun, concurrentRun] = await Promise.all([
      execFileAsync(process.execPath, [cachedRunner, "--", "status"], {
        cwd: projectCwd,
        env,
      }),
      execFileAsync(process.execPath, [cachedRunner, "--", "concurrent"], {
        cwd: projectCwd,
        env,
      }),
    ]);
    const first = parseRunnerOutput(firstRun.stdout);
    const concurrent = parseRunnerOutput(concurrentRun.stdout);
    const runtimeParent = path.dirname(path.dirname(path.dirname(path.dirname(first.entry))));
    const staleStaging = path.join(runtimeParent, ".staging-stale");
    const staleRuntime = path.join(runtimeParent, "0.9.0-stale");
    const activeRuntime = path.join(runtimeParent, "0.9.0-active");
    const abandonedRuntime = path.join(runtimeParent, "0.9.0-abandoned");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.mkdir(staleStaging);
    await fs.mkdir(staleRuntime);
    await fs.mkdir(activeRuntime);
    await fs.mkdir(abandonedRuntime);
    await fs.writeFile(path.join(staleRuntime, ".ask-pro-runtime-ready"), "");
    await fs.writeFile(path.join(activeRuntime, ".ask-pro-runtime-ready"), "");
    await fs.writeFile(
      path.join(abandonedRuntime, ".ask-pro-runtime-building"),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
    );
    await fs.utimes(path.join(abandonedRuntime, ".ask-pro-runtime-building"), old, old);
    await fs.writeFile(
      path.join(activeRuntime, ".active-test.json"),
      JSON.stringify({ pid: process.pid }),
    );
    await Promise.all(
      [staleStaging, staleRuntime, activeRuntime].map((dir) => fs.utimes(dir, old, old)),
    );
    await Promise.all(
      [staleRuntime, activeRuntime].map((dir) =>
        fs.utimes(path.join(dir, ".ask-pro-runtime-ready"), old, old),
      ),
    );
    const second = parseRunnerOutput(
      (
        await execFileAsync(process.execPath, [cachedRunner, "--", "resume"], {
          cwd: projectCwd,
          env,
        })
      ).stdout,
    );

    expect(await snapshotFiles(cacheRoot)).toEqual(before);
    expect(first.entry).toBe(second.entry);
    expect(concurrent.entry).toBe(first.entry);
    expect(first.dependencyResolved).toBe(true);
    expect(concurrent.dependencyResolved).toBe(true);
    expect(first.entry).toContain(path.join("plugin-runtimes", "ask-pro", "1.2.3-"));
    expect(first.entry).not.toContain(path.join("plugins", "cache"));
    expect(first.args).toEqual(["status"]);
    expect(second.args).toEqual(["resume"]);
    expect(first.launcher).toContain(cachedRunner);
    expect(await fs.realpath(first.codexHome)).toBe(await fs.realpath(codexHome));
    expect(await fs.realpath(first.initCwd)).toBe(await fs.realpath(projectCwd));
    expect(await fs.realpath(first.cwd)).toBe(await fs.realpath(projectCwd));
    await expect(fs.stat(staleStaging)).rejects.toThrow();
    await expect(fs.stat(staleRuntime)).rejects.toThrow();
    await expect(fs.stat(abandonedRuntime)).rejects.toThrow();
    await expect(fs.stat(activeRuntime)).resolves.toBeTruthy();

    await writeCli(2);
    const changed = parseRunnerOutput(
      (
        await execFileAsync(process.execPath, [cachedRunner, "--", "status"], {
          cwd: projectCwd,
          env,
        })
      ).stdout,
    );
    expect(changed.revision).toBe(2);
    expect(changed.entry).not.toBe(first.entry);
  }, 60_000);
});
