// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The hidden envelope's TABLE — who is in it, and who reads each row back. status.test.ts owns the
// coercion, the merge and the renders; this file owns ENVELOPE_FIELDS itself, because the v2 shrink
// turned the `consumers` column from documentation into a RULE.
//
// Before v2 the envelope had seventeen fields and four of them were read by nothing at all
// (`conviction`, `engagement`, `epistemic_trigger`, `profile_note`) — an empty `consumers` list was a
// documented fact. It is now a failure: every field costs the model a decision on every single turn
// and costs the prompt a bullet in the contract, so a field nobody reads back is weight in two places
// at once. Ten fields, ten rows, and every one of them named somewhere in code.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENVELOPE_FIELDS, STATUS_SCHEMA_PROP, type EnvelopeField } from './status.js';

/** The v2 envelope, spelled out — the closed set and the emission order, which is also the schema's
 *  `required` order and the contract's bullet order. Written here as a literal rather than derived
 *  from the table, because a table that lost or gained a field would derive its own new answer. */
const V2_KEYS: readonly string[] = [
  'mood_label', 'mood_shift', 'intent_mode', 'terminal_closure',
  'epistemic_trigger', 'meta_prompt', 'hook_kind', 'language_request', 'turned_down', 'dodged', 'thread_note', 'thread_outcome',
];

/** The modules that declare every name the `consumers` column can use. Read as SOURCE rather than
 *  imported: pulling threadHarvest.ts into a persona unit test would drag the repositories (and
 *  node:sqlite) in behind it, and the question being asked is only "does this name still exist".
 *  `mood.ts` and `affectDrift.ts` joined the list in v2 — the two modules that took over the fields
 *  the model stopped reporting; `hooks.ts` joined with `hook_kind`, and it is the one source here
 *  that a plain import would have been safe to take (a leaf that imports nothing) — read as text
 *  anyway, because the rule is about the list, not about any one module's dependencies.
 *  `affectCompiler.ts` joined last: the weather block is compiled now, so the functions that read
 *  `mood_label` and `meta_prompt` live there rather than in status.ts, and the column has to name
 *  the reader that really runs. */
const CONSUMER_SOURCES = [
  './status.ts', './mood.ts', './affectDrift.ts', './threads.ts', '../memory/threadHarvest.ts',
  '../memory/standingSettings.ts', './hooks.ts', './affectCompiler.ts',
  // `turned_down` joined with two readers outside persona/: the routing floors that stand down on a
  // mood's no (convo/shared.ts) and the store of what it put off (memory/owedAsks.ts).
  '../agents/convo/shared.ts', '../memory/owedAsks.ts',
] as const;

/** The rule, as a function, so the negative case below can be a real assertion rather than a claim
 *  about what would happen. Returns the keys nothing is named for. */
function unreadFields(rows: readonly EnvelopeField[]): string[] {
  return rows.filter(f => f.consumers.length === 0).map(f => f.key);
}

test('the envelope is exactly the twelve v2 fields, in emission order', () => {
  assert.deepEqual(
    ENVELOPE_FIELDS.map(f => f.key), V2_KEYS,
    'the shrink from seventeen fields to eight is a one-way migration — a field added back here is '
    + 'a field the model must fill on every turn, so it needs a reader and a row, not just a key',
  );
});

test('the schema both lanes validate against requires those twelve keys and nothing else', () => {
  const p = STATUS_SCHEMA_PROP as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(p.required, V2_KEYS);
  assert.deepEqual(Object.keys(p.properties), V2_KEYS);
});

test('every field names code that reads it back — an unread field is a failure now, not a fact', () => {
  assert.deepEqual(
    unreadFields(ENVELOPE_FIELDS), [],
    'these fields are emitted and persisted but nothing branches on them: give each one a reader or '
    + 'delete the row (persona/status.ts). The four v1 fields with no reader are what the shrink deleted.',
  );

  // …and the check can really fail: the same predicate over a row with an empty column.
  const orphan: EnvelopeField = {
    key: 'meta_prompt', type: 'string', required: true, description: 'x', consumers: [],
  };
  assert.deepEqual(unreadFields([...ENVELOPE_FIELDS, orphan]), ['meta_prompt']);
});

test('every consumer the table names is still an exported function', () => {
  const src = CONSUMER_SOURCES
    .map(rel => readFileSync(new URL(rel, import.meta.url), 'utf8'))
    .join('\n');
  const listed = [...new Set(ENVELOPE_FIELDS.flatMap(f => f.consumers))].sort();
  assert.ok(listed.length >= 5, 'the column still names the readers it did — this check went vacuous');
  for (const name of listed) {
    assert.match(
      src, new RegExp(`export (?:async )?function ${name}\\(`),
      `\`${name}\` is listed as a consumer but no longer declared in ${CONSUMER_SOURCES.join(' / ')} — it `
      + 'was renamed, moved or deleted. Fix the column (persona/status.ts) in the same commit, or the one '
      + 'documented map of who reads the envelope is now fiction.',
    );
  }
  for (const f of ENVELOPE_FIELDS) {
    assert.equal(new Set(f.consumers).size, f.consumers.length, `${f.key}: no consumer listed twice`);
  }
});

// The three fields the drift engine reads are the whole of the model's influence over the gauges it
// owns (persona/affectDrift.ts): a DIRECTION for mood, a widening for how the mind was changed, and
// how the last thread offer actually landed. If one of these rows ever stops naming it, the model is
// reporting into a void — the gauge it was meant to move is now decided by the clock alone.
// ── what the envelope costs, off-prompt ──────────────────────────────────────
// The descriptions reach the model TWICE: once as the `status_contract` section (ratcheted in
// promptPolicy.ts) and once on the response schema, which is sent with every request to both lanes
// and is the copy PROMPT_BUDGET cannot see — it is not part of the system prompt, so it is also not
// part of the cached prefix that makes the persona cheap. This is that copy's ceiling.

/**
 * What `JSON.stringify(STATUS_SCHEMA_PROP)` stands at TODAY, in characters, rounded up inside the 2%
 * PROMPT_BUDGET holds its own lines to. 4,789 measured with the dodge, one new row, `dodged`,
 * the reply's read of whether their message ducked what her last reply asked of them, whatever its
 * shape; thread_outcome could not carry it, since it fires only after a question or a tagged thread,
 * and it gains three words of its own (pushed_back now covers a tender spot). Was 3,587 measured. The share turn: +174, from 3,413, over two
 * descriptions and no new row — +140 on `hook_kind`, which names a fourth word (`question`) and
 * carries the two sentences that are the model's whole side of the question gate (a question
 * outranks the other kinds when one was asked; a question off a share turn is reported rather than
 * hidden, because the receipt that catches it reads this field), and +34 on `thread_outcome`, whose
 * trigger clause gains her own follow-up landing or bouncing. The cheap alternative was a field
 * asking her whether she asked a question, which would have been a fifth droppable row paid for on
 * every request to both lanes; the word rides the row that already reports the move. The ceiling
 * below stands at +1.8% of the measurement, inside the band. Was 3,413 measured. The Never-Send-a-Leaf rewrite: +218, from
 * 3,195, and all of it `hook_kind` joining the table — a 193-character row for the rhythm engine's
 * one input, plus 25 for its key on both of the wrapper's lists. Nothing else in the phase reached
 * this copy: the character rebuild happened in prose the schema does not carry, and re-measuring at
 * the end of it found the same 3,413. Was 2,899 before `language_request` joined the table (+296:
 * the standing-settings row, the one field here that SETS something rather than reporting it, and
 * the only channel through which a language the English fast path cannot read reaches code at all).
 *
 * It is deliberately NOT the 1,600 the task brief targeted, and the arithmetic says why. The ten
 * rows are 3,184 of the 3,587; the wrapper (`required`, the types, `additionalProperties`) is the
 * remaining 403, and has not moved through any of this. `thread_note` alone is 1,022 and
 * `thread_outcome` 488 — 42% of the schema in two rows — because those two descriptions are where P1 re-homed three CAPTURE rules that had lived
 * in Context.md only: the venting clause, the bare-fact exclusion and the anti-optimism read
 * (RESCUED_CAPTURE_RULES in status.test.ts, `thread_note_precedence` and
 * `thread_note_capture_when_heavy` in CLAUSE_INVENTORY). Deleting the pair would land the schema at
 * ~2,077 — and would delete three behaviour rules with no other home. Every other row is already
 * one sentence or an enum list.
 *
 * So the number to hold is the measurement, and the way to move it is to shorten a rule, in the
 * table, where both copies change together. Ratchet it here in the same commit when one does.
 *
 * Re-measured once more at the end of the phase, after the earned material landed, and unchanged
 * again at 3,413 — +1.7%, inside the band. The earned material never reaches this copy and was never
 * going to: moments and the thesis are written by BACKGROUND passes off the transcript
 * (memory/momentsHarvest.ts, memory/thesisRewrite.ts), not reported by the model through the
 * envelope, so the phase's one new row is still `hook_kind` and this table still has ten. Worth
 * stating rather than leaving as silence, because the cheap way to have built either feature was a
 * field asking her to nominate her own moments — which would have been paid for on every request to
 * both lanes, twice over, whether or not a moment was ever minted.
 */
// Autonomy (2026-09-25): +570, from 3,587 to 4,157, all of it `turned_down` joining the table, the
// one field that lets her mood say no out loud. Its description carries the tiers her mood gets no
// say on, because a field that could be set on a fact they asked for would let a bad mood skip the
// routing floor on exactly the turn it exists for.
// Feelings (2026-09-26): +67, to 4,224, `mood_label` asked to fit the feelings her weather names.
const SCHEMA_JSON_CEILING = 4_880;

/** How much the ceiling may sit above the measurement, copied from promptBudget.test.ts so this copy
 *  of the descriptions is held to the same band as the `status_contract` copy of them. The downward
 *  assertion below is the half this pin was missing: shortening a row and leaving the old number
 *  standing hands the next row that joins the table free space nobody voted for. */
const MAX_HEADROOM = 0.02;

test('the status schema both lanes validate against is inside its budget', () => {
  const json = JSON.stringify(STATUS_SCHEMA_PROP);
  const props = (STATUS_SCHEMA_PROP as { properties: Record<string, unknown> }).properties;
  const rows = Object.entries(props)
    .map(([k, v]) => [k, JSON.stringify(v).length] as const)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  ${k}: ${n}`);
  assert.ok(
    json.length <= SCHEMA_JSON_CEILING,
    `the status schema is ${json.length} chars, over its ${SCHEMA_JSON_CEILING}-char ceiling. It rides `
    + 'every request to both lanes, so a description that grows is paid for on every turn twice over. '
    + `Where it sits:\n${rows.join('\n')}`,
  );
  assert.ok(
    SCHEMA_JSON_CEILING <= json.length * (1 + MAX_HEADROOM),
    `the status schema measures ${json.length} chars but its ceiling stands at ${SCHEMA_JSON_CEILING} `
    + `(+${(((SCHEMA_JSON_CEILING - json.length) / json.length) * 100).toFixed(1)}%), over the `
    + `${MAX_HEADROOM * 100}% band — ratchet it down here in the commit that shortened a row. `
    + `Where it sits:\n${rows.join('\n')}`,
  );
});

test('the fields the gauges are computed from name the engine that computes them', () => {
  const consumersOf = (key: string) => ENVELOPE_FIELDS.find(f => f.key === key)!.consumers;
  for (const key of ['mood_shift', 'epistemic_trigger', 'thread_outcome']) {
    assert.ok(
      consumersOf(key).includes('applyAffectDrift'),
      `\`${key}\` is an input to the drift engine and must say so: ${JSON.stringify(consumersOf(key))}`,
    );
  }
  // `mood_label` is the other half of the bargain: the WORD decides the core (and through it the
  // valence band the level may sit in), which is why the model no longer reports a core at all.
  assert.ok(consumersOf('mood_label').includes('coreForLabel'), 'the word is what files the core');
  assert.ok(consumersOf('mood_label').includes('renderStatusForPrompt'), 'and it rides next turn\'s weather');
});
