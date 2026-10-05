process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markOpsStart, markOpsDone, getActiveOps, isDuplicateDelegation,
  requestOpsCancel, isOpsCancelled, noteOpsProgress, hasInFlightRequest,
  normalizeRequest, __resetOpsCoordination, markOpsRetry, getOpsEtaStatus,
  opsStaleMs, OPS_STALE_SLACK_MS,
  noteOpsEngineRun, getOpsEngineRun, requestOpsSteer, takePendingSteers,
  beginOpsEngineLeg, endOpsEngineLeg, noteOpsSteerUnreachable, extendOpsLeg,
  enqueueEngineAsk, settleEngineAsk, dropEngineAsks, noteEngineAskDeclined, engineAskDeclined,
} from './opsCoordination.js';
import { BROWSER_LEG_BUDGET_MS, ENGINE_APPROVAL_WAIT_MS } from '../agents/ops/engineBackend.js';

test('markOpsStart is visible to a synchronous getActiveOps in the same tick (no async race)', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'document_read', request: 'pull up that receipt' });
  const active = getActiveOps('chatA');
  assert.equal(active.length, 1);
  assert.equal(active[0].request, 'pull up that receipt');
  assert.equal(active[0].kind, 'document_read');
});

test('markOpsDone clears only the matching taskId; a concurrent distinct task survives', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'hours for the corner cafe' });
  markOpsStart('chatA', 'task2', { kind: 'general', request: 'how did the launch go' });
  markOpsDone('chatA', 'task1');
  const active = getActiveOps('chatA');
  assert.equal(active.length, 1);
  assert.equal(active[0].request, 'how did the launch go');
});

test('isDuplicateDelegation reports in_flight for an identical (case/space-insensitive) running ask', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'Hours For The Corner Cafe' });
  assert.equal(isDuplicateDelegation('chatA', 'web_research', 'hours for   the corner cafe'), 'in_flight');
  assert.equal(isDuplicateDelegation('chatA', 'web_research', 'hours for the other place'), null);
});

test('after the task finishes it reports recent (not in_flight) within the window', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'hours for the corner cafe' });
  markOpsDone('chatA', 'task1');
  assert.equal(isDuplicateDelegation('chatA', 'web_research', 'hours for the corner cafe'), 'recent');
});

test('one chat never sees another chat\'s in-flight work', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'hours for the corner cafe' });
  assert.equal(getActiveOps('chatB').length, 0);
  assert.equal(isDuplicateDelegation('chatB', 'web_research', 'hours for the corner cafe'), null);
});

test('normalizeRequest is case/whitespace-insensitive and scoped by kind', () => {
  assert.equal(normalizeRequest('general', '  Hello   World '), normalizeRequest('general', 'hello world'));
  assert.notEqual(normalizeRequest('general', 'x'), normalizeRequest('web_research', 'x'));
});

test('requestOpsCancel signals a running task: flag set, controller aborted, hidden from getActiveOps', () => {
  __resetOpsCoordination();
  const cancel = new AbortController();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'full inbox scan' }, cancel);
  assert.equal(requestOpsCancel('chatA', 'task1'), 'signalled');
  assert.equal(isOpsCancelled('chatA', 'task1'), true);
  assert.equal(cancel.signal.aborted, true);
  assert.equal(getActiveOps('chatA').length, 0); // cancelled = no longer "still pulling"
});

test('requestOpsCancel on a finished/unknown task reports already_done', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'full inbox scan' });
  markOpsDone('chatA', 'task1');
  assert.equal(requestOpsCancel('chatA', 'task1'), 'already_done');
  assert.equal(requestOpsCancel('chatA', 'never-existed'), 'already_done');
  assert.equal(isOpsCancelled('chatA', 'task1'), false);
});

test('a cancelled run neither blocks a re-ask as in_flight nor as recent', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'full inbox scan' });
  assert.equal(isDuplicateDelegation('chatA', 'general', 'full inbox scan'), 'in_flight');
  requestOpsCancel('chatA', 'task1');
  // "actually, run it again" right after a cancel must start fresh.
  assert.equal(isDuplicateDelegation('chatA', 'general', 'full inbox scan'), null);
});

test('cancel is per-task: a concurrent distinct task keeps running', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'full inbox scan' }, new AbortController());
  markOpsStart('chatA', 'task2', { kind: 'web_research', request: 'hours for the corner cafe' }, new AbortController());
  requestOpsCancel('chatA', 'task1');
  const active = getActiveOps('chatA');
  assert.equal(active.length, 1);
  assert.equal(active[0].request, 'hours for the corner cafe');
  assert.equal(isOpsCancelled('chatA', 'task2'), false);
});

test('getActiveOps exposes taskId so the cancel handler can target entries', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task9', { kind: 'general', request: 'full inbox scan' });
  assert.equal(getActiveOps('chatA')[0].taskId, 'task9');
});

test('markOpsRetry keeps an in-flight task active + a duplicate through the second leg', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'deep research' });
  // The retry resets the per-leg clock; the task stays active/visible so Convo keeps saying
  // "still on it" and dedupe suppression stays truthful through the second leg.
  markOpsRetry('chatA', 'task1');
  assert.equal(getActiveOps('chatA').length, 1);
  assert.equal(getActiveOps('chatA')[0].taskId, 'task1');
  assert.equal(isDuplicateDelegation('chatA', 'general', 'deep research'), 'in_flight');
});

test('origin is exposed via getActiveOps for scheduled runs; unset stays undefined (back-compat)', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'user1', { kind: 'general', request: 'live ask' });
  markOpsStart('chatA', 'sched1', { kind: 'general', request: 'scheduled ask', origin: 'scheduled' });
  const byTask = Object.fromEntries(getActiveOps('chatA').map(o => [o.taskId, o]));
  assert.equal(byTask['user1'].origin, undefined);
  assert.equal(byTask['sched1'].origin, 'scheduled');
});

test('noteOpsProgress records the latest milestone; a later call overwrites', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'deep research' });
  noteOpsProgress('chatA', 'task1', 'search_email');
  let active = getActiveOps('chatA')[0];
  assert.equal(active.lastMilestone, 'search_email');
  assert.equal(typeof active.milestoneAt, 'number');
  noteOpsProgress('chatA', 'task1', 'read_url');
  active = getActiveOps('chatA')[0];
  assert.equal(active.lastMilestone, 'read_url'); // most recent wins
});

test('noteOpsProgress is a no-op on a missing entry and on a cancelled entry', () => {
  __resetOpsCoordination();
  assert.doesNotThrow(() => noteOpsProgress('chatA', 'nope', 'read_email'));
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'deep research' }, new AbortController());
  requestOpsCancel('chatA', 'task1');
  // A late milestone from an abandoned/cancelled leg must not mutate or resurrect the entry.
  noteOpsProgress('chatA', 'task1', 'read_email');
  assert.equal(getActiveOps('chatA').length, 0); // still hidden (cancelled)
});

test('hasInFlightRequest matches case/whitespace-insensitively across a DIFFERENT kind', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'Hours For The Corner Cafe' });
  // The scheduler's row keyed this ask under 'general', but the running one is 'web_research' —
  // kind-agnostic match still fires.
  assert.equal(hasInFlightRequest('chatA', 'hours for   the corner cafe'), true);
  assert.equal(hasInFlightRequest('chatA', 'hours for the other place'), false);
});

test('hasInFlightRequest is chat-scoped and clears with the task', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'weekly sweep' });
  assert.equal(hasInFlightRequest('chatB', 'weekly sweep'), false); // other chat never sees it
  markOpsDone('chatA', 'task1');
  assert.equal(hasInFlightRequest('chatA', 'weekly sweep'), false); // gone after done
});

test('hasInFlightRequest ignores a cancelled run (a scheduled fire must not be blocked by it)', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'weekly sweep' }, new AbortController());
  assert.equal(hasInFlightRequest('chatA', 'weekly sweep'), true);
  requestOpsCancel('chatA', 'task1');
  assert.equal(hasInFlightRequest('chatA', 'weekly sweep'), false);
});

test('a scheduled entry is cancellable like any other run', () => {
  __resetOpsCoordination();
  const cancel = new AbortController();
  markOpsStart('chatA', 'sched1', { kind: 'general', request: 'scheduled sweep', origin: 'scheduled' }, cancel);
  assert.equal(requestOpsCancel('chatA', 'sched1'), 'signalled');
  assert.equal(cancel.signal.aborted, true);
  assert.equal(getActiveOps('chatA').length, 0);
});

// ── ETA estimate tests ──────────────────────────────────────────────────────

test('markOpsStart stores an auto-computed estimate on the entry', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'draft', request: 'write a thank-you note' });
  const active = getActiveOps('chatA')[0];
  assert.equal(active.estimatePhrase, 'about a minute');
  assert.equal(active.estimateMs, 60_000);
});

test('markOpsStart accepts an explicit estimate and stores it', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'test', estimate: { bucketMs: 999, phrase: 'custom' } });
  const active = getActiveOps('chatA')[0];
  assert.equal(active.estimatePhrase, 'custom');
  assert.equal(active.estimateMs, 999);
});

test('markOpsRetry keeps the task alive but does NOT stretch the ETA', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'deep research' });
  const before = getActiveOps('chatA')[0];
  markOpsRetry('chatA', 'task1');
  const after = getActiveOps('chatA')[0];
  assert.equal(after.firstStartedAt, before.firstStartedAt); // true elapsed still honest
  assert.equal(after.estimatePhrase, before.estimatePhrase); // never a different number
  assert.equal(isDuplicateDelegation('chatA', 'general', 'deep research'), 'in_flight');
});

test('markOpsRetry is a no-op on cancelled or missing entries', () => {
  __resetOpsCoordination();
  assert.doesNotThrow(() => markOpsRetry('chatA', 'nope'));
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'test' }, new AbortController());
  requestOpsCancel('chatA', 'task1');
  markOpsRetry('chatA', 'task1');
  assert.equal(isOpsCancelled('chatA', 'task1'), true);
  assert.equal(getActiveOps('chatA').length, 0);
});

test('getOpsEtaStatus returns a status for an active task', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'something' });
  const status = getOpsEtaStatus('chatA', 'task1');
  assert.ok(status);
  assert.equal(status.state, 'early');
  assert.equal(typeof status.remainingPhrase, 'string');
});

test('getOpsEtaStatus returns undefined for a cancelled task', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'general', request: 'something' }, new AbortController());
  requestOpsCancel('chatA', 'task1');
  assert.equal(getOpsEtaStatus('chatA', 'task1'), undefined);
});

test('getOpsEtaStatus returns undefined for a missing task', () => {
  __resetOpsCoordination();
  assert.equal(getOpsEtaStatus('chatA', 'nope'), undefined);
});

// ── the staleness horizon ───────────────────────────────────────────────────

/** Run `fn` with one env var set (or deleted), then put the environment back exactly as it was.
 *  The horizon is read at CALL time like every other flag, so this is what "the operator armed the
 *  browser budget" looks like from a test. */
function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { fn(); } finally {
    if (had) process.env[key] = before;
    else delete process.env[key];
  }
}

test('opsStaleMs is the WIDEST configured leg budget plus the slack — and 300_000 on a default env', () => {
  // The number this was a hardcoded constant for, unchanged: a default install reads exactly the
  // five minutes it has always read.
  assert.equal(opsStaleMs({}), 300_000);
  assert.equal(opsStaleMs({ OPS_BROWSER_TASK_TIMEOUT_MS: 'off' }), 300_000, 'the env var IS the flag; off is today');
  assert.equal(opsStaleMs({ OPS_BROWSER_TASK_TIMEOUT_MS: 'junk' }), 300_000, 'a nonsense window is not a budget');
  // Armed: the horizon now sits outside the browser leg it has to outlive.
  assert.equal(opsStaleMs({ OPS_BROWSER_TASK_TIMEOUT_MS: 'on' }), BROWSER_LEG_BUDGET_MS + OPS_STALE_SLACK_MS);
  assert.equal(opsStaleMs({ OPS_BROWSER_TASK_TIMEOUT_MS: '600000' }), 660_000);
  // A widened ORDINARY deadline counts too — the horizon tracks whichever leg is widest, and never
  // the last one read.
  assert.equal(opsStaleMs({ OPS_TASK_TIMEOUT_MS: '600000' }), 660_000);
  assert.equal(opsStaleMs({ OPS_TASK_TIMEOUT_MS: '600000', OPS_BROWSER_TASK_TIMEOUT_MS: '300000' }), 660_000);
  assert.equal(opsStaleMs({ OPS_TASK_TIMEOUT_MS: '60000', OPS_BROWSER_TASK_TIMEOUT_MS: '900000' }), 960_000);
});

test('an armed browser leg is still active, duplicate-suppressed and ETA-bearing at 6 and 14 minutes', () => {
  withEnv('OPS_BROWSER_TASK_TIMEOUT_MS', 'on', () => {
    __resetOpsCoordination();
    const t0 = Date.now();
    markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'pull the tags off that walled listing' });
    for (const minutes of [6, 14]) {
      const now = t0 + minutes * 60_000;
      assert.equal(getActiveOps('chatA', now).length, 1, `still on it at ${minutes} minutes`);
      assert.equal(hasInFlightRequest('chatA', 'pull the tags off that walled listing', now), true);
      assert.equal(
        isDuplicateDelegation('chatA', 'web_research', 'pull the tags off that walled listing', now),
        'in_flight',
        `a re-ask at ${minutes} minutes must not start a SECOND engine run`,
      );
      assert.ok(getOpsEtaStatus('chatA', 'task1', now), `the ETA is still there at ${minutes} minutes`);
    }
    // Past the horizon the self-heal still fires — a crashed run must stop blocking.
    const past = t0 + opsStaleMs() + 1;
    assert.equal(getActiveOps('chatA', past).length, 0);
    assert.equal(hasInFlightRequest('chatA', 'pull the tags off that walled listing', past), false);
    assert.equal(isDuplicateDelegation('chatA', 'web_research', 'pull the tags off that walled listing', past), null);
    assert.equal(getOpsEtaStatus('chatA', 'task1', past), undefined);
  });
});

test('with no browser budget armed the horizon is exactly five minutes, as it has always been', () => {
  withEnv('OPS_BROWSER_TASK_TIMEOUT_MS', undefined, () => {
    __resetOpsCoordination();
    const t0 = Date.now();
    markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'hours for the corner cafe' });
    const justInside = t0 + 300_000 - 1_000;
    assert.equal(getActiveOps('chatA', justInside).length, 1);
    assert.equal(isDuplicateDelegation('chatA', 'web_research', 'hours for the corner cafe', justInside), 'in_flight');
    const justPast = t0 + 300_000 + 1;
    assert.equal(getActiveOps('chatA', justPast).length, 0);
    assert.equal(hasInFlightRequest('chatA', 'hours for the corner cafe', justPast), false);
    assert.equal(getOpsEtaStatus('chatA', 'task1', justPast), undefined);
  });
});

// ── mid-run steer: the queue between "the user added something" and "there is a run to add it to" ──
//
// A hermes run is only steerable once its agent exists, which is a second or two after dispatch.
// A user who adds to the ask inside that window must not lose the words, so the state machine has
// three answers, not two: 'ready' (there is a handle — go POST it), 'queued' (hold it until the
// handle lands), 'already_done' (nothing to steer; fold it into the next ask instead).

test('requestOpsSteer: queued before the handle exists, ready after, and drained exactly once', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'flights to bekasi' });

  assert.equal(requestOpsSteer('chatA', 'task1', 'under 100k'), 'queued', 'no run handle yet');
  assert.equal(getOpsEngineRun('chatA', 'task1'), undefined);

  noteOpsEngineRun('chatA', 'task1', { engine: 'hermes', runId: 'run_1' });
  assert.deepEqual(getOpsEngineRun('chatA', 'task1'), { engine: 'hermes', runId: 'run_1' });
  assert.deepEqual(takePendingSteers('chatA', 'task1'), ['under 100k'], 'the queued text comes back for delivery');
  assert.deepEqual(takePendingSteers('chatA', 'task1'), [], 'and only once — a drain is a hand-off');

  assert.equal(requestOpsSteer('chatA', 'task1', 'actually jakarta'), 'ready', 'the handle exists now');
  assert.deepEqual(takePendingSteers('chatA', 'task1'), [], 'a ready steer is the caller\'s to send, not the queue\'s');
});

test('requestOpsSteer: every addition stays on the entry so the follow-up leg still sees it', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'flights to bekasi' });
  noteOpsEngineRun('chatA', 'task1', { engine: 'hermes', runId: 'run_1' });
  requestOpsSteer('chatA', 'task1', 'under 100k');
  requestOpsSteer('chatA', 'task1', 'morning departures');
  // Whether hermes accepted them or not, these are things the user said about a running ask: the
  // status line reads them back ("you added: …") and a refinement leg folds them in.
  assert.deepEqual(getActiveOps('chatA')[0].steers, ['under 100k', 'morning departures']);
  // Blank text is not an addition — it must not put an empty quote on the status line.
  assert.equal(requestOpsSteer('chatA', 'task1', '   '), 'already_done');
  assert.deepEqual(getActiveOps('chatA')[0].steers, ['under 100k', 'morning departures']);
});

test('requestOpsSteer: a finished or cancelled lookup is already_done, and never resurrects', () => {
  __resetOpsCoordination();
  assert.equal(requestOpsSteer('chatA', 'gone', 'also check jakarta'), 'already_done', 'no entry at all');

  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'flights' });
  markOpsDone('chatA', 'task1');
  assert.equal(requestOpsSteer('chatA', 'task1', 'also check jakarta'), 'already_done');

  markOpsStart('chatA', 'task2', { kind: 'web_research', request: 'trains' });
  requestOpsCancel('chatA', 'task2');
  // The user killed it a beat ago; adding to it would be a promise about work that is stopping.
  assert.equal(requestOpsSteer('chatA', 'task2', 'also check jakarta'), 'already_done');
  assert.deepEqual(takePendingSteers('chatA', 'task2'), []);
});

test('noteOpsEngineRun / takePendingSteers: no-ops on a gone or cancelled entry', () => {
  __resetOpsCoordination();
  noteOpsEngineRun('chatA', 'nope', { engine: 'hermes', runId: 'run_x' });
  assert.equal(getOpsEngineRun('chatA', 'nope'), undefined);
  assert.deepEqual(takePendingSteers('chatA', 'nope'), []);

  // A leg abandoned at its deadline can still publish a handle late (the adapter's 202 races the
  // teardown) — mirrors markOpsRetry/noteOpsProgress: a cleared or cancelled entry stays cleared.
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'flights' });
  requestOpsCancel('chatA', 'task1');
  noteOpsEngineRun('chatA', 'task1', { engine: 'hermes', runId: 'run_1' });
  assert.equal(getOpsEngineRun('chatA', 'task1'), undefined);
});

// ── the engine LEG's lifecycle, which is not the task's ─────────────────────────────────────────
//
// A task outlives its engine leg: triage and compose come after. Between those two moments the run
// is over on hermes (a steer at it answers 409) while the task is still very much in flight, so the
// map has to be able to say "the leg is done" without saying "the task is done".

test('requestOpsSteer: once the leg ends the handle is gone, and a steer is already_done', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'flights to bekasi' });
  beginOpsEngineLeg('chatA', 'task1', true);
  noteOpsEngineRun('chatA', 'task1', { engine: 'hermes', runId: 'run_1' });
  assert.equal(requestOpsSteer('chatA', 'task1', 'under 100k'), 'ready');

  assert.deepEqual(endOpsEngineLeg('chatA', 'task1'), [], 'nothing was left queued');
  // The window this closes: triage + compose, during which the task is still "running" for every
  // other reader. 'ready' here had Convo ack "adding that in" for a POST that then 409'd.
  assert.equal(getOpsEngineRun('chatA', 'task1'), undefined);
  assert.equal(requestOpsSteer('chatA', 'task1', 'actually jakarta'), 'already_done');
  // …and it is still an addition the user made about this ask, so it stays on the entry.
  assert.deepEqual(getActiveOps('chatA')[0].steers, ['under 100k', 'actually jakarta']);
});

test('requestOpsSteer: unsupported when no handle can EVER land for this leg', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'flights to bekasi' });
  // An engine with no steer route at all (OpenClaw today) — declared at the leg's start.
  beginOpsEngineLeg('chatA', 'task1', false);
  assert.equal(requestOpsSteer('chatA', 'task1', 'under 100k'), 'unsupported');
  assert.deepEqual(takePendingSteers('chatA', 'task1'), [], 'never queued for a drain that cannot come');
  assert.deepEqual(getActiveOps('chatA')[0].steers, ['under 100k'], 'their words still ride with the task');

  // The other shape: an engine that CAN steer, on a transport that carries no run id (hermes's
  // chat completions). Only the adapter knows, and it says so once it has routed.
  markOpsStart('chatA', 'task2', { kind: 'web_research', request: 'trains' });
  beginOpsEngineLeg('chatA', 'task2', true);
  assert.equal(requestOpsSteer('chatA', 'task2', 'under 100k'), 'queued', 'a handle might still land');
  noteOpsSteerUnreachable('chatA', 'task2');
  assert.equal(requestOpsSteer('chatA', 'task2', 'morning only'), 'unsupported');
});

test('endOpsEngineLeg: hands back what nobody could deliver, and a second leg starts clean', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'flights to bekasi' });
  beginOpsEngineLeg('chatA', 'task1', true);
  assert.equal(requestOpsSteer('chatA', 'task1', 'under 100k'), 'queued');
  // The leg ended before the handle ever landed: the queue is the CALLER's to trace, because this
  // module imports no diagnostics and a silently dropped addition is the failure being fixed.
  assert.deepEqual(endOpsEngineLeg('chatA', 'task1'), ['under 100k']);
  assert.deepEqual(takePendingSteers('chatA', 'task1'), [], 'handed off, not copied');

  // A retry or a steer replay is a NEW leg on the same task — it can be steered again.
  beginOpsEngineLeg('chatA', 'task1', true);
  assert.equal(requestOpsSteer('chatA', 'task1', 'actually jakarta'), 'queued');
  noteOpsEngineRun('chatA', 'task1', { engine: 'hermes', runId: 'run_2' });
  assert.equal(requestOpsSteer('chatA', 'task1', 'and mornings'), 'ready');
});

test('the leg hooks no-op on a gone or cancelled entry', () => {
  __resetOpsCoordination();
  beginOpsEngineLeg('chatA', 'nope', true);
  noteOpsSteerUnreachable('chatA', 'nope');
  assert.deepEqual(endOpsEngineLeg('chatA', 'nope'), []);

  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'flights' });
  requestOpsCancel('chatA', 'task1');
  beginOpsEngineLeg('chatA', 'task1', true);
  noteOpsEngineRun('chatA', 'task1', { engine: 'hermes', runId: 'run_1' });
  assert.equal(getOpsEngineRun('chatA', 'task1'), undefined, 'a cancelled entry stays cleared');
});

test('getActiveOps: an untouched run carries no steers field at all', () => {
  __resetOpsCoordination();
  markOpsStart('chatA', 'task1', { kind: 'web_research', request: 'flights' });
  // Absent, not empty: the status line and its prompt budget are the same bytes as before anyone
  // could add to a running ask.
  assert.equal('steers' in getActiveOps('chatA')[0], false);
});

test('an engine ask stretches the in-flight horizon by its wait, and a new leg starts with none', () => {
  __resetOpsCoordination();
  markOpsStart('c-grace', 't-grace', { kind: 'general', request: 'clear the scratch folder' });
  const past = Date.now() + opsStaleMs() + 1_000;
  assert.equal(getActiveOps('c-grace', past).length, 0, 'past the horizon it reads as stale');
  extendOpsLeg('c-grace', 't-grace', ENGINE_APPROVAL_WAIT_MS);
  assert.equal(getActiveOps('c-grace', past).length, 1);
  assert.equal(isDuplicateDelegation('c-grace', 'general', 'clear the scratch folder', past), 'in_flight');
  markOpsRetry('c-grace', 't-grace');
  assert.equal(getActiveOps('c-grace', Date.now() + opsStaleMs() + 1_000).length, 0, 'the retry leg carries no grace');
});

const queuedAsk = (armed: string[], taskId: string, runId: string) => ({ taskId, runId, arm: () => { armed.push(runId); } });

test('one engine ask per person: a second one waits, and is asked when the first settles', () => {
  __resetOpsCoordination();
  const armed: string[] = [];
  assert.equal(enqueueEngineAsk('+1', queuedAsk(armed, 't1', 'r1')), 'armed');
  assert.equal(enqueueEngineAsk('+1', queuedAsk(armed, 't2', 'r2')), 'queued');
  assert.equal(enqueueEngineAsk('+2', queuedAsk(armed, 't3', 'r3')), 'armed', 'another person is not in this line');
  settleEngineAsk('+1', 'r1');
  assert.deepEqual(armed, ['r1', 'r3', 'r2']);
});

test('a queued ask whose wait ended, or whose task ended, is never asked', () => {
  __resetOpsCoordination();
  const armed: string[] = [];
  enqueueEngineAsk('+1', queuedAsk(armed, 't1', 'r1'));
  enqueueEngineAsk('+1', queuedAsk(armed, 't2', 'r2'));
  enqueueEngineAsk('+1', queuedAsk(armed, 't3', 'r3'));
  settleEngineAsk('+1', 'r2'); // its window closed while it waited in line
  dropEngineAsks('+1', 't1');  // the live one's task ended
  assert.deepEqual(armed, ['r1', 'r3']);
});

test('a declined engine ask is remembered on its task until the task ends', () => {
  __resetOpsCoordination();
  markOpsStart('c-dec', 't-dec', { kind: 'general', request: 'tidy my downloads' });
  assert.equal(engineAskDeclined('c-dec', 't-dec'), false);
  noteEngineAskDeclined('c-dec', 't-dec');
  assert.equal(engineAskDeclined('c-dec', 't-dec'), true);
  markOpsDone('c-dec', 't-dec');
  assert.equal(engineAskDeclined('c-dec', 't-dec'), false);
});
