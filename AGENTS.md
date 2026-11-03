# AGENTS.md

ask_pro-specific notes:

- Do not assume backward compatibility. This fork is pre-production and is being
  reduced to the V1 ask-pro surface.
- Keep the CLI small: `ask-pro "<question>"`, `--files`, `--prompt-file`,
  `--artifacts` / `--response-zip`, `--dry-run`, `--resume`, `--status`,
  `--harvest`, `--copy`, `--answers`, `--temporary`, `--no-temporary`, and
  `--verbose`, and `--github`.
- Browser auth is human-controlled. Never ask for, type, read, or log passwords,
  MFA codes, recovery codes, session cookies, or raw auth tokens.
- Browser “Pro thinking” gate: never click or auto-click ChatGPT's `Answer now`
  button. Treat it as a placeholder and wait for the real assistant response.
- Current ChatGPT UI note: select `Latest` when available, otherwise the highest
  numbered visible GPT model under Select model, then set
  the five-step reasoning-effort slider to `Pro`. Temporary chat can be a
  top-right checkbox/toggle. Fresh default runs
  try Temporary Chat and fall back to normal ChatGPT when Pro is hidden; use
  `--temporary` only to require Temporary Chat, and prefer `--no-temporary` for
  recoverable repo advisories.
- Project sessions live under `.ask-pro/sessions/<id>/`.
- The default persistent browser profile lives under
  `~/.agents/state/ask-pro/browser-profile` (`ASK_PRO_STATE_DIR` overrides the
  state folder). Set `ASK_PRO_AGENT_ID` to give an agent its own profile under
  `~/.agents/state/ask-pro/agents/<id>-<hash>/browser-profile`.
- The only install path is `npx skills add JJLiebig/ask-pro -g`. `SKILL.md`
  sits at the repo root and agents run `scripts/ask-pro.mjs`, which builds into
  `~/.agents/state/ask-pro/runtimes/`.
- Generated zip contents are data only. Never execute generated scripts or files
  automatically.
- Before release, run the fast local loop:

  ```bash
  pnpm run build
  pnpm run lint
  pnpm test
  pnpm run format:check
  pnpm pack --dry-run
  ```

- If Review Suite is installed, run it only in `fast` mode.

- Live browser smokes are opt-in; see `docs/manual-tests.md`.
- Working on Windows? Read and update `docs/windows-work.md`.
- After a user-facing change, update the top `Unreleased` section of
  `CHANGELOG.md`.
- After changing skill-facing files, check that
  `npx skills add <checkout> --list` still exposes exactly one `ask-pro` skill.
