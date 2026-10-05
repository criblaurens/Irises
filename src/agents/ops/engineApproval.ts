// The engine stopped mid-run to ask before a dangerous command. Relay that question to the person
// whose look it is, and carry their answer back to the same run.
//
// hermes screens every shell command its agent runs against its own dangerous-pattern list and, on
// an API run, parks the command and emits `approval.request` (hermesBackend.ts). The ask goes out as
// ONE code-written line carrying the command exactly as the engine reported it (a voiced paraphrase
// could soften what runs), and their next reply is read by the same consent reader the approval
// park uses (ops/consent.ts).
//
// FAIL-CLOSED: an unread reply leaves the engine waiting until its own timeout, which REFUSES; a
// failed POST leaves the same. So does every ask that is not answerable: one never confirmed on
// their screen, one whose marker failed to save, and one too long to show whole. Only an
// unambiguous yes answers, and only with 'once', so every later dangerous command gets its own
// question. A reply that predates the ask answers nothing, and a yes that could equally mean a
// parked approval ask answers neither. A yes that lands after the engine stopped waiting (its
// window closed, or the run ended) re-runs exactly that command as a fresh task, whose own ask for
// it is answered without asking twice (OpsTask.preApproved).
//
// OPS_ENGINE_APPROVAL_RELAY=off (ops/engineBackend.ts) is the behaviour before this module: nothing
// here reads, answers or drops a marker, and the orchestrator hooks nothing.

import { randomUUID } from 'node:crypto';
import { getPreference, setPreference } from '../../db/repositories/memory.js';
import { resolveConsent } from './consent.js';
import {
  getEngineBackend, engineApprovalRelayEnabled, ENGINE_APPROVAL_WAIT_MS,
  type EngineApprovalRequest, type EngineBackend, type EngineRunHandle, type EngineRunContext,
} from './engineBackend.js';
import { gatePendingEngineApproval, oneLine } from '../../memory/dossier.js';
import { noteEngineAskDeclined, enqueueEngineAsk, settleEngineAsk, isOpsCancelled } from '../../state/opsCoordination.js';
import { record } from '../../diagnostics/trace.js';
import { emptyMedia } from '../../webhook/types.js';
import type { ActionResult } from '../convo/actionResults.js';
import type { OpsTask, TaskKind } from '../types.js';

export const ENGINE_APPROVAL_PREF = 'pending_engine_approval';
/** The longest command that is relayed. The ask always shows the command whole (the engine already
 *  redacted any secret in it); past this it is not asked at all, and the engine's own timeout
 *  refuses it. */
export const ENGINE_ASK_MAX_COMMAND_CHARS = 1000;

/** The ask as it sits on the person's prefs. Everything a late yes needs to re-run the step is here,
 *  because by then the task that asked may be long gone. */
export interface EngineApprovalMarker {
  handle: EngineRunHandle;
  taskId: string;
  chatId: string;
  command: string;
  description: string;
  askedAt: number;
  request: string;
  kind: TaskKind;
  effect: OpsTask['effect'];
  room?: true;
  /** The run moved on without their answer; the step did not run (markEngineApprovalTimedOut). */
  timedOut?: true;
}

/** The command each run's engine waits on right now, as its relay heard it (createEngineApprovalRelay
 *  sets it on the ask, drops it when the wait ends). A yes posts 'once' only while the run still waits
 *  on the very command they were shown. In memory: after a restart it is empty, and a live ask from
 *  before it is read as a late yes (a fresh run of the command they saw), never a 'once' posted blind. */
const engineWaitingOn = new Map<string, string>();
/** Test seam: the command one run's engine waits on now (undefined = none). */
export function __setEngineWaitingOnForTests(runId: string, command: string | undefined): void {
  if (command === undefined) engineWaitingOn.delete(runId);
  else engineWaitingOn.set(runId, command);
}

let backendForTests: EngineBackend | null | undefined;
/** Test seam: the engine getEngineBackend() would return (undefined = the real one). */
export function __setEngineApprovalBackendForTests(b: EngineBackend | null | undefined): void {
  backendForTests = b;
}
const backend = (): EngineBackend | null => (backendForTests !== undefined ? backendForTests : getEngineBackend());

/** The ask, in her register: the engine is THEIRS ("your hermes"), the command sits whole on its own
 *  line (the bubble splitter breaks at newlines), and the question is the last line. */
export function renderEngineApprovalAsk(req: { command: string; description: string }, engineName: string): string {
  const why = req.description ? ` (${req.description})` : '';
  return `your ${engineName} wants to run this before it carries on${why}\n${req.command}\ngo or no?`;
}

async function readMarker(sender: string): Promise<EngineApprovalMarker | undefined> {
  const m = await getPreference<EngineApprovalMarker>(sender, ENGINE_APPROVAL_PREF).catch(() => undefined);
  return m?.handle?.runId && m.taskId && m.command && typeof m.askedAt === 'number' ? m : undefined;
}

/** Drop (`next` null) or rewrite the marker, but only while it is still the very ask `seen` was:
 *  the same run and the same `askedAt`. A newer ask written meanwhile is never erased or
 *  overwritten. Resolves whether it wrote. */
async function replaceMarker(sender: string, seen: EngineApprovalMarker, next: EngineApprovalMarker | null): Promise<boolean> {
  const now = await readMarker(sender);
  if (!now || now.handle.runId !== seen.handle.runId || now.askedAt !== seen.askedAt) return false;
  await setPreference(sender, ENGINE_APPROVAL_PREF, next);
  return true;
}

const dropMarker = (sender: string, seen: EngineApprovalMarker) => replaceMarker(sender, seen, null)
  .catch(err => console.error('[ops] failed to clear pending_engine_approval', err));

/** POST their answer. Never throws: an engine with no route, or a dead one, is 'failed'. */
async function answer(handle: EngineRunHandle, choice: 'once' | 'deny'): Promise<'resolved' | 'not_pending' | 'failed'> {
  const engine = backend();
  if (!engine?.resolveRunApproval) return 'failed';
  return engine.resolveRunApproval(handle, choice).catch(() => 'failed' as const);
}

/** Is an engine ask standing for this person, live or skipped-and-still-answerable? Read by the
 *  early-emit gate (convo/shared.ts parkedApprovalStanding) and the follow-up offer (ops/followUp.ts). */
export async function engineApprovalWaiting(sender: string, now: number = Date.now()): Promise<boolean> {
  if (!engineApprovalRelayEnabled()) return false;
  return gatePendingEngineApproval(await readMarker(sender), now) !== null;
}

/** Send the ask, then record it. The marker is written only once the send resolves 'sent', with
 *  `askedAt` taken after it, so no reply can answer an ask that never reached their screen and no
 *  reply sent before it can answer it either. Any other way out leaves no marker: the engine's own
 *  timeout refuses the command. Never throws. Only ever called with the person's line free
 *  (state/opsCoordination.ts enqueueEngineAsk). */
export async function armEngineApproval(
  task: OpsTask,
  req: EngineApprovalRequest,
  send: (chatId: string, text: string) => Promise<unknown>,
  engineName: string,
  now?: number,
): Promise<void> {
  const rec = (detail: Record<string, unknown>) => record({
    type: 'event', label: 'ops:engine_approval', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
    detail: { runId: req.handle.runId, ...detail },
  });
  if (req.command.length > ENGINE_ASK_MAX_COMMAND_CHARS) {
    rec({ decision: 'not_relayed_too_long', chars: req.command.length });
    return;
  }
  const sent = await send(task.chatId, renderEngineApprovalAsk(req, engineName)).catch(err => {
    console.error('[ops] failed to send the engine approval ask', err);
    return 'failed';
  });
  if (sent !== 'sent') {
    rec({ decision: 'ask_not_sent', sent: String(sent) });
    return;
  }
  const marker: EngineApprovalMarker = {
    handle: req.handle, taskId: task.id, chatId: task.chatId, command: req.command, description: req.description,
    askedAt: now ?? Date.now(), request: task.request, kind: task.kind, effect: task.effect,
    ...(task.room ? { room: true as const } : {}),
  };
  try {
    await setPreference(task.agentHandle, ENGINE_APPROVAL_PREF, marker);
  } catch (err) {
    // On their screen but unanswerable: the engine's own timeout refuses the command.
    console.error('[ops] failed to persist pending_engine_approval', err);
    rec({ decision: 'marker_lost' });
    return;
  }
  rec({ decision: 'requested', description: req.description });
}

/** The run moved on without their answer: the engine refused the step on its own clock. The marker
 *  stays, flagged, so a late yes still gets the step done. Only THIS run's marker is touched (`of` a
 *  run id), or, for a task that is over, whatever ask of THIS task still stands live (`{ taskId }`). */
export async function markEngineApprovalTimedOut(sender: string, of: string | { taskId: string }): Promise<void> {
  const m = await readMarker(sender);
  if (!m || m.timedOut || (typeof of === 'string' ? m.handle.runId !== of : m.taskId !== of.taskId)) return;
  const wrote = await replaceMarker(sender, m, { ...m, timedOut: true }).catch(err => {
    console.error('[ops] failed to mark pending_engine_approval timed out', err);
    return false;
  });
  if (wrote) record({ type: 'event', label: 'ops:engine_approval', chatId: m.chatId, handle: sender, taskId: m.taskId, detail: { decision: 'timed_out', runId: m.handle.runId } });
}

/** Drop this task's live ask, and with `evenTimedOut` its skipped one too: a look they called off
 *  leaves nothing a late yes could re-run. Another task's ask is left alone. */
export async function clearEngineApproval(sender: string, taskId: string, evenTimedOut = false): Promise<void> {
  const m = await readMarker(sender);
  if (m && m.taskId === taskId && (evenTimedOut || !m.timedOut)) await dropMarker(sender, m);
}

/** The step a late yes gets done: a fresh task of its own carrying exactly that command. Kind,
 *  effect, chat and room are the original's. The request is code-written and carries no engine text;
 *  the command rides as the one engine action, so the brief renders it in the instruction layer.
 *  An act's late yes is that step's approval, given now; a read needs none. `preApproved` lets the
 *  re-run's own ask for the same command through without asking twice; `followUpOf` keeps it from
 *  offering a next step. The original's setup actions do not ride along: the first run did them. */
function lateRerun(m: EngineApprovalMarker, sender: string, now: number): OpsTask {
  return {
    id: randomUUID(), chatId: m.chatId, agentHandle: sender, kind: m.kind,
    request: `the one step that was held for their OK while working on "${m.request}"`,
    // As a JSON string: a newline in the command can then never open an action line of its own.
    engineActions: [`run exactly this command (given as a JSON string) and nothing else, then report what it did: ${JSON.stringify(m.command)}`],
    effect: m.effect,
    ...(m.effect === 'act' ? { approval: { askedAt: m.askedAt, approvedAt: now } } : {}),
    preApproved: [m.command], followUpOf: m.taskId, createdAt: now, media: emptyMedia(),
    ...(m.room ? { room: true } : {}),
  };
}

export interface EngineApprovalOutcome {
  /** What this turn did about the ask, for the reply to stand on. Null when nothing was settled. */
  result: ActionResult | null;
  /** A late yes: the step as a fresh task, for the one kickoff site (convo/shared.ts settledTask). */
  rerun: OpsTask | null;
  /** Their yes could equally answer the parked approval ask (`competing`): neither ask may take it. */
  ambiguous?: true;
  /** A yes that did not count for this ask (it predates the ask, or came from another chat): a
   *  non-success line so the reply cannot say the step was cleared. It settles nothing, so the
   *  parked approval ask may still take the same reply. */
  note?: ActionResult;
}
const NOTHING: EngineApprovalOutcome = { result: null, rerun: null };

/**
 * Read this turn as the answer to the engine's ask. Runs before the parked-action resolution, and a
 * reply it settles (any yes or no) settles nothing else.
 *   • live, yes → 'once': cleared, or a late yes when the engine already stopped waiting, or (a failed
 *     POST) the marker stays and the reply says the go-ahead did not land. 'once' goes only while the
 *     run still waits on the very command they were shown; otherwise it is a late yes, unposted;
 *   • live, no → 'deny', and the run remembers the step was turned down;
 *   • skipped, yes → the step's own fresh run, nothing posted; skipped, no → let go, nothing posted;
 *   • unclear → nothing moves; past the shared clock → dropped.
 * Nothing moves either for a reply from another chat than the ask's, or one that predates the ask
 * (`receivedAt`, the newest text's arrival); a yes among them comes back as a `note` that it did not
 * count. Nor for a yes that also reads as a yes to the parked approval ask (`competing`, its
 * request): that comes back `ambiguous`, and the caller settles the parked ask with it no more than
 * this one.
 */
export async function resolveEngineApproval(
  a: { sender: string; text: string; chatId: string; handle: string | undefined; receivedAt?: number; competing?: string },
  now: number = Date.now(),
): Promise<EngineApprovalOutcome> {
  if (!engineApprovalRelayEnabled()) return NOTHING;
  const m = await readMarker(a.sender);
  if (!m) return NOTHING;
  const rec = (detail: Record<string, unknown>) => record({
    type: 'event', label: 'ops:engine_approval', chatId: a.chatId, handle: a.handle, taskId: m.taskId,
    detail: { runId: m.handle.runId, latencyMs: now - m.askedAt, ...detail },
  });
  const state = gatePendingEngineApproval(m, now);
  if (!state) {
    await dropMarker(a.sender, m);
    rec({ decision: 'lapsed' });
    return NOTHING;
  }
  // Code-written: the engine's command never reaches the classify lane.
  const action = `let their ${m.handle.engine} run the one step it paused on${m.description ? ` (${m.description})` : ''}`;
  // The marker is keyed by sender, so a reply from a chat the ask was never shown in, or one sent
  // before it reached them, answers nothing. A yes among them gets a line that it did not count.
  const elsewhere = a.chatId !== m.chatId ? 'it was sent in another chat'
    : a.receivedAt !== undefined && a.receivedAt < m.askedAt ? 'it came before the ask reached them'
    : null;
  if (elsewhere) {
    const yes = (await resolveConsent(a.text, action)) === 'yes';
    rec({ decision: a.chatId !== m.chatId ? 'other_chat' : 'predates_ask', state, yes });
    return yes
      ? { ...NOTHING, note: { tool: 'engine_approval', status: 'unavailable', target: oneLine(m.command).slice(0, 80), detail: `that yes did not clear the step (${elsewhere}); the step is still waiting on a yes to the ask itself` } }
      : NOTHING;
  }
  const consent = await resolveConsent(a.text, action);
  if (consent === 'unclear') {
    rec({ decision: 'unclear', state });
    return NOTHING;
  }
  if (consent === 'yes' && a.competing && (await resolveConsent(a.text, a.competing)) === 'yes') {
    rec({ decision: 'ambiguous', state });
    return { result: null, rerun: null, ambiguous: true };
  }
  const target = oneLine(m.command).slice(0, 80);
  if (consent === 'no') {
    noteEngineAskDeclined(m.chatId, m.taskId);
    await dropMarker(a.sender, m);
    if (state === 'timed_out') {
      rec({ decision: 'declined', state });
      return { result: { tool: 'engine_approval', status: 'done', target, detail: 'they let the skipped step go; it never ran and nothing more will run for it' }, rerun: null };
    }
    const outcome = await answer(m.handle, 'deny');
    rec({ decision: 'declined', state, outcome });
    return { result: { tool: 'engine_approval', status: 'done', target, detail: 'that step is refused and did not run; the look carries on without it' }, rerun: null };
  }
  // 'once' clears whatever the run waits on NOW, so it is posted only while that is the command they
  // were shown. Any other, or none known (a restart), makes this a late yes of the one they saw.
  const bound = engineWaitingOn.get(m.handle.runId) === m.command;
  if (state === 'live' && bound) {
    const outcome = await answer(m.handle, 'once');
    if (outcome === 'resolved') {
      await dropMarker(a.sender, m);
      rec({ decision: 'approved', outcome });
      return { result: { tool: 'engine_approval', status: 'done', target, detail: 'that one step is cleared to run and the look carries on' }, rerun: null };
    }
    if (outcome === 'failed') {
      rec({ decision: 'approved', outcome });
      return { result: { tool: 'engine_approval', status: 'unavailable', target, detail: 'the go-ahead did not reach the engine, so the step is still waiting on it', nextStep: 'their next yes tries again' }, rerun: null };
    }
    // 'not_pending': it stopped waiting before the yes landed, which makes this a late yes.
  }
  await dropMarker(a.sender, m);
  const rerun = lateRerun(m, a.sender, now);
  rec({ decision: 'late_yes', state, rerunId: rerun.id, ...(state === 'live' && !bound ? { unbound: true } : {}) });
  return { result: { tool: 'engine_approval', status: 'done', target, detail: 'that step had stopped waiting, so it is starting again as a fresh run of just that step' }, rerun };
}

export interface EngineApprovalRelay {
  /** One leg's two engine hooks; `extendLeg` moves that leg's own deadline and in-flight horizon. */
  hooks(extendLeg: (ms: number) => void): Required<Pick<EngineRunContext, 'onApprovalRequest' | 'onApprovalSettled'>>;
  /** Is a leg of this task blocked on an engine ask right now? Progress pings stand down while it is. */
  waiting(): boolean;
}

/**
 * The run side of the relay, one per task, built only with OPS_ENGINE_APPROVAL_RELAY on.
 *  • A command they already said yes to (`task.preApproved`) is answered 'once' with no ask, the
 *    first time only: the same command again in this task is asked about, so one yes never runs it
 *    twice. It is also asked about as usual when that answer could not be delivered, while the
 *    engine still waits on it.
 *  • Otherwise the leg's clocks move out by the wait and the ask joins this person's line (one live
 *    at a time, state/opsCoordination.ts). A look they called off asks nothing, and neither does an
 *    ask whose run now waits on another command.
 *  • A wait that ends unanswered marks its ask skipped BEFORE the next in line is asked: the next ask
 *    writes the same marker, and that order is what keeps the newer one standing. A look they called
 *    off leaves no skipped step behind. Either waits for an ask still going out to be recorded.
 * Every hook is synchronous and never throws; the async work floats with its own catch, which logs.
 */
export function createEngineApprovalRelay(task: OpsTask, deps: {
  send: (chatId: string, text: string) => Promise<unknown>;
  engineName: string;
}): EngineApprovalRelay {
  // The request each blocked run waits on now. By identity, not run: one run asks again after its
  // first wait ends, and an ask still queued for the first command must then never go out.
  const blocked = new Map<string, EngineApprovalRequest>();
  const preApprovedUsed = new Set<string>();
  // Each run's ask while it goes out (the send, then the marker), so a wait that ends meanwhile
  // settles after it: settled first, the ask would then write a live marker over the settling.
  const arming = new Map<string, Promise<void>>();
  const askAbout = (req: EngineApprovalRequest, extendLeg: (ms: number) => void) => {
    extendLeg(ENGINE_APPROVAL_WAIT_MS);
    enqueueEngineAsk(task.agentHandle, {
      taskId: task.id, runId: req.handle.runId,
      arm: () => {
        if (isOpsCancelled(task.chatId, task.id) || blocked.get(req.handle.runId) !== req) return;
        arming.set(req.handle.runId, armEngineApproval(task, req, deps.send, deps.engineName)
          .catch(err => console.warn('[ops] engine approval ask failed', err)));
      },
    });
  };
  return {
    hooks: extendLeg => ({
      onApprovalRequest: req => {
        blocked.set(req.handle.runId, req);
        engineWaitingOn.set(req.handle.runId, req.command);
        if (!task.preApproved?.includes(req.command) || preApprovedUsed.has(req.command)) return askAbout(req, extendLeg);
        preApprovedUsed.add(req.command);
        void answer(req.handle, 'once').then(outcome => {
          record({ type: 'event', label: 'ops:engine_approval', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, detail: { decision: 'pre_approved', runId: req.handle.runId, outcome } });
          // Only while the engine still waits on it: a run it already settled takes no place in line.
          if (outcome === 'failed' && blocked.get(req.handle.runId) === req) askAbout(req, extendLeg);
        }).catch(err => console.warn('[ops] failed to relay the pre-approved engine ask', err));
      },
      onApprovalSettled: (handle, how) => {
        blocked.delete(handle.runId);
        engineWaitingOn.delete(handle.runId);
        const armed = arming.get(handle.runId) ?? Promise.resolve();
        arming.delete(handle.runId);
        void armed
          .then(() => {
            if (how === 'answered') return;
            return isOpsCancelled(task.chatId, task.id)
              ? clearEngineApproval(task.agentHandle, task.id, true)
              : markEngineApprovalTimedOut(task.agentHandle, handle.runId);
          })
          .catch(err => console.warn('[ops] failed to settle the engine ask on their prefs', err))
          .then(() => settleEngineAsk(task.agentHandle, handle.runId))
          .catch(err => console.warn('[ops] failed to ask the next engine ask in line', err));
      },
    }),
    waiting: () => blocked.size > 0,
  };
}

/** The step this task's run left standing on their prefs, or null. Any ask of its own still standing
 *  once the run is over is a skipped one (its 'expired' may land a moment after the run does). Read
 *  by the answer's composer, so the delivery says so: a later yes re-runs it. */
export async function skippedEngineStep(sender: string, taskId: string, now: number = Date.now()): Promise<{ command: string; description: string } | null> {
  if (!engineApprovalRelayEnabled()) return null;
  const m = await readMarker(sender);
  return m && m.taskId === taskId && gatePendingEngineApproval(m, now) !== null
    ? { command: m.command, description: m.description }
    : null;
}
