process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMouth } from './mouth.js';
import { __resetSendQueues, withChatLock } from './sendQueue.js';
import { DeadlineError } from '../agents/deadline.js';
import { splitIntoBubbles } from '../pipeline/bubbles.js';

const wait = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

interface SentCall { chatId: string; bubbles: string[]; opts: { record?: boolean; paced?: boolean; verbatim?: boolean } }

function makeDeps(overrides: { lastSpokenAt?: (chatId: string) => number | undefined; voiceTimeoutMs?: number } = {}) {
  const sent: SentCall[] = [];
  const deps = {
    sendBubbles: async (chatId: string, bubbles: string[], opts: { record?: boolean; paced?: boolean; verbatim?: boolean }) => {
      sent.push({ chatId, bubbles, opts });
    },
    splitIntoBubbles: (text: string) => text.split('\n---\n').map(s => s.trim()).filter(Boolean),
    lastSpokenAt: overrides.lastSpokenAt ?? (() => undefined),
    voiceTimeoutMs: overrides.voiceTimeoutMs,
  };
  return { deps, sent };
}

test('static text goes out through the chat lock', async () => {
  __resetSendQueues();
  const { deps, sent } = makeDeps();
  const speak = createMouth(deps);
  const r = await speak('c', 'hello\n---\nthere');
  assert.equal(r, 'sent');
  assert.deepEqual(sent[0].bubbles, ['hello', 'there']);
});

test('a voicer thunk runs INSIDE the lock — after every queued send, not at call time', async () => {
  __resetSendQueues();
  const { deps, sent } = makeDeps();
  const speak = createMouth(deps);
  const order: string[] = [];

  // A slow send holds the mouth (simulates a live reply mid-flight).
  const slow = withChatLock('c', async () => { await wait(40); order.push('live-reply'); });
  // Queue a voiced follow-up while the mouth is held: the thunk must not run yet.
  const followUp = speak('c', async () => { order.push('voice'); return 'late answer'; });
  await wait(10);
  assert.deepEqual(order, [], 'voicer must not run while another send owns the mouth');
  await Promise.all([slow, followUp]);
  assert.deepEqual(order, ['live-reply', 'voice'], 'voicer ran only once it owned the mouth');
  assert.equal(sent.length, 1);
});

test('two voiced follow-ups serialize: the second voices AFTER the first has fully sent', async () => {
  __resetSendQueues();
  const order: string[] = [];
  const { deps } = makeDeps();
  const slowSend = { ...deps, sendBubbles: async (_c: string, b: string[]) => { await wait(20); order.push(`sent:${b[0]}`); } };
  const speak = createMouth(slowSend);
  const a = speak('c', async () => { order.push('voice:a'); return 'a'; });
  const b = speak('c', async () => { order.push('voice:b'); return 'b'; });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['voice:a', 'sent:a', 'voice:b', 'sent:b']);
});

test('dropIf is honored before voicing (no wasted voice call)', async () => {
  __resetSendQueues();
  const { deps, sent } = makeDeps();
  const speak = createMouth(deps);
  let voiced = 0;
  const r = await speak('c', async () => { voiced++; return 'x'; }, { dropIf: () => true });
  assert.equal(r, 'dropped');
  assert.equal(voiced, 0, 'thunk must not run when already stale');
  assert.equal(sent.length, 0);
});

test('dropIf is re-checked AFTER voicing — a cancel landing mid-voice suppresses the send', async () => {
  __resetSendQueues();
  const { deps, sent } = makeDeps();
  const speak = createMouth(deps);
  let cancelled = false;
  const r = await speak('c', async () => { cancelled = true; return 'the answer'; }, { dropIf: () => cancelled });
  assert.equal(r, 'dropped');
  assert.equal(sent.length, 0, 'nothing sent after a mid-voice cancel');
});

test('staleIfSpokenSince drops content when Irises spoke after it was voiced', async () => {
  __resetSendQueues();
  let spokeAt: number | undefined;
  const { deps, sent } = makeDeps({ lastSpokenAt: () => spokeAt });
  const speak = createMouth(deps);

  const voicedAt = Date.now();
  spokeAt = voicedAt + 5; // Irises said something newer than this ping
  const r = await speak('c', 'still digging on that', { staleIfSpokenSince: voicedAt });
  assert.equal(r, 'dropped');
  assert.equal(sent.length, 0);

  // And when nothing was said since, it goes out.
  spokeAt = voicedAt - 5;
  const r2 = await speak('c', 'still digging on that', { staleIfSpokenSince: voicedAt });
  assert.equal(r2, 'sent');
});

test('an empty/null voice result is a silent drop, never a blank send', async () => {
  __resetSendQueues();
  const { deps, sent } = makeDeps();
  const speak = createMouth(deps);
  assert.equal(await speak('c', async () => null), 'dropped');
  assert.equal(await speak('c', async () => '   '), 'dropped');
  assert.equal(sent.length, 0);
});

test('a hung voicer hits the deadline and rejects instead of wedging the mouth', async () => {
  __resetSendQueues();
  const { deps, sent } = makeDeps({ voiceTimeoutMs: 25 });
  const speak = createMouth(deps);
  // The deadline timer is unref'd by design (deadline.ts) — hold the loop open so it can fire.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const hung = speak('c', () => new Promise<string>(() => { /* never settles */ }));
    await assert.rejects(hung, (e: unknown) => e instanceof DeadlineError);
    // The mouth is free again for the next speaker.
    const r = await speak('c', 'next message');
    assert.equal(r, 'sent');
    assert.equal(sent.length, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('critical bypasses the lock (fraud alert cannot queue behind a held mouth)', async () => {
  __resetSendQueues();
  const { deps, sent } = makeDeps();
  const speak = createMouth(deps);
  const order: string[] = [];
  const slow = withChatLock('c', async () => { await wait(40); order.push('held'); });
  const alert = speak('c', 'FRAUD WARNING', { priority: 'critical' }).then(() => order.push('alert'));
  await wait(10);
  assert.deepEqual(order, ['alert'], 'critical went out while the mouth was held');
  assert.equal(sent[0].opts.paced, false, 'critical is never paced');
  await Promise.all([slow, alert]);
});

test('paced:false rides the lock but skips typing simulation', async () => {
  __resetSendQueues();
  const { deps, sent } = makeDeps();
  const speak = createMouth(deps);
  await speak('c', 'quick ping', { paced: false });
  assert.equal(sent[0].opts.paced, false);
});

test('keepTypingAlive wraps thunk voicing (dots on while composing, off before the send) — and not static text', async () => {
  __resetSendQueues();
  const events: string[] = [];
  const { deps } = makeDeps();
  const speak = createMouth({
    ...deps,
    sendBubbles: async () => { events.push('sent'); },
    keepTypingAlive: async (_c, work) => { events.push('dots-on'); try { return await work; } finally { events.push('dots-off'); } },
  });
  // Like the real composer, the voicer awaits I/O before its slow work — the dots wrapper attaches
  // during that first tick (dots-on vs the thunk's first synchronous statement is not ordered).
  await speak('c', async () => { await wait(5); events.push('voice'); return 'composed reply'; });
  assert.deepEqual(events, ['dots-on', 'voice', 'dots-off', 'sent']);

  events.length = 0;
  await speak('c', 'pre-voiced ping');
  assert.deepEqual(events, ['sent'], 'static text never triggers the typing wrapper');
});

test('the typing wrapper is released when the voicer hits the deadline (dots never outlive delivery)', async () => {
  __resetSendQueues();
  const events: string[] = [];
  const { deps } = makeDeps({ voiceTimeoutMs: 25 });
  const speak = createMouth({
    ...deps,
    keepTypingAlive: async (_c, work) => { events.push('dots-on'); try { return await work; } finally { events.push('dots-off'); } },
  });
  const keepAlive = setTimeout(() => {}, 500); // the deadline timer is unref'd — hold the loop open
  try {
    await assert.rejects(
      speak('c', () => new Promise<string>(() => { /* hung voicer, never settles */ })),
      (e: unknown) => e instanceof DeadlineError,
    );
    assert.deepEqual(events, ['dots-on', 'dots-off'], 'dots released at the deadline despite the hung thunk');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('a verbatim send splits only at newlines, every line goes out as written, and the transport guards still hold', async () => {
  __resetSendQueues();
  const { deps, sent } = makeDeps();
  // The real reply splitter: a send that ignored verbatim would come out with each command rewritten.
  const speak = createMouth({ ...deps, splitIntoBubbles });
  const commands = ['rm -rf *.tmp *.log', 'rm -rf _old_ _tmp_', 'python -c "a  =  1"', 'git log -- src --- x — done. ok?'];
  const text = ['your hermes wants to run this', ...commands, 'you ok with that?'].join('\n');
  assert.equal(await speak('c', text, { paced: false, record: false, verbatim: true, dropIf: () => true }), 'dropped', 'dropIf still binds');
  assert.equal(await speak('c', text, { paced: false, record: false, verbatim: true }), 'sent');
  assert.deepEqual(sent[0].bubbles, ['your hermes wants to run this', ...commands, 'you ok with that?']);
  assert.equal(sent[0].opts.verbatim, true, 'the send path is told, so no text cleanup runs over the lines');
  assert.equal(sent[0].opts.paced, false);
  assert.equal(sent[0].opts.record, false);
});
