import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import net from "node:net";
import { execFile, spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import { Launcher, type LaunchedChrome } from "chrome-launcher";
import type { BrowserLogger, ResolvedBrowserConfig, ChromeClient } from "./types.js";
import {
  clearChromeLaunchStarting,
  clearIdleBrowserProfileCaches,
  cleanupStaleProfileState,
  hasChromeLaunchStarting,
  markChromeLaunchStarting,
  readChromePid,
  readDevToolsPort,
  verifyDevToolsReachable,
} from "./profileState.js";
import { delay } from "./utils.js";
import { formatElapsed } from "./format.js";
import { withTimeout } from "./reattachHelpers.js";

const execFileAsync = promisify(execFile);
const CPU_THROTTLING_OVERRIDE_FLAGS = new Set([
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-ipc-flooding-protection",
]);
const CHROME_STARTUP_HANDOFF_MS = 26_000;

export async function launchChrome(
  config: ResolvedBrowserConfig,
  userDataDir: string,
  logger: BrowserLogger,
  options: { ignoreLockId?: string } = {},
) {
  const connectHost = resolveRemoteDebugHost();
  const debugBindAddress = connectHost && connectHost !== "127.0.0.1" ? "0.0.0.0" : connectHost;
  const debugPort = config.debugPort ?? parseDebugPortEnv();
  const chromeFlags = buildChromeLaunchFlags(
    buildChromeFlags(config.headless ?? false, debugBindAddress, config.acceptLanguage, {
      startMinimized: shouldLaunchChromeMinimized(config),
    }),
  );
  await clearIdleBrowserProfileCaches(userDataDir, options);
  await markChromeLaunchStarting(userDataDir);
  try {
    const launcher = await launchManagedChrome({
      chromeFlags,
      chromePath: config.chromePath ?? undefined,
      userDataDir,
      host: connectHost,
      requestedPort: debugPort ?? undefined,
    });
    const pidLabel = typeof launcher.pid === "number" ? ` (pid ${launcher.pid})` : "";
    const hostLabel = connectHost ? ` on ${connectHost}` : "";
    logger(`Launched Chrome${pidLabel} on port ${launcher.port}${hostLabel}`);
    return Object.assign(launcher, { host: connectHost ?? "127.0.0.1" }) as LaunchedChrome & {
      host?: string;
    };
  } finally {
    await clearChromeLaunchStarting(userDataDir);
  }
}

export async function maybeReuseRunningChrome(
  userDataDir: string,
  logger: BrowserLogger,
): Promise<LaunchedChrome | null> {
  let port = await readDevToolsPort(userDataDir);
  if (!port) {
    const startupHandoff = await hasChromeLaunchStarting(userDataDir);
    if (startupHandoff) {
      const deadline = Date.now() + CHROME_STARTUP_HANDOFF_MS;
      logger(
        `Waiting up to ${formatElapsed(CHROME_STARTUP_HANDOFF_MS)} for brokered Chrome startup handoff...`,
      );
      while (!port && Date.now() < deadline) {
        await delay(100);
        port = await readDevToolsPort(userDataDir);
      }
    }
    if (startupHandoff) await clearChromeLaunchStarting(userDataDir);
  }
  if (!port) return null;

  await clearChromeLaunchStarting(userDataDir);

  const probe = await verifyDevToolsReachable({ port });
  if (!probe.ok) {
    logger(
      `DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`,
    );
    await cleanupStaleProfileState(userDataDir, logger, {
      lockRemovalMode: "if_ask_pro_pid_dead",
    });
    return null;
  }

  const pid = await readChromePid(userDataDir);
  logger(
    `Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ""})`,
  );
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}

export function releaseChromeProcessHandle(chrome: LaunchedChrome | null | undefined): void {
  const child = chrome?.process as
    | (NonNullable<LaunchedChrome["process"]> & {
        stdin?: { unref?: () => void };
        stdout?: { unref?: () => void };
        stderr?: { unref?: () => void };
        stdio?: Array<{ unref?: () => void } | null | undefined>;
      })
    | undefined;
  child?.stdin?.unref?.();
  child?.stdout?.unref?.();
  child?.stderr?.unref?.();
  for (const stream of child?.stdio ?? []) stream?.unref?.();
  child?.unref?.();
}

export function registerTerminationHooks(
  chrome: LaunchedChrome,
  userDataDir: string,
  keepBrowser: boolean,
  logger: BrowserLogger,
  opts?: {
    /** Return true when the run is still in-flight (assistant response pending). */
    isInFlight?: () => boolean;
    /** Persist runtime hints so reattach can find the live Chrome. */
    emitRuntimeHint?: () => Promise<void>;
    /** Preserve the profile directory even when Chrome is terminated. */
    preserveUserDataDir?: boolean;
  },
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT"];
  let handling: boolean | undefined;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (handling) {
      return;
    }
    handling = true;
    const inFlight = opts?.isInFlight?.() ?? false;
    const leaveRunning = keepBrowser || inFlight;
    if (leaveRunning) {
      logger(
        `Received ${signal}; leaving Chrome running${inFlight ? " (assistant response pending)" : ""}`,
      );
    } else {
      logger(`Received ${signal}; terminating Chrome process`);
    }
    void (async () => {
      if (leaveRunning) {
        // Ensure reattach hints are written before we exit.
        await opts?.emitRuntimeHint?.().catch(() => undefined);
        if (inFlight) {
          logger(
            'Session still in flight; reattach with "ask-pro --resume <session-id>" to continue.',
          );
        }
      } else {
        try {
          await closeChromeGracefully(chrome, logger);
        } catch {
          // ignore close failures
        }
        if (opts?.preserveUserDataDir) {
          // Preserve the profile directory (manual login), but clear reattach hints so we don't
          // try to reuse a dead DevTools port on the next run.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        } else {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    })().finally(() => {
      const exitCode = signal === "SIGINT" ? 130 : 1;
      // Vitest treats any `process.exit()` call as an unhandled failure, even if mocked.
      // Keep production behavior (hard-exit on signals) while letting tests observe state changes.
      process.exitCode = exitCode;
      const isTestRun = process.env.VITEST === "1" || process.env.NODE_ENV === "test";
      if (!isTestRun) {
        process.exit(exitCode);
      }
    });
  };

  for (const signal of signals) {
    process.on(signal, handleSignal);
  }

  return () => {
    for (const signal of signals) {
      process.removeListener(signal, handleSignal);
    }
  };
}

export async function closeChromeGracefully(
  chrome: LaunchedChrome & { host?: string },
  logger?: BrowserLogger,
): Promise<void> {
  const port = chrome.port;
  const host = chrome.host ?? "127.0.0.1";
  const shutdownDeadline = Date.now() + 20_000;
  try {
    await withTimeout(
      (async () => {
        if (!port) throw new Error("missing DevTools port");
        const version = (await CDP.Version({ host, port })) as { webSocketDebuggerUrl?: string };
        const target = version.webSocketDebuggerUrl;
        const client = (await CDP(
          target ? { target, local: true } : { host, port },
        )) as ChromeClient;
        try {
          await client.Browser?.close?.();
        } finally {
          await client.close().catch(() => undefined);
        }
        await waitForChromeExit(chrome.pid, Math.max(0, shutdownDeadline - Date.now()));
        if (chrome.pid && isPidAlive(chrome.pid)) {
          throw new Error(`Chrome process ${chrome.pid} remained alive after Browser.close`);
        }
      })(),
      20_000,
      "Chrome did not exit within 20 seconds after Browser.close",
    );
    chrome.process?.unref?.();
    return;
  } catch (error) {
    if (logger?.verbose) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Graceful Chrome close failed (${message}); terminating process.`);
    }
  }
  await chrome.kill();
  await waitForChromeExit(chrome.pid, 2500);
  if (chrome.pid && isPidAlive(chrome.pid)) {
    throw new Error(`Chrome process ${chrome.pid} remained alive after termination.`);
  }
  chrome.process?.unref?.();
}

async function waitForChromeExit(pid: number | undefined, timeoutMs: number): Promise<void> {
  if (!pid) {
    await delay(500);
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await delay(100);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function hideChromeWindow(
  chrome: LaunchedChrome,
  logger: BrowserLogger,
  deps: {
    platform?: NodeJS.Platform;
    execFileAsync?: typeof execFileAsync;
  } = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const runExecFile = deps.execFileAsync ?? execFileAsync;
  if (!chrome.pid) {
    logger("Unable to hide window: missing Chrome PID");
    return false;
  }
  if (platform === "win32") {
    return setWindowsChromeWindowVisibility(chrome.pid, 0, "hidden", logger, runExecFile);
  }
  if (platform !== "darwin") {
    logger("Window hiding is only supported on macOS and Windows");
    return false;
  }
  const script = `tell application "System Events"
    try
      set visible of (first process whose unix id is ${chrome.pid}) to false
    end try
  end tell`;
  try {
    await runExecFile("osascript", ["-e", script]);
    logger("Chrome window hidden (Cmd-H)");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to hide Chrome window: ${message}`);
    return false;
  }
}

async function setWindowsChromeWindowVisibility(
  pid: number,
  command: 0 | 9,
  state: "hidden" | "restored",
  logger: BrowserLogger,
  runExecFile: typeof execFileAsync,
): Promise<boolean> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AskProWindowVisibility {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder value, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr hWnd, string name);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetProp(IntPtr hWnd, string name, IntPtr value);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$targetPid = [uint32]${pid}
$changed = $false
$preserved = $false
$callback = [AskProWindowVisibility+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $windowPid = [uint32]0
  [void][AskProWindowVisibility]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
  if ($windowPid -eq $targetPid -and [AskProWindowVisibility]::GetWindowTextLength($hWnd) -gt 0) {
    $className = New-Object Text.StringBuilder 256
    [void][AskProWindowVisibility]::GetClassName($hWnd, $className, $className.Capacity)
    if ($className.ToString() -eq 'Chrome_WidgetWin_1') {
      if (${command} -eq 0 -and [AskProWindowVisibility]::GetProp($hWnd, 'AskProHumanRecovery') -ne [IntPtr]::Zero) {
        $script:preserved = $true
      } else {
        if (${command} -eq 9) {
          [void][AskProWindowVisibility]::SetProp($hWnd, 'AskProHumanRecovery', [IntPtr]1)
        }
        [void][AskProWindowVisibility]::ShowWindowAsync($hWnd, ${command})
        $script:changed = $true
      }
    }
  }
  return $true
}
[void][AskProWindowVisibility]::EnumWindows($callback, [IntPtr]::Zero)
if ($changed) { [Console]::Out.Write('changed') }
elseif ($preserved) { [Console]::Out.Write('preserved') }
else { exit 2 }
`;
  try {
    const { stdout } = await runExecFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        windowsHide: true,
        timeout: 5000,
      },
    );
    if (String(stdout).trim() === "preserved") {
      logger("[browser] Chrome window remains visible for human recovery");
      return false;
    }
    logger(`[browser] Chrome window ${state} by pid`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Failed to set Chrome window ${state} by pid: ${message}`);
    return false;
  }
}

export async function restoreChromeWindowByPid(
  pid: number | undefined,
  logger: BrowserLogger,
  deps: {
    platform?: NodeJS.Platform;
    execFileAsync?: typeof execFileAsync;
  } = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const runExecFile = deps.execFileAsync ?? execFileAsync;
  if (platform !== "win32" || !pid) {
    return false;
  }
  return setWindowsChromeWindowVisibility(pid, 9, "restored", logger, runExecFile);
}

export async function connectToChrome(
  port: number,
  logger: BrowserLogger,
  host?: string,
): Promise<ChromeClient> {
  const client = await CDP({ port, host });
  logger("Connected to Chrome DevTools protocol");
  return client;
}

export async function connectToRemoteChrome(
  host: string,
  port: number,
  logger: BrowserLogger,
  targetUrl?: string,
  browserWSEndpoint?: string,
  options?: {
    approvalWaitMs?: number;
  },
): Promise<RemoteChromeConnection> {
  if (browserWSEndpoint) {
    return await connectToRemoteChromeTarget(host, port, logger, {
      browserWSEndpoint,
      targetUrl: targetUrl ?? "about:blank",
      closeTargetOnDispose: true,
      approvalWaitMs: options?.approvalWaitMs,
    });
  }
  if (targetUrl) {
    const targetConnection = await connectToNewTarget(host, port, targetUrl, logger, {
      opened: () => `Opened dedicated remote Chrome tab targeting ${targetUrl}`,
      openFailed: (message) =>
        `Failed to open dedicated remote Chrome tab (${message}); falling back to first target.`,
      attachFailed: (targetId, message) =>
        `Failed to attach to dedicated remote Chrome tab ${targetId} (${message}); falling back to first target.`,
      closeFailed: (targetId, message) =>
        `Failed to close unused remote Chrome tab ${targetId}: ${message}`,
    });
    if (targetConnection) {
      return {
        client: targetConnection.client,
        targetId: targetConnection.targetId,
        close: async () => {
          await targetConnection.client.close().catch(() => undefined);
          await closeRemoteChromeTarget(host, port, targetConnection.targetId, logger);
        },
      };
    }
  }
  const fallbackClient = await CDP({ host, port });
  logger(`Connected to remote Chrome DevTools protocol at ${host}:${port}`);
  return {
    client: fallbackClient,
    close: async () => {
      await fallbackClient.close().catch(() => undefined);
    },
  };
}

export async function closeRemoteChromeTarget(
  host: string,
  port: number,
  targetId: string | undefined,
  logger: BrowserLogger,
): Promise<void> {
  if (!targetId) {
    return;
  }
  try {
    await CDP.Close({ host, port, id: targetId });
    if (logger.verbose) {
      logger(`Closed remote Chrome tab ${targetId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close remote Chrome tab ${targetId}: ${message}`);
  }
}

export interface RemoteChromeConnection {
  client: ChromeClient;
  targetId?: string;
  browserWSEndpoint?: string;
  close: () => Promise<void>;
}

export interface IsolatedTabConnection {
  client: ChromeClient;
  targetId?: string;
}

interface TargetConnectMessages {
  opened?: (targetId: string) => string;
  openFailed: (message: string) => string;
  attachFailed: (targetId: string, message: string) => string;
  closeFailed: (targetId: string, message: string) => string;
}

export interface RemoteTargetInfo {
  id?: string;
  targetId?: string;
  type?: string;
  url?: string;
}

export async function listRemoteChromeTargets(options: {
  host: string;
  port: number;
  browserWSEndpoint?: string;
}): Promise<RemoteTargetInfo[]> {
  if (!options.browserWSEndpoint) {
    const targets = await CDP.List({ host: options.host, port: options.port });
    return (targets as Array<RemoteTargetInfo>).map((target) => ({
      ...target,
      targetId: target.targetId ?? target.id,
    }));
  }
  const browser = await CDP({ target: options.browserWSEndpoint, local: true });
  try {
    const result = await browser.Target.getTargets();
    return (result.targetInfos ?? []).map((target) => ({
      targetId: target.targetId,
      type: target.type,
      url: target.url,
    }));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function connectToRemoteChromeTarget(
  host: string,
  port: number,
  logger: BrowserLogger,
  options: {
    targetId?: string;
    targetUrl?: string;
    browserWSEndpoint?: string;
    closeTargetOnDispose?: boolean;
    approvalWaitMs?: number;
  },
): Promise<RemoteChromeConnection> {
  if (!options.browserWSEndpoint) {
    const client = await CDP({ host, port, target: options.targetId });
    return {
      client,
      targetId: options.targetId,
      close: async () => {
        await client.close().catch(() => undefined);
      },
    };
  }

  const browser = await connectToBrowserWebSocket(
    host,
    port,
    options.browserWSEndpoint,
    logger,
    options.approvalWaitMs,
  );
  let targetId = options.targetId;
  try {
    if (!targetId) {
      const created = await browser.Target.createTarget({
        url: options.targetUrl ?? "about:blank",
      });
      targetId = created.targetId;
      logger(`Opened dedicated remote Chrome tab targeting ${options.targetUrl ?? "about:blank"}`);
    }
    const attached = await browser.Target.attachToTarget({ targetId, flatten: true });
    const client = createSessionBoundChromeClient(browser, attached.sessionId);
    return {
      client,
      targetId,
      browserWSEndpoint: options.browserWSEndpoint,
      close: async () => {
        await browser.Target.detachFromTarget({ sessionId: attached.sessionId }).catch(
          () => undefined,
        );
        if (options.closeTargetOnDispose && targetId) {
          await browser.Target.closeTarget({ targetId }).catch(() => undefined);
        }
        await browser.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function connectToBrowserWebSocket(
  host: string,
  port: number,
  browserWSEndpoint: string,
  logger: BrowserLogger,
  approvalWaitMs?: number,
): Promise<ChromeClient> {
  const connectPromise = CDP({ target: browserWSEndpoint, local: true }) as Promise<ChromeClient>;
  if (!approvalWaitMs || approvalWaitMs <= 0) {
    return await connectPromise;
  }

  logger(`Waiting for Chrome remote debugging approval for ${host}:${port}...`);

  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      connectPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `ask-pro waited ${formatApprovalWait(approvalWaitMs)} for Chrome remote debugging approval at ${host}:${port}. Allow the Chrome prompt or retry after toggling remote debugging.`,
            ),
          );
        }, approvalWaitMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function formatApprovalWait(waitMs: number): string {
  if (waitMs % 1000 === 0) {
    return `${waitMs / 1000}s`;
  }
  return `${waitMs}ms`;
}

async function connectToNewTarget(
  host: string,
  port: number,
  url: string,
  logger: BrowserLogger,
  messages: TargetConnectMessages,
): Promise<{ client: ChromeClient; targetId: string } | null> {
  try {
    const target = await CDP.New({ host, port, url });
    try {
      const client = await CDP({ host, port, target: target.id });
      if (messages.opened) {
        logger(messages.opened(target.id));
      }
      return { client, targetId: target.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(messages.attachFailed(target.id, message));
      try {
        await CDP.Close({ host, port, id: target.id });
      } catch (closeError) {
        const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
        logger(messages.closeFailed(target.id, closeMessage));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(messages.openFailed(message));
  }
  return null;
}

function createSessionBoundChromeClient(browser: ChromeClient, sessionId: string): ChromeClient {
  const browserWithEvents = browser as ChromeClient & {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    once: (event: string, listener: (...args: unknown[]) => void) => void;
    off?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  const bindDomain = <T extends object>(domainName: string): T => {
    const domain = (browser as unknown as Record<string, Record<string, unknown>>)[domainName] as
      | Record<string, unknown>
      | undefined;
    const eventName = (name: string) => `${domainName}.${name}.${sessionId}`;
    return new Proxy((domain ?? {}) as T, {
      get(target, prop, receiver) {
        if (prop === "on") {
          return (name: string, listener: (...args: unknown[]) => void) => {
            const domainEvent = (target as Record<string, unknown>)[name];
            if (typeof domainEvent === "function") {
              return (domainEvent as (...args: unknown[]) => unknown)(sessionId, listener);
            }
            browserWithEvents.on(eventName(name), listener);
            return () => browserWithEvents.removeListener(eventName(name), listener);
          };
        }
        if (prop === "off" || prop === "removeListener") {
          return (name: string, listener: (...args: unknown[]) => void) => {
            const off =
              browserWithEvents.off ?? browserWithEvents.removeListener.bind(browserWithEvents);
            off(eventName(name), listener);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) =>
          (value as (...callArgs: unknown[]) => unknown)(...args, sessionId);
      },
    });
  };

  return {
    ...browser,
    Network: bindDomain("Network"),
    Page: bindDomain("Page"),
    Runtime: bindDomain("Runtime"),
    Input: bindDomain("Input"),
    DOM: bindDomain("DOM"),
    on: browserWithEvents.on.bind(browserWithEvents),
    once: browserWithEvents.once.bind(browserWithEvents),
    off:
      browserWithEvents.off?.bind(browserWithEvents) ??
      browserWithEvents.removeListener.bind(browserWithEvents),
    removeListener: browserWithEvents.removeListener.bind(browserWithEvents),
    close: async () => {
      await browser.Target.detachFromTarget({ sessionId }).catch(() => undefined);
    },
  } as ChromeClient;
}

export async function connectWithNewTab(
  port: number,
  logger: BrowserLogger,
  initialUrl?: string,
  host?: string,
  options?: { fallbackToDefault?: boolean; retries?: number; retryDelayMs?: number },
): Promise<IsolatedTabConnection> {
  const effectiveHost = host ?? "127.0.0.1";
  const url = initialUrl ?? "about:blank";
  const fallbackToDefault = options?.fallbackToDefault ?? true;
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
  const fallbackLabel = fallbackToDefault
    ? "falling back to default target."
    : "strict mode: not falling back.";

  let attempt = 0;
  while (attempt <= retries) {
    const targetConnection = await connectToNewTarget(effectiveHost, port, url, logger, {
      opened: (targetId) => `Opened isolated browser tab (target=${targetId})`,
      openFailed: (message) => `Failed to open isolated browser tab (${message}); ${fallbackLabel}`,
      attachFailed: (targetId, message) =>
        `Failed to attach to isolated browser tab ${targetId} (${message}); ${fallbackLabel}`,
      closeFailed: (targetId, message) =>
        `Failed to close unused browser tab ${targetId}: ${message}`,
    });
    if (targetConnection) {
      return targetConnection;
    }
    if (attempt >= retries) {
      break;
    }
    attempt += 1;
    await delay(retryDelayMs * attempt);
  }

  if (!fallbackToDefault) {
    throw new Error("Failed to open isolated browser tab; refusing to attach to default target.");
  }
  const client = await connectToChrome(port, logger, effectiveHost);
  return { client };
}

export async function closeTab(
  port: number,
  targetId: string,
  logger: BrowserLogger,
  host?: string,
): Promise<void> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    await CDP.Close({ host: effectiveHost, port, id: targetId });
    logger(`Closed isolated browser tab (target=${targetId})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close browser tab ${targetId}: ${message}`);
  }
}

export function buildChromeFlags(
  headless: boolean,
  debugBindAddress?: string | null,
  acceptLanguage = "en-US,en",
  options: { startMinimized?: boolean } = {},
): string[] {
  const primaryLanguage = acceptLanguage.split(",", 1)[0]?.trim() || "en-US";
  const flags = [
    "--disable-background-networking",
    "--disk-cache-size=16777216",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--no-first-run",
    "--safebrowsing-disable-auto-update",
    "--disable-features=TranslateUI",
    "--mute-audio",
    "--window-size=1280,720",
    `--lang=${primaryLanguage}`,
    `--accept-lang=${acceptLanguage}`,
  ];

  if (process.platform !== "win32" && !isWsl()) {
    flags.push("--password-store=basic", "--use-mock-keychain");
  }

  if (debugBindAddress) {
    flags.push(`--remote-debugging-address=${debugBindAddress}`);
  }

  if (headless) {
    flags.push("--headless=new");
  } else if (options.startMinimized) {
    flags.push("--start-minimized");
  }

  return flags;
}

export function buildChromeLaunchFlags(askProFlags: string[]): string[] {
  return [
    ...Launcher.defaultFlags().filter((flag) => !CPU_THROTTLING_OVERRIDE_FLAGS.has(flag)),
    ...askProFlags.filter((flag) => !CPU_THROTTLING_OVERRIDE_FLAGS.has(flag)),
  ];
}

export function shouldLaunchChromeMinimized(
  config: Pick<
    ResolvedBrowserConfig,
    "headless" | "hideWindow" | "browserTabRef" | "remoteChrome" | "startMinimized"
  >,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    Boolean(config.startMinimized) &&
    platform === "win32" &&
    !config.headless &&
    !config.hideWindow &&
    !config.browserTabRef &&
    !config.remoteChrome
  );
}

function parseDebugPortEnv(): number | null {
  const raw = process.env.ASK_PRO_BROWSER_PORT ?? process.env.ASK_PRO_BROWSER_DEBUG_PORT;
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    return null;
  }
  return value;
}

function resolveRemoteDebugHost(): string | null {
  const override =
    process.env.ASK_PRO_BROWSER_REMOTE_DEBUG_HOST?.trim() || process.env.WSL_HOST_IP?.trim();
  if (override) {
    return override;
  }
  if (!isWsl()) {
    return null;
  }
  try {
    const resolv = readFileSync("/etc/resolv.conf", "utf8");
    for (const line of resolv.split("\n")) {
      const match = line.match(/^nameserver\s+([0-9.]+)/);
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch {
    // ignore; fall back to localhost
  }
  return null;
}

function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  const release = os.release();
  return release.toLowerCase().includes("microsoft");
}

const WINDOWS_BROKER_COMMAND_ENV = "ASK_PRO_WINDOWS_BROKER_COMMAND";
const WINDOWS_BROKER_CWD_ENV = "ASK_PRO_WINDOWS_BROKER_CWD";
const WINDOWS_BROKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$commandLine = [Environment]::GetEnvironmentVariable('${WINDOWS_BROKER_COMMAND_ENV}', 'Process')
if ([string]::IsNullOrWhiteSpace($commandLine)) { throw 'Missing brokered process command line.' }
$workingDirectory = [Environment]::GetEnvironmentVariable('${WINDOWS_BROKER_CWD_ENV}', 'Process')
$environment = @(
  [Environment]::GetEnvironmentVariables('Process').GetEnumerator() |
    Where-Object { $_.Key -notin @('${WINDOWS_BROKER_COMMAND_ENV}', '${WINDOWS_BROKER_CWD_ENV}') } |
    ForEach-Object { "$($_.Key)=$($_.Value)" }
)
$startup = New-CimInstance -ClassName Win32_ProcessStartup -Property @{
  EnvironmentVariables = [string[]]$environment
  PriorityClass = [uint32][System.Diagnostics.ProcessPriorityClass]::BelowNormal
} -ClientOnly
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $commandLine
  CurrentDirectory = $workingDirectory
  ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0 -or $result.ProcessId -le 0) {
  throw "Win32_Process.Create failed with return value $($result.ReturnValue)."
}
[Console]::Out.Write([string]$result.ProcessId)
`;

function quoteWindowsCommandLineArgument(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1);
    } else {
      quoted += "\\".repeat(backslashes);
    }
    quoted += character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function spawnWindowsProcessOutsideJob(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ReturnType<typeof spawn> {
  const commandLine = [command, ...args].map(quoteWindowsCommandLineArgument).join(" ");
  const cwd =
    typeof options.cwd === "string"
      ? options.cwd
      : options.cwd
        ? fileURLToPath(options.cwd)
        : process.cwd();
  const broker = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_BROKER_SCRIPT],
    {
      encoding: "utf8",
      env: {
        ...(options.env ?? process.env),
        [WINDOWS_BROKER_COMMAND_ENV]: commandLine,
        [WINDOWS_BROKER_CWD_ENV]: cwd,
      },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (broker.error || broker.status !== 0) {
    throw broker.error ?? new Error(broker.stderr?.trim() || "Windows process broker failed.");
  }
  const pid = Number.parseInt(broker.stdout.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Windows process broker returned an invalid process id.");
  }

  return Object.assign(new EventEmitter(), {
    pid,
    stdio: [],
    unref: () => undefined,
  }) as unknown as ReturnType<typeof spawn>;
}

const spawnManagedChrome = ((command: string, args: readonly string[], options: SpawnOptions) =>
  process.platform === "win32"
    ? spawnWindowsProcessOutsideJob(command, args, options)
    : spawn(command, args, options)) as typeof spawn;

async function launchManagedChrome({
  chromeFlags,
  chromePath,
  userDataDir,
  host,
  requestedPort,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  host: string | null;
  requestedPort?: number;
}): Promise<LaunchedChrome & { host?: string }> {
  const launcher = new Launcher(
    {
      chromePath: chromePath ?? undefined,
      chromeFlags,
      userDataDir,
      ignoreDefaultFlags: true,
      handleSIGINT: false,
      port: requestedPort ?? undefined,
    },
    { spawn: spawnManagedChrome },
  );

  if (host) {
    const patched = launcher as unknown as { isDebuggerReady?: () => Promise<void>; port?: number };
    patched.isDebuggerReady = function patchedIsDebuggerReady(
      this: Launcher & { port?: number },
    ): Promise<void> {
      const debugPort = this.port ?? 0;
      if (!debugPort) {
        return Promise.reject(new Error("Missing Chrome debug port"));
      }
      return new Promise((resolve, reject) => {
        const client = net.createConnection({ port: debugPort, host });
        const cleanup = () => {
          client.removeAllListeners();
          client.end();
          client.destroy();
          client.unref();
        };
        client.once("error", (err) => {
          cleanup();
          reject(err);
        });
        client.once("connect", () => {
          cleanup();
          resolve();
        });
      });
    };
  }

  try {
    await launcher.launch();
  } catch (error) {
    if (launcher.chromeProcess) {
      try {
        launcher.kill();
      } catch {
        // Preserve the launch failure.
      }
    }
    throw error;
  }

  const kill = async () => launcher.kill();
  return {
    pid: launcher.pid ?? undefined,
    port: launcher.port ?? 0,
    process: launcher.chromeProcess as unknown as NonNullable<LaunchedChrome["process"]>,
    kill,
    host: host ?? undefined,
    remoteDebuggingPipes: launcher.remoteDebuggingPipes,
  } as unknown as LaunchedChrome & { host?: string };
}
