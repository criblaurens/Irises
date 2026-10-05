// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Her own texts, and the one bound the familiarity mask adds to them: she texts first only someone
// she knows (familiar or close). A stranger, including someone with no row yet, is skipped for
// `familiarity`, and with the mask switched off the bound does not exist. `deliver` is always a spy,
// and `rand` always loses the chance draw, so nothing in this file can text anyone.
process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  familiarityAllows, runMusingSweep, __resetMusingGuardsForTests, MUSING_QUIET_MS, MUSING_HOURS, type MusingMessage,
  currentWeather, weatherAllows, theirHours,
} from './musings.js';
import { FAMILIARITY_BANDS } from '../persona/familiarity.js';
import { resetStorageForTests, stmt } from '../db/sqlite.js';
import { addMessage } from '../db/repositories/conversations.js';
import { saveFamiliarity } from '../db/repositories/familiarity.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';

const H = '+15550007777';
const CHAT = 'web:musings';

/** One sweep, three hours and a minute after their message, with a chance draw that always loses. */
async function sweep(): Promise<{ calls: MusingMessage[]; considered: number; skipped: Record<string, number> }> {
  const calls: MusingMessage[] = [];
  await runMusingSweep(
    { deliver: async (m: MusingMessage) => { calls.push(m); return 'sent'; } },
    { now: Date.now() + MUSING_QUIET_MS + 60_000, rand: () => 0.99 },
  );
  const detail = (getTraces().find(e => e.label === 'musings:sweep')?.detail ?? {}) as { considered?: number; skipped?: Record<string, number> };
  return { calls, considered: detail.considered ?? 0, skipped: detail.skipped ?? {} };
}

beforeEach(async () => {
  resetStorageForTests();
  __resetMusingGuardsForTests();
  clearTraces();
  delete process.env.CONVO_FAMILIARITY_ENABLED;
  delete process.env.IRISES_MUSINGS_ENABLED;
  await addMessage(CHAT, 'user', 'morning', H);
});
afterEach(() => { delete process.env.CONVO_FAMILIARITY_ENABLED; });

test('she texts first only someone she knows: familiar or close', () => {
  assert.deepEqual(FAMILIARITY_BANDS.filter(familiarityAllows), ['familiar', 'close']);
});

test('the sweep skips a stranger for familiarity, and a missing row is a stranger', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  const none = await sweep();
  assert.equal(none.considered, 1);
  assert.equal(none.skipped.familiarity, 1, 'no row yet');
  assert.equal(none.calls.length, 0);

  clearTraces();
  await saveFamiliarity(H, { level: 49, turns: 90, activeDays: 12, lastDay: '2026-09-25' });
  assert.equal((await sweep()).skipped.familiarity, 1, 'an acquaintance is still not enough');
});

test('someone she knows passes the gate and meets the rest of the sweep', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  await saveFamiliarity(H, { level: 50, turns: 200, activeDays: 14, lastDay: '2026-09-25' });
  const r = await sweep();
  assert.equal(r.skipped.familiarity, undefined);
  assert.equal(Object.values(r.skipped).reduce((n, v) => n + v, 0), 1, 'the one chat was still skipped, by a later bound');
  assert.equal(r.calls.length, 0);
});

test('with the mask off there is no gate, and a stranger row costs the sweep nothing', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  await saveFamiliarity(H, { level: 1, turns: 1, activeDays: 1, lastDay: '2026-09-25' });
  const r = await sweep();
  assert.equal(r.skipped.familiarity, undefined);
  assert.equal(r.calls.length, 0);
});

// ── her weather, rested ─────────────────────────────────────────────────────────────────────────
// The stored row only moves on a turn, so a night that ends at 2am left her drained all of the next
// day and no sweep ever passed. A row older than a few hours is read as rested: the clock's targets
// for this hour in THEIR zone.

const JKT = 'Asia/Jakarta';
const NIGHT_ROW = { mood_core: 'sad', mood_level: 35, social_battery: 23, at: Date.parse('2026-10-03T19:00:00Z') }; // 02:00 Jakarta

test('a fresh row is her weather as it stands', () => {
  const now = NIGHT_ROW.at + 60 * 60 * 1000;
  assert.equal(currentWeather(NIGHT_ROW, now, JKT), NIGHT_ROW);
  assert.equal(weatherAllows(currentWeather(NIGHT_ROW, now, JKT)), false);
});

test('last night does not hold her the next afternoon: a stale row rests to the clock', () => {
  const afternoon = Date.parse('2026-10-04T09:00:00Z'); // 16:00 Jakarta
  const w = currentWeather(NIGHT_ROW, afternoon, JKT);
  assert.equal(w?.mood_core, undefined, 'the feeling word belonged to that conversation');
  assert.equal(weatherAllows(w), true);
});

test('the rested clock is read in their zone', () => {
  const instant = Date.parse('2026-10-04T09:00:00Z'); // 16:00 Jakarta, 02:00 in Los Angeles
  assert.equal(weatherAllows(currentWeather(NIGHT_ROW, instant, JKT)), true);
  assert.equal(weatherAllows(currentWeather(NIGHT_ROW, instant, 'America/Los_Angeles')), false);
});

// ── their hours, learned ───────────────────────────────────────────────────────────────────────
// She texts first only at an hour, in their zone, when that person tends to be around: an hour is
// theirs once they have texted within an hour of it on two different days of the last fortnight.

const HOUR_MS = 60 * 60 * 1000;
/** A message at `hour` o'clock Jakarta on day `d` of October 2026. */
const jkt = (d: number, hour: number) => Date.parse(`2026-10-${String(d).padStart(2, '0')}T00:00:00+07:00`) + hour * HOUR_MS;

test('too little history to learn from falls back to the default window', () => {
  assert.equal(theirHours([jkt(1, 14), jkt(2, 14)], JKT), null);
  assert.deepEqual(MUSING_HOURS, [10, 21]);
});

test('a night owl gets their own hours, read in their zone', () => {
  const times = [1, 2, 3].flatMap(d => [jkt(d, 15), jkt(d, 23), jkt(d + 1, 2)]);
  const hours = theirHours(times, JKT)!;
  for (const h of [14, 15, 16, 22, 23, 0, 1, 2, 3]) assert.ok(hours.has(h), `hour ${h}`);
  for (const h of [9, 10, 11, 12, 18, 19]) assert.ok(!hours.has(h), `hour ${h}`);
  // The same instants read from another zone land on other hours.
  assert.ok(!theirHours(times, 'America/New_York')!.has(23));
});

test('an hour seen on one day only is not theirs yet', () => {
  const times = [jkt(1, 9), jkt(1, 20), jkt(2, 20), jkt(3, 20)];
  const hours = theirHours(times, JKT)!;
  assert.ok(hours.has(20));
  assert.ok(!hours.has(9));
});

// ── the back-off ──────────────────────────────────────────────────────────────────────────────
// Musings never send the check-in (they cannot stack past one unanswered on their own); they only
// stand down while the back-off is anything but ok.
test('the sweep stands down while the back-off holds', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  const later = Date.now() + 1_000;   // after beforeEach's 'morning'
  stmt(
    `INSERT INTO proactive_deliveries (id, chat_id, kind, text, meta_json, dedupe_key, status, deliver_after, created_at, delivered_at)
     VALUES ('c1', ?, 'checkin', 'x', '{}', 'k1', 'delivered', NULL, ?, ?)`
  ).run(CHAT, later, later);
  const r = await sweep();
  assert.equal(r.skipped.backed_off, 1);
  assert.equal(r.calls.length, 0);
});
