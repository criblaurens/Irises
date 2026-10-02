import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTurn, TurnSupersededError } from './liveTurn.js';

test('a turn still waiting for the mouth is never replaced: the drain folds the text in', () => {
  const turn = new LiveTurn('+1');
  assert.equal(turn.supersedeBy('+1'), false);
  assert.equal(turn.signal.aborted, false);
});

test('a thinking turn is replaced by a newer text from the same sender, and can no longer commit', () => {
  const turn = new LiveTurn('+1');
  turn.arm();
  assert.equal(turn.supersedeBy('+1'), true);
  assert.ok(turn.signal.reason instanceof TurnSupersededError);
  assert.equal(turn.commit(), false);
});

test("another sender's text never replaces the reply", () => {
  const turn = new LiveTurn('+1');
  turn.arm();
  assert.equal(turn.supersedeBy('+2'), false);
  assert.equal(turn.signal.aborted, false);
});

test('a committed turn finishes', () => {
  const turn = new LiveTurn('+1');
  turn.arm();
  assert.equal(turn.commit(), true);
  assert.equal(turn.supersedeBy('+1'), false);
  assert.equal(turn.signal.aborted, false);
});
