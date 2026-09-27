// Run with: npm test   (TZ=UTC DATA_BACKEND=memory tsx --test)
// The shared Composer call, with the LLM injected (repo convention: DI, no module mocks). What's
// under test is the ASSEMBLY both callers depend on: the instruction inside <prompt>, the format
// anchor as the very last thing the model reads, the JSON envelope bridged to legacy bubble text,
// the echo tripwire firing only when there IS a line already on their screen, and the throw that
// hands the degrade decision back to the caller.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { composeWithComposer, buildComposerDynamic, FORMAT_ANCHOR } from './composerCore.js';
import { renderPersonaBlock } from '../persona/policy.js';
import { addMessage } from '../db/repositories/conversations.js';
import { saveAffectState } from '../db/repositories/affectState.js';
import { coerceStatus, mergeStatus, type ComputedState } from '../persona/status.js';
import { computeCycle } from '../persona/cycle.js';
import { computeCircadian } from '../persona/circadian.js';
import { saveRelationshipClimate } from '../db/repositories/relationshipClimate.js';
import { defaultClimate, type RelationshipClimate } from '../persona/climate.js';
import { groupHandle } from '../memory/identity.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { getFamiliarity, saveFamiliarity } from '../db/repositories/familiarity.js';
import type { LlmRequest, LlmResult } from '../llm/types.js';

function fakeLlm(text: string, captured: LlmRequest[] = []) {
  return (async (req: LlmRequest): Promise<LlmResult> => {
    captured.push(req);
    return { text, provider: 'anthropic', model: 'fake', usage: { inputTokens: 0, outputTokens: 0 } } as unknown as LlmResult;
  }) as never;
}

const base = {
  chatId: 'web:a',
  handle: '',
  trace: { chatId: 'web:a', handle: '', label: 'composer-test' },
};

beforeEach(() => resetStorageForTests());

test('the JSON envelope becomes legacy bubble text; the instruction rides inside <prompt>', async () => {
  const captured: LlmRequest[] = [];
  const out = await composeWithComposer({
    ...base,
    buildInstruction: () => 'the deadline is march 14',
    llm: fakeLlm('{"bubbles":[{"text":"deadline\'s march 14"},{"text":"you\'ve got time"}],"confidence_level":90}', captured),
  });
  assert.equal(out, "deadline's march 14\n---\nyou've got time");
  const last = captured[0].messages.at(-1)!;
  assert.match(String(last.content), /<prompt>[\s\S]*the deadline is march 14[\s\S]*<\/prompt>/);
  assert.equal(captured[0].jsonBubbles, true);
  assert.ok(captured[0].system, 'the composer persona is the system prompt');
  assert.ok(String(captured[0].system).startsWith(renderPersonaBlock('composer')), 'the shared persona block leads the system prompt, ahead of Context.md');
});

test('the format anchor is the LAST thing in the message (recency holds the split rule)', async () => {
  const captured: LlmRequest[] = [];
  await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    llm: fakeLlm('{"bubbles":[{"text":"ok"}]}', captured),
  });
  assert.ok(String(captured[0].messages.at(-1)!.content).endsWith(FORMAT_ANCHOR));
});

test('buildInstruction receives the fetched history, and the voice window is the last 10 turns', async () => {
  for (let i = 0; i < 12; i++) await addMessage('web:a', 'user', `m${i}`, '+1555');
  const captured: LlmRequest[] = [];
  let seen = 0;
  await composeWithComposer({
    ...base,
    buildInstruction: history => { seen = history.length; return 'x'; },
    llm: fakeLlm('{"bubbles":[{"text":"ok"}]}', captured),
  });
  assert.equal(seen, 12, 'the callback sees the FULL history, not the sliced window');
  assert.equal(captured[0].messages.length, 11, '10 history turns + the brief');
  assert.equal(String(captured[0].messages[0].content), 'm2');
});

test('an echoed holding line is stripped — but only when a holding line was given', async () => {
  const envelope = '{"bubbles":[{"text":"checking your inbox nownothing under amazon in there"}]}';
  const stripped = await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    holdingText: 'checking your inbox now',
    llm: fakeLlm(envelope),
  });
  assert.equal(stripped, 'nothing under amazon in there');

  const untouched = await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    llm: fakeLlm(envelope),
  });
  assert.equal(untouched, 'checking your inbox nownothing under amazon in there');
});

test('a stray [[re:N]] tag never reaches the send path', async () => {
  const out = await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    llm: fakeLlm('{"bubbles":[{"text":"[[re:2]] got it"}]}'),
  });
  assert.equal(out, 'got it');
});

test('an empty reply retries once, then the second success is used', async () => {
  let n = 0;
  const out = await composeWithComposer({
    ...base,
    buildInstruction: () => 'x',
    llm: (async () => {
      n++;
      return { text: n === 1 ? '' : '{"bubbles":[{"text":"second time"}]}' } as unknown as LlmResult;
    }) as never,
  });
  assert.equal(out, 'second time');
  assert.equal(n, 2);
});

test('two failed attempts throw — the caller owns the degrade', async () => {
  let n = 0;
  await assert.rejects(
    composeWithComposer({
      ...base,
      buildInstruction: () => 'x',
      errorDetail: { moment: 'answer' },
      llm: (async () => { n++; throw new Error('provider down'); }) as never,
    }),
    /provider down/,
  );
  assert.equal(n, 2, 'exactly one retry, then it gives up');
});

test('two empty replies throw too (an empty completion is a failure, not a message)', async () => {
  await assert.rejects(
    composeWithComposer({ ...base, buildInstruction: () => 'x', llm: fakeLlm('') }),
    /no text/,
  );
});

// --- read-only mood continuity: the carried affect is threaded into the compose -----------------

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1)),
  circadian: computeCircadian(Date.UTC(2026, 0, 6, 16, 0, 0), 'UTC'),
};
const RAW = {
  mood_core: 'joyful', mood_label: 'hopeful', mood_level: 72,
  anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, conviction: 60,
  engagement: 70, patience: 75, intent_mode: 'sharing_update', epistemic_trigger: 'logic_valid',
  meta_prompt: 'keep it light and follow their lead', profile_note: 'warm, forward-looking',
  terminal_closure: false,
};

test('a fresh carried affect state is injected — weather BEFORE the facts, anchor still last, no status asked', async () => {
  await saveAffectState('web:a', mergeStatus(coerceStatus(RAW)!, COMPUTED, Date.now()));
  const captured: LlmRequest[] = [];
  await composeWithComposer({
    ...base,
    buildInstruction: () => 'the deadline is march 14',
    llm: fakeLlm('{"bubbles":[{"text":"deadline\'s march 14"}]}', captured),
  });
  const content = String(captured[0].messages.at(-1)!.content);

  const wIdx = content.indexOf('INTERNAL weather');
  const fIdx = content.indexOf('the deadline is march 14');
  assert.ok(wIdx >= 0, 'the internal-weather block is present');
  assert.ok(wIdx < fIdx, 'the weather colours voice BEFORE the facts are stated');
  assert.match(content, /hopeful/);                   // the carried mood rode in
  assert.ok(content.endsWith(FORMAT_ANCHOR), 'FORMAT_ANCHOR is still the very last thing');

  // read-only: the composer is never asked to (re-)emit a status field, and keeps its own envelope.
  // The shared persona block now rides in the system prompt (not this message), so no split-out is
  // needed here — the persona's one "status" mention (the machinery-is-invisible line) never reaches
  // this final user message at all.
  assert.doesNotMatch(content, /status/i);
  assert.equal(captured[0].envelopeSchema, undefined); // default bubbles+confidence envelope, unchanged
  assert.equal(captured[0].jsonBubbles, true);
});

test('a stale carried affect state is NOT injected (>45min)', async () => {
  await saveAffectState('web:a', mergeStatus(coerceStatus(RAW)!, COMPUTED, Date.now() - 46 * 60_000));
  const captured: LlmRequest[] = [];
  await composeWithComposer({
    ...base,
    buildInstruction: () => 'the deadline is march 14',
    llm: fakeLlm('{"bubbles":[{"text":"ok"}]}', captured),
  });
  const content = String(captured[0].messages.at(-1)!.content);
  assert.doesNotMatch(content, /INTERNAL weather/); // stale mood is dropped
  assert.ok(content.endsWith(FORMAT_ANCHOR));
});

test('with no carried affect state the compose is unchanged (no weather block)', async () => {
  const captured: LlmRequest[] = [];
  await composeWithComposer({
    ...base,
    buildInstruction: () => 'the deadline is march 14',
    llm: fakeLlm('{"bubbles":[{"text":"ok"}]}', captured),
  });
  const content = String(captured[0].messages.at(-1)!.content);
  assert.doesNotMatch(content, /INTERNAL weather/);
  assert.ok(content.endsWith(FORMAT_ANCHOR));
});

// --- the relationship-climate read: the kill switch and the group guard -------------------------
// This is the READ half of RELATIONSHIP_CLIMATE_ENABLED (the eval half is pinned in
// memory/climateDrift.test.ts). It has to be gated here too: with only the eval switched off, a
// register that had already drifted would stay frozen in every prompt, still colouring her voice,
// with nothing left running to move it back.

const MOVED: RelationshipClimate = {
  ...defaultClimate(), dials: { ease: 70, candor: 80, playfulness: 60 }, evalCount: 30,
};

/** Compose one message for `handle` and return what the model was shown. */
async function composedFor(handle: string, opts: { room?: boolean } = {}): Promise<string> {
  const captured: LlmRequest[] = [];
  await composeWithComposer({
    ...base,
    handle,
    ...opts,
    trace: { chatId: 'web:a', handle, label: 'composer-test' },
    buildInstruction: () => 'the deadline is march 14',
    llm: fakeLlm('{"bubbles":[{"text":"ok"}]}', captured),
  });
  return String(captured[0].messages.at(-1)!.content);
}

test('a moved climate colours the compose — and the kill switch takes it back to nothing', async () => {
  const h = '+15550002222';
  await saveRelationshipClimate(h, MOVED);
  assert.match(await composedFor(h), /standing register/, 'the register rides in when the flag is on');

  process.env.RELATIONSHIP_CLIMATE_ENABLED = 'off';
  try {
    const off = await composedFor(h);
    assert.doesNotMatch(off, /standing register/);
    // Byte-identical to a handle that never had a register at all: off means the feature costs the
    // prompt nothing, not that it renders something smaller. The row itself is left alone.
    assert.equal(off, await composedFor('+15550003333'));
  } finally {
    delete process.env.RELATIONSHIP_CLIMATE_ENABLED;
  }
  assert.match(await composedFor(h), /standing register/, 'flipping it back restores what was earned');
});

// The eval never runs for a group, so a group row can only be legacy or hand-written data — but
// "one member's rough afternoon must not set the register for everyone in the room" is too load
// bearing to rest on what the writer happens to skip. The read refuses it structurally.
test('a group identity never renders a register, even with a moved row stored under it', async () => {
  const g = groupHandle('web:a');
  await saveRelationshipClimate(g, MOVED);
  assert.doesNotMatch(await composedFor(g), /standing register/);
});

// --- the familiarity mask: the Composer relays a stranger composed ------------------------------
// The same band Convo's turn reads, off the same row, under the same gates, with the same rapport
// notch, and never written from here. A drained row files under sad, the one core whose close line
// carries a put-off clause, so close, familiar and stranger are three different lines.

const SAD_CLOSE = '- You are drained (sad). Fewer words. No tangents. Answer, then stop. Anything open-ended they ask today, research, long writing, a favour with no clock, is too much: say not now, and it stays owed.';
const SAD_FAMILIAR = '- You are drained (sad). Fewer words. No tangents. Answer, then stop.';
const SAD_STRANGER = '- Underneath you are drained (sad), but with someone you barely know you wear your brightest self: bubbly, big reactions and stretched words (sooo, omggg, nooo), laughing easily, the jester, curious about them and asking, sideways and specific. Asked how you really are, you drop it and say the true feeling; asked why you are so bright, you say it plainly: your creator made you cheerful with people you are still getting to know, so they get to know you.';

/** A fresh drained row in the composer's chat, the gauges stated (rapport is the one the notch reads). */
async function seedDrained(rapport = 40): Promise<void> {
  await saveAffectState('web:a', {
    ...mergeStatus(coerceStatus({ ...RAW, mood_label: 'drained', mood_core: 'sad' })!, COMPUTED, Date.now()),
    mood_level: 60, anxiety: 40, warmth: 60, social_battery: 70, rapport, patience: 60,
  });
}

/** The weather block's mood line, out of what the model was shown. */
const moodLine = (content: string) => content.split('\n').find(l => /^- (You are|Underneath you are) /.test(l));

test('the mask is off by default in the Composer too, and a stranger relays composed once it is on', async () => {
  const known = '+15550004343';
  const fresh = '+15550004444';
  await seedDrained();
  await saveFamiliarity(known, { level: 5, turns: 3, activeDays: 1, lastDay: '2026-01-05' });
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  try {
    assert.equal(moodLine(await composedFor(known)), SAD_CLOSE, 'off: no mask, whatever is stored');
    process.env.CONVO_FAMILIARITY_ENABLED = 'on';
    assert.equal(moodLine(await composedFor(fresh)), SAD_STRANGER, 'on, and no row yet: a stranger');
    assert.equal(moodLine(await composedFor(known)), SAD_STRANGER, 'on, and a low row: still a stranger');
    assert.equal(await getFamiliarity(fresh), null, 'the Composer never writes the ledger');
    assert.equal((await getFamiliarity(known))?.turns, 3, 'nor counts a turn on a row that exists');
  } finally {
    delete process.env.CONVO_FAMILIARITY_ENABLED;
  }
});

test('a room relays composed whatever its row says, and rapport landing badly notches the relay', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  try {
    await seedDrained();
    const room = groupHandle('web:a');
    await saveFamiliarity(room, { level: 95, turns: 500, activeDays: 60, lastDay: '2026-01-05' });
    assert.equal(moodLine(await composedFor(room)), SAD_STRANGER, 'a room is front stage');

    const close = '+15550004545';
    await saveFamiliarity(close, { level: 90, turns: 400, activeDays: 40, lastDay: '2026-01-05' });
    assert.equal(moodLine(await composedFor(close)), SAD_CLOSE, 'someone close gets the whole line');
    await seedDrained(20);
    assert.equal(moodLine(await composedFor(close)), SAD_FAMILIAR, 'close pulled up to familiar: no put-off');
  } finally {
    delete process.env.CONVO_FAMILIARITY_ENABLED;
  }
});

// A look delegated out of a room keys on the member who asked (their prefs, their research stash),
// so its handle is personal and says nothing about who else will read the answer. The caller says
// so, and the relay into a room is a stranger whatever that member's own row holds.
test('a relay into a room is a stranger even under the asker\'s own close row', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  try {
    await seedDrained();
    const owner = '+15550004646';
    await saveFamiliarity(owner, { level: 90, turns: 400, activeDays: 40, lastDay: '2026-01-05' });
    assert.equal(moodLine(await composedFor(owner)), SAD_CLOSE, 'one to one, the owner gets the whole line');
    assert.equal(moodLine(await composedFor(owner, { room: true })), SAD_STRANGER, 'in a room, composed');
    assert.equal((await getFamiliarity(owner))?.turns, 400, 'and the owner\'s own row is left as it was');
  } finally {
    delete process.env.CONVO_FAMILIARITY_ENABLED;
  }
});

// --- the dynamic block's own order ---------------------------------------------------------------
// buildComposerDynamic is the pure half of the assembly above: three strings in, one <prompt> body
// out. The shared persona block no longer rides here — it moved to the system prompt (see
// `composeWithComposer`'s `system` assembly, and the persona-in-system assertion above) — so what's
// left to pin is the order of what still does: weather, then facts, then the memory layer.

test('the dynamic block is weather, facts, memory — in that order', () => {
  const dynamic = buildComposerDynamic('## Where you are right now\nweather', 'the deadline is march 14', 'how to address them: Sam');
  const at = (needle: string) => dynamic.indexOf(needle);
  assert.ok(dynamic.startsWith('## Where you are right now'), 'weather leads when it is present');
  assert.ok(at('## Where you are right now') < at('the deadline is march 14'), 'weather before the facts');
  assert.ok(at('the deadline is march 14') < at('how to address them: Sam'), 'the facts before the memory layer');
});

test('an empty weather or memory layer drops out, and the facts still lead', () => {
  const dynamic = buildComposerDynamic('', 'the deadline is march 14', '');
  assert.equal(dynamic, 'the deadline is march 14', 'no blank joins, no empty sections');
});
