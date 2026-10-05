// The durable twin of the ops registry, and the one thing it exists to make possible: telling the
// user, afterwards, that a run they were promised got cut off.
//
// Two halves, and the seam between them is deliberate. opsCoordination.ts holds the live maps and
// imports no storage (it is on the reply path; its tests run without a database), so this module
// registers itself there as a SINK and does the writing. Nothing here is on a hot path: every hook
// is a synchronous row write behind a try/catch, and with the flag off no sink is ever registered,
// so not one line of this file runs.
//
// The sweep is NOT a queue drain. A row still live long past its own leg horizon is crash debris:
// the process driving it is gone, and nothing can bring the answer back. We mark it `lost` and send
// exactly one honest line that claims NO result and offers no automatic re-run — a re-run costs a
// real engine leg, and for anything with a side effect it could repeat the side effect. The user
// decides, in their own words, on their own turn.

import { record } from '../diagnostics/trace.js';
import {
  hasRunningTask, insertRunning, listStranded, markLost, markRetrying, settleOpsTask,
} from '../db/repositories/opsTasks.js';
import type { ProactiveMessage, ProactiveOutcome } from '../pipeline/proactiveDelivery.js';
import { getActiveOps, opsStaleMs, requestOpsCancel, type OpsTaskSink } from './opsCoordination.js';

/** The feature gate (env: OPS_DURABLE_TASKS). Default ON, read at CALL time — the same parse shape
 *  as every sibling flag (threadingEnabled, semanticRecallEnabled, …). Off is byte-identical to no
 *  feature at all: index.ts registers no sink and arms no timer, so the registry's hooks are one
 *  false `if` each and this table is never touched. */
export function opsDurableTasksEnabled(): boolean {
  const v = (process.env.OPS_DURABLE_TASKS || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BOOT_DELAY_MS = 15_000;
const SWEEP_BATCH = 20;
/** How much of the ask is quoted back. Long enough to be recognisable, short enough that a
 *  paragraph-long request cannot become the whole text. */
const REQUEST_QUOTE_CHARS = 120;

/**
 * The one thing she says about a run a restart killed. Her register: lowercase, plain, no emoji,
 * and — the load-bearing part — it CLAIMS NOTHING. No result, no partial finding, no "I'll pick it
 * back up": the honest state is that the work stopped and nobody knows what it would have said. The
 * offer to run it again is a statement of what is in reach, because running it again is the
 * user's call to make and a question would hand them the decision as homework.
 *
 * `engineActions` is the same honesty one clause further: a run can carry work as well as a
 * question, and quoting the request alone told them their lookup had stopped while leaving the
 * setup sounding like it had gone through. The actions are NOT quoted back — the apology claims
 * nothing about what any of them reached — only that they did not happen. Empty for every run that
 * was asked for none, which is the line exactly as it was.
 */
export function opsLostText(request: string, engineActions: string[] = []): string {
  const flat = request.trim().replace(/\s+/g, ' ');
  const quoted = flat.length > REQUEST_QUOTE_CHARS ? `${flat.slice(0, REQUEST_QUOTE_CHARS).trimEnd()}…` : flat;
  const setup = engineActions.length ? " the setting up you asked for didn't happen either." : '';
  return `that thing i was looking into for you — "${quoted}" — got cut off when i restarted. nothing came back from it.${setup} say the word and i run it again.`;
}

export interface OpsTaskRecoveryDeps {
  /** proactive.deliver: the one door every message she STARTS goes through. Its own dedupe over
   *  our key is what makes "exactly once" hold even if a sweep somehow ran twice. */
  deliver: (msg: ProactiveMessage) => Promise<ProactiveOutcome>;
}

export interface OpsTaskRecovery {
  /** Hand this to setOpsTaskSink() at boot. */
  sink: OpsTaskSink;
  /** One pass over the stranded rows. Returns how many were owned up to. */
  sweepStranded(): Promise<number>;
  /** Arm the boot + 60s sweep. Idempotent. */
  start(): void;
}

export function createOpsTaskRecovery(deps: OpsTaskRecoveryDeps): OpsTaskRecovery {
  const sink: OpsTaskSink = {
    onStart(e) {
      // `engineActions` rides the row's free-form meta rather than a column: ops_tasks has no
      // migration mechanism, and the row only ever has to answer what this run was asked to do.
      const meta: Record<string, unknown> = {
        ...(e.origin ? { origin: e.origin } : {}),
        ...(e.engineActions?.length ? { engineActions: e.engineActions } : {}),
      };
      const ok = insertRunning({ id: e.taskId, chatId: e.chatId, kind: e.kind, request: e.request, budgetMs: e.budgetMs, meta });
      if (!ok) {
        // Not fatal to the turn — the run proceeds on the in-memory maps exactly as before this
        // feature existed. What is lost is the ability to own up to it if the process dies, and
        // that silence is what this receipt makes readable.
        record({ type: 'event', chatId: e.chatId, taskId: e.taskId, label: 'ops:durable-write-lost', detail: { taskId: e.taskId, kind: e.kind, at: 'start' } });
      }
    },
    onRetry(e) {
      if (!markRetrying(e.taskId)) {
        record({ type: 'event', chatId: e.chatId, taskId: e.taskId, label: 'ops:durable-write-lost', detail: { taskId: e.taskId, at: 'retry' } });
      }
    },
    onCancel(e) {
      settleOpsTask(e.taskId, 'cancelled');
    },
    onDone(e) {
      // 'delivered' here means the run REACHED ITS HANDOFF, not that a message was voiced — the
      // mouth is downstream of this. The row only ever has to answer "was this cut off?", and every
      // terminal status answers it the same way: no. A row already cancelled or lost stays put; the
      // repository's terminal guard is what enforces that.
      settleOpsTask(e.taskId, 'delivered');
    },
    isRunningElsewhere(chatId, request) {
      return hasRunningTask(chatId, Date.now() - opsStaleMs(), request);
    },
  };

  let sweeping = false;

  async function sweepStranded(): Promise<number> {
    if (sweeping) return 0; // one sweep at a time: overlapping runs would double-send a follow-up
    sweeping = true;
    try {
      const now = Date.now();
      const rows = listStranded(now, opsStaleMs(), SWEEP_BATCH);
      let owned = 0;
      for (const row of rows) {
        try {
          // A live leg this process still holds is not crash debris: one waiting on the user's
          // answer to an engine ask reads as in flight past the row's horizon. After a crash the
          // registry is empty, and a stuck leg with no wait on it reads as stale, so both still go.
          if (getActiveOps(row.chatId, now).some(o => o.taskId === row.id)) continue;
          // Mark FIRST. A crash between the two writes costs one un-sent follow-up; the other order
          // would cost a follow-up re-sent on every sweep forever.
          if (!markLost(row.id)) continue; // someone settled it under us — not ours to own up to
          // Cancel any live in-memory leg so a live-but-stuck task (bridge unreachable,
          // OOM thrashing) doesn't deliver a stale result after the user was told it was lost.
          requestOpsCancel(row.chatId, row.id);
          const outcome = await deps.deliver({
            chatId: row.chatId,
            kind: 'memo',
            // The row's meta is the only record left of what this run was asked to DO — the
            // in-memory registry died with the process that held it.
            text: opsLostText(row.request, Array.isArray(row.meta?.engineActions) ? row.meta.engineActions as string[] : []),
            dedupeKey: `ops-lost:${row.id}`,
          });
          // Recorded on the no-op path too: the proactive layer dedupes, and a receipt that only
          // appeared when a text went out would make the swallowed case invisible.
          record({
            type: 'event', chatId: row.chatId, taskId: row.id, label: 'ops:lost',
            detail: { taskId: row.id, kind: row.kind, ageMs: now - row.legStartedAt, delivered: outcome === 'sent' },
          });
          owned++;
        } catch (err) {
          // One bad row must not end the sweep — the rest of the stranded runs still deserve theirs.
          console.error(`[opsTasks] could not own up to stranded run ${row.id}`, err);
        }
      }
      return owned;
    } catch (err) {
      console.error('[opsTasks] stranded sweep failed', err);
      return 0;
    } finally {
      sweeping = false;
    }
  }

  let armed = false;
  function start(): void {
    if (armed) return;
    armed = true;
    // Mirrors the proactive sweep and the retention timers: unref'd, best-effort, unable to take
    // the boot down. The boot delay is what keeps a restart from texting before the mouth is up.
    const boot = setTimeout(() => { void sweepStranded(); }, SWEEP_BOOT_DELAY_MS);
    (boot as { unref?: () => void }).unref?.();
    const timer = setInterval(() => { void sweepStranded(); }, SWEEP_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  return { sink, sweepStranded, start };
}
