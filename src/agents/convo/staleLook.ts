// The stale-look guard: a delegation that re-runs a look already delivered, when their message never
// named it.
//
// Observed live (local, 2026-10-04). Six hours after a delivered look on solo GitHub commit counts,
// they asked how to become president of Indonesia, she answered from her head, and they wrote "no i
// mean, search them on google". The draft delegated the commit-count look again. Their earlier
// message about commits had opened with the same words, and the fast tier bound "them" to that echo
// rather than to the question right before it. Replayed against the logged prompt, edge-of-prompt
// wording did not move it (3 of 8 wrong before, still about half wrong with a rule, a sitting line,
// or their previous message restated). What did move it is code noticing the shape after the draft:
// the subject is a delivered look, and their message names nothing of it. Shown that, the re-ask
// picked the question they meant in 10 of 12 replays and asked in the other 2.
//
// PURE: the verdict and the note. The one corrective re-ask lives in the call path (convo/shared.ts,
// beside the unkept-promise guard it mirrors) — only that has a model to re-ask.

import type { LlmToolCall } from '../../llm/types.js';
import type { ShortTermEntry } from '../../db/repositories/memoryShort.js';
import { salientTokens } from '../../memory/topicality.js';

/** How many topic words a new brief must share with a delivered ask to count as the same look. Two,
 *  because one shared word is how unrelated asks about the same country or tool look alike. */
export const STALE_LOOK_MIN_SHARED = 2;

/** The delivered look a draft is about to run again, and the brief it would run. */
export interface StaleLook {
  entry: ShortTermEntry;
  request: string;
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * The first delegate_to_ops call in the draft whose brief is a look already delivered in this chat,
 * while their message shares no topic word with that look's ask. Null when nothing matches.
 *
 * Matched on the ASK (`request`), never the result body or the topic key: the body shares words with
 * half the language, and every topic key carries its kind prefix, which would make every look match
 * every other look of the same kind.
 *
 * A message with no topic words at all names nothing, so it does not clear the look. That is the case
 * this guard is for: a bare nudge to go look carries no subject of its own.
 */
export function detectStaleLook(
  toolCalls: readonly LlmToolCall[],
  delivered: readonly ShortTermEntry[],
  turnText: string,
): StaleLook | null {
  const looks = delivered.filter(e => e.kind === 'ops_research' && (e.request ?? '').trim());
  if (!looks.length) return null;
  const turn = salientTokens(turnText);
  for (const call of toolCalls) {
    if (call.name !== 'delegate_to_ops') continue;
    const request = String((call.input as { request?: unknown } | undefined)?.request ?? '').trim();
    if (!request) continue;
    const brief = salientTokens(request);
    for (const entry of looks) {
      const ask = salientTokens(entry.request ?? '');
      if (shared(brief, ask) < STALE_LOOK_MIN_SHARED) continue;
      if (shared(turn, ask) > 0) continue;
      return { entry, request };
    }
  }
  return null;
}

/**
 * The system-authored correction. States the facts code is sure of (the look was delivered, how long
 * ago, what was asked, that their message names none of it) and the principle that decides the case,
 * then hands the call back to her. It never names the subject it thinks they meant: that guess is
 * exactly what the draft got wrong, and the re-ask has the whole thread to make it again.
 */
export function renderStaleLookCorrection(look: StaleLook, ago: string): string {
  const asked = (look.entry.request ?? '').replace(/\s+/g, ' ').trim();
  return [
    '[system note, not from them] Nothing was sent and nothing started.',
    `That look-up repeats one you already ran and delivered ${ago} ago ("${asked}"), and their newest message names nothing from it.`,
    'A delivered look is settled ground. A message that asks you to go look without naming a subject points at what the conversation was on right before it, so read their newest message against that last exchange and reply again with what it actually asks for.',
    'Run the same look again only if their message truly asks for it.',
  ].join(' ');
}
