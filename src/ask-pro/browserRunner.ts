import fs from "node:fs/promises";
import path from "node:path";
import { AssistantStoppedError, BrowserAutomationError } from "../browser/errors.js";
import {
  askProAgentIdForLegacyBrowserProfileDir,
  askProAgentIdForManagedBrowserProfileDir,
  askProBrowserProfileDirForAgentId,
  ensureAskProBrowserProfileDir,
  isLegacyAskProManagedBrowserProfileDir,
  isAskProManagedBrowserProfileDir,
  resolveAskProAgentId,
} from "../browser/profilePaths.js";
import { runBrowserMode, type BrowserRunResult } from "../browserMode.js";
import { closeTab } from "../browser/chromeLifecycle.js";
import { resumeBrowserSession } from "../browser/reattach.js";
import type { BrowserLogger } from "../browser/types.js";
import {
  appendAskProLog,
  getAskProSessionPaths,
  readAskProPrompt,
  readAskProStatus,
  updateAskProResumeCommand,
  updateAskProStatus,
  writeAskProAnswer,
  writeAskProBrowserMetadata,
} from "./session.js";
import { harvestLatestAssistantZip, writeResponseZipManifest } from "./responseZip.js";
import { withSessionControllerLease } from "./sessionControllerLease.js";

const DEFAULT_TIMEOUT_MS = 180 * 60 * 1000;
const MANUAL_LOGIN_WAIT_MS = 10 * 60 * 1000;
const ASK_PRO_CHATGPT_URL = "https://chatgpt.com/";
const ASK_PRO_TEMPORARY_CHATGPT_URL = "https://chatgpt.com/?temporary-chat=true";
const ASK_PRO_ACCEPT_LANGUAGE = "en-US,en";
export interface RunAskProBrowserSessionOptions {
  cwd: string;
  sessionId: string;
  temporary?: boolean;
  chatgptUrl?: string;
  browserProfileDir?: string;
  agentId?: string | null;
  allowStartMinimized?: boolean;
  verbose?: boolean;
}

export async function runAskProBrowserSession(
  options: RunAskProBrowserSessionOptions,
): Promise<BrowserRunResult> {
  const { dir } = getAskProSessionPaths(options.cwd, options.sessionId);
  return withSessionControllerLease(dir, () => runAskProBrowserSessionWithLease(options));
}

async function runAskProBrowserSessionWithLease({
  cwd,
  sessionId,
  temporary,
  chatgptUrl: chatgptUrlOverride,
  browserProfileDir,
  agentId: agentIdOverride,
  allowStartMinimized = true,
  verbose,
}: RunAskProBrowserSessionOptions): Promise<BrowserRunResult> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  const prompt = await readAskProPrompt({ cwd, sessionId });
  const { status: sessionStatus } = await readAskProStatus({ cwd, sessionId });
  const artifactsRequested = sessionStatus.artifacts === true;
  const agentId = agentIdOverride !== undefined ? agentIdOverride : resolveAskProAgentId();
  const browserProfile = browserProfileDir ?? (await ensureAskProBrowserProfileDir(agentId));
  const metadata = await readBrowserMetadata(paths.browser).catch(() => null);
  const chatgptUrl =
    chatgptUrlOverride ??
    (temporary === true
      ? ASK_PRO_TEMPORARY_CHATGPT_URL
      : temporary === false
        ? ASK_PRO_CHATGPT_URL
        : (metadata?.url ?? ASK_PRO_TEMPORARY_CHATGPT_URL));
  await fs.mkdir(browserProfile, { recursive: true });
  const startMinimized = allowStartMinimized;
  let capturedFinalStatus: FinalAnswerStatus | null = null;
  await writeAskProBrowserMetadata({
    cwd,
    sessionId,
    metadata: {
      schemaVersion: 1,
      status: "pending",
      agentId,
      profileDir: browserProfile,
      temporary,
      url: chatgptUrl,
      acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
      chromeMode: "launching",
    },
  });
  await updateAskProStatus({ cwd, sessionId, status: "BROWSER_STARTING" });

  const logger = buildAskProBrowserLogger(cwd, sessionId, verbose);
  try {
    await updateAskProStatus({ cwd, sessionId, status: "WAITING" });
    const result = await runBrowserMode({
      prompt,
      attachments: [
        {
          path: paths.contextZip,
          displayPath: "CONTEXT.zip",
        },
      ],
      config: {
        url: chatgptUrl,
        manualLogin: true,
        attachRunning: false,
        manualLoginProfileDir: browserProfile,
        manualLoginWaitMs: MANUAL_LOGIN_WAIT_MS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        inputTimeoutMs: 90_000,
        assistantRecheckDelayMs: 30_000,
        assistantRecheckTimeoutMs: 180_000,
        desiredModel: "GPT-5.6 Sol",
        modelStrategy: "select",
        thinkingTime: "pro",
        acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
        startMinimized,
        keepBrowser: true,
        allowCookieErrors: true,
      },
      log: logger,
      heartbeatIntervalMs: 30_000,
      verbose,
      shouldPreserveWindowStateOnError: (error) =>
        shouldFallbackFromDefaultTemporaryChat(error, {
          chatgptUrl,
          chatgptUrlOverride,
          temporary,
        }),
      runtimeHintCb: async (runtime) => {
        await writeAskProBrowserMetadata({
          cwd,
          sessionId,
          metadata: {
            schemaVersion: 1,
            status: "running",
            agentId,
            profileDir: browserProfile,
            temporary,
            url: chatgptUrl,
            acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
            chromeMode: "launched",
            runtime,
          },
        });
      },
      afterAnswerCb: async ({ Runtime, Page, Input, answer }) => {
        await writePostAnswerResponseZipManifest({
          sessionDir: paths.dir,
          artifactsRequested,
          runtime: Runtime,
          page: Page,
          input: Input,
          logger,
        });
        capturedFinalStatus = await persistCapturedAnswer({
          cwd,
          sessionId,
          sessionDir: paths.dir,
          answer: answer.markdown || answer.text,
          artifactsRequested,
        });
        if (capturedFinalStatus.status === "INCOMPLETE_ANSWER") {
          logger("Keeping browser open for incomplete-answer debugging.");
          return { keepBrowserOpen: true };
        }
        return undefined;
      },
    });

    const answer = result.answerMarkdown || result.answerText;
    const finalStatus =
      capturedFinalStatus ??
      (await persistCapturedAnswer({
        cwd,
        sessionId,
        sessionDir: paths.dir,
        answer,
        artifactsRequested,
      }));
    await writeAskProBrowserMetadata({
      cwd,
      sessionId,
      metadata: {
        schemaVersion: 1,
        status: finalStatus.browserStatus,
        agentId,
        profileDir: browserProfile,
        temporary,
        url: chatgptUrl,
        acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
        chromeMode: "launched",
        runtime: browserResultToRuntime(result),
      },
    });
    return result;
  } catch (error) {
    if (capturedFinalStatus) {
      throw error;
    }
    if (
      shouldFallbackFromDefaultTemporaryChat(error, {
        chatgptUrl,
        chatgptUrlOverride,
        temporary,
      })
    ) {
      await appendAskProLog(
        cwd,
        sessionId,
        "Temporary Chat did not expose the Pro model; retrying in normal ChatGPT.",
      );
      await closeFallbackTemporaryTab(cwd, sessionId, logger);
      await updateAskProStatus({
        cwd,
        sessionId,
        status: "WAITING",
        reason: "temporary_unavailable_fell_back_to_normal_chat",
        temporary: false,
      });
      await updateAskProResumeCommand({
        cwd,
        sessionId,
        resumeCommand: withNoTemporaryResumeCommand(sessionStatus.resumeCommand),
        harvestCommand: sessionStatus.harvestCommand,
        temporary: false,
      });
      const currentMetadata: AskProBrowserMetadata = await readBrowserMetadata(paths.browser).catch(
        () => ({}),
      );
      const { runtime: _closedTemporaryRuntime, ...metadataWithoutRuntime } = currentMetadata;
      await writeAskProBrowserMetadata({
        cwd,
        sessionId,
        metadata: {
          ...metadataWithoutRuntime,
          schemaVersion: 1,
          status: "running",
          agentId,
          profileDir: browserProfile,
          temporary: false,
          url: ASK_PRO_CHATGPT_URL,
          acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
          chromeMode: "launched",
        },
      });
      return runAskProBrowserSessionWithLease({
        cwd,
        sessionId,
        temporary: false,
        chatgptUrl: ASK_PRO_CHATGPT_URL,
        browserProfileDir: browserProfile,
        agentId,
        allowStartMinimized,
        verbose,
      });
    }

    if (isAuthGateError(error)) {
      const currentMetadata = await readBrowserMetadata(paths.browser).catch(() => ({}));
      await writeAskProBrowserMetadata({
        cwd,
        sessionId,
        metadata: {
          ...currentMetadata,
          schemaVersion: 1,
          status: "needs_user_auth",
          agentId,
          profileDir: browserProfile,
          temporary,
          url: chatgptUrl,
          acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
          chromeMode: "launched",
          reason: classifyBrowserError(error),
        },
      });
      await updateAskProStatus({
        cwd,
        sessionId,
        status: "NEEDS_USER_AUTH",
        reason: classifyBrowserError(error),
      });
      throw new AskProNeedsAuthError(sessionId, browserProfile, classifyBrowserError(error));
    }

    if (error instanceof AssistantStoppedError) {
      await writeTerminalBrowserMetadata(
        cwd,
        sessionId,
        "incomplete_answer",
        "stopped_without_answer",
      );
      await updateAskProStatus({
        cwd,
        sessionId,
        status: "INCOMPLETE_ANSWER",
        reason: "stopped_without_answer",
      });
      throw error;
    }
    if (isAssistantTimeoutError(error)) {
      await writeTerminalBrowserMetadata(cwd, sessionId, "wait_timed_out", "assistant_timeout");
      await updateAskProStatus({
        cwd,
        sessionId,
        status: "WAIT_TIMED_OUT",
        reason: "assistant_timeout",
      });
    } else {
      const reason = error instanceof Error ? error.message : String(error);
      await writeTerminalBrowserMetadata(cwd, sessionId, "failed", reason);
      await updateAskProStatus({
        cwd,
        sessionId,
        status: "FAILED",
        reason,
      });
    }
    throw error;
  }
}

export async function resumeAskProBrowserSession(
  options: RunAskProBrowserSessionOptions,
): Promise<void> {
  const { dir } = getAskProSessionPaths(options.cwd, options.sessionId);
  return withSessionControllerLease(dir, () => resumeAskProBrowserSessionWithLease(options));
}

async function resumeAskProBrowserSessionWithLease({
  cwd,
  sessionId,
  temporary,
  verbose,
}: RunAskProBrowserSessionOptions): Promise<void> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  const prompt = await readAskProPrompt({ cwd, sessionId });
  const { status: sessionStatus } = await readAskProStatus({ cwd, sessionId });
  const artifactsRequested = sessionStatus.artifacts === true;
  const logger = buildAskProBrowserLogger(cwd, sessionId, verbose);
  const metadata = await readBrowserMetadata(paths.browser);
  const effectiveTemporary = temporary ?? metadata.temporary;
  const chatgptUrl =
    effectiveTemporary === true
      ? ASK_PRO_TEMPORARY_CHATGPT_URL
      : effectiveTemporary === false
        ? ASK_PRO_CHATGPT_URL
        : (metadata.url ?? ASK_PRO_TEMPORARY_CHATGPT_URL);
  const fallbackProfile = await resolveResumeBrowserProfile(metadata);
  let capturedFinalStatus: FinalAnswerStatus | null = null;
  if (metadata.runtime) {
    metadata.runtime = normalizeResumeRuntime(
      metadata.runtime,
      metadata.profileDir,
      fallbackProfile,
    );
  }
  const attachRunning = !metadata.agentId;
  if (effectiveTemporary === false && isTemporaryAskProUrl(metadata.url ?? "")) {
    await appendAskProLog(
      cwd,
      sessionId,
      "Retrying Temporary Chat session in normal ChatGPT; opening managed browser submission.",
    );
    await runAskProBrowserSessionWithLease({
      cwd,
      sessionId,
      temporary: false,
      chatgptUrl: ASK_PRO_CHATGPT_URL,
      browserProfileDir: fallbackProfile,
      agentId: metadata.agentId ?? null,
      allowStartMinimized: false,
      verbose,
    });
    return;
  }
  if (!metadata.runtime) {
    if (metadata.status !== "needs_user_auth") {
      throw new Error(`session ${sessionId} has no saved browser runtime metadata`);
    }
    await appendAskProLog(
      cwd,
      sessionId,
      "No saved browser runtime metadata; reopening managed browser submission.",
    );
    const storedUrlIsDefaultTemporary = chatgptUrl === ASK_PRO_TEMPORARY_CHATGPT_URL;
    const shouldPreserveUrl =
      effectiveTemporary !== undefined ||
      (metadata.url !== undefined && !storedUrlIsDefaultTemporary);
    await runAskProBrowserSessionWithLease({
      cwd,
      sessionId,
      temporary: effectiveTemporary,
      chatgptUrl: shouldPreserveUrl ? chatgptUrl : undefined,
      browserProfileDir: fallbackProfile,
      agentId: metadata.agentId ?? null,
      allowStartMinimized: false,
      verbose,
    });
    return;
  }

  await updateAskProStatus({ cwd, sessionId, status: "WAITING" });
  await writeAskProBrowserMetadata({
    cwd,
    sessionId,
    metadata: {
      ...metadata,
      schemaVersion: 1,
      status: "running",
      profileDir: fallbackProfile,
      temporary: effectiveTemporary,
      url: chatgptUrl,
      acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
      chromeMode: "reattaching",
      reason: undefined,
    },
  });
  try {
    const result = await resumeBrowserSession(
      metadata.runtime,
      {
        manualLogin: true,
        attachRunning,
        manualLoginProfileDir: fallbackProfile,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        inputTimeoutMs: 90_000,
        acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
        url: chatgptUrl,
        desiredModel: "GPT-5.6 Sol",
        thinkingTime: "pro",
        startMinimized: false,
      },
      logger,
      {
        promptPreview: prompt,
        chromeModeCb: async (chromeMode) => {
          const current = await readBrowserMetadata(paths.browser).catch(() => metadata);
          await writeAskProBrowserMetadata({
            cwd,
            sessionId,
            metadata: {
              ...current,
              schemaVersion: 1,
              status: "running",
              profileDir: fallbackProfile,
              temporary: effectiveTemporary,
              url: chatgptUrl,
              acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
              chromeMode,
              reason: undefined,
            },
          });
        },
        afterAnswerCb: async ({ Runtime, Page, Input, answer }) => {
          await writePostAnswerResponseZipManifest({
            sessionDir: paths.dir,
            artifactsRequested,
            runtime: Runtime,
            page: Page,
            input: Input,
            logger,
          });
          capturedFinalStatus = await persistCapturedAnswer({
            cwd,
            sessionId,
            sessionDir: paths.dir,
            answer: answer.markdown || answer.text,
            artifactsRequested,
          });
          if (capturedFinalStatus.status === "INCOMPLETE_ANSWER") {
            logger("Keeping browser open for incomplete-answer debugging.");
            return { keepBrowserOpen: true };
          }
          return undefined;
        },
      },
    );
    const answer = result.answerMarkdown || result.answerText;
    const finalStatus =
      capturedFinalStatus ??
      (await persistCapturedAnswer({
        cwd,
        sessionId,
        sessionDir: paths.dir,
        answer,
        artifactsRequested,
      }));
    await writeAskProBrowserMetadata({
      cwd,
      sessionId,
      metadata: {
        ...metadata,
        schemaVersion: 1,
        status: finalStatus.browserStatus,
        profileDir: fallbackProfile,
        temporary: effectiveTemporary,
        url: chatgptUrl,
        acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
        chromeMode: result.chromeMode ?? "reused_devtools",
        reason: undefined,
      },
    });
  } catch (error) {
    if (capturedFinalStatus) {
      throw error;
    }
    if (isAuthGateError(error)) {
      const currentMetadata = await readBrowserMetadata(paths.browser).catch(() => metadata);
      await writeAskProBrowserMetadata({
        cwd,
        sessionId,
        metadata: {
          ...currentMetadata,
          schemaVersion: 1,
          status: "needs_user_auth",
          profileDir: fallbackProfile,
          temporary: effectiveTemporary,
          url: chatgptUrl,
          acceptLanguage: ASK_PRO_ACCEPT_LANGUAGE,
          chromeMode: authFailureChromeMode(currentMetadata.chromeMode),
          reason: classifyBrowserError(error),
        },
      });
      await updateAskProStatus({
        cwd,
        sessionId,
        status: "NEEDS_USER_AUTH",
        reason: classifyBrowserError(error),
      });
      throw new AskProNeedsAuthError(sessionId, fallbackProfile, classifyBrowserError(error));
    }
    if (error instanceof AssistantStoppedError) {
      await writeTerminalBrowserMetadata(
        cwd,
        sessionId,
        "incomplete_answer",
        "stopped_without_answer",
      );
      await updateAskProStatus({
        cwd,
        sessionId,
        status: "INCOMPLETE_ANSWER",
        reason: "stopped_without_answer",
      });
      throw error;
    }
    if (isAssistantTimeoutError(error)) {
      await writeTerminalBrowserMetadata(cwd, sessionId, "wait_timed_out", "assistant_timeout");
      await updateAskProStatus({
        cwd,
        sessionId,
        status: "WAIT_TIMED_OUT",
        reason: "assistant_timeout",
      });
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    await writeTerminalBrowserMetadata(cwd, sessionId, "failed", reason);
    await updateAskProStatus({
      cwd,
      sessionId,
      status: "FAILED",
      reason,
    });
    throw error;
  }
}

function isTemporaryAskProUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const value = (parsed.searchParams.get("temporary-chat") ?? "").trim().toLowerCase();
    return value === "true" || value === "1" || value === "yes";
  } catch {
    return false;
  }
}

function withNoTemporaryResumeCommand(command: string): string {
  const withoutStrictTemporary = command.replace(/\s--temporary(?=\s|$)/g, "");
  if (/\s--no-temporary(?=\s|$)/.test(withoutStrictTemporary)) {
    return withoutStrictTemporary;
  }
  return withoutStrictTemporary.replace(/\s--resume(?=\s|$)/, " --no-temporary --resume");
}

async function closeFallbackTemporaryTab(
  cwd: string,
  sessionId: string,
  logger: BrowserLogger,
): Promise<void> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  const metadata = await readBrowserMetadata(paths.browser).catch(() => null);
  const runtime = metadata?.runtime;
  if (!runtime?.chromePort || !runtime.chromeTargetId) {
    return;
  }
  await closeTab(
    runtime.chromePort,
    runtime.chromeTargetId,
    logger,
    runtime.chromeHost ?? "127.0.0.1",
  ).catch(() => undefined);
}

function shouldFallbackFromDefaultTemporaryChat(
  error: unknown,
  options: {
    chatgptUrl: string;
    chatgptUrlOverride?: string;
    temporary?: boolean;
  },
): boolean {
  return (
    options.temporary === undefined &&
    options.chatgptUrlOverride === undefined &&
    isTemporaryAskProUrl(options.chatgptUrl) &&
    isTemporaryProUnavailableError(error)
  );
}

function isTemporaryProUnavailableError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('unable to find model option matching "gpt-5.6 sol"') ||
    message.includes("unable to locate the chatgpt model selector button") ||
    message.includes("unable to select pro intelligence")
  );
}

async function ensureResponseZipManifest(
  sessionDir: string,
  artifactsRequested = true,
): Promise<void> {
  try {
    await fs.access(path.join(sessionDir, "PRO_OUTPUT_MANIFEST.json"));
  } catch {
    await writeResponseZipManifest(
      sessionDir,
      artifactsRequested ? responseZipUnavailableManifest() : responseZipNotRequestedManifest(),
    );
  }
}

async function writePostAnswerResponseZipManifest({
  sessionDir,
  artifactsRequested,
  runtime,
  page,
  input,
  logger,
}: {
  sessionDir: string;
  artifactsRequested: boolean;
  runtime: Parameters<typeof harvestLatestAssistantZip>[0]["runtime"];
  page: Parameters<typeof harvestLatestAssistantZip>[0]["page"];
  input: Parameters<typeof harvestLatestAssistantZip>[0]["input"];
  logger: BrowserLogger;
}): Promise<void> {
  try {
    if (artifactsRequested) {
      const manifest = await harvestLatestAssistantZip({
        runtime,
        page,
        input,
        sessionDir,
      });
      await writeResponseZipManifest(sessionDir, manifest);
    } else {
      await writeResponseZipManifest(sessionDir, responseZipNotRequestedManifest());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Response zip post-processing failed after answer capture: ${message}`);
    await writeResponseZipManifest(sessionDir, responseZipErrorManifest(message)).catch(
      () => undefined,
    );
  }
}

function responseZipNotRequestedManifest() {
  return {
    schemaVersion: 1 as const,
    responseZip: {
      status: "not_requested" as const,
      actualFileName: null,
      downloadPath: null,
      extractPath: null,
      requiredFilesPresent: false,
      notes: ["Response zip harvesting was not requested for this inline-answer session."],
    },
  };
}

function responseZipErrorManifest(message: string) {
  return {
    schemaVersion: 1 as const,
    responseZip: {
      status: "error" as const,
      actualFileName: null,
      downloadPath: null,
      extractPath: null,
      requiredFilesPresent: false,
      notes: [`Response zip post-processing failed after answer capture: ${message}`],
    },
  };
}

function responseZipUnavailableManifest() {
  return {
    schemaVersion: 1 as const,
    responseZip: {
      status: "unavailable" as const,
      actualFileName: null,
      downloadPath: null,
      extractPath: null,
      requiredFilesPresent: false,
      notes: ["Generated zip was unavailable; harvested markdown answer to ANSWER.md."],
    },
  };
}

async function classifyFinalAnswer(
  sessionDir: string,
  answer: string,
): Promise<{ status: "COMPLETED" | "INCOMPLETE_ANSWER"; browserStatus: string; reason?: string }> {
  if (!isSuspiciousPreambleAnswer(answer) || (await hasCompleteResponseZip(sessionDir))) {
    return { status: "COMPLETED", browserStatus: "completed" };
  }
  return {
    status: "INCOMPLETE_ANSWER",
    browserStatus: "incomplete_answer",
    reason: "preamble_without_artifacts",
  };
}

type FinalAnswerStatus = Awaited<ReturnType<typeof classifyFinalAnswer>>;

async function persistCapturedAnswer({
  cwd,
  sessionId,
  sessionDir,
  answer,
  artifactsRequested,
}: {
  cwd: string;
  sessionId: string;
  sessionDir: string;
  answer: string;
  artifactsRequested: boolean;
}): Promise<FinalAnswerStatus> {
  await writeAskProAnswer({ cwd, sessionId, answer });
  await ensureResponseZipManifest(sessionDir, artifactsRequested);
  const finalStatus = await classifyFinalAnswer(sessionDir, answer);
  await updateAskProStatus({
    cwd,
    sessionId,
    status: finalStatus.status,
    reason: finalStatus.reason,
  });
  return finalStatus;
}

async function hasCompleteResponseZip(sessionDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(sessionDir, "PRO_OUTPUT_MANIFEST.json"), "utf8");
    const manifest = JSON.parse(raw) as {
      responseZip?: { status?: string; requiredFilesPresent?: boolean };
    };
    return (
      manifest.responseZip?.status === "downloaded" &&
      manifest.responseZip.requiredFilesPresent === true
    );
  } catch {
    return false;
  }
}

export function isSuspiciousPreambleAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 1000) return false;
  if (hasSubstantiveAnswerMarker(normalized)) return false;
  const futureIntent =
    /\b(sure,?\s+)?(i['’]?ll|i will|let me|i['’]?m going to|i am going to)\b/.test(normalized);
  const deferredWork =
    /\b(inspect|review|analy[sz]e|read|look at|take a look|create|prepare|generate|build|get back to you)\b/.test(
      normalized,
    );
  return futureIntent && deferredWork;
}

function hasSubstantiveAnswerMarker(answer: string): boolean {
  return /\b(recommendation|recommend|answer|verdict|use|fix|root cause|because|risk|should|shouldn['’]?t|must|do not|don['’]?t)\b/.test(
    answer,
  );
}

function authFailureChromeMode(chromeMode: AskProBrowserMetadata["chromeMode"]) {
  return chromeMode === "reattaching" ? "reused_devtools" : chromeMode;
}

async function writeTerminalBrowserMetadata(
  cwd: string,
  sessionId: string,
  status: "failed" | "wait_timed_out" | "incomplete_answer",
  reason: string,
): Promise<void> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  const current = await readBrowserMetadata(paths.browser).catch(() => null);
  if (!current) return;
  const { chromeMode, ...rest } = current;
  const terminalChromeMode =
    status !== "failed" && chromeMode === "reattaching"
      ? "reused_devtools"
      : chromeMode === "launched" || chromeMode === "reused_devtools" || chromeMode === "relaunched"
        ? chromeMode
        : undefined;
  await writeAskProBrowserMetadata({
    cwd,
    sessionId,
    metadata: {
      ...rest,
      schemaVersion: 1,
      status,
      reason,
      ...(terminalChromeMode ? { chromeMode: terminalChromeMode } : {}),
    },
  });
}

async function resolveResumeBrowserProfile(metadata: AskProBrowserMetadata): Promise<string> {
  const agentProfile = resolveStoredAgentProfile(metadata.agentId);
  const profileDir = metadata.profileDir;
  const profileAgentId = profileDir ? askProAgentIdForManagedBrowserProfileDir(profileDir) : null;
  const legacyAgentId = profileDir ? askProAgentIdForLegacyBrowserProfileDir(profileDir) : null;
  if (profileAgentId && profileAgentId !== metadata.agentId) {
    throw new Error("Stored ask-pro agent profile does not match stored agent id.");
  }
  if (legacyAgentId && legacyAgentId !== metadata.agentId) {
    throw new Error("Stored ask-pro agent profile does not match stored agent id.");
  }
  if (profileAgentId && agentProfile) {
    return profileDir!;
  }
  if (legacyAgentId && agentProfile) {
    return ensureAskProBrowserProfileDir(metadata.agentId);
  }
  if (
    profileDir &&
    !profileAgentId &&
    !legacyAgentId &&
    !agentProfile &&
    isAskProManagedBrowserProfileDir(profileDir)
  ) {
    return ensureAskProBrowserProfileDir(null);
  }
  if (
    profileDir &&
    !profileAgentId &&
    !legacyAgentId &&
    !agentProfile &&
    isLegacyAskProManagedBrowserProfileDir(profileDir)
  ) {
    return ensureAskProBrowserProfileDir(null);
  }
  if (profileDir) {
    throw new Error("Stored ask-pro profile path is invalid.");
  }

  return ensureAskProBrowserProfileDir(metadata.agentId);
}

function resolveStoredAgentProfile(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  return askProBrowserProfileDirForAgentId(agentId);
}

function normalizeResumeRuntime(
  runtime: NonNullable<AskProBrowserMetadata["runtime"]>,
  storedProfile: string | undefined,
  resolvedProfile: string,
): NonNullable<AskProBrowserMetadata["runtime"]> {
  const allowed = [storedProfile, resolvedProfile].filter((value): value is string =>
    Boolean(value),
  );
  for (const candidate of [runtime.chromeProfileRoot, runtime.userDataDir]) {
    if (candidate && !allowed.some((value) => samePath(candidate, value))) {
      throw new Error("Stored ask-pro browser runtime profile path is invalid.");
    }
  }
  return {
    ...runtime,
    ...(runtime.chromeProfileRoot ? { chromeProfileRoot: resolvedProfile } : {}),
    ...(runtime.userDataDir ? { userDataDir: resolvedProfile } : {}),
  };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export class AskProNeedsAuthError extends Error {
  constructor(
    readonly sessionId: string,
    readonly browserProfile: string,
    readonly reason: string,
  ) {
    super("ChatGPT authentication is required.");
    this.name = "AskProNeedsAuthError";
  }
}

function buildAskProBrowserLogger(
  cwd: string,
  sessionId: string,
  verbose?: boolean,
): BrowserLogger {
  const logger = ((message?: string) => {
    if (typeof message !== "string") return;
    void appendAskProLog(cwd, sessionId, message);
    const shouldPrint =
      verbose || /\b(thinking|waiting|fallback|retry|stopped|url|reattach)\b/i.test(message);
    if (shouldPrint) {
      console.error(message);
    }
  }) as BrowserLogger;
  logger.verbose = Boolean(verbose);
  logger.sessionLog = (message: string) => {
    void appendAskProLog(cwd, sessionId, message);
  };
  return logger;
}

function isAuthGateError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const stage = error instanceof BrowserAutomationError ? String(error.details?.stage ?? "") : "";
  return (
    stage.includes("cloudflare") ||
    message.includes("login") ||
    message.includes("auth") ||
    message.includes("captcha") ||
    message.includes("cloudflare") ||
    message.includes("session expired") ||
    message.includes("prompt textarea not available") ||
    message.includes("no chatgpt cookies")
  );
}

function isAssistantTimeoutError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("assistant") && message.includes("timed out");
}

function classifyBrowserError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("cloudflare") || message.includes("captcha")) return "challenge_detected";
  if (message.includes("mfa")) return "mfa_detected";
  if (message.includes("auth")) return "auth_page_detected";
  if (message.includes("login") || message.includes("no chatgpt cookies")) {
    return "login_page_detected";
  }
  if (message.includes("prompt textarea not available")) return "composer_not_visible";
  return "auth_required";
}

function browserResultToRuntime(result: BrowserRunResult): Record<string, unknown> {
  return {
    browserTransport: result.browserTransport,
    chromePid: result.chromePid,
    chromePort: result.chromePort,
    chromeHost: result.chromeHost,
    chromeBrowserWSEndpoint: result.chromeBrowserWSEndpoint,
    chromeProfileRoot: result.chromeProfileRoot,
    userDataDir: result.userDataDir,
    chromeTargetId: result.chromeTargetId,
    tabUrl: result.tabUrl,
    controllerPid: result.controllerPid,
  };
}

interface AskProBrowserMetadata {
  schemaVersion?: number;
  status?: string;
  profileDir?: string;
  agentId?: string | null;
  temporary?: boolean;
  url?: string;
  acceptLanguage?: string;
  chromeMode?: "launching" | "launched" | "reattaching" | "reused_devtools" | "relaunched";
  runtime?: {
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
  };
}

async function readBrowserMetadata(filePath: string): Promise<AskProBrowserMetadata> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as AskProBrowserMetadata;
  return parsed;
}
