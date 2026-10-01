// The early-emit gate: streamArmed (whole-turn), sentenceBlocker (per-sentence) and
// cleanEarlySentence (the shared cosmetic cleanup). All three are pure, so these tests never touch
// the model, the DB or the clock.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  streamArmed, sentenceBlocker, cleanEarlySentence, remainderAfterPrefix, settleOnScreen, cleanBubbles, type PreCallFacts,
} from './earlyEmit.js';

const CLEAN: PreCallFacts = {
  hasParkedApproval: false,
  hookMode: 'task',
  groundingFlagged: false,
  isGroupChat: false,
  introOrFirstMove: false,
  isBurst: false,
  enabled: true,
};

test('streamArmed: true when every fact is clean', () => {
  assert.equal(streamArmed(CLEAN), true);
});

test('streamArmed: an undefined hookMode reads the same as a task turn', () => {
  assert.equal(streamArmed({ ...CLEAN, hookMode: undefined }), true);
});

test('streamArmed: a share turn arms — the share law is enforced in the prompt, not by a rewrite', () => {
  assert.equal(streamArmed({ ...CLEAN, hookMode: 'share' }), true);
});

test('streamArmed: a hook (idle-turn) mode arms — same reason, the hook law is enforced in the prompt', () => {
  assert.equal(streamArmed({ ...CLEAN, hookMode: 'hook' }), true);
});

test('streamArmed: a quiet turn never arms — enforceQuiet can still rewrite the draft after generation', () => {
  assert.equal(streamArmed({ ...CLEAN, hookMode: 'quiet' }), false);
});

test('streamArmed: each other fact flips it false on its own', () => {
  assert.equal(streamArmed({ ...CLEAN, hasParkedApproval: true }), false, 'parked approval');
  assert.equal(streamArmed({ ...CLEAN, groundingFlagged: true }), false, 'grounding flagged');
  assert.equal(streamArmed({ ...CLEAN, isGroupChat: true }), false, 'group chat');
  assert.equal(streamArmed({ ...CLEAN, introOrFirstMove: true }), false, 'intro / first move');
  assert.equal(streamArmed({ ...CLEAN, isBurst: true }), false, 'burst — bubble 0\'s thread target is unknown');
  assert.equal(streamArmed({ ...CLEAN, enabled: false }), false, 'STREAM_FIRST_BUBBLE off');
});

test('sentenceBlocker: an unkept promise', () => {
  assert.equal(sentenceBlocker('ok, lemme check that', 'whats the latest node LTS'), 'promise');
});

test('sentenceBlocker: an unbacked claim', () => {
  assert.equal(sentenceBlocker('got it, revised the morning one', 'can you move it earlier'), 'claim');
});

test('sentenceBlocker: a bare done on a turn that asked nothing is their day, and streams', () => {
  // The whole-reply guard reads it that way (unkeptPromise.ts BARE_CLAIM_PHRASES), so the early
  // check must too, or a share turn's "done" would disarm a reply the full pass lets ship.
  assert.equal(sentenceBlocker('deck: done', 'finally finished the deck', false), null);
  assert.equal(sentenceBlocker('deck: done', 'change my reminder to 8'), 'claim');
  assert.equal(sentenceBlocker('got it, revised the morning one', 'lol', false), 'claim');
});

test('sentenceBlocker: a clean sentence carrying no failure shape', () => {
  assert.equal(sentenceBlocker('408', 'whats 17% of 2400'), null);
});

test('sentenceBlocker: a capability refusal (routingGate.test.ts fixture)', () => {
  assert.equal(sentenceBlocker("i can't browse the web from here", 'whats the latest node LTS'), 'refusal');
});

test('sentenceBlocker: raw Ops scaffolding reads as an internal leak', () => {
  assert.equal(sentenceBlocker('ANSWER: yes', 'is the store open'), 'internal');
});

test('cleanEarlySentence: strips a leaked reply-routing tag', () => {
  assert.equal(cleanEarlySentence('[[re:2]]yes'), 'yes');
});

test('remainderAfterPrefix: an unchanged prefix leaves exactly the tail bubbles', () => {
  const r = remainderAfterPrefix(['oh nice', 'what did you put in it?', 'mine always burns'], ['Oh  nice']);
  assert.deepEqual(r, { rest: ['what did you put in it?', 'mine always burns'], diverged: false });
});

test('remainderAfterPrefix: a prefix that ends inside a bubble leaves the rest of that bubble', () => {
  // The stream closed a sentence where the bubble splitter did not ("etc." is an abbreviation to it).
  const r = remainderAfterPrefix(['eggs, rice, etc. and a lot of chili', 'classic'], ['eggs, rice, etc.']);
  assert.deepEqual(r, { rest: ['and a lot of chili', 'classic'], diverged: false });
});

test('remainderAfterPrefix: the whole reply already out leaves nothing to send', () => {
  assert.deepEqual(remainderAfterPrefix(['408'], ['408']), { rest: [], diverged: false });
});

test('remainderAfterPrefix: a diverged reply never repeats what already went out', () => {
  const r = remainderAfterPrefix(['oh nice', 'actually wait', 'what rice?'], ['oh nice', 'love that']);
  assert.equal(r.diverged, true);
  assert.deepEqual(r.rest, ['actually wait', 'what rice?']);
  // …and a bubble equal to an emitted sentence, wherever it sits, is dropped.
  assert.deepEqual(remainderAfterPrefix(['new take', 'Love that'], ['oh nice', 'love that']).rest, ['new take']);
});

test('remainderAfterPrefix: a prefix that stops mid-word is a divergence, never a cut', () => {
  assert.equal(remainderAfterPrefix(['heyo there'], ['hey']).diverged, true);
});

test('remainderAfterPrefix: an empty prefix leaves everything', () => {
  assert.deepEqual(remainderAfterPrefix(['a', 'b'], []), { rest: ['a', 'b'], diverged: false });
});

test('settleOnScreen: an unchanged reply ships whole and is recorded whole', () => {
  assert.deepEqual(settleOnScreen(['oh nice.'], 'oh nice.\n---\nwhat did you put in it?'),
    { text: 'oh nice.\n---\nwhat did you put in it?', record: 'oh nice.\n---\nwhat did you put in it?' });
});

test('settleOnScreen: a replaced reply drops a bubble they already have, and the record leads with it', () => {
  const out = settleOnScreen(['oh nice.'], 'oh nice sorry, i cant check that\n---\noh nice.\n---\nwhat was it?');
  assert.equal(out.text, 'oh nice sorry, i cant check that\n---\nwhat was it?');
  assert.equal(out.record, 'oh nice.\n---\noh nice sorry, i cant check that\n---\nwhat was it?');
});

test('settleOnScreen: a replacement that only starts with the same letters keeps every word', () => {
  assert.equal(settleOnScreen(['ok.'], 'okay lemme check that').text, 'okay lemme check that');
  assert.equal(settleOnScreen(['no.'], 'nope not that one').text, 'nope not that one');
});

test('settleOnScreen: an echoed timestamp marker on the first bubble is the same line, not a new one', () => {
  const final = '[9:14 AM] thats 408.\n---\nnice round number';
  const out = settleOnScreen(['thats 408.'], final);
  assert.equal(out.text, final, 'nothing diverged: it ships whole and the boundary cuts the prefix');
  assert.deepEqual(remainderAfterPrefix(cleanBubbles(final), ['thats 408.']), { rest: ['nice round number'], diverged: false });
});

test('settleOnScreen: nothing left to ship still records what went out', () => {
  assert.deepEqual(settleOnScreen(['oh nice.'], null), { text: null, record: 'oh nice.' });
});

test('remainderAfterPrefix: a final bubble that only adds a closing run of marks is already sent', () => {
  const r = remainderAfterPrefix(['ohhh no. WAIT', 'u better not say it\'s u"...'], ['ohhh no.', 'WAIT', 'u better not say it\'s u']);
  assert.deepEqual(r, { rest: [], diverged: false });
});
