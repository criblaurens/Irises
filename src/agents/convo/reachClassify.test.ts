// The reach judge: one word per message, one call per text, and every failure reads as "trust her".
process.env.DATA_BACKEND = 'memory';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readReachWord, readReachVerdict, peekReachVerdict, warmReachClassify, setReachJudgeForTests,
  clearReachClassifyCache,
} from './reachClassify.js';
import type { callLLM } from '../../llm/callLLM.js';

type Llm = typeof callLLM;
const ctx = (llm: Llm, timeoutMs?: number) => ({ chatId: 'web:test', llm, ...(timeoutMs ? { timeoutMs } : {}) });
const answering = (word: string, calls: { n: number }): Llm => (async () => {
  calls.n++;
  return { text: word, toolCalls: [], stopReason: 'end_turn', truncated: false, provider: 'openrouter', model: 't' };
}) as unknown as Llm;

beforeEach(() => { setReachJudgeForTests(null); clearReachClassifyCache(); });

test('the one word reads into a verdict; anything else is a failure', () => {
  assert.equal(readReachWord('reach'), 'reach');
  assert.equal(readReachWord(' None.'), 'none');
  assert.equal(readReachWord('unclear'), 'unclear');
  assert.equal(readReachWord('maybe'), 'failed');
  assert.equal(readReachWord(null), 'failed');
});

test('one text is one call, however many readers ask at once, and a second read is a cache hit', async () => {
  const calls = { n: 0 };
  const llm = answering('reach', calls);
  const [a, b] = await Promise.all([readReachVerdict(ctx(llm), 'what is gold at'), readReachVerdict(ctx(llm), 'What is  gold at')]);
  assert.deepEqual([a, b], ['reach', 'reach']);
  assert.equal(await readReachVerdict(ctx(llm), 'what is gold at'), 'reach');
  assert.equal(calls.n, 1);
});

test('a throw, a timeout and a garbage answer all read as failed, and a failure is never cached', async () => {
  const thrower = (async () => { throw new Error('lane down'); }) as unknown as Llm;
  assert.equal(await readReachVerdict(ctx(thrower), 'a'), 'failed');
  const never = (() => new Promise(() => {})) as unknown as Llm;
  // The deadline's timer is unref'd (it must never hold a shutdown open), so keep the loop alive.
  const alive = setTimeout(() => {}, 1_000);
  assert.equal(await readReachVerdict(ctx(never, 20), 'b'), 'failed');
  clearTimeout(alive);
  const calls = { n: 0 };
  assert.equal(await readReachVerdict(ctx(answering('perhaps', calls)), 'c'), 'failed');
  assert.equal(await readReachVerdict(ctx(answering('none', calls)), 'c'), 'none');
  assert.equal(calls.n, 2, 'the failed reading did not stick');
});

test('peek never waits: nothing while a call runs, the verdict once it lands', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const slow = (async () => { await gate; return { text: 'none', toolCalls: [], stopReason: 'end_turn', truncated: false, provider: 'openrouter', model: 't' }; }) as unknown as Llm;
  warmReachClassify(ctx(slow), 'count the letters');
  assert.equal(peekReachVerdict('count the letters'), undefined);
  release();
  assert.equal(await readReachVerdict(ctx(slow), 'count the letters'), 'none');
  assert.equal(peekReachVerdict('count the letters'), 'none');
});

test('with no lane configured the verdict settles as failed at once, no call and no pending state', () => {
  const saved = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
  try {
    assert.equal(peekReachVerdict('whats bitcoin at'), 'failed');
  } finally {
    Object.assign(process.env, saved);
  }
});

test('the test override answers both readers, bypassing the lane and the cache', async () => {
  setReachJudgeForTests(t => (t.includes('price') ? 'reach' : 'none'));
  assert.equal(peekReachVerdict('the price of gold'), 'reach');
  assert.equal(await readReachVerdict({ chatId: 'web:test' }, 'hello there'), 'none');
});

test('a turn needs reach on a link or path without a call, and otherwise only on a confident reach', async () => {
  const { turnNeedsReach } = await import('./reachClassify.js');
  setReachJudgeForTests(() => { throw new Error('the judge must not be asked'); });
  assert.deepEqual(await turnNeedsReach({ chatId: 'c' }, 'read https://example.com/a'), { needs: true, reach: 'structural' });
  for (const [word, needs] of [['reach', true], ['none', false], ['unclear', false], ['failed', false]] as const) {
    setReachJudgeForTests(() => word);
    assert.deepEqual(await turnNeedsReach({ chatId: 'c' }, 'whats gold at'), { needs, reach: word });
  }
});

test('the early-emit reading counts a verdict still out as flagged, so a turn the gate may force never streams', async () => {
  const { reachFlagged } = await import('./reachClassify.js');
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const slow = (async () => { await gate; return { text: 'none', toolCalls: [], stopReason: 'end_turn', truncated: false, provider: 'openrouter', model: 't' }; }) as unknown as Llm;
  warmReachClassify(ctx(slow), 'a plain question');
  assert.equal(reachFlagged('a plain question'), true);
  release();
  await readReachVerdict(ctx(slow), 'a plain question');
  assert.equal(reachFlagged('a plain question'), false);
  setReachJudgeForTests(() => 'reach');
  assert.equal(reachFlagged('a plain question'), true);
});

test('the judge reads their own words, the structural screen the whole turn', async () => {
  const { reachFlagged, turnNeedsReach } = await import('./reachClassify.js');
  const asked: string[] = [];
  setReachJudgeForTests(t => { asked.push(t); return 'none'; });
  // A tapped reply: the tag is app metadata, so the verdict the door warmed on the typed words holds.
  assert.equal(reachFlagged('[replying to "see you at 8"] lol ok', 'lol ok'), false);
  assert.deepEqual(await turnNeedsReach({ chatId: 'c' }, '[replying to "see you at 8"] lol ok', 'lol ok'), { needs: false, reach: 'none' });
  assert.deepEqual(asked, ['lol ok', 'lol ok']);
  // …while a link that rides in the quoted message still counts, with no call at all.
  assert.deepEqual(await turnNeedsReach({ chatId: 'c' }, '[replying to "https://example.com/a"] whats this', 'whats this'), { needs: true, reach: 'structural' });
  // A caption-less media turn has no words of its own: that is no reach verdict, and nothing pending.
  setReachJudgeForTests(null);
  assert.equal(peekReachVerdict(''), 'failed');
});
