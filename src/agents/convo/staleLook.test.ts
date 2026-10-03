// The stale-look verdict (convo/staleLook.ts). Fixtures are the live 2026-10-04 turn: a commit-count
// look delivered six hours earlier, then a bare nudge to go look that meant a different question.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStaleLook, renderStaleLookCorrection } from './staleLook.js';
import type { ShortTermEntry } from '../../db/repositories/memoryShort.js';
import type { LlmToolCall } from '../../llm/types.js';

const now = Date.now();
const delivered: ShortTermEntry = {
  id: 's1', agentHandle: 'h', chatId: 'c', kind: 'ops_research',
  request: 'average commit frequency for solo projects on GitHub',
  content: 'There is no official average…', meta: {}, createdAt: now - 6 * 3_600_000, expiresAt: now + 3_600_000,
};
const delegate = (request: string): LlmToolCall => ({ name: 'delegate_to_ops', input: { kind: 'web_research', request } });
const rerun = delegate('Find reliable figures on how many commits a solo GitHub project typically has');

test('a delivered look re-run on a message that names none of it is flagged', () => {
  const look = detectStaleLook([rerun], [delivered], 'no i mean, search them on google');
  assert.equal(look?.entry.id, 's1');
});

test('a message that names the delivered subject clears it', () => {
  assert.equal(detectStaleLook([rerun], [delivered], 'search the github commit numbers again'), null);
});

test('a brief on a different subject is never flagged', () => {
  const fresh = delegate('legal requirements to become President of Indonesia');
  assert.equal(detectStaleLook([fresh], [delivered], 'no i mean, search them on google'), null);
});

test('only delegations count, and only delivered research rows', () => {
  assert.equal(detectStaleLook([{ name: 'recall_memory', input: { query: 'solo github commits' } }], [delivered], 'go look'), null);
  assert.equal(detectStaleLook([rerun], [{ ...delivered, kind: 'email_flag' }], 'go look'), null);
});

test('the correction names the delivered ask and its age, never a guessed subject', () => {
  const look = detectStaleLook([rerun], [delivered], 'go look')!;
  const note = renderStaleLookCorrection(look, 'about 6 hours');
  assert.match(note, /about 6 hours ago \("average commit frequency for solo projects on GitHub"\)/);
  assert.match(note, /delivered look is settled ground/);
  assert.doesNotMatch(note, /president/i);
});

// ── the one corrective re-ask (through the DI seam) ──────────────────────────

test('the call path re-asks once and dispatches what the re-read delegates instead', async () => {
  const { processConvoResult } = await import('./shared.js');
  const { addShortTerm } = await import('../../db/repositories/memoryShort.js');
  const { DELEGATE_TO_OPS_TOOL } = await import('./tools.js');
  const { emptyMedia } = await import('../../webhook/types.js');
  const { getTraces, clearTraces } = await import('../../diagnostics/trace.js');
  const { randomUUID } = await import('node:crypto');
  clearTraces();
  const chatId = randomUUID();
  const handle = `+1555800${Math.floor(Math.random() * 1e4)}`;
  await addShortTerm({ agentHandle: handle, chatId, kind: 'ops_research', request: delivered.request, content: delivered.content });
  const result = (bubbles: string[], calls: LlmToolCall[]) => ({
    text: JSON.stringify({ confidence_level: 72, tool_calls: calls.map(c => ({ name: c.name, args: c.input })), bubbles: bubbles.map(text => ({ text, re: null })) }),
    toolCalls: calls, stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test',
  });
  const notes: string[] = [];
  const out = await processConvoResult({
    chatId, handle, history: [], media: emptyMedia(),
    chatContext: { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle },
    textToSend: 'no i mean, search them on google',
    res: result(['actually searching it now'], [rerun]),
    turn: {
      system: 'SYSTEM', messages: [{ role: 'user', content: 'no i mean, search them on google' }], tools: [DELEGATE_TO_OPS_TOOL],
      call: async req => {
        notes.push(String(req.messages[req.messages.length - 1].content));
        return result(['ohh the president one', 'looking it up'], [delegate('legal requirements to become President of Indonesia')]);
      },
    },
  });
  assert.equal(notes.length, 1, 'exactly one re-ask');
  assert.match(notes[0], /settled ground/);
  assert.equal(out.delegatedTask?.request, 'legal requirements to become President of Indonesia');
  const receipt = getTraces().find(e => e.type === 'event' && e.label === 'convo:stale_look')?.detail as { resolved?: string } | undefined;
  assert.equal(receipt?.resolved, 'reasked');
});
