// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// How well she knows someone, as arithmetic. Everything here is pure, and every rule the spec states
// is pinned from both sides:
//
//   • THE TABLE IS THE SPEC. Ten sources, each with a point value and a cap, and the caps sum to a
//     hundred, so a person she holds everything about, over enough days, is a hundred.
//   • WHO SAYS SO DISCOUNTS. A fact they stated is worth more than one she guessed, and a guess more
//     than one the engine handed over.
//   • THE PACE IS THE DAYS. However much she holds, the level cannot pass thirty plus ten per active
//     day, so a fact dump in one evening hits the ceiling.
//   • THE SLEW IS TWO. The stored level moves at most two points a turn either way.
//   • A FIRST ROW IS SEEDED FROM TENURE. The days since they were first seen, capped at seven, and
//     the turns the thread harvest has counted, with today's tick on top.
//   • A ROOM IS A STRANGER, whatever is stored.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILIARITY_BANDS, FAMILIARITY_SOURCES, FAMILIARITY_SLEW, FAMILIARITY_START, BAND_FLOORS,
  FAMILIARITY_SEED_DAYS_CAP,
  bandOf, clampLevel, emptyEvidence, evidenceScore, familiarityBandFor, lowerBand, paceCeiling,
  seedCounters, slewLevel, sourcePoints, targetLevel, tickCounters, utcDay,
  type FamiliarityBand, type FamiliarityCounters, type FamiliarityEvidence, type FamiliaritySourceKey,
} from './familiarity.js';

/** Evidence with one source set and everything else at zero. */
const only = (key: FamiliaritySourceKey, count: number): FamiliarityEvidence => ({ ...emptyEvidence(), [key]: count });

// ══ 1. The table ═════════════════════════════════════════════════════════════

test('the source table is the spec table, in its order, and the caps sum to a hundred', () => {
  assert.deepEqual(FAMILIARITY_SOURCES.map(s => [s.key, s.each, s.cap]), [
    ['turns', 0.25, 20],
    ['activeDays', 8, 20],
    ['statedFacts', 2, 16],
    ['inferredFacts', 1, 6],
    ['seededFacts', 0.5, 4],
    ['name', 2, 2],
    ['moments', 2, 12],
    ['themesTaken', 2, 8],
    ['loops', 1, 4],
    ['selfEntries', 2, 8],
  ]);
  assert.equal(FAMILIARITY_SOURCES.reduce((n, s) => n + s.cap, 0), 100);
  assert.deepEqual(Object.keys(emptyEvidence()).sort(), FAMILIARITY_SOURCES.map(s => s.key).sort());
});

test('each source is capped, and everything held at once is exactly a hundred', () => {
  for (const s of FAMILIARITY_SOURCES) {
    assert.equal(evidenceScore(only(s.key, 10_000)), s.cap, `${s.key} stops at its cap`);
  }
  const everything = Object.fromEntries(FAMILIARITY_SOURCES.map(s => [s.key, 10_000])) as FamiliarityEvidence;
  assert.equal(evidenceScore(everything), 100);
  assert.deepEqual(sourcePoints(only('turns', 40)).find(p => p.key === 'turns'), { key: 'turns', count: 40, points: 10, cap: 20 });
  // A garbled count is no evidence, never a negative one.
  assert.equal(evidenceScore(only('moments', -3)), 0);
  assert.equal(evidenceScore(only('moments', Number.NaN)), 0);
});

test('who says so discounts a fact: stated over inferred over seeded', () => {
  assert.equal(evidenceScore(only('statedFacts', 1)), 2);
  assert.equal(evidenceScore(only('inferredFacts', 1)), 1);
  assert.equal(evidenceScore(only('seededFacts', 1)), 0.5);
  // …and each discount has its own ceiling, so a pile of guesses never buys what their words do.
  assert.equal(evidenceScore(only('statedFacts', 100)), 16);
  assert.equal(evidenceScore(only('inferredFacts', 100)), 6);
  assert.equal(evidenceScore(only('seededFacts', 100)), 4);
});

// ══ 2. The pace, the slew, the bands ═════════════════════════════════════════

test('the pace ceiling is thirty plus ten per active day, and never past a hundred', () => {
  assert.equal(paceCeiling(0), 30);
  assert.equal(paceCeiling(1), 40);
  assert.equal(paceCeiling(2), 50, 'familiar is in reach on day two');
  assert.equal(paceCeiling(5), 80, 'close by day five');
  assert.equal(paceCeiling(7), 100);
  assert.equal(paceCeiling(1_000), 100);
  assert.equal(paceCeiling(-4), 30, 'a garbled count is no days');
});

test('the target is the evidence under the pace ceiling, so a fact dump in one evening hits the ceiling', () => {
  const dump: FamiliarityEvidence = {
    ...emptyEvidence(), turns: 30, activeDays: 1, statedFacts: 50, moments: 20, themesTaken: 10, selfEntries: 10,
  };
  assert.ok(evidenceScore(dump) > 50, 'she holds a lot');
  assert.equal(targetLevel(dump), 40, 'one active day allows forty, whatever she holds');
  // Fractional evidence floors, and nothing held is the bottom of the scale, never zero.
  assert.equal(targetLevel({ ...emptyEvidence(), turns: 3, activeDays: 1 }), 8);
  assert.equal(targetLevel(emptyEvidence()), 1);
});

test('the slew moves at most two a turn in either direction, and no level reads as one', () => {
  assert.equal(FAMILIARITY_SLEW, 2);
  assert.equal(FAMILIARITY_START, 1);
  assert.equal(slewLevel(null, 1), 1, 'no level starts at one');
  assert.equal(slewLevel(null, 0), 1, 'and never below it');
  assert.equal(slewLevel(null, 50), 3, 'no level starts at one and moves two');
  assert.equal(slewLevel(3, 1), 1, 'down from three is back to one');
  assert.equal(slewLevel(50, 1), 48);
  assert.equal(slewLevel(50, 100), 52);
  assert.equal(slewLevel(10, 11), 11, 'a step smaller than the slew lands on the target');
  assert.equal(slewLevel(100, 250), 100, 'the top holds');
});

test('the bands cut on the stored level at their edges, and a garbled level is a stranger', () => {
  assert.deepEqual(BAND_FLOORS, { stranger: 1, acquaintance: 25, familiar: 50, close: 75 });
  const edges: Array<[number, FamiliarityBand]> = [
    [1, 'stranger'], [24, 'stranger'], [25, 'acquaintance'], [49, 'acquaintance'],
    [50, 'familiar'], [74, 'familiar'], [75, 'close'], [100, 'close'],
  ];
  for (const [level, band] of edges) assert.equal(bandOf(level), band, `level ${level}`);
  assert.equal(bandOf(Number.NaN), 'stranger');
  assert.equal(bandOf(0), 'stranger');
  assert.equal(bandOf(400), 'close');
  assert.equal(clampLevel(52.9), 52);
});

test('one notch down is the next band toward stranger, and never below it', () => {
  assert.deepEqual([...FAMILIARITY_BANDS], ['stranger', 'acquaintance', 'familiar', 'close']);
  assert.equal(lowerBand('close'), 'familiar');
  assert.equal(lowerBand('familiar'), 'acquaintance');
  assert.equal(lowerBand('acquaintance'), 'stranger');
  assert.equal(lowerBand('stranger'), 'stranger');
});

test('a room reads as a stranger whatever is stored, and no row is a stranger too', () => {
  assert.equal(familiarityBandFor({ group: true, level: 100 }), 'stranger');
  assert.equal(familiarityBandFor({ group: true, level: null }), 'stranger');
  assert.equal(familiarityBandFor({ group: false, level: null }), 'stranger');
  assert.equal(familiarityBandFor({ group: false, level: 80 }), 'close');
});

// ══ 3. The lived-exchange counters ═══════════════════════════════════════════

test('a turn counts once and a UTC day counts once, however many turns it holds', () => {
  const t0 = Date.UTC(2026, 8, 20, 9, 0, 0);
  assert.equal(utcDay(t0), '2026-09-20');
  const first = tickCounters(null, t0);
  assert.deepEqual(first, { turns: 1, activeDays: 1, lastDay: '2026-09-20' });
  const sameDay = tickCounters(first, t0 + 14 * 60 * 60 * 1000);
  assert.deepEqual(sameDay, { turns: 2, activeDays: 1, lastDay: '2026-09-20' });
  const nextDay = tickCounters(sameDay, Date.UTC(2026, 8, 21, 0, 5));
  assert.deepEqual(nextDay, { turns: 3, activeDays: 2, lastDay: '2026-09-21' });
  // A clock that went backwards is not a new day.
  assert.deepEqual(tickCounters(nextDay, t0), { turns: 4, activeDays: 2, lastDay: '2026-09-21' });
  // A row whose day stamp did not parse counts the next turn's day.
  assert.deepEqual(tickCounters({ turns: 9, activeDays: 3, lastDay: '' }, t0), { turns: 10, activeDays: 4, lastDay: '2026-09-20' });
});

test('a first row is seeded from tenure: whole days since first seen up to seven, and the harvested turns', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const DAY = 24 * 60 * 60 * 1000;
  assert.equal(FAMILIARITY_SEED_DAYS_CAP, 7, 'the day the pace ceiling reaches a hundred');
  assert.equal(paceCeiling(FAMILIARITY_SEED_DAYS_CAP), 100);
  assert.deepEqual(seedCounters({ firstSeenMs: now - 200 * DAY, harvestCount: 120 }, now), { turns: 120, activeDays: 7, lastDay: '' });
  assert.equal(seedCounters({ firstSeenMs: now - 5.5 * DAY, harvestCount: 0 }, now).activeDays, 5, 'whole days only');
  assert.equal(seedCounters({ firstSeenMs: now - 60_000, harvestCount: 0 }, now).activeDays, 0, 'first seen today is no days yet');
  assert.deepEqual(seedCounters({ firstSeenMs: null, harvestCount: 0 }, now), { turns: 0, activeDays: 0, lastDay: '' }, 'no profile, no tenure');
  assert.equal(seedCounters({ firstSeenMs: now + 3 * DAY, harvestCount: 0 }, now).activeDays, 0, 'a first-seen in the future is no days');
  for (const garbage of [Number.NaN, 0, -5 * DAY, Number.POSITIVE_INFINITY]) {
    assert.equal(seedCounters({ firstSeenMs: garbage, harvestCount: 0 }, now).activeDays, 0, `a garbled first-seen (${garbage}) is no days`);
  }
  for (const garbage of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
    assert.equal(seedCounters({ firstSeenMs: null, harvestCount: garbage }, now).turns, 0, `a garbled harvest count (${garbage}) is no turns`);
  }
});

test('the tick on a seed counts today\'s turn and day on top, and an empty seed ticks like no row at all', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const seed = seedCounters({ firstSeenMs: now - 200 * 24 * 60 * 60 * 1000, harvestCount: 120 }, now);
  assert.deepEqual(tickCounters(seed, now), { turns: 121, activeDays: 8, lastDay: '2026-09-20' });
  assert.deepEqual(tickCounters(seedCounters({ firstSeenMs: null, harvestCount: 0 }, now), now), tickCounters(null, now));
});

// ══ 4. The walk ══════════════════════════════════════════════════════════════

/** Ten turns a day for thirty days, the band read at the end of each day. */
function walk(held: Partial<FamiliarityEvidence>): { bandOnDay: FamiliarityBand[]; level: number } {
  let counters: FamiliarityCounters | null = null;
  let level: number | null = null;
  const bandOnDay: FamiliarityBand[] = [];
  for (let day = 1; day <= 30; day++) {
    for (let turn = 0; turn < 10; turn++) {
      counters = tickCounters(counters, Date.UTC(2026, 3, day, 12, turn));
      level = slewLevel(level, targetLevel({ ...emptyEvidence(), ...held, turns: counters.turns, activeDays: counters.activeDays }));
    }
    bandOnDay[day] = bandOf(level!);
  }
  return { bandOnDay, level: level! };
}

test('a daily texter she holds a lot about opens the bands on the pace ceiling', () => {
  // Sixty points of held material: more than enough, so the ceiling is what binds.
  const { bandOnDay, level } = walk({
    statedFacts: 8, inferredFacts: 6, seededFacts: 8, name: 1, moments: 6, themesTaken: 4, loops: 4, selfEntries: 4,
  });
  assert.equal(bandOnDay[1], 'stranger');
  assert.equal(bandOnDay[2], 'acquaintance');
  assert.equal(bandOnDay[3], 'familiar');
  assert.equal(bandOnDay[4], 'familiar');
  assert.equal(bandOnDay[5], 'close');
  assert.equal(level, 100);
});

test('tenure alone, with nothing held, tops out at forty', () => {
  const { bandOnDay, level } = walk({});
  assert.equal(level, 40, 'twenty for the turns and twenty for the days');
  assert.equal(bandOnDay[30], 'acquaintance');
});
