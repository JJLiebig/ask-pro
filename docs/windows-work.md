# Windows Work Notes

Read this when working on `ask_pro` from Windows and add new findings here.

- Prefer PowerShell plus `pnpm` directly.
- `ask-pro` stores project sessions under `.ask-pro/` and the persistent browser
  profile under
  `C:\Users\<you>\.agents\state\ask-pro\browser-profile`
  (`ASK_PRO_STATE_DIR` overrides the `ask-pro` state folder).
  Normal and concurrent agents use this shared profile without configuration.
  Set `ASK_PRO_AGENT_ID` only for an explicitly isolated agent profile under
  `...\state\ask-pro\agents\<id>-<hash>\browser-profile`.
- Earlier versions kept profiles in `%USERPROFILE%\.codex\state\ask-pro`. The
  first run moves them with one rename. Chrome keeps its profile open, so
  Windows refuses that rename while Chrome runs; ask-pro then uses the old
  profile for that run and moves it on a later one. Tests set `CODEX_HOME` and
  `ASK_PRO_STATE_DIR` to temp folders so they never touch real profiles.
- `npx skills add` and the Codex marketplace plugin both install the whole
  repo. Its launcher,
  `scripts\ask-pro.mjs`, installs, builds, and executes under
  `...\state\ask-pro\runtimes\<install>\<hash>\`, never in the
  installed skill folder. Each installed skill folder has its own `<install>`
  group, so separate installs never remove each other's builds. Once a new build
  is running, the launcher removes every other build in its group that no
  running ask-pro still uses, and the groups of skill folders that no longer
  exist. Windows refuses to move a folder
  that a process still has open; the launcher skips it and retries on a later
  run. It moves each folder aside in one step before deleting it, so a locked
  build is never left half-deleted.
- Browser login is human-controlled. If ChatGPT asks for login, MFA, or a
  challenge, leave Chrome open and resume with `ask-pro --resume <session-id>`.
  Manual-login recovery discovers the authenticated ChatGPT tab again instead
  of keeping a stale DevTools target across the sign-in redirect. It also
  follows a replacement DevTools port recorded by the managed profile.
  Challenge recovery requires a visible active challenge control or surface;
  queued composer text and class or ID substrings do not trigger it.
- `--github` checks the connection in the managed profile after ChatGPT login
  and before any upload/submission. Missing or unconfirmed connections restore
  Chrome to the GitHub setup page and return `connect_github_then_resume`.
  The controller exits before human OAuth; resume rechecks the connection and
  starts the unsent prompt, instead of harvesting an unrelated conversation.
  The regular Chrome account can differ from ask-pro's account. Do not copy
  cookies or GitHub tokens between profiles.
- Chrome DevTools state is recorded in each session's `browser.json`; use the
  saved port for DOM inspection when a live browser needs debugging.
- Concurrent fresh and resumed runs on one managed profile use PID-backed
  browser-run leases. A completed run closes only its tab while peers remain;
  the last live run owns Chrome shutdown, and later runs prune dead leases.
  Managed Chrome is launched through the Windows process service so this lease
  transfer survives the original controller job exiting. A detached direct
  child still belongs to the Codex command job and is terminated with it. The
  broker launches managed Chrome at below-normal priority so its cold start
  does not compete with interactive desktop work. The exclusive profile-lock
  owner launches immediately. Only a recent startup marker left by a controller
  that exited after brokering Chrome triggers the remaining bounded handoff
  wait. The last lease requests Chrome's native graceful shutdown, waits up to
  20 seconds, and force-terminates the process only if Chrome does not exit.
- Mutable session metadata retries transient Windows `EPERM` and `EBUSY`
  replacement failures before reporting an error.
- The ChatGPT picker exposes model rows under Select model and a
  five-step reasoning-effort slider with `Pro` at the maximum. ask-pro selects
  or confirms both before submission, preferring `Latest` when available and
  otherwise the highest numbered available GPT model.
- Ordinary managed Chrome runs start minimized, then hide the native Windows
  browser window after isolated-tab setup. This keeps it out of normal desktop
  interaction and avoids repeating minimize/restore composition transitions
  when concurrent runs create tabs. First login, resume/recovery, stale auth,
  visible challenges, and retained debug sessions restore the window for human
  control. A native window marker distinguishes this intentional recovery state
  from Chrome making its parked window visible during concurrent tab creation,
  so unattended peers preserve only the human recovery state. Remote Chrome and
  explicit existing-tab runs are never parked.
- A visible `Answer now` and `Stop answering` control pair is the active Pro
  thinking gate. Report it as active status, but never click either control.
- The old Oracle API, MCP, Gemini, TUI, bridge, and remote-service paths are not
  V1 requirements in this fork.

- A latest assistant turn containing only `Stopped thinking`, with no active stop
  control, triggers one automatic `continue`. Managed runs disable the input guard
  for that submission and restore it afterward. A second stop preserves the chat
  and returns `INCOMPLETE_ANSWER` / `stopped_without_answer`; explicit `--resume`
  grants one more continuation attempt. Elapsed thinking time alone is not a stop.

Future Windows gotchas belong here.

- Linux virtual-display supervision is Linux-only; Windows keeps its existing
  broker and native window behavior. Login links now retain their fragment on reload.

- `--login` is an explicit remote sign-in relay; ordinary Windows runs keep their
  native window behavior. It does not inspect credentials or migrate profiles
  between operating systems. Its HTTP server is tested with disposable fixtures.

- Managed Chrome uses a 16 MiB disk-cache limit. Before a fresh launch, ask-pro
  clears only `Default/Cache` and `Default/Code Cache` under the selected shared
  or per-agent profile while holding its launch lock. Active profiles are left
  alone; locked cache folders are skipped silently. Cookies, Local Storage,
  IndexedDB, and other sign-in data are preserved.

- October 14: thinking-status monitoring now uses the same visible composer Stop
  selector as submission and response capture. The current icon-only
  `aria-label="Stop"` control confirms activity without a separate thinking label;
  hidden controls do not. The monitor never clicks Stop or Answer now.

- October 12: native clarification cards use
  `data-codex-composer-request-navigation` and show one question at a time.
  Pointer interaction requests a pause, but the live server returned 409
  ("Request can no longer be snoozed") even for fresh cards. ask-pro
  browses the cards without submitting defaults, retains Chrome, and returns
  `AWAITING_ANSWERS`. Use a UTF-8 JSON file with `--resume ... --answers ...`;
  this avoids PowerShell quoting problems with multiline free-text answers.
  Expired cards are answered by replying in the same conversation; capture waits
  for that new reply. A composer that rejects input before sending leaves answers
  pending for retry.

- October 7: the live Select model view exposes `GPT-6`, `GPT-5.6 Sol`, and
  `GPT-5.5` instead of `Latest`. The default picker prefers `Latest` when present,
  otherwise compares visible enabled terminal GPT versions numerically. Pro
  remains a separate requirement; a composer effort label does not prove which
  model is selected.
- September 30: signed-in ChatGPT loads a `/challenge-platform/` script even
  while its composer and the "Library is now Space" notice are visible. Script
  presence is not a blocking challenge. Navigation only treats the Cloudflare
  interstitial title as blocking when no visible enabled composer is available;
  active login, MFA, and CAPTCHA surfaces remain handled by the intervention monitor.
- September 10: the model picker exposes `Latest` (currently `6 Pro`). Select the
  literal `Latest` option and keep the reasoning slider on `Pro`. Tool work appears
  inside `[data-streaming-response-status]`; it is progress, not answer content.
  Updating the skill leaves running sessions on their existing build.
- September 23: ChatGPT can clear the composer and start generating before its
  current conversation turn selector reports a new turn. A visible Stop control
  confirms submission in that case; a hidden matching element does not. The
  current Stop button has `aria-label="Stop"` instead of the old test ID.
- September 23: the signed-in model button now has
  `aria-label="Select ChatGPT model"` without the old test ID or composer-pill
  class. Its menu has a `[data-reasoning-slider="true"]` Power control; ArrowRight
  moves it toward Pro, while End does not. The former "No cookies were applied"
  hint after a missing selector did not prove sign-out; check `/backend-api/me`
  status without reading its response body.
- September 23: current replies use `MarkdownRoot-` containers with nested
  `inline-markdown` citations. Capture the root to keep the full answer.
- September 24: ChatGPT may first route a submitted prompt through a provisional
  `/c/WEB:...` URL. Do not save or reload that route as a conversation; wait for
  the final conversation ID or print it as a recovery link. A browser observer
  that never settles must still obey the response deadline, including any reload
  attempt.
