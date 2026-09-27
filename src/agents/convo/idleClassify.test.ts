// Coverage for layer 3 of the idle gate as it is actually wired: the classify call, its deadline,
// its cache and its receipt (convo/idleClassify.ts), driven through the real `isIdleTurn` so the
// thing under test is the SEAM rather than a mock of it.
//
// The gate itself (persona/idle.ts) has its own suite for the vetoes and the fast path. What is
// pinned here is everything that file deliberately refuses to know: which lane, how long, how often,
// and what the ring gets to see afterwards.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_CLASSIFY_CACHE_MAX, IDLE_CLASSIFY_MAX_TOKENS, IDLE_CLASSIFY_PROMPT, IDLE_CLASSIFY_TIMEOUT_MS,
  clearIdleClassifyCache, idleCacheKey, idleClassifyCacheSize, makeIdleClassifier, readIdleVerdict,
  warmIdleClassify,
} from './idleClassify.js';
import { isIdleTurn, type IdleFacts, type IdleOptions } from '../../persona/idle.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { LlmRequest, LlmResult } from '../../llm/types.js';

/** Nothing structural in the way, so every message below reaches the layer under test. */
const CLEAR: IdleFacts = {
  attachmentNote: false, burstSize: 1, activeOps: false,
  pendingAsk: false, endsInQuestion: false, followUpOutstanding: false,
  consent: 'unclear',
};

/** The caller with CONVO_SHARE_TURNS_ENABLED on. Only the two share tests pass it: everything else
 *  in this file is the wiring as it ships today, which is the flag-off side (persona/idle.ts). */
const SHARE_ON: IdleOptions = { shareTurns: true };

/** A short stall in a script the English fast path cannot read a single token of — the exact case
 *  this layer exists for (persona/idle.ts's header names it). */
const NON_ENGLISH_STALL = 'ちょっとね';

function result(text: string): LlmResult {
  return { text, toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function setup() {
  clearTraces();
  clearIdleClassifyCache();
}

function receipts() {
  return getTraces().filter(e => e.type === 'event' && e.label === 'idle:classify').map(e => e.detail);
}

// ── the verdict reader ───────────────────────────────────────────────────────

test('a one-word answer is read past its punctuation, and anything unknown is a failed reading', () => {
  assert.equal(readIdleVerdict('stall'), 'stall');
  assert.equal(readIdleVerdict('  STALL.\n'), 'stall', 'a lane that punctuates has still answered');
  assert.equal(readIdleVerdict('share'), 'share');
  assert.equal(readIdleVerdict(' Share.\n'), 'share', 'the fourth word is read exactly like the other three');
  assert.equal(readIdleVerdict('Quiz.'), 'quiz', 'a question put to her as a test has its own word');
  assert.equal(readIdleVerdict('ask'), 'ask');
  assert.equal(readIdleVerdict('unclear'), 'unclear');
  // Failing toward task: everything that is not one of the four is the last one.
  for (const junk of ['', null, undefined, 'idle', 'bid', 'yes', '{"verdict":"stall"}']) {
    assert.equal(readIdleVerdict(junk as string), 'failed', JSON.stringify(junk));
  }
});

test('the cache key ignores case and spacing and NOTHING else', () => {
  assert.equal(idleCacheKey('  Hmm   OK '), 'hmm ok');
  // Deliberately not the gate's tokenizer, which drops every non-Latin character: two different
  // stalls in the same script must not collapse onto one key.
  assert.notEqual(idleCacheKey('ちょっとね'), idleCacheKey('そうだね'));
});

// ── the three layers, driven end to end ──────────────────────────────────────

test('a stall verdict makes the turn idle, and the receipt says the classify layer decided', async () => {
  setup();
  let asked = 0;
  const classify = makeIdleClassifier({
    chatId: 'c1', handle: '+15550001111', llm: async () => { asked++; return result('stall'); },
  });
  assert.deepEqual(await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify), { shape: 'idle', layer: 'classify', signals: [] });
  assert.equal(asked, 1);
  assert.deepEqual(receipts(), [{ verdict: 'stall', cached: false, chars: 5 }]);
});

test('a thrown lane is a TASK turn, and the receipt says the call failed rather than answered', async () => {
  setup();
  const classify = makeIdleClassifier({
    chatId: 'c1', llm: async () => { throw new TypeError('no classify lane configured'); },
  });
  assert.deepEqual(await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify), { shape: 'task', layer: 'classify', signals: [] });
  const [only] = receipts();
  assert.equal((only as { verdict: string }).verdict, 'failed', 'a dead lane settles nothing');
  assert.equal((only as { failed?: string }).failed, 'TypeError', 'and the receipt tells a dead lane from a hedging one');
});

test('an `ask` verdict is a task turn — only the exact word stall is idle', async () => {
  setup();
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => result('ask') });
  assert.deepEqual(await isIdleTurn('kirim ke mereka sekarang', CLEAR, classify), { shape: 'task', layer: 'classify', signals: [] });
});

test('a `share` verdict rides the same wiring, and the receipt names it like any other reading', async () => {
  setup();
  // A sentence about their own day, past the stall cap in tokens — which is the commonest shape a
  // bid arrives in, and the exact message the old three-word prompt had no word for.
  const bid = 'the morning meeting moved to friday and my whole week shifted with it';
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => result('share') });
  assert.deepEqual(await isIdleTurn(bid, CLEAR, classify, SHARE_ON),
    { shape: 'share', layer: 'classify', signals: ['too_many_tokens', 'too_long'] });
  assert.deepEqual(receipts(), [{ verdict: 'share', cached: false, chars: [...bid].length }]);

  // The same message on an install with the flag off never even reaches this layer: over the stall
  // caps, every signal is a work veto again, so the turn is settled before a lane is picked and the
  // ring stays at the one receipt above (persona/idle.ts's flag contract).
  assert.equal((await isIdleTurn(bid, CLEAR, classify)).shape, 'task');
  assert.equal(receipts().length, 1, 'no second reading, because no second call');
});

test('a failure is NOT cached — the next turn gets its own attempt', async () => {
  setup();
  let calls = 0;
  const classify = makeIdleClassifier({
    chatId: 'c1',
    llm: async () => { calls++; if (calls === 1) throw new Error('lane down'); return result('stall'); },
  });
  assert.equal((await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify)).shape, 'task');
  assert.equal(idleClassifyCacheSize(), 0, 'nothing was learned, so nothing is remembered');
  assert.equal((await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify)).shape, 'idle', 'the lane came back');
  assert.equal(calls, 2);
});

// ── the call itself ──────────────────────────────────────────────────────────

test('the call is the classify lane, five tokens, the fixed prompt, and the message as DATA', async () => {
  setup();
  const seen: LlmRequest[] = [];
  const classify = makeIdleClassifier({
    chatId: 'c9', handle: '+15550001111', llm: async req => { seen.push(req); return result('stall'); },
  });
  await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].role, 'classify');
  assert.equal(seen[0].maxTokens, IDLE_CLASSIFY_MAX_TOKENS);
  assert.equal(seen[0].system, IDLE_CLASSIFY_PROMPT);
  assert.equal(seen[0].trace?.label, 'idle:classify_call', 'the CALL and the decision are separate labels');
  const content = String(seen[0].messages[0].content);
  assert.match(content, /^<prompt>/, 'wrapped, so the message is context and not instruction');
  assert.match(content, /<message>[\s\S]*ちょっとね[\s\S]*<\/message>/, 'and sub-tagged as their own words');
  // The prompt is Fable's, and it defines all four words it will accept back — `share` included,
  // which is the word the third turn shape needed from this lane and the one `stall` used to swallow.
  for (const word of ['stall', 'share', 'ask', 'unclear']) assert.ok(IDLE_CLASSIFY_PROMPT.includes(`${word} —`), word);
});

test('the deadline fires and the turn goes on as work', async () => {
  setup();
  // A lane that answers, eventually, and far too late — which is the failure a hard deadline exists
  // for and the one a thrown call cannot stand in for. The wait is shortened through the same kind
  // of seam `llm` is; the production number is pinned on its own two lines below.
  let late: ReturnType<typeof setTimeout> | undefined;
  const classify = makeIdleClassifier({
    chatId: 'c1',
    timeoutMs: 20,
    llm: () => new Promise<LlmResult>(resolve => { late = setTimeout(() => resolve(result('stall')), 5_000); }),
  });
  const reading = await isIdleTurn(NON_ENGLISH_STALL, CLEAR, classify);
  clearTimeout(late);
  assert.deepEqual(reading, { shape: 'task', layer: 'classify', signals: [] }, 'a lane that missed the deadline settles nothing');
  assert.equal((receipts()[0] as { failed?: string }).failed, 'Error');
  assert.equal(idleClassifyCacheSize(), 0, 'and a timeout teaches the cache nothing');

  // This call sits ON the reply path, ahead of the prompt build: the number is a latency budget, not
  // a formality, and six seconds is generous for a five-token answer.
  assert.equal(IDLE_CLASSIFY_TIMEOUT_MS, 6_000);
});

// ── the cache ────────────────────────────────────────────────────────────────

test('the same stall costs ONE call however many turns it arrives on, and every hit is receipted', async () => {
  setup();
  let calls = 0;
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => { calls++; return result('stall'); } });
  for (const text of [NON_ENGLISH_STALL, NON_ENGLISH_STALL, `  ${NON_ENGLISH_STALL.toUpperCase()} `]) {
    assert.equal((await isIdleTurn(text, CLEAR, classify)).shape, 'idle', text);
  }
  assert.equal(calls, 1, 'a person\'s handful of stalls is a handful of calls, not one per turn');
  // A cache hit that filed nothing would make a busy install look like a lane nobody is calling.
  assert.deepEqual(receipts().map(d => (d as { cached: boolean }).cached), [false, true, true]);
});

test('the cache is capped, and it evicts the oldest reading first', async () => {
  setup();
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => result('stall') });
  // Distinct short messages made of LETTERS only: a digit anywhere is a structural veto, so a
  // numbered fixture would never reach the layer being filled up here (persona/idle.ts).
  const nth = (n: number) => `s${n.toString(2).replace(/0/g, 'a').replace(/1/g, 'b')}`;
  // One over the cap, so exactly one eviction has happened and it is the first key in.
  for (let i = 0; i <= IDLE_CLASSIFY_CACHE_MAX; i++) await isIdleTurn(nth(i), CLEAR, classify);
  assert.equal(idleClassifyCacheSize(), IDLE_CLASSIFY_CACHE_MAX);
  clearTraces();
  await isIdleTurn(nth(0), CLEAR, classify);
  assert.equal((receipts()[0] as { cached: boolean }).cached, false, 'the oldest reading is the one that went');
  clearTraces();
  await isIdleTurn(nth(IDLE_CLASSIFY_CACHE_MAX), CLEAR, classify);
  assert.equal((receipts()[0] as { cached: boolean }).cached, true, 'and the newest is still held');
});

test('a structural veto and the fast path both settle the turn without a call at all', async () => {
  setup();
  let calls = 0;
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => { calls++; return result('stall'); } });
  // Layer 1: a digit is a fact, and with the third shape off a message carrying one is carrying
  // something to act on — the signal is a work veto again (persona/idle.ts's flag contract).
  assert.deepEqual(await isIdleTurn('deploy 3 now', CLEAR, classify), { shape: 'task', layer: 'veto', signals: ['digit'] });
  // Layer 2: every token is a known English stall.
  assert.deepEqual(await isIdleTurn('hey', CLEAR, classify), { shape: 'idle', layer: 'fast_path', signals: [] });
  assert.equal(calls, 0, 'the lane is only reached by what the two free layers could not read');
  assert.deepEqual(receipts(), [], 'and a layer that never ran files nothing');
});

test('the receipt carries a size and a verdict — never the message', async () => {
  setup();
  const secret = 'ちょっとね';
  const classify = makeIdleClassifier({ chatId: 'c1', llm: async () => result('stall') });
  await isIdleTurn(secret, CLEAR, classify);
  assert.doesNotMatch(JSON.stringify(receipts()), new RegExp(secret));
});

// ── the settle-window warm ───────────────────────────────────────────────────
// The inbound door starts the call while the burst settles (index.ts enqueueInbound), and the gate
// reads it later. One text is one lane call and one receipt, however the two overlap.

test('a warm call in flight is joined by the reading, not duplicated', async () => {
  setup();
  let calls = 0;
  let release!: (v: LlmResult) => void;
  const llm = (() => { calls++; return new Promise<LlmResult>(r => { release = r; }); }) as never;
  warmIdleClassify({ chatId: 'c1', llm, timeoutMs: 5000 }, 'ちょっと待って');
  const read = makeIdleClassifier({ chatId: 'c1', llm, timeoutMs: 5000 })('ちょっと待って');
  release(result('stall'));
  assert.equal(await read, 'stall');
  assert.equal(calls, 1, 'the reading waited on the warm call instead of starting its own');
});

test('a warm call files no receipt; the reading files exactly one, and says it joined', async () => {
  setup();
  let release!: (v: LlmResult) => void;
  const llm = (() => new Promise<LlmResult>(r => { release = r; })) as never;
  warmIdleClassify({ chatId: 'c1', llm, timeoutMs: 5000 }, 'そうかもね');
  assert.deepEqual(receipts(), [], 'nobody has read the verdict yet, so nothing is receipted');
  const read = makeIdleClassifier({ chatId: 'c1', llm, timeoutMs: 5000 })('そうかもね');
  release(result('stall'));
  await read;
  // A join is neither a cache hit nor a call of its own: the flag is what lets a live round tell the
  // settle-window warm working from a cache that already knew the word.
  assert.deepEqual(receipts(), [{ verdict: 'stall', cached: false, joined: true, chars: 5 }]);
});

test('a warm call that finished is a plain cache hit for the reading', async () => {
  setup();
  let calls = 0;
  const llm = (async () => { calls++; return result('stall'); }) as never;
  warmIdleClassify({ chatId: 'c1', llm }, 'まあまあ');
  await new Promise(r => setImmediate(r));
  assert.equal(await makeIdleClassifier({ chatId: 'c1', llm })('まあまあ'), 'stall');
  assert.equal(calls, 1);
  assert.deepEqual(receipts(), [{ verdict: 'stall', cached: true, chars: 4 }]);
});

test('a warm call that failed teaches nothing, and the reading makes its own call', async () => {
  setup();
  let calls = 0;
  const llm = (async () => { calls++; if (calls === 1) throw new Error('lane down'); return result('stall'); }) as never;
  warmIdleClassify({ chatId: 'c1', llm }, 'ふーん');
  assert.equal(await makeIdleClassifier({ chatId: 'c1', llm })('ふーん'), 'stall');
  assert.equal(calls, 2, 'the failed warm poisoned nothing');
  assert.deepEqual(receipts(), [{ verdict: 'stall', cached: false, chars: 3 }]);
});

test('a warm call that timed out is read as failed, not waited on a second time', async () => {
  setup();
  // The one failure a retry cannot help: the lane already had the whole deadline and spent it, so a
  // second call would only stack a second deadline on the reply path behind the first.
  // The lane answers far too late on a ref'd timer, as in the deadline test above: the deadline's own
  // timer is unref'd, and a lane that never answered at all would let the event loop end the test first.
  let calls = 0;
  const late: ReturnType<typeof setTimeout>[] = [];
  const llm = (() => {
    calls++;
    return new Promise<LlmResult>(resolve => { late.push(setTimeout(() => resolve(result('stall')), 5_000)); });
  }) as never;
  warmIdleClassify({ chatId: 'c1', llm, timeoutMs: 20 }, 'えっとね');
  const verdict = await makeIdleClassifier({ chatId: 'c1', llm, timeoutMs: 20 })('えっとね');
  late.forEach(clearTimeout);
  assert.equal(verdict, 'failed', 'the same verdict a timeout on the reading itself produces');
  assert.equal(calls, 1, 'no second call after the warm spent the deadline');
  assert.deepEqual(receipts(), [{ verdict: 'failed', cached: false, joined: true, chars: 4, failed: 'Error' }]);
});
