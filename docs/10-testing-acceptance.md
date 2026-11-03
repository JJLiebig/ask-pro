# Testing and acceptance criteria

## Unit tests

Test:

- prompt validation
- file include/exclude logic
- secret redaction
- zip creation
- session ID generation
- status state transitions
- response zip validation
- generated zip extraction
- auth-gate status shape
- compact TOON-style CLI stdout for create/status/auth/error states
- raw `--harvest` answer output with no metadata wrapper

## Browser selector tests

Test with fake DOM fixtures:

- model picker button detection
- composer-pill detection
- Pro model row detection
- Pro intelligence menu detection
- send button readiness
- attachment upload completion

## Dry-run smoke

```bash
ask-pro --dry-run "Return exactly ASK_PRO_DRY_RUN_OK."
```

Expected:

- no browser submission
- session folder created
- prompt written
- context bundle created
- status indicates dry-run complete
- stdout is an `ask_pro` record with the next action and resume command

## Manual auth smoke

```bash
ask-pro "Return exactly ASK_PRO_BROWSER_OK."
```

Expected:

- if not logged in, tool returns `NEEDS_USER_AUTH`
- stdout is an `ask_pro` record with `state: needs_auth`
- human logs in
- resume succeeds
- final answer is harvested

## Attachment smoke

Use a small harmless file:

```bash
echo "attachment smoke" > .ask-pro-smoke.txt
ask-pro --files .ask-pro-smoke.txt "Read the attached file and return exactly ATTACHMENT_OK."
```

Expected:

- attachment uploads
- answer references content
- no Enter fallback before upload completion

## Response zip smoke

```bash
ask-pro --artifacts "Create a minimal implementation bundle with IMPLEMENTATION_PLAN.md and TASKS.json."
```

Expected:

- if zip is available, it is downloaded and extracted
- if zip is unavailable, markdown fallback is harvested
- run still completes

## Acceptance criteria

V1 is done when all are true:

- `ask-pro` binary exists.
- `$ask-pro` skill exists at `skills/ask-pro/SKILL.md`.
- Normal path requires no preset/model flags.
- Local/session naming uses project `.ask-pro/` sessions and persistent browser
  profiles under `$CODEX_HOME/state/ask-pro/`.
- Installed plugin caches stay immutable; cached launches bootstrap and execute
  from `$CODEX_HOME/plugin-runtimes/ask-pro/`.
- User-facing text does not say “smart guy”.
- Browser automation can open or attach to ChatGPT.
- Auth gate returns `NEEDS_USER_AUTH` instead of handling credentials.
- The tool can resume after human login.
- The tool can upload context and submit a prompt.
- The tool writes `ANSWER.md`.
- Normal CLI stdout is compact agent telemetry; browser progress goes to stderr.
- `ask-pro --harvest` prints raw `ANSWER.md` content.
- With `--artifacts`, the tool attempts generated zip download/extract/validate.
- Markdown fallback works if no zip exists.
- API/Gemini/MCP/image/TUI/Project Sources/Deep Research are removed or de-scoped.
- Build and relevant tests pass.
