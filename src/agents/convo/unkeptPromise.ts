// The unkept-promise guard — the honesty backstop under the ONE failure the persona names as
// unrecoverable: a reply that promises work while nothing is actually being done for the user.
//
// Observed live (VPS, 2026-09-02). The user asked for a browser look. The reply: "yeah, i already
// told hermes to use the browser … still on it, hang tight" — with `tool_calls: null`
// and no run in flight, the earlier one having finished 2.5h before. A fabricated in-flight claim,
// and nothing in the pipeline was looking for it: the routing gate reads the USER's message (and read
// that one as social), and the false-refusal floor reads the draft for the opposite failure — a claim
// that something is impossible. A promise is a claim about the FUTURE, so it can only be checked
// against what the turn actually DID, which is what this module is for.
//
// PURE: the lexicon and the verdict. The one corrective re-ask lives in the call path
// (convo/shared.ts, beside the JSON-envelope retry it mirrors) — only that has a model to re-ask.
// The same guard reads the mirror-image claim (a change said to have landed with nothing behind it,
// the unbacked-claim half below), and both share that one re-ask.

/**
 * The promise lexicon — ENGLISH-ONLY: her L1 is English, and a hand-written list for any other
 * language is the thing the language-agnostic rule forbids (user, 2026-09-04) — a promise in another
 * language is the model's own `[[re:N]]` tag / the classify lane's business, never this array's.
 * Whole phrases, not words: single words ("checking") carry no commitment on their own, and the
 * verdict here costs a model call.
 *
 * SINGLE SOURCE (the THEME_KINDS pattern): the trigger and the re-ask's accept check read this same
 * array, so a phrase can never be one the guard fires on but the retry is not held to. Deliberately
 * short — every entry is a phrase whose plain reading is "work is happening right now", which is
 * exactly the claim a turn with no tool call and no active run cannot back.
 *
 * The `let me check` / `lemme check`, `digging through`, `looking up that` and `reading that page`
 * rows were added when the delegate doc and the JSON anchor still taught example holding lines, and
 * they stay because she still writes those shapes.
 *
 * `looking up that` and `reading that page` have a gerund-subject reading that promises nothing —
 * "looking up that address is free on the county site", "reading that page yourself is faster" — so
 * each can cost a corrective re-ask on an honest reply. Accepted, and not a new risk: `looking that
 * up` has fired on "looking that up yourself is free on the county site" since the row was first
 * written (verified), so the array already took that trade. Severity tips it: a missing row ships a
 * fabricated in-flight claim, the one failure the persona calls unrecoverable, while a false row
 * costs one model call on a sentence she rarely writes.
 *
 * The short waits. The delegate doc now asks for a varied beat, and a thinking sound or a short wait
 * is one of its shapes. The waits whose only reading is "wait for me while I do something" are rows:
 * `one sec` and `give me a sec`, beside `gimme a sec` and `give me a minute`. The bare thinking
 * sounds, and the waits that also read as surprise (`hold on`, `wait a sec`), are deliberately left
 * out: she uses those as reactions in banter, so a row of them would re-ask honest replies all day,
 * and a corrective re-ask on an honest reply is the worse failure once it stops being rare. A
 * thinking sound alone promises no specific work, so an undelegated one reads as a reaction and
 * breaks no promise.
 *
 * Bare `checking` and bare `looking` stay out for the matcher's sake: it matches a phrase anywhere
 * inside a clause, so a row of `checking` would fire on "worth checking with a doctor before you rely
 * on this" and "checking that yourself is the faster route", neither of which promises anything. A
 * one-word entry cannot be restricted to a whole-clause reading without changing the matcher.
 * Multi-word rows only.
 */
export const PROMISE_PHRASES = [
  'on it',
  'looking that up',
  'pulling that up',
  'checking on that',
  'digging into',
  'digging through',
  'looking up that',
  'reading that page',
  'let me check',
  'lemme check',
  'still on it',
  'still digging',
  'hang tight',
  'gimme a sec',
  'give me a sec',
  'one sec',
  'give me a minute',
  'back in a bit',
] as const;

/** One phrase from the lexicon above — derived from the array so the two can never drift. */
export type PromisePhrase = typeof PROMISE_PHRASES[number];

export interface UnkeptPromiseVerdict {
  /** The reply claims work is happening (or about to). */
  promised: boolean;
  /** The phrase that made it a promise, in reading order. Absent when nothing promised. */
  phrase?: PromisePhrase;
  /** It promised, and NOTHING is behind it: no tool call this turn, no research in flight. */
  unkept: boolean;
}

// A phrase has to land inside ONE clause that STATES something. Sentence and clause punctuation ends
// the run of words a phrase may span, so "moving on. it can wait" and "hang on, it broke" are not
// promises even though their letters contain one — the words sit either side of a break. Every other
// non-alphanumeric run collapses to a single space, which is what makes the match blind to case,
// punctuation and the `[[re:N]]` routing prefix ("ON IT!", "[[re:1]]ON IT"). The leading/trailing pad
// is what makes the match below a whole-phrase test rather than a substring one ("depends on itself"
// contains "on it" as letters, never as words). A clause that ends in a question mark asks about work
// rather than claiming any, the same reading the claim half gives it (statedClauses below).
const NON_WORD = /[^a-z0-9]+/g;

// `on it` is the one row whose words are as often the object of a verb or an adjective ("sleep on
// it", "rough on it"). It is a status line only when it opens its clause or follows a word that makes
// it one: an acknowledgment, still/already, or who is on it ("i'm", "hermes is").
const ON_IT_AFTER = new Set([
  'ok', 'okay', 'k', 'yeah', 'yep', 'yup', 'ya', 'aight', 'alright', 'still', 'already', 'right', 'get', 'getting',
  'im', 'm', 'am', 're', 'we', 'is', 's', 'hermes',
]);

/** The first phrase the reply promises with, scanning bubble by bubble in reading order. */
function findPromise(bubbles: string[]): PromisePhrase | undefined {
  for (const bubble of bubbles) {
    for (const clause of statedClauses(bubble)) {
      for (const phrase of PROMISE_PHRASES) {
        const at = clause.indexOf(` ${phrase} `);
        if (at < 0) continue;
        if (phrase === 'on it' && at > 0 && !ON_IT_AFTER.has(clause.slice(0, at).trim().split(' ').pop()!)) continue;
        return phrase;
      }
    }
  }
  return undefined;
}

/**
 * Did this reply promise work it isn't doing? PURE — the three inputs are the whole question:
 * the bubbles she wrote, the tool calls the same envelope carried, and how many Ops runs are already
 * in flight for the chat.
 *
 * A promise is KEPT by either half: a tool call (the work starts the moment this turn dispatches) or
 * an active run ("still on it" is simply true then). Only the empty case is a lie, and it is the one
 * that shipped live.
 */
export function detectUnkeptPromise(
  bubbles: string[],
  toolCalls: unknown[] | null,
  activeOps: number,
): UnkeptPromiseVerdict {
  const phrase = findPromise(bubbles);
  const promised = phrase !== undefined;
  const nothingBehindIt = (!toolCalls || toolCalls.length === 0) && activeOps === 0;
  return {
    promised,
    ...(phrase !== undefined ? { phrase } : {}),
    unkept: promised && nothingBehindIt,
  };
}

/**
 * The corrective the re-ask appends after the model's own slip — system-authored, so bare prose in a
 * user-role message, exactly like the JSON-envelope retry's. It offers the two honest exits and names
 * the third as forbidden: do the work for real, or say plainly what you can and can't do.
 */
export function renderPromiseCorrection(phrase: string): string {
  return `SYSTEM: your reply promised work ("${phrase}") but called no tool and nothing is running for them. Reply again as ONE JSON object: either include the delegate_to_ops entry that actually does the work, or say plainly what you can and can't do right now — never claim work is in progress.`;
}

// ── The unbacked-claim half ─────────────────────────────────────────────────────────────────────
// The mirror image of a promise: a claim about the PAST, that a change already landed. Observed live
// (local instance, 2026-09-23), the last turn of the reminder incident (convo/actionResults.ts): after
// four replies that each said a cancel had missed, the model wrote "got it, revised the morning one"
// with no tool call at all. Nothing had been revised; the user read that it had, and stopped asking.
// A claim can only be checked against what the turn actually changed, so it rides the same guard and
// the same one re-ask as the promise above.

/**
 * Single-word claims, ENGLISH-ONLY under the same standing rule as the promise lexicon. A bare word
 * counts ONLY when it is the whole clause ("got it, revised" splits into "got it" and "revised"):
 * inside a longer clause each of these words carries no claim ("i fixed dinner", "the updated
 * schedule", "are we done here"), and the verdict costs a model call.
 */
export const CLAIM_WORDS = ['done', 'revised', 'updated', 'switched', 'cancelled', 'removed', 'fixed'] as const;

/** Multi-word claims, matched as whole phrases inside one clause like the promise rows. Each one's
 *  plain reading is "the change you asked for is made". A phrase with no past tense of its own
 *  ("set it for …") is left off: it reads as an offer or a plan as easily as a report. */
export const CLAIM_PHRASES = [
  'changed it',
  'switched it',
  'updated it',
  'revised it',
  'cancelled it',
  'removed it',
  'fixed it',
  'moved it',
  'all set',
  'all done',
] as const;

// A claim is a STATEMENT that a change landed. The same words also ask ("all set?"), offer ("want me
// to switch it"), plan ("i'll have it all set"), set a condition ("if you're all set") or deny ("i
// haven't changed it yet"), and every one of those is the honest reply to a turn that changed
// nothing, including the "which one did you mean" a missed cancel should end on. So a clause that
// ends in a question mark is never a claim, and neither is a phrase with one of these ahead of it
// inside its clause. `t` is the n't of a contraction, split off by NON_WORD ("haven't" reads "haven
// t"); `ll` is the 'll of "i'll".
const NOT_A_REPORT = new Set([
  'not', 'never', 't', 'cant', 'cannot', 'wont', 'dont', 'didnt', 'havent', 'hasnt', 'isnt', 'wasnt', 'aint',
  'will', 'll', 'shall', 'should', 'can', 'could', 'would', 'might', 'if', 'gonna', 'wanna',
]);
const NOT_A_REPORT_PHRASES = [' going to ', ' want me to '];

/** The `[[re:N]]` routing tag a bubble can open with (state/replyThreading.ts). Its colon is a
 *  clause break to the splitter, so it is set aside before any clause is read. */
const REPLY_TAG = /^\s*\[\[re:\d+\]\]/;
const REPLY_TAGS = /\[\[re:\d+\]\]/g;

/** A bubble's clauses, lowercased and padded for whole-phrase matching, each with whether its own
 *  terminator carries a question mark. */
function terminatedClauses(text: string): Array<{ clause: string; asks: boolean }> {
  const pieces = text.replace(REPLY_TAGS, ' ').toLowerCase().split(/([.!?,;:\n\r]+)/);
  const out: Array<{ clause: string; asks: boolean }> = [];
  for (let i = 0; i < pieces.length; i += 2) {
    out.push({ clause: ` ${pieces[i].replace(NON_WORD, ' ').trim()} `, asks: (pieces[i + 1] ?? '').includes('?') });
  }
  return out;
}

/** The clauses of a bubble that STATE something: each clause whose own terminator carries a
 *  question mark is left out. */
function statedClauses(text: string): string[] {
  return terminatedClauses(text).filter(c => !c.asks).map(c => c.clause);
}

/** Does the reply ask them something? Any bubble with a clause of words ending on a question mark,
 *  read by the same split that keeps questions from counting as claims. */
export function asksQuestion(bubbles: readonly string[]): boolean {
  return bubbles.some(b => terminatedClauses(b).some(c => c.asks && c.clause.trim() !== ''));
}

/** Does anything ahead of the phrase, inside its clause, make it other than a report? */
function reportsOtherwise(before: string): boolean {
  return before.trim().split(' ').some(w => NOT_A_REPORT.has(w))
    || NOT_A_REPORT_PHRASES.some(p => ` ${before.trim()} `.includes(p));
}

/**
 * The tools whose call is a change made on their behalf, and so the only thing that can back a
 * claim. A lookup is not one: work that is RUNNING backs a promise ("on it") and never a claim that
 * something is done, which is also why a delegation is left off. It also names the one change the
 * TURN makes on their word before her calls run, the engine ask's answer.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'schedule_automation', 'update_automation', 'cancel_automation', 'cancel_research', 'steer_research',
  'set_preference', 'update_directives', 'update_memory', 'remember_user', 'rename_group_chat', 'remove_member',
  // The answer to their engine's ask (agents/ops/engineApproval.ts), settled before her calls run.
  // Never a tool she calls, only a result a claim like "it's going ahead" can stand on.
  'engine_approval',
]);

export interface UnbackedClaimVerdict {
  /** The reply says a change already landed. */
  claimed: boolean;
  /** The claim that made it one, in reading order. Absent when nothing was claimed. */
  phrase?: string;
  /** It claimed, and nothing this turn changed anything. */
  unbacked: boolean;
}

/**
 * A statement clause that OPENS on one of these verbs with an object right after it reports a change
 * made: "revised the morning one", the incident's own last line, which the whole-clause rule above
 * cannot reach. Both lists are closed and short. "done" and "fixed" are left off, because a
 * clause they open is as often about her day ("done for today") as about a change; and an object
 * outside the list keeps an idiom out ("changed my mind").
 */
const CLAIM_LEAD_VERBS = new Set([
  'revised', 'updated', 'switched', 'changed', 'cancelled', 'canceled', 'removed', 'moved', 'deleted', 'replaced',
]);
const CLAIM_OBJECTS = new Set(['the', 'it', 'that', 'this', 'your', 'ur', 'them', 'both', 'those', 'ya', 'u']);

/**
 * The few words a report opens on ahead of its verb ("i revised the morning one", "ok revised it",
 * "got it revised it" with no comma). A closed set of whole-word openers, stripped from the front of
 * the clause before the verb is read, so a negation or a modal can never take an opener's slot:
 * "i haven't changed it" stops at "haven", which is no opener and no verb.
 */
const CLAIM_OPENERS: readonly (readonly string[])[] = [
  ['got', 'it'], ['i', 've'], ['i', 'have'], ['i'], ['ive'], ['just'], ['ok'], ['okay'], ['already'],
];

/** The clause's words with its leading openers taken off, however many there are. */
function afterOpeners(words: string[]): string[] {
  let rest = words;
  for (;;) {
    const opener = CLAIM_OPENERS.find(o => o.every((w, i) => rest[i] === w));
    if (!opener) return rest;
    rest = rest.slice(opener.length);
  }
}

/**
 * The claim rows with no change named in them: a bare completion word, or "all set" / "all done".
 * Each one reads as a report ONLY when there was an ask to report on. After "finally finished the
 * deck", or a "lol", nothing was asked of her, so the same words are about their day: the deck is
 * done, they are all set. Observed live (2026-09-24 latency round): a bare "done" on exactly that
 * turn cost a re-ask, and the re-ask shipped an apology for an action nobody asked about. A verb
 * with its object ("revised the morning one", "switched it") still says SHE changed something,
 * whatever the turn asked, so those rows hold on every turn.
 */
const BARE_CLAIM_PHRASES: ReadonlySet<string> = new Set(['all set', 'all done']);

/** The first claim in the reply, bubble by bubble in reading order. `bare` false leaves out the
 *  rows that name no change (above). */
function findClaim(bubbles: string[], bare = true): string | undefined {
  for (const bubble of bubbles) {
    for (const clause of statedClauses(bubble)) {
      const whole = clause.trim();
      const word = bare ? CLAIM_WORDS.find(w => w === whole) : undefined;
      if (word) return word;
      const [lead, object] = afterOpeners(whole.split(' '));
      if (CLAIM_LEAD_VERBS.has(lead) && CLAIM_OBJECTS.has(object)) return `${lead} ${object}`;
      for (const phrase of CLAIM_PHRASES) {
        if (!bare && BARE_CLAIM_PHRASES.has(phrase)) continue;
        const at = clause.indexOf(` ${phrase} `);
        if (at >= 0 && !reportsOtherwise(clause.slice(0, at + 1))) return phrase;
      }
    }
  }
  return undefined;
}

/**
 * Did this reply claim a change nothing made? PURE. A claim is backed by a mutating call in the
 * same envelope (it runs when the turn dispatches), or by `backedEarlier`: a change an earlier pass
 * of this same user-visible turn already made, which the caller reads off the turn's results.
 *
 * `taskTurn` false (a share or idle turn, from the turn's hook directive) reads the rows that name
 * no change as talk about their day (BARE_CLAIM_PHRASES above). Unknown is a task turn: the whole
 * lexicon, as before the turn kind was passed.
 */
export function detectUnbackedClaim(
  bubbles: string[],
  toolCalls: readonly { name: string }[] | null,
  backedEarlier: boolean,
  opts: { taskTurn?: boolean } = {},
): UnbackedClaimVerdict {
  const phrase = findClaim(bubbles, opts.taskTurn !== false);
  const claimed = phrase !== undefined;
  const mutated = (toolCalls ?? []).some(c => MUTATING_TOOLS.has(c.name));
  return { claimed, ...(phrase !== undefined ? { phrase } : {}), unbacked: claimed && !mutated && !backedEarlier };
}

/**
 * Drop every clause that claims a change from a line that must ship beside a result that did not
 * land (the holding half a delegated turn keeps). The draft was written before its calls ran, so a
 * claim in it is a guess, and beside a voiced miss it is a contradiction. The rest of each bubble
 * stands, punctuation and all; a bubble left with nothing is dropped, and nothing left at all is
 * null, so the caller's own fallback line takes over.
 */
export function dropClaims(legacyText: string): string | null {
  const kept: string[] = [];
  for (const bubble of legacyText.split('\n---\n')) {
    // The routing tag is set aside and put back on what survives: the send path threads the bubble
    // by it, and its colon would otherwise be read as a clause break and cut it in half.
    const tag = bubble.match(REPLY_TAG)?.[0].trim() ?? '';
    const body = tag ? bubble.replace(REPLY_TAG, '') : bubble;
    // The split keeps its separators (odd indices), so each surviving clause keeps its own, and a
    // clause is judged with its own terminator (a question is never a claim).
    const pieces = body.split(/([.!?,;:\n\r]+)/);
    const out: string[] = [];
    for (let i = 0; i < pieces.length; i += 2) {
      const sep = pieces[i + 1] ?? '';
      if (findClaim([pieces[i] + sep])) continue;
      out.push(pieces[i], sep);
    }
    const text = out.join('').replace(/\s{2,}/g, ' ').replace(/^[\s.!?,;:]+|[\s,;:]+$/g, '').trim();
    if (/[a-z0-9]/i.test(text)) kept.push(`${tag}${text}`);
  }
  return kept.length ? kept.join('\n---\n') : null;
}

/**
 * The corrective for an unbacked claim, in the same seam and shape as the promise one. It states the
 * rule rather than quoting her back at herself beyond the phrase: a change is said only when a call
 * made it.
 */
export function renderClaimCorrection(phrase: string): string {
  return `SYSTEM: your reply said a change was made ("${phrase}") but nothing this turn changed anything. Reply again as ONE JSON object: either include the call that makes the change, or say plainly what has and has not changed. Say a change landed only when a call behind it did.`;
}

/**
 * The feature gate (env: CONVO_UNKEPT_PROMISE_GUARD). Default ON, read at CALL time so flipping it
 * needs no restart — the same parse shape as every sibling flag (turnFocusBlockEnabled,
 * threadingEnabled, themeTopicGateEnabled, turnTraceEnabled).
 *
 * It gates the CALL PATH (convo/shared.ts), not this module: off means the scan never runs, no
 * re-ask is spent, no receipt is filed, and the reply the model wrote ships byte-identically to an
 * install that never had the guard.
 */
export function unkeptPromiseGuardEnabled(): boolean {
  const v = (process.env.CONVO_UNKEPT_PROMISE_GUARD || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}
