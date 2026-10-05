process.env.TZ = 'UTC';

// The gate ↔ mouth interlock — the exact wiring runOpsAndFollowUp uses for progress pings, proven
// as a unit so a future edit can't reintroduce either race:
//   1. a ping that queues behind a held mouth (a live reply / the answer's own delivery) is DROPPED
//      once the run settles (gate.stop) — never a "still on it" landing after or between the
//      bubbles of the real answer;
//   2. a ping voiced before Irises said something else is DROPPED as stale (staleIfSpokenSince) —
//      it was voiced blind to that message;
//   3. an undisturbed ping still goes out (the throttle isn't a mute button).
// Pings ride the LOCK now (no more priority:'critical' bypass), so they can never split another
// message's bubbles — that ordering is asserted here too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressGate, runPingCycle } from './progressGate.js';
import { createMouth } from '../state/mouth.js';
import { withChatLock, __resetSendQueues } from '../state/sendQueue.js';

const wait = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

function harness() {
  const sent: string[] = [];
  let lastSpoke: number | undefined;
  const speak = createMouth({
    sendBubbles: async (_chatId, bubbles) => { sent.push(...bubbles); lastSpoke = Date.now(); },
    splitIntoBubbles: t => [t],
    lastSpokenAt: () => lastSpoke,
  });
  const setSpoke = (at: number) => { lastSpoke = at; };
  return { sent, speak, setSpoke };
}

// Mirrors the orchestrator's ping send-callback wiring, verbatim in structure.
function pingSender(
  speak: ReturnType<typeof harness>['speak'],
  gate: ProgressGate,
  chatId: string,
) {
  return (text: string) => {
    const voicedAt = Date.now();
    void speak(chatId, text, {
      paced: false,
      dropIf: () => gate.isStopped,
      staleIfSpokenSince: voicedAt,
    }).catch(() => { /* progress is best-effort */ });
  };
}

test('a ping queued behind the answer is dropped when the run settles first', async () => {
  __resetSendQueues();
  const { sent, speak } = harness();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 5 });

  // The answer's own delivery holds the mouth...
  let releaseAnswer!: () => void;
  const answer = withChatLock('c', () => new Promise<void>(res => { releaseAnswer = () => { sent.push('THE ANSWER'); res(); }; }));

  // ...a ping fires meanwhile: gate allows it, it voices, and queues behind the held mouth.
  const ping = runPingCycle(gate, 'heartbeat', async () => 'still digging', pingSender(speak, gate, 'c'));
  await ping; // runPingCycle returns once the send is HANDED OFF (fire-and-forget queue entry)
  await wait(5);
  assert.deepEqual(sent, [], 'ping must not jump the queue');

  // The run settles: the gate freezes, the answer lands, the mouth frees — the queued ping must die.
  gate.stop();
  releaseAnswer();
  await answer;
  await wait(10);
  assert.deepEqual(sent, ['THE ANSWER'], 'the stale ping was dropped, never landed after the answer');
});

test('a ping voiced before Irises spoke again is dropped as stale', async () => {
  __resetSendQueues();
  const { sent, speak, setSpoke } = harness();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 5 });

  const sender = pingSender(speak, gate, 'c');
  // Voice completes at T; Irises then says something newer (e.g. a live reply to an intervening
  // text) before the ping's send owns the mouth.
  await runPingCycle(gate, 'heartbeat', async () => {
    setSpoke(Date.now() + 5_000); // strictly after any voicedAt this test can stamp
    return 'still digging';
  }, sender);
  await wait(10);
  assert.deepEqual(sent, [], 'a ping voiced blind to a newer Irises message must be dropped');
});

test('an undisturbed ping goes out — through the lock, unpaced', async () => {
  __resetSendQueues();
  const { sent, speak } = harness();
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 5 });
  await runPingCycle(gate, 'heartbeat', async () => 'still digging', pingSender(speak, gate, 'c'));
  await wait(10);
  assert.deepEqual(sent, ['still digging']);
});

test('pings serialize with other sends — never interleaving another message\'s bubbles', async () => {
  __resetSendQueues();
  const order: string[] = [];
  const speak = createMouth({
    // A multi-bubble send with a gap between bubbles — the old critical-bypass ping used to be able
    // to land inside this gap.
    sendBubbles: async (_c, bubbles) => { for (const b of bubbles) { order.push(b); await wait(8); } },
    splitIntoBubbles: t => t.split('|'),
    lastSpokenAt: () => undefined,
  });
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 5 });

  const reply = speak('c', 'bubble-1|bubble-2|bubble-3');
  await wait(1); // the reply owns the mouth, mid-bubbles
  await runPingCycle(gate, 'heartbeat', async () => 'PING', pingSender(speak, gate, 'c'));
  await reply;
  await wait(20);
  assert.deepEqual(order, ['bubble-1', 'bubble-2', 'bubble-3', 'PING'], 'ping waited for the whole message');
});

test('a ping held while an engine ask waits spends none of the run\'s budget', async () => {
  __resetSendQueues();
  const { sent, speak } = harness();
  const budget = { remaining: 1 };
  const gate = new ProgressGate({ quietMs: 0, gapMs: 0, maxPings: 1, budget });
  let waiting = true;
  await runPingCycle(gate, 'heartbeat', async () => 'still digging', pingSender(speak, gate, 'c'), () => waiting);
  assert.equal(budget.remaining, 1, 'held back, not spent');
  waiting = false;
  await runPingCycle(gate, 'milestone', async () => 'still digging', pingSender(speak, gate, 'c'), () => waiting);
  await wait(10);
  assert.deepEqual(sent, ['still digging'], 'the run\'s one ping is still there once the ask is settled');
});
