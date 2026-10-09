import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import {
  ensureGitHubConnection,
  GitHubConnectionRequiredError,
  GITHUB_SETUP_URL,
} from "../../src/browser/actions/github.js";

function element(textContent: string, label = "", hidden = false) {
  return {
    textContent,
    getAttribute: () => label,
    getBoundingClientRect: () => ({ width: hidden ? 0 : 100, height: 30 }),
    click: () => {
      throw new Error("Connection checks must not click consent");
    },
  };
}

describe("GitHub connection preflight", () => {
  test.each([
    {
      name: "a connected GitHub account",
      heading: "GitHub",
      ownSection: true,
      account: true,
      hidden: false,
      reconnect: false,
      connected: true,
    },
    {
      name: "no connected account",
      heading: "GitHub",
      ownSection: true,
      account: false,
      hidden: false,
      reconnect: false,
      connected: false,
    },
    {
      name: "another app's account",
      heading: "GitHub",
      ownSection: false,
      account: true,
      hidden: false,
      reconnect: false,
      connected: false,
    },
    {
      name: "an expired connection",
      heading: "GitHub",
      ownSection: true,
      account: true,
      hidden: false,
      reconnect: true,
      connected: false,
    },
    {
      name: "a hidden account control",
      heading: "GitHub",
      ownSection: true,
      account: true,
      hidden: true,
      reconnect: false,
      connected: false,
    },
    {
      name: "an unavailable app",
      heading: "Not found",
      ownSection: false,
      account: false,
      hidden: false,
      reconnect: false,
      connected: false,
    },
  ])("checks $name without handling authorization", async (fixture) => {
    const buttons = [
      element("Connect another account"),
      ...(fixture.account ? [element("", "Actions for test account", fixture.hidden)] : []),
      ...(fixture.reconnect ? [element("Reconnect")] : []),
    ];
    const section = { ...element(""), querySelectorAll: () => buttons };
    const document = {
      querySelectorAll: () => [element(fixture.heading)],
      getElementById: (id: string) =>
        fixture.ownSection &&
        id === "plugin-connected-accounts-connector_76869538009648d5b282a4bb21c3d157"
          ? section
          : null,
      get cookie() {
        throw new Error("Must not read credentials");
      },
    };
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value:
            expression === "location.href"
              ? "https://chatgpt.com/?temporary-chat=true"
              : runInNewContext(expression, {
                  document,
                  getComputedStyle: () => ({ display: "block", visibility: "visible" }),
                }),
        },
      })),
    };
    const destinations: string[] = [];
    const page = {
      navigate: async ({ url }: { url: string }) => {
        destinations.push(url);
      },
    };
    const pending = ensureGitHubConnection(page as never, runtime as never, () => {}, 0);
    if (fixture.connected) {
      await pending;
      expect(destinations.at(-1)).toBe("https://chatgpt.com/?temporary-chat=true");
    } else {
      await expect(pending).rejects.toBeInstanceOf(GitHubConnectionRequiredError);
      expect(destinations.at(-1)).toBe(GITHUB_SETUP_URL);
    }
    expect(destinations.every((url) => new URL(url).origin === "https://chatgpt.com")).toBe(true);
  });
});
