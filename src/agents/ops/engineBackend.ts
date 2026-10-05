// The engine seam. Irises keeps only the persona layer (Convo/Composer/Fallfirm/Classify);
// ALL deep work — research, email, media reads, scheduling, long-term memory — runs on an external
// engine (hermes-agent or OpenClaw) that this module dispatches to. The engine is deliberately
// UNMODIFIED upstream software: adapters speak only its public API (hermes: the OpenAI-compatible
// API server; OpenClaw: the Gateway WS `agent` RPC). There is NO native fallback — when the engine
// is unreachable the task fails honestly (Fallfirm voices the snag) and Convo keeps chatting.
import { record } from '../../diagnostics/trace.js';
import { HermesBackend } from './hermesBackend.js';
import { OpenClawBackend } from './openclawBackend.js';
// The in-flight map is where a run handle has to land for a LATER turn's steer_research to find it.
// Cyclic with this module (opsCoordination derives its staleness horizon from the leg budgets
// declared here), which ESM resolves fine because neither side calls into the other at module
// scope — both only ever read the other from inside a function.
import {
  noteOpsEngineRun, takePendingSteers, beginOpsEngineLeg, endOpsEngineLeg, noteOpsSteerUnreachable,
  noteSteerDelivery,
} from '../../state/opsCoordination.js';
import { steerWithRetry } from './steer.js';
import type { OpsTask, OpsResult, OpsDebrief, OpsFailureCause } from '../types.js';

// ── contract every adapter implements ────────────────────────────────────────

/** The ENGINE's own name for one in-flight run — the only thing that can be stopped or steered
 *  after dispatch. It exists solely for a transport that registers runs server-side (hermes's
 *  `POST /v1/runs` → `run_id`); an adapter whose transport has no such id simply never publishes
 *  one, and every control built on it degrades to "we can only drop it locally". */
export type EngineRunHandle = { engine: 'hermes' | 'openclaw'; runId: string };

/** How long a run may sit waiting on the user's answer to an engine's dangerous-command ask:
 *  hermes's own `approvals.timeout` default (300s, after which IT refuses the command) plus a
 *  margin, so our give-up never lands before the engine's own answer does. */
export const ENGINE_APPROVAL_WAIT_MS = 315_000;

/** One dangerous command the engine paused on mid-run, waiting for the user (hermes's
 *  `approval.request`). The command arrives already redacted by the engine. */
export interface EngineApprovalRequest {
  handle: EngineRunHandle;
  command: string;
  description: string;
}

/** Milestone/abort plumbing threaded from the orchestrator through runTask into the adapter. */
export interface EngineRunContext {
  onProgress?: (milestoneKey: string) => void;
  signal?: AbortSignal;
  /** This ONE call's transport budget, overriding the adapter's module-wide ENGINE_TIMEOUT_MS.
   *  Set only by a caller that knows this leg is wider than the standard one — today the walled-URL
   *  browser budget (ops/client.ts). Absent means "the standard window", byte for byte as before. */
  timeoutMs?: number;
  /** Called ONCE, as early as the transport can say it, with the engine's handle for this run.
   *  Synchronous and best-effort by contract: `runViaEngine` uses it to register the handle so a
   *  mid-run steer has something to aim at, and the adapter MUST NOT let a throwing hook kill the
   *  run it just started. */
  onRunHandle?: (handle: EngineRunHandle) => void;
  /** Called when this run will NEVER have a handle — the adapter took a transport that carries no
   *  run id (hermes's chat completions). Same synchronous, best-effort contract as `onRunHandle`,
   *  and mutually exclusive with it: an adapter says one or the other, as early as it can.
   *  `runViaEngine` uses it so a mid-run steer is answered honestly ('unsupported') instead of
   *  queued against a handle that is never coming. */
  onNoRunHandle?: () => void;
  /** Steer text the engine ACCEPTED but never applied — it landed after the final model response.
   *  Reported on the terminal event so the caller can replay it as its own leg instead of losing
   *  what the user asked for (hermes calls this `pending_steer`). */
  onPendingSteer?: (text: string) => void;
  /** The engine paused this run on a dangerous command and is waiting for the user's answer.
   *  Synchronous and best-effort, like `onRunHandle`: the adapter guards the call. Present means the
   *  caller relays the ask (OPS_ENGINE_APPROVAL_RELAY), so the adapter also holds its give-up for the
   *  wait; absent means the frame is ignored, exactly as before the relay existed. */
  onApprovalRequest?: (req: EngineApprovalRequest) => void;
  /** The wait `onApprovalRequest` opened is over: 'answered' when the engine confirmed an answer,
   *  'expired' when the run moved on without one (its own window closed, the run ended, or our view
   *  of it was lost). Exactly once per request. Same synchronous, best-effort contract. */
  onApprovalSettled?: (handle: EngineRunHandle, how: 'answered' | 'expired') => void;
}

/** A reminder/automation living ON THE ENGINE (its cron owns scheduling; Irises holds no rows). */
export interface ReminderSpec {
  chatId: string;
  agentHandle: string;
  instruction: string;   // what to do/say when it fires — the engine's job prompt is built from this
  cron?: string;         // recurring: standard 5-field cron
  fireAt?: number;       // one-time: epoch ms (adapters convert; exactly one of cron/fireAt)
  title?: string;
  // IANA zone the CRON's wall clock is expressed in (the user's zone, not the host's). Adapters
  // whose cron runs in the engine's own zone shift the fields by the offset difference; without it
  // "every weekday at 8am" fires at the engine's 8am. Ignored for fireAt (an absolute instant).
  timezone?: string;
}

export interface ReminderRef {
  id: string;
  title: string;
  schedule: string;      // human-readable-ish schedule the engine reported back
  // Everything below is OPTIONAL and hermes-shaped: an adapter that can't answer one simply omits
  // it, and a caller that only ever read `schedule`/`id`/`title` sees no change at all.
  /** The engine's own schedule shape, when it reported one. Absent when only the legacy bare-string
   *  `schedule` was seen (older fixtures, or an engine that doesn't distinguish). */
  kind?: 'cron' | 'once';
  /** The 5-field cron expression, present when `kind === 'cron'`. */
  expr?: string;
  /** The one-time fire instant, present when `kind === 'once'`. Kept as the engine's own
   *  ISO-with-offset string rather than converted to epoch ms — every consumer only ever DISPLAYS
   *  it (an Intl formatter reads an offset string directly), so there is nothing arithmetic to gain
   *  from converting it, and converting would be one more place a bad offset could get lost. */
  runAt?: string;
  /** The next time this job is due to fire, same ISO-with-offset string representation as `runAt`.
   *  Absent when the engine didn't report one (a paused job, or an engine that omits it). */
  nextRunAt?: string;
  /** When the job was created, same ISO-with-offset string representation. */
  createdAt?: string;
  /** The user's original reminder text, recovered from the job's own delivery prompt
   *  (hermesBackend's `parseReminderInstruction`) — the engine's jobs API reports schedule fields,
   *  never what the reminder is ABOUT, so this is the only place that text still lives once the job
   *  exists. Absent for a job whose prompt wasn't built by `reminderJobPrompt` (hand-created on the
   *  engine, or an older shape). */
  instruction?: string;
}

/** What `updateReminder` may change on an existing reminder — the engine seam's replacement for a
 *  caller cancelling and recreating one, so a later tool (`update_automation`) can revise a
 *  reminder as ONE call instead of two, and never loses the job in between.
 *
 *  `chatId` rides every patch (not just a create) because the adapter may need to rebuild the job's
 *  NAME (from the title) or its delivery PROMPT (from the instruction), both of which are keyed to
 *  the chat. `scheduleKind` is present only when the caller wants the schedule's SHAPE to change
 *  (cron ↔ once) — a plain reschedule within the same shape (a new cron expression, or a new
 *  `fireAt` on an existing one-shot) omits it and rides the in-place update path. */
export interface ReminderPatch {
  chatId: string;
  agentHandle?: string;
  title?: string;
  instruction?: string;
  /** Present only for a kind change (cron ↔ once) — see the interface doc above. */
  scheduleKind?: 'cron' | 'once';
  cron?: string;
  fireAt?: number;
  timezone?: string;
}

/** `updateReminder`'s outcome. A closed set rather than a thrown error for the three cases a caller
 *  needs to tell apart to answer the user honestly: the id named a job that is gone (`not_found`),
 *  the patch itself couldn't be applied (`invalid` — nothing to change, a kind change missing its
 *  new schedule, or the engine's own validation, e.g. moving a one-shot into the past), or the
 *  engine couldn't be reached at all or has no such route (`unreachable`: a 404 that is not the
 *  engine's own "job not found" says nothing about the job). Anything else (auth, rate limit) still throws
 *  EngineRunError, exactly as every other call on this interface does. */
export type ReminderUpdateResult =
  | { ok: true; ref: ReminderRef }
  | { ok: false; reason: 'not_found' | 'invalid' | 'unreachable' };

export interface ProbeResult { ok: boolean; detail?: string; }

/** The closed, CODE-OWNED vocabulary of deep-work action-classes Convo reasons about. An engine's
 *  raw capability/tool manifest is normalized ONTO this fixed set adapter-side, and NOTHING else
 *  ever reaches a prompt — raw manifest text stays out of the model entirely (that removes both the
 *  prompt-injection hazard and the cache-shape churn a free-form string would cause). */
export type CapabilityClass = 'web' | 'inbox' | 'files' | 'code' | 'media' | 'scheduling';

/** Canonical render order for the closed vocabulary. Declared ONCE here because its whole job is
 *  cross-file identity: a summary must read identically whichever adapter produced it (cache-friendly
 *  for the per-turn prompt line built from it), and a seventh class added to a per-adapter copy would
 *  type-check while silently leaving the other adapter's order wrong. */
export const CAP_ORDER: readonly CapabilityClass[] = ['web', 'inbox', 'files', 'code', 'media', 'scheduling'];

/** What the active engine can actually do THIS deployment, as the closed-vocabulary set above.
 *  Consumed ONLY to shape Convo's per-turn brief (so it never promises what the engine lacks); it
 *  is deliberately never fed into the engine-facing task prompt — Hermes knows its own tools, and a
 *  stale cache must not contradict it mid-run.
 *
 *  That rule survived the walled-URL hint (see ./walledUrls.ts), which DOES gate bytes in the task
 *  prompt: it reads `hasBrowserTooling()` below, not this summary. Two reasons, both worth keeping
 *  if a third such gate ever shows up. (a) Grain: `web` here is a superset — the class table folds
 *  browser, fetch, http, crawl and scrape into it — so this summary cannot answer "is there a
 *  browser" at all. (b) Blast radius: a gate on the closed vocabulary would make every prompt-shape
 *  question depend on the cache that Convo's phrasing already depends on. Keep engine-facing gates
 *  on their own narrow probes. */
export interface CapabilitySummary {
  classes: CapabilityClass[];
  /** `false` when the manifest carried tokens the adapter could not classify — i.e. the class list is
   *  a floor, not an inventory. Absent means fully understood (an operator declaration always is).
   *  The distinction is load-bearing downstream: only a fully-understood manifest may turn a MISSING
   *  class into a positive claim about the deployment ("their inbox isn't connected"). */
  complete?: boolean;
}

/** The engine went AWAY (unreachable / unconfigured / connection refused) — distinct from "the
 *  engine ran and failed". Callers voice it as a transient snag; nothing retries automatically. */
export class EngineUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) { super(message); this.name = 'EngineUnavailableError'; }
}

/** The engine answered the transport but the RUN failed (rate limit, auth, its own error). */
export class EngineRunError extends Error {
  constructor(message: string, public readonly failureCause: OpsFailureCause, public readonly status?: number) {
    super(message); this.name = 'EngineRunError';
  }
}

export interface EngineBackend {
  readonly name: 'hermes' | 'openclaw';
  /** One deep-work run: prompt in, final answer text out. The adapter owns transport, per-chat
   *  session continuity, media mapping (task.media), and its own request timeout. Throws
   *  EngineUnavailableError / EngineRunError; never returns partial output. */
  runTask(prompt: string, task: OpsTask, ctx: EngineRunContext): Promise<string>;
  /**
   * ADD to a run that is already going — the user narrowed it, corrected it, or thought of one more
   * thing — without dropping the work already done. `handle` is what `EngineRunContext.onRunHandle`
   * published for this run.
   *
   * `'accepted'` means the engine took the text; it is folded in at the next tool result or
   * pre-model call, so it never interrupts and may still land too late to act on (that case comes
   * back through `onPendingSteer`). `'not_running'` means the run is not in a steerable state —
   * still constructing its agent, already finalizing, stopping, or gone. That distinction is the
   * whole value of the return type: `'not_running'` during the construction window is worth
   * retrying (see ./steer.ts), an error is not.
   *
   * Optional the way `channelTyping` is: an engine with no steer route simply omits it, and the
   * caller says so honestly rather than pretending the addition was delivered.
   */
  steerRun?(handle: EngineRunHandle, text: string, opts?: { signal?: AbortSignal }): Promise<'accepted' | 'not_running'>;
  /** Answer a dangerous-command ask the run is waiting on (see `onApprovalRequest`). 'once' lets that
   *  ONE command run; 'not_pending' is a run no longer waiting (its own timeout refused it, or it
   *  ended); 'failed' is a transport error. Never throws. Optional: an engine without mid-run
   *  approvals has no method. */
  resolveRunApproval?(handle: EngineRunHandle, choice: 'once' | 'deny'): Promise<'resolved' | 'not_pending' | 'failed'>;
  createReminder(spec: ReminderSpec): Promise<ReminderRef>;
  /** `timeoutMs` overrides the adapter's own default request budget — optional, same DI convention
   *  as `EngineRunContext.timeoutMs`; a caller that doesn't pass it gets the adapter's standard
   *  window. */
  listReminders(chatId: string, opts?: { timeoutMs?: number }): Promise<ReminderRef[]>;
  cancelReminder(id: string): Promise<boolean>;
  /**
   * Revise a reminder ALREADY on the engine — its title, instruction, or schedule — as one call, so
   * a caller never has to cancel and recreate just to fix a typo or nudge a time. Optional the same
   * way `steerRun` is: a backend without it simply omits the method, and existing hand-written test
   * stubs keep compiling.
   */
  updateReminder?(id: string, patch: ReminderPatch): Promise<ReminderUpdateResult>;
  /** ASK the engine to update its own memory (scoped to this chat's engine session). The
   *  engine owns the decision — Irises never writes engine storage directly, and the same
   *  channel carries update, correction, and forget requests (see docs/ENGINES.md, "Memory
   *  boundary"). The reverse direction does not exist: engines have no path into Irises's
   *  own tiers. */
  remember(chatId: string, agentHandle: string, note: string): Promise<void>;
  probe(): Promise<ProbeResult>;
  /** The engine's current action-classes (closed vocabulary), or null when unknown/undiscovered.
   *  MUST be synchronous and NON-BLOCKING: return the last-known cached value immediately and never
   *  perform (or await) a fetch on the calling path — the per-turn Convo prompt build reads this, so
   *  any latency here lands on a user turn. The adapter refreshes the cache in the background.
   *  Optional: a backend that hasn't wired capability discovery simply omits it. */
  getCapabilitySummary?(): CapabilitySummary | null;
  /**
   * Does this deployment have a REAL browser toolset — one that can navigate to a URL and read the
   * rendered page? `true`/`false` when the adapter has seen a manifest that answers; `undefined`
   * when nobody can say yet (a cold discovery cache, an engine that is down, an adapter with no
   * probe). Same synchronous NON-BLOCKING contract as getCapabilitySummary above.
   *
   * Deliberately NOT a seventh CapabilityClass: `web` there is a superset by design (it folds
   * fetch/http/crawl in with browser), and Convo's brief neither needs nor should carry the finer
   * grain. This exists because ONE engine-facing decision does need it — the walled-URL `tooling:`
   * hint and its retry escalation (./walledUrls.ts), which name browser_navigate / browser_snapshot
   * and are worthless (the hint) or wasteful (a whole extra engine leg) on a box with only
   * web_search. `undefined` is never a promise: it degrades to the pre-hint behavior.
   *
   * A stale answer is tolerable in BOTH directions, which is what makes this safe to read into a
   * task prompt at all: stale-false only suppresses a suggestion (today's bytes), and stale-true
   * leaves a suggestion the engine can ignore — neither contradicts the engine about its own tools.
   */
  hasBrowserTooling?(): boolean | undefined;
  /** Which engine session a call for this chat would ride right now, and the rotation window that
   *  named it — for the `engine:*:start` receipt, so a degraded run can be attributed to the
   *  transcript it ran inside (engine sessions rotate: `engineSession.ts`). MUST be synchronous,
   *  pure-ish and cheap (it runs per dispatch). Optional: an adapter without it simply records no
   *  session on the receipt, exactly as before.
   *
   *  Asked here, at dispatch — a hair before the adapter stamps its own request — so a run that
   *  straddles a rotation boundary can record the window either side of it. The adapters say so at
   *  their own implementation; nothing downstream should treat this as a proof of what was sent. */
  sessionDescriptor?(chatId: string): { session: string; rotation: string };
  /** Deliver the engine-mode doctrine ONCE, as a chat message the engine folds into its own durable
   *  instructions by its own hand (Irises never edits engine files). `version` is the doctrine's
   *  content hash, so the adapter can key its idempotency on it; returns the engine's reply text.
   *  Optional in the type, implemented by BOTH adapters today — engineOnboarding.ts only runs for an
   *  engine that has it. Where the transport carries no idempotency key (hermes), the doctrine text's
   *  own replace-by-heading ask is the guard against a duplicate append. */
  sendOnboarding?(text: string, version: string): Promise<string>;
  /** ONE utility agent run that belongs to no chat: text in, the engine's reply text out. `tag` names
   *  its own engine session (code-owned, never a user string), so the exchange stays out of every
   *  chat's continuity AND out of every chat's engine-side memory scope — same transport as
   *  sendOnboarding, and optional the same way: a backend without it simply skips the features that
   *  need to ask (firstMove.ts). `timeoutMs` defaults to the doctrine send's generous budget, because
   *  what gets asked here is a real tool run on the engine's side. Throws EngineUnavailableError /
   *  EngineRunError like everything else on this interface; never returns empty. */
  askEngine?(text: string, opts: { tag: string; timeoutMs?: number }): Promise<string>;
  /** Bridge mode: deliver a message THROUGH one of the engine's own channel connections
   *  (the engine keeps owning the bot/number; Irises fronts it — see docs/ENGINES.md).
   *  `platform` is the engine's channel name (telegram/whatsapp/discord/…), `chatId` the raw
   *  platform chat id. Throws EngineUnavailableError/EngineRunError like runTask.
   *  Returns the PLATFORM's own message id when the engine reports one — the bridge channel
   *  stores it so a later tapped reply on that bubble resolves back to what Irises said
   *  (recordSentBubble → resolveTappedReply). `{}` when the engine can't tell us. */
  channelSend(platform: string, chatId: string, text: string, opts?: { threadId?: string; replyToId?: string }): Promise<{ messageId?: string }>;
  /** Bridge typing: best-effort typing / chat-action THROUGH the engine's own channel adapter, using a
   *  primitive the adapter ALREADY exposes (feature-detected in the bridge plugin — no engine-core
   *  change). Fire-and-forget semantics: MUST never throw on the caller's path (typing must never break
   *  or delay a turn) and MUST bypass the engine-run semaphore (like a lightweight side channel, not an
   *  agent run). No-ops safely when the adapter/gateway lacks the capability. Optional: a backend
   *  without it means "no bridge typing" — bridgeChannel.startTyping short-circuits on `!channelTyping`. */
  channelTyping?(platform: string, chatId: string, state: 'start' | 'stop', opts?: { threadId?: string }): Promise<void>;
  /** Bridge unsend: take back one of Irises's own messages through the engine's channel adapter.
   *  True only when the platform confirmed it. MUST never throw. Optional: absent means no unsend. */
  channelUnsend?(platform: string, chatId: string, messageId: string): Promise<boolean>;
}

// ── dispatch ──────────────────────────────────────────────────────────────────

/**
 * Parse a millisecond number or a human-friendly duration string into milliseconds.
 * Supports units: d/days, h/hours, m/mins/minutes, s/secs/seconds, ms.
 * Non-positive, non-finite, empty or invalid strings return null.
 */
export function parseDurationMs(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const str = raw.trim().toLowerCase();
  if (!str) return null;

  // Direct numeric representation (e.g. '240000', '600000')
  const num = Number(str);
  if (Number.isFinite(num)) {
    return num > 0 ? num : null;
  }

  // Human duration syntax: e.g. '7d', '3 days', '24h', '30m', '45s', '1000ms'
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|ms)$/);
  if (!match) return null;

  const val = parseFloat(match[1]);
  const unit = match[2];
  let multiplier = 1;
  if (unit.startsWith('d')) multiplier = 86_400_000;
  else if (unit.startsWith('h')) multiplier = 3_600_000;
  else if (unit.startsWith('m') && unit !== 'ms') multiplier = 60_000;
  else if (unit.startsWith('s')) multiplier = 1_000;
  else if (unit === 'ms') multiplier = 1;

  const res = val * multiplier;
  return Number.isFinite(res) && res > 0 ? res : null;
}

/**
 * Per-call budget: the transport request must give up BEFORE the orchestrator's own
 * OPS_TASK_TIMEOUT_MS deadline abandons the run, so the failure is a clean mapped result
 * (not a DeadlineError synthetic) whenever the engine is merely slow to say no.
 *
 * An explicit ENGINE_TIMEOUT_MS is taken as written (the operator's word is final). Otherwise the
 * derived value is clamped on BOTH sides: the old `max(30s, orch − 15s)` floor overshot the
 * orchestrator whenever OPS_TASK_TIMEOUT_MS was tuned below 45s (a 20s orchestrator deadline got a
 * 30s transport timeout — the deadline always won, and every slow engine looked like a synthetic
 * DeadlineError instead of a mapped timeout).
 */
export function computeEngineTimeoutMs(env: NodeJS.ProcessEnv, legBudgetMs?: number): number {
  const parsed = parseDurationMs(env.ENGINE_TIMEOUT_MS);
  const explicit = parsed ?? Number(env.ENGINE_TIMEOUT_MS);
  const standard = Number.isFinite(explicit) && explicit > 0
    ? explicit
    : transportWindowFor(standardLegBudgetMs(env));
  // A leg the caller widened deliberately (the walled-URL browser budget) needs a transport window
  // derived from ITS deadline, not from the standard one — the found bug is a 15-minute browser leg
  // cut at 225s with the finished answer lost to the aborted client. `max`, so this can only ever
  // widen: an operator's own bigger ENGINE_TIMEOUT_MS still stands, and no leg budget at all leaves
  // the number exactly as it was.
  if (!legBudgetMs || !Number.isFinite(legBudgetMs)) return standard;
  return Math.max(standard, transportWindowFor(legBudgetMs));
}

/** The transport window that sits INSIDE a leg deadline of `legMs`: give up ~15s early so the
 *  failure is a clean mapped result rather than the orchestrator's synthetic DeadlineError, clamped
 *  on both sides for the small-deadline case computeEngineTimeoutMs documents above. */
function transportWindowFor(legMs: number): number {
  return Math.min(Math.max(30_000, legMs - 15_000), Math.max(5_000, legMs - 5_000));
}

export const ENGINE_TIMEOUT_MS = computeEngineTimeoutMs(process.env);

/** The orchestrator's per-leg deadline for an ORDINARY task — `OPS_TASK_TIMEOUT_MS`, four minutes
 *  by default. Declared here, beside the transport window derived from it, so the deadline and the
 *  window can never be read two different ways; the orchestrator holds it as a module constant, and
 *  `computeEngineTimeoutMs` above derives its own window through this function rather than reading
 *  the var a second time. Being the ONE reading is why the fallback is total: empty, junk or a
 *  zero/negative window all read as the documented four minutes, so nothing derived from this — the
 *  transport window, the staleness horizon in state/opsCoordination.ts — can inherit a NaN. */
export function standardLegBudgetMs(env: NodeJS.ProcessEnv): number {
  const ms = parseDurationMs(env.OPS_TASK_TIMEOUT_MS);
  return ms ?? 4 * 60_000;
}

/** The leg budget a walled-URL browser task gets when `OPS_BROWSER_TASK_TIMEOUT_MS` is switched on
 *  without a number of its own: 15 minutes, the window the live Instagram re-tests actually needed
 *  (~6–15 min of browser work, cut at ~225s). */
export const BROWSER_LEG_BUDGET_MS = 900_000;

/**
 * The wider leg budget for a task the engine was told to open a browser for, or `null` when the
 * standard budget applies.
 *
 * The env var IS the flag: unset (or `off`/`0`/junk) means every leg keeps the deadline and the
 * transport window it has today, byte for byte. A number is taken as written — the operator's word
 * is final, as with ENGINE_TIMEOUT_MS above — and the switch-on words `threadingEnabled()` accepts
 * (`on`/`true`/`yes`/`1`) arm the documented BROWSER_LEG_BUDGET_MS default. `1` reads as the switch
 * rather than as one millisecond on purpose: it is the value an operator copying the other flags
 * types, and a one-millisecond browser window is not a thing anyone means.
 *
 * Pure: the env is injected, so the caller decides when it is read.
 */
export function browserLegBudgetMs(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.OPS_BROWSER_TASK_TIMEOUT_MS || '').trim().toLowerCase();
  if (raw === '') return null;
  if (['true', 'on', 'yes', '1'].includes(raw)) return Math.max(BROWSER_LEG_BUDGET_MS, standardLegBudgetMs(env));
  const parsed = parseDurationMs(raw);
  return parsed ?? null;
}

/** The mid-flight-cancel gate (env: OPS_CANCEL_ENGINE_ABORT). Default ON, read at CALL time — the
 *  same parse shape as every sibling flag (threadingEnabled, opsDurableTasksEnabled).
 *
 *  It lives HERE rather than in one adapter because BOTH adapters now answer to it: OpenClaw's
 *  wrapper-side abort + notify RPC, and hermes's `POST /v1/runs/{id}/stop` on either give-up. Off ⇒
 *  each adapter behaves exactly as it did before its own cancel path existed: the run is dropped
 *  locally and the engine is never told. */
export function opsCancelEngineAbortEnabled(): boolean {
  const v = (process.env.OPS_CANCEL_ENGINE_ABORT || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** The engine approval relay (env: OPS_ENGINE_APPROVAL_RELAY, docs/CONFIGURATION.md). Default ON,
 *  read at CALL time, the same parse shape as opsCancelEngineAbortEnabled. Off is the behaviour
 *  before the relay: the orchestrator hooks nothing, so an `approval.request` is ignored, no clock
 *  moves, no marker is written, and no reply is read as an answer to one. */
export function engineApprovalRelayEnabled(): boolean {
  const v = (process.env.OPS_ENGINE_APPROVAL_RELAY || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * How long a run may sit in the engine-slot queue below before it gives up and fails honestly.
 *
 * This bound is load-bearing, not a nicety. A QUEUED run is completely invisible: it has not
 * contacted the engine, emitted no `engine:*:start`, opened no socket. An unbounded wait here is
 * therefore a SILENT hang — the delegation logs "Delegating …" and then nothing observable ever
 * happens, which is exactly the failure this bound converts into a mapped 'timeout' the
 * orchestrator's triage can voice.
 *
 * Half the per-call transport budget by default: a run that has already burned that long waiting
 * for a slot is behind a pathologically slow (or leaked) run, and still needs time to actually
 * execute before the orchestrator's own OPS_TASK_TIMEOUT_MS abandons it.
 */
export function computeEngineQueueWaitMs(env: NodeJS.ProcessEnv): number {
  const explicit = Number(env.ENGINE_QUEUE_WAIT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(5_000, Math.round(computeEngineTimeoutMs(env) / 2));
}

// FIFO semaphore over engine AGENT RUNS — a burst of delegations must not stampede the engine
// (hermes's API server caps concurrent runs; OpenClaw serializes per session anyway). It covers
// runViaEngine and the fire-and-forget memory asks (withEngineSlot). Deliberately NOT covered:
// reminder CRUD (15s REST calls, not agent runs — they must stay snappy) and channelSend (a reply
// already composed must never queue behind two long runs).
// Default 3 concurrent engine runs. Keep it modest and matched to the engine's OWN concurrent-run
// cap: hermes 429s past its limit (mapped to 'rate_limited'), so raising this blindly just trades a
// queue wait for a hard failure. Override with ENGINE_MAX_CONCURRENT.
const MAX_CONCURRENT = Number(process.env.ENGINE_MAX_CONCURRENT) || 3;
let active = 0;
const waiters: Array<() => void> = [];

/** Snapshot of the slot pool — for the `engine:*:queued` trace and for tests. */
export function engineSlotState(): { active: number; waiting: number; cap: number } {
  return { active, waiting: waiters.length, cap: MAX_CONCURRENT };
}

/**
 * Wake EVERY waiter and let each re-check the cap. A broadcast (rather than shifting one waiter)
 * is what makes this deadlock-proof: `shift()?.()` handed the wake-up to a single waiter, and a
 * waiter that had meanwhile given up (abort / queue timeout) swallowed it — the freed slot then sat
 * idle with live waiters still parked, forever. Losers simply re-queue, preserving arrival order.
 */
function wakeAll(): void {
  for (const w of waiters.splice(0, waiters.length)) w();
}

/** Park until a slot MIGHT be free, the caller aborts, or `timeoutMs` elapses. Always resolves —
 *  the acquire loop is the single place that decides what a wake-up means. Self-removes from
 *  `waiters` on give-up so a dead waiter can never absorb a wake-up. */
function waitForSlot(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false;
    const finish = (dropSelf: boolean) => {
      if (settled) return;
      settled = true;
      if (dropSelf) {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const waiter = () => finish(false);      // woken by wakeAll: already spliced out
    const onAbort = () => finish(true);
    waiters.push(waiter);
    // Deliberately NOT unref'd, unlike most timers here. This one exists solely to guarantee the
    // wait TERMINATES; an unref'd timer is skipped entirely whenever the loop has nothing else
    // holding it, which is precisely the situation where a queued run would otherwise never come
    // back. It is cleared the moment a slot frees or the caller aborts, so the longest it can hold
    // the loop is one queue-wait window — and only while a run is genuinely stuck.
    const timer = setTimeout(() => finish(true), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface AcquireOpts {
  /** Caller's abort signal — a cancelled task must not keep a place in the queue. */
  signal?: AbortSignal;
  /** Give-up bound for the QUEUE WAIT only (not the run). Defaults to computeEngineQueueWaitMs,
   *  read at CALL time (not module load) so an operator's ENGINE_QUEUE_WAIT_MS applies without a
   *  restart — and so a test can pin it without import-order gymnastics. */
  timeoutMs?: number;
  /** Called once, only if the caller actually has to wait — the hook the `engine:*:queued` trace
   *  hangs off, so a stall in this queue is never again invisible. */
  onQueued?: () => void;
}

/** Take one engine slot. Throws EngineRunError('cancelled') on abort and EngineRunError('timeout')
 *  when no slot frees in time; on either the caller never held a slot, so there is nothing to
 *  release. */
async function acquire(opts: AcquireOpts = {}): Promise<() => void> {
  const { signal, timeoutMs = computeEngineQueueWaitMs(process.env) } = opts;
  if (signal?.aborted) throw new EngineRunError('cancelled before an engine slot was taken', 'cancelled');
  if (active >= MAX_CONCURRENT) {
    opts.onQueued?.();
    const deadline = Date.now() + timeoutMs;
    // A LOOP, not a single await: a wake-up only means "a slot MAY be free" — another already-queued
    // acquire() can barge in and take it first, so a woken waiter must re-check the cap rather than
    // increment unconditionally (which pushed `active` one past the engine's concurrent-run limit).
    while (active >= MAX_CONCURRENT) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new EngineRunError(
          `no engine slot free after ${timeoutMs}ms (${MAX_CONCURRENT} runs already in flight)`, 'timeout',
        );
      }
      await waitForSlot(signal, remaining);
      if (signal?.aborted) throw new EngineRunError('cancelled while queued for an engine slot', 'cancelled');
    }
  }
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    wakeAll();
  };
}

/** Run `fn` holding one engine slot — for engine calls made OUTSIDE runViaEngine that are still
 *  full agent runs (the memory ask). Releases on throw. */
export async function withEngineSlot<T>(fn: () => Promise<T>, opts: AcquireOpts = {}): Promise<T> {
  const release = await acquire(opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

let cached: EngineBackend | null | undefined;
let warnedNoBackend = false;

/** The configured engine, or null when OPS_BACKEND is unset/unknown (deep work is then offline —
 *  a deliberate, documented state, voiced honestly; Convo still chats). Cached for the process.
 *  Adapter classes are statically imported (cheap, dependency-free); the OpenClaw adapter defers
 *  its optional @openclaw/gateway-client npm dep until the first actual call. */
export function getEngineBackend(): EngineBackend | null {
  if (cached !== undefined) return cached;
  const name = (process.env.OPS_BACKEND || '').trim().toLowerCase();
  if (name === 'hermes') {
    cached = new HermesBackend();
  } else if (name === 'openclaw') {
    cached = new OpenClawBackend();
  } else {
    // NOT cached: "no backend" is a reading of the environment, not a decision about it. Caching it
    // pinned deep work offline for the whole process whenever anything asked before the env was
    // loaded (an early import, a probe at boot) — one unlucky call order and the engine never
    // existed. The warning is once-per-process so a hot path can't spam it. off/none/offline/… are
    // the DELIBERATE debug/standalone offline pins, so they don't warn — only a genuine typo does.
    const OFFLINE_PINS = new Set(['off', 'none', 'offline', 'disabled', 'false', '0']);
    if (name && !OFFLINE_PINS.has(name) && !warnedNoBackend) {
      warnedNoBackend = true;
      console.error(`[engine] unknown OPS_BACKEND "${name}" — deep work is offline`);
    }
    return null;
  }
  return cached;
}

/** Exported for unit tests. */
export function resetEngineBackendCache(backend?: EngineBackend | null): void {
  cached = backend;
}

/** Map an adapter failure onto the OpsResult the orchestrator's triage/compose machinery expects.
 *  Never throws: the seam's contract with runTask is "always an OpsResult". */
function failureResult(task: OpsTask, cause: OpsFailureCause, detail: string, status: OpsResult['status'] = 'error'): { result: OpsResult; cause: OpsFailureCause } {
  return {
    cause,
    result: { taskId: task.id, kind: task.kind, status, summary: 'ran into a problem completing that' },
  };
}

/** Hand the engine the additions the user made BEFORE this run had a handle, one at a time so they
 *  arrive in the order they were said. Fire-and-forget from the run's point of view: the leg itself
 *  must never wait on a courtesy call, and steerWithRetry never throws. Each answer is recorded on
 *  its addition, so the status line says whether the look ever had it. */
async function deliverQueuedSteers(engine: EngineBackend, handle: EngineRunHandle, texts: string[], task: OpsTask, signal?: AbortSignal): Promise<void> {
  const where = { chatId: task.chatId, agentHandle: task.agentHandle, taskId: task.id };
  for (const text of texts) {
    const outcome = await steerWithRetry(engine, handle, text, where, { signal });
    noteSteerDelivery(task.chatId, task.id, text, outcome === 'accepted' ? 'reached' : 'never');
  }
}

/** Run one task on the configured engine and shape the outcome as an OpsResult. The debrief is the
 *  caller's (runTask owns creating it + the sink/done bookkeeping); this fills in what happened. */
export async function runViaEngine(
  engine: EngineBackend,
  prompt: string,
  task: OpsTask,
  ctx: EngineRunContext,
  debrief: OpsDebrief,
): Promise<OpsResult> {
  const t0 = Date.now();
  // The slot is taken INSIDE the try and released in `finally`, and nothing runs between the two.
  // Previously `acquire()` sat above the try with `ctx.onProgress?.()` and `record()` in the gap:
  // a throw from either leaked one of the (2) slots for the life of the process, and two such leaks
  // wedge EVERY later delegation in acquire() forever — a hang with no trace, no socket and no
  // engine ever contacted. A throw from acquire() itself is safe: it never took a slot.
  let release: (() => void) | undefined;
  // A mid-run addition the engine took but never applied (hermes's `pending_steer`). Captured here
  // and returned on the result so the orchestrator can replay it as a refinement leg — an answer
  // that silently ignores the last thing the user said is worse than a slower one.
  let steerUnapplied: string | undefined;
  // The ctx the ADAPTER sees: the caller's, plus the two hooks this seam owns. Wrapping rather than
  // mutating keeps the caller's object untouched (ops/client.ts builds it per leg) and keeps any
  // hook the caller set of its own working.
  const engineCtx: EngineRunContext = {
    ...ctx,
    onRunHandle: handle => {
      // Registration FIRST: the caller's hook is free to throw, and losing the handle would leave
      // a run nothing can steer or stop for the rest of its life.
      noteOpsEngineRun(task.chatId, task.id, handle);
      const queued = takePendingSteers(task.chatId, task.id);
      if (queued.length) void deliverQueuedSteers(engine, handle, queued, task, ctx.signal);
      // Guarded here as well as in the adapters: this is the composition point, so an adapter that
      // forgets to guard still cannot lose a run to a caller's bookkeeping hook.
      try { ctx.onRunHandle?.(handle); } catch { /* a receipt must never outrank the run */ }
    },
    onNoRunHandle: () => {
      noteOpsSteerUnreachable(task.chatId, task.id);
      try { ctx.onNoRunHandle?.(); } catch { /* likewise */ }
    },
    onPendingSteer: text => {
      steerUnapplied = text;
      try { ctx.onPendingSteer?.(text); } catch { /* likewise */ }
    },
  };
  // The leg's own lifecycle, which is NOT the task's: it opens here and closes in the `finally`,
  // while the task lives on through triage and compose. `steerRun` is the engine's answer to "can
  // an addition reach a run at all"; an adapter that then takes a run-id-less transport says so
  // through onNoRunHandle above — but that hook only fires once the leg actually runs, and this
  // call sits BEFORE acquire(). A hermes leg carrying a photo is already known, right here, to be
  // routing onto the chat transport (images never take /v1/runs — see useRunsTransport), so a steer
  // said while it is still parked behind the concurrency cap must not be told 'queued' for a handle
  // that a long wait later turns out never to arrive.
  const imageBearing = (task.media?.images?.length ?? 0) > 0;
  const steerableAtOpen = !!engine.steerRun && !(engine.name === 'hermes' && imageBearing);
  beginOpsEngineLeg(task.chatId, task.id, steerableAtOpen);
  try {
    release = await acquire({
      signal: ctx.signal,
      onQueued: () => {
        // The run is parked behind the concurrency cap — it has NOT contacted the engine yet. Mark it
        // 'queued' so the in-flight status line can say "waiting for a free slot, hasn't started" and
        // not imply progress. Acquiring the slot fires onProgress('engine'), overwriting this.
        ctx.onProgress?.('queued');
        record({
          type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
          label: `engine:${engine.name}:queued`, detail: { kind: task.kind, ...engineSlotState() },
        });
      },
    });
    ctx.onProgress?.('engine');
    record({
      type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
      label: `engine:${engine.name}:start`,
      // …plus which session/rotation window the adapter is about to speak into, when it can say
      // (spreading an absent descriptor adds nothing — the detail stays exactly as it was).
      detail: { kind: task.kind, promptChars: prompt.length, queuedMs: Date.now() - t0, ...engine.sessionDescriptor?.(task.chatId) },
    });
    const text = (await engine.runTask(prompt, task, engineCtx)).trim();
    debrief.steps += 1;
    debrief.toolsRun.push({ name: `engine:${engine.name}`, argsSummary: task.kind, ok: true, resultPreview: text.slice(0, 200), durationMs: Date.now() - t0 });
    debrief.corpus.push(text);
    // Absent rather than undefined when nothing is pending, so an ordinary result is byte-identical
    // to what it has always been.
    const pending = steerUnapplied ? { steerUnapplied } : {};
    if (!text) {
      debrief.failure = { cause: 'empty_miss', detail: 'engine returned empty text' };
      return { taskId: task.id, kind: task.kind, status: 'ok', summary: 'NO RESULT: the look came back empty', debrief, ...pending };
    }
    return { taskId: task.id, kind: task.kind, status: 'ok', summary: text, debrief, ...pending };
  } catch (err) {
    const durationMs = Date.now() - t0;
    let mapped: { result: OpsResult; cause: OpsFailureCause };
    if (ctx.signal?.aborted) {
      mapped = failureResult(task, 'cancelled', 'aborted');
    } else if (err instanceof EngineRunError) {
      mapped = failureResult(task, err.failureCause, err.message, err.failureCause === 'rate_limited' ? 'rate_limited' : 'error');
    } else if (err instanceof EngineUnavailableError) {
      mapped = failureResult(task, 'llm_error', `engine unreachable: ${err.message}`);
    } else if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') {
      mapped = failureResult(task, 'timeout', `engine call exceeded ${ctx.timeoutMs ?? ENGINE_TIMEOUT_MS}ms`);
    } else {
      mapped = failureResult(task, 'llm_error', String((err as Error)?.message ?? err));
    }
    debrief.toolsRun.push({ name: `engine:${engine.name}`, argsSummary: task.kind, ok: false, resultPreview: String((err as Error)?.message ?? err).slice(0, 200), durationMs });
    debrief.failure = { cause: mapped.cause, detail: String((err as Error)?.message ?? err).slice(0, 500) };
    // `steerUnapplied` rides the OK path only — a failed leg has no answer to refine, so the
    // orchestrator's replay has nothing to hang off. Say the addition was dropped rather than
    // dropping it without a word: it is still on the in-flight entry for the next ask.
    if (steerUnapplied) {
      record({
        type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
        label: 'ops:steer-dropped', detail: { reason: 'leg_failed', cause: mapped.cause, texts: [steerUnapplied.slice(0, 120)] },
      });
    }
    record({
      type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
      label: `engine:${engine.name}:error`, detail: { cause: mapped.cause, ms: durationMs, error: String((err as Error)?.message ?? err).slice(0, 300) },
    });
    return { ...mapped.result, debrief };
  } finally {
    release?.();
    // The leg is over. Dropping the handle is what stops `requestOpsSteer` answering 'ready' during
    // triage and compose — a window in which Convo acked "adding that in" and the POST then 409'd.
    // Anything still queued for delivery reached nobody: a trace, never a silence.
    const undelivered = endOpsEngineLeg(task.chatId, task.id);
    if (undelivered.length) {
      record({
        type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
        label: 'ops:steer-dropped',
        detail: { reason: 'leg_ended', count: undelivered.length, texts: undelivered.map(t => t.slice(0, 120)) },
      });
    }
  }
}
