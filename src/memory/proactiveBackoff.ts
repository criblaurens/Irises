// When she stops texting first. The two sweeps that start conversations on her own (threadPings.ts,
// musings.ts) read this before they send.
//
// Nothing is counted on a counter: "ignored" is read off the delivery log at gate time, as her own
// texts delivered after their last message (db/repositories/proactive.ts unansweredProactiveKinds).
// Any text from them, about anything, is an answer, so the count resets by construction.
//
//   • fewer than BACKOFF_IGNORED_LIMIT unanswered → 'ok', she texts as she always has;
//   • BACKOFF_IGNORED_LIMIT unanswered → 'checkin', the next slot asks once whether they still want
//     her texting first (the ping sweep sends it);
//   • an unanswered check-in in the stack → 'silent' until they write;
//   • they said no (pref texts_first=false, written by set_preference) → 'silent' for good, until
//     they say otherwise.
// Only her own kinds are ever held. Reminders, mail and memos they set up never pass through here.

import { getPreference } from '../db/repositories/memory.js';
import { unansweredProactiveKinds } from '../db/repositories/proactive.js';

export const BACKOFF_IGNORED_LIMIT = 3;
export const TEXTS_FIRST_KEY = 'texts_first';

export type BackoffState = 'ok' | 'checkin' | 'silent';

/** Pure: the gate's verdict from the unanswered stack and the opt-out. */
export function backoffState(unanswered: readonly string[], optedOut: boolean): BackoffState {
  if (optedOut) return 'silent';
  if (unanswered.includes('checkin')) return 'silent';
  return unanswered.length >= BACKOFF_IGNORED_LIMIT ? 'checkin' : 'ok';
}

/** Pure: a stored `texts_first` reads as an opt-out when it is false, or a word a model writes for
 *  false. Anything else, including no value, leaves her texting first. */
export function optedOutOfTextingFirst(value: unknown): boolean {
  if (value === false) return true;
  return typeof value === 'string' && ['false', 'off', 'no'].includes(value.trim().toLowerCase());
}

/** The gate for one 1:1 chat and the person in it. */
export async function readBackoff(chatId: string, handle: string): Promise<BackoffState> {
  const optedOut = optedOutOfTextingFirst(await getPreference<unknown>(handle, TEXTS_FIRST_KEY));
  if (optedOut) return 'silent';
  return backoffState(await unansweredProactiveKinds(chatId), false);
}
