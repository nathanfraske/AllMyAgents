# CEC AiMesh — Visual Polish Backlog

A prioritized, concrete list of **visual/aesthetic** modernization work for the web frontend
(`apps/web/src`). Scope is strictly look-and-feel: color, type, spacing, borders/radii/shadows,
component polish, motion, iconography. Interaction/UX (keyboard nav, flows, copy) is owned by a
separate audit and is deliberately out of scope here.

**How to read this**
- **Priority** — `P0` foundational (do first; most items below reference these tokens), `P1` high-value
  per-surface polish, `P2` nice-to-have.
- **Impact** — High / Med / Low (visible "premium" lift).
- **Effort** — S (≤1h, usually a token swap that cascades), M (a component pass), L (multi-file / new markup).
- File paths are relative to `apps/web/src`.

**The one-line diagnosis:** the bones are good (coherent dark palette, thoughtful motion vars, real
status system) but everything is expressed with **ad-hoc per-component values** — ~11 distinct border
radii, 3 one-off shadows, ~19 font sizes, opaque flat borders, and elevation carried by background
color alone. The result reads slightly "skeleton/flat." The single highest-leverage move is to
introduce a **token layer** (below) and then refactor components onto it. Most P0 items are one edit
to `app.css` that improves every surface at once.

---

## 0. Design-system tokens (do these first)

Add to `:root` in `app.css`. These are referenced by nearly every item further down.

### 0.1 — `P0` Elevation & shadow scale · Impact High · Effort S
There is currently **no shadow token** and cards rely on background color for depth, so everything
sits on one visual plane. Add a calibrated scale (tuned for the near-black `--bg #070711`, where
shadows must be deep + soft) plus a **top-edge highlight** — the key trick that makes dark cards feel
"lifted" rather than "drawn":

```css
--shadow-1: 0 1px 2px 0 rgba(0,0,0,.40);
--shadow-2: 0 2px 6px -1px rgba(0,0,0,.45), 0 1px 2px rgba(0,0,0,.30);
--shadow-3: 0 8px 24px -6px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.35);   /* dropdowns, tooltip */
--shadow-4: 0 24px 60px -12px rgba(0,0,0,.65), 0 8px 20px rgba(0,0,0,.40); /* modal */
--edge-hi: inset 0 1px 0 0 rgba(255,255,255,.05);  /* subtle top highlight on raised surfaces */
```
Then: menus/tooltip → `--shadow-3` (replaces the three inconsistent `0 8px 28px / 0 10px 30px`
one-offs), modal → `--shadow-4` (replaces `0 24px 70px`), cards/tiles/composer → `--shadow-2` +
`--edge-hi`. This alone is the biggest single "flat → premium" jump.

### 0.2 — `P0` Radius scale · Impact High · Effort S
Radii in use today: `3,4,5,6,7,8,9,10,12,14,16,999px` — eleven values, no system (pills are 8, menus
10, cards 12, composer 14; `7px` appears on ~10 unrelated elements). Collapse to a 6-step scale:

```css
--r-xs: 4px;    /* badges, tiny chips, calendar keys */
--r-sm: 6px;    /* mini icon buttons, inline code, scrollbar thumb */
--r-md: 8px;    /* buttons, inputs, pills, list rows, tool cards */
--r-lg: 12px;   /* cards, tiles, dropdown menus, panels */
--r-xl: 16px;   /* composer, modal, drop ghosts */
--r-pill: 999px;
```
Migration: `3,4,5→--r-xs/sm`, `6,7,8→--r-md`, `9,10→--r-lg`, `12→--r-lg`, `14,16→--r-xl`, `999→--r-pill`.
Slightly larger, consistent corners read markedly more modern.

### 0.3 — `P0` Modern border system (translucent hairlines) · Impact High · Effort S
**This is the user's explicit "nicer, more modern borders" ask.** Current borders are opaque, mid-value
purple (`--border #303049`, `--border-strong #4a486d`) — only two steps, and opaque borders look muddy
where they cross different surfaces. Switch to **translucent white hairlines** (the Linear/Vercel/Geist
look): they render as a consistent 1px edge over any background and pick up a hint of the surface beneath.

```css
--border-subtle:  rgba(255,255,255,.06);  /* dividers, table row lines */
--border:         rgba(255,255,255,.10);  /* default card / input edge */
--border-strong:  rgba(255,255,255,.16);  /* hover, emphasized, menus */
--border-accent:  color-mix(in srgb, var(--accent) 55%, transparent); /* focused / active */
```
Keep the current names so existing `var(--border...)` references just inherit the new look. If you want
to retain brand identity in the edge, mix a little accent in (`color-mix(in srgb, var(--accent) 10%,
rgba(255,255,255,.10))`). Pair raised cards with `--edge-hi` (0.1) for a crisp lit top edge.

### 0.4 — `P0` Spacing scale (4px grid) · Impact Med · Effort S
Padding/gap values are currently freeform (`0.15/0.2/0.28/0.32/0.35/0.45/0.55/0.6/0.7/0.8/0.9…rem`),
so nothing aligns to a rhythm. Adopt an 8-step scale on a 4px grid (rem is relative to the 16px root, so
these are exact):

```css
--space-1: .25rem;  /* 4  */   --space-2: .375rem; /* 6  */
--space-3: .5rem;   /* 8  */   --space-4: .75rem;  /* 12 */
--space-5: 1rem;    /* 16 */   --space-6: 1.25rem; /* 20 */
--space-7: 1.5rem;  /* 24 */   --space-8: 2rem;    /* 32 */
```
Snap component paddings to the nearest step during each surface pass. Biggest wins: composer, cards,
sidebar rows, dashboard sections.

### 0.5 — `P0` Type scale + numeric alignment · Impact High · Effort M
~19 distinct font sizes today (down to `0.6rem` ≈ 8px on badges/chevrons/legend — too small). Define a
capped scale with a **legibility floor of 11px**, and standardize label tracking (currently three
values: `0.04/0.06/0.08em`) to one:

```css
--text-2xs: .6875rem; /* 11px — hard floor; micro-labels, badges */
--text-xs:  .75rem;   /* 12px — meta, times, hints */
--text-sm:  .8125rem; /* 13px — secondary UI text */
--text-base:.875rem;  /* 14px — body / transcript (bump from 13.5px, easier long-form read) */
--text-md:  1rem;     /* 16px — emphasis */
--text-lg:  1.125rem; /* 18px — modal/panel titles */
--text-xl:  1.375rem; /* 22px — dashboard greeting */
--text-2xl: 1.75rem;  /* 28px — big stat numbers */
--ls-label: .06em;    /* single uppercase-label tracking */
--fw-medium: 500; --fw-semibold: 600;
```
Also add **`font-variant-numeric: tabular-nums`** to every changing numeric readout — the live elapsed
timer + token counter in `ThreadView` (updates every 250ms), `ContextMeter` %, usage percentages,
dashboard stat tiles, relative times. Prevents digit-width jitter. High polish-per-effort.

### 0.6 — `P0` Focus-ring token + apply everywhere · Impact High (a11y+polish) · Effort M
Custom `<button>`s have **no `:focus-visible` styling at all** — keyboard focus is invisible across the
whole app. Inputs only shift border color. Add a ring token and a global rule:

```css
--ring: 0 0 0 3px color-mix(in srgb, var(--accent) 32%, transparent);
```
```css
:where(button, a, [role="button"], input, select, textarea):focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-color: var(--border-accent);
}
```
For inputs, prefer border-color + ring together for the glow. This is table-stakes for "premium."

### 0.7 — `P0` Motion token cleanup · Impact Low · Effort S
Good motion vars exist (`--ease`, `--ease-out`, `--dur 190ms`, `--dur-slow 240ms`) but several places
hardcode durations: `Sidebar` uses `transition: … 0.12s` (`.icon`, `.gadd`), menus animate `0.12s`,
`fade-in 0.22s`, modal `0.15/0.16s`. Add `--dur-fast: 120ms;` and replace all literals with tokens so
timing is coherent and one edit re-tunes the whole app.

### 0.8 — `P1` Refined surface ramp (optional, deeper polish) · Impact Med · Effort S
The five-step surface ramp (`--bg → --sidebar → --surface → --surface-2 → --surface-3`) is heavily
purple-saturated and the middle steps sit close in luminance. Consider nudging steps to more even
luminance spacing and letting **shadow + border + `--edge-hi` carry elevation** instead of only bg
lightness. Lightly desaturating `--surface-2/-3` (e.g. toward `#1c1b2e / #272640`) reduces the "plastic
purple" cast while keeping brand. Validate against every card before committing.

---

## 1. Global primitives (`app.css`)

### 1.1 — `P0` Unify buttons into a token'd set · Impact High · Effort M
Buttons are re-implemented per component: `.pill-btn`, `.send-btn`, `.mkbtn`, `.primary` (×2, defined
separately in `Dashboard` and `SettingsModal`), `.back`, `.foot-act`, `.abtn`, `.hbtn`, `.mini`,
`.icon`, `.gear`, `.browse`, `.btn`. Primary accent buttons hardcode `color:#fff` in four places.
Define a small global system and delete the duplicates:
- `.btn` (base: `--r-md`, `--space-2/--space-4` padding, `--text-sm`, `--edge-hi`, transitions).
- `.btn-primary` (accent bg, white text, `filter:brightness(1.08)` hover — already the SettingsModal
  pattern; make it the one source of truth).
- `.btn-ghost` (transparent → `--surface-2` hover; for icon/toolbar buttons).
- `.btn-danger` (bad).
- `.btn-icon` (square, `place-items:center`, `--r-sm`) — replaces `.icon/.gear/.hicon/.mini/.qx/.x`.
Consistent sizing/hover/press across the app is a major coherence win.

### 1.2 — `P0` Unify iconography — kill the glyph/emoji mix · Impact High · Effort M
The app mixes a clean stroked **Lucide** set (`Icon.svelte`) with raw unicode/emoji glyphs whose weights
and metrics clash: chevrons `▾ ▸`, actions `◼ ✕ ×`, send/queue/steer `↑ ⏲ ⤵`, summary `▶ ⚑ ✓`,
permission `🔒 ✎ ⚡`, traits `⚡`, model glyph square, `▣` in the checkout row. Emoji especially render
full-color and inconsistent per-OS. Add the missing paths to `Icon.svelte`
(`chevron-down, square, x, arrow-up, timer, corner-down-right, check, flag, play, lock, pencil, zap,
columns…`) and replace every glyph. This is one of the biggest "feels hand-assembled → feels designed"
levers in the whole audit.

### 1.3 — `P1` Status-dot polish · Impact Low · Effort S
`app.css` dots are solid — the `.dot.stopped` color is a hardcoded `#3a3958` (should be a token, e.g.
`--dim`/`--surface-3`). Give resting dots a faint ring for definition on busy rows
(`box-shadow: 0 0 0 1px rgba(255,255,255,.08)`), and consider a soft outer glow on the pulsing states
(working/approval/question) using the state color at low alpha, so "live" agents read at a glance.

### 1.4 — `P1` Pills (`.pill-btn`) refresh · Impact Med · Effort S
Composer pills are the most-touched control cluster. Move to `--r-md`, `--edge-hi`, and swap the text
`▾` chevron for the Lucide `chevron-down` at a fixed 12px with `opacity:.6`. Add a pressed/open state
(`--surface-3` bg + `--border-strong`) so an open picker's trigger stays visibly "active."

### 1.5 — `P2` Scrollbar refinement · Impact Low · Effort S
`.scroll` thumb is `--surface-3` at 9px. Make it a touch thinner (8px), use a translucent thumb
(`rgba(255,255,255,.12)`) that brightens on hover, and add `scrollbar-width: thin; scrollbar-color:` for
Firefox parity.

---

## 2. Sidebar (`lib/Sidebar.svelte`)

### 2.1 — `P1` Active-row accent rail · Impact Med · Effort S
Selected chat (`.row.sel`) only shifts to `--surface-2` — very subtle, and the brand accent never marks
the active item. Add a 2px accent rail: `.row.sel { box-shadow: inset 2px 0 0 var(--accent); }` (or a
`::before` bar) and give the label `--fw-medium`. Matches Linear/t3.chat active states.

### 2.2 — `P1` Row density & hover consistency · Impact Med · Effort S
Row padding is asymmetric (`.32rem .45rem .32rem .6rem`) and hover uses `--surface` while selected uses
`--surface-2`, so hovering a selected row *darkens* it. Snap padding to `--space` tokens, make hover
`--surface-2` and selected `--surface-2 + accent rail` so states layer correctly.

### 2.3 — `P1` Brand lockup polish · Impact Low · Effort S
`.logo` is a 14px accent→cyan gradient square; the `fleet` tag is a bordered micro-caps chip. Give the
logo a subtle glow (`box-shadow: 0 0 12px -2px color-mix(in srgb, var(--accent) 60%, transparent)`) and
round it to `--r-sm`. Tokenize the `.conn` dot colors (`--ok`/`--bad`) and add the resting ring from 1.3.

### 2.4 — `P1` Collapsed-group summary chips · Impact Med · Effort S
The collapsed-group summary line (`.sc.working/review/done/stalled`) uses mono text + glyphs
(`▶ ⚑ ✓ ✕`). Convert to small count-pills with the Lucide icon + number, colored per state, so a folded
project reads as a tidy row of status chips rather than mixed glyphs.

### 2.5 — `P2` Section headers · Impact Low · Effort S
`PROJECTS`/`USAGE` headers use `--text-2xs`, `--ls-label`, `--dim`. Fine — just route through the new
tokens and align the folder toggle (`▸/▾`) onto the Lucide `chevron` for weight consistency (see 1.2).

### 2.6 — `P2` Footer usage divider · Impact Low · Effort S
`.footer` uses `border-top: 1px solid var(--border)`; switch to `--border-subtle` so the usage panel
feels attached rather than boxed-off.

---

## 3. ThreadView — header (`lib/ThreadView.svelte`)

### 3.1 — `P1` Header hierarchy & spacing · Impact Med · Effort S
The head row crams logo, title, status chip, model sub, worktree, split, close. Group into left
(identity: logo + title + status chip) and right (meta + actions) with `--space` gaps; make the title
`--text-md/--fw-semibold` and demote `.sub`/`.wt` to `--text-xs --dim`. Add a subtle bottom shadow under
the header on scroll (`--shadow-1`) so it reads as a sticky bar.

### 3.2 — `P1` Status chip polish · Impact Low · Effort S
`.statuschip` is a good bordered pill, but on colored states it sets both text *and* full border to the
state color, which can vibrate. Use a tinted background instead:
`background: color-mix(in srgb, currentColor 12%, transparent); border-color: color-mix(in srgb,
currentColor 35%, transparent);` per state — softer, more modern, still legible.

### 3.3 — `P2` Dead CSS cleanup · Impact Low · Effort S
`.hbtn` and `.mode` are defined in `ThreadView`'s `<style>` but not used in markup. Remove during the pass.

---

## 4. ThreadView — transcript / ItemCard (`lib/ItemCard.svelte`)

### 4.1 — `P1` De-box assistant messages (modern chat feel) · Impact High · Effort M
Both user and assistant messages are rounded boxes (`.msg.assistant` surface+border, `.msg.user` accent
tint), so the transcript is a monotonous stack of near-identical rectangles. Follow the ChatGPT/Claude
pattern: render **assistant text flush** (no card, just the text column) and keep **only the user turn
in a subtle bubble**. Instantly reduces visual noise and increases reading comfort. Replace the tiny
uppercase `who` label with a small provider glyph (assistant) / nothing or "You" (user).

### 4.2 — `P1` Transcript reading typography · Impact Med · Effort S
Message `.text` inherits the 13.5px base at line-height 1.5. For long-form output set `--text-base`
(14px) at line-height 1.6, and cap measure (the `.stream` already maxes at 900px — good). Small bump,
noticeably comfier reads.

### 4.3 — `P1` Tool-call card refinement · Impact Med · Effort S
`.tool` cards are fine but the header mixes `▸/▾` glyph + mono tool name + `reflex`/`error` tags. Route
the disclosure to Lucide `chevron`, give `.io`/`.io.out` a hairline (`--border-subtle`) and `--r-sm`,
and use a left accent border for errored tools instead of recoloring the whole box border. Add
`--edge-hi` to the card. The `reflex-tag` and `.fail` are good as-is.

### 4.4 — `P2` Reasoning/thinking treatment · Impact Low · Effort S
`.think` is a left-border quote (good). The empty-reasoning `✦ reasoned` line uses a glyph — swap `✦`
for a small Lucide `sparkles`/`star` and route through `--text-xs`. Consider a very faint background on
open thinking bodies to distinguish from assistant prose.

### 4.5 — `P2` (flag) Markdown not rendered · Impact Med · Effort L
Assistant/user `.text` is raw `white-space: pre-wrap`, so markdown (`**bold**`, backticks, lists, code
fences) shows as literal source — a real "unpolished" tell. Likely owned by the content/interaction
pipeline, noted here for visual completeness: rendering markdown (with code blocks styled via the
existing `--mono` + `--bg` treatment) would sharply raise transcript quality.

---

## 5. ThreadView — composer

### 5.1 — `P0` Focus-within glow on the composer · Impact High · Effort S
The composer (`.composer`, `--surface` + `--border-strong` + `--r-xl`) never reacts when you click into
the textarea — it looks inert. Add:
```css
.composer:focus-within { border-color: var(--border-accent); box-shadow: var(--ring), var(--edge-hi); }
```
This is the single most-used surface in the app; making it "light up" on focus is a big perceived-quality win.

### 5.2 — `P1` Composer elevation & footer rhythm · Impact Med · Effort S
Give the composer `--shadow-2 + --edge-hi` to lift it off the transcript. The `.cfoot` pill row can get
crowded (account, model, traits, permission, spacer, interrupt, stop, send) — set consistent `--space-2`
gaps, and visually separate the destructive `interrupt`/`stop` from the pills with a thin
`--border-subtle` divider before them.

### 5.3 — `P1` Send button states · Impact Low · Effort S
`.send-btn` is a solid 32px accent circle (good). Swap the `↑/⏲/⤵` glyphs for Lucide
`arrow-up`/`timer`/`corner-down-right` (see 1.2), add `--shadow-1` + hover `brightness(1.08)` and a
tiny active `scale(.94)` press. The `.queue` (warn) variant is good — keep.

### 5.4 — `P1` Approval & queue cards · Impact Med · Effort S
`.approval` (warn border) and `.queue` (dashed border) are functional but heavy. Give both `--r-lg` +
`--edge-hi`; for `.approval` use a warn **tint background** (`color-mix(in srgb, var(--warn) 8%,
var(--surface))`) + left accent bar rather than a full warn border, so a pending approval reads as
"highlighted" not "alarming-boxed." Style `.abtn.ok`/decline via the global button set (1.1).

### 5.5 — `P2` Checkout meta row · Impact Low · Effort S
The `.checkout` row (`▣ worktree · id`) uses the `▣` glyph and `--dim` at 0.72rem. Swap `▣` for a Lucide
`git-branch`/`box` and route text through `--text-xs` + tabular-nums for the id.

---

## 6. ContextMeter (`lib/ContextMeter.svelte`)

### 6.1 — `P1` Smooth the conic ring + registered property · Impact Low · Effort S
The 14px conic ring is a nice touch but `--p` can't transition (custom prop is untyped). Register it so
it animates on context change:
```css
@property --p { syntax: '<number>'; inherits: false; initial-value: 0; }
.ring { transition: --p var(--dur-slow) var(--ease); }
```
Bump ring to 16px, add a faint inner hole (`box-shadow: inset 0 0 0 3px var(--surface)`) for a cleaner
"gauge" look, and give the `.tok` readout tabular-nums.

### 6.2 — `P2` Hot-state affordance · Impact Low · Effort S
At `>90%` it switches to warn — good. Add a subtle pulse (reuse the dot `pulse` keyframe) when hot so
near-full context is noticeable in a busy split view.

---

## 7. Dashboard — hero & tiles (`lib/Dashboard.svelte`)

### 7.1 — `P1` Ambient hero glow (kills the flat void) · Impact Med · Effort S
The dashboard sits on flat `--bg`. Add one soft radial accent glow behind the hero for depth:
`radial-gradient(60% 40% at 20% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent)`
on `.dashwrap` (fixed, non-scrolling). Low effort, high "premium landing" payoff. Enlarge the hero logo
glow to match 2.3.

### 7.2 — `P1` Stat tiles: equal grid + elevation · Impact Med · Effort S
`.tiles` is `flex-wrap` so tiles ragged-wrap and the `.split` (two provider counts) tile is a different
shape/height. Switch to `grid-template-columns: repeat(auto-fit, minmax(120px,1fr))` with equal
`min-height`, give tiles `--shadow-2 + --edge-hi`, and make the big `.num` `--text-2xl` mono +
tabular-nums. Keep the existing `translateY(-2px)` hover but add `--shadow-3` on hover for a real lift.

### 7.3 — `P2` Card headers · Impact Low · Effort S
`.card h3`/`.detail h3` micro-caps headers are good; route through `--text-2xs`, `--ls-label`, `--dim`
and add `--space-4` bottom margin consistently (currently `0.8rem`).

---

## 8. Dashboard — calendar heatmap

### 8.1 — `P1` Dim the empty cells · Impact Med · Effort S
Zero-activity cells use `--surface-3 (#2a2942)` — quite bright, so the whole grid looks "half-full."
GitHub keeps empties barely above bg. Use `color-mix(in srgb, var(--accent) 5%, var(--surface))` or a
dim `--surface-2` for zero, and steepen the ramp so real activity pops. This makes the heatmap actually
read as a heatmap.

### 8.2 — `P1` Softer hover/selected outline · Impact Med · Effort S
Hover is `outline: 1px solid var(--text)` (pure white — harsh) and selected is `2px solid var(--text)`.
Replace hover with `outline: 1px solid var(--border-strong)` (or a 1px accent ring) and selected with
`2px solid var(--accent)` + slight `scale(1.15)`. Brand-consistent and less jarring.

### 8.3 — `P2` Axis labels · Impact Med · Effort M
No month labels along the top or weekday labels down the side — the grid is hard to date. Add a thin
month-label row (reuse `monthLabel`) and Mon/Wed/Fri side labels like GitHub. Route cells through
`--r-xs` and consider 4px gap for breathing room.

---

## 9. Dashboard — project bars, day detail, tooltip

### 9.1 — `P1` Project usage bars · Impact Low · Effort S
`.pbar` (6px, `--surface-3` track, cyan→accent `.pfill` gradient) is decent. Give the fill rounded caps
(`border-radius: inherit` already via overflow — ensure the fill itself is `--r-pill`), a subtle inner
highlight, and animate width via the existing transition. Route `.pmeta` numbers through tabular-nums.

### 9.2 — `P1` Day-detail panel · Impact Low · Effort S
`.detail` (sticky) and its `.dstat` sub-cards (`--surface-2`, `--r-lg`) are good — apply `--edge-hi`,
tokenize radii, and give `.dstat .num` tabular-nums. The `.drow` project rows use `--border` top
dividers; switch to `--border-subtle`.

### 9.3 — `P2` Hover tooltip · Impact Low · Effort S
`.tip` uses a one-off `0 10px 30px` shadow → `--shadow-3`; tokenize radius to `--r-lg`. The `pop-in`
micro-motion is already nice. Numbers → tabular-nums.

---

## 10. Usage panel (`lib/Usage.svelte`)

### 10.1 — `P1` Usage bars & cards · Impact Med · Effort S
Bars are thin (5px, `--surface-3` track, flat `--accent` fill). Give the fill a subtle gradient
(`linear-gradient(90deg, var(--accent), var(--accent-hover))`), rounded caps (`--r-pill`), and animate
width. Route `.card` through `--r-md` + `--border-subtle` (these are dense nested cards — a lighter edge
reduces clutter). The `hot` (warn) state is good.

### 10.2 — `P1` Percent/label numerics · Impact Low · Effort S
Percentages and reset timers (`resetIn`) update live — apply tabular-nums and route the tiny `.small`
text to the `--text-2xs` floor (some are currently `0.66rem` ≈ 10.5px, below the legibility floor).

### 10.3 — `P2` Overage / blocked emphasis · Impact Low · Effort S
`.tag.bad` (overage) and `.card.blocked` recolor the border to `--bad`. Prefer a bad **tint background**
+ subtle border so a blocked account reads as a filled alert chip, consistent with 3.2/5.4.

---

## 11. Pickers / dropdown menus (`ModelPicker`, `AccountPicker`, `TraitsControl`, `PermissionPicker`)

### 11.1 — `P0` Consolidate the four near-identical menus · Impact Med · Effort M
All four re-declare the same `.wrap/.scrim/.menu/.row/.opt/.chev` CSS (menu: `--surface-2`,
`border-strong`, `--r-lg`, one-off `0 8px 28px` shadow, `pop-in`). Extract shared menu/scrim/option
classes to `app.css` (or a tiny shared style), route the shadow to `--shadow-3`, radius to `--r-lg`,
options to `--r-md`. One source of truth = consistent menus and less drift.

### 11.2 — `P1` Selected/hover option states · Impact Low · Effort S
Selected options use `--surface-3` bg (Model/Account) but Account/Traits/Permission also recolor text to
`--accent` — inconsistent. Standardize: hover `--surface-3`, selected `--surface-3` + `--fw-medium` +
a small accent `check` icon (Lucide) on the chosen row, rather than accent-coloring the whole label.

### 11.3 — `P1` Badges (New/Default) · Impact Low · Effort S
`.badge.new`/`.badge.def` are 0.6rem (≈8px) bordered chips — too small. Bump to `--text-2xs`, `--r-xs`,
and use a warn **tint** for "New" (`color-mix warn 15%`) instead of a hairline outline so it reads as a
proper badge.

### 11.4 — `P1` PermissionPicker & TraitsControl glyphs · Impact Med · Effort S
Permission modes use emoji `🔒 ✎ ⚡` and Traits uses `⚡` — full-color, OS-dependent, clashing with the
stroked set. Replace with Lucide `lock`/`pencil`/`zap` (see 1.2). The `.full` warn state on the pill is
good; keep it.

---

## 12. SettingsModal (`lib/SettingsModal.svelte`)

### 12.1 — `P1` Modal shell polish · Impact Med · Effort S
Modal is solid (backdrop blur(3px), `--surface`, `--r-xl`, big shadow). Route shadow → `--shadow-4`,
bump backdrop blur to ~6px, and add `--edge-hi`. The `×` close glyph → Lucide `x` via `.btn-icon` (1.1).
Consider a subtle top accent hairline on the header.

### 12.2 — `P1` Form controls & sections · Impact Med · Effort S
Inputs/selects use the global default (`--surface-2`, `--border-strong`, `--r-md`) — fine, but they get
no focus ring beyond border color; 0.6 fixes this globally. Snap section gaps to `--space-7`, route
section `h3` micro-caps through `--text-2xs/--ls-label`. The `.cmd` code block (cyan on `--bg`) is a nice
touch — give it `--border-subtle` + `--r-md`.

### 12.3 — `P2` Account rows & status messages · Impact Low · Effort S
`.acct` rows (`--surface-2`) → `--r-md` + `--edge-hi`. The login `.status.waiting/done/error` and mesh
`.mstate` messages are colored text; consider small leading status dots (reuse the `.dot` system) for
scannability. Buttons already route through `.btn`/`.btn.primary` — make that the canonical primary (1.1).

---

## 13. Split-view, drag ghosts & resize handles (`App.svelte`)

### 13.1 — `P1` Resize handles · Impact Med · Effort S
`.handle/.pane-handle/.row-handle` are invisible until hover, then flip to a solid `--accent` bar —
abrupt. Show a faint `--border-subtle` line at rest and transition to a **2px accent** on hover/active
with the existing `--dur` transition, so panes look intentionally divided and the grab affordance is
discoverable.

### 13.2 — `P1` Drop ghosts · Impact Low · Effort S
`.ghost-pane/.ghost-row` (2px dashed accent + accent-12% fill, `--r-lg/xl`) are good. Tokenize radii,
and add the `ghost-in` scale motion you already have. Consider a soft accent glow
(`box-shadow: 0 0 0 1px color-mix(accent 30%), 0 8px 24px -8px color-mix(accent 40%)`) so the target
reads as "live."

### 13.3 — `P2` Empty drop state · Impact Low · Effort S
`.empty.dropping` uses a dashed outline + accent text — fine. Route radius to `--r-xl`, add the Lucide
`columns`/`plus` icon above the "drop to open this chat" copy for a friendlier empty target.

---

## 14. Cross-cutting

### 14.1 — `P0` Contrast & minimum type size audit · Impact High (a11y) · Effort M
`--dim (#797987)` on `--surface (#161526)` is ~3.4:1 — below the 4.5:1 WCAG AA floor for normal text —
yet it's used heavily for the *smallest* text (times, counts, hints, meta at 0.66–0.72rem ≈ 10–11px).
Two fixes: (a) lighten `--dim` toward ~`#8b8b9c` (≈4.5:1), and (b) enforce the `--text-2xs` (11px) floor
so nothing renders below 11px (badges, chevrons, legend, `.small` usage text currently dip to 8–10.5px).
Legibility is a core part of "premium."

### 14.2 — `P1` Accent restraint pass · Impact Med · Effort M
Magenta `--accent` currently carries: primary buttons, focus, links, selected-menu text, user-message
tint, calendar heatmap, context ring, project/usage fills, logo gradient, drag ghosts, active handles.
It's loud and everywhere. Once tokens land, audit each use: keep accent for **primary action + active
selection + brand marks**, and shift secondary data-viz fills toward `--cyan`/`--secondary` (or a
desaturated accent) so the magenta regains impact where it matters. Restraint is what separates
"branded" from "over-saturated."

### 14.3 — `P2` Consistent enter/exit motion · Impact Low · Effort S
`fade-in`/`pop-in`/`pane-in`/`ghost-in`/`modal-in` are all defined separately with slightly different
values. Consolidate to 2–3 shared keyframes routed through `--dur`/`--ease`, all already correctly
gated behind `prefers-reduced-motion` (keep that). Add a gentle enter to newly-arrived transcript items
(the `.stream > * { animation: fade-in }` is a good start — ensure it doesn't re-fire on every scroll).

---

## Suggested sequencing

1. **Token foundation** — §0.1–0.7 (one `app.css` pass). Everything below leans on these.
2. **Global primitives** — §1.1 buttons, §1.2 iconography, §0.6 focus rings. Highest coherence-per-hour.
3. **Composer + transcript** — §5.1 focus glow, §4.1 de-box, §5.2–5.4. The most-viewed surface.
4. **Sidebar** — §2.1 active rail, §2.2 density.
5. **Dashboard + heatmap** — §7.1–7.2, §8.1–8.2.
6. **Menus, Usage, Settings, Split-view** — §11, §10, §12, §13.
7. **Cross-cutting sweeps** — §14.1 contrast, §14.2 accent restraint, tabular-nums everywhere.
