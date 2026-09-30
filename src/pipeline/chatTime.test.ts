// Run with: npm test   (TZ=UTC tsx --test)
// Host tz pinned to UTC — every helper here takes explicit nowMs/tz, and these tests prove the
// output is anchored to the user's zone (America/Chicago), not the host's.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { dateTimeInZone } from './zonedTime.js';
import {
  timestampLabel, timestampMarker, stampContent, stripTimestampMarker,
  classifyGap, describeGap, renderConversationTiming, conversationTimingLine, sittingLine,
} from './chatTime.js';

// Mon Jul 6 2026, 9:14 PM America/Chicago (CDT) — the reference "now" for most tests.
const NOW = dateTimeInZone('2026-07-06', { hour: 21, minute: 14 });
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── timestampLabel / timestampMarker ─────────────────────────────────────────

test('every timestamp carries the FULL date + clock, today included', () => {
  const todayMorning = dateTimeInZone('2026-07-06', { hour: 9, minute: 14 });
  assert.equal(timestampLabel(todayMorning), 'Mon, Jul 6, 9:14 AM');
  const friday = dateTimeInZone('2026-07-03', { hour: 21, minute: 5 });
  assert.equal(timestampLabel(friday), 'Fri, Jul 3, 9:05 PM');
  assert.equal(timestampLabel(undefined), '');
});

test('the marker is the bracketed label', () => {
  const friday = dateTimeInZone('2026-07-03', { hour: 21, minute: 5 });
  assert.equal(timestampMarker(friday), '[Fri, Jul 3, 9:05 PM]');
});

test('the render is anchored to the USER zone, not the host/UTC clock', () => {
  // 11:30 PM Chicago Jul 5 = 04:30 UTC Jul 6 — a UTC render would wrongly say Jul 6.
  const lateNight = dateTimeInZone('2026-07-05', { hour: 23, minute: 30 });
  assert.equal(timestampMarker(lateNight), '[Sun, Jul 5, 11:30 PM]');
});

test('missing or invalid `at` renders no marker and stampContent passes body through', () => {
  assert.equal(timestampMarker(undefined), '');
  assert.equal(timestampMarker(NaN), '');
  assert.equal(stampContent('hello', undefined), 'hello');
});

test('stampContent prefixes marker + single space', () => {
  const morning = dateTimeInZone('2026-07-06', { hour: 9, minute: 14 });
  assert.equal(stampContent('comps pls', morning), '[Mon, Jul 6, 9:14 AM] comps pls');
});

test('markers never contain the narrow no-break space some ICU builds emit', () => {
  const m = timestampMarker(NOW);
  assert.ok(!m.includes(' '), `marker "${m}" carries U+202F`);
});

// ── stripTimestampMarker (send-path echo backstop) ───────────────────────────

test('stripTimestampMarker removes an echoed leading marker, both forms', () => {
  assert.equal(stripTimestampMarker('[9:14 AM] you asked about comps'), 'you asked about comps');
  assert.equal(stripTimestampMarker('[Mon Jul 6, 9:14 PM] hey there'), 'hey there');
});

test('stripTimestampMarker leaves clean text untouched and is idempotent', () => {
  assert.equal(stripTimestampMarker('comps land around $310k'), 'comps land around $310k');
  assert.equal(stripTimestampMarker(''), '');
  const once = stripTimestampMarker('[9:14 AM] hi');
  assert.equal(stripTimestampMarker(once), once);
});

test('stripTimestampMarker never eats a legit bracketed opener that is not a time', () => {
  assert.equal(stripTimestampMarker('[urgent] call the lender'), '[urgent] call the lender');
});

// ── classifyGap ──────────────────────────────────────────────────────────────

test('classifyGap regimes across the thresholds', () => {
  assert.equal(classifyGap(undefined, NOW), 'first-contact');
  assert.equal(classifyGap(NOW - 4 * MIN - 59_000, NOW), 'live');
  assert.equal(classifyGap(NOW - 3 * HOUR, NOW), 'same-day');       // 6:14 PM same Chicago day
  // 11 PM the previous Chicago night → different day, < 24h → overnight.
  const lastNight = dateTimeInZone('2026-07-05', { hour: 23 });
  assert.equal(classifyGap(lastNight, NOW), 'overnight');
  assert.equal(classifyGap(NOW - 25 * HOUR, NOW), 'multi-day');
  assert.equal(classifyGap(NOW - 3 * DAY, NOW), 'multi-day');
});

// ── describeGap ──────────────────────────────────────────────────────────────

test('describeGap speaks loose human time, never raw numbers', () => {
  assert.equal(describeGap(30_000), 'moments');
  assert.equal(describeGap(5 * MIN), 'a few minutes');
  assert.equal(describeGap(20 * MIN), 'about 20 minutes');
  assert.equal(describeGap(70 * MIN), 'about an hour');
  assert.equal(describeGap(3 * HOUR), 'about 3 hours');
  assert.equal(describeGap(26 * HOUR), 'about a day');
  assert.equal(describeGap(2 * DAY + 4 * HOUR), '2 days');
});

// ── renderConversationTiming ─────────────────────────────────────────────────

test('empty history reads as first contact with a clock phrase', () => {
  const block = renderConversationTiming([], NOW);
  assert.match(block, /first exchange/);
  assert.match(block, /Monday evening/);
});

test('live volley: keep the energy, regardless of who spoke last', () => {
  const block = renderConversationTiming([{ role: 'assistant', at: NOW - MIN }], NOW);
  assert.match(block, /live back-and-forth/);
  assert.match(block, /no greeting/);
});

test('a short unanswered user message is an unremarkable pause (<3h: no apology)', () => {
  const block = renderConversationTiming([{ role: 'user', at: NOW - HOUR }], NOW);
  assert.match(block, /unremarkable pause/);
  assert.match(block, /no acknowledgment needed/i);
});

test('a long-unanswered user message makes the wait Irises\'s — no apology, no measurement', () => {
  const block = renderConversationTiming([{ role: 'user', at: NOW - 6 * HOUR }], NOW);
  assert.match(block, /The wait is YOURS/);
  assert.match(block, /Do not apologise for it and do not measure it/);
  assert.match(block, /one flat clause \("just seeing this"\), once/);
  // The gap is still handed to her in words, so the ceiling has to say what she may do with it.
  assert.doesNotMatch(block, /sorry|grovel/i);
});

test('user returning after days: fresh greeting, their silence never mentioned', () => {
  const block = renderConversationTiming([{ role: 'assistant', at: NOW - 3 * DAY }], NOW);
  assert.match(block, /quiet for 3 days/);
  assert.match(block, /never mentioned or measured/);
});

test('outreach mode reframes for a Irises-initiated message', () => {
  const block = renderConversationTiming([{ role: 'assistant', at: NOW - 2 * DAY }], NOW, undefined, 'outreach');
  assert.match(block, /You're the one opening this exchange/);
  assert.match(block, /2 days ago/);
});

test('late-night and weekend colour appear when the clock says so', () => {
  const lateSat = dateTimeInZone('2026-07-04', { hour: 23, minute: 30 }); // Sat 11:30 PM Chicago
  const block = renderConversationTiming([{ role: 'assistant', at: lateSat - 2 * HOUR }], lateSat);
  assert.match(block, /Late night/);
  assert.match(block, /weekend/);
});

// ── sittingLine ──────────────────────────────────────────────────────────────

test('an earlier sitting is named by where the current one began, with the unnamed-reference check', () => {
  // Yesterday evening's thread, then a fresh sitting this evening that is 25 minutes old.
  const yesterday = NOW - DAY;
  const line = sittingLine([
    { role: 'user', at: yesterday }, { role: 'assistant', at: yesterday + MIN },
    { role: 'user', at: NOW - HOUR }, { role: 'assistant', at: NOW - 25 * MIN },
  ], NOW);
  assert.match(line, /This sitting began at Mon, Jul 6, 8:14 PM/);
  assert.match(line, /went quiet about a day ago, and its topics have expired/);
  assert.match(line, /before you answer it or start any look-up/);
});

test('a message after a long silence opens a new sitting', () => {
  assert.match(sittingLine([{ role: 'assistant', at: NOW - 8 * HOUR }], NOW), /This message opens a new sitting/);
});

test('one continuous sitting carries no sitting line', () => {
  assert.equal(sittingLine([{ role: 'user', at: NOW - 3 * HOUR }, { role: 'assistant', at: NOW - 2 * HOUR }], NOW), '');
  assert.equal(sittingLine([], NOW), '');
});

test('a trailing turn without `at` degrades to the clock phrase, never NaN', () => {
  const block = renderConversationTiming([{ role: 'user' }], NOW);
  assert.match(block, /Monday evening/);
  assert.ok(!block.includes('NaN'));
});

test('the block never leaks raw millisecond numbers', () => {
  for (const gap of [MIN, HOUR, DAY, 3 * DAY]) {
    const block = renderConversationTiming([{ role: 'assistant', at: NOW - gap }], NOW);
    assert.ok(!/\d{4,}/.test(block.replace(/don't do date math/, '')), `raw number in: ${block}`);
  }
});

// ── conversationTimingLine ───────────────────────────────────────────────────

test('timing line is silent for hot threads, speaks for cold ones', () => {
  assert.equal(conversationTimingLine([{ role: 'assistant', at: NOW - MIN }], NOW), '');
  assert.equal(conversationTimingLine([{ role: 'assistant', at: NOW - 2 * HOUR }], NOW), '');
  const cold = conversationTimingLine([{ role: 'assistant', at: NOW - 2 * DAY }], NOW);
  assert.match(cold, /2 days ago/);
  assert.match(cold, /half-beat of orientation/);
});
