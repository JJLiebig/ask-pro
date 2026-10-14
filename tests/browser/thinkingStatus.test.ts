import { describe, expect, test, vi } from "vitest";
import { readThinkingStatusForTest } from "../../src/browser/actions/thinkingStatus.js";

class FakeControl {
  readonly dataset = {};
  readonly className = "";
  readonly click = vi.fn();

  constructor(
    readonly textContent: string,
    readonly attributes: Record<string, string> = {},
    readonly visible = true,
  ) {}

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  getBoundingClientRect() {
    return { width: this.visible ? 100 : 0, height: 30, top: 0, left: 0, right: 100, bottom: 30 };
  }
}

async function evaluateThinkingStatus(
  labels: string[],
  attributes: Record<string, string> = {},
  visible = true,
) {
  const controls = labels.map((label) => new FakeControl(label, attributes, visible));
  const document = {
    querySelectorAll: (selector: string) => {
      if (selector === 'button, [role="button"]') return controls;
      if (selector === '[data-testid="stop-button"], button[aria-label="Stop"]') {
        return controls.filter(
          (control) =>
            control.getAttribute("aria-label") === "Stop" ||
            control.getAttribute("data-testid") === "stop-button",
        );
      }
      return [];
    },
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
  test.each<Record<string, string>>([{ "aria-label": "Stop" }, { "data-testid": "stop-button" }])(
    "reports activity for the composer stop control %j without clicking it",
    async (attributes) => {
      const active = await evaluateThinkingStatus([""], attributes);
      const hidden = await evaluateThinkingStatus([""], attributes, false);

      expect(active.snapshot).toMatchObject({ message: "active", source: "inline" });
      expect(active.controls[0].click).not.toHaveBeenCalled();
      expect(hidden.snapshot).toBeNull();
    },
  );

  test("reports active tool work with only Stop answering visible", async () => {
    const { snapshot, controls } = await evaluateThinkingStatus(["Stop answering"]);
    expect(snapshot).toMatchObject({ message: "active", source: "inline" });
    expect(controls[0].click).not.toHaveBeenCalled();
  });

  test("reports the passive Pro gate only while both controls are visible", async () => {
    const active = await evaluateThinkingStatus(["Answer now", "Stop answering"]);
    const current = await evaluateThinkingStatus(["Answer now", ""], { "aria-label": "Stop" });
    const incomplete = await evaluateThinkingStatus(["Answer now"]);

    expect(active.snapshot).toMatchObject({ message: "pro gate active", source: "inline" });
    expect(active.controls.every((control) => control.click.mock.calls.length === 0)).toBe(true);
    expect(current.snapshot).toMatchObject({ message: "pro gate active", source: "inline" });
    expect(current.controls.every((control) => control.click.mock.calls.length === 0)).toBe(true);
    expect(incomplete.snapshot).toBeNull();
  });
});
