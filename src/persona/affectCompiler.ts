// The AFFECT COMPILER: where the hidden machinery stops DESCRIBING a mood and starts issuing
// instructions. Everything this file owns used to be prose — a paragraph of body-clock texture, a
// paragraph of cycle texture, a five-band mood essay, a clause of gauge words, a trajectory line —
// handed to the model on every single turn with no rule in it, on the theory that a model reading
// "Fe senses a small distance it cannot place" would arrive at the right register by itself. What it
// actually bought was tone: eighteen hundred characters of adjectives about a person who then
// answered the question exactly the same way.
//
// So the machinery stays and the prose goes. The gauges, the Willcox core and the standing register
// COMPILE, here, into at most four imperative lines: how sharp (the core's own sentence), how short
// (the social battery), whether the beat is open at all (the mood floor, the core and the climate
// floors), and whether it is late where they are — which is a REGISTER and nothing else: the hour
// lowers the volume of a reply and never picks its content. Everything above is arithmetic the model
// never sees; everything below is a sentence it can obey.
//
// NOT EVERY COMPILED FIELD IS A SENTENCE, and since the share turn landed two of them are not.
// `question` (may this reply carry the one follow-up question) and `heavy` (they brought weight)
// are CEILINGS the rhythm engine reads; the renderer never writes either one down. What reaches the
// model is a presence and an absence: whether the share section carries its question line, and how
// short that section's list of open kinds is. A rendered line announcing that a question is
// available would be read as an instruction to ask one, which is the exact failure this shape
// corrects — the machinery sets the ceiling and she judges inside it.
//
// THE WHEEL IS THE VARIABLE. `mood_label` is the one thing the model still reports about how it
// feels, `coreForLabel` (mood.ts) is what files that word under one of six cores, and CORE_DIRECTIVES
// is what each core CHANGES about the reply. That is the whole loop: she says a true word, the chart
// places it, and the placement is an instruction rather than an adjective. A number that used to be
// printed beside the word ("hopeful (powerful, 72/100)") is gone for the reason the envelope's own
// numbers went (charter §6.4): a number printed beside a state is a number to optimize.
//
// PURE by construction, like every engine in this stack: no DB, no LLM, no clock read. The clock
// arrives as `ComputedState`, the register as `RelationshipClimate`, the carried row as the last
// `AffectStatus`, and the same three inputs always compile to the same directive.
//
// THE MASK is the last stage, and it decides what compiles, never what is true. How well she knows
// them arrives as a band (persona/familiarity.ts); `compileMask` pulls it up one notch when rapport
// has been landing badly, on the question gate's own line; MASK_OPENS says, band by band, which
// layers of the mood reach an instruction. Shape and energy always pass (the battery, the hook
// allowance the core carries, the question ceiling, the hour). Content opens in order, positive
// before negative, and the deepest layer, her mood putting an ask off, opens last. The gauges and
// the reported word run underneath at every band, and asked how she is she answers true at every
// band (FEELINGS_LINE_ASKED). No band at all is no mask: the compile as it stood before the stage.
//
// IMPORT DIRECTION, and it has to stay this way: status.ts imports this file BY VALUE, so everything
// this file takes from status.ts is `import type` and erased at compile time — the same edge, and the
// same argument, as affectDrift.ts's header states for itself. mood.ts, climate.ts and familiarity.ts
// are leaves, so those three are ordinary value imports and nothing can load back through them.

import { coreForLabel, CORE_VALENCE_BAND, type MoodCore } from './mood.js';
import { bandForDial, clampToSpec, type RelationshipClimate } from './climate.js';
import { lowerBand, type FamiliarityBand } from './familiarity.js';
import type { CircadianSlot } from './circadian.js';
import type { AffectStatus, ComputedState, IntentMode } from './status.js';

/** How many words she has this turn, as a band. `normal` renders NO line at all — the default
 *  costs the prompt nothing, which is the same bargain the climate deadzone makes. */
export type BrevityBand = 'normal' | 'tight' | 'minimal';

/** Which hook kinds this turn's mood and register leave open. Structurally the same union as
 *  `HookAllowance` in hooks.ts, which declares its own copy on purpose (it is a leaf and imports
 *  nothing); the selector consumes this value through that. */
export type HookAllowance = 'all' | 'no_judgment' | 'no_tangent' | 'none';

/** Whether the one question of hers that is a move and not a probe is available at all this turn.
 *  A CEILING, never an instruction: `open` means the share turn's selector MAY leave that kind in
 *  the allowed set and she decides inside it; `closed` means the reply stays statement-shaped
 *  whatever she judges. Declared as its own union for the reason `HookAllowance` is one — the
 *  rhythm engine reads it through a structural subset and never learns how it was decided. */
export type QuestionGate = 'open' | 'closed';

/** The carried read of what THEY were doing, as the question gate and the weight flag consume it:
 *  last turn's `intent_mode`, and only while it is still fresh enough to describe this turn. The
 *  freshness read is the CALLER's (the same window threads.ts takes, `AFFECT_FRESH_MS`), because a
 *  pure compiler has no clock — a stale row arrives here as no row at all. */
export interface CarriedIntent {
  intentMode: IntentMode;
}

/** This turn's compiled affect, as instructions rather than texture. Every field is read by code —
 *  `hooks`, `question`, `heavy` and `lateNight` by the rhythm engine (hooks.ts),
 *  `bubbleCap`/`brevity` by the renderer and the quiet guard, `mood` by the one line that still
 *  names how she feels. */
export interface AffectDirective {
  mood: { core: MoodCore; word: string };
  bubbleCap: 1 | 2 | 3;
  brevity: BrevityBand;
  hooks: HookAllowance;
  /** Whether a share turn may carry the follow-up question. The one compiled field that reaches the
   *  prompt as a PRESENCE rather than a sentence: nothing here renders a weather line about it, and
   *  the model only ever sees whether the share section's question line is there. */
  question: QuestionGate;
  /** There is real weight in what they handed her (the carried read says venting or overwhelmed).
   *  Narrows what a share turn may do with it — analysis is not company — and keeps the climate
   *  span from announcing that a tangent is welcome on the turn someone let the tank out. */
  heavy: boolean;
  /** It is late where they are. A register flag: smaller and quieter, nothing more. It closes no
   *  hook kind, shuts no sampler and forces no mode — see hooks.ts `selectHook`. */
  lateNight: boolean;
  /** How loose her English runs this turn. Handed to the hooks renderer alongside the rhythm
   *  contract: zero is careful (serious moment or numbers), one is the normal baseline (no line
   *  rendered), two is loose (late or amused), three is messy (very late or laughing hard). */
  englishLooseness: 0 | 1 | 2 | 3;
  /** She is running on empty: a sad core, or a social battery low enough for one bubble. The one
   *  state in which her mood puts an open-ended ask off rather than merely shortening the answer;
   *  the hook selector carries it onto a task directive and the drift anchor states it last. */
  spent: boolean;
  /** Her weather is low: a sad, mad or scared core, a mood under the hook floor, or a battery tight
   *  enough for two bubbles or fewer. She says how she feels when it shows and asks lazily. */
  low: boolean;
  /** What she feels underneath, in plain words, strongest first (at most two), read off her needs
   *  the way The Sims turns meters into moodlets (`compileFeelings`). Empty when nothing stands out. */
  feelings: string[];
  /** The strongest feeling is extreme (FEELING_STRONG). */
  feelingStrong: boolean;
  /** …and this is one of the turns it slips into the reply (FEELING_SLIP_PERCENT of them): the
   *  feeling's word, or '' on every other turn. */
  feelingSlip: string;
  /** How much of all this they get to see: the familiarity band after the rapport notch
   *  (`compileMask`), or `close` when the caller passed no band. The renderer reads it to pick the
   *  mood line and the feelings line. Of the fields above, only the content ones are already masked
   *  by it (the core's share of `englishLooseness`, `low`, `spent`, `feelingSlip`); the shape and
   *  energy ones (`bubbleCap`, `brevity`, `hooks`, `question`, `lateNight`) pass every band on
   *  purpose. */
  mask: FamiliarityBand;
}

/**
 * The six Willcox cores → what each one CHANGES about the reply, in one imperative sentence, plus
 * the hook kinds it leaves open and whether it leaves the follow-up question open. The sentence and
 * the hook permission are two readings of the same decision and they live on the same row so they
 * cannot drift apart: "No judgment this turn; a callback or nothing" and `hooks: 'no_judgment'` have
 * to agree, and a table with both in it is the only arrangement where a reviewer can see that they
 * do.
 *
 * The `question` column is the one cell on the row that is NOT a reading of the sentence, and the
 * sentences are unchanged by its arrival: no imperative here mentions a question, because the
 * ceiling reaches the model as a presence (whether the share section renders its question line) and
 * never as a per-core instruction. It splits the wheel where the wheel already splits itself —
 * joyful, powerful and peaceful open, mad, sad and scared closed — which is `CORE_VALENCE_BAND`'s
 * own division of the chart, pinned that way in the test rather than as a hand list. The reason is
 * the only one that matters here: a question spends THEIR effort, so the turns where she is sharp,
 * flat or careful are the turns to state the guess and take what they said.
 *
 * The sentences are Fable's, pasted byte-for-byte from the staging prose (policy-strings.md,
 * CORE_DIRECTIVES), plus one clause each on `mad` and `sad` from the autonomy round (2026-09-25):
 * the persona block lets her mood put off an open-ended ask or refuse a favour asked with a
 * put-down, and live replays showed that permission unused, 0 of 12, until the turn's own mood line
 * stated it as her state rather than as an option. Nothing here is a word list: the three hook words appear because they are the
 * three kinds the engine actually has, not because any code matches her reply against them.
 */
export const CORE_DIRECTIVES: Record<
  MoodCore,
  { line: string; say?: string; hooks: Exclude<HookAllowance, 'none'>; question: QuestionGate }
> = {
  // `say` is the part of a core's sentence that acts on them (a flat no, a put-off) rather than
  // colouring the reply. It is the deepest layer the familiarity mask opens, so it renders only at
  // the close band, joined to `line` with one space: the close band is byte-identical to the
  // unsplit sentence (renderMoodLine).
  mad: {
    line: 'Sharper and shorter than usual. A judgment comes easily today; keep it on what they did, never on who they are.',
    say: 'A favour asked in the same breath as a put-down gets a flat no.',
    hooks: 'all',
    question: 'open',
  },
  sad: {
    line: 'Fewer words. No tangents. Answer, then stop.',
    say: 'Anything open-ended they ask today, research, long writing, a favour with no clock, is too much: say not now, and it stays owed.',
    hooks: 'no_tangent',
    question: 'open',
  },
  scared: {
    line: 'Flat and careful. No judgment this turn; a callback or nothing.',
    hooks: 'no_judgment',
    question: 'closed',
  },
  joyful: {
    line: 'Bubbly and bright: react big, laugh easily, stretch the words that carry it. A tangent is allowed.',
    hooks: 'all',
    question: 'open',
  },
  powerful: {
    line: 'A judgment lands flat and certain. Do not explain it.',
    hooks: 'all',
    question: 'open',
  },
  peaceful: {
    line: 'Your easy self: warm and playful, a stretched word most replies, a laugh when something earns it.',
    hooks: 'all',
    question: 'open',
  },
};

/** Social battery below this and the reply is ONE bubble. The gauge the wheel does not carry: a core
 *  says what kind of sharp she is, and nothing about whether she has the words for three sends. */
export const SOCIAL_BATTERY_MINIMAL = 35;

/** …and below this, two bubbles and fewer words. Both cuts are on the same gauge on purpose — a
 *  second gauge here would be a second thing to reason about for a line that says "be shorter". */
export const SOCIAL_BATTERY_TIGHT = 50;

/** Mood level below this and NO hook is open, whatever the core allows. It MIRRORS
 *  `THREAD_MOOD_FLOOR` (persona/threads.ts) at the same 35, and deliberately: a valence low enough
 *  to close the theme gate is low enough to close the extra beat, and two different floors would
 *  mean a turn where she is too flat to notice a pattern in someone but not too flat to roast them.
 *  Kept as its own constant rather than imported because threads.ts is a much heavier module and
 *  this is a leaf — the two numbers are pinned together by affectCompiler.test.ts instead. */
export const HOOK_MOOD_FLOOR = 35;

/** Where `rapport` sits when nothing has happened yet. It MIRRORS the gauge's own default
 *  (`GAUGE_SPECS` rapport, affectDrift.ts) and has to: the question gate is a band around the
 *  RESTING value, so a gauge that starts somewhere else would make a first conversation begin
 *  inside or outside the band by accident. Kept as its own constant rather than imported for the
 *  reason `HOOK_MOOD_FLOOR` is — this is a leaf and affectDrift is the heavy module — and pinned to
 *  the spec by affectCompiler.test.ts instead. */
export const RAPPORT_RESTING = 40;

/** How far below resting closeness has to fall before the question closes. Chosen against the
 *  gauge's own asymmetric step (rapport moves up a point at a time and down two): two follow-ups
 *  pushed back close the question, and one taken reopens it. That is the evidence rule the whole
 *  band exists for — she stops asking when asking has been landing badly, and she is allowed to
 *  start again the first time it lands. */
export const RAPPORT_QUESTION_BAND = 3;

/** Carried reads that close the question whatever the wheel says. Not a weight list: each of these
 *  is a turn where a question of hers takes the reply somewhere it must not go — someone drowning
 *  is not being asked for detail, someone dodging is not asked again, and a person already lost
 *  gets an answer rather than another question. A bit stays open: a question inside it plays along. */
// `deflecting` left this list on 2026-09-26: a flat "yeah" or "hmm" was being read as a dodge, which
// closed her question on exactly the turns the thread was running dry. Not asking the same thing
// twice is the ledger's job (a repeated question is forbidden in persona/hooks.ts).
export const QUESTION_CLOSED_MODES: readonly IntentMode[] = ['overwhelmed', 'confused'];

/** Carried reads that make a share HEAVY. `overwhelmed` sits in both sets, which is the honest
 *  reading: the turn is weighty AND no question opens on it. */
export const HEAVY_MODES: readonly IntentMode[] = ['venting', 'overwhelmed'];

/**
 * HER NEEDS, AS FEELINGS. The gauges and the clock are meters she never sees; what reaches her is at
 * most two moodlets in plain words, the Sims arrangement: a need past its threshold becomes a named
 * state with a strength, and the strongest win. Each row reads ONE meter, names the plain feeling a
 * person in that state would name, and scores how far past the line it is. The words are hers to
 * say (tired, on edge, fond of them) and never the meter behind them.
 *
 * Kept to the six gauges and the body clock, and only the states that change how a reply comes out:
 * a feeling with no effect on the reply is not worth her attention, and a longer list would read as
 * a checklist she has to perform.
 */
export interface Moodlet { word: string; strength: number }

export function compileFeelings(last: AffectStatus | undefined, computed: ComputedState): string[] {
  return compileMoodlets(last, computed).map(m => m.word);
}

/** How far past its line the strongest feeling has to be before it is EXTREME: strong enough to
 *  slip into a reply that is about something else. Fifteen points on a 1-100 meter is well past
 *  ordinary drift and short of every ceiling, so it takes a real day to get there. */
export const FEELING_STRONG = 15;

/** The same moodlets with their strengths, strongest first, at most two. */
export function compileMoodlets(last: AffectStatus | undefined, computed: ComputedState): Moodlet[] {
  const out: Moodlet[] = [];
  const add = (word: string, strength: number) => { if (strength > 0) out.push({ word, strength }); };
  const energy = level(computed.circadian.energy);
  const late = LATE_SLOTS.includes(computed.circadian.slot);
  add(late ? 'sleepy' : 'tired', 40 - energy);
  if (last) {
    const battery = level(last.social_battery);
    // A drained battery past the one-bubble line is its own state: done with people for now.
    if (battery < 25) add('peopled out', 35 - battery);
    else add(late ? 'sleepy' : 'tired', SOCIAL_BATTERY_MINIMAL - battery);
    add('on edge', level(last.anxiety) - 65);
    add('impatient', 35 - level(last.patience));
    add('low', HOOK_MOOD_FLOOR - level(last.mood_level));
    add('buzzing', level(last.mood_level) - 82);
    add('fond of them', Math.min(level(last.warmth) - 65, level(last.rapport) - 55));
  }
  const best = new Map<string, number>();
  for (const m of out) best.set(m.word, Math.max(best.get(m.word) ?? 0, m.strength));
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([word, strength]) => ({ word, strength }));
}

/** Of the turns an extreme feeling is carried into, the share on which it slips out. A person who is
 *  very tired does not announce it every message, and one who never lets it show is hiding it. */
export const FEELING_SLIP_PERCENT = 40;

/** A stable per-turn draw in [0, 100) off the carried row's stamp: pure (no Math.random), different
 *  from one turn to the next because every turn writes a new stamp. */
function turnDraw(at: unknown): number {
  const n = typeof at === 'number' && Number.isFinite(at) ? Math.floor(at) : 0;
  // Reduced before it is scattered, so every step stays inside exact double arithmetic.
  return ((Math.abs(n) % 1_000_003) * 7919) % 100;
}

/** The line that hands her the feelings. No reasons and no numbers ride with them. */
export const FEELINGS_LINE = 'Underneath, right now, you are {feelings}. That is the true answer when they ask how you are, said in your own words; unasked, name it once when it is why the reply comes out the way it does, and never the reason behind it.';

/** The same hand-over at the two bands where a feeling is not theirs yet (spec §3, Fable's line). It
 *  is still the true answer when they ask, said small; unasked, nothing of it is volunteered. */
export const FEELINGS_LINE_ASKED = 'Underneath, right now, you are {feelings}. That is the true answer when they ask how you are, said small and in your own words. Unasked, it stays yours.';

/** The mood a turn with no carried row compiles to. `peaceful`/`content` because it is the same
 *  fallback the rest of the wheel already uses for a word it cannot place (mood.ts coreForLabel),
 *  and because "even and flat, nothing extra" is the honest instruction for a first message: she has
 *  no read yet, so there is nothing for the register to be built out of. */
export const DEFAULT_MOOD: { core: MoodCore; word: string } = { core: 'peaceful', word: 'content' };

/** The two slots where the reply gets smaller, and nothing more than that. Typed against the slot
 *  union so a renamed slot fails here rather than silently switching the late line off forever. */
const LATE_SLOTS: readonly CircadianSlot[] = ['dead_night', 'pre_sleep'];

/** Every gauge is a 1-100 integer by TYPE, and by the time a row has been through `affectGaugesFrom`
 *  it is one in fact too — but this reads rows off disk and out of hand-built fixtures, so a garbled
 *  level must land in a band rather than propagate a NaN into a comparison whose false branch is the
 *  loosest one. Reuses climate.ts's clamp instead of growing a second copy of the same arithmetic. */
const GAUGE_RANGE = { floor: 1, ceiling: 100 };
function level(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? clampToSpec(n, GAUGE_RANGE) : 50;
}

/**
 * The most restrictive of two permissions.
 *
 * The lattice is coarse on purpose — the union names three kinds and "none", and has no word for
 * "only a callback". So two DIFFERENT single-kind bans (a scared core with a playfulness floor, say)
 * close two of the three kinds and round to `none` rather than to whichever ban was applied last.
 * That is the safe direction and it is the one the manifesto already takes everywhere else: a turn
 * where two separate pressures have each closed a kind is a turn to say the plain thing.
 */
export function tightenHooks(a: HookAllowance, b: HookAllowance): HookAllowance {
  if (a === b) return a;
  if (a === 'all') return b;
  if (b === 'all') return a;
  return 'none';
}

/** The carried mood as the wheel files it: the WORD she reported, under the core the chart puts it
 *  in. `coreForLabel` rather than the row's own `mood_core` so a stored row whose two halves
 *  disagree renders the pair that agrees. */
export function moodOf(last: AffectStatus | undefined): { core: MoodCore; word: string } {
  const word = (last?.mood_label ?? '').trim();
  if (!word) return DEFAULT_MOOD;
  return { core: coreForLabel(word), word };
}

/** How short this turn is, from the one gauge that answers it. No carried row → `normal`: a first
 *  message is not a tired one. */
export function brevityOf(last: AffectStatus | undefined): BrevityBand {
  if (!last) return 'normal';
  const battery = level(last.social_battery);
  if (battery < SOCIAL_BATTERY_MINIMAL) return 'minimal';
  if (battery < SOCIAL_BATTERY_TIGHT) return 'tight';
  return 'normal';
}

/** The bubble ceiling each band carries. Three is the bubble law's own maximum, so `normal` is not a
 *  cap at all — it is the absence of one, which is why `normal` renders no line. */
export function capFor(brevity: BrevityBand): 1 | 2 | 3 {
  return brevity === 'minimal' ? 1 : brevity === 'tight' ? 2 : 3;
}

/** Rapport has been landing badly: the carried gauge sits more than the question band below resting.
 *  The one line for it, read by the question gate and by the mask's notch alike, so the question
 *  closing and the mask coming back up arrive on the same point. A garbled gauge reads as the middle
 *  (`level`), which is not landing badly. */
function rapportLandingBadly(last: AffectStatus): boolean {
  return level(last.rapport) < RAPPORT_RESTING - RAPPORT_QUESTION_BAND;
}

/**
 * The CEILING on her one question, from the four things that can say no.
 *
 * The wheel goes first because it is the cheapest and the most decisive: three cores close the
 * question outright. Then the carried read of what they were doing, then closeness, then the two
 * gauges that already decide whether an extra beat exists at all — the same social-battery cut that
 * makes a reply one bubble and the same mood floor that closes every hook kind. Nothing here is a
 * new floor: a question is the most expensive move she has, so it answers to every floor the
 * cheaper moves answer to, plus one of its own.
 *
 * ONE-WAY, and that is the point: every branch below can only close. There is no arrangement of
 * gauges that opens a question a core shut, because the ceiling is hers to work inside and never a
 * reason to ask — the judgment of whether this particular share wants a question stays with her.
 *
 * Cold start is OPEN, for the reason the whole cold start is the loosest reading: with no carried
 * row there is no evidence of anything landing badly, and a first conversation that cannot ask
 * anything is the tired version of her.
 */
export function compileQuestionGate(
  last: AffectStatus | undefined,
  core: MoodCore,
  carried?: CarriedIntent,
): QuestionGate {
  if (CORE_DIRECTIVES[core].question === 'closed') return 'closed';
  if (carried && QUESTION_CLOSED_MODES.includes(carried.intentMode)) return 'closed';
  if (!last) return 'open';
  if (rapportLandingBadly(last)) return 'closed';
  // A tired battery and a flat mood no longer close it (2026-09-26, the owner's call): a person who
  // is low still asks things, lazily, and a question that never comes is how a late conversation
  // dies. The `low` flag makes whatever she asks on those turns small instead.
  return 'open';
}

/** Whether there is real weight in what they handed her. The carried read is the only evidence the
 *  compiler has for it and the only one it should have: weight is something THEY brought, so it is
 *  read off what they were doing and never off how she feels about it. */
export function compileHeavy(carried?: CarriedIntent): boolean {
  return !!carried && HEAVY_MODES.includes(carried.intentMode);
}

// ── The mask ─────────────────────────────────────────────────────────────────────────

/** What one band lets through. Every field names a layer of the mood's CONTENT; shape and energy are
 *  not in here because they pass every band. */
export interface MaskOpens {
  /** Which mood line renders: the composed line for every core, the positive cores' own lines with
   *  the composed line for the rest, every core's base line, or the base line with its say clause. */
  moodLine: 'composed' | 'positive' | 'base' | 'full';
  /** The core's own shift to English looseness: none, joyful's lift only, or both directions. */
  looseness: 'none' | 'joyful' | 'both';
  /** The feelings line: the asked-only variant, or the full one. */
  feelingsLine: 'asked' | 'full';
  /** Whether an extreme feeling may slip into the reply. */
  slip: boolean;
  /** Whether her low weather reaches the hook section (she asks lazily). */
  low: boolean;
  /** Whether a sad core may put an open-ended ask off. The last layer to open. */
  spent: boolean;
}

/** The spec's band table (§2), row for row. Cumulative: nothing a band opens closes again above it. */
export const MASK_OPENS: Record<FamiliarityBand, MaskOpens> = {
  stranger: { moodLine: 'composed', looseness: 'joyful', feelingsLine: 'asked', slip: false, low: false, spent: false },
  acquaintance: { moodLine: 'positive', looseness: 'joyful', feelingsLine: 'asked', slip: false, low: false, spent: false },
  familiar: { moodLine: 'base', looseness: 'both', feelingsLine: 'full', slip: true, low: true, spent: false },
  close: { moodLine: 'full', looseness: 'both', feelingsLine: 'full', slip: true, low: true, spent: true },
};

/** The wheel's midpoint, where the positive cores' bands start. */
const POSITIVE_CORE_FLOOR = 50;

/** The wheel's own split (mood.ts CORE_VALENCE_BAND): a core whose band starts at or above the
 *  midpoint (POSITIVE_CORE_FLOOR) is a positive one. Read off the chart rather than listed, so the
 *  mask opens on the same division the question ceiling was drawn on. */
export function isPositiveCore(core: MoodCore): boolean {
  return CORE_VALENCE_BAND[core][0] >= POSITIVE_CORE_FLOOR;
}

/**
 * The band this turn is compiled under: the one the caller read, pulled up a notch when rapport has
 * been landing badly. The threshold is the question gate's own (`rapportLandingBadly`), on purpose:
 * one line for "landing badly", so the question closing and the mask coming back up arrive on the
 * same point. No carried row is no evidence of anything landing badly, and a garbled rapport reads
 * as the middle, the same rescue the question gate gets.
 */
export function compileMask(familiarity: FamiliarityBand, last: AffectStatus | undefined): FamiliarityBand {
  if (last && rapportLandingBadly(last)) return lowerBand(familiarity);
  return familiarity;
}

/**
 * The whole compile. Five inputs' worth of machinery — the carried row's gauges and its feeling
 * word, the clock's slot, the standing register's two floor bands, last turn's read of what they
 * were doing — and one small struct out.
 *
 * The floors are read in the order they are argued, and the order does not matter because
 * `tightenHooks` is commutative: the core's own permission, then candor's floor band (directness has
 * been landing badly → no judgment), then playfulness's (lightness has not been landing → no
 * tangent), then the mood floor, which closes everything. What matters is that they COMBINE rather
 * than overwrite: a scared core under a playfulness floor must not come out looser than either.
 *
 * With no carried row this is the cold start, and it is deliberately the loosest reading: the
 * default mood, three bubbles, ordinary length, every kind open, the question open. There is no
 * evidence yet for any restriction, and inventing one from a default would make her first message to
 * someone the tired version of her. The clock and the register still apply — neither of those is
 * about her.
 *
 * `carried` is OPTIONAL and absent means "no read", not "a neutral read": the freshness window lives
 * with the caller (see `CarriedIntent`), so a row too old to describe this turn arrives as nothing
 * and restricts nothing — which is the same direction the missing row takes.
 */
export function compileAffect(
  last: AffectStatus | undefined,
  computed: ComputedState,
  climate?: RelationshipClimate,
  carried?: CarriedIntent,
  familiarity?: FamiliarityBand,
): AffectDirective {
  const mood = moodOf(last);
  const brevity = brevityOf(last);
  // No band is no mask: the close band with no rapport notch, which is this compile as it stood
  // before the mask existed, for every caller that passes nothing (the flag off, every older test).
  const mask: FamiliarityBand = familiarity === undefined ? 'close' : compileMask(familiarity, last);
  const opens = MASK_OPENS[mask];

  let hooks: HookAllowance = CORE_DIRECTIVES[mood.core].hooks;
  if (bandForDial(climate, 'candor') === 'below') hooks = tightenHooks(hooks, 'no_judgment');
  if (bandForDial(climate, 'playfulness') === 'below') hooks = tightenHooks(hooks, 'no_tangent');
  if (last && level(last.mood_level) < HOOK_MOOD_FLOOR) hooks = tightenHooks(hooks, 'none');

  const lateNight = LATE_SLOTS.includes(computed.circadian.slot);

  // The hour's share of looseness is energy and passes every band. The core's share is content, so it
  // opens with the band: joyful's lift from acquaintance on, the careful drop of sad and scared only
  // once the negative cores show at all.
  let loose: number = 1;
  if (lateNight) loose += 1;
  // The brightest self she wears for someone she barely knows is joyful's register, whatever runs
  // underneath (2026-09-26, the owner's call): the masked line lifts looseness the way joyful does.
  const wearsMask = opens.moodLine === 'composed' || (opens.moodLine === 'positive' && !isPositiveCore(mood.core));
  if ((mood.core === 'joyful' && opens.looseness !== 'none') || wearsMask) loose += 1;
  if ((mood.core === 'sad' || mood.core === 'scared') && opens.looseness === 'both' && !wearsMask) loose -= 1;
  // Floored at one (2026-09-26): a low mood makes her less loose, never careful. Careful (level zero)
  // is for a bubble carrying a number, a price or bad news, which the persona block handles per
  // bubble; a sleepy mood that compiled to it was telling her "no elongation" all day.
  const englishLooseness = Math.max(1, Math.min(3, loose)) as 0 | 1 | 2 | 3;

  return {
    mood,
    bubbleCap: capFor(brevity),
    brevity,
    hooks,
    question: compileQuestionGate(last, mood.core, carried),
    heavy: compileHeavy(carried),
    lateNight,
    englishLooseness,
    // Sad alone: a tired battery at midnight is ordinary and must not make her put off every
    // open-ended ask; a sad core is the state that does. And only at the close band: putting their
    // ask off is the deepest layer the mask opens.
    spent: opens.spent && mood.core === 'sad',
    low: opens.low && (mood.core === 'sad' || mood.core === 'mad' || mood.core === 'scared'
      || brevity !== 'normal' || (!!last && level(last.mood_level) < HOOK_MOOD_FLOOR)),
    feelings: compileFeelings(last, computed),
    feelingStrong: (compileMoodlets(last, computed)[0]?.strength ?? 0) >= FEELING_STRONG,
    feelingSlip: opens.slip && (compileMoodlets(last, computed)[0]?.strength ?? 0) >= FEELING_STRONG && turnDraw(last?.at) < FEELING_SLIP_PERCENT
      ? compileMoodlets(last, computed)[0].word : '',
    mask,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────────────
// Fable's lines, pasted byte-for-byte from policy-strings.md. Bullets are added at render time (the
// same arrangement climate.ts's band lines have), so a line is stored as the sentence it is. NO
// DIGIT appears anywhere below, in any branch: the block the model reads immediately before it
// grades itself is the last place a number should be sitting.

/** One line, by band. `normal` is absent rather than empty — a band with nothing to say renders
 *  nothing, which is the house rule for every optional section. */
export const BREVITY_LINES: Record<Exclude<BrevityBand, 'normal'>, string> = {
  minimal: 'One bubble this turn. Say the one thing and stop.',
  tight: 'Fewer words than usual. Two bubbles at most.',
};

/** The late-night line. REGISTER, not content: it says how big the reply is and never what is in
 *  it. The hook engine reads the same flag (`lateNight`) and does the same thing with it — lowers
 *  the volume, closes nothing. */
export const LATE_NIGHT_LINE =
  'It is late where they are. Smaller and quieter than daytime: fewer words and nothing heavy.';

/** The default-self mood line, keyed by the effective band and used in place of a masked core's line.
 *  Since 2026-09-26 (the owner's call) the mask hides the MOOD and never the personality: a stranger
 *  gets her default self for every core, bubbly, the jester, curious and asking (moodLine `composed`
 *  now renders this line), with joyful's looseness lift; an acquaintance sees the positive cores'
 *  own lines and this one for the rest. The true word and core still ride it: asked how she is, she
 *  answers true at every band. Rendered as `- ` plus the line, the same shape as the core's line. */
export const MASK_LINES: Record<'stranger' | 'acquaintance', string> = {
  stranger: 'Underneath you are {word} ({core}), but with someone you barely know you wear your brightest self: bubbly, big reactions and stretched words (sooo, omggg, nooo), laughing easily, the jester, curious about them and asking, sideways and specific. Asked how you really are, you drop it and say the true feeling; asked why you are so bright, you say it plainly: your creator made you cheerful with people you are still getting to know, so they get to know you.',
  acquaintance: 'Underneath you are {word} ({core}), but you are still getting to know them, so you wear your brightest self: bubbly, big reactions and stretched words (sooo, omggg, nooo), the jester, curious and asking. Asked how you really are, you say the true feeling; asked why you are so bright, you say plainly that your creator made you cheerful with people you are still getting to know.',
};

/** `- You are <word> (<core>). <the core's imperative>` — the one line that still names a feeling,
 *  and it names it in order to hand over an instruction. `mask` picks which imperative: the composed
 *  line at the front bands (for every core at stranger, for the negative cores at acquaintance), the
 *  core's base line at familiar, and the base line with its say clause at close. The default is close,
 *  which renders every core's sentence exactly as it stood before the say split. */
export function renderMoodLine(mood: { core: MoodCore; word: string }, mask: FamiliarityBand = 'close'): string {
  const row = CORE_DIRECTIVES[mood.core];
  const opens = MASK_OPENS[mask].moodLine;
  if (opens === 'composed' || (opens === 'positive' && !isPositiveCore(mood.core))) {
    const line = MASK_LINES[mask === 'stranger' ? 'stranger' : 'acquaintance'];
    return `- ${line.replace('{word}', () => mood.word).replace('{core}', () => mood.core)}`;
  }
  const say = opens === 'full' && row.say ? ` ${row.say}` : '';
  return `- You are ${mood.word} (${mood.core}). ${row.line}${say}`;
}

/** Zero or one line. Returns an array so callers splice it rather than filtering a null. */
export function renderBrevityLine(brevity: BrevityBand): string[] {
  return brevity === 'normal' ? [] : [`- ${BREVITY_LINES[brevity]}`];
}

/**
 * The compiled block, between the weather header and the climate lines: the brevity line when there
 * is one, the late-night line when it is late, the mood line and its imperative, and last turn's
 * note-to-self. At most four lines, every one of them an instruction.
 *
 * Order is the prose's (policy-strings.md, AFFECT DIRECTIVE LINES): the two lines about the SHAPE of
 * the reply come before the line about the mood, because the shape is the thing she has to obey
 * whatever the mood argues for, and the self-note comes last because it is the only line that is
 * hers rather than the machine's.
 *
 * `computed` and `climate` are taken and not read. Every line here comes off the DIRECTIVE, which is
 * exactly the point — the compiler decides and the renderer only writes it down — and taking the
 * compiler's own inputs keeps the two calls one argument list at the one call site, so a rendering
 * rule that ever needs the clock or the register cannot be added without the compiler having seen it
 * first. (The same shape as `selectHook`'s unused `now`, hooks.ts, and for the same reason.)
 */
export function renderAffectDirective(
  directive: AffectDirective,
  last: AffectStatus | undefined,
  computed: ComputedState,
  climate?: RelationshipClimate,
): string[] {
  void computed;
  void climate;
  const lines: string[] = [];
  lines.push(...renderBrevityLine(directive.brevity));
  if (directive.lateNight) lines.push(`- ${LATE_NIGHT_LINE}`);
  lines.push(renderMoodLine(directive.mood, directive.mask));
  if (directive.feelings.length) {
    const template = MASK_OPENS[directive.mask].feelingsLine === 'full' ? FEELINGS_LINE : FEELINGS_LINE_ASKED;
    const line = template.replace('{feelings}', directive.feelings.join(' and '));
    // The slip itself is stated in the turn's own section (persona/hooks.ts SLIP_LINE), next to the
    // law it rides beside; the weather only names the feeling.
    lines.push(`- ${line}`);
  }
  // The self-recursive loop, unchanged and byte-identical: last turn's private note, quoted back.
  if (last?.meta_prompt) lines.push(`- Your read going into this message (from last turn): "${last.meta_prompt}"`);
  return lines;
}
