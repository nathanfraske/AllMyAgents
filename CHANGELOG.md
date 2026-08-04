# AllMyAgents release history

All notable operator-facing changes are recorded here. The linked release notes contain the complete
feature and fix log used on the corresponding GitHub release.

## Unreleased

## v0.1.13-alpha.16 — 2026-08-03

This release turns the Application Overseer into a practical setup, teaching, and recovery assistant;
adds durable team presets and audited elevation; completes Claude worker questions; aligns Full Access;
and polishes pairing, Browser, and transcript links without weakening operator provenance.

[Full v0.1.13-alpha.16 release notes](docs/releases/v0.1.13-alpha.16.md)

- Claude worker sessions now support the same durable `AskUserQuestion` lifecycle as in-process sessions
  over the mutually authenticated worker channel, including interrupt aborts and restart-safe correlation.
- The Application Overseer can now guide project setup, save and launch durable team presets, configure
  existing managers and per-chat model/effort/access settings, trigger account sign-in, manage remote-device
  grants, drive GitHub imports, and issue short-lived mesh pairing codes through existing audited brokers.
- First-run setup is now the short path from one account to one Overseer. The detailed visual tour remains
  optional, while the Overseer has a provider-neutral guide for explaining every major app concept and can
  open and spotlight allowlisted UI controls with a bounded, dismissible explanation.
- Agent failures now alert the Overseer through a diagnostic-only bus turn with bounded journal evidence.
  Automatic alerts can produce troubleshooting reports but cannot mutate hub state or inherit operator
  authority.
- Added an elevated-command escape hatch with deny-by-default per-project scopes, literal-path and
  blast-radius analysis, a non-auto-approvable operator decision, bounded Windows UAC execution, process-tree
  timeout, and full proposal/decision/execution audit. Full Access alone still cannot self-elevate.
- Direct project-manager assignments now carry a hub-verified, narrowly scoped authority statement, so
  children treat ordinary reversible work inside their existing workspace as in scope without letting an
  ordinary teammate widen permissions or authorize risky actions.
- Codex **Full access** now selects the vendor's unrestricted host sandbox while retaining hub approval
  callbacks, origin clamps, and audit policy. Operating-system elevation (Windows UAC or `sudo`) remains a
  separate host boundary.
- External research links render compact local GitHub, PDF, or website identity badges without fetching
  remote favicons merely because a transcript was displayed.
- Absolute local-file links in transcripts now reveal the existing file in the desktop file manager only
  after an operator click; plain-browser views copy the path, and neither route executes the target.
- The Browser control is icon-only at rest and expands to show Browser on/off on hover, keyboard focus, or
  while its menu is open.
- New mesh devices can pair with a typo-resistant `XXXX-XXXX` code. Codes are cryptographically random,
  one-use, memory-only, valid for ten minutes, and invalidated after ten failed guesses; existing long-lived
  device credentials remain available under an Advanced recovery control.
- Overseer bus messages and automatic failure alerts now wait for a separate diagnostic-only turn instead
  of being steered into a live operator-origin turn, preserving the privilege boundary under concurrency.

## v0.1.12-alpha.15 — 2026-08-02

This release adds authenticated remote device testbeds and an application Overseer, closes workspace and
backup growth leaks, makes context maintenance visible, and fixes startup, composer, login, and OAuth
refresh-state failures.

[Full v0.1.12-alpha.15 release notes](docs/releases/v0.1.12-alpha.15.md)

## v0.1.11-alpha.14 — 2026-08-01

This release fixes a Claude streaming-lifecycle wedge discovered in a live project-manager turn and makes
the operator's per-chat **Always allow** tool grant effective for manager- and teammate-started turns.

[Full v0.1.11-alpha.14 release notes](docs/releases/v0.1.11-alpha.14.md)

## v0.1.10-alpha.13 — 2026-07-31

This release focuses on journal durability, account re-authentication, long-history chat reliability,
project-manager controls, renderer recovery, and day-to-day navigation polish.

[Full v0.1.10-alpha.13 release notes](docs/releases/v0.1.10-alpha.13.md)

## v0.1.9-alpha.12 — 2026-07-31

This release repaired a concurrent journal-recovery metadata publication race and strengthened its
durability stress coverage.

[Full v0.1.9-alpha.12 release notes](docs/releases/v0.1.9-alpha.12.md)
