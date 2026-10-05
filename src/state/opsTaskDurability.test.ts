// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The bridge between the in-memory ops registry and its durable row, plus the sweep that
// owns up — once, honestly, with no result claimed and no re-run — to a run a restart killed.
// Pinned here: the write-through in both directions, the once-only follow-up, the receipts
// (including on the no-op paths), and the byte-identical off path where no sink is registered.
process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetOpsCoordination,
  markOpsStart,
  markOpsRetry,
  markOpsDone,
  requestOpsCancel,
  isDuplicateDelegation,
  setOpsTaskSink,
  opsStaleMs,
  extendOpsLeg,
} from './opsCoordination.js';
import { ENGINE_APPROVAL_WAIT_MS } from '../agents/ops/engineBackend.js';
import { createOpsTaskRecovery, opsDurableTasksEnabled, opsLostText } from './opsTaskDurability.js';
import { getOpsTask, insertRunning, settleOpsTask } from '../db/repositories/opsTasks.js';
import { closeDb, resetStorageForTests, stmt } from '../db/sqlite.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import type { ProactiveMessage, ProactiveOutcome } from '../pipeline/proactiveDelivery.js';

interface Fake {
  calls: ProactiveMessage[];
  deliver: (msg: ProactiveMessage) => Promise<ProactiveOutcome>;
}

function fakeDeliver(outcome: ProactiveOutcome = 'sent'): Fake {
  const calls: ProactiveMessage[] = [];
  return {
    calls,
    deliver: async (msg: ProactiveMessage) => { calls.push(msg); return outcome; },
  };
}

function backdateLeg(id: string, msAgo: number): void {
  stmt('UPDATE ops_tasks SET leg_started_at = ? WHERE id = ?').run(Date.now() - msAgo, id);
}

function lostReceipts(): Array<Record<string, unknown>> {
  return getTraces().filter(e => e.label === 'ops:lost').map(e => e.detail ?? {});
}

beforeEach(() => {
  resetStorageForTests();
  __resetOpsCoordination();
  clearTraces();
});

afterEach(() => __resetOpsCoordination());

test('the flag parses like every sibling memory flag, default ON', () => {
  const env = { ...process.env };
  try {
    delete process.env.OPS_DURABLE_TASKS;
    assert.equal(opsDurableTasksEnabled(), true);
    process.env.OPS_DURABLE_TASKS = 'off';
    assert.equal(opsDurableTasksEnabled(), false);
    process.env.OPS_DURABLE_TASKS = 'yes';
    assert.equal(opsDurableTasksEnabled(), true);
  } finally {
    process.env = env;
  }
});

test('no sink registered: the registry writes nothing at all', () => {
  markOpsStart('chat-a', 't-1', { kind: 'research', request: 'x' });
  markOpsRetry('chat-a', 't-1');
  markOpsDone('chat-a', 't-1');
  assert.equal((stmt('SELECT COUNT(*) AS n FROM ops_tasks').get() as { n: number }).n, 0);
  assert.equal(isDuplicateDelegation('chat-a', 'research', 'x'), 'recent');
});

test('with a sink, the registry writes each move through to the row', () => {
  const recovery = createOpsTaskRecovery({ deliver: fakeDeliver().deliver });
  setOpsTaskSink(recovery.sink);

  markOpsStart('chat-a', 't-1', { kind: 'research', request: 'when is the tax deadline' });
  const started = getOpsTask('t-1');
  assert.equal(started?.status, 'running');
  assert.equal(started?.chatId, 'chat-a');
  assert.equal(started?.request, 'when is the tax deadline');
  assert.equal(started?.budgetMs, opsStaleMs());

  markOpsRetry('chat-a', 't-1');
  assert.equal(getOpsTask('t-1')?.status, 'retrying');

  markOpsDone('chat-a', 't-1');
  assert.equal(getOpsTask('t-1')?.status, 'delivered');
});

test('a cancel settles the row, and a late done cannot undo it', () => {
  const recovery = createOpsTaskRecovery({ deliver: fakeDeliver().deliver });
  setOpsTaskSink(recovery.sink);

  markOpsStart('chat-a', 't-1', { kind: 'research', request: 'x' }, new AbortController());
  assert.equal(requestOpsCancel('chat-a', 't-1'), 'signalled');
  assert.equal(getOpsTask('t-1')?.status, 'cancelled');

  markOpsDone('chat-a', 't-1');
  assert.equal(getOpsTask('t-1')?.status, 'cancelled');
});

test('a done for a task the registry never held writes nothing', () => {
  const recovery = createOpsTaskRecovery({ deliver: fakeDeliver().deliver });
  setOpsTaskSink(recovery.sink);
  markOpsDone('chat-a', 'never-started');
  assert.equal(getOpsTask('never-started'), null);
});

test('after a restart the row alone suppresses the same ask, and only that ask', () => {
  const recovery = createOpsTaskRecovery({ deliver: fakeDeliver().deliver });
  setOpsTaskSink(recovery.sink);
  markOpsStart('chat-a', 't-1', { kind: 'research', request: 'when is the tax deadline' });

  // The restart: maps gone, sink re-registered at boot.
  __resetOpsCoordination();
  setOpsTaskSink(recovery.sink);

  assert.equal(isDuplicateDelegation('chat-a', 'research', 'When is the  TAX deadline'), 'in_flight');
  assert.equal(isDuplicateDelegation('chat-a', 'research', 'what is the weather'), null);
  assert.equal(isDuplicateDelegation('chat-b', 'research', 'when is the tax deadline'), null);
});

test('a stranded run flips to lost and is owned up to exactly once', async () => {
  const fake = fakeDeliver('sent');
  const recovery = createOpsTaskRecovery({ deliver: fake.deliver });
  insertRunning({ id: 't-1', chatId: 'chat-a', kind: 'research', request: 'when is the tax deadline' });
  backdateLeg('t-1', opsStaleMs() + 60_000);

  await recovery.sweepStranded();

  assert.equal(getOpsTask('t-1')?.status, 'lost');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].chatId, 'chat-a');
  assert.equal(fake.calls[0].kind, 'memo');
  assert.equal(fake.calls[0].dedupeKey, 'ops-lost:t-1');
  assert.match(fake.calls[0].text, /when is the tax deadline/);
  assert.deepEqual(lostReceipts(), [{ taskId: 't-1', kind: 'research', ageMs: lostReceipts()[0].ageMs, delivered: true }]);

  clearTraces();
  await recovery.sweepStranded();
  assert.equal(fake.calls.length, 1, 'a terminal row is never owned up to twice');
  assert.deepEqual(lostReceipts(), []);
});

test('the follow-up claims no result and never offers to re-run by itself', () => {
  const text = opsLostText('when is the tax deadline');
  assert.match(text, /got cut off/);
  assert.match(text, /nothing came back/);
  assert.equal(text, text.toLowerCase(), 'her register is lowercase');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text), 'no emoji');
  // The re-run is a statement of what is in reach, not a question they have to answer: her one line
  // about a killed run ends on "say the word and i run it again", and carries no question mark at all.
  assert.match(text, /say the word and i run it again/);
  assert.ok(!text.includes('?'), 'no question shape — the decision is theirs without being homework');
  // A paragraph-long ask cannot become the whole text.
  assert.ok(opsLostText('x'.repeat(500)).length < 300);
});

// A run can carry work as well as a question (agents/types.ts `engineActions`, written into the
// row's meta). The apology quoted the request alone, so a restart that killed a setup told them
// their lookup stopped and left the setup sounding like it had gone through.
test('a killed run that carried a setup says the setup did not happen either', () => {
  const text = opsLostText('what those apis charge', ['install the skill they sent']);
  assert.match(text, /got cut off/);
  assert.match(text, /the setting up you asked for didn't happen either/);
  assert.equal(text, text.toLowerCase(), 'her register is lowercase');
  assert.ok(!text.includes('?'), 'still no question shape');
  // And a run that carried none is exactly the line it always was.
  assert.equal(opsLostText('what those apis charge', []), opsLostText('what those apis charge'));
});

test('the ops:lost receipt fires even when the proactive layer swallows the send', async () => {
  const fake = fakeDeliver('duplicate');
  const recovery = createOpsTaskRecovery({ deliver: fake.deliver });
  insertRunning({ id: 't-1', chatId: 'chat-a', kind: 'research', request: 'x' });
  backdateLeg('t-1', opsStaleMs() + 60_000);

  await recovery.sweepStranded();
  assert.equal(getOpsTask('t-1')?.status, 'lost');
  assert.equal(lostReceipts().length, 1);
  assert.equal(lostReceipts()[0].delivered, false);
});

test('the sweep leaves a settled row and a still-running one alone', async () => {
  const fake = fakeDeliver();
  const recovery = createOpsTaskRecovery({ deliver: fake.deliver });

  insertRunning({ id: 't-done', chatId: 'chat-a', kind: 'research', request: 'done' });
  settleOpsTask('t-done', 'delivered');
  backdateLeg('t-done', opsStaleMs() + 60_000);
  insertRunning({ id: 't-live', chatId: 'chat-a', kind: 'research', request: 'live' });

  await recovery.sweepStranded();
  assert.equal(fake.calls.length, 0);
  assert.equal(getOpsTask('t-done')?.status, 'delivered');
  assert.equal(getOpsTask('t-live')?.status, 'running');
});

test('the sweep leaves alone a leg still waiting on their answer to an engine ask', async () => {
  const fake = fakeDeliver();
  const recovery = createOpsTaskRecovery({ deliver: fake.deliver });
  setOpsTaskSink(recovery.sink);
  // Both legs started past the horizon, in memory and in the row alike.
  const realNow = Date.now;
  const then = realNow() - opsStaleMs() - 60_000;
  Date.now = () => then;
  try {
    markOpsStart('chat-a', 't-asking', { kind: 'general', request: 'clear the scratch folder' });
    markOpsStart('chat-a', 't-stuck', { kind: 'research', request: 'when is the tax deadline' });
  } finally {
    Date.now = realNow;
  }
  extendOpsLeg('chat-a', 't-asking', ENGINE_APPROVAL_WAIT_MS);

  await recovery.sweepStranded();
  assert.equal(getOpsTask('t-asking')?.status, 'running');
  assert.equal(getOpsTask('t-stuck')?.status, 'lost', 'a stuck live leg with no wait on it is still owned up to');
  assert.deepEqual(fake.calls.map(c => c.dedupeKey), ['ops-lost:t-stuck']);
});

test('one bad row does not end the sweep', async () => {
  const calls: string[] = [];
  const recovery = createOpsTaskRecovery({
    deliver: async (msg: ProactiveMessage) => {
      calls.push(msg.dedupeKey ?? '');
      if (msg.dedupeKey === 'ops-lost:t-1') throw new Error('mouth is down');
      return 'sent';
    },
  });
  insertRunning({ id: 't-1', chatId: 'chat-a', kind: 'research', request: 'first' });
  insertRunning({ id: 't-2', chatId: 'chat-a', kind: 'research', request: 'second' });
  backdateLeg('t-1', opsStaleMs() + 120_000);
  backdateLeg('t-2', opsStaleMs() + 60_000);

  await recovery.sweepStranded();
  assert.deepEqual(calls, ['ops-lost:t-1', 'ops-lost:t-2']);
  assert.equal(getOpsTask('t-1')?.status, 'lost', 'marked lost before the send, so a thrown mouth cannot loop it');
  assert.equal(getOpsTask('t-2')?.status, 'lost');
});

test('a lost durable write leaves a receipt instead of a silent gap', () => {
  const recovery = createOpsTaskRecovery({ deliver: fakeDeliver().deliver });
  setOpsTaskSink(recovery.sink);
  stmt('DROP TABLE ops_tasks').run();

  markOpsStart('chat-a', 't-1', { kind: 'research', request: 'x' });
  const receipt = getTraces().find(e => e.label === 'ops:durable-write-lost');
  assert.ok(receipt, 'the write-through failure is visible');
  assert.equal(receipt.detail?.taskId, 't-1');
  assert.equal(receipt.chatId, 'chat-a');

  closeDb(); // fresh connection for the next test — the DDL runs again on open
});
