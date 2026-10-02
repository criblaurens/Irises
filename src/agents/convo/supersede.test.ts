// A reply replaced by a newer text, through the front door (convo/client.ts `chat`): the model faked
// at the lane seam, nothing else stubbed. Pinned: the draft call carries the live turn's signal, a
// replaced turn throws instead of acting on its draft (even one the call managed to return), and the
// user row it wrote is taken back so the next turn records the burst once.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chat } from './client.js';
import type { ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { getConversation } from '../../state/conversation.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { LiveTurn, TurnSupersededError } from '../../state/liveTurn.js';
import type { LlmRequest, LlmResult } from '../../llm/types.js';

const ENVELOPE = JSON.stringify({ confidence_level: 90, tool_calls: null, bubbles: [{ text: 'lol yeah', re: null }], status: {} });

let seq = 0;
function ctx(turn: LiveTurn): ChatContext {
  __resetOpsCoordination();
  return {
    isGroupChat: false, participantNames: [], chatName: null,
    senderHandle: `+1555803${(seq++).toString().padStart(4, '0')}`,
    supersede: turn,
  };
}

test('a newer text aborts the draft call, and the turn leaves no trace in history', async () => {
  const chatId = randomUUID();
  const turn = new LiveTurn('+1');
  turn.arm();
  let seen: AbortSignal | undefined;
  const call = (req: LlmRequest) => new Promise<LlmResult>((_, reject) => {
    seen = req.signal;
    req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true });
    setImmediate(() => turn.supersedeBy('+1'));
  });

  await assert.rejects(chat(chatId, 'wait actually', emptyMedia(), ctx(turn), call), TurnSupersededError);
  assert.equal(seen, turn.signal, 'the draft call carries the live turn signal');
  assert.deepEqual(await getConversation(chatId), [], 'the user row was taken back');
});

test('a draft that came back after the turn was replaced is not acted on', async () => {
  const chatId = randomUUID();
  const turn = new LiveTurn('+1');
  turn.arm();
  const call = async (): Promise<LlmResult> => {
    turn.supersedeBy('+1');
    return { text: ENVELOPE, toolCalls: [], stopReason: 'end_turn', provider: 'openrouter', model: 'test' };
  };

  await assert.rejects(chat(chatId, 'wait actually', emptyMedia(), ctx(turn), call), TurnSupersededError);
  assert.deepEqual(await getConversation(chatId), [], 'no user row, no assistant row');
});

test('a turn nobody interrupted commits and answers as usual', async () => {
  const chatId = randomUUID();
  const turn = new LiveTurn('+1');
  turn.arm();
  const call = async (): Promise<LlmResult> => ({ text: ENVELOPE, toolCalls: [], stopReason: 'end_turn', provider: 'openrouter', model: 'test' });

  const out = await chat(chatId, 'wait actually', emptyMedia(), ctx(turn), call);
  assert.match(out.text ?? '', /lol yeah/);
  assert.equal(turn.supersedeBy('+1'), false, 'committed: a later text is the next turn');
  assert.deepEqual((await getConversation(chatId)).map(m => m.role), ['user', 'assistant']);
});
