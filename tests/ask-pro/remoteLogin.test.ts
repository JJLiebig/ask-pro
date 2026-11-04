import { afterEach, expect, test, vi } from "vitest";
import { startLoginServer } from "../../src/ask-pro/remoteLogin.js";

const list = vi.hoisted(() => vi.fn(async () => []));
vi.mock("chrome-remote-interface", () => ({ default: Object.assign(vi.fn(), { List: list }) }));
let relay: Awaited<ReturnType<typeof startLoginServer>> | undefined;
afterEach(async () => {
  await relay?.close();
  vi.clearAllMocks();
});

test("requires the private key before accessing tabs, rejects cross-origin control, and revokes access on Done", async () => {
  relay = await startLoginServer({ chromePort: 9222, host: "127.0.0.1" });
  const url = new URL(relay.url);
  const headers = { Authorization: "Bearer " + url.hash.slice(1) };
  expect((await fetch(url.origin + "/tabs")).status).toBe(401);
  expect(
    (
      await fetch(url.origin + "/input", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      })
    ).status,
  ).toBe(401);
  expect(
    (await fetch(url.origin + "/tabs", { headers: { ...headers, Origin: "https://evil.example" } }))
      .status,
  ).toBe(403);
  expect(list).not.toHaveBeenCalled();
  expect((await fetch(url.origin + "/tabs", { headers })).status).toBe(200);
  expect(
    (await fetch(url.origin + "/evaluate", { method: "POST", headers, body: "{}" })).status,
  ).toBe(404);
  expect((await fetch(url.origin + "/done", { method: "POST", headers, body: "{}" })).status).toBe(
    200,
  );
  await relay.done;
  await expect(fetch(url.origin + "/tabs", { headers })).rejects.toThrow();
});

test("expires an unattended login link", async () => {
  relay = await startLoginServer({ chromePort: 9222, host: "127.0.0.1", ttlMs: 25 });
  await relay.done;
  await expect(fetch(new URL(relay.url).origin)).rejects.toThrow();
});
