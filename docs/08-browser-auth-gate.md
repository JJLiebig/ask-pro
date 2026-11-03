# Browser auth gate

`ask-pro` must handle auth as a state machine.

## States

```text
BROWSER_STARTING
NEEDS_USER_AUTH
DRY_RUN_COMPLETE
READY_TO_SUBMIT
WAITING
WAIT_TIMED_OUT
INCOMPLETE_ANSWER
HARVESTED
COMPLETED
FAILED
```

## Auth detection

Return `NEEDS_USER_AUTH` when:

- URL contains login/auth/account challenge
- ChatGPT composer is not visible
- MFA UI is visible
- CAPTCHA/challenge UI is visible
- user account chooser is visible
- browser asks for permission that requires human action

## Agent-facing result

```toon
ask_pro
  session: 2026-05-01-billing-webhook
  state: needs_auth
  reason: login_page_detected
  profile: ~/.codex/state/ask-pro/browser-profile
  action: human_login_then_resume
  resume: "ask-pro --resume 2026-05-01-billing-webhook"
```

The browser window is the credential boundary. The calling agent should ask the
human to log in there and then run the emitted resume command.

## Resume behavior

On resume:

1. Reattach to existing browser/tab if possible.
2. Verify ChatGPT composer is visible.
3. Verify correct session prompt/context still exists.
4. Continue from the last safe state.
5. Do not resubmit if already submitted; harvest instead.

## Credential safety

Never:

- type the user's password
- ask the user to share MFA codes
- read cookies from logs
- print auth cookies
- store raw cookies in session logs

Debug logs must redact cookies and bearer tokens.

## Browser modes

The `ask-pro` CLI uses deterministic managed profiles. Browser-run leases and
dedicated tabs let concurrent agents share the default managed profile without
configuration. Use `ASK_PRO_AGENT_ID` only for explicit profile isolation.
Resume may reattach to saved browser runtime metadata when a session already
has it.

1. persistent automation profile at
   `$CODEX_HOME/state/ask-pro/browser-profile`
   for default runs, or
   `$CODEX_HOME/state/ask-pro/agents/<id>-<hash>/browser-profile` when
   `ASK_PRO_AGENT_ID` is set
2. headful manual-login browser
3. headless only after auth has been verified

Generic browser automation may attach to a user-approved running Chrome, but
`ask-pro` keeps agent-scoped runs on the managed profile path.

Headless is an optimization, not the auth bootstrap path.

`CODEX_HOME` defaults to `~/.codex`. On first use, ask-pro moves the exact
inactive legacy profile from `~/.agents/skills/ask-pro/` to the matching state
path. It never reads auth contents during migration, merges profiles, or moves
a profile with a live ask-pro lock, Chrome pid, or DevTools endpoint. Resume
metadata naming the exact legacy profile is migrated and rewritten; unrelated
profile paths remain rejected.
