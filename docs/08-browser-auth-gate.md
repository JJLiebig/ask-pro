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
  profile: ~/.agents/state/ask-pro/browser-profile
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
   `~/.agents/state/ask-pro/browser-profile`
   for default runs, or
   `~/.agents/state/ask-pro/agents/<id>-<hash>/browser-profile` when
   `ASK_PRO_AGENT_ID` is set
2. headed manual-login browser on desktop systems
3. headless Linux with human-operated `--login` on a private network

Generic browser automation may attach to a user-approved running Chrome, but
`ask-pro` keeps agent-scoped runs on the managed profile path.

Headless Linux bootstraps auth through a private browser relay without a virtual
display. See [Linux setup](linux.md). The human confirms sign-in before the
agent resumes; closing the relay does not itself prove authentication.

`ASK_PRO_STATE_DIR` overrides `~/.agents/state/ask-pro/`. Resume rejects
profile paths outside the state folder.
