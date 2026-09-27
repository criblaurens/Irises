// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory, so $IRISES_HOME is a
// throwaway temp dir and every state file below is disposable).
//
// The machine that turns an install into a first message. Two properties carry this whole file:
//
//   NO COLD TEXTS. `has_history: true` from the engine is the ONLY road to a proactive send. A
//   false, a missing channel, a pull that never landed — each one lands in nudge mode with ZERO
//   deliver calls, and several tests below exist only to assert that zero.
//
//   NEVER TWICE. Claim-before-send, a settled state that makes the sweep a no-op, a weave that
//   disarms the send and a send that disarms the weave. `deliver` is always injected — nothing here
//   can reach a voice lane, a chat, or a phone.

process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  runFirstMoveSweep, pendingIntroWeave, markIntroWoven, firstMoveEnabled, initFirstMove,
  loadFirstMoveState, introText, bridgeChatId, __resetFirstMoveGuardsForTests,
  INTRO_WEAVE_BLOCK, NO_DETAILS_TEXT, PULL_GIVE_UP_MS, BOOT_DELAY_MS, SWEEP_INTERVAL_MS,
  _internal, type FirstMoveDeps, type FirstMoveRecord,
} from './firstMove.js';
import { firstMoveAskVersion, FIRST_MOVE_ASK } from './firstMoveAsk.js';
import { sanitizeEngineProfile, type EngineProfile } from './firstMoveProfile.js';
import { saveOnboardingState, _resetOnboardingForTests } from './engineOnboarding.js';
import { hermesOnboardingVersion } from './hermesDoctrine.js';
import type { EngineBackend } from './engineBackend.js';
import type { ProactiveMessage, ProactiveOutcome } from '../../pipeline/proactiveDelivery.js';
import { resetStorageForTests } from '../../db/sqlite.js';
import { addMessage } from '../../db/repositories/conversations.js';
import { getPreference } from '../../db/repositories/memory.js';
import { groupHandle } from '../../memory/identity.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { SeedCounts } from '../../memory/seedFromEngine.js';

const T0 = Date.UTC(2026, 7, 29, 9, 0, 0);
const CHAT = 'eng:whatsapp:+15551230009';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** The engine's answer, as it actually arrives: a fenced json block wrapped in a sentence of prose. */
function reply(patch: Record<string, unknown> = {}): string {
  const body = {
    user_brief: 'She runs a small bakery on the north side and has done for six years.',
    name: 'Marta',
    fun_details: ['sails badly and often', 'names every sourdough starter'],
    primary_channel: { platform: 'whatsapp', chat_id: '+15551230009', has_history: true },
    ...patch,
  };
  return `Sure — here is what I hold about them.\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``;
}

/** An engine stub that records what it was asked, and can be made to fail. */
function fakeEngine(opts: { text?: string; fail?: boolean; noAsk?: boolean } = {}) {
  const asks: Array<{ text: string; tag: string }> = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { return ''; },
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* noop */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
    async askEngine(text: string, o: { tag: string }) {
      asks.push({ text, tag: o.tag });
      if (opts.fail) throw new Error('gateway not listening yet');
      return opts.text ?? reply();
    },
  };
  if (opts.noAsk) delete (engine as { askEngine?: unknown }).askEngine;
  return { engine, asks };
}

/** A recorded proactive lane plus a recorded seed — the two impure edges this module has. */
function rig(opts: { outcome?: ProactiveOutcome; engine?: EngineBackend; now?: number } = {}) {
  const sends: ProactiveMessage[] = [];
  const seeds: Array<{ handle: string; profile: EngineProfile; now: number }> = [];
  const deps: FirstMoveDeps = {
    deliver: async (msg: ProactiveMessage) => { sends.push(msg); return opts.outcome ?? 'sent'; },
    getEngine: () => opts.engine ?? null,
    now: () => opts.now ?? T0,
    seed: async (handle: string, profile: EngineProfile, now: number): Promise<SeedCounts> => {
      seeds.push({ handle, profile, now });
      return { dossier: true, facts: 2, themes: 1 };
    },
  };
  return { deps, sends, seeds };
}

function rec(): FirstMoveRecord {
  return loadFirstMoveState().hermes ?? {};
}

function traced(label: string): boolean {
  return getTraces().some(e => e.label === label);
}

beforeEach(() => {
  resetStorageForTests();
  __resetFirstMoveGuardsForTests();
  _resetOnboardingForTests();
  clearTraces();
  delete process.env.FIRST_MOVE_ENABLED;
  delete process.env.ENGINE_ONBOARDING;
  // The doctrine has landed — the ordinary state by the time this machine is allowed to ask.
  saveOnboardingState({ hermes: { version: hermesOnboardingVersion(), sentAt: T0 - 60_000, reply: 'OK' } });
});

afterEach(() => {
  delete process.env.FIRST_MOVE_ENABLED;
  delete process.env.ENGINE_ONBOARDING;
});

// ── the flag ─────────────────────────────────────────────────────────────────

// A single message that follows a deliberate install. Shipping it dark would be the feature not existing.
test('the flag defaults ON — unset and empty are both on, and the off switch still works', () => {
  delete process.env.FIRST_MOVE_ENABLED;
  assert.equal(firstMoveEnabled(), true, 'unset means ON');
  process.env.FIRST_MOVE_ENABLED = '';
  assert.equal(firstMoveEnabled(), true);
  for (const on of ['true', '1', 'on', 'YES']) {
    process.env.FIRST_MOVE_ENABLED = on;
    assert.equal(firstMoveEnabled(), true);
  }
  for (const off of ['false', '0', 'off', 'no', 'nope']) {
    process.env.FIRST_MOVE_ENABLED = off;
    assert.equal(firstMoveEnabled(), false);
  }
});

test('FIRST_MOVE_ENABLED=off is a hard no-op — nothing asked, nothing written, nothing sent', async () => {
  process.env.FIRST_MOVE_ENABLED = 'off';
  const { engine, asks } = fakeEngine();
  const { deps, sends } = rig({ engine });

  await runFirstMoveSweep(deps);

  assert.equal(asks.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(fs.existsSync(_internal.statePath()), false, 'a silent install leaves no state file at all');
  assert.equal(await pendingIntroWeave('web:debug'), null, 'the reactive lane is off with it');
});

// ── the gates ────────────────────────────────────────────────────────────────

test('no engine, and an adapter that cannot be asked, are both plain no-ops', async () => {
  const { deps: noEngine, sends: a } = rig({ engine: undefined });
  await runFirstMoveSweep(noEngine);
  assert.equal(a.length, 0);

  const { engine, asks } = fakeEngine({ noAsk: true });
  const { deps, sends } = rig({ engine });
  await runFirstMoveSweep(deps);

  assert.equal(asks.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(fs.existsSync(_internal.statePath()), false);
});

test('the ask waits for the doctrine to land — an engine that has not been onboarded is not asked', async () => {
  _resetOnboardingForTests();   // no doctrine record at all
  const { engine, asks } = fakeEngine();
  const { deps } = rig({ engine });

  await runFirstMoveSweep(deps);
  assert.equal(asks.length, 0, 'asking an un-onboarded engine spends the one install exchange for nothing');

  // A STALE doctrine version is just as much "not yet": editing the doctrine re-onboards.
  saveOnboardingState({ hermes: { version: 'deadbeef', sentAt: 1, reply: 'OK' } });
  await runFirstMoveSweep(deps);
  assert.equal(asks.length, 0);

  saveOnboardingState({ hermes: { version: hermesOnboardingVersion(), sentAt: 1, reply: 'OK' } });
  await runFirstMoveSweep(deps);
  assert.equal(asks.length, 1, 'the gate opens the moment the current doctrine is on record');
});

test('ENGINE_ONBOARDING=off removes the doctrine gate rather than blocking forever', async () => {
  _resetOnboardingForTests();
  process.env.ENGINE_ONBOARDING = 'OFF';
  const { engine, asks } = fakeEngine();
  const { deps } = rig({ engine });

  await runFirstMoveSweep(deps);

  assert.equal(asks.length, 1, 'that operator curates the engine by hand — there is no record to wait for');
  assert.equal(asks[0].text, FIRST_MOVE_ASK);
  assert.equal(asks[0].tag, 'first-move', 'its own engine session, out of every chat\'s continuity');
});

// ── pull ─────────────────────────────────────────────────────────────────────

test('a failed pull stores no profile and the next sweep simply tries again', async () => {
  const failing = fakeEngine({ fail: true });
  const { deps } = rig({ engine: failing.engine });

  await runFirstMoveSweep(deps);
  assert.equal(failing.asks.length, 1);
  const after = rec();
  assert.equal(after.firstAttemptAt, T0, 'the give-up clock starts on the first try');
  assert.equal(after.profile, undefined, 'nothing stored — a lost pull must retry');
  assert.equal(after.pulledAt, undefined);
  assert.equal(after.mode, undefined, 'a failed pull settles nothing');

  await runFirstMoveSweep(deps);
  assert.equal(failing.asks.length, 2, 'the interval IS the retry ladder');

  // And the moment the gateway comes up, the same parked state resumes at the pull.
  const good = fakeEngine();
  const { deps: deps2, sends } = rig({ engine: good.engine });
  await runFirstMoveSweep(deps2);
  assert.equal(rec().pulledAt, T0);
  assert.equal(rec().firstAttemptAt, T0, 'the first-attempt stamp is not rewritten');
  assert.equal(sends.length, 1);
});

test('a successful pull stores the SANITIZED profile and the ask version, never the raw reply', async () => {
  const { engine } = fakeEngine({ text: reply({ name: 'Marta', fun_details: ['sails badly'] }) });
  const { deps } = rig({ engine });

  await runFirstMoveSweep(deps);

  const r = rec();
  assert.equal(r.askVersion, firstMoveAskVersion());
  assert.equal(r.profile?.name, 'Marta');
  assert.deepEqual(r.profile?.details, ['sails badly']);
  assert.deepEqual(r.profile?.channel, { platform: 'whatsapp', chatId: '+15551230009', hasHistory: true });
  assert.ok(r.replyPreview && r.replyPreview.length <= 500, 'the raw reply is kept only as a capped operator preview');
  assert.ok(traced('first-move:pulled'));
  // The stored profile round-trips through the sanitizer on reload — a hand-edited file gets the
  // same treatment the engine's own words got.
  assert.deepEqual(_internal.coerceRecord(JSON.parse(JSON.stringify(r)))?.profile, r.profile);
});

test('24h of failed pulls gives up: an EMPTY profile, nudge mode, and the weave still armed', async () => {
  const failing = fakeEngine({ fail: true });
  await runFirstMoveSweep(rig({ engine: failing.engine, now: T0 }).deps);
  assert.equal(rec().firstAttemptAt, T0);

  const late = rig({ engine: failing.engine, now: T0 + PULL_GIVE_UP_MS });
  await runFirstMoveSweep(late.deps);

  assert.equal(failing.asks.length, 1, 'no eleventh-hour ask — the day is up');
  assert.ok(traced('first-move:gave-up'));
  const r = rec();
  assert.deepEqual(r.profile, sanitizeEngineProfile(null), 'the canonical empty profile');
  assert.equal(r.mode, 'awaiting_nudge');
  assert.equal(r.outcome, undefined, 'NO outcome — an outcome here would disarm the very fallback this is');
  assert.equal(late.sends.length, 0);

  // The sweep is done; the weave is not.
  await runFirstMoveSweep(late.deps);
  assert.equal(failing.asks.length, 1);
  assert.equal(await pendingIntroWeave('web:debug', { seed: async () => ({ dossier: false, facts: 0, themes: 0 }) }), INTRO_WEAVE_BLOCK);
});

// ── seed + the send-or-await gate ────────────────────────────────────────────

test('has_history:false — seeded, armed for the nudge, and ZERO deliver calls', async () => {
  const { engine } = fakeEngine({
    text: reply({ primary_channel: { platform: 'whatsapp', chat_id: '+15551230009', has_history: false } }),
  });
  const { deps, sends, seeds } = rig({ engine });

  await runFirstMoveSweep(deps);

  assert.equal(sends.length, 0, 'no cold texts, ever');
  assert.equal(seeds.length, 1, 'the memory is still seeded — the introduction just waits for their word');
  assert.equal(seeds[0].handle, CHAT);
  assert.equal(rec().mode, 'awaiting_nudge');
  assert.equal(rec().seededAt, T0);
  assert.equal(rec().handle, CHAT);
  assert.ok(traced('first-move:seeded'));
  // The chat id pref is written even with nothing to send, so every later proactive facility can
  // find this person from day one.
  assert.equal(await getPreference<string>(CHAT, 'chat_id'), CHAT);
});

test('an unsure engine (no channel at all) waits too, and does not seed a handle it had to guess', async () => {
  const { engine } = fakeEngine({ text: reply({ primary_channel: null }) });
  const { deps, sends, seeds } = rig({ engine });

  await runFirstMoveSweep(deps);

  assert.equal(sends.length, 0);
  assert.equal(seeds.length, 0, 'nothing to key memory on — the weave seeds against the real inbound handle');
  assert.equal(rec().mode, 'awaiting_nudge');
  assert.equal(rec().seededAt, undefined);
  assert.ok(rec().profile, 'the pull still resolved — the weave will be grounded');
});

test('has_history:true — seed, claim, deliver with the handle hint, then settle', async () => {
  const { engine } = fakeEngine();
  const { deps, sends, seeds } = rig({ engine });

  await runFirstMoveSweep(deps);

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].handle, CHAT);
  assert.equal(seeds[0].now, T0);

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], {
    chatId: CHAT,
    kind: 'introduction',
    text: '- sails badly and often\n- names every sourdough starter',
    dedupeKey: `first-move:hermes:${CHAT}`,
    // Nobody has spoken in this chat, so handle resolution comes back empty and the Composer would
    // otherwise voice the introduction blind to the dossier seeded a second earlier.
    handleHint: CHAT,
  });

  const r = rec();
  assert.equal(r.mode, 'proactive');
  assert.equal(r.sentAt, T0);
  assert.equal(r.outcome, 'sent');
  assert.ok(traced('first-move:sent'));
});

test('an empty-handed profile still sends — the payload says so in words', async () => {
  const { engine } = fakeEngine({
    text: reply({ user_brief: null, name: null, fun_details: [] }),
  });
  const { deps, sends } = rig({ engine });

  await runFirstMoveSweep(deps);

  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, NO_DETAILS_TEXT);
  assert.equal(introText(sanitizeEngineProfile(null)), NO_DETAILS_TEXT);
});

test('a settled send makes every later sweep a no-op — she never introduces herself twice', async () => {
  const good = fakeEngine();
  const { deps, sends } = rig({ engine: good.engine });

  await runFirstMoveSweep(deps);
  assert.equal(sends.length, 1);

  await runFirstMoveSweep(deps);
  await runFirstMoveSweep(deps);
  assert.equal(sends.length, 1, 'settled is settled');
  assert.equal(good.asks.length, 1, 'and nothing re-asks the engine either');
});

test("a delivery that FAILED releases the claim so the next sweep can recover it", async () => {
  const { engine } = fakeEngine();
  const failing = rig({ engine, outcome: 'failed' });

  await runFirstMoveSweep(failing.deps);
  assert.equal(failing.sends.length, 1);
  assert.equal(rec().sentAt, undefined, 'the claim is released — this is the one outcome that unclaims');
  assert.equal(rec().outcome, undefined);

  const retry = rig({ engine, outcome: 'sent' });
  await runFirstMoveSweep(retry.deps);
  assert.equal(retry.sends.length, 1, 'the retry re-sends');
  assert.equal(retry.seeds.length, 0, 'but does not re-seed — that phase is already durable');
  assert.equal(rec().outcome, 'sent');
});

test("'deferred' and 'duplicate' settle just like 'sent' — the message is out of our hands", async () => {
  for (const outcome of ['deferred', 'duplicate', 'dropped'] as ProactiveOutcome[]) {
    __resetFirstMoveGuardsForTests();
    resetStorageForTests();
    const { engine } = fakeEngine();
    const { deps, sends } = rig({ engine, outcome });

    await runFirstMoveSweep(deps);
    await runFirstMoveSweep(deps);

    assert.equal(sends.length, 1, `${outcome} must not be retried`);
    assert.equal(rec().outcome, outcome);
  }
});

test('skip-if-known: somebody has already spoken in that chat, so she has already met them', async () => {
  // A re-install over a wiped state file. The engine still reports history — because there IS
  // history, with Irises herself.
  await addMessage(CHAT, 'user', 'morning', CHAT);
  const { engine } = fakeEngine();
  const { deps, sends, seeds } = rig({ engine });

  await runFirstMoveSweep(deps);

  assert.equal(sends.length, 0, 'a stranger\'s opening line to somebody she has been talking to for months');
  assert.equal(seeds.length, 1, 'seeding still ran — its own guards decide whether it writes anything');
  assert.ok(traced('first-move:skipped-known'));
  assert.equal(rec().outcome, 'skipped-known');
  assert.equal(rec().sentAt, undefined, 'nothing was ever claimed');
});

test('a weave that already happened cancels the proactive send', async () => {
  const { engine } = fakeEngine();
  const { deps, sends } = rig({ engine });

  // Pull + seed land, but nudge mode is not what happened here: the user texted DURING the install
  // window, the weave fired, and only then does the sweep reach its send.
  markIntroWoven(T0 - 1_000);   // no record yet — idempotent no-op, proving it never invents one
  assert.equal(fs.existsSync(_internal.statePath()), false);

  await runFirstMoveSweep(deps);
  assert.equal(sends.length, 1, 'sanity: with nothing woven, this state does send');

  // Now the real shape: a record mid-flight with wovenAt set.
  __resetFirstMoveGuardsForTests();
  resetStorageForTests();
  _internal.saveState({
    hermes: {
      firstAttemptAt: T0 - 1000, pulledAt: T0 - 1000, seededAt: T0 - 1000, handle: CHAT,
      profile: sanitizeEngineProfile({
        user_brief: 'she bakes', fun_details: ['sails badly'],
        primary_channel: { platform: 'whatsapp', chat_id: '+15551230009', has_history: true },
      }),
      wovenAt: T0 - 500,
    },
  });
  const second = rig({ engine });
  await runFirstMoveSweep(second.deps);

  assert.equal(second.sends.length, 0, 'their first text already carried the introduction');
  assert.equal(rec().outcome, 'woven');
});

// ── the reactive weave ───────────────────────────────────────────────────────

/** Pull + seed done, has_history false — the ordinary armed-for-the-nudge state. */
async function armNudgeMode() {
  const { engine } = fakeEngine({
    text: reply({ primary_channel: { platform: 'whatsapp', chat_id: '+15551230009', has_history: false } }),
  });
  const r = rig({ engine });
  await runFirstMoveSweep(r.deps);
  return r;
}

test('the weave block is offered exactly once, then never again', async () => {
  await armNudgeMode();
  const seeds: string[] = [];
  const seed = async (handle: string): Promise<SeedCounts> => { seeds.push(handle); return { dossier: false, facts: 0, themes: 0 }; };

  const first = await pendingIntroWeave(CHAT, { seed, now: () => T0 });
  assert.equal(first, INTRO_WEAVE_BLOCK);
  assert.equal(await pendingIntroWeave(CHAT, { seed, now: () => T0 }), INTRO_WEAVE_BLOCK,
    'still armed until the reply actually goes out — a crash mid-turn must not lose the greeting');

  markIntroWoven(T0 + 5);
  assert.equal(await pendingIntroWeave(CHAT, { seed, now: () => T0 }), null, 'and never again');
  assert.equal(rec().wovenAt, T0 + 5);
  assert.equal(rec().outcome, 'woven');
  assert.ok(traced('first-move:woven'));

  markIntroWoven(T0 + 9);
  assert.equal(rec().wovenAt, T0 + 5, 'idempotent — a re-entered turn does not restamp');
});

test('the weave never renders for a group, and never before the pull has resolved', async () => {
  const seed = async (): Promise<SeedCounts> => ({ dossier: false, facts: 0, themes: 0 });

  assert.equal(await pendingIntroWeave(CHAT, { seed }), null, 'no state at all — nothing to weave');

  // A pull that has been attempted but has not answered: the turn is NOT blocked on it, and the
  // persona's own onboarding section handles a stranger perfectly well without this block.
  const failing = fakeEngine({ fail: true });
  await runFirstMoveSweep(rig({ engine: failing.engine }).deps);
  assert.ok(rec().firstAttemptAt, 'the attempt is on record');
  assert.equal(await pendingIntroWeave(CHAT, { seed }), null, 'no profile yet — no block');

  await armNudgeMode();
  assert.equal(await pendingIntroWeave(groupHandle('eng:whatsapp:room'), { seed }), null, 'a room is not a person');
  assert.equal(await pendingIntroWeave('', { seed }), null);
  process.env.FIRST_MOVE_ENABLED = 'off';
  assert.equal(await pendingIntroWeave(CHAT, { seed }), null);
});

test('the weave RE-KEYS the seed onto the handle that actually texted', async () => {
  await armNudgeMode();
  assert.equal(rec().handle, CHAT, 'seeded against the engine\'s prediction');

  const seeds: Array<{ handle: string; profile: EngineProfile }> = [];
  const seed = async (handle: string, profile: EngineProfile): Promise<SeedCounts> => {
    seeds.push({ handle, profile });
    return { dossier: true, facts: 1, themes: 0 };
  };

  // The inbound router keys the sender on sender_id, which need not be the predicted chat_id.
  const real = 'eng:whatsapp:15551230009@c.us';
  assert.equal(await pendingIntroWeave(real, { seed, now: () => T0 + 10 }), INTRO_WEAVE_BLOCK);

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].handle, real, 'the truth arrived — memory follows it');
  assert.equal(seeds[0].profile.name, 'Marta');
  assert.equal(rec().handle, real);
  assert.equal(rec().seededAt, T0 + 10);

  // A second turn on the same handle does not re-seed: the re-key already happened.
  await pendingIntroWeave(real, { seed, now: () => T0 + 20 });
  assert.equal(seeds.length, 1);
});

test('a no-channel install seeds at weave time, against the only handle anyone can know', async () => {
  const { engine } = fakeEngine({ text: reply({ primary_channel: null }) });
  await runFirstMoveSweep(rig({ engine }).deps);
  assert.equal(rec().seededAt, undefined);

  const seeds: string[] = [];
  const seed = async (handle: string): Promise<SeedCounts> => { seeds.push(handle); return { dossier: true, facts: 1, themes: 0 }; };

  assert.equal(await pendingIntroWeave('web:debug', { seed, now: () => T0 + 1 }), INTRO_WEAVE_BLOCK);
  assert.deepEqual(seeds, ['web:debug']);
  assert.equal(rec().handle, 'web:debug');
});

test('a seed that throws still gets the introduction out — grounding is worth less than the greeting', async () => {
  await armNudgeMode();
  const seed = async (): Promise<SeedCounts> => { throw new Error('store on fire'); };
  assert.equal(await pendingIntroWeave('web:debug', { seed }), INTRO_WEAVE_BLOCK);
});

test('a proactive send that already went disarms the weave', async () => {
  const { engine } = fakeEngine();
  await runFirstMoveSweep(rig({ engine }).deps);
  assert.equal(rec().outcome, 'sent');

  const seed = async (): Promise<SeedCounts> => ({ dossier: false, facts: 0, themes: 0 });
  assert.equal(await pendingIntroWeave(CHAT, { seed }), null, 'she has already said hello, out loud');
});

// ── durability ───────────────────────────────────────────────────────────────

test('the settled state survives a restart — a fresh cache reads the file and stands down', async () => {
  const { engine } = fakeEngine();
  await runFirstMoveSweep(rig({ engine }).deps);
  const onDisk = fs.readFileSync(_internal.statePath(), 'utf8');
  assert.match(onDisk, /"outcome": "sent"/);

  // A new process: guards dropped, cache dropped, the same file on disk.
  __resetFirstMoveGuardsForTests();
  fs.writeFileSync(_internal.statePath(), onDisk);

  assert.equal(loadFirstMoveState().hermes?.outcome, 'sent');
  const after = rig({ engine });
  await runFirstMoveSweep(after.deps);
  assert.equal(after.sends.length, 0, 'a restart must not re-introduce anybody');

  const seed = async (): Promise<SeedCounts> => ({ dossier: false, facts: 0, themes: 0 });
  assert.equal(await pendingIntroWeave(CHAT, { seed }), null);
});

test('a corrupt state file reads as never-run, never throws', async () => {
  fs.writeFileSync(_internal.statePath(), '{ not valid json');
  __resetFirstMoveGuardsForTests();
  fs.writeFileSync(_internal.statePath(), '{ not valid json');

  assert.deepEqual(loadFirstMoveState(), {});
  const { engine } = fakeEngine();
  const { deps, sends } = rig({ engine });
  await runFirstMoveSweep(deps);
  assert.equal(sends.length, 1, 'a lost file costs one duplicate introduction, never a wedged machine');
});

test('one engine\'s record never clobbers the other\'s', async () => {
  _internal.saveState({ openclaw: { mode: 'awaiting_nudge', outcome: 'sent' } });
  const { engine } = fakeEngine();
  await runFirstMoveSweep(rig({ engine }).deps);

  const state = loadFirstMoveState();
  assert.equal(state.hermes?.outcome, 'sent');
  assert.equal(state.openclaw?.outcome, 'sent', 'switching engines must not erase the other lane');
});

// ── wiring ───────────────────────────────────────────────────────────────────

test('initFirstMove arms a 90s boot pass plus a 5-minute interval, both unref\'d, exactly once', () => {
  const armedTimers: Array<{ ms: number; kind: string; unrefs: number }> = [];
  const make = (kind: string) => (_fn: () => void, ms: number) => {
    const t = { ms, kind, unrefs: 0 };
    armedTimers.push(t);
    return { unref: () => { t.unrefs += 1; } };
  };
  const deps: FirstMoveDeps = {
    deliver: async () => 'sent',
    getEngine: () => null,
    setTimer: make('timeout'),
    setInterval: make('interval'),
  };

  initFirstMove(deps);
  initFirstMove(deps);

  assert.deepEqual(armedTimers.map(t => [t.kind, t.ms]), [['timeout', BOOT_DELAY_MS], ['interval', SWEEP_INTERVAL_MS]]);
  assert.ok(armedTimers.every(t => t.unrefs === 1), 'the first move never holds the process open');
});

test('bridgeChatId is the routable chat id AND the memory handle — one string, two roles', () => {
  assert.equal(bridgeChatId({ platform: 'whatsapp', chatId: '+15551230009', hasHistory: true }), CHAT);
  assert.equal(bridgeChatId({ platform: 'imessage', chatId: 'a@b.com', hasHistory: false }), 'eng:imessage:a@b.com');
});
