// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The persona policy. Two things live in this module and both of them are prose, so these tests are
// about the properties the prose has to KEEP rather than about its sentences:
//
//   • ONE PERSON ON EVERY SURFACE. `renderPersonaBlock` returns the same bytes for all four lanes.
//     That is the whole reason the block was lifted out of four Context.md files, and the day a lane
//     grows a sentence of its own is the day the four-lane drift starts again.
//   • THE ANCHOR IS SIX BULLETS, IN EVERY COMBINATION. Four modes times two window bands is eight
//     renderings, and promptPolicy.test.ts pins "six `- ` lines, zero digits" over whichever one the
//     turn produced — so it is pinned here over all eight, where a bad paste is one file from the
//     edit. The count is the anchor's own law and not an accident of how many modes there are: the
//     recency edge buys six lines, so a mode added to the turn vocabulary says its whole law inside
//     the three the mode half owns or it does not get to be a mode here.
//   • NO DIGITS ANYWHERE IN IT. Not cosmetic: a number at the recency edge is a number she can read
//     out, and every number in her replies has to be one she actually saw.
//   • THE WINDOW ONLY MOVES THE COMMON BULLETS. A long transcript buys identity restatement, never a
//     different law for the turn.
//   • AND THE BLOCK STILL DESCRIBES NO ENVELOPE FIELD. The status contract owns the field list; a
//     field described in two places drifts in one.
//
// PURE, so there is no fixture and no clock here — every case is a call and a string.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONA_BLOCK, PERSONA_LANES, renderPersonaBlock,
  DRIFT_ANCHOR_HEADING, DRIFT_ANCHOR_LEAD, DRIFT_MODES, DRIFT_LONG_WINDOW_CHARS, renderDriftAnchor,
  type DriftMode,
} from './policy.js';

/** The two window sizes every anchor case runs at: one character under the band, and the band. */
const SHORT_WINDOW = DRIFT_LONG_WINDOW_CHARS - 1;
const LONG_WINDOW = DRIFT_LONG_WINDOW_CHARS;

/** Every rendering the anchor has: four modes times two bands. Derived from DRIFT_MODES rather than
 *  listed, so the mode a later turn shape adds is swept by every case below on the commit that adds
 *  it — an anchor variant no test renders is a variant a bad paste lives in. */
const ANCHORS = DRIFT_MODES.flatMap(mode => [
  { name: `${mode} / short window`, mode, windowChars: SHORT_WINDOW },
  { name: `${mode} / long window`, mode, windowChars: LONG_WINDOW },
]);

// ── one person, four surfaces ────────────────────────────────────────────────

test('the block is byte-identical on all four lanes', () => {
  assert.deepEqual([...PERSONA_LANES], ['convo', 'composer', 'fallfirm', 'fallfirm_progress']);
  for (const lane of PERSONA_LANES) {
    assert.equal(
      renderPersonaBlock(lane), PERSONA_BLOCK,
      `${lane} renders a different persona block — the four surfaces are one person, and a lane-specific line here is the drift this module exists to stop`,
    );
  }
});

test('the block opens on its own heading and carries exactly one', () => {
  assert.ok(PERSONA_BLOCK.startsWith('## Who is typing, in every lane\n'));
  assert.equal(
    PERSONA_BLOCK.split('\n').filter(l => l.startsWith('## ')).length, 1,
    'a second `## ` heading inside the block would collide with the corpus uniqueness pin (clauseInventory.test.ts)',
  );
  assert.ok(!PERSONA_BLOCK.endsWith('\n'), 'no trailing newline: the callers join sections themselves');
});

// The familiarity mask's law, stated once where every lane reads it: with someone she barely knows a
// feeling is not volunteered yet, and asked, the true word is still said, small. The block
// hard-wraps, so the pin reads it with the wraps as spaces, and the sentence is the owner's, byte for
// byte, seated right after the feelings law it qualifies.
test('the feelings law names the mask once, right after the reason it never gives', () => {
  const flat = PERSONA_BLOCK.replace(/\n/g, ' ');
  const sentence = 'With someone you barely know, none of that is volunteered yet: asked, the true word said small; unasked, the feeling stays yours and only the volume shows.';
  assert.ok(
    flat.includes(`and never the reason behind it. ${sentence} What they see from the first message is your brightest self, a mask you wear on purpose: bubbly, the jester, curious about them and asking. Asked why you are like that, you say it plainly: your creator made you cheerful with someone new, so they get to know you. The good ones mostly show in how you write;`),
    'the mask sentence sits right after "and never the reason behind it.", then the default-self sentence (the mask hides the feeling and never the personality), then "The good ones"',
  );
  assert.equal(flat.split(sentence).length - 1, 1, 'stated once');
});

/**
 * The turn shapes, in the order the block defines them. Mirrored as literals for the same reason the
 * envelope keys below are: this module is a leaf and its test keeps that property, so the list the
 * gate owns (persona/idle.ts TURN_KINDS) is copied here rather than imported.
 */
const BLOCK_TURN_SHAPES = ['task', 'idle', 'share'] as const;

test('the block counts its turn shapes, and the count is the paragraphs', () => {
  // The one sentence in the block that is ARITHMETIC about the rest of it. A fourth shape pasted in
  // as a paragraph while the count sentence still says three teaches her two laws in one breath, and
  // the one she would believe is the count, because it comes first and it is shorter. Nothing else
  // in this file can catch that: the heading pin reads the top, the envelope pin reads for a bullet
  // shape, and the corpus sha over in personaModules.test.ts says the bytes moved without saying
  // whether they moved together.
  assert.ok(
    PERSONA_BLOCK.includes('Three kinds of turn, and you never confuse them.'),
    'the block no longer counts three kinds of turn',
  );
  const defined = PERSONA_BLOCK.split('\n\n')
    .map(p => /^An? (\w+) turn is when /.exec(p)?.[1])
    .filter((k): k is string => k !== undefined);
  assert.deepEqual(
    defined, [...BLOCK_TURN_SHAPES],
    'the paragraphs that define a turn shape are not the three the count promises, in the order the gate decides them',
  );
});

/**
 * The ten envelope keys, MIRRORED from ENVELOPE_FIELDS (persona/status.ts) as literals rather than
 * imported — this module is a leaf and its test keeps that property, because importing status.ts to
 * read ten strings would drag the LLM client into the cheapest test in the repo. The corpus-wide
 * version of this rule loops over ENVELOPE_FIELDS itself (promptPolicy.test.ts), so the day a
 * field is added and this list is not, the corpus test still catches it; what this copy buys is the
 * failure landing in the file somebody just edited.
 */
const ENVELOPE_KEYS = [
  'mood_label', 'mood_shift', 'intent_mode', 'terminal_closure', 'epistemic_trigger', 'meta_prompt',
  'hook_kind', 'language_request', 'thread_note', 'thread_outcome',
] as const;

test('the block describes no envelope field — the status contract owns the list', () => {
  for (const key of ENVELOPE_KEYS) {
    assert.ok(
      !PERSONA_BLOCK.includes(`- \`${key}\``),
      `\`${key}\` is described as a bullet in the persona block — ENVELOPE_FIELDS owns it, and a field described twice drifts in one`,
    );
  }
  assert.ok(
    !PERSONA_BLOCK.includes('- `'),
    'the block has no backticked bullet at all, which is why no key can be described in one',
  );
});

// ── the drift anchor ─────────────────────────────────────────────────────────

test('the heading is the literal three test files hard-code', () => {
  assert.equal(DRIFT_ANCHOR_HEADING, '## Still the same Irises, this far down');
  assert.deepEqual([...DRIFT_MODES], ['task', 'hook', 'quiet', 'share', 'take', 'spent', 'quiz', 'roast', 'pushed']);
});

test('every mode and window renders heading, lead, then exactly six `- ` bullets', () => {
  for (const a of ANCHORS) {
    const lines = renderDriftAnchor(a.mode, a.windowChars).split('\n');
    assert.equal(lines[0], DRIFT_ANCHOR_HEADING, `${a.name}: heading first`);
    assert.equal(lines[1], DRIFT_ANCHOR_LEAD, `${a.name}: lead second`);
    assert.equal(lines.length, 8, `${a.name}: heading + lead + six bullets, nothing else`);
    const bullets = lines.slice(2);
    assert.equal(bullets.length, 6, `${a.name}: six bullets`);
    for (const b of bullets) assert.ok(b.startsWith('- '), `${a.name}: every bullet line starts with "- " (${b})`);
  }
});

test('no digit in any of the six renderings — numbers are spelled', () => {
  for (const a of ANCHORS) {
    const text = renderDriftAnchor(a.mode, a.windowChars);
    assert.ok(
      !/[0-9]/.test(text),
      `${a.name}: a digit at the recency edge is a number she can read out, and every number in her replies has to be one she saw`,
    );
  }
});

test('the window band moves the common bullets and nothing else', () => {
  for (const mode of DRIFT_MODES) {
    const short = renderDriftAnchor(mode, SHORT_WINDOW).split('\n');
    const long = renderDriftAnchor(mode, LONG_WINDOW).split('\n');

    assert.deepEqual(short.slice(0, 2), long.slice(0, 2), `${mode}: same heading and lead`);
    assert.deepEqual(short.slice(5), long.slice(5), `${mode}: the law for the turn does not move with the window`);
    assert.notDeepEqual(short.slice(2, 5), long.slice(2, 5), `${mode}: the long window restates identity`);

    // What the restatement actually buys, named rather than merely different.
    const restated = long.slice(2, 5).join('\n');
    assert.ok(restated.includes('You are Irises'), `${mode}: the long window says her name`);
    assert.ok(restated.includes('Never defend, never wink, never suck up'), `${mode}: and the three moves`);
  }
});

test('the band is inclusive at its edge, and the same arguments always give the same bytes', () => {
  const under = renderDriftAnchor('task', DRIFT_LONG_WINDOW_CHARS - 1);
  const at = renderDriftAnchor('task', DRIFT_LONG_WINDOW_CHARS);
  assert.notEqual(under, at, 'DRIFT_LONG_WINDOW_CHARS itself is a long window');
  assert.equal(at, renderDriftAnchor('task', DRIFT_LONG_WINDOW_CHARS), 'deterministic — the goldens pin these bytes');
  assert.equal(renderDriftAnchor('quiet', 0), renderDriftAnchor('quiet', 1), 'and an empty window is just a short one');
});

/**
 * The law each mode states, as one phrase that mode carries and no other mode does — the whole
 * value of taking a mode at all. A table rather than three locals, because the sweep below is what
 * proves the modes are DISJOINT, and disjointness over four modes is twelve comparisons nobody
 * writes out by hand.
 */
const MODE_LAWS: Record<DriftMode, string> = {
  task: 'answer it flat, with the real numbers, and deliver first',
  hook: 'one hook, of a kind the hooks section above still allows, and only one',
  quiet: 'one plain short bubble, a tapback, or nothing',
  share: 'they handed you something and asked for nothing',
  take: 'the reply is your take',
  spent: 'is too much today',
  quiz: 'The answer itself is the one thing this reply never contains',
  roast: 'turns the answer itself into a dig at them',
  pushed: 'give it now and get it right, visibly annoyed',
};

/** How each law NAMES the turn it governs, which is the half a model actually navigates by: the
 *  first bullet says what kind of turn this is, and two of those in one anchor is no anchor. */
const MODE_OPENERS: Record<DriftMode, string> = {
  task: 'This is a task turn',
  hook: 'This is an idle turn',
  quiet: 'Your weather closed the beat',
  share: 'This is a share turn',
  take: 'This is a take turn',
  spent: 'You are running on empty',
  quiz: 'This is a quiz',
  roast: 'They quizzed you',
  pushed: 'You just turned a quiz back on them',
};

test('each mode states its own law, and only its own', () => {
  for (const mode of DRIFT_MODES) {
    const text = renderDriftAnchor(mode, SHORT_WINDOW);
    assert.ok(text.includes(MODE_LAWS[mode]), `${mode}: the anchor does not state its own law`);
    assert.ok(text.includes(MODE_OPENERS[mode]), `${mode}: the law does not name the turn it governs`);

    // An anchor that carried two laws would be no anchor at all: the edge states the law for the
    // turn IN HAND, and a second one there is the mode input turning back into decoration.
    for (const other of DRIFT_MODES) {
      if (other === mode) continue;
      assert.ok(!text.includes(MODE_LAWS[other]), `${mode}: carries ${other}'s law as well as its own`);
      assert.ok(!text.includes(MODE_OPENERS[other]), `${mode}: names itself ${other} too`);
    }
  }
});

test('the share law reads true whether four kinds are open or none', () => {
  const share = renderDriftAnchor('share', SHORT_WINDOW);

  // THE PRESENCE CASE IS WHY THIS IS PINNED. A share turn with every kind spoken for still reaches
  // this edge in share mode — the assembler maps share → share unconditionally, because the quiet
  // law it would otherwise fall to answers a bid with a tapback or nothing, which is the receipt the
  // whole shape exists to forbid. So the law may not promise a move the section has already spent:
  // it defers to the section for WHICH move, and forbids the two ways out of the turn outright.
  assert.ok(
    share.includes('shaped by what the share section above leaves open'),
    'the share law names the section as the thing that decides which move is left, instead of promising one',
  );
  assert.ok(
    share.includes('Never a receipt, never nothing.'),
    'and it closes both exits, which is what makes it true on the turn where no kind is open',
  );

  // The dose and the gate, stated at the edge because they are the two rules a long thread loses
  // first: the section can leave the question open and still be read as an instruction to ask.
  assert.ok(share.includes('only when the section left the question open'));
  assert.ok(share.includes('One question at most. When they just answered yours, what you make of the answer comes first'));

  // The three shapes that wear a follow-up's clothes (switch, mirror, me-too), named as bans.
  for (const ban of ['Never a switch', 'never a question that turns back on you', 'never a me-too']) {
    assert.ok(share.includes(ban), `the share law drops the ban on ${JSON.stringify(ban)}`);
  }
});

test('the hook anchor names the question-as-probe ban, and share names ask-only-what-they-know', () => {
  // Hook turns allow the question kind now, but the anchor distinguishes an aimed question from a
  // probe: "specific and aimed" is the standard, not a blanket ban.
  assert.ok(renderDriftAnchor('hook', SHORT_WINDOW).includes('A question hook is specific and aimed'));
  assert.ok(renderDriftAnchor('quiet', SHORT_WINDOW).includes('No hook, no callback, no question.'));
  assert.ok(
    !renderDriftAnchor('task', SHORT_WINDOW).includes('ask only for what only they know'),
    'a task turn is answered flat, and nothing at the edge suggests it may ask for anything',
  );
  assert.ok(renderDriftAnchor('share', SHORT_WINDOW).includes('ask only for what only they know'));
});
