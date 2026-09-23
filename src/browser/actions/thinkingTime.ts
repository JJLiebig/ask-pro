import type { ChromeClient, BrowserLogger, ThinkingTimeLevel } from "../types.js";
import {
  INPUT_SELECTORS,
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { buildModelPickerDomHelpers } from "./modelPickerDom.js";

type ThinkingTimeOutcome =
  | { status: "already-selected"; label?: string | null }
  | { status: "switched"; label?: string | null }
  | { status: "chip-not-found" }
  | { status: "menu-not-found" }
  | { status: "option-not-found" };

/**
 * Selects a specific thinking time level in ChatGPT's composer.
 *
 * Best-effort: if the chip / menu / option is missing (for example because
 * ChatGPT moved the effort selector into the per-model trailing button), log a
 * debug dump and continue with whatever effort the UI defaults to.
 *
 * @param level - The intelligence or legacy thinking-time level to select.
 */
export async function ensureThinkingTime(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
) {
  const result = await evaluateThinkingTimeSelection(Runtime, level);
  const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

  switch (result?.status) {
    case "already-selected":
      logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
      return;
    case "switched":
      logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
      return;
    case "chip-not-found":
    case "menu-not-found":
    case "option-not-found": {
      await logDomFailure(Runtime, logger, `thinking-${result.status}`);
      if (level === "pro") {
        throw new Error(
          `Unable to select Pro intelligence: ${result.status.replaceAll("-", " ")}.`,
        );
      }
      logger(
        `Thinking time: ${result.status.replaceAll("-", " ")} (requested ${capitalizedLevel}); continuing with ChatGPT default.`,
      );
      return;
    }
    default: {
      await logDomFailure(Runtime, logger, "thinking-time-unknown");
      if (level === "pro") {
        throw new Error("Unable to select Pro intelligence: unknown picker outcome.");
      }
      logger(
        `Thinking time: unknown outcome selecting ${capitalizedLevel}; continuing with ChatGPT default.`,
      );
      return;
    }
  }
}

/**
 * Best-effort selection of a thinking time level in ChatGPT's composer pill menu.
 * Safe by default: if the pill/menu/option isn't present, we continue without throwing.
 * @param level - The intelligence or legacy thinking-time level to select.
 */
export async function ensureThinkingTimeIfAvailable(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
): Promise<boolean> {
  try {
    const result = await evaluateThinkingTimeSelection(Runtime, level);
    const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

    switch (result?.status) {
      case "already-selected":
        logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
        return true;
      case "switched":
        logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
        return true;
      case "chip-not-found":
      case "menu-not-found":
      case "option-not-found":
        if (logger.verbose) {
          logger(`Thinking time: ${result.status.replaceAll("-", " ")}; continuing with default.`);
        }
        return false;
      default:
        if (logger.verbose) {
          logger("Thinking time: unknown outcome; continuing with default.");
        }
        return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(`Thinking time selection failed (${message}); continuing with default.`);
      await logDomFailure(Runtime, logger, "thinking-time");
    }
    return false;
  }
}

async function evaluateThinkingTimeSelection(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
): Promise<ThinkingTimeOutcome | undefined> {
  const outcome = await Runtime.evaluate({
    expression: buildThinkingTimeExpression(level),
    awaitPromise: true,
    returnByValue: true,
  });

  return outcome.result?.value as ThinkingTimeOutcome | undefined;
}

function buildThinkingTimeExpression(level: ThinkingTimeLevel): string {
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  const modelButtonLiteral = JSON.stringify(MODEL_BUTTON_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const targetLevelLiteral = JSON.stringify(level.toLowerCase());

  return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const MODEL_BUTTON_SELECTOR = ${modelButtonLiteral};
    const INPUT_SELECTORS = ${inputSelectorsLiteral};
    const TARGET_LEVEL = ${targetLevelLiteral};

    // English level tokens plus observed localized variants.
    const LEVEL_TOKENS = {
      light: ['light', '轻'],
      standard: ['standard', '标准'],
      extended: ['extended', 'langer', '扩展', '深度', '加强'],
      heavy: ['heavy', '重度', '加重', '高'],
      pro: ['pro'],
    };
    const CURRENT_INTELLIGENCE_TOKENS = {
      light: ['instant', ...LEVEL_TOKENS.light],
      standard: ['medium', ...LEVEL_TOKENS.standard],
      extended: ['pro', ...LEVEL_TOKENS.extended],
      heavy: ['high', ...LEVEL_TOKENS.heavy],
      pro: ['pro'],
    };
    const targetTokens = LEVEL_TOKENS[TARGET_LEVEL] || [TARGET_LEVEL];
    const currentIntelligenceTokens = CURRENT_INTELLIGENCE_TOKENS[TARGET_LEVEL] || [TARGET_LEVEL];

    const INITIAL_WAIT_MS = 150;
    const STEP_WAIT_MS = 200;
    const MAX_WAIT_MS = 8000;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const normalize = (value) => (value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const matchesLevel = (text) => {
      const t = normalize(text);
      return targetTokens.some((tok) => t.includes(String(tok).toLowerCase()));
    };
    const matchesCurrentIntelligenceLevel = (text) => {
      const t = normalize(text);
      return currentIntelligenceTokens.some((tok) => t.startsWith(String(tok).toLowerCase()));
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
    let wakeRestore = null;
    const restoreWakeDraft = async () => {
      if (!wakeRestore) return;
      const restore = wakeRestore;
      wakeRestore = null;
      await restore().catch(() => undefined);
    };
    const wakeHiddenModelButton = async () => {
      if (findModelButton()) return;
      const input = findComposerInput();
      if (!(input instanceof HTMLElement)) return;
      dispatchClickSequence(input);
      input.focus?.();
      const before = readComposerValue(input);
      if (before.trim()) {
        await sleep(250);
        return;
      }
      const draft = 'ask-pro model selection';
      writeComposerValue(input, draft, 'insertText', draft);
      await sleep(500);
      wakeRestore = async () => {
        writeComposerValue(input, before, 'deleteByCut', null);
        await sleep(150);
      };
    };
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const ariaChecked = node.getAttribute('aria-checked');
      const dataState = (node.getAttribute('data-state') || '').toLowerCase();
      return ariaChecked === 'true' || dataState === 'checked' || dataState === 'selected' || dataState === 'on';
    };
    const closeOpenMenus = () => {
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }),
        );
      } catch {}
    };

    const OLD_CHIP_SELECTORS = [
      '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
      'button.__composer-pill[aria-haspopup="menu"]',
      '.__composer-pill-composite button[aria-haspopup="menu"]',
    ];
    const findOldChip = () => {
      for (const selector of OLD_CHIP_SELECTORS) {
        for (const btn of document.querySelectorAll(selector)) {
          if (btn.getAttribute?.('aria-haspopup') !== 'menu') continue;
          const testId = btn.getAttribute?.('data-testid') ?? '';
          if (testId.includes('model-switcher')) continue;
          const aria = normalize(btn.getAttribute?.('aria-label') ?? '');
          const text = normalize(btn.textContent ?? '');
          const label = [aria, text].filter(Boolean).join(' ');
          const hasVersion = /\\b5\\b/.test(label) || /\\b5\\s+[0-9]\\b/.test(label);
          if (!hasVersion && EFFORT_LABELS.has(text)) return btn;
          if (!hasVersion && (aria.includes('thinking') || text.includes('thinking'))) return btn;
          if (!hasVersion && (aria === 'pro' || text === 'pro')) return btn;
        }
      }
      return null;
    };
    const findOldEffortMenu = () => {
      const menus = document.querySelectorAll(
        MENU_CONTAINER_SELECTOR + ', [role="listbox"], [role="group"]'
      );
      for (const menu of menus) {
        const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
        if (normalize(label?.textContent ?? '').includes('thinking time')) return menu;
        const text = normalize(menu.textContent ?? '');
        if (text.includes('standard') && text.includes('extended')) return menu;
      }
      return null;
    };
    const levelOptionScore = (node, options = {}) => {
      const text = normalize(node.textContent ?? '');
      const aria = normalize(node.getAttribute?.('aria-label') ?? '');
      const label = [text, aria].filter(Boolean).join(' ');
      const currentIntelligence = options.currentIntelligence === true;
      if (currentIntelligence) {
        if (!matchesCurrentIntelligenceLevel(label)) return 0;
        let score = 500;
        const role = node.getAttribute?.('role') ?? '';
        if (TARGET_LEVEL === 'extended' && label.includes('5 min')) score += 100;
        if (['menuitemradio', 'option', 'radio'].includes(role)) score += 50;
        return score;
      }
      if (!matchesLevel(label)) return 0;
      if (EFFORT_LABELS.has(text) || EFFORT_LABELS.has(aria)) return 500;
      if (!text.includes('pro') && !text.includes('thinking') && !aria.includes('pro') && !aria.includes('thinking')) {
        return 200;
      }
      return 120;
    };
    const findOptionInMenu = (menu, options = {}) => {
      let best = null;
      for (const item of menu.querySelectorAll(MENU_ITEM_SELECTOR + ', [role="option"]')) {
        const score = levelOptionScore(item, options);
        if (score > 0 && (!best || score > best.score)) {
          best = { item, score };
        }
      }
      return best?.item ?? null;
    };
    const findCurrentIntelligenceMenu = () => {
      const menus = Array.from(document.querySelectorAll(
        MENU_CONTAINER_SELECTOR + ', [role="listbox"], [role="group"]'
      ));
      return menus.find((menu) => {
        const text = normalize(menu.textContent ?? '');
        const testId = normalize(menu.getAttribute?.('data-testid') ?? '');
        return (
          Boolean(menu.querySelector('[data-reasoning-slider="true"] [role="slider"][aria-valuemax]')) ||
          testId.includes('composer intelligence picker content') ||
          (
            text.includes('intelligence') &&
            text.includes('instant') &&
            text.includes('medium') &&
            text.includes('high') &&
            text.includes('pro')
          )
        );
      }) ?? null;
    };
    const selectCurrentIntelligenceLevel = async () => {
      const menu = findCurrentIntelligenceMenu();
      if (!menu) return null;
      const target = findOptionInMenu(menu, { currentIntelligence: true });
      if (!target) {
        const slider = menu.querySelector('[role="slider"][aria-valuemax]');
        if (TARGET_LEVEL !== 'pro' || !slider) return null;
        const max = Number(slider.getAttribute('aria-valuemax'));
        const before = Number(slider.getAttribute('aria-valuenow'));
        if (!Number.isFinite(max) || !Number.isFinite(before)) return null;
        if (before < max) {
          const control = slider.closest?.('[data-reasoning-slider="true"]') ?? slider;
          control.focus?.();
          for (let step = 0; step < 5; step++) {
            if (Number(menu.querySelector('[role="slider"][aria-valuemax]')?.getAttribute('aria-valuenow')) >= max) break;
            control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
            control.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
            await sleep(STEP_WAIT_MS);
          }
          if (Number(menu.querySelector('[role="slider"][aria-valuemax]')?.getAttribute('aria-valuenow')) < max) return null;
        }
        return { status: before >= max ? 'already-selected' : 'switched', label: 'Pro' };
      }
      const already = optionIsSelected(target);
      const label = target.textContent?.trim?.() || null;
      if (!already) {
        dispatchClickSequence(target);
        await sleep(STEP_WAIT_MS);
      }
      return { status: already ? 'already-selected' : 'switched', label };
    };
    const finishCurrentIntelligenceLevel = async () => {
      const outcome = await selectCurrentIntelligenceLevel();
      if (!outcome) return null;
      closeOpenMenus();
      await restoreWakeDraft();
      return outcome;
    };

    await wakeHiddenModelButton();

    const oldChip = findOldChip();
    if (oldChip) {
      dispatchClickSequence(oldChip);
      const start = performance.now();
      while (performance.now() - start < MAX_WAIT_MS) {
        await sleep(100);
        const newerPickerEvidence = document.querySelectorAll(
          '[data-model-picker-thinking-effort-action="true"], [data-testid="model-configure-modal"], [role="dialog"]',
        );
        if (newerPickerEvidence.length > 0) break;
        const currentIntelligenceOutcome = await finishCurrentIntelligenceLevel();
        if (currentIntelligenceOutcome) {
          return currentIntelligenceOutcome;
        }
        const menu = findOldEffortMenu();
        if (!menu) continue;
        const opt = findOptionInMenu(menu);
        if (!opt) {
          closeOpenMenus();
          await restoreWakeDraft();
          return { status: 'option-not-found' };
        }
        const already = optionIsSelected(opt);
        const label = opt.textContent?.trim?.() || null;
        dispatchClickSequence(opt);
        await sleep(STEP_WAIT_MS);
        closeOpenMenus();
        await restoreWakeDraft();
        return { status: already ? 'already-selected' : 'switched', label };
      }
      closeOpenMenus();
      // Fall through to the newer model-picker effort flow. Some ChatGPT builds
      // expose Pro/Thinking as a composer pill but keep the effort menu under
      // the selected model row.
    }

    const TRAILING_SELECTOR = '[data-model-picker-thinking-effort-action="true"]';
    const hasTrailingEffortControls = () => document.querySelectorAll(TRAILING_SELECTOR).length > 0;
    const findIntelligenceDialog = () => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [data-state="open"]'));
      return dialogs.find((dialog) => {
        const text = normalize(dialog.textContent ?? '');
        return (
          (text.includes('model') && text.includes('pro thinking effort')) ||
          (text.includes('modell') && text.includes('denkaufwand pro')) ||
          text.includes('denkaufwand pro')
        );
      }) ?? null;
    };
    const interactiveIn = (root) =>
      Array.from(root.querySelectorAll('button, [role="button"], [role="radio"], [role="combobox"], [role="option"], [role="menuitemradio"], [role="menuitem"], [aria-haspopup]'));
    const findProModelRow = (dialog) => {
      let best = null;
      for (const node of interactiveIn(dialog)) {
        const text = normalize(node.textContent ?? '');
        const aria = normalize(node.getAttribute?.('aria-label') ?? '');
        const testId = (node.getAttribute?.('data-testid') ?? '').toLowerCase();
        const role = node.getAttribute?.('role') ?? '';
        const label = [text, aria, testId].filter(Boolean).join(' ');
        const effortOnly = EFFORT_LABELS.has(text) || EFFORT_LABELS.has(aria);
        const kindFromId = modelKindFromTestId(testId);
        const kindFromText = modelKindFromLabel(label);
        let score = 0;
        if (kindFromId === 'pro') score += 500;
        else if (kindFromId === 'thinking') score -= 500;
        if (kindFromText === 'pro') score += 300;
        else if (kindFromText === 'thinking') score -= 300;
        if (label.includes('pro') && !label.includes('thinking model')) score += 120;
        if (['radio', 'menuitemradio', 'option'].includes(role)) score += 100;
        if (optionIsSelected(node)) score += 80;
        if (effortOnly) score -= 500;
        if (score > 0 && (!best || score > best.score)) best = { node, score };
      }
      return best?.node ?? null;
    };
    const findDialogEffortControl = (dialog, proRow) => {
      let best = null;
      for (const node of interactiveIn(dialog)) {
        if (node === proRow) continue;
        const text = normalize(node.textContent ?? '');
        const aria = normalize(node.getAttribute?.('aria-label') ?? '');
        const title = normalize(node.getAttribute?.('title') ?? '');
        const testId = normalize(node.getAttribute?.('data-testid') ?? '');
        const role = node.getAttribute?.('role') ?? '';
        const label = [text, aria, title, testId].filter(Boolean).join(' ');
        const isEffortValue = EFFORT_LABELS.has(text) || ['standard', 'extended'].includes(text);
        let score = 0;
        if (label.includes('pro thinking effort') || label.includes('denkaufwand pro')) score += 600;
        else if (label.includes('thinking effort') || label.includes('denkaufwand')) score += 400;
        if (role === 'combobox' && (isEffortValue || label.includes('effort') || label.includes('denkaufwand'))) score += 300;
        if ((role === 'button' || node.tagName === 'BUTTON') && (isEffortValue || label.includes('effort') || label.includes('denkaufwand'))) score += 200;
        if (proRow?.contains?.(node)) score += 150;
        if (isEffortValue) score += 100;
        if (score > 0 && (!best || score > best.score)) best = { node, score };
      }
      return best?.node ?? null;
    };
    const findConfigureOption = () =>
      Array.from(document.querySelectorAll('[data-testid="model-configure-modal"], [role="menuitem"], button, [role="button"]'))
        .find((node) => {
          const text = normalize(node.textContent ?? '');
          const testId = normalize(node.getAttribute?.('data-testid') ?? '');
          return testId.includes('model configure modal') || text === 'configure' || text === 'configure...' || text === 'konfigurieren' || text === 'konfigurieren...';
        }) ?? null;
    const findOpenEffortOption = () => {
      const menus = Array.from(document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="listbox"], [role="group"]'));
      let best = null;
      for (const menu of menus) {
        for (const node of menu.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"], [role="radio"], button')) {
          const score = levelOptionScore(node);
          if (score > 0 && (!best || score > best.score)) best = { node, score };
        }
      }
      if (best) return best.node;
      const candidates = Array.from(document.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"], [role="radio"], button'));
      for (const node of candidates) {
        const score = levelOptionScore(node);
        if (score > 0 && (!best || score > best.score)) best = { node, score };
      }
      return best?.node ?? null;
    };

    const modelBtn = findModelButton();
    if (!modelBtn) {
      await restoreWakeDraft();
      return { status: 'chip-not-found' };
    }

    let intelligenceDialog = findIntelligenceDialog();
    if (!intelligenceDialog) {
      dispatchClickSequence(modelBtn);
      await sleep(INITIAL_WAIT_MS);
      const dialogDeadline = performance.now() + MAX_WAIT_MS;
      while (performance.now() < dialogDeadline) {
        intelligenceDialog = findIntelligenceDialog();
        if (intelligenceDialog) break;
        const configure = findConfigureOption();
        if (configure) {
          dispatchClickSequence(configure);
          await sleep(STEP_WAIT_MS);
          intelligenceDialog = findIntelligenceDialog();
          if (intelligenceDialog) break;
        }
        const currentIntelligenceOutcome = await finishCurrentIntelligenceLevel();
        if (currentIntelligenceOutcome) {
          return currentIntelligenceOutcome;
        }
        if (hasTrailingEffortControls()) break;
        await sleep(100);
      }
    }

    if (intelligenceDialog) {
      const proRow = findProModelRow(intelligenceDialog);
      if (proRow && !optionIsSelected(proRow)) {
        dispatchClickSequence(proRow);
        await sleep(STEP_WAIT_MS);
      }
      const effortControl = findDialogEffortControl(intelligenceDialog, proRow);
      if (effortControl) {
        const currentLabel = effortControl.textContent?.trim?.() || null;
        if (currentLabel && matchesLevel(currentLabel)) {
          closeOpenMenus();
          await restoreWakeDraft();
          return { status: 'already-selected', label: currentLabel };
        }
        dispatchClickSequence(effortControl);
        await sleep(STEP_WAIT_MS);
        let targetOption = null;
        const optionDeadline = performance.now() + MAX_WAIT_MS;
        while (performance.now() < optionDeadline) {
          targetOption = findOpenEffortOption();
          if (targetOption) break;
          await sleep(100);
        }
        if (!targetOption) {
          closeOpenMenus();
          await restoreWakeDraft();
          return { status: 'option-not-found' };
        }
        const already = optionIsSelected(targetOption);
        const label = targetOption.textContent?.trim?.() || null;
        dispatchClickSequence(targetOption);
        await sleep(STEP_WAIT_MS);
        closeOpenMenus();
        await restoreWakeDraft();
        return { status: already ? 'already-selected' : 'switched', label };
      }
    }

    const findTrailingButtons = () => Array.from(document.querySelectorAll(TRAILING_SELECTOR));
    const modelLabel = () => normalize(modelBtn.textContent ?? '');
    const findEffortRow = (trailing) =>
      trailing.closest?.('[class*="model-picker-thinking-effort-row"]') ??
      trailing.closest?.('[data-radix-collection-item]') ??
      trailing.parentElement;
    const pickTrailingForCurrentModel = () => {
      const trailings = findTrailingButtons();
      if (trailings.length === 0) return null;
      const currentLabel = modelLabel();
      const currentKind = modelKindFromLabel(currentLabel);
      let best = null;
      for (const t of trailings) {
        const row = findEffortRow(t);
        const testId = (t.getAttribute?.('data-testid') ?? '').toLowerCase();
        const testIdKind = modelKindFromTestId(testId);
        const rowKind = modelKindFromLabel(row?.textContent ?? '');
        let score = 0;
        const rowSelected = row && (optionIsSelected(row) || row.querySelector('[aria-checked="true"]'));
        if (rowSelected) {
          score += 1000;
        }
        if (currentKind) {
          if (testIdKind === currentKind) score += 500;
          else if (testIdKind) score -= 500;
          if (rowKind === currentKind) score += 250;
          else if (rowKind) score -= 250;
        }
        if (!best || score > best.score) best = { trailing: t, score };
      }
      if (best && best.score > 0) return best.trailing;
      return null;
    };

    if (modelBtn.getAttribute('aria-expanded') !== 'true') {
      dispatchClickSequence(modelBtn);
      await sleep(INITIAL_WAIT_MS);
    }

    let trailing = null;
    const trailingDeadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < trailingDeadline) {
      trailing = pickTrailingForCurrentModel();
      if (trailing) break;
      await sleep(100);
    }
    if (!trailing) {
      closeOpenMenus();
      await restoreWakeDraft();
      return { status: 'option-not-found' };
    }

    dispatchClickSequence(trailing);
    await sleep(STEP_WAIT_MS);

    const resolveEffortMenu = () => {
      const id = trailing.getAttribute('aria-controls');
      if (id) {
        const node = document.getElementById(id);
        if (node) return node;
      }
      const menus = document.querySelectorAll(
        MENU_CONTAINER_SELECTOR + ', [role="listbox"], [role="group"]'
      );
      let best = null;
      for (const menu of menus) {
        if (menu === modelBtn || menu.contains(trailing)) continue;
        const text = normalize(menu.textContent ?? '');
        let hits = 0;
        for (const tokens of Object.values(LEVEL_TOKENS)) {
          if (tokens.some((tok) => text.includes(String(tok).toLowerCase()))) hits += 1;
        }
        if (hits >= 2 && (!best || hits > best.hits)) best = { menu, hits };
      }
      return best?.menu ?? null;
    };

    let effortMenu = null;
    const effortDeadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < effortDeadline) {
      effortMenu = resolveEffortMenu();
      if (effortMenu) break;
      await sleep(100);
    }
    if (!effortMenu) {
      closeOpenMenus();
      await restoreWakeDraft();
      return { status: 'menu-not-found' };
    }

    const targetOption = findOptionInMenu(effortMenu);
    if (!targetOption) {
      closeOpenMenus();
      await restoreWakeDraft();
      return { status: 'option-not-found' };
    }

    const already = optionIsSelected(targetOption);
    const label = targetOption.textContent?.trim?.() || null;
    dispatchClickSequence(targetOption);
    await sleep(STEP_WAIT_MS);
    closeOpenMenus();
    await restoreWakeDraft();
    return { status: already ? 'already-selected' : 'switched', label };
  })()`;
}

export function buildThinkingTimeExpressionForTest(level: ThinkingTimeLevel = "extended"): string {
  return buildThinkingTimeExpression(level);
}
