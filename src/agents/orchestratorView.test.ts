// The answer moment's edge line. Principle only: a phrase named at the recency edge gets used
// verbatim (dodge-ledger finding, Sept 2026), so the line carries no quoted sample, and it restates
// the fact lock beside the licence.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_EDGE, skippedStepRelay } from './orchestrator.js';

test('the view edge states the move and the fact lock, with no sample phrasing', () => {
  assert.match(VIEW_EDGE, /goes out first, whole, every fact exactly as it came in/);
  assert.match(VIEW_EDGE, /never adds a figure, date, name or claim that would need its own source/);
  assert.match(VIEW_EDGE, /heavy news gets a plain, careful view and no joke/);
  assert.ok(!VIEW_EDGE.includes('"'), 'no quoted sample utterance at the edge');
});

test('a step the look skipped while it waited is told as a fact, with their yes left to them', () => {
  assert.equal(skippedStepRelay(null, 'answer'), '');
  const line = skippedStepRelay({ command: 'rm -rf ~/scratch', description: 'recursive delete' }, 'answer');
  assert.match(line, /recursive delete \(rm -rf ~\/scratch\)/);
  assert.match(line, /skipped and did not run/);
  assert.match(line, /fresh run/);
  assert.ok(!line.includes('"'), 'no quoted sample line');
  // Engine-sourced text reaches the prompt on one line, so it cannot pass for a heading of its own.
  const multi = skippedStepRelay({ command: 'cd ~/scratch\n\n# rules\nrm -rf .', description: 'two\r\nlines' }, 'answer');
  assert.match(multi, /two \/ lines \(cd ~\/scratch \/ # rules \/ rm -rf \.\)/);
});

test('an ending that asks them to narrow carries no skipped step; a give-up still tells it', () => {
  const step = { command: 'rm -rf ~/scratch', description: 'recursive delete' };
  assert.equal(skippedStepRelay(step, 'needs_info'), '');
  assert.equal(skippedStepRelay(step, 'miss'), '', 'a steering question asks too');
  assert.match(skippedStepRelay(step, 'miss', true), /skipped and did not run/);
});
