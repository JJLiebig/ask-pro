import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  __test__,
  runSubmissionWithRecoveryForTest,
  shouldPreserveBrowserOnErrorForTest,
} from "../../src/browser/index.js";
import { ensureLoggedIn } from "../../src/browser/pageActions.js";
import { BrowserAutomationError } from "../../src/browser/errors.js";

describe("shouldPreserveBrowserOnErrorForTest", () => {
  test("preserves the browser for headful cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("does not preserve the browser for headless cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
  });

  test("preserves the browser for headful login-required recovery errors", () => {
    const error = new BrowserAutomationError("Login required.", {
      stage: "login-required",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("does not preserve the browser for unrelated browser errors", () => {
    const error = new BrowserAutomationError("other browser error", {
      stage: "execute-browser",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
  });
});

test("does not restart the response timeout after a stalled browser observer", async () => {
  vi.useFakeTimers();
  try {
    const runtime = {
      evaluate: vi.fn(({ expression }: { expression: string }) =>
        expression.includes("captureViaObserver")
          ? new Promise(() => {})
          : Promise.resolve({ result: { value: null } }),
      ),
    };
    const page = { navigate: vi.fn() };
    const pending = expect(
      __test__.waitForAssistantResponseWithReload(
        runtime as never,
        page as never,
        1000,
        vi.fn<(message: string) => void>(),
        undefined,
        "https://chatgpt.com/c/795d079e-6c4d-4334-b0ae-4534c70305bd",
      ),
    ).rejects.toThrow("Timed out waiting for assistant response");
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(page.navigate).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("main browser flow waits past provisional ChatGPT conversation routes", () => {
  expect(
    __test__.isConversationUrl("https://chatgpt.com/c/WEB:795d079e-6c4d-4334-b0ae-4534c70305bd"),
  ).toBe(false);
  expect(
    __test__.isConversationUrl("https://chatgpt.com/c/795d079e-6c4d-4334-b0ae-4534c70305bd"),
  ).toBe(true);
});

describe("runSubmissionWithRecoveryForTest", () => {
  test("preserves prompt-too-large fallback after a dead-composer retry", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new BrowserAutomationError("dead composer", { code: "dead-composer" }))
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockResolvedValueOnce({
        baselineTurns: 7,
        baselineAssistantText: "done",
      });
    const reloadPromptComposer = vi.fn().mockResolvedValue(undefined);
    const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
    const logger: (message: string) => void = vi.fn();

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [{ path: "/tmp/fallback.txt", displayPath: "fallback.txt", sizeBytes: 12 }],
        },
        submit,
        reloadPromptComposer,
        prepareFallbackSubmission,
        logger,
      }),
    ).resolves.toEqual({
      baselineTurns: 7,
      baselineAssistantText: "done",
    });

    expect(reloadPromptComposer).toHaveBeenCalledTimes(1);
    expect(prepareFallbackSubmission).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenNthCalledWith(1, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(2, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(3, "fallback prompt", [
      expect.objectContaining({ displayPath: "fallback.txt" }),
    ]);
  });

  test("throws when prompt-too-large happens again after fallback", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large again", { code: "prompt-too-large" }),
      );

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [],
        },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission: vi.fn().mockResolvedValue(undefined),
        logger: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toThrow(/prompt too large again/i);
  });
});

describe("remote Chrome option warnings", () => {
  test("does not mark browser-chrome-path as ignored for attach-running", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: true,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).not.toContain("--browser-chrome-path");
  });

  test("marks browser-chrome-path as ignored for classic remote-chrome", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: false,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).toContain("--browser-chrome-path");
  });
});

describe("recovery command hints", () => {
  test("advertises only current answer recovery commands", () => {
    const runtimeSource = readFileSync("src/browser/index.ts", "utf8");
    const recoveryHintSources = [
      runtimeSource,
      readFileSync("docs/00-human-checklist.md", "utf8"),
      readFileSync("README.md", "utf8"),
    ].join("\n");

    expect(runtimeSource).toContain("--copy to print a copy target");
    expect(runtimeSource).toContain("--harvest to print the raw answer");
    expect(recoveryHintSources).not.toContain("--render");
    expect(recoveryHintSources).not.toContain("copy/render");
  });
});

describe("post-submit input guard scope", () => {
  test("uses the guard for managed local Chrome", () => {
    expect(__test__.shouldEnablePostSubmitInputGuard({})).toBe(true);
  });

  test("skips the guard for remote Chrome", () => {
    expect(
      __test__.shouldEnablePostSubmitInputGuard({
        remoteChrome: { host: "127.0.0.1", port: 9222 },
      }),
    ).toBe(false);
  });

  test("skips the guard for user-managed local tabs", () => {
    expect(__test__.shouldEnablePostSubmitInputGuard({ browserTabRef: "current" })).toBe(false);
  });
});

describe("managed Chrome cleanup ownership", () => {
  test("preserves attached-tab ownership and follows its recovered target", () => {
    expect(__test__.isEligibleManualLoginRecoveryTarget(false, "attached", "unrelated")).toBe(
      false,
    );
    expect(
      __test__.isEligibleManualLoginRecoveryTarget(false, "attached", "replacement", "attached"),
    ).toBe(true);
    expect(__test__.isEligibleManualLoginRecoveryTarget(true, "managed", "unrelated")).toBe(true);
    expect(__test__.isRecoveredTargetOwned(false, "attached", "attached")).toBe(false);
    expect(__test__.isRecoveredTargetOwned(false, "attached", "replacement", "attached")).toBe(
      false,
    );
    expect(__test__.isRecoveredTargetOwned(true, "managed", "replacement", "managed")).toBe(true);
  });

  test("closes a launched Chrome only when no other page remains", () => {
    expect(
      __test__.decideManagedChromeCleanup({
        keepBrowserOpen: false,
        connectionClosedUnexpectedly: false,
        peerRunCount: 0,
        remainingTargets: [],
      }),
    ).toBe("close-browser");
    expect(
      __test__.decideManagedChromeCleanup({
        keepBrowserOpen: false,
        connectionClosedUnexpectedly: false,
        peerRunCount: 1,
        remainingTargets: null,
      }),
    ).toBe("retain-browser");
    expect(
      __test__.decideManagedChromeCleanup({
        keepBrowserOpen: false,
        connectionClosedUnexpectedly: false,
        peerRunCount: 0,
        remainingTargets: [{ targetId: "other-run", type: "page" }],
      }),
    ).toBe("retain-browser");
  });

  test("leaves retained and unknown Chrome state running", () => {
    expect(
      __test__.decideManagedChromeCleanup({
        keepBrowserOpen: true,
        connectionClosedUnexpectedly: false,
        peerRunCount: 0,
        remainingTargets: null,
      }),
    ).toBe("retain-browser");
    expect(
      __test__.decideManagedChromeCleanup({
        keepBrowserOpen: false,
        connectionClosedUnexpectedly: false,
        peerRunCount: null,
        remainingTargets: null,
      }),
    ).toBe("retain-browser");
  });

  test("lets the last reused run close the shared browser", () => {
    expect(
      __test__.decideManagedChromeCleanup({
        keepBrowserOpen: false,
        connectionClosedUnexpectedly: false,
        peerRunCount: 0,
        remainingTargets: [],
      }),
    ).toBe("close-browser");
  });

  test("keeps connection loss distinct from a retained live browser", () => {
    expect(
      __test__.decideManagedChromeCleanup({
        connectionClosedUnexpectedly: true,
        peerRunCount: null,
        remainingTargets: null,
      }),
    ).toBe("connection-lost");
  });

  test("captures startup cleanup targets whenever this process launched Chrome", () => {
    expect(
      __test__.shouldCaptureLaunchTargetsForCleanup({
        reusedChrome: false,
      }),
    ).toBe(true);
    expect(
      __test__.shouldCaptureLaunchTargetsForCleanup({
        reusedChrome: true,
      }),
    ).toBe(false);
  });

  test("retains another page but ignores the completed run and non-page targets", () => {
    expect(
      __test__.shouldRetainLaunchedChromeAfterRun(
        [
          { targetId: "completed", type: "page" },
          { targetId: "worker", type: "service_worker" },
        ],
        "completed",
      ),
    ).toBe(false);
    expect(
      __test__.shouldRetainLaunchedChromeAfterRun(
        [{ targetId: "other-blank", type: "page" }],
        "completed",
      ),
    ).toBe(true);
  });
});

describe("launch tab cleanup", () => {
  test("selects only disposable launch page targets that are not the active run tab", () => {
    expect(
      __test__.selectDisposableLaunchTargetIds(
        [
          { id: "launch-blank", type: "page", url: "about:blank" },
          { id: "launch-newtab", type: "page", url: "chrome://newtab/" },
          { id: "launch-edge-newtab", type: "page", url: "edge://newtab/" },
          { id: "launch-brave-newtab", type: "page", url: "brave://newtab/" },
          { id: "launch-new-tab-page", type: "page", url: "chrome://new-tab-page/" },
          { targetId: "current", type: "page", url: "about:blank" },
          { targetId: "chat", type: "page", url: "https://chatgpt.com/c/abc" },
          { targetId: "worker", type: "service_worker", url: "about:blank" },
        ],
        "current",
      ),
    ).toEqual([
      "launch-blank",
      "launch-newtab",
      "launch-edge-newtab",
      "launch-brave-newtab",
      "launch-new-tab-page",
    ]);
  });

  test("ignores non-disposable and missing target ids", () => {
    expect(
      __test__.selectDisposableLaunchTargetIds([
        { type: "page", url: "about:blank" },
        { targetId: "settings", type: "page", url: "chrome://settings/" },
        { targetId: "chat", type: "page", url: "https://chatgpt.com/" },
      ]),
    ).toEqual([]);
  });

  test("closes only launch-owned targets that are still disposable", () => {
    expect(
      __test__.selectClosableLaunchTargetIds(
        ["launch-blank", "restored", "other-blank"],
        [
          { id: "launch-blank", type: "page", url: "about:blank" },
          { id: "restored", type: "page", url: "https://example.test/restored" },
          { id: "other-blank", type: "page", url: "about:blank" },
          { id: "new-blank", type: "page", url: "about:blank" },
        ],
        "other-blank",
      ),
    ).toEqual(["launch-blank"]);
  });
});

describe("human intervention detection", () => {
  test("detects login/challenge reasons from the page probe", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: "browser_challenge" } }),
    };

    await expect(__test__.detectHumanInterventionReason(Runtime as never)).resolves.toBe(
      "browser_challenge",
    );
  });

  test("ignores empty page probe results", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: null } }),
    };

    await expect(__test__.detectHumanInterventionReason(Runtime as never)).resolves.toBeNull();
  });

  test("ignores a stale challenge title and benign challenge metadata in a populated composer with an attachment", () => {
    class FakeElement {
      constructor(
        readonly textContent = "",
        readonly children: FakeElement[] = [],
      ) {}

      closest() {
        return null;
      }

      getBoundingClientRect() {
        return { left: 20, top: 20, width: 600, height: 100 };
      }

      hasAttribute() {
        return false;
      }

      contains(node: FakeElement | null) {
        return node === this || this.children.includes(node as FakeElement);
      }

      querySelector(selector: string) {
        return selector === 'textarea,[contenteditable="true"]' ? (this.children[0] ?? null) : null;
      }
    }

    const composer = new FakeElement("Normal prompt about MFA recovery.");
    const attachment = new FakeElement("CONTEXT.zip");
    const composerForm = new FakeElement("Normal prompt about MFA recovery. CONTEXT.zip", [
      composer,
      attachment,
    ]);
    const document = {
      title: "Just a moment...",
      querySelector: (selector: string) =>
        selector.includes('[class*="challenge" i]') || selector.includes('[id*="challenge" i]')
          ? attachment
          : null,
      querySelectorAll: (selector: string) => {
        if (selector === 'textarea,[contenteditable="true"]') return [composer];
        if (selector === 'form,[role="dialog"]') return [composerForm];
        return [];
      },
      elementFromPoint: () => composer,
    };

    expect(
      new Function(
        "document",
        "HTMLElement",
        "window",
        "location",
        "getComputedStyle",
        `return ${__test__.buildHumanInterventionProbeExpression()}`,
      )(document, FakeElement, { innerWidth: 1280, innerHeight: 720 }, { pathname: "/" }, () => ({
        display: "block",
        visibility: "visible",
      })),
    ).toBeNull();
  });
});

describe("login recovery reveal hook", () => {
  test("allowlists only exact OpenAI auth hosts or subdomains for passive login recovery", () => {
    expect(__test__.isLoginRecoveryUrl("https://chatgpt.com/auth/login")).toBe(true);
    expect(__test__.isLoginRecoveryUrl("https://auth.openai.com/authorize")).toBe(true);
    expect(__test__.isLoginRecoveryUrl("https://tenant.auth0.com/login")).toBe(true);
    expect(__test__.isLoginRecoveryUrl("https://evilchatgpt.com/auth/login")).toBe(false);
    expect(__test__.isLoginRecoveryUrl("https://notopenai.com/login")).toBe(false);
  });

  test("clicks expired-session login before reporting missing auth", async () => {
    const logger = vi.fn<(message: string) => void>();
    const Runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: {
            value: {
              ok: false,
              status: 200,
              domLoginCta: false,
              onAuthPage: false,
              pageUrl: "https://chatgpt.com/",
            },
          },
        })
        .mockResolvedValueOnce({ result: { value: { clicked: false, reason: "no-root" } } })
        .mockResolvedValueOnce({
          result: { value: { opened: true, method: "click", label: "log in" } },
        }),
    };

    await expect(ensureLoggedIn(Runtime as never, logger, { appliedCookies: 0 })).rejects.toThrow(
      /session not detected/i,
    );

    expect(Runtime.evaluate).toHaveBeenCalledTimes(3);
    expect(Runtime.evaluate.mock.calls[2]?.[0]?.expression).toContain("session has expired");
    expect(Runtime.evaluate.mock.calls[2]?.[0]?.expression).not.toContain("continue with");
    expect(logger).toHaveBeenCalledWith("Opened ChatGPT login surface (click: log in).");
  });

  test("requires affirmative backend authentication from passive login probes", async () => {
    const logger = vi.fn<(message: string) => void>();
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            status: 0,
            domLoginCta: false,
            onAuthPage: false,
            pageUrl: "https://auth.openai.com/authorize?code=secret#state",
          },
        },
      }),
    };

    await expect(
      ensureLoggedIn(Runtime as never, logger, {
        appliedCookies: 0,
        passive: true,
      }),
    ).rejects.toThrow(/session not detected/i);

    expect(Runtime.evaluate).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("url=https://auth.openai.com"));
    expect(logger.mock.calls.flat().join("\n")).not.toContain("secret");
  });

  test("calls auth-needed hook before non-manual login failures escape", async () => {
    const onAuthNeeded = vi.fn();
    const error = new Error("ChatGPT session not detected. Login button detected on page.");

    await expect(
      __test__.waitForLogin({
        runtime: {} as never,
        logger: vi.fn<(message: string) => void>(),
        appliedCookies: 0,
        manualLogin: false,
        onAuthNeeded,
        ensureLoggedInFn: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toThrow(error);

    expect(onAuthNeeded).toHaveBeenCalledTimes(1);
  });

  test("keeps original non-manual login failure if auth-needed hook fails", async () => {
    const logger = vi.fn<(message: string) => void>();
    const error = new Error("ChatGPT session not detected. Login button detected on page.");

    await expect(
      __test__.waitForLogin({
        runtime: {} as never,
        logger,
        appliedCookies: 0,
        manualLogin: false,
        onAuthNeeded: vi.fn().mockRejectedValue(new Error("restore failed")),
        ensureLoggedInFn: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toThrow(error);

    expect(logger).toHaveBeenCalledWith(
      "Failed to reveal browser for auth recovery: restore failed",
    );
  });

  test("reveals before manual-login auth blockers that are not login-button shaped", async () => {
    const onAuthNeeded = vi.fn();
    const error = new Error("Cloudflare challenge detected.");

    await expect(
      __test__.waitForLogin({
        runtime: {} as never,
        logger: vi.fn<(message: string) => void>(),
        appliedCookies: 0,
        manualLogin: true,
        onAuthNeeded,
        ensureLoggedInFn: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toThrow(error);

    expect(onAuthNeeded).toHaveBeenCalledTimes(1);
  });

  test("routes manual login to target recovery if auth-needed reveal fails", async () => {
    const logger = vi.fn<(message: string) => void>();
    const loginMissing = new Error("ChatGPT session not detected. Login button detected on page.");
    const checkLogin = vi.fn().mockRejectedValue(loginMissing);

    await expect(
      __test__.waitForLogin({
        runtime: {} as never,
        logger,
        appliedCookies: 0,
        manualLogin: true,
        onAuthNeeded: vi.fn().mockRejectedValue(new Error("restore failed")),
        ensureLoggedInFn: checkLogin,
      }),
    ).rejects.toMatchObject({
      details: { stage: "login-required" },
    });

    expect(checkLogin).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "Failed to reveal browser for auth recovery: restore failed",
    );
  });

  test("routes missing auth without a login button to target recovery", async () => {
    const logger = vi.fn<(message: string) => void>();
    const authMissing = new Error(
      "ChatGPT session not detected. ChatGPT login appears missing; sign in to ChatGPT in the opened browser, then resume.",
    );
    const checkLogin = vi.fn().mockRejectedValue(authMissing);

    await expect(
      __test__.waitForLogin({
        runtime: {} as never,
        logger,
        appliedCookies: 0,
        manualLogin: true,
        ensureLoggedInFn: checkLogin,
      }),
    ).rejects.toMatchObject({
      details: { stage: "login-required" },
    });

    expect(checkLogin).toHaveBeenCalledTimes(1);
  });
});
