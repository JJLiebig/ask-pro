import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resumeBrowserSession } from "../../src/browser/reattach.js";
import { AssistantStoppedError } from "../../src/browser/errors.js";
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
  test("returns an exhausted continuation to the caller instead of relaunching", async () => {
    const recoverSession = vi.fn();
    const client = {
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
            throw new AssistantStoppedError(3);
          },
          recoverSession,
        },
      ),
    ).rejects.toBeInstanceOf(AssistantStoppedError);
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("releases its lease before falling back after an attach failure", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-lease-"));
    tempDirs.push(profileDir);
    const recovered = {
      answerText: "recovered",
      answerMarkdown: "recovered",
      chromeMode: "relaunched" as const,
    };
    const recoverSession = vi.fn().mockResolvedValue(recovered);

    await expect(
      resumeBrowserSession(
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
        },
      ),
    ).resolves.toEqual(recovered);

    expect(recoverSession).toHaveBeenCalledOnce();
    await expect(fs.readdir(path.join(profileDir, "ask-pro-browser-runs"))).resolves.toEqual([]);
  });
});
