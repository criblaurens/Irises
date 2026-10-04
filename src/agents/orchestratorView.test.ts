// The answer moment's edge line. Principle only: a phrase named at the recency edge gets used
// verbatim (dodge-ledger finding, Sept 2026), so the line carries no quoted sample, and it restates
// the fact lock beside the licence.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_EDGE } from './orchestrator.js';

test('the view edge states the move and the fact lock, with no sample phrasing', () => {
  assert.match(VIEW_EDGE, /goes out first, whole, every fact exactly as it came in/);
  assert.match(VIEW_EDGE, /never adds a figure, date, name or claim that would need its own source/);
  assert.match(VIEW_EDGE, /heavy news gets a plain, careful view and no joke/);
  assert.ok(!VIEW_EDGE.includes('"'), 'no quoted sample utterance at the edge');
});
