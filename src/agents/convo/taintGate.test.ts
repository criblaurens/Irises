// src/agents/convo/taintGate.test.ts
// The taint gate: an engine action waits for their yes when it would set something up on their
// machine, or when text from outside is in her context. End to end through processConvoResult,
// on the approvalGate.test.ts harness. The DB is the real ephemeral SQLite.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext, type ConvoTurnContext } from './shared.js';
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
