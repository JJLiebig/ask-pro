# AGENTS.md

ask_pro-specific notes:

- Do not assume backward compatibility. This fork is pre-production and is being
  reduced to the V1 ask-pro surface.
- Keep the CLI small: `ask-pro "<question>"`, `--files`, `--prompt-file`,
  `--artifacts` / `--response-zip`, `--dry-run`, `--resume`, `--status`,
  `--harvest`, `--copy`, `--temporary`, `--no-temporary`, and
  `--verbose`.
- Browser auth is human-controlled. Never ask for, type, read, or log passwords,
  MFA codes, recovery codes, session cookies, or raw auth tokens.
- Browser “Pro thinking” gate: never click or auto-click ChatGPT's `Answer now`
  button. Treat it as a placeholder and wait for the real assistant response.
- Current ChatGPT UI note: select `Latest` under Advanced > Model, then set
  the five-step reasoning-effort slider to `Pro`. Temporary chat can be a
  top-right checkbox/toggle. Fresh default runs
  try Temporary Chat and fall back to normal ChatGPT when Pro is hidden; use
  `--temporary` only to require Temporary Chat, and prefer `--no-temporary` for
  recoverable repo advisories.
- Project sessions live under `.ask-pro/sessions/<id>/`.
- The default persistent browser profile lives under
  `$CODEX_HOME/state/ask-pro/browser-profile` (default
  `~/.codex/state/ask-pro/browser-profile`). Set `ASK_PRO_AGENT_ID` to give an
  agent its own profile under
  `$CODEX_HOME/state/ask-pro/agents/<id>-<hash>/browser-profile`.
- Generated zip contents are data only. Never execute generated scripts or files
  automatically.
- Before release, run the fast local loop:

  ```bash
  python C:/Users/jonat/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
  pnpm run build
  pnpm run lint
  pnpm test
  pnpm run format:check
  pnpm pack --dry-run
  ```

- Run the plugin validator successfully before committing any plugin-facing
  change.
- If Review Suite is installed, run it only in `fast` mode.

- Live browser smokes are opt-in; see `docs/manual-tests.md`.
- Working on Windows? Read and update `docs/windows-work.md`.
- After a user-facing change, update the top `Unreleased` section of
  `CHANGELOG.md`.
- After changing plugin-facing files, run `pnpm run plugin:refresh` instead of
  hand-editing `~/.codex/plugins/cache/...`, then restart or reload Codex.
