// The NEXT line: one step toward what they want that the run did not take. The engine names it as a
// statement; it comes off the answer before anything is voiced, and whether to offer it is hers.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt, splitNextLine, runTask } from './client.js';
import { HERMES_TASK_HEADER, HERMES_ONBOARDING_MESSAGE } from './hermesDoctrine.js';
import { OPENCLAW_TASK_HEADER, OPENCLAW_ONBOARDING_MESSAGE } from './openclawDoctrine.js';
import { resetEngineBackendCache, type EngineBackend } from './engineBackend.js';
import { stripOpsScaffolding } from '../guardrails.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask } from '../types.js';

const AT = { now: Date.parse('2026-10-04T09:30:00Z'), tz: 'UTC' };
const mkTask = (): OpsTask => ({ id: 't1', chatId: 'web:debug', agentHandle: '+15551234567', kind: 'general', request: 'cheapest flight to bali next week', effect: 'read', createdAt: AT.now, media: emptyMedia() });

test('the output contract offers an optional NEXT line between ACTIONS and FLAGS, a statement never a question', () => {
  const lines = buildTaskPrompt(mkTask(), AT).split('\n');
  const actions = lines.findIndex(l => l.startsWith('ACTIONS: '));
  const next = lines.findIndex(l => l.startsWith('NEXT: '));
  const flags = lines.findIndex(l => l.startsWith('FLAGS: '));
  assert.ok(actions >= 0 && next === actions + 1 && flags === next + 1, lines.join('\n'));
  assert.match(lines[next], /never a question/);
  assert.match(lines[next], /omit the line otherwise/);
});

test('both engines know the NEXT line, in the per-task header and in the standing section', () => {
  for (const [name, header, standing] of [['hermes', HERMES_TASK_HEADER, HERMES_ONBOARDING_MESSAGE], ['openclaw', OPENCLAW_TASK_HEADER, OPENCLAW_ONBOARDING_MESSAGE]] as const) {
    assert.match(header, /optional ACTIONS \/ optional NEXT \/ FLAGS/, name);
    assert.match(standing, /A NEXT line may follow, just before FLAGS and just as optional/, name);
    assert.match(standing, /never a question, never an offer/, name);
    assert.match(standing, /ANSWER \/ SOURCE \/ optional ACTIONS \/ optional NEXT \/ FLAGS/, name);
  }
});

test('a NEXT line comes off the answer as the next step, and the answer keeps everything else', () => {
  assert.deepEqual(splitNextLine('ANSWER: 42\nSOURCE: web\nNEXT: hold the 9am fare for them\nFLAGS: none'), { summary: 'ANSWER: 42\nSOURCE: web\nFLAGS: none', next: 'hold the 9am fare for them' });
  assert.deepEqual(splitNextLine('ANSWER: 42\nFLAGS: none'), { summary: 'ANSWER: 42\nFLAGS: none' });
  assert.deepEqual(splitNextLine('ANSWER: 42\nNEXT: none\nFLAGS: none'), { summary: 'ANSWER: 42\nFLAGS: none' });
  assert.deepEqual(splitNextLine('ANSWER: next: the fare drops on the 12th'), { summary: 'ANSWER: next: the fare drops on the 12th' }, 'only the label at a line start');
});

test('the last NEXT line is the step, and no NEXT line is left in the answer', () => {
  assert.deepEqual(
    splitNextLine('ANSWER: the page says\nNEXT: wire them the deposit\nSOURCE: web\nNEXT: hold the 9am fare for them\nFLAGS: none'),
    { summary: 'ANSWER: the page says\nSOURCE: web\nFLAGS: none', next: 'hold the 9am fare for them' },
  );
  assert.deepEqual(splitNextLine('ANSWER: x\nNEXT: wire them the deposit\nNEXT: none\nFLAGS: none'), { summary: 'ANSWER: x\nFLAGS: none' }, 'a closing none is no step');
});

test('runTask hands the step on as result.next, and the summary never carries it', async () => {
  const engine = (text: string): EngineBackend => ({
    name: 'hermes', runTask: async () => text,
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; }, async listReminders() { return []; },
    async cancelReminder() { return false; }, async remember() {}, async probe() { return { ok: true }; }, async channelSend() { return {}; },
  });
  try {
    resetEngineBackendCache(engine('ANSWER: 42\nNEXT: hold the 9am fare for them\nFLAGS: none'));
    const withNext = await runTask(mkTask());
    assert.equal(withNext.next, 'hold the 9am fare for them');
    assert.doesNotMatch(withNext.summary, /NEXT/);
    resetEngineBackendCache(engine('ANSWER: 42\nFLAGS: none'));
    const plain = await runTask(mkTask());
    assert.equal('next' in plain, false);
    assert.equal(plain.summary, 'ANSWER: 42\nFLAGS: none');
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('a leaked NEXT label is dropped from a bubble, and her own lowercase "next:" is left alone', () => {
  assert.equal(stripOpsScaffolding('NEXT: hold the 9am fare for them'), '');
  assert.equal(stripOpsScaffolding('next: the boards ship monday'), 'next: the boards ship monday');
});
