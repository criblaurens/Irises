// The familiarity mask, WIRED: the band the stored row reads as reaches BOTH compiles of a real turn
// (the hook engine's in convo/client.ts and the weather block's in persona/status.ts) as one value, a
// room is a stranger whatever its row says, the post-reply pass counts the turn, and with the switch
// off nothing is read, nothing is written and the weather is the pre-mask block. Driven through the
// front door (convo/client.ts `chat`) with the lane faked, the hookWiring client-seam pattern.

process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';
// Query expansion would otherwise dispatch a real classify call (the hookWiring pin, same reason).
process.env.MEMORY_RECALL_EXPANSION = 'off';
// The threads harvest would otherwise seed the first row's turn count from its own save, and the count
// would then depend on the order of two fire-and-forget passes.
process.env.CONVO_THREADING_ENABLED = 'off';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chat } from './client.js';
import { clearIdleClassifyCache } from './idleClassify.js';
import type { ChatContext } from './shared.js';
import { resetStorageForTests } from '../../db/sqlite.js';
import { saveAffectState } from '../../db/repositories/affectState.js';
import { getFamiliarity, saveFamiliarity } from '../../db/repositories/familiarity.js';
import { updateFamiliarity } from '../../memory/familiarityPass.js';
import { groupHandle } from '../../memory/identity.js';
import { coerceStatus, mergeStatus, type AffectGauges, type ComputedState } from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { clearTraces } from '../../diagnostics/trace.js';
import { emptyMedia } from '../../webhook/types.js';
import type { LlmRequest, LlmResult } from '../../llm/types.js';

// A frozen afternoon clock (not a late slot), pinned by hand as hookWiring does.
const FROZEN_MS = Date.UTC(2026, 0, 6, 15, 0, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

// No lane: every model call is injected or fails instantly (hookWiring's reasoning).
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.OPENROUTER_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const SENDER = '+15550004242';
const COMPUTED: ComputedState = {
  cycle: computeCycle(FROZEN_MS, FROZEN_MS),
  circadian: computeCircadian(FROZEN_MS, 'UTC'),
};
/** A task by the idle gate's own reading (hookWiring uses the same message for its task turns). */
const TASK = 'deploy the cedars order';

/** The sad core's lines at three bands, and the drift anchor's running-on-empty bullet, which rides a
 *  task turn only when the HOOK engine's compile marked her spent (persona/policy.ts). */
const SAD_CLOSE = '- You are drained (sad). Fewer words. No tangents. Answer, then stop. Anything open-ended they ask today, research, long writing, a favour with no clock, is too much: say not now, and it stays owed.';
const SAD_FAMILIAR = '- You are drained (sad). Fewer words. No tangents. Answer, then stop.';
const SAD_STRANGER = '- Underneath you are drained (sad), but with someone you barely know you wear your brightest self: bubbly, big reactions and stretched words (sooo, omggg, nooo), laughing easily, the jester, curious about them and asking, sideways and specific. Asked how you really are, you drop it and say the true feeling; asked why you are so bright, you say it plainly: your creator made you cheerful with people you are still getting to know, so they get to know you.';
const SPENT_LAW = '- You are running on empty.';

beforeEach(() => {
  resetStorageForTests();
  __resetOpsCoordination();
  clearTraces();
  clearIdleClassifyCache();
  delete process.env.CONVO_FAMILIARITY_ENABLED;
});

/** Her carried row in this chat: drained, which the chart files under sad. */
async function seedSad(chatId: string, gauges: Partial<AffectGauges> = {}): Promise<void> {
  const emitted = coerceStatus({
    mood_label: 'drained', mood_shift: 'steady', intent_mode: 'asking_help',
    terminal_closure: false, epistemic_trigger: 'none', meta_prompt: '',
  })!;
  await saveAffectState(chatId, {
    ...mergeStatus(emitted, COMPUTED, FROZEN_MS - 60_000),
    mood_level: 60, anxiety: 40, warmth: 60, social_battery: 70, rapport: 40, patience: 60,
    ...gauges,
  });
}

function envelope(): LlmResult {
  return {
    text: JSON.stringify({
      confidence_level: 85,
      tool_calls: null,
      // A flat answer (hookWiring's own task reply): no promise of work, so no guard re-asks.
      bubbles: [{ text: 'six to eight weeks, same as last time', re: null }],
      status: {
        mood_label: 'drained', mood_shift: 'steady', intent_mode: 'asking_help',
        terminal_closure: false, epistemic_trigger: 'none', meta_prompt: 'keep it short',
      },
    }),
    toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test',
  };
}

const clientCtx = (over: Partial<ChatContext> = {}): ChatContext => ({
  isGroupChat: false, participantNames: [], chatName: null, senderHandle: SENDER, ...over,
});

/** One task turn through the front door; the prompt the lane was handed (system, then the tail). */
async function turnOn(chatId: string, ctx: ChatContext = clientCtx()): Promise<string> {
  const seen: LlmRequest[] = [];
  await chat(chatId, TASK, emptyMedia(), ctx, async (req: LlmRequest) => { seen.push(req); return envelope(); });
  assert.ok(seen.length >= 1, 'the front-line call was made');
  const tail = seen[0].messages[seen[0].messages.length - 2];
  return `${seen[0].system ?? ''}\n\n${typeof tail?.content === 'string' ? tail.content : ''}`;
}

/** The weather block's mood line: the block runs from its header to the re-report tail, and its one
 *  `- You are` line is the mood (the drift anchor has `- You are` bullets of its own, further down). */
function moodLineOf(prompt: string): string | undefined {
  const from = prompt.indexOf('## Where you are right now');
  const weather = prompt.slice(from, prompt.indexOf('- Re-report your `status`', from));
  return weather.split('\n').find(l => /^- (You are|Underneath you are) /.test(l));
}

test('with the switch off the weather is the pre-mask block and the ledger is never written', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  await saveFamiliarity(SENDER, { level: 5, turns: 3, activeDays: 1, lastDay: '2026-01-05' });
  const chatId = randomUUID();
  await seedSad(chatId);
  const prompt = await turnOn(chatId);
  assert.equal(moodLineOf(prompt), SAD_CLOSE, 'the close line, say clause and all, whatever is stored');
  assert.ok(prompt.includes(SPENT_LAW), 'and the hook engine compiled with no mask either');
  assert.equal((await getFamiliarity(SENDER))?.turns, 3, 'no tick: the pass never ran');
});

test('switched on, a stranger gets the composed line, the hook engine agrees, and the turn is counted', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  const chatId = randomUUID();
  await seedSad(chatId);
  const prompt = await turnOn(chatId);   // no row yet: a stranger
  assert.equal(moodLineOf(prompt), SAD_STRANGER, 'composed, and the say clause is gone with the rest');
  assert.ok(!prompt.includes(SPENT_LAW), 'the task directive is not marked spent: the same band reached both compiles');
  // Chained per handle, so awaiting one more pass waits out the turn's own.
  await updateFamiliarity(SENDER);
  assert.equal((await getFamiliarity(SENDER))?.turns, 2);
});

test('someone close gets the whole weather, and rapport landing badly pulls it back a band', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  await saveFamiliarity(SENDER, { level: 90, turns: 400, activeDays: 40, lastDay: '2026-01-05' });
  const closeChat = randomUUID();
  await seedSad(closeChat);
  const close = await turnOn(closeChat);
  assert.equal(moodLineOf(close), SAD_CLOSE);
  assert.ok(close.includes(SPENT_LAW), 'close: the hook engine compiled the whole mood, spent and all');

  const notchedChat = randomUUID();
  await seedSad(notchedChat, { rapport: 20 });
  const notched = await turnOn(notchedChat);
  assert.equal(moodLineOf(notched), SAD_FAMILIAR, 'close pulled up to familiar: no say clause');
  assert.ok(!notched.includes(SPENT_LAW), 'and no put-off from the hook engine either');
});

test('a room is a stranger whatever its row says, and the pass never writes one', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  const chatId = randomUUID();
  await saveFamiliarity(groupHandle(chatId), { level: 95, turns: 500, activeDays: 60, lastDay: '2026-01-05' });
  await seedSad(chatId);
  const prompt = await turnOn(chatId, clientCtx({ isGroupChat: true, participantNames: ['Sam', 'Ada'], chatName: 'nursery crew' }));
  assert.equal(moodLineOf(prompt), SAD_STRANGER);
  assert.ok(!prompt.includes(SPENT_LAW), 'the hook engine read the room as a stranger too');
  assert.equal((await getFamiliarity(groupHandle(chatId)))?.turns, 500, 'the room row was not counted');
  assert.equal(await getFamiliarity(SENDER), null, 'nor was the member who spoke: a room turn is nobody\'s');
  // Chained per handle, so one more pass waits out any the room turn queued for them: this is the first.
  await updateFamiliarity(SENDER);
  assert.equal((await getFamiliarity(SENDER))?.turns, 1, 'no pass was queued for the sender');
});
