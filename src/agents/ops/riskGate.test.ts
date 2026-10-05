// src/agents/ops/riskGate.test.ts
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHostSetupSignal, judgeHostSetup, judgeSetupInAsk, gateReasons, readTaint } from './riskGate.js';
import { addShortTerm } from '../../db/repositories/memoryShort.js';
import { RECENT_RESEARCH_TTL_MS } from '../../memory/shortTerm.js';
import type { callLLM } from '../../llm/callLLM.js';

function lane(word: string | Error, calls: { n: number }): typeof callLLM {
  return (async () => {
    calls.n++;
    if (word instanceof Error) throw word;
    return { text: word, toolCalls: [], stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test' };
  }) as typeof callLLM;
}

test('a link or an install-shaped word is host setup on its own', () => {
  assert.equal(findHostSetupSignal('set up https://monid.ai/SKILL.md'), 'link');
  assert.ok(findHostSetupSignal('npm install -g monid'));
  assert.ok(findHostSetupSignal('download the dataset and run the script on it'));
  assert.ok(findHostSetupSignal('add their API key to your config'));
  assert.equal(findHostSetupSignal('use your arxiv skill for this'), undefined);
  assert.equal(findHostSetupSignal('set yourself a follow-up check in two hours'), undefined);
});

test('the lexicon settles it without a call; anything else is one call, and a dead lane needs a yes', async () => {
  const calls = { n: 0 };
  assert.deepEqual(await judgeHostSetup([], { llm: lane('SAFE', calls) }), { risky: false, trigger: 'none' });
  const hit = await judgeHostSetup(['install https://monid.ai/SKILL.md'], { llm: lane('SAFE', calls) });
  assert.equal(hit.risky, true);
  assert.equal(hit.trigger, 'lexicon');
  assert.equal(calls.n, 0, 'no call for what the list already reads');

  assert.deepEqual(await judgeHostSetup(['set yourself a follow-up check in two hours'], { llm: lane('SAFE', calls) }), { risky: false, trigger: 'llm' });
  assert.deepEqual(await judgeHostSetup(['instala el paquete monid'], { llm: lane('RISKY', calls) }), { risky: true, trigger: 'llm' });
  assert.deepEqual(await judgeHostSetup(['instala el paquete monid'], { llm: lane(new Error('down'), calls) }), { risky: true, trigger: 'lane_failed' });
  assert.equal(calls.n, 3);
});

test('a request or brief is read for a setup only past a setup verb, and the lane tells a lookup from a setup', async () => {
  const calls = { n: 0 };
  assert.deepEqual(await judgeSetupInAsk(['summarize https://example.com/post', 'read the page and report back'], { llm: lane('RISKY', calls) }), { risky: false, trigger: 'none' });
  assert.equal(calls.n, 0, 'a link or a plain lookup costs no call');
  assert.deepEqual(await judgeSetupInAsk(['set up the skill at https://monid.ai/SKILL.md, then find prices', undefined], { llm: lane('RISKY', calls) }), { risky: true, trigger: 'llm', signal: 'set up' });
  assert.deepEqual(await judgeSetupInAsk(['how do I install docker on a mac'], { llm: lane('SAFE', calls) }), { risky: false, trigger: 'llm', signal: 'install' });
  assert.deepEqual(await judgeSetupInAsk(['find prices', 'first install the monid skill'], { llm: lane(new Error('down'), calls) }), { risky: true, trigger: 'lane_failed', signal: 'install' });
  assert.equal(calls.n, 3);
});

test('act and host setup stand alone; taint matters only when there is an engine action', () => {
  assert.deepEqual(gateReasons({ effect: 'read', engineActions: [], hostSetup: false, tainted: true }), []);
  assert.deepEqual(gateReasons({ effect: 'read', engineActions: ['x'], hostSetup: false, tainted: true }), ['tainted']);
  assert.deepEqual(gateReasons({ effect: 'act', engineActions: ['x'], hostSetup: true, tainted: false }), ['act', 'host_setup']);
  assert.deepEqual(gateReasons({ effect: 'read', engineActions: ['x'], hostSetup: false, tainted: false }), []);
});

test('a look delivered inside the recent-research window taints, and it wears off', async () => {
  const handle = `+15559310${Date.now() % 1000}`;
  assert.deepEqual(await readTaint(handle), { tainted: false });
  await addShortTerm({ agentHandle: handle, chatId: 'c1', kind: 'ops_research', request: 'what does this page say', content: 'ANSWER: it says things' });
  assert.deepEqual(await readTaint(handle), { tainted: true, from: 'what does this page say' });
  assert.deepEqual(await readTaint(handle, Date.now() + RECENT_RESEARCH_TTL_MS + 1), { tainted: false });
});

test('a failed read is tainted', async () => {
  const broken = () => { throw new Error('db down'); };
  assert.deepEqual(await readTaint('+15559310999', Date.now(), { latest: broken }), { tainted: true });
});
