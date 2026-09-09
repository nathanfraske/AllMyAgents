# TOON for AllMyAgents MCP results: measured evaluation

## Decision

Do not replace our MCP responses globally with TOON. In the measured manager workload,
compact JSON beats TOON on almost every run response. The larger saving comes from
returning concise run summaries and avoiding repeated no-change polling, not notation.
TOON remains a plausible opt-in format for genuinely uniform, multi-row tables, subject
to provider comprehension and consumer-compatibility tests.

This is a research result, not a production format change. No live service, journal,
permission, deployment, or application dependency was changed.

## Method and scope

Baseline source: `090bda9` (`fix/journal-status-manager-usage`). Read-only indexed query
of the MoM V4 manager session `ee63e095-2400-4081-bf43-49a6a251fe46`, at or below event
10871328, capped at 20,000 retained events. The observed window was
2026-09-08T19:33:46.804Z through 2026-09-09T03:42:23.348Z.

There were 1,911 completed MCP calls. The benchmark included 1,483 JSON object/array
response bodies: 1,275 `inspect_runs`, 162 `start_run`, 40 `query_team`, three
`monitor_ci`, and three `control_run`. It excluded 425 non-JSON responses and three
responses larger than 512 KiB. Forty-four externalized strings (7,026,961 bytes) were
read through the existing verified blob reader; a 32 MiB aggregate hydration ceiling
was not reached. The database connection was closed before tokenization and blob I/O.
No private response text was printed or sent to a service.

Each included response was measured as recorded, as compact JSON, and as official
TOON with comma and tab delimiters. Current `inspect_runs` summaries were regenerated
from those same retained result objects through `runAgentTool`, using a fake inspection
service; no real run was started, inspected remotely, or controlled.

Encoder: `@toon-format/toon@4.1.1`. Local token counter: `js-tiktoken@1.0.21`, with
`o200k_base` and `cl100k_base`. These are **tokenizer proxies, not exact GPT-6 or Claude
billing measurements**. Counts cover result bodies only, not request wrappers, tool
schemas, accumulated context, reasoning, or repeated context reads. This is one
manager's workload, not a fleet-wide distribution. Retention can change the rows in
a later query even with the same upper sequence; the counts below describe this run.

## Results

Token totals below use `o200k_base`. A positive change means TOON is larger. All
comparisons in the final column are against compact JSON containing identical data.

| Response | Count | As recorded | Compact JSON | TOON | TOON change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Retained `inspect_runs` | 1,275 | 2,422,480 | 2,145,488 | 2,232,615 | +4.06% |
| Current `inspect_runs` summaries | 1,275 | 1,295,584 | 1,295,584 | 1,303,819 | +0.64% |
| `start_run` | 162 | 169,963 | 140,971 | 146,911 | +4.21% |
| `query_team` | 40 | 145,821 | 121,783 | 121,043 | -0.61% |
| `monitor_ci` | 3 | 840 | 670 | 718 | +7.16% |
| `control_run` | 3 | 3,035 | 2,482 | 2,587 | +4.23% |

Do not add the retained and current inspection rows together: they represent two
renderings of the same calls. Across the retained responses, totals were 2,742,139
recorded, 2,411,394 compact JSON, and 2,503,874 TOON tokens. TOON looks beneficial
against pretty JSON but loses to simple whitespace removal.

The existing summary change reduces inspection-body tokens by **46.52%** against the
retained representation. This is a response-size reduction, not a measured 46.52%
reduction in the manager's total input, cost, or workload.

The second tokenizer confirms the main finding: TOON increases retained inspection
tokens by 4.50% and current-summary tokens by 0.75%. The very small `query_team` win
reverses to a 0.46% loss. Tab delimiters do not change the recommendation. A seven-token
`TOON v4.1` label per response and a proposed 34-token format explanation per model
request further erode small gains. Current summary totals with the label become
1,312,744 rather than 1,295,584 tokens under `o200k_base`.

As a positive control, a synthetic flat list of 20 runs with six uniform fields
encoded to **350 TOON tokens versus 618 compact-JSON tokens** (43.37% smaller; the
other tokenizer: 350 versus 617). That demonstrates the table-shaped opportunity,
not a saving measured in the manager's real traffic. Singleton run objects and
heterogeneous nested responses are the common case in this sample.

All 3,342 round-trip checks passed, including repeated-key/nested structures and ten
edge cases covering missing versus null, empty collections, quoted delimiters,
Windows paths, newlines/tabs, control characters, Unicode, and prototype-named keys.
The separate flat-table positive control also round-tripped. This tests the codec,
**not model comprehension**. The main benchmark took 147.6 seconds, including local
tokenization; TOON encoding itself totalled 727 ms for 3,322 unique-format encodes.
These timings are not a provider-latency benchmark.

## Where it could fit, and where it cannot

- `apps/hub/src/agentToolCore.ts` owns common tool bodies. `inspect_runs` now emits
  compact JSON; several other structured tools still pretty-print it.
- `apps/hub/src/agentTools.ts` wraps common results as MCP text for Claude.
  `apps/hub/src/agentMcpServer.ts` does the equivalent for Codex. A future formatter
  should be shared, deliberately opted into by a tool, not separate provider rewrites.
- MCP tool arguments and `inputSchema` remain JSON/JSON Schema. `structuredContent`,
  when used, remains a JSON object; an `outputSchema` requires a matching structured
  result. TOON can be presentation inside a text block, not a drop-in wire/schema
  replacement. See the [official MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- Leave journal storage, canonical signing, approval inputs, provenance, replay,
  cursors, and grants in their existing representations. Do not turn TOON into a
  new persistence or authorization layer. Do not wrap plain logs/prose/images in it.
- Preserve an explicit JSON mode for programmatic consumers. Existing tool tests
  already parse result text as JSON. A generic string-to-TOON middleware would break
  that contract and could accidentally reinterpret JSON-looking log content.
- Do not emit both complete JSON text and complete TOON text to the model and count
  only the latter. Keep any duplicate machine representation out of model-visible
  text unless the client contract requires it, in which case measure the duplication.

The full exposed core catalog has 45 tools: compact catalog serialization is 10,565
`o200k_base` tokens (10,357 `cl100k_base`), plus 54/53 tokens of shared MCP instructions.
These are serialization proxies, not proof every provider request includes the full
catalog. TOON text results would not reduce that schema cost. Role-appropriate tool
discovery and shorter descriptions warrant separate measurement.

## Recommended next increment

1. Keep current compact run summaries, exact cursor paging, and completion delivery.
   Verify that managers stop repeatedly polling unchanged runs: format changes do
   not eliminate that repeated work or context re-reading.
2. Prefer compact JSON for remaining structured responses where whitespace alone
   costs tokens. Check UI/readability and programmatic-consumer expectations first.
3. Only pilot TOON on a bounded, uniform list where identical-data compact JSON loses
   by a meaningful margin after labels/instructions. Keep input schemas unchanged.
4. Gate any pilot on Codex and Claude tests that recover exact run IDs, states,
   ownership, cursors, errors, and `outcome_unknown`, including adversarial-looking
   string values. Codec round trips cannot establish those model-level properties.
5. Measure actual request tokens, cached tokens, latency, follow-up errors, and task
   completion under each provider before enabling it by default.

This matches TOON's own guidance about [uniform versus deeply nested data](https://github.com/toon-format/toon/blob/main/packages/toon/README.md).
Independent [agentic-loop research](https://arxiv.org/abs/2605.29676) also reports
accuracy/parsing tradeoffs when changing notation. That study used other models and
settings; it is a reason to test our providers, not evidence they share its failures.

## Reproduction

The research dependencies were installed only in `.allmyagents/toon-benchmark`, with
lifecycle scripts disabled. Application manifests and lockfiles were untouched.
Pin the following in an isolated private package (including the transitive package):

- `@toon-format/toon@4.1.1`
- `js-tiktoken@1.0.21`
- `base64-js@1.5.1`

Run `npm install --ignore-scripts --no-audit --no-fund` in that isolated directory,
then from `apps/hub`, where the repository's `tsx` is installed:

```powershell
node --import tsx ../../scripts/benchmark-mcp-notation.mjs C:/Users/Admin/AppData/Roaming/AllMyAgents/data/hub.db ee63e095-2400-4081-bf43-49a6a251fe46 10871328 ../../.allmyagents/toon-benchmark
```

The script outputs only aggregate counts. It does not modify the database or invoke
provider/remote tools. `node --check scripts/benchmark-mcp-notation.mjs` and
`git diff --check` passed. No production application test suite was needed or run for
this documentation/diagnostic-only investigation.

## Follow-up: real list candidates and higher-value optimizations

The follow-up inspected existing callsites, a live 28-agent `list_agents` response,
and another bounded retained window from the same manager. The final list benchmark
included 42 JSON `query_team` responses. It used the same local tokenizers and pinned
encoder; only aggregate counts are published. Live `inspect_runs` returned no runs
in this chat's project and `practice_list` returned no practices, so neither empty
response was represented as evidence about real populated lists. No worker was woken.

### Actual TOON candidates

The following compares identical data in compact JSON against TOON **including the
seven-token response label**. Facets are measured independently to locate the useful
data shapes, not to recommend mixing two notations inside one opaque response.

| Existing response data | Observed rows / pages | Compact JSON tokens | Labeled TOON tokens | Saving |
| --- | ---: | ---: | ---: | ---: |
| `query_team` agent roster | 158 / 42 | 12,365 | 11,342 | 8.3% |
| Recent approval-decision records | 85 / 10 | 9,467 | 8,115 | 14.3% |
| Task-board records | 165 / 28 | 28,146 | 26,050 | 7.4% |
| Whole team queries without nonempty runs | 27 pages | 29,074 | 27,266 | 6.2% |

The second tokenizer agrees on the direction: 6.7%, 13.0%, 6.4%, and 5.1% respectively.
The format explanation would cost an additional 34 proxy tokens wherever supplied;
it is not included in these per-response labeled counts. Pending approval payloads
were empty in this sample: the decision-row result is NOT evidence for converting
full pending approval requests, commands, or connector arguments.

These are plausible small opt-in pilots, especially approval-decision history and
explicit task/roster queries. Whole queries that include raw run records still lose
to compact JSON; do not choose TOON merely because the outer response has arrays.
The final benchmark passed 155 codec/representation checks. No model-level parsing
or decision-quality gate has been run.

### A larger roster win without a new notation

The live list repeats the same full project UUID in every one of its 28 lines.
Counterfactuals preserve the complete agent IDs, names, providers, statuses, and role
text present in the response. Reconstructing the original text from the parsed rows
was verified byte-for-byte before measuring candidates.

| Rendering of that same roster | `o200k_base` tokens |
| --- | ---: |
| Current prose list | 1,749 |
| Flat TOON plus label | 1,734 |
| Project heading once, otherwise ordinary prose | 1,101 |
| Project grouping plus labeled TOON | 1,093 |

**Grouping alone saves 37.1%.** TOON saves only eight additional tokens beyond grouped
prose, before format instructions. Prefer grouped prose here. Do not shorten IDs or
use ambiguous aliases to manufacture a saving. Regenerate the heading and membership
from live data on each call, not a cached orientation claim.

`sessions.ts:managerChildStatus` similarly repeats team name/id and ACTIVE/STASHED
state per child. Grouping by current team is a source-confirmed analogous opportunity,
but no populated live `child_status` sample was available in this ordinary-worker
session, so no percentage is claimed for it. Mixed teams, projectless agents, and the
application Overseer need explicit distinct headings and regression coverage.

### Apply the run-summary optimization at the other existing entrypoints

`agentToolCore.ts:start_run` and `control_run` still return full durable records.
`sessions.ts:managerQueryTeam` calls `managerInspectRuns` and returns the full run
objects directly, bypassing the summary projection in the `inspect_runs` tool body.
This is why shortening `inspect_runs` alone leaves significant duplication elsewhere.

Reusing the current summary projection on retained records produced:

| Existing path | Samples | Recorded tokens | Compact JSON tokens | Candidate summary JSON | Saving versus compact JSON |
| --- | ---: | ---: | ---: | ---: | ---: |
| Standalone `start_run` acknowledgements | 161 | 167,003 | 138,579 | 55,480 | 60.0% |
| `control_run` acknowledgements | 3 | 3,035 | 2,482 | 997 | 59.8% |
| Whole `query_team` responses containing runs | 15 | 104,318 | 87,653 | 51,558 | 41.2% |

The second tokenizer gives 59.7%, 59.6%, and 41.1%. The acknowledgement sample excludes
errors, prerequisite wrappers, non-inline and oversized bodies; it is not a blanket
claim about all start calls. After summarizing runs, TOON on those 15 whole queries
reduces 51,558 to 47,325 tokens including labels (another 8.2%), much less than the
summary change itself.

Recommended implementation shape: one shared run-view serializer reused by inspection,
acknowledgements, and team queries, with a deliberate full-detail escape hatch. Keep
durable run storage and exact retained logs untouched. Preserve actual admitted
timeout, target identity, attribution, state, failure, `outcome_unknown`, and source
identity. Preserve both setup and dependent run IDs for prerequisite workflows.
Verify mutation responses still expose every fact needed to recognize partial
success before making the projection a default; this benchmark is not that API gate.

### Tool catalog overhead: another place TOON cannot solve

The shared catalog includes `overseer_control` for ordinary agents and managers even
though `sessions.ts:overseerControl` immediately rejects non-Overseer callers. Its
declaration alone is 2,634 proxy tokens: about 25% of the 10,565-token full core
catalog. Both adapters enumerate `AGENT_TOOLS`; the Codex bridge currently uses the
unfiltered default. This is a concrete candidate for role-appropriate discovery,
without altering server-side authorization or removing needed tools from the Overseer.

Generate discovery from the hub-bound live identity, never from an agent-asserted
role, cwd guess, or untrusted file. Preserve capability changes and compaction/resume
behavior. Whether a model request actually contains that entire declaration depends
on provider tool discovery/caching; **2,634 is not a guaranteed per-turn billing saving**.

The currently exposed MCP descriptions also repeat the 54-token common server header.
Forty-five copies are a 2,430-token serialization proxy. This header was already made
small in an earlier fix, so this is a residual opportunity, not the discovery of an
unaddressed giant header. Do not delete trust/authority rules: verify they remain in
the always-present native contract, and measure the actual provider request before
trying to remove redundant copies. `send_message` also has a 427-token description;
shortening its repeated examples may help, but its addressing/wake/authority rules
must survive. Behavioral reliability is more important than shaving a few hundred
tokens out of a permission-sensitive tool description.

### Priority and non-candidates

1. Reuse the run-summary projection in acknowledgements and team queries. Compact
   remaining JSON whitespace where contract-compatible. This produces the largest
   measured response saving here and needs no new dependency or model call.
2. Group rosters by project/team instead of repeating invariant IDs on each row.
3. Test role-appropriate tool discovery against actual provider requests, retaining
   all existing authorization checks.
4. Pilot TOON only for the measured table-like queries if its remaining savings justify
   added format guidance and provider comprehension testing.
5. Continue validating completion delivery and no-change polling behavior. Response
   encoding cannot fix the previously observed hundreds of identical inspections.
   Prefer existing completion notifications and cursor paging to another hidden
   cache, summarizer model, or custom persistence protocol.

Memory/practice search already returns capped prose excerpts, and remote command
output is already text. There is no demonstrated saving from wrapping those in TOON.
Remote-device roots and nested provenance are not uniformly tabular; retain their
identity/capability relationships. Further candidate measurements are warranted only
if usage shows they matter. The new investigation did not expand device grants,
invoke remote work, mutate services, or change application behavior.

Reproduce the list/facet comparison from `apps/hub`:

```powershell
node --import tsx ../../scripts/benchmark-mcp-list-candidates.mjs C:/Users/Admin/AppData/Roaming/AllMyAgents/data/hub.db ../../.allmyagents/toon-benchmark ../../.allmyagents/toon-benchmark/live-samples.json
```

The sample file is private scratch data captured from this chat's actual
`list_agents` result; it is not a checked-in fixture. The standalone acknowledgement
experiment is retained in `.allmyagents/toon-benchmark/run-acknowledgements.mjs`.
The list diagnostic is syntax-checked and has been executed after moving to `scripts`.
All changes in this follow-up are diagnostics/documentation, not production changes.

## Implemented follow-up (approved after the research)

The subsequent product change deliberately ships the larger, notation-independent
optimizations. The historical measurements above describe their named baseline and
candidate projections, not a new provider-billing measurement.

- `durableRunView.ts` is the shared model-facing projection for `inspect_runs`,
  `start_run`, `control_run`, and the runs facet of `query_team`. Summary is the
  default; `detail: "full"` returns the complete retained record. Setup/dependent IDs,
  admitted timeout, cancellation, unknown outcomes, failure stage, transport, stream
  byte counts, ownership and target identity survive the summary. Existing log pages
  and cursors are unchanged. The shipped summary preserves additional diagnostics
  beyond the initial benchmark candidate, so its exact size differs from that table.
- `list_agents` groups by project/Overseer/projectless scope; `child_status` groups
  by current active/stashed team. Full IDs and role/status text remain available.
- Both adapters omit `overseer_control` for non-Overseer identities. Claude receives
  the hub-minted worker identity. Codex asks the existing authenticated internal
  endpoint for its live bound-session catalog, with a three-second transport bound.
  Each discovery refresh reads the binding again. Old/unreachable hubs fall back to
  the previous catalog; this costs tokens but never grants execution authority.
  Hub authorization still checks every call. Agent-supplied role arguments cannot
  change discovery. Existing provider sessions may need their next tool-discovery
  refresh before seeing a smaller catalog.
- Remaining operational JSON whitespace is removed from CI monitor and Overseer
  responses without changing their data. No TOON runtime dependency, new persistence
  format, credentials, permission bypass, or summarizer-model call was introduced.

Regressions cover provider catalog parity and role refresh, mismatched/ambiguous
bindings, old-hub fallback, unauthorized execution, full-detail escape hatches,
unknown remote outcomes, cancellation, and mixed-scope/team roster ownership.
