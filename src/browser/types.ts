import type CDP from "chrome-remote-interface";
import type Protocol from "devtools-protocol";

export type ChromeClient = Awaited<ReturnType<typeof CDP>>;
export type CookieParam = Protocol.Network.CookieParam;
export type BrowserModelStrategy = "select" | "current" | "ignore";
export type ThinkingTimeLevel = "light" | "standard" | "extended" | "heavy" | "pro";

export type BrowserLogger = ((message: string) => void) & {
  verbose?: boolean;
  sessionLog?: (message: string) => void;
};

export interface BrowserAttachment {
  path: string;
  displayPath: string;
  sizeBytes?: number;
}

export interface BrowserRuntimeMetadata {
  githubCheckPending?: boolean;
  browserTransport?: "cdp";
  chromePid?: number;
  chromePort?: number;
  chromeHost?: string;
  chromeBrowserWSEndpoint?: string;
  chromeProfileRoot?: string;
  userDataDir?: string;
  chromeTargetId?: string;
  tabUrl?: string;
  conversationId?: string;
  controllerPid?: number;
}

export interface BrowserAutomationConfig {
  github?: boolean;
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  browserTabRef?: string | null;
  url?: string;
  chatgptUrl?: string | null;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  /** Delay before rechecking the conversation after an assistant timeout. */
  assistantRecheckDelayMs?: number;
  /** Time budget for the delayed recheck attempt. */
  assistantRecheckTimeoutMs?: number;
  /** Max time to wait for a shared manual-login profile lock (serializes parallel runs). */
  profileLockTimeoutMs?: number;
  /** Delay before starting periodic auto-reattach attempts after a timeout. */
  autoReattachDelayMs?: number;
  /** Interval between auto-reattach attempts (0 disables). */
  autoReattachIntervalMs?: number;
  /** Time budget for each auto-reattach attempt. */
  autoReattachTimeoutMs?: number;
  cookieSync?: boolean;
  cookieNames?: string[] | null;
  cookieSyncWaitMs?: number;
  inlineCookies?: CookieParam[] | null;
  inlineCookiesSource?: string | null;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  startMinimized?: boolean;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  debug?: boolean;
  allowCookieErrors?: boolean;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  manualLoginWaitMs?: number;
  acceptLanguage?: string;
  /** Intelligence or legacy thinking-time level to select in ChatGPT. */
  thinkingTime?: ThinkingTimeLevel;
}

export interface BrowserRunOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  /**
   * Optional secondary submission to try if the initial prompt is rejected by ChatGPT
   * (e.g. inline file paste exceeds composer limits). Intended for auto inline->upload fallback.
   */
  fallbackSubmission?: { prompt: string; attachments: BrowserAttachment[] };
  config?: BrowserAutomationConfig;
  log?: BrowserLogger;
  heartbeatIntervalMs?: number;
  verbose?: boolean;
  /** Optional hook to persist runtime info (port/url/target) as soon as Chrome is ready. */
  runtimeHintCb?: (hint: BrowserRuntimeMetadata) => void | Promise<void>;
  /** Keep the current managed Chrome window state for a caller-owned automatic retry. */
  shouldPreserveWindowStateOnError?: (error: Error) => boolean;
  /** Optional hook that can inspect the live page after the final answer is captured. */
  afterAnswerCb?: (context: {
    Runtime: ChromeClient["Runtime"];
    Page: ChromeClient["Page"];
    Input: ChromeClient["Input"];
    answer: {
      text: string;
      markdown: string;
      html?: string;
      meta?: { turnId?: string | null; messageId?: string | null };
    };
  }) => void | { keepBrowserOpen?: boolean } | Promise<void | { keepBrowserOpen?: boolean }>;
}

export interface BrowserRunResult {
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  tookMs: number;
  answerTokens: number;
  answerChars: number;
  browserTransport?: "cdp";
  chromePid?: number;
  chromePort?: number;
  chromeHost?: string;
  chromeBrowserWSEndpoint?: string;
  chromeProfileRoot?: string;
  userDataDir?: string;
  chromeTargetId?: string;
  tabUrl?: string;
  controllerPid?: number;
}

export type ResolvedBrowserConfig = Required<
  Omit<
    BrowserAutomationConfig,
    | "chromeProfile"
    | "chromePath"
    | "chromeCookiePath"
    | "desiredModel"
    | "remoteChrome"
    | "remoteChromeBrowserWSEndpoint"
    | "remoteChromeProfileRoot"
    | "manualLoginWaitMs"
    | "acceptLanguage"
    | "thinkingTime"
    | "modelStrategy"
    | "github"
  >
> & {
  github?: boolean;
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  browserTabRef?: string | null;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  thinkingTime?: ThinkingTimeLevel;
  debugPort?: number | null;
  inlineCookiesSource?: string | null;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  manualLoginWaitMs?: number;
  startMinimized?: boolean;
  acceptLanguage?: string;
};
