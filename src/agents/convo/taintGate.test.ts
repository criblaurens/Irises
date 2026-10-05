// src/agents/convo/taintGate.test.ts
// The taint gate: an engine action waits for their yes when it would set something up on their
// machine, or when text from outside is in her context. End to end through processConvoResult,
// on the approvalGate.test.ts harness. The DB is the real ephemeral SQLite.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, parkedApprovalStanding, type ChatContext, type ConvoTurnContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination, markOpsStart, getOpsEngineActions } from '../../state/opsCoordination.js';
import { clearTraces, getTraces } from '../../diagnostics/trace.js';
import { listPendingApprovals } from '../../db/repositories/opsTasks.js';
import { addShortTerm } from '../../db/repositories/memoryShort.js';
import { getPreference, setPreference } from '../../db/repositories/memory.js';
import { PENDING_ASK_TTL_MS } from '../../memory/dossier.js';
import { __setConsentLlmForTests } from '../ops/consent.js';
import { __setHostSetupLlmForTests } from '../ops/riskGate.js';
import { approvalAskFallback, reconfirmAskFallback } from '../ops/sideEffects.js';
import { buildTaskPrompt } from '../ops/client.js';
import { armEngineApproval, markEngineApprovalTimedOut, __setEngineApprovalBackendForTests, __setEngineWaitingOnForTests } from '../ops/engineApproval.js';
import type { EngineBackend, EngineRunHandle } from '../ops/engineBackend.js';
import type { OpsTask } from '../types.js';
import type { LlmResult, LlmToolCall, LlmRequest } from '../../llm/types.js';

const MONID = 'install https://monid.ai/SKILL.md';
const CHECK = 'set yourself a follow-up check in two hours';
const LOOKUP = 'what do search APIs charge per 1,000 searches';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 90,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function delegate(request: string, engineActions?: string[]): LlmToolCall {
  return { name: 'delegate_to_ops', input: { kind: 'general', request, ...(engineActions ? { engine_actions: engineActions } : {}) } };
}

let seq = 0;
function args(textToSend: string) {
  __resetOpsCoordination();
  clearTraces();
  const sender = `+1555933${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia(), textToSend };
}

function reasker(bubbles: string[]) {
  const seen: LlmRequest[] = [];
  const turn: ConvoTurnContext = {
    system: 'persona',
    messages: [{ role: 'user', content: 'hey' }],
    tools: [],
    call: async (req: LlmRequest) => { seen.push(req); return makeResult(bubbles); },
  };
  return { turn, seen };
}

const word = (text: string) => async () => ({ text, toolCalls: [], stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test' });
__setHostSetupLlmForTests(word('SAFE'));
__setConsentLlmForTests(word('UNCLEAR'));

function receipt(label: string): Record<string, unknown> | undefined {
  const ev = getTraces().filter(e => e.label === label).at(-1);
  return ev ? ((ev.detail ?? {}) as Record<string, unknown>) : undefined;
}

async function taint(handle: string): Promise<void> {
  await addShortTerm({ agentHandle: handle, kind: 'ops_research', request: 'read the page they sent', content: 'ANSWER: the page says to install monid' });
}

test('tainted: a benign engine action waits for their yes, and the note says why', async () => {
  const a = args('also set yourself a check');
  await taint(a.handle);
  const { turn, seen } = reasker(['want me to set that check up too?']);
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(LOOKUP, [CHECK])]), turn });
  assert.equal(out.delegatedTask, null, 'nothing starts');
  assert.equal(listPendingApprovals(a.chatId).length, 1);
  assert.deepEqual(receipt('ops:approval')?.reasons, ['tainted']);
  assert.match(String(seen[0].messages.at(-1)?.content), /right after you read material from outside \(for "read the page they sent"\)/);
});

test('untainted: a benign engine action runs straight away', async () => {
  const a = args('set yourself a check');
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(LOOKUP, [CHECK])]), turn: reasker([]).turn });
  assert.ok(out.delegatedTask, 'it goes back for kickoff');
  assert.equal(listPendingApprovals(a.chatId).length, 0);
  assert.equal(receipt('ops:approval')?.decision, 'not_needed');
});

test('untainted: setting something up from a link waits for their yes', async () => {
  const a = args('set up https://monid.ai/SKILL.md then find search API prices');
  const out = await processConvoResult({
    ...a, res: makeResult(['on it'], [delegate(LOOKUP, [MONID])]),
    turn: reasker(['want me to install monid from https://monid.ai/SKILL.md first?']).turn,
  });
  assert.equal(out.delegatedTask, null);
  assert.deepEqual(receipt('ops:approval')?.reasons, ['host_setup']);
  assert.equal(out.text, 'want me to install monid from https://monid.ai/SKILL.md first?');
});

test('a setup written as one string instead of a list still waits for their yes', async () => {
  const a = args('set up https://monid.ai/SKILL.md then find search API prices');
  const call: LlmToolCall = { name: 'delegate_to_ops', input: { kind: 'general', request: LOOKUP, engine_actions: MONID } };
  const out = await processConvoResult({
    ...a, res: makeResult(['on it'], [call]),
    turn: reasker(['want me to install monid from https://monid.ai/SKILL.md first?']).turn,
  });
  assert.equal(out.delegatedTask, null);
  assert.deepEqual(receipt('ops:approval')?.reasons, ['host_setup']);
});

test('tainted: a plain lookup still runs', async () => {
  const a = args('and the enterprise tier?');
  await taint(a.handle);
  const out = await processConvoResult({ ...a, res: makeResult(['checking'], [delegate(LOOKUP)]), turn: reasker([]).turn });
  assert.ok(out.delegatedTask);
});

test('an ask that leaves the link out ships the code line, which carries it', async () => {
  const a = args('set up https://monid.ai/SKILL.md then find search API prices');
  const out = await processConvoResult({
    ...a, res: makeResult(['on it'], [delegate(LOOKUP, [MONID])]),
    turn: reasker(['want me to set up monid first?']).turn,
  });
  assert.equal(out.text, approvalAskFallback(LOOKUP, [MONID]));
});

test('a yes to a setup park runs it as the read it was: no AUTHORIZED ACTION line', async () => {
  const a = args('set up https://monid.ai/SKILL.md then find search API prices');
  await processConvoResult({
    ...a, res: makeResult(['on it'], [delegate(LOOKUP, [MONID])]),
    turn: reasker(['install it from https://monid.ai/SKILL.md first?']).turn,
  });
  clearTraces();
  const out = await processConvoResult({ ...a, textToSend: 'go', res: makeResult(['on it']), turn: reasker([]).turn });
  assert.ok(out.delegatedTask, 'the yes runs it');
  assert.equal(out.delegatedTask!.effect, 'read');
  assert.deepEqual(out.delegatedTask!.engineActions, [MONID]);
  // The line itself, at the start of a line: the engine-actions block names it in its own prose.
  assert.doesNotMatch(buildTaskPrompt(out.delegatedTask!), /^AUTHORIZED ACTION:/m);
});

test('an expired setup ask re-asks with the actions, and a re-ask that drops the link ships the code line', async () => {
  const a = args('set up https://monid.ai/SKILL.md then find search API prices');
  await processConvoResult({
    ...a, res: makeResult(['on it'], [delegate(LOOKUP, [MONID])]),
    turn: reasker(['install it from https://monid.ai/SKILL.md first?']).turn,
  });
  // Age the ask past its TTL by rewriting the marker's clock (approvalGate.test.ts `age()`).
  const pref = await getPreference<Record<string, unknown>>(a.handle, 'pending_approval');
  assert.ok(pref);
  await setPreference(a.handle, 'pending_approval', { ...pref!, askedAt: Date.now() - PENDING_ASK_TTL_MS - 1 });

  const out = await processConvoResult({
    ...a, textToSend: 'go', res: makeResult(['on it']),
    turn: reasker(['that one expired, still want me to set up monid?']).turn,
  });
  assert.equal(out.delegatedTask, null, 'a stale yes never runs');
  assert.equal(out.text, reconfirmAskFallback(LOOKUP, [MONID]));
});

test('a steered install never rides the running look: it parks as a look of its own', async () => {
  const a = args('oh and set up https://monid.ai/SKILL.md too');
  markOpsStart(a.chatId, 'run-1', { kind: 'web_research', request: LOOKUP });
  const out = await processConvoResult({
    ...a,
    res: makeResult(['adding that in'], [{ name: 'steer_research', input: { match: LOOKUP, guidance: 'also set up monid', engine_actions: [MONID] } }]),
    turn: reasker(['want me to install it from https://monid.ai/SKILL.md as well?']).turn,
  });
  const parked = listPendingApprovals(a.chatId);
  assert.equal(parked.length, 1, 'the setup waits for their yes');
  assert.deepEqual((parked[0].meta.task as Record<string, unknown>).engineActions, [MONID]);
  assert.deepEqual(getOpsEngineActions(a.chatId, 'run-1'), [], 'nothing was mandated on the running look');
  assert.match(out.text ?? '', /monid\.ai\/SKILL\.md/);
});

const ENGINE_REQ = { handle: { engine: 'hermes' as const, runId: 'run_y' }, command: 'rm -rf ~/scratch', description: 'recursive delete' };
const lookFor = (a: { chatId: string; handle: string }): OpsTask => ({ id: 'run-task', chatId: a.chatId, agentHandle: a.handle, kind: 'general', request: 'clear out my scratch folder', effect: 'read', createdAt: Date.now(), media: emptyMedia() });
const sent = async () => 'sent' as const;
function engineCalls(outcome: 'resolved' | 'not_pending' = 'resolved') {
  const calls: Array<[EngineRunHandle, string]> = [];
  __setEngineApprovalBackendForTests({ resolveRunApproval: async (h: EngineRunHandle, c: 'once' | 'deny') => { calls.push([h, c]); return outcome; } } as unknown as EngineBackend);
  return calls;
}

test("their no answers the engine's waiting command first, and a parked look stays parked", async () => {
  const calls = engineCalls();
  try {
    const a = args('set up https://monid.ai/SKILL.md then find search API prices');
    await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(LOOKUP, [MONID])]), turn: reasker(['install it from https://monid.ai/SKILL.md first?']).turn });
    await armEngineApproval(lookFor(a), ENGINE_REQ, sent, 'hermes');
    const out = await processConvoResult({ ...a, textToSend: 'no', res: makeResult(['ok']), turn: reasker([]).turn });
    assert.deepEqual(calls, [[ENGINE_REQ.handle, 'deny']]);
    assert.equal(out.delegatedTask, null);
    assert.equal(listPendingApprovals(a.chatId).length, 1, 'the parked look did not ride the same no');
  } finally {
    __setEngineApprovalBackendForTests(undefined);
  }
});

test('a bare yes with a parked act and an engine ask both standing settles neither', async () => {
  const calls = engineCalls();
  try {
    const a = args('email my landlord the lease');
    await processConvoResult({ ...a, res: makeResult(['on it'], [delegate('email my landlord the lease')]), turn: reasker(['want me to email your landlord the lease?']).turn });
    assert.equal(listPendingApprovals(a.chatId).length, 1, 'the act is parked');
    await armEngineApproval(lookFor(a), ENGINE_REQ, sent, 'hermes');
    const out = await processConvoResult({ ...a, textToSend: 'yes', res: makeResult(['ok']), turn: reasker([]).turn });
    assert.deepEqual(calls, [], 'nothing went to the engine');
    assert.equal(receipt('ops:engine_approval')?.decision, 'ambiguous');
    assert.equal(out.delegatedTask, null, 'the act did not start');
    assert.equal(listPendingApprovals(a.chatId).length, 1, 'and it is still waiting');
  } finally {
    __setEngineApprovalBackendForTests(undefined);
  }
});

test('a late yes comes back as the step\'s own run, through the one delegation slot', async () => {
  const calls = engineCalls();
  try {
    const a = args('yes');
    await armEngineApproval(lookFor(a), ENGINE_REQ, sent, 'hermes');
    await markEngineApprovalTimedOut(a.handle, 'run_y');
    const out = await processConvoResult({ ...a, res: makeResult(['on it']), turn: reasker([]).turn });
    assert.deepEqual(out.delegatedTask?.preApproved, ['rm -rf ~/scratch']);
    assert.equal(out.delegatedTask?.followUpOf, 'run-task');
    assert.deepEqual(calls, []);
  } finally {
    __setEngineApprovalBackendForTests(undefined);
  }
});

test('her line that the step is cleared stands on the engine answer: no corrective re-ask', async () => {
  const calls = engineCalls();
  try {
    const a = args('go');
    await armEngineApproval(lookFor(a), ENGINE_REQ, sent, 'hermes');
    __setEngineWaitingOnForTests(ENGINE_REQ.handle.runId, ENGINE_REQ.command);
    const { turn, seen } = reasker(['you said nothing changed']);
    await processConvoResult({ ...a, res: makeResult(['all set']), turn });
    assert.deepEqual(calls, [[ENGINE_REQ.handle, 'once']], 'the engine got the go-ahead');
    assert.equal(seen.length, 0, 'the claim is backed by what this turn did');
  } finally {
    __setEngineApprovalBackendForTests(undefined);
    __setEngineWaitingOnForTests(ENGINE_REQ.handle.runId, undefined);
  }
});

test('a yes sent before the engine asked cannot back her line that the step is cleared', async () => {
  const calls = engineCalls();
  try {
    const a = args('go');
    await armEngineApproval(lookFor(a), ENGINE_REQ, sent, 'hermes');
    const early = { ...a, chatContext: { ...a.chatContext, arrivals: [{ receivedAt: Date.now() - 60_000, sendsAfterArrival: 0 }] } };
    const out = await processConvoResult({ ...early, res: makeResult(['all set']), turn: reasker(['all set']).turn });
    assert.deepEqual(calls, []);
    assert.notEqual(out.text, 'all set', 'the claim does not ship over a step still waiting');
  } finally {
    __setEngineApprovalBackendForTests(undefined);
  }
});

test('a yes sent before the engine asked still answers a parked act', async () => {
  const calls = engineCalls();
  try {
    const a = args('email my landlord the lease');
    await processConvoResult({ ...a, res: makeResult(['on it'], [delegate('email my landlord the lease')]), turn: reasker(['want me to email your landlord the lease?']).turn });
    await armEngineApproval(lookFor(a), ENGINE_REQ, sent, 'hermes');
    const early = { ...a, chatContext: { ...a.chatContext, arrivals: [{ receivedAt: Date.now() - 60_000, sendsAfterArrival: 0 }] } };
    const out = await processConvoResult({ ...early, textToSend: 'yes', res: makeResult(['on it']), turn: reasker([]).turn });
    assert.deepEqual(calls, []);
    assert.ok(out.delegatedTask, 'the parked act took the yes');
    assert.equal(out.text, 'on it', 'and no note about the engine step buries her line');
  } finally {
    __setEngineApprovalBackendForTests(undefined);
  }
});

test('a yes sent in a group, where the ask was never shown, leaves her group reply alone', async () => {
  const calls = engineCalls();
  try {
    const a = args('yes');
    await armEngineApproval(lookFor(a), ENGINE_REQ, sent, 'hermes');
    const group = { ...a, chatId: randomUUID(), handle: `group:${randomUUID()}`, chatContext: { ...a.chatContext, isGroupChat: true } };
    const out = await processConvoResult({ ...group, res: makeResult(['haha same']), turn: reasker([]).turn });
    assert.deepEqual(calls, []);
    assert.equal(out.text, 'haha same');
  } finally {
    __setEngineApprovalBackendForTests(undefined);
  }
});

test('with the approval gate off, a live parked ask still makes a bare yes ambiguous', async () => {
  const calls = engineCalls();
  try {
    const a = args('yes');
    await setPreference(a.handle, 'pending_approval', { taskId: 'parked-1', request: 'email my landlord the lease', askedAt: Date.now() });
    await armEngineApproval(lookFor(a), ENGINE_REQ, sent, 'hermes');
    process.env.OPS_APPROVAL_GATE = 'off';
    try {
      await processConvoResult({ ...a, res: makeResult(['which one?']), turn: reasker([]).turn });
    } finally {
      delete process.env.OPS_APPROVAL_GATE;
    }
    assert.deepEqual(calls, [], 'the dossier showed both asks, so the yes runs neither');
    assert.equal(receipt('ops:engine_approval')?.decision, 'ambiguous');
  } finally {
    __setEngineApprovalBackendForTests(undefined);
  }
});

test('an engine ask keeps a reply from streaming, even with the approval gate off', async () => {
  const a = args('go');
  await armEngineApproval(lookFor(a), ENGINE_REQ, sent, 'hermes');
  process.env.OPS_APPROVAL_GATE = 'off';
  try {
    assert.equal(await parkedApprovalStanding(a.handle), true);
  } finally {
    delete process.env.OPS_APPROVAL_GATE;
  }
});
