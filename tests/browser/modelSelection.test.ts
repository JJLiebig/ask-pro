import { performance } from "node:perf_hooks";
import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildModelMatchersLiteralForTest,
  buildModelSelectionExpressionForTest,
} from "../../src/browser/actions/modelSelection.js";
import { mapChatGptModelToBrowserLabel } from "../../src/browser/chatgptModelCatalog.js";

const expectContains = (arr: string[], value: string) => {
  expect(arr).toContain(value);
};

class FakeElement extends EventTarget {
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

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return this.children;
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
  readonly body: { innerText: string };
  readonly title: string;

  constructor(
    private readonly modelCandidates: FakeElement[] = [],
    readonly menus: FakeElement[] = [],
    private readonly inputCandidates: FakeElement[] = [],
    private readonly temporaryControls: FakeElement[] = [],
    pageCopy: { body?: string; title?: string } = {},
  ) {
    super();
    this.body = { innerText: pageCopy.body ?? "" };
    this.title = pageCopy.title ?? "";
  }

  querySelector(selector: string) {
    if (selector.includes('[role="menu"]') || selector.includes("data-radix-collection-root")) {
      return this.menus[0] ?? null;
    }
    if (
      selector.includes("prompt-textarea") ||
      selector.includes("contenteditable") ||
      selector.includes("textarea")
    ) {
      return this.inputCandidates[0] ?? null;
    }
    return null;
  }

  querySelectorAll(selector: string) {
    if (
      selector.includes('data-testid="model-switcher-dropdown-button"') ||
      selector.includes('aria-label="Select ChatGPT model"') ||
      selector.includes("__composer-pill")
    ) {
      return this.modelCandidates.filter(
        (node) =>
          (selector.includes('data-testid="model-switcher-dropdown-button"') &&
            node.getAttribute("data-testid") === "model-switcher-dropdown-button") ||
          (selector.includes('aria-label="Select ChatGPT model"') &&
            node.getAttribute("aria-label") === "Select ChatGPT model") ||
          (selector.includes("__composer-pill") &&
            node.getAttribute("class")?.includes("__composer-pill")),
      );
    }
    if (selector.includes('[role="menu"]') || selector.includes("data-radix-collection-root")) {
      return this.menus;
    }
    if (
      selector.includes("prompt-textarea") ||
      selector.includes("contenteditable") ||
      selector.includes("textarea")
    ) {
      return this.inputCandidates;
    }
    if (selector.includes('input[type="checkbox"]')) {
      return this.temporaryControls;
    }
    return [];
  }
}

const runModelSelectionExpression = async (
  targetModel: string,
  document: FakeDocument,
  options: { fastTimeout?: boolean; href?: string; strategy?: "select" | "current" } = {},
) => {
  const expression = buildModelSelectionExpressionForTest(targetModel, options.strategy);
  let now = 0;
  const context = createContext({
    document,
    EventTarget,
    HTMLElement: FakeElement,
    KeyboardEvent: Event,
    MouseEvent: Event,
    performance: options.fastTimeout
      ? {
          now: () => {
            now += 25_000;
            return now;
          },
        }
      : performance,
    setTimeout: options.fastTimeout
      ? (callback: () => void) => {
          setTimeout(callback, 0);
          return 0;
        }
      : setTimeout,
    Event,
    InputEvent: Event,
    URL,
    window: { location: { href: options.href ?? "https://chatgpt.com/" } },
  });
  return await new Script(expression).runInContext(context);
};

describe("browser model selection matchers", () => {
  it("uses the current ChatGPT model control when Latest is selected", async () => {
    const button = new FakeElement("Thinking effortPro", {
      "aria-label": "Select ChatGPT model",
      "aria-haspopup": "menu",
    });
    const latest = new FakeElement("Latest", { role: "menuitemradio", "aria-checked": "true" });
    const menu = new FakeElement("", { role: "menu" }, [latest]);

    expect(await runModelSelectionExpression("Latest", new FakeDocument([button], [menu]))).toEqual(
      {
        status: "already-selected",
        label: "Latest",
      },
    );
  });

  it.each([false, true])(
    "selects the literal Latest option (already selected: %s)",
    async (selected) => {
      let clicks = 0;
      const pill = new FakeElement("6 Pro", { class: "__composer-pill", "aria-haspopup": "menu" });
      const latest = new FakeElement(
        "Latest",
        { role: "menuitemradio", "aria-checked": String(selected) },
        [],
        () => {
          clicks += 1;
          latest.setAttribute("aria-checked", "true");
        },
      );
      const menu = new FakeElement("", {}, [
        new FakeElement("GPT-5.6 Sol", { "aria-checked": String(!selected) }),
        latest,
      ]);
      const result = await runModelSelectionExpression("Latest", new FakeDocument([pill], [menu]));
      expect(result).toEqual({
        status: selected ? "already-selected" : "switched",
        label: "Latest",
      });
      expect(clicks).toBe(selected ? 0 : 1);
    },
  );

  it("does not accept a dated model when Latest is missing", async () => {
    const pill = new FakeElement("GPT-5.6 Sol", {
      "data-testid": "model-switcher-dropdown-button",
    });
    const menu = new FakeElement("", {}, [
      new FakeElement("GPT-5.6 Sol", { "aria-checked": "true" }),
    ]);
    const result = await runModelSelectionExpression("Latest", new FakeDocument([pill], [menu]), {
      fastTimeout: true,
    });
    expect(result.status).toBe("option-not-found");
  });

  it("keeps retained model labels version-specific", () => {
    expect(mapChatGptModelToBrowserLabel("gpt-5.5-pro")).toBe("GPT-5.5 Pro");
  });

  it("includes pro + 5.4 tokens for gpt-5.4-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.4-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.4") || t.includes("5-4"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.4-pro") || t.includes("gpt-5-4-pro"))).toBe(
      true,
    );
  });

  it("requires a 5.6 label match for gpt-5.6-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.6-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.6") || t.includes("5-6"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.6-pro") || t.includes("gpt-5-6-pro"))).toBe(
      true,
    );

    const expression = buildModelSelectionExpressionForTest("gpt-5.6-pro");
    expect(expression).toContain('const TARGET_VERSION = "5-6"');
    expect(expression).toContain('const TARGET_KIND = "pro"');
    expect(expression).toContain("const VERSION_PATTERNS");
    expect(expression).toContain("const findModelButton = () =>");
    expect(expression).toContain("score += 1000");
    expect(expression).toContain("const isEffortOnly = label === 'pro' || label === 'thinking'");
    expect(expression).toContain("matchesVisibleAlias");
    expect(expression).toContain("best.score >= 100");
    expect(expression).toContain(
      "return { status: 'button-missing', hint: { temporaryChat: detectTemporaryChat() } }",
    );
    expect(expression).toContain("candidateTextVersion && candidateTextVersion !== desiredVersion");
    expect(expression).toContain(
      "candidateTestIdVersion && candidateTestIdVersion !== desiredVersion",
    );
    expect(expression).toContain("!candidateVisibleAlias");
  });

  it("reports temporary chat evidence when the model button is missing", async () => {
    const result = await runModelSelectionExpression("gpt-5.5-pro", new FakeDocument([]), {
      fastTimeout: true,
      href: "https://chatgpt.com/?temporary-chat=true",
    });

    expect(result).toEqual({ status: "button-missing", hint: { temporaryChat: true } });
  });

  it("requires state-bearing evidence instead of general temporary chat copy", async () => {
    const pageCopyOnly = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([], [], [], [], {
        body: "Temporary Chat keeps this conversation out of history.",
        title: "Temporary Chat overview",
      }),
      { fastTimeout: true },
    );
    const selectedControl = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([], [], [], [new FakeElement("Temporary Chat", { "aria-pressed": "true" })]),
      { fastTimeout: true },
    );

    expect(pageCopyOnly).toEqual({ status: "button-missing", hint: { temporaryChat: false } });
    expect(selectedControl).toEqual({ status: "button-missing", hint: { temporaryChat: true } });
  });

  it("does not poll for a missing picker when using the current strategy", async () => {
    const result = await runModelSelectionExpression("gpt-5.5-pro", new FakeDocument([]), {
      strategy: "current",
    });

    expect(result).toEqual({ status: "already-selected", label: "current model" });
  });

  it("accepts a generic Pro pill as the latest Pro target", async () => {
    const proChip = new FakeElement("Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const result = await runModelSelectionExpression("gpt-5.5-pro", new FakeDocument([proChip]), {
      fastTimeout: true,
    });

    expect(result).toEqual({ status: "already-selected", label: "Pro" });
  });

  it("waits for ChatGPT's delayed composer pill before reporting a missing picker", async () => {
    const modelCandidates: FakeElement[] = [];
    setTimeout(() => {
      modelCandidates.push(
        new FakeElement("Pro Extended", {
          "aria-haspopup": "menu",
          class: "__composer-pill __composer-pill--neutral",
        }),
      );
    }, 25);

    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument(modelCandidates),
    );

    expect(result).toEqual({ status: "already-selected", label: "Pro Extended" });
  });

  it("retries the hidden composer wake while waiting for a delayed picker", async () => {
    const modelCandidates: FakeElement[] = [];
    const inputCandidates: FakeElement[] = [];
    const modelButton = new FakeElement("Model", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const input = new FakeElement(
      "",
      { contenteditable: "true", role: "textbox" },
      [],
      undefined,
      (event) => {
        if (event.type !== "input") return;
        if (input.textContent.includes("ask-pro model selection")) {
          modelCandidates.splice(0, modelCandidates.length, modelButton);
        }
      },
    );
    setTimeout(() => inputCandidates.push(input), 25);
    const option = new FakeElement("Pro Extended", {}, [], () => {
      modelButton.textContent = "Pro Extended";
      option.setAttribute("aria-checked", "true");
    });
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument(modelCandidates, [menu], inputCandidates),
    );

    expect(result).toEqual({ status: "switched", label: "Pro Extended" });
    expect(input.textContent).toBe("");
  });

  it("does not treat Projects as a generic Pro option", async () => {
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement("Projects", {}, [], () => {
      modelButton.textContent = "Projects";
    });
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([modelButton], [menu]),
      { fastTimeout: true },
    );

    expect(result).toMatchObject({ status: "option-not-found" });
  });

  it("selects the current visible Pro target from the split latest 5.5 picker", async () => {
    const modelButton = new FakeElement("Heavy", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement("Pro", {}, [], () => {
      modelButton.textContent = "Pro";
    });
    const menu = new FakeElement("Latest • 5.5 Instant Thinking • Heavy Pro Configure...", {}, [
      new FakeElement("Latest • 5.5"),
      new FakeElement("Instant"),
      new FakeElement("Thinking • Heavy"),
      option,
      new FakeElement("Configure..."),
    ]);

    const result = await runModelSelectionExpression(
      "Pro",
      new FakeDocument([modelButton], [menu]),
    );

    expect(result).toEqual({ status: "switched", label: "Pro" });
  });

  it("selects GPT-5.6 Sol from the bottom of the Intelligence picker", async () => {
    let submenuClicked = false;
    let modelClicked = false;
    const modelButton = new FakeElement("High", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const submenu = new FakeElement(
      "GPT-5.6 Sol",
      {
        "aria-haspopup": "menu",
        "data-has-submenu": "",
        role: "menuitem",
      },
      [],
      () => {
        submenuClicked = true;
      },
    );
    const option = new FakeElement(
      "GPT-5.6 Sol",
      { "aria-checked": "false", role: "menuitemradio" },
      [],
      () => {
        modelClicked = true;
        option.setAttribute("aria-checked", "true");
      },
    );
    const menu = new FakeElement("Intelligence Instant Medium High Pro GPT-5.6 Sol", {}, [
      new FakeElement("Instant", { role: "menuitemradio" }),
      new FakeElement("Medium", { role: "menuitemradio" }),
      new FakeElement("High", { role: "menuitemradio" }),
      new FakeElement("Pro", { role: "menuitemradio" }),
      submenu,
      option,
    ]);

    const result = await runModelSelectionExpression(
      "GPT-5.6 Sol",
      new FakeDocument([modelButton], [menu]),
    );

    expect(result).toEqual({ status: "switched", label: "GPT-5.6 Sol" });
    expect(submenuClicked).toBe(false);
    expect(modelClicked).toBe(true);
  });

  it("accepts Pro Extended when the picker closes but the pill stays effort-only", async () => {
    const modelButton = new FakeElement("Heavy", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const document = new FakeDocument([modelButton]);
    const option = new FakeElement("Pro • Extended", {}, [], () => {
      document.menus.length = 0;
    });
    document.menus.push(
      new FakeElement(
        "Latest • 5.5 Instant Thinking • Heavy Pro • Extended Configure...",
        {
          role: "menu",
        },
        [
          new FakeElement("Latest • 5.5"),
          new FakeElement("Instant"),
          new FakeElement("Thinking • Heavy"),
          option,
          new FakeElement("Configure..."),
        ],
      ),
    );

    const result = await runModelSelectionExpression("Pro", document);

    expect(result).toEqual({ status: "switched", label: "Pro • Extended" });
  });

  it("does not accept Pro Extended when the picker stays open without selected evidence", async () => {
    const modelButton = new FakeElement("Heavy", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement("Pro • Extended");
    const menu = new FakeElement(
      "Latest • 5.5 Instant Thinking • Heavy Pro • Extended",
      {
        role: "menu",
      },
      [
        new FakeElement("Latest • 5.5"),
        new FakeElement("Instant"),
        new FakeElement("Thinking • Heavy"),
        option,
      ],
    );

    const result = await runModelSelectionExpression(
      "Pro",
      new FakeDocument([modelButton], [menu]),
      {
        fastTimeout: true,
      },
    );

    expect(result).toMatchObject({ status: "option-not-found" });
  });

  it("does not select Projects for the current visible Pro target", async () => {
    const modelButton = new FakeElement("Instant", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement("Projects", {}, [], () => {
      modelButton.textContent = "Projects";
    });
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "Pro",
      new FakeDocument([modelButton], [menu]),
      {
        fastTimeout: true,
      },
    );

    expect(result).toMatchObject({ status: "option-not-found" });
  });

  it("does not accept a visible effort chip as gpt-5.5-pro under select strategy", async () => {
    const effortChip = new FakeElement("Heavy", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([effortChip]),
      {
        fastTimeout: true,
      },
    );

    expect(result).toMatchObject({ status: "option-not-found" });
  });

  it("wakes the hidden composer model picker before selecting Pro", async () => {
    const hiddenModelButton = new FakeElement("Model", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
      "data-hidden": "true",
    });
    const modelCandidates: FakeElement[] = [hiddenModelButton];
    const modelButton = new FakeElement("Model", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const input = new FakeElement(
      "",
      { contenteditable: "true", role: "textbox" },
      [],
      undefined,
      (event) => {
        if (event.type !== "input") return;
        if (input.textContent.includes("ask-pro model selection")) {
          modelCandidates.splice(0, modelCandidates.length, modelButton);
        }
      },
    );
    const option = new FakeElement("Pro • Extended", {}, [], () => {
      modelButton.textContent = "Pro";
    });
    const menu = new FakeElement(
      "Latest • 5.5 Instant Thinking • Heavy Pro • Extended",
      {
        role: "menu",
      },
      [
        new FakeElement("Latest • 5.5"),
        new FakeElement("Instant"),
        new FakeElement("Thinking • Heavy"),
        option,
      ],
    );

    const result = await runModelSelectionExpression(
      "Pro",
      new FakeDocument(modelCandidates, [menu], [input]),
      { fastTimeout: true },
    );

    expect(result).toEqual({ status: "switched", label: "Pro" });
    expect(input.textContent).toBe("");
  });

  it("selects GPT-5.5 Pro from the composer-pill model picker DOM", async () => {
    const modelButton = new FakeElement("Heavy", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement(
      "Pro• Extended",
      { "data-testid": "model-switcher-gpt-5-5-pro" },
      [],
      () => {
        modelButton.textContent = "GPT-5.5 Pro";
        option.setAttribute("aria-checked", "true");
      },
    );
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([modelButton], [menu]),
    );

    expect(result).toEqual({ status: "switched", label: "GPT-5.5 Pro" });
  });

  it("selects GPT-5.5 Pro from the current composer pill without aria-haspopup", async () => {
    const modelButton = new FakeElement("Instant", {
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement(
      "Pro• Extended",
      { "data-testid": "model-switcher-gpt-5-5-pro" },
      [],
      () => {
        modelButton.textContent = "GPT-5.5 Pro";
        option.setAttribute("aria-checked", "true");
      },
    );
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([modelButton], [menu]),
    );

    expect(result).toEqual({ status: "switched", label: "GPT-5.5 Pro" });
  });

  it("selects GPT-5.5 Pro from the current visible Pro Extended label", async () => {
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement("Pro• Extended", {}, [], () => {
      modelButton.textContent = "Extended Pro";
      option.setAttribute("aria-checked", "true");
    });
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([modelButton], [menu]),
    );

    expect(result).toEqual({ status: "switched", label: "Extended Pro" });
  });

  it("accepts German Länger Pro as the current GPT-5.5 Pro label", async () => {
    const modelButton = new FakeElement("Länger Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });

    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([modelButton]),
    );

    expect(result).toEqual({ status: "already-selected", label: "Länger Pro" });
  });

  it("accepts terminal Pro row evidence when the composer pill remains effort-only", async () => {
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const document = new FakeDocument([modelButton]);
    const option = new FakeElement(
      "Pro Standard",
      { "data-testid": "model-switcher-gpt-5-5-pro" },
      [],
      () => {
        modelButton.textContent = "Standard";
        option.setAttribute("aria-checked", "true");
        document.menus.length = 0;
      },
    );
    document.menus.push(new FakeElement("", { role: "menu" }, [option]));

    const result = await runModelSelectionExpression("gpt-5.5-pro", document);

    expect(result).toEqual({ status: "switched", label: "Pro Standard" });
  });

  it("does not accept an ignored Pro row click while the composer pill remains effort-only", async () => {
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const document = new FakeDocument([modelButton]);
    const option = new FakeElement("Pro Standard", {
      "data-testid": "model-switcher-gpt-5-5-pro",
    });
    document.menus.push(new FakeElement("", { role: "menu" }, [option]));

    const result = await runModelSelectionExpression("gpt-5.5-pro", document, {
      fastTimeout: true,
    });

    expect(result).toMatchObject({ status: "option-not-found" });
  });

  it("selects Thinking 5.5 from the current visible Thinking Heavy label", async () => {
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement("Thinking• Heavy", {}, [], () => {
      modelButton.textContent = "Thinking Heavy";
      option.setAttribute("aria-checked", "true");
    });
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "Thinking 5.5",
      new FakeDocument([modelButton], [menu]),
    );

    expect(result).toEqual({ status: "switched", label: "Thinking Heavy" });
  });

  it("includes rich tokens for gpt-5.1", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.1");
    expectContains(labelTokens, "gpt-5.1");
    expectContains(labelTokens, "gpt-5-1");
    expectContains(labelTokens, "gpt51");
    expectContains(labelTokens, "chatgpt 5.1");
    expectContains(testIdTokens, "gpt-5-1");
    expect(
      testIdTokens.some(
        (t) => t.includes("gpt-5.1") || t.includes("gpt-5-1") || t.includes("gpt51"),
      ),
    ).toBe(true);
  });

  it("includes pro/research tokens for gpt-5.2-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-pro");
    expect(labelTokens.some((t) => t.includes("pro") || t.includes("research"))).toBe(true);
    expectContains(testIdTokens, "gpt-5.2-pro");
    expect(testIdTokens.some((t) => t.includes("model-switcher-gpt-5.2-pro"))).toBe(true);
  });

  it("includes pro + 5.2 tokens for gpt-5.2-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.2-pro") || t.includes("gpt-5-2-pro"))).toBe(
      true,
    );
  });

  it("includes thinking tokens for gpt-5.2-thinking", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-thinking");
    expect(labelTokens.some((t) => t.includes("thinking"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-2-thinking");
    expect(testIdTokens).toContain("gpt-5.2-thinking");
  });

  it("includes instant tokens for gpt-5.2-instant", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-instant");
    expect(labelTokens.some((t) => t.includes("instant"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-2-instant");
    expect(testIdTokens).toContain("gpt-5.2-instant");
  });

  it("closes the menu after a successful selection path", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4");
    expect(expression).toContain("const closeMenu = () =>");
    expect(expression).toContain("key: 'Escape'");
    expect(expression).toContain("closeMenu();");
  });
});
