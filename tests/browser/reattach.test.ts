import { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AskProNeedsAuthError,
  resumeAskProBrowserSession,
} from "../../src/ask-pro/browserRunner.js";
import * as humanCheck from "../../src/ask-pro/humanCheck.js";
import { readAskProQuestions, writeAskProQuestions } from "../../src/ask-pro/questions.js";
import {
  createAskProSession,
  readAskProStatus,
  updateAskProStatus,
  writeAskProBrowserMetadata,
} from "../../src/ask-pro/session.js";
import * as chromeLifecycle from "../../src/browser/chromeLifecycle.js";
import { resumeBrowserSession } from "../../src/browser/reattach.js";
import { AssistantStoppedError } from "../../src/browser/errors.js";
import { AssistantQuestionsError } from "../../src/browser/actions/questions.js";
import { readAssistantSnapshot } from "../../src/browser/actions/assistantResponse.js";
import { submitPrompt } from "../../src/browser/actions/promptComposer.js";
import {
  buildConversationUrl,
  extractConversationIdFromUrl,
} from "../../src/browser/reattachHelpers.js";
import type { ChromeClient } from "../../src/browser/types.js";

const tempDirs: string[] = [];
vi.mock("../../src/browser/actions/promptComposer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/actions/promptComposer.js")>()),
  submitPrompt: vi.fn(),
}));

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("reattach browser lease", () => {
  test.each([false, true])(
    "hands off a late challenge on the relaunched tab (answering: %s)",
    async (answering) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-challenge-"));
      tempDirs.push(cwd);
      const stateDir = path.join(cwd, "state");
      const profileDir = path.join(stateDir, "browser-profile");
      vi.stubEnv("ASK_PRO_STATE_DIR", stateDir);
      vi.stubEnv("DISPLAY", "");
      vi.stubEnv("WAYLAND_DISPLAY", "");
      try {
        vi.spyOn(humanCheck, "saveHumanCheck").mockImplementation(
          async (_dir, options) =>
            `http://fixture.invalid:${options.chromePort}/${options.targetId}`,
        );
        const session = await createAskProSession({
          cwd,
          question: "Recover this submitted prompt.",
          filePatterns: [],
          dryRun: false,
        });
        await writeAskProBrowserMetadata({
          cwd,
          sessionId: session.id,
          metadata: {
            schemaVersion: 1,
            status: answering ? "awaiting_answers" : "wait_timed_out",
            url: "https://chatgpt.com/",
            profileDir,
            runtime: {
              chromePort: 9230,
              chromeBrowserWSEndpoint: "ws://127.0.0.1:9230/devtools/browser/old",
              chromeTargetId: "old-tab",
              conversationId: "submitted-conversation",
              promptSubmitted: true,
            },
          },
        });
        let answers: string | undefined;
        if (answering) {
          await writeAskProQuestions(session.dir, [
            { question: "Which color?", options: ["Blue"], freeText: true },
          ]);
          const { requestId } = await readAskProQuestions(session.dir);
          answers = JSON.stringify({ requestId, answers: [1] });
        }
        await updateAskProStatus({
          cwd,
          sessionId: session.id,
          status: answering ? "AWAITING_ANSWERS" : "WAIT_TIMED_OUT",
        });

        let composerProbed!: () => void;
        const composerProbe = new Promise<void>((resolve) => {
          composerProbed = resolve;
        });
        const document = {
          readyState: "complete",
          title: "ChatGPT",
          querySelector: () => null,
          querySelectorAll: () => [],
        };
        const location = { href: "https://chatgpt.com/", pathname: "/" };
        const client = {
          Page: { navigate: async () => {} },
          Runtime: {
            evaluate: async ({ expression }: { expression: string }) => {
              if (expression.includes("const selectors =")) composerProbed();
              return {
                result: {
                  value: await new Function(
                    "document",
                    "location",
                    "fetch",
                    `return ${expression}`,
                  )(document, location, async () => ({ status: 200 })),
                },
              };
            },
          },
          close: async () => {},
        } as unknown as ChromeClient;
        vi.spyOn(chromeLifecycle, "listRemoteChromeTargets").mockRejectedValue(
          new Error("Original Chrome is unavailable"),
        );
        vi.spyOn(chromeLifecycle, "maybeReuseRunningChrome").mockResolvedValue(null);
        vi.spyOn(chromeLifecycle, "launchChrome").mockResolvedValue({
          pid: 2_147_483_647,
          port: 9238,
          process: new ChildProcess(),
          remoteDebuggingPipes: null,
          kill: () => {},
        });
        vi.spyOn(chromeLifecycle, "shouldLaunchChromeMinimized").mockReturnValue(false);
        vi.spyOn(chromeLifecycle, "connectWithNewTab").mockResolvedValue({
          client,
          targetId: "new-tab",
        });
        const closeTab = vi.spyOn(chromeLifecycle, "closeTab").mockResolvedValue(undefined);
        const closeChrome = vi
          .spyOn(chromeLifecycle, "closeChromeGracefully")
          .mockResolvedValue(undefined);

        vi.useFakeTimers();
        const outcome = resumeAskProBrowserSession({ cwd, sessionId: session.id, answers }).catch(
          (error: unknown) => error,
        );
        expect(
          await Promise.race([composerProbe.then(() => true), outcome.then(() => false)]),
        ).toBe(true);
        document.title = "Just a moment...";
        await vi.advanceTimersByTimeAsync(90_000);

        const error = await outcome;
        expect(error).toBeInstanceOf(AskProNeedsAuthError);
        expect(error).toMatchObject({ reason: "challenge_detected" });
        if (process.platform === "linux") {
          expect(error).toMatchObject({ checkUrl: "http://fixture.invalid:9238/new-tab" });
        }
        const { status } = await readAskProStatus({ cwd, sessionId: session.id });
        expect(status.status).toBe(answering ? "AWAITING_ANSWERS" : "NEEDS_USER_AUTH");
        const metadata = JSON.parse(
          await fs.readFile(path.join(session.dir, "browser.json"), "utf8"),
        );
        expect(metadata).toMatchObject({
          status: answering ? "awaiting_answers" : "needs_user_auth",
          chromeMode: "relaunched",
          runtime: {
            chromePort: 9238,
            chromeTargetId: "new-tab",
            conversationId: "submitted-conversation",
            promptSubmitted: true,
          },
        });
        expect(metadata.runtime).not.toHaveProperty("chromeBrowserWSEndpoint");
        expect(closeChrome).not.toHaveBeenCalled();
        expect(closeTab).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }
    },
  );

  test.each(["native", "expired"])(
    "captures the answer after %s questions are submitted",
    async (mode) => {
      const questions = [{ question: "Color?", options: ["Blue"], freeText: true }];
      let turns = 2;
      let snapshot = { text: "Previous reply", turnIndex: 1 };
      const client = {
        close: vi.fn().mockResolvedValue(undefined),
        Input: {},
        Runtime: {
          evaluate: async ({ expression }: { expression: string }) => ({
            result: {
              value:
                expression === "location.href"
                  ? "https://chatgpt.com/c/test"
                  : expression.endsWith(".length")
                    ? turns
                    : expression.includes("const MIN_TURN_INDEX")
                      ? snapshot
                      : expression.includes("const submission =")
                        ? {
                            questions: mode === "native" ? questions : null,
                            started: mode === "native",
                          }
                        : 2,
            },
          }),
        },
      } as unknown as ChromeClient;
      // Sending commits a new user turn before the next assistant turn appears.
      vi.mocked(submitPrompt).mockImplementationOnce(async () => {
        turns = 3;
        return turns;
      });
      const result = await resumeBrowserSession(
        { chromePort: 9222, conversationId: "test" },
        {},
        vi.fn<(message: string) => void>(),
        {
          listTargets: async () => [
            { targetId: "test", type: "page", url: "https://chatgpt.com/c/test" },
          ],
          connect: async () => client,
          questionAnswers: { answers: [1], questions, submissionState: { started: false } },
          waitForAssistantResponse: async (runtime, _timeout, _logger, minTurnIndex) => {
            if (mode === "expired")
              expect(await readAssistantSnapshot(runtime, minTurnIndex)).toBeNull();
            snapshot = { text: "Fresh answer: Blue", turnIndex: mode === "native" ? 1 : 3 };
            const answer = await readAssistantSnapshot(runtime, minTurnIndex);
            expect(answer?.text).toBe("Fresh answer: Blue");
            return { text: answer!.text!, meta: {} };
          },
          captureAssistantMarkdown: async () => null,
        },
      );
      expect(result.answerText).toBe("Fresh answer: Blue");
      expect(client.close).toHaveBeenCalledOnce();
    },
  );
  test("discards a stored provisional route before recovering an interrupted session", async () => {
    const recoverSession = vi.fn().mockResolvedValue({
      answerText: "Recovered answer",
      answerMarkdown: "Recovered answer",
      chromeMode: "relaunched",
    });
    await resumeBrowserSession(
      {
        tabUrl: "https://chatgpt.com/c/WEB:795d079e-6c4d-4334-b0ae-4534c70305bd",
        conversationId: "WEB",
      },
      {},
      vi.fn<(message: string) => void>(),
      { recoverSession },
    );
    expect(recoverSession).toHaveBeenCalledWith(
      expect.objectContaining({ tabUrl: undefined, conversationId: undefined }),
      {},
    );
  });
  test("recovers a pending check on an owned tab after Chrome restores its URL under a new ID", async () => {
    const conversationUrl = "https://chatgpt.com/c/saved-conversation";
    const restoredTab = {
      close: async () => {},
      Input: {},
      Runtime: {
        evaluate: async ({ expression }: { expression: string }) => ({
          result: { value: expression === "location.href" ? conversationUrl : 2 },
        }),
      },
    } as unknown as ChromeClient;
    const result = await resumeBrowserSession(
      { chromePort: 9222, chromeTargetId: "original-tab", tabUrl: conversationUrl },
      {},
      vi.fn<(message: string) => void>(),
      {
        humanCheck: "resume",
        listTargets: async () => [{ targetId: "restored-tab", type: "page", url: conversationUrl }],
        connect: async () => restoredTab,
        waitForAssistantResponse: async () => ({ text: "Response from restored tab", meta: {} }),
        captureAssistantMarkdown: async () => null,
        recoverSession: async () => ({
          answerText: "Recovered response",
          answerMarkdown: "Recovered response",
          chromeMode: "relaunched",
        }),
      },
    );
    expect(result.answerText).toBe("Recovered response");
  });
  test.each([
    ["saved conversation", true],
    ["wrong conversation", true],
    ["wrong conversation", false],
  ])("checks the %s in the verified tab with answers=%s", async (destination, answering) => {
    const conversationUrl = "https://chatgpt.com/c/saved-conversation";
    let tabUrl = "https://chatgpt.com/";
    let answered = false;
    let waitedForResponse = false;
    const questions = [{ question: "Color?", options: ["Blue"], freeText: true }];
    const client = {
      close: async () => {},
      Input: {},
      Page: {
        navigate: async ({ url }: { url: string }) => {
          expect(url).toBe(conversationUrl);
          tabUrl = destination === "saved conversation" ? url : "https://chatgpt.com/c/other";
        },
      },
      Runtime: {
        evaluate: async ({ expression }: { expression: string }) => {
          let value: unknown = false;
          if (expression === "location.href") value = tabUrl;
          if (expression === "document.readyState") value = "interactive";
          if (expression.includes("const submission =")) {
            answered = true;
            value = { questions, started: true };
          }
          return { result: { value } };
        },
      },
    } as unknown as ChromeClient;
    const resume = resumeBrowserSession(
      { chromePort: 9222, chromeTargetId: "verified-tab", tabUrl: conversationUrl },
      {},
      vi.fn<(message: string) => void>(),
      {
        humanCheck: "resume",
        listTargets: async () => [{ targetId: "verified-tab", type: "page", url: tabUrl }],
        connect: async () => client,
        questionAnswers: answering
          ? { answers: [1], questions, submissionState: { started: false } }
          : undefined,
        waitForAssistantResponse: async () => {
          waitedForResponse = true;
          return { text: "Fresh answer: Blue", meta: {} };
        },
        captureAssistantMarkdown: async () => null,
        recoverSession: async () => {
          throw Error("Could not recover the conversation.");
        },
      },
    );
    if (destination === "saved conversation") {
      expect((await resume).answerText).toBe("Fresh answer: Blue");
      expect(answered).toBe(true);
    } else {
      await expect(resume).rejects.toThrow("Could not recover the conversation.");
      expect(answered).toBe(false);
      expect(waitedForResponse).toBe(false);
    }
  });
  test("does not treat ChatGPT's provisional WEB route as a saved conversation", () => {
    const provisional = "https://chatgpt.com/c/WEB:795d079e-6c4d-4334-b0ae-4534c70305bd";
    const saved = "https://chatgpt.com/c/795d079e-6c4d-4334-b0ae-4534c70305bd";
    expect(extractConversationIdFromUrl(provisional)).toBeUndefined();
    expect(
      buildConversationUrl({ tabUrl: provisional, conversationId: "WEB" }, "https://chatgpt.com/"),
    ).toBeNull();
    expect(extractConversationIdFromUrl(saved)).toBe("795d079e-6c4d-4334-b0ae-4534c70305bd");
  });
  test.each([
    new AssistantStoppedError(3),
    new AssistantQuestionsError([{ question: "Which color?", options: ["Blue"], freeText: true }]),
  ])("returns $name to the caller and closes its connection without relaunching", async (error) => {
    const recoverSession = vi.fn();
    let connected = true;
    const client = {
      close: async () => {
        connected = false;
      },
      Runtime: {
        evaluate: async ({ expression }: { expression: string }) => ({
          result: { value: expression === "location.href" ? "https://chatgpt.com/c/test" : 2 },
        }),
      },
      Input: {},
    } as unknown as ChromeClient;
    await expect(
      resumeBrowserSession(
        { chromePort: 9222, conversationId: "test" },
        {},
        vi.fn<(message: string) => void>(),
        {
          listTargets: async () => [
            { targetId: "test", type: "page", url: "https://chatgpt.com/c/test" },
          ],
          connect: async () => client,
          waitForAssistantResponse: async () => {
            throw error;
          },
          recoverSession,
        },
      ),
    ).rejects.toBe(error);
    expect(connected).toBe(false);
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test.each(["ordinary", "pending answers", "uncertain submission"])(
    "releases its lease after an attach failure: %s",
    async (mode) => {
      const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-lease-"));
      tempDirs.push(profileDir);
      const recovered = {
        answerText: "recovered",
        answerMarkdown: "recovered",
        chromeMode: "relaunched" as const,
      };
      const recoverSession = vi.fn().mockResolvedValue(recovered);

      const result = resumeBrowserSession(
        { chromePort: 9222, userDataDir: profileDir },
        {
          manualLogin: true,
          manualLoginProfileDir: profileDir,
          profileLockTimeoutMs: 0,
        },
        vi.fn<(message: string) => void>(),
        {
          listTargets: async () => {
            throw new Error("attach failed");
          },
          recoverSession,
          questionAnswers:
            mode === "ordinary"
              ? undefined
              : {
                  answers: [1],
                  questions: [{ question: "Color?", options: ["Blue"], freeText: true }],
                  submissionState: { started: mode === "uncertain submission" },
                },
        },
      );
      if (mode === "uncertain submission") await expect(result).rejects.toThrow("attach failed");
      else await expect(result).resolves.toEqual(recovered);

      expect(recoverSession).toHaveBeenCalledTimes(mode === "uncertain submission" ? 0 : 1);
      await expect(fs.readdir(path.join(profileDir, "ask-pro-browser-runs"))).resolves.toEqual([]);
    },
  );
});
