import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const RESOLVED_AGENT_ID_PATTERN = /^[a-z0-9._-]+-[a-f0-9]{10}$/;

export function defaultAskProBrowserProfileDir(): string {
  return askProBrowserProfileDirForAgentId(null);
}

export function askProBrowserProfileDirForAgentId(
  agentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return askProBrowserProfileDirUnder(askProStateDir(env), agentId);
}

export function askProBrowserProfileDirUnder(
  root: string,
  agentId: string | null | undefined,
): string {
  if (!agentId) return path.join(root, "browser-profile");
  if (!isResolvedAskProAgentId(agentId)) {
    throw new Error("Stored ask-pro agent id is invalid.");
  }
  return path.join(root, "agents", agentId, "browser-profile");
}

export function isAskProManagedBrowserProfileDir(profileDir: string): boolean {
  const resolved = normalizeProfilePath(profileDir);
  const defaultProfile = normalizeProfilePath(askProBrowserProfileDirForAgentId(null));
  if (resolved === defaultProfile) return true;

  return askProAgentIdForManagedBrowserProfileDir(profileDir) !== null;
}

export function isAskProStatePath(profileDir: string): boolean {
  const resolved = normalizeProfilePath(profileDir);
  const stateRoot = normalizeProfilePath(askProStateDir());
  const relative = path.relative(stateRoot, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function askProAgentIdForManagedBrowserProfileDir(profileDir: string): string | null {
  return agentIdForProfileDir(profileDir, askProStateDir());
}

function agentIdForProfileDir(profileDir: string, stateRoot: string): string | null {
  const resolved = normalizeProfilePath(profileDir);
  const agentsRoot = normalizeProfilePath(path.join(stateRoot, "agents"));
  const relative = path.relative(agentsRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[1] !== "browser-profile") return null;
  const agentId = parts[0]!;
  return isResolvedAskProAgentId(agentId) ? agentId : null;
}

export function isResolvedAskProAgentId(agentId: string): boolean {
  return RESOLVED_AGENT_ID_PATTERN.test(agentId);
}

export function askProStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ASK_PRO_STATE_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".agents", "state", "ask-pro");
}

// State folders of earlier versions, in the order profiles are migrated from them.
export function legacyAskProStateDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const codexHome = env.CODEX_HOME?.trim();
  const current = normalizeProfilePath(askProStateDir(env));
  return [
    path.join(
      codexHome ? path.resolve(codexHome) : path.join(os.homedir(), ".codex"),
      "state",
      "ask-pro",
    ),
    path.join(os.homedir(), ".agents", "skills", "ask-pro"),
  ].filter((dir) => normalizeProfilePath(dir) !== current);
}

export function askProAgentIdForLegacyBrowserProfileDir(profileDir: string): string | null {
  for (const root of legacyAskProStateDirs()) {
    const agentId = agentIdForProfileDir(profileDir, root);
    if (agentId) return agentId;
  }
  return null;
}

export function isLegacyAskProManagedBrowserProfileDir(profileDir: string): boolean {
  const resolved = normalizeProfilePath(profileDir);
  return (
    legacyAskProStateDirs().some(
      (root) => normalizeProfilePath(askProBrowserProfileDirUnder(root, null)) === resolved,
    ) || askProAgentIdForLegacyBrowserProfileDir(profileDir) !== null
  );
}

export function resolveAskProAgentId(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.ASK_PRO_AGENT_ID;
  if (value === undefined) return null;
  const raw = value.trim();
  if (raw !== value) {
    throw new Error("ASK_PRO_AGENT_ID must not start or end with whitespace.");
  }
  if (!raw) {
    throw new Error("ASK_PRO_AGENT_ID must not be empty.");
  }
  if (!/^[a-z0-9._-]+$/.test(raw)) {
    throw new Error("ASK_PRO_AGENT_ID must use only lowercase letters, numbers, '.', '_', or '-'.");
  }
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 10);
  const prefix = raw.slice(0, 53).replace(/^[-_.]+|[-_.]+$/g, "") || "agent";
  return `${prefix}-${hash}`;
}

function normalizeProfilePath(profileDir: string): string {
  const resolved = path.resolve(profileDir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
