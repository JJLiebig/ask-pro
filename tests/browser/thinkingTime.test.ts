import { performance } from "node:perf_hooks";
import { createContext, Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  buildThinkingTimeExpressionForTest,
  ensureThinkingTime,
} from "../../src/browser/actions/thinkingTime.js";

class FakeKeyboardEvent extends Event {
  readonly key: string;

  constructor(type: string, options: { key: string; bubbles?: boolean }) {
    super(type, options);
    this.key = options.key;
  }
}

class FakeElement extends EventTarget {
  parentElement: FakeElement | null = null;

  private readonly attrs = new Map<string, string>();

  constructor(
    public textContent = "",
    attrs: Record<string, string> = {},
    private readonly children: FakeElement[] = [],
    private readonly onClick?: () => void,
    private readonly onEvent?: (event: Event) => void,
  ) {
    super();
    for (const [key, value] of Object.entries(attrs)) {
      this.attrs.set(key, value);
    }
    for (const child of children) {
      child.parentElement = this;
    }
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }

  getBoundingClientRect() {
    if (this.attrs.get("data-hidden") === "true") {
      return { height: 0, width: 0 };
    }
    return { height: 32, width: 160 };
  }

  contains(node: FakeElement) {
    for (let current: FakeElement | null = node; current; current = current.parentElement) {
      if (current === this) {
        return true;
      }
    }
    return false;
  }

  closest(selector: string): FakeElement | null {
    const className = this.getAttribute("class") ?? "";
    if (
      selector.includes("data-reasoning-slider") &&
      this.getAttribute("data-reasoning-slider") === "true"
    ) {
      return this;
    }
    if (
      selector.includes("model-picker-thinking-effort-row") &&
      className.includes("model-picker-thinking-effort-row")
    ) {
      return this;
    }
    if (
      selector.includes("data-radix-collection-item") &&
      this.getAttribute("data-radix-collection-item")
    ) {
      return this;
    }
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        const testId = child.getAttribute("data-testid") ?? "";
        const ariaChecked = child.getAttribute("aria-checked");
        const role = child.getAttribute("role");
        if (
          selector === "*" ||
          (selector.includes('[aria-checked="true"]') && ariaChecked === "true") ||
          (selector.includes("data-model-picker-thinking-effort-action") &&
            child.getAttribute("data-model-picker-thinking-effort-action") === "true") ||
          (selector.includes("model-switcher-") && testId.includes("model-switcher-")) ||
          (selector.includes('role="button"') && role === "button") ||
          (selector.includes('role="radio"') && role === "radio") ||
          (selector.includes('role="combobox"') && role === "combobox") ||
          (selector.includes('role="option"') && role === "option") ||
          (selector.includes('role="slider"') && role === "slider") ||
          (selector.includes("menuitem") && role?.includes("menuitem"))
        ) {
          results.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  dispatchEvent(event: Event) {
    if (event.type === "click") {
      this.onClick?.();
    }
    this.onEvent?.(event);
    return super.dispatchEvent(event);
  }

  focus() {
    return undefined;
  }
}

class FakeDocument extends EventTarget {
  private readonly byId = new Map<string, FakeElement>();

  constructor(
    public modelButton: FakeElement,
    private readonly trailingButtons: FakeElement[],
    menusById: Record<string, FakeElement>,
    readonly roots: FakeElement[] = [],
    readonly menus: FakeElement[] = [],
    private readonly inputCandidates: FakeElement[] = [],
  ) {
    super();
    for (const [id, element] of Object.entries(menusById)) {
      this.byId.set(id, element);
      this.menus.push(element);
    }
  }

  getElementById(id: string) {
    return this.byId.get(id) ?? null;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    const fromRoots = (roots: FakeElement[]) => [
      ...roots,
      ...roots.flatMap((root) => root.querySelectorAll(selector)),
    ];
    if (selector.includes('button.__composer-pill[aria-haspopup="menu"]')) {
      return [this.modelButton];
    }
    if (
      selector.includes("prompt-textarea") ||
      selector.includes("contenteditable") ||
      selector.includes("textarea")
    ) {
      return this.inputCandidates;
    }
    if (selector.includes("data-model-picker-thinking-effort-action")) {
      const extra = selector.includes("model-configure-modal") ? fromRoots(this.roots) : [];
      return [...this.trailingButtons, ...extra];
    }
    if (selector.includes('role="dialog"') || selector.includes('data-state="open"')) {
      return this.roots.filter(
        (node) =>
          node.getAttribute("role") === "dialog" || node.getAttribute("data-state") === "open",
      );
    }
    if (
      selector.includes('role="menu"') ||
      selector.includes("data-radix-collection-root") ||
      selector.includes('role="listbox"') ||
      selector.includes('role="group"')
    ) {
      return this.menus;
    }
    if (
      selector.includes("model-configure-modal") ||
      selector.includes('role="menuitem"') ||
      selector.includes('role="option"') ||
      selector.includes('role="radio"') ||
      selector.includes("button")
    ) {
      return fromRoots([...this.roots, ...this.menus]);
    }
    return [];
  }

  dispatchEvent(event: Event) {
    return super.dispatchEvent(event);
  }
}

const runThinkingTimeExpression = async (
  document: FakeDocument,
  level: "heavy" | "extended" | "standard" | "pro",
  options: { fastTimeout?: boolean } = {},
) => {
  let now = 0;
  const context = createContext({
    document,
    EventTarget,
    HTMLElement: FakeElement,
    KeyboardEvent: FakeKeyboardEvent,
    MouseEvent: Event,
    performance: options.fastTimeout
      ? {
          now: () => {
            now += 9_000;
            return now;
          },
        }
      : performance,
    setTimeout: options.fastTimeout
      ? (callback: () => void) => {
          callback();
          return 0;
        }
      : setTimeout,
    Event,
    InputEvent: Event,
    window: {},
  });
  return await new Script(buildThinkingTimeExpressionForTest(level)).runInContext(context);
};

describe("browser thinking-time selection expression", () => {
  it("fails closed when Pro intelligence is unavailable", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: "option-not-found" } } }),
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(ensureThinkingTime(Runtime as never, "pro", logger)).rejects.toThrow(
      "Unable to select Pro intelligence: option not found.",
    );
  });

  it("uses centralized menu selectors and normalized matching", () => {
    const expression = buildThinkingTimeExpressionForTest();
    expect(expression).toContain("const MENU_CONTAINER_SELECTOR");
    expect(expression).toContain("const MENU_ITEM_SELECTOR");
    expect(expression).toContain('role=\\"menu\\"');
    expect(expression).toContain("data-radix-collection-root");
    expect(expression).toContain('role=\\"menuitem\\"');
    expect(expression).toContain('role=\\"menuitemradio\\"');
    expect(expression).toContain("normalize");
    expect(expression).toContain("extended");
    expect(expression).toContain("standard");
    expect(expression).toContain("MODEL_BUTTON_SELECTOR");
    expect(expression).toContain("data-model-picker-thinking-effort-action");
    expect(expression).toContain("aria-controls");
    expect(expression).toContain('button.__composer-pill[aria-haspopup="menu"]');
    expect(expression).toContain("EFFORT_LABELS.has(text)");
    expect(expression).toContain("aria === 'pro' || text === 'pro'");
    expect(expression).toContain("const findModelButton = () =>");
    expect(expression).toContain("score += 1000");
    expect(expression).toContain("const isEffortOnly = label === 'pro' || label === 'thinking'");
    expect(expression).toContain("className.includes('__composer-pill')");
    expect(expression).toContain("findEffortRow");
    expect(expression).toContain("modelKindFromTestId");
    expect(expression).toContain("best.score >= 100");
  });

  it("targets the requested thinking time level", () => {
    const levels = ["light", "standard", "extended", "heavy"] as const;
    for (const level of levels) {
      const expression = buildThinkingTimeExpressionForTest(level);
      expect(expression).toContain("const TARGET_LEVEL");
      expect(expression).toContain(`"${level}"`);
    }
  });

  it("keeps polling the old effort menu when the menu itself has open state", async () => {
    let extendedClicked = false;
    const modelButton = new FakeElement(
      "Standard",
      {
        "aria-haspopup": "menu",
        class: "__composer-pill __composer-pill--neutral",
      },
      [],
      () => {
        document.menus.push(
          new FakeElement("Standard Extended", { "data-state": "open", role: "menu" }, [
            new FakeElement("Pro Extended", { role: "menuitemradio" }, [], () => {
              extendedClicked = true;
            }),
          ]),
        );
      },
    );
    const document = new FakeDocument(modelButton, [], {});

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "switched", label: "Pro Extended" });
    expect(extendedClicked).toBe(true);
  });

  it("selects Extended through Configure / Pro thinking effort", async () => {
    let configureClicked = false;
    let proClicked = false;
    let effortClicked = false;
    let extendedClicked = false;
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const configure = new FakeElement(
      "Configure...",
      { "data-testid": "model-configure-modal", role: "menuitem" },
      [],
      () => {
        configureClicked = true;
        document.roots.push(dialog);
      },
    );
    const proRow = new FakeElement(
      "Pro",
      {
        "aria-checked": "false",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "option",
      },
      [],
      () => {
        proClicked = true;
        proRow.setAttribute("aria-checked", "true");
      },
    );
    const extendedOption = new FakeElement("Extended", { role: "option" }, [], () => {
      extendedClicked = true;
    });
    const effortMenu = new FakeElement("Standard Extended", { role: "listbox" }, [extendedOption]);
    const effortControl = new FakeElement(
      "Standard",
      { "aria-label": "Pro thinking effort", role: "button" },
      [],
      () => {
        effortClicked = true;
        document.menus.push(effortMenu);
      },
    );
    const dialog = new FakeElement("Models Pro thinking effort Standard", { role: "dialog" }, [
      proRow,
      effortControl,
    ]);
    const document = new FakeDocument(modelButton, [], {}, [configure]);

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "switched", label: "Extended" });
    expect(configureClicked).toBe(true);
    expect(proClicked).toBe(true);
    expect(effortClicked).toBe(true);
    expect(extendedClicked).toBe(true);
  });

  it("selects Länger through German Configure / Denkaufwand Pro", async () => {
    let configureClicked = false;
    let effortClicked = false;
    let extendedClicked = false;
    const modelButton = new FakeElement("Länger Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const configure = new FakeElement(
      "Konfigurieren...",
      { "data-testid": "model-configure-modal", role: "menuitem" },
      [],
      () => {
        configureClicked = true;
        document.roots.push(dialog);
      },
    );
    const proRow = new FakeElement("Pro 5.5 Intelligenz auf höchstem Niveau", {
      "aria-checked": "true",
      "data-testid": "model-switcher-gpt-5-5-pro",
      role: "radio",
    });
    const longerOption = new FakeElement("Länger", { role: "option" }, [], () => {
      extendedClicked = true;
    });
    const effortMenu = new FakeElement("Standard Länger", { role: "listbox" }, [longerOption]);
    const effortControl = new FakeElement(
      "Länger",
      { "aria-label": "Denkaufwand Pro", role: "combobox" },
      [],
      () => {
        effortClicked = true;
        document.menus.push(effortMenu);
      },
    );
    const dialog = new FakeElement(
      "Intelligenz Modell Pro 5.5 Denkaufwand Pro Länger",
      { role: "dialog" },
      [proRow, effortControl],
    );
    const document = new FakeDocument(modelButton, [], {}, [configure]);

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "already-selected", label: "Länger" });
    expect(configureClicked).toBe(true);
    expect(effortClicked).toBe(false);
    expect(extendedClicked).toBe(false);
  });

  it("opens the effort menu for the currently selected model row", async () => {
    let thinkingClicked = false;
    let proClicked = false;
    let extendedClicked = false;
    const modelButton = new FakeElement("Standard Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "aria-controls": "thinking-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        thinkingClicked = true;
      },
    );
    const proTrailing = new FakeElement(
      "",
      {
        "aria-controls": "pro-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        proClicked = true;
      },
    );
    new FakeElement(
      "Thinking Heavy",
      { class: "group/model-picker-thinking-effort-row relative" },
      [
        new FakeElement("Thinking Heavy", {
          "aria-checked": "false",
          "data-testid": "model-switcher-gpt-5-5-thinking",
          role: "menuitemradio",
        }),
        thinkingTrailing,
      ],
    );
    new FakeElement("Pro Extended", { class: "group/model-picker-thinking-effort-row relative" }, [
      new FakeElement("Pro Extended", {
        "aria-checked": "true",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "menuitemradio",
      }),
      proTrailing,
    ]);
    const extendedOption = new FakeElement("Extended", { role: "menuitemradio" }, [], () => {
      extendedClicked = true;
    });
    const document = new FakeDocument(modelButton, [thinkingTrailing, proTrailing], {
      "pro-effort": new FakeElement("Standard Extended", { role: "menu" }, [extendedOption]),
    });

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "switched", label: "Extended" });
    expect(thinkingClicked).toBe(false);
    expect(proClicked).toBe(true);
    expect(extendedClicked).toBe(true);
  });

  it("opens the selected Pro trailing effort control when the composer pill is effort-only", async () => {
    let proClicked = false;
    let extendedClicked = false;
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const proTrailing = new FakeElement(
      "",
      {
        "aria-controls": "pro-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        proClicked = true;
      },
    );
    new FakeElement("Pro Standard", { class: "group/model-picker-thinking-effort-row relative" }, [
      new FakeElement("Pro Standard", {
        "aria-checked": "true",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "menuitemradio",
      }),
      proTrailing,
    ]);
    const extendedOption = new FakeElement("Extended", { role: "menuitemradio" }, [], () => {
      extendedClicked = true;
    });
    const document = new FakeDocument(modelButton, [proTrailing], {
      "pro-effort": new FakeElement("Standard Extended", { role: "menu" }, [extendedOption]),
    });

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "switched", label: "Extended" });
    expect(proClicked).toBe(true);
    expect(extendedClicked).toBe(true);
  });

  it("selects Pro from the current GPT-5.6 Intelligence picker", async () => {
    let proClicked = false;
    const modelButton = new FakeElement("High", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const proOption = new FakeElement(
      "Pro",
      { "aria-checked": "false", role: "menuitemradio" },
      [],
      () => {
        proClicked = true;
      },
    );
    const menu = new FakeElement(
      "Intelligence Instant Medium High Pro GPT-5.6 Sol",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Instant", { role: "menuitemradio" }),
        new FakeElement("Medium", { role: "menuitemradio" }),
        new FakeElement("High", { role: "menuitemradio" }),
        proOption,
        new FakeElement("GPT-5.6 Sol", { role: "menuitem" }),
      ],
    );
    const document = new FakeDocument(modelButton, [], {}, [], [menu]);

    const result = await runThinkingTimeExpression(document, "pro");

    expect(result).toEqual({ status: "switched", label: "Pro" });
    expect(proClicked).toBe(true);
  });

  it("selects Pro from the current model-picker power slider", async () => {
    let rightPressed = false;
    const modelButton = new FakeElement("High", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const slider = new FakeElement("", {
      "aria-valuemax": "4",
      "aria-valuemin": "0",
      "aria-valuenow": "3",
      role: "slider",
    });
    const power = new FakeElement(
      "",
      { "data-reasoning-slider": "true", role: "menuitem" },
      [new FakeElement("", { "data-model-picker-power-slider": "" }, [slider])],
      undefined,
      (event) => {
        if (event.type !== "keydown" || (event as KeyboardEvent).key !== "ArrowRight") return;
        rightPressed = true;
        slider.setAttribute("aria-valuenow", "4");
      },
    );
    const menu = new FakeElement("6 Pro Power Latest", { role: "menu" }, [power]);
    const document = new FakeDocument(modelButton, [], {}, [], [menu]);

    const result = await runThinkingTimeExpression(document, "pro");

    expect(result).toEqual({ status: "switched", label: "Pro" });
    expect(rightPressed).toBe(true);
  });

  it("keeps fallback paths when the current Intelligence menu is unmatched", async () => {
    let extendedClicked = false;
    const modelButton = new FakeElement("Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const currentMenu = new FakeElement(
      "Intelligence Custom5s Balanced30s Deep60s",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Custom5s", { role: "menuitemradio" }),
        new FakeElement("Balanced30s", { role: "menuitemradio" }),
        new FakeElement("Deep60s", { role: "menuitemradio" }),
      ],
    );
    const legacyMenu = new FakeElement("Standard Extended", { role: "menu" }, [
      new FakeElement("Extended", { role: "menuitemradio" }, [], () => {
        extendedClicked = true;
      }),
    ]);
    const document = new FakeDocument(modelButton, [], {}, [], [currentMenu, legacyMenu]);

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "switched", label: "Extended" });
    expect(extendedClicked).toBe(true);
  });

  it("matches localized current Intelligence extended aliases", async () => {
    const modelButton = new FakeElement("Länger Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const longerOption = new FakeElement("Länger5+ min", {
      "aria-checked": "true",
      role: "menuitemradio",
    });
    const menu = new FakeElement(
      "Intelligence Sofort5s Mittel5-30s Hoch15-60s Länger5+ min GPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Sofort5s", { role: "menuitemradio" }),
        new FakeElement("Mittel5-30s", { role: "menuitemradio" }),
        new FakeElement("Hoch15-60s", { role: "menuitemradio" }),
        longerOption,
        new FakeElement("GPT-5.5", { role: "menuitem" }),
      ],
    );
    const document = new FakeDocument(modelButton, [], {}, [], [menu]);

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "already-selected", label: "Länger5+ min" });
  });

  it("wakes the hidden composer model picker before selecting an effort", async () => {
    let proClicked = false;
    let extendedClicked = false;
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const hiddenModelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
      "data-hidden": "true",
    });
    const input = new FakeElement(
      "",
      { contenteditable: "true", role: "textbox" },
      [],
      undefined,
      (event) => {
        if (event.type !== "input") return;
        if (input.textContent.includes("ask-pro model selection")) {
          document.modelButton = modelButton;
        }
      },
    );
    const proTrailing = new FakeElement(
      "",
      {
        "aria-controls": "pro-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        proClicked = true;
      },
    );
    new FakeElement("Pro Standard", { class: "group/model-picker-thinking-effort-row relative" }, [
      new FakeElement("Pro Standard", {
        "aria-checked": "true",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "menuitemradio",
      }),
      proTrailing,
    ]);
    const extendedOption = new FakeElement("Extended", { role: "menuitemradio" }, [], () => {
      extendedClicked = true;
    });
    const document = new FakeDocument(
      hiddenModelButton,
      [proTrailing],
      {
        "pro-effort": new FakeElement("Standard Extended", { role: "menu" }, [extendedOption]),
      },
      [],
      [],
      [input],
    );

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "switched", label: "Extended" });
    expect(proClicked).toBe(true);
    expect(extendedClicked).toBe(true);
    expect(input.textContent).toBe("");
  });

  it("resolves a trailing effort listbox without aria-controls", async () => {
    let extendedClicked = false;
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const proTrailing = new FakeElement(
      "",
      {
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
        role: "menuitem",
      },
      [],
    );
    new FakeElement("Pro Standard", { class: "group/model-picker-thinking-effort-row relative" }, [
      new FakeElement("Pro Standard", {
        "aria-checked": "true",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "menuitemradio",
      }),
      proTrailing,
    ]);
    const extendedOption = new FakeElement("Extended", { role: "option" }, [], () => {
      extendedClicked = true;
    });
    const listbox = new FakeElement("Standard Extended", { role: "listbox" }, [extendedOption]);
    const document = new FakeDocument(modelButton, [proTrailing], {}, [], [listbox]);

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "switched", label: "Extended" });
    expect(extendedClicked).toBe(true);
  });

  it("does not click an arbitrary trailing effort control when the current row is ambiguous", async () => {
    let thinkingClicked = false;
    let proClicked = false;
    const modelButton = new FakeElement("Heavy", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "aria-controls": "thinking-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        thinkingClicked = true;
      },
    );
    const proTrailing = new FakeElement(
      "",
      {
        "aria-controls": "pro-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        proClicked = true;
      },
    );
    new FakeElement(
      "Thinking Heavy",
      { class: "group/model-picker-thinking-effort-row relative" },
      [
        new FakeElement("Thinking Heavy", {
          "aria-checked": "false",
          "data-testid": "model-switcher-gpt-5-5-thinking",
          role: "menuitemradio",
        }),
        thinkingTrailing,
      ],
    );
    new FakeElement("Pro Extended", { class: "group/model-picker-thinking-effort-row relative" }, [
      new FakeElement("Pro Extended", {
        "aria-checked": "false",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "menuitemradio",
      }),
      proTrailing,
    ]);
    const document = new FakeDocument(modelButton, [thinkingTrailing, proTrailing], {
      "thinking-effort": new FakeElement("Standard Extended Heavy", { role: "menu" }, []),
      "pro-effort": new FakeElement("Standard Extended", { role: "menu" }, []),
    });

    const result = await runThinkingTimeExpression(document, "heavy", { fastTimeout: true });

    expect(result).toEqual({ status: "option-not-found" });
    expect(thinkingClicked).toBe(false);
    expect(proClicked).toBe(false);
  });

  it("does not trust a single trailing effort control from another model row", async () => {
    let thinkingClicked = false;
    const modelButton = new FakeElement("Standard Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "aria-controls": "thinking-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        thinkingClicked = true;
      },
    );
    new FakeElement(
      "Thinking Heavy",
      { class: "group/model-picker-thinking-effort-row relative" },
      [
        new FakeElement("Thinking Heavy", {
          "aria-checked": "false",
          "data-testid": "model-switcher-gpt-5-5-thinking",
          role: "menuitemradio",
        }),
        thinkingTrailing,
      ],
    );
    const document = new FakeDocument(modelButton, [thinkingTrailing], {
      "thinking-effort": new FakeElement("Standard Extended Heavy", { role: "menu" }, []),
    });

    const result = await runThinkingTimeExpression(document, "heavy", { fastTimeout: true });

    expect(result).toEqual({ status: "option-not-found" });
    expect(thinkingClicked).toBe(false);
  });

  it("does not treat the thinking-effort suffix as Thinking model evidence", async () => {
    let proClicked = false;
    const modelButton = new FakeElement("Thinking", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const proTrailing = new FakeElement(
      "",
      {
        "aria-controls": "pro-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        proClicked = true;
      },
    );
    new FakeElement("Pro Extended", { class: "group/model-picker-thinking-effort-row relative" }, [
      new FakeElement("Pro Extended", {
        "aria-checked": "false",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "menuitemradio",
      }),
      proTrailing,
    ]);
    const document = new FakeDocument(modelButton, [proTrailing], {
      "pro-effort": new FakeElement("Standard Extended", { role: "menu" }, []),
    });

    const result = await runThinkingTimeExpression(document, "extended", { fastTimeout: true });

    expect(result).toEqual({ status: "option-not-found" });
    expect(proClicked).toBe(false);
  });

  it("does not use effort-label overlap as current-row proof", async () => {
    let thinkingClicked = false;
    const modelButton = new FakeElement("Pro Extended", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "aria-controls": "thinking-effort",
        "data-model-picker-thinking-effort-action": "true",
        role: "menuitem",
      },
      [],
      () => {
        thinkingClicked = true;
      },
    );
    new FakeElement(
      "Thinking Extended",
      { class: "group/model-picker-thinking-effort-row relative" },
      [
        new FakeElement("Thinking Extended", {
          "aria-checked": "false",
          role: "menuitemradio",
        }),
        thinkingTrailing,
      ],
    );
    const document = new FakeDocument(modelButton, [thinkingTrailing], {
      "thinking-effort": new FakeElement("Standard Extended Heavy", { role: "menu" }, []),
    });

    const result = await runThinkingTimeExpression(document, "extended", { fastTimeout: true });

    expect(result).toEqual({ status: "option-not-found" });
    expect(thinkingClicked).toBe(false);
  });
});
