// Synchronous, in-memory coordination for background Ops work — the single source of truth for
// "is research running for this chat right now?" and "did we just delegate this exact ask?".
//
// Why in-memory and not durable prefs: this flag must be readable on the VERY NEXT turn (a user
// types "ok" ~1.5s after we delegate). Routing it through async durable prefs loses that
// read-after-write race and reproduces the exact bug this exists to kill. It is set SYNCHRONOUSLY
// at the delegation point (before any await), so the next turn always sees it. Deployment is a
// single VM, so a process-local map is authoritative. State dies with the VM — which is correct:
// a crashed Ops run never resumes, so a stale "still pulling" flag must not survive a restart.
//
// Keyed by chatId then taskId so concurrent DISTINCT tasks coexist and each clears only its own
// marker (no first-finisher-clears-everyone bug).
import type { TaskKind } from '../agents/types.js';
import { estimateOpsEta, etaStatus, type EtaEstimate, type EtaStatus } from '../agents/etaEstimate.js';
import { standardLegBudgetMs, browserLegBudgetMs, type EngineRunHandle } from '../agents/ops/engineBackend.js';

interface InFlightEntry {
  kind: TaskKind;
  request: string;
  normKey: string;
  startedAt: number; // epoch ms (app clock — only ever compared to Date.now())
  firstStartedAt: number;  // epoch ms, set once, never reset — true elapsed survives a retry leg
  origin?: 'scheduled';     // set for scheduled engine runs; user-delegated runs leave it unset
  lastMilestone?: string;   // most recent user-noticeable milestone the run reported
  milestoneAt?: number;     // epoch ms that milestone landed — lets Convo say what's happening NOW
  cancel?: AbortController; // aborts the running task's step loop (best-effort, token-saving)
  cancelled?: boolean;      // the load-bearing flag: the orchestrator suppresses delivery on it
  estimateMs?: number;
  estimatePhrase?: string;
  // The ENGINE's handle for the leg currently running, once the adapter has one to give (hermes's
  // run_id, published through EngineRunContext.onRunHandle). It is what a steer or a stop aims at;
  // absent means the run cannot be reached at all yet.
  engineRun?: EngineRunHandle;
  // Set when NO handle can ever land for the leg now running: the engine has no steer route at all
  // (OpenClaw), or its adapter took a transport that carries no run id (hermes's chat completions).
  // Without it every steer on such a leg answered 'queued' and waited for a drain that never runs —
  // the user heard "adding that in" about an addition nothing would ever deliver.
  steerUnreachable?: true;
  // Set when the engine leg has ENDED. The task is still in flight (triage and compose come next)
  // but the run is over on the engine and answers 409 to a steer, so this is what tells the two
  // apart: 'already_done' for the addition, without pretending the whole task is finished.
  legEnded?: true;
  // Everything the user ADDED to this ask mid-run, in the order they said it — kept whether or not
  // the engine accepted any of it, because these are things they said about work that is running:
  // the status line reads them back and a refinement leg folds them in. Each one carries whether
  // the engine ever had it, because the status line is read as the record of what was handed over,
  // and an addition that never reached the look must not read back like one the run folded in.
  // `steers` (ActiveOps) and the unapplied list are both derived from this.
  steerLog?: SteerLogEntry[];
  // What the user asked the ENGINE to DO as part of this ask (agents/types.ts `engineActions`),
  // kept so the "already pulling" status line can name the parts that were really handed over —
  // the model reads which actions are in the task instead of recalling what it promised. ABSENT
  // rather than empty, like `steers`.
  engineActions?: string[];
  // The subset not yet handed to a caller for delivery. A steer that arrives before engineRun
  // exists (hermes takes a second or two to build the agent) waits here rather than being dropped.
  pendingSteers?: string[];
  // Time this leg spent waiting on the user's answer to an engine's dangerous-command ask
  // (ops/engineApproval.ts). The leg is alive through it, so every "still in flight" reading adds it
  // back. Reset with each new leg (markOpsRetry).
  graceMs?: number;
}

/**
 * Where one addition got to. 'pending' until something knows: the POST is out, or it waits in the
 * queue for a handle. 'reached' once the engine accepted it. 'never' when it cannot arrive any more:
 * the run could not take one mid-flight, its leg had already ended, the POST came back without the
 * engine taking it, or it was still waiting when the leg ended. The answer that comes back may not
 * cover a 'never' one, and the follow-up is told so (orchestrator.ts steerRelay).
 */
export type SteerDelivery = 'pending' | 'reached' | 'never';

export interface SteerLogEntry {
  text: string;
  delivery: SteerDelivery;
}

const inFlight = new Map<string, Map<string, InFlightEntry>>();   // chatId -> taskId -> entry
const recentlyDelegated = new Map<string, Map<string, number>>(); // chatId -> normKey -> at (ms)
const recentlyEnded = new Map<string, EndedOps[]>();              // chatId -> the last few runs that ended

/**
 * The optional durable twin of the maps above. This module is on the REPLY path and imports no
 * storage — its tests run without a database, and a db import here would drag one into every one of
 * them. So the durable half registers itself as a SINK instead: every method is synchronous (the
 * map writes it shadows are what INV-1 rests on, and an await between them would open the gap that
 * invariant closes) and every call site try/catches it (a durable write must never take down a
 * reply). No sink registered — the flag off, or a test — and every hook below is one false `if`.
 */
export interface OpsTaskSink {
  onStart(e: { chatId: string; taskId: string; kind: TaskKind; request: string; budgetMs: number; origin?: 'scheduled'; engineActions?: string[] }): void;
  onRetry(e: { chatId: string; taskId: string }): void;
  onCancel(e: { chatId: string; taskId: string }): void;
  onDone(e: { chatId: string; taskId: string }): void;
  /** "Is this exact ask already running, according to something that outlived the process?" —
   *  consulted only after both maps miss, which after a restart is every ask. */
  isRunningElsewhere(chatId: string, request: string): boolean;
}

let taskSink: OpsTaskSink | null = null;

/** Register (or clear, with null) the durable twin. Called once at boot, and by tests. */
export function setOpsTaskSink(sink: OpsTaskSink | null): void {
  taskSink = sink;
}

// A just-delegated ask stays "recent" this long so a repeat lands on the cached answer, not a
// second run. Short enough that a genuinely fresh re-ask after the data could change still runs.
const RECENT_DELEGATION_MS = 90_000;
// How far PAST its own deadline a leg may run before we stop claiming it is in flight. The orchestrator
// abandons a leg at its budget and clears the marker in `finally`, so this covers only the gap between
// "the deadline passed" and "the teardown got here" — a minute is generous for that, and short enough
// that a genuinely crashed process (no teardown at all) unblocks the next ask quickly.
export const OPS_STALE_SLACK_MS = 60_000;

/**
 * Soft upper bound on how long we'll claim a run is still "in flight" for wording/suppression: the
 * WIDEST leg deadline this deployment can wait on, plus the slack above. A run that overran it
 * (crash, stuck tool) stops blocking; that's a self-heal, not correctness.
 *
 * DERIVED, not pinned, because the two numbers are one fact. While a leg is genuinely running,
 * `getActiveOps` must keep Convo saying "still on it", `getOpsEtaStatus` must keep the ETA, and
 * `isDuplicateDelegation` / `hasInFlightRequest` must keep suppressing the re-ask — so this horizon
 * has to sit OUTSIDE every deadline the orchestrator waits on (ops/client.ts `legBudgetFor`: the
 * standard `OPS_TASK_TIMEOUT_MS` window, or the wider walled-URL browser budget when the operator
 * armed one). Pinned at a flat five minutes, an armed 15-minute browser leg went silent at five: the
 * "still on it" wording stopped, the ETA vanished, and a duplicate re-ask started a SECOND engine run
 * against the one already working.
 *
 * Both env vars are read through the parsers that OWN them (agents/ops/engineBackend.ts), never a
 * second reading of either one, and at CALL time like every other flag so arming the budget needs no
 * restart. Pure — the env is injected, so the caller decides when it is read. A default environment
 * gives 240_000 + 60_000: the same 300_000 this was a constant for.
 */
export function opsStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(standardLegBudgetMs(env), browserLegBudgetMs(env) ?? 0) + OPS_STALE_SLACK_MS;
}

/** Normalize kind+request into a dedupe key. Whitespace/case-insensitive; exact-intent match. */
export function normalizeRequest(kind: string, request: string): string {
  return `${kind}:${request.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/** Record that an Ops task just started for a chat. Call SYNCHRONOUSLY before `void runOps...`.
 *  Pass the task's AbortController so a user cancel can reach the running loop.
 *  `origin: 'scheduled'` marks an Autonome background run (framed differently in Convo's prompt). */
export function markOpsStart(chatId: string, taskId: string, info: { kind: TaskKind; request: string; origin?: 'scheduled'; estimate?: EtaEstimate; engineActions?: string[] }, cancel?: AbortController): void {
  const normKey = normalizeRequest(info.kind, info.request);
  const now = Date.now();
  const est = info.estimate ?? estimateOpsEta({ kind: info.kind, request: info.request });
  const byTask = inFlight.get(chatId) ?? new Map<string, InFlightEntry>();
  byTask.set(taskId, {
    kind: info.kind, request: info.request, normKey, startedAt: now, firstStartedAt: now,
    origin: info.origin, cancel, estimateMs: est.bucketMs, estimatePhrase: est.phrase,
    ...(info.engineActions?.length ? { engineActions: [...info.engineActions] } : {}),
  });
  inFlight.set(chatId, byTask);
  const ring = recentlyDelegated.get(chatId) ?? new Map<string, number>();
  ring.set(normKey, now);
  recentlyDelegated.set(chatId, ring);
  prune(chatId);
  // The durable copy goes AFTER the maps: the maps are the authority this turn, the row is what
  // answers for this run after the process is gone.
  if (taskSink) {
    try { taskSink.onStart({ chatId, taskId, kind: info.kind, request: info.request, budgetMs: opsStaleMs(), origin: info.origin, engineActions: info.engineActions }); }
    catch { /* durable state is best-effort — never the reply's problem */ }
  }
}

/**
 * User-requested cancel of one in-flight task. Synchronous (this map is the authority): sets the
 * `cancelled` flag the orchestrator's delivery guard reads, aborts the loop's signal (best-effort),
 * and forgets the ask's dedupe key so an immediate "actually run it again" isn't suppressed as a
 * duplicate. Returns 'already_done' when the entry is gone — the task finished and delivered (or
 * never existed); the caller voices that honestly instead of claiming a cancel.
 */
export function requestOpsCancel(chatId: string, taskId: string): 'signalled' | 'already_done' {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry) return 'already_done';
  // Noted at the stop rather than at the teardown: the orchestrator may take a while to unwind the
  // leg, and the very next turn must already read this run as dropped.
  if (!entry.cancelled) noteEnded(chatId, taskId, entry, 'cancelled');
  entry.cancelled = true;
  entry.cancel?.abort();
  recentlyDelegated.get(chatId)?.delete(entry.normKey);
  if (taskSink) {
    try { taskSink.onCancel({ chatId, taskId }); }
    catch { /* durable state is best-effort */ }
  }
  return 'signalled';
}

/** Read the cancel flag off the entry (works even for paths the signal never reaches). */
export function isOpsCancelled(chatId: string, taskId: string): boolean {
  return inFlight.get(chatId)?.get(taskId)?.cancelled === true;
}

/**
 * Keep-alive for the cheap RETRY leg (a transient-lane-blip second pass). An llm_error can land
 * LATE in the primary loop, so the retry may run well after the original start and the entry would
 * go stale mid-look (past opsStaleMs, getActiveOps + isDuplicateDelegation silently drop the task, so
 * Convo would stop saying "still on it" and a duplicate re-ask could run mid-look). Resetting the
 * per-leg startedAt hands the new leg the same clock a first leg gets, which is what the horizon is
 * built for: opsStaleMs sits outside the WIDEST leg deadline this deployment can wait on, so a leg
 * whose clock starts now cannot go stale before its own deadline abandons it (while firstStartedAt
 * stays put so true elapsed survives). It does NOT extend the ETA — a retry is expected to be quick and its
 * pings stay silent inside the normal quiet window. In-place, and MUST preserve `cancelled` — this
 * is NOT markOpsStart, which would resurrect a cancelled entry and re-arm its dedupe key. No-op if
 * the entry is already gone.
 */
export function markOpsRetry(chatId: string, taskId: string): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled) return;
  entry.startedAt = Date.now();
  delete entry.graceMs;
  if (taskSink) {
    try { taskSink.onRetry({ chatId, taskId }); }
    catch { /* durable state is best-effort */ }
  }
}

/**
 * Compute the current ETA status for an in-flight task (elapsed from firstStartedAt so a retry leg
 * doesn't reset the clock). Returns undefined for cancelled, stale, or missing entries.
 *
 * `now` is injectable, like on the three reads below: it defaults to the app clock, and a caller
 * that reads several of these for one turn can pass one instant so they cannot disagree.
 */
export function getOpsEtaStatus(chatId: string, taskId: string, now: number = Date.now()): EtaStatus | undefined {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled) return undefined;
  if (now - entry.startedAt - (entry.graceMs ?? 0) >= opsStaleMs()) return undefined;
  if (entry.estimateMs == null) return undefined;
  const elapsed = now - entry.firstStartedAt;
  return etaStatus({ bucketMs: entry.estimateMs, phrase: entry.estimatePhrase ?? '' }, elapsed);
}

/**
 * Record the latest user-noticeable milestone for an in-flight run — the tool it just started
 * (a stable key like 'search_email'). Fed by runTask's onProgress signal; this is what lets Convo
 * answer "how's that going?" with what the run is ACTUALLY doing instead of a generic beat.
 * Unlike the texted progress pings (throttled to 1/run so the user isn't spammed), EVERY milestone
 * updates the registry — the throttle is about the mouth, not about what Convo is allowed to know.
 * In-place; no-op if the entry is gone or cancelled (a timed-out abandoned leg's late milestones
 * must never resurrect or mutate a cleared/cancelled entry — mirrors markOpsRetry's discipline).
 */
export function noteOpsProgress(chatId: string, taskId: string, milestoneKey: string): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (entry && !entry.cancelled) {
    entry.lastMilestone = milestoneKey;
    entry.milestoneAt = Date.now();
  }
}

/** Push this leg's in-flight horizon out by `ms`: the engine is idle waiting on the user's answer to
 *  a dangerous-command ask, and the run must keep reading as in flight until that wait is up. */
export function extendOpsLeg(chatId: string, taskId: string, ms: number): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (entry && !entry.cancelled) entry.graceMs = (entry.graceMs ?? 0) + ms;
}

/**
 * Record the ENGINE's handle for the leg now running (hermes's run_id, from
 * `EngineRunContext.onRunHandle`). Until this lands there is nothing a steer or a stop can aim at.
 *
 * In-place; no-op if the entry is gone or cancelled — the same discipline markOpsRetry and
 * noteOpsProgress keep, and for the same reason: a leg abandoned at its deadline can still publish
 * a handle late, and a cleared or cancelled entry must not be resurrected or mutated by it.
 */
export function noteOpsEngineRun(chatId: string, taskId: string, handle: EngineRunHandle): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (entry && !entry.cancelled) entry.engineRun = handle;
}

/**
 * The engine leg for this task is STARTING (`runViaEngine`, once per leg — a retry and a steer
 * replay are each their own leg). Resets what belongs to a LEG rather than to the task: the
 * previous leg's handle, the fact that it had ended, and whether anything on this one can be
 * steered at all.
 *
 * `steerable` is the ENGINE's answer — does it have a steer route — not the transport's. An adapter
 * that then routes somewhere with no run id downgrades it through `noteOpsSteerUnreachable`.
 *
 * In-place; no-op on a gone or cancelled entry, the same discipline every mutator here keeps.
 */
export function beginOpsEngineLeg(chatId: string, taskId: string, steerable: boolean): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled) return;
  delete entry.engineRun;
  delete entry.legEnded;
  if (steerable) delete entry.steerUnreachable;
  else entry.steerUnreachable = true;
}

/** This leg will never publish a handle — an engine with no steer route, or a transport that
 *  carries no run id. Called through `EngineRunContext.onNoRunHandle` so the user gets the
 *  honest "it may not make it into the answer" now instead of an ack for a delivery that cannot happen. */
export function noteOpsSteerUnreachable(chatId: string, taskId: string): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (entry && !entry.cancelled) entry.steerUnreachable = true;
}

/**
 * The engine leg ENDED (an answer, or a failure). Drops the handle, because a steer aimed at a
 * finished run is a 409 and the caller must stop being told 'ready' for it, and hands back
 * anything still queued for delivery: those additions reached nobody, and this module imports no
 * diagnostics, so the CALLER owns the trace. Returns [] for a gone or cancelled entry.
 *
 * Every addition still 'pending' is marked 'never', the queued ones and any whose POST has not
 * answered: the run they were meant for is over. A POST that comes back accepted after this still
 * upgrades its own entry (noteSteerDelivery), since the engine did have it.
 *
 * The task is NOT done here — triage and compose still have to run. `markOpsDone` is that.
 */
export function endOpsEngineLeg(chatId: string, taskId: string): string[] {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled) return [];
  delete entry.engineRun;
  entry.legEnded = true;
  const undelivered = entry.pendingSteers ?? [];
  entry.pendingSteers = [];
  for (const s of entry.steerLog ?? []) if (s.delivery === 'pending') s.delivery = 'never';
  return undelivered;
}

/**
 * What became of one addition's delivery: the steer POST (convo/shared.ts steerResearch) or the
 * drain of the queue (agents/ops/engineBackend.ts deliverQueuedSteers) answered. Marks the earliest
 * entry with this text still waiting on an answer; 'reached' also lifts an entry the leg's end
 * already gave up on, because the engine did take it. In-place; no-op on a gone or cancelled entry.
 */
export function noteSteerDelivery(chatId: string, taskId: string, text: string, delivery: Exclude<SteerDelivery, 'pending'>): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled) return;
  const trimmed = text.trim();
  const log = entry.steerLog ?? [];
  const hit = log.find(s => s.text === trimmed && s.delivery === 'pending')
    ?? (delivery === 'reached' ? log.find(s => s.text === trimmed && s.delivery === 'never') : undefined);
  if (hit) hit.delivery = delivery;
}

/** The engine handle for an in-flight leg, or undefined when there is none (yet, or ever — an
 *  adapter whose transport carries no run id never publishes one). The companion read to
 *  `requestOpsSteer`'s 'ready': the caller needs the handle to actually deliver. */
export function getOpsEngineRun(chatId: string, taskId: string): EngineRunHandle | undefined {
  const entry = inFlight.get(chatId)?.get(taskId);
  return entry && !entry.cancelled ? entry.engineRun : undefined;
}

/**
 * The user just ADDED to a lookup that is already running (steer_research). Synchronous, because
 * this map is the authority and the answer has to be in hand inside the live turn.
 *
 *  - 'ready':        there is an engine handle — the CALLER performs the async POST (this module
 *                    stays storage-free and does no I/O; read the handle with getOpsEngineRun).
 *  - 'queued':       the leg is dispatched but has no handle yet (hermes needs a second or two to
 *                    build the agent). The text waits in pendingSteers and is drained the moment
 *                    the handle lands — losing it here is losing something the user actually said.
 *  - 'unsupported':  no handle can EVER land for this leg (`beginOpsEngineLeg`'s `steerable: false`,
 *                    or `noteOpsSteerUnreachable`). Distinct from 'queued' because a queue nobody
 *                    will drain is indistinguishable from delivery to the user, and from
 *                    'already_done' because the run is still going — the caller owes them a
 *                    different sentence: the run carries on as it was, so its answer may not
 *                    cover the addition.
 *  - 'already_done': nothing is running under that id, it was cancelled, its engine leg has ended
 *                    (triage/compose are next and a steer would 409), or the text is blank. The
 *                    caller says so honestly: what comes back was gathered before the addition.
 *
 * Every non-blank addition is remembered on the entry regardless of the answer, so the status line
 * can read it back and a refinement leg can carry it even when the engine never took it. Its
 * delivery starts 'pending' ('ready' and 'queued'), or 'never' when this answer already says it
 * cannot arrive; the caller that delivers it reports how that went (noteSteerDelivery).
 */
export function requestOpsSteer(chatId: string, taskId: string, text: string, engineActions: string[] = []): 'ready' | 'queued' | 'unsupported' | 'already_done' {
  const trimmed = text.trim();
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled || !trimmed) return 'already_done';
  const logged: SteerLogEntry = { text: trimmed, delivery: 'pending' };
  entry.steerLog = [...(entry.steerLog ?? []), logged];
  // An addition can ask for something to be DONE, not just looked at differently. It joins the
  // tracked list so the status line stays the whole record of what was handed over, and so a replay
  // leg renders it as an instruction rather than as data. The caller screens it first (the approval
  // gate's lexicon) — this function never decides what may be mandated, only remembers it.
  if (engineActions.length) entry.engineActions = [...(entry.engineActions ?? []), ...engineActions];
  // The leg is over even though the task is not: the engine has nothing left to fold this into.
  // Both this and the unsupported answer leave the addition unapplied, which the follow-up reads.
  if (entry.legEnded) {
    logged.delivery = 'never';
    return 'already_done';
  }
  if (entry.engineRun) return 'ready';
  if (entry.steerUnreachable) {
    logged.delivery = 'never';
    return 'unsupported';
  }
  entry.pendingSteers = [...(entry.pendingSteers ?? []), trimmed];
  return 'queued';
}

/** Everything this run was asked to DO — what it was delegated with, plus anything a steer added
 *  since. The registry is the authority: the OpsTask object the orchestrator holds was built before
 *  any of the additions existed, so a second leg reads the list from here rather than from itself.
 *  Empty for a gone or cancelled entry, and for every run that was asked for nothing done. */
export function getOpsEngineActions(chatId: string, taskId: string): string[] {
  const entry = inFlight.get(chatId)?.get(taskId);
  return entry && !entry.cancelled ? [...(entry.engineActions ?? [])] : [];
}

/** What the user added that never reached a leg (the 'never' entries of InFlightEntry.steerLog), in
 *  the order they said it. Empty for a gone or cancelled entry, and for every run whose additions
 *  all landed. */
export function getUnappliedSteers(chatId: string, taskId: string): string[] {
  const entry = inFlight.get(chatId)?.get(taskId);
  return entry && !entry.cancelled ? (entry.steerLog ?? []).filter(s => s.delivery === 'never').map(s => s.text) : [];
}

/** Take (and clear) the steers still awaiting delivery — a HAND-OFF, so a second call returns
 *  nothing and two drainers can never send the same addition twice. Empty for a gone or cancelled
 *  entry: a run nobody is waiting on has nothing to be told. */
export function takePendingSteers(chatId: string, taskId: string): string[] {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled || !entry.pendingSteers?.length) return [];
  const queued = entry.pendingSteers;
  entry.pendingSteers = [];
  return queued;
}

/** Clear a single finished task. Call from runOpsAndFollowUp's finally, AFTER the result handoff.
 *  `ended` says how it went, for the recently-ended list: 'delivered' when a follow-up reached them,
 *  'failed' when none did. A cancelled run was already noted as cancelled when it was stopped. */
export function markOpsDone(chatId: string, taskId: string, ended: 'delivered' | 'failed' = 'delivered'): void {
  const byTask = inFlight.get(chatId);
  if (!byTask) return;
  const entry = byTask.get(taskId);
  if (entry && !entry.cancelled) noteEnded(chatId, taskId, entry, ended);
  const had = byTask.delete(taskId);
  if (byTask.size === 0) inFlight.delete(chatId);
  // Only when an entry actually existed: a second markOpsDone (or one for a task this process never
  // held) must not write a row, and must not re-settle one another process already closed out.
  if (had && taskSink) {
    try { taskSink.onDone({ chatId, taskId }); }
    catch { /* durable state is best-effort */ }
  }
}

export interface ActiveOps {
  taskId: string;
  kind: TaskKind;
  request: string;
  startedAt: number;
  firstStartedAt: number;
  origin?: 'scheduled';
  lastMilestone?: string;
  milestoneAt?: number;
  estimateMs?: number;
  estimatePhrase?: string;
  /** What the user added to this ask mid-run, in the order they said it. ABSENT rather than empty
   *  when nobody added anything, so an ordinary run's status line — and the prompt budget pinned to
   *  it — stays exactly the bytes it was. */
  steers?: string[];
  /** The same additions with where each one got (InFlightEntry.steerLog), so the status line can say
   *  which reached the look. Present exactly when `steers` is. */
  steerLog?: SteerLogEntry[];
  /** What the user asked the engine to DO as part of this ask, in the order they asked. ABSENT
   *  rather than empty for the same reason `steers` is — the status line's bytes, and the prompt
   *  budget pinned to them, must not move for a run that was asked for no action. */
  engineActions?: string[];
}

/** Snapshot of research currently running for this chat (stale and cancelled entries filtered out —
 *  a cancelled task must stop reading as "still pulling" the moment the user killed it). */
export function getActiveOps(chatId: string, now: number = Date.now()): ActiveOps[] {
  const byTask = inFlight.get(chatId);
  if (!byTask) return [];
  const staleMs = opsStaleMs();
  return [...byTask.entries()]
    .filter(([, e]) => now - e.startedAt - (e.graceMs ?? 0) < staleMs && !e.cancelled)
    .map(([taskId, e]) => ({ taskId, kind: e.kind, request: e.request, startedAt: e.startedAt, firstStartedAt: e.firstStartedAt, origin: e.origin, lastMilestone: e.lastMilestone, milestoneAt: e.milestoneAt, estimateMs: e.estimateMs, estimatePhrase: e.estimatePhrase, ...(e.steerLog?.length ? { steers: e.steerLog.map(s => s.text), steerLog: e.steerLog.map(s => ({ ...s })) } : {}), ...(e.engineActions?.length ? { engineActions: [...e.engineActions] } : {}) }));
}

// ── Recently ended ──────────────────────────────────────────────────────────────────────────────
// A run leaves getActiveOps the moment it is stopped or finishes, and with it the only thing that
// told the next turn it existed. "Did you stop it?", or a second stop for the same look, then read
// against nothing at all: the model could not tell a run dropped a minute ago from one that never
// started. So the last few endings stay readable for a short while, in memory like the rest of this
// module (a restart forgets them, which is right: a new process never ran them).

export type OpsEnding = 'cancelled' | 'delivered' | 'failed';

export interface EndedOps {
  taskId: string;
  request: string;
  /** How it ended: stopped at their word, a follow-up delivered, or over with nothing delivered. */
  ended: OpsEnding;
  at: number;
  origin?: 'scheduled';
}

/** How long an ended run stays readable. */
export const RECENTLY_ENDED_MS = 15 * 60_000;
/** The most endings kept per chat; the oldest goes first. */
const MAX_RECENTLY_ENDED = 5;

function noteEnded(chatId: string, taskId: string, entry: InFlightEntry, ended: OpsEnding): void {
  const now = Date.now();
  const kept = (recentlyEnded.get(chatId) ?? []).filter(e => now - e.at < RECENTLY_ENDED_MS && e.taskId !== taskId);
  kept.push({ taskId, request: entry.request, ended, at: now, ...(entry.origin ? { origin: entry.origin } : {}) });
  recentlyEnded.set(chatId, kept.slice(-MAX_RECENTLY_ENDED));
}

/** The runs of this chat that ended in the last RECENTLY_ENDED_MS, oldest first. */
export function getRecentlyEndedOps(chatId: string, now: number = Date.now()): EndedOps[] {
  const live = (recentlyEnded.get(chatId) ?? []).filter(e => now - e.at < RECENTLY_ENDED_MS);
  if (live.length) recentlyEnded.set(chatId, live);
  else recentlyEnded.delete(chatId);
  return live.map(e => ({ ...e }));
}

// ── Ids ─────────────────────────────────────────────────────────────────────────────────────────
// A lookup and a parked action are shown with a short id the model can copy back, the way a reminder
// is (convo/liveReminders.ts shortReminderId): a letter for what it is, then the first six characters
// of the ops task id with a UUID's dashes dropped. The letter keeps the kinds apart in one reply, and
// resolveRef reads the short id back to the full one.

/** What a short id is a prefix of: the task id with a UUID's dashes dropped. */
export function opsRefKey(id: string): string {
  return id.replace(/-/g, '');
}

/** The id a running lookup is shown and addressed by. */
export function shortLookupId(taskId: string): string {
  return `L${opsRefKey(taskId).slice(0, 6)}`;
}

/** The id an action parked behind their approval is shown and addressed by (its ops_tasks row). */
export function shortApprovalId(rowId: string): string {
  return `A${opsRefKey(rowId).slice(0, 6)}`;
}

/**
 * Kind-agnostic "is THIS exact ask running right now?" — matches on the normalized request text
 * alone, across any TaskKind. The Autonome scheduler uses this before firing a needsOps job: the
 * row's opsKind and the kind Convo's model picked for the same wording routinely differ, so the
 * kind-scoped isDuplicateDelegation would miss the overlap. Full-request equality makes cross-kind
 * false positives negligible. Same freshness/cancel filters as getActiveOps.
 */
export function hasInFlightRequest(chatId: string, request: string, now: number = Date.now()): boolean {
  const byTask = inFlight.get(chatId);
  if (!byTask) return false;
  const staleMs = opsStaleMs();
  const norm = request.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const e of byTask.values()) {
    if (now - e.startedAt - (e.graceMs ?? 0) < staleMs && !e.cancelled && e.request.trim().toLowerCase().replace(/\s+/g, ' ') === norm) return true;
  }
  return false;
}

/**
 * Deterministic dedup signal for the delegate path:
 *  - 'in_flight': an identical ask is running RIGHT NOW (never run it twice).
 *  - 'recent':    an identical ask was delegated within RECENT_DELEGATION_MS and has finished.
 *  - null:        no recent identical ask.
 * The caller decides what to do (the two-strike refinement path must NOT be suppressed).
 */
export function isDuplicateDelegation(chatId: string, kind: string, request: string, now: number = Date.now()): 'in_flight' | 'recent' | null {
  const key = normalizeRequest(kind, request);
  const staleMs = opsStaleMs();
  const byTask = inFlight.get(chatId);
  if (byTask) {
    for (const e of byTask.values()) {
      // A cancelled run doesn't block a re-ask — "actually, run it again" must start fresh.
      if (e.normKey === key && now - e.startedAt - (e.graceMs ?? 0) < staleMs && !e.cancelled) return 'in_flight';
    }
  }
  const at = recentlyDelegated.get(chatId)?.get(key);
  if (at && now - at < RECENT_DELEGATION_MS) return 'recent';
  // Last: the durable twin, which is the only one that still remembers anything after a restart.
  // Asked ONLY on a miss, so nothing about the in-memory answer changes, and asked with the request
  // so a run stranded in this chat cannot make an unrelated ask read as already running.
  if (taskSink) {
    try { if (taskSink.isRunningElsewhere(chatId, request)) return 'in_flight'; }
    catch { /* durable state is best-effort — fall through to "no duplicate" */ }
  }
  return null;
}

function prune(chatId: string): void {
  const ring = recentlyDelegated.get(chatId);
  if (!ring) return;
  const now = Date.now();
  for (const [k, at] of ring) if (now - at >= RECENT_DELEGATION_MS) ring.delete(k);
  if (ring.size === 0) recentlyDelegated.delete(chatId);
}

/** Test-only: wipe all coordination state, sink included — the shape of a restart. */
export function __resetOpsCoordination(): void {
  inFlight.clear();
  recentlyDelegated.clear();
  recentlyEnded.clear();
  taskSink = null;
}
