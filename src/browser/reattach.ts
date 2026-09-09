import { AssistantStoppedError } from "./errors.js";
import { createAssistantContinuation } from "./actions/assistantResponse.js";
import CDP from "chrome-remote-interface";
import type { LaunchedChrome } from "chrome-launcher";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
} from "./pageActions.js";
import type {
  BrowserAutomationConfig,
  BrowserLogger,
  BrowserRunOptions,
  BrowserRuntimeMetadata,
  ChromeClient,
} from "./types.js";
import {
  launchChrome,
  connectToChrome,
  hideChromeWindow,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
  closeRemoteChromeTarget,
  closeChromeGracefully,
  connectWithNewTab,
  closeTab,
  maybeReuseRunningChrome,
  releaseChromeProcessHandle,
  restoreChromeWindowByPid,
  shouldLaunchChromeMinimized,
} from "./chromeLifecycle.js";
import { DEFAULT_BROWSER_CONFIG, resolveBrowserConfig } from "./config.js";
import { defaultAskProBrowserProfileDir } from "./profilePaths.js";
import { applyPageLanguageOverrides, seedChromeProfileLanguage } from "./language.js";
import { syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import { setChromeWindowState } from "./actions/windowState.js";
import type { ManagedChromeRunLease } from "./profileState.js";
import {
  acquireProfileRunLock,
  cleanupStaleProfileState,
  createManagedChromeRunLease,
  releaseManagedChromeRunLeaseAndCountPeers,
  verifyDevToolsReachable,
} from "./profileState.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  readConversationTurnIndex,
  buildPromptEchoMatcher,
  recoverPromptEcho,
  alignPromptEchoMarkdown,
  type TargetInfoLite,
} from "./reattachHelpers.js";

type BrowserSessionConfig = BrowserAutomationConfig;
export interface ReattachDeps {
  continuationState?: { used: boolean };
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  chromeModeCb?: (mode: ReattachResult["chromeMode"]) => Promise<void> | void;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachResult>;
  promptPreview?: string;
  afterAnswerCb?: BrowserRunOptions["afterAnswerCb"];
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  chromeMode: "reused_devtools" | "relaunched";
  keepBrowserOpen?: boolean;
}

interface ReattachRunLease {
  userDataDir: string;
  timeoutMs: number;
  lease: ManagedChromeRunLease;
}

function lifecycleLockTimeout(timeoutMs: number | undefined): number {
  return timeoutMs && timeoutMs > 0
    ? timeoutMs
    : (DEFAULT_BROWSER_CONFIG.profileLockTimeoutMs ?? 300_000);
}

async function acquireReattachRunLease(
  userDataDir: string,
  timeoutMs: number | undefined,
  logger: BrowserLogger,
): Promise<ReattachRunLease | null> {
  const effectiveTimeoutMs = lifecycleLockTimeout(timeoutMs);
  const lock = await acquireProfileRunLock(userDataDir, { timeoutMs: effectiveTimeoutMs, logger });
  try {
    return {
      userDataDir,
      timeoutMs: effectiveTimeoutMs,
      lease: await createManagedChromeRunLease(userDataDir),
    };
  } finally {
    await lock?.release();
  }
}

async function releaseReattachRunLease(
  runLease: ReattachRunLease | null,
  logger: BrowserLogger,
  onLastRun?: () => Promise<void>,
): Promise<number | null> {
  if (!runLease) return 0;
  try {
    const lock = await acquireProfileRunLock(runLease.userDataDir, {
      timeoutMs: runLease.timeoutMs,
      logger,
    });
    try {
      const peerRunCount = await releaseManagedChromeRunLeaseAndCountPeers(
        runLease.userDataDir,
        runLease.lease,
        logger,
      );
      if (peerRunCount === 0) await onLastRun?.();
      return peerRunCount;
    } finally {
      await lock?.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to resolve shared Chrome ownership; retaining browser (${message})`);
    return null;
  }
}

async function closeManagedChromeIfUnused(
  chrome: LaunchedChrome & { host?: string },
  userDataDir: string,
  inspectRemainingPages: boolean,
  logger: BrowserLogger,
): Promise<void> {
  if (inspectRemainingPages) {
    try {
      const targets = await listRemoteChromeTargets({
        host: chrome.host ?? "127.0.0.1",
        port: chrome.port,
      });
      if (targets.some((target) => target.type === "page")) {
        releaseChromeProcessHandle(chrome);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to inspect remaining Chrome tabs; retaining browser (${message})`);
      releaseChromeProcessHandle(chrome);
      return;
    }
  }
  try {
    await closeChromeGracefully(chrome, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close managed Chrome; retaining browser (${message})`);
    releaseChromeProcessHandle(chrome);
    return;
  }
  await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
    () => undefined,
  );
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  deps = { ...deps, continuationState: deps.continuationState ?? { used: false } };
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));
  const recoverWithRelaunchMode = async (
    runtimeMeta: BrowserRuntimeMetadata,
    configMeta: BrowserSessionConfig | undefined,
  ) => {
    await deps.chromeModeCb?.("relaunched");
    return recoverSession(runtimeMeta, configMeta);
  };

  if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
    logger("No running Chrome detected; reopening browser to locate the session.");
    return recoverWithRelaunchMode(runtime, config);
  }

  const resolvedConfig = resolveBrowserConfig(config ?? {});
  const directUserDataDir = resolvedConfig.manualLogin
    ? !resolvedConfig.remoteChrome && runtime.userDataDir
      ? runtime.userDataDir
      : null
    : null;
  let reattachRunLease = directUserDataDir
    ? await acquireReattachRunLease(directUserDataDir, resolvedConfig.profileLockTimeoutMs, logger)
    : null;
  let closeConnection: (() => Promise<void>) | null = null;

  try {
    const liveRuntime = await refreshAttachRuntime(runtime, logger).catch(() => runtime);
    if (!liveRuntime.chromePort && !liveRuntime.chromeBrowserWSEndpoint) {
      logger("Saved Chrome runtime metadata is stale; reopening browser to locate the session.");
      await releaseReattachRunLease(reattachRunLease, logger);
      reattachRunLease = null;
      return recoverWithRelaunchMode(runtime, config);
    }
    const host = liveRuntime.chromeHost ?? "127.0.0.1";
    const port =
      liveRuntime.chromePort ?? inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
    const browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
    const listTargets =
      deps.listTargets ??
      (async () =>
        (await listRemoteChromeTargets({
          host,
          port: port ?? 9222,
          browserWSEndpoint,
        })) as TargetInfoLite[]);
    const targetList = (await listTargets()) as TargetInfoLite[];
    const target = pickTarget(targetList, liveRuntime);
    const connection =
      browserWSEndpoint && !deps.connect
        ? await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
            browserWSEndpoint,
            targetId: target?.targetId,
            closeTargetOnDispose: false,
          })
        : ({
            client: (await (deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options)))(
              browserWSEndpoint
                ? {
                    target: browserWSEndpoint,
                    local: true,
                    targetId: target?.targetId,
                  }
                : {
                    host,
                    port,
                    target: target?.targetId,
                  },
            )) as unknown as ChromeClient,
            close: async () => undefined,
          } as const);
    closeConnection = connection.close;
    const connectedTargetId = "targetId" in connection ? connection.targetId : target?.targetId;
    const ownsConnectedTarget = Boolean(
      !resolvedConfig.browserTabRef &&
      liveRuntime.chromeTargetId &&
      connectedTargetId === liveRuntime.chromeTargetId,
    );
    const client: ChromeClient = connection.client;
    const windowTransitionLock =
      directUserDataDir && shouldLaunchChromeMinimized({ ...resolvedConfig, startMinimized: true })
        ? await acquireProfileRunLock(directUserDataDir, {
            timeoutMs: lifecycleLockTimeout(resolvedConfig.profileLockTimeoutMs),
            logger,
          })
        : null;
    try {
      if (windowTransitionLock) {
        const restored = await restoreChromeWindowByPid(liveRuntime.chromePid, logger);
        if (!restored) {
          await setChromeWindowState(client, "normal", logger, {
            targetId: connectedTargetId,
            reason: "resume",
          });
        }
      }
    } finally {
      await windowTransitionLock?.release();
    }
    const { Runtime, DOM, Page, Input } = client;
    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }

    const ensureConversationOpen = async () => {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      const href = typeof result?.value === "string" ? result.value : "";
      if (href.includes("/c/")) {
        const currentId = extractConversationIdFromUrl(href);
        if (!runtime.conversationId || (currentId && currentId === runtime.conversationId)) {
          return;
        }
      }
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId:
            runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
          preferProjects: true,
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      }
      await waitForLocationChange(Runtime, 15_000);
    };

    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = config?.timeoutMs ?? 120_000;
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: "1+1", returnByValue: true }),
      pingTimeoutMs,
      "Reattach target did not respond",
    );
    await ensureConversationOpen();
    const minTurnIndex = await readConversationTurnIndex(Runtime, logger);
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
    const answer = await withTimeout(
      waitForResponse(
        Runtime,
        timeoutMs,
        logger,
        minTurnIndex ?? undefined,
        runtime.conversationId,
        createAssistantContinuation(Runtime, Input, logger, undefined, deps.continuationState),
      ),
      timeoutMs + 5_000,
      "Reattach response timed out",
    );
    const recovered = await recoverPromptEcho(
      Runtime,
      answer,
      promptEcho,
      logger,
      minTurnIndex,
      timeoutMs,
    );
    const markdown =
      (await withTimeout(
        captureMarkdown(Runtime, recovered.meta, logger),
        15_000,
        "Reattach markdown capture timed out",
      )) ?? recovered.text;
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
    const afterAnswerResult = await deps.afterAnswerCb?.({
      Runtime,
      Page,
      Input,
      answer: {
        text: aligned.answerText,
        markdown: aligned.answerMarkdown,
      },
    });

    await connection.close().catch(() => undefined);
    closeConnection = null;
    const keepBrowserOpen = Boolean(
      resolvedConfig.keepBrowser ||
      resolvedConfig.browserTabRef ||
      afterAnswerResult?.keepBrowserOpen,
    );
    if (reattachRunLease && !keepBrowserOpen && ownsConnectedTarget) {
      await closeRemoteChromeTarget(host, port ?? 9222, connectedTargetId, logger);
    }
    if (reattachRunLease) {
      const completedLease = reattachRunLease;
      reattachRunLease = null;
      const chrome = {
        port: port ?? 9222,
        pid: liveRuntime.chromePid,
        host,
        kill: async () => undefined,
        process: undefined,
      } as unknown as LaunchedChrome & { host?: string };
      await releaseReattachRunLease(
        completedLease,
        logger,
        keepBrowserOpen
          ? undefined
          : async () =>
              closeManagedChromeIfUnused(chrome, completedLease.userDataDir, true, logger),
      );
    }

    return {
      answerText: aligned.answerText,
      answerMarkdown: aligned.answerMarkdown,
      chromeMode: "reused_devtools",
      keepBrowserOpen: afterAnswerResult?.keepBrowserOpen,
    };
  } catch (error) {
    await closeConnection?.().catch(() => undefined);
    await releaseReattachRunLease(reattachRunLease, logger);
    reattachRunLease = null;
    if (error instanceof AssistantStoppedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
    );
    return recoverWithRelaunchMode(runtime, config);
  }
}

async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
): Promise<BrowserRuntimeMetadata> {
  if (!runtime.chromeProfileRoot) {
    return runtime;
  }
  const host = runtime.chromeHost ?? "127.0.0.1";
  const activePort = await readDevToolsActivePortInfo(runtime.chromeProfileRoot, {
    host,
  });
  if (!activePort) {
    return runtime;
  }
  const probe = await verifyDevToolsReachable({
    port: activePort.port,
    host,
    attempts: 1,
    timeoutMs: 750,
  });
  if (!probe.ok) {
    logger(
      `DevTools port ${activePort.port} unreachable (${probe.error}); ignoring stale profile runtime metadata.`,
    );
    await cleanupStaleProfileState(runtime.chromeProfileRoot, logger, {
      lockRemovalMode: "never",
    }).catch(() => undefined);
    return {
      ...runtime,
      chromePort: undefined,
      chromeBrowserWSEndpoint: undefined,
    };
  }
  return {
    ...runtime,
    chromeHost: host,
    chromePort: activePort.port,
    chromeBrowserWSEndpoint: activePort.browserWSEndpoint,
  };
}

function inferPortFromBrowserWSEndpoint(browserWSEndpoint?: string): number | undefined {
  if (!browserWSEndpoint) {
    return undefined;
  }
  try {
    const parsed = new URL(browserWSEndpoint);
    const port = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch {
    // ignore malformed ws endpoints and fall back to caller defaults
  }
  return undefined;
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (runtime.userDataDir ?? resolved.manualLoginProfileDir ?? defaultAskProBrowserProfileDir())
    : await mkdtemp(path.join(os.tmpdir(), "ask-pro-reattach-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const launchLock = manualLogin
    ? await acquireProfileRunLock(userDataDir, {
        timeoutMs: lifecycleLockTimeout(resolved.profileLockTimeoutMs),
        logger,
      })
    : null;
  let reattachRunLease: ReattachRunLease | null = null;
  let reusedChrome: LaunchedChrome | null = null;
  let chrome: LaunchedChrome | null = null;
  try {
    reusedChrome = manualLogin ? await maybeReuseRunningChrome(userDataDir, logger) : null;
    if (!reusedChrome) {
      await seedChromeProfileLanguage(userDataDir, resolved.acceptLanguage, logger);
    }
    chrome = reusedChrome ?? (await launchChrome(resolved, userDataDir, logger));
    if (manualLogin) {
      reattachRunLease = {
        userDataDir,
        timeoutMs: lifecycleLockTimeout(resolved.profileLockTimeoutMs),
        lease: await createManagedChromeRunLease(userDataDir),
      };
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
    await launchLock?.release();
  }
  if (!chrome) throw new Error("Failed to start or reuse managed Chrome.");
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  let client: ChromeClient | null = null;
  let isolatedTargetId: string | undefined;
  let completed = false;
  let keepBrowserOpen = false;
  try {
    const manageManagedWindowState =
      manualLogin && shouldLaunchChromeMinimized({ ...resolved, startMinimized: true });
    const windowTransitionLock = manageManagedWindowState
      ? await acquireProfileRunLock(userDataDir, {
          timeoutMs: lifecycleLockTimeout(resolved.profileLockTimeoutMs),
          logger,
        })
      : null;
    let tabSetupFailed = false;
    try {
      const isolatedConnection = manualLogin
        ? await connectWithNewTab(chrome.port, logger, "about:blank", chromeHost, {
            fallbackToDefault: false,
            retries: 2,
          })
        : { client: await connectToChrome(chrome.port, logger, chromeHost) };
      client = isolatedConnection.client;
      isolatedTargetId = isolatedConnection.targetId;
      if (manageManagedWindowState) {
        const restored = await restoreChromeWindowByPid(chrome.pid, logger);
        if (!restored) {
          await setChromeWindowState(client, "normal", logger, {
            targetId: isolatedTargetId,
            reason: "resume-relaunch",
          });
        }
      }
    } catch (error) {
      tabSetupFailed = true;
      throw error;
    } finally {
      if (tabSetupFailed && windowTransitionLock) {
        const restoreClient =
          client ??
          ((await CDP({ host: chromeHost, port: chrome.port }).catch(
            () => null,
          )) as ChromeClient | null);
        let restored = false;
        if (restoreClient) {
          restored = await setChromeWindowState(restoreClient, "normal", logger, {
            targetId: isolatedTargetId,
            reason: "resume-tab-setup-failed",
          });
          if (restoreClient !== client) await restoreClient.close().catch(() => undefined);
        }
        if (!restored) await restoreChromeWindowByPid(chrome.pid, logger);
      }
      await windowTransitionLock?.release();
    }
    if (!client) throw new Error("Failed to connect to managed Chrome.");
    const { Network, Page, Runtime, DOM } = client;

    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }
    if (resolved.acceptLanguage) {
      await applyPageLanguageOverrides(client, resolved.acceptLanguage, logger);
    }
    if (!resolved.headless && resolved.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    let appliedCookies = 0;
    if (!manualLogin && resolved.cookieSync) {
      appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
        allowErrors: resolved.allowCookieErrors,
        filterNames: resolved.cookieNames ?? undefined,
        inlineCookies: resolved.inlineCookies ?? undefined,
        cookiePath: resolved.chromeCookiePath ?? undefined,
        waitMs: resolved.cookieSyncWaitMs ?? 0,
      });
    }

    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    if (resolved.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, resolved.url, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
    }
    await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);

    const conversationUrl = buildConversationUrl(runtime, resolved.url);
    if (conversationUrl) {
      logger(`Reopening conversation at ${conversationUrl}`);
      await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
      await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
    } else {
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId:
            runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
          preferProjects:
            resolved.url !== CHATGPT_URL ||
            Boolean(
              runtime.tabUrl &&
              (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
            ),
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      }
      await waitForLocationChange(Runtime, 15_000);
    }

    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = resolved.timeoutMs ?? 120_000;
    const minTurnIndex = await readConversationTurnIndex(Runtime, logger);
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
    const answer = await waitForResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex ?? undefined,
      runtime.conversationId,
      createAssistantContinuation(Runtime, client.Input, logger, undefined, deps.continuationState),
    );
    const recovered = await recoverPromptEcho(
      Runtime,
      answer,
      promptEcho,
      logger,
      minTurnIndex,
      timeoutMs,
    );
    const markdown = (await captureMarkdown(Runtime, recovered.meta, logger)) ?? recovered.text;
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
    const afterAnswerResult = await deps.afterAnswerCb?.({
      Runtime,
      Page,
      Input: client.Input,
      answer: {
        text: aligned.answerText,
        markdown: aligned.answerMarkdown,
      },
    });

    keepBrowserOpen = Boolean(resolved.keepBrowser || afterAnswerResult?.keepBrowserOpen);
    completed = true;
    return {
      answerText: aligned.answerText,
      answerMarkdown: aligned.answerMarkdown,
      chromeMode: "relaunched",
      keepBrowserOpen: afterAnswerResult?.keepBrowserOpen,
    };
  } finally {
    await client?.close().catch(() => undefined);
    if (manualLogin && completed && !keepBrowserOpen && isolatedTargetId) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost);
    }
    if (reattachRunLease) {
      const completedLease = reattachRunLease;
      reattachRunLease = null;
      await releaseReattachRunLease(
        completedLease,
        logger,
        completed && !keepBrowserOpen
          ? async () =>
              closeManagedChromeIfUnused(
                chrome,
                completedLease.userDataDir,
                Boolean(reusedChrome),
                logger,
              )
          : undefined,
      );
      releaseChromeProcessHandle(chrome);
    } else if (!manualLogin && completed && !keepBrowserOpen) {
      await closeChromeGracefully(chrome, logger).catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      releaseChromeProcessHandle(chrome);
    }
  }
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
};
