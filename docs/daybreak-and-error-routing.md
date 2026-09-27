# Daybreak and error routing

## Daybreak controls

The chat model menu has a Daybreak switch for Codex accounts whose own current model catalog advertises Daybreak access-program metadata (or a recognized alias in older catalogs). There is no global/fallback entitlement list. In Daybreak mode, **Default / Recommended**, when present, selects the account's advertised program alias; ordinary model choices come from that same account's catalog. When both programs are advertised, a separate Blue/Red selector is available.

The pinned Codex 0.156.1 experimental protocol exposes `TurnStartParams.cyberAccessProgram` as `standard`, `daybreakBlue`, or `daybreakRed`. The app persists this independently of `model`, carries it through the hub/worker boundary, and supplies it for each turn. Off explicitly sends `standard` (omitting the field allows provider automatic behavior). Legacy Daybreak aliases remain On; ordinary unconfigured chats default to Off. A change during an active turn applies to subsequent turns, not the running turn.

Codex 0.156.1 exposes caller-specific `Model.availableAccessPrograms.cyber`; this is projected as `cyberAccessPrograms` for each account model. Explicit unsupported combinations are disabled in the picker and rejected by the hub, including empty/malformed lists. GPT-6 Sol and Luna use the same dynamic path, with no hard-coded entitlement. Missing/null metadata from older catalogs remains unknown, not an empty list: recognized aliases can expose the legacy program control, with a visible warning that Codex verifies the requested combination at turn start. A provider denial is surfaced; it is never retried using a different model/program or without Daybreak. Unknown programs and models absent from the selected account's catalog are rejected before a fresh input is accepted. This control does not grant account entitlement, local permissions, or bypass provider policies.

The former 0.153.3 pin predates GPT-6 Sol/Luna picker support. Source manifests and both lockfiles now pin 0.156.1, the [official September 23 catalog hotfix](https://learn.chatgpt.com/docs/changelog). Refresh does not upgrade the installed vendor client; an older installed app still needs a compatible update. Spark is removed from the static fallback; saved helper configurations are not rewritten.

Switching accounts clears the draft treatment; manager account handoff does not carry a Daybreak alias or program into the successor. Removed program selections stay visibly On with a warning and an Off escape hatch, not a silent downgrade. The operator can refresh the account catalog. Failed settings writes revert both model and treatment together and show the error beside the control.

Install compatible hub, worker, and web builds together. Older workers do not implement this new field. Source tests use fixtures and mocked provider requests; no inference or entitlement claim is made for live accounts.

## Failure routing

Manager Assistants are approval reviewers. There is no global cheap-model error-triage assistant. Actionable/unknown failures still route directly to the Overseer, retaining the existing permission boundary.

Confirmed terminal usage/credit exhaustion no longer wakes the Overseer merely because it is on another account. The original session error, operator notification, and a suppression receipt remain. This is deterministic classification, not another model invocation, retry, account transfer, or billing change. Existing same-account manager suppression is unchanged. Authentication, cybersecurity-policy, context-length, and unrecognized errors are not classified as credit exhaustion. Fresh healthy telemetry or an elapsed reset releases suppression.

On September 27, saved helper settings for AllMyAgents and MyOwnMesh still named `gpt-5.3-codex-spark`; these were configuration observations, not availability proof. OpenAI's [official changelog](https://learn.chatgpt.com/docs/changelog) records Spark's September 14, 2026 retirement. No live helper/model settings are migrated by this change.
