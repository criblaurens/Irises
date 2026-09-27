// Run with: npm test   (TZ=UTC, DATA_BACKEND=memory)
//
// The Inner-state panel's ten SHAPERS, and nothing else. The route around them is a read of seven
// repositories behind the dashboard's own auth + cache, and the client half is a browser string the
// existing views.test.ts already scans — what is worth pinning here is the arithmetic that turns
// stored rows into what an operator reads:
//
//   • the affect trail, whose points carry no `mood_shift` of their own (persona/status.ts MoodPoint
//     doesn't store one) — so only the newest point can name a shift, off the `last` status, and
//     this is where that stays honest;
//   • the climate dials, which mean nothing without their own floor/ceiling and what the rolling
//     week has already spent;
//   • the thread inventory, summarized without leaking a note's text;
//   • her one read on this person, whose TEXT is shown here on purpose and whose superseded
//     revisions are not — the asymmetry is the panel's whole design, so it gets a pin either way;
//   • the moments, as tags and clocks with the kept line left on disk;
//   • the state of the two files those last two come out of, because "there is nothing here" and
//     "the file will not parse" are opposite instructions to the one person who can act on either;
//   • the rhythm ledger, as the four fields an operator is shown rather than whatever the store
//     happens to hold;
//   • the last N `turn:trace` receipts, flattened out of the persisted turn payloads;
//   • the approvals parked on this person's yes, which nothing here can settle;
//   • how well she knows them, as the stored level beside the band her replies compile under.
//
// Every one of them is pure and takes its clock injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  affectTrail, climateDialRows, threadSummary, traceRows, pendingApprovalRows,
  thesisSummary, momentRows, momentsFileState, rhythmSummary, familiaritySummary,
} from './affect.js';
import { emptyEvidence } from '../../../persona/familiarity.js';
import { MOOD_HISTORY_CAP, type AffectState, type AffectStatus } from '../../../persona/status.js';
import { CLIMATE_WINDOW_CAP, type RelationshipClimate } from '../../../persona/climate.js';
import { defaultThreadInventory, type ThreadInventory } from '../../../persona/threads.js';
import { defaultHookState, type HookState } from '../../../persona/hooks.js';
import type { MomentEntry } from '../../../persona/moments.js';
import type { MomentsFile } from '../../../db/repositories/moments.js';
import { TURN_TRACE_LABEL } from '../../traceLabels.js';
import type { Turn } from '../../turns.js';
import type { TraceEvent } from '../../trace.js';
import type { OpsTaskRow } from '../../../db/repositories/opsTasks.js';
import type { ThesisDoc, ThesisRevision } from '../../../db/repositories/thesis.js';

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const MIN = 60_000;

/** One `ops_tasks` row as the repository hands it back. */
function opsRow(over: Partial<OpsTaskRow> = {}): OpsTaskRow {
  return {
    id: 'a1', chatId: 'web:debug', kind: 'general', request: 'do the thing',
    status: 'pending_approval', startedAt: NOW - MIN, legStartedAt: NOW - MIN,
    budgetMs: null, retryOf: null, meta: {}, updatedAt: NOW - MIN, settledAt: null,
    ...over,
  };
}

function status(over: Partial<AffectStatus> = {}): AffectStatus {
  return {
    mood_label: 'hopeful', mood_core: 'powerful', mood_level: 72, mood_shift: 'lifted',
    intent_mode: 'chatting', terminal_closure: false, epistemic_trigger: 'none',
    meta_prompt: 'keep it light and follow their lead',
    warmth: 80, patience: 75, social_battery: 65, anxiety: 30, rapport: 55,
    at: NOW - MIN,
    ...over,
  } as AffectStatus;
}

function stateWithTrail(points: number): AffectState {
  const last = status();
  return {
    last,
    moodHistory: Array.from({ length: points }, (_, i) => ({
      level: 50 + i, core: 'peaceful' as const, label: `p${i}`, at: NOW - (points - i) * MIN,
      anxiety: 30 + i, warmth: 70 + i, social_battery: 60 + i, rapport: 50 + i,
    })),
  };
}

// ── the affect trail ─────────────────────────────────────────────────────────

test('the trail runs newest-first and only its newest point can name a mood shift', () => {
  const state = stateWithTrail(3);
  // The newest stored point IS the last status here (same clock), which is the live shape:
  // saveAffectState pushes `last` onto the trail in the same write.
  state.moodHistory[2].at = state.last!.at;
  const rows = affectTrail(state);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, 'p2', 'newest first — an operator reads down from now');
  assert.equal(rows[0].shift, 'lifted', 'the newest point takes the shift off the last status');
  assert.equal(rows[1].shift, null, 'an older point has none stored, so it claims none');
  assert.deepEqual(
    { level: rows[1].level, core: rows[1].core, warmth: rows[1].warmth, anxiety: rows[1].anxiety },
    { level: 51, core: 'peaceful', warmth: 71, anxiety: 31 },
  );
});

test('the trail is bounded by the stored cap and survives an empty/garbled state', () => {
  const rows = affectTrail(stateWithTrail(MOOD_HISTORY_CAP + 4));
  assert.equal(rows.length, MOOD_HISTORY_CAP, 'never more than the store itself keeps');
  assert.deepEqual(affectTrail({ moodHistory: [] }), [], 'a chat with no affect row reads as empty');
  // A point written before the gauges existed: no numbers, and nothing invented for it.
  const bare = affectTrail({ moodHistory: [{ level: 40, core: 'sad', label: 'flat', at: NOW }] });
  assert.deepEqual(
    { warmth: bare[0].warmth, rapport: bare[0].rapport, shift: bare[0].shift },
    { warmth: null, rapport: null, shift: null },
  );
});

// ── the climate dials ────────────────────────────────────────────────────────

test('each dial reports its own bounds and what the rolling week has spent', () => {
  const climate: RelationshipClimate = {
    dials: { ease: 42, candor: 45, playfulness: 25 },
    moves: [
      { at: NOW - 2 * 86_400_000, k: 'ease', d: 2 },
      { at: NOW - 86_400_000, k: 'ease', d: -1 },
      { at: NOW - 30 * 86_400_000, k: 'candor', d: 4 },  // outside the window
    ],
    lastEvalAt: NOW - 3 * 3_600_000,
    evalCount: 9,
  };
  const rows = climateDialRows(climate, NOW);
  assert.deepEqual(rows.map(r => r.key), ['ease', 'candor', 'playfulness'], 'the table order');
  const ease = rows[0];
  assert.deepEqual(
    { value: ease.value, dflt: ease.dflt, floor: ease.floor, ceiling: ease.ceiling, spent: ease.spent, cap: ease.cap },
    { value: 42, dflt: 35, floor: 20, ceiling: 80, spent: 3, cap: CLIMATE_WINDOW_CAP },
  );
  assert.equal(rows[1].spent, 0, 'a move older than the window is not still being billed');
  assert.equal(rows[2].moved, false, 'a dial still at its default says so');
  assert.equal(ease.moved, true);
});

// ── the thread inventory ─────────────────────────────────────────────────────

test('the thread summary counts by status and carries no note text', () => {
  const inv: ThreadInventory = {
    ...defaultThreadInventory(),
    themes: [
      { id: 't1', label: 'the cedar cabin', kind: 'goal', note: 'SECRET NOTE', evidenceDays: [1, 2], evidenceCount: 2, status: 'taggable', confidence: 70, firstSeenAt: NOW - 9 * 86_400_000, lastSeenAt: NOW - 86_400_000, lastOfferedAt: 0, lastTaggedAt: 0, lastOutcome: null, soreAt: 0, uptakes: 0, passes: 0 },
      { id: 't2', label: 'toast nerves', kind: 'tension', note: 'ALSO SECRET', evidenceDays: [1], evidenceCount: 1, status: 'open', confidence: 30, firstSeenAt: NOW - 2 * 86_400_000, lastSeenAt: NOW - 2 * 86_400_000, lastOfferedAt: 0, lastTaggedAt: 0, lastOutcome: null, soreAt: 0, uptakes: 0, passes: 0 },
    ],
    loops: [
      { id: 'l1', label: 'the electrician', note: 'LOOP NOTE', status: 'open', capturedAt: NOW - 4 * 86_400_000, lastSeenAt: NOW - 4 * 86_400_000, offeredAt: 0, askedAt: 0, resolvedAt: 0, passes: 0 },
      { id: 'l2', label: 'the dentist', note: 'x', status: 'resolved', capturedAt: NOW - 8 * 86_400_000, lastSeenAt: NOW - 8 * 86_400_000, offeredAt: 0, askedAt: 0, resolvedAt: NOW - 86_400_000, passes: 0 },
    ],
    turnsSinceOffer: 4,
    harvestCount: 31,
    lastHarvestAt: NOW - MIN,
  };
  const s = threadSummary(inv);
  // Counted by the status each row actually carries — a sparse map, so a status added to
  // persona/threads.ts shows up here without this file holding a second copy of that union.
  assert.deepEqual(s.themes, { total: 2, byStatus: { taggable: 1, open: 1 } });
  assert.deepEqual(s.loops, { total: 2, byStatus: { open: 1, resolved: 1 } });
  assert.deepEqual({ turnsSinceOffer: s.turnsSinceOffer, harvestCount: s.harvestCount }, { turnsSinceOffer: 4, harvestCount: 31 });
  assert.deepEqual(s.labels.map(l => l.label), ['the cedar cabin', 'toast nerves', 'the electrician', 'the dentist']);
  const json = JSON.stringify(s);
  for (const secret of ['SECRET NOTE', 'ALSO SECRET', 'LOOP NOTE']) {
    assert.ok(!json.includes(secret), `the summary leaked a stored note: ${secret}`);
  }
});

test('an empty inventory summarizes to zeros rather than to nothing', () => {
  const s = threadSummary(defaultThreadInventory());
  assert.deepEqual(s.themes, { total: 0, byStatus: {} });
  assert.deepEqual(s.loops, { total: 0, byStatus: {} });
  assert.deepEqual(s.labels, []);
  assert.equal(s.turnsSinceOffer, 0);
});

// ── her read on them ─────────────────────────────────────────────────────────
// The one panel that prints stored prose, and the one store where that is the point: a read she
// applies to everything and never says out loud is unreviewable anywhere else.

const DAY = 86_400_000;

test('the thesis summary carries the head text and its revisions as provenance only', () => {
  const doc: ThesisDoc = {
    docMd: 'they decide fast and then look for permission.\n\n## evidence\n- re-did the job alone',
    version: 7,
    writtenBy: 'weekly',
    updatedAt: NOW - 2 * DAY,
    lastRewriteAt: NOW - 2 * DAY,
  };
  const revisions: ThesisRevision[] = [
    { version: 7, docMd: 'CURRENT READ', writtenBy: 'weekly', createdAt: NOW - 2 * DAY },
    { version: 6, docMd: 'SUPERSEDED READ', writtenBy: 'evidence', createdAt: NOW - 3 * DAY },
  ];
  const s = thesisSummary({ doc, degraded: false }, revisions);
  assert.equal(s.text, doc.docMd, 'the operator surface for the read shows the read');
  assert.deepEqual(
    { version: s.version, updatedAt: s.updatedAt, degraded: s.degraded },
    { version: 7, updatedAt: NOW - 2 * DAY, degraded: false },
  );
  assert.deepEqual(s.revisions, [
    { version: 7, writtenBy: 'weekly', createdAt: NOW - 2 * DAY },
    { version: 6, writtenBy: 'evidence', createdAt: NOW - 3 * DAY },
  ], 'when and by which writer, in the listing order the store returned');
  // The head text is the live read; ten superseded copies of it would be a diary of everything she
  // has ever thought about somebody, on a page that only has to answer "is the read fair".
  const json = JSON.stringify(s.revisions);
  for (const body of ['CURRENT READ', 'SUPERSEDED READ']) {
    assert.ok(!json.includes(body), `a revision row carried its document: ${body}`);
  }
});

test('a person she has no read on yet summarizes to an empty read, not to nothing', () => {
  assert.deepEqual(thesisSummary({ doc: null, degraded: false }, []),
    { text: '', version: 0, updatedAt: 0, degraded: false, revisions: [] });
  // A wipe leaves the revisions behind and the document empty — the panel has to say both.
  const wiped = thesisSummary(
    { doc: { docMd: '', version: 3, writtenBy: 'forget', updatedAt: NOW, lastRewriteAt: NOW }, degraded: false },
    [{ version: 3, docMd: '', writtenBy: 'forget', createdAt: NOW }],
  );
  assert.deepEqual({ text: wiped.text, version: wiped.version, revs: wiped.revisions.length }, { text: '', version: 3, revs: 1 });
});

test('an unreadable THESIS.md does not summarize to "no read on them yet"', () => {
  // The route reads `readThesisHead` for exactly this row. `getThesis`'s null folds two opposite
  // facts together — a person she met this week, and a file that will not parse — and this panel is
  // the one reader that is an operator: the second one means every writer is refusing the document
  // until somebody opens it, so a page confidently reporting an empty store would be the worst
  // available answer.
  const s = thesisSummary({ doc: null, degraded: true }, []);
  assert.deepEqual(s, { text: '', version: 0, updatedAt: 0, degraded: true, revisions: [] });
  // And the revisions still list, because they are separate files: the last good read is right
  // there even when the head is not.
  const withRevs = thesisSummary({ doc: null, degraded: true }, [
    { version: 5, docMd: 'THE LAST GOOD READ', writtenBy: 'weekly', createdAt: NOW - DAY },
  ]);
  assert.deepEqual(withRevs.revisions, [{ version: 5, writtenBy: 'weekly', createdAt: NOW - DAY }]);
  assert.ok(!JSON.stringify(withRevs).includes('THE LAST GOOD READ'), 'still provenance only');
});

// ── the moments ──────────────────────────────────────────────────────────────

function moment(over: Partial<MomentEntry> = {}): MomentEntry {
  return {
    id: 'm1', text: 'THE LINE SHE KEPT', tag: 'habit', at: NOW - DAY,
    count: 1, offered: 0, lastOfferedAt: 0,
    ...over,
  };
}

test('the moment rows are tags and clocks, newest episode first, with no kept line in them', () => {
  const rows = momentRows([
    moment({ id: 'a', text: 'OLDEST PROSE', tag: 'obsession', at: NOW - 9 * DAY, count: 3, offered: 2, lastOfferedAt: NOW - 2 * DAY }),
    moment({ id: 'b', text: 'NEWEST PROSE', tag: 'embarrassing', at: NOW - 30 * 60_000 }),
    moment({ id: 'c', text: 'MIDDLE PROSE', tag: 'habit', at: NOW - 3 * DAY }),
  ], NOW);
  assert.deepEqual(rows.map(r => r.tag), ['embarrassing', 'habit', 'obsession'], 'newest first — an operator reads down from now');
  assert.deepEqual(rows[0], { tag: 'embarrassing', ageDays: 0, count: 1, offers: 0, lastOfferedAt: 0 },
    'half an hour old is zero whole days, not a rounded-up one');
  assert.deepEqual(rows[2], { tag: 'obsession', ageDays: 9, count: 3, offers: 2, lastOfferedAt: NOW - 2 * DAY });
  const json = JSON.stringify(rows);
  for (const prose of ['OLDEST PROSE', 'NEWEST PROSE', 'MIDDLE PROSE']) {
    assert.ok(!json.includes(prose), `a moment row carried her line: ${prose}`);
  }
  // The two keys the shaper deliberately strips: the id it is offered under, and the sort clock it
  // carries only to sort by. Excess-property checking does not apply to a non-literal return, so
  // dropping the trailing `.map` that removes `at` compiles clean and would ship it.
  for (const k of ['"id"', '"at"']) {
    assert.ok(!json.includes(k), `a moment row carried ${k}`);
  }
});

test('an empty moments file rows to nothing, and a clock ahead of now never reads negative', () => {
  assert.deepEqual(momentRows([], NOW), []);
  // A hand-edited or clock-skewed `at` in the future: zero days, never a negative age.
  assert.equal(momentRows([moment({ at: NOW + 5 * DAY })], NOW)[0].ageDays, 0);
});

function momentsFile(over: Partial<MomentsFile> = {}): MomentsFile {
  return { entries: [], lastHarvestAt: NOW - DAY, preserved: [], degraded: false, ...over };
}

test('the moments file state tells an empty file apart from one that will not parse', () => {
  // Both of the store's degraded-read flags, on the surface that exists to diagnose the store. An
  // absent MOMENTS.md and an unreadable one both hand the route zero entries, and they are opposite
  // facts: the second one means the nightly pass is skipping without stamping its clock every night
  // until a person opens the file (`MomentsFile.degraded`).
  assert.deepEqual(momentsFileState(momentsFile()), { degraded: false, preserved: 0 });
  assert.deepEqual(momentsFileState(momentsFile({ degraded: true })), { degraded: true, preserved: 0 });
  // Segments with no readable annotation: counted, never re-published. A mangled entry survives
  // every rewrite and is never rendered into a prompt, so it is invisible everywhere else — the
  // argument api/memory.ts's `mediumPreserved` makes one store over.
  const mangled = momentsFileState(momentsFile({ preserved: ['§ HER LINE, ANNOTATION MANGLED', '§ A HAND EDIT'] }));
  assert.deepEqual(mangled, { degraded: false, preserved: 2 });
  assert.ok(!JSON.stringify(mangled).includes('HER LINE'), 'a count, not the segment — this panel does not re-publish the prose');
});

// ── the hook rhythm ──────────────────────────────────────────────────────────

test('the rhythm summary shows the four ledger fields and nothing the store grew', () => {
  const state: HookState = {
    lastKinds: ['judgment', 'none', 'tangent'], idleStreak: 3, idleSinceMoment: 6, updatedAt: NOW - MIN,
  };
  assert.deepEqual(rhythmSummary(state), {
    lastKinds: ['judgment', 'none', 'tangent'], idleStreak: 3, idleSinceMoment: 6, updatedAt: NOW - MIN,
  }, 'oldest kind first — the window the kill switch reads, in the order it reads it');
  // The ledger is written after every turn and is the state most likely to grow a field. A widened
  // store must not put an undocumented number on an operator payload the day it is added.
  const widened = { ...state, secretCounter: 41 } as HookState;
  assert.ok(!JSON.stringify(rhythmSummary(widened)).includes('secretCounter'));
  // And the window is COPIED: the panel's array is not the stored one, which the 5s route cache
  // holds a reference to.
  const out = rhythmSummary(state);
  out.lastKinds.push('callback');
  assert.equal(state.lastKinds.length, 3);
});

test('a chat that has never taken a turn reads as a resting ledger', () => {
  assert.deepEqual(rhythmSummary(defaultHookState()), { lastKinds: [], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0 });
});

// ── the turn:trace rows ──────────────────────────────────────────────────────

function traceEvent(at: number, over: Record<string, unknown> = {}): TraceEvent {
  return {
    id: 1, ts: at, type: 'event', label: TURN_TRACE_LABEL,
    detail: {
      prompt: {
        sections: [{ name: 'persona', chars: 90_000 }, { name: 'turn_focus', chars: 400 }],
        personaChars: 90_000, dynChars: 12_000, anchorChars: 700,
        systemChars: 102_700, messagesChars: 800, transcriptRows: 12,
        transcriptShare: 0.0077, cacheBreakpoints: 2, craft: [],
      },
      gates: {
        threads: { reason: 'offered_theme' },
        memory: { shortHotLook: 'none', hits: [{ kind: 'note', label: 'dana' }], blocks: { notes: { verdict: 'digest', reason: 'partly_kept', dropped: 3 } } },
        extras: { updateNote: false, introWeave: false, activeOps: 0 },
      },
      affect: {
        source: 'emitted', rawEmitted: { mood_label: 'hopeful' },
        coerced: { mood_label: 'hopeful', mood_shift: 'lifted' },
        coercions: [{ field: 'meta_prompt', reason: 'truncated' }],
        drift: { changed: ['warmth'], capped: ['anxiety'], atBound: [], shortened: [], coerced: [], brokeDowngraded: false, applied: { warmth: 3 } },
        targets: null,
      },
      hits: ['dana'],
      // No `gates.hooks` and no `outcome.hook`: the rhythm engine never ran on this turn, which is
      // the pair turnTrace.ts documents as one fact from two sides. The three hook readings get
      // their own test below, where both halves of the receipt move together — a fixture carrying
      // one without the other would be a receipt no turn can file, and this is the fixture the next
      // row-shape test will copy.
      outcome: { wasEnvelope: true, retried: false, silent: false, routingGate: 'skipped_memory_hit' },
      bubbles: { count: 2, overLaw: 0, maxWords: 11, hardCapped: false },
      ...over,
    },
  };
}

function turn(id: string, at: number, events: TraceEvent[]): Turn {
  return {
    id, key: 'chat1', chatId: 'chat1', handle: '+1555', source: 'user',
    startedAt: at, lastAt: at, eventCount: events.length, agents: ['convo'], open: false, events,
  };
}

test('the trace rows are the newest receipts, flattened, newest first', () => {
  const turns: Turn[] = [
    turn('t1', NOW - 3 * MIN, [traceEvent(NOW - 3 * MIN)]),
    turn('t2', NOW - 2 * MIN, [{ id: 2, ts: NOW - 2 * MIN, type: 'event', label: 'threads:select' }]),
    turn('t3', NOW - MIN, [traceEvent(NOW - MIN)]),
  ];
  const rows = traceRows(turns, 20);
  assert.equal(rows.length, 2, 'a turn with no turn:trace receipt contributes no row');
  assert.deepEqual(rows.map(r => r.turnId), ['t3', 't1']);
  const r = rows[0];
  assert.deepEqual(
    { systemChars: r.systemChars, messagesChars: r.messagesChars, share: r.transcriptShare, rows: r.transcriptRows, breakpoints: r.cacheBreakpoints },
    { systemChars: 102_700, messagesChars: 800, share: 0.0077, rows: 12, breakpoints: 2 },
  );
  assert.deepEqual(r.sections, [{ name: 'persona', chars: 90_000 }, { name: 'turn_focus', chars: 400 }]);
  assert.deepEqual({ threads: r.threads, hook_kind: r.hook_kind, hook_mode: r.hook_mode },
    { threads: 'offered_theme', hook_kind: null, hook_mode: null },
    'a receipt whose selector never ran reads null in BOTH hook columns, not a beat and not `none`');
  assert.deepEqual(r.memory, [{ block: 'notes', verdict: 'digest', reason: 'partly_kept', dropped: 3 }]);
  assert.equal(r.routingGate, 'skipped_memory_hit');
  assert.deepEqual(r.drift, { changed: ['warmth'], capped: ['anxiety'], atBound: [], applied: { warmth: 3 }, brokeDowngraded: false });
  assert.deepEqual({ shift: r.shift, source: r.affectSource, coercions: r.coercions }, { shift: 'lifted', source: 'emitted', coercions: 1 });
  assert.deepEqual(r.bubbles, { count: 2, overLaw: 0, maxWords: 11, hardCapped: false });
  assert.deepEqual(r.hits, ['dana']);
});

test('the row limit is honoured and a receipt with no drift claims none', () => {
  const turns = Array.from({ length: 25 }, (_, i) => turn(`t${i}`, NOW - (25 - i) * MIN, [traceEvent(NOW - (25 - i) * MIN)]));
  assert.equal(traceRows(turns, 20).length, 20);
  assert.equal(traceRows(turns, 20)[0].turnId, 't24', 'the newest 20, not the first 20');

  const noDrift = traceEvent(NOW, {
    affect: { source: 'defaulted', rawEmitted: null, coerced: null, coercions: [], drift: null, targets: null },
  });
  const row = traceRows([turn('x', NOW, [noDrift])], 20)[0];
  assert.equal(row.drift, null, 'null drift is a fact about the turn, not an empty report');
  assert.deepEqual({ shift: row.shift, source: row.affectSource }, { shift: null, source: 'defaulted' });
});

test('the trace row tells a flat reply apart from a turn the rhythm engine never ran on', () => {
  // Three readings, one column. `none` is a reply that carried no beat; a MISSING hook field is the
  // negative control — CONVO_HOOKS_ENABLED off, or a caller that is not Convo — and the two must not
  // print the same thing, or the flag-off spot-check in the plan's Verification section proves
  // nothing.
  //
  // Both halves of the receipt move together here, because turnTrace.ts writes them as one fact from
  // two sides: `gates.hooks` is the selector's report and is null when it never ran, `outcome.hook`
  // is what its turn came to and is ABSENT on the same turns. A row with one and not the other is a
  // receipt no turn can file, so the fixtures never build one.
  // The MODE travels with the kind for the reason the column exists: the same word means different
  // turns under different contracts, so the pair is asserted as a pair and never one at a time.
  const ran = (emitted: string, mode: string) => ({
    gates: { hooks: { reason: mode === 'task' ? 'not_idle' : mode, idleLayer: 'fast_path', forbidden: [], lastKinds: ['none', 'tangent'] } },
    outcome: {
      wasEnvelope: true, silent: false,
      hook: { idle: mode === 'hook' || mode === 'quiet', mode, emitted, violation: false },
    },
  });
  const beat = (id: string, over: Record<string, unknown>) => {
    const r = traceRows([turn(id, NOW, [traceEvent(NOW, over)])], 20)[0];
    return { hook_kind: r.hook_kind, hook_mode: r.hook_mode };
  };
  assert.deepEqual(beat('hooked', ran('judgment', 'hook')), { hook_kind: 'judgment', hook_mode: 'hook' });
  assert.deepEqual(beat('shared', ran('question', 'share')), { hook_kind: 'question', hook_mode: 'share' },
    'the one contract under which a question of hers is the move, and the mode column is what says so');
  assert.deepEqual(beat('flat', ran('none', 'task')), { hook_kind: 'none', hook_mode: 'task' });
  assert.deepEqual(beat('off', { gates: {}, outcome: { wasEnvelope: true, silent: false } }),
    { hook_kind: null, hook_mode: null });
  // A receipt from before the field existed reads the same as the flag being off.
  assert.deepEqual(beat('old', { outcome: undefined }), { hook_kind: null, hook_mode: null });
});

test('a corrupt or partial receipt is skipped rather than crashing the panel', () => {
  const junk: TraceEvent = { id: 9, ts: NOW, type: 'event', label: TURN_TRACE_LABEL, detail: { prompt: 'nope' } };
  assert.deepEqual(traceRows([turn('bad', NOW, [junk])], 20), []);
  const noDetail: TraceEvent = { id: 9, ts: NOW, type: 'event', label: TURN_TRACE_LABEL };
  assert.deepEqual(traceRows([turn('bad', NOW, [noDetail])], 20), []);
});

// ── the pending approvals ────────────────────────────────────────────────────
// Read-only: the actions this chat has been asked about and has not answered yet. Nothing in the
// panel can settle one — the decision has to come from the user, in the chat.

test('pending approvals read as id, request, state and how long the ask has been open', () => {
  const rows = pendingApprovalRows([
    opsRow({ id: 'a1', request: 'email my landlord that rent is late', startedAt: NOW - 4 * MIN }),
    opsRow({
      id: 'a2', kind: 'draft', request: 'cancel my gym membership', startedAt: NOW - 40 * MIN,
      meta: { task: { approval: { askedAt: NOW - 40 * MIN, reconfirm: true } } },
    }),
  ], NOW);
  assert.deepEqual(rows, [
    { id: 'a1', kind: 'general', request: 'email my landlord that rent is late', askedAt: NOW - 4 * MIN, ageMs: 4 * MIN, state: 'pending_approval', reconfirm: false, expired: false },
    { id: 'a2', kind: 'draft', request: 'cancel my gym membership', askedAt: NOW - 40 * MIN, ageMs: 40 * MIN, state: 'pending_approval', reconfirm: true, expired: true },
  ]);
});

test('an approval panel with nothing pending is empty, not a row of blanks', () => {
  assert.deepEqual(pendingApprovalRows([], NOW), []);
});

// ── how well she knows them ──────────────────────────────────────────────────
// The one surface the number reaches: the stored level, the band it cuts to, the band her replies are
// actually compiled under, the pace ceiling, the two counters, and what each source is worth.

const FAM_ROW = { level: 52, turns: 40, activeDays: 14, lastDay: '2026-09-02', updatedAt: NOW };
const FAM_EVIDENCE = { ...emptyEvidence(), turns: 40, activeDays: 14, statedFacts: 3, name: 1, moments: 2 };

test('the familiarity row is the stored level, the band it cuts to, and what each source is worth', () => {
  const f = familiaritySummary(FAM_ROW, FAM_EVIDENCE, status(), { enabled: true, group: false });
  assert.deepEqual(
    { level: f.level, band: f.band, effectiveBand: f.effectiveBand, reguarded: f.reguarded, ceiling: f.ceiling, turns: f.turns, activeDays: f.activeDays },
    { level: 52, band: 'familiar', effectiveBand: 'familiar', reguarded: false, ceiling: 100, turns: 40, activeDays: 14 },
  );
  assert.deepEqual(f.sources.find(s => s.key === 'statedFacts'), { key: 'statedFacts', count: 3, points: 6, cap: 16 });
  assert.deepEqual(f.sources.find(s => s.key === 'turns'), { key: 'turns', count: 40, points: 10, cap: 20 });
  assert.equal(f.sources.reduce((n, s) => n + s.cap, 0), 100, 'every source is on the panel');
});

test('rapport landing badly shows as a notch, and the switch off shows the close band replies compile under', () => {
  const notched = familiaritySummary(FAM_ROW, FAM_EVIDENCE, status({ rapport: 20 }), { enabled: true, group: false });
  assert.equal(notched.effectiveBand, 'acquaintance');
  assert.equal(notched.reguarded, true);
  const off = familiaritySummary(FAM_ROW, FAM_EVIDENCE, status({ rapport: 20 }), { enabled: false, group: false });
  assert.equal(off.band, 'familiar', 'what is stored is still shown');
  assert.equal(off.effectiveBand, 'close');
  assert.equal(off.reguarded, false);
});

test('no row yet reads as a stranger at the bottom, and a room is a stranger whatever it stores', () => {
  const none = familiaritySummary(null, emptyEvidence(), undefined, { enabled: true, group: false });
  assert.deepEqual(
    { level: none.level, band: none.band, effectiveBand: none.effectiveBand, ceiling: none.ceiling, turns: none.turns, activeDays: none.activeDays },
    { level: 1, band: 'stranger', effectiveBand: 'stranger', ceiling: 30, turns: 0, activeDays: 0 },
  );
  const room = familiaritySummary({ ...FAM_ROW, level: 90 }, FAM_EVIDENCE, status(), { enabled: true, group: true });
  assert.equal(room.band, 'stranger');
  assert.equal(room.effectiveBand, 'stranger');
});
