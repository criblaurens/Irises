// Run with: npm test   (TZ=UTC DATA_BACKEND=memory tsx --test)
// The proactive door's four guarantees, over the REAL sqlite layer with the impure edges injected
// (repo convention: DI, no module mocks): idempotency against engine retries, quiet-hours deferral
// as a durable row, restart recovery through the sweep, and identity resolution that never leaks one
// member's memory into a room.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createProactiveDelivery, resolveProactiveHandle, type ProactiveDeliveryDeps } from './proactiveDelivery.js';
import { insertPending, sweepOldProactive } from '../db/repositories/proactive.js';
import { addMessage } from '../db/repositories/conversations.js';
import { listShortTerm, addShortTerm } from '../db/repositories/memoryShort.js';
import { setPreference } from '../db/repositories/memory.js';
import { groupHandle } from '../memory/identity.js';
import { resetStorageForTests, stmt } from '../db/sqlite.js';
import type { ProactivePayload } from '../agents/proactive.js';
import type { SpeakContent, SpeakOpts, SpeakResult } from '../state/mouth.js';

// Two instants in America/Chicago (CDT, UTC-5) on the same summer day:
const QUIET_2AM = Date.parse('2026-07-10T07:00:00Z');  // 02:00 local — inside quiet hours
const AWAKE_NOON = Date.parse('2026-07-10T17:00:00Z'); // 12:00 local — outside
const NEXT_8AM = Date.parse('2026-07-10T13:00:00Z');   // 08:00 CDT the same morning

interface Harness {
  sent: Array<{ chatId: string; text: string | null }>;
  voiced: ProactivePayload[];
  handles: string[];
}

function harness(over: Partial<ProactiveDeliveryDeps> = {}, prefs: Record<string, unknown> = {}) {
  const h: Harness = { sent: [], voiced: [], handles: [] };
  const sendFollowUp = async (chatId: string, content: SpeakContent, _o?: SpeakOpts): Promise<SpeakResult> => {
    const text = typeof content === 'string' ? content : await content();
    h.sent.push({ chatId, text });
    return 'sent';
  };
  const deps: ProactiveDeliveryDeps = {
    sendFollowUp,
    voice: async (payload, _chatId, handle) => { h.voiced.push(payload); h.handles.push(handle); return `voiced:${payload.text}`; },
    resolveHandle: async () => '+15550001',
    getPref: async <T>(_handle: string, key: string) => prefs[key] as T | undefined,
    ...over,
  };
  return { h, pipeline: createProactiveDelivery(deps) };
}

function rows(): Array<{ id: string; status: string; deliver_after: number | null; kind: string }> {
  return stmt('SELECT id, status, deliver_after, kind FROM proactive_deliveries ORDER BY created_at').all() as never;
}

beforeEach(() => {
  resetStorageForTests();
  delete process.env.PROACTIVE_DEDUPE_WINDOW_MS;
});

// ── idempotency ───────────────────────────────────────────────────────────────────────────────

test('the same push inside the dedupe window delivers once', async () => {
  const { h, pipeline } = harness();
  const msg = { chatId: 'web:a', kind: 'reminder' as const, text: 'standup in 10' };
  assert.equal(await pipeline.deliver(msg), 'sent');
  assert.equal(await pipeline.deliver(msg), 'duplicate');
  assert.equal(await pipeline.deliver({ ...msg }), 'duplicate'); // a fresh object hashes the same
  assert.equal(h.sent.length, 1);
});

test('a caller-supplied dedupeKey is what collapses two differently-worded pushes', async () => {
  const { h, pipeline } = harness();
  assert.equal(await pipeline.deliver({ chatId: 'web:a', kind: 'memo', text: 'v1', dedupeKey: 'job-9' }), 'sent');
  assert.equal(await pipeline.deliver({ chatId: 'web:a', kind: 'memo', text: 'v2 reworded', dedupeKey: 'job-9' }), 'duplicate');
  assert.equal(h.sent.length, 1);
});

test('the same key past the window delivers again (a repeating reminder still lands)', async () => {
  const { h, pipeline } = harness();
  const msg = { chatId: 'web:a', kind: 'reminder' as const, text: 'take the pills' };
  assert.equal(await pipeline.deliver(msg), 'sent');
  // Age the row past the 30-minute window.
  stmt('UPDATE proactive_deliveries SET created_at = created_at - ?').run(31 * 60_000);
  assert.equal(await pipeline.deliver(msg), 'sent');
  assert.equal(h.sent.length, 2);
});

// ── quiet hours ───────────────────────────────────────────────────────────────────────────────

test('respect_quiet_hours defers a non-reminder overnight to the next 8am in the agent tz', async () => {
  const { h, pipeline } = harness(
    { now: () => QUIET_2AM },
    { respect_quiet_hours: true, agent_tz: 'America/Chicago' },
  );
  for (const kind of ['email', 'memo', 'update'] as const) {
    assert.equal(await pipeline.deliver({ chatId: 'web:a', kind, text: `${kind} body` }), 'deferred');
  }
  assert.equal(h.sent.length, 0, 'nothing goes out at 2am');
  const parked = rows();
  assert.deepEqual(parked.map(r => r.status), ['pending', 'pending', 'pending']);
  // DST-correct: 8am CDT is 13:00Z, not "now + 6h" in some host zone.
  assert.deepEqual(parked.map(r => r.deliver_after), [NEXT_8AM, NEXT_8AM, NEXT_8AM]);
});

test('a reminder never defers — the user picked that time themselves', async () => {
  const { h, pipeline } = harness(
    { now: () => QUIET_2AM },
    { respect_quiet_hours: true, agent_tz: 'America/Chicago' },
  );
  assert.equal(await pipeline.deliver({ chatId: 'web:a', kind: 'reminder', text: 'flight at 5' }), 'sent');
  assert.equal(h.sent.length, 1);
});

test('with the pref unset nothing defers, at any hour', async () => {
  const { h, pipeline } = harness({ now: () => QUIET_2AM }, {});
  assert.equal(await pipeline.deliver({ chatId: 'web:a', kind: 'email', text: 'mail at 2am' }), 'sent');
  assert.equal(h.sent.length, 1);
});

test('inside the pref but outside quiet hours, delivery is immediate', async () => {
  const { h, pipeline } = harness(
    { now: () => AWAKE_NOON },
    { respect_quiet_hours: true, agent_tz: 'America/Chicago' },
  );
  assert.equal(await pipeline.deliver({ chatId: 'web:a', kind: 'memo', text: 'midday memo' }), 'sent');
  assert.equal(h.sent.length, 1);
});

// ── deferral + restart recovery through the sweep ──────────────────────────────────────────────

test('sweepDue delivers a parked row once its morning arrives, and only once', async () => {
  const { h, pipeline } = harness({ now: () => AWAKE_NOON });
  // A row parked overnight by an earlier process (or by the deferral path above).
  await insertPending({
    chatId: 'web:a', kind: 'email', text: 'the lease came in', dedupeKey: 'k1',
    meta: { framing: 'they asked to be told about this one', emailMeta: { subject: 'lease' } },
    deliverAfter: QUIET_2AM,
  });
  assert.equal(await pipeline.sweepDue(), 1);
  assert.deepEqual(h.sent.map(s => s.text), ['voiced:the lease came in']);
  // The framing stored on the row rides back into the voicer.
  assert.equal(h.voiced[0].framing, 'they asked to be told about this one');
  assert.equal(rows()[0].status, 'delivered');
  assert.equal(await pipeline.sweepDue(), 0, 'a delivered row is never picked up twice');
  assert.equal(h.sent.length, 1);
});

test('a row a restart stranded mid-send is recovered by the sweep once it is stale', async () => {
  const { h, pipeline } = harness();
  // The immediate path claims a row with no deliver_after; a crash right here leaves it pending.
  const id = await insertPending({ chatId: 'web:a', kind: 'reminder', text: 'stranded', dedupeKey: 'k2', deliverAfter: null });
  assert.equal(await pipeline.sweepDue(), 0, 'a fresh row is still in flight — never swept out from under a live send');
  stmt('UPDATE proactive_deliveries SET created_at = created_at - ? WHERE id = ?').run(10 * 60_000, id);
  assert.equal(await pipeline.sweepDue(), 1);
  assert.deepEqual(h.sent.map(s => s.text), ['voiced:stranded']);
});

test('a row still parked in the future is left alone', async () => {
  const { h, pipeline } = harness({ now: () => QUIET_2AM });
  await insertPending({ chatId: 'web:a', kind: 'memo', text: 'later', dedupeKey: 'k3', deliverAfter: NEXT_8AM });
  assert.equal(await pipeline.sweepDue(), 0);
  assert.equal(h.sent.length, 0);
});

// ── failure ───────────────────────────────────────────────────────────────────────────────────

test('a failed send reports failed and does NOT block the retry that recovers it', async () => {
  let fail = true;
  const sent: string[] = [];
  const pipeline = createProactiveDelivery({
    sendFollowUp: async (_c, content) => {
      if (fail) throw new Error('mouth exploded');
      const text = typeof content === 'string' ? content : await content();
      if (text) sent.push(text);
      return 'sent';
    },
    voice: async p => `voiced:${p.text}`,
    resolveHandle: async () => '',
  });
  const msg = { chatId: 'web:a', kind: 'reminder' as const, text: 'do the thing' };
  assert.equal(await pipeline.deliver(msg), 'failed');
  assert.equal(rows()[0].status, 'failed');
  fail = false;
  // Same dedupe key, immediately: a failed row must not be mistaken for a delivery.
  assert.equal(await pipeline.deliver(msg), 'sent');
  assert.deepEqual(sent, ['voiced:do the thing']);
});

// ── the email side effect ─────────────────────────────────────────────────────────────────────

test('a delivered email flag lands in the short tier, keyed by its row id', async () => {
  const { pipeline } = harness({ resolveHandle: async () => '+15550001' });
  const outcome = await pipeline.deliver({
    chatId: 'web:a', kind: 'email', text: 'karen sent the lease back',
    emailMeta: { from: 'karen@x.com', subject: 'lease', deadlineLabel: 'signing', deadlineDate: '2026-09-01' },
  });
  assert.equal(outcome, 'sent');
  const flags = await listShortTerm('+15550001', { kinds: ['email_flag'] });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].content, 'karen sent the lease back');
  assert.deepEqual(flags[0].meta, { from: 'karen@x.com', subject: 'lease', deadlineDate: '2026-09-01', deadlineLabel: 'signing' });
  // taskId is the delivery row id, and (handle, kind, taskId) is uniquely indexed — a retried
  // write is a no-op rather than a second flag on the same push.
  assert.equal(flags[0].taskId, rows()[0].id);
  await addShortTerm({ agentHandle: '+15550001', chatId: 'web:a', kind: 'email_flag', content: 'again', taskId: flags[0].taskId });
  assert.equal((await listShortTerm('+15550001', { kinds: ['email_flag'] })).length, 1);
});

test('no email flag is written for other kinds, or with no resolved identity', async () => {
  const { pipeline } = harness({ resolveHandle: async () => '+15550001' });
  await pipeline.deliver({ chatId: 'web:a', kind: 'memo', text: 'a memo' });
  assert.equal((await listShortTerm('+15550001', { kinds: ['email_flag'] })).length, 0);

  const anon = harness({ resolveHandle: async () => '' }).pipeline;
  await anon.deliver({ chatId: 'web:b', kind: 'email', text: 'nobody home' });
  assert.equal((await listShortTerm('', { kinds: ['email_flag'] })).length, 0);
});

// ── identity ──────────────────────────────────────────────────────────────────────────────────

test('resolveProactiveHandle: one speaker → that person, several → the group, none → no memory', async () => {
  await addMessage('web:solo', 'user', 'hey', '+15551111');
  await addMessage('web:solo', 'assistant', 'hi');
  assert.equal(await resolveProactiveHandle('web:solo'), '+15551111');

  await addMessage('web:room', 'user', 'hey', '+15551111');
  await addMessage('web:room', 'user', 'yo', '+15552222');
  // PRIVACY: a room resolves to its own identity — never one member's personal memory.
  assert.equal(await resolveProactiveHandle('web:room'), groupHandle('web:room'));

  assert.equal(await resolveProactiveHandle('web:cold'), '');
});

test('resolveProactiveHandle: an existing group identity wins outright', async () => {
  // The room was tuned before this push (a prefs row exists for its pseudo-handle), and one member
  // has spoken since — the group identity still owns the chat.
  await setPreference(groupHandle('web:tuned'), 'respect_quiet_hours', true);
  await addMessage('web:tuned', 'user', 'hey', '+15551111');
  assert.equal(await resolveProactiveHandle('web:tuned'), groupHandle('web:tuned'));
});

test('the resolved handle is what the voicer is given', async () => {
  await addMessage('web:solo', 'user', 'hey', '+15551111');
  const { h, pipeline } = harness({ resolveHandle: undefined });
  await pipeline.deliver({ chatId: 'web:solo', kind: 'reminder', text: 'x' });
  assert.deepEqual(h.handles, ['+15551111']);
});

// ── the cold-push hint ────────────────────────────────────────────────────────────────────────
// A chat nobody has ever spoken in resolves to '' — no memory layer at all. The install
// introduction is exactly that push, and it knows whose chat it is, so it may say so.

const COLD = 'eng:whatsapp:4477010';

test('the handleHint stands in only where the chat has no speaker of its own', async () => {
  const { h, pipeline } = harness({ resolveHandle: undefined });
  await pipeline.deliver({ chatId: COLD, kind: 'introduction', text: '- keeps orchids alive', handleHint: COLD });
  assert.deepEqual(h.handles, [COLD], 'nobody has spoken here — the hint is the only identity there is');

  // A recorded speaker always wins: the hint is the caller's guess, the chat's own history is not.
  await addMessage('web:solo', 'user', 'hey', '+15551111');
  await pipeline.deliver({ chatId: 'web:solo', kind: 'memo', text: 'x', handleHint: COLD });
  assert.deepEqual(h.handles, [COLD, '+15551111']);
});

test('a deferred hint is still there in the morning', async () => {
  const night = harness(
    { now: () => QUIET_2AM, resolveHandle: async () => '' },
    { respect_quiet_hours: true, agent_tz: 'America/Chicago' },
  );
  assert.equal(
    await night.pipeline.deliver({ chatId: COLD, kind: 'introduction', text: '- keeps orchids alive', handleHint: COLD }),
    'deferred',
  );
  assert.equal(night.h.sent.length, 0);

  // A different process, next morning: the hint rode the row's meta through the night.
  const morning = harness({ now: () => AWAKE_NOON, resolveHandle: async () => '' });
  assert.equal(await morning.pipeline.sweepDue(), 1);
  assert.deepEqual(morning.h.handles, [COLD]);
  assert.deepEqual(morning.h.sent.map(s => s.text), ['voiced:- keeps orchids alive']);
});

test('start() is idempotent and its timers never hold the process open', () => {
  const { pipeline } = harness();
  pipeline.start();
  pipeline.start();
});

test('retention keeps a settled reminder past the 7-day line, and still sweeps other kinds there', async () => {
  const tenDaysAgo = Date.now() - 10 * 86400000;
  const reminder = await insertPending({ chatId: 'web:a', kind: 'reminder', text: 'last week\'s brief', dedupeKey: 'r' });
  const memo = await insertPending({ chatId: 'web:a', kind: 'memo', text: 'old memo', dedupeKey: 'm' });
  stmt("UPDATE proactive_deliveries SET status = 'delivered', created_at = ? WHERE id IN (?, ?)").run(tenDaysAgo, reminder, memo);
  assert.equal(await sweepOldProactive(), 1);
  const left = stmt('SELECT id FROM proactive_deliveries').all() as Array<{ id: string }>;
  assert.deepEqual(left.map(r => r.id), [reminder]);
});

test('a send the mouth drops is settled with the dropped flag, so it never counts as ignored', async () => {
  const { pipeline } = harness({ sendFollowUp: async () => 'dropped' as const });
  assert.equal(await pipeline.deliver({ chatId: 'web:drop', kind: 'musing', text: 'seed' }), 'dropped');
  const row = stmt('SELECT status, meta_json FROM proactive_deliveries').get() as { status: string; meta_json: string };
  assert.equal(row.status, 'delivered', 'final, never retried');
  assert.equal(JSON.parse(row.meta_json).dropped, 1);
});
