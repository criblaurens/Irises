import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTurn, TurnSupersededError } from './liveTurn.js';

test('a turn still waiting for the mouth is left alone: the drain folds the text in', () => {
  const turn = new LiveTurn('+1');
  assert.equal(turn.supersedeBy('+1'), null);
  assert.equal(turn.signal.aborted, false);
});

test('a thinking turn is replaced: nothing of it may commit or show', () => {
  const turn = new LiveTurn('+1');
  turn.arm();
  assert.equal(turn.supersedeBy('+1'), 'replaced');
  assert.ok(turn.signal.reason instanceof TurnSupersededError);
  assert.equal(turn.commit(), false);
  assert.equal(turn.show(), false);
});

test("another sender's text never touches the reply", () => {
  const turn = new LiveTurn('+1');
  turn.arm();
  assert.equal(turn.supersedeBy('+2'), null);
  assert.equal(turn.show(), true);
});

test('after a tool acted, a newer text stops the reply before its first bubble', () => {
  const turn = new LiveTurn('+1');
  turn.arm();
  assert.equal(turn.commit(), true);
  assert.equal(turn.supersedeBy('+1'), 'stopped');
  assert.equal(turn.signal.aborted, false, 'the tool already ran: nothing to abort');
  assert.equal(turn.show(), false);
});

test('mid-reply, a newer text drops the bubbles not yet out', () => {
  const turn = new LiveTurn('+1');
  turn.arm();
  assert.equal(turn.show(), true);
  assert.equal(turn.supersedeBy('+1'), 'stopped');
  assert.equal(turn.show(), false);
});
