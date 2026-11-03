# ask-pro

`ask-pro` gives coding agents a focused ChatGPT Pro second opinion through a
human-logged-in browser. The calling agent supplies the question and evidence,
and owns the result; ask-pro never applies generated code.

## Install

```powershell
npx skills add JJLiebig/ask-pro -g
```

This installs the `ask-pro` skill for Codex, Claude Code, and the other agents
the [skills CLI](https://github.com/vercel-labs/skills) supports. The skill
contains ask-pro itself; its first run installs dependencies and builds, so no
separate CLI install is needed. Update with `npx skills update`.

Codex users can install it as a plugin instead:

```powershell
codex plugin marketplace add JJLiebig/ask-pro
codex plugin add ask-pro@ask-pro
```

Update with `codex plugin marketplace upgrade ask-pro`, then restart Codex.
Both installs run the same bundled launcher and share the same state.

You need Node.js 24+, npm, Chrome, and a ChatGPT account with Pro access. The
browser runtime is developed and tested on Windows; other operating systems
need validation.

**Upgrading from an earlier version:** ask-pro state moved from
`~/.codex/state/ask-pro` to `~/.agents/state/ask-pro`. Before the first run
after upgrading, and while no ask-pro run is active, copy your signed-in browser
state once:

```powershell
New-Item -ItemType Directory -Force "$HOME\.agents\state" | Out-Null
Copy-Item -Recurse "$HOME\.codex\state\ask-pro" "$HOME\.agents\state\ask-pro"
```

## Browser and session state

ask-pro never asks for, types, reads, or logs passwords, MFA codes, recovery
codes, session cookies, or raw auth tokens. A new browser profile may need one
manual ChatGPT login. On Windows, ordinary managed Chrome runs start minimized
and are hidden; login and recovery restore the window for human action.

ask-pro keeps its state in `~/.agents/state/ask-pro/`: the persistent browser
profile in `browser-profile/` and the builds of the installed skill in
`runtimes/`. Set `ASK_PRO_STATE_DIR` to use a different folder.

Project sessions live under `.ask-pro/sessions/<id>/`. Add `.ask-pro/` to your
project's `.gitignore`. At each invocation, ask-pro deletes entire session
directories at least seven days old, regardless of state.

## Use

Agents run ask-pro through the installed skill, as
`node <skill-folder>/scripts/ask-pro.mjs`; `ask-pro` below stands for that
command. Ask for a recoverable repo consult:

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
requires Temporary Chat. The [skill](SKILL.md) has agent guidance.

When Pro asks native questions, ask-pro returns `awaiting_answers`, prints each
question and its numbered choices, and saves `QUESTIONS.json`. The calling agent
can answer directly, or ask its user when a decision needs their input. Write a
UTF-8 JSON file using the emitted `request_id`, with one answer per question:

```json
{ "requestId": "<request_id>", "answers": [2, 3, "A workshop on incident response"] }
```

Numbers select 1-based options; strings enter free text. Then continue the same chat:

```powershell
ask-pro --resume <session-id> --answers answers.json
```

`--answers -` accepts piped JSON. ask-pro requests a native pause; if ChatGPT expires
the cards anyway, it sends your answers as a reply in the same conversation.
Keep the session's original Temporary Chat mode when answering.
Further question rounds use the same
flow; `--status` repeats pending questions and `--harvest` waits for a final answer.

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

To try local changes as an installed skill, run
`npx skills add <path-to-checkout> -g`. Live browser tests are opt-in; see
[manual tests](docs/manual-tests.md).

After the build matrix passes on `main`, [CI](.github/workflows/ci.yml) publishes
a new npm version through the configured trusted publisher, without a stored
npm token.
