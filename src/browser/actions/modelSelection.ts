import type { ChromeClient, BrowserLogger, BrowserModelStrategy } from "../types.js";
import {
  INPUT_SELECTORS,
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { buildChatGptModelMatchers } from "../chatgptModelCatalog.js";
import { buildModelPickerDomHelpers } from "./modelPickerDom.js";

export async function ensureModelSelection(
  Runtime: ChromeClient["Runtime"],
  desiredModel: string,
  logger: BrowserLogger,
  strategy: BrowserModelStrategy = "select",
) {
  const outcome = await Runtime.evaluate({
    expression: buildModelSelectionExpression(desiredModel, strategy),
    awaitPromise: true,
    returnByValue: true,
  });

  const result = outcome.result?.value as
    | { status: "already-selected"; label?: string | null }
    | { status: "switched"; label?: string | null }
    | {
        status: "option-not-found";
        hint?: { temporaryChat?: boolean; availableOptions?: string[] };
      }
    | { status: "button-missing"; hint?: { temporaryChat?: boolean } }
    | undefined;

  switch (result?.status) {
    case "already-selected":
    case "switched": {
      const label = result.label ?? desiredModel;
      logger(`Model picker: ${label}`);
      return;
    }
    case "option-not-found": {
      await logDomFailure(Runtime, logger, "model-switcher-option");
      const isTemporary = result.hint?.temporaryChat ?? false;
      const available = (result.hint?.availableOptions ?? []).filter(Boolean);
      const availableHint = available.length > 0 ? ` Available: ${available.join(", ")}.` : "";
      const tempHint =
        isTemporary && /\bpro\b/i.test(desiredModel)
          ? " Temporary Chat mode is active; verify the model picker exposes Pro in the current account/UI."
          : "";
      throw new Error(
        `Unable to find model option matching "${desiredModel}" in the model switcher.${availableHint}${tempHint}`,
      );
    }
    default: {
      await logDomFailure(Runtime, logger, "model-switcher-button");
      const isTemporary = result?.hint?.temporaryChat ?? false;
      const tempHint =
        isTemporary && /\bpro\b/i.test(desiredModel)
          ? " Temporary Chat mode is active; verify the model picker exposes Pro in the current account/UI."
          : "";
      throw new Error(`Unable to locate the ChatGPT model selector button.${tempHint}`);
    }
  }
}

/**
 * Builds the DOM expression that runs inside the ChatGPT tab to select a model.
 * The string is evaluated inside Chrome, so keep it self-contained and well-commented.
 */
function buildModelSelectionExpression(
  targetModel: string,
  strategy: BrowserModelStrategy,
): string {
  const matchers = buildModelMatchersLiteral(targetModel);
  const labelLiteral = JSON.stringify(matchers.labelTokens);
  const idLiteral = JSON.stringify(matchers.testIdTokens);
  const targetVersionLiteral = JSON.stringify(matchers.targetVersion);
  const targetKindLiteral = JSON.stringify(matchers.targetKind);
  const visibleAliasesLiteral = JSON.stringify(matchers.visibleAliases);
  const versionPatternsLiteral = JSON.stringify(matchers.versionPatterns);
  const primaryLabelLiteral = JSON.stringify(targetModel);
  const strategyLiteral = JSON.stringify(strategy);
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  const modelButtonLiteral = JSON.stringify(MODEL_BUTTON_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  return `(async () => {
    ${buildClickDispatcher()}
    // Capture the selectors and matcher literals up front so the browser expression stays pure.
    const MODEL_BUTTON_SELECTOR = ${modelButtonLiteral};
    const INPUT_SELECTORS = ${inputSelectorsLiteral};
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const TARGET_VERSION = ${targetVersionLiteral};
    const TARGET_KIND = ${targetKindLiteral};
    const VISIBLE_ALIASES = ${visibleAliasesLiteral};
    const VERSION_PATTERNS = ${versionPatternsLiteral};
    const PRIMARY_LABEL = ${primaryLabelLiteral};
    const MODEL_STRATEGY = ${strategyLiteral};
    const INITIAL_WAIT_MS = 150;
    const REOPEN_INTERVAL_MS = 400;
    const MAX_WAIT_MS = 20000;
    const MODEL_BUTTON_MOUNT_WAIT_MS = 6000;
    const normalize = (value) => {
      if (!value) {
        return '';
      }
      return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\\u0300-\\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
    };
    // Normalize every candidate token to keep fuzzy matching deterministic.
    const normalizedTarget = normalize(PRIMARY_LABEL);
    const normalizedTokens = Array.from(new Set([normalizedTarget, ...LABEL_TOKENS]))
      .map((token) => normalize(token))
      .filter(Boolean);
    const targetWords = normalizedTarget.split(' ').filter(Boolean);
    const desiredVersion = TARGET_VERSION;
    const wantsPro = TARGET_KIND === 'pro' || normalizedTokens.includes('pro');
    const wantsInstant = TARGET_KIND === 'instant' || normalizedTokens.includes('instant');
    const wantsThinking = TARGET_KIND === 'thinking' || normalizedTokens.includes('thinking');
    const labelHasToken = (label, token) => {
      if (!token) return true;
      const normalizedToken = normalize(token);
      if (!normalizedToken) return true;
      if (/^[a-z0-9]+$/.test(normalizedToken)) {
        return label
          .split(' ')
          .some((word) => word === normalizedToken || (word.startsWith(normalizedToken) && /^\\d/.test(word.slice(normalizedToken.length))));
      }
      return label.includes(normalizedToken);
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const matchesVisibleAlias = (value) => {
      const label = normalize(value);
      return VISIBLE_ALIASES.some((alias) => {
        const includes = alias.includes || [];
        const excludes = alias.excludes || [];
        return includes.every((token) => labelHasToken(label, token)) && excludes.every((token) => !labelHasToken(label, token));
      });
    };
    const versionFromText = (value) => {
      if (!value) return null;
      for (const pattern of VERSION_PATTERNS) {
        if ((pattern.textTokens || []).some((token) => value.includes(token))) {
          return pattern.version;
        }
      }
      return null;
    };
    const versionFromTestId = (value) => {
      if (!value) return null;
      for (const pattern of VERSION_PATTERNS) {
        if ((pattern.testIdTokens || []).some((token) => value.includes(token))) {
          return pattern.version;
        }
      }
      return null;
    };
    ${buildModelPickerDomHelpers()}
    const readComposerValue = (node) => {
      if (!node) return '';
      if (typeof HTMLTextAreaElement !== 'undefined' && node instanceof HTMLTextAreaElement) {
        return node.value ?? '';
      }
      return node.innerText ?? node.textContent ?? '';
    };
    const writeComposerValue = (node, value, inputType, data) => {
      if (!node) return;
      if (typeof HTMLTextAreaElement !== 'undefined' && node instanceof HTMLTextAreaElement) {
        node.value = value;
      } else {
        node.textContent = value;
      }
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const findComposerInput = () => {
      const candidates = INPUT_SELECTORS
        .map((selector) => document.querySelector(selector))
        .filter(Boolean);
      return candidates.find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }) || candidates[0] || null;
    };
    const wakeHiddenModelButton = async () => {
      const input = findComposerInput();
      if (!(input instanceof HTMLElement)) return null;
      dispatchClickSequence(input);
      input.focus?.();
      const before = readComposerValue(input);
      if (before.trim()) {
        await sleep(250);
        return { button: findModelButton(), restore: null };
      }
      const draft = 'ask-pro model selection';
      writeComposerValue(input, draft, 'insertText', draft);
      await sleep(500);
      return {
        button: findModelButton(),
        restore: async () => {
          writeComposerValue(input, before, 'deleteByCut', null);
          await sleep(150);
        },
      };
    };
    const detectTemporaryChat = () => {
      try {
        const url = new URL(window.location.href);
        const flag = (url.searchParams.get('temporary-chat') ?? '').toLowerCase();
        if (flag === 'true' || flag === '1' || flag === 'yes') return true;
      } catch {}
      const temporaryControls = Array.from(document.querySelectorAll('button, [role="button"], input[type="checkbox"]'));
      return temporaryControls.some((node) => {
        const label = [
          node.getAttribute?.('aria-label') ?? '',
          node.getAttribute?.('title') ?? '',
          node.textContent ?? '',
        ].join(' ').toLowerCase();
        const pressed = (node.getAttribute?.('aria-pressed') ?? '').toLowerCase();
        const checked = (node.getAttribute?.('aria-checked') ?? '').toLowerCase();
        const inputChecked =
          typeof HTMLInputElement !== 'undefined' &&
          node instanceof HTMLInputElement &&
          node.type === 'checkbox' &&
          node.checked;
        if (label.includes('turn off temporary chat')) return true;
        if (label.includes('temporary chat') && (pressed === 'true' || checked === 'true' || inputChecked)) return true;
        return false;
      });
    };

    const waitForModelButton = async (timeoutMs = MODEL_BUTTON_MOUNT_WAIT_MS, wake = false) => {
      const start = performance.now();
      do {
        const candidate = findModelButton();
        if (candidate) return candidate;
        if (wake) {
          const wakeResult = await wakeHiddenModelButton();
          if (wakeResult?.restore && !wakeRestore) {
            wakeRestore = wakeResult.restore;
          }
          if (wakeResult?.button) return wakeResult.button;
        }
        await sleep(REOPEN_INTERVAL_MS / 2);
      } while (performance.now() - start <= timeoutMs);
      return null;
    };

    let wakeRestore = null;
    let button = findModelButton();
    if (!button) {
      const wake = await wakeHiddenModelButton();
      button = wake?.button ?? null;
      wakeRestore = wake?.restore ?? null;
    }
    if (!button && MODEL_STRATEGY !== 'current' && !detectTemporaryChat()) {
      button = await waitForModelButton(MODEL_BUTTON_MOUNT_WAIT_MS, true);
    }
    if (!button) {
      await wakeRestore?.().catch?.(() => undefined);
      if (MODEL_STRATEGY === 'current') {
        return { status: 'already-selected', label: 'current model' };
      }
      return { status: 'button-missing', hint: { temporaryChat: detectTemporaryChat() } };
    }

    const closeMenu = () => {
      try {
        if (dispatchClickSequence(button)) {
          lastPointerClick = performance.now();
          return;
        }
      } catch {}
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
          }),
        );
      } catch {}
    };

    const getButtonLabel = () => (button.textContent ?? '').trim();
    if (MODEL_STRATEGY === 'current') {
      const label = getButtonLabel();
      await wakeRestore?.().catch?.(() => undefined);
      return { status: 'already-selected', label };
    }
    const buttonMatchesTarget = () => {
      // The numbered pill cannot prove that the rolling Latest option is selected.
      if (normalizedTarget === 'latest') return false;
      const normalizedLabel = normalize(getButtonLabel());
      if (!normalizedLabel) return false;
      if (matchesVisibleAlias(normalizedLabel)) return true;
      if (desiredVersion) {
        if (versionFromText(normalizedLabel) !== desiredVersion) return false;
      }
      if (wantsPro && !labelHasToken(normalizedLabel, 'pro')) return false;
      if (wantsInstant && !normalizedLabel.includes('instant')) return false;
      if (wantsThinking && !normalizedLabel.includes('thinking')) return false;
      // Also reject if button has variants we DON'T want
      if (!wantsPro && labelHasToken(normalizedLabel, 'pro')) return false;
      if (!wantsInstant && normalizedLabel.includes('instant')) return false;
      if (!wantsThinking && normalizedLabel.includes('thinking')) return false;
      return true;
    };

    if (buttonMatchesTarget()) {
      const label = getButtonLabel();
      await wakeRestore?.().catch?.(() => undefined);
      return { status: 'already-selected', label };
    }

    let lastPointerClick = 0;
    const pointerClick = () => {
      if (dispatchClickSequence(button)) {
        lastPointerClick = performance.now();
      }
    };

    const getOptionLabel = (node) => node?.textContent?.trim() ?? '';
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataSelected = node.getAttribute('data-selected');
      const dataState = (node.getAttribute('data-state') ?? '').toLowerCase();
      const selectedStates = ['checked', 'selected', 'on', 'true'];
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') {
        return true;
      }
      if (dataSelected === 'true' || selectedStates.includes(dataState)) {
        return true;
      }
      if (node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]')) {
        return true;
      }
      return false;
    };

    const scoreOption = (normalizedText, testid) => {
      if (normalizedTarget === 'latest') return normalizedText === 'latest' ? 1000 : 0;
      // Assign a score to every node so we can pick the most likely match without brittle equality checks.
      if (!normalizedText && !testid) {
        return 0;
      }
      let score = 0;
      const normalizedTestId = (testid ?? '').toLowerCase();
      const candidateTextVersion = versionFromText(normalizedText);
      const candidateTestIdVersion = versionFromTestId(normalizedTestId);
      const candidateVisibleAlias = matchesVisibleAlias(normalizedText);
      if (desiredVersion) {
        if (candidateTextVersion && candidateTextVersion !== desiredVersion) {
          return 0;
        }
        if (candidateTestIdVersion && candidateTestIdVersion !== desiredVersion) {
          return 0;
        }
        const versionLikeLabel =
          normalizedText.includes('gpt') ||
          normalizedText.includes('pro') ||
          normalizedText.includes('thinking') ||
          /\\b5\\b/.test(normalizedText);
        if (
          versionLikeLabel &&
          !candidateTextVersion &&
          !candidateTestIdVersion &&
          !candidateVisibleAlias
        ) {
          return 0;
        }
        // When targeting an explicit version, avoid selecting submenu wrappers that can contain legacy models.
        if (normalizedTestId.includes('submenu') && candidateTestIdVersion === null) {
          return 0;
        }
      }
      if (candidateVisibleAlias) {
        score += 900;
      }
      if (normalizedTestId) {
        // Exact testid matches take priority over substring matches
        const exactMatch = TEST_IDS.find((id) => id && normalizedTestId === id);
        if (exactMatch) {
          score += 1500;
          if (exactMatch.startsWith('model-switcher-')) score += 200;
        } else {
          const matches = TEST_IDS.filter((id) => id && normalizedTestId.includes(id));
          if (matches.length > 0) {
            // Prefer the most specific match (longest token) instead of treating any hit as equal.
            // This prevents generic tokens (e.g. "pro") from outweighing version-specific targets.
            const best = matches.reduce((acc, token) => (token.length > acc.length ? token : acc), '');
            score += 200 + Math.min(900, best.length * 25);
            if (best.startsWith('model-switcher-')) score += 120;
            if (best.includes('gpt-')) score += 60;
          }
        }
      }
      if (normalizedText && normalizedTarget) {
        if (normalizedText === normalizedTarget) {
          score += 500;
        } else if (normalizedTarget.length > 3 && normalizedText.startsWith(normalizedTarget)) {
          score += 420;
        } else if (normalizedTarget.length > 3 && normalizedText.includes(normalizedTarget)) {
          score += 380;
        }
      }
      for (const token of normalizedTokens) {
        // Reward partial matches to the expanded label/token set.
        if (token && labelHasToken(normalizedText, token)) {
          const tokenWeight = Math.min(120, Math.max(10, token.length * 4));
          score += tokenWeight;
        }
      }
      if (targetWords.length > 1) {
        let missing = 0;
        for (const word of targetWords) {
          if (!normalizedText.includes(word)) {
            missing += 1;
          }
        }
        score -= missing * 12;
      }
      // If the caller didn't explicitly ask for Pro, prefer non-Pro options when both exist.
      if (wantsPro) {
        if (!labelHasToken(normalizedText, 'pro')) {
          score -= 80;
        }
      } else if (labelHasToken(normalizedText, 'pro')) {
        score -= 40;
      }
      // Similarly for Thinking variant
      if (wantsThinking) {
        if (!normalizedText.includes('thinking') && !normalizedTestId.includes('thinking')) {
          score -= 80;
        }
      } else if (normalizedText.includes('thinking') || normalizedTestId.includes('thinking')) {
        score -= 40;
      }
      // Similarly for Instant variant
      if (wantsInstant) {
        if (!normalizedText.includes('instant') && !normalizedTestId.includes('instant')) {
          score -= 80;
        }
      } else if (normalizedText.includes('instant') || normalizedTestId.includes('instant')) {
        score -= 40;
      }
      return Math.max(score, 0);
    };

    const findBestOption = () => {
      // Walk through every menu item and keep whichever earns the highest score.
      let bestMatch = null;
      const menus = Array.from(document.querySelectorAll(${menuContainerLiteral}));
      for (const menu of menus) {
        const buttons = Array.from(menu.querySelectorAll(${menuItemLiteral}));
        for (const option of buttons) {
          const text = option.textContent ?? '';
          const normalizedText = normalize(text);
          const testid = option.getAttribute('data-testid') ?? '';
          const isSubmenu =
            testid.toLowerCase().includes('submenu') ||
            option.getAttribute('data-has-submenu') !== null ||
            option.getAttribute('aria-haspopup') === 'menu';
          const baseScore = scoreOption(normalizedText, testid);
          if (baseScore <= 0) {
            continue;
          }
          const score = baseScore + (isSubmenu ? 0 : 1);
          const label = getOptionLabel(option);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { node: option, label, score, testid, normalizedText, isSubmenu };
          }
        }
      }
      return bestMatch;
    };

    return new Promise((resolve) => {
      const start = performance.now();
      const collectAvailableOptions = () => {
        const menuRoots = Array.from(document.querySelectorAll(${menuContainerLiteral}));
        const nodes = menuRoots.length > 0
          ? menuRoots.flatMap((root) => Array.from(root.querySelectorAll(${menuItemLiteral})))
          : Array.from(document.querySelectorAll(${menuItemLiteral}));
        const labels = nodes
          .map((node) => (node?.textContent ?? '').trim())
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index);
        return labels.slice(0, 12);
      };
      const ensureMenuOpen = () => {
        const menuOpen = document.querySelector(${menuContainerLiteral});
        if (!menuOpen && performance.now() - lastPointerClick > REOPEN_INTERVAL_MS) {
          pointerClick();
        }
      };

      // Open once and wait a tick before first scan.
      pointerClick();
      const openDelay = () => new Promise((r) => setTimeout(r, INITIAL_WAIT_MS));
      const restoreWakeDraft = async () => {
        if (!wakeRestore) return;
        const restore = wakeRestore;
        wakeRestore = null;
        await restore().catch(() => undefined);
      };
      let initialized = false;
      const attempt = async () => {
        if (!initialized) {
          initialized = true;
          await openDelay();
        }
        ensureMenuOpen();
        if (normalizedTarget === 'latest') {
          const modelView = document.querySelector('[role="menuitem"][aria-label="Select model"][aria-expanded="false"]');
          if (modelView) {
            dispatchClickSequence(modelView);
            await openDelay();
          }
        }
        const match = findBestOption();
        if (match) {
          if (optionIsSelected(match.node)) {
            await restoreWakeDraft();
            closeMenu();
            resolve({
              status: 'already-selected',
              label: buttonMatchesTarget() ? getButtonLabel() : match.label,
            });
            return;
          }
          dispatchClickSequence(match.node);
          // Submenus (e.g. "Legacy models") need a second pass to pick the actual model option.
          // Keep scanning once the submenu opens instead of treating the submenu click as a final switch.
          if (match.isSubmenu) {
            setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
            return;
          }
          // Newer ChatGPT builds may keep the composer pill as just "Standard",
          // "Extended", or "Pro" after selecting a terminal Pro row. Require
          // selected-state evidence, or a closed picker, when the composer
          // remains effort-only.
          setTimeout(async () => {
            if (
              buttonMatchesTarget() ||
              optionIsSelected(match.node) ||
              !document.querySelector(${menuContainerLiteral})
            ) {
              await restoreWakeDraft();
              closeMenu();
              resolve({
                status: 'switched',
                label: buttonMatchesTarget() ? getButtonLabel() : match.label,
              });
              return;
            }
            if (performance.now() - start > MAX_WAIT_MS) {
              await restoreWakeDraft();
              resolve({
                status: 'option-not-found',
                hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
              });
              return;
            }
            attempt();
          }, Math.max(120, INITIAL_WAIT_MS));
          return;
        }
        if (performance.now() - start > MAX_WAIT_MS) {
          await restoreWakeDraft();
          resolve({
            status: 'option-not-found',
            hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
          });
          return;
        }
        setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
      };
      attempt();
    });
  })()`;
}

export function buildModelMatchersLiteralForTest(targetModel: string) {
  return buildModelMatchersLiteral(targetModel);
}

function buildModelMatchersLiteral(targetModel: string) {
  return buildChatGptModelMatchers(targetModel);
}

export function buildModelSelectionExpressionForTest(
  targetModel: string,
  strategy: BrowserModelStrategy = "select",
): string {
  return buildModelSelectionExpression(targetModel, strategy);
}
