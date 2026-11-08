// Opt-in Chrome proof: fake credentials, disposable profile, no ChatGPT navigation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import { parseSessionCookies, replaceSessionCookies } from "../dist/src/ask-pro/sessionLogin.js";
import { resolveBrowserConfig } from "../dist/src/browser/config.js";
import { launchChrome, closeChromeGracefully } from "../dist/src/browser/chromeLifecycle.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-import-smoke-"));
process.env.ASK_PRO_STATE_DIR = root;
const profile = path.join(root, "browser-profile");
const base = "__Secure-next-auth.session-token";
let chrome, client;
const connect = async () => {
  chrome = await launchChrome(resolveBrowserConfig({ manualLogin: true }), profile, () => {});
  const target = await CDP.New({ port: chrome.port, url: "about:blank" });
  client = await CDP({ port: chrome.port, target: target.id });
};
const stop = async () => {
  await client?.close();
  client = undefined;
  if (chrome) await closeChromeGracefully(chrome);
  chrome = undefined;
};
try {
  await connect();
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const cookie = (name, value) => ({ name, value, expires });
  await replaceSessionCookies(
    client.Network,
    parseSessionCookies(JSON.stringify([cookie(base, "old-fake")])),
  );
  await client.Network.setCookie({
    name: "cf_clearance",
    value: "local-fake",
    url: "https://chatgpt.com/",
    expires,
  });
  const chunks = [cookie(base + ".0", "fake-first"), cookie(base + ".1", "fake-second")];
  await replaceSessionCookies(client.Network, parseSessionCookies(JSON.stringify(chunks)));
  await stop();
  await connect();
  let cookies = (await client.Network.getCookies({ urls: ["https://chatgpt.com/"] })).cookies;
  assert.equal(cookies.find((c) => c.name === "cf_clearance")?.value, "local-fake");
  assert.equal(
    cookies.some((c) => c.name === base),
    false,
  );
  for (const chunk of chunks) {
    const found = cookies.find((c) => c.name === chunk.name);
    assert.equal(found?.value, chunk.value);
    assert.equal(found?.expires, expires);
    assert.equal(found?.httpOnly, true);
    assert.equal(found?.secure, true);
  }
  await replaceSessionCookies(
    client.Network,
    parseSessionCookies(JSON.stringify([cookie(base, "new-fake")])),
  );
  cookies = (await client.Network.getCookies({ urls: ["https://chatgpt.com/"] })).cookies;
  assert.equal(
    cookies.some((c) => c.name.startsWith(base + ".")),
    false,
  );
  assert.equal(cookies.find((c) => c.name === base)?.value, "new-fake");
  console.log(
    "smoke: passed\nchecks: replacement, chunk_persistence, expiry, flags, local_clearance_preserved",
  );
} finally {
  try {
    await stop();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
