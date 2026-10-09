import { BrowserAutomationError } from "../errors.js";
import type { BrowserLogger, ChromeClient } from "../types.js";
import { delay } from "../utils.js";

const GITHUB_PLUGIN_ID = "plugin_connector_1p_1a69035c238881919c4190932b2df699";
const GITHUB_APP_ID = "connector_76869538009648d5b282a4bb21c3d157";
export const GITHUB_SETUP_URL = `https://chatgpt.com/plugins/${GITHUB_PLUGIN_ID}`;
const GITHUB_SETTINGS_URL = `https://chatgpt.com/settings/plugins-settings/${GITHUB_PLUGIN_ID}/apps/${GITHUB_APP_ID}`;

export class GitHubConnectionRequiredError extends BrowserAutomationError {
  constructor(readonly reason: "github_connection_required" | "github_connection_unverified") {
    super("Connect GitHub in the opened ChatGPT page, review repository access, then resume.", {
      stage: "github-connection-required",
    });
  }
}

// Read only visible connection controls, never account identifiers or OAuth state.
function readGitHubConnectionState(
  accountSectionId: string,
): "connected" | "disconnected" | "unknown" {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    );
  };
  const heading = Array.from(document.querySelectorAll("h1")).some(
    (element) => visible(element) && element.textContent?.trim() === "GitHub",
  );
  if (!heading) return "unknown";
  const section = document.getElementById(accountSectionId);
  if (!section || !visible(section)) return "unknown";
  const buttons = Array.from(section.querySelectorAll("button")).filter(visible);
  if (buttons.some((button) => /^reconnect\b/i.test(button.textContent?.trim() ?? ""))) {
    return "disconnected";
  }
  if (buttons.some((button) => button.getAttribute("aria-label")?.startsWith("Actions for "))) {
    return "connected";
  }
  return buttons.some((button) => /^connect\b/i.test(button.textContent?.trim() ?? ""))
    ? "disconnected"
    : "unknown";
}

export async function ensureGitHubConnection(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  timeoutMs: number,
): Promise<void> {
  const { result: location } = await Runtime.evaluate({
    expression: "location.href",
    returnByValue: true,
  });
  const returnUrl = location.value as string;
  await Page.navigate({ url: GITHUB_SETTINGS_URL });
  const deadline = Date.now() + timeoutMs;
  let state: "connected" | "disconnected" | "unknown" = "unknown";
  do {
    const result = await Runtime.evaluate({
      expression: `(${readGitHubConnectionState.toString()})(${JSON.stringify(`plugin-connected-accounts-${GITHUB_APP_ID}`)})`,
      returnByValue: true,
    }).catch(() => undefined);
    state = result?.result.value ?? "unknown";
    if (state !== "unknown") break;
    if (Date.now() < deadline) await delay(300);
  } while (Date.now() < deadline);

  if (state !== "connected") {
    // Stop on ChatGPT before the human starts OAuth; do not observe consent or callback URLs.
    await Page.navigate({ url: GITHUB_SETUP_URL });
    throw new GitHubConnectionRequiredError(
      state === "disconnected" ? "github_connection_required" : "github_connection_unverified",
    );
  }
  logger("GitHub connected. Repository access depends on the selected repositories.");
  await Page.navigate({ url: returnUrl });
}
