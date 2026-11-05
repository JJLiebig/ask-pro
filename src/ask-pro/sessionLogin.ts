import CDP from "chrome-remote-interface";
import { isHeadlessLinux, resolveBrowserConfig } from "../browser/config.js";
import { prepareAskProBrowserProfile } from "../browser/profileMigration.js";
import { resolveAskProAgentId } from "../browser/profilePaths.js";
import {
  acquireProfileRunLock,
  createManagedChromeRunLease,
  releaseManagedChromeRunLeaseAndCountPeers,
  writeChromePid,
  writeDevToolsActivePort,
} from "../browser/profileState.js";
import {
  launchChrome,
  maybeReuseRunningChrome,
  releaseChromeProcessHandle,
  closeChromeGracefully,
  restoreChromeWindowByPid,
} from "../browser/chromeLifecycle.js";
import { navigateToChatGPT, ensureLoggedIn } from "../browser/actions/navigation.js";
import type { CookieParam } from "../browser/types.js";

const sessionName = /^__Secure-next-auth\.session-token(?:\.(0|[1-9]\d*))?$/;

/** Only session cookies cross this boundary; never accept a whole browser cookie jar. */
export function parseSessionCookies(input: string): CookieParam[] {
  const invalid = () =>
    new Error(
      "Expected a JSON array of session cookies with name, value and expires (Unix seconds or ISO date). See docs/linux.md.",
    );
  let rows: unknown;
  try {
    rows = JSON.parse(input);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(rows) || !rows.length) throw invalid();
  const cookies = rows.map((row: unknown) => {
    if (!row || typeof row !== "object") throw invalid();
    const { name, value, expires } = row as Record<string, unknown>;
    const expiry =
      typeof expires === "number"
        ? expires
        : typeof expires === "string"
          ? Date.parse(expires) / 1000
          : NaN;
    if (
      typeof name !== "string" ||
      !sessionName.test(name) ||
      typeof value !== "string" ||
      !value ||
      /[\s;\x00-\x1f\x7f]/.test(value) ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() / 1000
    )
      throw invalid();
    return {
      name,
      value,
      expires: expiry,
      url: "https://chatgpt.com/",
      domain: ".chatgpt.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax" as const,
    };
  });
  const names = new Set(cookies.map((c) => c.name));
  if (names.size !== cookies.length) throw invalid();
  if (names.has("__Secure-next-auth.session-token")) {
    if (cookies.length !== 1) throw invalid();
  } else {
    for (let i = 0; i < cookies.length; i++)
      if (!names.has(`__Secure-next-auth.session-token.${i}`)) throw invalid();
  }
  return cookies;
}

export async function replaceSessionCookies(
  Network: NonNullable<Awaited<ReturnType<typeof CDP>>["Network"]>,
  cookies: CookieParam[],
) {
  const existing = await Network.getCookies({ urls: ["https://chatgpt.com/"] });
  for (const cookie of existing.cookies) {
    if (sessionName.test(cookie.name))
      await Network.deleteCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
  }
  for (const cookie of cookies) {
    const result = await Network.setCookie(cookie);
    if (!result.success) throw Error("Session cookie could not be installed.");
  }
}

export async function runSessionLogin(
  cookies?: CookieParam[],
  savedProfile?: string,
): Promise<boolean> {
  if (!cookies && isHeadlessLinux())
    throw Error("On a machine without a display, use --import-session. See docs/linux.md.");
  const profile = savedProfile ?? (await prepareAskProBrowserProfile(resolveAskProAgentId()));
  const lock = await acquireProfileRunLock(profile, { timeoutMs: 1000 });
  if (!lock) throw Error("Browser busy. Wait for ask-pro runs to finish.");
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let client: Awaited<ReturnType<typeof CDP>> | undefined;
  try {
    const lease = await createManagedChromeRunLease(profile);
    const peers = await releaseManagedChromeRunLeaseAndCountPeers(profile, lease);
    if (peers !== 0) throw Error("Browser busy. Wait for ask-pro runs to finish.");
    chrome =
      (await maybeReuseRunningChrome(profile, () => {})) ??
      (await launchChrome(resolveBrowserConfig({ manualLogin: true }), profile, () => {}, {
        ignoreLockId: lock.lockId,
      }));
    releaseChromeProcessHandle(chrome);
    if (chrome.pid) await writeChromePid(profile, chrome.pid);
    await writeDevToolsActivePort(profile, chrome.port);
    const target = await CDP.New({ port: chrome.port, url: "about:blank" });
    client = await CDP({ port: chrome.port, target: target.id });
    if (cookies) {
      await replaceSessionCookies(client.Network, cookies);
    }
    await navigateToChatGPT(client.Page, client.Runtime, "https://chatgpt.com/", () => {});
    if (!cookies) {
      await restoreChromeWindowByPid(chrome.pid, () => {});
      return false;
    }
    try {
      await ensureLoggedIn(client.Runtime, () => {}, { passive: true });
      return true;
    } catch {
      return false;
    }
  } catch {
    throw Error(
      "Could not prepare the browser session. Check Chrome availability and wait for other ask-pro runs to finish; see docs/linux.md.",
    );
  } finally {
    await client?.close().catch(() => undefined);
    // Import always flushes persistent cookies to disk; desktop login stays visible.
    try {
      if (cookies && chrome) await closeChromeGracefully(chrome);
    } finally {
      await lock.release();
    }
  }
}
