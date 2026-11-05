# Linux and session import

Install Node 24+, npm, Chrome and (without a desktop display) Xvfb:
`sudo apt install xvfb`. Installed Chrome is discovered automatically; set
`CHROME_PATH=/absolute/path/to/chrome` for a custom install. Keep Chrome updated.
Chrome for Testing needs the same shared libraries as desktop Chrome; `ldd
"$CHROME_PATH"` identifies missing ones. Do not disable Chrome's sandbox.
Ubuntu may need an administrator to allow Chrome under its AppArmor policy.

ask-pro runs headed Chrome on a private Xvfb display when neither `DISPLAY` nor
`WAYLAND_DISPLAY` exists. The display follows Chrome's lifetime. Headless Chrome
was blocked by Cloudflare on the dev host while headed Chrome could reach
chatgpt.com. The identity provider still blocked login on that datacenter IP,
so remote sign-in forwarding has been removed. With a desktop, `--login` opens
Chrome for manual sign-in.

## Import your personal-browser session

Do this yourself in a private terminal, with no agent watching or recording the
terminal. Cookies grant account access. Never send them to an agent, paste them
in chat, put them in a command argument, or save them in a repository.

1. On your own computer, open a separate Chrome profile if you want to keep this
   login separate from your everyday browser. Sign in at `https://chatgpt.com`.
2. Press F12 (or Ctrl+Shift+I / Cmd+Option+I). Select **Application** (under `>>`
   if hidden), expand **Storage → Cookies**, select **https://chatgpt.com**, and
   filter for `__Secure-next-auth.session-token`.
3. Copy the **Name**, **Value**, and **Expires / Max-Age** of the unsuffixed cookie.
   If it is split into `.0`, `.1`, etc., copy **every numbered chunk instead**.
   Double-click a Value cell to select/copy its full content. Do not copy the
   whole cookie table, `cf_clearance`, `__cf_bm`, CSRF tokens, or other cookies.
   NextAuth [documents numbered cookie chunks](https://next-auth.js.org/configuration/options#cookies).
4. SSH to the server interactively (for the dev pod: `ssh jjdev`). In the project
   directory, run this shell block. Replace `ask-pro` with
   `node /path/to/skill/scripts/ask-pro.mjs` if using only the skill install.

   ```sh
   (
     saved_tty=$(stty -g) || exit
     trap 'stty "$saved_tty"' EXIT
     trap 'exit 130' INT TERM
     stty -echo
     ask-pro --import-session
   )
   ```

5. While it waits, paste a JSON array in this shape, using your actual values and
   the expiry shown by DevTools (ISO date including timezone, or Unix seconds).
   This is **stdin**, not a shell command; input is hidden by `stty -echo`.

   ```json
   [
     {
       "name": "__Secure-next-auth.session-token",
       "value": "YOUR_VALUE",
       "expires": "2027-01-01T00:00:00Z"
     }
   ]
   ```

   For chunks, use one object per chunk, preserving each name, value and expiry.
   Keep chunk values separate. Unknown JSON properties are ignored. Mixed
   unsuffixed/chunked sets, duplicate names, missing chunks, expired cookies and
   non-session cookie names are rejected without echoing the input.

6. Press Enter, then Ctrl+D on the empty line to end stdin. Wait for the result.
   `state: ready` confirms the existing backend login probe passed. `needs_auth`
   means the copied session was not confirmed: check all chunks and their expiry,
   or log in again on your personal browser and repeat. A datacenter challenge
   may still prevent verification; this does not guarantee the session is portable.
7. Resume your saved ask-pro session or start your requested question. Import
   itself sends **no question**. A `needs_auth` handoff includes an `import`
   command with `--cwd` and a session ID; run that command inside the shell block
   instead so the correct saved profile is used.

Wait for other ask-pro runs to finish before importing. The import holds the
profile launch lock, replaces only matching ChatGPT session-cookie variants,
checks login and closes newly launched Chrome to flush the cookies. If Chrome
was already retained for recovery, it keeps that browser and its other tabs
open, closing only the import tab; Chrome flushes cookies in its usual lifecycle. It stores cookies only in
Chrome's profile, with the expiry you provided; it never writes them to ask-pro
session logs. Existing local Cloudflare cookies are left to the browser. State
lives under `~/.agents/state/ask-pro`; `ASK_PRO_STATE_DIR` selects a different
state folder. Do not copy an entire Windows browser profile to Linux.

## Session lifetime and limits

There is no promised lifetime or guarantee that cross-device reuse works.
Cookies expire at the copied expiry or can be invalidated earlier by the service.
Keep the source profile signed in: we have not verified whether ordinary logout
invalidates its copied token. Do not assume closing the source browser revokes it.
For revocation, OpenAI documents **Settings → Security → Log out all**, which
[can take up to 30 minutes for other sessions](https://help.openai.com/en/articles/9243857-how-do-i-log-out-of-all-of-my-devices).

This flow imports the NextAuth session token, including numbered chunks; it does
not transfer Cloudflare clearance. Cookie transport and persistence are tested
with fake values only. Real session portability, Pro access and a successful
query remain human-attended checks; the agent must not read your real cookies.

## Local qualification

After `pnpm run build`, run `node scripts/smoke-session-import.mjs`. It uses a
throwaway `ASK_PRO_STATE_DIR`, fake cookies and a local page, and checks cookie
replacement and persistence across a real Chrome restart. It never signs in or
sends a query. Remove only test profiles and processes created by the smoke.
