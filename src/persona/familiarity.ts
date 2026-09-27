// HOW WELL SHE KNOWS THEM, as one number that never prints.
//
// The mood engine runs the same way with everyone: a hidden weather, compiled into instructions on
// every turn (affectCompiler.ts). What changes from person to person is how much of it they get to
// see. A stranger gets her composed, and someone she has known for a month gets the whole weather.
// This file is the arithmetic that says where a person sits between those two, and all it hands the
// rest of the stack is a band name.
//
// FOUR FINDINGS, FOUR RULES (docs/superpowers/specs/2026-09-26-familiarity-mask-design.md):
//   • intimacy grows in layers, positive before negative, and too much too soon reads wrong (Altman
//     and Taylor), so the level is PACED by the days they have actually talked;
//   • with people we barely know we hold the content of a feeling while its energy leaks (Gross), so
//     the band decides content and never shape (affectCompiler.ts MASK_OPENS);
//   • a room is front stage (Goffman), so a group reads as a stranger, always;
//   • the mask drops on responsiveness and not on knowledge alone (Reis and Shaver), so rapport
//     landing badly pulls it back up a band (affectCompiler.ts compileMask).
//
// THE NUMBER IS ARITHMETIC OVER STORES, never a model's report (charter §10.1, the bargain rapport
// and the climate dials make): turns and active days off the ledger row, and what she holds about
// them read off the memory stores at compute time, each source worth a fixed number of points up to
// its own cap. The caps sum to a hundred. Nothing here reads a clock: a quiet stretch is not evidence,
// so the level never decays on silence (climate's rule) and falls only when what she holds shrinks.
// A first row is seeded from tenure (days since first seen, the harvested turns) and lands on its
// target, so someone she has known for months is not a stranger the day the mask ships.
//
// PURE and a LEAF: no DB, no clock read, no env, and it imports nothing, so the compiler, the
// repository, the musings sweep and the dashboard can all import it for the price of a string.

/** The four bands, named after Knapp's stages, in the order they open. The order IS the notch
 *  direction: `lowerBand` steps one place toward the front. */
export const FAMILIARITY_BANDS = ['stranger', 'acquaintance', 'familiar', 'close'] as const;
export type FamiliarityBand = (typeof FAMILIARITY_BANDS)[number];

/** The scale's two ends. A stored level is an integer inside them, always. */
export const FAMILIARITY_FLOOR = 1;
export const FAMILIARITY_CEILING = 100;

/** Where a new row starts, and what a missing row reads as: the bottom of the scale. */
export const FAMILIARITY_START = 1;

/** The most the stored level moves in one turn, either direction. Slow enough that a band cannot
 *  flap from one turn to the next, fast enough that a day of talk moves it. */
export const FAMILIARITY_SLEW = 2;

/** Each band's lowest level. The cut is on the STORED level; the rapport notch is the compiler's. */
export const BAND_FLOORS: Record<FamiliarityBand, number> = {
  stranger: 1, acquaintance: 25, familiar: 50, close: 75,
};

/** The pace ceiling: thirty on no days, ten more for every day they have actually talked. Familiar is
 *  in reach on day two and the ceiling is gone by day seven; the evidence still has to be there. */
export const PACE_BASE = 30;
export const PACE_PER_DAY = 10;

/** The ten things a level is made of: two of lived exchange (the ledger row's own counters) and
 *  eight of held evidence (read off the memory stores when the pass runs). */
export type FamiliaritySourceKey =
  | 'turns' | 'activeDays' | 'statedFacts' | 'inferredFacts' | 'seededFacts'
  | 'name' | 'moments' | 'themesTaken' | 'loops' | 'selfEntries';

/**
 * Each source, what one of it is worth, and the most it can ever be worth. The caps sum to a hundred
 * (pinned by familiarity.test.ts), so the scale's top is "everything, over enough days".
 *
 *   turns        user turns she replied to in a one-to-one chat (a merged burst is one)
 *   activeDays   distinct UTC days with at least one replied turn
 *   statedFacts  facts they told her (medium and profile, provenance stated)
 *   inferredFacts facts she worked out, worth half as much and capped lower
 *   seededFacts  the engine's second-hand picture, worth a quarter
 *   name         their name is known
 *   moments      episodes she keeps about them
 *   themesTaken  recurring things of theirs they picked up at least once
 *   loops        open loops in their life she is tracking
 *   selfEntries  her own stances, tastes and changes of mind with them (a learned entry is about
 *                them, not her, and does not count here)
 */
export const FAMILIARITY_SOURCES: ReadonlyArray<{ key: FamiliaritySourceKey; each: number; cap: number }> = [
  { key: 'turns', each: 0.25, cap: 20 },
  { key: 'activeDays', each: 8, cap: 20 },
  { key: 'statedFacts', each: 2, cap: 16 },
  { key: 'inferredFacts', each: 1, cap: 6 },
  { key: 'seededFacts', each: 0.5, cap: 4 },
  { key: 'name', each: 2, cap: 2 },
  { key: 'moments', each: 2, cap: 12 },
  { key: 'themesTaken', each: 2, cap: 8 },
  { key: 'loops', each: 1, cap: 4 },
  { key: 'selfEntries', each: 2, cap: 8 },
];

/** How many of each source there are, as counts. `name` is zero or one. */
export type FamiliarityEvidence = Record<FamiliaritySourceKey, number>;

/** Nothing held and nothing lived: every count zero. */
export function emptyEvidence(): FamiliarityEvidence {
  return {
    turns: 0, activeDays: 0, statedFacts: 0, inferredFacts: 0, seededFacts: 0,
    name: 0, moments: 0, themesTaken: 0, loops: 0, selfEntries: 0,
  };
}

/** One source as the dashboard reads it: how many, what they are worth, and the cap. */
export interface SourcePoints {
  key: FamiliaritySourceKey;
  count: number;
  points: number;
  cap: number;
}

/** The two lived-exchange counters and the day stamp that guards the second. */
export interface FamiliarityCounters {
  turns: number;
  activeDays: number;
  /** The last UTC day counted, `YYYY-MM-DD`, or '' when none has been. */
  lastDay: string;
}

/** A level as the scale allows it: an integer between the two ends. Garbage is the bottom. */
export function clampLevel(v: number): number {
  if (!Number.isFinite(v)) return FAMILIARITY_START;
  return Math.max(FAMILIARITY_FLOOR, Math.min(FAMILIARITY_CEILING, Math.trunc(v)));
}

/** A count as evidence: a finite positive number, or no evidence at all. */
function countOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Every source, in table order, with its count, its points under the cap, and the cap. */
export function sourcePoints(ev: FamiliarityEvidence): SourcePoints[] {
  return FAMILIARITY_SOURCES.map(s => {
    const count = countOf(ev[s.key]);
    return { key: s.key, count, points: Math.min(s.cap, count * s.each), cap: s.cap };
  });
}

/** What everything held and lived adds up to, before the pace ceiling. At most a hundred. */
export function evidenceScore(ev: FamiliarityEvidence): number {
  return sourcePoints(ev).reduce((n, s) => n + s.points, 0);
}

/** How far the level may have got by now: thirty, plus ten per active day, at most a hundred. */
export function paceCeiling(activeDays: number): number {
  const days = Math.floor(countOf(activeDays));
  return Math.min(FAMILIARITY_CEILING, PACE_BASE + PACE_PER_DAY * days);
}

/** Where the stored level is heading: the evidence under the pace ceiling, as a level. */
export function targetLevel(ev: FamiliarityEvidence): number {
  return clampLevel(Math.floor(Math.min(evidenceScore(ev), paceCeiling(ev.activeDays))));
}

/** One turn's move toward the target, at most FAMILIARITY_SLEW either way. `from` null starts at
 *  FAMILIARITY_START. (The pass never slews a first row: it seeds one from tenure, seedCounters, and
 *  lands it on its target.) */
export function slewLevel(from: number | null, target: number): number {
  const start = from === null ? FAMILIARITY_START : clampLevel(from);
  const step = Math.max(-FAMILIARITY_SLEW, Math.min(FAMILIARITY_SLEW, clampLevel(target) - start));
  return clampLevel(start + step);
}

/** The band a stored level cuts to. */
export function bandOf(level: number): FamiliarityBand {
  const n = clampLevel(level);
  if (n >= BAND_FLOORS.close) return 'close';
  if (n >= BAND_FLOORS.familiar) return 'familiar';
  if (n >= BAND_FLOORS.acquaintance) return 'acquaintance';
  return 'stranger';
}

/** One notch toward the front, never past stranger. */
export function lowerBand(band: FamiliarityBand): FamiliarityBand {
  return FAMILIARITY_BANDS[Math.max(0, FAMILIARITY_BANDS.indexOf(band) - 1)];
}

/** The band a turn reads, from what the caller found: a room is a stranger whatever is stored, and
 *  no row is the bottom of the scale. The flag is the caller's to check (no band at all when off). */
export function familiarityBandFor(read: { group: boolean; level: number | null }): FamiliarityBand {
  if (read.group) return 'stranger';
  return bandOf(read.level ?? FAMILIARITY_START);
}

/** The most days a first row is seeded with: the day the pace ceiling reaches a hundred. */
export const FAMILIARITY_SEED_DAYS_CAP = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A first row's counters, from what the stores already say: whole days since they were first seen
 *  (none for no profile, a garbled stamp or one in the future), capped at FAMILIARITY_SEED_DAYS_CAP,
 *  and the turns the thread harvest has counted. No day stamp, so the tick that follows counts today
 *  as a fresh day. */
export function seedCounters(read: { firstSeenMs: number | null; harvestCount: number }, nowMs: number): FamiliarityCounters {
  const first = read.firstSeenMs;
  const days = typeof first === 'number' && first > 0 ? countOf((nowMs - first) / DAY_MS) : 0;
  return {
    turns: Math.floor(countOf(read.harvestCount)),
    activeDays: Math.min(FAMILIARITY_SEED_DAYS_CAP, Math.floor(days)),
    lastDay: '',
  };
}

/** The UTC day an instant falls on, `YYYY-MM-DD`. */
export function utcDay(nowMs: number): string {
  return new Date(Number.isFinite(nowMs) ? nowMs : 0).toISOString().slice(0, 10);
}

/** Count one replied turn, and its day when the day is new. A day stamp at or before the last one
 *  counted is the same day (a clock that went backwards is not a new day). */
export function tickCounters(prior: FamiliarityCounters | null, nowMs: number): FamiliarityCounters {
  const day = utcDay(nowMs);
  if (!prior) return { turns: 1, activeDays: 1, lastDay: day };
  const fresh = day > prior.lastDay;
  return {
    turns: Math.floor(countOf(prior.turns)) + 1,
    activeDays: Math.floor(countOf(prior.activeDays)) + (fresh ? 1 : 0),
    lastDay: fresh ? day : prior.lastDay,
  };
}
