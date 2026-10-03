// Delivering a mid-run ADDITION to the engine: the user narrowed, corrected, or thought of one
// more thing while a lookup was already going, and dropping the run to start over would throw away
// minutes of real work.
//
// Why a retry ladder rather than one POST: hermes only accepts a steer while the run's status is
// exactly `running` (api_server.py `_handle_steer_run` — the status gate, not the mere presence of
// an agent ref). A freshly dispatched run spends a second or two `queued` and then constructing its
// agent, and a user who types "also check jakarta" one second after Irises said "on it" lands
// squarely inside that window. A 409 there is not a failure; it is "not yet".
//
// Everything here is best-effort by construction: it runs inside a live Convo turn, beside a leg
// that is doing the actual work. Nothing throws, and a steer nobody could deliver is not a lost
// instruction — it stays on the in-flight entry (state/opsCoordination.ts), so the status line reads
// it back and the follow-up leg folds it in.
import { record } from '../../diagnostics/trace.js';
import type { EngineBackend, EngineRunHandle } from './engineBackend.js';

/** How many times a 'not_running' is worth re-asking — enough to cover hermes's construction
 *  window, short enough that the whole ladder fits inside a turn the user is waiting on. */
export const STEER_ATTEMPTS = 3;
/** The wait between attempts. Roughly the construction window itself; two of these plus three
 *  three-second POSTs is the worst case, and only when the run never becomes steerable. */
export const STEER_BACKOFF_MS = 1_500;

/** Where this steer belongs, for the receipt. */
export interface SteerContext {
  chatId: string;
  agentHandle: string;
  taskId: string;
}

export interface SteerOpts {
  attempts?: number;
  backoffMs?: number;
  /** The task's own signal: a run the user has since cancelled must not be steered. */
  signal?: AbortSignal;
  /** Injected so the ladder is testable without real waits (repo DI convention). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `'accepted'`  — the engine took it (it folds in at the next tool result or pre-model call).
 * `'not_running'` — the run was never steerable in the window we gave it, or the call errored.
 * `'unsupported'` — this engine has no steer route at all (OpenClaw today). Distinct because the
 *                   caller owes the user a different sentence: not "too late", but "I'll work it
 *                   into the answer when it lands" — which is honest, since the follow-up already
 *                   folds intervening messages in.
 */
export type SteerOutcome = 'accepted' | 'not_running' | 'unsupported';

/**
 * Wrap the user's addition for the engine. The wording is the human's own, pinned whole by its test
 * — treat it as text to be changed deliberately, not tidied.
 *
 * Three jobs. It says WHAT this text is: an addition to work already in progress, not a new task
 * and not a correction of the engine's instructions (hermes additionally marks it
 * `[OUT-OF-BAND USER MESSAGE …]` on its own side) — "the work you are doing now" is what stops a
 * run restarting itself. It restates the output contract, because a steered run otherwise tends to
 * answer the addition alone, in prose, leaving the follow-up composer with no
 * ANSWER/SOURCE/ACTIONS/FLAGS block to read. And the FLAGS clause is what turns a steer that missed
 * its window into something the user hears about instead of silence.
 *
 * The user's words are quoted, deliberately, rather than fenced as data: this IS an instruction from
 * them about their own task, and the engine is meant to act on it. Wrapping happens HERE and only
 * here — every caller passes the guidance raw.
 */
export function steerPrompt(text: string): string {
  return `The user just added to this task mid-run: "${text.trim()}"\n`
    + 'Fold it into the work you are doing now. Keep the same output contract (ANSWER / NOTICED / SOURCE / ACTIONS / FLAGS). '
    + 'If it arrived too late to act on, say so in FLAGS in one line rather than restarting.';
}

const defaultSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Deliver one addition to a running engine leg, retrying the "not yet" case.
 *
 * Never throws and never retries an ERROR: a 401/429/5xx is not the construction window, so re-asking
 * only spends the user's turn. Leaves an `ops:steer` receipt on every outcome that reached the
 * engine or decided not to — accepted, not_running, errored, cancelled, unsupported — because "did
 * the engine actually hear the correction?" is the one question a live round needs answered. The
 * ONE silent return is blank text: nothing happened, there is no addition, and an event saying so
 * would be noise in the round it is meant to make readable (requestOpsSteer already answers
 * 'already_done' for a blank steer, so nothing upstream reaches this line by accident).
 */
export async function steerWithRetry(
  engine: EngineBackend,
  handle: EngineRunHandle,
  text: string,
  where: SteerContext,
  opts: SteerOpts = {},
): Promise<SteerOutcome> {
  const receipt = (accepted: boolean, reason: string, attempts: number, error?: string): void => {
    record({
      type: 'event', chatId: where.chatId, handle: where.agentHandle, taskId: where.taskId,
      label: 'ops:steer',
      detail: { accepted, reason, attempts, engine: handle.engine, runId: handle.runId, ...(error ? { error } : {}) },
    });
  };

  const trimmed = text.trim();
  if (!trimmed) return 'not_running'; // nothing to add — never a request the engine should see
  if (!engine.steerRun) {
    receipt(false, 'unsupported', 0);
    return 'unsupported';
  }

  const attempts = opts.attempts ?? STEER_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? STEER_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const wrapped = steerPrompt(trimmed);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) {
      receipt(false, 'cancelled', attempt - 1);
      return 'not_running';
    }
    let outcome: 'accepted' | 'not_running';
    try {
      outcome = await engine.steerRun(handle, wrapped, { signal: opts.signal });
    } catch (err) {
      receipt(false, 'error', attempt, String((err as Error)?.message ?? err).slice(0, 300));
      return 'not_running';
    }
    if (outcome === 'accepted') {
      receipt(true, 'accepted', attempt);
      return 'accepted';
    }
    // 'not_running' — the construction window, or a run that has moved on. Wait only if there is
    // another attempt to make; a trailing sleep would just delay the honest answer.
    if (attempt < attempts) await sleep(backoffMs);
  }
  receipt(false, 'not_running', attempts);
  return 'not_running';
}
