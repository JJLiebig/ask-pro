#!/usr/bin/env node
import "dotenv/config";
import { AssistantStoppedError } from "../src/browser/errors.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import {
  createAskProSession,
  getAskProSessionPaths,
  pruneExpiredAskProSessions,
  type AskProStatusFile,
  readAskProAnswer,
  readAskProStatus,
  updateAskProResumeCommand,
  updateAskProStatus,
} from "../src/ask-pro/session.js";
import {
  AskProNeedsAuthError,
  isSuspiciousPreambleAnswer,
  resumeAskProBrowserSession,
  runAskProBrowserSession,
} from "../src/ask-pro/browserRunner.js";
import { renderToonRecord, type AskProToonFields } from "../src/ask-pro/toon.js";
import {
  askProAgentIdForManagedBrowserProfileDir,
  defaultAskProBrowserProfileDir,
} from "../src/browser/profilePaths.js";
import { getCliVersion } from "../src/version.js";

interface AskProOptions {
  dryRun?: boolean;
  files?: string[];
  promptFile?: string;
  artifacts?: boolean;
  responseZip?: boolean;
  resume?: string | boolean;
  status?: string | boolean;
  harvest?: string | boolean;
  copy?: string | boolean;
  temporary?: boolean;
  cwd?: string;
  verbose?: boolean;
}

const program = new Command();

program
  .name("ask-pro")
  .description("Browser-backed ChatGPT Pro escalation for hard engineering questions.")
  .version(getCliVersion())
  .argument("[question...]", "question to send to ChatGPT Pro")
  .option("--dry-run", "prepare the session and context bundle without opening the browser")
  .option("--files <pattern>", "include files or globs in the context bundle", collectFiles, [])
  .option("--prompt-file <path>", "read the question from a UTF-8 file; use - for stdin")
  .option("--artifacts", "ask Pro for ask-pro-response.zip plus markdown fallback")
  .option("--response-zip", "alias for --artifacts")
  .option("--resume [session-id]", "resume a prepared or waiting ask-pro session")
  .option("--status [session-id]", "show ask-pro session status")
  .option("--harvest [session-id]", "print harvested ANSWER.md for a session")
  .option("--copy [session-id]", "print the copy target for a session")
  .option("--temporary", "require ChatGPT Temporary Chat; default runs already try it first")
  .option("--no-temporary", "retry a session outside ChatGPT Temporary Chat")
  .addOption(new Option("--cwd <path>", "project working directory").hideHelp())
  .option("--verbose", "print browser automation diagnostics")
  .action(async (questionParts: string[], options: AskProOptions) => {
    try {
      await runAskPro(questionParts.join(" "), options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeToon("ask_pro_error", {
        code: classifyCliError(message),
        message,
        action: "inspect_session",
      });
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);

async function runAskPro(question: string, options: AskProOptions): Promise<void> {
  const cwd = resolveProjectCwd(options);
  await pruneExpiredAskProSessions({ cwd });
  if (options.status !== undefined) {
    const { status } = await readAskProStatus({ cwd, sessionId: optionSessionId(options.status) });
    printStatusRecord(status, {
      ...(await readBrowserPreflight(cwd, status)),
      ...answerExtraForStatus(status, status.sessionId),
    });
    return;
  }
  if (options.harvest !== undefined) {
    const { status } = await readAskProStatus({
      cwd,
      sessionId: optionSessionId(options.harvest),
    });
    if (!isAnswerBearingStatus(status)) {
      const recoverable = await readRecoverableCapturedAnswer(cwd, status);
      if (recoverable !== null) {
        await writeStdout(recoverable);
        try {
          await updateAskProStatus({ cwd, sessionId: status.sessionId, status: "HARVESTED" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`ask-pro harvest status update failed: ${message}`);
        }
        return;
      }
      printStatusRecord(status, await readBrowserPreflight(cwd, status));
      return;
    }
    const result = await readAskProAnswer({ cwd, sessionId: status.sessionId });
    await writeStdout(result.answer);
    try {
      if (status.status !== "HARVESTED") {
        await updateAskProStatus({ cwd, sessionId: result.sessionId, status: "HARVESTED" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`ask-pro harvest status update failed: ${message}`);
    }
    return;
  }
  if (options.copy !== undefined) {
    const { dir, status } = await readAskProStatus({
      cwd,
      sessionId: optionSessionId(options.copy),
    });
    if (isAnswerBearingStatus(status)) {
      writeToon("ask_pro", {
        session: status.sessionId,
        state: normalizeState(status.status),
        target: path.join(dir, "ANSWER.md"),
        action: "copy_target",
      });
    } else {
      printStatusRecord(status, await readBrowserPreflight(cwd, status));
    }
    return;
  }
  if (options.resume !== undefined) {
    const { status } = await readAskProStatus({ cwd, sessionId: optionSessionId(options.resume) });
    const effectiveOptions = mergeStatusOptions(options, status);
    const resumeCommand = buildResumeCommand(status.sessionId, effectiveOptions, cwd);
    const harvestCommand = buildHarvestCommand(status.sessionId, cwd);
    if (resumeCommand !== status.resumeCommand || harvestCommand !== status.harvestCommand) {
      await updateAskProResumeCommand({
        cwd,
        sessionId: status.sessionId,
        resumeCommand,
        harvestCommand,
        temporary: effectiveOptions.temporary,
      });
    }
    await submitOrResumeBrowserSession(cwd, status.sessionId, effectiveOptions);
    return;
  }

  const dryRun = options.dryRun === true;
  const resolvedQuestion = await resolveQuestion(question, options, cwd);
  const artifacts = options.artifacts === true || options.responseZip === true;
  const session = await createAskProSession({
    cwd,
    question: resolvedQuestion,
    filePatterns: options.files ?? [],
    dryRun,
    artifacts,
  });
  const resumeCommand = buildResumeCommand(session.id, options, cwd);
  const harvestCommand = buildHarvestCommand(session.id, cwd);
  let currentStatus = session.status;
  if (
    resumeCommand !== session.status.resumeCommand ||
    harvestCommand !== session.status.harvestCommand
  ) {
    currentStatus = await updateAskProResumeCommand({
      cwd,
      sessionId: session.id,
      resumeCommand,
      harvestCommand,
      temporary: options.temporary,
    });
  }
  if (dryRun) {
    printStatusRecord(currentStatus, { files: session.manifest.includedFiles.length });
    return;
  }
  await submitOrResumeBrowserSession(cwd, session.id, options);
}

function collectFiles(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

async function resolveQuestion(
  question: string,
  options: AskProOptions,
  cwd: string,
): Promise<string> {
  if (!options.promptFile) {
    return question;
  }
  if (question.trim()) {
    throw new Error("Use either a question argument or --prompt-file, not both.");
  }
  if (options.promptFile === "-") {
    if (process.stdin.isTTY) {
      throw new Error("--prompt-file - requires piped stdin.");
    }
    return readStdin();
  }
  return fs.readFile(path.resolve(cwd, options.promptFile), "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function optionSessionId(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function submitOrResumeBrowserSession(
  cwd: string,
  sessionId: string,
  options: AskProOptions,
): Promise<void> {
  const { status } = await readAskProStatus({ cwd, sessionId });
  if (status.status === "COMPLETED" || status.status === "HARVESTED") {
    printStatusRecord(status, {
      ...(await readBrowserPreflight(cwd, status)),
      ...answerExtraForStatus(status, sessionId),
    });
    return;
  }
  if (
    status.status === "WAITING" ||
    status.status === "WAIT_TIMED_OUT" ||
    status.status === "INCOMPLETE_ANSWER" ||
    status.status === "NEEDS_USER_AUTH"
  ) {
    try {
      await resumeAskProBrowserSession({
        cwd,
        sessionId,
        temporary: options.temporary,
        verbose: options.verbose,
      });
    } catch (error) {
      if (error instanceof AssistantStoppedError) {
        const { status: stopped } = await readAskProStatus({ cwd, sessionId });
        printStatusRecord(stopped, await readBrowserPreflight(cwd, stopped));
        return;
      }
      if (error instanceof AskProNeedsAuthError) {
        await printAuthInstructions(sessionId, options, cwd, error);
        return;
      }
      throw error;
    }
    const { status: completed } = await readAskProStatus({ cwd, sessionId });
    printStatusRecord(completed, {
      ...(await readBrowserPreflight(cwd, completed)),
      ...answerExtraForStatus(completed, sessionId),
    });
    return;
  }
  try {
    await runAskProBrowserSession({
      cwd,
      sessionId,
      temporary: options.temporary,
      verbose: options.verbose,
    });
    const { status: completed } = await readAskProStatus({ cwd, sessionId });
    printStatusRecord(completed, {
      ...(await readBrowserPreflight(cwd, completed)),
      ...answerExtraForStatus(completed, sessionId),
    });
  } catch (error) {
    if (error instanceof AssistantStoppedError) {
      const { status: stopped } = await readAskProStatus({ cwd, sessionId });
      printStatusRecord(stopped, await readBrowserPreflight(cwd, stopped));
      return;
    }
    if (error instanceof AskProNeedsAuthError) {
      await printAuthInstructions(sessionId, options, cwd, error);
      return;
    }
    throw error;
  }
}

function buildResumeCommand(sessionId: string, options: AskProOptions, cwd: string): string {
  const flags = [
    options.temporary === true ? "--temporary" : null,
    options.temporary === false ? "--no-temporary" : null,
  ];
  return buildSessionCommand(cwd, [...flags, "--resume", sessionId]);
}

function buildHarvestCommand(sessionId: string, cwd: string): string {
  return buildSessionCommand(cwd, ["--harvest", sessionId]);
}

function buildSessionCommand(cwd: string, args: Array<string | null>): string {
  const launcher = buildLauncherCommand();
  const flags = [
    needsExplicitCwd(launcher) ? "--cwd" : null,
    needsExplicitCwd(launcher) ? quoteCommandArg(cwd) : null,
    ...args,
  ].filter(Boolean);
  return `${launcher} ${flags.join(" ")}`;
}

function buildLauncherCommand(): string {
  const sourceLauncher = process.env.ASK_PRO_SOURCE_CHECKOUT_LAUNCHER?.trim();
  if (sourceLauncher) {
    return sourceLauncher;
  }
  return "ask-pro";
}

function needsExplicitCwd(launcher: string): boolean {
  return launcher !== "ask-pro";
}

function resolveProjectCwd(options: AskProOptions): string {
  if (options.cwd) {
    return path.resolve(options.cwd);
  }
  if (process.env.ASK_PRO_SOURCE_CHECKOUT_LAUNCHER && process.env.INIT_CWD) {
    return path.resolve(process.env.INIT_CWD);
  }
  return process.cwd();
}

async function printAuthInstructions(
  sessionId: string,
  options: AskProOptions,
  cwd: string,
  error: AskProNeedsAuthError,
): Promise<void> {
  const resumeCommand = buildResumeCommand(sessionId, options, cwd);
  const fallbackPreflight = {
    profile: profileMode(error.browserProfile),
    profile_path: collapseHome(error.browserProfile),
  };
  const browserPreflight = await readBrowserPreflightForSession(cwd, sessionId);
  writeToon("ask_pro", {
    session: sessionId,
    state: "needs_auth",
    reason: error.reason,
    ...fallbackPreflight,
    ...browserPreflight,
    action: "human_login_then_resume",
    resume: resumeCommand,
  });
}

function quoteCommandArg(value: string): string {
  if (process.platform !== "win32") {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function mergeStatusOptions(
  options: AskProOptions,
  status: { temporary?: boolean },
): AskProOptions {
  const temporary = options.temporary !== undefined ? options.temporary : status.temporary;
  return {
    ...options,
    temporary,
  };
}

function printStatusRecord(status: AskProStatusFile, extra: AskProToonFields = {}): void {
  writeToon("ask_pro", {
    session: status.sessionId,
    state: normalizeState(status.status),
    reason: status.reason,
    temporary: normalizeTemporary(status.temporary),
    action: actionForStatus(status),
    resume: shouldPrintResume(status) ? status.resumeCommand : undefined,
    harvest: shouldPrintHarvest(status) ? status.harvestCommand : undefined,
    retry:
      status.reason === "stopped_without_answer"
        ? "Run the original request again without --resume to start a new chat."
        : undefined,
    ...extra,
  });
}

function writeToon(name: string, fields: AskProToonFields): void {
  process.stdout.write(`${renderToonRecord(name, fields)}\n`);
}

async function writeStdout(value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(value, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function normalizeState(status: AskProStatusFile["status"]): string {
  if (status === "NEEDS_USER_AUTH") return "needs_auth";
  return status.toLowerCase();
}

function normalizeTemporary(temporary: boolean | undefined): string {
  if (temporary === true) return "strict";
  if (temporary === false) return "off";
  return "default";
}

function actionForStatus(status: AskProStatusFile): string {
  if (status.reason === "stopped_without_answer") return "choose_resume_or_retry";
  switch (status.status) {
    case "DRY_RUN_COMPLETE":
    case "INCOMPLETE_ANSWER":
    case "READY_TO_SUBMIT":
    case "WAIT_TIMED_OUT":
    case "FAILED":
      return "resume";
    case "NEEDS_USER_AUTH":
      return "human_login_then_resume";
    case "COMPLETED":
      return "harvest";
    case "HARVESTED":
      return "read_answer";
    case "WAITING":
    case "BROWSER_STARTING":
      return "wait";
  }
}

function shouldPrintResume(status: AskProStatusFile): boolean {
  return [
    "BROWSER_STARTING",
    "DRY_RUN_COMPLETE",
    "INCOMPLETE_ANSWER",
    "WAITING",
    "READY_TO_SUBMIT",
    "NEEDS_USER_AUTH",
    "WAIT_TIMED_OUT",
    "FAILED",
  ].includes(status.status);
}

function shouldPrintHarvest(status: AskProStatusFile): boolean {
  return status.status === "COMPLETED";
}

function answerPath(sessionId: string): string {
  return `.ask-pro/sessions/${sessionId}/ANSWER.md`;
}

function answerExtraForStatus(status: AskProStatusFile, sessionId: string): AskProToonFields {
  return isAnswerBearingStatus(status) ? { answer: answerPath(sessionId) } : {};
}

function isAnswerBearingStatus(status: AskProStatusFile): boolean {
  return ["COMPLETED", "HARVESTED"].includes(status.status);
}

async function readRecoverableCapturedAnswer(
  cwd: string,
  status: AskProStatusFile,
): Promise<string | null> {
  if (status.status === "INCOMPLETE_ANSWER") {
    return null;
  }
  try {
    const { answer } = await readAskProAnswer({ cwd, sessionId: status.sessionId });
    return isPlaceholderAnswer(answer) || isSuspiciousPreambleAnswer(answer) ? null : answer;
  } catch {
    return null;
  }
}

function isPlaceholderAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "# dry run\n\nno browser submission was performed." ||
    normalized === "# pending\n\nbrowser submission is not wired in this slice."
  );
}

async function readBrowserPreflight(
  cwd: string,
  status: AskProStatusFile,
): Promise<AskProToonFields> {
  return readBrowserPreflightForSession(cwd, status.sessionId);
}

async function readBrowserPreflightForSession(
  cwd: string,
  sessionId: string,
): Promise<AskProToonFields> {
  const metadata = await readBrowserMetadata(cwd, sessionId);
  if (!metadata) return {};
  const profileDir = typeof metadata.profileDir === "string" ? metadata.profileDir : undefined;
  const profile = profileMode(profileDir);
  return compactFields({
    profile,
    profile_path: profile && profileDir ? collapseHome(profileDir) : undefined,
    chrome: chromeMode(metadata),
    language: typeof metadata.acceptLanguage === "string" ? metadata.acceptLanguage : undefined,
    conversation_url: recoverableConversationUrl(metadata),
  });
}

async function readBrowserMetadata(
  cwd: string,
  sessionId: string,
): Promise<BrowserMetadata | null> {
  try {
    const paths = getAskProSessionPaths(cwd, sessionId);
    const raw = await fs.readFile(paths.browser, "utf8");
    return JSON.parse(raw) as BrowserMetadata;
  } catch {
    return null;
  }
}

function profileMode(profileDir: string | undefined): string | undefined {
  if (!profileDir) return undefined;
  if (askProAgentIdForManagedBrowserProfileDir(profileDir)) return "agent";
  if (path.resolve(profileDir) === path.resolve(defaultAskProBrowserProfileDir())) return "shared";
  return undefined;
}

function chromeMode(metadata: BrowserMetadata): string | undefined {
  if (typeof metadata.chromeMode === "string") return metadata.chromeMode;
  return undefined;
}

function recoverableConversationUrl(metadata: BrowserMetadata): string | undefined {
  if (metadata.temporary === true) return undefined;
  const runtime = browserRuntimeMetadata(metadata.runtime);
  const candidates = [runtime.tabUrl, metadata.url].filter(
    (value): value is string => typeof value === "string",
  );
  return candidates.find(isConversationUrl);
}

function browserRuntimeMetadata(value: unknown): { tabUrl?: string } {
  return value !== null && typeof value === "object" ? (value as { tabUrl?: string }) : {};
}

function isConversationUrl(value: string): boolean {
  return /^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+(?:[/?#]|$)/i.test(value);
}

interface BrowserMetadata {
  status?: string;
  profileDir?: string;
  agentId?: string | null;
  temporary?: boolean;
  url?: string;
  acceptLanguage?: string;
  chromeMode?: string;
  runtime?: unknown;
}

function compactFields(fields: AskProToonFields): AskProToonFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function collapseHome(filePath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return filePath;
  const resolvedHome = path.resolve(home);
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath === resolvedHome) return "~";
  if (resolvedPath.startsWith(`${resolvedHome}${path.sep}`)) {
    return `~${path.sep}${path.relative(resolvedHome, resolvedPath)}`;
  }
  return filePath;
}

function classifyCliError(message: string): string {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("requires a question") ||
    normalized.includes("no ask-pro sessions") ||
    normalized.includes("use either a question argument or --prompt-file") ||
    normalized.includes("--prompt-file - requires piped stdin")
  ) {
    return "usage";
  }
  if (normalized.includes("auth") || normalized.includes("login")) {
    return "auth_required";
  }
  if (normalized.includes("browser") || normalized.includes("chatgpt")) {
    return "browser_failed";
  }
  return "failed";
}
