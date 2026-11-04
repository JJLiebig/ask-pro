# Linux and remote sign-in

Install Node 24+, npm and Chrome. `chrome-launcher` discovers installed Chrome;
set `CHROME_PATH=/absolute/path/to/chrome` for Chrome for Testing or a custom
install. Prefer your system's maintained Chrome package for automatic updates.
Chrome for Testing downloads need manual updates and the same shared libraries
as desktop Chrome. `ldd "$CHROME_PATH"` identifies missing libraries. Do not
disable Chrome's sandbox. Ubuntu may require an administrator to allow its
sandbox under the host's AppArmor policy.

Without `DISPLAY` or `WAYLAND_DISPLAY`, ask-pro launches unified headless Chrome.
With a display it retains headed operation. Profiles, run leases, launch locks,
idle cache cleanup and graceful shutdown use the same lifecycle on both systems.
State lives under `~/.agents/state/ask-pro`; `ASK_PRO_STATE_DIR` isolates tests.
Never transfer a Windows profile to Linux; create a Linux profile and sign in once.

## One manual login, no virtual display

On the host, set the private network address reachable from your devices:

```sh
export CHROME_PATH=/opt/google/chrome/chrome # optional; installed Chrome is discovered
export ASK_PRO_LOGIN_HOST=100.123.207.19 # your host's Tailscale IP
node scripts/ask-pro.mjs --login
```

Open the emitted `login_url` on your desktop or phone connected to Tailscale.
Select `chatgpt.com` in the tab selector if a blank tab is shown, then click Log in
in the remote browser and complete sign-in yourself. Click a field,
then type on a desktop; on a phone use the masked text box and Send text.
Enter, Tab and Backspace buttons also work. Scroll with a desktop mouse wheel or the Scroll up / Scroll down buttons.
If authentication opens another tab, choose Refresh tabs and select it.
Select Done when the ChatGPT composer is visible. Tell your agent sign-in is
complete, then it can run the requested question or the saved `--resume` command.
The login command never submits a ChatGPT question or verifies auth for you.

Keep the command running during login (use a persistent terminal or a user
systemd service on a headless host). Done, Ctrl-C, or 15 minutes closes the
relay and releases the launch lock; Chrome and its profile remain for resume.
An expired link is replaced by running `--login` again. Do not run other ask-pro
commands during login. Active browser runs prevent opening the login relay.
If a query later returns `needs_auth`, run its emitted `login` command (which identifies the saved session profile), complete
the same human flow, then resume. Headless queries return that handoff without
waiting for a nonexistent desktop window.

## Transport and alternatives

The relay uses an unguessable access key in the URL fragment, an authorization
header for every frame and input request, no caching, and a 15-minute lifetime.
It forwards only screenshots, text, pointer and selected key events; it exposes
no DOM, cookie, evaluation or arbitrary DevTools API. Input and frames are
transient and are never written to logs or files. Treat the link as browser
control: share it only with the human signing in. Screenshots include whatever
the selected tab displays, so agents must not inspect the relay during sign-in.

Bind `ASK_PRO_LOGIN_HOST` to the host's **Tailscale IP**: Tailscale encrypts the
device-to-host connection. Plain HTTP on a public or untrusted LAN interface
would expose sign-in traffic. Do not forward this port publicly. Chrome's raw
DevTools listener stays on loopback; do not set remote-debug-host overrides for
this flow. `0.0.0.0` is available for an independently secured private network,
and emits the machine's hostname, but binding to the Tailscale IP is preferred.

Desktop Chrome's `chrome://inspect` can also connect through an SSH tunnel to
Chrome's loopback debugging port and offers its own screencast and input. That
avoids a custom viewer but needs desktop DevTools and exposes full browser
control. It is not a useful phone login path. The small relay supports both
devices without VNC, Xvfb, display servers, or extra dependencies.

Chrome documents headless remote interaction at
[Debug in Headless mode](https://developer.chrome.com/docs/automation-and-testing/debug-headless).
This proves the browser mechanism, not ChatGPT acceptance. ChatGPT or its
identity provider can challenge or reject headless Chrome or a datacenter IP.
A fixture pass cannot establish real login, Pro access, or a successful query.
If the challenge cannot be completed, report it to the user; do not bypass it
or copy session cookies. Real sign-in and one Pro query remain an attended gate.

## Local qualification

After `pnpm run build`, run `node scripts/smoke-linux-login.mjs` with Chrome
installed. It creates and removes a temporary `ASK_PRO_STATE_DIR` and uses only
loopback fixtures. It checks real input, screenshots, replacement tabs, desktop
and phone layout, link revocation, Chrome reuse/restart, launch locks, leases,
stale DevTools recovery and idle cache cleanup. Set `ASK_PRO_SMOKE_EVIDENCE` to a
scratch output directory to retain screenshots of the fixture viewer only.
