import { afterEach, describe, expect, test, vi } from "vitest";
import {
  __test__,
  buildAssistantSnapshotExpressionForTest,
  createAssistantContinuation,
  waitForAssistantResponse,
} from "../../src/browser/actions/assistantResponse.js";
import { AssistantStoppedError } from "../../src/browser/errors.js";
import { submitPrompt } from "../../src/browser/actions/promptComposer.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

vi.mock("../../src/browser/actions/promptComposer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/actions/promptComposer.js")>()),
  submitPrompt: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("assistant response actions", () => {
  test.each(["status only", "tool markdown", "final answer"])(
    "excludes progress panels: %s",
    (scenario) => {
      class Element {
        constructor(
          readonly textContent: string,
          readonly status = false,
          readonly children: Element[] = [],
        ) {}
        get innerText() {
          return this.textContent;
        }
        get innerHTML() {
          return this.textContent;
        }
        getAttribute(name: string) {
          return name === "data-turn" ? "assistant" : null;
        }
        closest(selector: string) {
          if (selector.includes("conversation-turn")) return this === oldFinal ? oldTurn : turn;
          return selector.includes("data-streaming-response-status") && this.status ? this : null;
        }
        querySelector(selector: string) {
          return selector === "[data-streaming-response-status]"
            ? (this.children.find((node) => node.status) ?? null)
            : null;
        }
        querySelectorAll(selector: string): Element[] {
          return selector.includes("markdown")
            ? this.children.filter((node) => scenario !== "status only" || !node.status)
            : [];
        }
      }
      const progress = new Element("Inspecting Manifest and File Tree", true);
      const final = new Element("Use the shared transaction boundary.");
      const turn = new Element(
        progress.textContent,
        false,
        scenario === "final answer" ? [progress, final] : [progress],
      );
      const oldFinal = new Element("An older completed answer.");
      const oldTurn = new Element(oldFinal.textContent, false, [oldFinal]);
      const main = new Element("", false, [oldFinal, progress]);
      const document = {
        querySelectorAll: () => [oldTurn, turn],
        querySelector: (selector: string) => (selector === "main" ? main : null),
      };
      const snapshot = new Function(
        "document",
        "HTMLElement",
        "location",
        `return ${buildAssistantSnapshotExpressionForTest()}`,
      )(document, Element, { href: "https://chatgpt.com/c/test" });
      if (scenario === "final answer") expect(snapshot?.text).toBe(final.textContent);
      else expect(snapshot).toBeNull();
    },
  );

  test.each([1, 5000])("does not save active text at a %s ms deadline", async (timeoutMs) => {
    vi.useFakeTimers();
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (
          expression.includes("extractAssistantTurn") ||
          expression.includes("captureViaObserver")
        ) {
          return {
            result: {
              type: "object",
              value: { text: "A partial response that has not finished yet.", turnIndex: 1 },
            },
          };
        }
        return { result: { value: expression.startsWith("Boolean(document.querySelector(") } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const pending = expect(
      waitForAssistantResponse(runtime, timeoutMs, vi.fn() as unknown as BrowserLogger, 1),
    ).rejects.toThrow("Timed out waiting for assistant response");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  test("recovery waits for completion instead of accepting partial text", async () => {
    vi.useFakeTimers();
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: expression.includes("extractAssistantTurn")
            ? { text: "Partial response", turnIndex: 1 }
            : expression.startsWith("Boolean(document.querySelector("),
        },
      })),
    } as unknown as ChromeClient["Runtime"];
    const pending = __test__.recoverAssistantResponse(
      runtime,
      1000,
      vi.fn() as unknown as BrowserLogger,
      1,
    );
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBeNull();
  });

  test.each([
    { answer: "", active: false, laterUser: false, stopped: true },
    { answer: "A substantive partial answer.", active: false, laterUser: false, stopped: false },
    { answer: "", active: true, laterUser: false, stopped: false },
    { answer: "", active: false, laterUser: true, stopped: false },
  ])("only an empty, inactive, latest stopped turn permits continuation: %j", (sample) => {
    // Minimal pinned DOM input: this checks our recovery boundary, not ChatGPT compatibility.
    class Element {
      constructor(
        readonly textContent: string,
        readonly role = "assistant",
      ) {}
      get innerText() {
        return this.textContent;
      }
      get innerHTML() {
        return this.textContent;
      }
      getAttribute(name: string) {
        return name === "data-turn" ? this.role : null;
      }
      querySelector() {
        return null;
      }
      querySelectorAll(selector: string): Element[] {
        if (selector === "button") return [new Element("Stopped thinking")];
        if (selector === ".markdown" && sample.answer) return [new Element(sample.answer)];
        return [];
      }
    }
    const turns = [
      new Element(`ChatGPT said:\nStopped thinking${sample.answer ? `\n${sample.answer}` : ""}`),
    ];
    if (sample.laterUser) turns.push(new Element("continue", "user"));
    const snapshot = new Function(
      "document",
      "HTMLElement",
      "location",
      `return ${buildAssistantSnapshotExpressionForTest()}`,
    )(
      {
        querySelectorAll: () => turns,
        querySelector: (selector: string) =>
          selector.includes("stop") && sample.active ? {} : null,
      },
      Element,
      { href: "https://chatgpt.com/c/test" },
    );
    expect(snapshot?.stoppedWithoutAnswer === true).toBe(sample.stopped);
    if (sample.answer) expect(snapshot.text).toBe(sample.answer);
  });

  test.each(["observer", "watchdog"])(
    "%s recovery sends once and captures the continued answer",
    async (path) => {
      vi.useFakeTimers();
      let snapshot: Record<string, unknown> = {
        text: "",
        stoppedWithoutAnswer: true,
        turnIndex: 1,
      };
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("captureViaObserver") && path === "watchdog")
            return new Promise(() => {});
          if (
            expression.includes("extractAssistantTurn") ||
            expression.includes("captureViaObserver")
          ) {
            return { result: { type: "object", value: snapshot } };
          }
          return { result: { value: false } };
        }),
      } as unknown as ChromeClient["Runtime"];
      vi.mocked(submitPrompt).mockImplementationOnce(async () => {
        snapshot = {
          text: "Use the shared transaction boundary to fix the lock ordering.",
          turnIndex: 3,
        };
        return 3;
      });
      const logger = vi.fn() as unknown as BrowserLogger;
      const continuation = createAssistantContinuation(
        runtime,
        {} as ChromeClient["Input"],
        logger,
      );
      const pending = waitForAssistantResponse(runtime, 60_000, logger, 1, "test", continuation);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toMatchObject({
        text: "Use the shared transaction boundary to fix the lock ordering.",
      });
      expect(vi.mocked(submitPrompt).mock.calls.map((call) => call[1])).toEqual(["continue"]);
      // The same budget survives a reload/recheck; it cannot silently send twice.
      await expect(continuation(3)).rejects.toBeInstanceOf(AssistantStoppedError);
    },
  );

  test("a second empty stop returns control; an explicit resume permits one new attempt", async () => {
    let turnIndex = 1;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          type: "object",
          value:
            expression.includes("extractAssistantTurn") || expression.includes("captureViaObserver")
              ? { text: "", stoppedWithoutAnswer: true, turnIndex }
              : false,
        },
      })),
    } as unknown as ChromeClient["Runtime"];
    vi.mocked(submitPrompt).mockImplementation(async () => {
      turnIndex += 2;
      return turnIndex;
    });
    const logger = vi.fn() as unknown as BrowserLogger;
    for (const expectedSends of [1, 2]) {
      const continuation = createAssistantContinuation(
        runtime,
        {} as ChromeClient["Input"],
        logger,
      );
      await expect(
        waitForAssistantResponse(runtime, 60_000, logger, turnIndex, "test", continuation),
      ).rejects.toBeInstanceOf(AssistantStoppedError);
      expect(submitPrompt).toHaveBeenCalledTimes(expectedSends);
    }
  });

  test.each([".ProseMirror", 'textarea[aria-label="Message ChatGPT"]'])(
    "preserves a draft in fallback composer %s",
    async (selector) => {
      class TextArea {
        value = "Unsent draft";
        innerText = "Unsent draft";
        getBoundingClientRect() {
          return { width: 100, height: 40 };
        }
        getAttribute() {
          return null;
        }
      }
      const node = new TextArea();
      const runtime = {
        evaluate: async ({ expression }: { expression: string }) => ({
          result: {
            value: new Function(
              "document",
              "HTMLTextAreaElement",
              "HTMLInputElement",
              `return ${expression}`,
            )(
              { querySelector: (candidate: string) => (candidate === selector ? node : null) },
              selector.startsWith("textarea") ? TextArea : class {},
              class {},
            ),
          },
        }),
      } as unknown as ChromeClient["Runtime"];
      const logger = vi.fn() as unknown as BrowserLogger;
      await expect(
        createAssistantContinuation(runtime, {} as ChromeClient["Input"], logger)(1),
      ).rejects.toBeInstanceOf(AssistantStoppedError);
      expect(submitPrompt).not.toHaveBeenCalled();
      expect(node.value).toBe("Unsent draft");
    },
  );

  test("does not retry an uncertain send", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: {} } }),
    } as unknown as ChromeClient["Runtime"];
    const logger = vi.fn() as unknown as BrowserLogger;
    vi.mocked(submitPrompt).mockRejectedValueOnce(new Error("Disconnected during send"));
    const continuation = createAssistantContinuation(runtime, {} as ChromeClient["Input"], logger);
    await expect(continuation(1)).rejects.toBeInstanceOf(AssistantStoppedError);
    await expect(continuation(1)).rejects.toBeInstanceOf(AssistantStoppedError);
    expect(submitPrompt).toHaveBeenCalledOnce();
  });

  test("observer does not click ChatGPT stop controls", () => {
    const expression = __test__.buildResponseObserverExpression(120_000);

    expect(expression).not.toContain("dispatchClickSequence(stop)");
  });

  test("routes failed recovery diagnostics through the verbose logger", async () => {
    vi.useFakeTimers();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ result: { value: null } })
      .mockResolvedValueOnce({
        result: { value: { matchedControls: 0, truncated: false, controls: [] } },
      });
    const logger = vi.fn() as unknown as BrowserLogger;
    logger.verbose = true;

    const recovery = __test__.recoverAssistantResponse(
      { evaluate } as unknown as ChromeClient["Runtime"],
      1,
      logger,
    );
    await vi.runAllTimersAsync();

    await expect(recovery).resolves.toBeNull();
    expect(JSON.parse(vi.mocked(logger).mock.calls[0]?.[0] as string)).toMatchObject({
      context: "assistant-response-recovery",
      controls: [],
    });
    vi.useRealTimers();
  });
});
