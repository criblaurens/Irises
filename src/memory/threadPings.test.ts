// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The one place threading STARTS a message. Everything here is about restraint: the flag that must
// be opted into, the week that is spent before the send is attempted, the two days of silence a
// thread has to have before this path gets to speak at all, and the loops that must never be asked
// about a second time. `deliver` is always injected — no test in this file can reach a voice lane,
// a chat, or a phone.
process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runThreadPingSweep, pickPingLoop, threadingPingsEnabled, __resetThreadPingGuardsForTests,
  PING_MIN_AGE_MS, PING_MAX_AGE_MS, PING_BUDGET_MS, PING_QUIET_MS,
  type ThreadPingMessage,
} from './threadPings.js';
import { groupHandle } from './identity.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { getThreadInventory, saveThreadInventory } from '../db/repositories/threadInventory.js';
import { bumpForgetEpoch, setPreference } from '../db/repositories/memory.js';
import { defaultThreadInventory, type OpenLoop, type ThreadInventory } from '../persona/threads.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import type { TraceEvent } from '../diagnostics/trace.js';

const T0 = Date.UTC(2026, 3, 1);
const DAY = 24 * 60 * 60 * 1000;
const H = '+15551230009';
const CHAT = 'web:pings';

/** A loop that has been quiet a week with nobody having asked how it went — the whole fixture the
 *  ping exists for. Every negative case below is this one with a single field moved. */
function loop(patch: Partial<OpenLoop> = {}): OpenLoop {
  return {
    id: 'l1',
    label: 'the interview',
    note: 'the thing on thursday she was dreading',
    status: 'open',
    capturedAt: T0 - 7 * DAY,
    lastSeenAt: T0 - 7 * DAY,
    offeredAt: 0,
    askedAt: 0,
    resolvedAt: 0,
    passes: 0,
    ...patch,
  };
}

/** A row plus, optionally, the chat_id pref that tells the sweep where to send. Defaults leave
 *  `lastPingAt` and `lastHarvestAt` at 0, which reads as "never" — both gates wide open. */
async function seed(handle: string, patch: Partial<ThreadInventory>, chatId?: string): Promise<void> {
  await saveThreadInventory(handle, { ...defaultThreadInventory(), ...patch });
  if (chatId) await setPreference(handle, 'chat_id', chatId);
}

function spy(): { calls: ThreadPingMessage[]; deliver: (m: ThreadPingMessage) => Promise<string> } {
  const calls: ThreadPingMessage[] = [];
  return { calls, deliver: async (m: ThreadPingMessage) => { calls.push(m); return 'sent'; } };
}

function trace(label: string): TraceEvent | undefined {
  return getTraces().find(e => e.label === label);
}
function detail(ev: TraceEvent | undefined): Record<string, unknown> {
  return (ev?.detail ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  resetStorageForTests();
  __resetThreadPingGuardsForTests();
  clearTraces();
  process.env.THREADING_PINGS_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.THREADING_PINGS_ENABLED;
  delete process.env.CONVO_THREADING_ENABLED;
});

// ── The flags ────────────────────────────────────────────────────────────────

// Default on, and the off switch costs nothing: no read, no write, no send.
test('pings are ON unless the install turned them off — off costs no read, no write, no send', async () => {
  delete process.env.THREADING_PINGS_ENABLED;
  assert.equal(threadingPingsEnabled(), true, 'unset means ON, like every sibling flag');
  process.env.THREADING_PINGS_ENABLED = '';
  assert.equal(threadingPingsEnabled(), true, 'empty is unset');
  process.env.THREADING_PINGS_ENABLED = 'off';
  assert.equal(threadingPingsEnabled(), false);

  await seed(H, { loops: [loop()] }, CHAT);
  const s = spy();
  await runThreadPingSweep(s, { now: T0 });

  assert.equal(s.calls.length, 0, 'nobody was texted');
  assert.equal(trace('threads:ping'), undefined, 'the off sweep is not even a no-op receipt');
  const inv = await getThreadInventory(H);
  assert.equal(inv.lastPingAt, 0, 'and nothing was billed — the flags are read before the store is');
  assert.equal(inv.pending, null);

  // Negative control: the very same fixture DOES ping once the flag is back on, so the assertions
  // above are about the flag and not about a fixture that could never have fired.
  process.env.THREADING_PINGS_ENABLED = 'true';
  await runThreadPingSweep(s, { now: T0 });
  assert.equal(s.calls.length, 1);
});

// The threading kill switch is upstream of the ping switch: turning the FEATURE off turns its
// unprompted surface off with it, whatever the ping flag says.
test('the threading kill switch stops pings even with the ping flag on', async () => {
  process.env.CONVO_THREADING_ENABLED = 'false';
  await seed(H, { loops: [loop()] }, CHAT);
  const s = spy();
  await runThreadPingSweep(s, { now: T0 });

  assert.equal(s.calls.length, 0);
  assert.equal(trace('threads:ping'), undefined);
  assert.equal((await getThreadInventory(H)).lastPingAt, 0);
});

// ── The happy path ───────────────────────────────────────────────────────────

test('an aged, unasked loop is billed and then handed to the proactive pipeline', async () => {
  await seed(H, { loops: [loop()] }, CHAT);
  const s = spy();
  await runThreadPingSweep(s, { now: T0 });

  assert.equal(s.calls.length, 1);
  const msg = s.calls[0];
  assert.equal(msg.chatId, CHAT);
  assert.equal(msg.kind, 'callback', 'the one proactive kind that ends on a question');
  assert.match(msg.text, /the interview/, "the thread rides in their own words");
  assert.match(msg.text, /she was dreading/, 'label and note both, so the beat has something to place');
  // The exact ISO week of T0 (2026-04-01), not `W\d\d`: the week arithmetic is shared with the
  // engine session's rotation window (`src/pipeline/isoWeek.ts`, covered there), so this key is
  // what says the ping side of it still spells the week it always did.
  assert.equal(msg.dedupeKey, 'threads:ping:+15551230009:l1:2026-W14');

  // Billed: the week is spent, the loop is under the reply path's own offer cooldown, and the
  // pending slot is armed straight to `awaiting` — the ping IS the utterance.
  const inv = await getThreadInventory(H);
  assert.equal(inv.lastPingAt, T0);
  assert.equal(inv.loops[0].offeredAt, T0);
  assert.deepEqual(inv.pending, { themeId: 'l1', at: T0, phase: 'awaiting', material: 'loop' });

  const d = detail(trace('threads:ping'));
  assert.equal(d.considered, 1);
  assert.equal(d.sent, 1);
  assert.equal(d.no_candidate, 0);
  assert.deepEqual(d.sends, [{ handle: H, loopId: 'l1', label: 'the interview', outcome: 'sent' }]);
});

test('the receipt buckets are disjoint — every considered handle has exactly one reason', async () => {
  await seed('+15550000001', { loops: [loop()] }, 'web:1');                       // sent
  await seed('+15550000002', { loops: [loop({ status: 'asked', askedAt: T0 - DAY })] }, 'web:2'); // no_candidate
  await seed('+15550000003', { loops: [loop()] });                                // no_chat
  await seed('+15550000004', { loops: [loop()], lastPingAt: T0 - DAY }, 'web:4'); // skipped_budget
  await seed('+15550000005', { loops: [loop()], lastHarvestAt: T0 - 60_000 }, 'web:5'); // skipped_quiet
  await seed(groupHandle('room-1'), { loops: [loop()] }, 'web:6');                // skipped_group

  const s = spy();
  await runThreadPingSweep(s, { now: T0 });

  const d = detail(trace('threads:ping')) as unknown as Record<string, number>;
  assert.equal(d.considered, 6);
  const accounted = d.sent + d.failed + d.skipped_group + d.skipped_budget
    + d.skipped_quiet + d.no_candidate + d.no_chat + d.save_refused;
  assert.equal(accounted, d.considered, 'nothing vanished without a reason');
  assert.equal(d.sent, 1);
  assert.equal(d.no_candidate, 1);
  assert.equal(d.no_chat, 1);
  assert.equal(d.skipped_budget, 1);
  assert.equal(d.skipped_quiet, 1);
  assert.equal(d.skipped_group, 1, 'a room never had a loop of its own to ask about');
  assert.equal(s.calls.length, 1);
});

// ── The budgets ──────────────────────────────────────────────────────────────

test('one unprompted question a week, persisted on the row', async () => {
  await seed(H, { loops: [loop()] }, CHAT);
  const s = spy();

  await runThreadPingSweep(s, { now: T0 });
  assert.equal(s.calls.length, 1);

  // Six days later the loop is still eligible on its own terms — the WEEK is what stops it.
  await runThreadPingSweep(s, { now: T0 + 6 * DAY });
  assert.equal(s.calls.length, 1, 'the second sweep sent nothing');
  const receipts = getTraces().filter(e => e.label === 'threads:ping');
  assert.equal(detail(receipts[0]).sent, 1);
  assert.equal(detail(receipts[1]).skipped_budget, 1, 'and said why');

  // …and a week is a week, not forever.
  await runThreadPingSweep(s, { now: T0 + PING_BUDGET_MS });
  assert.equal(s.calls.length, 2);
  assert.equal((await getThreadInventory(H)).lastPingAt, T0 + PING_BUDGET_MS);
});

// An active texter's loops surface in live turns, where the reply path can read the room, the mood
// and the opening gap first. This path only speaks into silence.
test('a thread that is still being talked to is left to the reply path', async () => {
  await seed(H, { loops: [loop()], lastHarvestAt: T0 - (PING_QUIET_MS - 60_000) }, CHAT);
  const s = spy();
  await runThreadPingSweep(s, { now: T0 });

  assert.equal(s.calls.length, 0);
  assert.equal(detail(trace('threads:ping')).skipped_quiet, 1);
  assert.equal((await getThreadInventory(H)).lastPingAt, 0, 'a skipped handle is never billed');

  // Two days of silence and the same row is fair game.
  await runThreadPingSweep(s, { now: T0 + PING_QUIET_MS });
  assert.equal(s.calls.length, 1);
});

test('a handle with nowhere to send is skipped without being billed', async () => {
  await seed(H, { loops: [loop()] });   // no chat_id pref
  const s = spy();
  await runThreadPingSweep(s, { now: T0 });

  assert.equal(s.calls.length, 0);
  assert.equal(detail(trace('threads:ping')).no_chat, 1);
  assert.equal((await getThreadInventory(H)).lastPingAt, 0);
});

// ── pickPingLoop: the eligibility matrix ─────────────────────────────────────

test('only an open, never-asked, never-waved-off loop of the right age is ever picked', () => {
  const inv = (l: OpenLoop): ThreadInventory => ({ ...defaultThreadInventory(), loops: [l] });

  assert.equal(pickPingLoop(inv(loop()), T0)?.id, 'l1', 'the base fixture IS eligible');

  // Already asked — the failure this whole feature exists to avoid.
  assert.equal(pickPingLoop(inv(loop({ status: 'asked', askedAt: T0 - 2 * DAY })), T0), null);
  // A loop revived from `asked` back to `open` still carries its askedAt: it had its question.
  assert.equal(pickPingLoop(inv(loop({ askedAt: T0 - 9 * DAY })), T0), null);
  // Waved off even once, and an unprompted repeat is pushing.
  assert.equal(pickPingLoop(inv(loop({ passes: 1 })), T0), null);
  // Terminal either way.
  assert.equal(pickPingLoop(inv(loop({ status: 'resolved', resolvedAt: T0 - DAY })), T0), null);
  assert.equal(pickPingLoop(inv(loop({ status: 'expired', resolvedAt: T0 - DAY })), T0), null);

  // Too fresh: the thing has usually not happened yet, and the question is hovering, not a revisit.
  assert.equal(pickPingLoop(inv(loop({ lastSeenAt: T0 - (PING_MIN_AGE_MS - 60_000) })), T0), null);
  assert.equal(pickPingLoop(inv(loop({ lastSeenAt: T0 - PING_MIN_AGE_MS })), T0)?.id, 'l1', 'the floor is inclusive');
  // Too old: warm has gone stale, and the harvest would have expired it if they had come back.
  assert.equal(pickPingLoop(inv(loop({ lastSeenAt: T0 - (PING_MAX_AGE_MS + 60_000) })), T0), null);
  assert.equal(pickPingLoop(inv(loop({ lastSeenAt: T0 - PING_MAX_AGE_MS })), T0)?.id, 'l1', 'the ceiling is inclusive');

  assert.equal(pickPingLoop(defaultThreadInventory(), T0), null, 'an empty inventory asks nothing');
});

test('the loop they have gone longest without mentioning wins', () => {
  const inventory: ThreadInventory = {
    ...defaultThreadInventory(),
    loops: [
      loop({ id: 'recent', lastSeenAt: T0 - 4 * DAY }),
      loop({ id: 'oldest', lastSeenAt: T0 - 12 * DAY }),
      loop({ id: 'middle', lastSeenAt: T0 - 8 * DAY }),
    ],
  };
  assert.equal(pickPingLoop(inventory, T0)?.id, 'oldest');
});

test('pickPingLoop never touches what it was given', () => {
  const inventory = Object.freeze({
    ...defaultThreadInventory(), loops: [Object.freeze(loop())],
  }) as ThreadInventory;
  assert.equal(pickPingLoop(inventory, T0)?.id, 'l1');
});

// ── Billing before delivery ──────────────────────────────────────────────────

// The trade, stated as a test: a failed send still costs the week. The reverse — a failure that
// leaves the budget unspent — is an hourly sweep finding the same loop still eligible and a person
// getting the same question twice.
test('a delivery that throws still spends the week, and says so on the receipt', async () => {
  await seed(H, { loops: [loop()] }, CHAT);
  let attempts = 0;
  const deliver = async (): Promise<string> => { attempts++; throw new Error('voice lane down'); };

  await runThreadPingSweep({ deliver }, { now: T0 });
  assert.equal(attempts, 1);

  const inv = await getThreadInventory(H);
  assert.equal(inv.lastPingAt, T0, 'billed before the send was attempted');
  assert.equal(inv.pending?.themeId, 'l1');

  const d = detail(trace('threads:ping'));
  assert.equal(d.sent, 0);
  assert.equal(d.failed, 1);
  assert.deepEqual(d.sends, [], 'nothing claims to have been sent');

  // And the very next sweep sees the spent week rather than retrying into a second text.
  await runThreadPingSweep({ deliver }, { now: T0 + DAY });
  assert.equal(attempts, 1, 'no retry');
});

// One bad row, one dead lane, one missing chat must not silence the ping the next person had coming.
test('one handle failing does not end the sweep', async () => {
  await seed('+15550000001', { loops: [loop()] }, 'web:1');
  await seed('+15550000002', { loops: [loop({ id: 'l2' })] }, 'web:2');

  const sent: string[] = [];
  const deliver = async (m: ThreadPingMessage): Promise<string> => {
    if (m.chatId === 'web:1') throw new Error('lane down for this one');
    sent.push(m.chatId);
    return 'sent';
  };
  await runThreadPingSweep({ deliver }, { now: T0 });

  assert.deepEqual(sent, ['web:2']);
  const d = detail(trace('threads:ping'));
  assert.equal(d.sent, 1);
  assert.equal(d.failed, 1);
});

// ── The /forget fence ────────────────────────────────────────────────────────

// Each delivery below is an LLM call, so a sweep runs for as long as it takes to write everybody's
// message. A wipe landing anywhere inside that window refuses every billing write after it.
test('a /forget landing mid-sweep refuses the write and the question is never asked', async () => {
  const A = '+15550000001';
  const B = '+15550000002';
  await seed(A, { loops: [loop()] }, 'web:a');
  await seed(B, { loops: [loop({ id: 'l2' })] }, 'web:b');

  const calls: ThreadPingMessage[] = [];
  const deliver = async (m: ThreadPingMessage): Promise<string> => {
    calls.push(m);
    // The wipe lands while the first person's message is being voiced.
    bumpForgetEpoch(m.chatId === 'web:a' ? B : A);
    return 'sent';
  };
  await runThreadPingSweep({ deliver }, { now: T0 });

  assert.equal(calls.length, 1, 'the forgotten handle was never texted');
  const d = detail(trace('threads:ping'));
  assert.equal(d.sent, 1);
  assert.equal(d.save_refused, 1);

  const forgotten = calls[0].chatId === 'web:a' ? B : A;
  const inv = await getThreadInventory(forgotten);
  assert.equal(inv.lastPingAt, 0, 'nothing was billed onto the row the user asked to be wiped');
  assert.equal(inv.pending, null);
});

// ── The timer guards ─────────────────────────────────────────────────────────

test('two sweeps cannot overlap', async () => {
  await seed(H, { loops: [loop()] }, CHAT);
  let inFlight = 0;
  let overlapped = false;
  const deliver = async (): Promise<string> => {
    inFlight++;
    if (inFlight > 1) overlapped = true;
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return 'sent';
  };

  const first = runThreadPingSweep({ deliver }, { now: T0 });
  const second = runThreadPingSweep({ deliver }, { now: T0 });
  await Promise.all([first, second]);

  assert.equal(overlapped, false);
  assert.equal(getTraces().filter(e => e.label === 'threads:ping').length, 1, 'the second run saw the guard');
});
