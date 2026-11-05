// Opt-in real Chrome qualification using ONLY local fixtures and a disposable profile.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import CDP from "chrome-remote-interface";
import { startLoginServer } from "../dist/src/ask-pro/remoteLogin.js";
import { resolveBrowserConfig } from "../dist/src/browser/config.js";
import {
  launchChrome,
  maybeReuseRunningChrome,
  closeChromeGracefully,
} from "../dist/src/browser/chromeLifecycle.js";
import {
  writeChromePid,
  writeDevToolsActivePort,
  acquireProfileRunLock,
  createManagedChromeRunLease,
  releaseManagedChromeRunLeaseAndCountPeers,
  cleanupStaleProfileState,
} from "../dist/src/browser/profileState.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-linux-smoke-"));
process.env.ASK_PRO_STATE_DIR = root;
const profile = path.join(root, "browser-profile");
const fixture = http.createServer((_req, res) =>
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><form onsubmit="event.preventDefault();document.querySelector(\'h1\').textContent=\'Submitted\';window.submittedValue=document.querySelector(\'input\').value"><h1>Local sign-in fixture</h1><input aria-label="Fixture input"><button>Continue</button></form><div style="height:1800px"></div>',
  ),
);
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
let chrome, relay, client, viewer;
const evidence = process.env.ASK_PRO_SMOKE_EVIDENCE;
try {
  chrome = await launchChrome(resolveBrowserConfig({ manualLogin: true }), profile, () => {});
  assert.ok(chrome.pid);
  await writeChromePid(profile, chrome.pid);
  await writeDevToolsActivePort(profile, chrome.port);
  assert.equal((await maybeReuseRunningChrome(profile, () => {})).pid, chrome.pid);
  const lock = await acquireProfileRunLock(profile, { timeoutMs: 1000 });
  assert.ok(lock);
  await assert.rejects(
    acquireProfileRunLock(profile, { timeoutMs: 30, pollMs: 5 }),
    /profile lock still held/,
  );
  await lock.release();
  const lease = await createManagedChromeRunLease(profile);
  assert.equal(await releaseManagedChromeRunLeaseAndCountPeers(profile, lease), 0);
  const target = await CDP.New({
    port: chrome.port,
    url: "http://127.0.0.1:" + fixture.address().port,
  });
  client = await CDP({ port: chrome.port, target: target.id });
  await client.Page.enable();
  await client.Runtime.evaluate({ expression: "document.readyState" });
  relay = await startLoginServer({ chromePort: chrome.port, host: "127.0.0.1" });
  const url = new URL(relay.url),
    headers = { Authorization: "Bearer " + url.hash.slice(1), "Content-Type": "application/json" };
  assert.equal((await fetch(url.origin + "/tabs")).status, 401);
  assert.equal(
    (await fetch(url.origin + "/tabs", { headers: { ...headers, Origin: "https://evil.example" } }))
      .status,
    403,
  );
  const post = async (body) => {
    const res = await fetch(url.origin + "/input", {
      method: "POST",
      headers,
      body: JSON.stringify({ target: target.id, ...body }),
    });
    assert.equal(res.status, 200);
  };
  const rect = (
    await client.Runtime.evaluate({
      expression:
        'JSON.stringify(document.querySelector("input").getBoundingClientRect().toJSON())',
      returnByValue: true,
    })
  ).result.value;
  const bounds = JSON.parse(rect);
  await post({ kind: "click", x: bounds.x + 10, y: bounds.y + 10 });
  await post({ kind: "text", text: "fixture-only" });
  assert.equal(
    (await client.Runtime.evaluate({ expression: 'document.querySelector("input").value' })).result
      .value,
    "fixture-only",
  );
  await post({ kind: "key", key: "Enter" });
  assert.equal(
    (await client.Runtime.evaluate({ expression: 'document.querySelector("h1").textContent' }))
      .result.value,
    "Submitted",
  );
  const frame = await fetch(url.origin + "/frame?target=" + target.id, { headers });
  assert.equal(frame.headers.get("content-type"), "image/jpeg");
  assert.ok((await frame.arrayBuffer()).byteLength > 1000);
  assert.equal(
    (
      await fetch(url.origin + "/input", {
        method: "POST",
        headers,
        body: JSON.stringify({ target: target.id, kind: "evaluate", expression: "1" }),
      })
    ).status,
    400,
  );
  // Drive the actual remote page at desktop and phone sizes, using dummy input.
  const ui = await CDP.New({ port: chrome.port, url: relay.url });
  viewer = await CDP({ port: chrome.port, target: ui.id });
  await viewer.Page.enable();
  await viewer.Runtime.evaluate({
    expression: `new Promise(resolve=>{const t=setInterval(()=>{if(document.querySelector('#tabs')?.options.length){clearInterval(t);resolve(true)}},50)})`,
    awaitPromise: true,
  });
  // Reload must preserve authorization and resume frames without a replacement link.
  await viewer.Page.reload();
  await viewer.Runtime.evaluate({
    expression: `new Promise(resolve=>{const t=setInterval(()=>{if(document.querySelector('#screen')?.naturalWidth){clearInterval(t);resolve(true)}},50)})`,
    awaitPromise: true,
  });
  assert.equal(
    (await viewer.Runtime.evaluate({ expression: "location.hash" })).result.value,
    url.hash,
  );
  await viewer.Runtime.evaluate({
    expression: `document.querySelector('#tabs').value=${JSON.stringify(target.id)}`,
  });
  for (const [width, height, mobile] of [
    [1280, 900, false],
    [390, 844, true],
  ]) {
    await viewer.Emulation.setDeviceMetricsOverride({
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
    await viewer.Runtime.evaluate({
      expression: `inputQueue.then(()=>frame()).then(()=>document.querySelector('#screen').decode())`,
      awaitPromise: true,
    });
    assert.equal(
      (
        await viewer.Runtime.evaluate({
          expression: "document.documentElement.scrollWidth<=innerWidth",
        })
      ).result.value,
      true,
    );
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true });
      const shot = await viewer.Page.captureScreenshot();
      await fs.writeFile(
        path.join(evidence, "login-" + width + ".png"),
        Buffer.from(shot.data, "base64"),
      );
    }
  }
  await client.Runtime.evaluate({ expression: 'document.querySelector("input").focus()' });
  await viewer.Runtime.evaluate({
    expression:
      'document.querySelector("#text").value="-phone";document.querySelector("form").requestSubmit();document.querySelector("#enter").click()',
  });
  await viewer.Runtime.evaluate({
    expression: "new Promise(r=>setTimeout(r,200))",
    awaitPromise: true,
  });
  assert.equal(
    (await client.Runtime.evaluate({ expression: 'document.querySelector("input").value' })).result
      .value,
    "fixture-only-phone",
  );
  assert.equal(
    (await client.Runtime.evaluate({ expression: "window.submittedValue" })).result.value,
    "fixture-only-phone",
  );
  await viewer.Runtime.evaluate({ expression: 'document.querySelector("#down").click()' });
  await viewer.Runtime.evaluate({
    expression: "new Promise(r=>setTimeout(r,200))",
    awaitPromise: true,
  });
  assert.ok((await client.Runtime.evaluate({ expression: "scrollY" })).result.value > 0);
  // Replacement tab discovery is how auth redirects/popups are recovered.
  const replacement = await CDP.New({
    port: chrome.port,
    url: "http://127.0.0.1:" + fixture.address().port + "/callback",
  });
  await CDP.Close({ port: chrome.port, id: target.id });
  assert.ok(
    (await (await fetch(url.origin + "/tabs", { headers })).json()).some(
      (t) => t.id === replacement.id,
    ),
  );
  assert.equal(
    (await fetch(url.origin + "/frame?target=" + replacement.id, { headers })).status,
    200,
  );
  await fetch(url.origin + "/done", { method: "POST", headers, body: "{}" });
  await relay.done;
  await assert.rejects(fetch(url.origin + "/tabs", { headers }));
  await viewer.close();
  viewer = undefined;
  await client.close();
  client = undefined;
  await closeChromeGracefully(chrome);
  chrome = undefined;
  assert.equal(await maybeReuseRunningChrome(profile, () => {}), null);
  await cleanupStaleProfileState(profile, () => {});
  // Restart the same disposable profile; only idle caches are removed.
  await fs.mkdir(path.join(profile, "Default", "Cache"), { recursive: true });
  await fs.writeFile(path.join(profile, "Default", "Cache", "smoke"), "cache");
  await fs.writeFile(path.join(profile, "Default", "smoke-retained"), "profile-data");
  chrome = await launchChrome(resolveBrowserConfig({ manualLogin: true }), profile, () => {});
  assert.equal(
    await fs.readFile(path.join(profile, "Default", "smoke-retained"), "utf8"),
    "profile-data",
  );
  await assert.rejects(fs.stat(path.join(profile, "Default", "Cache", "smoke")));
  console.log(
    "linux_login_smoke\n  state: passed\n  fixtures_only: true\n  desktop_and_phone: passed\n  lifecycle_and_recovery: passed",
  );
} finally {
  await relay?.close();
  await viewer?.close().catch(() => {});
  await client?.close().catch(() => {});
  if (chrome) await closeChromeGracefully(chrome);
  fixture.close();
  fixture.closeAllConnections();
  await fs.rm(root, { recursive: true, force: true });
}
