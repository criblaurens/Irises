// Coverage for the silent-turn floor — the recovery under a turn that answers a REAL inbound message
// with nothing at all (empty `bubbles`, null `tool_calls`). Observed live on a weak model: the user
// sent a question and got literally nothing back, no signal anything had happened. For a texting
// assistant that silence IS the failure, so the turn retries the same input ONCE and then falls to
// the Fallfirm voicer (and, under it, the hardcoded floor) rather than leaving them on read.
//
// The ask used here is deliberately SOCIAL: a grounding-required message never reaches this floor —
// the routing gate above it forces a delegation and its holding line speaks instead (pinned at the
// bottom). Runs end-to-end against the ephemeral DB backend with the LLM injected (repo DI convention).

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext, type ConvoTurnContext } from './shared.js';
import { REACTION_TOOL, DELEGATE_TO_OPS_TOOL, RECALL_MEMORY_TOOL } from './tools.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import type { LlmRequest, LlmResult, LlmToolCall } from '../../llm/types.js';
import { __setHostSetupLlmForTests } from '../ops/riskGate.js';

// The setup screen's classify lane (ops/riskGate.ts judgeSetupInAsk) reads these asks as the lookups they are.
__setHostSetupLlmForTests(async () => ({ text: 'SAFE', toolCalls: [], stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test' }));

const ASK = 'haha ok tell me a joke about cats';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

/** The live failure shape: a schema-valid envelope with nothing at all in it. */
const silent = () => makeResult([]);

let seq = 0;
function turnCtx(call: (req: LlmRequest) => Promise<LlmResult>, text = ASK): ConvoTurnContext {
  return {
    system: 'SYSTEM PROMPT (persona + this turn)',
    messages: [{ role: 'user', content: text }],
    tools: [REACTION_TOOL, DELEGATE_TO_OPS_TOOL, RECALL_MEMORY_TOOL],
    call,
  };
}

function args(textToSend = ASK, over: Partial<ChatContext> = {}) {
  __resetOpsCoordination();
  const sender = `+1555600${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender, ...over };
  return {
    chatId: randomUUID(),
    handle: chatContext.senderHandle!,
    chatContext,
    history: [],
    media: emptyMedia(),
    textToSend,
  };
}

test('a silent turn on a real message retries the same input once, and the retry ships', async () => {
  const seen: LlmRequest[] = [];
  const out = await processConvoResult({
    ...args(),
    res: silent(),
    turn: turnCtx(async req => {
      seen.push(req);
      return makeResult(['ok here: why do cats hate mondays']);
    }),
  });
  assert.equal(seen.length, 1, 'exactly one retry');
  assert.equal(seen[0].system, 'SYSTEM PROMPT (persona + this turn)', 'the SAME input, unchanged');
  assert.deepEqual(seen[0].messages, [{ role: 'user', content: ASK }]);
  assert.ok(seen[0].tools?.some(t => t.name === 'delegate_to_ops'), 'the full tool list still stands');
  assert.equal(out.text, 'ok here: why do cats hate mondays');
});

test('a retry that calls a tool has it dispatched exactly as a first pass would', async () => {
  const out = await processConvoResult({
    ...args(),
    res: silent(),
    turn: turnCtx(async () => makeResult(['on it, one sec'], [
      { name: 'delegate_to_ops', input: { kind: 'general', request: 'a cat joke', meta_prompt: null } },
    ])),
  });
  assert.ok(out.delegatedTask, 'the retry’s delegation stands');
  assert.equal(out.text, 'on it, one sec');
});

test('a retry that is ALSO silent falls to the voiced floor — one retry max, never a loop', async () => {
  let calls = 0;
  const out = await processConvoResult({
    ...args(),
    res: silent(),
    turn: turnCtx(async () => { calls++; return silent(); }),
  });
  assert.equal(calls, 1, 'the silentRetry fence caps recovery at one extra call');
  assert.ok(out.text && out.text.trim().length, 'the user is never left on read');
});

test('a retry whose call throws still lands a voiced line', async () => {
  const out = await processConvoResult({
    ...args(),
    res: silent(),
    turn: turnCtx(async () => { throw new Error('provider down'); }),
  });
  assert.ok(out.text && out.text.trim().length);
});

test('with no turn context there is nothing to retry, so the floor voices straight away', async () => {
  const out = await processConvoResult({ ...args(), res: silent() });
  assert.ok(out.text && out.text.trim().length);
});

test('a reaction-only turn is legitimately silent: no retry, the tapback stands alone', async () => {
  let calls = 0;
  const out = await processConvoResult({
    ...args(),
    res: makeResult([], [{ name: 'send_reaction', input: { type: 'like' } }]),
    turn: turnCtx(async () => { calls++; return makeResult(['unused']); }),
  });
  assert.equal(calls, 0, 'the persona allows empty bubbles alongside a reaction — that is not a failure');
  assert.equal(out.text, null, 'and no line is invented next to it');
  assert.deepEqual(out.reaction, { type: 'like' });
});

test('a turn with no inbound text of its own (nothing was asked) is not forced to speak', async () => {
  let calls = 0;
  const out = await processConvoResult({
    ...args(''),
    res: silent(),
    turn: turnCtx(async () => { calls++; return makeResult(['unused']); }, ''),
  });
  assert.equal(calls, 0);
  assert.equal(out.text, null);
});

test('a silent turn on a GROUNDED ask is caught earlier: the routing gate delegates instead', async () => {
  // The other half of the same live failure — this exact message came back silent. The widened gate
  // now forces it to the engine, so the retry never has to fire and the answer is grounded.
  const ask = 'can you peek at what skill folders exist in my ~/.hermes/skills and name like 5 of them?';
  let calls = 0;
  const out = await processConvoResult({
    ...args(ask),
    res: silent(),
    turn: turnCtx(async () => { calls++; return makeResult(['unused']); }, ask),
  });
  assert.equal(calls, 0, 'no silent-turn retry — the gate already routed it');
  assert.ok(out.delegatedTask, 'forced delegation');
  assert.equal(out.delegatedTask!.request, ask);
  assert.ok(out.text && out.text.trim().length, 'and a holding line goes out with it');
});
