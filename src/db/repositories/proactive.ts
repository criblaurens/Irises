// The durable half of proactive delivery: one row per message Irises decided to start a thread
// with. Three jobs, none of which survive a restart in memory:
//
//   • IDEMPOTENCY — the engine's cron retries a push it thinks failed (our 202 fires before the
//     voicing), so the same reminder can arrive two or three times. hasRecentDelivery() over a
//     dedupe key is what makes the second arrival a no-op.
//   • DEFERRAL — a quiet-hours push is parked with deliver_after set and swept when morning
//     actually comes, instead of being held in a timer that a restart forgets.
//   • RECOVERY — a row inserted just before the process died is still pending, so the sweep
//     delivers it late rather than losing it.
//
// Failure policy mirrors memoryShort.ts: BEST-EFFORT with one retry, then a loud log. A lost row
// degrades to "this push isn't deduped / isn't recoverable", which is annoying; it must never take
// down a delivery or a boot.

import { randomUUID } from 'node:crypto';
import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';

export type ProactiveStatus = 'pending' | 'delivered' | 'failed';

export interface ProactiveDeliveryRow {
  id: string;
  chatId: string;
  kind: string;
  text: string;
  meta: Record<string, unknown>;
  dedupeKey: string;
  status: ProactiveStatus;
  deliverAfter: number | null;
  createdAt: number;
  deliveredAt: number | null;
}

/** Rows deleted this long after they settled (delivered/failed only). */
export const PROACTIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Settled REMINDER rows live longer: they are the history a recurring reminder is voiced against
 *  (what the user already heard), and a weekly or monthly job needs its previous run still here. */
export const PROACTIVE_REMINDER_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
/** How long an immediate-path row may sit pending before the sweep treats it as crash debris.
 *  Comfortably past the mouth's voice timeout, so a live send is never swept out from under itself. */
export const PROACTIVE_STUCK_GRACE_MS = Number(process.env.PROACTIVE_STUCK_GRACE_MS || 5 * 60_000);

interface Row {
  id: string;
  chat_id: string;
  kind: string;
  text: string;
  meta_json: string;
  dedupe_key: string;
  status: string;
  deliver_after: number | null;
  created_at: number;
  delivered_at: number | null;
}

function fromRow(r: Row): ProactiveDeliveryRow {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(r.meta_json) as Record<string, unknown>; } catch { /* unparseable → {} */ }
  return {
    id: r.id,
    chatId: r.chat_id,
    kind: r.kind,
    text: r.text,
    meta,
    dedupeKey: r.dedupe_key,
    status: r.status as ProactiveStatus,
    deliverAfter: r.deliver_after,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  };
}

/**
 * Has this dedupe key already been taken since `sinceMs`? Counts pending and delivered rows only:
 * a FAILED attempt must never block the retry that recovers it. Reads degrade to false — the cost
 * of a missed dedupe (one repeat text) is smaller than the cost of swallowing a real delivery.
 */
export async function hasRecentDelivery(dedupeKey: string, sinceMs: number): Promise<boolean> {
  try {
    const row = stmt(
      `SELECT 1 AS hit FROM proactive_deliveries
       WHERE dedupe_key = ? AND created_at > ? AND status IN ('pending','delivered')
       LIMIT 1`
    ).get(dedupeKey, sinceMs) as { hit: number } | undefined;
    return !!row;
  } catch (error) {
    logDbError('hasRecentDelivery', error);
    return false;
  }
}

/** Claim a delivery: the row goes in as `pending` and the caller drives it to delivered/failed.
 *  Returns the row id — also the addShortTerm taskId for the email side effect, so a retried
 *  delivery can't write a second flag. A lost write still returns an id (delivery proceeds
 *  undeduped rather than not at all). */
export async function insertPending(e: {
  chatId: string;
  kind: string;
  text: string;
  dedupeKey: string;
  meta?: Record<string, unknown>;
  deliverAfter?: number | null;
}): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      stmt(
        `INSERT INTO proactive_deliveries
           (id, chat_id, kind, text, meta_json, dedupe_key, status, deliver_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(id, e.chatId, e.kind, e.text, JSON.stringify(e.meta ?? {}), e.dedupeKey, e.deliverAfter ?? null, now);
      return id;
    } catch (error) {
      if (attempt === 0) logDbError('proactive insert failed, retrying once', error);
      else console.error(`[proactive] DURABLE WRITE LOST for ${e.chatId}/${e.kind} — this delivery is not deduped or recoverable`, error);
    }
  }
  return id;
}

function settle(id: string, status: Exclude<ProactiveStatus, 'pending'>): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      stmt('UPDATE proactive_deliveries SET status = ?, delivered_at = ? WHERE id = ?')
        .run(status, Date.now(), id);
      return;
    } catch (error) {
      if (attempt === 0) logDbError(`proactive ${status} write failed, retrying once`, error);
      else console.error(`[proactive] could not mark ${id} ${status} — the sweep may retry this delivery`, error);
    }
  }
}

export async function markDelivered(id: string): Promise<void> {
  settle(id, 'delivered');
}

/** A failed row stays visible for diagnostics but is EXCLUDED from dedupe, so the next arrival of
 *  the same message is delivered rather than swallowed. */
export async function markFailed(id: string): Promise<void> {
  settle(id, 'failed');
}

/** A send the mouth deliberately dropped (staleness, or an empty voicing). Final like a delivery,
 *  so it is never retried, but flagged: nobody saw it, so it must never count as a text they ignored
 *  (memory/proactiveBackoff.ts). */
export async function markDropped(id: string): Promise<void> {
  try {
    stmt(
      `UPDATE proactive_deliveries SET status = 'delivered', delivered_at = ?, meta_json = json_set(meta_json, '$.dropped', 1) WHERE id = ?`
    ).run(Date.now(), id);
  } catch (error) {
    logDbError('markDropped', error);
    settle(id, 'delivered');
  }
}

/**
 * Pending rows whose moment has come, oldest first: a deferred row at its deliver_after, or an
 * immediate row left pending past the stuck grace (a crash mid-send). Reads degrade to [].
 */
export async function listDue(nowMs: number, limit = 20): Promise<ProactiveDeliveryRow[]> {
  try {
    const rows = stmt(
      `SELECT * FROM proactive_deliveries
       WHERE status = 'pending'
         AND ((deliver_after IS NOT NULL AND deliver_after <= ?)
           OR (deliver_after IS NULL AND created_at <= ?))
       ORDER BY created_at ASC
       LIMIT ?`
    ).all(nowMs, nowMs - PROACTIVE_STUCK_GRACE_MS, limit) as unknown as Row[];
    return rows.map(fromRow);
  } catch (error) {
    logDbError('listDue', error);
    return [];
  }
}

/**
 * The reminders this chat already heard, newest first: delivered rows only, so the push being voiced
 * right now (still pending) is never its own history. A run she chose to skip is delivered too, and
 * rightly counts: its content was old news. Reads degrade to [] (voiced as if there were no history).
 */
export async function listRecentReminders(chatId: string, sinceMs: number, limit: number): Promise<ProactiveDeliveryRow[]> {
  try {
    const rows = stmt(
      `SELECT * FROM proactive_deliveries
       WHERE chat_id = ? AND kind = 'reminder' AND status = 'delivered' AND created_at > ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(chatId, sinceMs, limit) as unknown as Row[];
    return rows.map(fromRow);
  } catch (error) {
    logDbError('listRecentReminders', error);
    return [];
  }
}

/** The kinds SHE starts on her own. Only these count toward the back-off and only these are held by
 *  it; everything the user set up (reminder, email, memo) and the one-off notes (update,
 *  introduction) are always delivered and never counted. */
export const BACKOFF_KINDS: readonly string[] = ['callback', 'musing', 'checkin'];

/**
 * Her own texts that have gone unanswered: delivered, not dropped, back-off kinds, newer than
 * `sinceMs` (default: their latest message in this chat, 0 when they never wrote). Oldest first.
 * Reads degrade to [] — a failed read lets her text as before rather than silencing her.
 */
export async function unansweredProactiveKinds(chatId: string, sinceMs?: number): Promise<string[]> {
  try {
    const since = sinceMs ?? ((stmt(
      `SELECT COALESCE(MAX(created_at), 0) AS at FROM messages WHERE chat_id = ? AND role = 'user'`
    ).get(chatId) as { at: number } | undefined)?.at ?? 0);
    const rows = stmt(
      `SELECT kind FROM proactive_deliveries
       WHERE chat_id = ? AND status = 'delivered' AND delivered_at > ?
         AND kind IN (${BACKOFF_KINDS.map(() => '?').join(',')})
         AND COALESCE(json_extract(meta_json, '$.dropped'), 0) = 0
       ORDER BY delivered_at ASC`
    ).all(chatId, since, ...BACKOFF_KINDS) as unknown as { kind: string }[];
    return rows.map(r => r.kind);
  } catch (error) {
    logDbError('unansweredProactiveKinds', error);
    return [];
  }
}

/** Hard-delete SETTLED rows past `maxAgeMs`, called by the daily retention sweep. Reminders AND the
 *  back-off kinds live for `reminderMaxAgeMs`: a reminder is voiced against its previous runs, and a
 *  3-text unanswered stack can span two weekly pings plus a musing, which the 7-day window would
 *  erase before it ever reached 3. Pending rows are never swept — a deferral or a crash-recovery row
 *  must survive until it is delivered. */
export async function sweepOldProactive(
  maxAgeMs: number = PROACTIVE_MAX_AGE_MS,
  reminderMaxAgeMs: number = PROACTIVE_REMINDER_MAX_AGE_MS,
): Promise<number> {
  try {
    const now = Date.now();
    const longKinds = ['reminder', ...BACKOFF_KINDS];
    const marks = longKinds.map(() => '?').join(',');
    const res = stmt(
      `DELETE FROM proactive_deliveries WHERE status IN ('delivered','failed')
         AND ((kind IN (${marks}) AND created_at <= ?) OR (kind NOT IN (${marks}) AND created_at <= ?))`
    ).run(...longKinds, now - reminderMaxAgeMs, ...longKinds, now - maxAgeMs);
    return Number(res.changes);
  } catch (error) {
    logDbError('sweepOldProactive', error);
    return 0;
  }
}
