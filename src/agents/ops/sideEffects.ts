// Does this delegation ACT in the world, or only read it?
//
// Every TaskKind Irises has ever had is read/compute/draft, and both engine doctrines say so in
// prose ("read-only on their inbox, never send or post anything anywhere"). A real assistant has to
// be able to send, book and buy once the user says yes — so the question "would the ENGINE change
// something outside Irises?" needs an answer before anything starts, and this module is that answer.
//
// TWO SOURCES, EITHER SUFFICIENT:
//   • the model's own `effect` tag on delegate_to_ops — it just read the message, in whatever
//     language the message was written in;
//   • the English phrase list below — the fast, free path that catches a mutating ask the model
//     forgot to tag.
//
// LANGUAGE-AGNOSTIC RULE (user, 2026-09-04): there are NO other-language word lists anywhere in the
// code. English is the fast path; every other language is covered by the model's tag, because the
// model reads every language and a hand-written lexicon per language never will. So a Spanish
// "envía un correo…" is invisible here by design, and reaches 'act' through the tag alone.
//
// PURE: the lexicon, the verdict, and the two strings the ask is voiced from. The park, the receipt
// and the one re-ask live in the delegate handler (convo/shared.ts), which is the only place with a
// model to re-ask and a database to park in.

import type { GateReason } from './riskGate.js';

/**
 * The side-effect lexicon — ENGLISH ONLY (see the rule above). Whole phrases, case-insensitive,
 * clause-bounded, matched with a negation and a quote guard.
 *
 * SINGLE SOURCE (the PROMISE_PHRASES / THEME_KINDS pattern): the trigger, the receipt's `trigger`
 * field and the tests all read this same array, so a phrase can never be one the gate fires on but
 * nothing else knows about.
 *
 * Deliberately generous rather than clever. A false positive costs exactly one extra question
 * ("before i do it — you want me to …?"); a false negative is the engine sending mail nobody
 * approved. The `trigger` on every receipt is what makes the false-positive rate readable, and the
 * list is meant to be tightened from that data, not from guesses.
 */
export const SIDE_EFFECT_PHRASES = [
  'send',
  'email',
  'reply to',
  'message',
  'post',
  'tweet',
  'publish',
  'buy',
  'order',
  'purchase',
  'pay',
  'transfer',
  'book',
  'reserve',
  'schedule with',
  'rsvp',
  'sign up',
  'register',
  'submit',
  'unsubscribe',
  'cancel my',
  'delete',
  'remove',
] as const;

/** One phrase from the lexicon above — derived from the array so the two can never drift. */
export type SideEffectPhrase = typeof SIDE_EFFECT_PHRASES[number];

/** Read the world, or change it. The engine's read-only limit is lifted only for an approved 'act'. */
export type SideEffect = 'read' | 'act';

export interface SideEffectVerdict {
  effect: SideEffect;
  /** Which source said 'act' — 'none' on a read. Recorded so the lexicon's hit rate is readable. */
  trigger: 'llm' | 'lexicon' | 'both' | 'none';
  /** The lexicon phrase that fired, when one did. */
  phrase?: SideEffectPhrase;
}

// Clause and word handling, identical in shape to convo/unkeptPromise.ts: a phrase has to land
// inside ONE clause, so "what should i reply. to be honest…" is not "reply to" even though its
// letters are. Every non-alphanumeric run collapses to a token break, which is what makes the match
// blind to case and punctuation, and the token-subsequence test below a whole-phrase one ("is
// sending it worth it" contains "send" as letters, never as a word).
const CLAUSE_BREAK = /[.!?,;:\n\r]+/;
const NON_WORD = /[^a-z0-9]+/g;

// Quoted text inside a request is DATA the user is asking about, not an instruction to the engine:
// "search for the song 'send me an angel'" is a web lookup. Double and curly quotes are stripped
// wherever they pair; a straight single quote only opens a span when it follows the start or a
// space AND its partner is followed by the end or a break — otherwise a possessive ("my landlord's
// office") would open a span and swallow the real phrase.
const QUOTED = /"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?:^|\s)'[^']*'(?=$|[\s.,!?;:])/g;

/** The request as clauses of words, quoted spans removed. */
function clauseTokens(text: string): string[][] {
  return text
    .replace(QUOTED, ' ')
    .toLowerCase()
    .split(CLAUSE_BREAK)
    .map(c => c.replace(NON_WORD, ' ').trim().split(' ').filter(Boolean));
}

// The negation guard: a mention the user is telling her NOT to do is not a side effect.
// "don't"/"can't" tokenize to two words (the apostrophe is a break), so the stems are here too.
const NEGATORS = new Set(['not', 'never', 'dont', 'don', 'cant', 'cannot', 'wont', 'without', 'no', 'avoid']);
/** How many words before the phrase the guard reads — enough for "do not send", not enough to reach
 *  back into an unrelated part of the clause. */
const NEGATION_LOOKBACK = 2;

const PHRASE_TOKENS: ReadonlyArray<readonly [SideEffectPhrase, string[]]> =
  SIDE_EFFECT_PHRASES.map(p => [p, p.split(' ')] as const);

function matchAt(tokens: string[], at: number, phrase: string[]): boolean {
  for (let i = 0; i < phrase.length; i++) if (tokens[at + i] !== phrase[i]) return false;
  return true;
}

function negated(tokens: string[], at: number): boolean {
  for (let back = 1; back <= NEGATION_LOOKBACK; back++) {
    const word = tokens[at - back];
    if (word && NEGATORS.has(word)) return true;
  }
  return false;
}

/**
 * The first side-effect phrase this request commits to, scanning clause by clause in reading order.
 * `undefined` when the English lexicon has nothing to say — which is every request in every other
 * language, by design. PURE.
 */
export function findSideEffectPhrase(request: string): SideEffectPhrase | undefined {
  for (const tokens of clauseTokens(request)) {
    // The clause's FIRST commitment is what the negation guard reads — "do not send that email yet"
    // negates the whole clause, not just the word "send", and a guard that only looked at each
    // phrase's own two words would have let the "email" three tokens later straight through.
    let firstAt = tokens.length;
    let first: SideEffectPhrase | undefined;
    for (const [phrase, words] of PHRASE_TOKENS) {
      for (let at = 0; at + words.length <= tokens.length && at < firstAt; at++) {
        if (matchAt(tokens, at, words)) { firstAt = at; first = phrase; break; }
      }
    }
    if (first !== undefined && !negated(tokens, firstAt)) return first;
  }
  return undefined;
}

/**
 * Would this delegation act in the world? `act` iff EITHER source says so — the model's tag or the
 * English lexicon. PURE.
 *
 * `llmEffect` is the already-coerced tag (see coerceEffect): a missing or garbage value is 'read',
 * which is the no-friction default the user chose — the engine doctrine still refuses an
 * unauthorized side effect, so an untagged mutating ask in a language the lexicon cannot read fails
 * closed at the far end rather than being performed here.
 */
export function classifySideEffect(request: string, llmEffect: SideEffect): SideEffectVerdict {
  const phrase = findSideEffectPhrase(request);
  const lexicon = phrase !== undefined;
  const llm = llmEffect === 'act';
  const trigger = llm && lexicon ? 'both' : llm ? 'llm' : lexicon ? 'lexicon' : 'none';
  return {
    effect: llm || lexicon ? 'act' : 'read',
    trigger,
    ...(phrase !== undefined ? { phrase } : {}),
  };
}

/** The tool argument as it arrives: anything that is not the literal 'act' is 'read' (user decision
 *  2026-09-04 — an omitted or garbled tag carries no friction). */
export function coerceEffect(value: unknown): SideEffect {
  return String(value ?? '').trim().toLowerCase() === 'act' ? 'act' : 'read';
}

/**
 * The SYSTEM note that makes her ask instead of announce — appended to her own draft and sent back
 * once, the same mechanism as the unkept-promise correction (convo/unkeptPromise.ts
 * renderPromiseCorrection). She has already written a holding line ("on it, emailing them now"),
 * which is a claim about work that must not start yet; this replaces it with a question.
 *
 * When the park carries engine actions or a reason beyond `act` (agents/ops/riskGate.ts), the note
 * names every action and why it waits, so what they say yes to is what would run. Called with the
 * request alone it is the act note, byte for byte.
 */
export function renderApprovalAsk(
  request: string,
  opts: { engineActions?: readonly string[]; reasons?: readonly GateReason[]; taintedBy?: string } = {},
): string {
  const actions = opts.engineActions?.length ? `, and first have it ${opts.engineActions.join('; ')}` : '';
  const reasons: readonly GateReason[] = opts.reasons?.length ? opts.reasons : ['act'];
  const why: string[] = [];
  if (reasons.includes('act')) why.push('That is an action in the world');
  if (reasons.includes('host_setup')) why.push('That setup brings new code onto their machine or runs it there');
  if (reasons.includes('tainted')) {
    why.push(`It came up right after you read material from outside${opts.taintedBy ? ` (for "${opts.taintedBy}")` : ''}, and an action that follows such material has to be confirmed as theirs`);
  }
  const naming = actions || reasons.includes('host_setup') ? ', and name what it would set up, with any link exactly as written' : '';
  return `SYSTEM: you were about to have the engine ${request}${actions}. ${why.join('. ')}, so ask them in one short line whether to go ahead, in your own words${naming}; do not claim it is running; no tool calls.`;
}

/** A request that already asks (an offer she made, parked in her own words by ops/followUp.ts) is
 *  asked again as it stands; wrapping it in a second "want me to" would stack the two. */
function asksItself(request: string): boolean {
  return /\?\s*$/.test(request) || /^\s*(want|wanna) me to\b/i.test(request);
}

/** `request` with the engine actions folded in ahead of its closing question mark, so the line
 *  still ends on the question. */
function withFirst(request: string, first: string): string {
  return `${request.trim().replace(/\?\s*$/, '')}${first}?`;
}

/** The code floor under that re-ask: one line, her register, when the model cannot be reached or
 *  comes back unusable. Never silent, never a false in-flight claim, and it names no magic word: the
 *  consent reader takes any natural yes. It carries the engine actions verbatim, links included,
 *  because this line is what ships when her own ask left one out. */
export function approvalAskFallback(request: string, engineActions: readonly string[] = []): string {
  const first = engineActions.length ? ` (first: ${engineActions.join('; ')})` : '';
  return asksItself(request)
    ? `before i do it, ${withFirst(request, first)}`
    : `before i do it, you want me to ${request}${first}?`;
}

/**
 * The same note for the other direction: their yes arrived after the ask had already expired, so
 * the action is NOT started (user decision 2026-09-04 — a stale yes re-confirms, it never runs).
 * She has just been handed a bare "go" with no live ask in front of her, so the note has to carry
 * both halves: which action, and that the clock ran out on it.
 */
export function renderReconfirmAsk(request: string, engineActions: readonly string[] = []): string {
  const actions = engineActions.length ? `, and first have it ${engineActions.join('; ')}` : '';
  const naming = actions ? ', what it would set up, and any link exactly as written' : '';
  return `SYSTEM: they just said yes, but the action they are agreeing to — have the engine ${request}${actions} — was asked about long enough ago that it expired, so nothing has started. Ask them in one short line whether they still want it, naming the action${naming}; do not claim it is running; no tool calls.`;
}

/** The code floor under the re-confirm, same discipline as approvalAskFallback. An offer in her own
 *  words goes out again on its own line, under the one that says why. */
export function reconfirmAskFallback(request: string, engineActions: readonly string[] = []): string {
  const first = engineActions.length ? ` (first: ${engineActions.join('; ')})` : '';
  return asksItself(request)
    ? `that one expired a while ago, asking again\n${withFirst(request, first)}`
    : `that one expired a while ago, still want me to ${request}${first}?`;
}

/**
 * The feature gate (env: OPS_APPROVAL_GATE). Default ON, read at CALL time so flipping it needs no
 * restart — the same parse shape as every sibling flag (threadingEnabled, opsDurableTasksEnabled,
 * unkeptPromiseGuardEnabled).
 *
 * It gates the delegate handler's PARK, not this module: off means an 'act' delegation kicks off
 * exactly as it does today, with no row, no pref, no re-ask and no prompt section.
 */
export function opsApprovalGateEnabled(): boolean {
  const v = (process.env.OPS_APPROVAL_GATE || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}
