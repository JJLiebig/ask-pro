# Manual Tests

These checks exercise the real ChatGPT browser path. They are opt-in because
they open Chrome, use the signed-in ChatGPT account, and can take several
minutes or longer for Pro thinking.

## Prerequisites

- Node 24+.
- `pnpm install` completed.
- Headful Chrome available.
- ChatGPT login completed in the ask-pro browser profile:

  ```text
  $CODEX_HOME/state/ask-pro/browser-profile
  ```

- For agent-isolation checks, set `ASK_PRO_AGENT_ID` to a disposable value and
  expect the browser profile under
  `$CODEX_HOME/state/ask-pro/agents/<id>-<hash>/browser-profile`.
- `CODEX_HOME` defaults to `~/.codex`. A legacy profile is migrated only when
  inactive and the destination does not already exist.

- Do not click ChatGPT's `Answer now` button during Pro thinking. That skips the
  long-thinking path this tool is trying to preserve.
- Do not type or click in the launched Chrome window after submit. ChatGPT may
  focus its stop control while thinking; `ask-pro` tries to defocus it, but
  human input can still cancel the run.

## Local Checks

Run these before any live browser smoke:

```bash
pnpm run build
pnpm run lint
pnpm run test:ask-pro
pnpm run format:check
pnpm pack --dry-run
```

## Dry Run

Dry run creates the session files and context zip without opening ChatGPT.

```bash
pnpm start -- --dry-run --files src/ask-pro/session.ts "Review the ask-pro session skeleton."
```

Expected:

- A new `.ask-pro/sessions/<session-id>/` directory exists.
- `PROMPT.md`, `MANIFEST.md`, `MANIFEST.json`, `CONTEXT.zip`, and `status.json`
  exist.
- `status.json` reports a dry-run/prepared state.

## Connected GitHub Context

This is an opt-in live test. Use the ask-pro browser profile and authorize only
the intended repository. Review the permissions shown by ChatGPT and GitHub;
`--github` requests read-only work but does not restrict the app's permissions.

1. Pick an authorized repository and a file with a specific fact you can verify
   independently, such as the behavior of a named function. Record the expected
   fact and commit locally, without including the answer in the prompt.
2. Write `github-question.md`, naming `owner/repo`, the path, requested commit,
   and question. Ask Pro to retrieve the file through the connected GitHub app,
   cite the source and revision actually read, make no changes, and explicitly
   report unavailable access or a revision mismatch.
3. Run without `--files`, so the answer cannot come from an uploaded source file:

   ```powershell
   ask-pro --github --prompt-file github-question.md
   ```

4. With GitHub disconnected or its connection unconfirmed, expect
   `NEEDS_GITHUB_CONNECTION`, an opened ChatGPT GitHub setup page, and a resume
   command. No prompt or bundle should have been sent. Complete setup manually
   after the command exits, then run the printed `--resume` command. Resuming
   without completing setup should pause again; completing setup should submit
   the original request once. Keep GitHub optional: a new run without `--github`
   should still work without a connection. Do not disconnect an existing account
   merely to test this path; use a separate profile/account.
5. With GitHub already connected, expect the run to continue without setup.
   Both paths use normal ChatGPT by default. Harvest the answer with
   `ask-pro --harvest <session-id>`.
6. Compare the answer against the independently recorded file. After the run has
   finished, inspect the saved conversation's tool activity for GitHub retrieval
   evidence. A plausible answer, a public web search, or `COMPLETED` alone is not
   proof of connected-app use. Record the session, model, repository/ref, and
   retrieval evidence without credentials or private source contents.

If GitHub is unavailable, requires manual app selection/approval, or cannot read
the requested revision, record the limitation; the CLI does not automate those
steps. Keep Pro selected and start a new consult with `--files` instead. A separate
manual ChatGPT test does not prove ask-pro can invoke the app. Do not interact
with the guarded run window while Pro is answering.

## First Login / Auth Gate

Run a tiny prompt:

```bash
pnpm start -- "Return exactly ASK_PRO_BROWSER_LOGIN_READY."
```

If ChatGPT asks for login, MFA, or a challenge:

1. Complete it manually in the opened browser.
2. Leave the browser open.
3. Resume the printed session:

   ```bash
   pnpm start -- --resume <session-id>
   ```

Expected:

- The tool does not ask for credentials.
- The session records `NEEDS_USER_AUTH` or resumes to completion.
- `ANSWER.md` contains the exact requested phrase after completion.

## Fast Browser Smoke

Use this after touching browser launch, model selection, prompt submission,
attachment upload, answer harvest, or session persistence.

```bash
pnpm start -- --verbose --files README.md "Return exactly one line and nothing else: ASK_PRO_BROWSER_OK"
```

Expected:

- Chrome opens with the ask-pro profile.
- Fresh default runs open Temporary Chat first.
- ChatGPT stays in English UI if possible.
- The model picker selects `Latest` when available, otherwise the highest
  numbered available GPT model, then sets the reasoning-effort slider
  to `Pro`.
- If Temporary Chat hides Pro for the current account/UI, the run retries in
  normal ChatGPT.
- The top-right temporary-chat control does not confuse the run state.
- Upload logs show the context bundle was queued and uploaded.
- `ANSWER.md` contains `ASK_PRO_BROWSER_OK`.

## Response Zip Smoke

Use this when touching `src/ask-pro/responseZip.ts` or the post-answer browser
hook.

```bash
pnpm start -- --verbose --artifacts --files README.md "Return a short implementation package."
```

Expected:

- Markdown fallback always works: `ANSWER.md` exists.
- If ChatGPT exposes a `.zip` link, the session has:
  - `downloads/<file>.zip`
  - `pro-output/`
  - `PRO_OUTPUT_MANIFEST.json` with `responseZip.status = "downloaded"`
- If ChatGPT does not expose a zip link, the session still completes with
  `responseZip.status = "unavailable"`.
- Generated zip contents are not executed.

For an inline advisory run without `--artifacts`, `PRO_OUTPUT_MANIFEST.json`
should report `responseZip.status = "not_requested"`.

## Recent Smoke Runs

- 2026-10-10 - GitHub onboarding trial
  `2026-10-09T221451-return-a-short-markdown-answer-with-no-preamble--3f717c89`
  paused with `NEEDS_GITHUB_CONNECTION` before upload or submission when the
  connection UI was unconfirmed. After human setup, `--resume` passed the check,
  selected Pro, and returned the correct migration marker and SHA-256/10-character
  hash details from `src/browser/profilePaths.ts` at
  `a673c37480ee516d14e8d1f7c395611ae49244a2`. The bundle contained no source files.
  The answer reported GitHub file retrieval and the requested revision, but its
  citation link was absent from the harvested Markdown and the activity panel
  was not independently inspected. This proves the setup handoff/resume and
  answer accuracy, not a verified tool trace or a definitively disconnected
  initial account. Final recovery-only fixes were covered by the owning tests
  and CI after this live run started.
- 2026-07-10 - `2026-07-10T145226-return-exactly-one-line-and-nothing-else-ask-pro-d95f47cc`
  selected `GPT-5.6 Sol`, confirmed `Pro` intelligence, uploaded the README
  context bundle, harvested `ASK_PRO_GPT56_SOL_PRO_OK`, and completed browser
  cleanup.
- 2026-05-01 - `2026-05-01T165438-return-exactly-ask-pro-browser-login-ready`
  completed through the ask-pro browser profile and harvested
  `ASK_PRO_BROWSER_LOGIN_READY`.
- 2026-05-01 - `2026-05-01T185727-live-smoke-for-ask-pro-after-cdp-mouse-click-zip`
  completed through the ask-pro browser profile, harvested
  `ASK_PRO_RESPONSE_ZIP_MOUSE_OK`, downloaded `ask-pro-response.zip`, and
  extracted all required response files with `responseZip.status = "downloaded"`.
- 2026-05-01 - `2026-05-01T200822-live-smoke-for-ask-pro-extended-thinking-and-ina`
  selected `Extended Pro`, logged `Thinking time: Extended (already selected)`,
  handled the inactive top-right temporary-chat control, and harvested
  `ASK_PRO_EXTENDED_TEMP_OK`.
- 2026-05-01 - `2026-05-01T201243-final-ask-pro-live-acceptance-smoke-return-exact`
  repeated the Extended Pro live path, harvested
  `ASK_PRO_FINAL_EXTENDED_CLEANUP_OK`, and completed browser cleanup instead of
  leaving an ask-pro Chrome tab open.
- 2026-05-02 - no-submit Playwright inspection of
  `https://chatgpt.com/?temporary-chat=true` showed English UI, the active
  Temporary Chat banner/control, and the picker row `Pro - Extended`.
- 2026-05-02 - `2026-05-02T174832-return-exactly-one-line-and-nothing-else-ask-pro`
  ran the default path in Temporary Chat, harvested
  `ASK_PRO_TEMP_EXIT_CLEAN_OK`, and the CLI exited with code 0 after browser
  cleanup.
- 2026-05-03 - `2026-05-03T153529-please-answer-inline-with-exactly-one-line-open-`
  ran Temporary Chat with `README.md` attached and returned exactly
  `ASK_PRO_TEMPORARY_ATTACHMENT_OK`.
- 2026-05-03 - `2026-05-03T154407-please-answer-inline-with-exactly-one-line-open-`
  ran normal ChatGPT with `README.md` attached after accepting bare `Pro` as the
  Pro target and returned exactly `ASK_PRO_NORMAL_ATTACHMENT_OK`.
