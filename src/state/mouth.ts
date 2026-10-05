// The mouth — the one pipeline every out-of-band user-facing message speaks through, built on the
// per-chat send lock (sendQueue.ts). It exists to kill a whole class of race conditions: a message
// VOICED against the thread as it looked seconds ago, LANDING after the thread has moved on.
//
// The invariant it enforces, per chat: voice → send → record is ONE atomic critical section. A
// voicer (a thunk that reads conversation history and calls a model) runs only once it owns the
// mouth — at which point every previously-queued outbound has been fully sent AND recorded, and
// nothing else can send until this one finishes. So whatever a voicer reads is, by construction,
// exactly the thread the user will see its reply land on. No snapshot can go stale between voicing
// and sending, because nothing can move the thread in that window.
//
// For content that must be voiced EARLY (progress pings reserve their throttle slot before the slow
// voice call), the mouth instead offers staleness guards re-checked the moment the send owns the
// lock: `dropIf` (arbitrary sync predicate — "the answer already shipped", "the user cancelled")
// and `staleIfSpokenSince` (Irises said something in this chat after the text was voiced). A stale
// message is DROPPED, never sent — a late "still on it" after the answer is a contradiction, and
// silence is the correct fallback for a reassurance.
//
// `priority: 'critical'` (suspected fraud) bypasses the lock entirely — the one deliberate
// exception, where interleaving a live reply is better than delaying an emergency.
import { withChatLock } from './sendQueue.js';
import { withDeadline, DeadlineError } from '../agents/deadline.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { ReplyTo } from '../webhook/types.js';

/** Static text, or a voicer thunk run INSIDE the chat lock (fresh-history guarantee). A thunk
 *  returning null/empty means "nothing to say after all" — the send is dropped silently. */
export type SpeakContent = string | (() => Promise<string | null>);

export interface SpeakOpts {
  record?: boolean;               // append to history after sending (default true, via sendBubbles)
  replyTo?: ReplyTo;              // native-quote target for the first bubble
  priority?: 'critical';          // bypass the lock + pacing (fraud alerts only — documented tradeoff)
  paced?: boolean;                // simulate typing between bubbles (default true); pings pass false
  /** Re-checked inside the lock BEFORE voicing and again right before the send: true → drop. */
  dropIf?: () => boolean;
  /** App-clock instant (Date.now) the content was voiced. If Irises has spoken in this chat since,
   *  the content was voiced blind to that message — drop it rather than land it stale. */
  staleIfSpokenSince?: number;
  /** Code-written text that has to reach them exactly as written (a command they are asked to OK):
   *  split at newlines only, and none of the reply cleanup touches a line (markdown, dashes, spacing,
   *  sentence splits, scaffold labels). Everything about the send itself is unchanged. */
  verbatim?: true;
}

export type SpeakResult = 'sent' | 'dropped';

export interface MouthDeps {
  /** The raw bubble sender (index.ts sendBubbles): splits nothing, paces, sends, records. */
  sendBubbles: (chatId: string, bubbles: string[], opts: { record?: boolean; replyToFirst?: ReplyTo; paced?: boolean; verbatim?: boolean }) => Promise<void>;
  splitIntoBubbles: (text: string) => string[];
  /** When Irises last spoke in this chat (app clock), for the staleIfSpokenSince guard. */
  lastSpokenAt: (chatId: string) => number | undefined;
  /** Ceiling on one voicer thunk. Without it a hung model call inside the lock would wedge the
   *  chat's mouth shut — every later reply (including live turns) queues behind it forever. The
   *  deadline REJECTS (DeadlineError) so the caller's existing failure path voices the snag. */
  voiceTimeoutMs?: number;
  /** Optional: hold the typing indicator alive while a voicer thunk composes, so the user sees
   *  "typing…" instead of dead air between owning the mouth and the first bubble. Must release on
   *  settle AND on rejection (index.ts withTypingKeptAlive does). Not used for pre-voiced text. */
  keepTypingAlive?: <T>(chatId: string, work: Promise<T>) => Promise<T>;
}

const DEFAULT_VOICE_TIMEOUT_MS = 120_000;

export function createMouth(deps: MouthDeps) {
  const voiceTimeoutMs = deps.voiceTimeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;

  return async function speak(chatId: string, content: SpeakContent, opts: SpeakOpts = {}): Promise<SpeakResult> {
    const stale = (): boolean => {
      if (opts.dropIf?.()) return true;
      if (opts.staleIfSpokenSince != null && (deps.lastSpokenAt(chatId) ?? 0) > opts.staleIfSpokenSince) return true;
      return false;
    };

    const deliver = async (): Promise<SpeakResult> => {
      if (stale()) return 'dropped';
      let text: string | null;
      if (typeof content === 'function') {
        // Deadline INSIDE the typing wrapper: on a timeout the wrapper's finally clears the dots
        // even though the abandoned thunk may never settle — dots must never outlive the delivery.
        const voiced = withDeadline(content(), voiceTimeoutMs, `follow-up voice for ${chatId}`);
        try {
          text = await (deps.keepTypingAlive ? deps.keepTypingAlive(chatId, voiced) : voiced);
        } catch (err) {
          // Re-thrown unchanged — the caller's failure path voices the snag. The report exists
          // because a voicer that hangs past the deadline holds the chat's mouth for the whole
          // window, and today that shows up only as the user's missing follow-up.
          if (err instanceof DeadlineError) {
            reportError({
              source: 'pipeline', category: 'timeout', severity: 'warn',
              message: 'follow-up voicing timed out', detail: { timeoutMs: voiceTimeoutMs }, chatId,
            });
          }
          throw err;
        }
      } else {
        text = content;
      }
      if (!text || !text.trim()) return 'dropped';
      // The voice call was the slow part — a cancel/settle can have landed during it (dropIf), and
      // for pre-voiced content this is the moment the staleness guard actually binds.
      if (stale()) return 'dropped';
      const bubbles = opts.verbatim ? text.split('\n').filter(line => line.trim()) : deps.splitIntoBubbles(text);
      await deps.sendBubbles(chatId, bubbles, {
        record: opts.record,
        replyToFirst: opts.replyTo,
        paced: opts.paced !== false && opts.priority !== 'critical',
        ...(opts.verbatim ? { verbatim: true } : {}),
      });
      return 'sent';
    };

    // Critical = the documented emergency lane: skip the queue AND the pacing. Everything else
    // owns the mouth first, so bubbles from two messages can never interleave.
    if (opts.priority === 'critical') return deliver();
    return withChatLock(chatId, deliver);
  };
}
