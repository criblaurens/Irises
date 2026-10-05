import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline, DeadlineError, type DeadlineExtender } from './deadline.js';

test('withDeadline: resolves when work settles within deadline', async () => {
  const result = await withDeadline(Promise.resolve('ok'), 1000, 'test fast work');
  assert.equal(result, 'ok');
});

test('withDeadline: rejects with DeadlineError when work exceeds deadline', async () => {
  const slow = new Promise<string>(resolve => setTimeout(() => resolve('late'), 100));
  await assert.rejects(
    withDeadline(slow, 10, 'test slow work'),
    err => err instanceof DeadlineError && /exceeded 10ms deadline/.test((err as Error).message),
  );
});

test('withDeadline: re-throws underlying error when work fails within deadline', async () => {
  const failing = Promise.reject(new Error('underlying failure'));
  await assert.rejects(
    withDeadline(failing, 1000, 'test error work'),
    err => !(err instanceof DeadlineError) && (err as Error).message === 'underlying failure',
  );
});

test('withDeadline: non-positive or non-finite ms returns work unbounded', async () => {
  const res1 = await withDeadline(Promise.resolve('infinite'), Infinity, 'infinite');
  assert.equal(res1, 'infinite');

  const res2 = await withDeadline(Promise.resolve('zero'), 0, 'zero');
  assert.equal(res2, 'zero');

  const res3 = await withDeadline(Promise.resolve('negative'), -100, 'negative');
  assert.equal(res3, 'negative');
});

test('withDeadline: delays exceeding 32-bit signed int (> 24.8 days) do not overflow or reject prematurely', async () => {
  // 30 days in ms = 2,592,000,000 > 2,147,483,647 (Node.js signed 32-bit int limit)
  // Without safe scheduling, Node triggers TimeoutOverflowWarning and rejects in ~1ms.
  let warningEmitted = false;
  const onWarning = (warning: Error) => {
    if (warning.name === 'TimeoutOverflowWarning') warningEmitted = true;
  };
  process.on('warning', onWarning);

  try {
    const fastWork = new Promise<string>(resolve => setTimeout(() => resolve('completed'), 20));
    const result = await withDeadline(fastWork, 2_592_000_000, '30-day task');
    assert.equal(result, 'completed');
    assert.equal(warningEmitted, false, 'must not trigger Node.js TimeoutOverflowWarning');
  } finally {
    process.removeListener('warning', onWarning);
  }
});

test('withDeadline: an extension pushes the deadline out while the work waits', async () => {
  const ext: DeadlineExtender = {};
  const work = new Promise<string>(r => setTimeout(() => r('late but allowed'), 80));
  const p = withDeadline(work, 40, 'extended', ext);
  ext.extend?.(100);
  assert.equal(await p, 'late but allowed');
});
