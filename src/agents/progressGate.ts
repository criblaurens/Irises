// The throttle behind every "still waiting on Ops" reassurance (the mid-run heartbeat and Ops's tool
// milestones). Pulled out of the orchestrator so the timing law is one small, unit-tested unit.
//
// The law (user directive): at most 3 messages per task (holding line + at most 1 mid-run update +
// final answer). The mid-run update fires only after 5 minutes of silence, with at least 5 minutes
// between pings, and the hard cap of 1 per run. Both windows are env-overridable; the defaults
// encode the 5-minute / max-1 rule.
//
// `allow(key)` is the gate: it is SYNCHRONOUS and RESERVES the slot the moment it returns true, so a
// caller can check-then-voice (a slow LLM voice call) without a second concurrent milestone slipping
// through in the gap. `key` dedupes a repeat of the SAME milestone within one run (the tool name, or
// 'heartbeat') even when the voiced phrasing varies. `stop()` freezes the gate the instant Ops settles.

/** Shared across all legs of a single Ops run so the total mid-run update count is run-wide. */
export interface PingBudget { remaining: number }

export interface ProgressGateOpts {
  /** Stay silent until the wait crosses this. Default 300s — the holding line covers everything shorter. */
  quietMs?: number;
  /** Minimum spacing between two pings. Default 300s — "once every 5 minutes". */
  gapMs?: number;
  /** Hard cap over the whole run, so a very long pull never becomes a play-by-play. Default 1. */
  maxPings?: number;
  /** Shared run-wide budget — when present, `allow()` also decrements this and refuses when depleted. */
  budget?: PingBudget;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export class ProgressGate {
  private readonly quietMs: number;
  private readonly gapMs: number;
  private readonly maxPings: number;
  private readonly budget: PingBudget | undefined;
  private readonly now: () => number;
  private readonly startAt: number;
  private readonly sent = new Set<string>();
  private lastPingAt = 0; // 0 => "never" — the first eligible ping always clears the gap check
  private pingCount = 0;
  private stopped = false;

  constructor(opts: ProgressGateOpts = {}) {
    this.quietMs = opts.quietMs ?? 300_000;
    this.gapMs = opts.gapMs ?? 300_000;
    this.maxPings = opts.maxPings ?? 1;
    this.budget = opts.budget;
    this.now = opts.now ?? Date.now;
    this.startAt = this.now();
  }

  /** True if a ping keyed `key` may fire right now — and, when true, RESERVES the slot (records the
   *  key, stamps the clock, bumps the count, debits the run-wide budget) so a concurrent caller in the
   *  voice window can't double-fire. */
  allow(key: string): boolean {
    if (this.stopped) return false;
    const now = this.now();
    if (now - this.startAt < this.quietMs) return false;   // not long enough yet — the holding text stands
    if (this.pingCount >= this.maxPings) return false;      // cap the total, never narrate the whole run
    if (this.budget && this.budget.remaining <= 0) return false; // run-wide budget exhausted by another leg
    // Gap only applies AFTER the first ping — the first eligible one always clears it (guarding on the
    // count, not on lastPingAt=0, so a config where quietMs < gapMs still fires its first ping on time).
    if (this.pingCount > 0 && now - this.lastPingAt < this.gapMs) return false; // once every 5 minutes, no closer
    if (this.sent.has(key)) return false;                   // never repeat the SAME milestone
    this.sent.add(key);
    this.lastPingAt = now;
    this.pingCount++;
    if (this.budget) this.budget.remaining--;
    return true;
  }

  /** Whether the run has settled (used to drop a ping whose voice call finished after the answer shipped). */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Freeze the gate — no more pings. Called the instant Ops settles. */
  stop(): void {
    this.stopped = true;
  }
}

/**
 * One ping's full life, with the ordering that makes the throttle correct:
 *   1. gate.allow(key) FIRST (synchronous, reserves the slot) — a suppressed ping spends no `voice`
 *      call, and two milestones landing together can't both slip through the async `voice` window.
 *   2. voice() — the slow part (reads the thread + a model call).
 *   3. gate.isStopped re-check — if Ops settled while we were voicing, drop this now-stale reassurance
 *      so it never lands AFTER the real answer.
 *   4. send(text).
 * `holdIf` is read before step 1: a ping held back (the run is waiting on their answer to an engine
 * ask) spends nothing, so the run's one ping is still there once the wait is over.
 * Extracted from the orchestrator so this exact ordering is unit-testable (a future edit that voices
 * before gating, or forgets the post-voice re-check, fails a test instead of shipping a stale ping).
 * NEITHER `voice` NOR `send` may take the run down with it. Callers float this promise (`void
 * voiceAndPing(...)`, one of them from inside a setTimeout with no caller at all), and an unhandled
 * rejection is FATAL in this process — diagnostics/errorLog.ts turns it into process.exit(1). A
 * reassurance that failed to voice or failed to hand off is worth exactly nothing; it must never be
 * worth the whole delegation, so both halves are swallowed here.
 */
export async function runPingCycle(
  gate: ProgressGate,
  key: string,
  voice: () => Promise<string>,
  send: (text: string) => void,
  holdIf?: () => boolean,
): Promise<void> {
  if (holdIf?.() || !gate.allow(key)) return;
  let text: string;
  try {
    text = await voice();
  } catch {
    return; // voice should self-floor; a hard throw just means no ping this cycle
  }
  if (gate.isStopped) return;
  try {
    send(text);
  } catch {
    // `send` is a hand-off to the mouth (itself fire-and-forget). A synchronous throw here used to
    // escape as an unhandled rejection on a floated ping — i.e. a best-effort "still on it" could
    // kill the process mid-delegation, which reads downstream as the task silently hanging forever.
  }
}
