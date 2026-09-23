# Windows Work Notes

Read this when working on `ask_pro` from Windows and add new findings here.

- Prefer PowerShell plus `pnpm` directly.
- `ask-pro` stores project sessions under `.ask-pro/` and the persistent browser
  profile under
  `%CODEX_HOME%\state\ask-pro\browser-profile` (default
  `C:\Users\<you>\.codex\state\ask-pro\browser-profile`).
  Normal and concurrent agents use this shared profile without configuration.
  Set `ASK_PRO_AGENT_ID` only for an explicitly isolated agent profile under
  `%CODEX_HOME%\state\ask-pro\agents\<id>-<hash>\browser-profile`.
- The first run migrates an inactive legacy profile from
  `C:\Users\<you>\.agents\skills\ask-pro\`; active profiles and collisions fail
  closed. If a watcher denies the usual atomic rename or cleanup, ask-pro uses
  the verified state-path copy and preserves the exact legacy directory
  without later merging or deleting it.
- Cached plugin launches install, build, and execute under
  `%CODEX_HOME%\plugin-runtimes\ask-pro\<version>-<hash>\`, never in the
  installed plugin cache.
- Skills CLI installs only `skills/ask-pro/SKILL.md`. Install the standalone
  CLI with `npm install --global ask-pro`; it does not use Codex's plugin cache
  or the marketplace runtime-copy path.
- Browser login is human-controlled. If ChatGPT asks for login, MFA, or a
  challenge, leave Chrome open and resume with `ask-pro --resume <session-id>`.
  Manual-login recovery discovers the authenticated ChatGPT tab again instead
  of keeping a stale DevTools target across the sign-in redirect. It also
  follows a replacement DevTools port recorded by the managed profile.
  Challenge recovery requires a visible active challenge control or surface;
  queued composer text and class or ID substrings do not trigger it.
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
- The ChatGPT picker exposes `Latest` under Advanced > Model and a
  five-step reasoning-effort slider with `Pro` at the maximum. ask-pro selects
  or confirms both before submission.
- The current logged-in ChatGPT homepage exposes its picker as a visible
  `button[aria-label="Select ChatGPT model"]` without the old model-switcher test ID
  or composer-pill class. A missing picker after a passed login check is a UI
  selector failure, not evidence that the user needs to sign in.
- The same picker menu exposes a bare `[role="slider"][aria-valuemax]` for Pro
  effort, without the older `data-model-reasoning-effort-slider` wrapper.
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

- September 10: the model picker exposes `Latest` (currently `6 Pro`). Select the
  literal `Latest` option and keep the reasoning slider on `Pro`. Tool work appears
  inside `[data-streaming-response-status]`; it is progress, not answer content.
  Refreshing the plugin leaves existing immutable session runtimes running.
