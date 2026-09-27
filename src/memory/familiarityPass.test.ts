// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The familiarity pass, end to end against the ephemeral store: a replied turn is counted once and a
// day once, what she holds is read off the stores it lives in (a store behind a switch that is off
// holds nothing), a first row is seeded from tenure and lands on its target, every later pass moves
// the stored level at most two points toward what that adds up to, a room is never counted, and a
// band change files one receipt.
process.env.TZ = 'UTC';

import fs from 'node:fs';
import path from 'node:path';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { memoriesDir } from '../db/stateDir.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { getFamiliarity, saveFamiliarity, type FamiliarityRow } from '../db/repositories/familiarity.js';
import { upsertFact } from '../db/repositories/memoryMedium.js';
import { addUserFact, setUserName, updateUserProfile } from '../db/repositories/profiles.js';
import { writeMoments } from '../db/repositories/moments.js';
import { writeSelf, type SelfEntry, type SelfKind } from '../db/repositories/self.js';
import { saveThreadInventory } from '../db/repositories/threadInventory.js';
import { defaultThreadInventory, type LoopStatus, type OpenLoop, type ThreadTheme } from '../persona/threads.js';
import type { MomentEntry } from '../persona/moments.js';
import { bandOf, emptyEvidence, FAMILIARITY_SLEW, FAMILIARITY_START, targetLevel } from '../persona/familiarity.js';
import { SEED_SOURCE } from './provenance.js';
import { groupHandle } from './identity.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import { FAMILIARITY_BAND_LABEL, gatherFamiliarityEvidence, updateFamiliarity } from './familiarityPass.js';

const H = '+15550003131';
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ENV = ['CONVO_FAMILIARITY_ENABLED', 'MEMORY_PROVENANCE_ENABLED', 'MEMORY_MOMENTS_ENABLED', 'MEMORY_SELF_ENABLED', 'CONVO_THREADING_ENABLED'];

beforeEach(() => {
  resetStorageForTests();
  clearTraces();
  for (const k of ENV) delete process.env[k];
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
});
afterEach(() => { for (const k of ENV) delete process.env[k]; });

/** The stored row without its write clock. */
async function row(handle: string): Promise<Omit<FamiliarityRow, 'updatedAt'> | null> {
  const r = await getFamiliarity(handle);
  return r && { level: r.level, turns: r.turns, activeDays: r.activeDays, lastDay: r.lastDay };
}

const bandReceipts = () => getTraces().filter(e => e.label === FAMILIARITY_BAND_LABEL);

function moment(id: string): MomentEntry {
  return { id, text: 'checked the volcano dashboard again and decided nothing', tag: 'habit', at: T0, count: 1, offered: 0, lastOfferedAt: 0 };
}
function selfEntry(id: string, kind: SelfKind): SelfEntry {
  return { id, kind, text: 'pineapple belongs on pizza, sweet and salt is the point', at: T0 };
}
function theme(id: string, uptakes: number): ThreadTheme {
  return {
    id, label: `speed vs craft ${id}`, kind: 'tension', note: 'ships fast, then hates the seams',
    evidenceDays: [T0 - 3 * DAY, T0], evidenceCount: 2, status: 'taggable', confidence: 40,
    firstSeenAt: T0 - 3 * DAY, lastSeenAt: T0, lastOfferedAt: 0, lastTaggedAt: 0, lastOutcome: null,
    soreAt: 0, uptakes, passes: 0, pushbacks: 0, mintedDistressed: false,
  };
}
function loop(id: string, status: LoopStatus = 'open'): OpenLoop {
  const closed = status === 'resolved' || status === 'expired';
  return {
    id, label: 'the interview', note: 'the thing on thursday', status,
    capturedAt: T0, lastSeenAt: T0, offeredAt: 0, askedAt: status === 'asked' ? T0 : 0,
    resolvedAt: closed ? T0 : 0, passes: 0,
  };
}

/** A profile first seen at `at`. The profile stamps its own clock, and tenure is what a first row
 *  is seeded from, so a test that cannot age a profile cannot tell a seed from a fresh start. */
async function firstSeenAt(handle: string, at: number): Promise<void> {
  const real = Date.now;
  Date.now = () => at;
  try {
    await updateUserProfile(handle, {});
  } finally {
    Date.now = real;
  }
}

/** One of everything, in every store the pass reads, with the harvest's own turn count. */
async function seedEverything(harvestCount = 0): Promise<void> {
  process.env.MEMORY_PROVENANCE_ENABLED = 'true';
  await upsertFact(H, 'job', 'runs a plant nursery');                       // their words
  await upsertFact(H, 'pet', 'probably a cat person', 'convo', 'inferred');  // her guess
  await upsertFact(H, 'hometown', 'grew up near the coast', SEED_SOURCE);    // the engine's picture
  await addUserFact(H, 'likes golf');                                        // stated, the default basis
  await addUserFact(H, 'a night owl', 'inferred');
  await setUserName(H, 'Ada');
  await writeMoments(H, [moment('m1'), moment('m2')], 0, []);
  await writeSelf(H, [selfEntry('s1', 'stance'), selfEntry('s2', 'taste'), selfEntry('s3', 'learned'), selfEntry('s4', 'changed')], 0, []);
  // Two loops still pending (open, and asked about) and two that have ended but wait out the prune.
  const loops = [loop('l1'), loop('l2', 'asked'), loop('l3', 'resolved'), loop('l4', 'expired')];
  await saveThreadInventory(H, { ...defaultThreadInventory(), themes: [theme('t1', 1), theme('t2', 0)], loops, harvestCount });
}

// ── the counters ─────────────────────────────────────────────────────────────

test('a first replied turn opens a row on its target and counts the turn and the day', async () => {
  await updateFamiliarity(H, { now: T0 });
  assert.deepEqual(await row(H), { level: 8, turns: 1, activeDays: 1, lastDay: '2026-09-20' });
});

test('the same day is one day however many turns it holds, and the next day is another', async () => {
  await updateFamiliarity(H, { now: T0 });
  await updateFamiliarity(H, { now: T0 + 60_000 });
  await updateFamiliarity(H, { now: T0 + 3 * 60 * 60 * 1000 });
  assert.deepEqual(await row(H), { level: 8, turns: 3, activeDays: 1, lastDay: '2026-09-20' });
  await updateFamiliarity(H, { now: T0 + DAY });
  assert.deepEqual(await row(H), { level: 10, turns: 4, activeDays: 2, lastDay: '2026-09-21' });
});

test('passes fired together still count every turn', async () => {
  await Promise.all([updateFamiliarity(H, { now: T0 }), updateFamiliarity(H, { now: T0 + 1 }), updateFamiliarity(H, { now: T0 + 2 })]);
  assert.equal((await row(H))?.turns, 3, 'serialized per handle, so no tick is lost to a race');
});

// ── the first row ────────────────────────────────────────────────────────────

test('someone she has known for months lands on their target on the first pass, seeded from tenure', async () => {
  await firstSeenAt(H, T0 - 200 * DAY);
  await seedEverything(120);
  await updateFamiliarity(H, { now: T0 });
  const first = await row(H);
  const target = targetLevel(await gatherFamiliarityEvidence(H, { turns: 121, activeDays: 8 }));
  assert.deepEqual(first, { level: target, turns: 121, activeDays: 8, lastDay: '2026-09-20' },
    'days capped at seven and the harvested turns, today on top, and the level straight to the target');
  assert.equal(bandOf(target), 'familiar', 'months of held material: no stranger for days');
  // Every later pass slews: with her stances switched off the target falls six, the level two.
  process.env.MEMORY_SELF_ENABLED = 'off';
  await updateFamiliarity(H, { now: T0 + 60_000 });
  assert.deepEqual(await row(H), { level: target - FAMILIARITY_SLEW, turns: 122, activeDays: 8, lastDay: '2026-09-20' },
    'a row exists now, so the counters are its own and the move is paced');
});

test('someone new lands where the evidence and the pace put them, which is near the bottom', async () => {
  await firstSeenAt(H, T0);
  await updateFamiliarity(H, { now: T0 });
  const first = await row(H);
  assert.ok((first?.level ?? 0) <= 40, 'one day allows forty at most');
  assert.deepEqual(first, { level: 8, turns: 1, activeDays: 1, lastDay: '2026-09-20' }, 'nothing held but today: one turn and one day, and today counted');
});

test('a fact dump the evening she meets them still stops at the pace ceiling', async () => {
  await firstSeenAt(H, T0);
  await seedEverything(200);
  await updateFamiliarity(H, { now: T0 });
  assert.equal((await row(H))?.level, 40, 'one active day allows forty, whatever she holds');
});

test('an unreadable store on the first pass stores the seeded counters at the start, and the next pass slews', async () => {
  await firstSeenAt(H, T0 - 200 * DAY);
  await saveThreadInventory(H, { ...defaultThreadInventory(), harvestCount: 120 });
  const broken = path.join(memoriesDir(H), 'MOMENTS.md');
  fs.mkdirSync(broken, { recursive: true });
  const original = console.error;
  console.error = () => {};
  try {
    await updateFamiliarity(H, { now: T0 });
  } finally {
    console.error = original;
  }
  assert.deepEqual(await row(H), { level: FAMILIARITY_START, turns: 121, activeDays: 8, lastDay: '2026-09-20' },
    'a first row that could not read its evidence does not jump, and its tenure is still kept');
  fs.rmSync(broken, { recursive: true, force: true });
  await updateFamiliarity(H, { now: T0 + 60_000 });
  assert.equal((await row(H))?.level, FAMILIARITY_START + FAMILIARITY_SLEW, 'a row exists now: the clean pass slews from the start');
});

// ── the slew ─────────────────────────────────────────────────────────────────

test('the stored level moves at most two points a turn, in either direction', async () => {
  // A long tenure: the target (forty on tenure alone) is far above the stored ten.
  await saveFamiliarity(H, { level: 10, turns: 200, activeDays: 30, lastDay: '2026-09-19' });
  await updateFamiliarity(H, { now: T0 });
  assert.equal((await row(H))?.level, 10 + FAMILIARITY_SLEW);
  // Nothing lived and nothing held: the target is the bottom, and the fall is paced the same.
  await saveFamiliarity(H, { level: 60, turns: 0, activeDays: 0, lastDay: '' });
  await updateFamiliarity(H, { now: T0 });
  assert.equal((await row(H))?.level, 60 - FAMILIARITY_SLEW);
});

// A file that fails to read comes back empty and `degraded`, and empty is not evidence of holding
// less. A directory where the file should be is the stores' own unreadable fixture (moments.test.ts).
for (const file of ['MOMENTS.md', 'SELF.md']) {
  test(`an unreadable ${file} holds the level where it was, and the turn still counts`, async () => {
    // Nothing held and a short tenure: the target sits below the stored forty, so a clean read falls.
    await saveFamiliarity(H, { level: 40, turns: 50, activeDays: 10, lastDay: '2026-09-19' });
    const broken = path.join(memoriesDir(H), file);
    fs.mkdirSync(broken, { recursive: true });
    const original = console.error;
    console.error = () => {};
    try {
      await updateFamiliarity(H, { now: T0 });
    } finally {
      console.error = original;
    }
    assert.deepEqual(await row(H), { level: 40, turns: 51, activeDays: 11, lastDay: '2026-09-20' }, 'held, and counted');
    // The same pass over a readable store does fall, so the hold was the degraded read.
    fs.rmSync(broken, { recursive: true, force: true });
    await updateFamiliarity(H, { now: T0 + 60_000 });
    assert.equal((await row(H))?.level, 40 - FAMILIARITY_SLEW, 'a clean read slews as usual');
  });
}

// ── the receipt ──────────────────────────────────────────────────────────────

test('a band change files one receipt with both bands and the level, and a steady band files none', async () => {
  await saveFamiliarity(H, { level: 24, turns: 100, activeDays: 10, lastDay: '2026-09-19' });
  await updateFamiliarity(H, { now: T0, chatId: 'web:fam' });
  assert.equal((await row(H))?.level, 26);
  const receipts = bandReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].handle, H);
  assert.equal(receipts[0].chatId, 'web:fam');
  assert.deepEqual(receipts[0].detail, { from: 'stranger', to: 'acquaintance', level: 26 });
  clearTraces();
  await updateFamiliarity(H, { now: T0 + 60_000 });
  assert.equal((await row(H))?.level, 28);
  assert.equal(bandReceipts().length, 0, 'still acquaintance: nothing to report');
});

// ── the gates ────────────────────────────────────────────────────────────────

test('a room is never counted, and with the switch off nobody is', async () => {
  const room = groupHandle('chat-fam-1');
  await updateFamiliarity(room, { now: T0 });
  assert.equal(await getFamiliarity(room), null);
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  await updateFamiliarity(H, { now: T0 });
  assert.equal(await getFamiliarity(H), null);
});

// ── the evidence ─────────────────────────────────────────────────────────────

test('what she holds is read off each store, facts counted by who said so and loops only while open', async () => {
  await seedEverything();
  assert.deepEqual(await gatherFamiliarityEvidence(H, { turns: 7, activeDays: 3 }), {
    turns: 7, activeDays: 3, statedFacts: 2, inferredFacts: 2, seededFacts: 1, name: 1,
    moments: 2, themesTaken: 1, loops: 2, selfEntries: 3,
  });
});

test('a store behind a switch that is off holds nothing, and a person she holds nothing about is empty', async () => {
  await seedEverything();
  process.env.MEMORY_MOMENTS_ENABLED = 'off';
  process.env.MEMORY_SELF_ENABLED = 'off';
  process.env.CONVO_THREADING_ENABLED = 'off';
  const ev = await gatherFamiliarityEvidence(H, { turns: 0, activeDays: 0 });
  assert.deepEqual(
    { moments: ev.moments, selfEntries: ev.selfEntries, themesTaken: ev.themesTaken, loops: ev.loops },
    { moments: 0, selfEntries: 0, themesTaken: 0, loops: 0 },
  );
  assert.equal(ev.statedFacts, 2, 'facts have no switch and still count');
  assert.equal(ev.name, 1);
  assert.deepEqual(await gatherFamiliarityEvidence('+15550009898', { turns: 0, activeDays: 0 }), emptyEvidence());
});
