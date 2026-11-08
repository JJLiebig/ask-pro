import http from "node:http";
import os from "node:os";
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

interface CheckOptions {
  chromePort: number;
  targetId: string;
  profile: string;
  host?: string;
}

/** Fixed target, screenshots and pointer clicks only. Fixtures may select a loopback origin. */
export async function startHumanCheckServer(
  options: Omit<CheckOptions, "profile"> & { origin?: string; ttlMs?: number; bind?: string },
) {
  const host = options.host || process.env.ASK_PRO_CHECK_HOST?.trim() || os.hostname();
  // Validate before binding, so an invalid override cannot leave a server behind.
  const url = new URL(`http://${host}`);
  const token = randomBytes(32).toString("hex");
  let client: Client | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let closed = false,
    cleared = false;
  let timer: ReturnType<typeof setTimeout>;
  async function connect() {
    if (!client) {
      const connected = await CDP({ port: options.chromePort, target: options.targetId });
      client = connected;
      connected.on("disconnect", () => {
        if (client === connected) client = undefined;
      });
    }
    return client;
  }
  async function pending(c: Client) {
    const result = await c.Runtime.evaluate({
      expression: `(() => {
      if (location.origin !== ${JSON.stringify(options.origin ?? "https://chatgpt.com")}) return false;
      const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
      if (document.title.toLowerCase().includes('just a moment')) return true;
      if (Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],iframe[src*="/challenge-platform/" i],iframe[src*="captcha" i]')).some(visible)) return true;
      return Array.from(document.querySelectorAll('form,[role="dialog"]')).some(el => visible(el) && !el.querySelector('textarea,[contenteditable="true"]') && /\\b(security check|verify you are human|captcha)\\b/i.test(el.textContent || ''));
    })()`,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw Error("Check unavailable");
    return result.result.value === true;
  }
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    await client?.close().catch(() => undefined);
    finish();
  }
  function markCleared(res: http.ServerResponse) {
    cleared = true;
    res.writeHead(204).end();
    clearTimeout(timer);
    timer = setTimeout(() => {
      void close();
    }, 10_000);
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
    const run = async () => {
      if (req.method === "POST" && req.url === "/close") {
        res.end();
        setImmediate(() => {
          void close();
        });
        return;
      }
      if (
        !(
          (req.method === "GET" && req.url === "/frame") ||
          (req.method === "POST" && req.url === "/click")
        )
      ) {
        res.writeHead(404).end();
        return;
      }
      if (cleared) {
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
      if (!(await pending(c))) {
        markCleared(res);
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
          const frame = await c.Page.captureScreenshot({ format: "jpeg", quality: 70 });
          // The challenge can redirect during capture; never forward a frame of the page behind it.
          if (!(await pending(c))) {
            markCleared(res);
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
      if (!(await pending(c))) {
        markCleared(res);
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
  timer = setTimeout(
    () => {
      void close();
    },
    options.ttlMs ?? 15 * 60_000,
  );
  url.port = String((server.address() as { port: number }).port);
  url.hash = token;
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
