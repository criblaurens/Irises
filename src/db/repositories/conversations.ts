import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { archiveEntries } from './memoryArchive.js';
import type { StoredMessage } from '../types.js';

export type { StoredMessage } from '../types.js';

// Conversation history retention. Bumped 1h → 24h → 7d: a week gives deal-relevant facts a wide
// window to be extracted into the memory tiers, and the read cap below — not this window — is what
// bounds the cost of a turn.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// How many of a chat's newest messages getConversation hands back. This IS the live context
// window for a Convo turn: the front-line client sends every row it gets (agents/convo/client.ts
// → formatHistory), so the number below is the transcript the model reads. The other readers
// narrow it further for their own purpose (the Composer takes the last 10, the group-chat
// classifier the last 4), which is why this is a cap and not a target.
const DEFAULT_CONVO_HISTORY_MAX = 40;

/**
 * The read cap, from `CONVO_HISTORY_MAX` (default 40 — unset is exactly the window this has always
 * had). Read at CALL time, not module load, so a test or a live retune takes effect without a
 * restart. A value that isn't a positive whole number is not a window size: fall back to the
 * default rather than reading zero rows or letting a stray string reach the query.
 */
export function convoHistoryMax(): number {
  const raw = (process.env.CONVO_HISTORY_MAX || '').trim();
  if (!raw) return DEFAULT_CONVO_HISTORY_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONVO_HISTORY_MAX;
  return Math.floor(n);
}

// The granularity the read window's START moves in. A plain last-N window slides its first row by
// one on every single turn once a chat outgrows the cap, which means the system-prompt-then-history
// prefix OpenRouter would otherwise cache never repeats byte-for-byte two turns running — the whole
// point of the byte-stable system message ahead of it is wasted. Moving the start in whole chunks
// instead means the first row (and everything after it, up to the next chunk boundary) stays fixed
// across a run of turns, so the shared prefix actually hits cache.
const DEFAULT_CONVO_HISTORY_TRIM_CHUNK = 20;

/** Same call-time-read, sanitize-or-default contract as convoHistoryMax, for the chunk size. */
export function convoHistoryTrimChunk(): number {
  const raw = (process.env.CONVO_HISTORY_TRIM_CHUNK || '').trim();
  if (!raw) return DEFAULT_CONVO_HISTORY_TRIM_CHUNK;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONVO_HISTORY_TRIM_CHUNK;
  return Math.floor(n);
}

/**
 * The index (0-based, oldest-first) of the first history row to include, given `total` rows on
 * hand and a `max`-row cap. Below the cap every row is in view, so the start is always 0 — nothing
 * to trim yet, nothing to chunk. Past the cap, a plain "keep the newest max" window would move its
 * start by one row every single turn; this instead advances it in whole `chunk`-sized steps, so the
 * start (and the shared prefix built on top of it) stays put between jumps. `chunk` is clamped to
 * `[1, max]` — a chunk of 0 would divide by zero, and a chunk wider than the whole cap would just be
 * the cap.
 */
export function historyWindowStart(total: number, max: number, chunk: number): number {
  if (total <= max) return 0;
  const c = Math.min(Math.max(Math.floor(chunk), 1), max);
  return Math.ceil((total - max) / c) * c;
}

type MessageRow = { role: 'user' | 'assistant'; content: string; handle: string | null; created_at: number };

export async function getConversation(chatId: string): Promise<StoredMessage[]> {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    const max = convoHistoryMax();
    // Count first so the window's start can be computed in whole chunks (historyWindowStart)
    // instead of always taking the newest `max` rows — a plain "newest N" LIMIT slides its first
    // row by one every turn, which is exactly the un-cacheable prefix this chunking exists to fix.
    const { total } = stmt(
      `SELECT COUNT(*) AS total FROM messages WHERE chat_id = ? AND created_at > ?`
    ).get(chatId, cutoff) as unknown as { total: number };
    const start = historyWindowStart(total, max, convoHistoryTrimChunk());
    // Ascending order straight from the chunk boundary: OFFSET/LIMIT are BOUND, not interpolated,
    // same rule as the old LIMIT-only query. id breaks same-millisecond ties in true insertion
    // order, so no reverse() is needed the way the old DESC-then-reverse query needed one.
    const rows = stmt(
      `SELECT role, content, handle, created_at FROM messages
       WHERE chat_id = ? AND created_at > ?
       ORDER BY created_at ASC, id ASC
       LIMIT ? OFFSET ?`
    ).all(chatId, cutoff, total - start, start) as unknown as MessageRow[];
    return rows.map(r => ({
      role: r.role,
      content: r.content,
      ...(r.handle ? { handle: r.handle } : {}),
      at: r.created_at,
    }));
  } catch (error) {
    logDbError('getConversation', error);
    return [];
  }
}

/**
 * Append a message and return the canonical stored timestamp (epoch ms, app clock —
 * single-host storage means one clock everywhere). Callers that need to know "what did
 * the user say AFTER this point" stamp it from this return value.
 */
export async function addMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  handle?: string,
): Promise<number> {
  const at = Date.now();
  try {
    stmt(
      'INSERT INTO messages (chat_id, role, content, handle, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(chatId, role, content, handle ?? null, at);
  } catch (error) {
    logDbError('addMessage', error);
  }
  // Keep the chat bounded even if the retention timer dies: prune this chat's rows past the
  // window (the newest-N read cap, convoHistoryMax, is applied on read). Goes through
  // pruneMessagesBefore so the inline prune archives exactly like the daily sweep does — a bare
  // DELETE here was silently destroying a week of conversation the archive never saw.
  await pruneMessagesBefore(at - RETENTION_MS, chatId);
  return at;
}

/**
 * Take back one row addMessage wrote, matched on everything that identifies it (addMessage returned
 * `at`). For a turn that never happened: a reply replaced by a newer text before any of it was real
 * (state/liveTurn.ts), or a stopped one nothing of which went out. Not archived — nothing was said. Best-effort like every other repository call.
 */
export async function removeMessage(chatId: string, role: 'user' | 'assistant', content: string, at: number): Promise<void> {
  try {
    stmt('DELETE FROM messages WHERE chat_id = ? AND role = ? AND content = ? AND created_at = ?')
      .run(chatId, role, content, at);
  } catch (error) {
    logDbError('removeMessage', error);
  }
}

/** Rewrite one row addMessage wrote, matched the same way: a reply cut short by a newer text keeps
 *  only what reached their screen (state/liveTurn.ts). Best-effort. */
export async function replaceMessage(chatId: string, role: 'user' | 'assistant', content: string, at: number, next: string): Promise<void> {
  try {
    stmt('UPDATE messages SET content = ? WHERE chat_id = ? AND role = ? AND content = ? AND created_at = ?')
      .run(next, chatId, role, content, at);
  } catch (error) {
    logDbError('replaceMessage', error);
  }
}

/**
 * Hard-delete messages older than `cutoffMs` (optionally in one chat), archiving each one
 * first. Both prune paths — the daily retention sweep and addMessage's inline
 * keep-it-bounded prune — call this, so conversation history always leaves a searchable trace.
 * Returns the number of rows deleted; best-effort like every other repository call.
 *
 * NOT archived alongside it: sent_messages / inbound_messages (their content duplicates these
 * rows — they are reply-threading indexes, not memories) and /clear (clearConversation), where
 * the user explicitly asked for a fresh start and a cold copy would be a leak.
 */
export async function pruneMessagesBefore(cutoffMs: number, chatId?: string): Promise<number> {
  try {
    const where = chatId ? 'chat_id = ? AND created_at <= ?' : 'created_at <= ?';
    const params: Array<string | number> = chatId ? [chatId, cutoffMs] : [cutoffMs];
    const rows = stmt(
      `SELECT chat_id, role, content, handle, created_at FROM messages WHERE ${where}`
    ).all(...params) as unknown as Array<MessageRow & { chat_id: string }>;
    if (rows.length) {
      const archived = await archiveEntries(rows.map(r => ({
        source: 'message_pruned' as const,
        agentHandle: r.handle ?? undefined,
        chatId: r.chat_id,
        kind: 'message',
        content: r.content,
        meta: { role: r.role },
        createdAt: r.created_at,
      })));
      // The archive is the only copy a pruned message keeps. A row it could not take stays here.
      if (!archived) {
        console.warn('[db] message prune skipped — the archive did not take every row, so none were deleted');
        return 0;
      }
    }
    return Number(stmt(`DELETE FROM messages WHERE ${where}`).run(...params).changes);
  } catch (error) {
    logDbError('pruneMessagesBefore', error);
    return 0;
  }
}

/**
 * Has this chat EVER exchanged a message? No time window on purpose: the caller is the contact-card
 * gate, and "we have talked before" doesn't expire the way conversation context does — a chat that
 * went quiet for a month is still not a first hello. The in-memory turn counter it replaces reset on
 * every restart, so a redeploy re-introduced Irises to everyone who texted next.
 *
 * Fails SOFT as `true` ("we've met"): a DB glitch must never spam the card into a live conversation.
 */
export async function hasHistory(chatId: string): Promise<boolean> {
  try {
    const row = stmt('SELECT 1 AS present FROM messages WHERE chat_id = ? LIMIT 1').get(chatId) as { present?: number } | undefined;
    return row != null;
  } catch (error) {
    logDbError('hasHistory', error);
    return true;
  }
}

/**
 * Distinct chats with any message newer than `sinceMs`, most-recent first — the audience for a
 * proactive update announcement. Reuses idx_messages_chat_created; the 7d message window keeps the
 * scan small. Returns [] on any error (same fail-soft contract as getConversation).
 */
export async function listActiveChats(sinceMs: number, limit = 20): Promise<{ chatId: string; lastAt: number }[]> {
  try {
    const rows = stmt(
      `SELECT chat_id AS chatId, MAX(created_at) AS lastAt FROM messages
       WHERE created_at > ?
       GROUP BY chat_id
       ORDER BY lastAt DESC
       LIMIT ?`
    ).all(sinceMs, limit) as unknown as { chatId: string; lastAt: number }[];
    return rows;
  } catch (error) {
    logDbError('listActiveChats', error);
    return [];
  }
}

/**
 * Distinct handles that have SPOKEN in this chat (user rows carry the sender's handle), newest
 * first. The proactive pipeline's identity resolver reads this: exactly one handle means a 1:1 chat
 * whose personal memory is safe to load, more than one means a room that must fall back to the
 * group pseudo-handle. `limit` is small on purpose — "one or many" is the only question asked.
 * Returns [] on any error (same fail-soft contract as getConversation).
 */
export async function distinctUserHandles(chatId: string, limit = 3): Promise<string[]> {
  try {
    const rows = stmt(
      `SELECT handle, MAX(created_at) AS lastAt FROM messages
       WHERE chat_id = ? AND role = 'user' AND handle IS NOT NULL AND handle <> ''
       GROUP BY handle
       ORDER BY lastAt DESC
       LIMIT ?`
    ).all(chatId, limit) as unknown as { handle: string; lastAt: number }[];
    return rows.map(r => r.handle);
  } catch (error) {
    logDbError('distinctUserHandles', error);
    return [];
  }
}

/** /clear — a TRUE delete, never archived: they asked for a fresh start, and a cold copy of the
 *  thread they just wiped would hand it straight back through recall. */
export async function clearConversation(chatId: string): Promise<void> {
  try {
    stmt('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  } catch (error) {
    logDbError('clearConversation', error);
  }
}
