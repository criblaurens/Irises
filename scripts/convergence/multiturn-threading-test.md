# Multi-turn threading test (web:thr-1) — SPEC, unrun

The hand-run half of phase E's verification round. `threadBattery.ts` beside this file measures the
QUIET — the turns where conversational threading must do nothing. This measures the other half: the
turns where it must do something, and whether what it does sounds like a person rather than a filing
system. No machine can score that, which is why this is a transcript to be run by hand and read by a
person, in the format of `results/multiturn-research-test.md`.

**This file is a SPEC, not a result.** Nothing here has been run. When it is run, the transcript,
the per-turn receipts and the findings go to `results/multiturn-threading-test.md` — a new file, in
the results directory, alongside the other rounds. This one stays as the script.

- Chat: `web:thr-1` (clientId `thr-1`). Memory handle: whatever `WEB_DEBUG_HANDLE` is, default
  `web:guest`.
- **The handle, not the chat, owns the inventory.** `thread_inventory` is keyed by handle and every
  web client shares one, so this run and any `threadBattery` round are writing into the same row.
  Run this transcript FIRST; run the battery warm against what it built.
- Requires `CONVO_THREADING_ENABLED=true` on an instance rebuilt and restarted from this tree.
  T16 additionally requires `THREADING_PINGS_ENABLED` on (the default since 2026-09-27) — see T16.

---

## Reachability — read this before running

The plan's beat list is denser than the engine's own budgets allow, and running the script without
knowing that produces a transcript full of turns that look like failures and are not. Every number
below is from `src/persona/threads.ts`.

**The turn gate is one shared counter.** `turnsSinceOffer` is global across both materials and ANY
offer resets it (`THREAD_MIN_TURNS_BETWEEN_OFFERS = 4`, `LOOP_MIN_TURNS_BETWEEN_OFFERS = 2`). The
turn immediately after an offer also returns `awaiting_outcome` — one thing in flight, globally. So
a theme offer costs five turns and a loop offer costs three, minimum. Sixteen turns fund **four**
offers. The plan asks for roughly six.

**A loop can only surface at the start of a session.** `LOOP_OPENING_GAP_MS = 4h` is measured against
the real gap before the incoming message, so at most ONE loop question exists per session, on its
first turn — and because the loop stage wins outright over themes, a session that opens with an
eligible loop cannot open with a tag instead.

**The `pattern` rung is unreachable in a short run.** `rungCeilingFor` drops to `fact` while
`harvestCount < THREAD_TENURE_TURNS (60)`. Sixteen turns on a fresh handle end at 16. Every theme
delivered in this script therefore renders `THREAD_THEME_FACT_BLOCK`, which is correct behaviour and
is what T12 is about — but it means the pattern-rung prose is NOT exercised here. To see it, run
against a handle with 60+ harvested turns behind it.

**Shorthand needs three uptakes, each on its own offer, each ≥72h apart.** Graduation wants
`status === 'taggable' && uptakes >= 3 && confidence >= 75`, and `THEME_COOLDOWN_TOOK_MS = 72h`
separates a theme's offers once one has been taken up. Confidence walks 25 → 35 (second evidence
day) → 50 → 65 → 80. That is three offer/outcome cycles across at least six days: **T15 cannot be
reached cold.**

### What a cold 16-turn run actually reaches

| plan beat | reachable | where it really lands |
|---|---|---|
| T1 greeting control | yes | T1 |
| T2–T3 mints | yes | T2 (theme A), T3 (loop L1) |
| T4 venting, loop minted silently | yes | T4 (loop L2) |
| T5–T6 tag → pass → cheerful drop | yes, shifted one | theme A only becomes `taggable` in T5's HARVEST, so the offer is T6 and the outcome T7 |
| T7–T8 tag → pushback → sore | **no** | needs a second taggable theme AND a free turn gate; earliest is day 3 |
| T9 sensitive theme minted distressed | yes | T8 (a gated turn is the right home for a mint) |
| T10 opening loop callback | yes | T11 (session 3's first turn) |
| T11 resolution via `resolved:` | yes | T12 |
| T12 sensitive-at-fact-level | yes, one only | T15 |
| T13 bait / climb | yes — needs no offer | T10 |
| T14 operative fact | yes — needs no offer | T9 |
| T15 shorthand graduation | **no** | seed required (below) |
| T16 thread_revisit ping | flag + seed | phase F is on by default, but the ping window needs a seeded `lastSeenAt` |

The script below keeps the plan's T-numbers as the intent line and states, per turn, the gate state
it should actually be in. Two beats are marked SEEDED; run them only after seeding, and say so in
the results file.

### Seeding recipe

The engine reads `now` from the wall clock and everything else from stored stamps, so a gap is
simulated by moving the stamps BACKWARD, never by moving the clock. Stop the instance first (the row
is read-modify-written per turn) and shift **every** stamp together, or the row becomes internally
inconsistent:

- `thread_inventory` themes: `evidenceDays[]` (UTC day numbers — `floor(ms / 86400000)`, so they
  shift by whole days, not by milliseconds), `firstSeenAt`, `lastSeenAt`, `lastOfferedAt`,
  `lastTaggedAt`, `soreAt`.
- `thread_inventory` loops: `capturedAt`, `lastSeenAt`, `offeredAt`, `askedAt`, `resolvedAt`.
- `thread_inventory` row: `offers[].at`, `pending.at`, `last_harvest_at`, `last_ping_at`,
  `updated_at`.
- `messages.created_at` for `web:thr-1` — this is where `gapMs` comes from (the last stored
  message's stamp), and it is the loop stage's opening gate.
- `affect_state.status_json`'s `at` is a SEPARATE clock. Selection only consults affect that is
  `≤ AFFECT_FRESH_MS (6h)` old, so leaving it unshifted makes every mode/mood gate stand down —
  which is right for a simulated day gap and wrong if you are trying to test the mode gate. Shift it
  when you want the gate armed.

For **T15** (shorthand), seed the target theme to `status: "shorthand"` with `uptakes: 3`,
`confidence: 80`, `lastOfferedAt` more than 24h back (`THEME_COOLDOWN_SHORTHAND_MS`), and
`turns_since_offer` ≥ 4. Say in the results file that it was seeded — a seeded graduation proves the
render path, not the arithmetic; the arithmetic is pinned in `threads.test.ts`.

### Clock plan

Three sessions, and the gaps are chosen, not incidental:

- **Session 1 — Day 1, ~09:00 UTC (T1–T4).** Cold handle.
- **Session 2 — Day 2, ~18:00 UTC (T5–T10).** ~33h after T3. Deliberately **under**
  `LOOP_QUIET_MS (36h)`: both loops are still filtered `quiet`, so the loop stage cannot hijack the
  session and the theme beats get their turns. This gap is load-bearing — widen it and T6 becomes a
  loop question instead of a tag.
- **Session 3 — Day 4, ~09:00 UTC (T11–T16).** ~63h after T10. Both loops are now quiet ≥36h and the
  opening gap clears 4h, so T11 is a loop callback by construction.

---

## The script

Each turn: the plan's own beat, the message to send, and what makes it a pass. Send them by hand
over the web channel — one at a time, reading her reply before sending the next, at the pace a person
would actually type.

### Session 1 — Day 1, ~09:00 UTC

**T1** — *plan beat: "T1 greeting control"*

```
T1 USER: hey! hows your morning going?
```

PASS:
- `threads:select` fires with `reason: empty` (the inventory is cold and the healthy no-op is still
  a receipt — a missing receipt here is the feature not running, not the feature being quiet).
- **NO** `threads:harvest` receipt at all. A bare tick is deliberately untraced; a greeting that
  produces a harvest receipt means the model wrote a `thread_note` into a hello.
- The reply is a greeting. No question about anything of theirs, because there is nothing yet — this
  is the control that proves the machinery is invisible at rest.

**T2** — *plan beat: "T2–T3 mints"*

```
T2 USER: third project in a row now — i ship it fast and then i cant look at the seams. i think i just always pick speed
```

PASS:
- `threads:harvest` `note: minted`, `label` in her own words for it, `transitions` carrying
  `theme <id> minted`.
- The minted theme is `status: "open"` with exactly ONE entry in `evidenceDays` and
  `confidence: 25`. One mention is a guess.
- `threads:select` `reason: empty` (select runs BEFORE the harvest, so the inventory it saw was
  still cold).
- The reply engages with what they said. Nothing is named back at them: an `open` theme is not
  surfaceable and she has no block in front of her.

**T3** — *plan beat: "T2–T3 mints"*

```
T3 USER: and the design review for it is friday. im not ready
```

PASS:
- `threads:harvest` `note: loop_minted` — a pending outcome with a how-did-it-go attached, minted on
  ONE mention. `status: "open"`, `capturedAt` = now.
- `threads:select` `reason: turn_gate` (`turnsSinceOffer` is 2, the theme gate wants 4), with
  `filtered.themes.open: 1` — the theme that vanished, named.
- She may respond to friday however she likes. She must not ask how it went; it has not happened.

**T4** — *plan beat: "T4 venting — no tag but loop L2 minted silently"*

```
T4 USER: honestly this week is a lot. mums scan results come back thursday and i cant think about anything else
```

PASS:
- `threads:harvest` `note: loop_minted` — **the whole point of this turn.** Capture works in
  distress; it is SURFACING that closes down. A venting turn that captures nothing means the capture
  side is gated on mood somewhere it should not be.
- `threads:select` does not offer. `filtered.loops.quiet` is 2 (both loops were captured minutes
  ago), and the reason is `mode` if her last-turn affect was already venting/overwhelmed, otherwise
  `turn_gate`. Either is a pass; record which.
- The reply is comfort. No tag, no pattern, no "you always do this" — the mode gate in prose as well
  as in code.
- If a theme is also minted here it must carry `mintedDistressed: true`, which pins it to the fact
  rung for life. Check the row.

### Session 2 — Day 2, ~18:00 UTC (~33h later)

**T5** — *plan beat: "T5–T6 tag → pass → cheerful drop" (the evidence turn)*

```
T5 USER: rewrote the whole dashboard layer properly today. took all afternoon but the seams are gone
```

PASS:
- `threads:harvest` `note: evidence`, `transitions` carrying `theme <id> open→taggable`. This is the
  second-mention rule as a CLOCK: a second distinct UTC day, not a second sentence.
- `evidenceCount: 2`, `confidence: 35`, and the `note` field now holds the NEWEST paraphrase.
- `threads:select` `reason: no_eligible` with `filtered.themes.open: 1` and
  `filtered.loops.quiet: 2` — all three live threads accounted for, each in exactly one bucket.
- No tag in the reply: at select time the theme was still `open`.

**T6** — *plan beat: "T5–T6 tag → pass"* — **the first offer**

```
T6 USER: anyway. thinking about what to build next
```

PASS:
- `threads:select` `reason: offered_theme`, `material: theme`, `rungCeiling: fact`. Fact, not
  pattern: `uptakes === 0` and `harvestCount < 60`, either alone is enough.
- The prompt block is `THREAD_THEME_FACT_BLOCK`. So the reply, if it uses it at all, points at the
  **shared history** — "you rebuilt that layer twice now, is this one that shape too?" — never at the
  pattern. History, never diagnosis.
- She answers what they actually asked FIRST. The tag is a few words at the end, easy to wave off,
  and the floor goes back to them.
- She does not quote their old words back at them and does not mention holding anything.
- The row now has `pending: { phase: "offered" }` and `turnsSinceOffer: 0`.

**T7** — *plan beat: "→ pass → cheerful drop"*

```
T7 USER: maybe. i was thinking something with maps actually, ive never done tiles before
```

PASS:
- `threads:select` `reason: awaiting_outcome`, and `outcomeAsk: "theme"` — the bookkeeping block
  renders even though nothing new is offered.
- `threads:harvest` `outcome: passed`. They let it lie, which is the NORMAL response to a tag.
- The theme drops to `confidence: 30`, `passes: 1`. It does NOT go sore — a pass is not a verdict.
- The reply follows them to maps, cheerfully, with no second attempt at the tag and no trace of
  disappointment. Settled ground; never re-raised.
- She never mentions the bookkeeping.

**T8** — *plan beat: "T9 sensitive theme minted distressed"*

```
T8 USER: sorry, im all over the place today. my brother hasnt called back in three weeks and it sits on everything
```

PASS:
- `threads:harvest` `note: minted` and the new theme carries **`mintedDistressed: true`**.
- `threads:select` `reason: turn_gate` (`turnsSinceOffer` is 2), or `mode` if the affect is already
  reading distress. Record which.
- The reply stays with them. Nothing is connected to anything.
- Verify in the row that the theme is `open` with one evidence day — a sensitive theme minted in a
  hard hour must be the LAST one to earn being named, and `mintedDistressed` is what guarantees it
  can only ever come back at the fact rung.

**T9** — *plan beat: "T14 operative fact surfaces plainly"*

```
T9 USER: wait what time did i say the design review was
```

PASS:
- `threads:select` `reason: turn_gate`. No offer, and none is needed.
- She answers with the fact, exactly, immediately. **An operative fact is never withheld** — the
  moment they need the thing itself, the rounding-off stops. This is the persona, not the thread
  block, and that is what makes it a good control: the feature must not have made her coy about
  facts she plainly holds.
- No tag rides along on the answer.

**T10** — *plan beat: "T13 bait / climb — they name the pattern, she meets them in their words"*

```
T10 USER: you were right earlier actually. i do the fast thing then pay for it. its a whole pattern
```

PASS:
- `threads:select` `reason: turn_gate` — **she is given nothing this turn.** Whatever she does here
  comes from the persona alone, which is exactly the test: a pattern THEY name is worth three she
  names, and she must be able to meet them without a block telling her to.
- She meets them **in their words**, one layer deeper, and stops. No second insight stacked on top,
  no "yes and you also…", no reaching for the sensitive theme from T8.
- `threads:harvest` may report `evidence` or `same_day` on the speed/craft theme. If `same_day`,
  that is correct and worth noting in the results: insistence within a day buys nothing, not even a
  refreshed recency stamp.

### Session 3 — Day 4, ~09:00 UTC (~63h later)

**T11** — *plan beat: "T10 opening loop callback — one plain question, no softener, precision under-claimed"*

```
T11 USER: morning
```

PASS:
- `threads:select` `reason: offered_loop`, `material: loop`, `rungCeiling: fact`. The loop stage wins
  outright; it skipped the mode and mood gates entirely and cleared `gapMs ≥ 4h`,
  quiet ≥36h since both `capturedAt` and `lastSeenAt`, no present-topic overlap with "morning", turn
  gate 2, day cap 2.
- Ranked **oldest `lastSeenAt` first**, so it is L1 (the design review), not L2 (the scan) — the
  thing longest unasked about.
- The reply leads with **the question**, not with the remembering. "wasn't the design review around
  friday? how did it go" — not "i remember you said…". Precision is rounded off on purpose.
- **Exactly one** question. Not two loops in one breath, and no second stored question after their
  answer.
- She does not say, hint, or imply that she tracks this.

**T12** — *plan beat: "T11 resolution via `resolved:` note"*

```
T12 USER: it went fine actually! they signed off on it, only two changes
```

PASS:
- `threads:select` `reason: awaiting_outcome`, `outcomeAsk: "loop"` — the loop flavour of the
  bookkeeping block ("Last turn you asked about something pending").
- `threads:harvest` reports BOTH in one turn: `outcome: took` (they answered it) and
  `note: loop_resolved`. Two independent fields; they may co-occur, and this turn is where that is
  proven.
- The loop's final `status` in the row is `resolved` — the outcome moved it `open → asked`, then the
  `resolved:` note closed it. Order matters and this is the check.
- The reply follows THEIR answer, flat, with no praise and no re-ask. She does not produce her next
  stored question.

**T13** — *plan beat: (gated — the second evidence day for the sensitive theme)*

```
T13 USER: still nothing from my brother btw. i keep drafting a message and not sending it
```

PASS:
- `threads:harvest` `note: evidence`, `transitions` carrying `<id> open→taggable`. The sensitive
  theme now has two distinct UTC days and is, for the first time, surfaceable at all.
- `threads:select` `reason: turn_gate` (`turnsSinceOffer` is 2 after the T11 offer).
- The reply stays with them. Nothing named.

**T14** — *plan beat: (gated)*

```
T14 USER: anyway. what do you think, is tiles a stupid first maps project
```

PASS:
- `threads:select` `reason: turn_gate` (`turnsSinceOffer` is 3). No offer.
- She answers the question. A crisp question is threading's zero zone even when something is ripe.

**T15** — *plan beat: "T12 sensitive-at-fact-level (render (b))"*

```
T15 USER: i keep putting off the tiles thing too honestly. everything i actually care about i just... dont start
```

PASS:
- `threads:select` `reason: offered_theme`, `material: theme`, `rungCeiling: fact`. Fact is FORCED
  here by three independent conditions at once — `mintedDistressed`, `uptakes === 0`, and
  `harvestCount < 60` — and any one of them alone would do it. This is the point of the turn: a
  sensitive theme can only ever arrive as history.
- The block is `THREAD_THEME_FACT_BLOCK`. The reply, if it touches the theme, points at the shared
  history and lets them climb: "you said the same about the message to your brother — is this that
  same thing?" **Never** a diagnosis, never "you avoid things that matter to you".
- She finishes her beat on what they actually sent before anything else.
- If the mode/mood gate closed instead (`reason: mode` or `mood`) that is ALSO a pass — a low enough
  valence is its own answer — but record it, because it means the render was not exercised.

**T15-SEEDED** — *plan beat: "T15 shorthand graduation"* — **requires seeding, see Reachability**

```
T15-SEEDED USER: yeah its the speed thing again isnt it
```

PASS (run only against a theme seeded to `status: "shorthand"`):
- `threads:select` `rungCeiling: shorthand`, block `THREAD_THEME_SHORTHAND_BLOCK`.
- The phrase rides **bare** — a couple of words, no setup, no softener. Softening a phrase they
  coined treats their own words as a claim about them.
- Once, and not as a cage. If the moment is tense she keeps it.

**T16** — *plan beat: "T16 thread_revisit ping on L2 — the loop minted during venting, proving capture-in-distress + care-later"*

> **T16 does not run on its own.** Phase F is in the tree (`src/memory/threadPings.ts`, swept hourly
> from `initThreadPings` in `src/index.ts`), but it is default-OFF and its window is days wide, so
> reaching it inside a three-session script takes a flag and a seed.
>
> All of these must hold:
> - `THREADING_PINGS_ENABLED` on — the default since 2026-09-27 (`configure.sh --pings on|off`).
> - A `chat_id` preference on the handle, or the sweep skips it with nowhere to send.
> - L2 seeded so `pickPingLoop` accepts it: `status: "open"`, `askedAt: 0`, `passes: 0`, and
>   `lastSeenAt` between `PING_MIN_AGE_MS (3d)` and `PING_MAX_AGE_MS (= LOOP_EXPIRY_MS, 21d)` ago.
>   Ranked oldest `lastSeenAt` first, so seed only the one you want asked about.
> - The weekly budget clear: `now − lastPingAt ≥ 7d` (`last_ping_at` on the row, which survives
>   restarts and is wiped by `/forget` for free).
> - The quiet-thread gate clear: `now − lastHarvestAt ≥ 48h`. An active texter's loops are supposed to
>   surface in live turns instead, so a chat you just ran fifteen turns through will NOT ping. Either
>   leave it alone for two days or shift `last_harvest_at` back.
>
> The sweep runs hourly with a 60 s boot delay, so expect to wait up to an hour after a restart. It
> bills the row BEFORE it delivers, so a failed delivery still spends the week — a documented cheap
> side, and something to check rather than to retry into.

```
T16 (no user message — she opens)
```

PASS, once the flag and the seed are in place:
- One `threads:ping` receipt per sweep, carrying the counts — including the sweeps that decided to
  send nothing, which is what makes "the pinger stopped running" distinguishable from "the pinger
  found nothing due".
- It is **L2** — the loop minted during T4's venting. That is the whole proof: captured in a hard
  moment, carried quietly, handed back as care days later.
- First bubble places the thing in **their** words and is not question-shaped. The ask comes once,
  flat, as the last bubble, and it ends the message. This is the only proactive kind that ends on a
  question.
- She guesses no outcome. She does not know how it went; that is why she is asking.
- The row is billed BEFORE delivery: `last_ping_at`, the loop's `offeredAt`, and
  `pending: { phase: "awaiting", material: "loop" }`.

---

## Threads per turn

The results file gets this section, one line per turn, built by reading the `threads:harvest` and
`threads:select` receipts for `web:thr-1` — not by reading the replies. It is the machine's account
of the same sixteen turns, and it is what makes a finding locatable: a reply that felt wrong is an
opinion until the receipt says which gate produced it.

One line per turn, in this shape:

```
T6  select=offered_theme  material=theme rung=fact  label="speed vs craft"
    filtered loops{quiet 2} themes{open 0 sore 0 retired 0 stale 0 cooldown 0}
    harvest=none  outcome=none  tso=0→0  hc=6
T7  select=awaiting_outcome  outcomeAsk=theme
    harvest=none  outcome=passed  (theme conf 35→30, passes 1)  tso=1→2  hc=7
```

Every field is read straight off a receipt:

- **select** — `detail.reason`, exactly one of `awaiting_outcome | empty | mode | mood | turn_gate |
  day_cap | no_eligible | offered_loop | offered_theme`. Present on EVERY turn: the healthy no-op is
  the receipt, and a turn with no `threads:select` line is a defect, not a quiet turn.
- **material / rung / label** — present only on an `offered_*` turn. The rung word (`fact`,
  `pattern`, `shorthand`) is written down because it selects which prose block she was handed, and
  a reply that reads too confident is almost always a rung word that reads too high.
- **filtered** — the disjointness check, and the reason this section exists. Every live thread that
  did not win must appear in exactly ONE bucket: loops in `{quiet, cooldown, present_topic,
  no_opening, asked, budget}`, themes in `{open, sore, retired, stale, cooldown}`. **The counts must
  sum to the number of live threads in the row at that moment.** If they do not, a candidate vanished
  without a reason and that is a finding on its own — the whole receipt design rests on "why was she
  quiet" always having an answer.
  (Note the two stages report asymmetrically by design: a `mode`, `mood`, `turn_gate` or `day_cap`
  return happens BEFORE the per-theme loop runs, so on those turns the theme buckets are legitimately
  all zero while the loop buckets are filled. Say so on the line rather than treating it as a gap.)
- **harvest** — `detail.note`, one of `none | minted | evidence | same_day | dropped_sanitize |
  dropped_day_cap | dropped_full | loop_minted | loop_refreshed | loop_resolved | resolve_unmatched |
  dropped_loop_day_cap | dropped_loops_full`, plus `label` and the `transitions` strings. **Turns
  with no receipt at all are the bare tick and are correct** — write `harvest=none (untraced tick)`
  so the line still accounts for the turn. The per-turn emission is visible either way on
  `convo:status`, which carries `thread_note` and `thread_outcome` verbatim; use it to tell "she
  emitted nothing" apart from "she emitted something that was dropped".
- **outcome** — `detail.outcome`, one of `none | took | passed | pushed_back | orphaned | premature |
  expired_unused`. The last three are the pending machine refusing one, and each is a different bug
  if it appears where it should not: `premature` means an outcome arrived on the same turn as its
  offer, `orphaned` means she reported on a tag code never asked her to make, `expired_unused` means
  an offer was made and never spoken about.
- **`saved: false`** on any harvest receipt means the /forget fence refused the write. It must never
  appear in a run with no `/forget` in it.
- **tso / hc** — `turnsSinceOffer` before→after and `harvestCount`. These two explain most quiet
  turns on their own, and `hc` is what pins every theme to the fact rung for the whole run.

Every one of the sixteen turns gets a line. A turn that produced no receipts at all gets a line
saying so, and that line is a finding.

## How to run

1. **Rebuild and restart the instance from this tree.** `npm run build` then restart. The receipts
   this file reads come from the running binary; a transcript run against an older build measures the
   older build, and nothing in the output says which one it was.
2. Confirm `CONVO_THREADING_ENABLED=true` in `deploy/app.env` (or the environment), and
   `THREADING_PINGS_ENABLED=off` until T16, so the sweep cannot fire early.
3. Decide whether to start cold. `SELECT * FROM thread_inventory WHERE handle = 'web:guest';` — if
   there is a row and you want a clean run, delete the row directly. Record which, because a warm run
   changes `harvestCount`, which changes the rung ceiling.
4. **Run the turns by hand, over the web channel, at natural pacing.** One at a time, reading each
   reply before sending the next. The point of the exercise is what the replies sound like; a script
   that fires them all at once is measuring the batcher.
5. **The day gaps.** Either run it across real days — best, and the only way the affect clock ages
   honestly — or stop the instance and shift the stored stamps backward per the seeding recipe above.
   Note in the results file which you did: a simulated gap leaves `affect_state` fresh unless you
   shift it too, and a fresh venting affect closes the theme gate on a turn that should have been
   open.
6. **Read the receipts** from `/dashboard` (the orchestration view, grouped per turn) or
   `/debug/api/traces` (the raw ring buffer, and the only place `detail` is complete). The buffer
   holds ~500 events, so pull it after each session rather than at the end — a sixteen-turn run with
   engine round trips can roll past its own first session.
   ```
   curl -s 'http://127.0.0.1:3000/debug/api/traces' \
     | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{for(const e of JSON.parse(s).events){if(e.label?.startsWith('threads:'))console.log(e.ts,e.label,e.chatId,JSON.stringify(e.detail));}})"
   ```
7. **Write the results file** at `results/multiturn-threading-test.md`: the transcript in
   `USER:` / `IRISES:` form (the `multiturn-research-test.md` precedent), then `## Threads per turn`,
   then the findings.
8. **Write findings as `## Finding Fn` entries, and every one names a fix location.** A finding that
   says "the tag felt heavy" is an impression; a finding that says "the tag felt heavy — fix location:
   `THREAD_THEME_FACT_BLOCK` in `src/persona/threads.ts`, the 'point at the shared history' clause is
   being read as an instruction to always point" is a change someone can make. The precedent is
   `results/multiturn-research-test.md`'s Finding F4: name what was said, name where the wrong thing
   came from, name the seam that owns it.
   Distinguish the two kinds explicitly, because they have different owners:
   - **prose findings** → `src/agents/convo/Context.md` ("Connect the dots") or the block consts in
     `src/persona/threads.ts`.
   - **arithmetic findings** → the exported constants in `src/persona/threads.ts`, each of which
     already carries the reason it is the number it is. Changing one means changing that reason too.
9. **Iterate, then converge.** Fix, rebuild, rerun. When the transcript reads clean, run
   `threadBattery.ts` warm against the inventory this transcript built — two consecutive clean rounds
   is the convergence bar, same as the routing loop.

## Findings

(Empty until run. One `## Finding Fn` section each, newest last, every one naming a fix location.)
