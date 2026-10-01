// The early-emit gate: the PURE decisions behind sending a bubble before the reply that carries it
// has finished generating. A later task (streaming the reply sentence-by-sentence, Task 15) is the
// impure half — it owns the model connection, the send timing and the fallback when the gate says
// no partway through. Everything here is a function of its arguments alone, on purpose: the ONE
// failure this whole feature must never cause is a sentence reaching the user that a downstream
// guard would have discarded or rewritten, and a gate that is pure is a gate a test can pin down to
// every combination without a model in the loop.
//
// Three questions, three functions:
//   • streamArmed  — before the call even starts, is this turn's shape one where an early sentence
//     is safe at ALL? (a whole-turn question, decided once)
//   • sentenceBlocker — for one sentence that already streamed out of the model, does it carry a
//     failure shape the send path would have caught downstream? (a per-sentence question, decided
//     once per candidate)
//   • cleanEarlySentence — the cosmetic cleanup sendBubbles already applies to every bubble
//     (routing-tag strip, echoed-timestamp strip, tool-name redaction, Ops-scaffolding strip).
//     Reused verbatim so an early-sent bubble and a normally-sent bubble are byte-identical for the
//     same input — two cleanup paths for one bubble is how they drift.
//
// REUSE, NOT REIMPLEMENTATION. Every check below calls the same function the non-streamed path
// already trusts (unkeptPromise.ts's two detectors, routingGate.ts's refusal map, guardrails.ts's
// two scrubs, replyThreading.ts's tag strip, chatTime.ts's marker strip). A second lexicon here would
// only ever be a second place for the first one to go stale against.

import { detectUnkeptPromise, detectUnbackedClaim } from '../agents/convo/unkeptPromise.js';
import { refusedCapabilities } from '../agents/routingGate.js';
import { redactInternalTools, stripOpsScaffolding } from '../agents/guardrails.js';
import { stripReplyTag } from '../state/replyThreading.js';
import { stripTimestampMarker } from './chatTime.js';
import { splitIntoBubbles, splitIntoBubblesWithSplits } from './bubbles.js';

/**
 * Everything `streamArmed` needs, gathered before the model call starts (Task 15 builds this from
 * values `chat()` already has on hand — a parked-approval DB read, the hook directive picked for
 * this turn, the routing gate's own pre-check, and the chat/turn shape).
 */
export interface PreCallFacts {
  /** A delegation is parked on this chat awaiting a yes/no — the routing/approval floor may replace
   *  the whole draft with the parked question, so nothing of the model's own draft may ship early. */
  hasParkedApproval: boolean;
  /** The hook mode picked for this turn (persona/hooks.ts `HookMode`, or `undefined` with no hook
   *  directive at all — which reads as a plain task turn, same as `client.ts`'s own `anchorMode`
   *  fallback). `'hook'` is the idle-turn mode's actual value (persona/hooks.ts's `HookMode`), not
   *  `'idle'`. Every mode arms EXCEPT `'quiet'`: `'task'`, `'share'` and `'hook'` (idle) are exactly
   *  the slow turns this feature exists to speed up, and the share/hook laws — one hook, the share
   *  turn's gated follow-up — are enforced in the PROMPT, not by a code guard that rewrites the draft
   *  after the fact, so there is nothing downstream for an early sentence to race past. `'quiet'` is
   *  the one mode with a post-draft rewrite (`enforceQuiet` in convo/shared.ts can still replace the
   *  whole reply after generation), so it's the one mode that never arms. */
  hookMode: 'task' | 'share' | 'hook' | 'quiet' | string | undefined;
  /** The routing gate's pre-check, and ONLY the pre-check: `needsGrounding(textToSend) === 'yes'`,
   *  with NO freshness read alongside it. The freshness TTL can flip between this read and the gate's
   *  own later one, and `holdsTheAnswer` only ever stands the gate down — it never rewrites what
   *  ships — so a flag computed here that also weighed freshness could arm on a turn the gate goes on
   *  to force-delegate, which discards the draft this flag is guarding. */
  groundingFlagged: boolean;
  /** A group chat. */
  isGroupChat: boolean;
  /** The turn is an intro weave or a first-move message rather than an ordinary reply. */
  introOrFirstMove: boolean;
  /** More than one message landed in the same burst (`chatContext.burstManifest.length > 1`).
   *  Bubble order in a burst reply is `text` first, `re` (which incoming message it answers) second
   *  — so the moment bubble 0's FIRST sentence closes, its thread target is still unknown. A burst
   *  turn never arms. */
  isBurst: boolean;
  /** `STREAM_FIRST_BUBBLE` — see `streamFirstBubbleEnabled` below. */
  enabled: boolean;
}

/**
 * `STREAM_FIRST_BUBBLE` — the master switch for early-emit, read at CALL time so a flip needs no
 * restart (same house shape as `persona/featureFlags.ts`, read fresh on every use rather than cached
 * at import time). Default ON, and — unlike the whitelist those four flags parse against — disabled
 * by exactly one word, `off`: this switch is the one an operator reaches for FIRST if a live turn
 * ships a bad early sentence, so it has to come back off with the plainest possible value, not a
 * word chosen from a list nobody has memorized at 3am.
 */
export function streamFirstBubbleEnabled(): boolean {
  const v = (process.env.STREAM_FIRST_BUBBLE || '').trim().toLowerCase();
  if (v === '') return true;
  return v !== 'off';
}

/**
 * May THIS TURN stream at all? A whole-turn decision, made once before the model call starts — every
 * fact has to read clean, because any one of them is a downstream pass that may still rewrite or
 * discard the draft this gate is about to let out early.
 */
export function streamArmed(f: PreCallFacts): boolean {
  return f.enabled
    && !f.hasParkedApproval
    && f.hookMode !== 'quiet'
    && !f.groundingFlagged
    && !f.isGroupChat
    && !f.introOrFirstMove
    && !f.isBurst;
}

/**
 * Stateless per-sentence scans: may THIS sentence, already out of the model, go out early? Returns
 * the reason it must NOT (the same shape the send path's own downstream guards would have caught it
 * under), or `null` when it's clean.
 *
 * Checked in the same order the honesty backstop runs its own two detectors (convo/shared.ts's
 * `enforcePromiseKept`, promise before claim), then the refusal floor, then the internal-leak
 * tripwires — cheapest and most likely first, though the checks are independent and a sentence can
 * only ever carry one of these at a time in practice.
 */
export function sentenceBlocker(
  text: string,
  ask: string,
  // A share or idle turn asked for nothing, so a bare completion word there is about their day, the
  // same reading the whole-reply guard gives it (unkeptPromise.ts BARE_CLAIM_PHRASES). Default: a
  // task turn, the whole lexicon.
  taskTurn = true,
): 'promise' | 'claim' | 'refusal' | 'internal' | null {
  // A promise ("lemme check that") with nothing behind it — no tool call and no active run — reads
  // one sentence early exactly the way it would read as a whole reply: it can't be backed by a call
  // that hasn't happened yet, because the envelope carrying the tool call hasn't finished streaming.
  if (detectUnkeptPromise([text], null, 0).unkept) return 'promise';
  // A claim of a change ("revised it") is judged the same way: no mutating call and nothing an
  // earlier pass of this turn already backed it with, both of which are true by construction — the
  // envelope this sentence is streaming out of hasn't run anything yet either.
  if (detectUnbackedClaim([text], [], false, { taskTurn }).unbacked) return 'claim';
  // The false-refusal floor's own subject map, read against this one sentence and the user's ask —
  // the same signature the whole-reply floor uses (routingGate.ts:283).
  if (refusedCapabilities(text, ask).length > 0) return 'refusal';
  // An internal-machinery leak or raw Ops scaffolding: block whenever either scrub would actually
  // CHANGE the text, which is the same "did it fire" test each scrub's own doc comment describes.
  if (redactInternalTools(text) !== text || stripOpsScaffolding(text) !== text) return 'internal';
  return null;
}

/**
 * The same per-bubble cleanup `sendBubbles` (index.ts) applies to every outbound bubble, run over a
 * single early sentence: strip a leaked `[[re:N]]` routing tag, strip a leaked echoed timestamp
 * marker, then the two scrubs `sentenceBlocker` above already checked for a CHANGE (here they're
 * applied, not just probed). Byte-identical to the normal send path by construction — both call the
 * same four functions in the same order — which is the whole point: an early sentence and its later,
 * normally-sent siblings must read as one voice, not two cleanup paths that can drift apart.
 */
export function cleanEarlySentence(text: string): string {
  const stripped = stripReplyTag(text);
  const unstamped = stripTimestampMarker(stripped);
  return stripOpsScaffolding(redactInternalTools(unstamped));
}

// ── after the envelope completes ────────────────────────────────────────────────────────────────
// Two readers need the same answer to "which part of the final reply is already on their screen":
// the send boundary (index.ts), which must send only what is left, and the history write
// (convo/shared.ts), which must record what they actually saw. One comparison for both, so the
// transcript and the screen can never disagree about a bubble.

/** The comparison space: trimmed, whitespace collapsed, lowercased. Nothing stronger, on purpose — a
 *  looser match would call a genuinely different sentence "already sent" and swallow it. */
function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A bubble with its closing run of marks (and a stray quote) gone: the words the stream already
 *  sent when the model typed the run after the string had closed. */
function bare(s: string): string {
  return s.replace(/["'.!?…]+$/u, '');
}

/**
 * The raw text of `bubble` after its first `n` normalized characters, when that cut lands on a word
 * boundary; null when it would land inside a word (that is a different sentence, not a longer one).
 * Walks raw prefixes rather than mapping indexes, because lowercasing can change a string's length
 * and a bubble is at most a few dozen words.
 */
function cutAfterNormalized(bubble: string, target: string): string | null {
  for (let k = 1; k <= bubble.length; k++) {
    if (norm(bubble.slice(0, k)) !== target) continue;
    if (k < bubble.length && !/\s/.test(bubble[k])) return null;
    return bubble.slice(k).trim();
  }
  return null;
}

/**
 * What of `finalBubbles` is still to send, given the sentences that already went out early
 * (`prefix`, in the order they were sent). PURE.
 *
 * When the final reply starts with the prefix (the common case: nothing rewrote the draft), `rest`
 * is exactly what follows it and `diverged` is false. The prefix is consumed across whole bubbles
 * first; where it ends partway into one (the stream closed a sentence the bubble splitter kept
 * together), the rest of that bubble is re-split with the send path's own splitter, so it goes out
 * shaped the way any bubble would.
 *
 * When it does not (a guard replaced the reply after the first sentence went out), `diverged` is true
 * and `rest` is every final bubble except one that equals an emitted sentence: the replacement is
 * told what is already on their screen, and this is the backstop for when it retypes a line of it
 * anyway. A bubble is only ever dropped for being identical to one they already have.
 */
export function remainderAfterPrefix(finalBubbles: string[], prefix: string[]): { rest: string[]; diverged: boolean } {
  if (prefix.length === 0) return { rest: [...finalBubbles], diverged: false };
  let remaining = norm(prefix.join(' '));
  for (let i = 0; i < finalBubbles.length; i++) {
    if (!remaining) return { rest: finalBubbles.slice(i), diverged: false };
    const nb = norm(finalBubbles[i]);
    if (!nb) continue;
    if (remaining === nb || remaining.startsWith(`${nb} `)) {
      remaining = remaining.slice(nb.length).trimStart();
      continue;
    }
    // Only a closing run of marks is new: the words are on their screen, and a run alone is no bubble.
    if (bare(nb) && remaining === bare(nb)) { remaining = ''; continue; }
    if (nb.startsWith(`${remaining} `)) {
      const tail = cutAfterNormalized(finalBubbles[i], remaining);
      if (tail !== null) {
        return { rest: [...splitIntoBubblesWithSplits(tail).bubbles, ...finalBubbles.slice(i + 1)], diverged: false };
      }
    }
    break;
  }
  if (!remaining) return { rest: [], diverged: false };
  const sent = new Set(prefix.map(norm));
  return { rest: finalBubbles.filter(b => !sent.has(norm(b))), diverged: true };
}

/** A reply as the send path will deliver it: split by the send law, each bubble through the same
 *  per-bubble cleanup, the ones that clean to nothing dropped. Exported because the send boundary
 *  (index.ts) cuts its remainder against the same shapes. */
export function cleanBubbles(text: string): string[] {
  return splitIntoBubbles(text).map(cleanEarlySentence).filter(Boolean);
}

/**
 * The final reply of a turn that sent part of itself early, settled against what is already on their
 * screen (`onScreen`, the sentences that went out, in order). PURE. Returns the text still to hand to
 * the send path and the text the assistant history row records.
 *
 *   • The reply still starts with what went out: it ships whole (the send boundary cuts the prefix
 *     off itself, with the same comparison) and is recorded whole, which is what they will have read.
 *   • It was replaced: any bubble identical to one they already have is dropped, and the record leads
 *     with what went out, so the transcript she reads next turn matches their screen instead of a
 *     reply that never arrived in that shape. Nothing is cut off the front of a bubble that merely
 *     starts with the same letters: stripEchoedHolding compares with the punctuation and spaces gone,
 *     so on-screen "ok." would take "ok" off "okay, one sec" and ship "ay, one sec". A bubble is
 *     only ever dropped whole, for being the same bubble.
 *
 * Both sides are compared in the send path's own bubble shapes AND after its own per-bubble cleanup
 * (cleanEarlySentence is the same four steps sendBubbles runs), because the sentence that went early
 * was cleaned on its way out: a final bubble that still carries an echoed `[9:14 AM]` marker is the
 * same line on their screen, and reading it as a different one would send it twice.
 *   • Nothing is left to ship: the record is what went out alone. They were not left on read.
 */
export function settleOnScreen(onScreen: readonly string[], finalText: string | null): { text: string | null; record: string | null } {
  const shown = onScreen.join('\n---\n');
  if (!onScreen.length) return { text: finalText, record: finalText };
  if (!finalText || !finalText.trim()) return { text: null, record: shown };
  const shownBubbles = cleanBubbles(onScreen.join('\n'));
  const { rest, diverged } = remainderAfterPrefix(cleanBubbles(finalText), shownBubbles);
  if (!diverged) return { text: finalText, record: finalText };
  const text = rest.length ? rest.join('\n---\n') : null;
  return { text, record: text ? `${shown}\n---\n${text}` : shown };
}
