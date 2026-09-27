// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The hook engine is the CODE half of the turn law: the model contributes one word out of four, and
// every run, cap, interval and veto below it is arithmetic in hooks.ts. These tests pin all of it,
// plus the invariants the rest of pillar three leans on:
//
//   • THE KILL SWITCH OUTRANKS EVERYTHING ON AN IDLE TURN. Three hooked replies in a row and the
//     fourth turn is quiet whatever the mood, the room, or the sampler would have said. It is
//     checked before any of them, and its receipt says so in its own disjoint bucket. A SHARE turn
//     is outside it entirely — they spoke — and can never be forced quiet.
//   • THE QUESTION IS THE SHARE TURN'S ALONE. An idle turn forbids it with no condition attached;
//     a share turn opens it only inside the compiled ceiling, never twice running, never in a room.
//   • `none` IS AN ENTRY, not a gap. One flat reply anywhere in the window buys the next hook back,
//     which is what keeps the window three turns wide instead of three weeks wide.
//   • DISJOINT REPORTS. Every turn the selector ran lands in exactly one `reason`, and a kind that
//     is forbidden for three overlapping reasons is still named exactly once.
//   • TASK TURNS RENDER NOTHING. On the turns that are actually work the prompt is byte-identical
//     to an install that never had a hook engine.
//   • NO SHAPE OF THE SHARE BLOCK READS AS PERMISSION TO SEND NOTHING. Every other mode has a floor
//     of silence under it — a tapback, a beat let pass — and on a share turn silence is the receipt
//     the shape was built to refuse, so even the all-kinds-closed variant says what the reply is.
//   • NOT ONE DIGIT, and the clamp is always last.
//   • PURE. `now` is injected, inputs are deep-frozen here and must survive it.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectHook, recordHook, quietViolation, renderHooksSection, defaultHookState, hookKindOpen, shapeOf,
  HOOK_WORDS, HOOK_RUN_LIMIT, MOMENT_IDLE_INTERVAL, QUIET_MAX_WORDS,
  HOOK_CLAMP, HOOK_HEADING, HOOK_LEAD, HOOK_OPEN_LINE, HOOK_NONE_OPEN, HOOK_LATE_LINE,
  MOMENTS_LEAD, QUIET_HEADING, QUIET_LAW,
  SHARE_HEADING, SHARE_LEAD, SHARE_OPEN_LINE, SHARE_QUESTION_LINE, SHARE_NONE_OPEN, SHARE_LATE_LINE,
  LOOSE_LEVEL_LINES, PUSH_LINE, PUSH_PERCENT, QUIZ_PUSH_MS, QUIZ_ROAST_PERCENT,
  type HookAffectInput, type HookDirective, type HookKind, type HookState, type HookWord,
  type TurnKind,
} from './hooks.js';
import { renderDriftAnchor, PUSH_BULLET } from './policy.js';

const T0 = Date.UTC(2026, 3, 1);

function state(over: Partial<HookState> = {}): HookState {
  return { ...defaultHookState(), ...over };
}

/** Nothing closed by her weather: every kind allowed, the question ceiling open, no weight, daylight.
 *  The question being OPEN here is what allows every idle case below to show the MODE's own rules;
 *  a closed ceiling adds its own ban on top, and these cases isolate the mode's arithmetic. */
const OPEN: HookAffectInput = { hooks: 'all', question: 'open', heavy: false, lateNight: false };

/** Selection with the boring arguments filled in: an idle turn, a wide-open mood, a one-to-one chat.
 *  `shape` is the gate's reading (persona/idle.ts `TurnKind`) and the default is `idle`, so a case
 *  that says nothing about it is a case about the turn the hook engine was built for. */
function pick(
  s: HookState,
  over: { shape?: TurnKind; layer?: string; affect?: HookAffectInput; isGroup?: boolean } = {},
) {
  return selectHook(
    s,
    over.shape ?? 'idle',
    over.layer ?? 'fast_path',
    over.affect ?? OPEN,
    over.isGroup ?? false,
    T0,
  );
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

// ══ 1. The four modes ════════════════════════════════════════════════════════

test('a task turn carries no hook, no offer and no moment, and says why', () => {
  const { directive, report } = pick(state({ idleSinceMoment: 99 }), { shape: 'task', layer: 'veto' });
  assert.equal(directive.mode, 'task');
  assert.equal(directive.idle, false);
  assert.equal(directive.offerAllowed, false);
  assert.equal(directive.moments, false, 'a spent interval buys nothing on a turn that was work');
  assert.deepEqual(directive.forbidden, [], 'the MODE forbids every kind; the list would be a second answer');
  assert.equal(report.reason, 'not_idle');
  assert.equal(report.idleLayer, 'veto', 'the layer that decided rides through untouched');
});

// An idle turn opens all four kinds with an empty ledger and a wide-open mood. The question is
// now a valid hook kind, gated only by the affect ceiling and the group rule — not by the shape
// of the turn itself.
test('an idle turn with an empty ledger opens all four carrying kinds', () => {
  const { directive, report } = pick(state());
  assert.equal(directive.mode, 'hook');
  assert.equal(directive.idle, true);
  assert.equal(directive.offerAllowed, true);
  assert.deepEqual(directive.forbidden, []);
  assert.equal(report.reason, 'hook');
  assert.deepEqual(report.lastKinds, []);
  assert.equal(directive.heavy, undefined, 'weight is a property of a thing handed over, and nothing was');
});

// THE load-bearing rule. Three sharp replies in a row and the fourth turn stops performing at them:
// it hands them the turn with a question or opens up with a rant (a tangent), nothing offered or sampled.
test('three hooked replies in a row narrow the fourth turn to a question or a rant', () => {
  const { directive, report } = pick(state({ lastKinds: ['judgment', 'callback', 'tangent'] }));
  assert.equal(directive.mode, 'hook');
  assert.deepEqual(directive.forbidden, ['judgment', 'callback']);
  assert.equal(directive.offerAllowed, false, 'the thread OFFER is off, the move is the whole beat');
  assert.equal(directive.moments, false);
  assert.equal(report.reason, 'kill_switch');
  assert.deepEqual(report.lastKinds, ['judgment', 'callback', 'tangent'], 'the receipt shows the run it fired on');
});

// Each exit has its own gates, and the switch goes quiet only when both are shut.
test('the kill switch keeps whichever exit is open, and goes quiet when neither is', () => {
  const run = state({ lastKinds: ['judgment', 'callback', 'tangent'] });
  assert.deepEqual(pick(run, { affect: { ...OPEN, question: 'closed' } }).directive.forbidden, ['judgment', 'callback', 'question']);
  assert.deepEqual(pick(run, { isGroup: true }).directive.forbidden, ['judgment', 'callback', 'question']);
  assert.deepEqual(pick(run, { affect: { ...OPEN, hooks: 'no_tangent' } }).directive.forbidden, ['judgment', 'callback', 'tangent']);
  const neither = pick(run, { affect: { ...OPEN, hooks: 'no_tangent', question: 'closed' } });
  assert.equal(neither.directive.mode, 'quiet');
  assert.equal(neither.report.reason, 'kill_switch');
});

// `none` is a first-class entry: one flat reply anywhere in the window breaks the run. Without it
// the window would span every hooked turn ever taken rather than the last three turns.
test('one flat reply anywhere in the window breaks the run', () => {
  for (const window of [
    ['none', 'callback', 'tangent'],
    ['judgment', 'none', 'tangent'],
    ['judgment', 'callback', 'none'],
  ] as HookKind[][]) {
    const { directive } = pick(state({ lastKinds: window }));
    assert.equal(directive.mode, 'hook', `${window.join(',')} is not a run`);
  }
});

test('a short ledger cannot fire the switch, and a long one is read at its tail', () => {
  assert.equal(pick(state({ lastKinds: ['judgment', 'callback'] })).directive.mode, 'hook',
    'two is not a run — the switch needs a full window');
  // A hand-built (or hand-edited) state longer than the cap is read exactly as the store would have
  // capped it: the tail is the run, and the older entries are already spent.
  const long: HookKind[] = ['judgment', 'callback', 'none', 'judgment', 'tangent', 'callback'];
  const { report } = pick(state({ lastKinds: long }));
  assert.equal(report.reason, 'kill_switch');
  assert.deepEqual(report.lastKinds, ['judgment', 'tangent', 'callback'], 'only the window the cap keeps');
});

test('a flat mood closes hooks outright, in its own bucket, and leaves one lazy question when the gate is open', () => {
  const closed = pick(state(), { affect: { ...OPEN, hooks: 'none', question: 'closed' } });
  assert.equal(closed.directive.mode, 'quiet');
  assert.equal(closed.directive.offerAllowed, false);
  assert.equal(closed.report.reason, 'affect_floor');
  // A low mood still asks things, lazily (2026-09-26): the question is the one move left.
  const lazy = pick(state(), { affect: { ...OPEN, hooks: 'none' } });
  assert.equal(lazy.directive.mode, 'hook');
  assert.deepEqual(lazy.directive.forbidden, ['judgment', 'callback', 'tangent']);
  assert.equal(lazy.directive.low, true);
  assert.equal(lazy.report.reason, 'affect_floor');
  // …never in a room, and never a second question in a row.
  assert.equal(pick(state(), { affect: { ...OPEN, hooks: 'none' }, isGroup: true }).directive.mode, 'quiet');
});

// Precedence, stated as a test rather than as a comment: when both would fire, the receipt says
// kill_switch. The battery scores the switch off that bucket, so a flat mood must never be able to
// wear its name.
test('the kill switch outranks the affect floor, the room and a spent moment interval', () => {
  const { directive, report } = pick(
    state({ lastKinds: ['judgment', 'judgment', 'judgment'], idleSinceMoment: 99 }),
    { affect: { ...OPEN, hooks: 'none', lateNight: true }, isGroup: true, layer: 'classify' },
  );
  assert.equal(directive.mode, 'quiet');
  assert.equal(directive.moments, false);
  assert.equal(report.reason, 'kill_switch');
  assert.equal(report.idleLayer, 'classify');
});

// ══ 2. Forbidden kinds ═══════════════════════════════════════════════════════

test('the same kind twice in a row forbids the third', () => {
  for (const w of ['judgment', 'callback', 'tangent'] as HookWord[]) {
    const { directive, report } = pick(state({ lastKinds: ['none', w, w] }));
    assert.equal(directive.mode, 'hook', 'a repeat is a forbidden kind, never a quiet turn');
    assert.deepEqual(directive.forbidden, [w]);
    assert.deepEqual(report.forbidden, [w], 'the receipt carries the same list');
  }
  // The fourth word obeys the same repeat rule: two questions in a row closes the next one.
  assert.deepEqual(pick(state({ lastKinds: ['none', 'question', 'question'] })).directive.forbidden, ['question']);
  // Two of the same kind NOT adjacent is not a tic.
  assert.deepEqual(pick(state({ lastKinds: ['tangent', 'none', 'tangent'] })).directive.forbidden, []);
  // …except a judgment, which never follows a judgment (the persona's never-twice rule).
  assert.deepEqual(pick(state({ lastKinds: ['judgment', 'none', 'judgment'] })).directive.forbidden, ['judgment']);
  assert.deepEqual(pick(state({ lastKinds: ['judgment', 'judgment', 'none'] })).directive.forbidden, []);
  // And two flat replies in a row is just a conversation, not a repeated kind.
  assert.deepEqual(pick(state({ lastKinds: ['tangent', 'none', 'none'] })).directive.forbidden, []);
});

test('the compiled mood forbids its own kind', () => {
  assert.deepEqual(pick(state(), { affect: { ...OPEN, hooks: 'no_judgment' } }).directive.forbidden, ['judgment']);
  assert.deepEqual(pick(state(), { affect: { ...OPEN, hooks: 'no_tangent' } }).directive.forbidden, ['tangent']);
  assert.deepEqual(pick(state(), { affect: OPEN }).directive.forbidden, []);
});

// The ceiling DOES matter on idle turns: an open ceiling permits the question kind, and a closed
// one forbids it — the same gate as the share branch, nothing unconditional about the shape.
test('the compiled ceiling gates the question on idle turns', () => {
  assert.deepEqual(pick(state(), { affect: { ...OPEN, question: 'open' } }).directive.forbidden, []);
  assert.deepEqual(pick(state(), { affect: { ...OPEN, question: 'closed' } }).directive.forbidden, ['question']);
  // …and the weight flag is a share-turn read: it neither closes a kind here nor rides the directive.
  const heavy = pick(state(), { affect: { ...OPEN, heavy: true } });
  assert.deepEqual(heavy.directive.forbidden, []);
  assert.equal(heavy.directive.heavy, undefined);
});

// A read is between the two of them. In a room there is no `them` for it to be about, so the
// verdict-with-an-audience is off the table while the other two kinds stay.
test('a group forbids judgment and keeps the rest', () => {
  const { directive } = pick(state(), { isGroup: true });
  assert.equal(directive.mode, 'hook');
  assert.deepEqual(directive.forbidden, ['judgment', 'question']);
});

// Rooms accumulate a ledger exactly like a one-to-one chat does — the write sits outside the
// non-group guard for this reason.
test('the kill switch fires in a group too', () => {
  const { directive, report } = pick(state({ lastKinds: ['callback', 'tangent', 'callback'] }), { isGroup: true });
  assert.deepEqual(directive.forbidden, ['judgment', 'callback', 'question'], 'a room closes the question, the rant stays');
  assert.equal(report.reason, 'kill_switch');
});

test('overlapping reasons name a kind once, in HOOK_WORDS order', () => {
  const { directive } = pick(
    state({ lastKinds: ['none', 'judgment', 'judgment'] }),
    { affect: { ...OPEN, hooks: 'no_judgment' }, isGroup: true },
  );
  assert.deepEqual(directive.forbidden, ['judgment', 'question'], 'three reasons, one entry');

  const { directive: two } = pick(
    state({ lastKinds: ['none', 'tangent', 'tangent'] }),
    { affect: { ...OPEN, hooks: 'no_judgment' } },
  );
  assert.deepEqual(two.forbidden, ['judgment', 'tangent'],
    'always the array order, never the discovery order');
});

// Reachable, and rarely: a room (no judgment), a flattened mood (no tangent), and a callback she
// just used twice. The turn stays a hook turn — a thread offer still belongs to it — with nothing
// left to carry.
test('every kind can be spoken for at once, and the turn is still a hook turn', () => {
  const { directive } = pick(
    state({ lastKinds: ['none', 'callback', 'callback'] }),
    { affect: { ...OPEN, hooks: 'no_tangent' }, isGroup: true },
  );
  assert.equal(directive.mode, 'hook');
  assert.equal(directive.offerAllowed, true);
  assert.deepEqual(directive.forbidden, [...HOOK_WORDS],
    'the three carrying kinds, each for its own reason, and the fourth for the shape of the turn');
});

// ══ 3. The share branch ══════════════════════════════════════════════════════
//
// They handed her something and asked for nothing. The move is the whole reply rather than a beat
// after one, which is why the two things that can silence an idle turn must not silence this one:
// answering a bid with a receipt is what this shape was built to refuse, and answering it with
// nothing at all is the same failure with the volume down. So the kill switch does not reach here
// and the affect floor narrows the turn instead of closing it. The fourth kind is reachable on this
// branch and on no other.

test('a share turn is its own mode, its own bucket, and opens all four kinds', () => {
  const { directive, report } = pick(state({ idleSinceMoment: 99 }), { shape: 'share', layer: 'classify' });
  assert.equal(directive.mode, 'share');
  assert.equal(directive.idle, false, 'they said something — the streak this feeds counts silences');
  assert.deepEqual(directive.forbidden, [], 'the question included: this is the turn it belongs to');
  assert.equal(directive.heavy, false);
  assert.equal(directive.offerAllowed, true);
  assert.equal(directive.moments, false,
    'a spent interval buys nothing here — what a callback could be made of is in front of her already');
  assert.equal(report.reason, 'share', 'not a flavour of `hook`: the battery has to be able to tell them apart');
  assert.equal(report.idleLayer, 'classify', 'the layer that decided rides through untouched');
  assert.equal(hookKindOpen(directive), true);
});

// THE SCOPE OF THE KILL SWITCH, stated where it stops. It is a switch on silence answered with
// cleverness — four turns of someone sending nothing and getting a clever line back — so a run of
// three means nothing on the turn where the person actually spoke. Same ledger, same state, two
// answers, and the share one is not even a different reason.
test('the kill switch never fires on a share turn', () => {
  const full = state({ lastKinds: ['judgment', 'callback', 'tangent'] });
  assert.equal(pick(full).report.reason, 'kill_switch', 'the same window fires the switch on an IDLE turn');
  const { directive, report } = pick(full, { shape: 'share' });
  assert.equal(directive.mode, 'share');
  assert.equal(report.reason, 'share');
  assert.deepEqual(directive.forbidden, [], 'and the run costs the share turn nothing');
  assert.deepEqual(report.lastKinds, ['judgment', 'callback', 'tangent']);
});

// The affect floor's other half. On an idle turn `hooks: 'none'` IS the quiet bucket; here it is the
// presence case — every kind closed, the turn still a share turn, and the section's own law is that
// one plain sentence about their thing is what is left. A mood too flat for a move is not a reason to
// answer a person with nothing.
test('a flat mood narrows a share turn to presence and never closes it', () => {
  const { directive, report } = pick(state(), { shape: 'share', affect: { ...OPEN, hooks: 'none', question: 'closed' } });
  assert.equal(directive.mode, 'share', 'never quiet');
  assert.deepEqual(directive.forbidden, [...HOOK_WORDS]);
  // With the gate open, a flat mood still leaves the (lazy) question.
  assert.deepEqual(pick(state(), { shape: 'share', affect: { ...OPEN, hooks: 'none' } }).directive.forbidden, ['judgment', 'callback', 'tangent']);
  assert.equal(directive.offerAllowed, true);
  assert.equal(report.reason, 'share', 'and no affect_floor bucket: nothing was floored, the turn was narrowed');
  assert.equal(hookKindOpen(directive), false, 'nothing open, and the section still forbids silence');
});

// The compiled CEILING (affectCompiler.ts `compileQuestionGate`): her weather saying the reply stays
// statement-shaped. `open` is a permission and never an instruction — the kind stays in the set and
// she judges whether this particular share wants a question — and nothing on this branch turns
// `closed` back into `open`.
test('the compiled ceiling closes the question and leaves the rest', () => {
  const closed = pick(state(), { shape: 'share', affect: { ...OPEN, question: 'closed' } });
  assert.deepEqual(closed.directive.forbidden, ['question']);
  assert.equal(hookKindOpen(closed.directive), true, 'the guess is still hers to state');
  assert.deepEqual(pick(state(), { shape: 'share', affect: { ...OPEN, question: 'open' } }).directive.forbidden, []);
});

// Back-to-back questions on share turns are allowed — only the compiled ceiling and the group gate
// close the question, not the ledger tail. The repeat rule (two-in-a-row) still applies as with
// any kind, but a single question at the tail is not a ban.
test('a question at the ledger tail does not close the next share turn', () => {
  const after = pick(state({ lastKinds: ['none', 'judgment', 'question'] }), { shape: 'share' });
  assert.deepEqual(after.directive.forbidden, [],
    'the tail question is the last kind, not a ban — the ceiling decides');
  const later = pick(state({ lastKinds: ['question', 'none', 'judgment'] }), { shape: 'share' });
  assert.deepEqual(later.directive.forbidden, ['judgment'], 'one reply on: the question still open, and no judgment after a judgment');
});

// A room closes the two moves that need one person to be aimed at: a verdict in front of an audience,
// and a follow-up that puts one member on the spot to answer in front of everyone. A callback and a
// tangent are about the thing, so they survive — the same fence every per-person read sits behind.
test('a stranger gets no judgment on an idle or a share turn, and everything else stays open', () => {
  assert.deepEqual(pick(state(), { affect: { ...OPEN, stranger: true } }).directive.forbidden, ['judgment']);
  assert.deepEqual(pick(state(), { shape: 'share', affect: { ...OPEN, stranger: true } }).directive.forbidden, ['judgment']);
  assert.deepEqual(pick(state(), { affect: OPEN }).directive.forbidden, []);
});

test('a room closes the judgment and the question on a share turn', () => {
  const { directive } = pick(state(), { shape: 'share', isGroup: true });
  assert.equal(directive.mode, 'share');
  assert.deepEqual(directive.forbidden, ['judgment', 'question']);
});

// WEIGHT. A judgment on a heavy share is analysis, and analysis is not company; a tangent walks away
// from the thing they just put down. What is left is a callback and — if the ceiling left it open — a
// question about what happened or how it sat. The flag rides the directive because the climate span
// reads it too: it must not tell her a tangent is welcome on the turn someone let the tank out.
test('weight closes the judgment and the tangent, and rides the directive', () => {
  const { directive } = pick(state(), { shape: 'share', affect: { ...OPEN, heavy: true } });
  assert.deepEqual(directive.forbidden, ['judgment', 'tangent']);
  assert.equal(directive.heavy, true);
  assert.equal(hookKindOpen(directive), true, 'a callback and the question are still moves');
  // The narrowest share there is — weight plus a closed ceiling, which is exactly what someone
  // overwhelmed compiles to — and it is still a share turn with a law that forbids silence.
  const narrow = pick(state(), { shape: 'share', affect: { ...OPEN, heavy: true, question: 'closed' } });
  assert.equal(narrow.directive.mode, 'share');
  assert.deepEqual(narrow.directive.forbidden, ['judgment', 'tangent', 'question']);
  assert.equal(hookKindOpen(narrow.directive), true, 'the callback is what is left');
});

test('the repeat rule and the sampler behave on a share turn too', () => {
  const { directive } = pick(
    state({ lastKinds: ['none', 'callback', 'callback'], idleSinceMoment: MOMENT_IDLE_INTERVAL + 5 }),
    { shape: 'share' },
  );
  assert.deepEqual(directive.forbidden, ['callback'], 'two in a row is a tic on any turn');
  assert.equal(directive.moments, false, 'and the sampler is for the turn with nothing else in it');
});

test('overlapping reasons name a kind once on a share turn, in HOOK_WORDS order', () => {
  const { directive } = pick(
    state({ lastKinds: ['none', 'judgment', 'judgment'] }),
    { shape: 'share', affect: { ...OPEN, hooks: 'no_judgment', heavy: true }, isGroup: true },
  );
  assert.deepEqual(directive.forbidden, ['judgment', 'tangent', 'question'],
    'four reasons closed the judgment, one entry');
});

// The clock is not a branch here either: it lowers the volume of the one move and picks none of it.
test('lateNight rides a share turn as a register and closes nothing', () => {
  const { directive } = pick(state(), { shape: 'share', affect: { ...OPEN, lateNight: true } });
  assert.equal(directive.lateNight, true);
  assert.deepEqual(directive.forbidden, []);
  const day = pick(state(), { shape: 'share' });
  assert.deepEqual({ ...directive, lateNight: false }, day.directive);
});

// ══ 4. The late-night register and moments ═══════════════════════════════════

// Passed through in every mode so a consumer never has to check which branch it came from.
test('lateNight rides through every mode untouched', () => {
  const late: HookAffectInput = { ...OPEN, lateNight: true };
  assert.equal(pick(state(), { affect: late }).directive.lateNight, true);
  assert.equal(pick(state(), { affect: late, shape: 'task' }).directive.lateNight, true);
  assert.equal(pick(state({ lastKinds: ['judgment', 'callback', 'tangent'] }), { affect: late }).directive.lateNight, true);
  assert.equal(pick(state(), { affect: OPEN }).directive.lateNight, false);
});

// THE 2AM TURN, and the one line it used to print every night. The clock used to CLOSE every kind
// and shut the sampler and the thread offer, which left sending them to bed as the only content a
// late turn could hold — a script, restated in seven prompt surfaces, and the person on the other
// end got it every night with their name attached. The hour is a REGISTER now: it lowers the volume
// (the rendered late line) and decides nothing else, so a late idle turn falls through to the
// ordinary hook path and the mood, the room and the ledger pick the content the way they do at noon.
test('a late-night idle turn is an ordinary hook turn at a lower volume', () => {
  const late: HookAffectInput = { ...OPEN, lateNight: true };
  const { directive, report } = pick(state({ idleSinceMoment: MOMENT_IDLE_INTERVAL + 5 }), { affect: late });
  assert.equal(directive.mode, 'hook');
  assert.deepEqual(directive.forbidden, [], 'the clock closes no kind, and neither does the shape — the ceiling does');
  assert.equal(directive.lateNight, true);
  assert.equal(directive.moments, true, 'the interval was spent, and the hour does not shut the sampler');
  assert.equal(directive.offerAllowed, true, 'nor the thread offer');
  assert.equal(report.reason, 'hook', 'the clock has no bucket of its own — there is nothing to explain');
  assert.deepEqual(report.forbidden, []);
  assert.equal(hookKindOpen(directive), true, 'so the beat is open and the anchor gets the HOOK law');
  // Byte-identical to the same state in daylight, apart from the flag itself: proof the hour is a
  // register and not a branch.
  const day = pick(state({ idleSinceMoment: MOMENT_IDLE_INTERVAL + 5 }), { affect: OPEN });
  assert.deepEqual({ ...directive, lateNight: false }, day.directive);
  assert.deepEqual(report, day.report);
});

// The predicate every consumer outside the renderer has to use, and the reason it exists: the mode
// and "is there a beat" come apart on the closed-kinds shape — a room, a flattened mood and a
// repeated kind overlapping. A directive like that read as a hook turn by the climate span would put
// "A tangent or a callback is expected of you here" in the same prompt as "No kind is open this
// turn", which is the register door left open one function away.
test('hookKindOpen answers whether a beat is OPEN, never what the mode says', () => {
  const hook: HookDirective = {
    idle: true, mode: 'hook', forbidden: [], lateNight: false, moments: true, offerAllowed: true,
  };
  assert.equal(hookKindOpen(hook), true, 'all four open');
  // Any ONE carrying kind left is still a beat she may spend, so the boundary is the whole set and
  // not a count: a room forbids judgment and a flat mood forbids a tangent, and a callback is still
  // a hook. The question is now a valid hook kind too, so a turn where only the question is left
  // reads open — the ceiling or the group rule may have closed the other three.
  for (const w of HOOK_WORDS) {
    assert.equal(hookKindOpen({ ...hook, forbidden: HOOK_WORDS.filter(k => k !== w) }), true, w);
  }
  assert.equal(hookKindOpen({ ...hook, forbidden: [...HOOK_WORDS] }), false, 'the closed-kinds shape');
  // Which is why the reading is taken over the SET and not off `forbidden.length`: a list that
  // carries a duplicate has as many entries as there are carrying kinds and still leaves one open.
  // The renderer always read the set (`allowed.length > 0`), so a counting predicate would have
  // called this turn closed while the section it ships names tangent — the disagreement this
  // predicate exists to end. The count to fool is the CARRYING kinds, not the vocabulary: the
  // question is in HOOK_WORDS and in no hook turn's set.
  const carrying = HOOK_WORDS.filter(w => w !== 'question');
  const dupe: HookDirective = { ...hook, forbidden: ['judgment', 'judgment', 'callback'] };
  assert.equal(dupe.forbidden.length, carrying.length, 'the shape that fools a count');
  assert.equal(hookKindOpen(dupe), true, 'tangent is still open');
  assert.equal(
    renderHooksSection(dupe),
    renderHooksSection({ ...hook, forbidden: ['judgment', 'callback'] }),
    'and the renderer agrees — the same section as the deduped directive, naming tangent',
  );
  // A SHARE turn answers this question too, and both modes now agree: question is a valid kind in
  // both modes, so when only question remains the beat is open in either.
  const share: HookDirective = { ...hook, idle: false, mode: 'share', heavy: false, moments: false };
  assert.equal(hookKindOpen({ ...share, forbidden: [...carrying] }), true,
    'the question alone is still a move to make on a share turn');
  assert.equal(hookKindOpen({ ...hook, forbidden: [...carrying] }), true,
    '…and on a hook turn too: question is now a valid hook kind');
  assert.equal(hookKindOpen({ ...share, forbidden: [...HOOK_WORDS] }), false,
    'the presence case: nothing open, and the share section still forbids silence');
  // The other two modes never populate `forbidden` — the MODE forbade every kind already — so the
  // predicate must not read an empty list there as "everything is open".
  assert.equal(hookKindOpen({ ...hook, mode: 'quiet', forbidden: [] }), false);
  assert.equal(hookKindOpen({ ...hook, mode: 'task', idle: false, forbidden: [] }), false);
  // A caller with no rhythm engine at all (the flag off, a non-Convo lane) is on a turn with no beat.
  assert.equal(hookKindOpen(null), false);
  assert.equal(hookKindOpen(undefined), false);
});

// The two forced-quiet buckets are unmoved by the hour: they fire at 2am exactly as they fire at
// noon, and the receipt names the thing that actually decided. A run of three is still a run of
// three after midnight, and the clock never gets to talk one of them out of firing.
test('the kill switch and the affect floor still fire at night', () => {
  const late: HookAffectInput = { ...OPEN, lateNight: true };
  const killed = pick(state({ lastKinds: ['judgment', 'callback', 'tangent'] }), { affect: late });
  assert.deepEqual(killed.directive.forbidden, ['judgment', 'callback']);
  assert.equal(killed.report.reason, 'kill_switch');
  const floored = pick(state(), { affect: { ...OPEN, hooks: 'none', question: 'closed', lateNight: true } });
  assert.equal(floored.directive.mode, 'quiet');
  assert.equal(floored.report.reason, 'affect_floor');
});

// A late TASK turn is a task turn. Somebody who asks for something at 2am gets the answer, flat,
// with the real numbers — the clock only ever spends the extra beat, never the work.
test('the clock never touches a task turn', () => {
  const { directive, report } = pick(state(), { affect: { ...OPEN, lateNight: true }, shape: 'task' });
  assert.equal(directive.mode, 'task');
  assert.deepEqual(directive.forbidden, [], 'the MODE forbids every kind already');
  assert.equal(report.reason, 'not_idle');
});

// The rendered section for that turn, char-for-char: the OPEN line naming all three kinds, then the
// register line under it. Nothing in the block tells her what to send, and the word "sleep" is not
// in it — the whole complaint that produced this design was one sentence arriving every night.
test('a late idle turn renders the open line and the late line, and says nothing about sleep', () => {
  const { directive } = pick(state(), { affect: { ...OPEN, lateNight: true } });
  assert.equal(renderHooksSection(directive), [
    '## This turn may carry one hook (INTERNAL)',
    'They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.',
    'Open to you this turn: a judgment, a callback, a tangent or a question. One of them, never two, never a kind not named here.',
    'It is late where they are: one short bubble, or a tapback, and nothing heavy. Same rules as any idle turn, at a lower volume, and never the line you sent them last night.',
    'Play level: dry. Light touch only, close to literal, no long bridges.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

test('moments wait out the interval', () => {
  for (let i = 0; i < MOMENT_IDLE_INTERVAL; i++) {
    assert.equal(pick(state({ idleSinceMoment: i })).directive.moments, false, `${i} idle turns is not enough`);
  }
  assert.equal(pick(state({ idleSinceMoment: MOMENT_IDLE_INTERVAL })).directive.moments, true);
  assert.equal(pick(state({ idleSinceMoment: MOMENT_IDLE_INTERVAL + 5 })).directive.moments, true);
});

// A moment can only ride out as a callback, so a forbidden callback makes the sample dead weight —
// and sampling BILLS the moment, so the gate has to sit before it, not in the renderer.
test('a forbidden callback stops the sampler even with the interval spent', () => {
  const spent = { idleSinceMoment: MOMENT_IDLE_INTERVAL + 1 };
  assert.equal(pick(state({ ...spent, lastKinds: ['none', 'callback', 'callback'] })).directive.moments, false);
  assert.equal(pick(state({ ...spent, lastKinds: ['none', 'judgment', 'judgment'] })).directive.moments, true,
    'a forbidden judgment costs the moment nothing');
});

test('a group never samples moments', () => {
  const s = state({ idleSinceMoment: MOMENT_IDLE_INTERVAL + 1 });
  assert.equal(pick(s, { isGroup: true }).directive.moments, false);
  assert.equal(pick(s).directive.moments, true);
});

// ══ 5. The ledger ════════════════════════════════════════════════════════════

test('recordHook pushes the emitted kind and caps the window', () => {
  let s = defaultHookState();
  s = recordHook(s, 'judgment', 'idle', false, T0);
  s = recordHook(s, 'callback', 'idle', false, T0 + 1);
  s = recordHook(s, 'tangent', 'idle', false, T0 + 2);
  assert.deepEqual(s.lastKinds, ['judgment', 'callback', 'tangent']);
  s = recordHook(s, undefined, 'idle', false, T0 + 3);
  assert.deepEqual(s.lastKinds, ['callback', 'tangent', 'none'], 'oldest out, most recent last, capped');
  assert.equal(s.lastKinds.length, HOOK_RUN_LIMIT);
  assert.equal(s.updatedAt, T0 + 3, 'the injected clock, never the wall clock');
});

// A droppable envelope field: a model that said nothing about its hook did not hook.
test('an absent kind reads as none', () => {
  assert.deepEqual(recordHook(defaultHookState(), undefined, 'idle', false, T0).lastKinds, ['none']);
  assert.deepEqual(recordHook(defaultHookState(), 'nonsense' as never, 'idle', false, T0).lastKinds, ['none'],
    'a word outside the four is no kind at all');
});

// THE ROW TWO OTHER ENGINES READ. A question emitted on a share turn is written down like any other
// kind, and the tail is what the gate's follow-up read (persona/idle.ts `followUpOutstanding`) uses.
// The shape of the turn changes the two clocks and never what is recorded.
test('a question is a ledger entry like any other kind, whatever the shape recorded it', () => {
  const asked = recordHook(defaultHookState(), 'question', 'share', false, T0);
  assert.deepEqual(asked.lastKinds, ['question']);
  // Back-to-back questions are no longer banned — only the ceiling and the group gate close the kind.
  assert.deepEqual(pick(state({ lastKinds: asked.lastKinds }), { shape: 'share' }).directive.forbidden, []);
});

test('the idle streak counts consecutive idle turns, and an ask or a share resets it', () => {
  let s = recordHook(defaultHookState(), 'judgment', 'idle', false, T0);
  assert.equal(s.idleStreak, 1);
  s = recordHook(s, undefined, 'idle', false, T0 + 1);
  assert.equal(s.idleStreak, 2);
  s = recordHook(s, undefined, 'task', false, T0 + 2);
  assert.equal(s.idleStreak, 0, 'one real ask and the streak is over');
  s = recordHook(s, undefined, 'idle', false, T0 + 3);
  assert.equal(s.idleStreak, 1);
  // A SHARE ends it exactly as a task does: the count is "how many times in a row they sent
  // nothing", and someone who handed her a piece of their day sent something.
  s = recordHook(s, 'question', 'share', false, T0 + 4);
  assert.equal(s.idleStreak, 0);
});

test('the moment clock ticks on idle turns and resets on an offer', () => {
  let s = defaultHookState();
  s = recordHook(s, undefined, 'idle', false, T0);
  s = recordHook(s, undefined, 'idle', false, T0 + 1);
  assert.equal(s.idleSinceMoment, 2);
  s = recordHook(s, undefined, 'task', false, T0 + 2);
  assert.equal(s.idleSinceMoment, 2, 'a task turn neither spends nor tops up the moment clock');
  // Nor does a share turn, and for the same reason the sampler never runs on one: a callback about
  // something old is not what this turn is short of.
  s = recordHook(s, 'callback', 'share', false, T0 + 3);
  assert.equal(s.idleSinceMoment, 2);
  s = recordHook(s, 'callback', 'idle', true, T0 + 4);
  assert.equal(s.idleSinceMoment, 0, 'the offer was made, so the spacing starts again');
  assert.equal(s.idleStreak, 1, 'and the two clocks are independent — the task turn reset only one of them');
  // The reset wins on a task turn too: the offer happened either way.
  s = recordHook(s, undefined, 'idle', false, T0 + 5);
  assert.equal(s.idleSinceMoment, 1);
  s = recordHook(s, undefined, 'task', true, T0 + 6);
  assert.equal(s.idleSinceMoment, 0);
});

// The ledger write reads the KIND off the directive it shipped (convo/shared.ts), so the mapping
// that gets it there is pinned here rather than at the seam: the mode says share or it does not, and
// `idle` says whether they sent anything. A quiet turn is an idle turn the switch spent, and it
// counts toward the streak the way it always has.
test('shapeOf reads the turn kind back off the directive that shipped', () => {
  assert.equal(shapeOf(pick(state(), { shape: 'task' }).directive), 'task');
  assert.equal(shapeOf(pick(state()).directive), 'idle');
  assert.equal(shapeOf(pick(state({ lastKinds: ['judgment', 'callback', 'tangent'] })).directive), 'idle',
    'a forced-quiet turn is an idle turn that was spent');
  assert.equal(shapeOf(pick(state(), { shape: 'share' }).directive), 'share');
  // The presence case is still a share turn: every kind closed changes what she may do and not what
  // kind of turn it was.
  assert.equal(shapeOf(pick(state(), { shape: 'share', affect: { ...OPEN, hooks: 'none' } }).directive), 'share');
});

// ══ 6. The quiet law ═════════════════════════════════════════════════════════

test('quietViolation catches a hook, a second bubble, and a long one', () => {
  const short = ['fair'];
  assert.equal(quietViolation(undefined, short), false);
  for (const w of HOOK_WORDS) {
    assert.equal(quietViolation(w, short), true, `${w} on a quiet turn is a violation`);
  }
  assert.equal(quietViolation(undefined, ['fair', 'or dont']), true, 'more than one bubble');
  const atCap = Array.from({ length: QUIET_MAX_WORDS }, (_, i) => `w${i}`).join(' ');
  assert.equal(quietViolation(undefined, [atCap]), false, 'the cap itself is fine');
  assert.equal(quietViolation(undefined, [`${atCap} more`]), true, 'one word past it is not');
  // Whitespace is not words: a padded short line is still a short line.
  assert.equal(quietViolation(undefined, ['  fair\n\n  ']), false);
  // Silence and a bare tapback are both legal quiet replies, and neither sends a bubble.
  assert.equal(quietViolation(undefined, []), false);
  assert.equal(quietViolation(undefined, ['']), false);
});

// ══ 7. The rendered section ══════════════════════════════════════════════════

const HOOK_DIRECTIVE: HookDirective = {
  idle: true, mode: 'hook', forbidden: [], lateNight: false, moments: false, offerAllowed: true,
};

// THE no-regression pin: on the turns that are actually work the block is not merely short, it is
// absent — the prompt is byte-identical to an install that never had a hook engine.
test('a task turn renders not one byte', () => {
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, idle: false, mode: 'task', offerAllowed: false }), '');
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, mode: 'task' }, ['a moment']), '');
});

test('the hook block renders char-for-char', () => {
  assert.equal(renderHooksSection(HOOK_DIRECTIVE), [
    '## This turn may carry one hook (INTERNAL)',
    'They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.',
    'Open to you this turn: a judgment, a callback, a tangent or a question. One of them, never two, never a kind not named here.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

// The other two variants of the hook block, char-for-char, so all nine pasted constants are pinned
// to a literal somewhere in this file rather than to themselves. `includes(CONSTANT)` is a tautology
// over the constant's own value: it proves the renderer used the constant and says nothing at all
// about whether the constant still matches the staging prose. threads.test.ts pins every rendered
// block this way and this file is written to that precedent.
test('the every-kind-spoken-for block, with the late line, renders char-for-char', () => {
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, forbidden: [...HOOK_WORDS], lateNight: true }), [
    '## This turn may carry one hook (INTERNAL)',
    'They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.',
    'No kind is open this turn. Short and flat, and let the beat pass.',
    'It is late where they are: one short bubble, or a tapback, and nothing heavy. Same rules as any idle turn, at a lower volume, and never the line you sent them last night.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

test('the moments block renders char-for-char', () => {
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, moments: true }, ['the volcano week']), [
    '## This turn may carry one hook (INTERNAL)',
    'They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.',
    'Open to you this turn: a judgment, a callback, a tangent or a question. One of them, never two, never a kind not named here.',
    'Kept about them, in case a callback fits. Retell one in fresh words, never read it out, never its date, never more than one.',
    'the volcano week',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

test('only the ALLOWED kinds are named — what is off the table is never spoken', () => {
  const one = renderHooksSection({ ...HOOK_DIRECTIVE, forbidden: ['judgment', 'tangent', 'question'] });
  assert.match(one, /^Open to you this turn: a callback\. /m);
  const two = renderHooksSection({ ...HOOK_DIRECTIVE, forbidden: ['judgment'] });
  assert.match(two, /^Open to you this turn: a callback, a tangent or a question\. /m);
  assert.doesNotMatch(two, /judgment/, 'naming what is forbidden is an instruction to think about it');
  const none = renderHooksSection({ ...HOOK_DIRECTIVE, forbidden: [...HOOK_WORDS] });
  assert.ok(none.includes(HOOK_NONE_OPEN), 'every kind spoken for still renders a block');
  assert.doesNotMatch(none, /judgment|callback|tangent/);
});

test('the late line rides along on a hook turn, and the quiet block never needs it', () => {
  const late = renderHooksSection({ ...HOOK_DIRECTIVE, lateNight: true });
  assert.ok(late.includes(HOOK_LATE_LINE));
  assert.ok(late.includes(HOOK_OPEN_LINE.replace('{kinds}', 'a judgment, a callback, a tangent or a question')),
    'the register line rides UNDER the open line — it does not replace it');
  assert.ok(late.endsWith(HOOK_CLAMP), 'the clamp stays last');
  const quiet = renderHooksSection({ ...HOOK_DIRECTIVE, mode: 'quiet', lateNight: true, offerAllowed: false });
  assert.equal(quiet.includes(HOOK_LATE_LINE), false, 'a quiet turn is already the quiet reply');
  // The whole point of the redesign: no rendered shape of this section tells her to send them to bed.
  // Every mode that renders a block, the share turn included: the register is the one thing the clock
  // is allowed to change, and it is not allowed to change it into content.
  for (const mode of ['hook', 'quiet', 'share'] as const) {
    for (const lateNight of [false, true]) {
      const block = renderHooksSection({ ...HOOK_DIRECTIVE, mode, lateNight, moments: false });
      assert.doesNotMatch(block, /sleep/i, `${mode}/${lateNight} named sleep`);
    }
  }
});

test('the quiet block renders char-for-char', () => {
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, mode: 'quiet', offerAllowed: false }), [
    '## This turn is quiet (INTERNAL)',
    'Your weather says so, or you have been sharp three times running with nothing left to hand them. One plain short bubble, or a tapback, or nothing. No hook, no question, no offer. Do not explain the quiet.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

// ── the share block ─────────────────────────────────────────────────────────
//
// The fourth contract's own block, and the one whose every variant is pinned to a literal here: it
// mirrors the hook block line for line and shares not one const with it, so a paste that drifted
// (the hook lead says nothing of theirs comes back; the share lead says the opposite) would render
// a turn that contradicts its own heading. THE LAW THIS BLOCK ALONE CARRIES: no shape of it reads as
// permission to send nothing. A quiet turn may be a tapback and a closed-kinds hook turn may let the
// beat pass; a share turn answered with silence is the receipt the whole shape exists to refuse.

const SHARE_DIRECTIVE: HookDirective = {
  idle: false, mode: 'share', forbidden: [], heavy: false, lateNight: false, moments: false, offerAllowed: true,
};

test('the share block renders char-for-char, and names the fourth kind last', () => {
  assert.equal(renderHooksSection(SHARE_DIRECTIVE), [
    '## This turn is a share (INTERNAL)',
    'They handed you something and asked for nothing. A receipt turns it away; the reply turns toward it, one move about the thing itself.',
    'Open to you this turn: a judgment, a callback, a tangent or a question. One of them, never two, and it is the reply, not a beat after one.',
    'The question, if you take it, asks for the one part only they know, built on their last message, never their own words handed back. Something of yours first when they wrote more than a line.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

// The compiled ceiling's render (affectCompiler.ts `compileQuestionGate`), and the dose rule's: the
// kind is out of the sentence AND the line that says what a follow-up is goes with it. A ban she
// reads is a kind she is thinking about, so a closed question is an absence and never a negation.
test('a closed question leaves the block three kinds and no question line', () => {
  assert.equal(renderHooksSection({ ...SHARE_DIRECTIVE, forbidden: ['question'] }), [
    '## This turn is a share (INTERNAL)',
    'They handed you something and asked for nothing. A receipt turns it away; the reply turns toward it, one move about the thing itself.',
    'Open to you this turn: a judgment, a callback or a tangent. One of them, never two, and it is the reply, not a beat after one.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

// WEIGHT, rendered: a judgment on a heavy share is analysis and a tangent walks away from the thing
// they just put down, so what is named is the callback and the question — the two moves that stay
// with them — and the question line rides along because the ceiling left the kind open.
test('a heavy share names the two moves that stay with them', () => {
  assert.equal(renderHooksSection({ ...SHARE_DIRECTIVE, heavy: true, forbidden: ['judgment', 'tangent'] }), [
    '## This turn is a share (INTERNAL)',
    'They handed you something and asked for nothing. A receipt turns it away; the reply turns toward it, one move about the thing itself.',
    'Open to you this turn: a callback or a question. One of them, never two, and it is the reply, not a beat after one.',
    'The question, if you take it, asks for the one part only they know, built on their last message, never their own words handed back. Something of yours first when they wrote more than a line.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
});

// THE PRESENCE CASE, with the register line under it. Every kind spoken for — a flat mood closes all
// four at once — and the block still says what the reply IS rather than what it is spared. The hook
// block's answer to the same shape ("let the beat pass") is the one answer this turn may not give,
// which is why the two none-open lines are two constants.
test('the presence case still tells her to speak, and takes the late register', () => {
  assert.equal(renderHooksSection({ ...SHARE_DIRECTIVE, forbidden: [...HOOK_WORDS], lateNight: true }), [
    '## This turn is a share (INTERNAL)',
    'They handed you something and asked for nothing. A receipt turns it away; the reply turns toward it, one move about the thing itself.',
    'No kind is open this turn. Take what they said plainly, one short bubble about the thing itself, and stop.',
    'It is late where they are: one short bubble and nothing heavy. Same move, lower volume.',
    'Never mention notes, memory, a read you were handed, or that you were told which kind to use.',
  ].join('\n'));
  // No variant of this block, however narrow, offers her the exit the other two modes have.
  for (const forbidden of [[], ['question'], ['judgment', 'tangent'], [...HOOK_WORDS]] as HookWord[][]) {
    for (const lateNight of [false, true]) {
      const block = renderHooksSection({ ...SHARE_DIRECTIVE, forbidden, lateNight });
      const why = `${forbidden.length} kinds closed, lateNight=${lateNight}`;
      assert.equal(block.includes(HOOK_NONE_OPEN), false, `${why}: the hook block's exit`);
      assert.equal(block.includes(QUIET_LAW), false, `${why}: the quiet law`);
      assert.doesNotMatch(block, /let the beat pass|tapback/, `${why}: read as permission to send nothing`);
      assert.ok(block.endsWith(HOOK_CLAMP), `${why}: the clamp is last in every share variant too`);
    }
  }
});

// The register rides UNDER the move the block named and never in place of it — the same shape the
// hook late line has, and the reason the clock is not a branch anywhere in this file.
test('the late line lowers the volume of a share turn and picks none of it', () => {
  const late = renderHooksSection({ ...SHARE_DIRECTIVE, lateNight: true });
  assert.equal(late, `${renderHooksSection(SHARE_DIRECTIVE).replace(`\n${HOOK_CLAMP}`, '')}\n${SHARE_LATE_LINE}\n${HOOK_CLAMP}`);
  assert.equal(late.includes(HOOK_LATE_LINE), false, 'and it is the share line, not the hook one');
});

// The two blocks share no prose. Pinned as a sweep rather than as a comment because the failure is
// invisible in a diff of one file: a share turn rendering "They sent you nothing" contradicts its own
// heading, and the cheapest way to get there is a paste from the block above.
test('the share block and the hook block share no line but the clamp', () => {
  const share = renderHooksSection(SHARE_DIRECTIVE).split('\n');
  const hook = renderHooksSection({ ...HOOK_DIRECTIVE, lateNight: true }).split('\n');
  const shared = share.filter(l => hook.includes(l));
  assert.deepEqual(shared, [HOOK_CLAMP], 'one sentence twice, at two distances from the recency edge');
});

// A moment rides out as a callback about something OLD, and this turn has something of theirs in
// front of her. The selector never sets the flag on a share turn; the block has no lead to render it
// under either, so a hand-built directive that says otherwise still gets no diary read out.
test('the share block never reads out a moment, whatever it is handed', () => {
  const lines = ['the volcano week'];
  assert.equal(
    renderHooksSection({ ...SHARE_DIRECTIVE, moments: true }, lines),
    renderHooksSection(SHARE_DIRECTIVE),
  );
  assert.equal(renderHooksSection({ ...SHARE_DIRECTIVE, moments: true }, lines).includes(MOMENTS_LEAD), false);
});

// The DIRECTIVE gates the moments, not the caller: one gate, in one place, and it is the one the
// receipt reports.
test('moments render only when the directive allowed them', () => {
  const lines = ['the volcano week', 'the shed that never got built'];
  const on = renderHooksSection({ ...HOOK_DIRECTIVE, moments: true }, lines);
  assert.ok(on.includes(MOMENTS_LEAD));
  for (const l of lines) assert.ok(on.includes(l));
  assert.ok(on.endsWith(HOOK_CLAMP), 'the clamp is last even with moments in the block');

  const off = renderHooksSection({ ...HOOK_DIRECTIVE, moments: false }, lines);
  assert.equal(off.includes(MOMENTS_LEAD), false);
  for (const l of lines) assert.equal(off.includes(l), false, 'a sample handed in against the gate is dropped');

  // No moments to sample is not an empty heading with nothing under it.
  assert.equal(renderHooksSection({ ...HOOK_DIRECTIVE, moments: true }, ['', '   ']).includes(MOMENTS_LEAD), false);
});

// A number in the prompt is a thing to reason about and optimize; a register is a thing to speak in.
// (Moment lines are model-authored prose and legitimately carry digits — their own words for their
// own week — so the pin is on the consts, and on a render with nothing interpolated.)
test('not one digit anywhere in the prose consts', () => {
  const consts = {
    HOOK_CLAMP, HOOK_HEADING, HOOK_LEAD, HOOK_OPEN_LINE, HOOK_NONE_OPEN, HOOK_LATE_LINE,
    MOMENTS_LEAD, QUIET_HEADING, QUIET_LAW,
    SHARE_HEADING, SHARE_LEAD, SHARE_OPEN_LINE, SHARE_QUESTION_LINE, SHARE_NONE_OPEN, SHARE_LATE_LINE,
    ...Object.fromEntries(Object.entries(LOOSE_LEVEL_LINES).map(([k, v]) => [`LOOSE_${k}`, v])),
  };
  for (const [name, line] of Object.entries(consts)) {
    assert.doesNotMatch(line, /\d/, `${name} leaked a number into the prompt`);
    assert.doesNotMatch(line, /streak|ledger|kill switch|idle turns since/i, `${name} named an internal counter`);
  }
  const forbiddenSets: HookWord[][] = [[], ['judgment'], [...HOOK_WORDS]];
  for (const forbidden of forbiddenSets) {
    for (const lateNight of [false, true]) {
      for (const mode of ['hook', 'quiet', 'share'] as const) {
        const block = renderHooksSection({ ...HOOK_DIRECTIVE, mode, forbidden, lateNight, moments: true });
        assert.doesNotMatch(block, /\d/, `${mode} block leaked a number`);
        // Every block ends on the same clamp: the one unrecoverable failure of this feature is her
        // telling someone she keeps notes on them, or that something told her what to say.
        assert.ok(block.endsWith(HOOK_CLAMP), 'the clamp is always last');
      }
    }
  }
  // A moment carrying digits still renders them: the sampler, not the prose, is the guard.
  const withDigits = renderHooksSection({ ...HOOK_DIRECTIVE, moments: true }, ['the 3am deploy']);
  assert.match(withDigits, /the 3am deploy/);
});

// ══ 8. Looseness rendering ═══════════════════════════════════════════════════

// The per-turn English looseness signal: rendered before the play level, absent at level one (the
// normal baseline costs nothing), present at all other levels. Undefined also renders nothing, so
// test constants that omit the field keep their char-for-char pinned sections unchanged.
test('looseness level one and undefined render no line', () => {
  const block = renderHooksSection({ ...HOOK_DIRECTIVE, englishLooseness: 1 });
  assert.equal(block.includes('English'), false, 'level one is the baseline: no line');
  const blockUndef = renderHooksSection({ ...HOOK_DIRECTIVE });
  assert.equal(blockUndef.includes('English'), false, 'absent also renders nothing');
  assert.deepEqual(block, blockUndef, 'undefined and one are the same output');
});

test('looseness levels zero, two, three each render their line before the play level', () => {
  for (const [looseness, frag] of [
    [0, 'careful'] as const,
    [2, 'loose'] as const,
    [3, 'messy'] as const,
  ]) {
    const block = renderHooksSection({ ...HOOK_DIRECTIVE, englishLooseness: looseness });
    assert.ok(block.includes(LOOSE_LEVEL_LINES[looseness]), `level ${looseness} renders its line`);
    // Looseness line precedes the clamp (which is always last).
    const looseIdx = block.indexOf('English');
    const clampIdx = block.indexOf(HOOK_CLAMP);
    assert.ok(looseIdx < clampIdx, `level ${looseness}: looseness line before clamp`);
  }
});

test('looseness line renders on quiet and share turns too', () => {
  const quiet = renderHooksSection({ ...HOOK_DIRECTIVE, mode: 'quiet', offerAllowed: false, englishLooseness: 2 });
  assert.ok(quiet.includes(LOOSE_LEVEL_LINES[2]), 'quiet turn also gets the looseness signal');
  const share = renderHooksSection({ ...SHARE_DIRECTIVE, englishLooseness: 3 });
  assert.ok(share.includes(LOOSE_LEVEL_LINES[3]), 'share turn also gets the looseness signal');
});

// ══ 9. Purity ════════════════════════════════════════════════════════════════

test('selectHook and recordHook are pure: frozen inputs survive, same in same out', () => {
  const before = deepFreeze(state({ lastKinds: ['none', 'judgment', 'judgment'], idleStreak: 3, idleSinceMoment: 9 }));
  const a = pick(before, { affect: { ...OPEN, hooks: 'no_tangent', lateNight: true } });
  const b = pick(before, { affect: { ...OPEN, hooks: 'no_tangent', lateNight: true } });
  assert.deepEqual(a.directive, b.directive);
  assert.deepEqual(a.report, b.report);
  assert.notEqual(a.report.lastKinds, before.lastKinds, 'the receipt gets its own array');
  // The share branch is the same function under the same rule: one state in, two identical readings.
  const shareA = pick(before, { shape: 'share', affect: { ...OPEN, heavy: true } });
  const shareB = pick(before, { shape: 'share', affect: { ...OPEN, heavy: true } });
  assert.deepEqual(shareA.directive, shareB.directive);
  assert.deepEqual(shareA.report, shareB.report);

  const next = recordHook(before, 'callback', 'idle', true, T0 + 10);
  assert.deepEqual(next.lastKinds, ['judgment', 'judgment', 'callback']);
  assert.deepEqual(before.lastKinds, ['none', 'judgment', 'judgment'], 'the input was not touched');
  assert.equal(before.idleSinceMoment, 9);
});

// ══ 10. Push turns ═══════════════════════════════════════════════════════════

test('a push turn: PUSH_PERCENT of turns carry it, never in a room, on a heavy share, a slip, or a task', () => {
  // A hundred consecutive seconds visit every residue of the draw once.
  const nows = Array.from({ length: 100 }, (_, i) => T0 + i * 1000);
  const at = (n: number, over: { shape?: TurnKind; affect?: HookAffectInput; isGroup?: boolean } = {}) =>
    selectHook(state(), over.shape ?? 'idle', 'fast_path', over.affect ?? OPEN, over.isGroup ?? false, n);
  const pushed = nows.filter(n => at(n).directive.push);
  assert.equal(pushed.length, PUSH_PERCENT);
  const n = pushed[0];
  assert.equal(at(n).report.push, true, 'the receipt says so');
  assert.equal(at(n, { shape: 'share' }).directive.push, true);
  assert.equal(at(n, { shape: 'share', affect: { ...OPEN, heavy: true } }).directive.push, undefined, 'weight gets company');
  assert.equal(at(n, { isGroup: true }).directive.push, undefined, 'never in a room');
  assert.equal(at(n, { affect: { ...OPEN, slip: 'tired' } }).directive.push, undefined, 'a slip already has the move');
  assert.equal(at(n, { shape: 'task' }).directive.push, undefined);

  assert.ok(renderHooksSection(at(n).directive).includes(PUSH_LINE));
  assert.ok(!renderHooksSection(at(nows.find(x => !pushed.includes(x))!).directive).includes(PUSH_LINE));
  assert.ok(renderDriftAnchor('hook', 0, undefined, true).endsWith(PUSH_BULLET));
  assert.ok(renderDriftAnchor('share', 0, undefined, true).endsWith(PUSH_BULLET));
  assert.ok(!renderDriftAnchor('quiet', 0, undefined, true).includes(PUSH_BULLET));
  assert.ok(!renderDriftAnchor('task', 0, undefined, true).includes(PUSH_BULLET));
});

// ══ 11. Quizzes ═══════════════════════════════════════════════════════════════

test('a quiz is refused, the push right after it is answered annoyed, and the clock lapses', () => {
  const quiz = selectHook(state(), 'task', 'classify', OPEN, false, T0, false, true).directive;
  assert.ok(quiz.quiz === 'refuse' || quiz.quiz === 'roast');
  assert.equal(quiz.mode, 'task');
  // A hundred consecutive seconds visit every residue of the draw once: the split is the constant.
  const roasts = Array.from({ length: 100 }, (_, i) => selectHook(state(), 'task', 'classify', OPEN, false, T0 + i * 1000, false, true).directive.quiz)
    .filter(q => q === 'roast').length;
  assert.equal(roasts, QUIZ_ROAST_PERCENT);
  const after = recordHook(state(), undefined, 'task', false, T0, 'refused');
  assert.equal(after.quizzedAt, T0);
  // The next task inside the window is a push, whether it is the same quiz again or a just answer.
  assert.equal(selectHook(after, 'task', 'classify', OPEN, false, T0 + 60_000, false, true).directive.quizPushed, true);
  assert.equal(selectHook(after, 'task', 'veto', OPEN, false, T0 + 60_000).directive.quizPushed, true);
  // A laugh in between is not a push, and neither is a task after the window.
  assert.equal(selectHook(after, 'idle', 'fast_path', OPEN, false, T0 + 60_000).directive.quizPushed, undefined);
  assert.equal(selectHook(after, 'task', 'veto', OPEN, false, T0 + QUIZ_PUSH_MS).directive.quizPushed, undefined);
  // Giving in clears it.
  assert.equal(recordHook(after, undefined, 'task', false, T0 + 60_000, 'pushed').quizzedAt, undefined);
  assert.equal(recordHook(after, undefined, 'idle', false, T0 + 60_000).quizzedAt, T0);
});
