# Session layout

Each run creates a durable session.

## Local project sessions

```text
.ask-pro/sessions/<session-id>/
```

## Required files

```text
PROMPT.md                 # final prompt submitted to ChatGPT
MANIFEST.md               # human-readable context manifest
MANIFEST.json             # machine-readable context manifest
CONTEXT.zip               # uploaded repo context bundle
ANSWER.md                 # harvested markdown answer
status.json               # current state
browser.json              # browser/session/tab metadata
log.txt                   # redacted log
```

## Optional files

```text
downloads/ask-pro-response.zip
pro-output/IMPLEMENTATION_PLAN.md
pro-output/TASKS.json
pro-output/TEST_PLAN.md
pro-output/RISK_REGISTER.md
pro-output/FILES_TO_EDIT.md
pro-output/REPO_CONTEXT_USED.md
PRO_OUTPUT_MANIFEST.json
CODEX_PLAN.md
```

## Session ID format

Prefer:

```text
YYYY-MM-DDTHHMMSS-short-slug-8hex
```

Example:

```text
2026-05-01T142000-billing-webhook-1a2b3c4d
```

Session IDs are plain directory names made from ASCII letters, numbers, and
hyphens. Session helpers reject path-like IDs before reading or writing files,
and resolve accepted IDs only below `.ask-pro/sessions/<session-id>/`.

## `MANIFEST.json`

```json
{
  "schemaVersion": 1,
  "sessionId": "2026-05-01T142000-billing-webhook-1a2b3c4d",
  "question": "Should this billing webhook use a queue or transactional outbox?",
  "includedFiles": [
    {
      "path": "src/api/stripe/webhook.ts",
      "reason": "Current webhook entry point"
    }
  ],
  "excludedFiles": [
    {
      "path": ".env",
      "reason": "secret file"
    }
  ],
  "redaction": {
    "mode": "best_effort",
    "findings": []
  }
}
```

## `status.json`

```json
{
  "schemaVersion": 1,
  "sessionId": "2026-05-01T142000-billing-webhook-1a2b3c4d",
  "status": "WAITING",
  "createdAt": "2026-05-01T14:20:00+02:00",
  "updatedAt": "2026-05-01T14:35:00+02:00",
  "resumeCommand": "ask-pro --resume 2026-05-01T142000-billing-webhook-1a2b3c4d",
  "harvestCommand": "ask-pro --harvest 2026-05-01T142000-billing-webhook-1a2b3c4d"
}
```

## Retention

At the start of every invocation, ask-pro permanently deletes each session
directory at least seven days old. Status does not matter: answers,
manifests, logs, context bundles, downloads, extracted Pro output, and unfinished
session state are all removed together. Because ask-pro is a short-lived CLI,
expiry is enforced the next time ask-pro runs rather than by a background
process.

`browser.json` records the exact browser profile path used for the run. When
`ASK_PRO_AGENT_ID` is set, that path is agent-specific so reattach uses the same
isolated profile. Resume accepts the exact former
`~/.agents/skills/ask-pro/.../browser-profile` only for the one-time migration
to `$CODEX_HOME/state/ask-pro/`; other external profile paths fail closed.
