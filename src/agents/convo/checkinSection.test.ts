// Run with: npm test   (runner pins DATA_BACKEND=memory)
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPromptSections } from './shared.js';
import { convoToolList } from './tools.js';

test('the turn after an unanswered check-in carries the edge section, and only that turn', () => {
  const tools = convoToolList({ engineName: 'hermes', isGroupChat: false });
  const build = (checkinAwaiting: boolean) => buildSystemPromptSections(undefined, '', [], undefined, tools, [], 'x', undefined, undefined, undefined, null, undefined, undefined, undefined, undefined, undefined, undefined, { checkinAwaiting });
  const on = build(true);
  assert.match(on.tail, /## Your last text asked whether they still want you texting first/);
  assert.match(on.tail, /set_preference/);
  assert.match(on.tail, /texts_first/);
  assert.doesNotMatch(on.system, /still want you texting first/, 'never in the cached system message');
  assert.doesNotMatch(build(false).tail, /still want you texting first/);
});

test('set_preference documents the texts_first switch', () => {
  const docs = JSON.stringify(convoToolList({ engineName: 'hermes', isGroupChat: false }));
  assert.match(docs, /texts_first/);
});
