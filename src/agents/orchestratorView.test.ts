// The answer moment's edge line. Principle only: a phrase named at the recency edge gets used
// verbatim (dodge-ledger finding, Sept 2026), so the line carries no quoted sample, and it restates
// the fact lock beside the licence.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_EDGE, skippedStepRelay, nextStepClause, offerTextOf } from './orchestrator.js';
import { loadContext } from './loadContext.js';

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

test('with no next step the answer keeps its standing rule; with one, offering it is her call', () => {
  assert.equal(nextStepClause(), 'never a "want me to?" question', 'byte for byte what the answer said before');
  const clause = nextStepClause('hold the 9am fare for them');
  assert.match(clause, /"hold the 9am fare for them"/);
  assert.match(clause, /offering it is your call/);
  assert.match(clause, /one yes\/no question in your last bubble/);
  assert.match(clause, /otherwise leave it out/);
  assert.doesNotMatch(clause, /want me to/, 'no sample phrasing');
});

test('the composer persona names the one exception to its no-offer rule', () => {
  assert.match(loadContext('composer'), /the one exception is a next step your brief itself hands you as yours to offer/);
});

test('the parked offer text keeps her last bubble on a long answer, with reply tags stripped', () => {
  assert.equal(offerTextOf('[[re:1]]the 9am is $412\n---\nhold it for you?'), 'the 9am is $412 / hold it for you?');
  const long = offerTextOf(`[[re:1]]${'the 9am is $412 and the 11am is $380. '.repeat(30)}\n---\n[[re:2]]hold the 9am for you?`);
  assert.equal(long.length, 600, 'capped at 600');
  assert.ok(long.startsWith('…'), 'the head is what gets cut');
  assert.ok(long.endsWith(' / hold the 9am for you?'), 'the offer they said yes to survives the cap');
  assert.doesNotMatch(long, /\[\[re:/);
});
