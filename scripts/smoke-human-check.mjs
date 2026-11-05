// Real browser proof against a fake local checkbox only; no ChatGPT query or profile.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import { startHumanCheckServer } from "../dist/src/ask-pro/humanCheck.js";
import { launchChrome, closeChromeGracefully } from "../dist/src/browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../dist/src/browser/config.js";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-check-smoke-"));
process.env.ASK_PRO_STATE_DIR = root;
const fixture = http.createServer((_req, res) =>
  res.end(
    '<!doctype html><title>Just a moment...</title><label style="display:block;margin:40px;font:24px sans-serif"><input type="checkbox" onchange="document.title=\'Check cleared\';document.body.textContent=\'Verified\'"> Verify you are human</label>',
  ),
);
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + fixture.address().port;
let chrome, relay, page, viewer;
const wait = async (fn) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Fixture timed out");
};
try {
  chrome = await launchChrome(
    resolveBrowserConfig({ manualLogin: true }),
    path.join(root, "browser-profile"),
    () => {},
  );
  const target = await CDP.New({ port: chrome.port, url: origin });
  page = await CDP({ port: chrome.port, target: target.id });
  await wait(
    async () =>
      (await page.Runtime.evaluate({ expression: "document.readyState" })).result.value ===
      "complete",
  );
  relay = await startHumanCheckServer({
    chromePort: chrome.port,
    targetId: target.id,
    origin,
    host: "127.0.0.1",
    bind: "127.0.0.1",
  });
  const url = new URL(relay.url),
    headers = { Authorization: "Bearer " + url.hash.slice(1), "Content-Type": "application/json" };
  assert.equal((await fetch(url.origin + "/frame")).status, 401);
  assert.equal(
    (
      await fetch(url.origin + "/frame", {
        headers: { ...headers, Origin: "https://elsewhere.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url.origin + "/input", {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "not-forwarded" }),
      })
    ).status,
    404,
  );
  const viewerTarget = await CDP.New({ port: chrome.port, url: relay.url });
  viewer = await CDP({ port: chrome.port, target: viewerTarget.id });
  await wait(
    async () =>
      (
        await viewer.Runtime.evaluate({
          expression: 'document.querySelector("#screen")?.naturalWidth>0',
        })
      ).result.value,
  );
  await viewer.Page.reload();
  await wait(
    async () =>
      (
        await viewer.Runtime.evaluate({
          expression: 'document.querySelector("#screen")?.naturalWidth>0',
        })
      ).result.value,
  );
  assert.equal(
    (await viewer.Runtime.evaluate({ expression: "location.hash" })).result.value,
    url.hash,
  );
  const point = (
    await page.Runtime.evaluate({
      expression:
        '(()=>{const r=document.querySelector("input").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()',
      returnByValue: true,
    })
  ).result.value;
  // Click the viewer image, exercising its coordinate mapping and request, against the fake checkbox.
  await viewer.Runtime.evaluate({
    expression: `(()=>{const img=document.querySelector('#screen'),r=img.getBoundingClientRect();img.dispatchEvent(new MouseEvent('click',{clientX:r.x+${point.x}*r.width/img.naturalWidth,clientY:r.y+${point.y}*r.height/img.naturalHeight}));})()`,
  });
  await wait(
    async () =>
      (
        await viewer.Runtime.evaluate({
          expression: 'document.querySelector("#status").textContent.includes("Check cleared")',
        })
      ).result.value,
  );
  assert.equal(
    (await page.Runtime.evaluate({ expression: "document.title" })).result.value,
    "Check cleared",
  );
  assert.equal((await fetch(url.origin + "/frame", { headers })).status, 204);
  await relay.close();
  await relay.done;
  relay = undefined;
  // A new viewer must not expose a non-challenge page or allow clicking it.
  relay = await startHumanCheckServer({
    chromePort: chrome.port,
    targetId: target.id,
    origin,
    host: "127.0.0.1",
    bind: "127.0.0.1",
    ttlMs: 100,
  });
  const second = new URL(relay.url);
  assert.equal(
    (
      await fetch(second.origin + "/click", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + second.hash.slice(1),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(point),
      })
    ).status,
    204,
  );
  await relay.close();
  relay = undefined;
  // The independent viewer must survive the CLI controller exiting after handoff.
  await page.Page.reload();
  await wait(
    async () =>
      (await page.Runtime.evaluate({ expression: "document.title" })).result.value ===
      "Just a moment...",
  );
  const moduleUrl = new URL("../dist/src/ask-pro/humanCheck.js", import.meta.url).href;
  const options = {
    chromePort: chrome.port,
    targetId: target.id,
    profile: path.join(root, "browser-profile"),
    origin,
    host: "127.0.0.1",
    bind: "127.0.0.1",
  };
  const child = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {launchHumanCheck} from ${JSON.stringify(moduleUrl)}; console.log(await launchHumanCheck(${JSON.stringify(options)}));`,
    ],
    { timeout: 15000 },
  );
  const detachedUrl = new URL(child.stdout.trim()),
    detachedHeaders = { Authorization: "Bearer " + detachedUrl.hash.slice(1) };
  try {
    assert.equal(
      (await fetch(detachedUrl.origin + "/frame", { headers: detachedHeaders })).status,
      200,
    );
  } finally {
    await fetch(detachedUrl.origin + "/close", { method: "POST", headers: detachedHeaders });
  }
  console.log(
    "smoke: passed\nchecks: access_control, no_keyboard, fragment_reload, viewer_click, automatic_clear, no_post_check_frames, detached_handoff",
  );
} finally {
  await relay?.close();
  await viewer?.close().catch(() => {});
  await page?.close().catch(() => {});
  if (chrome) await closeChromeGracefully(chrome);
  await new Promise((resolve) => fixture.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
