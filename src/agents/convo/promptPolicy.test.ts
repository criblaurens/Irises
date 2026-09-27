// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The prose has no other test. Every clause in RULE_ANCHORS was added to Context.md on purpose, and
// each one is a behaviour the live thread depends on — guess before you ask, the probe that wears a
// statement's clothes, the three-check gate, the play frame that keeps a tease off their wound. A
// rewrite that drops one of them looks like a tidy-up in review and shows up as drift in production
// weeks later. This file makes that deletion fail immediately, by id.
//
// "The persona" here is the whole CORPUS — Context.md plus every craft page under convo/craft/
// (convoPersonaWithCraft, the flag's off-path concatenation) — and not the core file alone. P4a moved
// seven sections out into pages that load per-turn, so a rule that ends up in one of them is still a
// rule the model reads, and a scan of Context.md alone would report it missing. The negative checks
// below get the same widening for free, and want it more: "no envelope field is described in the
// prose" has to mean no page either.
//
// Its other half is the same job pointed the other way: the JSON anchor at the recency edge STATES
// the bubble law, and the pipeline ENFORCES it (pipeline/bubbleJson.ts, pipeline/bubbles.ts). The
// statement and the backstop must agree, or the model is told one law and held to another.
// promptSections.test.ts pins the prompt's exact bytes; this pins the RELATIONSHIP between the words
// and the constants, so changing a constant fails here instead of silently disagreeing. Since P1 the
// JSON anchor is the ONLY place in Convo's prompt that states the numbers, and the check below holds
// it that way.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPromptSections } from './shared.js';
import { RULE_ANCHORS, CONFIDENCE_BANDS } from './promptPolicy.js';
import { convoPersonaWithCraft } from './personaModules.js';
import { BUBBLE_LAW_MAX } from '../../pipeline/bubbleJson.js';
import { MAX_BUBBLE_WORDS, BUBBLE_WORD_TARGET_LO, BUBBLE_WORD_TARGET_HI } from '../../pipeline/bubbles.js';
import { ENVELOPE_FIELDS, STATUS_CONTRACT_HEADER } from '../../persona/status.js';
import { MOOD_CORES, CORE_VALENCE_BAND } from '../../persona/mood.js';
import type { ThreadRung } from '../../persona/threads.js';
import { FORMAT_ANCHOR } from '../composerCore.js';
import { buildOutcomeBrief } from '../fallfirm/client.js';
import { buildProgressBrief } from '../fallfirm/voiceInstant.js';
import { loadContext } from '../loadContext.js';
import { renderPersonaBlock, DRIFT_MODES, type DriftMode, type PersonaLane } from '../../persona/policy.js';
import type { HookDirective } from '../../persona/hooks.js';
import type { PersonaTurn } from './shared.js';

// ── the persona's load-bearing clauses ───────────────────────────────────────

test('every rule anchor is still in the persona, verbatim', () => {
  const persona = convoPersonaWithCraft();
  for (const { id, personaAnchor } of RULE_ANCHORS) {
    assert.ok(
      persona.includes(personaAnchor),
      `the "${id}" rule is gone from the persona corpus (Context.md + every craft page) — its anchor no longer appears: ${JSON.stringify(personaAnchor)}. If the rewrite was deliberate, update RULE_ANCHORS in the same commit.`,
    );
  }
});

test('the anchor list is a usable index — unique ids, real phrases', () => {
  assert.ok(RULE_ANCHORS.length >= 8, 'the eight clauses this phase pinned are all listed');
  const ids = RULE_ANCHORS.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'no id is used twice');
  for (const { id, personaAnchor } of RULE_ANCHORS) {
    assert.ok(id.trim().length > 0, 'every anchor is named');
    // Long enough that the match means the CLAUSE is present, not a coincidence of common words.
    assert.ok(personaAnchor.trim().length >= 18, `${id}: the anchor is specific enough to be evidence`);
  }
});

// ── the threading ladder, as taught vs as deliverable ────────────────────────
//
// The selector can only ever hand her a `fact`, a `pattern` or a `shorthand` offer (ThreadRung,
// persona/threads.ts) — three rungs. The persona taught FIVE, splitting fact into question and
// connection and pattern into soft and named, so two of the rungs it asked her to climb do not
// exist downstream and no code could ever confirm one had been earned. Now it teaches three, and
// this holds the two ladders in step.

/** The rungs lowest-first. A Record keyed by ThreadRung, so renaming or adding a rung in
 *  persona/threads.ts breaks THIS LINE — which is the point: the type is the source, and the
 *  persona's prose has to follow it. */
const RUNG_ORDER: Record<ThreadRung, number> = { fact: 0, pattern: 1, shorthand: 2 };
const RUNGS = (Object.keys(RUNG_ORDER) as ThreadRung[]).sort((a, b) => RUNG_ORDER[a] - RUNG_ORDER[b]);

test('the persona teaches exactly the rungs the engine can deliver, in the same order', () => {
  const persona = convoPersonaWithCraft();
  const at = persona.indexOf('**The ladder: enter one rung lower than you could.**');
  assert.ok(at > 0, 'found the ladder paragraph in the threading craft page');
  // To the end of the PARAGRAPH, not the end of the first line. The prose commit rewrote
  // craft/threading.md hard-wrapped at a hundred columns, so the lead-in now sits on a line of its
  // own and the three rungs are spread over the four lines under it. A line-shaped slice read only
  // the bold sentence and reported a ladder with no rungs in it at all — a false failure about
  // wrapping, on a test that is supposed to be about the rungs. Markdown makes a blank line the
  // paragraph break, so that is the boundary; the rungs still have to arrive in one paragraph.
  const end = persona.indexOf('\n\n', at);
  assert.ok(end > at, 'the ladder paragraph is terminated, so the slice is the paragraph and not the rest of the page');
  const ladder = persona.slice(at, end);

  assert.ok(ladder.includes('Three rungs'), `the ladder still claims a different height: ${ladder.slice(0, 120)}`);
  const positions = RUNGS.map(rung => ({ rung, at: ladder.indexOf(rung) }));
  for (const { rung, at: found } of positions) {
    assert.ok(found >= 0, `the ${rung} rung is missing from the ladder — the engine can still offer one`);
  }
  assert.deepEqual(
    [...positions].sort((a, b) => a.at - b.at).map(p => p.rung), RUNGS,
    'the ladder climbs in the order the rung ceiling drops through: fact → pattern → shorthand',
  );

  // The five-rung version is gone, not just outnumbered: its two extra rungs were "a fact
  // connection" and "a named theme", neither of which the selector can express.
  assert.ok(!/[Ff]ive rungs/.test(persona), 'the five-rung ladder is still in the persona');
  assert.ok(!persona.includes('a named theme ("the perfectionism loop again?")'), 'the named-theme rung is still listed');
});

// ── the hidden envelope, described once ──────────────────────────────────────
//
// The `status` object used to be described in four places, two of which lived in the persona: a
// hand-copied feelings wheel (83 words, with each core's valence band beside it) and a field-by-field
// bullet list. Both were a second copy of persona/status.ts — the wheel of WILLCOX_WHEEL, the list of
// STATUS_SCHEMA_PROP — and both had drifted. They are gone; ENVELOPE_FIELDS is the source and the
// `status_contract` section is the copy the model reads. This is what holds them out of the prose: a
// well-meant "let me just remind her what mood_core is" in Context.md fails here.

/** How Context.md names the per-turn block that carries the field list now — DERIVED from the
 *  contract's own heading (persona/status.ts), so renaming the heading fails here, on the persona
 *  side, in the same run. It used to be a hardcoded copy of the same words, which meant a rename
 *  failed only because internalWeather.test.ts spelled them a third time: nothing linked Context.md's
 *  pointer to the code's heading, and this check would have gone on passing while the persona pointed
 *  at a block that no longer existed under that name. */
const STATUS_CONTRACT_POINTER = `under "${STATUS_CONTRACT_HEADER.replace(/^## /, '')}"`;

/**
 * The one thing the persona still says about a named envelope field, and it is a RULE rather than a
 * description: "you concede to information, never to insistence" is the persona's ONLY statement of
 * that anti-sycophancy behaviour (RULE_ANCHORS.concede_to_information), rescued from the field list
 * P1 deleted. It was reintroduced as "One of those fields is a rule rather than a reading:", which
 * hands the model a rule with no referent — seventeen fields, and no way to know which one it
 * calibrates. It names the field now. An inline backtick is not a `- \`key\`` bullet, so this does
 * not reopen the description the contract owns (checked in the same test below).
 */
const PERSONA_RULE_FIELD = '`epistemic_trigger` is a rule rather than a reading:';

test('the persona describes no envelope field and copies no wheel — it points at the contract', () => {
  const persona = convoPersonaWithCraft();

  // The bands are the wheel's tell: they only ever appeared in the hand-copied list.
  assert.ok(!persona.includes('joyful [70-100]'), 'the copied feelings wheel is back in the persona');
  for (const core of MOOD_CORES) {
    const [lo, hi] = CORE_VALENCE_BAND[core];
    assert.ok(!persona.includes(`${core} [${lo}-${hi}]`), `${core}'s valence band is back in the persona`);
  }

  // A field described in the persona is a field described twice — the contract owns all seventeen.
  for (const f of ENVELOPE_FIELDS) {
    assert.ok(
      !persona.includes(`- \`${f.key}\``),
      `\`${f.key}\` is described as a persona bullet again — ENVELOPE_FIELDS (persona/status.ts) owns it, and the status_contract section is where the model reads it`,
    );
  }

  // …and the pointer that replaced them still names the block it points at.
  assert.ok(
    persona.includes(STATUS_CONTRACT_POINTER),
    `the inner-weather section no longer points at the contract (looked for ${JSON.stringify(STATUS_CONTRACT_POINTER)}), so the persona now describes the envelope nowhere at all`,
  );

  // The one rule the persona kept says which field it calibrates, in the same sentence.
  const ruleAt = persona.indexOf(PERSONA_RULE_FIELD);
  assert.ok(
    ruleAt > 0,
    `the rescued anti-sycophancy rule no longer names its field (looked for ${JSON.stringify(PERSONA_RULE_FIELD)}) — it is the persona's only statement of "concede to information, never to insistence", and without the field name it is a rule about nothing`,
  );
  const concede = persona.indexOf('you concede to information, never to insistence');
  assert.ok(
    concede > ruleAt && concede - ruleAt < 80,
    'the field name and the rule it introduces are still one sentence, not two paragraphs apart',
  );
});

// ── the bubble law, as stated vs as enforced ─────────────────────────────────

/** A hook directive in one mode and nothing else going on — the ONE input the drift anchor reads off
 *  the per-turn struct (convo/shared.ts PersonaTurn). Built as a literal rather than through
 *  selectHook: what is under test here is what the anchor SAYS in each mode, not how a turn earns
 *  one, and hooks.test.ts owns the selector. */
function turnInMode(mode: DriftMode): PersonaTurn {
  const hooks: HookDirective = {
    // `idle` is "they sent nothing", which is TRUE on the two idle modes and false on both of the
    // gate's own answers: a share turn is the opposite of an idle one (they said something), so it
    // reads false here the way the selector sets it. The anchor reads neither field — the mode is
    // its whole input — but a fixture that carries a shape the selector cannot produce is a fixture
    // the next reader believes.
    idle: mode === 'hook' || mode === 'quiet', mode: mode === 'take' || mode === 'spent' || mode === 'quiz' || mode === 'roast' || mode === 'pushed' ? 'task' : mode, forbidden: [], lateNight: false,
    moments: false, offerAllowed: mode === 'hook' || mode === 'share',
    // A take and a spent turn are task turns marked as such: the anchor reads the flag, not a hook mode.
    ...(mode === 'take' ? { take: true } : {}),
    ...(mode === 'spent' ? { spent: true } : {}),
    ...(mode === 'quiz' ? { quiz: 'refuse' as const } : {}),
    ...(mode === 'roast' ? { quiz: 'roast' as const } : {}),
    ...(mode === 'pushed' ? { quizPushed: true } : {}),
  };
  return { hooks, moments: [], thesis: '' };
}

/** The two bookends that close the tail after its `</prompt>`: the drift anchor, then the JSON
 *  contract. The bare build carries no history, so the anchor's window band is the short one;
 *  `personaTurn` is what picks its mode, and omitting it is the task-turn fallback every non-Convo
 *  caller gets. */
function anchors(personaTurn?: PersonaTurn): { behavior: string; json: string } {
  const { tail: system } = buildSystemPromptSections(
    undefined, '', [], undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    personaTurn,
  );
  const behaviorAt = system.lastIndexOf('## Still the same Irises');
  const jsonAt = system.lastIndexOf('## Last thing before you type');
  assert.ok(behaviorAt > 0 && jsonAt > behaviorAt, 'both anchors are where the assembler puts them');
  return { behavior: system.slice(behaviorAt, jsonAt), json: system.slice(jsonAt) };
}

test('the JSON anchor states the bubble law with the pipeline constants', () => {
  const { json } = anchors();
  assert.ok(
    json.includes(`Target ${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words, hard ceiling ${MAX_BUBBLE_WORDS}, never exceeded, at most ${BUBBLE_LAW_MAX} items per reply`),
    'the law sentence reads off BUBBLE_WORD_TARGET_LO/HI, MAX_BUBBLE_WORDS and BUBBLE_LAW_MAX',
  );
  assert.ok(json.includes(String(BUBBLE_LAW_MAX)), 'the count the model is told is the exported one');
});

test('the drift anchor states no bubble number at all, in any mode — the JSON anchor owns the law', () => {
  // Until P1 the behaviour anchor retold the law in its own words ("5-12 words, three at most"), so
  // raising a constant left it quietly telling her the old number. The fix was not a better
  // interpolation but a deletion: the law is stated ONCE, in the JSON anchor above. This holds that —
  // any digit reappearing here is a second statement of a number, which is how the two drift apart.
  //
  // It runs once per mode now, and that is the point of running it here rather than in policy.test.ts
  // (which pins the same two properties over the renderer directly): what the model actually reads at
  // the recency edge is whatever the ASSEMBLER put there, and only one of the four modes can be the
  // one a given turn renders. A mode that grew a seventh bullet, or a spelled number that came back as
  // a digit, would otherwise fail on whichever mode a fixture happened to pick.
  const cases: ReadonlyArray<readonly [string, PersonaTurn | undefined]> = [
    ['no directive at all (the task-turn fallback)', undefined],
    ...DRIFT_MODES.map(mode => [`mode ${mode}`, turnInMode(mode)] as const),
  ];
  for (const [name, personaTurn] of cases) {
    const { behavior } = anchors(personaTurn);
    const digits = behavior.match(/\d+/g) ?? [];
    assert.deepEqual(digits, [], `${name}: a number came back into the drift anchor — state it in the JSON anchor instead`);
    const bullets = behavior.split('\n').filter(l => l.startsWith('- '));
    assert.equal(bullets.length, 6, `${name}: the anchor is the six lines that drift first, and stays that short`);
  }

  // …and the four modes really do say different things, or the mode input is decoration.
  const rendered = DRIFT_MODES.map(mode => anchors(turnInMode(mode)).behavior);
  assert.equal(new Set(rendered).size, DRIFT_MODES.length, 'each mode puts its own law at the edge');
  assert.equal(anchors().behavior, anchors(turnInMode('task')).behavior, 'no directive reads as a task turn');
});

// ── the confidence bands, as taught vs as anchored ───────────────────────────
//
// `confidence_level` is the first field of every reply, and the number is only worth setting because
// it picks the SHAPE of the reply. Until this test that mapping lived only in the JSON anchor: P1
// deleted the two prose restatements (the opening ABSOLUTE RULE and the FINAL REMINDER) and the
// persona's own confidence section teaches how to score without ever saying what a score buys. So
// the section states it again, once, compressed — and this holds the two copies in step, the same
// job the bubble-law checks above do for the numbers.

/** Where the compressed mapping lives in the persona. Bold lead-in, so it is findable by a reader
 *  scanning the section as well as by this test. */
const BAND_MAPPING_LEAD = "**The band picks the reply's shape";

test('the persona says what each confidence band buys, and the JSON anchor still agrees', () => {
  const persona = convoPersonaWithCraft();
  const at = persona.indexOf(BAND_MAPPING_LEAD);
  assert.ok(
    at > 0,
    `the confidence section no longer maps a band to a reply shape (looked for ${JSON.stringify(BAND_MAPPING_LEAD)}). It teaches how to SCORE and never says what the score buys, which leaves the mapping only in the JSON anchor — a code file no persona editor reads.`,
  );
  const mapping = persona.slice(at, persona.indexOf('\n', at));

  const copies = [
    { name: 'the persona confidence section', text: mapping, shape: (b: typeof CONFIDENCE_BANDS[number]) => b.personaShape },
    { name: 'the JSON anchor', text: anchors().json, shape: (b: typeof CONFIDENCE_BANDS[number]) => b.anchorShape },
  ];
  for (const copy of copies) {
    const found = CONFIDENCE_BANDS.map(b => ({
      band: b.band, phrase: copy.shape(b),
      bandAt: copy.text.indexOf(b.band), shapeAt: copy.text.indexOf(copy.shape(b)),
    }));
    for (const f of found) {
      assert.ok(f.bandAt >= 0, `${copy.name}: the ${f.band} band is gone from the mapping`);
      assert.ok(
        f.shapeAt >= 0,
        `${copy.name}: the ${f.band} band no longer buys ${JSON.stringify(f.phrase)} — the two copies now promise different replies. If the wording moved on, move CONFIDENCE_BANDS with it in the same commit.`,
      );
    }
    const byBand = [...found].sort((a, b) => a.bandAt - b.bandAt).map(f => f.band);
    const byShape = [...found].sort((a, b) => a.shapeAt - b.shapeAt).map(f => f.band);
    const order = CONFIDENCE_BANDS.map(b => b.band);
    assert.deepEqual(byBand, order, `${copy.name}: the bands are not listed lowest-first`);
    assert.deepEqual(byShape, order, `${copy.name}: the shapes do not climb with the bands — a band is described by the wrong reply`);
  }
});

// ── the same law, as the other lanes state it ────────────────────────────────
//
// Convo is not the only voice that states the bubble law. The composer's FORMAT_ANCHOR and both
// Fallfirm anchors carry their own copy of it, and every bubble they produce goes through the SAME
// pipeline backstop — so a lane spelling a different number is a lane held to a law it was never
// told. All three now interpolate the same constants; these assertions are that the RENDERED digits
// really are those constants. They live here, beside Convo's, because "who states the law and in
// which numbers" is one question, and answering it in four files is how the four drift apart.

/** Small numbers as prose spells them. Only ever indexed by a bubble-law constant, so the list stops
 *  exactly where the law does. Prose that spells a count cannot interpolate it, which is precisely
 *  why the spelled copies need a test. */
const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five'] as const;

test("the composer's format anchor states the word target and comma-split rule (no count cap)", () => {
  assert.ok(
    FORMAT_ANCHOR.includes(`${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words per item`),
    `the composer anchor's word target has drifted from BUBBLE_WORD_TARGET_LO/HI`,
  );
  assert.ok(
    FORMAT_ANCHOR.includes('a second comma means two items'),
    'the composer anchor should state the comma-split rule',
  );
});

// The two anchors share the target and the ceiling, and part ways on the count on purpose: the
// outcome voice may run to the law's full count, while every wait beat is ONE bubble (the holding-beat
// rule, fallfirm/Progress.md) — a count under the law, so the pipeline backstop never has to cut it.
test("Fallfirm's two anchors state the same target and ceiling, and each its own count", () => {
  const outcome = buildOutcomeBrief({ kind: 'confirmed', summary: 'the reminder is set for 7pm' }, '');
  const instant = buildProgressBrief({ kind: 'holding', request: 'cedar lead times' }, '');
  for (const [lane, prompt] of [['voiceOutcome', outcome], ['voiceInstant', instant]] as const) {
    assert.ok(
      prompt.includes(`${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words, hard ceiling ${MAX_BUBBLE_WORDS}`),
      `${lane}: its anchor's target/ceiling has drifted from the pipeline constants`,
    );
  }
  assert.ok(
    outcome.includes('a second comma means two items'),
    'voiceOutcome: its anchor should state the comma-split rule',
  );
  assert.ok(
    outcome.includes(`one to ${SPELLED[BUBBLE_LAW_MAX]} items`),
    `voiceOutcome: its anchor should say "one to ${SPELLED[BUBBLE_LAW_MAX]} items" — it has drifted from BUBBLE_LAW_MAX`,
  );
  assert.ok(instant.includes('exactly one item'), 'voiceInstant: a wait beat is one bubble');
});

// ── one personality, four surfaces ───────────────────────────────────────────
//
// The sibling of the bubble-law checks above, and the same question asked about the PERSON rather
// than about a number. Convo, the Composer relay, Fallfirm's outcome voice and Fallfirm's holding
// voice each used to carry their own description of who is typing, and nobody ever read two of them
// side by side — so the lane with the thinnest paragraph drifted toward the assistant default first
// and nothing failed. The personality lives in one string now (persona/policy.ts), and each lane's
// own Context.md keeps only how that lane works.
//
// What this test is worth depends entirely on running the REAL assembly on each surface. Asserting
// that renderPersonaBlock returns the same bytes four times is a tautology and policy.test.ts already
// pins it; the failure mode this catches is a lane whose prompt builder simply never renders it —
// which is exactly what all four lanes looked like the day before this landed.
//
// T7 moved the block out of the composer/Fallfirm `<prompt>` tails and into their system prompts
// (composerCore.ts, fallfirm/client.ts, fallfirm/voiceInstant.ts), matching Convo — so all four
// surfaces below are now each lane's system prompt, built the same `persona + Context.md`/
// `persona + Progress.md` way the real call sites assemble it.

/** The four surfaces, each built the way its own lane builds its system prompt. */
function surfacePrompts(): ReadonlyArray<readonly [PersonaLane, string]> {
  return [
    ['convo', buildSystemPromptSections(undefined, '').system],
    ['composer', `${renderPersonaBlock('composer')}\n\n${loadContext('composer')}`],
    ['fallfirm', `${renderPersonaBlock('fallfirm')}\n\n${loadContext('fallfirm')}`],
    ['fallfirm_progress', `${renderPersonaBlock('fallfirm_progress')}\n\n${loadContext('fallfirm', 'Progress.md')}`],
  ];
}

test('the shared persona block reaches all four prompt surfaces, verbatim and once', () => {
  for (const [lane, prompt] of surfacePrompts()) {
    const block = renderPersonaBlock(lane);
    assert.ok(block.length > 1000, `${lane}: the block is a real one, not an empty string`);
    assert.equal(
      prompt.split(block).length - 1, 1,
      `${lane}: its prompt carries the shared persona block ${prompt.split(block).length - 1}×, not once. Zero means the lane never renders it and is back to whatever its own Context.md happens to say about her; two means it is stated twice and can be edited in one of them.`,
    );
  }
});

test('the four surfaces carry the SAME block — a lane-specific sentence is the drift', () => {
  const [[, convo]] = surfacePrompts();
  const block = renderPersonaBlock('convo');
  assert.ok(convo.includes(block), 'the Convo prompt is the reference copy');
  for (const [lane, prompt] of surfacePrompts()) {
    assert.ok(
      prompt.includes(block),
      `${lane}: it renders a persona block, but not the SAME bytes Convo renders — four descriptions of one person are four people, which is what persona/policy.ts exists to stop`,
    );
  }
});
