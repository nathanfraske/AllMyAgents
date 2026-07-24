# Streaming Claude output — token-by-token into the transcript

Design + implementation plan, drafted 2026-07-24. Goal: make **Claude** assistant text stream into the
transcript as it is written (token-by-token), the way **Codex** already does, instead of appearing all at
once when the turn's `assistant` message lands. No behavior regressions to thinking markers, tool rendering,
the live token counter, the reflex heuristic, or journal replay.

Grounded in the code as it exists today:

- **`apps/hub/src/adapters/claude.ts`** — `ClaudeDriver.send()` runs `query({ prompt, options })` and forwards
  every streamed SDK message with `this.onEvent(\`claude/${m.type}\`, message)` (lines 73–87). It does **not**
  set `includePartialMessages`, so assistant text arrives only as a complete `assistant` message. `emitTokens`
  (lines 96–107) derives the live counter from `.message.usage` / `.usage`. `THINKING_KEYWORD` (lines 17–21)
  prepends a budget keyword to the prompt.
- **`apps/hub/src/adapters/codex.ts`** — the streaming template: Codex emits `codex/item/agentMessage/delta`
  (partial) followed by `codex/item/completed` (final), both keyed by the same item id.
- **`apps/web/src/lib/store.svelte.ts`** — `applyClaudeAssistant` (lines 918–942) renders complete Claude
  content blocks; `upsertCodexText` (lines 982–987) + the `codex/item/agentMessage/delta` case (lines 907–911)
  are the delta pattern to mirror: deltas append, the completed item replaces, both keyed by `codex:<itemId>`
  so a message renders exactly once.
- **`apps/hub/src/journal.ts`**, **`apps/hub/src/server.ts`** — every hub event is `journal.append()`ed (one
  SQLite row + one `emit('event')`), and `/ws?since=N` **replays the entire backlog from `N`** then attaches a
  live listener (server.ts 572–586). The web store connects with **`since=0` on every cold load**
  (store.svelte.ts 723–724) and dedups on `seq <= lastSeq` (752–753). This is why delta volume is the main
  scaling risk (§8).

---

## TL;DR

- **Feasible, and cheap on the driver side.** Setting `includePartialMessages: true` in the query options is
  the *only* required driver change. The existing forward loop already turns each partial into a
  `claude/stream_event` hub event automatically, because the partial message's `type` is literally
  `'stream_event'` and the loop emits `claude/${m.type}` (claude.ts:81).
- **The one key field path for the assistant text delta:**
  `payload.event.delta.text` — present when `payload.event.type === 'content_block_delta'` and
  `payload.event.delta.type === 'text_delta'`, belonging to content block `payload.event.index` of the message
  whose id came from the preceding `message_start` (`payload.event.message.id`).
- **The main risk is dedup + journal replay.** The streamed text and the final `claude/assistant` message must
  resolve to **one** transcript item (no double render), and because deltas flow through the same journal that
  the store replays from `seq 0` on every load, **thousands of per-token rows** would bloat the DB and slow
  every cold start. Recommendation: forward deltas as **volatile (non-journaled) live frames** and keep only the
  final `claude/assistant` in the journal, so replay rebuilds the same text from the final message alone.

---

## 1. What happens today, and the gap

**Codex (streams):** during a turn the app-server emits `codex/item/agentMessage/delta` frames; the store's
`upsertCodexText(view, ts, itemId, delta, /*append*/ true)` finds-or-creates one item keyed `codex:<itemId>`
and appends. When the turn's `codex/item/completed` (type `agentMessage`) lands, the store calls
`upsertCodexText(..., text, /*append*/ false)` on the **same key**, replacing the accumulated text with the
authoritative final. One item, rendered once, grown live.

**Claude (does not stream):** `ClaudeDriver` forwards `claude/assistant`, `claude/user`, `claude/result`, etc.
The assistant's visible text only exists inside the complete `assistant` message
(`payload.message.content[].text`), so `applyClaudeAssistant` pushes it all at once at the *end* of each
assistant message. Everything before that is just the "thinking" spinner. There is no token-level channel
because `includePartialMessages` is off.

The fix is to turn on the SDK's partial-message channel and mirror the Codex upsert pattern for Claude — with
the twist that Claude's delta frames identify a block by **index within a message**, not by a single flat item
id, so the store has to reconstruct the per-block key from the stream (§4).

---

## 2. The SDK: exact partial-streaming types and field paths

Types live in
`node_modules/.pnpm/@anthropic-ai+claude-agent-_51ba27ed38fde18bc8063e5514babc9d/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
and the raw event types it re-exports from
`@anthropic-ai/sdk@0.114.0/.../resources/beta/messages/messages.d.ts`.

### 2.1 The option and the partial message

```ts
// sdk.d.ts (Options)
includePartialMessages?: boolean;   // "When true, SDKPartialAssistantMessage events will be emitted during streaming."

// sdk.d.ts:4120
export declare type SDKPartialAssistantMessage = {
    type: 'stream_event';               // <- becomes hub kind `claude/stream_event`
    event: BetaRawMessageStreamEvent;   // <- the raw Anthropic stream event (the payload of interest)
    parent_tool_use_id: string | null;  // set when the block is inside a subagent/tool; null for the main turn
    uuid: UUID;
    session_id: string;                 // still carried, so the driver's session_id capture keeps working
    ttft_ms?: number;                   // time-to-first-token, first frame only (nice for telemetry)
};
```

Because the driver forwards `this.onEvent(\`claude/${m.type}\`, message)` and `m.type === 'stream_event'`, the
whole `SDKPartialAssistantMessage` arrives at the store as a `claude/stream_event` event whose `payload` is that
object. So in the store, **`payload.event`** is the raw stream event, discriminated on `payload.event.type`.

### 2.2 `BetaRawMessageStreamEvent` — the six raw event types

```ts
// messages.d.ts:1757
export type BetaRawMessageStreamEvent =
  | BetaRawMessageStartEvent        // type: 'message_start'
  | BetaRawMessageDeltaEvent        // type: 'message_delta'
  | BetaRawMessageStopEvent         // type: 'message_stop'
  | BetaRawContentBlockStartEvent   // type: 'content_block_start'
  | BetaRawContentBlockDeltaEvent   // type: 'content_block_delta'
  | BetaRawContentBlockStopEvent;   // type: 'content_block_stop'
```

Field paths (all relative to the hub event `payload`, i.e. `payload.event.…`):

| `payload.event.type` | Fields | Meaning |
|---|---|---|
| `message_start` | `.message` (`BetaMessage`) → **`.message.id`**, `.message.role`, `.message.usage`, `.message.content` (usually empty) | A new assistant message begins. **`message.id` is the only place the message id appears** — the per-block delta frames below do *not* repeat it. |
| `content_block_start` | **`.index`** (number), `.content_block` (the starting block) | A block opens at position `index`. `content_block` is `{type:'text',text:''}` \| `{type:'thinking',thinking:'',signature:''}` \| `{type:'tool_use',id,name,input:{}}` \| … |
| `content_block_delta` | **`.index`** (number), **`.delta`** (discriminated, see below) | Incremental content for block `index`. |
| `content_block_stop` | `.index` (number) | Block `index` is complete. |
| `message_delta` | `.delta` (`{stop_reason, stop_sequence, …}`), **`.usage`** (`BetaMessageDeltaUsage`) | End-of-message metadata + running output-token usage. |
| `message_stop` | *(none)* | The assistant message is finished. |

### 2.3 `content_block_delta` — the four delta shapes

```ts
// messages.d.ts:1691 — the delta union
BetaRawContentBlockDelta = BetaTextDelta | BetaInputJSONDelta | BetaCitationsDelta
                         | BetaThinkingDelta | BetaSignatureDelta | BetaCompactionContentBlockDelta;

export interface BetaTextDelta      { type: 'text_delta';      text: string; }                          // :2000
export interface BetaInputJSONDelta { type: 'input_json_delta'; partial_json: string; }                 // :1190
export interface BetaThinkingDelta  { type: 'thinking_delta';  thinking: string; estimated_tokens: number | null; } // :2125
export interface BetaSignatureDelta { type: 'signature_delta'; signature: string; }                     // :1938
```

So, per `payload.event.delta.type`:

- **`text_delta`** → append **`payload.event.delta.text`** to the text block at `payload.event.index`. **This is
  the assistant streaming text.**
- **`thinking_delta`** → append `payload.event.delta.thinking` to the thinking block. On subscription accounts
  this is typically empty (see §5); `estimated_tokens` is a coarse progress hint, not billable.
- **`signature_delta`** → `payload.event.delta.signature`. Opaque cryptographic signature for a thinking block;
  **never rendered as text**.
- **`input_json_delta`** → `payload.event.delta.partial_json`, a fragment of the tool's input JSON, concatenated
  across frames to reconstruct the full `input` object (see §6).

### 2.4 The final message shapes (for reconciliation)

```ts
// sdk.d.ts:2833 — the complete assistant message the store already handles as `claude/assistant`
export declare type SDKAssistantMessage = {
    type: 'assistant';
    message: BetaMessage;              // .id (same id as message_start), .content[], .usage
    parent_tool_use_id: string | null;
    aborted?: true;                    // present when an interrupt truncated the stream (see §7)
    uuid: UUID; session_id: string; …
};
// BetaMessage.id (messages.d.ts:1417): the message id; content blocks are BetaTextBlock{text},
//   BetaThinkingBlock{thinking,signature}, BetaToolUseBlock{id,input,name}, in content-array order.
```

**Key invariant for dedup:** `message_start.event.message.id` and the final `assistant`
message's `message.id` are the same `BetaMessage.id`, and the final `message.content[i]` corresponds to the
stream's block `index === i`. That equality is what lets streamed items and the final message resolve to one
item (§4). **Spike item S1:** confirm the ids match under *subscription* auth, where Claude Code proxies the
API — the reconciliation depends on it (fallback in §4.3).

---

## 3. Driver change (`adapters/claude.ts`): enable partials

Exactly one required change — enable the channel:

```ts
// in send(), where options is assembled (currently lines 58–69)
const options: Record<string, unknown> = {
  env,
  cwd: this.cwd,
  includePartialMessages: true,   // <-- ADD: turn on SDKPartialAssistantMessage frames
}
```

No new forwarding code is needed: the loop at claude.ts:73–87 already does
`this.onEvent(\`claude/${m.type}\`, message)` for every message, and partial messages have `type:
'stream_event'`, so they are forwarded as **`claude/stream_event`** automatically. The complete `assistant`
message is still emitted (partials are *additive*), so `claude/assistant` keeps arriving as today. **Recommend
reusing this auto-derived `claude/stream_event` kind** rather than inventing a new one — it needs zero driver
plumbing and reads naturally in the journal.

Two optional driver touches:

1. **Smoother live token counter.** `emitTokens` currently fires only on `assistant`/`result` (claude.ts:85–86).
   Optionally also emit from `message_delta` usage so the counter ticks during a long message:
   ```ts
   // inside the loop, after onEvent(...)
   if (m.type === 'stream_event') {
     const ev = (message as { event?: { type?: string; usage?: unknown } }).event
     if (ev?.type === 'message_delta') this.emitTokens(ev.usage)   // BetaMessageDeltaUsage has output_tokens
   }
   ```
   `emitTokens` already tolerates a missing `input_tokens` (input stays `undefined`), so this is safe. Low
   priority; the existing per-`assistant` update already keeps the counter alive.
2. **Volatile routing (see §8).** If we adopt non-journaled deltas, the *routing* decision lives in
   `sessions.ts` (`claudeDriverFor`'s `onEvent`, lines 202–211), **not** in the driver — the driver stays a dumb
   forwarder. See §8.1.

---

## 4. Store change (`store.svelte.ts`): accumulate deltas into one item

### 4.1 Generalize the Codex upsert

`upsertCodexText` (982–987) is already generic except for its name and hardcoded `kind:'assistant'`. Generalize
it (or add a sibling) so it can also carry `thinking`:

```ts
// keyed find-or-create; append grows text, replace overwrites it — mirrors the Codex path exactly
private upsertStreamText(view: SessionView, ts: string, key: string, text: string,
                         append: boolean, kind: ItemKind = 'assistant'): void {
  const item = view.items.find((i) => i.key === key)
  if (item) item.text = append ? (item.text ?? '') + text : text
  else this.push(view, { kind, ts, text, key })
}
```

Point the existing `codex/item/agentMessage/delta` and `applyCodexItem` calls at `upsertStreamText` (behavior
identical). Now it serves both providers.

### 4.2 Handle `claude/stream_event`

Add a case in `apply()` (next to the `codex/item/agentMessage/delta` case at 907–911). Claude's frames carry a
**block index**, not a flat id, so we track the current message id per view and build the key
`claude:<messageId>:<index>` — the same shape as `codex:<itemId>`, but reconstructed:

```ts
// SessionView gains two transient fields (undefined when idle):
//   streamMsgId?: string   // id from the most recent message_start
//   streamTick?: number    // bumped on each applied delta, so the scroll effect can react (§7.3)

case 'claude/stream_event': {
  const ev = (payload as { event?: any }).event
  if (!ev) break
  switch (ev.type) {
    case 'message_start':
      view.streamMsgId = ev.message?.id
      break
    case 'content_block_start': {
      const key = `claude:${view.streamMsgId}:${ev.index}`
      const b = ev.content_block
      if (b?.type === 'text') this.upsertStreamText(view, ts, key, '', false, 'assistant')
      else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
        view.sawReasoning = true                       // live "✦ reasoned" marker (§5)
        this.upsertStreamText(view, ts, key, '', false, 'thinking')
      }
      // tool_use: intentionally NOT created here — wait for the complete block (§6)
      break
    }
    case 'content_block_delta': {
      const key = `claude:${view.streamMsgId}:${ev.index}`
      const d = ev.delta
      if (d?.type === 'text_delta') this.upsertStreamText(view, ts, key, d.text ?? '', true, 'assistant')
      else if (d?.type === 'thinking_delta') this.upsertStreamText(view, ts, key, d.thinking ?? '', true, 'thinking')
      // signature_delta / input_json_delta: ignored for visible text (§5, §6)
      view.streamTick = (view.streamTick ?? 0) + 1     // drive stick-to-bottom (§7.3)
      break
    }
    // content_block_stop / message_delta / message_stop: no transcript action needed
  }
  break
}
```

Notes:

- **Creating items on `content_block_start`** (rather than lazily on the first delta) preserves exact block
  order in the transcript and makes the thinking "✦ reasoned" marker appear the moment reasoning starts — even
  on subscription accounts where no readable `thinking_delta` ever arrives.
- The streamed text item renders through the same `assistant` branch of `ItemCard` (`<Markdown text={item.text}>`,
  ItemCard.svelte:32–39), so Markdown re-renders progressively as `item.text` grows.

### 4.3 Reconcile the final `claude/assistant` — the dedup

Rework `applyClaudeAssistant` (918–942) so text/thinking blocks **upsert by the same key** (replace, not
append) instead of unconditionally pushing. Tool blocks are unchanged. This is the exact Codex contract: deltas
append, the final replaces, one key → one item.

```ts
private applyClaudeAssistant(view, ts, payload): void {
  const msg = (payload as { message?: { id?: string; content?: ClaudeBlock[] } }).message
  const content = msg?.content
  if (!Array.isArray(content)) return
  let sawThinkingThisTurn = false
  content.forEach((block, i) => {
    const key = msg?.id ? `claude:${msg.id}:${i}` : `claude:noid:${view.items.length}:${i}`
    if (block.type === 'text') {
      this.upsertStreamText(view, ts, key, block.text ?? '', false, 'assistant')   // replace → authoritative final
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      view.sawReasoning = true; sawThinkingThisTurn = true
      this.upsertStreamText(view, ts, key, (block.thinking ?? '').trim(), false, 'thinking')
    } else if (block.type === 'tool_use') {
      this.push(view, {                                  // unchanged: stream created no tool item
        kind: 'tool', ts, toolName: block.name, toolInput: block.input,
        reflex: !sawThinkingThisTurn && !view.sawReasoning,
        key: `tool:${block.id}`,
      })
    }
  })
  view.streamMsgId = undefined                           // end of message; keys for the next message differ by id
}
```

**Why this dedups cleanly:**

- If streaming was **on** and worked, the text/thinking items already exist under `claude:<msg.id>:<i>`, so the
  final message's `upsertStreamText(..., append:false)` *replaces* their text (a visual no-op if the accumulated
  text already equals the final; a self-heal if any delta was dropped). **One item.**
- If streaming was **off/absent** for this message (feature-flag off, an old journal, or a frame that never
  arrived), no keyed item exists, so `upsertStreamText` *pushes* it — i.e. exactly today's behavior. **Graceful
  fallback.**
- **Does `applyClaudeAssistant` still run?** Yes — it remains the authority. The stream *previews* the text; the
  final message *finalizes* it (and is the only source of tool blocks). This keeps a single code path that is
  correct with or without streaming, which matters for replay (§8.3).

**Fallback if S1 fails (ids don't match under subscription auth):** if `message_start.message.id !==` the final
`assistant`'s `message.id`, the reconcile keys won't line up and we'd double-render. Mitigations, in order of
preference: (a) key on `parent_tool_use_id`-scoped **per-turn block ordinal** tracked in the store instead of
the message id (works if both the stream and the final message expose a consistent ordinal); (b) if streamed
items exist for the in-flight message, have `applyClaudeAssistant` treat text/thinking as **already rendered**
and skip them (make the final a no-op for text, authoritative only for tools) — the stream becomes the single
source of truth for text. Decide after S1.

---

## 5. Thinking — preserve "✦ reasoned", never stream a signature

On subscription accounts Claude Code withholds reasoning text: a thinking block streams as
`content_block_start{thinking:''}` → one or more `signature_delta` frames (and possibly `thinking_delta` frames
whose `thinking` is empty) → `content_block_stop`. The visible text stays empty.

- Create the thinking item on `content_block_start` with **empty text**. `ItemCard` (40–48) renders empty
  thinking as the `✦ reasoned` marker — so the marker now appears *live*, when reasoning starts, and persists.
- **`thinking_delta`** → append `delta.thinking` (empty on subscription, real text on API-key accounts that
  expose summaries — both handled by the same append).
- **`signature_delta`** → **ignore for visible text.** Appending the signature would fill the item with opaque
  base64 and destroy the marker. This is the one delta type we deliberately drop.
- The final reconcile replaces thinking text with `(block.thinking ?? '').trim()` → still empty on subscription
  → marker preserved. **No regression.**

---

## 6. Tool use — wait for the complete block (recommended)

Partial tool calls stream as `input_json_delta.partial_json` fragments — an *incomplete JSON string* until
`content_block_stop`. Recommendation: **do not render tools live; keep today's behavior of rendering the
complete `tool_use` block from `claude/assistant`.** Reasons, both grounded in code:

- **`DiffView` needs the full parsed input.** `fileDiffsFromItem` (diff.ts:485–501) dispatches to
  `claudeEdit`/`claudeWrite`/`claudeMultiEdit`, which read structured fields — `file_path`, `old_string`,
  `new_string`, `content`, `edits[]` (diff.ts:203–228). A half-streamed `partial_json` can't be parsed into
  those, so a live tool item would show broken/empty diffs until the block closes.
- **The reflex heuristic needs message context.** `reflex` is computed in `applyClaudeAssistant` from whether a
  thinking block preceded the tool *in the same message's content array* (`sawThinkingThisTurn`) plus the
  session-wide `view.sawReasoning`. That determination is only reliable on the complete content array (§7.2).

So the stream handler skips `tool_use` blocks entirely; `applyClaudeAssistant` pushes them once, keyed
`tool:<block.id>`, exactly as now — which also keeps `applyClaudeUser`'s tool_result attachment (944–956)
working. **Optional polish (defer):** on `content_block_start{tool_use}` show a lightweight non-diff
"calling `<name>`…" placeholder keyed `claude:<msgId>:<index>`, then have `applyClaudeAssistant` *replace* it
with the real `tool:<block.id>` item — but this doubles the reconciliation surface for marginal value. Not
recommended for v1.

---

## 7. Tokens, status, scroll, and the reflex heuristic under streaming

### 7.1 Live token counter
Keeps working: `emitTokens` still fires on each `assistant` message and the final `result`
(claude.ts:85–86 → `session/tokens` → store 898–903). Optionally add the `message_delta` tick from §3 for a
finer live readout. No change to `session/tokens` handling required.

### 7.2 Turn timing, thinking indicator, reflex
- `turnStartedAt` / the "thinking" spinner are driven by `session/status` and cleared on `result`/idle
  (store 821–835, 861–883) — untouched by streaming. The spinner now naturally gives way to streaming text.
- **Reflex heuristic is unchanged and must stay computed in `applyClaudeAssistant`** from the final content
  array. Streamed thinking may set `view.sawReasoning = true` earlier, but within a message `sawThinkingThisTurn`
  is still recomputed from that message's own blocks, so a tool preceded by thinking in the same message is
  computed identically to today. Do **not** compute `reflex` from stream events (the stream creates no tool
  items). No regression.

### 7.3 Stick-to-bottom scroll — needs one small fix
ThreadView's auto-scroll `$effect` (ThreadView.svelte:92–96) reads **`view?.items.length`** and `thinking`.
Streaming a text block **mutates `item.text` in place without changing `items.length`**, so the effect does not
re-run and the view will not follow growing text within a single message (it only snaps when a *new* item is
pushed or the thinking row toggles). This is a real gap that Claude's token-level deltas will expose more than
Codex's chunkier deltas. **Spike S2:** confirm whether Codex streaming visibly follows growing text today (the
effect as written suggests it does not re-run on pure text mutation).

Fix: make the effect depend on something that changes per delta. The store already bumps `view.streamTick` on
each applied delta (§4.2); have the effect read it:

```svelte
$effect(() => {
  view?.items.length
  view?.streamTick        // <-- re-run as streamed text grows
  void thinking
  if (stick && scroller) scroller.scrollTop = scroller.scrollHeight
})
```

`stick` (ThreadView 98–101) already disengages when the user scrolls up >60px, so streaming won't fight a user
who scrolls back. Coalescing (§8) further reduces scroll/render churn.

---

## 8. Edge cases

### 8.1 Delta volume / journal bloat — the main scaling risk

Every `claude/stream_event` that goes through `journal.append` (journal.ts:27–40) becomes a `redact(JSON.stringify(...))`
+ one SQLite INSERT + one `emit('event')` + one WS frame + one store `apply()`. A long turn is **thousands** of
per-token frames. Worse: the store connects with **`since=0` on every cold load** (store 723–724) and the WS
**replays the entire backlog** (server 578–580), so every historical token delta is re-sent and re-applied on
*every* fresh page load. Journaling deltas verbatim makes both the DB and cold-start replay grow without bound.

Three options:

- **A — Volatile (non-journaled) deltas. Recommended.** Broadcast `claude/stream_event` frames to live WS
  clients **without** persisting them; keep only the final `claude/assistant` in the journal (it already carries
  the full text, so replay rebuilds the item via the push-fallback in §4.3). Requires:
  1. A broadcast path on `Journal` that emits without inserting, e.g. `broadcast(sessionId, kind, payload)` that
     constructs a frame and `emit('event', frame)` but skips the INSERT. Mark the frame **`volatile: true`** and
     do **not** give it a real `seq` (reuse the last seq or send `seq: -1`).
  2. Route in `sessions.ts` `claudeDriverFor` onEvent (202–211): `if (kind === 'claude/stream_event')
     this.journal.broadcast(record.id, kind, payload); else this.journal.append(record.id, kind, payload)`.
  3. Client `apply()` must bypass the `seq <= lastSeq` early-return for volatile frames and **not advance
     `lastSeq`** on them (store 752–753): `if (!event.volatile && event.seq <= this.lastSeq) return; … if
     (!event.volatile) this.lastSeq = event.seq`.
  - **Result:** live streaming, lean journal, cold-load replays only final messages. A client that (re)connects
    *mid-stream* simply misses in-flight deltas and catches up at the final `claude/assistant` — an acceptable,
    self-healing gap.

- **B — Coalesced journaled deltas. Low-risk interim.** Keep deltas in the journal but **buffer and merge** in
  the `claudeDriverFor` onEvent wrapper (or the driver): accumulate `text_delta` fragments per
  `(msgId,index)` and flush a single merged `claude/stream_event` every ~60–100 ms (or every N chars). Cuts rows
  ~10–50×, needs **no protocol change**, and replay stays verbatim-correct. Downside: still O(turn-length) rows,
  still replayed on cold start (just fewer), plus a timer/flush-on-`message_stop` to add.

- **C — Journal verbatim + post-turn compaction. Not recommended.** Append every delta, then delete the
  `claude/stream_event` rows for a message once its `claude/assistant` lands. Conflicts with the append-only
  `seq`/replay-join invariants (server 574–585) and breaks mid-stream reconnect. Skip.

**Recommendation:** target **A**; if a smaller first cut is wanted, ship **B** (no protocol change) and migrate
to A later. A and B compose (broadcast *merged* chunks) if render smoothness needs it. Either way, pair with the
§7.3 `streamTick` scroll fix.

### 8.2 Interrupts mid-stream
`ClaudeDriver.interrupt()` (claude.ts:109–111) aborts the query. The in-flight message may then arrive as a
final `assistant` with **`aborted: true`** and truncated content, or not arrive at all:
- If it arrives, `applyClaudeAssistant` reconciles (replace) with the truncated content — correct.
- If it doesn't, the streamed item simply keeps its last streamed text — a truthful "here's how far it got."
- `session/status` → idle/stopped and `claude/result` clear `turnStartedAt` (store 826–835, 861–883), so the
  spinner never sticks. Clear `view.streamMsgId`/`streamTick` on turn-end (idle/stopped/error) so the next turn
  starts clean.

### 8.3 Journal replay correctness
- **With option A (volatile):** the journal contains only `claude/assistant` for the turn, so replay pushes the
  full text once via the §4.3 fallback path. Nothing to dedup on replay — there are no delta rows. ✅
- **With option B/C (journaled deltas):** replay re-applies the `message_start` (restores `streamMsgId`) and each
  `content_block_delta` (rebuilds the accumulated text under `claude:<msgId>:<index>`), then the final
  `claude/assistant` reconciles (replace) → identical final text, one item. Dedup is automatic because the key is
  derived from journaled fields (message id + index), so replay is deterministic. ✅
- Either way, the store's existing `seq <= lastSeq` dedup (752–753) covers reconnect overlap for journaled
  frames; volatile frames are exempted per §8.1.

### 8.4 Multiple content blocks / multiple messages per turn
Indices are per-message and restart at 0 for each `message_start`. Keying on `claude:<messageId>:<index>` keeps
block 0 of message A (`claude:A:0`) distinct from block 0 of message B (`claude:B:0`). Interleaved
thinking/text/tool blocks land in content-array order because items are created on `content_block_start` in
arrival order, which equals content order. ✅

### 8.5 Subagents / nested tool output
`parent_tool_use_id` is non-null when a partial belongs to a subagent's message. v1 can treat those blocks the
same (they still have a message id + index). If subagent text should be visually nested or suppressed, branch on
`payload.parent_tool_use_id` — out of scope here, flagged for later.

---

## 9. Ordered implementation plan

1. **Driver:** set `includePartialMessages: true` in `ClaudeDriver.send()` options (claude.ts:58–69). Verify
   `claude/stream_event` events now appear in the journal/WS. *(Spike S1 + S3 here.)*
2. **Store — upsert:** rename/generalize `upsertCodexText` → `upsertStreamText(view, ts, key, text, append, kind)`;
   repoint the Codex delta + `applyCodexItem` calls. No behavior change (regression-guard with existing tests).
3. **Store — stream case:** add `streamMsgId` + `streamTick` to `SessionView`; add the `claude/stream_event` case
   (§4.2) handling `message_start` / `content_block_start` (text, thinking) / `content_block_delta`
   (text_delta, thinking_delta); ignore signature/input_json/tool_use.
4. **Store — reconcile:** rework `applyClaudeAssistant` (§4.3) to upsert text/thinking by
   `claude:<msg.id>:<i>` (replace) and clear `streamMsgId`; leave tool_use push + reflex as-is.
5. **Scroll:** add `view?.streamTick` to ThreadView's scroll `$effect` (§7.3). *(Spike S2.)*
6. **Delta volume:** implement §8.1 — **A** (volatile `journal.broadcast` + `sessions.ts` routing + client
   volatile-frame handling) or, for a first cut, **B** (coalescing buffer in `claudeDriverFor` onEvent).
7. **Optional:** `message_delta` → `emitTokens` for a smoother live counter (§3).
8. **Cleanup on turn-end:** clear `streamMsgId`/`streamTick` on idle/stopped/error in the `session/status` and
   `claude/result` handlers.

## 10. Tests (mirror `store.test.ts`)

The test harness drives the private `apply(event)` directly with synthetic `HubEvent`s (store.test.ts:59–65).
Add cases:

- **Streams into one item:** seed a claude session; feed `claude/stream_event` `message_start{message.id:'m1'}`,
  `content_block_start{index:0,content_block:{type:'text'}}`, three `content_block_delta{index:0,
  delta:{type:'text_delta',text:…}}`, then `claude/assistant{message:{id:'m1',content:[{type:'text',text:'<full>'}]}}`.
  Assert **exactly one** `assistant` item, `text === '<full>'`, keyed `claude:m1:0`.
- **No streaming (fallback):** feed only the final `claude/assistant` → one item with the full text (today's path).
- **Thinking marker:** stream a thinking block (start + `signature_delta` only) + final thinking block with empty
  `thinking` → one `thinking` item, `text===''` → renders `✦ reasoned`; assert signature never lands in `text`.
- **Reflex:** message with `[tool_use]` and no thinking → tool item `reflex===true`; message with
  `[thinking, tool_use]` → `reflex===false`.
- **Replay (option B):** replay the same delta stream twice / from seq 0 → still one item, correct text (dedup by
  key). For option A, assert delta frames are volatile (not journaled) and the final assistant alone rebuilds it.
- **Multi-message:** two `message_start`s (`m1`,`m2`) each with a text block → two distinct items
  `claude:m1:0`, `claude:m2:0`.

---

## 11. Spikes / things to confirm live

- **S1 (blocking dedup):** under **subscription** auth, does `message_start.event.message.id` equal the final
  `assistant` message's `message.id`, and are content-block indices stable between the stream and the final
  `content[]`? The §4.3 keying depends on it; §4.3 fallback if not.
- **S2 (scroll):** does the current ThreadView scroll effect actually follow Codex's growing text today, or does
  it only snap on item push? Confirms whether §7.3 is a fix or a new feature (it is needed either way for
  token-level Claude deltas).
- **S3 (stream shape under Claude Code proxy):** capture a real `claude/stream_event` sequence on a subscription
  account and confirm the field paths in §2 (esp. that `text_delta.text` and `message_start.message.id` are
  populated, and whether any extra wrapping is added by the CLI vs. the raw Anthropic API). Journal a few turns
  with option **B** disabled to inspect the verbatim wire shape before choosing A vs B.
- **S4 (delta cadence):** measure deltas-per-second on a representative turn to size the coalescing window (§8 B)
  and confirm the journal-bloat estimate that motivates option A.
