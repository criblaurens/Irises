// The HOOK engine: what a turn is allowed to carry, which kinds are still open to it, and the
// ledger that makes three sharp replies in a row cost the fourth one.
//
// A hook is the ONE extra beat an idle turn may carry — a judgment, a callback, or a tangent. It
// exists because the alternative is the failure this whole build is named after: "hey" answered
// with "hey", a contentless reply that spends a turn and hands back nothing. Task turns get NO hook
// (the answer, flat, with the real numbers, is the entire reply), and quiet turns get less than
// that. So the modes are not volumes of the same voice — they are different contracts, and exactly
// one of them is live per turn.
//
// A SHARE turn is the fourth contract and the one that inverts the arithmetic above. They handed her
// something and asked for nothing, which is a bid, and the move is not an extra beat after an answer
// — it IS the reply, because there is nothing else for the reply to be. So the share branch has no
// kill switch (a run of moves on share turns is a conversation, not a tic), never goes quiet (a bid
// answered with silence is the receipt this shape exists to refuse), and is the one place the fourth
// kind — the question — can be open at all. Everything else it reads, it reads the same way a hook
// turn does: the repeated tail kind, the mood's own bans, the room.
//
// Doctrine, inherited whole from threads.ts next door: the model contributes ONE word inside the
// envelope it already emits (`hook_kind`), and every count, transition and budget below is
// arithmetic over one stored row. Nothing here costs an LLM call. Nothing here reads a clock — the
// engine is PURE the way `applyThreadHarvest` is: `now` injected, inputs never mutated, and every
// turn the selector ran landing in exactly one disjoint `reason` bucket, so a receipt can never say
// two things at once about why she went quiet.
//
// This file is a LEAF: it imports nothing, from anywhere. status.ts (the envelope field), the db
// (the ledger row) and the convo lane (the caller) all sit DOWNSTREAM of it, and the convergence
// battery re-exports the constants below as VALUES rather than re-typing the numbers — a threshold
// pinned to a copied number is a threshold that silently stops describing the engine.
//
// The kill switch is the load-bearing piece. Three hooked replies in a row and the fourth IDLE turn
// goes quiet whatever else is true: it outranks the affect floor, the group rules, the moment
// sampler and the thread offer. Someone who has sent nothing four times running is not asking for a
// fourth clever line, and a bot that keeps producing them is the exact thing the manifesto refuses.
// What it is a switch on is SILENCE answered with cleverness, which is why a share turn is outside
// it: the person on the other end just said something.

/** The kinds of move a reply may carry, and the ONLY words the model may emit in `hook_kind`. The
 *  runtime list lives beside the type it describes (threads.ts's THEME_KINDS precedent) because the
 *  rendered sections build their "open to you" sentence out of THIS array: a kind added to the type
 *  alone would be a word the schema accepted, the ledger recorded, and the prompt never named.
 *
 *  Why these three first: a judgment CLOSES a beat (they now have to prove or disprove it), a
 *  tangent OPENS one, and a callback does both. `question` is the fourth, and it is the odd one —
 *  the other three are things she does with what she already holds, and a question is the one move
 *  that asks THEM for something. It is therefore not a kind an idle turn can reach: nothing was
 *  shared, so there is nothing to follow up on, and a question into that silence is the probe the
 *  whole ban was written against. It belongs to the turn where they handed her something, and the
 *  list below (HOOK_MODE_KINDS) is what keeps the idle section from ever naming it. The word lives
 *  in the ledger, the schema and the envelope from here, so the one place that decides whether it
 *  is open is the selector and not the vocabulary. */
export const HOOK_WORDS = ['judgment', 'callback', 'tangent', 'question'] as const;

/** What the model may emit. */
export type HookWord = typeof HOOK_WORDS[number];

/** The kinds an idle HOOK turn may carry. All four — judgment, callback, tangent, and question —
 *  are open, with the question gated by the affect ceiling and the group rule (the same gates the
 *  share branch uses). Two readers must agree on the available set: `hookKindOpen` (is there a beat
 *  left) and `renderHooksSection` (which beats to name). Both reach this list through `namableKinds`
 *  rather than naming it directly. */
const HOOK_MODE_KINDS: readonly HookWord[] = HOOK_WORDS;

/**
 * Which kinds a MODE is allowed to name at all — four on a share turn, three on a hook turn.
 *
 * The vocabulary is one list and the modes disagree about one word in it, so the disagreement lives
 * in exactly one function and every reader asks it: `hookKindOpen` (is there a move left) and the
 * renderer's own allowed set (which moves to name). A mode is handed in rather than a directive
 * because that is all the question is about — the forbidden list is the caller's other half of it.
 *
 * `task` and `quiet` name nothing, which is not a special case: the MODE has already spent the turn,
 * and a kind named in either block would be an instruction to think about a move that is not
 * available. The empty list is that fact, arithmetically.
 */
function namableKinds(mode: HookMode): readonly HookWord[] {
  if (mode === 'share') return HOOK_WORDS;
  if (mode === 'hook') return HOOK_MODE_KINDS;
  return [];
}

/** What the LEDGER records. `none` is a first-class entry, not a gap: a flat task answer and a
 *  quiet reply both push `none`, and that is precisely what breaks a run — the kill switch reads a
 *  window of three, so one plain reply anywhere in it buys the next hook back. Without the `none`
 *  rows the window would silently span weeks of conversation. */
export type HookKind = HookWord | 'none';

/** The rhythm ledger for one chat. Deliberately four small numbers and nothing else: this row is
 *  read before every turn and written after every turn, so anything expensive here is expensive
 *  forever. `lastKinds` is capped at HOOK_RUN_LIMIT, most recent LAST (append order, so the tail is
 *  the run the kill switch reads). */
export interface HookState {
  lastKinds: HookKind[];
  /** Consecutive idle turns. Rendered to the model as material — how many times in a row they have
   *  sent nothing is a checkable fact about them, and checkable facts are what a hook is made of. */
  idleStreak: number;
  /** Idle turns since a moment was last offered. The sampler's spacing clock, kept separately from
   *  `idleStreak` because a moment offered on turn one must not also reset the streak she is
   *  allowed to talk about. */
  idleSinceMoment: number;
  /** Injected, never `Date.now()` — see the file header. */
  updatedAt: number;
  /** When she last turned down a quiz. Inside QUIZ_PUSH_MS the next task is read as them pushing
   *  for it, and she gives in, annoyed. Cleared once she has. */
  quizzedAt?: number;
  /** Moves of hers they let lie (recordDodge), newest last, at most DODGE_KEEP. */
  dodges?: Dodge[];
  /** The dodge her last reply was allowed back to, so the next turn can tell what they did with it. */
  curiousAt?: number;
}

/** A move of hers they dodged. `at` is her message's own stamp, which is also how the recency edge
 *  points at it: by the transcript's clock label, never by her words, because words named back to
 *  her are words she reaches for. */
export interface Dodge {
  at: number;
  /** When they dodged it. */
  since: number;
  /** They bristled, or it was tender for them: gone for DODGE_DROPPED_MS, no curiosity draw. */
  dropped?: true;
  /** Her one way back in is spent. */
  reraised?: true;
}

/** The resting state: no history, no streak, and `idleSinceMoment` at zero so a brand-new chat must
 *  earn its first callback the same way an old one earns its next. */
export function defaultHookState(): HookState {
  return { lastKinds: [], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0 };
}

/** How long a run of hooked replies may get before the next turn is forced quiet, and — the same
 *  number, deliberately — how many entries the ledger keeps. One constant rather than two because
 *  the ledger holds EXACTLY the window the switch reads: a fourth remembered kind would be a kind
 *  nothing consults, and a two-entry ledger would be a switch that can never fire. */
export const HOOK_RUN_LIMIT = 3;

/** Idle turns that must pass between one moment offer and the next. Moments are the scarcest
 *  material she has — a callback lands because it is rare, and a bot that reaches for its diary
 *  every idle turn is a filing system reading itself out loud. */
export const MOMENT_IDLE_INTERVAL = 4;

/** The ceiling on a quiet reply's first bubble. A quiet turn is one short thing or nothing; past
 *  this many words it is a paragraph wearing a short reply's clothes, which is the violation the
 *  corrective re-ask exists to catch. */
export const QUIET_MAX_WORDS = 12;

/** This turn's contract, in the four shapes it can take.
 *  • `task`  — she was asked for something. Nothing renders; no hook, no offer, no moment.
 *  • `quiet` — the kill switch or the affect floor fired. Less than a hook: one short bubble, a
 *              tapback, or nothing.
 *  • `hook`  — an idle turn with budget left. One extra beat, of a kind not in `forbidden`.
 *  • `share` — they handed her something. One move, of a kind not in `forbidden`, and the move is
 *              the whole reply rather than a beat after one. Never forced quiet.
 *
 *  FOUR MODES OVER THREE TURN KINDS, and the asymmetry is the point: `task` and `share` are the
 *  gate's own answers, while an idle turn splits in two on the ledger and the mood. So the mode is
 *  what every downstream reader wants (the section, the anchor, the receipt) and the KIND is what
 *  the caller hands in. */
export type HookMode = 'task' | 'quiet' | 'hook' | 'share';

/** The kind of turn the gate read, as the selector takes it. MIRRORED from persona/idle.ts's
 *  `TurnKind` — structurally identical, so the gate's own reading assigns straight into the
 *  parameter — and declared here rather than imported for the reason `idleLayer` below is a plain
 *  `string`: this file is a leaf, and a leaf that imported the gate's vocabulary would be a leaf
 *  that depends on the gate. The layer is a passthrough and can stay a string; this one BRANCHES,
 *  so it has to be the union. */
export type TurnKind = 'task' | 'idle' | 'share';

/** What the compiled affect directive allows this turn. Declared HERE as a structural subset rather
 *  than imported from the affect compiler: this is a leaf, and the compiler is free to grow fields
 *  that the rhythm engine has no business knowing about. The union is the compiler's own. */
export type HookAllowance = 'all' | 'no_judgment' | 'no_tangent' | 'none';

/** Whether her one question is available this turn at all — the compiler's ceiling, mirrored the way
 *  `HookAllowance` is and for the same reason. `open` is a PERMISSION and never an instruction: it
 *  means the kind may stay in the allowed set and she judges whether this particular share wants a
 *  question. Nothing here ever turns `closed` back into `open`. */
export type QuestionGate = 'open' | 'closed';

/** The slice of the affect directive the selector reads. Structurally satisfied by the compiler's
 *  full `AffectDirective`, so the caller passes the directive itself and nothing converts. */
export interface HookAffectInput {
  hooks: HookAllowance;
  /** The ceiling on the fourth kind. Read ONLY by the share branch: an idle turn forbids the
   *  question whatever this says, because nothing was shared for it to follow up on. */
  question: QuestionGate;
  /** They brought real weight (the compiler's read of what they were doing). Narrows a share turn
   *  to the kinds that are company rather than analysis. */
  heavy: boolean;
  lateNight: boolean;
  /** The climate's playfulness band, passed through as a plain string because this file is a leaf.
   *  'below' | 'none' | 'raised' | 'high'. Defaults to 'none' when absent. */
  playfulnessBand?: string;
  /** The thread_outcome emitted on the previous turn: 'took' | 'passed' | 'pushed_back', or null
   *  when there is no prior turn or the model did not emit one. */
  lastOutcome?: string | null;
  /** The compiled English looseness for this turn. Absent or one means normal baseline (no line
   *  rendered). Passed through so the renderer can write the instruction without seeing the
   *  affect compiler. */
  englishLooseness?: number;
  /** She is running on empty this turn (affect compiler `spent`): a sad core. Read only by the
   *  task branch, where it marks the directive so the recency edge states
   *  the tired law (persona/policy.ts, the `spent` drift mode). */
  spent?: boolean;
  /** Her weather is low (a sad, mad or scared core, a flat mood, a tired battery). Carried onto the
   *  directive so the section tells her to keep whatever she asks lazy and low-effort. */
  low?: boolean;
  /** The extreme feeling that slips out this turn (affect compiler `feelingSlip`), or absent. */
  slip?: string;
  /** How likely she is, this turn, to come back to a plain dodge after its cooldown: curiosityPercent
   *  off her mood. Absent reads as none. */
  curiosity?: number;
  /** DODGE_COOLDOWN_MS unless overridden (a battery sets it short). */
  dodgeCooldownMs?: number;
  /** They are a stranger to her (the familiarity mask's effective band). Her default self gets to
   *  know someone by asking, so a judgment, which needs material she does not have yet, is closed. */
  stranger?: boolean;
}

/** 0 = no comedy, 1 = dry, 2 = normal, 3 = hot. The dial the jester reads before deciding
 *  how far to reach. Computed from the turn kind, the affect, the climate's playfulness, and
 *  whether the last joke landed. */
export type PlayLevel = 0 | 1 | 2 | 3;

/** The decision, as the prompt renderer and the thread engine consume it. */
export interface HookDirective {
  /** They sent nothing this turn. TRUE on `hook` and `quiet`, false on `task` — and false on
   *  `share`, which is the one that has to be said out loud: a share turn is the opposite of an idle
   *  one (they said something) and the streak this flag feeds counts turns where they said nothing. */
  idle: boolean;
  mode: HookMode;
  /** Kinds that may NOT be emitted this turn. Only ever populated in `hook` and `share` mode: on a
   *  task or a quiet turn the MODE forbids every kind already, and listing them there would give two
   *  different answers to "what stopped this hook". */
  forbidden: HookWord[];
  /** There is real weight in what they handed her. Set ONLY on a share turn, because weight is a
   *  property of the thing THEY brought and nothing is brought on an idle or a task turn — which is
   *  also why an absent field reads as no weight rather than as unknown. Two readers: the kinds this
   *  turn narrows to (here), and the climate span, which must not tell her a tangent is welcome on
   *  the turn someone let the tank out. */
  heavy?: boolean;
  /** It is late where they are. REGISTER ONLY, and passed through in every mode so a consumer can
   *  read it without first checking which branch it came from. It closes no kind, shuts no sampler
   *  and selects no mode: a late idle turn is an ordinary idle turn whose reply is smaller. The
   *  clock decides the volume; the mood, the register and the ledger decide the content. */
  lateNight: boolean;
  /** Whether the moment sampler may run — and, downstream, whether sampled moments render at all. */
  moments: boolean;
  /** Whether the thread engine may make an OFFER this turn. The engine keeps running either way:
   *  the outcome ask and the pending machine are bookkeeping and must not skip a beat. */
  offerAllowed: boolean;
  /** How hard the jester may reach this turn. 0 = no comedy (task, quiet, heavy). 1 = dry
   *  (light touch). 2 = normal. 3 = hot (reach further, the bridge can be longer). */
  playLevel: PlayLevel;
  /** How loose her English runs this turn. Absent or one means normal baseline (no line rendered).
   *  Zero is careful (serious moment or numbers), two is loose, three is messy. */
  englishLooseness?: 0 | 1 | 2 | 3;
  /** A task turn whose ask is her own take (persona/idle.ts, TAKES). Only ever set on `task`: the
   *  answer is still owed, so nothing about the mode changes, but the answer is her opinion and her
   *  mood decides how hard the jester may reach in it (`playLevel` is computed, not zeroed). */
  take?: boolean;
  /** A task turn on which she is running on empty: an open-ended ask gets a not now and stays owed,
   *  while a fact, a clock or their safety is still answered. Only ever set on a plain `task`. */
  spent?: boolean;
  /** Her weather is low this turn: what she asks, she asks lazily (LOW_LINE). */
  low?: boolean;
  /** The extreme feeling of hers that slips into this reply, stated at the recency edge
   *  (persona/policy.ts renderDriftAnchor). Never on a quiet turn. */
  slip?: string;
  /** A task turn that is a quiz a small child could pass, put to her as a test (persona/idle.ts
   *  `quiz`), and which way she takes it: `refuse` holds the answer back, `roast` gives it with a
   *  twist that makes it a dig at them. Only ever set on `task`; the edge states the law (policy.ts). */
  quiz?: 'refuse' | 'roast';
  /** Dodged moves the recency edge names this turn: the ones still spent, and at most one she is
   *  curious enough to come back to. Stamps; the prompt renders them as transcript clock labels. */
  dodges?: { spent: number[]; curious?: number };
  /** The task right after she turned a quiz down: likely them pushing for it, so she answers it
   *  this time, visibly annoyed, or answers whatever real thing they moved on to. */
  quizPushed?: true;
  /** One of the turns her opinion on what they should do comes out as the move (PUSH_PERCENT of the
   *  hook and share turns that have a move open). Stated in the section and at the recency edge. */
  push?: true;
}

/**
 * Does this turn actually have a beat she may spend?
 *
 * `mode === 'hook'` is NOT that question: hook mode with every kind forbidden is a real shape (a
 * room that closes judgment, plus a flattened mood that closes tangent, plus a callback she just
 * used twice), so the mode says "hook" while the turn has nothing open. Anything that changes what
 * the model READS on the strength of a hook has to ask this question instead of the mode — the
 * climate span in the internal-weather block (persona/climate.ts HOOK_NAMING, gated at the
 * assembler seam) and the drift anchor's law at the recency edge both do. Ask the mode and such a
 * turn is handed "a tangent or a callback is expected of you here" beside "No kind is open this
 * turn", which is two copies of one turn disagreeing.
 *
 * The renderer itself builds the same reading out of the same two fields (`allowed.length > 0` in
 * `renderHooksSection`), because it needs the LIST and not just the answer; this is the predicate
 * for every consumer that only needs the answer. It is computed the same way the renderer computes
 * it — over the SET of kinds, never by counting `forbidden` — so a directive whose `forbidden`
 * happened to carry a duplicate could not tell the predicate "closed" and the renderer "open". The
 * set is the MODE's own (`namableKinds`), which is why the same question has two different answers
 * about the same word: a question is not a beat a hook turn may spend, so on a hook turn it can
 * neither be left open into this answer nor forbidden out of it, and on a share turn it is the
 * fourth move and counts like the other three.
 *
 * A SHARE turn answers here too, and it has to: the two consumers are the climate span and the
 * anchor's law, and both of them ride every turn. A share turn with every kind spoken for is the
 * presence case — one plain sentence about their thing — and a span telling her a tangent is welcome
 * there is the same contradiction in a different mode.
 */
export function hookKindOpen(directive: HookDirective | null | undefined): boolean {
  return !!directive && namableKinds(directive.mode).some(w => !directive.forbidden.includes(w));
}

/** Why this turn got the mode it got. The buckets are DISJOINT and cover every path: a receipt that
 *  could say both `kill_switch` and `affect_floor` would make the battery unable to tell a working
 *  kill switch from a flat mood. The clock has no bucket, because the clock decides nothing here —
 *  a late turn lands in `hook` like any other idle turn and reads its register off `lateNight`.
 *
 *  `share` is a bucket of its own and not a flavour of `hook`, for the reason every other bucket is
 *  one: the battery scores a shape off the name, and a turn that took the bid branch — no kill
 *  switch, no quiet, the fourth kind reachable — has to be tellable from an idle turn that happened
 *  to leave the same three kinds open. It is also the bucket with no counter-case: a share turn
 *  cannot land anywhere else. */
export type HookSelectReason = 'not_idle' | 'kill_switch' | 'affect_floor' | 'hook' | 'share' | 'take' | 'quiz' | 'quiz_pushed';

/** The receipt half. Names and numbers only — never her words, never a moment's text. */
export interface HookSelectReport {
  reason: HookSelectReason;
  /** Which layer of the idle gate decided: `veto` | `fast_path` | `classify` | `none`. Passed in by
   *  the caller and carried through untouched, as a plain string on purpose — the layer names belong
   *  to the idle gate, and a leaf that typed them would be a leaf that depends on it. */
  idleLayer: string;
  forbidden: HookWord[];
  lastKinds: HookKind[];
  push?: true;
}

/**
 * How hard the jester may reach this turn.
 *
 * The dial reads four signals: the turn kind (task and quiet are always 0), the affect's hook
 * allowance (a floor on bad days), the climate's playfulness band (the weeks-scale register),
 * and whether the last joke landed (thread_outcome from the previous turn).
 *
 * 0 = no comedy. 1 = dry, light touch. 2 = normal reach. 3 = hot, reach further.
 */
function computePlayLevel(
  mode: HookMode,
  affect: HookAffectInput,
): PlayLevel {
  if (mode === 'task' || mode === 'quiet') return 0;
  if (affect.heavy) return 0;
  if (affect.hooks === 'none') return 0;

  let level = 1;
  const band = affect.playfulnessBand ?? 'none';
  if (band === 'raised') level += 1;
  else if (band === 'high') level += 2;
  else if (band === 'below') level -= 1;

  if (affect.lastOutcome === 'took') level += 1;
  else if (affect.lastOutcome === 'pushed_back') level -= 1;

  return Math.max(0, Math.min(3, level)) as PlayLevel;
}

/** The kind repeated at the tail of the ledger, if any. Two of the same kind in a row is the point
 *  at which a bot has a tic rather than a read, so the third is forbidden — and `none` is exempt,
 *  because two flat replies in a row is just a conversation. */
function repeatedTailKind(lastKinds: readonly HookKind[]): HookWord | null {
  const last = lastKinds[lastKinds.length - 1];
  const prev = lastKinds[lastKinds.length - 2];
  if (!last || last !== prev || last === 'none') return null;
  return last;
}

/**
 * This turn's contract, plus the receipt that explains it.
 *
 * Order is the whole design. The kill switch is tested BEFORE the affect floor and before anything
 * that could spend budget, because a run of three is a fact about the conversation that no mood,
 * no room and no sampler may talk its way past. `now` is taken (and, today, unused) so the entry
 * point matches every other engine in this stack: no branch added here can ever be the one that
 * reaches for the wall clock.
 *
 * THE CLOCK IS NOT A BRANCH. `affect.lateNight` is carried into every directive and consulted by
 * none of them: it is a register, so it changes the SIZE of the reply (the rendered late line) and
 * never which kinds are open, whether the sampler runs, or which mode the turn is in. A late idle
 * turn is an ordinary idle turn — whatever the mood, the room and the ledger left open stays open,
 * and the kill switch plus the no-same-kind-three-times rule supply the same variety at 2am they
 * supply at noon. This used to be a branch that forbade every kind, which made "go to sleep" the
 * only content a late turn could hold and turned one hour of the clock into a script.
 *
 * THE SHARE BRANCH SITS ABOVE THE KILL SWITCH, which is the one ordering decision in this function
 * that is not about precedence but about scope. The switch exists because four silences answered
 * with four clever lines is a bot performing at someone; a share turn is the opposite situation —
 * they spoke — so the run of moves the switch counts is not evidence of anything on it. Nothing
 * below it can force a share turn quiet either: a bid met with silence is the receipt this whole
 * shape was built to refuse, so the flat-mood floor narrows a share turn to presence instead of
 * closing it, and the turn still has to say one plain thing about their thing.
 */
/** How many dodges the ledger keeps, and how long each kind stays spent. */
export const DODGE_KEEP = 3;
export const DODGE_PLAIN_MS = 12 * 60 * 60 * 1000;
export const DODGE_DROPPED_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a plain dodge is off the table before her curiosity gets a say. */
export const DODGE_COOLDOWN_MS = 30 * 60 * 1000;

/** The mood words of her curious state; the joyful core carries them (persona/mood.ts). */
const CURIOUS_LABELS: ReadonlySet<string> = new Set(['curious', 'fascinated', 'stimulated']);

/** How likely she is to come back to a plain dodge on a given turn, from her mood. Her own claim of
 *  curiosity cannot be the gate: "now i curious what it was" is what she said on every turn of the
 *  loop this exists for. Low, sad, mad or scared, she lets it be. */
export function curiosityPercent(core?: string, label?: string): number {
  if (core === 'joyful') return label && CURIOUS_LABELS.has(label.toLowerCase()) ? 60 : 35;
  if (core === 'powerful' || core === 'peaceful') return 20;
  return 0;
}

/** Dodges still inside their window. */
export function liveDodges(dodges: readonly Dodge[] | undefined, now: number): Dodge[] {
  return (dodges ?? []).filter(d => now - d.since >= 0 && now - d.since < (d.dropped ? DODGE_DROPPED_MS : DODGE_PLAIN_MS));
}

function dodgeDraw(now: number): number {
  const n = Number.isFinite(now) ? Math.floor(Math.abs(now) / 1000) : 0;
  return ((n % 1_000_003) * 6_133) % 100;
}

/** What the edge says about dodges this turn: every live one is spent, except at most one plain dodge
 *  past its cooldown that she has not come back to yet, when her curiosity draw lands. */
function viewDodges(state: HookState, now: number, affect: HookAffectInput): HookDirective['dodges'] {
  const live = liveDodges(state.dodges, now);
  if (!live.length) return undefined;
  const cooldown = affect.dodgeCooldownMs ?? DODGE_COOLDOWN_MS;
  const open = live.filter(d => !d.dropped && !d.reraised && now - d.since >= cooldown);
  const pick = open.length && dodgeDraw(now) < (affect.curiosity ?? 0) ? open[open.length - 1] : undefined;
  return { spent: live.filter(d => d !== pick).map(d => d.at), ...(pick ? { curious: pick.at } : {}) };
}

/**
 * Fold what they did with her last move into the dodge ledger. Pure, and called after recordHook on
 * the reply path. `dodged` is the envelope's read of their message (plain or shut), `outcome` its
 * thread_outcome for her previous reply, `herLastAt` that
 * reply's stamp, `tender` whether they were venting or overwhelmed, and `curious` the dodge THIS
 * reply was allowed back to (the directive's).
 *
 *   • passed: a plain dodge, spent, and after its cooldown her curiosity may bring it back once;
 *   • pushed_back, or tender: dropped for DODGE_DROPPED_MS, no way back;
 *   • her way back taken and dodged again: the new pointer carries no way back either; taken and
 *     picked up (took): the dodge is gone, because the thread is alive again.
 */
export function recordDodge(
  state: HookState,
  input: { dodged?: string | null; outcome?: string | null; tender?: boolean; herLastAt?: number; curious?: number },
  now: number,
): HookState {
  const prior = state.curiousAt;
  // The envelope's own `dodged` word first; thread_outcome's reading of a question or a thread counts
  // too, since the two are read off the same message and either one is a dodge.
  const dodged = input.dodged === 'plain' || input.dodged === 'shut' || input.outcome === 'passed' || input.outcome === 'pushed_back';
  const hard = input.dodged === 'shut' || input.outcome === 'pushed_back' || input.tender === true;
  let dodges = liveDodges(state.dodges, now);
  if (prior != null && input.outcome === 'took') dodges = dodges.filter(d => d.at !== prior);
  if (prior != null && dodged && hard) dodges = dodges.map(d => (d.at === prior ? { ...d, dropped: true as const } : d));
  if (dodged && input.herLastAt != null && !dodges.some(d => d.at === input.herLastAt)) {
    dodges.push({ at: input.herLastAt, since: now, ...(hard ? { dropped: true as const } : {}), ...(prior != null ? { reraised: true as const } : {}) });
  }
  if (input.curious != null) dodges = dodges.map(d => (d.at === input.curious ? { ...d, reraised: true as const } : d));
  const { dodges: _d, curiousAt: _c, ...rest } = state;
  void _d; void _c;
  return {
    ...rest,
    ...(dodges.length ? { dodges: dodges.slice(-DODGE_KEEP) } : {}),
    ...(input.curious != null ? { curiousAt: input.curious } : {}),
  };
}

/** Of the hook and share turns with a move open, the share on which the move is her telling them what
 *  to do. She has an opinion on everything they do; a friend who voiced it on every text would be a
 *  nag, and one who never did would have none. */
export const PUSH_PERCENT = 35;

/** How long after she turns a quiz down the next task still reads as them pushing for it. */
export const QUIZ_PUSH_MS = 15 * 60 * 1000;

/** Of the quizzes, the share she answers at once with a dig instead of holding the answer back. Drawn,
 *  because left to choose she takes the answer every time, and a no that never comes is no bit. */
export const QUIZ_ROAST_PERCENT = 50;

function quizDraw(now: number): number {
  const n = Number.isFinite(now) ? Math.floor(Math.abs(now) / 1000) : 0;
  return ((n % 1_000_003) * 104_729) % 100;
}

/** A stable per-turn draw in [0, 100) off the turn's clock, pure, so a test that fixes `now` fixes it. */
function pushDraw(now: number): number {
  const n = Number.isFinite(now) ? Math.floor(Math.abs(now) / 1000) : 0;
  return ((n % 1_000_003) * 7919) % 100;
}

export function selectHook(
  state: HookState,
  shape: TurnKind,
  idleLayer: string,
  affect: HookAffectInput,
  isGroup: boolean,
  now: number,
  take = false,
  quiz = false,
): { directive: HookDirective; report: HookSelectReport } {
  // Never in a room (advice aimed at one person in front of everyone) and never on a slip turn, whose
  // one move is already spoken for. The branches below add their own: a share that is heavy gets
  // company, and a turn with no move open has nothing to land it as.
  const pushDrawn = !isGroup && !affect.slip && pushDraw(now) < PUSH_PERCENT;
  const dodgeView = viewDodges(state, now, affect);
  const withDodges = dodgeView ? { dodges: dodgeView } : {};
  // Sliced here as well as on the way into the store: the selector must give the same answer for a
  // hand-built state as for a stored one, and a longer window would be a kill switch with a longer
  // memory than the ledger it is documented to read.
  const lastKinds = state.lastKinds.slice(-HOOK_RUN_LIMIT);
  const report = (reason: HookSelectReason, forbidden: HookWord[]): HookSelectReport =>
    ({ reason, idleLayer, forbidden, lastKinds: [...lastKinds] });

  // Right after she said no to a quiz, the next ask is most likely them pushing for it, the same quiz
  // again or a just answer. She gives in this time, annoyed; the law says so and also lets a real ask
  // they moved on to be answered as itself.
  const pushed = typeof state.quizzedAt === 'number' && now - state.quizzedAt >= 0 && now - state.quizzedAt < QUIZ_PUSH_MS;
  if (shape === 'task' && pushed && !take) {
    return {
      directive: { idle: false, mode: 'task', quizPushed: true, forbidden: [], lateNight: affect.lateNight, moments: false, offerAllowed: false, playLevel: computePlayLevel('hook', affect), englishLooseness: affect.englishLooseness as 0 | 1 | 2 | 3 | undefined },
      report: report('quiz_pushed', []),
    };
  }
  if (shape === 'task' && quiz) {
    // Something a small child could answer, asked to see if she can. Still a task by mode, so nothing
    // is hooked on, but the answer is a no, and the jester gets to say it at her mood's reach.
    return {
      directive: { idle: false, mode: 'task', quiz: quizDraw(now) < QUIZ_ROAST_PERCENT ? 'roast' : 'refuse', forbidden: [], lateNight: affect.lateNight, moments: false, offerAllowed: false, playLevel: computePlayLevel('hook', affect), englishLooseness: affect.englishLooseness as 0 | 1 | 2 | 3 | undefined },
      report: report('quiz', []),
    };
  }
  if (shape === 'task' && take) {
    // They asked what she thinks. Still a task (the answer is owed and nothing is hooked on), but
    // the answer is hers, so the play dial reads her mood the way an idle turn's does.
    return {
      directive: { idle: false, mode: 'task', take: true, forbidden: [], lateNight: affect.lateNight, moments: false, offerAllowed: false, playLevel: computePlayLevel('hook', affect), englishLooseness: affect.englishLooseness as 0 | 1 | 2 | 3 | undefined, ...(affect.slip ? { slip: affect.slip } : {}) },
      report: report('take', []),
    };
  }
  if (shape === 'task') {
    return {
      directive: { idle: false, mode: 'task', forbidden: [], lateNight: affect.lateNight, moments: false, offerAllowed: false, playLevel: 0, englishLooseness: affect.englishLooseness as 0 | 1 | 2 | 3 | undefined, ...(affect.spent ? { spent: true } : {}), ...(affect.slip ? { slip: affect.slip } : {}) },
      report: report('not_idle', []),
    };
  }

  // HOOK_WORDS order, so the rendered sentence and the receipt read the same way every time, and so
  // three overlapping reasons to forbid a kind still name it exactly once. Read before either branch
  // because both of them owe the same answer: two of a kind in a row is a tic on a share turn as
  // much as on an idle one.
  const repeated = repeatedTailKind(lastKinds);

  if (shape === 'share') {
    const forbidden = HOOK_WORDS.filter(w =>
      // The flat-mood floor, which on an idle turn is `quiet` and here is PRESENCE: every kind
      // closed, the turn still a share turn, and the section's own law is that one plain sentence
      // about their thing is what is left. A mood too flat for a move is not a reason to answer a
      // person with nothing.
      (affect.hooks === 'none' && !(w === 'question' && affect.question === 'open'))
      || w === repeated
      || (affect.hooks === 'no_judgment' && w === 'judgment')
      || (affect.hooks === 'no_tangent' && w === 'tangent')
      // A room closes the two moves that need one person to be aimed at: a judgment is a verdict in
      // front of an audience, and a follow-up puts one member on the spot to answer in front of
      // everyone. A callback and a tangent are about the thing, so they survive.
      || (isGroup && (w === 'judgment' || w === 'question'))
      // The compiled ceiling is the one closer for a question: her weather says the reply stays
      // statement-shaped (affectCompiler.ts `compileQuestionGate`). Back-to-back questions are
      // permitted; the repeat rule above still fires on three in a row.
      || (w === 'question' && affect.question === 'closed')
      // WEIGHT narrows the turn to the two moves that stay with them. A judgment on a heavy share is
      // analysis, and analysis is not company; a tangent walks away from the thing they just put
      // down. A callback and — when the ceiling left it open — a question about what happened or how
      // it sat are what is left.
      || (affect.heavy && (w === 'judgment' || w === 'tangent'))
      || (w === 'judgment' && (affect.stranger || lastKinds[lastKinds.length - 1] === 'judgment')));
    // An extreme feeling slipping out takes the turn's one move, as a tangent about her, whenever a
    // tangent is still hers to make: the move list is what she obeys, and a slip stated anywhere
    // else lost to the share law in every live replay.
    const slipTurn = !!affect.slip && !forbidden.includes('tangent');
    const shareForbidden = slipTurn ? HOOK_WORDS.filter(w => w !== 'tangent') : forbidden;
    const sharePush = pushDrawn && !affect.heavy && shareForbidden.length < HOOK_WORDS.length;

    return {
      directive: {
        // NOT an idle turn: they said something. The streak this feeds counts silences.
        idle: false,
        mode: 'share',
        forbidden: shareForbidden,
        heavy: affect.heavy,
        lateNight: affect.lateNight,
        // A moment rides out as a callback about something OLD, and this turn already has something
        // of theirs in front of her. The sampler stays for idle turns, where there is nothing else
        // for a callback to be made of (a stored moment connected to what they shared is a v2 idea,
        // and it needs the sampler to be handed the share text before it can pick one).
        moments: false,
        offerAllowed: true,
        playLevel: computePlayLevel('share', affect),
        englishLooseness: affect.englishLooseness as 0 | 1 | 2 | 3 | undefined,
        ...(affect.low ? { low: true } : {}),
        ...(affect.slip ? { slip: affect.slip } : {}),
        ...(sharePush ? { push: true as const } : {}),
        ...withDodges,
      },
      report: { ...report('share', shareForbidden), ...(sharePush ? { push: true as const } : {}) },
    };
  }

  const quiet = (reason: HookSelectReason) => ({
    directive: { idle: true, mode: 'quiet' as const, forbidden: [], lateNight: affect.lateNight, moments: false, offerAllowed: false, playLevel: 0 as PlayLevel, englishLooseness: affect.englishLooseness as 0 | 1 | 2 | 3 | undefined },
    report: report(reason, []),
  });

  // The kill switch. A full window with no `none` in it means she has been sharp three times running
  // at someone who has asked for nothing three times running. Silence there ends the conversation, so
  // the exit is handing them the turn (a question) or opening up (a rant, which rides as a tangent);
  // quiet only when neither is hers.
  if (lastKinds.length >= HOOK_RUN_LIMIT && lastKinds.every(k => k !== 'none')) {
    const open = affect.hooks !== 'none';
    const canAsk = open && affect.question === 'open' && !isGroup && repeated !== 'question';
    const canRant = open && affect.hooks !== 'no_tangent' && repeated !== 'tangent';
    if (!canAsk && !canRant) return quiet('kill_switch');
    const forbidden = HOOK_WORDS.filter(w => !(w === 'question' && canAsk) && !(w === 'tangent' && canRant));
    return {
      directive: { idle: true, mode: 'hook', forbidden, lateNight: affect.lateNight, moments: false, offerAllowed: false, playLevel: computePlayLevel('hook', affect), englishLooseness: affect.englishLooseness as 0 | 1 | 2 | 3 | undefined, ...withDodges },
      report: report('kill_switch', forbidden),
    };
  }
  // The affect floor: the compiled directive can close hooks outright (a flat mood, a spent battery).
  // …except that a low mood still asks things, lazily: when the question gate is open, the one
  // move left is a low-effort question, and the `low` line says how small it comes out.
  if (affect.hooks === 'none') {
    if (affect.question !== 'open' || isGroup || repeated === 'question') return quiet('affect_floor');
    const forbidden = HOOK_WORDS.filter(w => w !== 'question');
    return {
      directive: { idle: true, mode: 'hook', forbidden, lateNight: affect.lateNight, moments: false, offerAllowed: false, playLevel: 0, englishLooseness: affect.englishLooseness as 0 | 1 | 2 | 3 | undefined, low: true, ...withDodges },
      report: report('affect_floor', forbidden),
    };
  }

  const forbidden = HOOK_WORDS.filter(w =>
    w === repeated
    || (affect.hooks === 'no_judgment' && w === 'judgment')
    || (affect.hooks === 'no_tangent' && w === 'tangent')
    // A group closes both the per-person judgment (a verdict in front of an audience) and the
    // follow-up question (puts one member on the spot to answer in front of everyone).
    || (isGroup && (w === 'judgment' || w === 'question'))
    // The affect ceiling: her weather says the question stays closed this turn.
    || (w === 'question' && affect.question === 'closed')
    // Never two judgments in a row (the persona's own rule), and none at all for a stranger: her
    // default self keeps a conversation alive by asking and bringing something of hers.
    || (w === 'judgment' && (affect.stranger || lastKinds[lastKinds.length - 1] === 'judgment')));
  // The slip takes the one hook the same way it takes a share's move (see the share branch).
  const hookForbidden = affect.slip && !forbidden.includes('tangent') ? HOOK_WORDS.filter(w => w !== 'tangent') : forbidden;
  const hookPush = pushDrawn && hookForbidden.length < HOOK_WORDS.length;

  return {
    directive: {
      idle: true,
      mode: 'hook',
      forbidden: hookForbidden,
      lateNight: affect.lateNight,
      // A moment can only ride out as a callback, so a forbidden callback makes the sample dead
      // weight — and sampling bills the moment either way, which is why the gate sits here rather
      // than in the renderer.
      moments: !hookForbidden.includes('callback') && state.idleSinceMoment >= MOMENT_IDLE_INTERVAL && !isGroup,
      offerAllowed: true,
      playLevel: computePlayLevel('hook', affect),
      englishLooseness: affect.englishLooseness as 0 | 1 | 2 | 3 | undefined,
      ...(affect.low ? { low: true } : {}),
      ...(affect.slip ? { slip: affect.slip } : {}),
      ...(hookPush ? { push: true as const } : {}),
      ...withDodges,
    },
    report: { ...report('hook', hookForbidden), ...(hookPush ? { push: true as const } : {}) },
  };
}

/**
 * Which kind of turn a directive came from — the selector's input, read back off its output.
 *
 * The post-model half of the turn (convo/shared.ts) holds the DIRECTIVE and not the gate's reading,
 * and the ledger write needs the kind: the streak counts silences, so a share turn ends it exactly
 * as a task turn does. Deriving it here rather than threading the reading down keeps one answer to
 * the question — the mode says `share` or it does not, and `idle` says whether they sent anything —
 * instead of two fields on two structs that can disagree about the same turn.
 *
 * `quiet` maps to `idle`, which is not a special case: a quiet turn is an idle turn the switch or the
 * floor spent, and it counts toward the streak the way it always has.
 */
export function shapeOf(directive: HookDirective): TurnKind {
  if (directive.mode === 'share') return 'share';
  return directive.idle ? 'idle' : 'task';
}

/**
 * The ledger after this turn. Pure: a fresh state, the input untouched, `now` injected.
 *
 * An ABSENT `emitted` reads as `none`, which is the honest reading of a droppable envelope field —
 * a model that said nothing about its hook did not hook. `momentOffered` resets the moment spacing
 * whether or not the turn was idle, because the offer was made either way.
 *
 * THE KIND IS RECORDED WHATEVER THE SHAPE, and only the two clocks read the shape. A `question` on a
 * share turn is the entry the next turn's dose rule reads (the selector closes the question when the
 * tail is one) and the entry the turn gate reads to tell her follow-up from her confirm question
 * (persona/idle.ts `followUpOutstanding`), so the one word she emitted is the one row two engines
 * consult. Both clocks count SILENCES: a share turn ends the streak exactly as a task turn does,
 * because they said something, and it neither spends nor tops up the moment spacing for the same
 * reason a task turn does not — the sampler only ever runs on the turn with nothing else in it.
 */
export function recordHook(
  state: HookState,
  emitted: HookWord | undefined,
  shape: TurnKind,
  momentOffered: boolean,
  now: number,
  quiz?: 'refused' | 'pushed',
): HookState {
  const kind: HookKind = emitted && (HOOK_WORDS as readonly string[]).includes(emitted) ? emitted : 'none';
  const idle = shape === 'idle';
  return {
    lastKinds: [...state.lastKinds, kind].slice(-HOOK_RUN_LIMIT),
    // A task turn ENDS the streak: the count is "how many times in a row they sent nothing", and one
    // real ask is them sending something. So is one real share.
    idleStreak: idle ? state.idleStreak + 1 : 0,
    idleSinceMoment: momentOffered ? 0 : idle ? state.idleSinceMoment + 1 : state.idleSinceMoment,
    updatedAt: now,
    // A refusal stamps the clock the next turn reads; giving in clears it. Anything else keeps it,
    // and QUIZ_PUSH_MS lets it lapse on its own.
    ...(quiz === 'refused' ? { quizzedAt: now } : quiz === 'pushed' || state.quizzedAt === undefined ? {} : { quizzedAt: state.quizzedAt }),
    // The dodge ledger is recordDodge's, folded right after this; carried through untouched.
    ...(state.dodges ? { dodges: state.dodges } : {}),
    ...(state.curiousAt != null ? { curiousAt: state.curiousAt } : {}),
  };
}

/**
 * Did a forced-quiet turn break the quiet? Pure, and the second consumer of `hook_kind` (the ledger
 * is the first).
 *
 * Three arms, because a quiet reply fails in three different ways: she hooked anyway, she sent more
 * than one bubble, or the one bubble ran long. Zero bubbles is NOT a violation — silence and a bare
 * tapback are both legal quiet replies, and the tapback path sends no bubbles at all.
 */
export function quietViolation(emitted: HookWord | undefined, bubbles: string[]): boolean {
  if (emitted && (HOOK_WORDS as readonly string[]).includes(emitted)) return true;
  if (bubbles.length > 1) return true;
  const first = (bubbles[0] ?? '').trim();
  if (!first) return false;
  return first.split(/\s+/).filter(Boolean).length > QUIET_MAX_WORDS;
}

// ── The rendered section ─────────────────────────────────────────────────────────────────────────
//
// Same two laws the thread blocks are written under. NOT ONE DIGIT: a number in the prompt is a
// thing to reason about and optimize, a register is a thing to speak in — "one, and only one" is
// obeyed, "1 hook max" is negotiated with. And every block ENDS on the same clamp, because the one
// unrecoverable failure of this feature is her telling someone she keeps notes on them or that
// something told her which kind of line to send.
//
// Moment lines are model-authored prose, interpolated bare like a thread label, and they may
// legitimately carry digits (their own words for their own week). The no-digit law is a law about
// the CONSTS below, which is where it is pinned.

/** The clamp. Byte-identical to the last line of the hooks craft page: two copies of one sentence at
 *  two distances from the recency edge, which is the anti-drift pattern, not an accident. */
export const HOOK_CLAMP = 'Never mention notes, memory, a read you were handed, or that you were told which kind to use.';

export const HOOK_HEADING = '## This turn may carry one hook (INTERNAL)';
export const HOOK_LEAD = 'They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.';

/** `{kinds}` is filled from the ALLOWED set, never the forbidden one. What is off the table is not
 *  named: naming it is an instruction to think about it. */
export const HOOK_OPEN_LINE = 'Open to you this turn: {kinds}. One of them, never two, never a kind not named here.';

/** Rare, and it takes three pressures at once: a room (no judgment) plus a flattened mood (no
 *  tangent) plus a callback she just used twice. The clock is NOT one of them — an hour never closes
 *  a kind. The turn stays a hook turn — a plain short answer still belongs to it — but the extra
 *  beat is spent. */
export const HOOK_NONE_OPEN = 'No kind is open this turn. Short and flat, and let the beat pass.';

/** The register line, rendered after the open/none line whenever it is late where they are. It says
 *  how BIG the reply is and never what is in it: the kinds above still pick the content, and the
 *  last clause is the whole anti-repeat intervention for a shape she used last night. */
export const HOOK_LATE_LINE = 'It is late where they are: one short bubble that hands them something to answer or do, or a tapback, and nothing heavy. Same rules as any idle turn, at a lower volume, and never the line you sent them last night.';

export const MOMENTS_LEAD = 'Kept about them, in case a callback fits. Retell one in fresh words, never read it out, never its date, never more than one.';

const PLAY_LEVEL_LINES: Record<0 | 1 | 2 | 3, string> = {
  0: '',
  1: 'Play level: dry. Light touch only, close to literal, no long bridges.',
  2: 'Play level: normal. One bend, moderate reach. The half-second gap is yours.',
  3: 'Play level: hot. Reach further, the bridge can be longer, they are here for it.',
};

/** The per-turn English looseness signal: one instruction line handed to the model alongside the
 *  rhythm contract. Level one is the normal baseline and renders nothing — the default costs the
 *  prompt nothing, the same bargain the brevity deadzone makes. Level zero is a special case that
 *  DOES render a line, because careful is a directive rather than a default.
 *
 *  NOT ONE DIGIT anywhere in this record: a number the model reads inside the section it grades
 *  itself on is a number to optimize. "Two slips" is a phrase, not a count. */
export const LOOSE_LEVEL_LINES: Record<0 | 1 | 2 | 3, string> = {
  0: 'English careful this turn. Slips near zero, no typos, no elongation. Any bubble with a number, date, price or bad news stays at this level even when the rest is looser.',
  1: '',
  2: 'English loose this turn. Two slips per bubble, occasional typo left in, stretched words often, longer when funny or annoyed. A big feeling gets caps on the word it sits on.',
  3: 'English messy this turn. Slips everywhere, subjects drop, typos stay uncorrected, letters stretch, punctuation mostly gone. Big feelings come out in caps, a word, a phrase or the whole bubble.',
};

export const QUIET_HEADING = '## This turn is quiet (INTERNAL)';
export const QUIET_LAW = 'Your weather says so, or you have been sharp three times running with nothing left to hand them. One plain short bubble, or a tapback, or nothing. No hook, no question, no offer. Do not explain the quiet.';

// ── The share block ─────────────────────────────────────────────────────────────────────────────
//
// The same two laws (no digit, ends on the clamp) plus a third this block alone carries: NO SHAPE OF
// IT MAY READ AS PERMISSION TO SEND NOTHING. Every other mode has a floor of silence under it — a
// quiet turn is allowed to be a tapback, a closed-kinds hook turn is allowed to let the beat pass —
// and on a share turn silence is the receipt the whole shape exists to refuse. So the none-open
// variant still says what the reply is (one short bubble about their thing) rather than what it is
// spared, and the block is the only one whose narrowest render is still an instruction to speak.
//
// It mirrors the hook block line for line and shares not one const with it, which is deliberate: the
// hook lead says nothing of theirs comes back, and the share lead is the opposite sentence. Two
// contracts that happen to have the same shape are two constants.

export const SHARE_HEADING = '## This turn is a share (INTERNAL)';
export const SHARE_LEAD = 'They handed you something and asked for nothing. A receipt turns it away; the reply turns toward it, one move about the thing itself.';

/** `{kinds}` from the ALLOWED set, same law as the hook line: what is off the table is not named.
 *  The last clause is the arithmetic difference between the two modes — a hook is the extra beat
 *  after an answer, and here there is no answer for it to come after, so the move IS the reply. */
export const SHARE_OPEN_LINE = 'Open to you this turn: {kinds}. One of them, never two, and it is the reply, not a beat after one.';

/** Rendered ONLY when the question survived into the allowed set — the one line in this file that is
 *  about a single kind, because the question is the one kind whose failure mode is a different move
 *  wearing its shape (a switch, a mirror, a thing a search answers). The two sentences are the two
 *  halves of the research: what makes a follow-up a follow-up (it could not exist without their last
 *  message, and it stays in their word for the thing), and the dose that keeps it from curdling into
 *  an interview (something of hers first when they wrote more than a line). When the kind is closed
 *  the line is absent rather than negated: a ban she reads is a kind she is thinking about. */
export const SHARE_QUESTION_LINE = 'The question, if you take it, asks for the one part only they know, built on their last message, never their own words handed back. Something of yours first when they wrote more than a line.';

/** THE PRESENCE CASE, and the reason this const is not the hook block's. Every kind is spoken for —
 *  a flat mood closing all four, or weight plus a closed ceiling plus a repeated callback — and the
 *  hook line's answer to that ("let the beat pass") is the one answer a share turn may not give. So
 *  it names the reply instead: their thing, plainly, once, and then stop. */
export const SHARE_NONE_OPEN = 'No kind is open this turn. Take what they said plainly, one short bubble about the thing itself, and stop.';

/** The register line, and shorter than the hook one by everything the hook one had to say about not
 *  repeating last night: a share turn is answering something they just sent, so there is no shape
 *  from last night for it to fall back into. It lowers the volume of the move above it and picks
 *  none of it. */
/** The take turn: they asked what SHE thinks, likes, feels or would do (persona/idle.ts, TAKES). A
 *  task by mode, so nothing is hooked on and the answer is owed; the section only says whose answer
 *  it is, and the play and looseness lines below it carry her mood into it. */
export const TAKE_HEADING = '## This turn is a take (INTERNAL)';
export const TAKE_LEAD = 'They asked what you think, like, feel or would do, and your take is the whole answer. Your mood sets the volume it comes out at, dry or bouncing, one line or a rant. Commit to a side and say why.';
export const TAKE_LATE_LINE = 'It is late where they are: the same take, smaller and quieter.';

/** Her weather is low. She says how she feels when it shows, plainly, and asks what she asks with no
 *  effort spent on it. Rendered on hook and share turns whenever the directive carries `low`. */
/** On a slip turn whose one move is a tangent: the tangent is her. `{feeling}` is the moodlet. */
export const SLIP_TANGENT_LINE = 'This turn the tangent is you: how {feeling} you are today, a few plain words, hooked onto what they sent.';

/** On a push turn, under the line that named the kinds: whichever it is, it lands as what they
 *  should do. The recency edge carries the same turn as a bubble (persona/policy.ts PUSH_BULLET). */
export const PUSH_LINE = 'This turn, whichever kind you take, it tells them what to do: your opinion on their next step, said straight.';

export const LOW_LINE = 'You are low right now: short and lazy, and the few words you spend go on a lazy question or a lazy push for them, no effort dressing it up, the question still keeping its question mark.';

export const SHARE_LATE_LINE ='It is late where they are: one short bubble that hands them something to answer or do, and nothing heavy. Same move, lower volume.';

/** The allowed kinds as English — `a judgment, a callback or a tangent` on a hook turn, and the same
 *  list with `or a question` at the end of it on a share turn. An oxford-less list because it is a
 *  sentence she reads, not a config value she parses. */
function nameKinds(kinds: readonly HookWord[]): string {
  const words = kinds.map(k => `a ${k}`);
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/**
 * The `hooks` dyn section, in the three blocks the four modes render: nothing, the hook block, the
 * quiet law, the share block. `''` on a task turn — the no-regression pin the whole feature rests
 * on: on the turns that are actually work, the prompt is byte-identical to an install that never had
 * a hook engine.
 *
 * THE ALLOWED SET IS THE MODE'S OWN (`namableKinds`), which is what keeps the block from naming a
 * kind the turn cannot spend: a hook turn drops the question out of the sentence whatever the
 * selector handed in (nothing was shared, so there is nothing to follow up on), and a share turn
 * names it when it survived. Same computation as `hookKindOpen` above, deliberately — the predicate
 * answers "is a move open" for every consumer that only needs the answer, and this needs the LIST,
 * so a directive those two disagreed about would put "No kind is open this turn" in the same prompt
 * as a climate span offering a beat.
 *
 * `momentLines` are gated by the DIRECTIVE, not by the caller: if the selector said no moments this
 * turn, lines handed in anyway are dropped rather than rendered. One gate, in one place, and it is
 * the one the receipt reports. The share block has no sampler line at all, and that is the mode's
 * contract rather than a second gate — a moment rides out as a callback about something OLD, and
 * this turn has something of theirs in front of her (the selector sets `moments: false` on every
 * share turn for the same reason).
 */
export function renderHooksSection(directive: HookDirective, momentLines: string[] = []): string {
  // A plain task carries no move, but it still carries her English: a looseness line, when there is
  // one, rides alone so stretched words do not vanish on every turn they asked her something.
  if (directive.mode === 'task' && !directive.take) return LOOSE_LEVEL_LINES[directive.englishLooseness ?? 1] || '';
  const lines: string[] = [];
  if (directive.mode === 'task') {
    lines.push(TAKE_HEADING, TAKE_LEAD);
    if (directive.lateNight) lines.push(TAKE_LATE_LINE);
  } else if (directive.mode === 'quiet') {
    lines.push(QUIET_HEADING, QUIET_LAW);
  } else {
    const allowed = namableKinds(directive.mode).filter(w => !directive.forbidden.includes(w));
    if (directive.mode === 'share') {
      lines.push(SHARE_HEADING, SHARE_LEAD);
      lines.push(allowed.length > 0 ? SHARE_OPEN_LINE.replace('{kinds}', nameKinds(allowed)) : SHARE_NONE_OPEN);
      if (directive.push && allowed.length > 0) lines.push(PUSH_LINE);
      if (directive.slip && allowed.length === 1 && allowed[0] === 'tangent') lines.push(SLIP_TANGENT_LINE.replace('{feeling}', directive.slip));
      // Under the sentence that named it, and only when it is actually hers this turn: the line is
      // what a follow-up IS, and it has nothing to say on a turn where the kind is closed.
      if (allowed.includes('question')) lines.push(SHARE_QUESTION_LINE);
      // Register last, the way it rides last on a hook turn: the lines above pick the move, and this
      // one says how big it comes out.
      if (directive.lateNight) lines.push(SHARE_LATE_LINE);
    } else {
      lines.push(HOOK_HEADING, HOOK_LEAD);
      lines.push(allowed.length > 0 ? HOOK_OPEN_LINE.replace('{kinds}', nameKinds(allowed)) : HOOK_NONE_OPEN);
      if (directive.push && allowed.length > 0) lines.push(PUSH_LINE);
      if (directive.slip && allowed.length === 1 && allowed[0] === 'tangent') lines.push(SLIP_TANGENT_LINE.replace('{feeling}', directive.slip));
      if (directive.lateNight) lines.push(HOOK_LATE_LINE);
      const moments = directive.moments ? momentLines.map(l => l.trim()).filter(Boolean) : [];
      if (moments.length > 0) lines.push(MOMENTS_LEAD, ...moments);
    }
  }
  if (directive.low && directive.mode !== 'quiet') lines.push(LOW_LINE);
  const looseLine = LOOSE_LEVEL_LINES[directive.englishLooseness ?? 1];
  if (looseLine) lines.push(looseLine);
  const playLine = PLAY_LEVEL_LINES[directive.playLevel];
  if (playLine) lines.push(playLine);
  lines.push(HOOK_CLAMP);
  return lines.join('\n');
}
