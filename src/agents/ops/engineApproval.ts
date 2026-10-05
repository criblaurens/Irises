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
// failed POST leaves the same. Only an unambiguous yes answers, and only with 'once', so every later
// dangerous command gets its own question. A yes that lands after the engine stopped waiting (its
// window closed, or the run ended) re-runs just that step as a fresh task, whose own ask for the
// same command is answered without asking twice (OpsTask.preApproved).
//
// OPS_ENGINE_APPROVAL_RELAY=off (ops/engineBackend.ts) is the behaviour before this module: nothing
// here reads, answers or drops a marker, and the orchestrator hooks nothing.

import { randomUUID } from 'node:crypto';
import { getPreference, setPreference } from '../../db/repositories/memory.js';
import { resolveConsent } from './consent.js';
import {
  getEngineBackend, engineApprovalRelayEnabled,
  type EngineApprovalRequest, type EngineBackend, type EngineRunHandle,
} from './engineBackend.js';
import { gatePendingEngineApproval } from '../../memory/dossier.js';
import { noteEngineAskDeclined } from '../../state/opsCoordination.js';
import { record } from '../../diagnostics/trace.js';
import { emptyMedia } from '../../webhook/types.js';
import type { ActionResult } from '../convo/actionResults.js';
import type { OpsTask, TaskKind } from '../types.js';

export const ENGINE_APPROVAL_PREF = 'pending_engine_approval';
/** Past this the command is cut on screen. The engine already redacted any secret in it. */
const COMMAND_SHOWN_CHARS = 300;

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
  approval?: OpsTask['approval'];
  room?: true;
  /** The run moved on without their answer; the step did not run (markEngineApprovalTimedOut). */
  timedOut?: true;
}

let backendForTests: EngineBackend | null | undefined;
/** Test seam: the engine getEngineBackend() would return (undefined = the real one). */
export function __setEngineApprovalBackendForTests(b: EngineBackend | null | undefined): void {
  backendForTests = b;
}
const backend = (): EngineBackend | null => (backendForTests !== undefined ? backendForTests : getEngineBackend());

/** The ask, in her register: the engine is THEIRS ("your hermes"), the command sits on its own line
 *  (the bubble splitter breaks at newlines), and the question is the last line. */
export function renderEngineApprovalAsk(req: { command: string; description: string }, engineName: string): string {
  const cmd = req.command.length > COMMAND_SHOWN_CHARS ? `${req.command.slice(0, COMMAND_SHOWN_CHARS)}…` : req.command;
  const why = req.description ? ` (${req.description})` : '';
  return `your ${engineName} wants to run this before it carries on${why}\n${cmd}\ngo or no?`;
}

async function readMarker(sender: string): Promise<EngineApprovalMarker | undefined> {
  const m = await getPreference<EngineApprovalMarker>(sender, ENGINE_APPROVAL_PREF).catch(() => undefined);
  return m?.handle?.runId && m.taskId && m.command && typeof m.askedAt === 'number' ? m : undefined;
}

const dropMarker = (sender: string) => setPreference(sender, ENGINE_APPROVAL_PREF, null)
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

/** Record the ask and send it. The marker is written FIRST, so a reply racing the send still finds
 *  it. Only ever called with the person's line free (state/opsCoordination.ts enqueueEngineAsk). */
export async function armEngineApproval(
  task: OpsTask,
  req: EngineApprovalRequest,
  send: (chatId: string, text: string) => Promise<unknown>,
  engineName: string,
  now: number = Date.now(),
): Promise<void> {
  const marker: EngineApprovalMarker = {
    handle: req.handle, taskId: task.id, chatId: task.chatId, command: req.command, description: req.description,
    askedAt: now, request: task.request, kind: task.kind, effect: task.effect,
    ...(task.approval ? { approval: task.approval } : {}),
    ...(task.room ? { room: true as const } : {}),
  };
  await setPreference(task.agentHandle, ENGINE_APPROVAL_PREF, marker)
    .catch(err => console.error('[ops] failed to persist pending_engine_approval', err));
  record({ type: 'event', label: 'ops:engine_approval', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, detail: { decision: 'requested', runId: req.handle.runId, description: req.description } });
  await send(task.chatId, renderEngineApprovalAsk(req, engineName));
}

/** The run moved on without their answer: the engine refused the step on its own clock. The marker
 *  stays, flagged, so a late yes still gets the step done. Only THIS run's marker is touched. */
export async function markEngineApprovalTimedOut(sender: string, runId: string): Promise<void> {
  const m = await readMarker(sender);
  if (!m || m.handle.runId !== runId || m.timedOut) return;
  await setPreference(sender, ENGINE_APPROVAL_PREF, { ...m, timedOut: true })
    .catch(err => console.error('[ops] failed to mark pending_engine_approval timed out', err));
  record({ type: 'event', label: 'ops:engine_approval', chatId: m.chatId, handle: sender, taskId: m.taskId, detail: { decision: 'timed_out', runId } });
}

/** The task is over. A live ask it left can never be answered now, so its marker goes; a skipped one
 *  stays for the late yes, unless the look was called off (`evenTimedOut`). Another task's ask is
 *  left alone. */
export async function clearEngineApproval(sender: string, taskId: string, evenTimedOut = false): Promise<void> {
  const m = await readMarker(sender);
  if (m && m.taskId === taskId && (evenTimedOut || !m.timedOut)) await dropMarker(sender);
}

/** The step a late yes gets done: a fresh task of its own carrying just that step. Kind, effect,
 *  chat and room are the original's, and so is its approval, so an act they already said yes to
 *  keeps its AUTHORIZED ACTION line. `preApproved` lets the re-run's own ask for the same command
 *  through without asking twice; `followUpOf` keeps it from offering a next step. Setup actions do
 *  not ride along: the first run already did them. */
function lateRerun(m: EngineApprovalMarker, sender: string, now: number): OpsTask {
  return {
    id: randomUUID(), chatId: m.chatId, agentHandle: sender, kind: m.kind,
    request: `the one step that was held waiting on their OK while working on "${m.request}": ${m.description ? `${m.description}, ` : ''}by running ${m.command}`,
    effect: m.effect, ...(m.approval ? { approval: m.approval } : {}),
    preApproved: [m.command], followUpOf: m.taskId, createdAt: now, media: emptyMedia(),
    ...(m.room ? { room: true } : {}),
  };
}

export interface EngineApprovalOutcome {
  /** What this turn did about the ask, for the reply to stand on. Null when nothing was settled. */
  result: ActionResult | null;
  /** A late yes: the step as a fresh task, for the one kickoff site (convo/shared.ts settledTask). */
  rerun: OpsTask | null;
}
const NOTHING: EngineApprovalOutcome = { result: null, rerun: null };

/**
 * Read this turn as the answer to the engine's ask. Runs before the parked-action resolution, and a
 * reply it settles (any yes or no) settles nothing else.
 *   • live, yes → 'once': cleared, or a late yes when the engine already stopped waiting, or (a failed
 *     POST) the marker stays and the reply says the go-ahead did not land;
 *   • live, no → 'deny', and the run remembers the step was turned down;
 *   • skipped, yes → the step's own fresh run, nothing posted; skipped, no → let go, nothing posted;
 *   • unclear → nothing moves; past the shared clock → dropped.
 */
export async function resolveEngineApproval(
  a: { sender: string; text: string; chatId: string; handle: string | undefined },
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
    await dropMarker(a.sender);
    rec({ decision: 'lapsed' });
    return NOTHING;
  }
  const consent = await resolveConsent(a.text, `run ${m.command}`);
  if (consent === 'unclear') {
    rec({ decision: 'unclear', state });
    return NOTHING;
  }
  const target = m.command.slice(0, 80);
  if (consent === 'no') {
    noteEngineAskDeclined(m.chatId, m.taskId);
    await dropMarker(a.sender);
    if (state === 'timed_out') {
      rec({ decision: 'declined', state });
      return { result: { tool: 'engine_approval', status: 'done', target, detail: 'they let the skipped step go; it never ran and nothing more will run for it' }, rerun: null };
    }
    const outcome = await answer(m.handle, 'deny');
    rec({ decision: 'declined', state, outcome });
    return { result: { tool: 'engine_approval', status: 'done', target, detail: 'that step is refused and did not run; the look carries on without it' }, rerun: null };
  }
  if (state === 'live') {
    const outcome = await answer(m.handle, 'once');
    if (outcome === 'resolved') {
      await dropMarker(a.sender);
      rec({ decision: 'approved', outcome });
      return { result: { tool: 'engine_approval', status: 'done', target, detail: 'that one step is cleared to run and the look carries on' }, rerun: null };
    }
    if (outcome === 'failed') {
      rec({ decision: 'approved', outcome });
      return { result: { tool: 'engine_approval', status: 'unavailable', target, detail: 'the go-ahead did not reach the engine, so the step is still waiting on it', nextStep: 'their next yes tries again' }, rerun: null };
    }
    // 'not_pending': it stopped waiting before the yes landed, which makes this a late yes.
  }
  await dropMarker(a.sender);
  const rerun = lateRerun(m, a.sender, now);
  rec({ decision: 'late_yes', state, rerunId: rerun.id });
  return { result: { tool: 'engine_approval', status: 'done', target, detail: 'that step had stopped waiting, so it is starting again as a fresh run of just that step' }, rerun };
}
