// The first move: the one-shot machine that turns a finished install into a first message.
//
// Irises has never spoken first. After `engine-setup.sh` completes she sits silent until the user
// texts her, which means her opening line lands with no idea who she is talking to — even though the
// engine she now fronts has lived with that person for months. This module closes that gap ONCE, in
// four durable phases:
//
//   pull  — ask the engine what it knows (firstMoveAsk.ts's words, firstMoveProfile.ts's doubt)
//   seed  — fold the answer into her own memory tiers (seedFromEngine.ts)
//   send  — text them first, but ONLY where the engine confirms real prior history on that chat
//   weave — otherwise: she introduces herself INSIDE her reply to their own first text
//
//   $IRISES_HOME/first-move.json
//   { hermes?: { askVersion, pulledAt, profile, seededAt, handle, mode, sentAt, outcome, … } }
//
// Keyed by ENGINE NAME, exactly like engine-onboarding.json next door, and read with the same
// lenient-load / best-effort-save discipline: a missing or mangled file reads as "never ran" (one
// duplicate introduction is the worst it can cost), and a failed write never takes a boot down.
//
// WHY THIS DEFAULTS ON. This is exactly ONE message, minutes after an operator deliberately ran an
// installer, addressed to the one person that installer was run for. The install IS the consent, and a feature shipped dark here is the feature
// not existing. The off switch stays for the silent install (a deployment handed over before the
// person on the far end knows anything is coming).
//
// AND WHY IT STILL CANNOT COLD-TEXT. The proactive send fires only when the engine says, in so many
// words, that it has already exchanged messages in that exact chat (`has_history`, coerced to a
// strict boolean that defaults false). Every other reading — no channel, an unsure engine, a pull
// that never landed — arms the reactive weave instead, where the first word is still theirs. Nothing
// in this file can put a message in front of somebody who has never written to us.

import fs from 'node:fs';
import { join } from 'node:path';
import { atomicWriteText, readTextIfExists } from '../../db/files.js';
import { irisesHome } from '../../db/stateDir.js';
import { record } from '../../diagnostics/trace.js';
import { reportError } from '../../diagnostics/errorLog.js';
import { distinctUserHandles } from '../../db/repositories/conversations.js';
import { ensureChatId } from '../../db/repositories/memory.js';
import { isGroupHandle } from '../../memory/identity.js';
import { seedFromEngineProfile } from '../../memory/seedFromEngine.js';
import { getEngineBackend, withEngineSlot } from './engineBackend.js';
import type { EngineBackend } from './engineBackend.js';
import { loadOnboardingState, type EngineName } from './engineOnboarding.js';
import { onboardingVersion } from './openclawDoctrine.js';
import { hermesOnboardingVersion } from './hermesDoctrine.js';
import { FIRST_MOVE_ASK, firstMoveAskVersion } from './firstMoveAsk.js';
import { extractFencedJson, sanitizeEngineProfile, type EngineProfile } from './firstMoveProfile.js';
import type { ProactiveMessage, ProactiveOutcome } from '../../pipeline/proactiveDelivery.js';

// ── the durable record ────────────────────────────────────────────────────────

/** Which lane the introduction is travelling on, once the pull has answered.
 *  `proactive` — history confirmed, she texts first. `awaiting_nudge` — she waits, and her reply to
 *  their first text carries the introduction. `awaiting_nudge` also SETTLES the sweep: there is
 *  nothing left for a timer to do, and everything left belongs to the next inbound turn. */
export type FirstMoveMode = 'proactive' | 'awaiting_nudge';

export interface FirstMoveRecord {
  /** Content hash of the ask that produced `profile` — an operator can see which words were used. */
  askVersion?: string;
  /** When the FIRST pull was attempted. The 24h give-up clock runs from here, not from boot: a
   *  gateway that stays down across ten restarts must still eventually stop being waited for. */
  firstAttemptAt?: number;
  pulledAt?: number;
  /** The engine's raw answer, capped. Diagnostic only — nothing downstream reads it, and it never
   *  reaches a prompt or a memory tier. What IS trusted is `profile`, which went through the door. */
  replyPreview?: string;
  /** The SANITIZED profile. Its presence is what "the pull phase has resolved" means: an empty
   *  profile stored here (the 24h give-up) resolves the phase just as a full one does. */
  profile?: EngineProfile;
  seededAt?: number;
  /** The handle the seed actually landed on. Re-keyed by the weave the moment a real inbound message
   *  tells us who they are for certain (see pendingIntroWeave). */
  handle?: string;
  mode?: FirstMoveMode;
  /** The send CLAIM, written BEFORE deliver() and cleared only on an outright failure (the
   *  updateAnnouncer pattern). Its presence settles the sweep, so a crash between the claim and the
   *  outcome costs a missed introduction rather than a second one. */
  sentAt?: number;
  /** How this ended, forever: a ProactiveOutcome ('sent' | 'dropped' | 'deferred' | 'duplicate'),
   *  or 'woven' (their first text beat us to it) or 'skipped-known' (she had already met them).
   *  DELIBERATELY NOT WRITTEN on the 24h give-up: that settles the sweep via `mode`, and an outcome
   *  here would also disarm the weave — which is the exact thing a failed pull must fall back to. */
  outcome?: string;
  wovenAt?: number;
}

export type FirstMoveState = Partial<Record<EngineName, FirstMoveRecord>>;

const ENGINE_NAMES: readonly EngineName[] = ['openclaw', 'hermes'];

/** The doctrine version each engine's onboarding record must be carrying before the ask goes out.
 *  Same table shape as engineOnboarding's DOCTRINES, and for the same reason: an engine that is not
 *  in it cannot half-land. */
const DOCTRINE_VERSIONS: Record<EngineName, () => string> = {
  openclaw: onboardingVersion,
  hermes: hermesOnboardingVersion,
};

/** The engine session this exchange belongs to — code-owned, never a user string, and distinct from
 *  the doctrine's so the ask stays out of every chat's continuity. */
export const FIRST_MOVE_TAG = 'first-move';

/** Enough of the engine's answer for an operator to see what it actually said. */
export const REPLY_PREVIEW_MAX = 500;

/** Long enough that a gateway wedged over a working day still gets its chance; short enough that a
 *  person who installed on Monday is not still un-greeted on Wednesday. After this she settles into
 *  nudge mode and introduces herself — ungrounded — the moment they write. */
export const PULL_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** Later than every other boot timer in the process (retention 30s, proactive 15s, thread pings 60s).
 *  `engine-setup.sh` restarts the gateway LAST, so the first ask is deliberately the last thing a
 *  fresh boot does — and the 5-minute interval, not this delay, is what actually catches the race. */
export const BOOT_DELAY_MS = 90_000;

/** How often the machine re-tries whichever phase it is parked on. Five minutes: the whole sequence
 *  wants to finish within the first coffee after an install, and each tick is one env read plus one
 *  in-memory state read whenever there is nothing to do. */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

/** What the payload says when the engine knew nothing to ground the introduction in. Not empty
 *  string: the Composer's introduction framing branches on having details or not, and an empty
 *  payload with no words at all reads as a delivery bug rather than a deliberate blank hand. */
export const NO_DETAILS_TEXT = '(no details — newly acquainted)';

/**
 * The one-shot block the reactive lane injects into a single Convo turn. Byte-pinned: the persona's
 * own Onboarding section carries the craft (how she greets, how she paces, what she never asks), and
 * this only adds the two things that section cannot know — that this specific reply IS the
 * introduction, and that she is holding a picture of them she was handed rather than told.
 *
 * The three prohibitions are not style notes. Never their NAME, because being greeted by name by
 * something you have never spoken to is the exact moment a warm install turns cold. Never anything
 * SENSITIVE, because the payload is second-hand and she cannot know what they would want known.
 * Never a word about being TOLD, BRIEFED, SET UP or INSTALLED, because the honest framing of what
 * happened here — she moved in and noticed things — is also the only one that does not read as a
 * file having been opened about them.
 */
export const INTRO_WEAVE_BLOCK = `## First move was theirs (this turn only)\nTheir very first text just landed and you two have never spoken a word. This reply IS your introduction: fold in who you are — i'm Irises, but you can call me Iris or Ilish or Lish — while answering what they actually sent. Match their register, never their content: if their opener is a task, the task comes first and the intro is one small beat. What you hold about them may colour this reply with at most ONE flat, deniable judgment, and only where it touches what they said — never a second one, never anything sensitive, never their name, and never a word about being told, briefed, set up, or installed; you just moved in, you noticed things. The onboarding page carries the rest of the craft. This note shows once and never again.`;

// ── flags ─────────────────────────────────────────────────────────────────────

/**
 * The feature gate (env: FIRST_MOVE_ENABLED). DEFAULT ON — `''`/unset is on, the house shape shared
 * with threadingEnabled and relationshipClimateEnabled.
 * The justification is in the module header; the short version is that this is one message following
 * one deliberate install, not a standing licence to text. Read at CALL time like its siblings, so an
 * operator turning it off needs no restart — and so a sweep already armed simply stops finding work.
 */
export function firstMoveEnabled(): boolean {
  const v = (process.env.FIRST_MOVE_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

// ── state, cached ─────────────────────────────────────────────────────────────

/** Loaded once and then held. pendingIntroWeave runs on the per-turn prompt build — the hottest path
 *  in the process — so the reactive lane must never touch the filesystem to answer "is the weave
 *  armed?". Every mutation goes through saveState, which updates this in the same breath, so the
 *  cache and the file can only disagree when the WRITE failed (best-effort by design). */
let cache: FirstMoveState | null = null;

/** Armed once, at boot. */
let armed = false;

/** True while a sweep is in flight. The interval does not know how long an engine ask takes: a slow
 *  pull can outlive five minutes, and two passes could double-claim the same send. */
let running = false;

function statePath(): string {
  return join(irisesHome(), 'first-move.json');
}

/** One stored record, field by field, with anything unreadable simply absent. A hand-edited file, a
 *  truncated write, a record from a future schema — each degrades to "this phase has not happened",
 *  which is always the safe reading here (the worst case is one repeated introduction).
 *
 *  `profile` is re-run through the sanitizer rather than trusted: it round-trips exactly (the
 *  sanitizer accepts its own camelCase output as aliases), so this costs nothing and means a profile
 *  hand-edited into the file gets the same treatment the engine's own words got. */
function coerceRecord(raw: unknown): FirstMoveRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  return {
    askVersion: str(o.askVersion),
    firstAttemptAt: num(o.firstAttemptAt),
    pulledAt: num(o.pulledAt),
    replyPreview: str(o.replyPreview),
    profile: o.profile === undefined || o.profile === null ? undefined : sanitizeEngineProfile(o.profile),
    seededAt: num(o.seededAt),
    handle: str(o.handle),
    mode: o.mode === 'proactive' || o.mode === 'awaiting_nudge' ? o.mode : undefined,
    sentAt: num(o.sentAt),
    outcome: str(o.outcome),
    wovenAt: num(o.wovenAt),
  };
}

/** Lenient load — a missing or corrupt file yields an empty state, never a throw. Each engine's
 *  record is read independently, so one malformed entry cannot erase the other's. */
export function loadFirstMoveState(): FirstMoveState {
  if (cache) return cache;
  let out: FirstMoveState = {};
  try {
    const raw = readTextIfExists(statePath());
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const name of ENGINE_NAMES) {
        const rec = coerceRecord(parsed?.[name]);
        if (rec) out[name] = rec;
      }
    }
  } catch {
    out = {};
  }
  cache = out;
  return out;
}

/** Best-effort persist — never throws. The CACHE is updated first and unconditionally: a write that
 *  fails must not leave this process about to re-send an introduction it has already delivered. A
 *  lost write costs at most one duplicate after a restart, which is the same loss class the doctrine
 *  module accepts next door. */
function saveState(next: FirstMoveState): void {
  cache = next;
  try {
    atomicWriteText(statePath(), JSON.stringify(next, null, 2) + '\n');
  } catch (err) {
    console.warn('[first-move] could not persist first-move.json:', (err as Error)?.message ?? err);
  }
}

/** The ONE mutation door. An explicitly-`undefined` value in `patch` CLEARS the field (that is how
 *  the send claim is released on a failed delivery) rather than storing a hole. Merged rather than
 *  replaced, so an operator who switched engines keeps the other engine's record. */
function patchRecord(name: EngineName, patch: Partial<FirstMoveRecord>): FirstMoveRecord {
  const state = loadFirstMoveState();
  const merged: FirstMoveRecord = { ...(state[name] ?? {}), ...patch };
  for (const key of Object.keys(patch) as (keyof FirstMoveRecord)[]) {
    if (patch[key] === undefined) delete merged[key];
  }
  saveState({ ...state, [name]: merged });
  return merged;
}

/**
 * The record this install's introduction lives in, and which key it is stored under.
 *
 * The active engine's record wins when there is one. The fallback — the first record present — is
 * what makes the REACTIVE lane work at all: the weave runs on a Convo turn that may have no engine
 * configured (a web-only chat, an OPS_BACKEND typo, a test), and the introduction is a property of
 * the INSTALL rather than of whichever backend answers today.
 */
function currentRecord(state: FirstMoveState, engineName?: EngineName | null): { name: EngineName; rec: FirstMoveRecord } | null {
  if (engineName && state[engineName]) return { name: engineName, rec: state[engineName]! };
  for (const name of ENGINE_NAMES) {
    if (state[name]) return { name, rec: state[name]! };
  }
  return null;
}

/** Nothing left for a TIMER to do. Deliberately wider than "the weave is disarmed": `awaiting_nudge`
 *  settles the sweep while leaving the weave armed, because from the sweep's point of view the rest
 *  of this feature now belongs to the next inbound message. */
function isSweepSettled(rec: FirstMoveRecord): boolean {
  return !!rec.outcome || !!rec.sentAt || !!rec.wovenAt || rec.mode === 'awaiting_nudge';
}

/** Nothing left for a TURN to do — the mirror of the above, and strictly narrower. Note that
 *  `mode: 'proactive'` is NOT disarming: if the user beats the sweep to the first word, the weave
 *  wins and the sweep's own wovenAt re-check cancels the send. */
function isWeaveArmed(rec: FirstMoveRecord): boolean {
  return !rec.sentAt && !rec.wovenAt && !rec.outcome;
}

// ── the payload ───────────────────────────────────────────────────────────────

/** What the Composer is handed to voice. Details ONLY — never the brief, never the name: the
 *  introduction framing picks two of these and makes one light association, and everything richer
 *  it might want is already in the dossier the seed just wrote for this handle. */
export function introText(profile: EngineProfile): string {
  const lines = profile.details.map(d => `- ${d}`);
  return lines.length ? lines.join('\n') : NO_DETAILS_TEXT;
}

/** The routable chat id for an engine channel — which is ALSO the memory handle for that person
 *  (`eng:<platform>:<chat>`, see channels/registry.ts). One string, two roles: the bridge routes on
 *  it and every memory tier keys on it, which is exactly why the seed can run before anybody has
 *  said a word. */
export function bridgeChatId(channel: NonNullable<EngineProfile['channel']>): string {
  return `eng:${channel.platform}:${channel.chatId}`;
}

// ── deps (the repo's DI convention — no module mocks) ─────────────────────────

export interface FirstMoveDeps {
  /** `proactive.deliver` from src/index.ts. Owns quiet hours, the dedupe row, the mouth, the
   *  Composer voicing and the Fallfirm degrade under it — an introduction is not reminder-exempt, so
   *  a 3am install is parked as a durable row and lands in the morning. */
  deliver: (msg: ProactiveMessage) => Promise<ProactiveOutcome>;
  getEngine?: () => EngineBackend | null;
  now?: () => number;
  seed?: typeof seedFromEngineProfile;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  /** The repeating sibling of setTimer. Injectable for the same reason: a test that arms the machine
   *  must not leave a real five-minute interval behind it. */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
}

type ResolvedDeps = Required<Omit<FirstMoveDeps, 'deliver'>> & { deliver: FirstMoveDeps['deliver'] };

const realDeps: Omit<ResolvedDeps, 'deliver'> = {
  getEngine: getEngineBackend,
  now: () => Date.now(),
  seed: seedFromEngineProfile,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
};

/** The doctrine gate. The ask is a full agent run on an engine that may not yet have been told what
 *  Irises IS — sending it first would spend the one install-time exchange on an engine still reading
 *  the request as an ordinary user message. ENGINE_ONBOARDING=off removes the gate entirely rather
 *  than blocking forever: that operator curates the engine's instructions by hand, so there is no
 *  record for this to wait on and never will be. */
function doctrineLanded(name: EngineName): boolean {
  if ((process.env.ENGINE_ONBOARDING || '').toLowerCase() === 'off') return true;
  const want = DOCTRINE_VERSIONS[name];
  if (!want) return false;
  return loadOnboardingState()[name]?.version === want();
}

function reportPhaseError(name: EngineName, phase: string, err: unknown, detail: Record<string, unknown> = {}): void {
  reportError({
    source: 'ops', category: 'first_move', severity: 'warn', err,
    message: `first move ${phase} phase failed — the sweep will try again`,
    detail: { engine: name, phase, ...detail },
  });
}

// ── the phase machine ─────────────────────────────────────────────────────────

/**
 * One tick. Exported so it can be driven directly (tests, a manual catch-up) without arming a timer
 * — runThreadPingSweep's seam.
 *
 * Every gate is cheap and every phase is durable, so a tick that finds nothing to do costs one env
 * read plus one in-memory state read, and a crash anywhere below resumes at the phase it died in
 * rather than at the beginning. Never rejects: this runs fire-and-forget from a timer.
 */
export async function runFirstMoveSweep(deps: FirstMoveDeps): Promise<void> {
  if (!firstMoveEnabled()) return;
  if (running) return;

  const d: ResolvedDeps = { ...realDeps, ...deps };
  const engine = d.getEngine();
  // No engine, or an adapter that cannot be asked: there is no memory to pull and no channel to send
  // on. Skipped rather than degraded — an introduction with nothing behind it is what the weave is
  // for, and the weave needs a real inbound message it has not had.
  if (!engine?.askEngine) return;
  const name = engine.name;

  let rec = loadFirstMoveState()[name] ?? {};
  // Their first text beat the timer to it. Settle with the outcome that actually happened rather
  // than just standing down, so the record says WHY nothing was ever sent. (markIntroWoven writes
  // both fields together, so this only fires for a raced or hand-edited record — it costs one
  // comparison and removes a state that would otherwise be unreadable to an operator.)
  if (rec.wovenAt && !rec.outcome) { patchRecord(name, { outcome: 'woven' }); return; }
  if (isSweepSettled(rec)) return;
  if (!doctrineLanded(name)) return;

  running = true;
  try {
    const now = d.now();

    // ── pull ────────────────────────────────────────────────────────────────
    // `profile` present — not `pulledAt` — is what resolves this phase: the 24h give-up stores an
    // empty profile without ever having pulled, and everything downstream treats that identically.
    if (!rec.profile) {
      if (!rec.firstAttemptAt) rec = patchRecord(name, { firstAttemptAt: now });

      if (now - (rec.firstAttemptAt ?? now) >= PULL_GIVE_UP_MS) {
        // A day of unanswered asks. Stop dialling and fall to the reactive lane with empty hands:
        // she still introduces herself the moment they write, just ungrounded. No `outcome` is
        // written here on purpose — see the field's comment.
        record({ type: 'event', label: 'first-move:gave-up', detail: { engine: name, waitedMs: now - (rec.firstAttemptAt ?? now) } });
        patchRecord(name, { profile: sanitizeEngineProfile(null), mode: 'awaiting_nudge' });
        return;
      }

      let reply: string;
      try {
        // Through the engine slot like the doctrine send: this is a full agent run on the engine's
        // side, and a boot-time ask must never take a slot a waiting user turn needs.
        reply = await withEngineSlot(() => engine.askEngine!(FIRST_MOVE_ASK, { tag: FIRST_MOVE_TAG }));
      } catch (err) {
        // No state change at all — the interval IS the retry ladder, and a stored half-attempt would
        // only be a lie to unwind later.
        reportPhaseError(name, 'pull', err);
        return;
      }

      const profile = sanitizeEngineProfile(extractFencedJson(reply));
      rec = patchRecord(name, {
        pulledAt: now,
        replyPreview: reply.slice(0, REPLY_PREVIEW_MAX),
        askVersion: firstMoveAskVersion(),
        profile,
      });
      record({
        type: 'event', label: 'first-move:pulled',
        detail: {
          engine: name, empty: profile.empty, named: !!profile.name,
          details: profile.details.length, briefChars: profile.brief.length,
          platform: profile.channel?.platform ?? null, hasHistory: profile.channel?.hasHistory ?? false,
        },
      });
    }

    const profile = rec.profile ?? sanitizeEngineProfile(null);
    const channel = profile.channel;

    // ── seed ────────────────────────────────────────────────────────────────
    // No channel means no handle to key memory on and nowhere to send: settle into nudge mode and
    // let the weave do BOTH jobs against the real inbound handle, which is better information than
    // anything we could have guessed here anyway.
    if (!channel) {
      patchRecord(name, { mode: 'awaiting_nudge' });
      return;
    }

    const chatId = bridgeChatId(channel);
    if (!rec.seededAt) {
      try {
        // The chat id pref is what every later proactive facility (thread pings, engine pushes)
        // reads to find this person, so it is written even when nothing is about to be sent —
        // seedFromEngineProfile deliberately does not do this, because it can be re-run against a
        // handle whose channel we do not know.
        await ensureChatId(chatId, chatId);
        const counts = await d.seed(chatId, profile, now);
        rec = patchRecord(name, { seededAt: now, handle: chatId });
        record({ type: 'event', label: 'first-move:seeded', chatId, handle: chatId, detail: { engine: name, ...counts } });
      } catch (err) {
        reportPhaseError(name, 'seed', err, { handle: chatId });
        return;
      }
    }

    // ── send or await ───────────────────────────────────────────────────────
    // The whole "no cold texts, ever" rule, in one comparison. `hasHistory` is already a strict
    // boolean by the time it reaches here (firstMoveProfile.ts), so this is belt-and-braces on a
    // decision that would otherwise be made by another model's typing.
    if (channel.hasHistory !== true) {
      patchRecord(name, { mode: 'awaiting_nudge' });
      return;
    }

    // Somebody has already SPOKEN in this chat, which means she has met them — a re-install over a
    // wiped state file, most likely. An introduction now would be a stranger's line from someone
    // they have been talking to for months.
    const known = await distinctUserHandles(chatId, 1);
    if (known.length) {
      record({ type: 'event', label: 'first-move:skipped-known', chatId, detail: { engine: name, speaker: known[0] } });
      patchRecord(name, { mode: 'proactive', outcome: 'skipped-known' });
      return;
    }

    // The race window: the user may have texted first while this sweep was pulling or seeding, in
    // which case their turn already carried the introduction. Re-read the CACHE (markIntroWoven
    // writes through it) immediately before claiming.
    if (loadFirstMoveState()[name]?.wovenAt) {
      patchRecord(name, { outcome: 'woven' });
      return;
    }

    // CLAIM, then send. A crash inside deliver() leaves the claim standing and this install never
    // introduces itself twice; a delivery that outright FAILED releases it so the next tick retries.
    patchRecord(name, { mode: 'proactive', sentAt: now });
    let outcome: ProactiveOutcome;
    try {
      outcome = await d.deliver({
        chatId,
        kind: 'introduction',
        text: introText(profile),
        dedupeKey: `first-move:${name}:${chatId}`,
        // Nobody has spoken in this chat, so resolveProactiveHandle comes back empty and the
        // Composer would voice the introduction blind to the dossier we seeded minutes ago.
        handleHint: chatId,
      });
    } catch (err) {
      reportPhaseError(name, 'send', err, { handle: chatId });
      patchRecord(name, { sentAt: undefined });
      return;
    }

    if (outcome === 'failed') {
      patchRecord(name, { sentAt: undefined });
      reportPhaseError(name, 'send', new Error('proactive delivery returned "failed"'), { handle: chatId });
      return;
    }

    // 'sent', 'dropped', 'deferred' and 'duplicate' are all SETTLED from here: the message is out of
    // this module's hands, and re-offering it would be the double-introduction this claim exists to
    // prevent.
    patchRecord(name, { outcome });
    record({ type: 'event', label: 'first-move:sent', chatId, handle: chatId, detail: { engine: name, outcome, details: profile.details.length } });
  } catch (err) {
    // The machine must never take a boot (or a timer tick) down with it.
    reportPhaseError(name, 'sweep', err);
  } finally {
    running = false;
  }
}

/**
 * Called once from src/index.ts at boot. Arms UNCONDITIONALLY — the flag and every gate are read
 * inside the sweep, at call time, so an operator can flip FIRST_MOVE_ENABLED without a restart and
 * an armed timer on a settled install costs one env read plus one cached state read every 5 minutes.
 */
export function initFirstMove(deps: FirstMoveDeps): void {
  if (armed) return;
  armed = true;
  const d: ResolvedDeps = { ...realDeps, ...deps };

  // The retention-timer shape (src/db/retention.ts): a boot delay, an unref'd interval, and a body
  // that can never take the process down.
  const boot = d.setTimer(() => { void runFirstMoveSweep(deps); }, BOOT_DELAY_MS);
  boot.unref?.();
  const periodic = d.setInterval(() => { void runFirstMoveSweep(deps); }, SWEEP_INTERVAL_MS);
  periodic.unref?.();
}

// ── the reactive lane ─────────────────────────────────────────────────────────

/**
 * The weave block for THIS turn, or null. Called from buildSystemPrompt's dyn-section assembly on
 * every 1:1 Convo turn, so the ordinary answer — after the one turn this ever fires on — is null
 * from a cached state read and nothing else.
 *
 * Three refusals worth naming:
 *   • a GROUP handle. Structural, like every other memory surface: the introduction is one person's
 *     first conversation, and a room is not a person.
 *   • a pull that has not RESOLVED (no profile yet). The turn is never blocked on an engine round
 *     trip — the persona's own Onboarding section already knows how to meet a stranger, and this
 *     block only adds what the seeded picture makes possible.
 *   • anything SETTLED. The proactive send already went, or a previous turn already wove it.
 *
 * The one write it performs is the RE-KEY. Until a real message arrives, the handle is the engine's
 * prediction (`eng:<platform>:<chat_id>`); the inbound router keys the sender on `sender_id ?? chat`,
 * which can differ. This is the exact moment the truth arrives, so the seed is re-run against the
 * handle that actually texted — and the seed's own guards (write-only-into-a-vacuum, upsert-by-key,
 * skip-a-lived-in-inventory) make that a near no-op rather than a second copy.
 */
export async function pendingIntroWeave(
  handle: string,
  deps: Pick<FirstMoveDeps, 'seed' | 'now' | 'getEngine'> = {},
): Promise<string | null> {
  if (!firstMoveEnabled()) return null;
  if (!handle || isGroupHandle(handle)) return null;

  const found = currentRecord(loadFirstMoveState(), deps.getEngine?.()?.name ?? null);
  if (!found) return null;
  const { name, rec } = found;
  if (!isWeaveArmed(rec) || !rec.profile) return null;

  if (rec.handle !== handle || !rec.seededAt) {
    const now = (deps.now ?? realDeps.now)();
    try {
      await (deps.seed ?? realDeps.seed)(handle, rec.profile, now);
      patchRecord(name, { handle, seededAt: now });
    } catch (err) {
      // The introduction is worth more than the grounding: an ungrounded weave is still the right
      // reply to a stranger's first text, and a thrown seed must not cost her the greeting.
      reportPhaseError(name, 'weave-seed', err, { handle });
    }
  }

  return INTRO_WEAVE_BLOCK;
}

/**
 * The weave happened — settle the machine forever. Called from processConvoResult once the reply
 * carrying the block has been assembled and recorded, and idempotent because a retried or
 * re-entered turn must not turn one introduction into two records.
 *
 * A crash between the prompt build and here leaves the weave armed for the next inbound message.
 * That is deliberate: the worst case is a second introduction, which is the same loss class the
 * doctrine module accepts, and the alternative — marking it done before she has said anything —
 * risks the introduction never happening at all.
 */
export function markIntroWoven(now: number = Date.now()): void {
  const found = currentRecord(loadFirstMoveState());
  if (!found || found.rec.wovenAt) return;
  patchRecord(found.name, { wovenAt: now, outcome: found.rec.outcome ?? 'woven' });
  record({ type: 'event', label: 'first-move:woven', detail: { engine: found.name, handle: found.rec.handle ?? null } });
}

/** Test seam: back to a never-installed machine (no armed timer, no cache, no state file) — the
 *  __resetThreadPingGuardsForTests / _resetOnboardingForTests convention. */
export function __resetFirstMoveGuardsForTests(): void {
  armed = false;
  running = false;
  cache = null;
  try { fs.rmSync(statePath(), { force: true }); } catch { /* best-effort */ }
}

/** Pure helpers the tests pin directly. Not part of the module's contract with the rest of the app. */
export const _internal = {
  coerceRecord,
  currentRecord,
  isSweepSettled,
  isWeaveArmed,
  patchRecord,
  saveState,
  statePath,
};
