# ask-pro

`ask-pro` gives coding agents a focused ChatGPT Pro second opinion through a
human-logged-in browser. The calling agent supplies the question and evidence,
and owns the result; ask-pro never applies generated code.

## Install

Both options need Node.js 24+, Chrome, and a ChatGPT account with Pro access.
Browser login is manual.

### Codex plugin marketplace

```powershell
codex plugin marketplace add JJLiebig/ask-pro
codex plugin add ask-pro@ask-pro
```

This route needs Git and npm. The plugin's cached runner downloads pnpm, builds
outside the plugin cache, and keeps the installed snapshot unchanged. If
`ask-pro` is not on `PATH`, the skill uses that runner.

Update with `codex plugin marketplace upgrade ask-pro`, then restart Codex to
load the updated skill.

### Skills CLI (Codex and other supported agents)

Install the skill and its standalone CLI separately:

```powershell
npx skills add JJLiebig/ask-pro
npm install --global ask-pro
```

The [skills CLI](https://github.com/vercel-labs/skills) installs the skill in
the current project by default. Add `-g` for a user-wide skill or `-a codex`
to select Codex; it supports other agents too. The npm CLI runs without Codex's
plugin cache.

Update both parts:

```powershell
npx skills update
npm update --global ask-pro
```

The browser runtime is developed and tested on Windows. Other operating systems
need validation.

## Browser and session state

ask-pro never asks for, types, reads, or logs passwords, MFA codes, recovery
codes, session cookies, or raw auth tokens. A new browser profile may need one
manual ChatGPT login. On Windows, ordinary managed Chrome runs start minimized
and are hidden; login and recovery restore the window for human action.

The persistent profile lives at `$CODEX_HOME/state/ask-pro/browser-profile`, or
`~/.codex/state/ask-pro/browser-profile` when `CODEX_HOME` is unset. Existing
legacy profiles are migrated on first use; see [Windows notes](docs/windows-work.md)
for copy and recovery details.

Project sessions live under `.ask-pro/sessions/<id>/`. Add `.ask-pro/` to your
project's `.gitignore`. At each invocation, ask-pro deletes entire session
directories at least seven days old, regardless of state.

## Use

Ask for a recoverable repo consult:

```powershell
ask-pro --no-temporary --prompt-file question.md --files src --files tests
```

ask-pro selects `Latest` when available, otherwise the highest numbered available
GPT model, with `Pro` intelligence. Supply the caller's context explicitly.
Use a focused file bundle for local code; connected GitHub can provide remote
repository context when available (see below).

Request generated files only when needed; treat them as data and never execute
them automatically:

```powershell
ask-pro --artifacts --prompt-file implementation-plan.md --files src
ask-pro --harvest <session-id>
```

Use `ask-pro --help` for the full CLI. For multiline prompts, use
`--prompt-file`. Prefer `--no-temporary` when recovery matters; `--temporary`
requires Temporary Chat. The [skill](skills/ask-pro/SKILL.md) has agent guidance.

## Optional GitHub context

You can connect GitHub to the ChatGPT account used by ask-pro. OpenAI documents
the native [GitHub app](https://help.openai.com/en/articles/11145903-connecting-github-to-chatgpt)
as read-only. Access depends on the account, workspace, and ChatGPT experience;
a connection alone does not prove it works with ask-pro's selected Pro model.

Before starting an ask-pro run, open ChatGPT in your usual browser with the same
account and workspace. In **Settings > Plugins** (or **Apps**, if shown), open
GitHub and complete its connection flow yourself. Review permissions and select
only the repositories you want available; an organization may require approval.
Do this separately from ask-pro's login pause, which automatically continues
once ChatGPT sign-in succeeds.

Then explicitly request repository evidence in the prompt:

```powershell
ask-pro --no-temporary "Use the connected GitHub app to read owner/repo. Explain its request authentication flow, cite the files and revision you actually retrieved, and report any access gaps. Do not change anything."
```

Use `--files` for local changes or a precise snapshot that GitHub cannot retrieve.
ask-pro forwards the request; it does not connect the app, select an app in the
composer, approve app actions, or verify that retrieval succeeded. Check the
answer's evidence. The opt-in [GitHub smoke](docs/manual-tests.md#connected-github-context)
describes how to verify the path on your account. GitHub authorization stays with
ChatGPT; ask-pro needs no GitHub token.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm run lint
pnpm test
pnpm run format:check
pnpm pack --dry-run
```

After changing plugin files, run `pnpm run plugin:refresh` and restart Codex.
Do not edit the installed plugin cache. Live browser tests are opt-in; see
[manual tests](docs/manual-tests.md).

After the build matrix passes on `main`, [CI](.github/workflows/ci.yml) publishes
a new npm version through the configured trusted publisher, without a stored
npm token.
