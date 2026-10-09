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

Use `--github` to check the GitHub connection in ask-pro's signed-in ChatGPT
account before sending any prompt or files. It defaults to normal ChatGPT for
recovery; an explicit `--temporary` still requires Temporary Chat.

If GitHub is disconnected or its connection cannot be confirmed, ask-pro opens
GitHub's ChatGPT page and returns `connect_github_then_resume`. Install the
plugin if needed, connect your account yourself, and review repository access.
Select only the repositories you want available; an organization may require
approval. Then run the emitted `--resume` command. It checks the connection again
before submitting. ChatGPT login alone does not pass this GitHub check.

Then explicitly request repository evidence in the prompt:

```powershell
ask-pro --github "Read owner/repo and explain its request authentication flow."
```

Use `--files` for local changes or a precise snapshot that GitHub cannot retrieve.
For committed repository code, prefer `--github` with the repository, ref, paths,
and question; source-file uploads are usually unnecessary when retrieval works.
The flag requests read-only work and citations, but **does not enforce read-only
GitHub permissions**. The live GitHub plugin advertises write capabilities;
review the actual grant even though the [Help Center](https://help.openai.com/en/articles/11145903-connecting-github-to-chatgpt)
describes a read-only app. [Allow read actions](https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt)
controls approval prompts, not the underlying access grant.

A connected account does not prove access to a particular repository, revision,
or Pro experience. ask-pro does not select an app in the composer, approve app
actions, or verify the answer's sources. The opt-in [GitHub smoke](docs/manual-tests.md#connected-github-context)
checks actual retrieval. GitHub authorization stays with ChatGPT; ask-pro needs
no GitHub token.

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
