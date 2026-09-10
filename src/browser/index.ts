import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import CDP from "chrome-remote-interface";
import { DEFAULT_BROWSER_CONFIG, resolveBrowserConfig } from "./config.js";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserLogger,
  ChromeClient,
  BrowserAttachment,
  ResolvedBrowserConfig,
} from "./types.js";
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  connectToRemoteChrome,
  connectWithNewTab,
  closeTab,
  closeRemoteChromeTarget,
  closeChromeGracefully,
  listRemoteChromeTargets,
  maybeReuseRunningChrome,
  releaseChromeProcessHandle,
  restoreChromeWindowByPid,
  shouldLaunchChromeMinimized,
} from "./chromeLifecycle.js";
import { syncCookies } from "./cookies.js";
import {
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  installJavaScriptDialogAutoDismissal,
  ensureModelSelection,
  clearPromptComposer,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  readAssistantSnapshot,
} from "./pageActions.js";
import { INPUT_SELECTORS } from "./constants.js";
import { uploadAttachmentViaDataTransfer } from "./actions/remoteFileTransfer.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { startThinkingStatusMonitor } from "./actions/thinkingStatus.js";
import { createAssistantContinuation } from "./actions/assistantResponse.js";
import { createPostSubmitInputGuard } from "./actions/inputGuard.js";
import { isChromeWindowMinimized, setChromeWindowState } from "./actions/windowState.js";
import { estimateTokenCount, withRetries, delay } from "./utils.js";
import { formatElapsed } from "./format.js";
import { CHATGPT_URL, CONVERSATION_TURN_SELECTOR, DEFAULT_MODEL_STRATEGY } from "./constants.js";
import type { LaunchedChrome } from "chrome-launcher";
import { AssistantStoppedError, BrowserAutomationError } from "./errors.js";
import { defaultAskProBrowserProfileDir } from "./profilePaths.js";
import { applyPageLanguageOverrides, seedChromeProfileLanguage } from "./language.js";
import { alignPromptEchoPair, buildPromptEchoMatcher, withTimeout } from "./reattachHelpers.js";
import type { ManagedChromeRunLease, ProfileRunLock } from "./profileState.js";
import {
  cleanupStaleProfileState,
  acquireProfileRunLock,
  createManagedChromeRunLease,
  releaseManagedChromeRunLeaseAndCountPeers,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { chatgptDomProvider } from "./providers/chatgptDomProvider.js";
import { resolveAttachRunningConnection } from "./attachRunning.js";
import { connectToExistingChatGptTab } from "./liveTabs.js";

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from "./types.js";
export { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
export { parseDuration, delay, normalizeChatgptUrl, isTemporaryChatUrl } from "./utils.js";
export {
  formatThinkingLog,
  formatThinkingWaitingLog,
  buildThinkingStatusExpressionForTest,
  readThinkingStatusForTest,
  sanitizeThinkingText,
  startThinkingStatusMonitorForTest,
} from "./actions/thinkingStatus.js";

function redactBrowserConfigForDebugLog(config: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...config };
  if (Array.isArray(config.inlineCookies)) {
    redacted.inlineCookies = `[redacted:${config.inlineCookies.length} cookies]`;
    redacted.inlineCookieCount = config.inlineCookies.length;
  }
  return redacted;
}

function isHumanInterventionError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const stage = (error.details as { stage?: string } | undefined)?.stage;
  return stage === "login-required" || stage === "cloudflare-challenge";
}

function shouldPreserveBrowserOnError(error: unknown, headless: boolean): boolean {
  return !headless && isHumanInterventionError(error);
}

export function shouldPreserveBrowserOnErrorForTest(error: unknown, headless: boolean): boolean {
  return shouldPreserveBrowserOnError(error, headless);
}

function hasBrowserErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof BrowserAutomationError &&
    (error.details as { code?: string } | undefined)?.code === code
  );
}

type BrowserSubmissionResult = {
  baselineTurns: number | null;
  baselineAssistantText: string | null;
};

type BrowserSubmissionFallback = {
  prompt: string;
  attachments: BrowserAttachment[];
};

async function runSubmissionWithRecovery({
  prompt,
  attachments,
  fallbackSubmission,
  submit,
  reloadPromptComposer,
  prepareFallbackSubmission,
  logger,
}: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (prompt: string, attachments: BrowserAttachment[]) => Promise<BrowserSubmissionResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  let currentPrompt = prompt;
  let currentAttachments = attachments;
  let retriedDeadComposer = false;
  let usedFallbackSubmission = false;

  while (true) {
    try {
      return await submit(currentPrompt, currentAttachments);
    } catch (error) {
      const isPromptTooLarge = hasBrowserErrorCode(error, "prompt-too-large");
      const isDeadComposer = hasBrowserErrorCode(error, "dead-composer");
      if (isDeadComposer && !retriedDeadComposer) {
        retriedDeadComposer = true;
        await reloadPromptComposer();
        continue;
      }
      if (fallbackSubmission && !usedFallbackSubmission && isPromptTooLarge) {
        usedFallbackSubmission = true;
        logger("[browser] Inline prompt too large; retrying with file uploads.");
        await prepareFallbackSubmission();
        currentPrompt = fallbackSubmission.prompt;
        currentAttachments = fallbackSubmission.attachments;
        continue;
      }
      throw error;
    }
  }
}

export async function runSubmissionWithRecoveryForTest(args: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (prompt: string, attachments: BrowserAttachment[]) => Promise<BrowserSubmissionResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  return runSubmissionWithRecovery(args);
}

function listIgnoredRemoteChromeFlags(config: {
  attachRunning?: ResolvedBrowserConfig["attachRunning"];
  headless?: ResolvedBrowserConfig["headless"];
  hideWindow?: ResolvedBrowserConfig["hideWindow"];
  keepBrowser?: ResolvedBrowserConfig["keepBrowser"];
  chromePath?: ResolvedBrowserConfig["chromePath"];
}): string[] {
  return [
    config.headless ? "--browser-headless" : null,
    config.hideWindow ? "--browser-hide-window" : null,
    config.keepBrowser ? "--browser-keep-browser" : null,
    !config.attachRunning && config.chromePath ? "--browser-chrome-path" : null,
  ].filter((value): value is string => Boolean(value));
}

function shouldEnablePostSubmitInputGuard(config: {
  remoteChrome?: ResolvedBrowserConfig["remoteChrome"];
  browserTabRef?: string | null;
}): boolean {
  return !config.remoteChrome && !config.browserTabRef;
}

type ManagedChromeCleanupDecision = "close-browser" | "retain-browser" | "connection-lost";

function decideManagedChromeCleanup(config: {
  keepBrowserOpen?: boolean;
  connectionClosedUnexpectedly?: boolean;
  peerRunCount: number | null;
  remainingTargets: Array<{ id?: string; targetId?: string; type?: string }> | null;
  completedRunTargetId?: string | null;
}): ManagedChromeCleanupDecision {
  if (config.connectionClosedUnexpectedly) return "connection-lost";
  if (
    config.keepBrowserOpen ||
    config.peerRunCount === null ||
    config.peerRunCount > 0 ||
    config.remainingTargets === null ||
    shouldRetainLaunchedChromeAfterRun(config.remainingTargets, config.completedRunTargetId)
  ) {
    return "retain-browser";
  }
  return "close-browser";
}

function shouldCaptureLaunchTargetsForCleanup(config: { reusedChrome?: boolean }): boolean {
  return !config.reusedChrome;
}

function shouldRetainLaunchedChromeAfterRun(
  targets: Array<{ id?: string; targetId?: string; type?: string }>,
  completedRunTargetId?: string | null,
): boolean {
  return targets.some((target) => {
    const targetId = target.targetId ?? target.id;
    return Boolean(targetId && targetId !== completedRunTargetId && target.type === "page");
  });
}

function isDisposableLaunchPageUrl(url: string | undefined): boolean {
  const normalized = (url ?? "").trim().toLowerCase();
  return (
    normalized === "about:blank" ||
    /^[a-z][a-z0-9+.-]*:\/\/newtab\/$/.test(normalized) ||
    normalized === "chrome://new-tab-page/"
  );
}

function selectDisposableLaunchTargetIds(
  targets: Array<{ id?: string; targetId?: string; type?: string; url?: string }>,
  currentTargetId?: string | null,
): string[] {
  return targets
    .filter((target) => {
      const targetId = target.targetId ?? target.id;
      if (!targetId || targetId === currentTargetId) return false;
      if (target.type && target.type !== "page") return false;
      return isDisposableLaunchPageUrl(target.url);
    })
    .map((target) => (target.targetId ?? target.id) as string);
}

function selectClosableLaunchTargetIds(
  launchTargetIds: string[],
  currentTargets: Array<{ id?: string; targetId?: string; type?: string; url?: string }>,
  currentTargetId?: string | null,
): string[] {
  const launchTargetSet = new Set(launchTargetIds);
  return selectDisposableLaunchTargetIds(currentTargets, currentTargetId).filter((targetId) =>
    launchTargetSet.has(targetId),
  );
}

function buildHumanInterventionProbeExpression(): string {
  return `(() => {
      const path = String(location?.pathname || '').toLowerCase();
      const composerSelector = 'textarea,[contenteditable="true"]';
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (node.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || node.hasAttribute('disabled')) return false;
        const centerX = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
        const centerY = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
        const topNode = document.elementFromPoint(centerX, centerY);
        return topNode === node || node.contains(topNode);
      };
      const composerVisible = Array.from(document.querySelectorAll(composerSelector)).some(isVisible);
      const hasConversation = Boolean(document.querySelector(${JSON.stringify(CONVERSATION_TURN_SELECTOR)}));
      if (/\\/(auth|login|signin)/i.test(path)) return 'login';
      const challengeControls = Array.from(document.querySelectorAll('input[autocomplete="one-time-code"],input[name*="otp" i],input[id*="otp" i],iframe[src*="captcha" i],iframe[src*="/challenge-platform/" i]'));
      if (challengeControls.some(isVisible)) return 'browser_challenge';
      const challengeSurfaces = Array.from(document.querySelectorAll('form,[role="dialog"]'))
        .filter((node) => isVisible(node) && !node.querySelector(composerSelector));
      const challengeText = challengeSurfaces.map((node) => node.textContent || '').join(' ').toLowerCase();
      if (/\\b(mfa|two-factor|2fa|verification code|security check|verify you are human|captcha)\\b/i.test(challengeText)) return 'browser_challenge';
      if (composerVisible) return null;
      if (hasConversation) return null;
      const nodes = Array.from(document.querySelectorAll('button,a,[role="button"]'));
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const label = String(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '')
          .toLowerCase()
          .trim();
        if (/^(log in|login|sign in|signin|continue with)\\b/i.test(label)) return 'login';
      }
      return null;
    })()`;
}

async function detectHumanInterventionReason(
  Runtime: ChromeClient["Runtime"],
): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: buildHumanInterventionProbeExpression(),
    returnByValue: true,
  });
  return typeof result?.value === "string" && result.value.length > 0 ? result.value : null;
}

function startHumanInterventionRestoreMonitor({
  Runtime,
  logger,
  revealWindow,
  disableInputGuard,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  revealWindow: (reason: string) => Promise<void>;
  disableInputGuard: () => Promise<boolean>;
}): { promise: Promise<never>; stop: () => void } {
  let stopped = false;
  let restoring = false;
  let rejectPromise: (error: Error) => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  const check = async () => {
    if (stopped || restoring) return;
    const reason = await detectHumanInterventionReason(Runtime).catch(() => null);
    if (!reason) return;
    restoring = true;
    logger(`[browser] ${reason} detected while waiting; restoring Chrome for human action.`);
    await disableInputGuard().catch(() => false);
    if (reason === "login") {
      await openLoginSurfaceForHumanAction(Runtime, logger).catch(() => undefined);
    }
    await revealWindow(`human-intervention:${reason}`).catch(() => undefined);
    rejectPromise(
      new BrowserAutomationError(
        reason === "login"
          ? "ChatGPT login appeared while ask-pro was waiting; sign in in the restored browser, then resume."
          : "Browser challenge appeared while ask-pro was waiting; complete it in the restored browser, then resume.",
        { stage: reason === "login" ? "login-required" : "cloudflare-challenge" },
      ),
    );
  };
  const timer = setInterval(() => void check(), 5_000);
  timer.unref?.();
  void check();
  return {
    promise,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function openLoginSurfaceForHumanAction(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<void> {
  const outcome = await Runtime.evaluate({
    expression: `(() => {
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (node.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.hasAttribute('disabled');
      };
      const labelFor = (node) =>
        String(node?.textContent || node?.getAttribute?.('aria-label') || node?.getAttribute?.('title') || '')
          .toLowerCase()
          .replace(/\\s+/g, ' ')
          .trim();
      const pageText = String(document.body?.textContent || '').toLowerCase();
      const hasExpiredSessionDialog = pageText.includes('session has expired');
      if (!hasExpiredSessionDialog) {
        return { opened: false, method: 'no-expired-session-dialog' };
      }
      const login = Array.from(document.querySelectorAll('a,button,[role="button"]')).find((node) => {
        if (!isVisible(node)) return false;
        const label = labelFor(node);
        return label === 'log in' || label === 'login';
      });
      if (login) {
        login.click();
        return { opened: true, method: 'click', label: labelFor(login) };
      }
      return { opened: false, method: 'missing-control' };
    })()`,
    returnByValue: true,
  });
  const result = outcome.result?.value as
    | { opened?: boolean; method?: string; label?: string }
    | undefined;
  if (result?.opened) {
    logger(
      `[browser] Opened ChatGPT login surface for human action (${result.method ?? "unknown"}${result.label ? `: ${result.label}` : ""}).`,
    );
  } else if (result?.method) {
    logger(`[browser] ChatGPT login control not found (${result.method}).`);
  }
}

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error("Prompt text is required when using browser mode.");
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];
  const fallbackSubmission = options.fallbackSubmission;

  let config = resolveBrowserConfig(options.config);
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }
  if (logger.sessionLog === undefined && options.log?.sessionLog) {
    logger.sessionLog = options.log.sessionLog;
  }
  const runtimeHintCb = options.runtimeHintCb;
  let lastTargetId: string | undefined;
  let lastUrl: string | undefined;
  const emitRuntimeHint = async (): Promise<void> => {
    if (!runtimeHintCb || !chrome?.port) {
      return;
    }
    const conversationId = lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined;
    const hint = {
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId,
      userDataDir,
      controllerPid: process.pid,
    };
    try {
      await runtimeHintCb(hint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...redactBrowserConfigForDebugLog(config),
        promptLength: promptText.length,
      })}`,
    );
  }

  if (config.attachRunning) {
    const attached = await resolveAttachRunningConnection(config, logger);
    config = {
      ...config,
      remoteChrome: { host: attached.host, port: attached.port },
      remoteChromeBrowserWSEndpoint: attached.browserWSEndpoint,
      remoteChromeProfileRoot: attached.profileRoot,
    };
  }

  if (!config.remoteChrome && !config.manualLogin) {
    const preferredPort = config.debugPort ?? DEFAULT_DEBUG_PORT;
    const availablePort = await pickAvailableDebugPort(preferredPort, logger);
    if (availablePort !== preferredPort) {
      logger(
        `DevTools port ${preferredPort} busy; using ${availablePort} to avoid attaching to stray Chrome.`,
      );
    }
    config = { ...config, debugPort: availablePort };
  }

  // Remote Chrome mode - connect to existing browser
  if (config.remoteChrome) {
    // Warn about ignored local-only options
    const ignoredFlags = listIgnoredRemoteChromeFlags(config);
    if (ignoredFlags.length > 0) {
      logger(`Note: --remote-chrome ignores local Chrome flags (${ignoredFlags.join(", ")}).`);
    }

    return runRemoteBrowserMode(promptText, attachments, config, logger, options);
  }

  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultAskProBrowserProfileDir();
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), "ask-pro-browser-"));
  if (manualLogin) {
    // Learned: manual login reuses a persistent profile so cookies/SSO survive.
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  const profileLockTimeoutMs = manualLogin ? (config.profileLockTimeoutMs ?? 0) : 0;
  const lifecycleLockTimeoutMs = manualLogin
    ? profileLockTimeoutMs > 0
      ? profileLockTimeoutMs
      : (DEFAULT_BROWSER_CONFIG.profileLockTimeoutMs ?? 300_000)
    : 0;
  let profileLock: ProfileRunLock | null = null;
  const acquireProfileLockIfNeeded = async (timeoutMs = profileLockTimeoutMs) => {
    if (timeoutMs <= 0 || profileLock) return false;
    profileLock = await acquireProfileRunLock(userDataDir, {
      timeoutMs,
      logger,
    });
    return true;
  };
  const releaseProfileLockIfHeld = async () => {
    if (!profileLock) return;
    const handle = profileLock;
    profileLock = null;
    await handle.release().catch(() => undefined);
  };

  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  let managedChromeRunLease: ManagedChromeRunLease | null = null;
  await acquireProfileLockIfNeeded(lifecycleLockTimeoutMs);
  let reusedChrome: LaunchedChrome | null = null;
  let chrome: LaunchedChrome | null = null;
  try {
    reusedChrome = manualLogin ? await maybeReuseRunningChrome(userDataDir, logger) : null;
    if (!reusedChrome) {
      await seedChromeProfileLanguage(userDataDir, config.acceptLanguage, logger);
    }
    chrome =
      reusedChrome ??
      (await launchChrome(
        {
          ...config,
          remoteChrome: config.remoteChrome,
        },
        userDataDir,
        logger,
      ));
    // Persist profile state so future manual-login runs can reuse this Chrome.
    if (manualLogin && chrome.port) {
      await writeDevToolsActivePort(userDataDir, chrome.port);
      if (!reusedChrome && chrome.pid) {
        await writeChromePid(userDataDir, chrome.pid);
      }
      managedChromeRunLease = await createManagedChromeRunLease(userDataDir);
    }
  } catch (error) {
    if (chrome && !reusedChrome) {
      const closed = await closeChromeGracefully(chrome, logger).then(
        () => true,
        () => {
          releaseChromeProcessHandle(chrome);
          return false;
        },
      );
      if (closed) {
        await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
          () => undefined,
        );
      }
    } else {
      releaseChromeProcessHandle(chrome);
    }
    throw error;
  } finally {
    await releaseProfileLockIfHeld();
  }
  if (!chrome) throw new Error("Failed to start or reuse managed Chrome.");
  const chromeLaunchMinimized = !reusedChrome && shouldLaunchChromeMinimized(config);
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser || manualLogin,
      logger,
      {
        isInFlight: () => runStatus !== "complete",
        emitRuntimeHint,
        preserveUserDataDir: manualLogin,
      },
    );
  } catch {
    // ignore failure; cleanup still happens below
  }

  let client: ChromeClient | null = null;
  let isolatedTargetId: string | null = null;
  let launchTargetIds: string[] = [];
  let closedLaunchTabs = false;
  const closeLaunchTabs = async () => {
    if (closedLaunchTabs || launchTargetIds.length === 0) return;
    closedLaunchTabs = true;
    const currentTargets = await listRemoteChromeTargets({
      host: chromeHost,
      port: chrome.port,
    }).catch(() => []);
    const targetIds = selectClosableLaunchTargetIds(
      launchTargetIds,
      currentTargets,
      isolatedTargetId,
    );
    launchTargetIds = [];
    await Promise.all(
      targetIds.map((targetId) =>
        closeTab(chrome.port, targetId, logger, chromeHost).catch(() => undefined),
      ),
    );
  };
  let ownsTarget = true;
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let runStatus: "attempted" | "complete" = "attempted";
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let appliedCookies = 0;
  let windowParkedAfterSetup = false;
  let windowWasMinimized = false;
  let preserveBrowserOnError = false;
  let preserveBrowserAfterComplete = false;
  let preserveWindowStateOnError = false;
  let revealAuthenticatedWindow: (reason: string) => Promise<void> = async () => {};
  let disablePostSubmitInputGuard: () => Promise<boolean> = async () => true;
  let stopHumanInterventionMonitor: (() => void) | null = null;
  let humanInterventionPromise: Promise<never> | null = null;
  let manualLoginRecoveryInProgress = false;

  try {
    try {
      if (config.browserTabRef) {
        const attached = await connectToExistingChatGptTab({
          host: chromeHost,
          port: chrome.port,
          ref: config.browserTabRef,
        });
        client = attached.client;
        isolatedTargetId = attached.targetId ?? null;
        lastTargetId = attached.targetId ?? undefined;
        lastUrl = attached.tab.url || lastUrl;
        ownsTarget = false;
        logger(
          `Attached to existing ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
        );
      } else {
        const strictTabIsolation = Boolean(manualLogin && reusedChrome);
        const manageManagedWindowState =
          manualLogin &&
          shouldLaunchChromeMinimized({
            ...config,
            startMinimized: true,
          });
        let windowClient: ChromeClient | null = null;
        let tabSetupFailed = false;
        try {
          if (manageManagedWindowState) {
            await acquireProfileLockIfNeeded(lifecycleLockTimeoutMs);
          }
          windowClient = manageManagedWindowState
            ? ((await CDP({ host: chromeHost, port: chrome.port }).catch(
                () => null,
              )) as ChromeClient | null)
            : null;
          const observedWindowMinimized = windowClient
            ? await isChromeWindowMinimized(windowClient)
            : null;
          windowWasMinimized = Boolean(
            manageManagedWindowState &&
            (observedWindowMinimized ?? (config.startMinimized ? chromeLaunchMinimized : true)),
          );
          if (shouldCaptureLaunchTargetsForCleanup({ reusedChrome: Boolean(reusedChrome) })) {
            const initialTargets = await listRemoteChromeTargets({
              host: chromeHost,
              port: chrome.port,
            }).catch(() => []);
            launchTargetIds = selectDisposableLaunchTargetIds(initialTargets, null);
          }
          const connection = await connectWithNewTab(
            chrome.port,
            logger,
            "about:blank",
            chromeHost,
            {
              fallbackToDefault: !strictTabIsolation,
              retries: strictTabIsolation ? 3 : 0,
              retryDelayMs: 500,
            },
          );
          client = connection.client;
          isolatedTargetId = connection.targetId ?? null;
          if (!isolatedTargetId) {
            launchTargetIds = [];
          }
          if (config.startMinimized && manageManagedWindowState) {
            windowParkedAfterSetup = await hideChromeWindow(chrome, logger);
          } else if (!config.startMinimized && manageManagedWindowState) {
            let restored = await restoreChromeWindowByPid(chrome.pid, logger);
            if (!restored) {
              restored = await setChromeWindowState(client, "normal", logger, {
                targetId: isolatedTargetId ?? undefined,
                reason: "recovery-tab",
              });
            }
            windowParkedAfterSetup = !restored;
            if (restored) windowWasMinimized = false;
          }
          ownsTarget = true;
        } catch (error) {
          tabSetupFailed = true;
          throw error;
        } finally {
          if (tabSetupFailed && manageManagedWindowState && profileLock) {
            const restoreClient = client ?? windowClient;
            let restored = await restoreChromeWindowByPid(chrome.pid, logger);
            if (!restored && restoreClient) {
              restored = await setChromeWindowState(restoreClient, "normal", logger, {
                targetId: isolatedTargetId ?? undefined,
                reason: "tab-setup-failed",
              });
            }
            if (restored) windowWasMinimized = false;
          } else if (config.startMinimized && manageManagedWindowState && !windowParkedAfterSetup) {
            windowParkedAfterSetup = await hideChromeWindow(chrome, logger);
          }
          await windowClient?.close().catch(() => undefined);
          if (manageManagedWindowState) await releaseProfileLockIfHeld();
        }
      }
    } catch (error) {
      const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
      if (hint) {
        logger(hint);
      }
      throw error;
    }
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        if (manualLoginRecoveryInProgress) {
          logger("Managed Chrome target changed during manual login; discovering its replacement.");
          return;
        }
        connectionClosedUnexpectedly = true;
        logger("Managed Chrome connection lost; preserving the run for resume.");
        reject(
          new Error("Managed Chrome process or DevTools target was lost before ask-pro finished."),
        );
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([
        promise,
        disconnectPromise,
        ...(humanInterventionPromise ? [humanInterventionPromise] : []),
      ]);
    const { Network, Page, Runtime, Input, DOM } = client;
    const postSubmitInputGuard = shouldEnablePostSubmitInputGuard({
      ...config,
    })
      ? createPostSubmitInputGuard(Input, logger)
      : null;
    const continueResponse = createAssistantContinuation(
      Runtime,
      Input,
      logger,
      postSubmitInputGuard,
    );
    disablePostSubmitInputGuard = () => postSubmitInputGuard?.disable() ?? Promise.resolve(true);
    let authenticatedWindowParked =
      chromeLaunchMinimized || windowParkedAfterSetup || windowWasMinimized;
    revealAuthenticatedWindow = async (reason: string): Promise<void> => {
      if (!authenticatedWindowParked) return;
      const acquiredProfileLock = manualLogin
        ? await acquireProfileLockIfNeeded(lifecycleLockTimeoutMs)
        : false;
      try {
        let restored = await restoreChromeWindowByPid(chrome?.pid, logger);
        if (!restored && client) {
          restored = await setChromeWindowState(client, "normal", logger, {
            targetId: isolatedTargetId ?? lastTargetId,
            reason,
          });
        }
        if (restored) {
          authenticatedWindowParked = false;
        }
      } finally {
        if (acquiredProfileLock) await releaseProfileLockIfHeld();
      }
    };

    if (!config.headless && config.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (config.acceptLanguage) {
      await applyPageLanguageOverrides(client, config.acceptLanguage, logger);
    }
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
    const cookieSyncEnabled = config.cookieSync && (!manualLogin || manualLoginCookieSync);
    if (cookieSyncEnabled) {
      if (manualLoginCookieSync) {
        logger(
          "Manual login mode: seeding persistent profile with cookies from your Chrome profile.",
        );
      }
      if (!config.inlineCookies) {
        logger(
          "Heads-up: macOS may prompt for your Keychain password to read Chrome cookies; for answer-bearing sessions, use --copy to print a copy target or --harvest to print the raw answer.",
        );
      } else {
        logger("Applying inline cookies (skipping Chrome profile read and Keychain prompt)");
      }
      // Learned: always sync cookies before the first navigation so /backend-api/me succeeds.
      const cookieCount = await syncCookies(Network, config.url, config.chromeProfile, logger, {
        allowErrors: config.allowCookieErrors ?? false,
        filterNames: config.cookieNames ?? undefined,
        inlineCookies: config.inlineCookies ?? undefined,
        cookiePath: config.chromeCookiePath ?? undefined,
        waitMs: config.cookieSyncWaitMs ?? 0,
      });
      appliedCookies = cookieCount;
      if (config.inlineCookies && cookieCount === 0) {
        throw new Error("No inline cookies were applied; aborting before navigation.");
      }
      logger(
        cookieCount > 0
          ? config.inlineCookies
            ? `Applied ${cookieCount} inline cookies`
            : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
          : config.inlineCookies
            ? "No inline cookies applied; continuing without session reuse"
            : "No Chrome cookies found; continuing without session reuse",
      );
    } else {
      logger(
        manualLogin
          ? "Skipping Chrome cookie sync because manual browser login is enabled; reuse the opened profile after signing in."
          : "Skipping Chrome cookie sync because cookie sync is disabled.",
      );
    }

    if (cookieSyncEnabled && !manualLogin && (appliedCookies ?? 0) === 0 && !config.inlineCookies) {
      // Learned: if the profile has no ChatGPT cookies, browser mode will just bounce to login.
      // Fail early so the user knows to sign in.
      throw new BrowserAutomationError(
        "No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode. " +
          "Make sure ChatGPT is signed in in the selected profile, then retry or use the manual-login path.",
        {
          stage: "execute-browser",
          details: {
            profile: config.chromeProfile ?? "Default",
            cookiePath: config.chromeCookiePath ?? null,
            hint: "If macOS Keychain prompts or denies access, run ask-pro from a GUI session or use the manual browser profile.",
          },
        },
      );
    }

    const baseUrl = CHATGPT_URL;
    // First load the base ChatGPT homepage to satisfy potential interstitials,
    // then hop to the requested URL if it differs.
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, baseUrl, logger));
    await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    // Learned: login checks must happen on the base domain before jumping into project URLs.
    if (manualLogin) manualLoginRecoveryInProgress = true;
    await raceWithDisconnect(
      waitForLogin({
        runtime: Runtime,
        logger,
        appliedCookies,
        manualLogin,
        onAuthNeeded: async () => {
          await revealAuthenticatedWindow("login-required");
        },
      }),
    );
    if (manualLogin) manualLoginRecoveryInProgress = false;

    if (config.url !== baseUrl) {
      await raceWithDisconnect(
        navigateToPromptReadyWithFallback(Page, Runtime, {
          url: config.url,
          fallbackUrl: baseUrl,
          timeoutMs: config.inputTimeoutMs,
          headless: config.headless,
          logger,
        }),
      );
    } else {
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    const captureRuntimeSnapshot = async () => {
      try {
        if (client?.Target?.getTargetInfo) {
          const info = await client.Target.getTargetInfo({});
          lastTargetId = info?.targetInfo?.targetId ?? lastTargetId;
          lastUrl = info?.targetInfo?.url ?? lastUrl;
        }
      } catch {
        // ignore
      }
      try {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        if (typeof result?.value === "string") {
          lastUrl = result.value;
        }
      } catch {
        // ignore
      }
      if (lastUrl) {
        logger(`[browser] url = ${lastUrl}`);
      }
      if (chrome?.port) {
        const suffix = lastTargetId ? ` target=${lastTargetId}` : "";
        if (lastUrl) {
          logger(
            `[reattach] chrome port=${chrome.port} host=${chromeHost} url=${lastUrl}${suffix}`,
          );
        } else {
          logger(`[reattach] chrome port=${chrome.port} host=${chromeHost}${suffix}`);
        }
        await emitRuntimeHint();
      }
    };
    await captureRuntimeSnapshot().catch(() => undefined);
    if (postSubmitInputGuard) {
      const monitor = startHumanInterventionRestoreMonitor({
        Runtime,
        logger,
        revealWindow: revealAuthenticatedWindow,
        disableInputGuard: disablePostSubmitInputGuard,
      });
      stopHumanInterventionMonitor = monitor.stop;
      humanInterventionPromise = monitor.promise;
    }
    let expectedConversationUrl: string | undefined;
    let expectedConversationId: string | undefined;
    let conversationHintInFlight: Promise<boolean> | null = null;
    const lockConversationUrl = async (
      candidateUrl: string | null | undefined,
      label: string,
    ): Promise<boolean> => {
      if (!candidateUrl || !isConversationUrl(candidateUrl)) {
        return false;
      }
      const candidateId = extractConversationIdFromUrl(candidateUrl);
      if (!candidateId) {
        return false;
      }
      if (expectedConversationId && candidateId !== expectedConversationId) {
        logger(
          `[browser] Ignoring conversation drift (${label}); expected ${expectedConversationUrl}, saw ${candidateUrl}`,
        );
        return false;
      }
      expectedConversationUrl = candidateUrl;
      expectedConversationId = candidateId;
      lastUrl = candidateUrl;
      logger(`[browser] conversation url (${label}) = ${candidateUrl}`);
      await emitRuntimeHint();
      return true;
    };
    const updateConversationHint = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
      if (!chrome?.port) {
        return false;
      }
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const { result } = await Runtime.evaluate({
            expression: "location.href",
            returnByValue: true,
          });
          if (
            typeof result?.value === "string" &&
            (await lockConversationUrl(result.value, label))
          ) {
            return true;
          }
        } catch {
          // ignore; keep polling until timeout
        }
        await delay(250);
      }
      return false;
    };
    const scheduleConversationHint = (label: string, timeoutMs?: number): void => {
      if (conversationHintInFlight) {
        return;
      }
      // Learned: the /c/ URL can update after the answer; emit hints in the background.
      // Run in the background so prompt submission/streaming isn't blocked by slow URL updates.
      conversationHintInFlight = updateConversationHint(label, timeoutMs)
        .catch(() => false)
        .finally(() => {
          conversationHintInFlight = null;
        });
    };
    const ensureExpectedConversation = async (label: string): Promise<boolean> => {
      if (!expectedConversationUrl || !expectedConversationId) {
        return false;
      }
      const currentUrl = await readConversationUrl(Runtime);
      const currentId = currentUrl ? extractConversationIdFromUrl(currentUrl) : undefined;
      if (currentId === expectedConversationId) {
        if (currentUrl && currentUrl !== lastUrl) {
          lastUrl = currentUrl;
          await emitRuntimeHint();
        }
        return true;
      }
      logger(
        `[browser] Conversation drifted during ${label}; restoring ${expectedConversationUrl}`,
      );
      await raceWithDisconnect(Page.navigate({ url: expectedConversationUrl }));
      await raceWithDisconnect(delay(1000));
      lastUrl = expectedConversationUrl;
      await emitRuntimeHint();
      return true;
    };
    await captureRuntimeSnapshot();
    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore") {
      await raceWithDisconnect(
        withRetries(
          () => ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
          {
            retries: 2,
            delayMs: 300,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      ).catch((error) => {
        const base = error instanceof Error ? error.message : String(error);
        const hint =
          appliedCookies === 0
            ? " No cookies were applied; sign in to ChatGPT in the opened browser, then resume."
            : "";
        throw new Error(`${base}${hint}`);
      });
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore") {
      logger("Model picker: skipped (strategy=ignore)");
    }
    // Handle thinking time selection if specified
    const thinkingTime = config.thinkingTime;
    if (thinkingTime) {
      await raceWithDisconnect(
        withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        }),
      );
    }
    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      try {
        const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
        const baselineAssistantText =
          typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
        const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
        let inputOnlyAttachments = false;
        if (submissionAttachments.length > 0) {
          if (!DOM) {
            throw new Error("Chrome DOM domain unavailable while uploading attachments.");
          }
          await clearComposerAttachments(Runtime, 5_000, logger);
          for (
            let attachmentIndex = 0;
            attachmentIndex < submissionAttachments.length;
            attachmentIndex += 1
          ) {
            const attachment = submissionAttachments[attachmentIndex];
            logger(`Uploading attachment: ${attachment.displayPath}`);
            const uiConfirmed = await raceWithDisconnect(
              uploadAttachmentFile(
                { runtime: Runtime, dom: DOM, input: Input },
                attachment,
                logger,
                { expectedCount: attachmentIndex + 1 },
              ),
            );
            if (!uiConfirmed) {
              inputOnlyAttachments = true;
            }
            await delay(500);
          }
          // Scale timeout based on number of files: base 45s + 20s per additional file.
          const baseTimeout = config.inputTimeoutMs ?? 30_000;
          const perFileTimeout = 20_000;
          const waitBudget =
            Math.max(baseTimeout, 45_000) + (submissionAttachments.length - 1) * perFileTimeout;
          await raceWithDisconnect(
            waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger),
          );
          logger("All attachments uploaded");
        }
        let baselineTurns = await readConversationTurnCount(Runtime, logger);
        // Learned: return baselineTurns so assistant polling can ignore earlier content.
        const providerState: Record<string, unknown> = {
          runtime: Runtime,
          input: Input,
          logger,
          timeoutMs: config.timeoutMs,
          inputTimeoutMs: config.inputTimeoutMs ?? undefined,
          baselineTurns: baselineTurns ?? undefined,
          attachmentNames,
          afterSubmit: postSubmitInputGuard ? () => postSubmitInputGuard.enable() : undefined,
        };
        await raceWithDisconnect(
          runProviderSubmissionFlow(chatgptDomProvider, {
            prompt,
            evaluate: async () => undefined,
            delay,
            log: logger,
            state: providerState,
          }),
        );
        const providerBaselineTurns = providerState.baselineTurns;
        if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
          baselineTurns = providerBaselineTurns;
        }
        if (attachmentNames.length > 0) {
          if (inputOnlyAttachments) {
            logger(
              "Attachment UI did not render before send; skipping user-turn attachment verification.",
            );
          } else {
            const verified = await raceWithDisconnect(
              waitForUserTurnAttachments(Runtime, attachmentNames, 20_000, logger, {
                minTurnIndex: baselineTurns ?? undefined,
                expectedPrompt: prompt,
                expectedConversationId,
              }),
            );
            if (!verified) {
              logger(
                "Sent user message attachment UI was not visible after upload; continuing because upload and send completed.",
              );
            } else {
              logger("Verified attachments present on sent user message");
            }
          }
        }
        // Reattach needs a /c/ URL; ChatGPT can update it late, so poll in the background.
        scheduleConversationHint("post-submit", config.timeoutMs ?? 120_000);
        await updateConversationHint("post-submit", 15_000).catch(() => false);
        return { baselineTurns, baselineAssistantText };
      } catch (error) {
        await postSubmitInputGuard?.disable();
        throw error;
      }
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await raceWithDisconnect(Page.reload({ ignoreCache: true }));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    };
    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    await acquireProfileLockIfNeeded();
    try {
      const submission = await runSubmissionWithRecovery({
        prompt: promptText,
        attachments,
        fallbackSubmission,
        submit: (submissionPrompt, submissionAttachments) =>
          raceWithDisconnect(submitOnce(submissionPrompt, submissionAttachments)),
        reloadPromptComposer,
        prepareFallbackSubmission: async () => {
          await raceWithDisconnect(clearPromptComposer(Runtime, logger));
          await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        },
        logger,
      });
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
      await closeLaunchTabs();
    } finally {
      await releaseProfileLockIfHeld();
    }
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId,
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    let answer: {
      text: string;
      html?: string;
      meta: { turnId?: string | null; messageId?: string | null };
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await raceWithDisconnect(delay(recheckDelayMs));
      await updateConversationHint("assistant-recheck", 15_000).catch(() => false);
      await ensureExpectedConversation("assistant-recheck").catch(() => false);
      await captureRuntimeSnapshot().catch(() => undefined);
      const conversationUrl = expectedConversationUrl ?? (await readConversationUrl(Runtime));
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await raceWithDisconnect(Page.navigate({ url: conversationUrl }));
        await raceWithDisconnect(delay(1000));
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            },
          },
        );
      }
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        raceWithDisconnect(
          waitForAssistantResponseWithReload(
            Runtime,
            Page,
            timeoutMs,
            logger,
            baselineTurns ?? undefined,
            expectedConversationUrl,
            expectedConversationId,
            continueResponse,
          ),
        ),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    try {
      try {
        await ensureExpectedConversation("assistant-wait").catch(() => false);
        answer = await waitWithThinkingMonitor(() =>
          raceWithDisconnect(
            waitForAssistantResponseWithReload(
              Runtime,
              Page,
              config.timeoutMs,
              logger,
              baselineTurns ?? undefined,
              expectedConversationUrl,
              expectedConversationId,
              continueResponse,
            ),
          ),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheck().catch((error) => {
            if (error instanceof AssistantStoppedError) throw error;
            return null;
          });
          if (rechecked) {
            answer = rechecked;
          } else {
            await updateConversationHint("assistant-timeout", 15_000).catch(() => false);
            await ensureExpectedConversation("assistant-timeout").catch(() => false);
            await captureRuntimeSnapshot().catch(() => undefined);
            const runtime = {
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            };
            throw new BrowserAutomationError(
              "Assistant response timed out before completion; reattach later to capture the answer.",
              { stage: "assistant-timeout", runtime },
              error,
            );
          }
        } else {
          throw error;
        }
      }
    } finally {
      await postSubmitInputGuard?.disable();
    }
    // Ensure we store the final conversation URL even if the UI updated late.
    await updateConversationHint("post-response", 15_000);
    await ensureExpectedConversation("post-response").catch(() => false);
    const baselineNormalized = baselineAssistantText
      ? normalizeForComparison(baselineAssistantText)
      : "";
    if (baselineNormalized) {
      const normalizedAnswer = normalizeForComparison(answer.text ?? "");
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const isBaseline =
        normalizedAnswer === baselineNormalized ||
        (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
      if (isBaseline) {
        logger("Detected stale assistant response; waiting for new response...");
        const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
        if (refreshed) {
          answer = refreshed;
        }
      }
    }
    answerText = answer.text;
    answerHtml = answer.html ?? "";
    const copiedMarkdown = await raceWithDisconnect(
      withRetries(
        async () => {
          const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
          if (!attempt) {
            throw new Error("copy-missing");
          }
          return attempt;
        },
        {
          retries: 2,
          delayMs: 350,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      ),
    ).catch(() => null);
    answerMarkdown = copiedMarkdown ?? answerText;

    const promptEchoMatcher = buildPromptEchoMatcher(promptText);
    ({ answerText, answerMarkdown } = await maybeRecoverLongAssistantResponse({
      runtime: Runtime,
      baselineTurns,
      expectedConversationId,
      answerText,
      answerMarkdown,
      logger,
      allowMarkdownUpdate: !copiedMarkdown,
    }));

    // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
    const finalSnapshot = await readAssistantSnapshot(
      Runtime,
      baselineTurns ?? undefined,
      expectedConversationId,
    ).catch(() => null);
    const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
    if (finalText && finalText !== promptText.trim()) {
      const trimmedMarkdown = answerMarkdown.trim();
      const finalIsEcho = promptEchoMatcher ? promptEchoMatcher.isEcho(finalText) : false;
      const lengthDelta = finalText.length - trimmedMarkdown.length;
      const missingCopy = !copiedMarkdown && lengthDelta >= 0;
      const likelyTruncatedCopy =
        copiedMarkdown &&
        trimmedMarkdown.length > 0 &&
        lengthDelta >= Math.max(12, Math.floor(trimmedMarkdown.length * 0.75));
      if ((missingCopy || likelyTruncatedCopy) && !finalIsEcho && finalText !== trimmedMarkdown) {
        logger("Refreshed assistant response via final DOM snapshot");
        answerText = finalText;
        answerMarkdown = finalText;
      }
    }

    // Detect prompt echo using normalized comparison (whitespace-insensitive).
    const alignedEcho = alignPromptEchoPair(
      answerText,
      answerMarkdown,
      promptEchoMatcher,
      copiedMarkdown ? logger : undefined,
      {
        text: "Aligned assistant response text to copied markdown after prompt echo",
        markdown: "Aligned assistant markdown to response text after prompt echo",
      },
    );
    answerText = alignedEcho.answerText;
    answerMarkdown = alignedEcho.answerMarkdown;
    const isPromptEcho = alignedEcho.isEcho;
    if (isPromptEcho) {
      logger("Detected prompt echo in response; waiting for actual assistant response...");
      const deadline = Date.now() + 15_000;
      let bestText: string | null = null;
      let stableCount = 0;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId,
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
        if (!isStillEcho) {
          if (!bestText || text.length > bestText.length) {
            bestText = text;
            stableCount = 0;
          } else if (text === bestText) {
            stableCount += 1;
          }
          if (stableCount >= 2) {
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (bestText) {
        logger("Recovered assistant response after detecting prompt echo");
        answerText = bestText;
        answerMarkdown = bestText;
      }
    }
    const minAnswerChars = 16;
    if (answerText.trim().length > 0 && answerText.trim().length < minAnswerChars) {
      const deadline = Date.now() + 12_000;
      let bestText = answerText.trim();
      let stableCycles = 0;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId,
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text && text.length > bestText.length) {
          bestText = text;
          stableCycles = 0;
        } else {
          stableCycles += 1;
        }
        if (stableCycles >= 3 && bestText.length >= minAnswerChars) {
          break;
        }
        await delay(400);
      }
      if (bestText.length > answerText.trim().length) {
        logger("Refreshed short assistant response from latest DOM snapshot");
        answerText = bestText;
        answerMarkdown = bestText;
      }
    }
    if (connectionClosedUnexpectedly) {
      // Bail out on mid-run disconnects so the session stays reattachable.
      throw new Error("Chrome disconnected before completion");
    }
    if (options.afterAnswerCb) {
      const afterAnswerResult = await options.afterAnswerCb({
        Runtime,
        Page,
        Input,
        answer: {
          text: answerText,
          markdown: answerMarkdown,
          html: answerHtml || undefined,
          meta: answer.meta,
        },
      });
      preserveBrowserAfterComplete = Boolean(afterAnswerResult?.keepBrowserOpen);
      if (preserveBrowserAfterComplete) {
        await revealAuthenticatedWindow("debug-retention");
      }
    }
    runStatus = "complete";
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      controllerPid: process.pid,
    };
  } catch (error) {
    let normalizedError = error instanceof Error ? error : new Error(String(error));
    if (manualLoginRecoveryInProgress && isWebSocketClosureError(normalizedError)) {
      const livePort = await readDevToolsPort(userDataDir);
      const endpoint = livePort
        ? await verifyDevToolsReachable({
            host: chromeHost,
            port: livePort,
            attempts: 2,
            timeoutMs: 1000,
          })
        : null;
      if (endpoint?.ok) {
        normalizedError = new BrowserAutomationError(
          "ChatGPT login target changed; discovering the authenticated replacement.",
          { stage: "login-required" },
          normalizedError,
        );
        connectionClosedUnexpectedly = false;
      }
    }
    preserveWindowStateOnError =
      options.shouldPreserveWindowStateOnError?.(normalizedError) ?? false;
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    if (shouldPreserveBrowserOnError(normalizedError, config.headless)) {
      preserveBrowserOnError = true;
      await revealAuthenticatedWindow("manual-recovery");
      const stage =
        normalizedError instanceof BrowserAutomationError
          ? String(normalizedError.details?.stage ?? "")
          : "";
      const isLoginRequired = stage === "login-required";
      const runtime = {
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      };
      const reuseProfileHint = `ask-pro --resume <session-id> # browser profile: ${JSON.stringify(userDataDir)}`;
      await emitRuntimeHint();
      logger(
        isLoginRequired
          ? "ChatGPT login required; leaving browser open so you can sign in."
          : "Cloudflare challenge detected; leaving browser open so you can complete the check.",
      );
      logger(`Reuse this browser profile with: ${reuseProfileHint}`);
      if (isLoginRequired && manualLogin) {
        const recoveryRuntime = client?.Runtime;
        if (!recoveryRuntime) {
          throw normalizedError;
        }
        manualLoginRecoveryInProgress = true;
        try {
          logger(
            "Manual login mode: waiting for sign-in to complete, then restarting the ask-pro submission...",
          );
          await openLoginSurfaceForHumanAction(recoveryRuntime, logger).catch(() => undefined);
          await revealAuthenticatedWindow("login-required");
          const recovered = await waitForManualLoginOnLiveChrome({
            host: chromeHost,
            port: chrome.port,
            userDataDir,
            previousTargetId: isolatedTargetId,
            previousTargetOwned: ownsTarget,
            logger,
            timeoutMs: Math.min(config.manualLoginWaitMs ?? config.timeoutMs, config.timeoutMs),
          });
          logger("Manual login completed; restarting ask-pro submission.");
          preserveBrowserOnError = false;
          await client?.close().catch(() => undefined);
          if (isolatedTargetId && ownsTarget) {
            await closeTab(chrome.port, isolatedTargetId, logger, chromeHost);
            ownsTarget = false;
          }
          if (chrome.port !== recovered.port) {
            const replacementChrome = await maybeReuseRunningChrome(userDataDir, logger);
            if (!replacementChrome || replacementChrome.port !== recovered.port) {
              throw new BrowserAutomationError(
                "Managed Chrome lifecycle changed during login and could not be reacquired.",
                { stage: "connection-lost" },
              );
            }
            releaseChromeProcessHandle(chrome);
            Object.assign(chrome, replacementChrome);
          }
          isolatedTargetId = recovered.ownsTarget ? recovered.targetId : null;
          ownsTarget = recovered.ownsTarget;
          connectionClosedUnexpectedly = false;
          const restartedResult = await runBrowserMode(
            config.browserTabRef
              ? {
                  ...options,
                  config: { ...options.config, browserTabRef: recovered.targetId },
                }
              : options,
          );
          runStatus = "complete";
          return restartedResult;
        } finally {
          manualLoginRecoveryInProgress = false;
        }
      }
      throw new BrowserAutomationError(
        isLoginRequired
          ? "ChatGPT login required. Sign in in the open browser, then rerun."
          : "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.",
        {
          stage: isLoginRequired ? "login-required" : "cloudflare-challenge",
          runtime,
          reuseProfileHint,
        },
        normalizedError,
      );
    }
    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
      logger(`Managed Chrome connection lost before completion: ${normalizedError.message}`);
      logger(normalizedError.stack);
    }
    await emitRuntimeHint();
    throw new BrowserAutomationError(
      "Managed Chrome process or DevTools target was lost before ask-pro finished. The session remains resumable.",
      {
        stage: "connection-lost",
        runtime: {
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: lastUrl,
          controllerPid: process.pid,
        },
      },
      normalizedError,
    );
  } finally {
    stopHumanInterventionMonitor?.();
    const keepBrowserOpen =
      preserveBrowserAfterComplete ||
      preserveBrowserOnError ||
      (effectiveKeepBrowser && runStatus !== "complete");
    try {
      const guardDisabled = await disablePostSubmitInputGuard();
      if (!guardDisabled && (keepBrowserOpen || connectionClosedUnexpectedly)) {
        logger(
          "[browser] Post-submit input guard may still be active; retained browser may require closing and relaunching.",
        );
      }
      if (keepBrowserOpen && !preserveWindowStateOnError) {
        await revealAuthenticatedWindow("browser-retained");
      } else if (connectionClosedUnexpectedly) {
        await revealAuthenticatedWindow("connection-lost");
      }
      if (!connectionClosedUnexpectedly) {
        await client?.close();
      }
    } catch {
      // ignore
    }
    // Close the isolated tab once the response has been fully captured to prevent
    // tab accumulation across repeated runs. Keep the tab open on incomplete runs
    // so reattach can recover the response.
    if (
      runStatus === "complete" &&
      !preserveBrowserAfterComplete &&
      isolatedTargetId &&
      chrome?.port &&
      ownsTarget
    ) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }
    await closeLaunchTabs();
    try {
      let peerRunCount: number | null = 0;
      if (managedChromeRunLease) {
        try {
          await acquireProfileLockIfNeeded(lifecycleLockTimeoutMs);
          peerRunCount = await releaseManagedChromeRunLeaseAndCountPeers(
            userDataDir,
            managedChromeRunLease,
            logger,
          );
          managedChromeRunLease = null;
        } catch (error) {
          peerRunCount = null;
          const message = error instanceof Error ? error.message : String(error);
          logger(`Failed to resolve shared Chrome ownership; retaining browser (${message})`);
        }
      }
      let remainingTargets: Awaited<ReturnType<typeof listRemoteChromeTargets>> | null = null;
      if (peerRunCount === 0 && !keepBrowserOpen && !connectionClosedUnexpectedly) {
        try {
          remainingTargets = await listRemoteChromeTargets({ host: chromeHost, port: chrome.port });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger(`Failed to inspect remaining Chrome tabs; retaining browser (${message})`);
        }
      }
      const cleanupDecision = decideManagedChromeCleanup({
        keepBrowserOpen,
        connectionClosedUnexpectedly,
        peerRunCount,
        remainingTargets,
        completedRunTargetId: ownsTarget ? isolatedTargetId : null,
      });
      removeDialogHandler?.();
      removeTerminationHooks?.();
      if (!keepBrowserOpen) {
        if (cleanupDecision === "close-browser") {
          try {
            await closeChromeGracefully(chrome, logger);
          } catch {
            // ignore close failures
          }
        } else if (cleanupDecision === "retain-browser") {
          releaseChromeProcessHandle(chrome);
          logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
        }
        if (manualLogin) {
          const shouldCleanup =
            cleanupDecision !== "retain-browser" &&
            (await shouldCleanupManualLoginProfileState(
              userDataDir,
              logger.verbose ? logger : undefined,
              {
                connectionClosedUnexpectedly,
                host: chromeHost,
              },
            ));
          if (shouldCleanup) {
            // Preserve the persistent manual-login profile, but clear stale reattach hints.
            await cleanupStaleProfileState(userDataDir, logger, {
              lockRemovalMode: "never",
            }).catch(() => undefined);
          }
        } else if (cleanupDecision !== "retain-browser") {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (!connectionClosedUnexpectedly) {
          const totalSeconds = (Date.now() - startedAt) / 1000;
          logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
        }
      } else if (!connectionClosedUnexpectedly) {
        releaseChromeProcessHandle(chrome);
        logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
      }
    } finally {
      await releaseProfileLockIfHeld();
    }
  }
}

const DEFAULT_DEBUG_PORT = 9222;

async function pickAvailableDebugPort(
  preferredPort: number,
  logger: BrowserLogger,
): Promise<number> {
  const start =
    Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DEBUG_PORT;
  for (let offset = 0; offset < 10; offset++) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  const fallback = await findEphemeralPort();
  logger(`DevTools ports ${start}-${start + 9} are occupied; falling back to ${fallback}.`);
  return fallback;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to acquire ephemeral port")));
      }
    });
  });
}

async function waitForLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  onAuthNeeded,
  ensureLoggedInFn,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  onAuthNeeded?: () => void | Promise<void>;
  ensureLoggedInFn?: typeof ensureLoggedIn;
}): Promise<void> {
  const checkLogin = ensureLoggedInFn ?? ensureLoggedIn;
  const notifyAuthNeeded = async (): Promise<void> => {
    try {
      await onAuthNeeded?.();
    } catch (hookError) {
      logger(
        `Failed to reveal browser for auth recovery: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
      );
    }
  };
  if (!manualLogin) {
    try {
      await checkLogin(runtime, logger, { appliedCookies });
    } catch (error) {
      await notifyAuthNeeded();
      throw error;
    }
    return;
  }
  try {
    await checkLogin(runtime, logger, { appliedCookies });
  } catch (error) {
    await notifyAuthNeeded();
    const message = error instanceof Error ? error.message : String(error);
    if (!isRecoverableManualLoginMessage(message)) throw error;
    throw new BrowserAutomationError(
      "ChatGPT login required; waiting for sign-in in the open managed browser.",
      { stage: "login-required" },
      error,
    );
  }
}

function isRecoverableManualLoginMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("session not detected") ||
    normalized.includes("login button") ||
    normalized.includes("login appears missing") ||
    normalized.includes("not signed into chatgpt") ||
    normalized.includes("no chatgpt cookies") ||
    normalized.includes("sign in to chatgpt")
  );
}

async function waitForManualLoginOnLiveChrome({
  host,
  port,
  userDataDir,
  previousTargetId,
  previousTargetOwned,
  logger,
  timeoutMs,
}: {
  host: string;
  port: number;
  userDataDir: string;
  previousTargetId: string | null;
  previousTargetOwned: boolean;
  logger: BrowserLogger;
  timeoutMs: number;
}): Promise<{ port: number; targetId: string; ownsTarget: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let lastNotice = 0;
  let currentPort = port;
  while (Date.now() < deadline) {
    const savedPort = await readDevToolsPort(userDataDir);
    if (savedPort && savedPort !== currentPort) {
      currentPort = savedPort;
      logger(
        `Managed Chrome DevTools endpoint changed during login; continuing on port ${savedPort}.`,
      );
    }
    let targets: Awaited<ReturnType<typeof listLoginRecoveryTargets>>;
    try {
      targets = await listLoginRecoveryTargets(host, currentPort);
    } catch {
      const replacementPort = await readDevToolsPort(userDataDir);
      if (replacementPort && replacementPort !== currentPort) {
        currentPort = replacementPort;
        logger(
          `Managed Chrome DevTools endpoint changed during login; continuing on port ${replacementPort}.`,
        );
        continue;
      }
      const endpoint = await verifyDevToolsReachable({
        host,
        port: currentPort,
        attempts: 1,
        timeoutMs: 1000,
      });
      if (!endpoint.ok) {
        throw new BrowserAutomationError(
          "Managed Chrome process or DevTools endpoint was lost during manual login. The session remains resumable.",
          { stage: "connection-lost" },
        );
      }
      targets = [];
    }
    for (const target of targets) {
      const targetId = target.targetId ?? target.id;
      if (!targetId) continue;
      let client: ChromeClient | null = null;
      try {
        client = (await CDP({
          host,
          port: currentPort,
          target: targetId,
        })) as ChromeClient;
        const targetInfo = await client.Target.getTargetInfo({ targetId }).catch(() => null);
        const openerId = targetInfo?.targetInfo?.openerId;
        if (
          !isEligibleManualLoginRecoveryTarget(
            previousTargetOwned,
            previousTargetId,
            targetId,
            openerId,
          )
        ) {
          continue;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await withTimeout(
          ensureLoggedIn(client.Runtime, logger, { appliedCookies: 0, passive: true }),
          remainingMs,
          "Manual login recovery probe timed out",
        );
        return {
          port: currentPort,
          targetId,
          ownsTarget: isRecoveredTargetOwned(
            previousTargetOwned,
            previousTargetId,
            targetId,
            openerId,
          ),
        };
      } catch (error) {
        if (logger.verbose) {
          logger(
            `Manual login passive probe failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        await client?.close().catch(() => undefined);
      }
    }
    if (Date.now() >= deadline) break;
    const now = Date.now();
    if (now - lastNotice > 5000) {
      logger("Manual login mode: waiting in the opened Chrome login tab...");
      lastNotice = now;
    }
    await delay(1000);
  }
  throw new BrowserAutomationError(
    "Manual login mode timed out waiting for ChatGPT session; sign in in the open browser, then resume.",
    { stage: "login-required" },
  );
}

function isRecoveredTargetOwned(
  previousTargetOwned: boolean,
  previousTargetId: string | null,
  recoveredTargetId: string,
  openerId?: string,
): boolean {
  return (
    previousTargetOwned && isRelatedManualLoginTarget(previousTargetId, recoveredTargetId, openerId)
  );
}

function isEligibleManualLoginRecoveryTarget(
  previousTargetOwned: boolean,
  previousTargetId: string | null,
  candidateTargetId: string,
  openerId?: string,
): boolean {
  return (
    previousTargetOwned || isRelatedManualLoginTarget(previousTargetId, candidateTargetId, openerId)
  );
}

function isRelatedManualLoginTarget(
  previousTargetId: string | null,
  candidateTargetId: string,
  openerId?: string,
): boolean {
  return (
    previousTargetId !== null &&
    (candidateTargetId === previousTargetId || openerId === previousTargetId)
  );
}

async function listLoginRecoveryTargets(
  host: string,
  port: number,
): Promise<Array<{ id?: string; targetId?: string; url?: string; type?: string }>> {
  const targets = await listRemoteChromeTargets({ host, port });
  const pages = targets.filter((target) => !target.type || target.type === "page");
  return pages.filter((target) => isLoginRecoveryUrl(target.url));
}

function isLoginRecoveryUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      isAllowedLoginRecoveryHost(parsed.hostname, "chatgpt.com") ||
      isAllowedLoginRecoveryHost(parsed.hostname, "openai.com") ||
      isAllowedLoginRecoveryHost(parsed.hostname, "auth0.com")
    );
  } catch {
    return false;
  }
}

function isAllowedLoginRecoveryHost(hostname: string, domain: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

async function maybeRecoverLongAssistantResponse({
  runtime,
  baselineTurns,
  expectedConversationId,
  answerText,
  answerMarkdown,
  logger,
  allowMarkdownUpdate,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  expectedConversationId?: string;
  answerText: string;
  answerMarkdown: string;
  logger: BrowserLogger;
  allowMarkdownUpdate: boolean;
}): Promise<{ answerText: string; answerMarkdown: string }> {
  // Learned: long streaming responses can still be rendering after initial capture.
  // Add a brief delay and re-poll to catch any additional content (#71).
  const capturedLength = answerText.trim().length;
  if (capturedLength <= 500) {
    return { answerText, answerMarkdown };
  }

  await delay(1500);
  let bestLength = capturedLength;
  let bestText = answerText;
  for (let i = 0; i < 5; i++) {
    const laterSnapshot = await readAssistantSnapshot(
      runtime,
      baselineTurns ?? undefined,
      expectedConversationId,
    ).catch(() => null);
    const laterText = typeof laterSnapshot?.text === "string" ? laterSnapshot.text.trim() : "";
    if (laterText.length > bestLength) {
      bestLength = laterText.length;
      bestText = laterText;
      await delay(800); // More content appeared, keep waiting
    } else {
      break; // Stable, stop polling
    }
  }
  if (bestLength > capturedLength) {
    logger(`Recovered ${bestLength - capturedLength} additional chars via delayed re-read`);
    return {
      answerText: bestText,
      answerMarkdown: allowMarkdownUpdate ? bestText : answerMarkdown,
    };
  }
  return { answerText, answerMarkdown };
}

async function _assertNavigatedToHttp(
  runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";
  while (Date.now() < deadline) {
    const { result } = await runtime.evaluate({
      expression: 'typeof location === "object" && location.href ? location.href : ""',
      returnByValue: true,
    });
    const url = typeof result?.value === "string" ? result.value : "";
    lastUrl = url;
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    await delay(250);
  }
  throw new BrowserAutomationError("ChatGPT session not detected; page never left new tab.", {
    stage: "execute-browser",
    details: { url: lastUrl || "(empty)" },
  });
}

async function runRemoteBrowserMode(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  options: BrowserRunOptions,
): Promise<BrowserRunResult> {
  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error(
      "Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.",
    );
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let remoteTargetId: string | null = null;
  let lastUrl: string | undefined;
  let expectedConversationUrl: string | undefined;
  let expectedConversationId: string | undefined;
  let attachedExistingTab = false;
  let ownsTarget = true;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async () => {
    if (!runtimeHintCb) return;
    try {
      const conversationId = lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined;
      await runtimeHintCb({
        chromePort: port,
        chromeHost: host,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        conversationId,
        controllerPid: process.pid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let connection: Awaited<ReturnType<typeof connectToRemoteChrome>> | null = null;
  const browserWSEndpoint = config.remoteChromeBrowserWSEndpoint ?? undefined;
  const chromeProfileRoot = config.remoteChromeProfileRoot ?? undefined;

  try {
    if (config.browserTabRef) {
      const attached = await connectToExistingChatGptTab({
        host,
        port,
        ref: config.browserTabRef,
      });
      client = attached.client;
      remoteTargetId = attached.targetId ?? null;
      lastUrl = attached.tab.url || lastUrl;
      attachedExistingTab = true;
      ownsTarget = false;
      logger(
        `Attached to existing remote ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
      );
    } else {
      connection = await connectToRemoteChrome(
        host,
        port,
        logger,
        "about:blank",
        browserWSEndpoint,
        {
          approvalWaitMs: config.attachRunning && browserWSEndpoint ? 20_000 : undefined,
        },
      );
      client = connection.client;
      remoteTargetId = connection.targetId ?? null;
      ownsTarget = true;
    }
    await emitRuntimeHint();
    const markConnectionLost = () => {
      connectionClosedUnexpectedly = true;
    };
    client.on("disconnect", markConnectionLost);
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
        reject(new Error("Remote Chrome connection lost during browser automation."));
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);
    const lockConversationUrl = async (
      candidateUrl: string | null | undefined,
      label: string,
    ): Promise<boolean> => {
      if (!candidateUrl || !isConversationUrl(candidateUrl)) {
        return false;
      }
      const candidateId = extractConversationIdFromUrl(candidateUrl);
      if (!candidateId) {
        return false;
      }
      if (expectedConversationId && candidateId !== expectedConversationId) {
        logger(
          `[browser] Ignoring conversation drift (${label}); expected ${expectedConversationUrl}, saw ${candidateUrl}`,
        );
        return false;
      }
      expectedConversationUrl = candidateUrl;
      expectedConversationId = candidateId;
      lastUrl = candidateUrl;
      logger(`[browser] conversation url (${label}) = ${candidateUrl}`);
      await emitRuntimeHint();
      return true;
    };
    const updateConversationHint = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const { result } = await Runtime.evaluate({
            expression: "location.href",
            returnByValue: true,
          });
          if (
            typeof result?.value === "string" &&
            (await lockConversationUrl(result.value, label))
          ) {
            return true;
          }
        } catch {
          // ignore; keep polling until timeout
        }
        await delay(250);
      }
      return false;
    };
    const ensureExpectedConversation = async (label: string): Promise<boolean> => {
      if (!expectedConversationUrl || !expectedConversationId) {
        return false;
      }
      const currentUrl = await readConversationUrl(Runtime);
      const currentId = currentUrl ? extractConversationIdFromUrl(currentUrl) : undefined;
      if (currentId === expectedConversationId) {
        if (currentUrl && currentUrl !== lastUrl) {
          lastUrl = currentUrl;
          await emitRuntimeHint();
        }
        return true;
      }
      logger(
        `[browser] Conversation drifted during ${label}; restoring ${expectedConversationUrl}`,
      );
      await raceWithDisconnect(Page.navigate({ url: expectedConversationUrl }));
      await raceWithDisconnect(delay(1000));
      lastUrl = expectedConversationUrl;
      await emitRuntimeHint();
      return true;
    };
    const { Network, Page, Runtime, Input, DOM } = client;
    const postSubmitInputGuard = shouldEnablePostSubmitInputGuard(config)
      ? createPostSubmitInputGuard(Input, logger)
      : null;
    const continueResponse = createAssistantContinuation(
      Runtime,
      Input,
      logger,
      postSubmitInputGuard,
    );

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (config.acceptLanguage) {
      await applyPageLanguageOverrides(client, config.acceptLanguage, logger);
    }
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);

    // Skip cookie sync for remote Chrome - it already has cookies
    logger("Skipping cookie sync for remote Chrome (using existing session)");

    if (!attachedExistingTab) {
      await raceWithDisconnect(navigateToChatGPT(Page, Runtime, config.url, logger));
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
      await raceWithDisconnect(ensureLoggedIn(Runtime, logger, { remoteSession: true }));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    } else {
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
      await raceWithDisconnect(ensureLoggedIn(Runtime, logger, { remoteSession: true }));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    try {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      if (typeof result?.value === "string") {
        lastUrl = result.value;
      }
      await emitRuntimeHint();
    } catch {
      // ignore
    }

    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore") {
      await withRetries(
        () => ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
        {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      );
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore") {
      logger("Model picker: skipped (strategy=ignore)");
    }
    // Handle thinking time selection if specified
    const thinkingTime = config.thinkingTime;
    if (thinkingTime) {
      await raceWithDisconnect(
        withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        }),
      );
    }

    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      try {
        const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
        const baselineAssistantText =
          typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
        const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
        if (submissionAttachments.length > 0) {
          if (!DOM) {
            throw new Error("Chrome DOM domain unavailable while uploading attachments.");
          }
          await clearComposerAttachments(Runtime, 5_000, logger);
          // Use remote file transfer for remote Chrome (reads local files and injects via CDP)
          for (const attachment of submissionAttachments) {
            logger(`Uploading attachment: ${attachment.displayPath}`);
            await uploadAttachmentViaDataTransfer(
              { runtime: Runtime, dom: DOM },
              attachment,
              logger,
            );
            await delay(500);
          }
          // Scale timeout based on number of files: base 30s + 15s per additional file
          const baseTimeout = config.inputTimeoutMs ?? 30_000;
          const perFileTimeout = 15_000;
          const waitBudget =
            Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
          await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
          logger("All attachments uploaded");
        }
        let baselineTurns = await readConversationTurnCount(Runtime, logger);
        const providerState: Record<string, unknown> = {
          runtime: Runtime,
          input: Input,
          logger,
          timeoutMs: config.timeoutMs,
          inputTimeoutMs: config.inputTimeoutMs ?? undefined,
          baselineTurns: baselineTurns ?? undefined,
          attachmentNames,
          afterSubmit: postSubmitInputGuard ? () => postSubmitInputGuard.enable() : undefined,
        };
        await runProviderSubmissionFlow(chatgptDomProvider, {
          prompt,
          evaluate: async () => undefined,
          delay,
          log: logger,
          state: providerState,
        });
        const providerBaselineTurns = providerState.baselineTurns;
        if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
          baselineTurns = providerBaselineTurns;
        }
        await updateConversationHint("post-submit", 15_000).catch(() => false);
        return { baselineTurns, baselineAssistantText };
      } catch (error) {
        await postSubmitInputGuard?.disable();
        throw error;
      }
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await raceWithDisconnect(Page.reload({ ignoreCache: true }));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    const submission = await runSubmissionWithRecovery({
      prompt: promptText,
      attachments,
      fallbackSubmission: options.fallbackSubmission,
      submit: (submissionPrompt, submissionAttachments) =>
        raceWithDisconnect(submitOnce(submissionPrompt, submissionAttachments)),
      reloadPromptComposer,
      prepareFallbackSubmission: async () => {
        await raceWithDisconnect(clearPromptComposer(Runtime, logger));
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      },
      logger,
    });
    baselineTurns = submission.baselineTurns;
    baselineAssistantText = submission.baselineAssistantText;
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId,
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    let answer: {
      text: string;
      html?: string;
      meta: { turnId?: string | null; messageId?: string | null };
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await delay(recheckDelayMs);
      await updateConversationHint("assistant-recheck", 15_000).catch(() => false);
      await ensureExpectedConversation("assistant-recheck").catch(() => false);
      const conversationUrl = expectedConversationUrl ?? (await readConversationUrl(Runtime));
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await raceWithDisconnect(Page.navigate({ url: conversationUrl }));
        await raceWithDisconnect(delay(1000));
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromeHost: host,
              chromePort: port,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            },
          },
        );
      }
      await emitRuntimeHint();
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        waitForAssistantResponseWithReload(
          Runtime,
          Page,
          timeoutMs,
          logger,
          baselineTurns ?? undefined,
          expectedConversationUrl,
          expectedConversationId,
          continueResponse,
        ),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    try {
      try {
        await ensureExpectedConversation("assistant-wait").catch(() => false);
        answer = await waitWithThinkingMonitor(() =>
          waitForAssistantResponseWithReload(
            Runtime,
            Page,
            config.timeoutMs,
            logger,
            baselineTurns ?? undefined,
            expectedConversationUrl,
            expectedConversationId,
            continueResponse,
          ),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheck().catch((error) => {
            if (error instanceof AssistantStoppedError) throw error;
            return null;
          });
          if (rechecked) {
            answer = rechecked;
          } else {
            try {
              const conversationUrl =
                expectedConversationUrl ?? (await readConversationUrl(Runtime));
              if (conversationUrl) {
                lastUrl = conversationUrl;
              }
            } catch {
              // ignore
            }
            await ensureExpectedConversation("assistant-timeout").catch(() => false);
            await emitRuntimeHint();
            const runtime = {
              chromePort: port,
              chromeHost: host,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            };
            throw new BrowserAutomationError(
              "Assistant response timed out before completion; reattach later to capture the answer.",
              { stage: "assistant-timeout", runtime },
              error,
            );
          }
        } else {
          throw error;
        }
      }
    } finally {
      await postSubmitInputGuard?.disable();
    }
    const baselineNormalized = baselineAssistantText
      ? normalizeForComparison(baselineAssistantText)
      : "";
    if (baselineNormalized) {
      const normalizedAnswer = normalizeForComparison(answer.text ?? "");
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const isBaseline =
        normalizedAnswer === baselineNormalized ||
        (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
      if (isBaseline) {
        logger("Detected stale assistant response; waiting for new response...");
        const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
        if (refreshed) {
          answer = refreshed;
        }
      }
    }
    answerText = answer.text;
    answerHtml = answer.html ?? "";

    const copiedMarkdown = await withRetries(
      async () => {
        const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
        if (!attempt) {
          throw new Error("copy-missing");
        }
        return attempt;
      },
      {
        retries: 2,
        delayMs: 350,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(
              `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      },
    ).catch(() => null);

    answerMarkdown = copiedMarkdown ?? answerText;
    ({ answerText, answerMarkdown } = await maybeRecoverLongAssistantResponse({
      runtime: Runtime,
      baselineTurns,
      expectedConversationId,
      answerText,
      answerMarkdown,
      logger,
      allowMarkdownUpdate: !copiedMarkdown,
    }));

    // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
    const finalSnapshot = await readAssistantSnapshot(
      Runtime,
      baselineTurns ?? undefined,
      expectedConversationId,
    ).catch(() => null);
    const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
    if (
      finalText &&
      finalText !== answerMarkdown.trim() &&
      finalText !== promptText.trim() &&
      finalText.length >= answerMarkdown.trim().length
    ) {
      logger("Refreshed assistant response via final DOM snapshot");
      answerText = finalText;
      answerMarkdown = finalText;
    }

    // Detect prompt echo using normalized comparison (whitespace-insensitive).
    const promptEchoMatcher = buildPromptEchoMatcher(promptText);
    const alignedEcho = alignPromptEchoPair(
      answerText,
      answerMarkdown,
      promptEchoMatcher,
      copiedMarkdown ? logger : undefined,
      {
        text: "Aligned assistant response text to copied markdown after prompt echo",
        markdown: "Aligned assistant markdown to response text after prompt echo",
      },
    );
    answerText = alignedEcho.answerText;
    answerMarkdown = alignedEcho.answerMarkdown;
    const isPromptEcho = alignedEcho.isEcho;
    if (isPromptEcho) {
      logger("Detected prompt echo in response; waiting for actual assistant response...");
      const deadline = Date.now() + 15_000;
      let bestText: string | null = null;
      let stableCount = 0;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId,
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
        if (!isStillEcho) {
          if (!bestText || text.length > bestText.length) {
            bestText = text;
            stableCount = 0;
          } else if (text === bestText) {
            stableCount += 1;
          }
          if (stableCount >= 2) {
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (bestText) {
        logger("Recovered assistant response after detecting prompt echo");
        answerText = bestText;
        answerMarkdown = bestText;
      }
    }
    if (options.afterAnswerCb) {
      await options.afterAnswerCb({
        Runtime,
        Page,
        Input,
        answer: {
          text: answerText,
          markdown: answerMarkdown,
          html: answerHtml || undefined,
          meta: answer.meta,
        },
      });
    }
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);

    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      browserTransport: "cdp",
      chromePid: undefined,
      chromePort: port,
      chromeHost: host,
      chromeBrowserWSEndpoint: browserWSEndpoint,
      chromeProfileRoot,
      userDataDir: undefined,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;

    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }

    throw new BrowserAutomationError("Remote Chrome connection lost before ask-pro finished.", {
      stage: "connection-lost",
      runtime: {
        chromeHost: host,
        chromePort: port,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      },
    });
  } finally {
    try {
      if (!connectionClosedUnexpectedly && connection) {
        await connection.close();
      }
    } catch {
      // ignore
    }
    removeDialogHandler?.();
    if (ownsTarget) {
      await closeRemoteChromeTarget(host, port, remoteTargetId ?? undefined, logger);
    }
    // Don't kill remote Chrome - it's not ours to manage
    const totalSeconds = (Date.now() - startedAt) / 1000;
    logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  }
}

export { estimateTokenCount } from "./utils.js";
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from "./config.js";

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  listIgnoredRemoteChromeFlags,
  shouldEnablePostSubmitInputGuard,
  decideManagedChromeCleanup,
  shouldCaptureLaunchTargetsForCleanup,
  shouldRetainLaunchedChromeAfterRun,
  isDisposableLaunchPageUrl,
  selectDisposableLaunchTargetIds,
  selectClosableLaunchTargetIds,
  buildHumanInterventionProbeExpression,
  detectHumanInterventionReason,
  isLoginRecoveryUrl,
  isEligibleManualLoginRecoveryTarget,
  isRecoveredTargetOwned,
  waitForLogin,
};
export { syncCookies } from "./cookies.js";
export {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
} from "./pageActions.js";

export function isWebSocketClosureError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("websocket connection closed") ||
    message.includes("websocket is closed") ||
    message.includes("websocket error") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("target closed")
  );
}

async function waitForAssistantResponseWithReload(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationUrl?: string,
  expectedConversationId?: string,
  continueResponse?: (turnIndex: number) => Promise<number>,
) {
  try {
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
      continueResponse,
    );
  } catch (error) {
    if (!shouldReloadAfterAssistantError(error)) {
      throw error;
    }
    const conversationUrl = expectedConversationUrl ?? (await readConversationUrl(Runtime));
    if (!conversationUrl || !isConversationUrl(conversationUrl)) {
      throw error;
    }
    logger("Assistant response stalled; reloading conversation and retrying once");
    await Page.navigate({ url: conversationUrl });
    await delay(1000);
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
      continueResponse,
    );
  }
}

function shouldReloadAfterAssistantError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("assistant-response") ||
    message.includes("watchdog") ||
    message.includes("timeout") ||
    message.includes("capture assistant response")
  );
}

function isAssistantResponseTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (!message) return false;
  return (
    message.includes("assistant-response") ||
    message.includes("assistant response") ||
    message.includes("watchdog") ||
    message.includes("capture assistant response")
  );
}

async function readConversationUrl(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  try {
    const currentUrl = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    return typeof currentUrl.result?.value === "string" ? currentUrl.result.value : null;
  } catch {
    return null;
  }
}

interface SessionValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that the ChatGPT session is still active by checking for login CTAs
 * and textarea availability. Sessions can expire during long delays (e.g., recheck).
 *
 * @param Runtime - Chrome Runtime client
 * @param logger - Browser logger for diagnostics
 * @returns SessionValidationResult indicating if session is valid and reason if not
 */
async function validateChatGPTSession(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<SessionValidationResult> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildSessionValidationExpression(),
      awaitPromise: true,
      returnByValue: true,
    });

    const result = outcome.result?.value as
      | {
          valid: boolean;
          hasLoginCta: boolean;
          hasTextarea: boolean;
          onAuthPage: boolean;
          pageUrl: string | null;
        }
      | undefined;

    if (!result) {
      return { valid: false, reason: "Failed to evaluate session state" };
    }

    if (result.onAuthPage) {
      return { valid: false, reason: "Redirected to auth page" };
    }

    if (result.hasLoginCta) {
      return { valid: false, reason: "Login button detected on page" };
    }

    if (!result.hasTextarea) {
      return { valid: false, reason: "Prompt textarea not available" };
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Session validation error: ${message}`);
    return { valid: false, reason: `Validation error: ${message}` };
  }
}

function buildSessionValidationExpression(): string {
  const selectorLiteral = JSON.stringify(INPUT_SELECTORS);
  return `(async () => {
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    // Check for login CTAs (similar to ensureLoggedIn logic)
    const hasLoginCta = (() => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    })();

    // Check for textarea availability
    const hasTextarea = (() => {
      const selectors = ${selectorLiteral};
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) {
          return true;
        }
      }
      return false;
    })();

    return {
      valid: !onAuthPage && !hasLoginCta && hasTextarea,
      hasLoginCta,
      hasTextarea,
      onAuthPage,
      pageUrl,
    };
  })()`;
}

async function readConversationTurnCount(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  const selectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { result } = await Runtime.evaluate({
        expression: `document.querySelectorAll(${selectorLiteral}).length`,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (!Number.isFinite(raw)) {
        throw new Error("Turn count not numeric");
      }
      return Math.max(0, Math.floor(raw));
    } catch (error) {
      if (attempt < attempts - 1) {
        await delay(150);
        continue;
      }
      if (logger?.verbose) {
        logger(
          `Failed to read conversation turn count: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
  return null;
}

function isConversationUrl(url: string): boolean {
  return /\/c\/[a-z0-9-]+/i.test(url);
}

function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${port} is blocked from WSL.`,
    "",
    "PowerShell (admin):",
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    "",
    "Re-run the same ask-pro command after adding the rule.",
  ].join("\n");
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

function extractConversationIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1];
}

async function resolveUserDataBaseDir(): Promise<string> {
  // On WSL, Chrome launched via Windows can choke on UNC paths; prefer a Windows-backed temp folder.
  if (isWsl()) {
    const candidates = [
      "/mnt/c/Users/Public/AppData/Local/Temp",
      "/mnt/c/Temp",
      "/mnt/c/Windows/Temp",
    ];
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { recursive: true });
        return candidate;
      } catch {
        // try next
      }
    }
  }

  const tmpDir = os.tmpdir();
  if (process.platform === "linux") {
    const homeDir = os.homedir();
    const relativeToHome =
      homeDir && tmpDir.startsWith(homeDir + path.sep) ? tmpDir.slice(homeDir.length + 1) : "";
    const firstSegment = relativeToHome.split(path.sep, 1)[0];
    const isHiddenHomeTmp = Boolean(firstSegment?.startsWith("."));
    if (isHiddenHomeTmp) {
      try {
        await mkdir("/tmp", { recursive: true });
        return "/tmp";
      } catch {
        // Fall back to the inherited tmpdir if /tmp is unavailable.
      }
    }
  }

  return tmpDir;
}
