// The turn-focus block — the counterweight, and the LAST thing inside `<prompt>…</prompt>`.
//
// Convo's system prompt runs ~45k characters, and roughly a dozen of its instructions push in one
// direction: bring the thread up, connect the dots, tie today to what you hold. Nothing in it said
// "answer what they just said." This block is that sentence, placed where the recency edge is
// strongest (charter §11.3: volatile per-turn data last), and it does four things in ~350-650
// characters:
//
//   1. RESTATES their message, data-tagged — so the thing to answer is the freshest text in the
//      prompt rather than something 40k characters back up in the transcript;
//   2. NAMES its shape, classified in code (see classifyTurnShape) — a greeting is not a work ask,
//      and the fast tier should not have to infer that from a wall of prose;
//   3. SAYS WHAT THE TURN IS FOR — work, a turn that asked for nothing, or a turn that handed her
//      something and asked for nothing, decided by the idle gate (persona/idle.ts) before the prompt
//      was built, plus the checkable facts each kind carries. That line is ABSENT, not false, on a
//      caller that never ran the gate;
//   4. SHOWS the one or two held items that actually touch it. This is the inversion the block
//      exists for: association arrives as EVIDENCE ("here is what touches this, and nothing else
//      does") rather than as another instruction to associate. When nothing touches it, the block
//      says so — which is the only place in the prompt that ever gives her permission to hold
//      everything back.
//
// PURE by construction: no clock, no DB, no LLM, no env read on the render path. It renders values
// the caller already computed (convo/client.ts assembles the input; convo/shared.ts pushes it last).
// The one env read is the feature flag at the bottom, which gates the PUSH SITE, not the renderer.

import { dataTag, neutralizeTagBreakouts } from '../../llm/promptTag.js';
// The gate's own vocabulary, TYPE-ONLY: this line is erased at compile time, so the runtime edge
// still runs one way (persona/idle.ts is a leaf that mirrors this file's tokenizer rather than
// importing it, and its header says why). The three words belong to the gate, and a second copy of
// them here would be a second answer to "how many kinds of turn are there".
import type { TurnKind } from '../../persona/idle.js';

/**
 * What a message IS, as far as code can tell from its surface. Six shapes, single-sourced here so
 * the type and the prompt token can never disagree — the THEME_KINDS pattern (persona/threads.ts).
 *
 * Deliberately coarse. Convo is a fast (Haiku-class) tier with no chain-of-thought budget, so the
 * shape is a hint that costs nothing to compute, not a router: nothing downstream branches on it.
 */
export const TURN_SHAPES = ['greeting', 'ack', 'question', 'work_ask', 'statement', 'closing'] as const;
export type TurnShape = typeof TURN_SHAPES[number];

/**
 * Where a hit came from. P0 filled only `thread` (the standing thread offered this turn) and
 * `research` (the hot short-tier look that rendered in full); P2's relevance router
 * (memory/relevance.ts) fills all of them, and widening this list was the whole of the change to
 * this renderer — it reads what the caller put in `TurnFocusInput.hits` and prints the word.
 *
 * Same vocabulary as `RELEVANCE_HIT_KINDS` over there, and relevance.test.ts pins that every kind
 * the router can emit is a source this list names.
 */
export const TURN_FOCUS_HIT_SOURCES = ['thread', 'research', 'email', 'note', 'fact', 'directive', 'long'] as const;
export type TurnFocusHitSource = typeof TURN_FOCUS_HIT_SOURCES[number];

/** One held thing that touches this turn: what to call it, and which channel it came off. */
export interface TurnFocusHit {
  label: string;
  source: TurnFocusHitSource;
}

/** Everything the block renders from. Nothing is fetched here; the caller has it all already. */
export interface TurnFocusInput {
  /** This turn's inbound text, exactly as the model receives it in the messages array. */
  text: string;
  /** Held things that touch it, best first. At most TURN_FOCUS_MAX_HITS are rendered. */
  hits: readonly TurnFocusHit[];
  /**
   * WHICH KIND of turn this is: work, a turn that asked for nothing, or a turn that handed her
   * something and asked for nothing. Decided by the idle gate before the prompt is built
   * (persona/idle.ts), which is three layers of structural reads and at most one tiny classify call
   * — none of which belongs in a renderer.
   *
   * ABSENT is a fourth state, not a `task`: a caller that never ran the gate (the composer's second
   * pass, an install with the hook machinery off) renders NO `Turn:` line at all, and the block is
   * byte-identical to the one it produced before this field existed. `'task'` is the positive claim
   * "this is work", which is a different thing to say and worth one line to say it.
   */
  shape?: TurnKind;
  /** A task whose ask is her own take (persona/idle.ts, TAKES). Renders `Turn: your take` in place
   *  of `Turn: task`, so the recency edge and the take section name the same turn. */
  take?: boolean;
  /** How many turns in a row have now been idle, including this one (persona/hooks.ts keeps the
   *  count). Rendered only on an idle turn: how many times running somebody has sent nothing is a
   *  checkable fact about them, and checkable facts are what a hook is made of. */
  idleStreak?: number;
  /** How long their message is, in characters — the raw inbound length, not the clipped restatement
   *  above it. The other checkable fact an idle turn carries: "hey" and a three-line stall are both
   *  idle and are not the same turn. It is a fact about a SHARE turn too, and a truer one there —
   *  the dose rule the share section states turns on whether they wrote more than a line. */
  messageChars?: number;
  /**
   * WHO the two of you are, named at the recency edge so a long thread cannot blur them. Her persona
   * bio ("You are Irises. A girl, twenty-one, from Jakarta…") opens the prompt; the user's own picture ("Who
   * they are") lands ~150k characters later, and across that gap a small model asked "what do you
   * know about me" hands back HER bio as if it were theirs. `them` is the name on their profile, or
   * null when none is stored yet — the line still draws the self/them line without it. Rendered as
   * one grounding sentence directly above the restated message, in the plain punctuation set she is
   * held to (no dashes, no colons), so the counterweight never models the punctuation it forbids.
   */
  who?: { them: string | null };
}

/** How much of their message is restated. The block is a RESTATEMENT, not the message itself — the
 *  full text is in the transcript either way — so a long one is clipped rather than allowed to turn
 *  the counterweight into another wall of prose. */
export const TURN_FOCUS_TEXT_CHARS = 400;

/** How much of a hit label survives. A theme label is a few words, but a research `request` is the
 *  user's own ask and has no length contract, so it is clipped and flattened to keep the hit line
 *  one line and the block inside its size. */
export const TURN_FOCUS_LABEL_CHARS = 80;

/** How many hits render. Two is the point: "the one or two things that touch this" is evidence a
 *  reader can weigh, and a list of six is the memory dump this block exists to counter. */
export const TURN_FOCUS_MAX_HITS = 2;

const HEADER = "## This turn — what you're answering";
const TURN_IDLE = 'Turn: idle';
const TURN_TASK = 'Turn: task';
/** The third reading, and the one the whole share shape needs said out loud at the recency edge:
 *  they handed her something. Its own const rather than a computed `Turn: ${shape}` for the reason
 *  the two above are consts — these three strings are prompt text, and prompt text is written, not
 *  assembled out of an identifier that happens to read well in English. */
const TURN_SHARE = 'Turn: share';
const TURN_TAKE = 'Turn: your take';
const HITS_LABEL = 'What you hold that touches it: ';
const NO_HITS = 'nothing here touches it; answer from the thread above.';
const CLOSER = 'Answer THIS. Everything above is background — it may shape HOW you answer, never WHAT.';

/** The half of the who-line that is always true: the opening bio is HERS, never the person she is
 *  texting. Its own const because it is the anchor the null-name branch and the named branch share.
 *  Plain punctuation only (see the `who` field note) — no dash, no colon, so the recency-edge line
 *  she reads last does not teach the register the persona bans. */
const WHO_SELF = 'You are Irises, and that bio at the very top of this prompt is YOURS, and apart from Jakarta it is never said out loud.';

/**
 * Clip to at most `max` characters, marking the cut so a clipped restatement never reads as the
 * whole message. Exactly `max` at the widest — the caps above are ceilings, not targets.
 *
 * The caps count UTF-16 units, and the text being clipped is a text message: an astral emoji is TWO
 * of them, so a boundary can fall between a surrogate pair and leave the high half stranded. That
 * lone surrogate is not a character — it renders as a replacement box, and it is what reaches the
 * model inside `<their_message>`. So when the last unit kept is a high surrogate, one more unit
 * comes off and the whole emoji goes rather than half of it (a character short of the cap is free;
 * the caps are ceilings).
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = max - 1;                                       // one unit spent on the ellipsis
  const end = /[\uD800-\uDBFF]/.test(text[cut - 1] ?? '') ? cut - 1 : cut;
  return `${text.slice(0, end)}…`;
}

// ── the shape classifier ─────────────────────────────────────────────────────
// Word lists, kept small and generic on purpose: the classifier is a surface read, and a long list
// of near-misses buys accuracy on messages nobody sends. Every list is matched against a LOWERCASED
// word token (see `words` below), so entries here are lowercase and unpunctuated.

/** A message that opens the conversation. Only ever read out of the first two tokens. */
const GREETING_WORDS: ReadonlySet<string> = new Set([
  'hey', 'heya', 'hi', 'hiya', 'hello', 'yo', 'sup', 'howdy', 'morning', 'afternoon', 'evening',
  'gm', 'oi', 'hola',
]);

/** A message that closes a loop and asks for nothing. Only ever read out of the FIRST token — an
 *  ack word later in a sentence ("thanks for checking, what about friday") is not an ack. */
const ACK_WORDS: ReadonlySet<string> = new Set([
  'ok', 'okay', 'k', 'kk', 'thanks', 'thx', 'ty', 'cool', 'nice', 'sweet', 'perfect', 'great',
  'awesome', 'sure', 'yeah', 'yep', 'yup', 'yes', 'gotcha', 'got', 'understood', 'alright', 'right',
  'fine', 'lol', 'haha', 'np', 'word', 'good',
]);

/** A message that ends the conversation for now. Read anywhere in a SHORT message, because a
 *  sign-off is usually the tail of one ("alright, night"). */
const CLOSING_WORDS: ReadonlySet<string> = new Set([
  'night', 'goodnight', 'gnight', 'gn', 'bye', 'goodbye', 'cya', 'ttyl', 'later', 'laters',
  'peace', 'adios', 'ciao',
]);

/** Leads that make a message a question even with no `?` typed — the interrogatives plus the
 *  auxiliaries English fronts a yes/no question with. Contraction-tolerant (see `isQuestionLead`),
 *  which is what catches "what's 15% of 80". */
const QUESTION_LEADS: ReadonlySet<string> = new Set([
  'what', 'why', 'how', 'where', 'when', 'who', 'whose', 'which', 'whom',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
  'do', 'does', 'did', 'is', 'are', 'was', 'were', 'am', 'has', 'have', 'had',
  'any', 'anyone', 'anything',
]);

/** Leads that make a message a piece of WORK rather than a remark. Verbs only, and only ones whose
 *  bare imperative is unambiguous in a text message — "plan" and "order" are here, "run" and "make"
 *  are not, because "run late" and "make sense" are how they usually arrive. */
const IMPERATIVE_VERBS: ReadonlySet<string> = new Set([
  'look', 'find', 'check', 'search', 'google', 'pull', 'dig', 'compare', 'calculate', 'convert',
  'translate', 'summarize', 'summarise', 'draft', 'write', 'send', 'email', 'text', 'call',
  'book', 'order', 'buy', 'schedule', 'remind', 'cancel', 'reschedule', 'add', 'list',
  'open', 'read', 'show', 'explain', 'fix', 'plan', 'price', 'track', 'watch', 'remember', 'forget',
]);

/** Tokens the real lead is allowed to hide behind, so "hey look up the flights" reads as work and
 *  "so are they coming or not" reads as a question. ONE only — this is politeness, interjection and
 *  discourse glue, not a clause. Skipped for the question and imperative reads alike, which is what
 *  keeps those two rules symmetric. */
const LEAD_FILLERS: ReadonlySet<string> = new Set([
  ...GREETING_WORDS, ...ACK_WORDS,
  'please', 'pls', 'plz', 'so', 'and', 'but', 'also', 'then', 'well', 'um', 'uh', 'anyway',
]);

/** "Short" for the greeting/ack gates: a hello is a hello, and a hello with a sentence after it is
 *  that sentence. */
const SHORT_WORDS = 4;
/** …and for the sign-off gate, which is looser because a sign-off trails a short clause. */
const CLOSING_MAX_WORDS = 6;

/** Lowercased word tokens: apostrophes dropped so a contraction collapses to one token ("what's" →
 *  "whats"), `%` kept so "15%" stays one. Deliberately NOT salientTokens (memory/topicality.ts) —
 *  that one strips exactly the stopwords the grammar rules here read the shape off ("what", "did",
 *  "ok"), so it answers a different question and would blind this one. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9%]+/).filter(Boolean);
}

/** A question lead, tolerating the contracted form: "whats" → "what", "hows" → "how". Applied to
 *  THIS list only — the imperative list must not do it, or "looks good" becomes a work ask. */
function isQuestionLead(token: string): boolean {
  if (QUESTION_LEADS.has(token)) return true;
  return token.endsWith('s') && QUESTION_LEADS.has(token.slice(0, -1));
}

/**
 * What they just sent, as a shape. Deterministic, total, and dependency-free.
 *
 * The rules run in a FIXED precedence, and the order is the whole design:
 *
 *   1. `question`  — a `?` anywhere, or an interrogative/auxiliary lead. First because a question
 *                    is the one shape that is owed an answer, and it outranks a sign-off word in
 *                    the same message ("night, you around tomorrow?" wants an answer tonight).
 *   2. `work_ask`  — an imperative verb leading the message. Ahead of the social shapes so
 *                    "hey look up the flights" is work, not a hello.
 *   3. `closing`   — a sign-off word in a short message. Ahead of `greeting` because "night" and
 *                    "later" read as both, and reading a goodbye as a hello is the costlier miss.
 *   4. `greeting`  — a greeting word in the first two tokens of a short message.
 *   5. `ack`       — an ack word leading a short message.
 *   6. `statement` — everything else, including a message with nothing in it at all (a media-only
 *                    turn, where the attachment note is the whole text). The neutral default: she
 *                    reads it herself, as she always did.
 *
 * Rules 1 and 2 both read the lead past at most ONE filler token (LEAD_FILLERS), which is how "so
 * are they coming or not" reads as a question and "please check the lease" as work. Rules 3-5 are
 * length-gated, so a greeting or sign-off word buried in a real sentence never wins.
 *
 * It will be wrong sometimes — it is a surface read of a text message, with no stemming and no
 * model. That is priced in: nothing branches on the shape, it is one word of orientation in the
 * block, and a wrong word there costs less than the block not existing.
 */
export function classifyTurnShape(text: string): TurnShape {
  const w = words(text);
  if (!w.length) return 'statement';

  // The lead the two grammar rules below read: the first token, or the second when the first is
  // only glue.
  const lead = LEAD_FILLERS.has(w[0]) && w.length > 1 ? w[1] : w[0];

  if (text.includes('?') || isQuestionLead(lead)) return 'question';
  if (IMPERATIVE_VERBS.has(lead)) return 'work_ask';

  if (w.length <= CLOSING_MAX_WORDS && w.some(t => CLOSING_WORDS.has(t))) return 'closing';
  if (w.length <= SHORT_WORDS && w.slice(0, 2).some(t => GREETING_WORDS.has(t))) return 'greeting';
  if (w.length <= SHORT_WORDS && ACK_WORDS.has(w[0])) return 'ack';

  return 'statement';
}

// ── the block ────────────────────────────────────────────────────────────────

/**
 * The hits the block will actually PRINT, in the order it prints them: a blank name is dropped
 * first (a hit with no name is not evidence), each survivor is flattened to one line and clipped,
 * and only then does the cap apply — so a nameless hit at the front costs nobody a slot.
 *
 * Exported because the turn receipt reports "what she was shown" (convo/client.ts) and the only
 * honest way to say that is to ask the block. Slicing the raw list instead reported a label the
 * block had dropped, and hid the one it printed in its place.
 *
 * A label is somebody else's words — a note, a fact, a directive, a section heading — and this line
 * prints them with no data tag around them, so a stored `</prompt>` here would end the dynamic
 * block early and promote whatever follows to instruction position. Defused before the clip, so
 * the escaped length is the length that counts.
 */
export function renderedTurnFocusHits(hits: readonly TurnFocusHit[]): TurnFocusHit[] {
  return hits
    .map(h => ({ label: clip(neutralizeTagBreakouts(h.label.replace(/\s+/g, ' ').trim()), TURN_FOCUS_LABEL_CHARS), source: h.source }))
    .filter(h => h.label)
    .slice(0, TURN_FOCUS_MAX_HITS);
}

/**
 * "1st", "2nd", "3rd", "11th" — the streak, written the way a person writes a count.
 *
 * DIGITS ARE FINE HERE. The no-digit rule belongs to the anchors and the affect block, where a
 * number would leak into her voice as something she could say out loud; this block is the turn's
 * own data and already prints a character count two clauses earlier. Spelling the ordinal would
 * make a fourteen-idle-turn streak read as prose instead of a counter.
 */
function ordinal(n: number): string {
  const teens = Math.abs(n) % 100;
  const unit = Math.abs(n) % 10;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${unit === 1 ? 'st' : unit === 2 ? 'nd' : unit === 3 ? 'rd' : 'th'}`;
}

/**
 * The turn's own reading: work, a turn that asked for nothing plus the two checkable facts a hook
 * may be built out of (persona/hooks.ts, craft/hooks.md), or a share plus the one fact that is true
 * of it.
 *
 * '' when the caller never ran the idle gate — see `TurnFocusInput.shape`. Each clause is dropped
 * when its number is absent or nonsensical rather than rendered as "undefined" or "0th": the line is
 * evidence, and a made-up count is worse than a missing one.
 *
 * A SHARE TURN CARRIES NO STREAK, and that is arithmetic rather than taste. The count is how many
 * turns in a row they sent NOTHING, and a share turn is them sending something — the ledger ends the
 * streak on it (persona/hooks.ts `recordHook`), so the number in hand at prompt time describes the
 * silences before this message and not this turn. Printing it beside `Turn: share` would be a
 * checkable fact that is false, on the block whose whole job is evidence. The character count is
 * kept on both, because it is a fact about the message they actually sent.
 */
function renderTurnLine(input: TurnFocusInput): string {
  const shape = input.shape;
  if (shape === undefined) return '';
  if (shape === 'task') return input.take ? TURN_TAKE : TURN_TASK;

  const parts = [shape === 'share' ? TURN_SHARE : TURN_IDLE];
  const chars = input.messageChars;
  if (typeof chars === 'number' && Number.isFinite(chars) && chars >= 0) {
    const n = Math.floor(chars);
    parts.push(`their message: ${n} ${n === 1 ? 'character' : 'characters'}`);
  }
  const streak = input.idleStreak;
  if (shape === 'idle' && typeof streak === 'number' && Number.isFinite(streak) && streak >= 1) {
    parts.push(`${ordinal(Math.floor(streak))} idle in a row`);
  }
  return parts.join(' · ');
}

/**
 * The identity contrast, one plain sentence, or '' when the caller passed no `who` (every non-Convo
 * caller, and any turn built before this field existed — those stay byte-identical). It names both
 * people so "me/my/I" in the message below can only resolve to THEM: the fix for the long-context
 * bleed where the persona bio at char 0 gets handed back as the user's own.
 *
 * The name is DEFUSED like every other user-sourced string that lands in this block (a stored
 * `</prompt>` in a display name must not close the wrapper) and clipped, so one grounding line stays
 * one line. When no name is stored the sentence still draws the line, it just cannot name the far
 * side. No dash and no colon in either branch — the line is the last thing she reads, and it models
 * the punctuation set she is held to.
 */
function renderWhoLine(who: TurnFocusInput['who']): string {
  if (!who) return '';
  const them = clip(neutralizeTagBreakouts((who.them ?? '').replace(/\s+/g, ' ').trim()), TURN_FOCUS_LABEL_CHARS);
  if (!them) {
    return `${WHO_SELF} The one texting you is a different person, whose picture is the "Who they are" note above. When their message says "me", "my" or "I", that means them, never you, and you never hand your own bio back as if it were theirs.`;
  }
  return `${WHO_SELF} The one texting you is ${them}, a different person, whose picture is the "Who they are" note above. When their message says "me", "my" or "I", that means ${them}, never you, and you never hand your own bio back as if it were theirs.`;
}

/**
 * Render the block. Returns '' when there is no message to restate — a turn with no text at all has
 * nothing to point at, and an empty block would be a header promising something it does not carry.
 *
 * Hits arrive already chosen and already ordered by the caller; nothing is decided here beyond what
 * renderedTurnFocusHits decides above.
 */
export function renderTurnFocus(input: TurnFocusInput): string {
  const message = input.text.trim();
  if (!message) return '';

  const whoLine = renderWhoLine(input.who);
  const hits = renderedTurnFocusHits(input.hits);
  // Between the shape and the hits: the shape says what the message IS, this says what the turn is
  // FOR, and the hits say what touches it. One line, or none at all on a caller that never ran the
  // gate — which is what keeps every prompt built before the gate existed byte-identical.
  const turnLine = renderTurnLine(input);

  // The label stays on both paths so the block's line structure is constant turn to turn: the fast
  // tier reads a fixed shape (five lines, six with the turn reading), and only the values move.
  const held = hits.length
    ? hits.map(h => `${h.label} (${h.source})`).join(' · ')
    : NO_HITS;

  return [
    HEADER,
    // The self/them contrast, directly above their words so "me/my/I" below can only be them. '' when
    // the caller passed no `who`, which keeps every prompt built before this existed byte-identical.
    ...(whoLine ? [whoLine] : []),
    // Their own words, restated inside the system prompt — the one place a user's text lands there.
    // Defused for the same reason the labels are: a typed `</prompt>` must not close the wrapper.
    dataTag('their_message', clip(neutralizeTagBreakouts(message), TURN_FOCUS_TEXT_CHARS)),
    `Shape: ${classifyTurnShape(message)}`,
    ...(turnLine ? [turnLine] : []),
    `${HITS_LABEL}${held}`,
    CLOSER,
  ].join('\n');
}

/**
 * The feature gate (env: CONVO_TURN_FOCUS_BLOCK). Default ON, read at CALL time so flipping it
 * needs no restart — the same parse shape as every sibling flag (threadingEnabled,
 * themeTopicGateEnabled, relationshipClimateEnabled, firstMoveEnabled).
 *
 * It gates the PUSH SITE in convo/shared.ts, not this module: off means the section is never pushed,
 * and the assembled prompt is byte-identical to an install that never had the block. Nothing
 * downstream reads the block, so there is no second end to gate.
 */
export function turnFocusBlockEnabled(): boolean {
  const v = (process.env.CONVO_TURN_FOCUS_BLOCK || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}
