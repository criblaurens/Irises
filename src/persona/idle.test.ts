// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The turn gate. One word decides whether a reply may carry a hook, turn toward a bid, or answer
// flat, so these tests are about the three layers and the direction the gate falls when it cannot
// tell:
//
//   • THE WORK VETOES OUTRANK EVERYTHING, including the fast path and including the third shape.
//     "sure" is the most example-shaped token in the file, and "sure" as the answer to her parked
//     approval is a task.
//   • A SIGNAL IS NOT A VETO. A digit, a sentence's worth of tokens or characters, a burst: each
//     proves only that the English examples cannot speak for this message, so the fast path is
//     barred and layer 3 reads the whole thing. Every one of them was a veto before 2026-09-11,
//     which is why a bare life update came back to a flat task turn.
//   • THE EXAMPLES ARE EXAMPLES. Nothing in the English list is a law: the same stall in another
//     language reaches the same answer through the injected classifier, and a token nobody listed
//     costs one call rather than a wrong reading.
//   • AND THE FAST PATH ONLY SPEAKS FOR WHAT IT READ WHOLE. A mixed message ("ok 볼래") tokenizes
//     down to its one English token, so it is the classifier's — the ASCII half is not a verdict.
//   • IT FAILS TOWARD TASK. `ask`, `unclear`, a garbled verdict, a thrown call, a deadline — every
//     one of them is a task, and the layer on the receipt still says the classifier ran.
//   • AND THE FLAG IS A CONTRACT. With `shareTurns` off every signal is a veto again, the follow-up
//     relaxation never applies and a classified `share` reads as a task — so the whole veto table
//     below answers exactly what it answered before the third shape existed. Every test in this file
//     that passes no options is a test of that contract.
//   • PURE. No clock, no lane, no network: the classifier is injected, so every layer here is
//     driven by a stub that counts its own calls.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isIdleTurn, idleVetoes, idleSignals, followUpOnly, leafTokens, leafExamplesExtra, endsInQuestion,
  fastPathCanRead, classifyNeeded,
  LEAF_EXAMPLES, IDLE_LAYERS, IDLE_MAX_TOKENS, IDLE_MAX_CHARS, SHARE_MAX_CHARS, TURN_KINDS,
  QUESTION_MARKS,
  type CheapIdleFacts, type IdleFacts, type IdleOptions, type IdleVerdict,
} from './idle.js';

/** The quiet turn: nothing arrived, nothing is running, nothing is outstanding. */
const CLEAR: IdleFacts = {
  attachmentNote: false, burstSize: 1, activeOps: false,
  pendingAsk: false, endsInQuestion: false, followUpOutstanding: false,
  consent: 'unclear',
};

const facts = (over: Partial<IdleFacts> = {}): IdleFacts => ({ ...CLEAR, ...over });

/** The caller with CONVO_SHARE_TURNS_ENABLED on. Passed EXPLICITLY by every test of the third shape,
 *  so a test that omits it is a test of the flag-off contract and reads as one. */
const SHARE_ON: IdleOptions = { shareTurns: true };

/** Seven tokens of pure example, every one of them on the fast path: the fixture that proves the
 *  token count is not a reading of the words but of how many there are. */
const SEVEN = 'ok cool yeah sure nice thanks lol';

/** A classifier that answers one word and counts how often it was asked. */
function stub(verdict: IdleVerdict | string) {
  const calls: string[] = [];
  const fn = async (text: string): Promise<IdleVerdict> => {
    calls.push(text);
    return verdict as IdleVerdict;
  };
  return { fn, calls };
}

/** A classifier that fails the way a dead lane or a fired deadline fails. */
function thrower(message: string) {
  const calls: string[] = [];
  const fn = async (text: string): Promise<IdleVerdict> => {
    calls.push(text);
    throw new Error(message);
  };
  return { fn, calls };
}

/** Never reached — any test using this asserts the decision was made before the fallback. */
const NEVER = async (): Promise<IdleVerdict> => {
  throw new Error('the classify layer was reached when an earlier layer should have decided');
};

// ── the structural layer ─────────────────────────────────────────────────────

test('the vetoes name every structural reason this turn is work', () => {
  assert.deepEqual(idleVetoes('hey', CLEAR), [], 'a bare stall on a quiet turn clears them all');

  assert.deepEqual(idleVetoes('hey?', CLEAR), ['question_mark']);
  assert.deepEqual(idleVetoes('ok example.com/x', CLEAR), ['url']);
  assert.deepEqual(idleVetoes('ok https://example.test', CLEAR), ['url']);
  assert.deepEqual(idleVetoes('ok www.example.test', CLEAR), ['url']);
  // Past the share cap a message is a thing people want done with, not a bid: the one length that
  // is a veto rather than a signal.
  assert.deepEqual(idleVetoes('a'.repeat(SHARE_MAX_CHARS + 1), CLEAR), ['over_share_cap']);
  assert.deepEqual(idleVetoes('a'.repeat(SHARE_MAX_CHARS), CLEAR), [], 'the cap itself is inside it');

  assert.deepEqual(idleVetoes('hey', facts({ attachmentNote: true })), ['attachment_note']);
  assert.deepEqual(idleVetoes('hey', facts({ activeOps: true })), ['active_ops']);
  // Two facts, one veto: a parked approval and her own last turn ending on a question mark are both
  // an answer owed, and either one alone names it.
  assert.deepEqual(idleVetoes('hey', facts({ pendingAsk: true })), ['pending_question']);
  assert.deepEqual(idleVetoes('hey', facts({ endsInQuestion: true })), ['pending_question']);
  // A consent word is an answer only when there is something to answer. With one owed the reading
  // names the same fact a second time; with nothing owed it is not a fact about the turn at all, and
  // reading it alone made "ok", "yes" and "sure" permanently un-idle.
  assert.deepEqual(idleVetoes('hey', facts({ pendingAsk: true, consent: 'yes' })), ['pending_question', 'consent']);
  assert.deepEqual(idleVetoes('hey', facts({ endsInQuestion: true, consent: 'no' })), ['pending_question', 'consent']);
  assert.deepEqual(idleVetoes('hey', facts({ consent: 'yes' })), [], 'nothing was outstanding, so nothing was answered');
  assert.deepEqual(idleVetoes('hey', facts({ consent: 'no' })), []);
  // 'unclear' settles nothing, so it vetoes nothing — the whole point of a three-way reading.
  assert.deepEqual(idleVetoes('hey', facts({ consent: 'unclear' })), []);
  assert.deepEqual(idleVetoes('hey', facts({ pendingAsk: true, consent: 'unclear' })), ['pending_question']);

  // …and the four facts that are NO LONGER vetoes, named here so the split is pinned from both
  // sides: each of them is a signal now (see the next test), and a signal proves only that this is
  // no stall.
  assert.deepEqual(idleVetoes('ok 4', CLEAR), []);
  assert.deepEqual(idleVetoes(SEVEN, CLEAR), []);
  assert.deepEqual(idleVetoes('。'.repeat(IDLE_MAX_CHARS + 1), CLEAR), []);
  assert.deepEqual(idleVetoes('hey', facts({ burstSize: 2 })), []);
});

test('a question mark vetoes in every script a text message arrives in', () => {
  for (const mark of QUESTION_MARKS) {
    assert.deepEqual(idleVetoes(`ok${mark}`, CLEAR), ['question_mark'], `the ${mark} mark`);
  }
});

test('the signals name every reason this message is no stall — a digit in any script, and the two length reads', () => {
  assert.deepEqual(idleSignals('hey', CLEAR), [], 'a bare stall signals nothing either');

  assert.deepEqual(idleSignals('ok 4', CLEAR), ['digit']);
  assert.deepEqual(idleSignals('ok ٤', CLEAR), ['digit'], 'Arabic-Indic digits are digits');

  assert.equal(SEVEN.split(' ').length, IDLE_MAX_TOKENS + 1, 'the fixture is genuinely one token over');
  assert.deepEqual(idleSignals(SEVEN, CLEAR), ['too_many_tokens'], 'every token is an example, and it is still no stall');

  const long = `${'ok '.repeat(14)}ok`;
  assert.ok([...long].length > IDLE_MAX_CHARS);
  assert.ok(idleSignals(long, CLEAR).includes('too_long'));

  // The character cap is the one that reads a script the tokenizer cannot: this message tokenizes
  // to nothing at all, so only the code-point count can see how long it is.
  const cjk = '。'.repeat(IDLE_MAX_CHARS + 1);
  assert.deepEqual(idleSignals(cjk, CLEAR), ['too_long']);

  // Somebody who sent three texts in a row is not stalling, they are mid-thought — which is exactly
  // how a share arrives, so this one stopped being a veto too.
  assert.deepEqual(idleSignals('hey', facts({ burstSize: 2 })), ['burst']);
  assert.deepEqual(idleSignals('hey', facts({ burstSize: 9 })), ['burst']);
});

test('a bare domain is left to the fallback rather than read as a link', () => {
  // "ok.thanks" is how a person types two words with no space, and a URL veto wide enough to catch
  // a bare domain is wide enough to catch that too — a stall turned into a task for nothing.
  assert.deepEqual(idleVetoes('ok.thanks', CLEAR), []);
});

test('both readings accumulate — the receipt is not limited to the first thing wrong', () => {
  const text = 'did the 3 land at example.com/x?';
  const f = facts({ burstSize: 3, activeOps: true });
  assert.deepEqual(idleVetoes(text, f), ['question_mark', 'url', 'active_ops']);
  assert.deepEqual(idleSignals(text, f), ['digit', 'too_many_tokens', 'burst']);
});

test('followUpOnly is her follow-up standing ALONE — a parked approval outranks it', () => {
  assert.equal(followUpOnly(CLEAR), false, 'nothing outstanding is not a follow-up outstanding');
  assert.equal(followUpOnly(facts({ followUpOutstanding: true })), true);
  // The distinction the whole shape rests on: an approval is an action waiting on a word, and no
  // ledger entry relaxes that.
  assert.equal(followUpOnly(facts({ followUpOutstanding: true, pendingAsk: true })), false);
  assert.equal(followUpOnly(facts({ pendingAsk: true })), false);
});

test('endsInQuestion reads her last turn in any script, through a closing quote', () => {
  assert.equal(endsInQuestion('want me to send it?'), true);
  assert.equal(endsInQuestion('送っていい？'), true);
  assert.equal(endsInQuestion('¿lo mando?'), true);
  assert.equal(endsInQuestion('so, thursday then?"'), true, 'a quoted question is still a question');
  assert.equal(endsInQuestion('sending it now.'), false);
  assert.equal(endsInQuestion('why not? sending it now.'), false, 'a mark mid-sentence is not the end');
  assert.equal(endsInQuestion('u serious?!'), true, 'a question shouted is still a question');
  assert.equal(endsInQuestion('u sure?..'), true, 'a question trailing off is still a question');
  assert.equal(endsInQuestion('since when???'), true);
  assert.equal(endsInQuestion('LETS GO!!!'), false);
  assert.equal(endsInQuestion('ok...'), false);
  assert.equal(endsInQuestion(''), false);
  assert.equal(endsInQuestion(null), false);
  assert.equal(endsInQuestion(undefined), false);
});

// ── layer 1: the veto path ───────────────────────────────────────────────────

// The pre-2026-09-11 veto table, unchanged and passed no options: every row that was work is still
// work, through the same layer, and the signals ride along on the receipt without deciding anything.
// This IS the flag's contract — the four signal rows in it are work only because the flag is off.
test('a lead-in is a task: the thing is still coming, so it earns no hook', async () => {
  const never = async (): Promise<never> => { throw new Error('no call for a lead-in the examples read'); };
  for (const text of ['btw', 'cool\n\nbtw', 'ok so', 'wait']) {
    const reading = await isIdleTurn(text, facts({ burstSize: text.includes('\n') ? 2 : 1 }), never, { shareTurns: true });
    assert.deepEqual([reading.shape, reading.layer], ['task', 'fast_path'], text);
  }
  // A lead-in the examples cannot read reaches the classifier, whose `preface` word is a task too.
  const classified = await isIdleTurn('ey btw', facts(), async () => 'preface', { shareTurns: true });
  assert.deepEqual([classified.shape, classified.layer], ['task', 'classify']);
  // A stall that merely contains no lead-in at the end is still a stall.
  assert.equal((await isIdleTurn('hmm', facts(), never, { shareTurns: true })).shape, 'idle');
});

test('a veto ends the turn as work, before the fast path and before any call', async () => {
  const rows: Array<[string, IdleFacts, string[]]> = [
    ['hey?', CLEAR, []],                                    // a question mark
    ['ok 4', CLEAR, ['digit']],                             // a digit
    ['ok example.com/x', CLEAR, []],                        // a link
    [SEVEN, CLEAR, ['too_many_tokens']],                    // seven tokens, every one an example
    ['yes please', facts({ pendingAsk: true }), []],
    ['yes please', facts({ endsInQuestion: true }), []],
    ['sure', facts({ pendingAsk: true, consent: 'yes' }), []],
    ['hey', facts({ attachmentNote: true }), []],
    ['hey', facts({ burstSize: 2 }), ['burst']],
    ['ok', facts({ activeOps: true }), []],
  ];
  for (const [text, f, signals] of rows) {
    assert.deepEqual(await isIdleTurn(text, f, NEVER), { shape: 'task', layer: 'veto', signals }, JSON.stringify(text));
  }
});

test('"sure" is the most example-shaped token there is, and a settled yes outranks it — with a question open', async () => {
  // The precedence that matters most: the fast path would call this idle in one lookup, and the
  // consent reader has already read it as permission for something irreversible.
  assert.ok(leafTokens().has('sure'), 'the fixture is genuinely on the fast path');
  assert.deepEqual(await isIdleTurn('sure', facts({ pendingAsk: true, consent: 'yes' }), NEVER),
    { shape: 'task', layer: 'veto', signals: [] });
  assert.deepEqual(await isIdleTurn('sure', CLEAR, NEVER), { shape: 'idle', layer: 'fast_path', signals: [] });
});

// …and the other half of that precedence, which the veto used to get wrong. The consent reader says
// what the word would MEAN if it settled something; with nothing parked it settles nothing, and read
// on its own it made the three commonest stalls there are un-idle forever.
test('a consent word with nothing outstanding is a stall, and the fast path says so for free', async () => {
  for (const text of ['ok', 'sure']) {
    assert.ok(leafTokens().has(text), `${text} is genuinely on the fast path`);
    for (const consent of ['yes', 'no'] as const) {
      assert.deepEqual(await isIdleTurn(text, facts({ consent }), NEVER), { shape: 'idle', layer: 'fast_path', signals: [] },
        `"${text}" read as ${consent} with nothing to answer`);
    }
  }
  // With her question outstanding the same reading is an answer twice over, and the receipt says so
  // twice: "yes please" after "want me to send it?" is the most load-bearing task turn there is.
  assert.deepEqual(idleVetoes('yes please', facts({ pendingAsk: true, consent: 'yes' })),
    ['pending_question', 'consent'], 'both reasons, in the fixed order');
  assert.deepEqual(await isIdleTurn('yes please', facts({ pendingAsk: true, consent: 'yes' }), NEVER),
    { shape: 'task', layer: 'veto', signals: [] });
});

// ── layer 2: the English fast path ───────────────────────────────────────────

test('a short message made only of examples is idle, with no call at all', async () => {
  const c = stub('ask');
  for (const text of ['im bored', 'hmm', 'same', 'ok', 'hey', 'nothing much', 'lol', 'night']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, c.fn), { shape: 'idle', layer: 'fast_path', signals: [] }, text);
  }
  assert.deepEqual(c.calls, [], 'the fast path is free — it never reaches the lane');
});

test('the fast path is case- and apostrophe-insensitive, the way a token is', async () => {
  // Both apostrophes: the straight one and the curly one an iPhone actually types.
  for (const text of ['OK', "I'm bored", 'I’m bored', 'Hey', '  hmm  ']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, NEVER), { shape: 'idle', layer: 'fast_path', signals: [] }, text);
  }
});

test('the fast path never decides a message it only half read', async () => {
  // The MIXED-script message is the one that bites: "ok 볼래" tokenizes to ['ok'] — one perfect
  // example token, and a request the ASCII tokenizer never saw. Judged on those tokens alone it
  // reads as a stall, so the fast path is barred from it and the classifier gets the whole message.
  const mixed = ['ok 볼래', 'hmm 明日は', 'ok 👍'];

  const asked = stub('ask');
  for (const text of mixed) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, asked.fn), { shape: 'task', layer: 'classify', signals: [] }, text);
  }
  assert.deepEqual(asked.calls, mixed, 'and it was asked about the WHOLE message, not the ASCII half');

  // …and the bar is not a veto: the same messages come back idle when the classifier reads them as
  // stalls. The fast path gave up the answer, not the outcome.
  const stalled = stub('stall');
  for (const text of mixed) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, stalled.fn), { shape: 'idle', layer: 'classify', signals: [] }, text);
  }

  // The ASCII half on its own is still the free path it always was.
  assert.deepEqual(await isIdleTurn('ok', CLEAR, NEVER), { shape: 'idle', layer: 'fast_path', signals: [] });
});

test('fastPathCanRead is exactly "the tokenizer dropped nothing"', () => {
  for (const text of ['ok', 'nothing much', "i'm bored", 'i’m bored', 'ok.thanks', '  hmm  ', '']) {
    assert.equal(fastPathCanRead(text), true, JSON.stringify(text));
  }
  for (const text of ['ok 볼래', 'hmm 明日は', 'ok 👍', 'café', 'да', 'ok ¡vale']) {
    assert.equal(fastPathCanRead(text), false, JSON.stringify(text));
  }
});

test('the example set is small, lowercase and unpunctuated — a shortcut, not a lexicon', () => {
  assert.ok(LEAF_EXAMPLES.length < 60, `the list is ${LEAF_EXAMPLES.length} long; it is meant to stay small`);
  assert.equal(new Set(LEAF_EXAMPLES).size, LEAF_EXAMPLES.length, 'no token is listed twice');
  for (const token of LEAF_EXAMPLES) {
    assert.match(token, /^[a-z0-9]+$/, `${token}: a token, so it can actually match one`);
  }
  // The words a piece of work is made of are deliberately NOT in here: an example set that swallowed
  // a verb would turn a deployment into a stall.
  for (const token of ['deploy', 'prod', 'run', 'test', 'kill', 'container', 'meeting', 'moved', 'shift', 'tomorrow']) {
    assert.ok(!leafTokens().has(token), `${token}: work is never an example`);
  }
});

// ── layer 3: the injected classifier ─────────────────────────────────────────

test('work that clears the vetoes and fails the fast path goes to the classifier, and comes back task', async () => {
  const c = stub('ask');
  for (const text of ['deploy prod', 'run test', 'kill container', 'morning meeting moved', 'night shift tomorrow']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, c.fn), { shape: 'task', layer: 'classify', signals: [] }, text);
  }
  assert.deepEqual(c.calls, ['deploy prod', 'run test', 'kill container', 'morning meeting moved', 'night shift tomorrow']);
});

test('a stall the English list cannot read is idle, through the classifier', async () => {
  // The 2026-09-04 rule in one test: none of these tokenizes to an example (two of them tokenize to
  // nothing at all), and every one of them is the same idle turn "hmm" is.
  const c = stub('stall');
  for (const text of ['bosan', 'sama', 'nada', 'ya', 'なんもない', 'что-то']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, c.fn), { shape: 'idle', layer: 'classify', signals: [] }, text);
  }
  assert.equal(c.calls.length, 6, 'one call each');
});

test('the classifier is read strictly: only the exact words stall, share and unclear are not work', async () => {
  for (const verdict of ['ask', 'failed', 'STALL?', 'stalling', 'sharing', 'yes', '', 'stall me']) {
    const c = stub(verdict);
    assert.deepEqual(await isIdleTurn('bosan', CLEAR, c.fn, SHARE_ON), { shape: 'task', layer: 'classify', signals: [] },
      JSON.stringify(verdict));
  }
  // …but the word itself survives the whitespace and capitals a lane puts on it.
  for (const verdict of ['stall', 'STALL', ' stall\n']) {
    const c = stub(verdict);
    assert.deepEqual(await isIdleTurn('bosan', CLEAR, c.fn), { shape: 'idle', layer: 'classify', signals: [] }, JSON.stringify(verdict));
  }
  // A genuine unclear is a person saying something the lane could not place: a share when the shape
  // is on, the old task when it is off. A failed reading is always a task.
  assert.deepEqual(await isIdleTurn('bosan', CLEAR, stub('unclear').fn, SHARE_ON), { shape: 'share', layer: 'classify', signals: [] });
  assert.deepEqual(await isIdleTurn('bosan', CLEAR, stub('unclear').fn), { shape: 'task', layer: 'classify', signals: [] });
  for (const verdict of ['share', 'SHARE', ' share\n']) {
    const c = stub(verdict);
    assert.deepEqual(await isIdleTurn('bosan', CLEAR, c.fn, SHARE_ON), { shape: 'share', layer: 'classify', signals: [] },
      JSON.stringify(verdict));
  }
});

test('a thrown, dead or timed-out classifier is a task, and the receipt still says it ran', async () => {
  for (const message of ['no classify lane configured', 'idle classify timed out']) {
    const c = thrower(message);
    assert.deepEqual(await isIdleTurn('bosan', CLEAR, c.fn), { shape: 'task', layer: 'classify', signals: [] }, message);
    assert.equal(c.calls.length, 1, 'it was really asked');
  }
});

test('a turn with nothing to read is a task, and no layer claims to have read it', async () => {
  for (const text of ['', '   ', '\n \t ']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, NEVER), { shape: 'task', layer: 'none', signals: [] }, JSON.stringify(text));
  }
});

test('every layer and every shape the gate can report is a member of its own union', async () => {
  const layers = new Set<string>();
  layers.add((await isIdleTurn('', CLEAR, NEVER)).layer);
  layers.add((await isIdleTurn('hey?', CLEAR, NEVER)).layer);
  layers.add((await isIdleTurn('hey', CLEAR, NEVER)).layer);
  layers.add((await isIdleTurn('bosan', CLEAR, stub('stall').fn)).layer);
  assert.deepEqual([...layers].sort(), [...IDLE_LAYERS].sort(), 'all four, and nothing else');

  const shapes = new Set<string>();
  shapes.add((await isIdleTurn('hey?', CLEAR, NEVER, SHARE_ON)).shape);
  shapes.add((await isIdleTurn('hey', CLEAR, NEVER, SHARE_ON)).shape);
  shapes.add((await isIdleTurn('bosan', CLEAR, stub('share').fn, SHARE_ON)).shape);
  assert.deepEqual([...shapes].sort(), [...TURN_KINDS].sort(), 'all three, and nothing else');
});

// ── the third shape ──────────────────────────────────────────────────────────

test('a classified share is a share turn, whatever the message looked like structurally', async () => {
  const c = stub('share');
  for (const text of ['morning meeting moved', 'bosan', 'kinda tired today ngl']) {
    assert.deepEqual(await isIdleTurn(text, CLEAR, c.fn, SHARE_ON), { shape: 'share', layer: 'classify', signals: [] }, text);
  }
  assert.equal(c.calls.length, 3, 'one call each — the classifier is the only thing that can name a bid');
});

// The rows the split moved: each of these was a veto before 2026-09-11 and came back a flat task
// turn with nothing to deliver. Now the message reaches the lane, and a `stall` on a message too
// long, too numerous or too many messages to BE a stall is the classifier describing a bid.
test('the signal rows reach the classifier with the shape on, and a stall there is a share', async () => {
  const rows: Array<[string, IdleFacts, string[]]> = [
    ['ok 4', CLEAR, ['digit']],
    [SEVEN, CLEAR, ['too_many_tokens']],
    ['。'.repeat(IDLE_MAX_CHARS + 1), CLEAR, ['too_long']],
    ['hey', facts({ burstSize: 2 }), ['burst']],
  ];
  for (const [text, f, signals] of rows) {
    const c = stub('stall');
    assert.deepEqual(await isIdleTurn(text, f, c.fn, SHARE_ON), { shape: 'share', layer: 'classify', signals },
      JSON.stringify(text));
    assert.deepEqual(c.calls, [text.trim()], 'and it was asked');
    // The same row, with the flag off, is the work turn it has always been.
    assert.deepEqual(await isIdleTurn(text, f, NEVER), { shape: 'task', layer: 'veto', signals }, JSON.stringify(text));
  }
  // A signal bars the fast path, and the bar is not a veto: a short message of pure examples that a
  // burst arrived behind is read by the lane, not by the list.
  const barred = stub('ask');
  assert.deepEqual(await isIdleTurn('hey', facts({ burstSize: 3 }), barred.fn, SHARE_ON),
    { shape: 'task', layer: 'classify', signals: ['burst'] });
  assert.deepEqual(barred.calls, ['hey']);
});

test('the work vetoes outrank the third shape, and the share cap is one of them', async () => {
  const rows: Array<[string, IdleFacts]> = [
    ['is it done?', CLEAR],
    ['ok example.com/x', CLEAR],
    ['a'.repeat(SHARE_MAX_CHARS + 1), CLEAR],
    ['long day', facts({ attachmentNote: true })],
    ['long day', facts({ activeOps: true })],
    ['long day', facts({ pendingAsk: true })],
    ['long day', facts({ endsInQuestion: true })],
  ];
  for (const [text, f] of rows) {
    // NEVER: a work veto costs no call at all, with the shape on exactly as without it.
    const { shape, layer } = await isIdleTurn(text, f, NEVER, SHARE_ON);
    assert.deepEqual({ shape, layer }, { shape: 'task', layer: 'veto' }, JSON.stringify(text.slice(0, 20)));
  }
});

test('her own follow-up is the one question of hers whose answer is another share', async () => {
  const followUp = facts({ endsInQuestion: true, followUpOutstanding: true });

  // A one-word "meh" answering "how did it sit with you" is the smallest share there is: the fast
  // path can still read it, and reading it as an IDLE turn would spend a hook on it and leave the
  // question she asked hanging.
  assert.deepEqual(await isIdleTurn('meh', followUp, NEVER, SHARE_ON), { shape: 'share', layer: 'fast_path', signals: [] });
  const stalled = stub('stall');
  assert.deepEqual(await isIdleTurn('bosan', followUp, stalled.fn, SHARE_ON), { shape: 'share', layer: 'classify', signals: [] });

  // …and the relaxation is only ever about HER follow-up. A parked approval is an action waiting on
  // a word, so both vetoes stand and the turn is work.
  const parked = facts({ endsInQuestion: true, followUpOutstanding: true, pendingAsk: true, consent: 'yes' });
  assert.deepEqual(idleVetoes('sure', parked, SHARE_ON), ['pending_question', 'consent']);
  assert.deepEqual(await isIdleTurn('sure', parked, NEVER, SHARE_ON), { shape: 'task', layer: 'veto', signals: [] });

  // Their answer can still be a piece of work: the relaxation opens the shape, it does not decide it.
  const asked = stub('ask');
  assert.deepEqual(await isIdleTurn('send it to them', followUp, asked.fn, SHARE_ON),
    { shape: 'task', layer: 'classify', signals: [] });
});

test('with the flag off the third shape is unreachable, layer for layer', async () => {
  const followUp = facts({ endsInQuestion: true, followUpOutstanding: true });

  // A `share` verdict is a task: the gate read a bid and the install has nowhere to put one.
  const shared = stub('share');
  assert.deepEqual(await isIdleTurn('morning meeting moved', CLEAR, shared.fn),
    { shape: 'task', layer: 'classify', signals: [] });
  assert.equal(shared.calls.length, 1, 'the call is still made — only the reading collapses');

  // The relaxation never applies, so her follow-up is her question and their answer is work.
  assert.deepEqual(idleVetoes('meh', followUp), ['pending_question']);
  assert.deepEqual(await isIdleTurn('meh', followUp, NEVER), { shape: 'task', layer: 'veto', signals: [] });

  // And an explicit `false` is the same install as no options at all.
  assert.deepEqual(await isIdleTurn('meh', followUp, NEVER, { shareTurns: false }),
    { shape: 'task', layer: 'veto', signals: [] });
});

// ── the env extras ───────────────────────────────────────────────────────────

test('LEAF_EXAMPLES_EXTRA widens the fast path at call time, with no code change', async () => {
  const saved = process.env.LEAF_EXAMPLES_EXTRA;
  try {
    delete process.env.LEAF_EXAMPLES_EXTRA;
    assert.deepEqual(leafExamplesExtra(), []);
    const before = stub('ask');
    assert.deepEqual(await isIdleTurn('mkay', CLEAR, before.fn), { shape: 'task', layer: 'classify', signals: [] }, 'unknown today');

    process.env.LEAF_EXAMPLES_EXTRA = ' MKAY , yeh ,, ';
    assert.deepEqual(leafExamplesExtra(), ['mkay', 'yeh'], 'trimmed, lowercased, blanks dropped');
    assert.ok(leafTokens().has('mkay'));
    assert.deepEqual(await isIdleTurn('mkay', CLEAR, NEVER), { shape: 'idle', layer: 'fast_path', signals: [] }, 'and read at call time');
    assert.deepEqual(await isIdleTurn('yeh mkay', CLEAR, NEVER), { shape: 'idle', layer: 'fast_path', signals: [] });

    // An extra widens the fast path and never a reading of length: seven tokens of extras is a
    // message the examples may not speak for, whichever side of the flag the install is on.
    assert.deepEqual(await isIdleTurn('mkay yeh mkay yeh mkay yeh mkay', CLEAR, NEVER),
      { shape: 'task', layer: 'veto', signals: ['too_many_tokens'] });
    const c = stub('share');
    assert.deepEqual(await isIdleTurn('mkay yeh mkay yeh mkay yeh mkay', CLEAR, c.fn, SHARE_ON),
      { shape: 'share', layer: 'classify', signals: ['too_many_tokens'] });
  } finally {
    if (saved === undefined) delete process.env.LEAF_EXAMPLES_EXTRA;
    else process.env.LEAF_EXAMPLES_EXTRA = saved;
  }
  assert.ok(!leafTokens().has('mkay'), 'the env is restored for the rest of the file');
});

// ── purity ───────────────────────────────────────────────────────────────────

test('the gate never mutates what it was handed', async () => {
  const f = facts({ burstSize: 3 });
  const before = JSON.stringify(f);
  idleVetoes('hey there you', f);
  idleSignals('hey there you', f);
  await isIdleTurn('hey there you', f, NEVER);
  await isIdleTurn('hey there you', f, stub('share').fn, SHARE_ON);
  assert.equal(JSON.stringify(f), before);
  assert.equal(LEAF_EXAMPLES.length, new Set(LEAF_EXAMPLES).size, 'and the example list is still itself');
});

test('the gate is deterministic — the same message twice is the same answer twice', async () => {
  const c = stub('stall');
  assert.deepEqual(await isIdleTurn('bosan', CLEAR, c.fn), await isIdleTurn('bosan', CLEAR, c.fn));
  const s = stub('share');
  assert.deepEqual(await isIdleTurn('bosan', CLEAR, s.fn, SHARE_ON), await isIdleTurn('bosan', CLEAR, s.fn, SHARE_ON));
  assert.deepEqual(idleVetoes('did the 3 land?', CLEAR), idleVetoes('did the 3 land?', CLEAR));
  assert.deepEqual(idleSignals('did the 3 land?', CLEAR), idleSignals('did the 3 land?', CLEAR));
});

// ── the prefetch predicate ───────────────────────────────────────────────────
//
// `classifyNeeded` is the caller's licence to start layer 3 in parallel with its own memory read
// (convo/client.ts), so it answers with a SUBSET of the facts the gate will have. Its contract is
// one-directional and that is the only thing worth pinning: it may say yes where the gate later
// vetoes (five wasted tokens), and it may never say no where the gate goes on to classify (a wrong
// reading paid for with a latency win nobody asked for).

/** The prefetch's view of a turn: the two facts a caller holds before the memory read answers. */
const CHEAP: CheapIdleFacts = { attachmentNote: false, burstSize: 1 };

test('the predicate never withholds a call the gate goes on to make', async () => {
  // Every shape in this file's tables, on both sides of the flag: a stall, a share, a work ask, a
  // message the tokenizer cannot read, a burst, an attachment, a vetoed message, a signal-bearing
  // one. The gate is driven with the LOOSEST facts the predicate assumes, because that is the case
  // where the two are actually comparable — with a veto in hand the gate stops early and the
  // prediction is allowed to have been wrong.
  const messages = [
    'hey', 'ok', SEVEN, 'bosan', 'ok 볼래', 'hmm 明日は', 'deploy the cedars order',
    'the morning meeting moved to friday', 'nothing much just tired', 'i am so done with today',
    'ok.thanks', 'a'.repeat(SHARE_MAX_CHARS + 1), 'did the 3 land', 'hey?', '',
  ];
  for (const opts of [undefined, SHARE_ON]) {
    for (const text of messages) {
      const c = stub('share');
      await isIdleTurn(text, CLEAR, c.fn, opts);
      const predicted = classifyNeeded(text, CHEAP, opts);
      if (c.calls.length) {
        assert.equal(predicted, true, `the gate classified "${text}" and the predicate said no`);
      }
      // …and the other direction is a claim about waste, not about correctness: a predicted call the
      // gate did not make is only ever legal where a fact the predicate cannot see decided it, and
      // with CLEAR facts there is no such fact.
      assert.equal(predicted, c.calls.length > 0, `"${text}" (share turns ${opts ? 'on' : 'off'})`);
    }
  }
});

test('the predicate reads the two facts it is given, and assumes nothing about the rest', () => {
  // A file that really arrived is a veto the caller holds before the memory read, so it spends no
  // call at all. A burst is a SIGNAL — with the third shape on it bars the fast path and the message
  // goes to the lane, and with it off it is a veto again, exactly as in the gate's own table.
  assert.equal(classifyNeeded('bosan', { ...CHEAP, attachmentNote: true }, SHARE_ON), false);
  assert.equal(classifyNeeded('hey', { ...CHEAP, burstSize: 3 }, SHARE_ON), true, 'a burst is not a stall');
  assert.equal(classifyNeeded('hey', { ...CHEAP, burstSize: 3 }), false, 'and off the flag it is a veto');
  // The facts it CANNOT see are assumed at their loosest, which is what makes a yes here safe: a
  // parked approval settles the turn at the gate, and the abandoned call is the price of the guess.
  assert.equal(classifyNeeded('bosan', CHEAP, SHARE_ON), true);
});
