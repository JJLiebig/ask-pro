# Risk register

## ChatGPT UI churn

Risk: selectors break.

Mitigation:

- keep selector tests
- merge current composer/model-picker PRs
- fail gracefully to manual copy/upload
- do not over-rely on one selector

## Auth/MFA/CAPTCHA

Risk: automation cannot continue.

Mitigation:

- explicit `NEEDS_USER_AUTH` state
- human logs in manually
- never automate credentials

## Latest / Pro intelligence unavailable

Risk: the selected model or Pro intelligence target is missing.

Mitigation:

- select Latest before Pro intelligence
- do not submit if the required model is unavailable
- log selected visible label

## Temporary Chat incompatibility

Risk: Temporary Chat may not expose desired Pro model picker.

Mitigation:

- default fresh runs to Temporary Chat, then retry in normal ChatGPT if Pro is
  hidden there
- keep `--temporary` strict for callers that require Temporary Chat
- keep `--no-temporary` for normal ChatGPT retries
- keep model-picker failure actionable when explicit Temporary Chat hides Pro
- keep model-picker failure messages actionable if ChatGPT changes availability
- keep session metadata

## Generated zip unavailable

Risk: ChatGPT returns markdown only.

Mitigation:

- markdown fallback is first-class
- zip is opt-in and optional

## Preamble-only answer

Risk: ChatGPT acknowledges work, says it will inspect or create files, and then
the browser capture sees that preamble as the final answer.

Mitigation:

- classify suspicious deferred-work answers as `INCOMPLETE_ANSWER`
- do not treat incomplete answers as harvest-ready
- leave the browser open for debug while the incomplete-answer hardening is
  still active

## Generated zip unsafe or wrong

Risk: zip includes bad code, scripts, or irrelevant plan.

Mitigation:

- never execute zip contents automatically
- validate schema
- implementation agent translates plan into deliberate changes

## Secret leakage

Risk: repo bundle includes secrets.

Mitigation:

- best-effort redaction plus conservative default excludes
- exclude `.env`, keys, build dirs
- test redaction fixtures
- log redaction without leaking values

## Over-deleting useful browser code

Risk: rip-out deletes session/harvest/attachment code.

Mitigation:

- merge browser PRs before deletion
- keep a preserve list
- run tests after deletion

## Public distribution / terms risk

Risk: a public automated ChatGPT web tool may be perceived as scraping or abusive.

Mitigation:

- position as a local, human-controlled browser handoff
- user controls auth
- no credential sharing
- no scale/scraping features
- optional manual copy fallback
