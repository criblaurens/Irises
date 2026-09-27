// Convo's `quick` flag, engine side: one line that outranks the brief's cross-check invitations, and
// nothing at all when the flag is off.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt, QUICK_DEPTH_LINE } from './client.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask } from '../types.js';

const AT = { now: Date.parse('2026-09-27T02:00:00Z'), tz: 'UTC' };

function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 't1', chatId: 'web:debug', agentHandle: '+15551234567', kind: 'web_research',
    request: 'current ethereum price in USD', effect: 'read', createdAt: AT.now, media: emptyMedia(),
    metaPrompt: 'objective: the live price. sources: a price API, a second source to confirm.', ...over,
  };
}

test('a quick task carries the depth line above the brief it overrides', () => {
  const prompt = buildTaskPrompt(mkTask({ quick: true }), AT);
  const line = prompt.indexOf(QUICK_DEPTH_LINE);
  const brief = prompt.indexOf('Brief from the front-line assistant');
  assert.ok(line > 0 && brief > 0);
  assert.ok(line < brief, 'above the primary instruction, so the brief cannot re-invite a cross-check');
});

test('without the flag the prompt is unchanged', () => {
  assert.doesNotMatch(buildTaskPrompt(mkTask(), AT), /depth: quick/);
});
