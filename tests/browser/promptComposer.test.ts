import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { __test__ } from "../../src/browser/actions/promptComposer.js";

describe("prompt composer actions", () => {
  test("accepts an active answer when turn selectors miss the submitted prompt", async () => {
    const evaluate = vi.fn(async (_: { expression: string }) => ({
      result: {
        value: {
          baseline: 0,
          turnsCount: 0,
          hasNewTurn: false,
          composerCleared: true,
          stopVisible: true,
        },
      },
    }));

    await expect(
      __test__.verifyPromptCommitted({ evaluate } as never, "question", 100, undefined, 0),
    ).resolves.toBe(0);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[0]?.expression).toContain("isVisible(document.querySelector");
  });

  test("does not accept a cleared composer without visible submission evidence", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: runInNewContext(expression, {
          document: {
            querySelector: (selector: string) =>
              selector.includes("stop-button")
                ? { getBoundingClientRect: () => ({ width: 20, height: 20 }) }
                : null,
            querySelectorAll: () => [],
          },
          window: { getComputedStyle: () => ({ visibility: "hidden", display: "block" }) },
          location: { href: "https://chatgpt.com/c/test" },
        }),
      },
    }));

    await expect(
      __test__.verifyPromptCommitted({ evaluate } as never, "question", 1, undefined, 0),
    ).rejects.toThrow("Prompt did not appear in conversation");
  });

  test("arms post-submit guard before defocus and pointer cleanup", async () => {
    const order: string[] = [];
    const evaluate = vi.fn(async () => {
      order.push("defocus");
      return { result: { value: { changed: true, stopFocused: false } } };
    });
    const dispatchMouseEvent = vi.fn(async () => {
      order.push("pointer");
    });
    const afterSubmit = vi.fn(async () => {
      order.push("guard");
    });

    await __test__.runPostSubmitProtection(
      { evaluate } as never,
      { dispatchMouseEvent } as never,
      vi.fn<(message: string) => void>(),
      afterSubmit,
    );

    expect(order).toEqual(["guard", "defocus", "pointer"]);
  });

  test("moves focus away from the stop button after submit", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      expect(expression).toContain("__ask_pro_focus_sink__");
      expect(expression).toContain("activeBefore.blur()");
      expect(expression).toContain("sink.focus({ preventScroll: true })");
      return { result: { value: { changed: true, stopFocused: false } } };
    });
    const logger = vi.fn();

    await __test__.defocusStopButtonAfterSubmit({ evaluate } as never, logger);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith("Moved focus away from ChatGPT stop button");
  });

  test("logs if the focus sink runs but stop still reports focused", async () => {
    const evaluate = vi.fn(async () => ({
      result: { value: { changed: true, stopFocused: true } },
    }));
    const logger = vi.fn();

    await __test__.defocusStopButtonAfterSubmit({ evaluate } as never, logger);

    expect(logger).toHaveBeenCalledWith(
      "Moved focus sink after submit, but ChatGPT stop button still reports focused",
    );
  });

  test("logs when ChatGPT keeps the stop button focused after defocus", async () => {
    const evaluate = vi.fn(async () => ({
      result: { value: { changed: false, stopFocused: true, activeLabel: "Stop answering" } },
    }));
    const logger = vi.fn();

    await __test__.defocusStopButtonAfterSubmit({ evaluate } as never, logger);

    expect(logger).toHaveBeenCalledWith(
      "ChatGPT stop button remained focused after defocus attempt (Stop answering)",
    );
  });

  test("moves the pointer away from the stop control after submit", async () => {
    const dispatchMouseEvent = vi.fn().mockResolvedValue(undefined);
    const logger = vi.fn();

    await __test__.movePointerAwayFromStopControl({ dispatchMouseEvent } as never, logger);

    expect(dispatchMouseEvent).toHaveBeenCalledWith({ type: "mouseMoved", x: 1, y: 1 });
    expect(logger).toHaveBeenCalledWith("Moved pointer away from ChatGPT stop control");
  });

  test("refuses Enter fallback while stop control is visible", async () => {
    const evaluate = vi.fn(async () => ({ result: { value: false } }));

    const canSubmit = await __test__.canSubmitPromptViaEnter({ evaluate } as never);

    expect(canSubmit).toBe(false);
  });
});
