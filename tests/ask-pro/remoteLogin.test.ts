import { afterEach, expect, test, vi } from "vitest";
import { startLoginServer } from "../../src/ask-pro/remoteLogin.js";
import { resolveAskProLoginProfile } from "../../src/ask-pro/browserRunner.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import { getAskProSessionPaths } from "../../src/ask-pro/session.js";

const list = vi.hoisted(() => vi.fn(async () => []));
vi.mock("chrome-remote-interface", () => ({ default: Object.assign(vi.fn(), { List: list }) }));
let relay: Awaited<ReturnType<typeof startLoginServer>> | undefined;
afterEach(async () => {
  await relay?.close();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

test("login uses the saved session profile across agent environments and rejects an outside path", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-login-profile-"));
  vi.stubEnv("ASK_PRO_STATE_DIR", path.join(cwd, "state"));
  vi.stubEnv("ASK_PRO_AGENT_ID", "different-agent");
  try {
    const agentId = "review-0123456789";
    const profileDir = path.join(cwd, "state", "agents", agentId, "browser-profile");
    const paths = getAskProSessionPaths(cwd, "fixture");
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(paths.browser, JSON.stringify({ agentId, profileDir }));
    expect(await resolveAskProLoginProfile(cwd, "fixture")).toBe(profileDir);
    await fs.writeFile(
      paths.browser,
      JSON.stringify({ agentId, profileDir: path.join(cwd, "outside") }),
    );
    await expect(resolveAskProLoginProfile(cwd, "fixture")).rejects.toThrow(
      "profile path is invalid",
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
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

test("reconnects to the same tab after a viewer aborts a pending frame", async () => {
  list.mockResolvedValue([{ id: "fixture", type: "page", url: "about:blank" }] as never);
  let started!: () => void;
  let rejectCapture!: (error: Error) => void;
  const capturing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = {
    on: vi.fn(),
    Page: {
      captureScreenshot: () => {
        started();
        return new Promise((_resolve, reject) => {
          rejectCapture = reject;
        });
      },
    },
    close: async () => {
      rejectCapture(Error("closed"));
    },
  };
  const second = {
    on: vi.fn(),
    Page: {
      captureScreenshot: async () => ({ data: Buffer.from("fixture-image").toString("base64") }),
    },
    close: async () => {},
  };
  vi.mocked(CDP)
    .mockResolvedValueOnce(first as never)
    .mockResolvedValueOnce(second as never);
  relay = await startLoginServer({ chromePort: 9222, host: "127.0.0.1" });
  const url = new URL(relay.url);
  const headers = { Authorization: "Bearer " + url.hash.slice(1) };
  const abort = new AbortController();
  const pending = fetch(url.origin + "/frame?target=fixture", { headers, signal: abort.signal });
  const rejected = expect(pending).rejects.toThrow();
  await capturing;
  abort.abort();
  await rejected;
  const next = await fetch(url.origin + "/frame?target=fixture", { headers });
  expect(next.status).toBe(200);
  expect(await next.text()).toBe("fixture-image");
});
