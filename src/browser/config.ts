import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
import { normalizeBrowserModelStrategy } from "./modelStrategy.js";
import { defaultAskProBrowserProfileDir } from "./profilePaths.js";
import type { BrowserAutomationConfig, ResolvedBrowserConfig } from "./types.js";
import { normalizeChatgptUrl } from "./utils.js";

export function isHeadlessLinux(platform = process.platform, env = process.env): boolean {
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export const DEFAULT_BROWSER_CONFIG: ResolvedBrowserConfig = {
  chromeProfile: null,
  chromePath: null,
  chromeCookiePath: null,
  attachRunning: false,
  browserTabRef: null,
  url: CHATGPT_URL,
  chatgptUrl: CHATGPT_URL,
  timeoutMs: 1_200_000,
  debugPort: null,
  inputTimeoutMs: 60_000,
  assistantRecheckDelayMs: 0,
  assistantRecheckTimeoutMs: 120_000,
  profileLockTimeoutMs: 300_000,
  autoReattachDelayMs: 0,
  autoReattachIntervalMs: 0,
  autoReattachTimeoutMs: 120_000,
  cookieSync: true,
  cookieNames: null,
  cookieSyncWaitMs: 0,
  inlineCookies: null,
  inlineCookiesSource: null,
  headless: false,
  keepBrowser: false,
  hideWindow: false,
  startMinimized: false,
  desiredModel: DEFAULT_MODEL_TARGET,
  modelStrategy: DEFAULT_MODEL_STRATEGY,
  debug: false,
  allowCookieErrors: false,
  remoteChrome: null,
  remoteChromeBrowserWSEndpoint: null,
  remoteChromeProfileRoot: null,
  manualLogin: false,
  manualLoginProfileDir: null,
  manualLoginCookieSync: false,
  manualLoginWaitMs: 20 * 60_000,
  acceptLanguage: "en-US,en",
};

export function resolveBrowserConfig(
  config: BrowserAutomationConfig | undefined,
): ResolvedBrowserConfig {
  const debugPortEnv = parseDebugPort(
    process.env.ASK_PRO_BROWSER_PORT ?? process.env.ASK_PRO_BROWSER_DEBUG_PORT,
  );
  const envAllowCookieErrors =
    (process.env.ASK_PRO_BROWSER_ALLOW_COOKIE_ERRORS ?? "").trim().toLowerCase() === "true" ||
    (process.env.ASK_PRO_BROWSER_ALLOW_COOKIE_ERRORS ?? "").trim() === "1";
  const rawUrl = config?.chatgptUrl ?? config?.url ?? DEFAULT_BROWSER_CONFIG.url;
  const normalizedUrl = normalizeChatgptUrl(
    rawUrl ?? DEFAULT_BROWSER_CONFIG.url,
    DEFAULT_BROWSER_CONFIG.url,
  );
  const desiredModel =
    config?.desiredModel ?? DEFAULT_BROWSER_CONFIG.desiredModel ?? DEFAULT_MODEL_TARGET;
  const modelStrategy =
    normalizeBrowserModelStrategy(config?.modelStrategy) ??
    DEFAULT_BROWSER_CONFIG.modelStrategy ??
    DEFAULT_MODEL_STRATEGY;
  const isWindows = process.platform === "win32";
  const manualLogin =
    config?.manualLogin ?? (isWindows ? true : DEFAULT_BROWSER_CONFIG.manualLogin);
  const cookieSyncDefault = isWindows ? false : DEFAULT_BROWSER_CONFIG.cookieSync;
  const resolvedProfileDir =
    config?.manualLoginProfileDir ??
    process.env.ASK_PRO_BROWSER_PROFILE_DIR ??
    defaultAskProBrowserProfileDir();
  return {
    ...DEFAULT_BROWSER_CONFIG,
    ...config,
    url: normalizedUrl,
    chatgptUrl: normalizedUrl,
    timeoutMs: config?.timeoutMs ?? DEFAULT_BROWSER_CONFIG.timeoutMs,
    debugPort: config?.debugPort ?? debugPortEnv ?? DEFAULT_BROWSER_CONFIG.debugPort,
    inputTimeoutMs: config?.inputTimeoutMs ?? DEFAULT_BROWSER_CONFIG.inputTimeoutMs,
    assistantRecheckDelayMs:
      config?.assistantRecheckDelayMs ?? DEFAULT_BROWSER_CONFIG.assistantRecheckDelayMs,
    assistantRecheckTimeoutMs:
      config?.assistantRecheckTimeoutMs ?? DEFAULT_BROWSER_CONFIG.assistantRecheckTimeoutMs,
    profileLockTimeoutMs:
      config?.profileLockTimeoutMs ?? DEFAULT_BROWSER_CONFIG.profileLockTimeoutMs,
    autoReattachDelayMs: config?.autoReattachDelayMs ?? DEFAULT_BROWSER_CONFIG.autoReattachDelayMs,
    autoReattachIntervalMs:
      config?.autoReattachIntervalMs ?? DEFAULT_BROWSER_CONFIG.autoReattachIntervalMs,
    autoReattachTimeoutMs:
      config?.autoReattachTimeoutMs ?? DEFAULT_BROWSER_CONFIG.autoReattachTimeoutMs,
    cookieSync: config?.cookieSync ?? cookieSyncDefault,
    cookieNames: config?.cookieNames ?? DEFAULT_BROWSER_CONFIG.cookieNames,
    cookieSyncWaitMs: config?.cookieSyncWaitMs ?? DEFAULT_BROWSER_CONFIG.cookieSyncWaitMs,
    inlineCookies: config?.inlineCookies ?? DEFAULT_BROWSER_CONFIG.inlineCookies,
    inlineCookiesSource: config?.inlineCookiesSource ?? DEFAULT_BROWSER_CONFIG.inlineCookiesSource,
    headless: config?.headless ?? isHeadlessLinux(),
    keepBrowser: config?.keepBrowser ?? DEFAULT_BROWSER_CONFIG.keepBrowser,
    hideWindow: config?.hideWindow ?? DEFAULT_BROWSER_CONFIG.hideWindow,
    startMinimized: config?.startMinimized ?? DEFAULT_BROWSER_CONFIG.startMinimized,
    desiredModel,
    modelStrategy,
    chromeProfile: config?.chromeProfile ?? DEFAULT_BROWSER_CONFIG.chromeProfile,
    chromePath: config?.chromePath ?? process.env.CHROME_PATH ?? DEFAULT_BROWSER_CONFIG.chromePath,
    chromeCookiePath: config?.chromeCookiePath ?? DEFAULT_BROWSER_CONFIG.chromeCookiePath,
    attachRunning: config?.attachRunning ?? DEFAULT_BROWSER_CONFIG.attachRunning,
    browserTabRef: config?.browserTabRef ?? DEFAULT_BROWSER_CONFIG.browserTabRef,
    debug: config?.debug ?? DEFAULT_BROWSER_CONFIG.debug,
    allowCookieErrors:
      config?.allowCookieErrors ?? envAllowCookieErrors ?? DEFAULT_BROWSER_CONFIG.allowCookieErrors,
    remoteChromeBrowserWSEndpoint:
      config?.remoteChromeBrowserWSEndpoint ?? DEFAULT_BROWSER_CONFIG.remoteChromeBrowserWSEndpoint,
    remoteChromeProfileRoot:
      config?.remoteChromeProfileRoot ?? DEFAULT_BROWSER_CONFIG.remoteChromeProfileRoot,
    thinkingTime: config?.thinkingTime,
    manualLogin,
    manualLoginProfileDir: manualLogin ? resolvedProfileDir : null,
    manualLoginCookieSync:
      config?.manualLoginCookieSync ?? DEFAULT_BROWSER_CONFIG.manualLoginCookieSync,
    manualLoginWaitMs: config?.manualLoginWaitMs ?? DEFAULT_BROWSER_CONFIG.manualLoginWaitMs,
    acceptLanguage: config?.acceptLanguage ?? DEFAULT_BROWSER_CONFIG.acceptLanguage,
  };
}

function parseDebugPort(raw?: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    return null;
  }
  return value;
}
