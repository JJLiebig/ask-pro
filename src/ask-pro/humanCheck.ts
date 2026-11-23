import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import CDP from "chrome-remote-interface";
import type { Client } from "chrome-remote-interface";
import {
  acquireProfileRunLock,
  createManagedChromeRunLease,
  releaseManagedChromeRunLeaseAndCountPeers,
} from "../browser/profileState.js";
import { humanCheckPage } from "./humanCheckPage.js";

export interface HumanCheckTarget {
  chromePort: number;
  targetId: string;
}

interface CheckOptions extends HumanCheckTarget {
  profile: string;
  host?: string;
}

const CHECK_TTL_MS = 24 * 60 * 60_000;
const SETTLE_MS = 2_000;
const CHATGPT_ORIGIN = "https://chatgpt.com";
const MONITOR_WORLD = "ask-pro-human-check";
const MONITOR_BINDING = "reportAskProHumanCheck";
type CheckState = "challenge" | "loading" | "clear";

function checkStateExpression(origin: string) {
  return `(() => {
    if (location.origin === ${JSON.stringify(origin)}) {
      const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
      if (document.title.toLowerCase().includes('just a moment')) return 'challenge';
      if (Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],iframe[src*="/challenge-platform/" i],iframe[src*="captcha" i]')).some(visible)) return 'challenge';
      if (Array.from(document.querySelectorAll('form,[role="dialog"]')).some(el => visible(el) && !el.querySelector('textarea,[contenteditable="true"]') && /\\b(security check|verify you are human|captcha)\\b/i.test(el.textContent || ''))) return 'challenge';
    }
    return document.readyState === 'loading' || location.href === 'about:blank' ? 'loading' : 'clear';
  })()`;
}

async function readCheckState(client: Client, expression: string): Promise<CheckState> {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
  });
  const value: unknown = result.value;
  if (exceptionDetails || (value !== "challenge" && value !== "loading" && value !== "clear"))
    throw Error("Check unavailable");
  return value;
}

function connectToCheckTarget({ chromePort, targetId }: HumanCheckTarget) {
  return CDP({ port: chromePort, target: targetId });
}

/** Fixed target, screenshots and pointer clicks only. Fixtures may select a loopback origin. */
export async function startHumanCheckServer(
  options: Omit<CheckOptions, "profile"> & { origin?: string; ttlMs?: number; bind?: string },
) {
  const host = options.host || process.env.ASK_PRO_CHECK_HOST?.trim() || os.hostname();
  // Validate before binding, so an invalid override cannot leave a server behind.
  const url = new URL(`http://${host}`);
  const token = randomBytes(32).toString("hex");
  const expression = checkStateExpression(options.origin ?? CHATGPT_ORIGIN);
  const waiters = new Set<http.ServerResponse>();
  let monitor: Client | undefined;
  let client: Client | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let state: "watching" | "cleared" | "closed" = "watching";
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let navigating = false;
  let revision = 0;
  async function connect() {
    if (!client) {
      const connected = await connectToCheckTarget(options);
      if (state !== "watching") {
        await connected.close();
        throw Error("Check unavailable");
      }
      client = connected;
      connected.on("disconnect", () => {
        if (client === connected) client = undefined;
      });
    }
    return client;
  }
  function cancelSettlement() {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  }
  async function close() {
    if (state === "closed") return done;
    state = "closed";
    cancelSettlement();
    clearTimeout(timer);
    clearTimeout(confirmationTimer);
    server.close();
    server.closeAllConnections();
    await Promise.all([monitor, client].map((connection) => connection?.close().catch(() => {})));
    finish();
  }

  function observe(next: string) {
    if (state !== "watching") return;
    revision += 1;
    if (next !== "clear" || navigating) {
      cancelSettlement();
      return;
    }
    if (settleTimer) return;
    const candidate = setTimeout(async () => {
      const final = await readCheckState(monitor!, expression).catch(() => "loading");
      if (settleTimer !== candidate) return;
      settleTimer = undefined;
      if (final !== "clear") return;
      state = "cleared";
      for (const waiter of waiters) waiter.end("cleared");
      // Briefly serve the terminal result so the viewer can display confirmation.
      confirmationTimer = setTimeout(() => void close(), 10_000);
    }, SETTLE_MS);
    settleTimer = candidate;
  }

  async function watchTab() {
    const c = await connectToCheckTarget(options);
    monitor = c;
    c.on("disconnect", () => {
      if (state === "watching") void close();
    });
    await c.Page.enable();
    await c.Runtime.enable();
    let {
      frameTree: {
        frame: { id: mainFrame },
      },
    } = await c.Page.getFrameTree();
    c.Page.frameStartedLoading(({ frameId }) => {
      if (frameId !== mainFrame) return;
      navigating = true;
      observe("loading");
    });
    c.Page.frameNavigated(({ frame }) => {
      if (frame.parentId) return;
      mainFrame = frame.id;
      navigating = true;
      observe("loading");
    });
    c.Page.frameStoppedLoading(({ frameId }) => {
      if (frameId !== mainFrame) return;
      navigating = false;
      const stoppedAt = revision;
      void readCheckState(c, expression)
        .then((next) => {
          if (revision === stoppedAt) observe(next);
        })
        .catch(() => {});
    });
    c.Runtime.bindingCalled(({ name, payload }) => {
      if (name === MONITOR_BINDING) observe(payload);
    });
    await c.Runtime.addBinding({ name: MONITOR_BINDING, executionContextName: MONITOR_WORLD });
    await c.Page.addScriptToEvaluateOnNewDocument({
      worldName: MONITOR_WORLD,
      runImmediately: true,
      source: `(() => {
        if (window !== window.top) return;
        let last;
        function observe() {
          const next = ${expression};
          if (next === last) return;
          last = next;
          ${MONITOR_BINDING}(next);
        }
        new MutationObserver(observe).observe(document, {
          subtree: true, childList: true, attributes: true, characterData: true,
        });
        document.addEventListener('DOMContentLoaded', observe);
        window.addEventListener('load', observe, true);
        window.addEventListener('resize', observe);
        observe();
      })()`,
    });
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'",
    );
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(humanCheckPage);
      return;
    }
    if (req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401).end();
      return;
    }
    if (req.headers.origin && req.headers.origin !== "http://" + req.headers.host) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url === "/wait") {
      res.setHeader("Content-Type", "text/plain");
      if (state === "cleared") {
        res.end("cleared");
      } else {
        waiters.add(res);
        res.once("close", () => waiters.delete(res));
        res.flushHeaders();
      }
      return;
    }
    if (req.method === "POST" && req.url === "/close") {
      res.end(() => void close());
      return;
    }
    const run = async () => {
      if (
        !(
          (req.method === "GET" && req.url === "/frame") ||
          (req.method === "POST" && req.url === "/click")
        )
      ) {
        res.writeHead(404).end();
        return;
      }
      if (state === "cleared") {
        res.writeHead(204).end();
        return;
      }
      let point: { x: number; y: number } | undefined;
      if (req.url === "/click") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 1024) {
            res.writeHead(413).end();
            return;
          }
        }
        point = JSON.parse(raw) as { x: number; y: number };
        if (
          ![point.x, point.y].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
        ) {
          res.writeHead(400).end();
          return;
        }
      }
      if (res.destroyed) return;
      const c = await connect();
      if (res.destroyed) return;
      // Check immediately before input, so a challenge that cleared meanwhile never receives a click.
      if (point) await c.Page.bringToFront();
      if ((await readCheckState(c, expression)) !== "challenge" || state !== "watching") {
        res.writeHead(202).end();
        return;
      }
      if (!point) {
        // A reloaded viewer cancels capture; disconnect so a stuck capture cannot block its successor.
        const cancel = () => {
          if (!res.writableEnded) {
            if (client === c) client = undefined;
            void c.close().catch(() => undefined);
          }
        };
        res.once("close", cancel);
        try {
          if (res.destroyed) {
            cancel();
            return;
          }
          const capturedAt = revision;
          const frame = await c.Page.captureScreenshot({ format: "jpeg", quality: 70 });
          // The challenge can redirect during capture; never forward a frame of the page behind it.
          if (
            (await readCheckState(c, expression)) !== "challenge" ||
            revision !== capturedAt ||
            state !== "watching"
          ) {
            res.writeHead(202).end();
            return;
          }
          res.setHeader("Content-Type", "image/jpeg");
          res.end(Buffer.from(frame.data, "base64"));
        } finally {
          res.removeListener("close", cancel);
        }
        return;
      }
      const { x, y } = point;
      await c.Input.dispatchMouseEvent({
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await c.Input.dispatchMouseEvent({
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      if ((await readCheckState(c, expression)) !== "challenge") {
        res.writeHead(202).end();
        return;
      }
      res.end();
    };
    queue = queue.then(run).catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, options.bind ?? "0.0.0.0", resolve);
  });
  url.port = String((server.address() as { port: number }).port);
  url.hash = token;
  timer = setTimeout(
    () => {
      void close();
    },
    Math.min(options.ttlMs ?? CHECK_TTL_MS, CHECK_TTL_MS),
  );
  try {
    await watchTab();
  } catch (error) {
    await close();
    throw error;
  }
  if (!server.listening) throw Error("Challenge browser is unavailable.");
  return { url: url.href, done, close };
}

/** Detached server survives the CLI handoff; the human alone supplies click events. */
export async function launchHumanCheck(options: CheckOptions): Promise<string> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--human-check", JSON.stringify(options)],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Human-check viewer did not start."));
      }, 10_000);
      const fail = () => {
        clearTimeout(timer);
        reject(Error("Human-check viewer could not start."));
      };
      child.once("error", fail);
      child.once("exit", fail);
      child.once("message", (message: { url?: string }) => {
        clearTimeout(timer);
        if (!message.url) {
          fail();
          return;
        }
        child.removeListener("error", fail);
        child.removeListener("exit", fail);
        child.disconnect();
        child.unref();
        resolve(message.url);
      });
    });
  } catch (error) {
    child.kill();
    throw error;
  }
}

export async function readHumanCheckUrl(dir: string): Promise<URL | undefined> {
  try {
    const { url } = JSON.parse(await fs.readFile(path.join(dir, "human-check.json"), "utf8"));
    const link = typeof url === "string" ? new URL(url) : undefined;
    if (link?.protocol === "http:" && link.port && /^#[a-f0-9]{64}$/.test(link.hash)) return link;
  } catch {
    // Sessions without a readable viewer link use the saved Chrome target directly.
  }
}

// Node's HTTP client can keep reading the authenticated response until the check clears.
// The short timeout only applies before the viewer acknowledges the request.
export function waitForHumanCheck(url: URL): Promise<boolean> {
  return requestViewer(url, "wait");
}

function requestViewer(url: URL, operation: "wait" | "close"): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: url.port,
        path: `/${operation}`,
        method: operation === "wait" ? "GET" : "POST",
        headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
        agent: false,
      },
      (res) => {
        res.once("error", () => resolve(false));
        res.once("close", () => resolve(false));
        if (operation === "close" || res.statusCode !== 200) {
          res.resume();
          return;
        }
        req.setTimeout(0);
        let result = "";
        res.setEncoding("utf8").on("data", (chunk: string) => {
          result += chunk;
          if (result.length > "cleared".length) res.destroy();
        });
        res.once("end", () => resolve(result === "cleared"));
      },
    );
    req.setTimeout(2_000, () => req.destroy());
    req.once("error", () => resolve(false));
    req.end();
  });
}

export async function saveHumanCheck(dir: string, options: CheckOptions): Promise<string> {
  const url = await launchHumanCheck(options);
  try {
    await fs.writeFile(path.join(dir, "human-check.json"), JSON.stringify({ url }), {
      mode: 0o600,
    });
    return url;
  } catch (error) {
    await requestViewer(new URL(url), "close");
    throw error;
  }
}

/** Only the session controller may consume or replace its viewer link. */
export async function resumeHumanCheck(dir: string, target?: HumanCheckTarget) {
  const url = await readHumanCheckUrl(dir);
  if (url) {
    const cleared = target && (await waitForHumanCheck(url));
    if (!cleared) await requestViewer(url, "close");
    await fs.rm(path.join(dir, "human-check.json"), { force: true });
    if (cleared) return "clear";
  }
  if (!target) return "unavailable";
  const client = await connectToCheckTarget(target).catch(() => undefined);
  if (!client) return "unavailable";
  try {
    return await readCheckState(client, checkStateExpression(CHATGPT_ORIGIN));
  } catch {
    return "unavailable";
  } finally {
    await client.close().catch(() => {});
  }
}

if (process.argv[2] === "--human-check") {
  const options = JSON.parse(process.argv[3]!) as CheckOptions;
  const lock = await acquireProfileRunLock(options.profile, { timeoutMs: 5000 });
  if (!lock) throw Error("Browser busy");
  const lease = await createManagedChromeRunLease(options.profile).finally(() => lock.release());
  let server: Awaited<ReturnType<typeof startHumanCheckServer>> | undefined;
  try {
    server = await startHumanCheckServer(options);
    const stop = () => {
      void server?.close();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    process.send?.({ url: server.url });
    await server.done;
  } finally {
    await server?.close();
    await releaseManagedChromeRunLeaseAndCountPeers(options.profile, lease);
    if (process.connected) process.disconnect();
  }
}
