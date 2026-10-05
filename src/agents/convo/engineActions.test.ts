// The acting half of an ask. A message can carry two parts — something to set up on the engine's
// side, and something to find out — and before `engine_actions` existed there was nowhere for the
// first part to travel: `request` distils ONE ask, so delegation shipped the research half and
// dropped the rest, with nothing downstream able to tell that a part was missing.
//
// End to end through processConvoResult with the model faked at the lane seam (the pattern of
// approvalGate.test.ts), so the task, the in-flight registry and the durable row are the live ones.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext, type ConvoTurnContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination, getActiveOps, markOpsStart } from '../../state/opsCoordination.js';
import { listPendingApprovals } from '../../db/repositories/opsTasks.js';
import { buildTaskPrompt } from '../ops/client.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';
import { __setHostSetupLlmForTests } from '../ops/riskGate.js';
import type { OpsTask } from '../types.js';

// The host-setup lane, faked: an action the English list cannot read would otherwise be a network
// call in a unit suite.
__setHostSetupLlmForTests(async () => ({ text: 'SAFE', toolCalls: [], stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test' }));

/** The task the turn built: handed back for kickoff, or parked behind their yes (an install waits). */
function builtTask(out: { delegatedTask: OpsTask | null }, chatId: string): OpsTask {
  const task = out.delegatedTask ?? (listPendingApprovals(chatId)[0]?.meta.task as OpsTask | undefined);
  assert.ok(task, 'the turn built a task');
  return task;
}

// The shape the incident had: one setup the engine performs on its own side, one thing to find out.
const SETUP = 'install the skill published at the url they gave and the CLI it needs';
const ASK = 'what the search APIs charge per 1,000 searches';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 90,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function delegate(input: Record<string, unknown>): LlmToolCall {
  return { name: 'delegate_to_ops', input: { kind: 'general', ...input } };
}

let seq = 0;
function args(textToSend: string) {
  __resetOpsCoordination();
  const sender = `+1555930${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia(), textToSend };
}

const turn: ConvoTurnContext = {
  system: 'persona',
  messages: [{ role: 'user', content: 'hey' }],
  tools: [],
  call: async () => makeResult(['unused']),
};

test('a two-part ask carries the acting half on the task, in the order it was asked', async () => {
  const a = args(`set that skill up, then find ${ASK}`);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it — skill first, then the price'], [delegate({
      request: ASK, engine_actions: [SETUP, 'run the CLI once to confirm it answers'],
    })]),
    turn,
  });
  assert.deepEqual(builtTask(out, a.chatId).engineActions, [SETUP, 'run the CLI once to confirm it answers'],
    'both actions ride the task, in order, nothing dropped');
  assert.equal(builtTask(out, a.chatId).request, ASK);
});

// The incident end to end, in one test: the whole ask leaves the turn, and the prompt the engine is
// handed carries the acting half as work to perform rather than as text it is told to disregard.
test('the task the turn built renders an engine prompt that carries both halves', async () => {
  const a = args(`set that skill up, then find ${ASK}`);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it'], [delegate({ request: ASK, engine_actions: [SETUP] })]),
    turn,
  });
  const prompt = buildTaskPrompt(builtTask(out, a.chatId), { now: Date.parse('2026-09-19T09:30:00Z'), tz: 'UTC' });
  assert.match(prompt, /Required actions \(do these first, they are part of the assignment, not optional\):/);
  assert.match(prompt, new RegExp(`^1\\. ${SETUP}$`, 'm'));
  assert.ok(prompt.indexOf(SETUP) < prompt.indexOf('<user_request>'), 'in the instruction layer');
  assert.match(prompt, /<user_request>[\s\S]*what the search APIs charge/, 'and the reading half is still the request');
});

test('the actions are tracked where the next turn can read them back', () => {
  __resetOpsCoordination();
  const chatId = randomUUID();
  markOpsStart(chatId, 'task-1', { kind: 'general', request: ASK, engineActions: [SETUP] });
  assert.deepEqual(getActiveOps(chatId)[0].engineActions, [SETUP]);
});

test('a run that was asked for no action carries the field not at all', () => {
  __resetOpsCoordination();
  const chatId = randomUUID();
  markOpsStart(chatId, 'task-2', { kind: 'web_research', request: ASK });
  assert.equal('engineActions' in getActiveOps(chatId)[0], false,
    'absent rather than empty — an ordinary run stays the bytes it was');
});

test('a garbled or empty actions argument leaves the field off rather than tracking nothing', async () => {
  // A lone non-blank string is one action, not garbage (convo/taintGate.test.ts pins that it is gated).
  for (const engine_actions of [[], ['', '   '], '   ', 7, null]) {
    const a = args('go find that');
    const out = await processConvoResult({
      ...a,
      res: makeResult(['looking'], [delegate({ request: ASK, engine_actions })]),
      turn,
    });
    assert.equal(out.delegatedTask!.engineActions, undefined, `${JSON.stringify(engine_actions)} tracks nothing`);
  }
});

// The approval gate's first reason is an action on the USER's accounts. An action on the engine's
// own environment is not one: it never becomes `act`. Since 2026-10-04 an install still waits for
// a yes, as host setup (agents/ops/riskGate.ts), and a setup that brings nothing new in starts.
test('an engine-side install waits for a yes as host setup, and stays a read', async () => {
  const a = args('set that skill up and then look this up');
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it'], [delegate({ request: ASK, engine_actions: [SETUP] })]),
    turn,
  });
  assert.equal(out.delegatedTask, null, 'nothing starts');
  const task = listPendingApprovals(a.chatId)[0]?.meta.task as Record<string, unknown>;
  assert.equal(task.effect, 'read', 'a setup is never an act on the world');
  assert.deepEqual(task.engineActions, [SETUP]);
});

test('an engine-side setup that brings nothing new in starts straight away', async () => {
  const a = args('check again in two hours');
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it'], [delegate({ request: ASK, engine_actions: ['set yourself a follow-up check in two hours'] })]),
    turn,
  });
  assert.ok(out.delegatedTask, 'the task goes out for kickoff');
  assert.equal(out.delegatedTask!.effect, 'read');
  assert.equal(out.delegatedTask!.approval, undefined);
  assert.equal(listPendingApprovals(a.chatId).length, 0, 'no approval row');
});

// The bypass the twin above opens if the gate is left reading only `request`. The tool text tells
// the model that engine work stays "read", so a model that files an action on the USER's accounts
// as an engine action hands the gate a request nothing in it is about — and the block below it
// renders that action as mandatory. Every entry is therefore screened exactly like the request.
test('an action on the USER\'s accounts parks, wherever in the call it was written', async () => {
  const a = args('find the cheapest flight thursday');
  const { turn: reask } = { turn: {
    system: 'persona',
    messages: [{ role: 'user' as const, content: 'hey' }],
    tools: [],
    call: async () => makeResult(['want me to actually book it?']),
  } as ConvoTurnContext };
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it'], [delegate({
      request: 'the cheapest flight thursday', effect: 'read',
      engine_actions: ['book it on their account once you find it'],
    })]),
    turn: reask,
  });
  assert.equal(out.delegatedTask, null, 'nothing starts');
  const parked = listPendingApprovals(a.chatId);
  assert.equal(parked.length, 1, 'it parks behind a yes like any other action in the world');
  const task = parked[0].meta.task as Record<string, unknown>;
  assert.equal(task.effect, 'act');
  assert.deepEqual(task.engineActions, ['book it on their account once you find it'],
    'and the action is still on the task, so the yes runs the brief she asked about');
});

test('the rendered block tells the engine what it may NOT be asked to do', async () => {
  const a = args('set that skill up and then look this up');
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it'], [delegate({ request: ASK, engine_actions: [SETUP] })]),
    turn,
  });
  const prompt = buildTaskPrompt(builtTask(out, a.chatId), { now: Date.parse('2026-09-19T09:30:00Z'), tz: 'UTC' });
  assert.match(prompt, /These are actions on your own side\./);
  assert.match(prompt, /touch the user's accounts, messages, money or bookings/);
  assert.match(prompt, /refuse it and report it as refused on the ACTIONS line/);
});
