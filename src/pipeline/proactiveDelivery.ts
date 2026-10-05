// The one door every message Irises STARTS goes through. The engine's cron pushes (reminders, mail
// nudges, background memos) and the update notes all call deliver(); everything the four of them
// used to each get wrong now happens once, here:
//
//   • WHOSE memory this is — a chat id is not a person. resolveProactiveHandle() answers it, and
//     refuses to load one member's personal memory into a room.
//   • IDEMPOTENCY — the engine retries a push whose HTTP call it thinks failed (our 202 lands
//     before the voicing), so the same reminder can arrive several times.
//   • QUIET HOURS — a non-urgent push at 2am waits for morning, DURABLY (a row, not a timer).
//   • RECOVERY — a row claimed just before the process died is delivered late, not lost.
//
// A reminder is deliberately EXEMPT from quiet hours: the user picked the time. Only the pushes
// nobody scheduled (mail, memos, update notes) get held to morning, and only for a user who asked
// for quiet hours.

import { createHash } from 'node:crypto';
import { voiceProactive, type ProactiveKind, type ProactivePayload } from '../agents/proactive.js';
import { distinctUserHandles } from '../db/repositories/conversations.js';
import { getMemory, getPreference } from '../db/repositories/memory.js';
import { addShortTerm } from '../db/repositories/memoryShort.js';
import { hasRecentDelivery, insertPending, listDue, markDelivered, markDropped, markFailed } from '../db/repositories/proactive.js';
import { groupHandle } from '../memory/identity.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';
import { DEFAULT_TZ, inQuietHours, nextQuietHoursEndMs } from './zonedTime.js';
import type { SendFollowUp } from '../agents/orchestrator.js';

/** 'dropped' = the mouth's staleness guard suppressed the send (a deliberate outcome, not a
 *  failure). 'duplicate' / 'deferred' are both successes from the caller's point of view. */
export type ProactiveOutcome = 'sent' | 'dropped' | 'deferred' | 'duplicate' | 'failed';

/** Whitelisted mail metadata — the only structured extras a push may carry into memory. */
export interface ProactiveEmailMeta {
  from?: string;
  subject?: string;
  deadlineDate?: string;
  deadlineLabel?: string;
}

export interface ProactiveMessage {
  chatId: string;
  kind: ProactiveKind;
  text: string;
  framing?: string;
  /** Caller-supplied idempotency key. Defaults to a hash of chatId|kind|text. */
  dedupeKey?: string;
  emailMeta?: ProactiveEmailMeta;
  /** WHOSE memory to read when the chat itself can't say — used ONLY where resolveProactiveHandle
   *  comes back empty (a cold push into a chat nobody has spoken in). The install introduction is
   *  the case: it seeded that handle's memory minutes ago and would otherwise be voiced blind to
   *  it. A recorded speaker always wins — the hint is a caller's guess, the chat's own history
   *  isn't. Persisted in the row's meta, so a deferred hint is still there in the morning. */
  handleHint?: string;
}

export interface ProactiveDeliveryDeps {
  sendFollowUp: SendFollowUp;
  voice?: (payload: ProactivePayload, chatId: string, handle: string) => Promise<string>;
  resolveHandle?: (chatId: string) => Promise<string>;
  getPref?: <T>(handle: string, key: string) => Promise<T | undefined>;
  now?: () => number;
}

export interface ProactiveDelivery {
  deliver(msg: ProactiveMessage): Promise<ProactiveOutcome>;
  /** Deliver every row whose moment has come (deferred or crash-stranded). Returns rows sent. */
  sweepDue(): Promise<number>;
  /** Arm the boot + 60s sweep. Idempotent. */
  start(): void;
}

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BOOT_DELAY_MS = 15_000;
const SWEEP_BATCH = 20;
const META_FIELD_MAX_CHARS = 200;

/** How long one dedupe key stays taken. Long enough to absorb an engine's retry ladder, short
 *  enough that a genuinely repeating reminder (hourly, say) still lands each time. */
function dedupeWindowMs(): number {
  return Number(process.env.PROACTIVE_DEDUPE_WINDOW_MS || 30 * 60_000);
}

function defaultKey(msg: ProactiveMessage): string {
  return createHash('sha256').update(`${msg.chatId}|${msg.kind}|${msg.text}`).digest('hex');
}

function sanitizeEmailMeta(meta: ProactiveEmailMeta | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!meta) return out;
  for (const key of ['from', 'subject', 'deadlineDate', 'deadlineLabel'] as const) {
    const v = meta[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, META_FIELD_MAX_CHARS);
  }
  return out;
}

/**
 * WHOSE memory a proactive message reads. In order:
 *   1. a group identity that already exists for this chat wins outright (it was tuned for the room);
 *   2. more than one person has spoken here → the group pseudo-handle. PRIVACY: never load one
 *      member's personal memory into a room, and never write the room's turn back to them;
 *   3. exactly one → that person;
 *   4. nobody has spoken (a cold push into a fresh chat) → '' (no memory layer at all).
 */
export async function resolveProactiveHandle(chatId: string): Promise<string> {
  const group = groupHandle(chatId);
  try {
    if (await getMemory(group)) return group;
    const handles = await distinctUserHandles(chatId, 3);
    if (handles.length > 1) return group;
    return handles[0] ?? '';
  } catch (err) {
    console.error('[proactive] handle resolution failed — voicing with no memory layer', err);
    return '';
  }
}

export function createProactiveDelivery(deps: ProactiveDeliveryDeps): ProactiveDelivery {
  const voice = deps.voice ?? voiceProactive;
  const resolveHandle = deps.resolveHandle ?? resolveProactiveHandle;
  const getPref = deps.getPref ?? getPreference;
  const now = deps.now ?? (() => Date.now());

  /** Resolution first, the caller's hint only where resolution found nobody. */
  async function handleFor(chatId: string, hint?: string): Promise<string> {
    return (await resolveHandle(chatId)) || hint?.trim() || '';
  }

  // Voice + send one claimed row. Owns the row's terminal state: delivered (including a mouth-level
  // drop, which is final, not retryable) or failed.
  async function send(msg: ProactiveMessage, handle: string, rowId: string): Promise<'sent' | 'dropped' | 'failed'> {
    try {
      // The voicer rides the mouth as a THUNK, so it reads the thread as it will look when the
      // message lands (state/mouth.ts) — that is what lets an out-of-nowhere text still read as
      // the same person in the same chat.
      const result = await deps.sendFollowUp(
        msg.chatId,
        () => voice({ kind: msg.kind, text: msg.text, framing: msg.framing }, msg.chatId, handle),
        {},
      );
      // A drop is final like a delivery, but flagged: nobody saw it, so the back-off never counts it.
      if (result === 'sent') await markDelivered(rowId);
      else await markDropped(rowId);
      // Mail Irises surfaced is part of what it did today: the short tier is the channel Convo's
      // context block reads, so a same-day "what was that email again?" is answered without a
      // re-dig. (kind, taskId) is uniquely indexed, so a retried delivery writes no second row.
      if (result === 'sent' && msg.kind === 'email' && handle) {
        await addShortTerm({
          agentHandle: handle, chatId: msg.chatId, kind: 'email_flag',
          content: msg.text, meta: sanitizeEmailMeta(msg.emailMeta), taskId: rowId,
        });
      }
      return result === 'sent' ? 'sent' : 'dropped';
    } catch (err) {
      // LOUD: a proactive message that dies here is a thing the user was promised and never got.
      console.error(`[proactive] delivery failed for ${msg.chatId} (${msg.kind})`, err);
      reportError({
        source: 'process', category: 'proactive_delivery', severity: 'error', err,
        message: `proactive ${msg.kind} delivery failed`, chatId: msg.chatId, handle,
        detail: { kind: msg.kind, rowId },
      });
      await markFailed(rowId);
      return 'failed';
    }
  }

  async function deliver(msg: ProactiveMessage): Promise<ProactiveOutcome> {
    const at = now();
    const dedupeKey = msg.dedupeKey || defaultKey(msg);
    if (await hasRecentDelivery(dedupeKey, at - dedupeWindowMs())) {
      record({ type: 'event', chatId: msg.chatId, label: 'proactive:duplicate', detail: { kind: msg.kind } });
      return 'duplicate';
    }

    const handle = await handleFor(msg.chatId, msg.handleHint);
    const meta = {
      ...(msg.framing ? { framing: msg.framing } : {}),
      ...(msg.emailMeta ? { emailMeta: sanitizeEmailMeta(msg.emailMeta) } : {}),
      ...(msg.handleHint ? { handleHint: msg.handleHint } : {}),
    };

    // Quiet hours, opt-in per user and never for a reminder (they chose that time themselves).
    if (msg.kind !== 'reminder' && (await getPref<boolean>(handle, 'respect_quiet_hours')) === true) {
      const tz = (await getPref<string>(handle, 'agent_tz')) || DEFAULT_TZ;
      if (inQuietHours(tz, at)) {
        const deliverAfter = nextQuietHoursEndMs(tz, at);
        await insertPending({ chatId: msg.chatId, kind: msg.kind, text: msg.text, dedupeKey, meta, deliverAfter });
        record({ type: 'event', chatId: msg.chatId, handle, label: 'proactive:deferred', detail: { kind: msg.kind, tz, deliverAfter } });
        return 'deferred';
      }
    }

    const rowId = await insertPending({ chatId: msg.chatId, kind: msg.kind, text: msg.text, dedupeKey, meta, deliverAfter: null });
    const outcome = await send(msg, handle, rowId);
    record({ type: 'event', chatId: msg.chatId, handle, label: 'proactive:delivery', detail: { kind: msg.kind, outcome } });
    return outcome;
  }

  let sweeping = false;

  async function sweepDue(): Promise<number> {
    if (sweeping) return 0; // one sweep at a time: overlapping runs would double-deliver a row
    sweeping = true;
    try {
      const rows = await listDue(now(), SWEEP_BATCH);
      let sent = 0;
      for (const row of rows) {
        // Re-resolve: the chat may have gained a second speaker while the row waited overnight.
        const emailMeta = row.meta.emailMeta as ProactiveEmailMeta | undefined;
        const framing = typeof row.meta.framing === 'string' ? row.meta.framing : undefined;
        const handleHint = typeof row.meta.handleHint === 'string' ? row.meta.handleHint : undefined;
        const handle = await handleFor(row.chatId, handleHint);
        // No re-defer: this row already served its wait, and quiet hours ended.
        const outcome = await send(
          { chatId: row.chatId, kind: row.kind as ProactiveKind, text: row.text, framing, emailMeta },
          handle, row.id,
        );
        if (outcome === 'sent') sent++;
      }
      return sent;
    } catch (err) {
      console.error('[proactive] sweep failed', err);
      return 0;
    } finally {
      sweeping = false;
    }
  }

  let armed = false;
  function start(): void {
    if (armed) return;
    armed = true;
    // Mirrors src/db/retention.ts: unref'd timers, best-effort, never able to take the boot down.
    const boot = setTimeout(() => { void sweepDue(); }, SWEEP_BOOT_DELAY_MS);
    (boot as { unref?: () => void }).unref?.();
    const timer = setInterval(() => { void sweepDue(); }, SWEEP_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  return { deliver, sweepDue, start };
}
