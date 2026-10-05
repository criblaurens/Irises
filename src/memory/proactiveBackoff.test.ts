// Run with: npm test   (runner pins DATA_BACKEND=memory)
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { backoffState, optedOutOfTextingFirst, readBackoff, BACKOFF_IGNORED_LIMIT, TEXTS_FIRST_KEY } from './proactiveBackoff.js';
import { resetStorageForTests, stmt } from '../db/sqlite.js';
import { setPreference } from '../db/repositories/memory.js';

const H = '+15550004444';
const CHAT = 'web:gate';

function delivered(kind: string, at: number): void {
  stmt(
    `INSERT INTO proactive_deliveries (id, chat_id, kind, text, meta_json, dedupe_key, status, deliver_after, created_at, delivered_at)
     VALUES (?, ?, ?, 'x', '{}', ?, 'delivered', NULL, ?, ?)`
  ).run(`${kind}-${at}`, CHAT, kind, `k-${kind}-${at}`, at, at);
}

beforeEach(() => resetStorageForTests());

test('the limit is three', () => assert.equal(BACKOFF_IGNORED_LIMIT, 3));

test('under the limit she texts as usual, at it she asks once, after an unanswered ask she is silent', () => {
  assert.equal(backoffState([], false), 'ok');
  assert.equal(backoffState(['callback', 'musing'], false), 'ok');
  assert.equal(backoffState(['musing', 'callback', 'callback'], false), 'checkin');
  assert.equal(backoffState(['musing', 'callback', 'callback', 'checkin'], false), 'silent');
  assert.equal(backoffState(['checkin'], false), 'silent', 'an unanswered ask holds on its own');
});

test('an opt-out is silent whatever the count', () => {
  assert.equal(backoffState([], true), 'silent');
});

test('the opt-out reads a boolean or the words a model writes for one', () => {
  for (const v of [false, 'false', 'OFF', 'no']) assert.equal(optedOutOfTextingFirst(v), true, String(v));
  for (const v of [undefined, null, true, 'true', 'on', 'yes', '']) assert.equal(optedOutOfTextingFirst(v), false, String(v));
});

test('readBackoff wires the store and the pref together', async () => {
  delivered('callback', 1_000); delivered('musing', 2_000); delivered('callback', 3_000);
  assert.equal(await readBackoff(CHAT, H), 'checkin');
  stmt(`INSERT INTO messages (chat_id, role, content, handle, created_at) VALUES (?, 'user', 'yo', ?, 4000)`).run(CHAT, H);
  assert.equal(await readBackoff(CHAT, H), 'ok', 'any text from them resets it');
  await setPreference(H, TEXTS_FIRST_KEY, false);
  assert.equal(await readBackoff(CHAT, H), 'silent');
});
