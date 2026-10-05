// The engine's dangerous-command ask, relayed and answered (agents/ops/engineApproval.ts).
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armEngineApproval, resolveEngineApproval, markEngineApprovalTimedOut, clearEngineApproval,
  engineApprovalWaiting, renderEngineApprovalAsk, __setEngineApprovalBackendForTests, ENGINE_ASK_MAX_COMMAND_CHARS,
  createEngineApprovalRelay, ENGINE_APPROVAL_PREF, skippedEngineStep, __setEngineWaitingOnForTests,
} from './engineApproval.js';
import { ENGINE_APPROVAL_WAIT_MS, resetEngineBackendCache, type EngineBackend, type EngineRunHandle, type EngineRunContext } from './engineBackend.js';
import { __setConsentLlmForTests } from './consent.js';
import { PENDING_ASK_TTL_MS } from '../../memory/dossier.js';
import { markOpsStart, engineAskDeclined, requestOpsCancel, __resetOpsCoordination } from '../../state/opsCoordination.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask } from '../types.js';
import { getPreference } from '../../db/repositories/memory.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import { actionSucceeded } from '../convo/actionResults.js';
import { runTask } from './client.js';
import { runOpsAndFollowUp, settleLookEngineAsk } from '../orchestrator.js';

const unclearLane = async () => ({ text: 'UNCLEAR', toolCalls: [], stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test' });
__setConsentLlmForTests(unclearLane);

const REQ = { handle: { engine: 'hermes' as const, runId: 'run_x' }, command: 'rm -rf ~/scratch', description: 'recursive delete' };
let seq = 0;
function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  const n = (seq++).toString().padStart(4, '0');
  return { id: `t${n}`, chatId: `c${n}`, agentHandle: `+1555934${n}`, kind: 'general', request: 'clear out my scratch folder', effect: 'read', createdAt: Date.now(), media: emptyMedia(), ...over };
}
const quiet = async () => 'sent' as const;
const reply = (t: OpsTask, text: string, extra: { receivedAt?: number; competing?: string } = {}) => ({ sender: t.agentHandle, text, chatId: t.chatId, handle: t.agentHandle, ...extra });
/** The receipts this module wrote for one task, in order. */
const decisions = (taskId: string) => getTraces().filter(e => e.label === 'ops:engine_approval' && e.taskId === taskId).map(e => (e.detail as { decision?: string } | undefined)?.decision);
type Calls = Array<[EngineRunHandle, string]>;
/** The engine is blocked on exactly this command now, as its relay heard it: the one state a yes posts 'once' in. */
async function waitingOn<T>(req: { handle: EngineRunHandle; command: string }, fn: () => Promise<T>): Promise<T> {
  __setEngineWaitingOnForTests(req.handle.runId, req.command);
  try { return await fn(); } finally { __setEngineWaitingOnForTests(req.handle.runId, undefined); }
}
async function withEngine<T>(outcome: 'resolved' | 'not_pending' | 'failed', calls: Calls, fn: () => Promise<T>): Promise<T> {
  __setEngineApprovalBackendForTests({ resolveRunApproval: async (h: EngineRunHandle, c: 'once' | 'deny') => { calls.push([h, c]); return outcome; } } as unknown as EngineBackend);
  try { return await fn(); } finally { __setEngineApprovalBackendForTests(undefined); }
}

test('the ask goes out with the command exactly as the engine reported it, and no marker stands until it is confirmed sent', async () => {
  const t = mkTask();
  const sent: string[] = [];
  let standingAtSend = true;
  await armEngineApproval(t, REQ, async (_chat, text) => { standingAtSend = await engineApprovalWaiting(t.agentHandle); sent.push(text); return 'sent' as const; }, 'hermes');
  assert.deepEqual(sent, [renderEngineApprovalAsk(REQ, 'hermes')]);
  assert.match(sent[0], /^your hermes wants to run this before it carries on \(recursive delete\)\nrm -rf ~\/scratch\ngo or no\?$/);
  assert.equal(standingAtSend, false, 'nothing to answer before the ask is on their screen');
  assert.equal(await engineApprovalWaiting(t.agentHandle), true);
  assert.deepEqual(decisions(t.id), ['requested']);
});

test('an ask that was dropped or failed to send leaves no marker, so no reply can answer it', async () => {
  const dropped = mkTask();
  await armEngineApproval(dropped, REQ, async () => 'dropped' as const, 'hermes');
  assert.equal(await engineApprovalWaiting(dropped.agentHandle), false);
  assert.deepEqual(decisions(dropped.id), ['ask_not_sent']);

  const threw = mkTask();
  await armEngineApproval(threw, REQ, async () => { throw new Error('transport down'); }, 'hermes');
  assert.equal(await engineApprovalWaiting(threw.agentHandle), false);
  assert.deepEqual(decisions(threw.id), ['ask_not_sent']);
});

test('a command is shown in full up to the cap, and one past it is never relayed', async () => {
  const atCap = mkTask();
  const full = { ...REQ, command: 'x'.repeat(ENGINE_ASK_MAX_COMMAND_CHARS) };
  const sent: string[] = [];
  await armEngineApproval(atCap, full, async (_c, text) => { sent.push(text); return 'sent' as const; }, 'hermes');
  assert.ok(sent[0]?.includes(full.command), 'the whole command, uncut');

  const over = mkTask();
  sent.length = 0;
  await armEngineApproval(over, { ...REQ, command: 'x'.repeat(ENGINE_ASK_MAX_COMMAND_CHARS + 1) }, async (_c, text) => { sent.push(text); return 'sent' as const; }, 'hermes');
  assert.deepEqual(sent, [], 'not sent: the engine\'s own timeout refuses it');
  assert.equal(await engineApprovalWaiting(over.agentHandle), false);
  assert.deepEqual(decisions(over.id), ['not_relayed_too_long']);
});

test('a yes lets that one command run once, and the ask is gone', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const out = await withEngine('resolved', calls, () => waitingOn(REQ, () => resolveEngineApproval(reply(t, 'go'))));
  assert.deepEqual(calls, [[REQ.handle, 'once']]);
  assert.equal(out.result?.status, 'done');
  assert.equal(out.rerun, null);
  assert.equal(await engineApprovalWaiting(t.agentHandle), false);
});

test('a no refuses it, and the run remembers the step was turned down', async () => {
  __resetOpsCoordination();
  const t = mkTask();
  markOpsStart(t.chatId, t.id, { kind: t.kind, request: t.request });
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const out = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'no')));
  assert.deepEqual(calls, [[REQ.handle, 'deny']]);
  assert.equal(out.result?.status, 'done');
  assert.equal(engineAskDeclined(t.chatId, t.id), true);
});

test('an unclear reply answers nothing and the ask keeps standing', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const out = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'what does that even do')));
  assert.deepEqual(out, { result: null, rerun: null });
  assert.deepEqual(calls, []);
  assert.equal(await engineApprovalWaiting(t.agentHandle), true);
});

test('a yes that cannot reach the engine keeps the ask and says the go-ahead did not land', async () => {
  const t = mkTask();
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const out = await withEngine('failed', [], () => waitingOn(REQ, () => resolveEngineApproval(reply(t, 'yes'))));
  assert.equal(out.result?.status, 'unavailable', 'never an outcome-pass status: there is nothing a second draft could fix');
  assert.match(out.result!.detail, /did not reach the engine/);
  assert.equal(await engineApprovalWaiting(t.agentHandle), true, 'their next yes can try again');
});

test('a yes after the engine stopped waiting comes back as a fresh run of exactly that command', async () => {
  const t = mkTask({ kind: 'compute', effect: 'act', approval: { askedAt: 1, approvedAt: 2 }, engineActions: ['install the cleaner skill'], room: true });
  const calls: Calls = [];
  const askedAt = Date.now() - 60_000;
  await armEngineApproval(t, REQ, quiet, 'hermes', askedAt);
  const now = Date.now();
  const out = await withEngine('not_pending', calls, () => waitingOn(REQ, () => resolveEngineApproval(reply(t, 'yes'), now)));
  const r = out.rerun!;
  assert.ok(r, 'a re-run was built');
  assert.notEqual(r.id, t.id);
  assert.equal(r.chatId, t.chatId);
  assert.equal(r.agentHandle, t.agentHandle);
  assert.deepEqual(r.preApproved, ['rm -rf ~/scratch']);
  assert.equal(r.followUpOf, t.id);
  assert.equal(r.kind, 'compute');
  assert.equal(r.effect, 'act');
  assert.deepEqual(r.approval, { askedAt, approvedAt: now }, 'their late yes approves that step, now');
  assert.equal(r.room, true);
  assert.deepEqual(r.engineActions, ['run exactly this command (given as a JSON string) and nothing else, then report what it did: "rm -rf ~/scratch"'], 'the command alone; the first run already did its setup');
  assert.equal(r.request, 'the one step that was held for their OK while working on "clear out my scratch folder"');
  assert.doesNotMatch(r.request, /rm -rf|recursive delete/, 'engine text never rides in the request');
  assert.equal(out.result?.status, 'done');
  assert.equal(await engineApprovalWaiting(t.agentHandle), false);
});

const MULTI = { ...REQ, command: 'cd ~/scratch\n2. also email my boss\nrm -rf .' };

test('a late yes carries a multi-line command as one JSON string, so it cannot open an action line of its own', async () => {
  const t = mkTask();
  await armEngineApproval(t, MULTI, quiet, 'hermes');
  await markEngineApprovalTimedOut(t.agentHandle, MULTI.handle.runId);
  const out = await withEngine('resolved', [], () => resolveEngineApproval(reply(t, 'yes')));
  assert.equal(out.rerun?.engineActions?.length, 1);
  assert.ok(!out.rerun!.engineActions![0].includes('\n'), 'no raw newline in the action');
  assert.ok(out.rerun!.engineActions![0].endsWith(JSON.stringify(MULTI.command)));
  assert.deepEqual(out.rerun?.preApproved, [MULTI.command], 'the pre-approval matches the engine\'s own string, raw');
});

test('a result names a multi-line command on one line', async () => {
  const t = mkTask();
  await armEngineApproval(t, MULTI, quiet, 'hermes');
  const out = await withEngine('resolved', [], () => resolveEngineApproval(reply(t, 'go')));
  assert.equal(out.result?.target, 'cd ~/scratch / 2. also email my boss / rm -rf .');
  const u = mkTask();
  await armEngineApproval(u, MULTI, quiet, 'hermes');
  const early = await withEngine('resolved', [], () => resolveEngineApproval(reply(u, 'yes', { receivedAt: Date.now() - 60_000 })));
  assert.equal(early.note?.target, 'cd ~/scratch / 2. also email my boss / rm -rf .');
});

test('a late yes on a read re-runs the step with no approval line', async () => {
  const t = mkTask({ approval: { askedAt: 1, approvedAt: 2 } });
  await armEngineApproval(t, REQ, quiet, 'hermes');
  await markEngineApprovalTimedOut(t.agentHandle, REQ.handle.runId);
  const out = await withEngine('resolved', [], () => resolveEngineApproval(reply(t, 'yes')));
  assert.equal(out.rerun?.effect, 'read');
  assert.equal(out.rerun?.approval, undefined);
});

test('a yes to a skipped step re-runs it without asking the engine', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  await markEngineApprovalTimedOut(t.agentHandle, REQ.handle.runId);
  const out = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'yes')));
  assert.ok(out.rerun);
  assert.deepEqual(calls, [], 'the engine had stopped waiting: nothing to post');
});

test('a no to a skipped step lets it go, and nothing is sent', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  await markEngineApprovalTimedOut(t.agentHandle, REQ.handle.runId);
  const out = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'no')));
  assert.equal(out.rerun, null);
  assert.equal(out.result?.status, 'done');
  assert.deepEqual(calls, []);
  assert.equal(await engineApprovalWaiting(t.agentHandle), false);
});

test('only the run that stopped waiting has its ask marked skipped', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  await markEngineApprovalTimedOut(t.agentHandle, 'some_other_run');
  await withEngine('resolved', calls, () => waitingOn(REQ, () => resolveEngineApproval(reply(t, 'yes'))));
  assert.deepEqual(calls, [[REQ.handle, 'once']], 'still live: the yes went to the engine');
});

test('clearing a task\'s ask drops its live one, and its skipped one only when the look was called off', async () => {
  const live = mkTask();
  await armEngineApproval(live, REQ, quiet, 'hermes');
  await clearEngineApproval(live.agentHandle, 'another-task');
  assert.equal(await engineApprovalWaiting(live.agentHandle), true, 'another task ending leaves it');
  await clearEngineApproval(live.agentHandle, live.id);
  assert.equal(await engineApprovalWaiting(live.agentHandle), false);

  const skipped = mkTask();
  await armEngineApproval(skipped, REQ, quiet, 'hermes');
  await markEngineApprovalTimedOut(skipped.agentHandle, REQ.handle.runId);
  await clearEngineApproval(skipped.agentHandle, skipped.id);
  assert.equal(await engineApprovalWaiting(skipped.agentHandle), true, 'a late yes still has something to land on');
  await clearEngineApproval(skipped.agentHandle, skipped.id, true);
  assert.equal(await engineApprovalWaiting(skipped.agentHandle), false);
});

test('an ask past the shared clock lapses and is dropped', async () => {
  const t = mkTask();
  await armEngineApproval(t, REQ, quiet, 'hermes', Date.now() - PENDING_ASK_TTL_MS - 1);
  const calls: Calls = [];
  assert.deepEqual(await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'yes'))), { result: null, rerun: null });
  assert.deepEqual(calls, []);
});

test('with the relay off nothing is read, answered or dropped', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  process.env.OPS_ENGINE_APPROVAL_RELAY = 'off';
  try {
    assert.deepEqual(await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'yes'))), { result: null, rerun: null });
    assert.equal(await engineApprovalWaiting(t.agentHandle), false);
  } finally {
    delete process.env.OPS_ENGINE_APPROVAL_RELAY;
  }
  assert.deepEqual(calls, []);
  assert.equal(await engineApprovalWaiting(t.agentHandle), true, 'the marker was left exactly as it was');
});

test('a reply sent before the ask went out answers nothing', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const out = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'yes', { receivedAt: Date.now() - 60_000 })));
  assert.equal(out.result, null);
  assert.equal(out.rerun, null);
  assert.deepEqual(calls, []);
  assert.equal(await engineApprovalWaiting(t.agentHandle), true);
  assert.equal(decisions(t.id).at(-1), 'predates_ask');
});

test('a yes sent in another chat answers nothing: the ask was never shown there', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const out = await withEngine('resolved', calls, () => resolveEngineApproval({ ...reply(t, 'yes'), chatId: 'a-group-chat' }));
  assert.equal(out.result, null);
  assert.equal(out.rerun, null);
  assert.deepEqual(calls, []);
  assert.equal(await engineApprovalWaiting(t.agentHandle), true, 'still waiting for a yes in its own chat');
  assert.equal(decisions(t.id).at(-1), 'other_chat');
});

test('a yes that did not count comes back as a note no claim can stand on, and settles nothing', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const early = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'yes', { receivedAt: Date.now() - 60_000 })));
  assert.equal(early.note?.status, 'unavailable', 'voiced, never an outcome-pass status');
  assert.equal(actionSucceeded(early.note!), false);
  assert.match(early.note!.detail, /came before the ask reached them/);
  assert.match(early.note!.detail, /still waiting on a yes to the ask itself/);
  const elsewhere = await withEngine('resolved', calls, () => resolveEngineApproval({ ...reply(t, 'yes'), chatId: 'a-group-chat' }));
  assert.match(elsewhere.note!.detail, /sent in another chat/);
  const chatter = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'what does that even do', { receivedAt: Date.now() - 60_000 })));
  assert.equal(chatter.note, undefined, 'only a yes has anything to correct');
  assert.deepEqual(calls, []);
  assert.equal(await engineApprovalWaiting(t.agentHandle), true);
});

test('a yes that also answers a parked approval ask settles neither and posts nothing', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const out = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'yes', { competing: 'send the invoice to accounts' })));
  assert.deepEqual(out, { result: null, rerun: null, ambiguous: true });
  assert.deepEqual(calls, []);
  assert.equal(await engineApprovalWaiting(t.agentHandle), true, 'still waiting for a yes that names it');
  assert.equal(decisions(t.id).at(-1), 'ambiguous');
});

test('the consent reader is shown a code-written action, never the engine\'s raw command', async () => {
  const t = mkTask();
  const seen: string[] = [];
  __setConsentLlmForTests(async (req) => {
    seen.push(JSON.stringify(req.messages));
    return { text: 'YES', toolCalls: [], stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test' };
  });
  try {
    await armEngineApproval(t, REQ, quiet, 'hermes');
    const calls: Calls = [];
    await withEngine('resolved', calls, () => waitingOn(REQ, () => resolveEngineApproval(reply(t, 'sure thing, go ahead with it'))));
    assert.equal(seen.length, 1, 'the lane read it');
    assert.ok(!seen[0].includes('rm -rf'), 'no engine command in the classify prompt');
    assert.ok(seen[0].includes('let their hermes run the one step it paused on (recursive delete)'));
    assert.deepEqual(calls, [[REQ.handle, 'once']]);
  } finally {
    __setConsentLlmForTests(unclearLane);
  }
});

const flush = () => new Promise(r => setTimeout(r, 30));
function relayFor(t: OpsTask, sent: string[], extended: number[]) {
  const relay = createEngineApprovalRelay(t, { send: async (_c, text) => { sent.push(text); return 'sent' as const; }, engineName: 'hermes' });
  return { relay, hooks: relay.hooks(ms => { extended.push(ms); }) };
}
const runB = { ...REQ, handle: { engine: 'hermes' as const, runId: 'run_b' }, command: 'rm -rf ~/other' };

test('a command they already said yes to is answered once, with no ask and no stretched clock', async () => {
  __resetOpsCoordination(); clearTraces();
  const t = mkTask({ preApproved: ['rm -rf ~/scratch'] });
  const sent: string[] = []; const extended: number[] = []; const calls: Calls = [];
  await withEngine('resolved', calls, async () => { relayFor(t, sent, extended).hooks.onApprovalRequest(REQ); await flush(); });
  assert.deepEqual(calls, [[REQ.handle, 'once']]);
  assert.deepEqual(sent, []);
  assert.deepEqual(extended, []);
  assert.equal(getTraces().filter(e => e.label === 'ops:engine_approval').at(-1)?.detail?.decision, 'pre_approved');
});

test('a pre-approved command is answered for them only once; the same command again is asked about', async () => {
  __resetOpsCoordination();
  const t = mkTask({ preApproved: ['rm -rf ~/scratch'] });
  const again = { ...REQ, handle: { engine: 'hermes' as const, runId: 'run_again' } };
  const sent: string[] = []; const extended: number[] = []; const calls: Calls = [];
  await withEngine('resolved', calls, async () => {
    const { hooks } = relayFor(t, sent, extended);
    hooks.onApprovalRequest(REQ);
    hooks.onApprovalRequest(again);
    await flush();
  });
  assert.deepEqual(calls, [[REQ.handle, 'once']], 'only the first is answered for them');
  assert.deepEqual(sent, [renderEngineApprovalAsk(again, 'hermes')]);
  assert.deepEqual(extended, [ENGINE_APPROVAL_WAIT_MS]);
});

test('a pre-approved command whose go-ahead cannot be delivered is asked about as usual', async () => {
  __resetOpsCoordination();
  const t = mkTask({ preApproved: ['rm -rf ~/scratch'] });
  const sent: string[] = []; const extended: number[] = [];
  await withEngine('failed', [], async () => { relayFor(t, sent, extended).hooks.onApprovalRequest(REQ); await flush(); });
  assert.equal(sent.length, 1);
  assert.deepEqual(extended, [ENGINE_APPROVAL_WAIT_MS]);
});

test('an ask stretches the leg, goes out, and holds the task as waiting until the engine says how it ended', async () => {
  __resetOpsCoordination();
  const t = mkTask();
  const sent: string[] = []; const extended: number[] = [];
  const { relay, hooks } = relayFor(t, sent, extended);
  hooks.onApprovalRequest(REQ);
  await flush();
  assert.deepEqual(sent, [renderEngineApprovalAsk(REQ, 'hermes')]);
  assert.deepEqual(extended, [ENGINE_APPROVAL_WAIT_MS]);
  assert.equal(relay.waiting(), true, 'progress pings stand down');
  hooks.onApprovalSettled(REQ.handle, 'answered');
  assert.equal(relay.waiting(), false);
});

test('a second ask for the same person waits its turn and goes out when the first is answered', async () => {
  __resetOpsCoordination();
  const t1 = mkTask(); const t2 = mkTask({ agentHandle: t1.agentHandle });
  const sent: string[] = [];
  const a = relayFor(t1, sent, []); const b = relayFor(t2, sent, []);
  a.hooks.onApprovalRequest(REQ); b.hooks.onApprovalRequest(runB);
  await flush();
  assert.equal(sent.length, 1, 'one live ask per person');
  a.hooks.onApprovalSettled(REQ.handle, 'answered');
  await flush();
  assert.deepEqual(sent, [renderEngineApprovalAsk(REQ, 'hermes'), renderEngineApprovalAsk(runB, 'hermes')]);
});

test('an unanswered ask is marked skipped before the next in line is asked, so the newer ask stands', async () => {
  __resetOpsCoordination();
  const t1 = mkTask(); const t2 = mkTask({ agentHandle: t1.agentHandle });
  const a = relayFor(t1, [], []); const b = relayFor(t2, [], []);
  a.hooks.onApprovalRequest(REQ); b.hooks.onApprovalRequest(runB);
  await flush();
  a.hooks.onApprovalSettled(REQ.handle, 'expired');
  await flush();
  const m = await getPreference<{ taskId: string; timedOut?: boolean }>(t1.agentHandle, ENGINE_APPROVAL_PREF);
  assert.equal(m?.taskId, t2.id);
  assert.equal(m?.timedOut, undefined);
});

test('a look called off asks nothing more, and an unanswered ask of it leaves nothing behind', async () => {
  __resetOpsCoordination();
  const t = mkTask();
  markOpsStart(t.chatId, t.id, { kind: t.kind, request: t.request });
  const sent: string[] = [];
  const { hooks } = relayFor(t, sent, []);
  hooks.onApprovalRequest(REQ);
  await flush();
  requestOpsCancel(t.chatId, t.id);
  hooks.onApprovalSettled(REQ.handle, 'expired');
  hooks.onApprovalRequest(runB);
  await flush();
  assert.equal(sent.length, 1, 'no ask after the stop');
  assert.equal(await engineApprovalWaiting(t.agentHandle), false);
});

test('runTask hands a leg\'s approval hooks to the engine untouched', async () => {
  let seen: EngineRunContext = {};
  resetEngineBackendCache({
    name: 'hermes',
    runTask: async (_p: string, _t: OpsTask, ctx: EngineRunContext) => { seen = ctx; return 'ANSWER: done\nFLAGS: none'; },
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; }, async listReminders() { return []; },
    async cancelReminder() { return false; }, async remember() {}, async probe() { return { ok: true }; }, async channelSend() { return {}; },
  });
  const hooks = { onApprovalRequest: () => {}, onApprovalSettled: () => {} };
  try { await runTask(mkTask(), undefined, undefined, undefined, undefined, hooks); } finally { resetEngineBackendCache(undefined); }
  assert.equal(seen.onApprovalRequest, hooks.onApprovalRequest);
  assert.equal(seen.onApprovalSettled, hooks.onApprovalSettled);
});

test('the answer hears about a step its own run left standing, and only its own', async () => {
  const t = mkTask();
  await armEngineApproval(t, REQ, quiet, 'hermes');
  await markEngineApprovalTimedOut(t.agentHandle, REQ.handle.runId);
  assert.deepEqual(await skippedEngineStep(t.agentHandle, t.id), { command: REQ.command, description: REQ.description });
  assert.equal(await skippedEngineStep(t.agentHandle, 'another-task'), null);
});

/** A promise the test lets go of: the in-flight window of a send or a POST. */
function held() {
  let release!: () => void;
  const until = new Promise<void>(r => { release = r; });
  return { until, release };
}

test('a wait that ends while its ask is still going out settles after the ask is recorded', async () => {
  __resetOpsCoordination();
  const t = mkTask();
  markOpsStart(t.chatId, t.id, { kind: t.kind, request: t.request });
  const send = held();
  const relay = createEngineApprovalRelay(t, { send: async () => { await send.until; return 'sent' as const; }, engineName: 'hermes' });
  const hooks = relay.hooks(() => {});
  hooks.onApprovalRequest(REQ);
  await flush();
  requestOpsCancel(t.chatId, t.id);
  hooks.onApprovalSettled(REQ.handle, 'expired');
  send.release();
  await flush();
  assert.equal(await engineApprovalWaiting(t.agentHandle), false, 'a look called off leaves no ask a later yes could re-run');
});

test('a pre-approved answer that fails after the engine stopped waiting asks nothing', async () => {
  __resetOpsCoordination();
  const t = mkTask({ preApproved: ['rm -rf ~/scratch'] });
  const post = held();
  __setEngineApprovalBackendForTests({ resolveRunApproval: async () => { await post.until; return 'failed'; } } as unknown as EngineBackend);
  const sent: string[] = []; const extended: number[] = [];
  try {
    const { hooks } = relayFor(t, sent, extended);
    hooks.onApprovalRequest(REQ);
    hooks.onApprovalSettled(REQ.handle, 'expired');
    post.release();
    await flush();
  } finally {
    __setEngineApprovalBackendForTests(undefined);
  }
  assert.deepEqual(sent, [], 'a settled run takes no place in their line');
  assert.deepEqual(extended, []);
});

test('an answer that lands after a newer ask went out never erases the newer ask', async () => {
  const t1 = mkTask(); const t2 = mkTask({ agentHandle: t1.agentHandle });
  await armEngineApproval(t1, REQ, quiet, 'hermes');
  const post = held();
  __setEngineApprovalBackendForTests({ resolveRunApproval: async () => { await post.until; return 'resolved'; } } as unknown as EngineBackend);
  try {
    const answering = waitingOn(REQ, () => resolveEngineApproval(reply(t1, 'yes')));
    await flush();
    await armEngineApproval(t2, runB, quiet, 'hermes');
    post.release();
    await answering;
  } finally {
    __setEngineApprovalBackendForTests(undefined);
  }
  const m = await getPreference<{ taskId: string }>(t1.agentHandle, ENGINE_APPROVAL_PREF);
  assert.equal(m?.taskId, t2.id, 'the newer ask still stands');
});

/** A look whose engine pauses on REQ mid-run and then answers; `send` is the mouth it delivers through. */
async function lookThatAsked(t: OpsTask, send: (chatId: string, content: string | (() => Promise<string | null>)) => Promise<'sent' | 'dropped'>): Promise<void> {
  __resetOpsCoordination();
  resetEngineBackendCache({
    name: 'hermes',
    runTask: async (_p: string, _t: OpsTask, ctx: EngineRunContext) => { ctx.onApprovalRequest?.(REQ); await flush(); return 'ANSWER: done\nFLAGS: none'; },
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; }, async listReminders() { return []; },
    async cancelReminder() { return false; }, async remember() {}, async probe() { return { ok: true }; }, async channelSend() { return {}; },
  });
  try {
    await runOpsAndFollowUp(t, send);
  } finally {
    resetEngineBackendCache(undefined);
  }
  await flush();
}

test('a look whose message never named its step clears it: the fallback voicing, or a run that threw', async () => {
  // No LLM lane in tests, so the composer fails and Fallfirm's fallback is what goes out.
  const fallback = mkTask();
  await lookThatAsked(fallback, async (_c, content) => { if (typeof content === 'function') await content(); return 'sent'; });
  assert.equal(await getPreference(fallback.agentHandle, ENGINE_APPROVAL_PREF), null, 'the fallback never named the step');
  // The ask goes out; the follow-up's delivery throws, so only the snag line is tried.
  const threw = mkTask();
  await lookThatAsked(threw, async (_c, content) => { if (typeof content === 'function') throw new Error('mouth down'); return 'sent'; });
  assert.equal(await getPreference(threw.agentHandle, ENGINE_APPROVAL_PREF), null, 'the snag line never named it');
});

test('a finished look keeps its step only when the message they read named it', async () => {
  const live = mkTask();
  await armEngineApproval(live, REQ, quiet, 'hermes');
  await settleLookEngineAsk(live, false);
  assert.equal(await getPreference(live.agentHandle, ENGINE_APPROVAL_PREF), null, 'a live step they were never told of goes');
  const skipped = mkTask();
  await armEngineApproval(skipped, REQ, quiet, 'hermes');
  await markEngineApprovalTimedOut(skipped.agentHandle, REQ.handle.runId);
  await settleLookEngineAsk(skipped, false);
  assert.equal(await getPreference(skipped.agentHandle, ENGINE_APPROVAL_PREF), null, 'and so does a skipped one');
  const told = mkTask();
  await armEngineApproval(told, REQ, quiet, 'hermes');
  await settleLookEngineAsk(told, true);
  const kept = await getPreference<{ taskId: string; timedOut?: boolean }>(told.agentHandle, ENGINE_APPROVAL_PREF);
  assert.equal(kept?.taskId, told.id);
  assert.equal(kept?.timedOut, true, 'an answer that named it keeps it for the late yes it promised');
});

test('a relay step that fails says so in the log', async () => {
  __resetOpsCoordination();
  const t = mkTask({ preApproved: ['rm -rf ~/scratch'] });
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(String(a[0])); };
  try {
    await withEngine('failed', [], async () => {
      createEngineApprovalRelay(t, { send: quiet, engineName: 'hermes' }).hooks(() => { throw new Error('clock gone'); }).onApprovalRequest(REQ);
      await flush();
    });
  } finally {
    console.warn = warn;
  }
  assert.ok(warned.some(w => /pre-approved/.test(w)), `warned: ${JSON.stringify(warned)}`);
});

test('a queued ask its run has moved past sends nothing: the run now waits on another command', async () => {
  __resetOpsCoordination();
  const t0 = mkTask(); const t = mkTask({ agentHandle: t0.agentHandle });
  const sent: string[] = [];
  const first = relayFor(t0, sent, []);
  first.hooks.onApprovalRequest(runB);
  await flush();
  const { hooks } = relayFor(t, sent, []);
  const cmd2 = { ...REQ, command: 'rm -rf ~/elsewhere' };
  hooks.onApprovalRequest(REQ);
  hooks.onApprovalRequest(cmd2);
  first.hooks.onApprovalSettled(runB.handle, 'answered');
  await flush();
  assert.ok(!sent.includes(renderEngineApprovalAsk(REQ, 'hermes')), 'the first command is never asked: a yes to it would clear the second');
});

test('a yes to a command its run has moved past posts nothing, and re-runs exactly the command they saw', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const cmd2 = { ...REQ, command: 'rm -rf ~/elsewhere' };
  const out = await withEngine('resolved', calls, () => waitingOn(cmd2, () => resolveEngineApproval(reply(t, 'yes'))));
  assert.deepEqual(calls, [], 'no once: the engine would apply it to the command they never saw');
  assert.deepEqual(out.rerun?.preApproved, [REQ.command]);
  assert.ok(out.rerun?.engineActions?.[0].endsWith(JSON.stringify(REQ.command)));
  assert.equal(await engineApprovalWaiting(t.agentHandle), false);
});

test('a bare acknowledgement of a skipped step is no answer; a clear yes still re-runs it', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  await markEngineApprovalTimedOut(t.agentHandle, REQ.handle.runId);
  const ack = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'ok thanks')));
  assert.deepEqual(ack, { result: null, rerun: null }, 'thanks for telling me is not a go');
  const last = getTraces().filter(e => e.label === 'ops:engine_approval' && e.taskId === t.id).at(-1)?.detail as { decision?: string; reason?: string } | undefined;
  assert.equal(last?.decision, 'unclear');
  assert.equal(last?.reason, 'acknowledgement');
  assert.equal(await engineApprovalWaiting(t.agentHandle), true, 'the step still waits on a clear answer');
  const yes = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'yes')));
  assert.ok(yes.rerun, 'a clear yes still gets it done');
  assert.deepEqual(calls, [], 'nothing posted either way: the engine stopped waiting');
});

test('live, the ask itself asked go or no, so an ok answers it', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  await withEngine('resolved', calls, () => waitingOn(REQ, () => resolveEngineApproval(reply(t, 'ok'))));
  assert.deepEqual(calls, [[REQ.handle, 'once']]);
});
