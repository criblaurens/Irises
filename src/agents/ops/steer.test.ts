// steerWithRetry: delivering a mid-run addition through hermes's narrow steerable window.
// DI everywhere (a stub EngineBackend, an injected sleep) — no module mocks, no real backoff waits.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steerWithRetry, steerPrompt, STEER_ATTEMPTS } from './steer.js';
import { EngineRunError, type EngineBackend, type EngineRunHandle } from './engineBackend.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';

const HANDLE: EngineRunHandle = { engine: 'hermes', runId: 'run_1' };
const WHERE = { chatId: 'web:debug', agentHandle: '+15551234567', taskId: 't1' };

/** An engine that answers `steerRun` from a script — one entry per attempt. A `string` is an
 *  outcome; an Error is thrown. */
function engineWith(script: Array<'accepted' | 'not_running' | Error>, calls: Array<{ handle: EngineRunHandle; text: string }> = []): EngineBackend {
  let i = 0;
  return {
    name: 'hermes',
    async runTask() { throw new Error('not used'); },
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* noop */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
    async steerRun(handle, text) {
      calls.push({ handle, text });
      const step = script[Math.min(i++, script.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

/** An engine with no steer route at all — OpenClaw today (no gateway RPC for it was found). */
function engineWithoutSteer(): EngineBackend {
  const be = engineWith(['accepted']) as Record<string, unknown>;
  delete be.steerRun;
  return be as unknown as EngineBackend;
}

function steerTrace(): Record<string, unknown> | undefined {
  return getTraces().find(e => e.label === 'ops:steer')?.detail as Record<string, unknown> | undefined;
}

test('steerPrompt: the wrapper is the exact text the engine is meant to read', () => {
  // Pinned whole, not by fragments: this is the human-authored engine-facing wording, and the
  // clauses are load-bearing — "the work you are doing now" is what stops a restart, the contract
  // restatement is what keeps an ANSWER/SOURCE/ACTIONS/FLAGS block for the composer to read, and
  // the FLAGS clause is what turns a steer that missed its window into something the user hears.
  assert.equal(steerPrompt('  also check jakarta  '), [
    'The user just added to this task mid-run: "also check jakarta"',
    'Fold it into the work you are doing now. Keep the same output contract (ANSWER / NOTICED / SOURCE / ACTIONS / FLAGS). If it arrived too late to act on, say so in FLAGS in one line rather than restarting.',
  ].join('\n'));
});

test('steerWithRetry: accepted on the first attempt, with a receipt saying so', async () => {
  clearTraces();
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  const slept: number[] = [];
  const out = await steerWithRetry(engineWith(['accepted'], calls), HANDLE, 'also check jakarta', WHERE, {
    sleep: async ms => { slept.push(ms); },
  });
  assert.equal(out, 'accepted');
  assert.equal(calls.length, 1);
  assert.deepEqual(slept, [], 'no backoff on a first-try accept');
  assert.equal(calls[0].text, steerPrompt('also check jakarta'), 'the engine gets the wrapped text, not the raw words');
  const detail = steerTrace();
  assert.equal(detail?.accepted, true);
  assert.equal(detail?.runId, 'run_1');
  assert.equal(detail?.attempts, 1);
});

test('steerWithRetry: a 409 during hermes\'s agent-construction window is retried, then lands', async () => {
  clearTraces();
  // hermes only accepts a steer while the run's status is exactly `running`, and a fresh run spends
  // a second or two queued/constructing. That window is the ENTIRE reason this retries at all.
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  const slept: number[] = [];
  const out = await steerWithRetry(engineWith(['not_running', 'not_running', 'accepted'], calls), HANDLE, 'under 100k', WHERE, {
    sleep: async ms => { slept.push(ms); },
  });
  assert.equal(out, 'accepted');
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [1500, 1500], 'one wait between attempts, none after the last');
  assert.equal(steerTrace()?.attempts, 3);
});

test('steerWithRetry: a run that never becomes steerable gives up honestly, and does not throw', async () => {
  clearTraces();
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  const out = await steerWithRetry(engineWith(['not_running'], calls), HANDLE, 'under 100k', WHERE, {
    sleep: async () => { /* instant */ },
  });
  assert.equal(out, 'not_running');
  assert.equal(calls.length, STEER_ATTEMPTS, 'the ladder is bounded');
  const detail = steerTrace();
  assert.equal(detail?.accepted, false);
  assert.equal(detail?.reason, 'not_running');
});

test('steerWithRetry: an engine with no steer route says so without pretending', async () => {
  clearTraces();
  const out = await steerWithRetry(engineWithoutSteer(), HANDLE, 'under 100k', WHERE, { sleep: async () => { /* instant */ } });
  assert.equal(out, 'unsupported');
  const detail = steerTrace();
  assert.equal(detail?.accepted, false);
  assert.equal(detail?.reason, 'unsupported');
});

test('steerWithRetry: a THROWING steer is swallowed — a courtesy call must never break the turn', async () => {
  clearTraces();
  // This runs inside a live Convo turn (steer_research) and beside a running leg. Whatever the
  // engine does with a steer, the user's reply and the run itself outrank it.
  const boom = new EngineRunError('hermes rejected the API key (401)', 'needs_auth', 401);
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  const out = await steerWithRetry(engineWith([boom], calls), HANDLE, 'under 100k', WHERE, { sleep: async () => { /* instant */ } });
  assert.equal(out, 'not_running');
  assert.equal(calls.length, 1, 'an error is not the construction window — no point retrying it');
  const detail = steerTrace();
  assert.equal(detail?.accepted, false);
  assert.equal(detail?.reason, 'error');
  assert.match(String(detail?.error), /401/);
});

test('steerWithRetry: an aborted signal stops the ladder where it stands', async () => {
  clearTraces();
  const ac = new AbortController();
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  const out = await steerWithRetry(engineWith(['not_running'], calls), HANDLE, 'under 100k', WHERE, {
    signal: ac.signal,
    sleep: async () => { ac.abort(); },
  });
  assert.equal(out, 'not_running');
  assert.equal(calls.length, 1, 'the run is gone — retrying into it is waste');
});

test('steerWithRetry: blank text is not an addition and never reaches the engine', async () => {
  clearTraces();
  const calls: Array<{ handle: EngineRunHandle; text: string }> = [];
  assert.equal(await steerWithRetry(engineWith(['accepted'], calls), HANDLE, '   ', WHERE), 'not_running');
  assert.equal(calls.length, 0);
});
