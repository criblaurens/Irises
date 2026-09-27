import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceSamplesFor, SAMPLE_COUNT, STRETCH_COUNT, SAMPLE_REPLIES } from './voiceSamples.js';

test('the envelope samples are distinct, stable per minute, and rotate across minutes', () => {
  const seen = new Set<string>();
  for (let m = 29_000_000; m < 29_000_060; m++) {
    const v = voiceSamplesFor(m);
    const samples = v.samples.split(' · ');
    assert.equal(new Set(samples).size, SAMPLE_COUNT, 'no sample twice in one line');
    assert.equal(new Set(v.stretch.split(', ')).size, STRETCH_COUNT, 'no stretched word twice');
    assert.deepEqual(voiceSamplesFor(m), v, 'the same minute gives the same line');
    for (const s of samples) seen.add(s);
  }
  assert.ok(seen.size > SAMPLE_REPLIES.length * 0.8, 'an hour of turns shows most of the pool');
});
