// The engine's dangerous-command ask, relayed and answered (agents/ops/engineApproval.ts).
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armEngineApproval, resolveEngineApproval, markEngineApprovalTimedOut, clearEngineApproval,
  engineApprovalWaiting, renderEngineApprovalAsk, __setEngineApprovalBackendForTests,
} from './engineApproval.js';
import type { EngineBackend, EngineRunHandle } from './engineBackend.js';
import { __setConsentLlmForTests } from './consent.js';
import { PENDING_ASK_TTL_MS } from '../../memory/dossier.js';
import { markOpsStart, engineAskDeclined, __resetOpsCoordination } from '../../state/opsCoordination.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask } from '../types.js';

__setConsentLlmForTests(async () => ({ text: 'UNCLEAR', toolCalls: [], stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test' }));

const REQ = { handle: { engine: 'hermes' as const, runId: 'run_x' }, command: 'rm -rf ~/scratch', description: 'recursive delete' };
let seq = 0;
function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  const n = (seq++).toString().padStart(4, '0');
  return { id: `t${n}`, chatId: `c${n}`, agentHandle: `+1555934${n}`, kind: 'general', request: 'clear out my scratch folder', effect: 'read', createdAt: Date.now(), media: emptyMedia(), ...over };
}
const quiet = async () => {};
const reply = (t: OpsTask, text: string) => ({ sender: t.agentHandle, text, chatId: t.chatId, handle: t.agentHandle });
type Calls = Array<[EngineRunHandle, string]>;
async function withEngine<T>(outcome: 'resolved' | 'not_pending' | 'failed', calls: Calls, fn: () => Promise<T>): Promise<T> {
  __setEngineApprovalBackendForTests({ resolveRunApproval: async (h: EngineRunHandle, c: 'once' | 'deny') => { calls.push([h, c]); return outcome; } } as unknown as EngineBackend);
  try { return await fn(); } finally { __setEngineApprovalBackendForTests(undefined); }
}

test('the ask goes out with the command exactly as the engine reported it, and the marker is written first', async () => {
  const t = mkTask();
  const sent: string[] = [];
  let standingAtSend = false;
  await armEngineApproval(t, REQ, async (_chat, text) => { standingAtSend = await engineApprovalWaiting(t.agentHandle); sent.push(text); }, 'hermes');
  assert.deepEqual(sent, [renderEngineApprovalAsk(REQ, 'hermes')]);
  assert.match(sent[0], /^your hermes wants to run this before it carries on \(recursive delete\)\nrm -rf ~\/scratch\ngo or no\?$/);
  assert.equal(standingAtSend, true, 'a reply racing the send still finds it');
});

test('a yes lets that one command run once, and the ask is gone', async () => {
  const t = mkTask();
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const out = await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'go')));
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
  const out = await withEngine('failed', [], () => resolveEngineApproval(reply(t, 'yes')));
  assert.equal(out.result?.status, 'unavailable', 'never an outcome-pass status: there is nothing a second draft could fix');
  assert.match(out.result!.detail, /did not reach the engine/);
  assert.equal(await engineApprovalWaiting(t.agentHandle), true, 'their next yes can try again');
});

test('a yes after the engine stopped waiting comes back as a fresh run of just that step', async () => {
  const t = mkTask({ kind: 'compute', effect: 'act', approval: { askedAt: 1, approvedAt: 2 }, engineActions: ['install the cleaner skill'], room: true });
  const calls: Calls = [];
  await armEngineApproval(t, REQ, quiet, 'hermes');
  const out = await withEngine('not_pending', calls, () => resolveEngineApproval(reply(t, 'yes')));
  const r = out.rerun!;
  assert.ok(r, 'a re-run was built');
  assert.notEqual(r.id, t.id);
  assert.equal(r.chatId, t.chatId);
  assert.equal(r.agentHandle, t.agentHandle);
  assert.deepEqual(r.preApproved, ['rm -rf ~/scratch']);
  assert.equal(r.followUpOf, t.id);
  assert.equal(r.kind, 'compute');
  assert.equal(r.effect, 'act');
  assert.deepEqual(r.approval, { askedAt: 1, approvedAt: 2 }, 'an approved act keeps its AUTHORIZED ACTION line');
  assert.equal(r.room, true);
  assert.equal(r.engineActions, undefined, 'the first run already did its setup');
  assert.match(r.request, /held waiting on their OK while working on "clear out my scratch folder"/);
  assert.match(r.request, /rm -rf ~\/scratch/);
  assert.equal(out.result?.status, 'done');
  assert.equal(await engineApprovalWaiting(t.agentHandle), false);
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
  await withEngine('resolved', calls, () => resolveEngineApproval(reply(t, 'yes')));
  assert.deepEqual(calls, [[REQ.handle, 'once']], 'still live: the yes went to the engine');
});

test('a skipped step outlives its task; a live ask does not; a look called off leaves neither', async () => {
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
