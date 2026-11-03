import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildChromeFlags } from "../../src/browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { CHATGPT_URL } from "../../src/browser/constants.js";
import {
  applyPageLanguageOverrides,
  buildChromeProfileLanguagePatchForTest,
  seedChromeProfileLanguage,
} from "../../src/browser/language.js";
import {
  askProAgentIdForManagedBrowserProfileDir,
  askProBrowserProfileDirForAgentId,
  defaultAskProBrowserProfileDir,
  ensureAskProBrowserProfileDir,
  isAskProManagedBrowserProfileDir,
  isAskProStatePath,
  legacyAskProBrowserProfileDirForAgentId,
  resolveAskProAgentId,
} from "../../src/browser/profilePaths.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolveBrowserConfig", () => {
  test("returns defaults when config missing", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.url).toBe(CHATGPT_URL);
    const isWindows = process.platform === "win32";
    expect(resolved.cookieSync).toBe(!isWindows);
    expect(resolved.headless).toBe(false);
    expect(resolved.manualLogin).toBe(isWindows);
    if (isWindows) expect(resolved.manualLoginProfileDir).toBe(defaultAskProBrowserProfileDir());
    expect(resolved.profileLockTimeoutMs).toBe(300_000);
    expect(resolved.manualLoginWaitMs).toBe(1_200_000);
    expect(resolved.acceptLanguage).toBe("en-US,en");
  });

  test("applies overrides", () => {
    const resolved = resolveBrowserConfig({
      url: "https://example.com",
      timeoutMs: 123,
      inputTimeoutMs: 456,
      cookieSync: false,
      headless: true,
      desiredModel: "Custom",
      chromeProfile: "Profile 1",
      chromePath: "/Applications/Chrome",
      browserTabRef: "current",
      manualLoginWaitMs: 12_000,
      acceptLanguage: "en-GB,en",
      debug: true,
    });
    expect(resolved.url).toBe("https://example.com/");
    expect(resolved.timeoutMs).toBe(123);
    expect(resolved.inputTimeoutMs).toBe(456);
    expect(resolved.cookieSync).toBe(false);
    expect(resolved.headless).toBe(true);
    expect(resolved.desiredModel).toBe("Custom");
    expect(resolved.chromeProfile).toBe("Profile 1");
    expect(resolved.chromePath).toBe("/Applications/Chrome");
    expect(resolved.browserTabRef).toBe("current");
    expect(resolved.manualLoginWaitMs).toBe(12_000);
    expect(resolved.acceptLanguage).toBe("en-GB,en");
    expect(resolved.debug).toBe(true);
  });

  test("uses the agent skill profile for manual login by default", () => {
    const resolved = resolveBrowserConfig({ manualLogin: true });

    expect(resolved.manualLoginProfileDir).toBe(defaultAskProBrowserProfileDir());
  });

  test("keeps mutable profiles under CODEX_HOME with the standard fallback", () => {
    const customHome = path.join(os.tmpdir(), "custom-codex-home");
    vi.stubEnv("CODEX_HOME", customHome);
    expect(defaultAskProBrowserProfileDir()).toBe(
      path.join(customHome, "state", "ask-pro", "browser-profile"),
    );
    expect(askProBrowserProfileDirForAgentId("review-t1-59cd6bada6")).toBe(
      path.join(
        customHome,
        "state",
        "ask-pro",
        "agents",
        "review-t1-59cd6bada6",
        "browser-profile",
      ),
    );

    vi.stubEnv("CODEX_HOME", "");
    expect(defaultAskProBrowserProfileDir()).toBe(
      path.join(os.homedir(), ".codex", "state", "ask-pro", "browser-profile"),
    );
  });

  test("migrates a legacy profile once and fails closed on active, collision, or failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-profile-migration-"));
    tempDirs.push(root);
    const fakeHome = path.join(root, "home");
    const codexHome = path.join(root, "codex");
    const options = { env: { CODEX_HOME: codexHome }, homeDir: fakeHome };
    const target = path.join(codexHome, "state", "ask-pro", "browser-profile");
    const legacy = legacyAskProBrowserProfileDirForAgentId(null, fakeHome);

    expect(await ensureAskProBrowserProfileDir(null, options)).toBe(target);
    expect(await fs.stat(target).catch(() => null)).toBeNull();

    await fs.mkdir(target, { recursive: true });
    expect(await ensureAskProBrowserProfileDir(null, options)).toBe(target);
    await fs.rm(target, { recursive: true });

    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "Local State"), "opaque-profile-data");
    expect(await ensureAskProBrowserProfileDir(null, options)).toBe(target);
    expect(await fs.readFile(path.join(target, "Local State"), "utf8")).toBe("opaque-profile-data");
    expect(await fs.stat(legacy).catch(() => null)).toBeNull();

    const concurrentAgent = "concurrent-16f7b434ba";
    const concurrentLegacy = legacyAskProBrowserProfileDirForAgentId(concurrentAgent, fakeHome);
    await fs.mkdir(concurrentLegacy, { recursive: true });
    const concurrent = await Promise.all([
      ensureAskProBrowserProfileDir(concurrentAgent, options),
      ensureAskProBrowserProfileDir(concurrentAgent, options),
    ]);
    expect(concurrent[0]).toBe(concurrent[1]);

    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(
      path.join(legacy, "ask-pro-automation.lock"),
      JSON.stringify({ pid: process.pid, lockId: "active", createdAt: new Date().toISOString() }),
    );
    await expect(ensureAskProBrowserProfileDir(null, options)).rejects.toThrow(/both current/i);
    await fs.rm(target, { recursive: true });
    await expect(ensureAskProBrowserProfileDir(null, options)).rejects.toThrow(/in use/i);
    expect(await fs.stat(legacy)).toBeTruthy();

    await fs.rm(path.join(legacy, "ask-pro-automation.lock"));
    await fs.writeFile(path.join(legacy, "chrome.pid"), `${process.pid}\n`);
    expect(await ensureAskProBrowserProfileDir(null, options)).toBe(target);
    expect(await fs.stat(legacy).catch(() => null)).toBeNull();

    await fs.mkdir(legacy, { recursive: true });
    await fs.mkdir(target, { recursive: true });
    await expect(ensureAskProBrowserProfileDir(null, options)).rejects.toThrow(
      /refusing to merge/i,
    );
    expect(await fs.stat(legacy)).toBeTruthy();
    expect(await fs.stat(target)).toBeTruthy();

    await fs.writeFile(
      path.join(target, ".ask-pro-profile-migration"),
      JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() - 301_000 }),
    );
    await fs.writeFile(path.join(legacy, "Local State"), "recreated-profile-data");
    await expect(ensureAskProBrowserProfileDir(null, options)).rejects.toThrow(
      /refusing to merge/i,
    );
    expect(await fs.readFile(path.join(legacy, "Local State"), "utf8")).toBe(
      "recreated-profile-data",
    );

    await fs.rm(target, { recursive: true });
    const blockedCodexHome = path.join(root, "blocked-codex-home");
    await fs.writeFile(blockedCodexHome, "not a directory");
    await expect(
      ensureAskProBrowserProfileDir(null, {
        env: { CODEX_HOME: blockedCodexHome },
        homeDir: fakeHome,
      }),
    ).rejects.toThrow();
    expect(await fs.stat(legacy)).toBeTruthy();
  }, 15_000);

  test("copies on sharing-denied rename and retains only the exact cleanup-denied legacy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-profile-retained-"));
    tempDirs.push(root);
    const options = {
      env: { CODEX_HOME: path.join(root, "codex") },
      homeDir: path.join(root, "home"),
    };
    const target = askProBrowserProfileDirForAgentId(null, options.env);
    const legacy = legacyAskProBrowserProfileDirForAgentId(null, options.homeDir);
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "Local State"), "opaque-profile-data");

    const originalRename = fs.rename.bind(fs);
    const originalRm = fs.rm.bind(fs);
    let signalCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanupStarted = resolve;
    });
    let allowCleanup!: () => void;
    const cleanupAllowed = new Promise<void>((resolve) => {
      allowCleanup = resolve;
    });
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.resolve(String(from)) === legacy && path.resolve(String(to)) === target) {
        throw Object.assign(new Error("sharing denied"), { code: "EPERM" });
      }
      return originalRename(from, to);
    });
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (targetPath, rmOptions) => {
      if (path.resolve(String(targetPath)) === legacy && rmOptions?.recursive) {
        expect(
          JSON.parse(await fs.readFile(path.join(legacy, "ask-pro-automation.lock"), "utf8")),
        ).toMatchObject({
          pid: process.pid,
          lockId: expect.any(String),
        });
        signalCleanupStarted();
        await cleanupAllowed;
        throw Object.assign(new Error("sharing denied"), { code: "EPERM" });
      }
      return originalRm(targetPath, rmOptions);
    });

    try {
      const firstMigration = ensureAskProBrowserProfileDir(null, options);
      await cleanupStarted;
      const concurrentMigration = ensureAskProBrowserProfileDir(null, options);
      allowCleanup();
      const migrated = await Promise.all([firstMigration, concurrentMigration]);
      expect(migrated).toEqual([target, target]);
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }

    expect(await fs.readFile(path.join(target, "Local State"), "utf8")).toBe("opaque-profile-data");
    expect(await fs.readFile(path.join(legacy, "Local State"), "utf8")).toBe("opaque-profile-data");
    await expect(fs.stat(path.join(legacy, "ask-pro-automation.lock"))).rejects.toThrow();
    const marker = JSON.parse(
      await fs.readFile(path.join(target, ".ask-pro-profile-migration"), "utf8"),
    );
    expect(marker.legacyIdentity).toMatchObject({
      dev: expect.stringMatching(/^[1-9]\d*$/),
      ino: expect.stringMatching(/^[1-9]\d*$/),
      birthtimeNs: expect.stringMatching(/^[1-9]\d*$/),
    });

    await fs.writeFile(
      path.join(legacy, "ask-pro-automation.lock"),
      JSON.stringify({
        pid: process.pid,
        lockId: "older-runner",
        createdAt: new Date().toISOString(),
      }),
    );
    await expect(ensureAskProBrowserProfileDir(null, options)).rejects.toThrow(/in use/i);
    await fs.rm(path.join(legacy, "ask-pro-automation.lock"));

    await fs.writeFile(path.join(legacy, "diverged"), "preserve");
    expect(await ensureAskProBrowserProfileDir(null, options)).toBe(target);
    await expect(fs.stat(path.join(target, "diverged"))).rejects.toThrow();
    expect(await fs.readFile(path.join(legacy, "diverged"), "utf8")).toBe("preserve");

    await fs.rm(legacy, { recursive: true });
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "recreated"), "preserve");
    await expect(ensureAskProBrowserProfileDir(null, options)).rejects.toThrow(/both current/i);
    expect(await fs.readFile(path.join(legacy, "recreated"), "utf8")).toBe("preserve");
  });

  test("keeps cross-device copy migration when birth-time identity is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-profile-cross-device-"));
    tempDirs.push(root);
    const options = {
      env: { CODEX_HOME: path.join(root, "codex") },
      homeDir: path.join(root, "home"),
    };
    const target = askProBrowserProfileDirForAgentId(null, options.env);
    const legacy = legacyAskProBrowserProfileDirForAgentId(null, options.homeDir);
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "Local State"), "opaque-profile-data");

    const originalRename = fs.rename.bind(fs);
    const originalStat = fs.stat.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.resolve(String(from)) === legacy && path.resolve(String(to)) === target) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      return originalRename(from, to);
    });
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await Reflect.apply(originalStat, fs, args);
      if (
        path.resolve(String(args[0])) === legacy &&
        (args[1] as { bigint?: boolean } | undefined)?.bigint
      ) {
        Object.defineProperty(result, "birthtimeNs", { value: 0n });
      }
      return result as never;
    });

    try {
      expect(await ensureAskProBrowserProfileDir(null, options)).toBe(target);
    } finally {
      renameSpy.mockRestore();
      statSpy.mockRestore();
    }

    expect(await fs.readFile(path.join(target, "Local State"), "utf8")).toBe("opaque-profile-data");
    await expect(fs.stat(legacy)).rejects.toThrow();
    await expect(fs.stat(path.join(target, ".ask-pro-profile-migration"))).rejects.toThrow();
  });

  test("keeps ASK_PRO_AGENT_ID out of shared browser config defaults", () => {
    vi.stubEnv("ASK_PRO_AGENT_ID", "review-t1-windows");
    const resolved = resolveBrowserConfig({ manualLogin: true });

    const agentId = resolveAskProAgentId();
    expect(agentId).toMatch(/^review-t1-windows-[a-f0-9]{10}$/);
    expect(resolved.manualLoginProfileDir).toBe(defaultAskProBrowserProfileDir());
    expect(resolved.manualLoginProfileDir).not.toContain(path.join("agents", agentId!));
  });

  test("keeps colliding agent slugs isolated with a stable hash suffix", () => {
    const first = resolveAskProAgentId({ ASK_PRO_AGENT_ID: "review-t1" });
    const second = resolveAskProAgentId({ ASK_PRO_AGENT_ID: "review.t1" });
    const reserved = resolveAskProAgentId({ ASK_PRO_AGENT_ID: "con" });

    expect(first).toMatch(/^review-t1-[a-f0-9]{10}$/);
    expect(second).toMatch(/^review.t1-[a-f0-9]{10}$/);
    expect(first).not.toBe(second);
    expect(reserved).toMatch(/^con-[a-f0-9]{10}$/);
  });

  test("rejects malformed stored agent ids before deriving a profile path", () => {
    expect(() => askProBrowserProfileDirForAgentId("review-t1")).toThrow(
      /stored ask-pro agent id is invalid/i,
    );
    expect(() => askProBrowserProfileDirForAgentId("../review-t1-59cd6bada6")).toThrow(
      /stored ask-pro agent id is invalid/i,
    );
  });

  test("recognizes only managed browser profile directories", () => {
    const agentProfile = askProBrowserProfileDirForAgentId("review-t1-59cd6bada6");

    expect(isAskProManagedBrowserProfileDir(defaultAskProBrowserProfileDir())).toBe(true);
    expect(isAskProManagedBrowserProfileDir(agentProfile)).toBe(true);
    expect(isAskProManagedBrowserProfileDir(path.join(path.dirname(agentProfile), "other"))).toBe(
      false,
    );
    expect(isAskProManagedBrowserProfileDir(path.join(process.cwd(), "profile"))).toBe(false);
    expect(askProAgentIdForManagedBrowserProfileDir(agentProfile)).toBe("review-t1-59cd6bada6");
    expect(askProAgentIdForManagedBrowserProfileDir(defaultAskProBrowserProfileDir())).toBeNull();
    expect(isAskProStatePath(path.join(path.dirname(agentProfile), "other"))).toBe(true);
    expect(isAskProStatePath(path.join(process.cwd(), "profile"))).toBe(false);
  });

  test("rejects padded explicit agent ids instead of silently aliasing them", () => {
    expect(() => resolveAskProAgentId({ ASK_PRO_AGENT_ID: " review-t1 " })).toThrow(
      /must not start or end with whitespace/i,
    );
    expect(() => resolveAskProAgentId({ ASK_PRO_AGENT_ID: "   " })).toThrow(
      /must not start or end with whitespace/i,
    );
    expect(() => resolveAskProAgentId({ ASK_PRO_AGENT_ID: "" })).toThrow(/must not be empty/i);
    expect(() => resolveAskProAgentId({ ASK_PRO_AGENT_ID: "Review-T1" })).toThrow(
      /lowercase letters/i,
    );
    expect(() => resolveAskProAgentId({ ASK_PRO_AGENT_ID: "review t1" })).toThrow(
      /lowercase letters/i,
    );
  });

  test("allows temporary chat URLs when desiredModel is Pro", () => {
    const resolved = resolveBrowserConfig({
      url: "https://chatgpt.com/?temporary-chat=true",
      desiredModel: "GPT-5.2 Pro",
    });

    expect(resolved.url).toBe("https://chatgpt.com/?temporary-chat=true");
    expect(resolved.desiredModel).toBe("GPT-5.2 Pro");
  });

  test("does not pass automation-controlled Chrome feature flags", () => {
    const flags = buildChromeFlags(false, null, "en-US,en");

    expect(flags).toContain("--disable-features=TranslateUI");
    expect(flags).toContain("--lang=en-US");
    expect(flags).toContain("--accept-lang=en-US,en");
    expect(flags.join(" ")).not.toContain("AutomationControlled");
    expect(flags.join(" ")).not.toContain("disable-blink-features");
  });

  test("applies page language overrides through safe CDP domains", async () => {
    const headers: unknown[] = [];
    const locales: unknown[] = [];
    const client = {
      Network: {
        setExtraHTTPHeaders: async (payload: unknown) => {
          headers.push(payload);
        },
      },
      Emulation: {
        setLocaleOverride: async (payload: unknown) => {
          locales.push(payload);
        },
      },
    };

    await applyPageLanguageOverrides(client as never, "en-GB,en");

    expect(headers).toEqual([{ headers: { "Accept-Language": "en-GB,en" } }]);
    expect(locales).toEqual([{ locale: "en_GB" }]);
  });

  test("skips missing page language override CDP domains", async () => {
    await expect(applyPageLanguageOverrides({} as never, "en-GB,en")).resolves.toBeUndefined();
  });

  test("builds Chrome profile language prefs without preserving German-first state", () => {
    const patch = buildChromeProfileLanguagePatchForTest("en-US,en");

    expect(patch.preferences).toEqual({
      intl: {
        accept_languages: "en-US,en",
        app_locale: "en-US",
        selected_languages: "en-US,en",
      },
      spellcheck: {
        dictionaries: ["en-US", "en"],
      },
    });
    expect(JSON.stringify(patch)).not.toContain("de-DE");
  });

  test("does not overwrite unreadable Chrome preference JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-language-root-"));
    tempDirs.push(root);
    vi.stubEnv("CODEX_HOME", root);
    const stateDir = path.join(root, "state", "ask-pro");
    await fs.mkdir(stateDir, { recursive: true });
    const userDataDir = await fs.mkdtemp(path.join(stateDir, "test-language-"));
    const prefs = path.join(userDataDir, "Default", "Preferences");
    await fs.mkdir(path.dirname(prefs), { recursive: true });
    await fs.writeFile(prefs, "{not valid json", "utf8");

    await seedChromeProfileLanguage(userDataDir, "en-US,en");

    await expect(fs.readFile(prefs, "utf8")).resolves.toBe("{not valid json");
  });
});
