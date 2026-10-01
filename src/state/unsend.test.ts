// Unsend (spec: docs/superpowers/specs/2026-10-01-unsend-design.md): when the tool exists, what a
// call resolves to, and the one ground code checks (her irritation against her mood).
process.env.DATA_BACKEND = 'memory';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  UNSEND_COOLDOWN_MS, UNSEND_MARGIN_MS, executeUnsend, moodAllowsIrritatedUnsend, noteInbound,
  noteSentBubble, resetUnsendStateForTests, unsendOffer, unsendWindowMs,
} from './unsend.js';
import { convoToolList } from '../agents/convo/tools.js';
import { buildSystemPromptSections, processConvoResult, type ChatContext } from '../agents/convo/shared.js';
import { __resetOpsCoordination } from './opsCoordination.js';
import { emptyMedia } from '../webhook/types.js';
import { resetEngineBackendCache, type EngineBackend } from '../agents/ops/engineBackend.js';
import type { LlmResult, LlmToolCall } from '../llm/types.js';

const MIN = 60_000;
const tg = () => `eng:telegram:${randomUUID()}`;
const ok = async () => true;

// An engine that can unsend; the window is null without one (an OpenClaw chat).
const UNSEND_ENGINE = { channelUnsend: async () => true } as unknown as EngineBackend;
beforeEach(() => { resetUnsendStateForTests(); resetEngineBackendCache(UNSEND_ENGINE); });

/** She sent `texts` at `at`, then they spoke. */
function previousReply(chatId: string, texts: string[], at: number): void {
  texts.forEach((t, i) => noteSentBubble(chatId, `m${i + 1}`, t, at));
  noteInbound(chatId);
}

test('windows: telegram 48h, photon 2min, web 2min, anything else none', () => {
  assert.equal(unsendWindowMs('eng:telegram:1'), 48 * 60 * MIN);
  assert.equal(unsendWindowMs('eng:photon:any;-;+1555'), 2 * MIN);
  assert.equal(unsendWindowMs('web:debug'), 2 * MIN);
  assert.equal(unsendWindowMs('eng:whatsapp:1'), null);
  resetEngineBackendCache(null);
  assert.equal(unsendWindowMs('eng:telegram:1'), null, 'an engine with no unsend seam offers none');
});

test('offers her previous reply only after they spoke, and only inside the window less the margin', () => {
  const chat = 'eng:photon:x';
  const t0 = 1_000_000_000;
  noteSentBubble(chat, 'm1', 'one', t0);
  assert.deepEqual(unsendOffer(chat, t0 + 1000), [], 'nothing before they speak');
  noteInbound(chat);
  assert.equal(unsendOffer(chat, t0 + 1000).length, 1);
  assert.deepEqual(unsendOffer(chat, t0 + 2 * MIN - UNSEND_MARGIN_MS), [], 'past the margin');
});

test('a burst rotates once: their second message keeps her previous reply in reach', () => {
  const chat = tg();
  previousReply(chat, ['a', 'b'], Date.now());
  noteInbound(chat);
  assert.deepEqual(unsendOffer(chat).map(b => b.text), ['a', 'b']);
});

test('synthetic ids and platforms with no unsend never enter reach', () => {
  const chat = tg();
  noteSentBubble(chat, 'eng-out-abc', 'x');
  noteInbound(chat);
  assert.deepEqual(unsendOffer(chat), []);
  const wa = 'eng:whatsapp:1';
  noteSentBubble(wa, 'm1', 'x');
  noteInbound(wa);
  assert.deepEqual(unsendOffer(wa), []);
});

test('a success takes it out of reach and starts the week cooldown; a failure spends nothing', async () => {
  const chat = tg();
  const now = Date.now();
  previousReply(chat, ['a', 'b'], now);

  unsendOffer(chat, now);
  assert.deepEqual(await executeUnsend(chat, { bubble: 1, why: 'they_are_annoyed' }, async () => false, now), { status: 'failed', text: 'a' });
  assert.equal(unsendOffer(chat, now).length, 2, 'failure spends no cooldown');

  const calls: string[] = [];
  assert.deepEqual(await executeUnsend(chat, { bubble: 2, why: 'they_are_annoyed' }, async (_c, id) => { calls.push(id); return true; }, now), { status: 'unsent', text: 'b' });
  assert.deepEqual(calls, ['m2']);
  assert.deepEqual(unsendOffer(chat, now + 1000), [], 'cooldown closes the tool');

  previousReply(chat, ['c'], now + UNSEND_COOLDOWN_MS);
  assert.equal(unsendOffer(chat, now + UNSEND_COOLDOWN_MS + 1000).length, 1, 'open again after a week');
});

test('a number off the offered list, or no offer this turn, is invalid', async () => {
  const chat = tg();
  previousReply(chat, ['a'], Date.now());
  assert.deepEqual(await executeUnsend(chat, { bubble: 1, why: 'they_are_annoyed' }, ok), { status: 'invalid' }, 'never offered');
  unsendOffer(chat);
  assert.deepEqual(await executeUnsend(chat, { bubble: 2, why: 'they_are_annoyed' }, ok), { status: 'invalid' });
});

test('the irritated ground needs mad at 25 or below', () => {
  assert.equal(moodAllowsIrritatedUnsend({ mood_core: 'mad', mood_level: 25 }), true);
  assert.equal(moodAllowsIrritatedUnsend({ mood_core: 'mad', mood_level: 26 }), false);
  assert.equal(moodAllowsIrritatedUnsend({ mood_core: 'sad', mood_level: 5 }), false);
  assert.equal(moodAllowsIrritatedUnsend(undefined), false);
});

test('the tool exists only when offered, last in the list, with a static doc', () => {
  const base = { engineName: 'hermes' as const, isGroupChat: false };
  assert.equal(convoToolList(base).some(t => t.name === 'unsend'), false);
  const tools = convoToolList({ ...base, unsend: true });
  assert.equal(tools[tools.length - 1].name, 'unsend');
  assert.deepEqual(tools.slice(0, -1).map(t => t.name), convoToolList(base).map(t => t.name), 'every other tool keeps its place');
});

test('the take-back section numbers the bubbles, only when the tool is offered', () => {
  const tools = convoToolList({ engineName: 'hermes', isGroupChat: false, unsend: true });
  const live = { unsendBubbles: ['zq-bubble-one', 'zq-bubble-two'] };
  const on = buildSystemPromptSections(undefined, '', [], undefined, tools, [], 'x', undefined, undefined, undefined, null, undefined, undefined, undefined, undefined, undefined, undefined, live);
  assert.match(on.tail, /## Your previous reply can still be taken back\nThe bubbles of it still in reach:\n1\. zq-bubble-one\n2\. zq-bubble-two/);
  const off = buildSystemPromptSections(undefined, '', [], undefined, convoToolList({ engineName: 'hermes', isGroupChat: false }), [], 'x', undefined, undefined, undefined, null, undefined, undefined, undefined, undefined, undefined, undefined, live);
  assert.doesNotMatch(off.tail, /taken back/);
  assert.doesNotMatch(on.system, /zq-bubble/, 'the bubbles never enter the cached system message');
});

// ── dispatch: the call as she made it → ChatResponse.unsend ──────────────────

function makeResult(toolCalls: LlmToolCall[]): LlmResult {
  const envelope = { confidence_level: 85, tool_calls: toolCalls.map(c => ({ name: c.name, args: c.input })), bubbles: [{ text: 'my bad', re: null }] };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test' };
}
function args() {
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}` };
  return { chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history: [], media: emptyMedia(), textToSend: 'x' };
}
const unsendCall = (input: Record<string, unknown>): LlmToolCall => ({ name: 'unsend', input });

test('dispatch: an annoyed-ground call rides out; the bubble number arrives as a string', async () => {
  __resetOpsCoordination(); resetEngineBackendCache(null);
  const out = await processConvoResult({ ...args(), res: makeResult([unsendCall({ bubble: '2', why: 'they_are_annoyed' })]) });
  assert.deepEqual(out.unsend, { bubble: 2, why: 'they_are_annoyed' });
});

test('dispatch: the irritated ground with no mood this turn is refused; an unknown ground is dropped', async () => {
  __resetOpsCoordination(); resetEngineBackendCache(null);
  const irritated = await processConvoResult({ ...args(), res: makeResult([unsendCall({ bubble: 1, why: 'i_am_irritated' })]) });
  assert.equal(irritated.unsend, null);
  const unknown = await processConvoResult({ ...args(), res: makeResult([unsendCall({ bubble: 1, why: 'bored' })]) });
  assert.equal(unknown.unsend, null);
});
