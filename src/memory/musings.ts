// Her own texts: the one place she starts a conversation because something is on HER mind.
//
// Every other unprompted message in this engine answers to something the user set up or left open:
// a reminder coming due, watched mail, a background finding, an update note, a loop they left
// hanging (memory/threadPings.ts). This line answers to nothing of theirs. It is separate from all of
// those on purpose, the owner's call: no cron job, no reminder and no watch rides it, and nothing here
// is ever billed against their setups. A sweep on a timer looks at what she holds (a stance or taste
// from SELF.md, a moment she keeps about them, a theme of theirs), and sometimes, when her weather is
// up and the moment is ordinary daytime, hands one to the proactive pipeline as a `musing` seed. The
// Composer grows a thought out of it and never reads the seed out (agents/proactive.ts).
//
// The bounds are code, in the order the sweep checks them, cheapest first:
//   • the flag, then a real 1:1 person (never a room);
//   • someone she knows: familiar or close (persona/familiarity.ts), when the familiarity mask is on.
//     A stranger, and someone with no row yet, gets no text she was not asked for;
//   • they talked to her within MUSING_ACTIVE_WITHIN_MS, so a thread they walked away from is not
//     one she keeps texting into;
//   • the chat has been quiet MUSING_QUIET_MS, so a live conversation keeps the thought for itself;
//   • at most one musing per MUSING_GAP_MS, and never a second one they have not answered;
//   • an hour, in their zone, when this person tends to be around (theirHours, learned from when they
//     text; MUSING_HOURS until there is enough history to learn from);
//   • her own weather: a sad or scared core, a low mood or a spent social battery keeps it to herself.
//     Read as it stands NOW (currentWeather): the stored row only moves on a turn, so one from hours
//     ago is how the last conversation left her, and the hours since have rested her to the clock;
//   • then chance (MUSING_CHANCE per eligible sweep), so she is a person with a thought and not a
//     clock that fires at ten every morning;
//   • then a seed she has not already texted about recently.
// BILL FIRST, THEN DELIVER, the ping sweep's rule: the day is spent before the send is attempted, so
// a failed send can never turn into a second text.

import { getPreference, setPreferences } from '../db/repositories/memory.js';
import { distinctUserHandles, getConversation, listActiveChats, userMessageTimes } from '../db/repositories/conversations.js';
import { getAffectState } from '../db/repositories/affectState.js';
import { readSelf } from '../db/repositories/self.js';
import { readMoments } from '../db/repositories/moments.js';
import { getThreadInventory, threadingEnabled } from '../db/repositories/threadInventory.js';
import { familiarityEnabled, musingsEnabled, momentsEnabled, selfEnabled } from '../persona/featureFlags.js';
import { getFamiliarity } from '../db/repositories/familiarity.js';
import { familiarityBandFor, type FamiliarityBand } from '../persona/familiarity.js';
import { isGroupHandle } from './identity.js';
import { dayKey, hourInZone } from '../pipeline/chatTime.js';
import { DEFAULT_TZ } from '../pipeline/zonedTime.js';
import { affectTargets } from '../persona/affectDrift.js';
import { computeCircadian } from '../persona/circadian.js';
import { computeCycle } from '../persona/cycle.js';
import { cycleAnchorMs } from '../persona/config.js';
import { AFFECT_FRESH_MS } from '../persona/threads.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** They spoke to her within this long, or she leaves them be. */
export const MUSING_ACTIVE_WITHIN_MS = 7 * DAY;
/** The chat has been quiet at least this long. A thought that arrives mid-conversation is just a reply. */
export const MUSING_QUIET_MS = 3 * HOUR;
/** At most one musing per this window, per person. */
export const MUSING_GAP_MS = 20 * HOUR;
/** Their local hours she may text in, [from, to), until their own hours can be learned (theirHours). */
export const MUSING_HOURS: readonly [number, number] = [10, 21];
/** How far back their hours are learned from. */
export const MUSING_HOURS_LEARN_MS = 14 * DAY;
/** Days they must have texted on before their hours are trusted over MUSING_HOURS. */
export const MUSING_HOURS_MIN_DAYS = 3;
/** An hour is theirs once they have texted within an hour of it on this many different days. */
export const MUSING_HOUR_MIN_DAYS = 2;
/** The chance an eligible hourly sweep actually sends. About one a day across the daytime window. */
export const MUSING_CHANCE = 0.12;
/** Her weather floors: below either, the thought stays hers. */
export const MUSING_MOOD_FLOOR = 45;
export const MUSING_BATTERY_FLOOR = 50;
/** How many recent seeds are remembered so the same thought is not sent twice in a row. */
export const MUSING_SEED_MEMORY = 12;

const BOOT_DELAY_MS = 90_000;

function sweepIntervalMs(): number {
  const n = Number(process.env.MUSINGS_SWEEP_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HOUR;
}

/** The message this module hands the proactive pipeline, structural like the ping sweep's. */
export interface MusingMessage {
  chatId: string;
  kind: 'musing';
  text: string;
  dedupeKey: string;
}

export interface MusingDeps {
  deliver: (msg: MusingMessage) => Promise<string>;
}

/** Everything she might have on her mind about this person, as seed lines. Stances and tastes lead
 *  with their kind so the Composer knows what sort of thought it is growing. */
export async function gatherSeeds(handle: string): Promise<string[]> {
  const seeds: string[] = [];
  if (selfEnabled()) {
    const self = await readSelf(handle);
    for (const e of self.entries) seeds.push(`${e.kind}: ${e.text}`);
  }
  if (momentsEnabled()) {
    const moments = await readMoments(handle);
    for (const m of moments.entries) seeds.push(`a moment you keep about them: ${m.text}`);
  }
  if (threadingEnabled()) {
    const inv = await getThreadInventory(handle);
    for (const t of inv.themes) {
      if (t.status === 'taggable' || t.status === 'shorthand') seeds.push(`a thing of theirs that keeps coming back: ${t.label}${t.note ? `, ${t.note}` : ''}`);
    }
  }
  return seeds;
}

/** Pure: pick a seed not in the recent list, or null. `rand` in [0, 1). */
export function pickSeed(seeds: readonly string[], recent: readonly string[], rand: number): string | null {
  const seen = new Set(recent);
  const open = seeds.filter(s => !seen.has(s));
  if (!open.length) return null;
  return open[Math.min(open.length - 1, Math.floor(rand * open.length))];
}

/** Pure: the hours of their day, in their zone, when they tend to be around, learned from when they
 *  text. An hour counts once they have texted within an hour of it on MUSING_HOUR_MIN_DAYS different
 *  days, so a one-off late night does not open the small hours. Null when they have texted on fewer
 *  than MUSING_HOURS_MIN_DAYS days: too little to learn from, and the caller falls back. */
export function theirHours(times: readonly number[], tz: string): Set<number> | null {
  const daysAt: Set<string>[] = Array.from({ length: 24 }, () => new Set<string>());
  const allDays = new Set<string>();
  for (const t of times) {
    const day = dayKey(t, tz);
    allDays.add(day);
    daysAt[hourInZone(t, tz)].add(day);
  }
  if (allDays.size < MUSING_HOURS_MIN_DAYS) return null;
  const hours = new Set<number>();
  for (let h = 0; h < 24; h++) {
    const near = new Set([...daysAt[(h + 23) % 24], ...daysAt[h], ...daysAt[(h + 1) % 24]]);
    if (near.size >= MUSING_HOUR_MIN_DAYS) hours.add(h);
  }
  return hours;
}

/** The slice of her affect row the weather gate reads. */
export interface WeatherRead { mood_core?: string; mood_level?: number; social_battery?: number; at?: number }

/** Pure but for the clock math: her weather as it stands at `now`. A row from the last few hours
 *  (AFFECT_FRESH_MS, the window the turn itself trusts) is her weather. An older row, or none, is
 *  read as rested: the gauge targets for this hour in their zone and this cycle day, the same
 *  baseline every turn drifts toward (persona/affectDrift.ts). A rested read carries no core, since
 *  the feeling word belonged to the conversation that wrote it. */
export function currentWeather(last: WeatherRead | undefined, now: number, tz: string): WeatherRead {
  if (last && typeof last.at === 'number' && now >= last.at && now - last.at <= AFFECT_FRESH_MS) return last;
  const t = affectTargets({ cycle: computeCycle(now, cycleAnchorMs()), circadian: computeCircadian(now, tz) });
  return { mood_level: t.mood_level, social_battery: t.social_battery };
}

/** Pure: does her weather leave room for a thought of her own? No row reads as yes. */
export function weatherAllows(last: WeatherRead | undefined): boolean {
  if (!last) return true;
  if (last.mood_core === 'sad' || last.mood_core === 'scared') return false;
  if (typeof last.mood_level === 'number' && last.mood_level < MUSING_MOOD_FLOOR) return false;
  if (typeof last.social_battery === 'number' && last.social_battery < MUSING_BATTERY_FLOOR) return false;
  return true;
}

/** Pure: does she know them well enough to text first? Familiar or close. A thought of her own is a
 *  back-stage move, and a stranger is still front stage. */
export function familiarityAllows(band: FamiliarityBand): boolean {
  return band === 'familiar' || band === 'close';
}

interface SweepCounts {
  considered: number;
  sent: number;
  failed: number;
  skipped: Record<string, number>;
}

let armed = false;
let running = false;

export async function runMusingSweep(deps: MusingDeps, opts: { now?: number; rand?: () => number } = {}): Promise<void> {
  if (!musingsEnabled()) return;
  if (running) return;
  running = true;
  const now = opts.now ?? Date.now();
  const rand = opts.rand ?? Math.random;
  const counts: SweepCounts = { considered: 0, sent: 0, failed: 0, skipped: {} };
  const skip = (why: string) => { counts.skipped[why] = (counts.skipped[why] ?? 0) + 1; };

  try {
    const chats = await listActiveChats(now - MUSING_ACTIVE_WITHIN_MS, 10);
    for (const { chatId, lastAt } of chats) {
      counts.considered++;
      try {
        if (now - lastAt < MUSING_QUIET_MS) { skip('live'); continue; }
        const handles = await distinctUserHandles(chatId, 2);
        if (handles.length !== 1 || isGroupHandle(handles[0])) { skip('group'); continue; }
        const handle = handles[0];
        // The stored band, as the turn reads it before any rapport notch; no row is a stranger. With
        // the mask off there is no gate at all.
        if (familiarityEnabled()) {
          const row = await getFamiliarity(handle);
          if (!familiarityAllows(familiarityBandFor({ group: false, level: row?.level ?? null }))) { skip('familiarity'); continue; }
        }

        const lastMusingAt = (await getPreference<number>(handle, 'last_musing_at')) ?? 0;
        if (now - lastMusingAt < MUSING_GAP_MS) { skip('budget'); continue; }
        const rows = await getConversation(chatId);
        const lastUserAt = [...rows].reverse().find(m => m.role === 'user')?.at ?? 0;
        if (now - lastUserAt > MUSING_ACTIVE_WITHIN_MS) { skip('gone_quiet'); continue; }
        if (lastMusingAt > lastUserAt) { skip('unanswered'); continue; }

        // Their zone, and one Intl will accept: a stored zone it rejects reads as the default.
        let tz = (await getPreference<string>(handle, 'agent_tz')) || DEFAULT_TZ;
        try { hourInZone(now, tz); } catch { tz = DEFAULT_TZ; }
        const hour = hourInZone(now, tz);
        const learned = theirHours(await userMessageTimes(chatId, now - MUSING_HOURS_LEARN_MS), tz);
        if (learned ? !learned.has(hour) : hour < MUSING_HOURS[0] || hour >= MUSING_HOURS[1]) { skip('hour'); continue; }

        const affect = await getAffectState(chatId);
        if (!weatherAllows(currentWeather(affect.last, now, tz))) { skip('weather'); continue; }
        if (rand() >= MUSING_CHANCE) { skip('chance'); continue; }

        const recent = (await getPreference<string[]>(handle, 'musing_seeds')) ?? [];
        const seed = pickSeed(await gatherSeeds(handle), Array.isArray(recent) ? recent : [], rand());
        if (!seed) { skip('no_seed'); continue; }

        // BILL FIRST: the day and the seed are spent before the send, so nothing retries into a
        // second text.
        await setPreferences(handle, {
          last_musing_at: now,
          musing_seeds: [...(Array.isArray(recent) ? recent : []), seed].slice(-MUSING_SEED_MEMORY),
        });
        const outcome = await deps.deliver({ chatId, kind: 'musing', text: seed, dedupeKey: `musing:${handle}:${dayKey(now, tz)}` });
        counts.sent++;
        record({ type: 'event', label: 'musings:sent', chatId, handle, detail: { outcome } });
      } catch (err) {
        counts.failed++;
        reportError({ source: 'memory', category: 'other', severity: 'warn', message: 'musing failed, the day is still spent', err });
      }
    }
    record({ type: 'event', label: 'musings:sweep', detail: { ...counts } });
  } catch (err) {
    reportError({ source: 'memory', category: 'other', severity: 'warn', message: 'musing sweep failed, nobody was texted', err });
  } finally {
    running = false;
  }
}

/** Called once from src/index.ts at boot. Arms unconditionally; the flag is read inside the sweep. */
export function initMusings(deps: MusingDeps): void {
  if (armed) return;
  armed = true;
  const boot = setTimeout(() => { void runMusingSweep(deps); }, BOOT_DELAY_MS);
  (boot as { unref?: () => void }).unref?.();
  const periodic = setInterval(() => { void runMusingSweep(deps); }, sweepIntervalMs());
  (periodic as { unref?: () => void }).unref?.();
}

export function __resetMusingGuardsForTests(): void {
  armed = false;
  running = false;
}
