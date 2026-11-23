import http from "node:http";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import CDP from "chrome-remote-interface";
import { afterEach, expect, test, vi } from "vitest";
import { startHumanCheckServer, waitForHumanCheck } from "../../src/ask-pro/humanCheck.js";

vi.mock("chrome-remote-interface", () => ({ default: vi.fn() }));

let relay: Awaited<ReturnType<typeof startHumanCheckServer>> | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
  vi.useRealTimers();
  vi.resetAllMocks();
});

function fakeChallenge() {
  const origin = "http://fixture.invalid";
  let inlineChallenge = false;
  let visible = true;
  let followUpVisible = false;
  let source = "http://fixture.invalid/captcha-one";
  const iframe = {
    getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: 100 }),
    getAttribute: () => source,
    matches: () => true,
  };
  const followUp = {
    getBoundingClientRect: () => ({ width: followUpVisible ? 100 : 0, height: 100 }),
    getAttribute: () => "http://fixture.invalid/captcha-follow-up",
  };
  const document = {
    title: "Just a moment...",
    readyState: "complete",
    querySelectorAll: (selector: string) =>
      inlineChallenge && selector.startsWith("iframe") ? [iframe, followUp] : [],
    addEventListener: () => {},
  };
  const location = { origin, href: origin };
  const globals = { document, location, getComputedStyle: () => ({}) };
  let onMutation: () => void;
  let onResize: () => void;
  let onLoad: (event: { type: string; target: typeof iframe }) => void;
  const resizing = new Set<unknown>();
  let installObserver: () => void;
  let bindingName: string;
  let clicks = 0;
  const events = new EventEmitter();
  const client = Object.assign(events, {
    close: async () => {},
    Runtime: {
      enable: async () => {},
      bindingCalled: (handler: (...params: unknown[]) => void) => events.on("binding", handler),
      addBinding: async ({ name }: { name: string }) => {
        bindingName = name;
      },
      evaluate: async ({ expression }: { expression: string }) => ({
        result: { value: runInNewContext(expression, globals) },
      }),
    },
    Page: {
      enable: async () => {},
      getFrameTree: async () => ({ frameTree: { frame: { id: "main" } } }),
      frameStartedLoading: (handler: (...params: unknown[]) => void) =>
        events.on("starting", handler),
      frameNavigated: (handler: (...params: unknown[]) => void) => events.on("navigating", handler),
      frameStoppedLoading: (handler: (...params: unknown[]) => void) =>
        events.on("loaded", handler),
      addScriptToEvaluateOnNewDocument: async ({ source }: { source: string }) => {
        installObserver = () => {
          const window = {
            addEventListener: (event: string, callback: typeof onLoad) => {
              if (event === "load") onLoad = callback;
            },
            get top() {
              return this;
            },
          };
          runInNewContext(source, {
            ...globals,
            window,
            MutationObserver: class {
              constructor(callback: () => void) {
                onMutation = callback;
              }
              observe() {}
            },
            ResizeObserver: class {
              constructor(callback: () => void) {
                onResize = callback;
              }
              observe(element: unknown) {
                resizing.add(element);
              }
              unobserve(element: unknown) {
                resizing.delete(element);
              }
            },
            IntersectionObserver: class {
              observe() {}
              unobserve() {}
            },
            [bindingName]: (payload: string) =>
              events.emit("binding", { name: bindingName, payload }),
          });
        };
        installObserver();
      },
      bringToFront: async () => {},
      captureScreenshot: async () => ({ data: Buffer.from("fake challenge").toString("base64") }),
    },
    Input: {
      dispatchMouseEvent: async ({ type }: { type: string }) => {
        if (type === "mouseReleased") {
          clicks += 1;
          document.title = "Fixture app";
          onMutation();
        }
      },
    },
  });
  vi.mocked(CDP).mockResolvedValue(client as never);
  return {
    origin,
    clicks: () => clicks,
    startNavigation: () => events.emit("starting", { frameId: "main" }),
    loadFollowUp: () => {
      document.title = "Just a moment...";
      events.emit("navigating", { frame: { id: "main" } });
      installObserver();
      events.emit("loaded", { frameId: "main" });
    },
    commitInteractivePage: () => {
      document.title = "Fixture app";
      document.readyState = "interactive";
      events.emit("navigating", { frame: { id: "main" } });
      installObserver();
    },
    showInlineChallenge: () => {
      document.title = "Fixture app";
      inlineChallenge = true;
      onMutation();
    },
    replaceInlineChallenge: () => {
      source = "http://fixture.invalid/captcha-two";
      onMutation();
    },
    reloadInlineChallenge: () => onLoad({ type: "load", target: iframe }),
    switchVisibleChallenge: () => {
      visible = false;
      followUpVisible = true;
      if (resizing.has(iframe)) onResize();
    },
    hideIframeWithoutMutation: () => {
      visible = false;
    },
    resizeIframe: () => {
      visible = false;
      followUpVisible = false;
      if (resizing.has(followUp)) onResize();
    },
    disconnect: () => events.emit("disconnect"),
  };
}

function request(
  url: URL,
  route: string,
  options: {
    method?: "GET" | "POST";
    authorized?: boolean;
    onHeaders?: () => void;
    revision?: number;
  } = {},
) {
  return new Promise<{ status: number; body: string; revision?: number }>((resolve, reject) => {
    const req = http.request(
      new URL(route, url),
      {
        method: options.method ?? "GET",
        headers:
          options.authorized === false ? {} : { Authorization: `Bearer ${url.hash.slice(1)}` },
      },
      (res) => {
        options.onHeaders?.();
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          const header = res.headers["x-check-revision"];
          resolve({ status: res.statusCode!, body, ...(header && { revision: Number(header) }) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(
      route === "/click" ? JSON.stringify({ x: 4, y: 5, revision: options.revision }) : undefined,
    );
  });
}

function click(url: URL, revision: number | undefined) {
  return request(url, "/click", { method: "POST", revision });
}

function openWait(url: URL) {
  let acknowledge!: () => void;
  const attached = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const response = request(url, "/wait", { onHeaders: acknowledge });
  return { attached, response };
}

async function startFixture() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fixture = fakeChallenge();
  relay = await startHumanCheckServer({
    chromePort: 1,
    targetId: "fixture",
    origin: fixture.origin,
    host: "127.0.0.1",
    bind: "127.0.0.1",
  });
  return { relay, fixture, url: new URL(relay.url) };
}

test("keeps the same viewer through a follow-up navigation and wakes the waiter after the last click", async () => {
  const { fixture, url } = await startFixture();
  expect((await request(url, "/wait", { authorized: false })).status).toBe(401);
  const wait = openWait(url);
  let waiting = true;
  const result = wait.response.then((response) => {
    waiting = false;
    return response;
  });
  await wait.attached;
  await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
  expect(waiting).toBe(true);
  const first = await request(url, "/frame");
  expect(first).toMatchObject({ status: 200, body: "fake challenge" });
  expect((await click(url, first.revision)).status).toBe(202);
  expect(await request(url, "/frame")).toEqual({ status: 202, body: "" });
  expect((await click(url, first.revision)).status).toBe(202);
  expect(fixture.clicks()).toBe(1);

  await vi.advanceTimersByTimeAsync(1_000);
  fixture.startNavigation();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(waiting).toBe(true);
  fixture.loadFollowUp();
  const second = await request(url, "/frame");
  expect(second).toMatchObject({ status: 200, body: "fake challenge" });
  expect((await click(url, first.revision)).status).toBe(202);
  expect(fixture.clicks()).toBe(1);
  expect((await click(url, second.revision)).status).toBe(202);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await result).toEqual({ status: 200, body: "cleared" });
  expect(fixture.clicks()).toBe(2);
  expect(await waitForHumanCheck(url)).toBe(true);
  expect(await request(url, "/frame")).toEqual({ status: 204, body: "" });
});

test("settles an interactive replacement page with unrelated resources still loading", async () => {
  const { fixture, url } = await startFixture();
  const wait = openWait(url);
  await wait.attached;
  fixture.startNavigation();
  fixture.commitInteractivePage();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await wait.response).toEqual({ status: 200, body: "cleared" });
});

test("lets a frame's fresh visibility check settle a hidden challenge iframe", async () => {
  const { fixture, url } = await startFixture();
  fixture.showInlineChallenge();
  const wait = openWait(url);
  await wait.attached;
  const frame = await request(url, "/frame");
  expect(frame.status).toBe(200);
  expect((await click(url, frame.revision)).status).toBe(200);
  fixture.hideIframeWithoutMutation();
  expect(await request(url, "/frame")).toEqual({ status: 202, body: "" });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await wait.response).toEqual({ status: 200, body: "cleared" });
});

test("settles an inline challenge that disappears after the phone sends its last click", async () => {
  const { fixture, url } = await startFixture();
  fixture.showInlineChallenge();
  const wait = openWait(url);
  await wait.attached;
  for (const replace of [
    fixture.replaceInlineChallenge,
    fixture.reloadInlineChallenge,
    fixture.switchVisibleChallenge,
  ]) {
    const initial = await request(url, "/frame");
    expect(initial.status).toBe(200);
    replace();
    expect((await click(url, initial.revision)).status).toBe(202);
  }
  expect(fixture.clicks()).toBe(0);
  const replacement = await request(url, "/frame");
  expect((await click(url, replacement.revision)).status).toBe(200);
  fixture.resizeIframe();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await wait.response).toEqual({ status: 200, body: "cleared" });
});

test.each(["expired", "tab closed", "session moved on"])(
  "ends a pending wait when %s",
  async (event) => {
    const { relay, fixture, url } = await startFixture();
    const wait = openWait(url);
    const result = wait.response.catch(() => "unavailable");
    await wait.attached;
    if (event === "expired") {
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    } else if (event === "tab closed") {
      fixture.disconnect();
    } else {
      await request(url, "/close", { method: "POST" });
    }
    await relay.done;
    expect(await result).toBe("unavailable");
    expect(await waitForHumanCheck(url)).toBe(false);
  },
);
