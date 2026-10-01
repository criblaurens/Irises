import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';

// The bubbles Irises took back (state/unsend.ts). A handful of rows a year at most, so no sweep:
// the newest row per chat is the unsend cooldown, and the rest is the record of what she retracted.

/** Remember one bubble she unsent. Fire-and-forget; never throws. */
export function recordUnsent(chatId: string, messageId: string, content: string, why: string, at: number = Date.now()): void {
  try {
    stmt(
      `INSERT INTO unsent_messages (message_id, chat_id, content, why, unsent_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO NOTHING`
    ).run(messageId, chatId, content, why, at);
  } catch (error) {
    logDbError('recordUnsent', error);
  }
}

/** When she last unsent anything in this chat (epoch ms), or 0 for never. A read error reads as
 *  "just now", which closes the cooldown: an unreadable store must never open the door wider. */
export function lastUnsentAt(chatId: string): number {
  try {
    const row = stmt('SELECT MAX(unsent_at) AS at FROM unsent_messages WHERE chat_id = ?').get(chatId) as { at: number | null } | undefined;
    return row?.at ?? 0;
  } catch (error) {
    logDbError('lastUnsentAt', error);
    return Date.now();
  }
}
