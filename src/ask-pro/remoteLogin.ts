import http from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import CDP from "chrome-remote-interface";
import type { Client } from "chrome-remote-interface";
import { resolveBrowserConfig } from "../browser/config.js";
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
} from "../browser/chromeLifecycle.js";
import { loginPage } from "./loginPage.js";

const keys = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Escape",
  "Home",
  "End",
]);

/** Narrow human-operated relay: no cookies, DOM, evaluation, or arbitrary CDP endpoint. */
export async function startLoginServer(options: {
  chromePort: number;
  host: string;
  port?: number;
  ttlMs?: number;
}) {
  const token = randomBytes(32).toString("hex");
  let client: Client | undefined;
  let targetId: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const targets = async () =>
    (await CDP.List({ port: options.chromePort })).filter(
      (t) => t.type === "page" && /^(https?:|about:blank)/.test(t.url),
    );
  async function connect(id: string) {
    if (!(await targets()).some((t) => t.id === id)) throw Error("Unavailable tab");
    if (targetId !== id || !client) {
      await client?.close().catch(() => undefined);
      client = await CDP({ port: options.chromePort, target: id });
      targetId = id;
      client.on("disconnect", () => {
        if (targetId === id) {
          client = undefined;
          targetId = undefined;
        }
      });
    }
    return client;
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
      res.end(loginPage);
      return;
    }
    if (req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401).end();
      return;
    }
    // Reject cross-origin browser requests even when a caller has the link.
    if (req.headers.origin && req.headers.origin !== "http://" + req.headers.host) {
      res.writeHead(403).end();
      return;
    }
    const route = new URL(req.url ?? "/", "http://localhost");
    const run = async () => {
      if (req.method === "GET" && route.pathname === "/tabs") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            (await targets()).map((t) => ({
              id: t.id,
              name: t.url === "about:blank" ? "Blank tab" : new URL(t.url).hostname,
            })),
          ),
        );
        return;
      }
      if (req.method === "GET" && route.pathname === "/frame") {
        const c = await connect(route.searchParams.get("target") ?? "");
        // Reload cancels the image request. Release its pending CDP capture so
        // it cannot hold the shared request queue and freeze the new viewer.
        const cancel = () => {
          if (!res.writableEnded) void c.close().catch(() => undefined);
        };
        res.once("close", cancel);
        let frame;
        try {
          frame = await c.Page.captureScreenshot({ format: "jpeg", quality: 70 });
        } finally {
          res.removeListener("close", cancel);
        }
        res.setHeader("Content-Type", "image/jpeg");
        res.end(Buffer.from(frame.data, "base64"));
        return;
      }
      if (req.method !== "POST" || !["/input", "/done"].includes(route.pathname)) {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 16384) {
          res.writeHead(413).end();
          return;
        }
      }
      if (route.pathname === "/done") {
        res.end();
        setImmediate(() => {
          void close();
        });
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      const c = await connect(typeof body.target === "string" ? body.target : "");
      await c.Page.bringToFront();
      const coordinate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
      if (body.kind === "text" && typeof body.text === "string")
        await c.Input.insertText({ text: body.text });
      else if (body.kind === "key" && typeof body.key === "string" && keys.has(body.key)) {
        const key = body.key;
        const code = (
          {
            Enter: 13,
            Tab: 9,
            Backspace: 8,
            Delete: 46,
            Escape: 27,
            ArrowLeft: 37,
            ArrowUp: 38,
            ArrowRight: 39,
            ArrowDown: 40,
            Home: 36,
            End: 35,
          } as Record<string, number>
        )[key];
        await c.Input.dispatchKeyEvent({
          type: "keyDown",
          key,
          code: key,
          windowsVirtualKeyCode: code,
          ...(key === "Enter" ? { text: "\r" } : {}),
        });
        await c.Input.dispatchKeyEvent({
          type: "keyUp",
          key,
          code: key,
          windowsVirtualKeyCode: code,
        });
      } else if (
        (body.kind === "click" || body.kind === "scroll") &&
        coordinate(body.x) &&
        coordinate(body.y)
      ) {
        const x = body.x as number,
          y = body.y as number;
        if (body.kind === "click") {
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
        } else if (typeof body.deltaY === "number" && Number.isFinite(body.deltaY))
          await c.Input.dispatchMouseEvent({
            type: "mouseWheel",
            x,
            y,
            deltaX: 0,
            deltaY: body.deltaY,
          });
        else {
          res.writeHead(400).end();
          return;
        }
      } else {
        res.writeHead(400).end();
        return;
      }
      res.end();
    };
    queue = queue.then(run).catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    await client?.close().catch(() => undefined);
    finish();
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host, resolve);
  });
  const timer = setTimeout(
    () => {
      void close();
    },
    options.ttlMs ?? 15 * 60_000,
  );
  const address = server.address() as { port: number };
  const hostname = options.host === "0.0.0.0" ? os.hostname() : options.host;
  return { url: "http://" + hostname + ":" + address.port + "/#" + token, done, close };
}

export async function runRemoteLogin(onReady: (url: string) => void, savedProfile?: string) {
  const host = process.env.ASK_PRO_LOGIN_HOST?.trim();
  if (!host)
    throw Error(
      "Set ASK_PRO_LOGIN_HOST to this machine’s private network IP (for example its Tailscale IP), then run --login.",
    );
  const profile = savedProfile ?? (await prepareAskProBrowserProfile(resolveAskProAgentId()));
  const lock = await acquireProfileRunLock(profile, { timeoutMs: 1000 });
  if (!lock) throw Error("Browser busy. Wait for ask-pro runs to finish before --login.");
  const lease = await createManagedChromeRunLease(profile);
  let relay: Awaited<ReturnType<typeof startLoginServer>> | undefined;
  try {
    // Count live automation leases while holding the launch lock; login never races a query.
    const peers = await releaseManagedChromeRunLeaseAndCountPeers(profile, lease);
    if (peers !== 0) throw Error("Browser busy. Wait for ask-pro runs to finish before --login.");
    const chrome =
      (await maybeReuseRunningChrome(profile, () => {})) ??
      (await launchChrome(resolveBrowserConfig({ manualLogin: true }), profile, () => {}, {
        ignoreLockId: lock.lockId,
      }));
    releaseChromeProcessHandle(chrome);
    if (chrome.pid) await writeChromePid(profile, chrome.pid);
    await writeDevToolsActivePort(profile, chrome.port);
    const pages = await CDP.List({ port: chrome.port });
    if (
      !pages.some(
        (t) => t.type === "page" && /^https:\/\/(chatgpt\.com|auth\.openai\.com)(\/|$)/.test(t.url),
      )
    ) {
      await CDP.New({ port: chrome.port, url: "https://chatgpt.com/" });
    }
    relay = await startLoginServer({ chromePort: chrome.port, host });
    const stop = () => {
      void relay?.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      onReady(relay.url);
      await relay.done;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await relay?.close();
    await releaseManagedChromeRunLeaseAndCountPeers(profile, lease);
    await lock.release();
  }
}
