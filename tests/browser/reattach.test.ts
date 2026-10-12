import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resumeBrowserSession } from "../../src/browser/reattach.js";
import { AssistantStoppedError } from "../../src/browser/errors.js";
import { AssistantQuestionsError } from "../../src/browser/actions/questions.js";
import {
  buildConversationUrl,
  extractConversationIdFromUrl,
} from "../../src/browser/reattachHelpers.js";
import type { ChromeClient } from "../../src/browser/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("reattach browser lease", () => {
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
