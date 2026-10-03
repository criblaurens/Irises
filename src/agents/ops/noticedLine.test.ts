// The NOTICED line: what the engine saw on the way that gives the answer its meaning. The composer's
// view of a finding is made of it (composer/Context.md "what you make of it"), so the contract asks for
// it on every run, both engines' per-task headers name it, and a leaked label never reaches a bubble.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from './client.js';
import { HERMES_TASK_HEADER } from './hermesDoctrine.js';
import { OPENCLAW_TASK_HEADER } from './openclawDoctrine.js';
import { stripOpsScaffolding } from '../guardrails.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask } from '../types.js';

const AT = { now: Date.parse('2026-10-04T09:30:00Z'), tz: 'UTC' };

function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 't1', chatId: 'web:debug', agentHandle: '+15551234567', kind: 'general',
    request: 'cheapest flight to bali next week', effect: 'read', createdAt: AT.now, media: emptyMedia(), ...over,
  };
}

test('the output contract asks for a NOTICED line between ANSWER and SOURCE', () => {
  const lines = buildTaskPrompt(mkTask(), AT).split('\n');
  const answer = lines.findIndex(l => l.startsWith('ANSWER: '));
  const noticed = lines.findIndex(l => l.startsWith('NOTICED: '));
  const source = lines.findIndex(l => l.startsWith('SOURCE: '));
  assert.ok(answer >= 0 && noticed === answer + 1 && source === noticed + 1, lines.join('\n'));
  assert.match(lines[noticed], /never an extra lookup/);
  assert.match(lines[noticed], /"none"/);
});

test('both per-task headers name the NOTICED line in the reply shape', () => {
  for (const header of [HERMES_TASK_HEADER, OPENCLAW_TASK_HEADER]) {
    assert.match(header, /ANSWER \/ NOTICED \/ SOURCE \/ optional ACTIONS \/ FLAGS/);
  }
});

test('a leaked NOTICED label is stripped and its value kept', () => {
  assert.equal(stripOpsScaffolding('NOTICED: fares ~40% above september'), 'fares ~40% above september');
  assert.equal(stripOpsScaffolding('  noticed: school holiday week  '), 'school holiday week');
});
