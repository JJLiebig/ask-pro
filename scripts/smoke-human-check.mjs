// Real browser proof against a fake local checkbox only; no ChatGPT query or profile.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import { startHumanCheckServer, waitForHumanCheck } from "../dist/src/ask-pro/humanCheck.js";
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
const frameReady = 'document.querySelector("#screen:not([hidden])")?.naturalWidth > 0';
async function openPage(port, url) {
  const target = await CDP.New({ port, url: "about:blank" });
  const client = await CDP({ port, target: target.id });
  await client.Page.enable();
  const loaded = client.Page.loadEventFired();
  await client.Page.navigate({ url });
  await loaded;
  return { target, client };
}
async function waitForDocument(client, expression) {
  const result = await client.Runtime.evaluate({
    expression: `new Promise(resolve => {
      const observer = new MutationObserver(check);
      function check() {
        if (!(${expression})) return;
        observer.disconnect();
        document.removeEventListener('load', check, true);
        resolve(true);
      }
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      document.addEventListener('load', check, true);
      check();
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(result.result.value, true);
}
async function reload(client) {
  const loaded = client.Page.loadEventFired();
  await client.Page.reload();
  await loaded;
}
try {
  chrome = await launchChrome(
    resolveBrowserConfig({ manualLogin: true }),
    path.join(root, "browser-profile"),
    () => {},
  );
  const { target, client } = await openPage(chrome.port, origin);
  page = client;
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
  viewer = (await openPage(chrome.port, relay.url)).client;
  await waitForDocument(viewer, frameReady);
  await reload(viewer);
  await waitForDocument(viewer, frameReady);
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
  const resumed = waitForHumanCheck(url);
  // Click the viewer image, exercising its coordinate mapping and request, against the fake checkbox.
  await viewer.Runtime.evaluate({
    expression: `(()=>{const img=document.querySelector('#screen'),r=img.getBoundingClientRect();img.dispatchEvent(new MouseEvent('click',{clientX:r.x+${point.x}*r.width/img.naturalWidth,clientY:r.y+${point.y}*r.height/img.naturalHeight}));})()`,
  });
  assert.equal(await resumed, true);
  await waitForDocument(viewer, '!document.querySelector("#screen")');
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
  });
  const second = new URL(relay.url);
  const clickBehindCheck = await fetch(second.origin + "/click", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + second.hash.slice(1),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...point, revision: 0 }),
  });
  assert.ok(clickBehindCheck.status === 202 || clickBehindCheck.status === 204);
  await relay.close();
  relay = undefined;
  // The independent viewer must survive the CLI controller exiting after handoff.
  await reload(page);
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
    "smoke: passed\nchecks: access_control, no_keyboard, fragment_reload, viewer_click, automatic_resume_signal, no_post_check_frames, detached_handoff",
  );
} finally {
  await relay?.close();
  await viewer?.close().catch(() => {});
  await page?.close().catch(() => {});
  if (chrome) await closeChromeGracefully(chrome);
  await new Promise((resolve) => fixture.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
