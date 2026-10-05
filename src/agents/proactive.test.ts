// Run with: npm test   (TZ=UTC DATA_BACKEND=memory tsx --test)
// The proactive voicer: the shape of the instruction the Composer gets (branch mark first, payload
// last), the byte-pin between PROACTIVE_MARK and the persona's branch trigger, and the guarantee
// that a proactive message NEVER goes silent — with no voice model reachable, the Fallfirm floor
// still carries the substance.
process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROACTIVE_MARK, INTRODUCTION_MARK, CHECKIN_PAYLOAD, fallfirmOutcomeFor, voiceProactive, _internal, type ProactiveKind, type ProactiveContinuity } from './proactive.js';
import { fallfirmFloor } from './fallfirm/floor.js';
import { resetStorageForTests, stmt } from '../db/sqlite.js';
import { insertPending } from '../db/repositories/proactive.js';
import { saveThreadInventory } from '../db/repositories/threadInventory.js';
import { defaultThreadInventory, type ThreadTheme } from '../persona/threads.js';
import { groupHandle } from '../memory/identity.js';

// The six kinds that arrive INTO a thread. `introduction` is the odd one out end to end — a second
// mark, no orientation beat, no colour — and has its own section at the bottom.
const KINDS: ProactiveKind[] = ['reminder', 'email', 'memo', 'update', 'callback', 'checkin'];

beforeEach(() => resetStorageForTests());
afterEach(() => { delete process.env.CONVO_THREADING_ENABLED; });

test('the persona branch trigger is byte-identical to PROACTIVE_MARK', () => {
  const persona = readFileSync(join(__dirname, 'composer', 'Context.md'), 'utf8');
  assert.ok(
    persona.includes(PROACTIVE_MARK),
    'composer/Context.md must carry the exact PROACTIVE_MARK phrase — the branch is keyed on the surface form',
  );
});

test('the instruction opens on the branch mark and ends on the payload', () => {
  for (const kind of KINDS) {
    const text = `the ${kind} substance, verbatim`;
    const instruction = _internal.buildProactiveInstruction({ kind, text });
    assert.ok(instruction.startsWith(PROACTIVE_MARK), `${kind}: the mark leads`);
    assert.ok(instruction.trimEnd().endsWith(`"${text}"`), `${kind}: the facts are the last thing read`);
    // The fidelity contract is restated per turn, not left to the persona alone.
    assert.match(instruction, /only place your facts come from/);
    assert.match(instruction, /voice, register and continuity ONLY/);
  }
});

test('caller framing rides between the kind framing and the facts', () => {
  const instruction = _internal.buildProactiveInstruction({
    kind: 'update', text: 'now on build abc1234', framing: 'you just came back from an upgrade',
  });
  const framingAt = instruction.indexOf('you just came back from an upgrade');
  const factsAt = instruction.indexOf('now on build abc1234');
  assert.ok(framingAt > 0 && factsAt > framingAt, 'framing first, facts last');
});

test('each kind is pointed at its own moment, and none of them names machinery', () => {
  for (const kind of KINDS) {
    const instruction = _internal.buildProactiveInstruction({ kind, text: 'x' });
    // The check-in places nothing: it keeps no score of what went unanswered, so it has no beat to orient.
    if (kind !== 'checkin') assert.match(instruction, /orient|placing|first beat/, `${kind}: the orientation beat is asked for`);
    assert.doesNotMatch(instruction, /\bcron\b|\bjob\b|\bengine\b|\bwebhook\b/i);
  }
});

// The callback is the odd one out: every other kind hands something OVER, this one asks. The framing
// has to buy that exception without buying an invented answer along with it.
test('the callback framing asks, once, and claims to know nothing', () => {
  const instruction = _internal.buildProactiveInstruction({
    kind: 'callback', text: '"the interview" — the thing on thursday she was dreading',
  });
  assert.match(instruction, /just you asking how it went/);
  assert.match(instruction, /the question itself, once, flat/);
  // The one hook this text is allowed to carry, named as a hook (persona/hooks.ts HOOK_WORDS).
  assert.match(instruction, /it is a callback: the one hook this text carries/);
  assert.match(instruction, /you don't know how it went; that is exactly why you're asking/);
  // The kind-specific fidelity line rides between the generic clause and the payload.
  const genericAt = instruction.indexOf('the line below is the only place your facts come from');
  const specificAt = instruction.indexOf('the line below is the thread itself');
  const payloadAt = instruction.indexOf("what you're delivering:");
  assert.ok(genericAt > 0 && specificAt > genericAt && payloadAt > specificAt,
    'generic fidelity, then the thread-specific one, then the facts');
  assert.match(instruction, /nothing gets guessed, assumed, or hoped into a fact/);
});

// It is kind-SPECIFIC on purpose: telling the model it holds no news about news it is literally
// carrying is how a reminder or a mail flag gets hedged into uselessness.
test('the no-outcome line belongs to the callback alone', () => {
  for (const kind of KINDS) {
    const instruction = _internal.buildProactiveInstruction({ kind, text: 'x' });
    const present = instruction.includes('the line below is the thread itself');
    assert.equal(present, kind === 'callback', `${kind}: fidelity line presence`);
  }
});

// Byte-pins on the two instructions with the tightest fidelity contract in the engine — the user's
// own setups. Adding a fifth kind must not have moved a word of either.
test('the reminder and email instructions are untouched by the new kind', () => {
  assert.equal(
    _internal.buildProactiveInstruction({ kind: 'reminder', text: 'pick up the dry cleaning by 6' }),
    [
      PROACTIVE_MARK,
      'a reminder they set with you earlier just came due — orient them first (one short beat that ties this text to what they asked you to flag), then deliver it, flat and brief, like you remembered on your own',
      'the line below is the only place your facts come from. the thread above is there for voice, register and continuity ONLY — never for content, never as a second source. if the thread and this line disagree, this line wins, silently, with no mention of the difference. nothing here gets rounded, filled in, or guessed at: if a detail is not below, it does not exist.',
      'what you\'re delivering:\n"pick up the dry cleaning by 6"',
    ].join('\n\n'),
  );
  assert.match(
    _internal.buildProactiveInstruction({ kind: 'email', text: 'karen sent the lease back' }),
    /^\(no one texted you, this one starts with you\)\n\nsomething just landed in their email/,
  );
});

// ── Continuity colouring (phase G) ───────────────────────────────────────────────────
// A standing thread may TINT a proactive turn. It is the loosest thing in a file whose whole
// subject is fidelity, so every test below is really about where it is NOT allowed to go.

const CONTINUITY = /a standing thread you and they share, for voice only/;
const THREAD: ProactiveContinuity = { label: 'speed vs craft', note: 'she keeps trading one for the other and minding it' };
const CH = '+15551230042';

/** A theme that has earned standing — taggable, seen this week. `topStandingThread` asks for
 *  nothing else. */
function theme(patch: Partial<ThreadTheme> = {}): ThreadTheme {
  const now = Date.now();
  return {
    id: 't1', label: THREAD.label, kind: 'tension', note: THREAD.note,
    evidenceDays: [1, 2], evidenceCount: 2, status: 'taggable', confidence: 55,
    firstSeenAt: now - 20 * 86400000, lastSeenAt: now - 86400000,
    lastOfferedAt: 0, lastTaggedAt: 0, lastOutcome: null, soreAt: 0,
    uptakes: 0, passes: 0, pushbacks: 0, mintedDistressed: false,
    ...patch,
  };
}

test('the colour rides the three kinds she shapes, never the two the user set up', () => {
  for (const kind of KINDS) {
    // A callback whose payload is a DIFFERENT thread — the redundancy case has its own test.
    const instruction = _internal.buildProactiveInstruction({ kind, text: '"the interview" — thursday' }, THREAD);
    const expected = kind === 'memo' || kind === 'update' || kind === 'callback';
    assert.equal(CONTINUITY.test(instruction), expected, `${kind}: continuity presence`);
  }
  // And with no candidate, nothing is inserted anywhere.
  for (const kind of KINDS) {
    assert.doesNotMatch(_internal.buildProactiveInstruction({ kind, text: 'x' }, null), CONTINUITY, `${kind}: null candidate`);
    assert.doesNotMatch(_internal.buildProactiveInstruction({ kind, text: 'x' }), CONTINUITY, `${kind}: absent candidate`);
  }
});

test('the colour carries the thread verbatim, above the fidelity clause and below the framing', () => {
  const instruction = _internal.buildProactiveInstruction(
    { kind: 'memo', text: 'the lease comparison came back', framing: 'you finished it just now' },
    THREAD,
  );
  assert.ok(instruction.includes(
    'a standing thread you and they share, for voice only — "speed vs craft": she keeps trading one for the other and minding it. '
    + 'if what you are delivering naturally touches it, one dry half-line may nod to it as a callback; it adds no fact, changes no fact, '
    + 'and is dropped without a trace when it does not fit.',
  ), 'the line is pinned word for word');
  const framingAt = instruction.indexOf('you finished it just now');
  const colourAt = instruction.search(CONTINUITY);
  const fidelityAt = instruction.indexOf('the line below is the only place your facts come from');
  const factsAt = instruction.indexOf("what you're delivering:");
  assert.ok(framingAt > 0 && colourAt > framingAt && fidelityAt > colourAt && factsAt > fidelityAt,
    'framing, colour, fidelity, facts — the payload still reads last');
  assert.ok(instruction.trimEnd().endsWith('"the lease comparison came back"'));
});

// A callback's payload IS a thread. Handing the model the same one twice is noise at best and a
// second source at worst, so the colour steps aside when the labels match.
test('a callback never nods to the thread it is already about', () => {
  const same = _internal.buildProactiveInstruction(
    { kind: 'callback', text: `"${THREAD.label}" — the thing she keeps circling` }, THREAD,
  );
  assert.doesNotMatch(same, CONTINUITY, 'same label → no second copy of the thread');
  // Whitespace and case are not a difference; a genuinely different loop is.
  assert.doesNotMatch(
    _internal.buildProactiveInstruction({ kind: 'callback', text: '"  Speed   vs Craft " — same thing, typed loosely' }, THREAD),
    CONTINUITY,
  );
  assert.match(
    _internal.buildProactiveInstruction({ kind: 'callback', text: '"the interview" — the thing on thursday' }, THREAD),
    CONTINUITY,
    'a different loop still gets the colour',
  );
});

test('the pre-read finds a standing thread, and degrades to nothing everywhere else', async () => {
  assert.equal(await _internal.readContinuity(CH), null, 'no inventory at all → no colour');

  await saveThreadInventory(CH, { ...defaultThreadInventory(), themes: [theme()] });
  assert.deepEqual(await _internal.readContinuity(CH), THREAD);

  // The flag gates this read as it gates the reply path: off means byte-identical to no feature.
  process.env.CONVO_THREADING_ENABLED = 'false';
  assert.equal(await _internal.readContinuity(CH), null, 'flag off → no colour');
  delete process.env.CONVO_THREADING_ENABLED;

  // No identity resolved (a cold push), and rooms — no personal theme is ever read into a group.
  assert.equal(await _internal.readContinuity(''), null);
  const room = groupHandle('web:room');
  await saveThreadInventory(room, { ...defaultThreadInventory(), themes: [theme()] });
  assert.equal(await _internal.readContinuity(room), null, 'group handle → no colour');

  // An inventory with themes but none STANDING (still open, never twice-evidenced) is empty here.
  await saveThreadInventory(CH, { ...defaultThreadInventory(), themes: [theme({ status: 'open' })] });
  assert.equal(await _internal.readContinuity(CH), null, 'nothing has earned standing yet');
});

// ── the first text ever (introduction) ───────────────────────────────────────────────
// The one proactive with nothing above it: no setup of theirs came due, no thread runs over it, and
// the person on the other end has never heard from her. Everything below is about the second mark
// being the only thing that says so.

test('the persona first-move trigger is byte-identical to INTRODUCTION_MARK', () => {
  const persona = readFileSync(join(__dirname, 'composer', 'Context.md'), 'utf8');
  assert.ok(
    persona.includes(INTRODUCTION_MARK),
    "composer/Context.md must carry the exact INTRODUCTION_MARK phrase — the \"when it's the very first text ever\" section is keyed on the surface form",
  );
});

test('the introduction stacks its own mark on the line under the proactive one', () => {
  const text = '- keeps orchids alive\n- calls the car the tank';
  const instruction = _internal.buildProactiveInstruction({ kind: 'introduction', text });
  assert.ok(instruction.startsWith(`${PROACTIVE_MARK}\n${INTRODUCTION_MARK}`), 'both marks, in that order, before anything else');
  // The framing, pinned: no orientation beat, the nicknames, two details and ONE flat judgment made
  // out of them, and the line that keeps a seeded profile from reading like a file was opened.
  assert.match(instruction, /you're texting them first, ever/);
  assert.match(instruction, /no orientation beat: nothing was set up, there's nothing to place/);
  assert.match(instruction, /they can call you Iris or Ilish or Lish, your words, never a form/);
  assert.match(instruction, /pick TWO at most, make ONE flat judgment out of them/);
  assert.match(instruction, /never their name even if you hold it, never 'i was told'/);
  // And the payload still reads last, like every other kind.
  assert.ok(instruction.trimEnd().endsWith(`"${text}"`));
});

test('the first-text mark belongs to the introduction alone', () => {
  for (const kind of KINDS) {
    assert.ok(
      !_internal.buildProactiveInstruction({ kind, text: 'x' }).includes(INTRODUCTION_MARK),
      `${kind}: a thread already exists — the second mark would be a lie`,
    );
  }
});

// She has never spoken to this person: there is no thread to nod to, and the seeded profile in the
// payload is the only thing she holds. A colour line here would be a second source out of nowhere.
test('no thread ever colours the first text, even when one is handed in', () => {
  const instruction = _internal.buildProactiveInstruction({ kind: 'introduction', text: '- keeps orchids alive' }, THREAD);
  assert.doesNotMatch(instruction, CONTINUITY);
  assert.ok(!instruction.includes(THREAD.label), 'not the label either, in any wording');
});

test('at the floor the introduction is still an introduction', () => {
  const outcome = fallfirmOutcomeFor({ kind: 'introduction', text: '(no details — newly acquainted)' });
  assert.match(outcome.summary, /introducing yourself for the very first time/);
  assert.match(outcome.summary, /they can call you Iris or Lish, one flat line, then stop/);
  assert.equal(outcome.facts, '(no details — newly acquainted)');
});

test('the Fallfirm degrade carries the substance in facts, the framing in summary', () => {
  const outcome = fallfirmOutcomeFor({ kind: 'email', text: 'karen sent the lease back', framing: 'it looked urgent' });
  assert.equal(outcome.kind, 'confirmed');
  assert.equal(outcome.facts, 'karen sent the lease back');
  assert.match(outcome.summary, /their email/);
  assert.match(outcome.summary, /it looked urgent/);
});

// Even at the floor the callback stays a question, not an announcement about a thing she knows.
test('the callback degrades to a check-in, never to a delivery', () => {
  const outcome = fallfirmOutcomeFor({ kind: 'callback', text: '"the interview" — thursday' });
  assert.match(outcome.summary, /checking in on something you two keep coming back to/);
  assert.match(outcome.summary, /one flat question, and stop/);
  assert.equal(outcome.facts, '"the interview" — thursday');
});

test('with no voice model configured, the floor still lands with the substance', async (t) => {
  // Mirrors the enginePush push-delivery convention: in a key-less test env every voicer call fails
  // fast, so this exercises the whole ladder — Composer (two attempts) → Fallfirm → floor.
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY) {
    t.skip('a voice model is configured in this environment — the floor path is unreachable here');
    return;
  }
  const payload = { kind: 'reminder' as const, text: 'pick up the dry cleaning by 6' };
  const text = await voiceProactive(payload, 'web:a', '');
  assert.equal(text, fallfirmFloor(fallfirmOutcomeFor(payload)));
  assert.match(text, /pick up the dry cleaning by 6/, 'the thing they were promised still reaches them');
});

// ── Repeating reminders ──────────────────────────────────────────────────────────────
// A reminder is voiced against the reminder texts this chat already heard, so a repeat can lead
// with what changed, and say nothing when nothing did.

test('earlier reminder texts sit above the fidelity clause, with the skip rule and their own contract', () => {
  const earlier = [{ at: Date.parse('2026-09-25T00:02:00Z'), text: 'fires are the big story' }];
  const instruction = _internal.buildProactiveInstruction({ kind: 'reminder', text: 'fires still the big story' }, null, earlier);
  const blockAt = instruction.indexOf('"fires are the big story"');
  const fidelityAt = instruction.indexOf('only place your facts come from');
  assert.ok(blockAt > 0 && fidelityAt > blockAt, 'history before the fidelity clause');
  assert.match(instruction, /what they already heard is old news/);
  assert.match(instruction, /reply with exactly \[\[skip\]\] and nothing else/);
  assert.match(instruction, /nothing from them is said again, except as the before-side of a change/);
  assert.ok(instruction.trimEnd().endsWith('"fires still the big story"'), 'the payload is still read last');
  // Only reminders carry it: another kind handed the same history ignores it.
  assert.doesNotMatch(_internal.buildProactiveInstruction({ kind: 'memo', text: 'x' }, null, earlier), /old news/);
});

test('the pre-read returns this chat\'s delivered reminders, oldest first, six at most', async () => {
  const base = Date.now() - 20 * 86400000;
  for (let i = 0; i < 8; i++) {
    const id = await insertPending({ chatId: CH, kind: 'reminder', text: `brief ${i}`, dedupeKey: `k${i}` });
    stmt("UPDATE proactive_deliveries SET status = 'delivered', created_at = ? WHERE id = ?").run(base + i * 86400000, id);
  }
  await insertPending({ chatId: CH, kind: 'reminder', text: 'being voiced now', dedupeKey: 'now' });
  const memo = await insertPending({ chatId: CH, kind: 'memo', text: 'a memo', dedupeKey: 'm' });
  stmt("UPDATE proactive_deliveries SET status = 'delivered' WHERE id = ?").run(memo);
  const other = await insertPending({ chatId: 'web:other', kind: 'reminder', text: 'another chat', dedupeKey: 'o' });
  stmt("UPDATE proactive_deliveries SET status = 'delivered' WHERE id = ?").run(other);

  const earlier = await _internal.readEarlierReminders(CH);
  assert.deepEqual(earlier.map(r => r.text), ['brief 2', 'brief 3', 'brief 4', 'brief 5', 'brief 6', 'brief 7']);
});

test('the skip mark alone sends nothing; a beat sent with it ships without it', () => {
  assert.equal(_internal.applySkipMark('[[skip]]'), '');
  assert.equal(_internal.applySkipMark('same fires story, nothing moved\n---\n[[skip]]'), 'same fires story, nothing moved');
  assert.equal(_internal.applySkipMark('quiet one today [[skip]]'), 'quiet one today');
  assert.equal(_internal.applySkipMark('no mark here'), 'no mark here');
});

test('the check-in asks once and keeps no score', () => {
  const instruction = _internal.buildProactiveInstruction({ kind: 'checkin', text: CHECKIN_PAYLOAD });
  assert.ok(instruction.startsWith(PROACTIVE_MARK));
  assert.match(instruction, /still want you starting conversations/);
  assert.match(instruction, /no count/);
  assert.ok(instruction.trimEnd().endsWith(`"${CHECKIN_PAYLOAD}"`));
  assert.match(fallfirmOutcomeFor({ kind: 'checkin', text: CHECKIN_PAYLOAD }).summary, /texting first/);
});
