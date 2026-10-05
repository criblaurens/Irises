// Run with: npm test   (runner pins DATA_BACKEND=memory)
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests, stmt } from '../sqlite.js';
import { insertPending, markDropped, sweepOldProactive, unansweredProactiveKinds } from './proactive.js';

const CHAT = 'web:backoff';
const DAY = 24 * 60 * 60 * 1000;

function delivered(kind: string, at: number, chatId = CHAT, meta: Record<string, unknown> = {}): void {
  stmt(
    `INSERT INTO proactive_deliveries (id, chat_id, kind, text, meta_json, dedupe_key, status, deliver_after, created_at, delivered_at)
     VALUES (?, ?, ?, 'x', ?, ?, 'delivered', NULL, ?, ?)`
  ).run(`${kind}-${at}-${chatId}`, chatId, kind, JSON.stringify(meta), `k-${kind}-${at}`, at, at);
}
function userSaid(at: number, chatId = CHAT): void {
  stmt(`INSERT INTO messages (chat_id, role, content, handle, created_at) VALUES (?, 'user', 'hey', '+1555', ?)`).run(chatId, at);
}

beforeEach(() => resetStorageForTests());

test('only her own texts after their last message count, oldest first', async () => {
  delivered('callback', 1_000);          // answered: before their message
  userSaid(2_000);
  delivered('musing', 3_000);
  delivered('reminder', 3_500);           // theirs: never counted
  delivered('update', 3_600);             // a note about her: never counted
  delivered('callback', 4_000);
  delivered('callback', 4_500, 'web:other');
  assert.deepEqual(await unansweredProactiveKinds(CHAT), ['musing', 'callback']);
});

test('no message from them at all reads as since-the-beginning', async () => {
  delivered('callback', 1_000);
  assert.deepEqual(await unansweredProactiveKinds(CHAT), ['callback']);
});

test('an explicit since overrides the latest message', async () => {
  delivered('checkin', 1_000);
  userSaid(2_000);
  assert.deepEqual(await unansweredProactiveKinds(CHAT), []);
  assert.deepEqual(await unansweredProactiveKinds(CHAT, 500), ['checkin']);
});

test('a send the mouth dropped is delivered but never counted', async () => {
  const id = await insertPending({ chatId: CHAT, kind: 'musing', text: 'x', dedupeKey: 'd1' });
  await markDropped(id);
  const row = stmt('SELECT status, meta_json FROM proactive_deliveries WHERE id = ?').get(id) as { status: string; meta_json: string };
  assert.equal(row.status, 'delivered');
  assert.equal(JSON.parse(row.meta_json).dropped, 1);
  assert.deepEqual(await unansweredProactiveKinds(CHAT), []);
});

test('back-off kinds survive the 7-day sweep like reminders do', async () => {
  const old = Date.now() - 10 * DAY;
  delivered('callback', old);
  delivered('memo', old);
  await sweepOldProactive();
  const kinds = (stmt('SELECT kind FROM proactive_deliveries').all() as { kind: string }[]).map(r => r.kind);
  assert.deepEqual(kinds, ['callback'], 'a memo goes at 7 days, a ping stays for the 35-day window');
});
