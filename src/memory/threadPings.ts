// The thread-revisit ping: the one place threading STARTS a message instead of colouring a reply.
//
// Everything else in this feature happens inside a turn the user began — the harvest folds what she
// noticed into the row, the pre-turn read puts at most one thing in front of her. This file has no
// turn to hang off. It sweeps the store on a timer, finds a loop that has been quiet for a few days
// with nobody having asked how it went, and texts a phone about it.
//
// That difference is the whole reason for the shape below:
//   • DEFAULT ON (see threadingPingsEnabled), the owner's call: she should start conversations, the
//     same as musings. It is still the flag that decides whether a phone buzzes at someone who did not
//     write to her, so the bounds below are hard code, and the off switch is one Configure flag.
//   • BILL FIRST, THEN DELIVER. The weekly budget is spent before the send is attempted, so a
//     delivery that fails still costs the week. That is the cheap side of the trade: the expensive
//     side would be a failure that leaves the budget unspent, an hourly sweep that finds the same
//     loop still eligible, and a person getting the same question twice.
//   • ONE FAILING HANDLE ENDS ONE HANDLE. The sweep walks everybody; a bad row, a missing chat, a
//     dead voice lane for one person must not silence the ping the next person had coming.
//
// Gates, in order, all of them cheap and all of them code: both flags → not a room → not already
// pinged this week → the thread has actually gone quiet → we know where to send it → an eligible
// loop exists. Only then does anything get written or sent. The back-off gate runs after the chat
// lookup.

import { getForgetEpoch, getPreference } from '../db/repositories/memory.js';
import {
  getThreadInventory, listThreadInventoryHandles, saveThreadInventory, threadingEnabled,
} from '../db/repositories/threadInventory.js';
import { LOOP_EXPIRY_MS, type OpenLoop, type ThreadInventory } from '../persona/threads.js';
import { isGroupHandle } from './identity.js';
import { readBackoff } from './proactiveBackoff.js';
// A pure leaf with no imports of its own — the note further down about src/memory not reaching into
// src/pipeline is about the modules that reach BACK into src/agents; this one reaches nowhere.
import { isoWeekParts } from '../pipeline/isoWeek.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The feature gate (env: THREADING_PINGS_ENABLED). DEFAULT ON, the house shape: `''` means on, and
 * only an explicit off value turns it off (`bash scripts/configure.sh --pings off`). Read at call
 * time like its siblings, so flipping it needs no restart.
 */
export function threadingPingsEnabled(): boolean {
  const v = (process.env.THREADING_PINGS_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** How often the sweep runs (env: THREAD_PING_SWEEP_MS). Hourly: the eligibility window is days
 *  wide, so this only decides how promptly a loop that ripened overnight gets its question. */
function sweepIntervalMs(): number {
  const n = Number(process.env.THREAD_PING_SWEEP_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HOUR;
}

/** Delay before the first sweep, so a restart's own work lands first (initSemanticRecall's number,
 *  for the same reason). */
const BOOT_DELAY_MS = 60_000;

/** The check-in's payload. A copy of agents/proactive.ts CHECKIN_PAYLOAD (src/memory does not import
 *  src/agents); threadPings.test.ts pins the two equal. */
const CHECKIN_PAYLOAD = 'whether they still want you texting them first';

/** Youngest a loop may be before it is worth a ping. Under three days the thing has usually not
 *  HAPPENED yet, and a question about it is not a revisit — it is her hovering. */
export const PING_MIN_AGE_MS = 3 * DAY;

/**
 * Oldest a loop may be. Deliberately the same clock the harvest expires a loop on: three weeks with
 * no mention means it resolved without her or it never mattered, and the question has gone from warm
 * to stale either way.
 *
 * It is not redundant with that expiry, which is why it is enforced here too. The harvest only runs
 * on turns the user starts, so exactly the person this sweep exists for — the one who went quiet —
 * is the person whose row still says `open` on day forty. The expiry catches it the moment they come
 * back; this catches it while they are gone.
 */
export const PING_MAX_AGE_MS = LOOP_EXPIRY_MS;

/** At most one unprompted question a week, per person. Persisted on the row (`lastPingAt`), so it
 *  survives restarts and a /forget wipes it for free along with everything else. */
export const PING_BUDGET_MS = 7 * DAY;

/** How long the CONVERSATION must have been quiet. An active texter's open loops surface in live
 *  turns, where the reply path can read the room, the mood and the opening gap before it asks — a
 *  far better ask than this one. The ping is for the thread that has gone silent, so it stands down
 *  for two days after the last harvested turn and lets the reply path have first refusal. */
export const PING_QUIET_MS = 48 * HOUR;

/**
 * The pure half: which held loop (if any) deserves an unprompted question right now.
 *
 * Every condition is a reason the question is still both ASKABLE and UNASKED:
 *   • `open` — not asked, not resolved, not expired.
 *   • `askedAt === 0` — belt to the status's braces: a loop revived from `asked` back to `open` has
 *     already had its question, and asking again is the failure this whole feature is built to avoid.
 *   • `passes === 0` — waved off even once, and an unprompted repeat is pushing.
 *   • age in [3d, 21d] — old enough to be a revisit, fresh enough to still be alive.
 * Oldest mention first, matching the reply path's ranking: the thing they have gone longest without
 * mentioning is the thing a person would actually wonder about.
 */
export function pickPingLoop(inventory: ThreadInventory, now: number): OpenLoop | null {
  let best: OpenLoop | null = null;
  for (const loop of inventory.loops) {
    if (loop.status !== 'open') continue;
    if (loop.askedAt !== 0) continue;
    if (loop.passes !== 0) continue;
    const age = now - loop.lastSeenAt;
    if (age < PING_MIN_AGE_MS || age > PING_MAX_AGE_MS) continue;
    if (!best || loop.lastSeenAt < best.lastSeenAt) best = loop;
  }
  return best;
}

/** The message this module hands the proactive pipeline: a callback, or the back-off's one check-in.
 *  Structural, not `ProactiveMessage` itself: src/memory does not import src/pipeline (which would
 *  drag src/agents in behind it), and the real `deliver` is assignable to this exactly as it stands. */
export interface ThreadPingMessage {
  chatId: string;
  kind: 'callback' | 'checkin';
  text: string;
  dedupeKey: string;
}

export interface ThreadPingDeps {
  /** `proactive.deliver` from src/index.ts. Owns quiet hours (a callback is NOT reminder-exempt, so
   *  a 2am ping is parked as a durable row until morning), idempotency, Composer voicing and the
   *  Fallfirm degrade under it. Its ProactiveOutcome string rides into the receipt. */
  deliver: (msg: ThreadPingMessage) => Promise<string>;
}

/** ISO-8601 week, UTC (`2026-W35`). Part of the dedupe key so that key changes at most once a week.
 *  Worth being precise about: the pipeline's dedupe window is MINUTES (PROACTIVE_DEDUPE_WINDOW_MS,
 *  30m default), so this token is not what enforces one-per-week — the persisted `lastPingAt` is.
 *  What it buys is that two sweeps racing the same ripe loop inside that window collapse into one
 *  delivery even if the billing write somehow lost its race. */
function isoWeek(at: number): string {
  // The arithmetic (Monday-based weeks that belong to the year of their Thursday) lives in
  // `src/pipeline/isoWeek.ts` — one home, shared with the engine session's rotation window, which
  // renders the same parts as `-w2026-36`. Only this rendering is local.
  const { year, week } = isoWeekParts(at);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Disjoint by construction: `considered` is the sum of every other bucket, so a handle that
 *  vanished from the sweep always has exactly one reason on the receipt.
 *
 *  `sent` means HANDED OVER, not landed: the pipeline's own verdict (sent / deferred to morning by
 *  quiet hours / duplicate / dropped by the mouth) rides per-send in `sends[].outcome`, because from
 *  here every one of those is the same thing — the question is out of this module's hands and the
 *  week is spent. `failed` is the send that threw. `skipped_backoff` = held by the back-off;
 *  `checkins` = the back-off's one ask was handed over. */
interface SweepCounts {
  considered: number;
  sent: number;
  failed: number;
  skipped_group: number;
  skipped_budget: number;
  skipped_quiet: number;
  no_candidate: number;
  no_chat: number;
  save_refused: number;
  skipped_backoff: number;
  checkins: number;
}

/** Armed once, at boot. */
let armed = false;
/** True while a sweep is in flight. The hourly interval does not know how long a sweep takes: a slow
 *  voice lane can outlive the hour, and two passes over the same ripe loop would bill it twice. */
let running = false;

/**
 * One sweep over every handle holding an inventory. Exported so it can be driven directly (tests, a
 * manual catch-up) without arming a timer — runEmbeddingBackfill's shape.
 *
 * Both flags are read BEFORE the handle list, not per handle: with the feature off this costs one
 * env read and touches the database not at all.
 */
export async function runThreadPingSweep(
  deps: ThreadPingDeps,
  opts: { now?: number } = {},
): Promise<void> {
  if (!threadingEnabled() || !threadingPingsEnabled()) return;
  if (running) return;   // an hourly timer must never overlap a sweep that ran long and double-send
  running = true;

  const now = opts.now ?? Date.now();
  const counts: SweepCounts = {
    considered: 0, sent: 0, failed: 0, skipped_group: 0, skipped_budget: 0,
    skipped_quiet: 0, no_candidate: 0, no_chat: 0, save_refused: 0, skipped_backoff: 0, checkins: 0,
  };
  // The model's own words for the thing live in receipts and in the message, nowhere else.
  const sends: Array<{ handle: string; loopId: string; label: string; outcome: string }> = [];

  try {
    const handles = await listThreadInventoryHandles();
    // The /forget fence, read ONCE for the whole sweep rather than per handle. Every voiced delivery
    // below is an LLM call, so a sweep over a handful of people can run for minutes: reading the
    // epochs up front means a /forget landing ANYWHERE inside that window — including while somebody
    // else's message was being written — refuses every billing write after it, not just the row the
    // wipe raced. Strictly more conservative than reading it per handle, which is the right
    // direction for a fence.
    const epochs = new Map(handles.map(h => [h, getForgetEpoch(h)]));

    for (const handle of handles) {
      counts.considered++;
      try {
        // Structural privacy, the same as both live ends: a loop is one person's pending thing, and
        // a room has none. A group row should not exist at all — this is the belt.
        if (isGroupHandle(handle)) { counts.skipped_group++; continue; }

        const epoch0 = epochs.get(handle) ?? getForgetEpoch(handle);
        const inventory = await getThreadInventory(handle);

        if (now - inventory.lastPingAt < PING_BUDGET_MS) { counts.skipped_budget++; continue; }
        if (now - inventory.lastHarvestAt < PING_QUIET_MS) { counts.skipped_quiet++; continue; }

        // Where a proactive message for this person goes (memory.ts's ensureChatId writes it on
        // every turn). No chat id, no send — there is nowhere to put the question.
        const chatId = (await getPreference<string>(handle, 'chat_id'))?.trim();
        if (!chatId) { counts.no_chat++; continue; }

        // The back-off (memory/proactiveBackoff.ts): her own texts piling up unanswered turn this
        // slot into one ask, and an unanswered ask, or a no, into silence.
        const backoff = await readBackoff(chatId, handle);
        if (backoff === 'silent') { counts.skipped_backoff++; continue; }
        if (backoff === 'checkin') {
          // BILL FIRST, like a ping: the week is spent before the send, and no loop is armed — the
          // ask is about her texting at all, not about any thread.
          const saved = await saveThreadInventory(handle, { ...inventory, lastPingAt: now }, { ifForgetEpoch: epoch0 });
          if (!saved) { counts.save_refused++; continue; }
          const outcome = await deps.deliver({
            chatId, kind: 'checkin', text: CHECKIN_PAYLOAD,
            dedupeKey: `backoff:checkin:${handle}:${isoWeek(now)}`,
          });
          counts.checkins++;
          sends.push({ handle, loopId: '', label: 'checkin', outcome });
          continue;
        }

        const loop = pickPingLoop(inventory, now);
        if (!loop) { counts.no_candidate++; continue; }

        // BILL FIRST. `offeredAt` puts the loop under the reply path's 72h cooldown so a live turn
        // does not ask the same question tonight, and the pending slot is armed straight to
        // `awaiting` (not `offered`): the ping IS the utterance, so the next turn's outcome-ask is
        // honest immediately, and one thing in flight blocks any other offer until it is answered.
        const next: ThreadInventory = {
          ...inventory,
          loops: inventory.loops.map(l => (l.id === loop.id ? { ...l, offeredAt: now } : l)),
          pending: { themeId: loop.id, at: now, phase: 'awaiting', material: 'loop' },
          lastPingAt: now,
        };
        const saved = await saveThreadInventory(handle, next, { ifForgetEpoch: epoch0 });
        // A refused save is a /forget mid-sweep. Nothing is owed and nothing is sent: the question
        // was about a thread the user just asked to be forgotten.
        if (!saved) { counts.save_refused++; continue; }

        // A hand-edited row can carry a loop with no note; the label alone is still a thing to ask
        // about, and a dangling em dash is not.
        const text = loop.note ? `"${loop.label}" — ${loop.note}` : `"${loop.label}"`;
        const outcome = await deps.deliver({
          chatId,
          kind: 'callback',
          text,
          dedupeKey: `threads:ping:${handle}:${loop.id}:${isoWeek(now)}`,
        });
        counts.sent++;
        sends.push({ handle, loopId: loop.id, label: loop.label, outcome });
      } catch (err) {
        // Billed or not, this handle is done for the week (see the header) and the sweep goes on.
        counts.failed++;
        reportError({
          source: 'memory', category: 'other', severity: 'warn',
          message: 'thread ping failed — the week is still spent',
          err, handle,
        });
      }
    }

    // ONE summary per sweep, always — the sweep that pinged nobody is exactly as informative as the
    // one that did, and without it "off" and "found nothing" look identical on the dashboard.
    record({ type: 'event', label: 'threads:ping', detail: { ...counts, sends } });
  } catch (err) {
    reportError({
      source: 'memory', category: 'other', severity: 'warn',
      message: 'thread ping sweep failed — nobody was pinged', err,
    });
  } finally {
    // In a finally, always: a run that threw must not wedge the flag on and end the sweeps.
    running = false;
  }
}

/**
 * Called once from src/index.ts at boot. Arms UNCONDITIONALLY — both flags are read inside the sweep,
 * at call time, so an operator can turn pings on without a restart and the armed timer costs an env
 * read an hour until they do.
 */
export function initThreadPings(deps: ThreadPingDeps): void {
  if (armed) return;
  armed = true;

  // Retention-timer shape (src/db/retention.ts): a boot delay, an unref'd interval, and a body that
  // can never take the process down.
  const boot = setTimeout(() => { void runThreadPingSweep(deps); }, BOOT_DELAY_MS);
  (boot as { unref?: () => void }).unref?.();

  const periodic = setInterval(() => { void runThreadPingSweep(deps); }, sweepIntervalMs());
  (periodic as { unref?: () => void }).unref?.();
}

/** Test seam: drop the armed and in-flight guards (repo convention — see
 *  __resetBackfillGuardsForTests, __resetThreadInFlightForTests). */
export function __resetThreadPingGuardsForTests(): void {
  armed = false;
  running = false;
}
