import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceSamplesFor, SAMPLE_COUNT, STRETCH_COUNT, PUNCT_COUNT, SAMPLE_REPLIES, PUNCT_RUNS } from './voiceSamples.js';

test('the envelope samples are distinct, stable per minute, and rotate across minutes', () => {
  const seen = new Set<string>();
  for (let m = 29_000_000; m < 29_000_060; m++) {
    const v = voiceSamplesFor(m);
    const samples = v.samples.split(' · ');
    assert.equal(new Set(samples).size, SAMPLE_COUNT, 'no sample twice in one line');
    assert.equal(new Set(v.stretch.split(', ')).size, STRETCH_COUNT, 'no stretched word twice');
    assert.equal(new Set(v.punct.split(', ')).size, PUNCT_COUNT, 'no punctuation run twice');
    assert.deepEqual(voiceSamplesFor(m), v, 'the same minute gives the same line');
    for (const s of samples) seen.add(s);
  }
  assert.ok(seen.size > SAMPLE_REPLIES.length * 0.8, 'an hour of turns shows most of the pool');
});

test('the punctuation pool holds no run twice and no run with a digit', () => {
  assert.equal(new Set(PUNCT_RUNS).size, PUNCT_RUNS.length);
  for (const r of PUNCT_RUNS) assert.ok(!/\d/.test(r) && !r.includes(','), r);
});
