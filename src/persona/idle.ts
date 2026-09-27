// The turn gate: does this turn ask for anything, hand her something, or stall?
//
// THREE KINDS OF TURN, and the whole hook engine hangs off which one this is (persona/hooks.ts). A
// TASK turn gets the answer, flat, with the real numbers and nothing else. An IDLE turn — they sent
// nothing to act on and told nothing either — is the one turn a reply may carry a hook. A SHARE turn
// is the one in between: they handed her something about their own day and asked for nothing, which
// is a bid, and the reply is one move about the thing they handed her. So a gate that reads "deploy
// prod" as idle spends a work turn on a clever line, a gate that reads "hmm" as work produces the
// leaf this whole build is named after, and a gate that reads "morning meeting moved" as either one
// answers a bid with a receipt.
//
// LANGUAGE-AGNOSTIC, THREE LAYERS, FAILING TOWARD TASK. This is the 2026-09-04 rule (see the header
// of agents/ops/consent.ts, which reads a reply the same way): no hand-written word list is ever the
// last word on what a person's message means, because a person may text in any language and a list
// only ever knows one.
//
//   1. STRUCTURAL READS — script-independent facts about the message and the turn around it, split
//      in two by what they can prove. A WORK VETO proves the turn is work: a question mark, a link,
//      a message past the share cap, a file that arrived, a look already running, an answer owed.
//      Any one of them and the turn is a task, with no call at all. A NOT-A-STALL SIGNAL proves
//      something weaker and useful — a digit, a sentence's worth of tokens or characters, a burst —
//      namely that whatever this message is, it is not one of the stalls the English list knows. It
//      bars the fast path and goes on to layer 3, because "too long to be a stall" is the commonest
//      shape a share arrives in. Neither layer reads a word.
//   2. THE ENGLISH FAST PATH — LEAF_EXAMPLES below. EXAMPLES, NOT A LAW: a short message every one
//      of whose tokens is a known English stall is idle, for free, with no call. The list is small
//      on purpose and extensible without a code change (LEAF_EXAMPLES_EXTRA), because it is a
//      shortcut for the commonest case and never a definition of the case. It may only speak for a
//      message it can READ WHOLE — see `fastPathCanRead`, and the paragraph under it — and never for
//      one a signal already marked as no stall.
//   3. THE CLASSIFY FALLBACK — everything veto-free the fast path could not read or was barred from:
//      a Spanish "nada", an Indonesian "bosan", a Japanese stall with no Latin tokens at all, and
//      every message long enough to be a share. The caller injects it (convo/idleClassify.ts wires
//      it); this module only knows it returns one of four words. `stall` and `share` are the two
//      that are not work. Anything else — `ask`, `unclear`, a garbled answer, a thrown call, a lane
//      that timed out — is a task. That call sits on the reply path, so `classifyNeeded` below lets
//      the caller PREDICT it from the facts it holds early and start it in parallel with its own
//      memory read; the prediction is allowed to be wrong in one direction only, and says so.
//
// AND THE FAST PATH NEVER HALF-READS A MESSAGE. A person may text in any language, and a real
// message is often MIXED: one English ack and a clause in another script ("ok 볼래", "hmm 明日は").
// `words` below drops every non-Latin character, so a message like that tokenizes down to its one
// ASCII token — and a fast path that judged those tokens alone would read a request as a stall on
// the strength of the single word it happened to be able to see. The English list is English by
// design; the honest consequence is that layer 2 may decide ONLY a message with nothing in it the
// tokenizer would drop (`fastPathCanRead`). Everything else belongs to layer 3, which reads any
// script — one small call, never a wrong reading.
//
// THE THIRD SHAPE IS FLAGGED (`IdleOptions.shareTurns`, CONVO_SHARE_TURNS_ENABLED at the caller).
// Off, every signal is a veto again and a `share` verdict is read as a task, which is this gate's
// answer to every message in the pre-share table, layer for layer. The flag's whole contract is that
// an install with it off cannot tell this file changed.
//
// This file is a LEAF: it imports nothing, from anywhere. `words` below is MIRRORED from
// convo/turnFocus.ts rather than imported for exactly that reason (that module imports the prompt
// tagger), and the consent reading arrives as a plain union rather than as ops/consent.ts's `Consent`
// (that module imports the LLM client). Both duplications are two lines and are named here so the
// day one of them drifts is a day somebody reads this paragraph.
//
// PURE: no clock, no DB, no LLM of its own. The one env read is LEAF_EXAMPLES_EXTRA, parsed at CALL
// time so a live install can widen the fast path without a restart.

/** The three kinds of turn, and the vocabulary every engine downstream of this one speaks (the hook
 *  selector's mode, the `Turn:` line, the drift anchor, the craft gates). Deliberately NOT
 *  `TurnShape`: convo/turnFocus.ts owns that name for the shape of the message SURFACE (one line, a
 *  paragraph, a burst), which is a different question about the same turn. */
export const TURN_KINDS = ['task', 'idle', 'share'] as const;
export type TurnKind = typeof TURN_KINDS[number];

/** The four readings the injected classifier may come back with. Deliberately its own tiny union:
 *  the fallback is a seam, and a caller that wires a different classifier still has to answer this
 *  question in these words. `share` is the one that carries the bid — a message that TELLS her
 *  something and asks for nothing — and it is the reading `stall` used to swallow. */
export type IdleVerdict = 'stall' | 'share' | 'ask' | 'take' | 'quiz' | 'unclear' | 'failed';

/** Which layer decided, for the receipt (`hooks:select` carries it, persona/hooks.ts). Four values,
 *  disjoint and exhaustive: `veto` a structural fact, `fast_path` the English examples, `classify`
 *  the injected fallback (whatever it answered, including a failure), and `none` a turn with no text
 *  to read at all. A receipt that could not tell a fast-path idle from a classified one could not
 *  tell a working fallback from a dead one. */
export const IDLE_LAYERS = ['veto', 'fast_path', 'classify', 'none'] as const;
export type IdleLayer = typeof IDLE_LAYERS[number];

/** What the consent reader made of this message, mirrored from ops/consent.ts's `Consent`. Only the
 *  caller can produce it (the reading may cost a lane call), so it arrives as a fact. */
export type IdleConsent = 'yes' | 'no' | 'unclear';

/**
 * The turn around the message, as facts somebody else already computed. Nothing here is an opinion
 * and nothing here is derived from what the message MEANS — the same discipline the craft-module
 * gates keep (convo/personaModules.ts).
 */
export interface IdleFacts {
  /** describeAttachments produced a note this turn — a file, photo or memo really arrived. A file is
   *  a thing to do, whatever the caption says. */
  attachmentNote: boolean;
  /** How many messages arrived in this turn's burst (1 on a normal turn). Somebody who sent three
   *  texts in a row is not stalling, they are mid-thought — which is a signal rather than a veto,
   *  because mid-thought is exactly how a share arrives. */
  burstSize: number;
  /** A look of theirs is running or queued for this chat. Their short message is landing on it —
   *  "ok" while she is mid-research is bookkeeping, not a stall. */
  activeOps: boolean;
  /** An approval or steering question of HERS is parked and unanswered — the memory read's own
   *  reading, not a punctuation guess. Their next message is the answer to it, and answering is
   *  work, so this one is a veto on every shape and is never relaxed. */
  pendingAsk: boolean;
  /** Her previous turn ended on a question mark of any script (`endsInQuestion` below computes it).
   *  Owed an answer the same way — unless the question she asked was a FOLLOW-UP, which is the one
   *  question of hers that is a move rather than an ask; see `followUpOnly`. */
  endsInQuestion: boolean;
  /** Her last reply's move WAS that follow-up question: the rhythm ledger's tail kind is `question`
   *  (persona/hooks.ts). It is what tells her own confirm question ("want me to send it?", owed an
   *  answer) from her own follow-up ("what did they say", owed nothing but a turn), and the whole
   *  reason this fact is separate from `endsInQuestion`.
   *
   *  A stray question emitted off a share turn — the slip `hook:off_turn` reports — therefore hands
   *  the next short message a share turn it did not strictly earn. Known and harmless: the cost is
   *  one reply that turns toward what they said instead of carrying a hook. */
  followUpOutstanding: boolean;
  /** What the consent reader made of this message (ops/consent.ts). A settled yes or no is an answer
   *  to a parked action — which is why it only vetoes alongside an answer being owed, there being no
   *  parked action without one; `unclear` settles nothing and vetoes nothing either way. */
  consent: IdleConsent;
}

/** What the CALLER's switches say this gate may do. One field, and the reason it is an options bag
 *  rather than a boolean parameter is that the flag is the caller's fact about the install, not a
 *  fact about the turn — everything in `IdleFacts` is the latter. */
export interface IdleOptions {
  /** CONVO_SHARE_TURNS_ENABLED (persona/featureFlags.ts). Off: the not-a-stall signals are work
   *  vetoes again, the follow-up relaxation never applies, and a classified `share` reads as a task.
   *  Nothing about this file's shape changes either way — only which side of it ships. */
  shareTurns?: boolean;
  /** Whether a question that asks for HER take (what she thinks, likes, feels, would do) may be read
   *  as a take turn rather than a task. Only a message whose one veto is its question mark is ever
   *  sent to the classifier for this, so every other kind of question stays a task with no call. */
  takeTurns?: boolean;
}

/** True when the only thing making this message work is its question mark: no link, no file, no
 *  look running, no answer of theirs owed. That is the one question shape that can be asking for her
 *  opinion instead of for a thing, and the only one the take reading is allowed to look at. */
function onlyQuestionMark(vetoes: readonly string[]): boolean {
  return vetoes.length === 1 && vetoes[0] === 'question_mark';
}

/**
 * The English fast path — EXAMPLES, NOT A LAW.
 *
 * Greetings, acks, closings, laughter, stalls: the tokens a stall is made of in the one language
 * this file can afford to hard-code. A short message every one of whose tokens is in here is idle
 * with no call at all, which is the commonest idle turn and the cheapest.
 *
 * READ THE NAME. This is not the definition of an idle turn and it is not allowed to become one:
 * the same message in Spanish, Indonesian, Tagalog or Japanese is exactly as idle and reaches the
 * same answer through the classify layer below. Nothing here is a veto either — a token missing
 * from this list costs one small call, never a wrong reading. That is what makes it safe to keep
 * SHORT: a longer list buys speed on messages nobody sends and risks swallowing a real ask.
 *
 * Extensible without a code change through LEAF_EXAMPLES_EXTRA (below), which is the pressure valve
 * that keeps anybody from being tempted to grow this into a lexicon.
 */
export const LEAF_EXAMPLES: readonly string[] = [
  // greeting
  'hey', 'hi', 'hello', 'yo', 'sup', 'morning',
  // acknowledgement
  'ok', 'okay', 'k', 'yeah', 'yep', 'yup', 'cool', 'nice', 'thanks', 'ty', 'sure',
  // closing
  'night', 'bye', 'later', 'cya', 'gn',
  // laughter
  'lol', 'lmao', 'haha', 'hehe',
  // stall
  'hmm', 'hm', 'meh', 'eh', 'idk', 'im', 'bored', 'same', 'nothing', 'nothin', 'much', 'nvm',
];

/** Built once: the examples never change inside a process. The env extras are folded in per call. */
const BASE_EXAMPLES: ReadonlySet<string> = new Set(LEAF_EXAMPLES);

/**
 * The whole message's worth of tokens: lowercased, apostrophes dropped so a contraction collapses to
 * one token ("i'm" → "im"), split on everything else.
 *
 * MIRRORED from convo/turnFocus.ts `words` (see the file header for why it is not imported), which
 * means it is an ASCII-Latin tokenizer and knows it: a message in a non-Latin script tokenizes to
 * NOTHING here. A WHOLLY non-Latin message is therefore harmless — zero tokens can never match the
 * English examples, so it falls straight through to the classify layer, which is exactly where it
 * belongs. A MIXED one is the dangerous case, and `fastPathCanRead` below is what handles it.
 * All of this is also why the token count below is not the load-bearing length read: the CHARACTER
 * counts are, and those count every script.
 */
function words(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9%]+/).filter(Boolean);
}

/**
 * Everything `words` can read without dropping any of it: ASCII letters, digits, whitespace and
 * ASCII punctuation, plus the curly apostrophe an iPhone types (which `words` strips exactly the way
 * it strips the straight one, so "I’m bored" is still two tokens and still the fast path's).
 */
const FAST_PATH_READABLE = /^[\t\n\r\x20-\x7e’]*$/;

/**
 * May the English fast path speak for this message at all?
 *
 * Only if the message holds nothing the tokenizer would silently drop. "ok 볼래" tokenizes to
 * ['ok'] — one perfect example token and a request the tokenizer never saw — and a fast path reading
 * those tokens alone calls that idle. So the fast path is barred from any message with a character
 * outside what `words` reads, and those go to the classify layer, which reads every script.
 *
 * Deliberately a read of the RAW characters rather than of the tokens: the whole failure is that the
 * tokens no longer contain the evidence. An emoji or an accented letter costs one classify call for
 * the same reason, which is the cheap side of the trade.
 */
export function fastPathCanRead(text: string): boolean {
  return FAST_PATH_READABLE.test(text);
}

/**
 * LEAF_EXAMPLES_EXTRA: a comma-separated list of extra fast-path tokens, read at CALL time.
 *
 * The whole point of the examples being examples: an install whose person says "mkay" and "yeh"
 * twenty times a day can add them without a deploy, and nothing about the gate's shape changes.
 * Normalised exactly the way a token is (see `words`), so an entry that could never match a token
 * simply never matches one.
 */
export function leafExamplesExtra(): string[] {
  return (process.env.LEAF_EXAMPLES_EXTRA || '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/['’]/g, ''))
    .filter(Boolean);
}

/** The fast path's set for THIS call: the examples plus whatever the env adds. */
export function leafTokens(): ReadonlySet<string> {
  const extra = leafExamplesExtra();
  return extra.length ? new Set([...BASE_EXAMPLES, ...extra]) : BASE_EXAMPLES;
}

// ── the structural layer ─────────────────────────────────────────────────────

/**
 * The question marks, in the three scripts a text message actually arrives in: ASCII, the fullwidth
 * form CJK keyboards produce, and the inverted mark Spanish opens with. Not a word list — a
 * punctuation set, which is the same thing in every language that uses it.
 */
export const QUESTION_MARKS = ['?', '？', '¿'] as const;

/** Does this text carry a question mark of any script? */
function hasQuestionMark(text: string): boolean {
  return QUESTION_MARKS.some(mark => text.includes(mark));
}

/**
 * Did HER last turn end on a question? Exported because it is how the caller computes
 * `IdleFacts.endsInQuestion`, and computing it twice in two places is how the two copies end up
 * disagreeing about the fullwidth mark. Trailing whitespace and a closing bracket or quote are
 * ignored, because "so, thursday then?" survives being quoted.
 */
export function endsInQuestion(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').replace(/[\s"'’)\]}»”]+$/u, '');
  const last = trimmed.slice(-1);
  return !!last && QUESTION_MARKS.some(mark => mark === last);
}

/**
 * A link, structurally: a scheme, a `www.` host, or a host with a path after it. A BARE domain with
 * no scheme and no path is deliberately not matched — the shape `<word>.<word>` is also how a person
 * types "ok.thanks" with no space, and reading that as a link would turn a stall into a task for the
 * sake of a URL that the classify layer reads correctly anyway.
 */
const URL_SHAPE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}\/)/i;

/** Any decimal digit, in any script (`\p{Nd}`, not `\d`): a number is a fact, and a message carrying
 *  one is carrying something to act on — or at least is no stall. Arabic-Indic digits count the same
 *  as ASCII ones. */
const DIGIT_SHAPE = /\p{Nd}/u;

/** How many tokens a stall may be. Six is generous for "nothing much just tired" and short of any
 *  sentence with a subject and an object in it. An English-side convenience — see `words`. */
export const IDLE_MAX_TOKENS = 6;

/** …and how many characters, counted in code points so an astral emoji costs what a person thinks
 *  it costs. This is the LANGUAGE-AGNOSTIC read of length: it measures a script the tokenizer cannot
 *  see at all. Past it a message is no stall — which is the signal, not a veto. */
export const IDLE_MAX_CHARS = 40;

/**
 * How long a message may be and still be read for a share at all: ten times the stall cap, which is
 * a paragraph about a day and well short of a pasted document, a forwarded thread or an error log.
 *
 * This is the one length that IS a veto, and the cap Rivian's decision names ("share detection runs
 * on longer messages up to a cap"). Two reasons for a ceiling rather than none: past it a message is
 * work far more often than it is a bid — the thing people paste is a thing they want done with —
 * and every message under it that is not obviously a stall costs one classify call, so the cap is
 * also what keeps the layer-3 bill a function of conversation rather than of paste size.
 */
export const SHARE_MAX_CHARS = 600;

/**
 * Every structural reason this turn is WORK, by name, in a fixed order. Empty means nothing proves
 * the turn is a task — which is NOT the same as calling it idle, or a share.
 *
 * Named rather than boolean because the receipt has to be able to say WHICH fact decided: a gate
 * reporting only "task" cannot tell a burst from a pending question, and the battery scores the
 * layer, not the text (M11).
 *
 * PURE and total. The message-side reads come first (they are free and they are about the thing the
 * person actually typed), the turn-side facts after, each named for the fact rather than for its
 * effect.
 */
export function idleVetoes(text: string, facts: IdleFacts, opts?: IdleOptions): string[] {
  const t = (text ?? '').trim();
  const out: string[] = [];

  // A question is the one shape that is owed an answer, and answering is work — whatever else the
  // message looks like.
  if (hasQuestionMark(t)) out.push('question_mark');
  if (URL_SHAPE.test(t)) out.push('url');
  // Past the share cap nothing here is being read for a bid any more: see SHARE_MAX_CHARS.
  if ([...t].length > SHARE_MAX_CHARS) out.push('over_share_cap');

  if (facts.attachmentNote) out.push('attachment_note');
  if (facts.activeOps) out.push('active_ops');

  // An answer of theirs is owed: a parked approval the memory read reported, or her own last turn
  // ending on a question mark. Their next message is that answer, and answering is work.
  //
  // …unless the only question of hers standing is the FOLLOW-UP she asked on a share turn, which is
  // the one question of hers that asks for nothing to be done. Their reply to it is more of their
  // own story, which is another share and not a task — and routing it to work here is exactly what
  // made the follow-up impossible to ask in the first place (the pre-2026-09-11 gate treated every
  // question of hers alike, so a hook that came out as a question turned their next stall into an
  // answer turn and the kill switch could never fire). A parked APPROVAL is never relaxed: with one
  // outstanding the follow-up is not the only thing owed, so `followUpOnly` reads false and both
  // vetoes stand.
  const answerOwed = facts.pendingAsk || facts.endsInQuestion;
  const relaxed = opts?.shareTurns === true && followUpOnly(facts);
  if (answerOwed && !relaxed) out.push('pending_question');
  // …and the same message read as a settled yes or no by the consent gate is an answer twice over —
  // but only where there was an answer to give. A consent word answers something only when there is
  // something to answer: the reader says what "ok" WOULD mean if it settled something, which on its
  // own is not a fact about the turn. Read unconditionally it made "ok", "yes" and "sure"
  // permanently un-idle, and those are the commonest stalls there are (live: a bare "ok" after a
  // line of hers that asked nothing). So the veto is conditional on an answer being owed: with one
  // owed, `pending_question` fires and consent joins it — "yes please" after "want me to send it?"
  // is named by both — and with nothing owed a bare "ok" is a stall, which is what it looks like.
  if ((facts.consent === 'yes' || facts.consent === 'no') && answerOwed && !relaxed) out.push('consent');

  return out;
}

/**
 * Every structural reason this message is NO STALL, by name, in a fixed order. Weaker than a veto
 * and useful for exactly that reason: none of these proves the turn is work, and every one of them
 * proves the English examples cannot speak for it.
 *
 * Two effects, and no third: the fast path is barred (a message with a digit, a sentence's worth of
 * tokens, forty characters of text or a burst behind it is not made of the tokens LEAF_EXAMPLES
 * lists), and a layer-3 `stall` on such a message is read as a SHARE rather than as a stall — the
 * classifier answering "it asks for nothing" about a message too long to be a filler is describing
 * a bid. Each of these was a veto before 2026-09-11, which is why "morning meeting moved" came back
 * to a flat task turn with nothing to deliver.
 */
export function idleSignals(text: string, facts: IdleFacts): string[] {
  const t = (text ?? '').trim();
  const out: string[] = [];

  if (DIGIT_SHAPE.test(t)) out.push('digit');
  if (words(t).length > IDLE_MAX_TOKENS) out.push('too_many_tokens');
  if ([...t].length > IDLE_MAX_CHARS) out.push('too_long');

  if (facts.burstSize > 1) out.push('burst');

  return out;
}

/**
 * Is the ONLY question of hers still standing the follow-up she asked last turn?
 *
 * The distinction the whole share shape rests on: her confirm question is owed an answer and their
 * reply to it is work, while her follow-up asked for nothing to be done and their reply to it is
 * more of the thing they were already telling her. A parked approval outranks it — `pendingAsk` is
 * a fact about an action waiting on a word, and no ledger entry relaxes that.
 */
export function followUpOnly(facts: IdleFacts): boolean {
  return facts.followUpOutstanding && !facts.pendingAsk;
}

/**
 * Layer 2 in one predicate: can the English examples speak for this message, and do they call it a
 * stall?
 *
 * Extracted rather than left inline because TWO callers now ask it — the gate itself, and the
 * prefetch predicate below, which exists to answer "will layer 3 be reached" before the memory read
 * has come back. A second copy of the three conditions would be a copy that decides a call is
 * unnecessary on a message the gate then classifies anyway, i.e. the latency win handed back with a
 * doubled bill. One copy, two readers.
 *
 * The three conditions are the gate's own, in the gate's order: a message already marked as no stall
 * is not one made of stall tokens, a message the tokenizer cannot read WHOLE is not one the English
 * list may judge, and a message that tokenized to nothing must not pass "every token is an example"
 * vacuously.
 */
function fastPathStall(text: string, signals: readonly string[]): boolean {
  if (signals.length) return false;
  if (!fastPathCanRead(text)) return false;
  const tokens = words(text);
  const examples = leafTokens();
  return tokens.length > 0 && tokens.every(tok => examples.has(tok));
}

/**
 * The facts a caller can have in hand BEFORE the memory read has answered — the message-side ones,
 * plus the burst the webhook already counted and the attachment note the media already decides.
 *
 * Deliberately a SUBSET of `IdleFacts` and deliberately not all of it: the three question facts are
 * the memory read's and the ledger's, and waiting for them is exactly what the prefetch below exists
 * not to do. `activeOps` is left out for a different reason — it is an in-memory read the caller
 * takes at its own point in the turn, and a second sample here would be a second answer to "is a
 * look running" with no one to arbitrate between them.
 */
export type CheapIdleFacts = Pick<IdleFacts, 'attachmentNote' | 'burstSize'>;

/**
 * WILL THIS TURN REACH LAYER 3? Answered from the cheap facts alone, so the caller can start the
 * classify call in parallel with the memory read instead of behind it (convo/client.ts).
 *
 * It is a prediction and it is allowed to be wrong in exactly one direction. A `true` that the gate
 * then vetoes — a parked approval the memory read reports, her own last turn ending on a question,
 * a look that started — costs one abandoned five-token call and nothing else. A `false` costs a
 * wrong reading, so every branch here has to be one the full gate would take too: the vetoes are
 * asked with the unknown facts at their LOOSEST (nothing owed, nothing consented), which can only
 * ever make this answer more permissive than the gate's, and the fast path is asked through the very
 * function the gate asks.
 *
 * The flag rides along for the one thing it changes up here: with the third shape off a not-a-stall
 * signal is a veto again, so the long message a share arrives in never reaches the lane and must not
 * be prefetched either.
 */
export function classifyNeeded(text: string, facts: CheapIdleFacts, opts?: IdleOptions): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;

  // The unknowns at their loosest. Anything else here would be this function inventing a fact about
  // the turn, which is the one thing the gate's own inputs are arranged never to do.
  const full: IdleFacts = {
    ...facts,
    activeOps: false,
    pendingAsk: false,
    endsInQuestion: false,
    followUpOutstanding: false,
    consent: 'unclear',
  };
  const signals = idleSignals(t, full);
  const vetoes = idleVetoes(t, full, opts);
  // A bare question may be asking for her take, and the take reading is the classifier's.
  if (vetoes.length > 0) return opts?.takeTurns === true && onlyQuestionMark(vetoes);
  if (opts?.shareTurns !== true && signals.length > 0) return false;
  return !fastPathStall(t, signals);
}

// ── the three layers, in order ───────────────────────────────────────────────

/** What the gate decided, which layer decided it, and what the message was marked as no stall for.
 *  All three ride the receipt (`hooks:select`): the shape is the answer, the layer says whether the
 *  fallback is alive, and the signals say why a short-looking message went to it. */
export interface IdleReading {
  shape: TurnKind;
  layer: IdleLayer;
  signals: readonly string[];
  /** A task turn whose ask is her own opinion, taste, feeling or experience. Set only by the
   *  classifier's `take` verdict, and only on a task shape. */
  take?: boolean;
  /** A task turn whose ask is something a small child could answer, put to her as a test. Set only by
   *  the classifier's `quiz` verdict, and only on a task shape: she says no, and it stings. */
  quiz?: boolean;
}

/**
 * Which kind of turn is this? The three layers in order, failing toward task at every step.
 *
 * `classify` is INJECTED: this module never picks a lane, never sets a timeout and never caches, so
 * a test can drive all three layers without a network and the production wiring (convo/idleClassify.ts)
 * owns the model, the budget and the deadline. A classifier that rejects — including one that
 * rejected because it timed out — is read as a task, which is the same answer a dead lane gives and
 * the same answer an `unclear` gives: the cost of a wrong task turn is one flat reply; the cost of a
 * wrong idle turn is a clever line answering a piece of work.
 *
 * The `none` layer is the turn with nothing in it: a media-only message whose whole text is the
 * attachment note the caller stripped, or an empty string. There is no message to read, so no layer
 * reads one, and a turn nobody can read is a task.
 *
 * THE SHAPE TABLE, which is this function in full and the flag's contract in one place:
 *
 *   |                  | fast path | `stall`  | `share` | `ask` / `unclear` / throw |
 *   | plain            | idle      | idle     | share   | task                      |
 *   | `followUpOnly`   | share     | share    | share   | task                      |
 *   | a signal hit     | barred    | share    | share   | task                      |
 *
 * With `shareTurns` off the bottom two rows cannot be reached — a signal is a veto again and the
 * relaxation never applies — and a `share` verdict collapses to `task`, so every row of the
 * pre-share table comes back with the same layer and the same answer it did before this file grew a
 * third kind.
 *
 * TAKES. With `takeTurns` on, a question whose only veto is its question mark is read by the
 * classifier too, and a `take` verdict (on it, or on any message that reaches layer 3) comes back as
 * a task marked `take`: they asked what she thinks, so the answer is her opinion at her mood's
 * volume. Any other verdict on that question, or a failure, is the plain task it always was.
 */
export async function isIdleTurn(
  text: string,
  facts: IdleFacts,
  classify: (text: string) => Promise<IdleVerdict>,
  opts?: IdleOptions,
): Promise<IdleReading> {
  const shareOn = opts?.shareTurns === true;
  const t = (text ?? '').trim();
  if (!t) return { shape: 'task', layer: 'none', signals: [] };

  // Both structural reads, always, so the receipt carries the signals whichever way the turn went.
  const signals = idleSignals(t, facts);
  const vetoes = idleVetoes(t, facts, opts);
  // A question whose only veto is its question mark may be asking for HER take. It stays a task
  // either way (a take is answered, never hooked); the classifier only decides whether the answer is
  // her opinion, and a failed or unsure call is a plain task, like every other failure here.
  if (opts?.takeTurns === true && onlyQuestionMark(vetoes)) {
    try {
      const word = String(await classify(t) ?? '').trim().toLowerCase();
      return word === 'take'
        ? { shape: 'task', layer: 'classify', signals, take: true }
        : word === 'quiz'
          ? { shape: 'task', layer: 'classify', signals, quiz: true }
          : { shape: 'task', layer: 'classify', signals };
    } catch {
      return { shape: 'task', layer: 'classify', signals };
    }
  }
  const vetoed = vetoes.length > 0
    // With the third shape off, a signal is what every one of these facts was before it existed: a
    // veto. This one line is the whole of the flag's off path in this layer.
    || (!shareOn && signals.length > 0);
  if (vetoed) return { shape: 'task', layer: 'veto', signals };

  const relaxed = shareOn && followUpOnly(facts);
  // The examples, under their three conditions (`fastPathStall` above states all three and why each
  // one is there). A message they cannot speak for is not vetoed by that — it simply goes on to
  // layer 3, which reads the whole message in any script.
  if (fastPathStall(t, signals)) {
    // Their stall lands on her own follow-up: a one-word "meh" answering "how did it sit with you"
    // is the smallest share there is, and reading it as an idle turn would spend a hook on it and
    // leave the question she asked hanging.
    return { shape: relaxed ? 'share' : 'idle', layer: 'fast_path', signals };
  }

  try {
    const verdict = await classify(t);
    // Normalised rather than compared: a lane answers with a word, and a word with a newline or a
    // capital on it is the same answer. Anything that is neither `stall` nor `share` is a task.
    const word = String(verdict ?? '').trim().toLowerCase();
    // `share` needs no qualification — the classifier read a bid in the message itself. A `stall` is
    // a share only in the two cases the message could not have been a filler: it answers a follow-up
    // of hers, or a signal already said it is too long, too numerous or too many messages to be one.
    // A genuine `unclear` on a message with no question mark and no other veto is a person saying
    // something the lane could not place out of context ("thinking", "because im your developer"),
    // which is a thing handed to her far more often than a piece of work: with the share shape on it
    // is a share. A FAILED call (`failed`: a dead lane, a timeout, an unreadable answer) still fails
    // toward task, the gate's rule for everything it could not read at all.
    const shape: TurnKind = word === 'share' || (word === 'unclear' && shareOn)
      ? 'share'
      : word === 'stall'
        ? (relaxed || signals.length ? 'share' : 'idle')
        : 'task';
    // A take with no question mark ("curious what you make of cats") is the same ask as one with it.
    if (word === 'take' && opts?.takeTurns === true) return { shape: 'task', layer: 'classify', signals, take: true };
    if (word === 'quiz' && opts?.takeTurns === true) return { shape: 'task', layer: 'classify', signals, quiz: true };
    return { shape: shareOn || shape !== 'share' ? shape : 'task', layer: 'classify', signals };
  } catch {
    // A thrown call, a spent budget, an install with no classify lane, a deadline that fired. The
    // gate is not the place to log it — the caller owns the receipt and the error report, the same
    // way resolveConsent's caller does.
    return { shape: 'task', layer: 'classify', signals };
  }
}
