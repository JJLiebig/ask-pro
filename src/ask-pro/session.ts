import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { atomicWriteFile } from "./atomicWrite.js";
import { createStoredZip } from "./zip.js";

export type AskProStatus =
  | "BROWSER_STARTING"
  | "DRY_RUN_COMPLETE"
  | "READY_TO_SUBMIT"
  | "NEEDS_USER_AUTH"
  | "NEEDS_GITHUB_CONNECTION"
  | "WAITING"
  | "WAIT_TIMED_OUT"
  | "INCOMPLETE_ANSWER"
  | "HARVESTED"
  | "COMPLETED"
  | "FAILED";

export interface AskProIncludedFile {
  path: string;
  reason: string;
}

export interface AskProExcludedFile {
  path: string;
  reason: string;
}

export interface AskProManifest {
  schemaVersion: 1;
  sessionId: string;
  question: string;
  includedFiles: AskProIncludedFile[];
  excludedFiles: AskProExcludedFile[];
  redaction: {
    mode: "best_effort";
    findings: string[];
  };
}

export interface AskProStatusFile {
  schemaVersion: 1;
  sessionId: string;
  status: AskProStatus;
  createdAt: string;
  updatedAt: string;
  resumeCommand: string;
  harvestCommand: string;
  dryRun: boolean;
  artifacts?: boolean;
  github?: boolean;
  temporary?: boolean;
  reason?: string;
}

export interface AskProSession {
  id: string;
  dir: string;
  status: AskProStatusFile;
  manifest: AskProManifest;
}

export interface AskProSessionPaths {
  dir: string;
  prompt: string;
  manifestMarkdown: string;
  manifestJson: string;
  contextZip: string;
  answer: string;
  browser: string;
  status: string;
  log: string;
}

const DEFAULT_EXCLUDES = [
  ".ask-pro/**",
  ".env",
  ".env.*",
  "**/*.pem",
  "**/*.key",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  "target/**",
  "vendor/**",
  ".git/**",
];
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/;
const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function createAskProSession({
  cwd,
  question,
  filePatterns,
  dryRun,
  artifacts = false,
  github = false,
}: {
  cwd: string;
  question: string;
  filePatterns: string[];
  dryRun: boolean;
  artifacts?: boolean;
  github?: boolean;
}): Promise<AskProSession> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("ask-pro requires a question.");
  }

  const { sessionId, sessionDir } = await createSessionDirectory(cwd, trimmedQuestion);

  const collected = await collectContextFiles({ cwd, filePatterns });
  const redactionFindings: string[] = [];
  const redactedFiles = await Promise.all(
    collected.includedFiles.map(async (file) => {
      const absolute = path.join(cwd, file.path);
      const raw = await fs.readFile(absolute, "utf8");
      const redacted = redactSecrets(raw, file.path, redactionFindings);
      return { path: file.path, content: redacted };
    }),
  );

  const manifest: AskProManifest = {
    schemaVersion: 1,
    sessionId,
    question: trimmedQuestion,
    includedFiles: collected.includedFiles,
    excludedFiles: collected.excludedFiles,
    redaction: {
      mode: "best_effort",
      findings: redactionFindings,
    },
  };

  const now = new Date().toISOString();
  const status: AskProStatusFile = {
    schemaVersion: 1,
    sessionId,
    status: dryRun ? "DRY_RUN_COMPLETE" : "READY_TO_SUBMIT",
    createdAt: now,
    updatedAt: now,
    resumeCommand: `ask-pro --resume ${sessionId}`,
    harvestCommand: `ask-pro --harvest ${sessionId}`,
    dryRun,
    artifacts,
    ...(github ? { github: true } : {}),
  };

  const submittedPrompt = renderSubmittedPrompt(question, artifacts, github);
  const manifestMarkdown = renderManifestMarkdown(manifest);
  const browserMetadata = {
    schemaVersion: 1,
    status: dryRun ? "not_started" : "pending",
    notes: dryRun
      ? ["Dry run only; no browser was opened."]
      : ["Browser submission is pending ask-pro runner wiring."],
  };
  const answer = dryRun
    ? "# Dry Run\n\nNo browser submission was performed.\n"
    : "# Pending\n\nBrowser submission is not wired in this slice.\n";

  await Promise.all([
    fs.writeFile(path.join(sessionDir, "PROMPT.md"), submittedPrompt, "utf8"),
    fs.writeFile(path.join(sessionDir, "MANIFEST.md"), manifestMarkdown, "utf8"),
    fs.writeFile(
      path.join(sessionDir, "MANIFEST.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(sessionDir, "status.json"),
      `${JSON.stringify(status, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(sessionDir, "browser.json"),
      `${JSON.stringify(browserMetadata, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(path.join(sessionDir, "ANSWER.md"), answer, "utf8"),
    fs.writeFile(path.join(sessionDir, "log.txt"), renderLog(status, manifest), "utf8"),
  ]);

  const zipEntries = [
    { name: "MANIFEST.md", data: manifestMarkdown },
    ...redactedFiles.map((file) => ({
      name: `context/${file.path.replace(/\\/g, "/")}`,
      data: file.content,
    })),
  ];
  await fs.writeFile(path.join(sessionDir, "CONTEXT.zip"), createStoredZip(zipEntries));

  return { id: sessionId, dir: sessionDir, status, manifest };
}

export function getAskProSessionPaths(cwd: string, sessionId: string): AskProSessionPaths {
  const dir = resolveAskProSessionDir(cwd, sessionId);
  return {
    dir,
    prompt: path.join(dir, "PROMPT.md"),
    manifestMarkdown: path.join(dir, "MANIFEST.md"),
    manifestJson: path.join(dir, "MANIFEST.json"),
    contextZip: path.join(dir, "CONTEXT.zip"),
    answer: path.join(dir, "ANSWER.md"),
    browser: path.join(dir, "browser.json"),
    status: path.join(dir, "status.json"),
    log: path.join(dir, "log.txt"),
  };
}

export async function pruneExpiredAskProSessions({
  cwd,
  now = Date.now(),
}: {
  cwd: string;
  now?: number;
}): Promise<number> {
  const root = getAskProSessionsRoot(cwd);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidAskProSessionId(entry.name)) continue;
    const sessionDir = resolveAskProSessionDir(cwd, entry.name);
    let createdAtMs;
    try {
      createdAtMs = await readSessionRetentionTimestamp(sessionDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (createdAtMs > now - SESSION_RETENTION_MS) continue;

    try {
      await fs.rm(sessionDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      removed += 1;
    } catch (error) {
      if (
        isNodeError(error) &&
        ["ENOENT", "EBUSY", "EACCES", "EPERM", "ENOTEMPTY"].includes(error.code ?? "")
      ) {
        continue;
      }
      throw error;
    }
  }
  return removed;
}

export async function updateAskProStatus({
  cwd,
  sessionId,
  status,
  reason,
  temporary,
}: {
  cwd: string;
  sessionId: string;
  status: AskProStatus;
  reason?: string;
  temporary?: boolean;
}): Promise<AskProStatusFile> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  const current = JSON.parse(await fs.readFile(paths.status, "utf8")) as AskProStatusFile;
  const { reason: _currentReason, ...currentWithoutReason } = current;
  const next: AskProStatusFile = {
    ...currentWithoutReason,
    status,
    updatedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
    ...(temporary !== undefined ? { temporary } : {}),
  };
  await atomicWriteFile(paths.status, `${JSON.stringify(next, null, 2)}\n`);
  await appendAskProLog(cwd, sessionId, `status=${status}${reason ? ` reason=${reason}` : ""}`);
  return next;
}

export async function updateAskProResumeCommand({
  cwd,
  sessionId,
  resumeCommand,
  harvestCommand,
  temporary,
}: {
  cwd: string;
  sessionId: string;
  resumeCommand: string;
  harvestCommand?: string;
  temporary?: boolean;
}): Promise<AskProStatusFile> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  const current = JSON.parse(await fs.readFile(paths.status, "utf8")) as AskProStatusFile;
  const next: AskProStatusFile = {
    ...current,
    resumeCommand,
    harvestCommand: harvestCommand ?? current.harvestCommand,
    ...(temporary !== undefined ? { temporary } : {}),
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteFile(paths.status, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function writeAskProAnswer({
  cwd,
  sessionId,
  answer,
}: {
  cwd: string;
  sessionId: string;
  answer: string;
}): Promise<void> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  await atomicWriteFile(paths.answer, answer.endsWith("\n") ? answer : `${answer}\n`);
}

export async function writeAskProBrowserMetadata({
  cwd,
  sessionId,
  metadata,
}: {
  cwd: string;
  sessionId: string;
  metadata: unknown;
}): Promise<void> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  await atomicWriteFile(paths.browser, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function appendAskProLog(
  cwd: string,
  sessionId: string,
  message: string,
): Promise<void> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  const line = `${new Date().toISOString()} ${redactSecretsForLog(message)}\n`;
  await fs.appendFile(paths.log, line, "utf8");
}

export async function readAskProStatus({
  cwd,
  sessionId,
}: {
  cwd: string;
  sessionId?: string;
}): Promise<{ dir: string; status: AskProStatusFile }> {
  const id = sessionId ?? (await findLatestSessionId(cwd));
  const paths = getAskProSessionPaths(cwd, id);
  const raw = await fs.readFile(paths.status, "utf8");
  return { dir: paths.dir, status: JSON.parse(raw) as AskProStatusFile };
}

export async function readAskProAnswer({
  cwd,
  sessionId,
}: {
  cwd: string;
  sessionId?: string;
}): Promise<{ sessionId: string; answer: string }> {
  const { status, dir } = await readAskProStatus({ cwd, sessionId });
  const answer = await fs.readFile(path.join(dir, "ANSWER.md"), "utf8");
  return { sessionId: status.sessionId, answer };
}

export async function readAskProPrompt({
  cwd,
  sessionId,
}: {
  cwd: string;
  sessionId: string;
}): Promise<string> {
  const paths = getAskProSessionPaths(cwd, sessionId);
  return fs.readFile(paths.prompt, "utf8");
}

async function findLatestSessionId(cwd: string): Promise<string> {
  const root = getAskProSessionsRoot(cwd);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const sessions = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && isValidAskProSessionId(entry.name))
        .map((entry) => readSessionCreatedAt(cwd, entry.name)),
    )
  ).filter((session) => session !== undefined);
  const latest = sessions.sort(
    (left, right) =>
      left.createdAtMs - right.createdAtMs ||
      left.tiebreakerMs - right.tiebreakerMs ||
      left.sessionId.localeCompare(right.sessionId),
  )[sessions.length - 1]?.sessionId;
  if (!latest) {
    throw new Error("No ask-pro sessions found.");
  }
  return latest;
}

async function readSessionRetentionTimestamp(sessionDir: string): Promise<number> {
  try {
    const status = JSON.parse(
      await fs.readFile(path.join(sessionDir, "status.json"), "utf8"),
    ) as Partial<AskProStatusFile>;
    const createdAt = typeof status.createdAt === "string" ? Date.parse(status.createdAt) : NaN;
    if (Number.isFinite(createdAt)) return createdAt;
  } catch {
    // Fall back to the directory timestamp for damaged legacy sessions.
  }
  return (await fs.stat(sessionDir)).mtimeMs;
}

async function readSessionCreatedAt(
  cwd: string,
  sessionId: string,
): Promise<{ sessionId: string; createdAtMs: number; tiebreakerMs: number } | undefined> {
  const statusPath = path.join(resolveAskProSessionDir(cwd, sessionId), "status.json");
  try {
    const [raw, stat] = await Promise.all([fs.readFile(statusPath, "utf8"), fs.stat(statusPath)]);
    const status = JSON.parse(raw) as Partial<AskProStatusFile>;
    const createdAt = typeof status.createdAt === "string" ? Date.parse(status.createdAt) : NaN;
    const createdAtMs = Number.isFinite(createdAt) ? createdAt : 0;
    return {
      sessionId,
      createdAtMs,
      tiebreakerMs: stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

async function createSessionDirectory(
  cwd: string,
  question: string,
): Promise<{ sessionId: string; sessionDir: string }> {
  const root = getAskProSessionsRoot(cwd);
  await fs.mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sessionId = buildSessionId(question);
    const sessionDir = resolveAskProSessionDir(cwd, sessionId);
    try {
      await fs.mkdir(sessionDir);
      return { sessionId, sessionDir };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not allocate a unique ask-pro session id.");
}

function getAskProSessionsRoot(cwd: string): string {
  return path.resolve(cwd, ".ask-pro", "sessions");
}

function resolveAskProSessionDir(cwd: string, sessionId: string): string {
  validateAskProSessionId(sessionId);
  const root = getAskProSessionsRoot(cwd);
  const dir = path.resolve(root, sessionId);
  const relative = path.relative(root, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid ask-pro session id: ${sessionId}`);
  }
  return dir;
}

function validateAskProSessionId(sessionId: string): void {
  if (!isValidAskProSessionId(sessionId)) {
    throw new Error(`Invalid ask-pro session id: ${sessionId}`);
  }
}

function isValidAskProSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function collectContextFiles({
  cwd,
  filePatterns,
}: {
  cwd: string;
  filePatterns: string[];
}): Promise<{
  includedFiles: AskProIncludedFile[];
  excludedFiles: AskProExcludedFile[];
}> {
  const patterns = await normalizeFilePatterns(cwd, filePatterns);
  const matched =
    patterns.length > 0
      ? await fg(patterns, {
          cwd,
          onlyFiles: true,
          dot: true,
          unique: true,
          ignore: DEFAULT_EXCLUDES,
        })
      : [];
  const realCwd = await realpathIfExists(cwd);
  const includedFiles = await Promise.all(
    matched.sort().map(async (entry) => ({
      path: await normalizeMatchedFilePath(cwd, realCwd, entry),
      reason: "Matched by --files pattern.",
    })),
  );
  const excludedFiles = DEFAULT_EXCLUDES.map((entry) => ({
    path: entry,
    reason: "Default safety exclude.",
  }));
  return { includedFiles, excludedFiles };
}

async function normalizeFilePatterns(cwd: string, filePatterns: string[]): Promise<string[]> {
  return Promise.all(filePatterns.map((pattern) => normalizeFilePattern(cwd, pattern)));
}

async function normalizeFilePattern(cwd: string, pattern: string): Promise<string> {
  const normalized = pattern.replace(/\\/g, "/");
  const asPath = path.resolve(cwd, normalized);
  const realCwd = await realpathIfExists(cwd);
  await assertFilePatternPrefixInsideCwd(cwd, realCwd, pattern);
  if (path.isAbsolute(pattern)) {
    const realTarget = await realpathIfExists(asPath);
    const realRelative = path.relative(realCwd, realTarget);
    if (isOutsidePath(realRelative)) {
      throw new Error(`--files path must be inside the project cwd: ${pattern}`);
    }
    const relative = path.relative(cwd, asPath);
    if (isOutsidePath(relative)) {
      throw new Error(`--files path must be inside the project cwd: ${pattern}`);
    }
    return expandDirectoryPattern(asPath, normalizeManifestPath(relative) || ".");
  }
  const realTarget = await realpathIfExists(asPath);
  const realRelative = path.relative(realCwd, realTarget);
  if ((await pathExists(asPath)) && isOutsidePath(realRelative)) {
    throw new Error(`--files path must be inside the project cwd: ${pattern}`);
  }
  return expandDirectoryPattern(asPath, normalized);
}

async function assertFilePatternPrefixInsideCwd(
  cwd: string,
  realCwd: string,
  pattern: string,
): Promise<void> {
  await Promise.all(
    expandBraceAlternatives(pattern).map((expandedPattern) =>
      assertExpandedFilePatternInsideCwd(cwd, realCwd, expandedPattern, pattern),
    ),
  );
}

async function assertExpandedFilePatternInsideCwd(
  cwd: string,
  realCwd: string,
  expandedPattern: string,
  originalPattern: string,
): Promise<void> {
  assertNoRootedGlobAlternative(expandedPattern, originalPattern);
  assertNoUnsafeExtglobBody(expandedPattern, originalPattern);
  const { prefix, globTail } = splitPatternAtFirstGlob(expandedPattern);
  const absolutePrefix = path.resolve(cwd, prefix || ".");
  const lexicalRelative = path.relative(path.resolve(cwd), absolutePrefix);
  if (isOutsidePath(lexicalRelative)) {
    throw new Error(`--files path must be inside the project cwd: ${originalPattern}`);
  }
  assertGlobTailInsideCwd(lexicalRelative, globTail, originalPattern);

  if (!(await pathExists(absolutePrefix))) {
    return;
  }

  const realPrefix = await fs.realpath(absolutePrefix);
  const realRelative = path.relative(realCwd, realPrefix);
  if (isOutsidePath(realRelative)) {
    throw new Error(`--files path must be inside the project cwd: ${originalPattern}`);
  }
}

function expandBraceAlternatives(pattern: string): string[] {
  const results: string[] = [];
  const visit = (source: string): void => {
    const brace = findExpandableBrace(source);
    if (!brace) {
      results.push(source);
      return;
    }
    for (const alternative of brace.alternatives) {
      if (results.length >= 64) {
        throw new Error(`--files pattern has too many brace alternatives: ${pattern}`);
      }
      visit(`${source.slice(0, brace.start)}${alternative}${source.slice(brace.end + 1)}`);
    }
  };
  visit(pattern.replace(/\\/g, "/"));
  return results;
}

function findExpandableBrace(
  pattern: string,
): { start: number; end: number; alternatives: string[] } | undefined {
  for (let start = 0; start < pattern.length; start += 1) {
    if (pattern[start] !== "{") {
      continue;
    }
    let depth = 0;
    for (let end = start; end < pattern.length; end += 1) {
      if (pattern[end] === "{") {
        depth += 1;
      } else if (pattern[end] === "}") {
        depth -= 1;
      }
      if (depth === 0) {
        const alternatives = splitBraceAlternatives(pattern.slice(start + 1, end));
        if (alternatives.length > 1) {
          return { start, end, alternatives };
        }
        start = end;
        break;
      }
    }
  }
  return undefined;
}

function splitBraceAlternatives(body: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let segmentStart = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "{") {
      depth += 1;
    } else if (body[index] === "}") {
      depth -= 1;
    } else if (body[index] === "," && depth === 0) {
      alternatives.push(body.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }
  alternatives.push(body.slice(segmentStart));
  return alternatives.length === 1 ? [] : alternatives;
}

function splitPatternAtFirstGlob(pattern: string): { prefix: string; globTail: string[] } {
  const normalized = pattern.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const firstGlobSegment = segments.findIndex(hasGlobSyntax);
  return firstGlobSegment === -1
    ? { prefix: normalized, globTail: [] }
    : {
        prefix: segments.slice(0, firstGlobSegment).join("/"),
        globTail: segments.slice(firstGlobSegment),
      };
}

function assertGlobTailInsideCwd(
  lexicalRelativePrefix: string,
  globTail: string[],
  pattern: string,
): void {
  let depth =
    lexicalRelativePrefix === ""
      ? 0
      : lexicalRelativePrefix.replace(/\\/g, "/").split("/").filter(Boolean).length;
  for (const segment of globTail) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (globSegmentCanExpandToParent(segment)) {
      depth -= 1;
    } else if (hasGlobSyntax(segment)) {
      depth += globSegmentMinimumDepth(segment);
    } else if (segment === "..") {
      depth -= 1;
    } else {
      depth += 1;
    }
    if (depth < 0) {
      throw new Error(`--files path must be inside the project cwd: ${pattern}`);
    }
  }
}

function hasGlobSyntax(segment: string): boolean {
  return /[*?[\]{}]|[!+@]\(/.test(segment);
}

function globSegmentCanExpandToParent(segment: string): boolean {
  return (
    hasGlobSyntax(segment) &&
    (/(^|[,{(|])\.\.($|[,}|)])/.test(segment) ||
      (hasNestedExtglob(segment) && segment.includes(".")) ||
      (segment.includes("..") && segmentContainsEmptyCapableExtglob(segment)) ||
      segment.replaceAll(emptyCapableExtglobPattern, "") === "..")
  );
}

function globSegmentMinimumDepth(segment: string): number {
  if (segment === "**" || extglobSegmentCanBeEmpty(segment)) {
    return 0;
  }
  return 1;
}

function extglobSegmentCanBeEmpty(segment: string): boolean {
  const body = segment.match(/^([!*+@?])\((.*)\)$/)?.[2];
  return (
    body !== undefined &&
    (hasNestedExtglob(segment) ||
      segment.startsWith("!(") ||
      segment.startsWith("?(") ||
      segment.startsWith("*(") ||
      body.includes("!(") ||
      body.includes("?(") ||
      body.includes("*(") ||
      body.includes("(|") ||
      body.includes("|)") ||
      body.split("|").includes(""))
  );
}

const emptyCapableExtglobPattern = /[!?*]\([^)]*\)|[+@]\([^)]*(?:\|\)|\(\||\|\|)[^)]*\)/g;

function hasNestedExtglob(segment: string): boolean {
  return /[!+@?*]\([^)]*[!+@?*]\(/.test(segment);
}

function segmentContainsEmptyCapableExtglob(segment: string): boolean {
  emptyCapableExtglobPattern.lastIndex = 0;
  return emptyCapableExtglobPattern.test(segment);
}

function assertNoRootedGlobAlternative(pattern: string, originalPattern: string): void {
  if (/[,(|](?:\/|[A-Za-z]:\/)/.test(pattern)) {
    throw new Error(`--files path must be inside the project cwd: ${originalPattern}`);
  }
}

function assertNoUnsafeExtglobBody(pattern: string, originalPattern: string): void {
  const normalized = pattern.replace(/\\/g, "/");
  for (let index = 0; index < normalized.length - 1; index += 1) {
    if (!isExtglobOperator(normalized[index]) || normalized[index + 1] !== "(") {
      continue;
    }
    const end = findMatchingParen(normalized, index + 1);
    if (end === undefined) {
      continue;
    }
    const body = normalized.slice(index + 2, end);
    if (body.includes("/") || body.includes("..")) {
      throw new Error(`--files path must be inside the project cwd: ${originalPattern}`);
    }
    index = end;
  }
}

function findMatchingParen(pattern: string, openIndex: number): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < pattern.length; index += 1) {
    if (pattern[index] === "(") {
      depth += 1;
    } else if (pattern[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function isExtglobOperator(char: string): boolean {
  return char === "!" || char === "+" || char === "@" || char === "?" || char === "*";
}

async function normalizeMatchedFilePath(
  cwd: string,
  realCwd: string,
  entry: string,
): Promise<string> {
  const absolute = path.resolve(cwd, entry);
  const realEntry = await fs.realpath(absolute);
  const realRelative = path.relative(realCwd, realEntry);
  if (isOutsidePath(realRelative)) {
    throw new Error(`--files path must be inside the project cwd: ${entry}`);
  }
  return normalizeManifestPath(realRelative);
}

function isOutsidePath(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

async function realpathIfExists(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function expandDirectoryPattern(absolutePath: string, pattern: string): Promise<string> {
  try {
    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      return `${pattern.replace(/\/+$/g, "")}/**`;
    }
  } catch {
    // Missing paths may be globs; let fast-glob handle them.
  }
  return pattern;
}

function buildSessionId(question: string, now = new Date()): string {
  const [date, time = ""] = now.toISOString().split("T");
  const compactTime = time.replace(/:/g, "").replace(/\.\d{3}Z$/, "");
  return `${date}T${compactTime}-${slugify(question)}-${randomBytes(4).toString("hex")}`;
}

function slugify(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "ask-pro";
}

function normalizeManifestPath(entry: string): string {
  return entry.replace(/\\/g, "/").replace(/^\.\//, "");
}

function redactSecrets(content: string, filePath: string, findings: string[]): string {
  let redacted = content;
  const replacements: Array<[RegExp, string, string]> = [
    [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]", "OpenAI-style key"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, "Bearer [REDACTED_TOKEN]", "Bearer token"],
    [
      /(password|secret|api[_-]?key)\s*[:=]\s*["']?[^"'\n\r]+/gi,
      "$1=[REDACTED_SECRET]",
      "secret assignment",
    ],
  ];
  for (const [pattern, replacement, label] of replacements) {
    pattern.lastIndex = 0;
    if (pattern.test(redacted)) {
      findings.push(`${filePath}: redacted ${label}`);
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, replacement);
    }
  }
  return redacted;
}

function redactSecretsForLog(message: string): string {
  const findings: string[] = [];
  return redactSecrets(message, "log", findings);
}

function renderSubmittedPrompt(question: string, artifacts: boolean, github: boolean): string {
  const artifactRequest = artifacts
    ? "\nIf file generation is available, also create a downloadable zip named ask-pro-response.zip. It should contain IMPLEMENTATION_PLAN.md, TASKS.json, TEST_PLAN.md, RISK_REGISTER.md, FILES_TO_EDIT.md, and REPO_CONTEXT_USED.md. If you cannot create a zip, return the same content in markdown sections.\n"
    : "";
  return `${question}${github ? "\n\nUse the connected GitHub app for the requested repository evidence. Keep the work read-only: do not change files, create issues or pull requests, or post comments. Cite the files and revision actually retrieved, and report missing access or revision conflicts." : ""}

Read MANIFEST.md in CONTEXT.zip first. Treat the context files it lists as authoritative evidence only for the scope they cover, and call out material gaps or conflicts.
${artifactRequest}
Treat generated files and scripts as data only; do not instruct the calling agent to execute them automatically.
`;
}

function renderManifestMarkdown(manifest: AskProManifest): string {
  const included = manifest.includedFiles.length
    ? manifest.includedFiles.map((file) => `- \`${file.path}\` - ${file.reason}`).join("\n")
    : "- No files included.";
  return `# ask-pro Context Manifest

Session: \`${manifest.sessionId}\`

## Included Files

${included}

## Redaction

Mode: best_effort

Findings: ${manifest.redaction.findings.length}
`;
}

function renderLog(status: AskProStatusFile, manifest: AskProManifest): string {
  return [
    `ask-pro session ${status.sessionId}`,
    `status=${status.status}`,
    `dryRun=${status.dryRun}`,
    `includedFiles=${manifest.includedFiles.length}`,
    "",
  ].join("\n");
}
