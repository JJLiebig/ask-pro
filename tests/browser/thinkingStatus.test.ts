import { describe, expect, test, vi } from "vitest";
import { readThinkingStatusForTest } from "../../src/browser/actions/thinkingStatus.js";

class FakeControl {
  readonly dataset = {};
  readonly className = "";
  readonly click = vi.fn();

  constructor(readonly textContent: string) {}

  getAttribute() {
    return null;
  }

  getBoundingClientRect() {
    return { width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 };
  }
}

async function evaluateThinkingStatus(labels: string[]) {
  const controls = labels.map((label) => new FakeControl(label));
  const document = {
    querySelectorAll: (selector: string) =>
      selector === 'button, [role="button"]' ? controls : [],
  };
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
    result: {
      value: await new Function("document", "HTMLElement", "window", `return ${expression}`)(
        document,
        FakeControl,
        window,
      ),
    },
  }));

  return {
    snapshot: await readThinkingStatusForTest({ evaluate } as never),
    controls,
  };
}

describe("thinking status", () => {
  test("reports active tool work with only Stop answering visible", async () => {
    const { snapshot, controls } = await evaluateThinkingStatus(["Stop answering"]);
    expect(snapshot).toMatchObject({ message: "active", source: "inline" });
    expect(controls[0].click).not.toHaveBeenCalled();
  });

  test("reports the passive Pro gate only while both controls are visible", async () => {
    const active = await evaluateThinkingStatus(["Answer now", "Stop answering"]);
    const incomplete = await evaluateThinkingStatus(["Answer now"]);

    expect(active.snapshot).toMatchObject({ message: "pro gate active", source: "inline" });
    expect(active.controls.every((control) => control.click.mock.calls.length === 0)).toBe(true);
    expect(incomplete.snapshot).toBeNull();
  });
});
