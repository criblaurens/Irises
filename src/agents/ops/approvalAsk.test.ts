// src/agents/ops/approvalAsk.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderApprovalAsk, approvalAskFallback, renderReconfirmAsk, reconfirmAskFallback } from './sideEffects.js';

const MONID = 'install https://monid.ai/SKILL.md';

test('an act-only ask reads exactly as it always has', () => {
  assert.equal(
    renderApprovalAsk('email my landlord'),
    'SYSTEM: you were about to have the engine email my landlord. That is an action in the world, so ask them in one short line whether to go ahead, in your own words; do not claim it is running; no tool calls.',
  );
  assert.equal(approvalAskFallback('email my landlord'), 'before i do it, you want me to email my landlord?');
});

test('a setup ask names every action and why it waits, and the code line carries the link', () => {
  const note = renderApprovalAsk('find search API prices', {
    engineActions: ['install https://monid.ai/SKILL.md'], reasons: ['host_setup', 'tainted'], taintedBy: 'read monid.ai',
  });
  assert.match(note, /and first have it install https:\/\/monid\.ai\/SKILL\.md\./);
  assert.match(note, /brings new code onto their machine or runs it there/);
  assert.match(note, /right after you read material from outside \(for "read monid\.ai"\)/);
  assert.match(note, /name what it would set up, with any link exactly as written/);
  assert.match(approvalAskFallback('find search API prices', ['install https://monid.ai/SKILL.md']),
    /\(first: install https:\/\/monid\.ai\/SKILL\.md\)\?$/);
});

test('a reconfirm without actions reads exactly as it always has', () => {
  assert.equal(
    renderReconfirmAsk('email my landlord'),
    'SYSTEM: they just said yes, but the action they are agreeing to — have the engine email my landlord — was asked about long enough ago that it expired, so nothing has started. Ask them in one short line whether they still want it, naming the action; do not claim it is running; no tool calls.',
  );
  assert.equal(reconfirmAskFallback('email my landlord'), 'that one expired a while ago, still want me to email my landlord?');
});

test('a request that already asks (an offer in her own words) is asked again as it stands', () => {
  const offer = 'want me to send it over to them rn?';
  assert.equal(reconfirmAskFallback(offer), `that one expired a while ago, asking again\n${offer}`);
  assert.equal(approvalAskFallback(offer), `before i do it, ${offer}`);
  assert.doesNotMatch(reconfirmAskFallback('i can book the 9am / want that?'), /want me to/);
  assert.equal(reconfirmAskFallback(offer, [MONID]), `that one expired a while ago, asking again\nwant me to send it over to them rn (first: ${MONID})?`, 'the actions ride ahead of the question mark');
});

test('a reconfirm with engine actions carries the link in both the note and the code line', () => {
  assert.match(renderReconfirmAsk('find search API prices', [MONID]), /https:\/\/monid\.ai\/SKILL\.md/);
  assert.match(reconfirmAskFallback('find search API prices', [MONID]), /https:\/\/monid\.ai\/SKILL\.md/);
});
