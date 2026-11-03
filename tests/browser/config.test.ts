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
  isAskProManagedBrowserProfileDir,
  isAskProStatePath,
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

  test("keeps state under the overridable ask-pro state root", () => {
    const customRoot = path.join(os.tmpdir(), "custom-ask-pro-state");
    vi.stubEnv("ASK_PRO_STATE_DIR", customRoot);
    expect(defaultAskProBrowserProfileDir()).toBe(path.join(customRoot, "browser-profile"));
    expect(askProBrowserProfileDirForAgentId("review-t1-59cd6bada6")).toBe(
      path.join(customRoot, "agents", "review-t1-59cd6bada6", "browser-profile"),
    );

    vi.stubEnv("ASK_PRO_STATE_DIR", "");
    expect(defaultAskProBrowserProfileDir()).toBe(
      path.join(os.homedir(), ".agents", "state", "ask-pro", "browser-profile"),
    );
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
    vi.stubEnv("ASK_PRO_STATE_DIR", root);
    const userDataDir = await fs.mkdtemp(path.join(root, "test-language-"));
    const prefs = path.join(userDataDir, "Default", "Preferences");
    await fs.mkdir(path.dirname(prefs), { recursive: true });
    await fs.writeFile(prefs, "{not valid json", "utf8");

    await seedChromeProfileLanguage(userDataDir, "en-US,en");

    await expect(fs.readFile(prefs, "utf8")).resolves.toBe("{not valid json");
  });
});
