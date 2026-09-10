import { AssistantStoppedError } from "../../src/browser/errors.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createAskProSession,
  readAskProAnswer,
  readAskProStatus,
  updateAskProStatus,
  writeAskProBrowserMetadata,
} from "../../src/ask-pro/session.js";

const managedProfileState = vi.hoisted(() => ({ root: "", legacyRoot: "" }));
const resumeBrowserSessionMock = vi.fn(async () => ({
  answerText: "reattached answer",
  answerMarkdown: "# Reattached\n",
  chromeMode: "reused_devtools",
}));
const runBrowserModeMock = vi.fn(async () => ({
  answerText: "agent answer",
  answerMarkdown: "# Agent\n",
  browserTransport: "launched",
}));
const closeTabMock = vi.fn(async () => undefined);
const harvestLatestAssistantZipMock = vi.fn(async () => ({
  schemaVersion: 1 as const,
  responseZip: {
    status: "unavailable" as const,
    actualFileName: null,
    downloadPath: null,
    extractPath: null,
    requiredFilesPresent: false,
    notes: ["No zip."],
  },
}));

vi.mock("../../src/browser/reattach.js", () => ({
  resumeBrowserSession: resumeBrowserSessionMock,
}));
vi.mock("../../src/browserMode.js", () => ({
  runBrowserMode: runBrowserModeMock,
}));
vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  closeTab: closeTabMock,
}));
vi.mock("../../src/browser/profilePaths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/profilePaths.js")>();
  const pathModule = await import("node:path");
  const resolvedAgentIdPattern = /^[a-z0-9._-]+-[a-f0-9]{10}$/;
  const normalizeProfilePath = (profileDir: string) => {
    const resolved = pathModule.resolve(profileDir);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const defaultProfile = () => pathModule.join(managedProfileState.root, "browser-profile");
  const legacyDefaultProfile = () =>
    pathModule.join(managedProfileState.legacyRoot, "browser-profile");
  const agentProfile = (agentId: string) =>
    pathModule.join(managedProfileState.root, "agents", agentId, "browser-profile");
  const agentIdForProfileUnder = (profileDir: string, root: string) => {
    const relative = pathModule.relative(
      normalizeProfilePath(pathModule.join(root, "agents")),
      normalizeProfilePath(profileDir),
    );
    if (relative.startsWith("..") || pathModule.isAbsolute(relative)) return null;
    const parts = relative.split(pathModule.sep);
    if (parts.length !== 2 || parts[1] !== "browser-profile") return null;
    const agentId = parts[0]!;
    return resolvedAgentIdPattern.test(agentId) ? agentId : null;
  };
  const agentIdForProfile = (profileDir: string) =>
    agentIdForProfileUnder(profileDir, managedProfileState.root);
  const agentIdForLegacyProfile = (profileDir: string) =>
    agentIdForProfileUnder(profileDir, managedProfileState.legacyRoot);
  return {
    ...actual,
    defaultAskProBrowserProfileDir: () => defaultProfile(),
    askProBrowserProfileDirForAgentId: (agentId: string | null | undefined) => {
      if (!agentId) return defaultProfile();
      if (!resolvedAgentIdPattern.test(agentId)) {
        throw new Error("Stored ask-pro agent id is invalid.");
      }
      return agentProfile(agentId);
    },
    ensureAskProBrowserProfileDir: async (agentId: string | null | undefined) =>
      agentId ? agentProfile(agentId) : defaultProfile(),
    isAskProManagedBrowserProfileDir: (profileDir: string) =>
      normalizeProfilePath(profileDir) === normalizeProfilePath(defaultProfile()) ||
      agentIdForProfile(profileDir) !== null,
    askProAgentIdForManagedBrowserProfileDir: agentIdForProfile,
    isLegacyAskProManagedBrowserProfileDir: (profileDir: string) =>
      normalizeProfilePath(profileDir) === normalizeProfilePath(legacyDefaultProfile()) ||
      agentIdForLegacyProfile(profileDir) !== null,
    askProAgentIdForLegacyBrowserProfileDir: agentIdForLegacyProfile,
  };
});
vi.mock("../../src/ask-pro/responseZip.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ask-pro/responseZip.js")>();
  return {
    ...actual,
    harvestLatestAssistantZip: harvestLatestAssistantZipMock,
  };
});

const { AskProNeedsAuthError, resumeAskProBrowserSession, runAskProBrowserSession } =
  await import("../../src/ask-pro/browserRunner.js");

const tempDirs: string[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  managedProfileState.root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-managed-root-"));
  managedProfileState.legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-legacy-root-"));
  tempDirs.push(managedProfileState.root, managedProfileState.legacyRoot);
});

function testSharedProfileDir(): string {
  return path.join(managedProfileState.root, "browser-profile");
}

function testAgentProfileDir(agentId: string): string {
  return path.join(managedProfileState.root, "agents", agentId, "browser-profile");
}

function testLegacyAgentProfileDir(agentId: string): string {
  return path.join(managedProfileState.legacyRoot, "agents", agentId, "browser-profile");
}

afterEach(async () => {
  resumeBrowserSessionMock.mockClear();
  runBrowserModeMock.mockClear();
  closeTabMock.mockClear();
  harvestLatestAssistantZipMock.mockClear();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ask-pro browser runner", () => {
  test("rejects a live same-session controller and releases the lease in finally", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-controller-live-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Keep one controller per session.",
      filePatterns: [],
      dryRun: false,
    });
    const entered = deferred();
    const finish = deferred();
    runBrowserModeMock.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return {
        answerText: "agent answer",
        answerMarkdown: "# Agent\n",
        browserTransport: "launched",
      };
    });

    const first = runAskProBrowserSession({ cwd, sessionId: session.id });
    await entered.promise;
    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      `ask-pro session controller is already running (pid ${process.pid})`,
    );
    finish.resolve();
    await first;

    runBrowserModeMock.mockRejectedValueOnce(new Error("browser failed"));
    await expect(runAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      "browser failed",
    );
    await runAskProBrowserSession({ cwd, sessionId: session.id });
    await expect(fs.stat(path.join(session.dir, ".controller.lease"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("recovers a stale session-controller owner", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-controller-stale-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Recover the stale controller.",
      filePatterns: [],
      dryRun: false,
    });
    const leaseDir = path.join(session.dir, ".controller.lease");
    await fs.mkdir(leaseDir);
    await fs.writeFile(path.join(leaseDir, "2147483647-stale.owner"), "");
    const entered = deferred();
    const finish = deferred();
    runBrowserModeMock.mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
      return {
        answerText: "agent answer",
        answerMarkdown: "# Agent\n",
        browserTransport: "launched",
      };
    });

    const runs = [
      runAskProBrowserSession({ cwd, sessionId: session.id }),
      runAskProBrowserSession({ cwd, sessionId: session.id }),
    ];
    const rejected = deferred();
    for (const run of runs) void run.catch(() => rejected.resolve());
    const outcomesPromise = Promise.allSettled(runs);
    await entered.promise;
    await rejected.promise;
    finish.resolve();
    const outcomes = await outcomesPromise;

    expect(runBrowserModeMock).toHaveBeenCalledTimes(1);
    expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  test("allows browser controllers for different sessions to run concurrently", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-controller-concurrent-"));
    tempDirs.push(cwd);
    const sessions = await Promise.all(
      ["first", "second"].map((name) =>
        createAskProSession({
          cwd,
          question: `${name} concurrent session.`,
          filePatterns: [],
          dryRun: false,
        }),
      ),
    );
    const bothEntered = deferred();
    const finish = deferred();
    let entered = 0;
    runBrowserModeMock.mockImplementation(async () => {
      if (++entered === 2) bothEntered.resolve();
      await finish.promise;
      return {
        answerText: "agent answer",
        answerMarkdown: "# Agent\n",
        browserTransport: "launched",
      };
    });

    const runs = sessions.map((session) => runAskProBrowserSession({ cwd, sessionId: session.id }));
    await bothEntered.promise;
    finish.resolve();
    await Promise.all(runs);

    expect(runBrowserModeMock).toHaveBeenCalledTimes(2);
  });

  test("runs ask-pro sessions with the explicit agent profile", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-agent-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review with the agent profile.",
      filePatterns: [],
      dryRun: false,
    });

    vi.stubEnv("ASK_PRO_AGENT_ID", "review-t1");
    await runAskProBrowserSession({ cwd, sessionId: session.id });

    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/?temporary-chat=true",
        attachRunning: false,
        desiredModel: "Latest",
        thinkingTime: "pro",
        manualLoginProfileDir: expect.stringMatching(
          /agents[\\/]+review-t1-[a-f0-9]{10}[\\/]+browser-profile$/,
        ),
      },
    });
  });

  test("runs default ask-pro sessions on the shared managed profile", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-default-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review with the default profile.",
      filePatterns: [],
      dryRun: false,
    });

    await runAskProBrowserSession({ cwd, sessionId: session.id });

    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/?temporary-chat=true",
        attachRunning: false,
        desiredModel: "Latest",
        thinkingTime: "pro",
        manualLoginProfileDir: testSharedProfileDir(),
      },
    });
  });

  test("starts ordinary managed runs minimized", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-minimized-"));
    tempDirs.push(cwd);
    const browserProfile = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-profile-minimized-"));
    tempDirs.push(browserProfile);
    const session = await createAskProSession({
      cwd,
      question: "Review minimized launch.",
      filePatterns: [],
      dryRun: false,
    });

    await runAskProBrowserSession({
      cwd,
      sessionId: session.id,
      browserProfileDir: browserProfile,
    });

    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        manualLoginProfileDir: browserProfile,
        startMinimized: true,
      },
    });
  });

  test("marks preamble-only answers incomplete when no response zip exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-incomplete-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Give the actual answer.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockResolvedValueOnce({
      answerText: "I'll inspect the bundle and create the files.",
      answerMarkdown: "I'll inspect the bundle and create the files.",
      browserTransport: "launched",
    });

    await runAskProBrowserSession({ cwd, sessionId: session.id });

    const { status } = await readAskProStatus({ cwd, sessionId: session.id });
    expect(status).toMatchObject({
      status: "INCOMPLETE_ANSWER",
      reason: "preamble_without_artifacts",
    });
  });

  test("asks browser runner to stay open for incomplete-answer debugging", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-incomplete-keep-open-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Give the actual answer.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockResolvedValueOnce({
      answerText: "I'll inspect the bundle and create the files.",
      answerMarkdown: "I'll inspect the bundle and create the files.",
      browserTransport: "launched",
    });

    await runAskProBrowserSession({ cwd, sessionId: session.id });

    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    const options = firstCall?.[0] as
      | {
          afterAnswerCb?: (context: {
            Runtime: { evaluate: () => Promise<{ result: { value: unknown } }> };
            Page: undefined;
            Input: undefined;
            answer: { text: string; markdown: string };
          }) => Promise<{ keepBrowserOpen?: boolean } | undefined>;
        }
      | undefined;
    const result = await options?.afterAnswerCb?.({
      Runtime: {
        evaluate: async () => ({ result: { value: { status: "unavailable" } } }),
      },
      Page: undefined,
      Input: undefined,
      answer: {
        text: "I'll inspect the bundle and create the files.",
        markdown: "I'll inspect the bundle and create the files.",
      },
    });

    expect(result).toEqual({ keepBrowserOpen: true });
  });

  test("persists a fresh answer before browser cleanup fails", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-cleanup-fail-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Give a durable answer.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockImplementationOnce(async (...args: unknown[]) => {
      const afterAnswerCb = (
        args[0] as {
          afterAnswerCb: (context: {
            Runtime: unknown;
            Page: unknown;
            Input: unknown;
            answer: { text: string; markdown: string };
          }) => Promise<unknown>;
        }
      ).afterAnswerCb;
      await afterAnswerCb({
        Runtime: undefined,
        Page: undefined,
        Input: undefined,
        answer: { text: "Durable answer", markdown: "# Durable answer\n" },
      });
      throw new Error("cleanup failed");
    });

    await expect(runAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      "cleanup failed",
    );

    expect((await readAskProAnswer({ cwd, sessionId: session.id })).answer).toBe(
      "# Durable answer\n",
    );
    expect((await readAskProStatus({ cwd, sessionId: session.id })).status.status).toBe(
      "COMPLETED",
    );
  });

  test("does not harvest response zip for inline-default sessions", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-inline-no-zip-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Give the actual answer.",
      filePatterns: [],
      dryRun: false,
    });

    await runAskProBrowserSession({ cwd, sessionId: session.id });
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    const options = firstCall?.[0] as
      | {
          afterAnswerCb?: (context: {
            Runtime: unknown;
            Page: unknown;
            Input: unknown;
            answer: { text: string; markdown: string };
          }) => Promise<unknown>;
        }
      | undefined;
    await options?.afterAnswerCb?.({
      Runtime: undefined,
      Page: undefined,
      Input: undefined,
      answer: { text: "# Agent\n", markdown: "# Agent\n" },
    });

    expect(harvestLatestAssistantZipMock).not.toHaveBeenCalled();
    const manifest = JSON.parse(
      await fs.readFile(path.join(session.dir, "PRO_OUTPUT_MANIFEST.json"), "utf8"),
    );
    expect(manifest.responseZip.status).toBe("not_requested");
  });

  test("harvests response zip only when artifacts are requested", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-artifacts-zip-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Return an implementation package.",
      filePatterns: [],
      dryRun: false,
      artifacts: true,
    });

    await runAskProBrowserSession({ cwd, sessionId: session.id });
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    const options = firstCall?.[0] as
      | {
          afterAnswerCb?: (context: {
            Runtime: unknown;
            Page: unknown;
            Input: unknown;
            answer: { text: string; markdown: string };
          }) => Promise<unknown>;
        }
      | undefined;
    await options?.afterAnswerCb?.({
      Runtime: undefined,
      Page: undefined,
      Input: undefined,
      answer: { text: "# Agent\n", markdown: "# Agent\n" },
    });

    expect(harvestLatestAssistantZipMock).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(
      await fs.readFile(path.join(session.dir, "PRO_OUTPUT_MANIFEST.json"), "utf8"),
    );
    expect(manifest.responseZip.status).toBe("unavailable");
  });

  test("marks broader deferred-work preambles incomplete when no response zip exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-incomplete-broad-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Give the actual answer.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockResolvedValueOnce({
      answerText: "Sure, I'll take a look and get back to you with the full analysis.",
      answerMarkdown: "Sure, I'll take a look and get back to you with the full analysis.",
      browserTransport: "launched",
    });

    await runAskProBrowserSession({ cwd, sessionId: session.id });

    const { status } = await readAskProStatus({ cwd, sessionId: session.id });
    expect(status).toMatchObject({
      status: "INCOMPLETE_ANSWER",
      reason: "preamble_without_artifacts",
    });
  });

  test("keeps short substantive inline answers completed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-short-answer-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Give the actual answer.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockResolvedValueOnce({
      answerText: "I'll review auth first; recommendation: use the shared profile and resume.",
      answerMarkdown: "I'll review auth first; recommendation: use the shared profile and resume.",
      browserTransport: "launched",
    });

    await runAskProBrowserSession({ cwd, sessionId: session.id });

    const { status } = await readAskProStatus({ cwd, sessionId: session.id });
    expect(status.status).toBe("COMPLETED");
  });

  test("auth failure after runtime hint preserves runtime metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-auth-runtime-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Auth after runtime.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[0] as { runtimeHintCb?: (runtime: unknown) => void };
      await options.runtimeHintCb?.({
        chromePort: 9230,
        chromeHost: "127.0.0.1",
        chromeTargetId: "auth-runtime-target",
      });
      throw new Error("session expired during recheck");
    });

    await expect(runAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /authentication is required/i,
    );

    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { status?: string; runtime?: { chromePort?: number }; reason?: string };
    expect(metadata).toMatchObject({
      status: "needs_user_auth",
      runtime: { chromePort: 9230 },
      reason: "auth_required",
    });
  });

  test("runs ask-pro sessions in temporary chat when requested", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-temporary-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review in temporary chat.",
      filePatterns: [],
      dryRun: false,
    });

    await runAskProBrowserSession({ cwd, sessionId: session.id, temporary: true });

    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/?temporary-chat=true",
      },
    });
    const shouldPreserveWindowStateOnError = (
      firstCall?.[0] as { shouldPreserveWindowStateOnError?: (error: Error) => boolean } | undefined
    )?.shouldPreserveWindowStateOnError;
    expect(
      shouldPreserveWindowStateOnError?.(
        new Error('Unable to find model option matching "Latest" in the model switcher.'),
      ),
    ).toBe(false);
    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { url?: string };
    expect(metadata.url).toBe("https://chatgpt.com/?temporary-chat=true");
  });

  test("falls back to normal ChatGPT when default Temporary Chat hides Pro", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-temporary-fallback-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review with temporary fallback.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock
      .mockRejectedValueOnce(
        new Error('Unable to find model option matching "Latest" in the model switcher.'),
      )
      .mockResolvedValueOnce({
        answerText: "agent answer",
        answerMarkdown: "# Agent\n",
        browserTransport: "launched",
      });

    await runAskProBrowserSession({ cwd, sessionId: session.id });

    expect(runBrowserModeMock).toHaveBeenCalledTimes(2);
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    const secondCall = runBrowserModeMock.mock.calls[1] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/?temporary-chat=true",
      },
    });
    const shouldPreserveWindowStateOnError = (
      firstCall?.[0] as { shouldPreserveWindowStateOnError?: (error: Error) => boolean } | undefined
    )?.shouldPreserveWindowStateOnError;
    expect(
      shouldPreserveWindowStateOnError?.(
        new Error('Unable to find model option matching "Latest" in the model switcher.'),
      ),
    ).toBe(true);
    expect(shouldPreserveWindowStateOnError?.(new Error("attachment upload failed"))).toBe(false);
    expect(secondCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/",
      },
    });
    const log = await fs.readFile(path.join(session.dir, "log.txt"), "utf8");
    expect(log).toContain("Temporary Chat did not expose the Pro model");
    const { status } = await readAskProStatus({ cwd, sessionId: session.id });
    expect(status).toMatchObject({
      status: "COMPLETED",
      temporary: false,
      resumeCommand: expect.stringContaining("--no-temporary --resume"),
    });
    expect(status).not.toHaveProperty("reason");
    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { temporary?: boolean; url?: string };
    expect(metadata).toMatchObject({
      temporary: false,
      url: "https://chatgpt.com/",
    });
  });

  test("falls back to normal ChatGPT when default Temporary Chat lacks Pro intelligence", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-intelligence-fallback-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review with Pro intelligence fallback.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock
      .mockRejectedValueOnce(new Error("Unable to select Pro intelligence: option not found."))
      .mockResolvedValueOnce({
        answerText: "agent answer",
        answerMarkdown: "# Agent\n",
        browserTransport: "launched",
      });

    await runAskProBrowserSession({ cwd, sessionId: session.id });

    expect(runBrowserModeMock).toHaveBeenCalledTimes(2);
    const secondCall = runBrowserModeMock.mock.calls[1] as unknown[] | undefined;
    expect(secondCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/",
        desiredModel: "Latest",
        thinkingTime: "pro",
      },
    });
  });

  test("closes the failed temporary chat tab before falling back", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-temporary-close-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review with temporary cleanup.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        const options = args[0] as { runtimeHintCb?: (runtime: unknown) => void };
        await options.runtimeHintCb?.({
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "temp-target",
        });
        throw new Error('Unable to find model option matching "Latest" in the model switcher.');
      })
      .mockResolvedValueOnce({
        answerText: "agent answer",
        answerMarkdown: "# Agent\n",
        browserTransport: "launched",
      });

    await runAskProBrowserSession({ cwd, sessionId: session.id });

    expect(closeTabMock).toHaveBeenCalledWith(
      9222,
      "temp-target",
      expect.any(Function),
      "127.0.0.1",
    );
    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { temporary?: boolean; url?: string; runtime?: { chromeTargetId?: string } };
    expect(metadata.temporary).toBe(false);
    expect(metadata.url).toBe("https://chatgpt.com/");
    expect(metadata.runtime?.chromeTargetId).not.toBe("temp-target");
  });

  test("falls back to normal ChatGPT when default Temporary Chat lacks the model picker", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-temporary-picker-fallback-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review with temporary picker fallback.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock
      .mockRejectedValueOnce(new Error("Unable to locate the ChatGPT model selector button."))
      .mockResolvedValueOnce({
        answerText: "agent answer",
        answerMarkdown: "# Agent\n",
        browserTransport: "launched",
      });

    await runAskProBrowserSession({ cwd, sessionId: session.id });

    expect(runBrowserModeMock).toHaveBeenCalledTimes(2);
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    const secondCall = runBrowserModeMock.mock.calls[1] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/?temporary-chat=true",
      },
    });
    expect(secondCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/",
      },
    });
  });

  test("does not fall back when the normal ChatGPT model picker is missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-picker-missing-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review with generic picker failure.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockRejectedValueOnce(
      new Error("Unable to locate the ChatGPT model selector button."),
    );

    await expect(
      runAskProBrowserSession({ cwd, sessionId: session.id, temporary: false }),
    ).rejects.toThrow(/model selector button/);

    expect(runBrowserModeMock).toHaveBeenCalledTimes(1);
  });

  test("does not fall back when explicit temporary chat hides Pro", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-temporary-strict-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review with strict temporary chat.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockRejectedValueOnce(
      new Error('Unable to find model option matching "Latest" in the model switcher.'),
    );

    await expect(
      runAskProBrowserSession({ cwd, sessionId: session.id, temporary: true }),
    ).rejects.toThrow(/Latest/);

    expect(runBrowserModeMock).toHaveBeenCalledTimes(1);
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/?temporary-chat=true",
      },
    });
  });

  test("finalizes implicit temporary metadata after early browser failure", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-temporary-metadata-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Fail before runtime metadata.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockRejectedValueOnce(new Error("early browser launch failure"));

    await expect(runAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /early browser launch failure/,
    );

    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { url?: string; status?: string; chromeMode?: string; acceptLanguage?: string };
    expect(metadata).toMatchObject({
      status: "failed",
      url: "https://chatgpt.com/?temporary-chat=true",
      acceptLanguage: "en-US,en",
    });
    expect(metadata.chromeMode).toBeUndefined();
  });

  test.each([
    {
      error: new Error("assistant response timed out"),
      status: "wait_timed_out",
      reason: "assistant_timeout",
    },
    {
      error: new AssistantStoppedError(3),
      status: "incomplete_answer",
      reason: "stopped_without_answer",
    },
  ])("preserves launched Chrome for recoverable failures: $reason", async (failure) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-timeout-preflight-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Timeout after launch.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[0] as { runtimeHintCb?: (runtime: unknown) => void };
      await options.runtimeHintCb?.({
        chromePort: 9227,
        chromeHost: "127.0.0.1",
        chromeTargetId: "timeout-target",
      });
      throw failure.error;
    });

    await expect(runAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      failure.error,
    );

    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { status?: string; chromeMode?: string; reason?: string };
    const { status } = await readAskProStatus({ cwd, sessionId: session.id });
    expect(status).toMatchObject({ status: failure.status.toUpperCase(), reason: failure.reason });
    expect(metadata).toMatchObject({
      status: failure.status,
      chromeMode: "launched",
      reason: failure.reason,
    });
  });

  test("preserves launched Chrome mode for post-launch failures", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-post-launch-fail-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Fail after launch.",
      filePatterns: [],
      dryRun: false,
    });
    runBrowserModeMock.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[0] as { runtimeHintCb?: (runtime: unknown) => void };
      await options.runtimeHintCb?.({
        chromePort: 9229,
        chromeHost: "127.0.0.1",
        chromeTargetId: "failed-target",
      });
      throw new Error("model picker broke");
    });

    await expect(runAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /model picker broke/,
    );

    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { status?: string; chromeMode?: string; reason?: string };
    expect(metadata).toMatchObject({
      status: "failed",
      chromeMode: "launched",
      reason: "model picker broke",
    });
  });

  test("auth relaunch defaults missing stored URLs to temporary chat", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-default-temp-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume default temporary chat after early auth.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "needs_user_auth",
        profileDir: testSharedProfileDir(),
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "NEEDS_USER_AUTH" });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    expect(runBrowserModeMock).toHaveBeenCalledTimes(1);
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/?temporary-chat=true",
      },
    });
  });

  test("auth relaunch preserves default temporary chat fallback semantics", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-temp-fallback-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume default temporary chat with fallback.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "needs_user_auth",
        profileDir: testSharedProfileDir(),
        url: "https://chatgpt.com/?temporary-chat=true",
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "NEEDS_USER_AUTH" });
    runBrowserModeMock
      .mockRejectedValueOnce(
        new Error(
          'Unable to find model option matching "Latest" in the model switcher. Temporary Chat mode is active; verify the model picker exposes Pro in the current account/UI.',
        ),
      )
      .mockResolvedValueOnce({
        answerText: "agent answer",
        answerMarkdown: "# Agent\n",
        browserTransport: "launched",
      });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    expect(runBrowserModeMock).toHaveBeenCalledTimes(2);
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    const secondCall = runBrowserModeMock.mock.calls[1] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/?temporary-chat=true",
      },
    });
    expect(secondCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/",
        startMinimized: false,
      },
    });
  });

  test("auth relaunch preserves explicit temporary strictness from metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-strict-temp-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume strict temporary chat.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "needs_user_auth",
        temporary: true,
        profileDir: testSharedProfileDir(),
        url: "https://chatgpt.com/?temporary-chat=true",
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "NEEDS_USER_AUTH" });
    runBrowserModeMock.mockRejectedValueOnce(
      new Error(
        'Unable to find model option matching "Latest" in the model switcher. Temporary Chat mode is active; verify the model picker exposes Pro in the current account/UI.',
      ),
    );

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /temporary chat mode is active/i,
    );

    expect(runBrowserModeMock).toHaveBeenCalledTimes(1);
  });

  test("fresh retry honors no-temporary over a stored temporary URL", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-run-no-temporary-retry-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Retry outside temporary chat.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "failed",
        profileDir: testSharedProfileDir(),
        url: "https://chatgpt.com/?temporary-chat=true",
      },
    });

    await runAskProBrowserSession({ cwd, sessionId: session.id, temporary: false });

    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/",
      },
    });
  });

  test("reattaches submitted sessions without resubmitting", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-"));
    tempDirs.push(cwd);
    const profileDir = testSharedProfileDir();
    const session = await createAskProSession({
      cwd,
      question: "Review the saved browser session.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir,
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    expect(resumeBrowserSessionMock).toHaveBeenCalledTimes(1);
    const firstCall = resumeBrowserSessionMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({ chromePort: 9222 });
    expect(firstCall?.[1]).toMatchObject({
      attachRunning: true,
      manualLoginProfileDir: profileDir,
    });
    const answer = await readAskProAnswer({ cwd, sessionId: session.id });
    expect(answer.answer).toBe("# Reattached\n");
    const { status } = await readAskProStatus({ cwd, sessionId: session.id });
    expect(status.status).toBe("COMPLETED");
    const manifest = JSON.parse(
      await fs.readFile(path.join(session.dir, "PRO_OUTPUT_MANIFEST.json"), "utf8"),
    );
    expect(manifest.responseZip.status).toBe("not_requested");
  });

  test("reattach rejects non-managed profile metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-unmanaged-"));
    tempDirs.push(cwd);
    const unmanagedProfileDir = path.join(cwd, "profile");
    const session = await createAskProSession({
      cwd,
      question: "Reject the unmanaged browser profile.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: unmanagedProfileDir,
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-unmanaged",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /stored ask-pro profile path is invalid/i,
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("reattach relaunch stays visible", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-visible-"));
    tempDirs.push(cwd);
    const profileDir = testSharedProfileDir();
    const session = await createAskProSession({
      cwd,
      question: "Review the saved browser session.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir,
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    const firstCall = resumeBrowserSessionMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[1]).toMatchObject({
      manualLoginProfileDir: profileDir,
      startMinimized: false,
    });
  });

  test("reattach harvests response zip for artifact sessions", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-artifacts-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the saved artifact browser session.",
      filePatterns: [],
      dryRun: false,
      artifacts: true,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });
    resumeBrowserSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
      const deps = args[3] as
        | {
            afterAnswerCb?: (context: {
              Runtime: unknown;
              Page: unknown;
              Input: unknown;
              answer: { text: string; markdown: string };
            }) => Promise<unknown>;
          }
        | undefined;
      await deps?.afterAnswerCb?.({
        Runtime: undefined,
        Page: undefined,
        Input: undefined,
        answer: { text: "# Reattached\n", markdown: "# Reattached\n" },
      });
      return {
        answerText: "reattached answer",
        answerMarkdown: "# Reattached\n",
        chromeMode: "reused_devtools",
      };
    });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    expect(harvestLatestAssistantZipMock).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(
      await fs.readFile(path.join(session.dir, "PRO_OUTPUT_MANIFEST.json"), "utf8"),
    );
    expect(manifest.responseZip.status).toBe("unavailable");
  });

  test("persists a resumed answer before browser cleanup fails", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-cleanup-fail-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume a durable answer.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: testSharedProfileDir(),
        runtime: { chromePort: 9222, chromeHost: "127.0.0.1" },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });
    resumeBrowserSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
      const afterAnswerCb = (
        args[3] as {
          afterAnswerCb: (context: {
            Runtime: unknown;
            Page: unknown;
            Input: unknown;
            answer: { text: string; markdown: string };
          }) => Promise<unknown>;
        }
      ).afterAnswerCb;
      await afterAnswerCb({
        Runtime: undefined,
        Page: undefined,
        Input: undefined,
        answer: { text: "Resumed answer", markdown: "# Resumed answer\n" },
      });
      throw new Error("cleanup failed");
    });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      "cleanup failed",
    );

    expect((await readAskProAnswer({ cwd, sessionId: session.id })).answer).toBe(
      "# Resumed answer\n",
    );
    expect((await readAskProStatus({ cwd, sessionId: session.id })).status.status).toBe(
      "COMPLETED",
    );
  });

  test("reattach keeps markdown answer when artifact post-processing fails", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-artifact-error-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the saved artifact browser session.",
      filePatterns: [],
      dryRun: false,
      artifacts: true,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });
    harvestLatestAssistantZipMock.mockRejectedValueOnce(new Error("download failed"));
    resumeBrowserSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
      const deps = args[3] as
        | {
            afterAnswerCb?: (context: {
              Runtime: unknown;
              Page: unknown;
              Input: unknown;
              answer: { text: string; markdown: string };
            }) => Promise<unknown>;
          }
        | undefined;
      await deps?.afterAnswerCb?.({
        Runtime: undefined,
        Page: undefined,
        Input: undefined,
        answer: { text: "# Reattached\n", markdown: "# Reattached\n" },
      });
      return {
        answerText: "reattached answer",
        answerMarkdown: "# Reattached\n",
        chromeMode: "reused_devtools",
      };
    });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    expect(resumeBrowserSessionMock).toHaveBeenCalledTimes(1);
    const { status } = await readAskProStatus({ cwd, sessionId: session.id });
    expect(status.status).toBe("COMPLETED");
    const answer = await readAskProAnswer({ cwd, sessionId: session.id });
    expect(answer.answer).toBe("# Reattached\n");
    const manifest = JSON.parse(
      await fs.readFile(path.join(session.dir, "PRO_OUTPUT_MANIFEST.json"), "utf8"),
    );
    expect(manifest.responseZip.status).toBe("error");
  });

  test("reattach selects Latest Pro intelligence", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-pro-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the saved browser session with Pro intelligence.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9223,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-thinking",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    const firstCall = resumeBrowserSessionMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[1]).toMatchObject({
      desiredModel: "Latest",
      thinkingTime: "pro",
    });
    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { chromeMode?: string; acceptLanguage?: string };
    expect(metadata.chromeMode).toBe("reused_devtools");
    expect(metadata.acceptLanguage).toBe("en-US,en");
  });

  test("reattach auth failure refreshes browser preflight metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-auth-preflight-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume after auth expiry.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        chromeMode: "launched",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9225,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-auth-expired",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });
    resumeBrowserSessionMock.mockRejectedValueOnce(new Error("login required"));

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toBeInstanceOf(
      AskProNeedsAuthError,
    );

    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { status?: string; chromeMode?: string; acceptLanguage?: string; reason?: string };
    expect(metadata).toMatchObject({
      status: "needs_user_auth",
      chromeMode: "reused_devtools",
      acceptLanguage: "en-US,en",
      reason: "login_page_detected",
    });
  });

  test("reattach non-auth failure clears in-progress Chrome mode", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-fail-preflight-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume after generic failure.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9226,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-generic-failure",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });
    resumeBrowserSessionMock.mockRejectedValueOnce(new Error("model picker broke"));

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /model picker broke/,
    );

    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { status?: string; chromeMode?: string; reason?: string };
    expect(metadata).toMatchObject({
      status: "failed",
      reason: "model picker broke",
    });
    expect(metadata.chromeMode).toBeUndefined();
  });

  test.each([
    {
      error: new Error("assistant response timed out"),
      status: "WAIT_TIMED_OUT",
      reason: "assistant_timeout",
    },
    {
      error: new AssistantStoppedError(3),
      status: "INCOMPLETE_ANSWER",
      reason: "stopped_without_answer",
    },
  ])("reattach failure remains resumable: $reason", async (failure) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-timeout-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume and timeout again.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        chromeMode: "launched",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9228,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-timeout-again",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });
    resumeBrowserSessionMock.mockRejectedValueOnce(failure.error);

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      failure.error,
    );

    const { status } = await readAskProStatus({ cwd, sessionId: session.id });
    expect(status.status).toBe(failure.status);
    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { status?: string; chromeMode?: string; reason?: string };
    expect(metadata).toMatchObject({
      status: failure.status.toLowerCase(),
      chromeMode: "reused_devtools",
      reason: failure.reason,
    });
  });

  test("reattach auth failure preserves relaunch Chrome mode", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-relaunch-auth-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume after relaunch auth failure.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        chromeMode: "launched",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9231,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-relaunch-auth",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });
    resumeBrowserSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
      const deps = args[3] as { chromeModeCb?: (mode: string) => Promise<void> };
      await deps.chromeModeCb?.("relaunched");
      throw new Error("login required");
    });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toBeInstanceOf(
      AskProNeedsAuthError,
    );

    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { status?: string; chromeMode?: string; reason?: string };
    expect(metadata).toMatchObject({
      status: "needs_user_auth",
      chromeMode: "relaunched",
      reason: "login_page_detected",
    });
  });

  test("reattach timeout preserves relaunch Chrome mode", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-relaunch-timeout-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume after relaunch timeout.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        chromeMode: "launched",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9232,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-relaunch-timeout",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });
    resumeBrowserSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
      const deps = args[3] as { chromeModeCb?: (mode: string) => Promise<void> };
      await deps.chromeModeCb?.("relaunched");
      throw new Error("assistant response timed out");
    });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /assistant response timed out/,
    );

    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { status?: string; chromeMode?: string; reason?: string };
    expect(metadata).toMatchObject({
      status: "wait_timed_out",
      chromeMode: "relaunched",
      reason: "assistant_timeout",
    });
  });

  test("reattach generic failure preserves relaunch Chrome mode", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-relaunch-fail-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume after relaunch failure.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        chromeMode: "launched",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9233,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-relaunch-fail",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });
    resumeBrowserSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
      const deps = args[3] as { chromeModeCb?: (mode: string) => Promise<void> };
      await deps.chromeModeCb?.("relaunched");
      throw new Error("model picker broke after relaunch");
    });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /model picker broke after relaunch/,
    );

    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { status?: string; chromeMode?: string; reason?: string };
    expect(metadata).toMatchObject({
      status: "failed",
      chromeMode: "relaunched",
      reason: "model picker broke after relaunch",
    });
  });

  test("reattach without runtime metadata reopens the managed browser submission", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-no-runtime-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume after login without a saved runtime.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "needs_user_auth",
        profileDir: testSharedProfileDir(),
        url: "https://chatgpt.com/",
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAITING" });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(runBrowserModeMock).toHaveBeenCalledTimes(1);
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        manualLoginProfileDir: testSharedProfileDir(),
        startMinimized: false,
        desiredModel: "Latest",
        thinkingTime: "pro",
        url: "https://chatgpt.com/",
      },
    });
  });

  test("auth relaunch preserves stored non-default ChatGPT URL", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-custom-url-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume after login on a custom ChatGPT URL.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "needs_user_auth",
        profileDir: testSharedProfileDir(),
        url: "https://chatgpt.com/g/g-test-project",
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "NEEDS_USER_AUTH" });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/g/g-test-project",
      },
    });
  });

  test("reattach without runtime metadata fails closed unless auth was pending", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-no-runtime-waiting-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume a waiting session without runtime metadata.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: testSharedProfileDir(),
        url: "https://chatgpt.com/",
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAITING" });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /no saved browser runtime metadata/i,
    );
    expect(runBrowserModeMock).not.toHaveBeenCalled();
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("no-temporary resume opens a normal chat retry instead of reattaching temporary chat", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-no-temporary-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Retry outside temporary chat.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: testSharedProfileDir(),
        url: "https://chatgpt.com/?temporary-chat=true",
        runtime: {
          chromePort: 9224,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/?temporary-chat=true",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAITING" });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id, temporary: false });

    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    expect(runBrowserModeMock).toHaveBeenCalledTimes(1);
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        url: "https://chatgpt.com/",
      },
    });
  });

  test("reattach without runtime metadata reuses the stored agent profile", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-no-runtime-agent-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume after agent login without a saved runtime.",
      filePatterns: [],
      dryRun: false,
    });
    const storedProfile = testAgentProfileDir("review-t1-59cd6bada6");
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "needs_user_auth",
        agentId: "review-t1-59cd6bada6",
        profileDir: storedProfile,
        url: "https://chatgpt.com/",
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "NEEDS_USER_AUTH" });

    vi.stubEnv("ASK_PRO_AGENT_ID", "other-agent");
    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
    const firstCall = runBrowserModeMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      config: {
        manualLoginProfileDir: storedProfile,
      },
    });
    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { agentId?: string | null; profileDir?: string };
    expect(metadata.agentId).toBe("review-t1-59cd6bada6");
    expect(metadata.profileDir).toBe(storedProfile);
  });

  test("reattach fallback uses recorded agent id instead of ambient env", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-agent-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the saved agent browser session.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        agentId: "review-t1-59cd6bada6",
        runtime: {
          chromePort: 9333,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-agent",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    vi.stubEnv("ASK_PRO_AGENT_ID", "other-agent");
    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    const firstCall = resumeBrowserSessionMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[1]).toMatchObject({
      attachRunning: false,
      manualLoginProfileDir: expect.stringContaining(
        path.join("agents", "review-t1-59cd6bada6", "browser-profile"),
      ),
    });
    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { profileDir?: string };
    expect(metadata.profileDir).toContain(
      path.join("agents", "review-t1-59cd6bada6", "browser-profile"),
    );
  });

  test("reattach rejects unsafe agent-scoped profile metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-unsafe-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the unsafe stored browser session.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        agentId: "../bad-agent",
        profileDir: path.join(cwd, "other-agent-profile"),
        runtime: {
          chromePort: 9444,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-unsafe",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /stored ask-pro agent id is invalid/i,
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("reattach validates stored agent id before accepting a managed profile path", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-invalid-managed-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the invalid managed browser session.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        agentId: "../bad-agent",
        profileDir: testAgentProfileDir("review-t1-6d908a4714"),
        runtime: {
          chromePort: 9666,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-invalid-managed",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /stored ask-pro agent id is invalid/i,
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("reattach rejects agent profile paths without a stored agent id", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-missing-agent-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the missing-agent managed browser session.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: testAgentProfileDir("review-t1-6d908a4714"),
        runtime: {
          chromePort: 9776,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-missing-agent",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /does not match stored agent id/i,
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("reattach rejects malformed profile paths under the ask-pro state root", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-malformed-state-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the malformed managed-root browser session.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: path.join(managedProfileState.root, "agents", "review-t1", "browser-profile"),
        runtime: {
          chromePort: 9778,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-malformed-state",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /stored ask-pro profile path is invalid/i,
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("reattach keeps a safe recorded managed profile authoritative", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-managed-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the saved managed browser session.",
      filePatterns: [],
      dryRun: false,
    });
    const recordedProfile = testAgentProfileDir("review-t2-91dc99b944");
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        agentId: "review-t2-91dc99b944",
        profileDir: recordedProfile,
        runtime: {
          chromePort: 9555,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-managed",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    const firstCall = resumeBrowserSessionMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[1]).toMatchObject({
      manualLoginProfileDir: recordedProfile,
    });
  });

  test("reattach migrates exact legacy profile metadata and runtime hints", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-legacy-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Resume the legacy profile.",
      filePatterns: [],
      dryRun: false,
    });
    const agentId = "review-t1-6d908a4714";
    const legacyProfile = testLegacyAgentProfileDir(agentId);
    const currentProfile = testAgentProfileDir(agentId);
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        agentId,
        profileDir: legacyProfile,
        runtime: {
          chromePort: 9556,
          chromeProfileRoot: legacyProfile,
          userDataDir: legacyProfile,
          tabUrl: "https://chatgpt.com/c/test-legacy",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await resumeAskProBrowserSession({ cwd, sessionId: session.id });

    const resumeCall = resumeBrowserSessionMock.mock.calls[0] as unknown[] | undefined;
    expect(resumeCall?.[0]).toMatchObject({
      chromeProfileRoot: currentProfile,
      userDataDir: currentProfile,
    });
    expect(resumeCall?.[1]).toMatchObject({
      manualLoginProfileDir: currentProfile,
    });
    const metadata = JSON.parse(
      await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
    ) as { profileDir?: string; runtime?: { chromeProfileRoot?: string; userDataDir?: string } };
    expect(metadata.profileDir).toBe(currentProfile);
    expect(metadata.runtime).toMatchObject({
      chromeProfileRoot: currentProfile,
      userDataDir: currentProfile,
    });
  });

  test("reattach rejects runtime profile hints outside the recorded profile", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-runtime-profile-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Reject an unrelated runtime profile.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9557,
          userDataDir: path.join(cwd, "unrelated-profile"),
          tabUrl: "https://chatgpt.com/c/test-unrelated",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /runtime profile path is invalid/i,
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("reattach rejects agent profile paths that do not match the stored agent id", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-mismatch-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the mismatched managed browser session.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        agentId: "review-t1-6d908a4714",
        profileDir: testAgentProfileDir("review-t2-91dc99b944"),
        runtime: {
          chromePort: 9777,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-mismatch",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /does not match stored agent id/i,
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });

  test("reattach rejects agent metadata paired with the shared default profile", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-shared-agent-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Review the shared-default agent browser session.",
      filePatterns: [],
      dryRun: false,
    });
    await writeAskProBrowserMetadata({
      cwd,
      sessionId: session.id,
      metadata: {
        schemaVersion: 1,
        status: "running",
        agentId: "review-t1-6d908a4714",
        profileDir: testSharedProfileDir(),
        runtime: {
          chromePort: 9888,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/test-shared-agent",
        },
      },
    });
    await updateAskProStatus({ cwd, sessionId: session.id, status: "WAIT_TIMED_OUT" });

    await expect(resumeAskProBrowserSession({ cwd, sessionId: session.id })).rejects.toThrow(
      /stored ask-pro profile path is invalid/i,
    );
    expect(resumeBrowserSessionMock).not.toHaveBeenCalled();
  });
});
