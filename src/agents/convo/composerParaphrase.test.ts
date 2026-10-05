// Regression coverage for the "composer-paraphrase" double-say fix in processConvoResult.
//
// Bug: when the model wrote SUBSTANTIVE answer content AND called delegate_to_ops in the same
// envelope, processConvoResult shipped the full text (SEND #1) and promoted it wholesale to
// delegatedTask.holdingText; the composer then re-answered the same facts from the real Ops result,
// and stripEchoedHolding only cuts a VERBATIM echo — so the paraphrase survived and the user heard
// the fact twice. The tail was also un-grounded (Convo is single-shot). Fix: when the MODEL builds
// the task, salvage only the safe holding-style opener (salvageHoldingText) as the shipped text and
// holdingText, discarding the un-grounded substantive tail — mirroring the routing-gate salvage.
//
// Exercised end-to-end against the ephemeral DB backend, with voiceInstant
// degrading to its static floor when the LLM call fails — so processConvoResult runs for real.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { markOpsStart, __resetOpsCoordination } from '../../state/opsCoordination.js';
import { recentHoldingBeats } from '../../state/holdingBeats.js';
import { HOLDING } from '../fallfirm/floor.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

// Minimal engine stub (repo DI convention): captures remember() and accepts reminders.
import { resetEngineBackendCache, type EngineBackend } from '../ops/engineBackend.js';
function installStubEngine(): Array<{ chatId: string; handle: string; note: string }> {
  const remembered: Array<{ chatId: string; handle: string; note: string }> = [];
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder() { return { id: 'r1', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember(chatId, handle, note) { remembered.push({ chatId, handle, note }); },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  };
  resetEngineBackendCache(engine);
  return remembered;
}


// Build an LlmResult the way callConvoLLM hands one to processConvoResult: `text` is the JSON bubble
// envelope (parseReply bridges it to legacy `\n---\n` wire text) and `toolCalls` are the parsed calls.
function makeResult(bubbles: string[], toolCalls: LlmToolCall[], confidence = 85): LlmResult {
  const envelope = {
    confidence_level: confidence,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return {
    text: JSON.stringify(envelope),
    toolCalls,
    stopReason: 'end_turn',
    provider: 'anthropic',
    model: 'test',
  };
}

function delegate(request: string, address?: string): LlmToolCall {
  return { name: 'delegate_to_ops', input: { kind: 'web_research', request, address: address ?? null, meta_prompt: null } };
}

function schedule(instruction: string, fireAtIso: string): LlmToolCall {
  return { name: 'schedule_automation', input: { instruction, schedule_kind: 'once', fire_at: fireAtIso, timezone: 'America/Chicago', title: null, needs_ops: false, ops_kind: null } };
}

function ctx(): ChatContext {
  const handle = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  return { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle };
}

const baseArgs = () => {
  const chatContext = ctx();
  return {
    chatId: randomUUID(),
    handle: chatContext.senderHandle!,
    chatContext,
    history: [],
    media: emptyMedia(),
  };
};

test('substantive answer + delegate: shipped text drops the un-grounded claim; holdingText equals it', async () => {
  const a = baseArgs();
  // The exact bug shape: a genuine holding opener, then an un-grounded owner assertion. The opener
  // is digit-free so salvage keeps it verbatim (salvageHoldingText rejects any bubble with a figure).
  const res = makeResult(
    ["pulling the owner up now", "owner's the Hendersons"],
    [delegate('owner of 412 Maple', '412 Maple')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: "who owns 412 Maple?" });

  assert.ok(out.delegatedTask, 'a task was delegated');
  assert.ok(out.text, 'the turn is never silent');
  // The un-grounded substantive claim never ships.
  assert.doesNotMatch(out.text!, /henderson/i, 'the un-grounded owner claim was dropped');
  // Only the safe holding opener survives.
  assert.match(out.text!, /pulling the owner up now/i);
  // holdingText (the composer's "never retype" anchor + stripEchoedHolding key) equals the shipped
  // text (tag-free; there are no [[re:N]] tags here so they match verbatim).
  assert.equal(out.delegatedTask!.holdingText, out.text);
});

test('pure holding text + delegate: her first beat ships as the one holding bubble', async () => {
  const a = baseArgs();
  const res = makeResult(
    ["lemme check", "one sec"],
    [delegate('inspection deadline on 900 Pine')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: "what's my inspection deadline on 900 Pine?" });

  assert.ok(out.delegatedTask);
  assert.equal(out.text, 'lemme check', 'her own first beat ships, and only that one');
  assert.equal(out.delegatedTask!.holdingText, 'lemme check');
});

test('delegate with NO safe opener: voiceInstant holding path still produces text', async () => {
  const a = baseArgs();
  // A substantive-only draft (no holding-shaped bubble) salvages nothing → salvage yields null →
  // the !textResponse voiceInstant holding line must still fire.
  const res = makeResult(
    ["owner's the Hendersons and the ARV is $410,000"],
    [delegate('owner and ARV of 412 Maple', '412 Maple')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: "who owns 412 Maple and what's the ARV?" });

  assert.ok(out.delegatedTask);
  assert.ok(out.text && out.text.trim().length > 0, 'voiceInstant holding line filled the gap');
  assert.doesNotMatch(out.text!, /henderson|410,000/i, 'the un-grounded draft did not leak through');
  // holdingText tracks whatever actually shipped (the voiced holding line).
  assert.equal(out.delegatedTask!.holdingText, out.text);
});

// Shape, never a pinned string: the beat is drawn from a varied pool (a hum, a wait, a line naming
// the thing), so what holds is that ONE non-empty beat ships and it joins her recent beats.
test('delegate with EMPTY bubbles: voiceInstant holding path produces one beat, and records it', async () => {
  const a = baseArgs();
  const res = makeResult([], [delegate('comps on 55 Birch')]);
  const out = await processConvoResult({ ...a, res, textToSend: 'pull comps on 55 Birch' });

  assert.ok(out.delegatedTask);
  assert.ok(out.text && out.text.trim().length > 0, 'never silent on a bare delegation');
  assert.doesNotMatch(out.text!, /\n---\n/, 'the holding beat is a single bubble');
  assert.equal(out.delegatedTask!.holdingText, out.text);
  // The record is fire-and-forget; let it land.
  for (let i = 0; i < 5 && !(await recentHoldingBeats(a.chatId)).length; i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(await recentHoldingBeats(a.chatId), [out.text]);
});

test('the fallback beat steers off her recent beats', async () => {
  const a = baseArgs();
  const recentBeats = HOLDING.web_research!.slice(0, -1);
  const out = await processConvoResult({ ...a, res: makeResult([], [delegate('comps on 55 Birch')]), textToSend: 'pull comps on 55 Birch', recentBeats });
  assert.equal(out.text, HOLDING.web_research!.at(-1), 'the one line she has not sent lately');
});

test('multi-intent (pleasantry + delegate): her pleasantry and her holding line both ship, no data leaks', async () => {
  const a = baseArgs();
  // "you're welcome!" comes before the beat, and the look is the turn's only action, so her whole
  // hold ships (salvageHold). The digits ("55 Birch") are the user's own words, so they're a safe echo.
  const res = makeResult(
    ["you're welcome!", "pulling comps on 55 Birch now"],
    [delegate('comps on 55 Birch')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'thanks, also pull comps on 55 Birch' });

  assert.ok(out.delegatedTask);
  assert.equal(out.text, "you're welcome!\n---\npulling comps on 55 Birch now", 'her whole hold ships, not a generated line');
  assert.equal(out.delegatedTask!.holdingText, out.text);
});

test("persona-example holding text with the user's own address digits ships verbatim (no Fallfirm override)", async () => {
  const a = baseArgs();
  // The reported bug: Convo responds with a persona-compliant holding text; the old salvage killed it
  // (any-digit rule) and the later-returning Fallfirm line replaced Convo's response. Now the user's
  // own figures are a grounded echo and Irises's words ship untouched.
  const res = makeResult(
    ["okay that's a real question", 'pulling the comps on 412 Maple now'],
    [delegate('comps on 412 Maple', '412 Maple')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'pull comps on 412 Maple' });

  assert.ok(out.delegatedTask);
  assert.equal(out.text, "okay that's a real question\n---\npulling the comps on 412 Maple now",
    "Convo's own hold ships — Fallfirm never overrides a safe model-written holding text");
  assert.equal(out.delegatedTask!.holdingText, out.text);
});

test('in-flight duplicate: no new task, and the un-grounded claim is salvaged away (no cross-turn double-say)', async () => {
  // The model re-delegates an ask ALREADY running; `if (suppressedDuplicate) continue` skips building
  // a new task, so the salvage's `modelDelegated && delegatedTask` guard would miss it — the inline
  // claim would ship AND the original in-flight task's composer would re-voice it later. The fix also
  // salvages on the suppressedDuplicate path; here the !textResponse still_on_it line fills the gap.
  __resetOpsCoordination();
  const a = baseArgs();
  markOpsStart(a.chatId, 'task-A', { kind: 'web_research', request: 'owner of 412 Maple' });
  const res = makeResult(
    ["the county records show it's owned by an LLC", "pulling the exact entity now"],
    [delegate('owner of 412 Maple', '412 Maple')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'who owns 412 maple?' });

  assert.equal(out.delegatedTask, null, 'the in-flight dup was suppressed — no second Ops run');
  assert.ok(out.text && out.text.trim().length > 0, 'never silent (still_on_it line)');
  assert.doesNotMatch(out.text!, /county records|owned by an llc|\bllc\b/i, 'the un-grounded claim never ships');
  __resetOpsCoordination();
});

test('schedule + delegate: the reminder confirmation survives (salvage must not swallow it)', async (t) => {
  installStubEngine();
  t.after(() => resetEngineBackendCache(undefined));
  // A turn that BOTH schedules and delegates: the model writes the reminder confirmation AND a holding
  // line. The reminder must never end up silently set: the draft is salvaged to its one beat like any
  // delegation (her own "i'll remind you" goes with the rest of the draft), and the schedule's result
  // is voiced after it, from what actually ran, so a confirmation still ships.
  const a = baseArgs();
  const fireAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const res = makeResult(
    ["got it, i'll remind you tomorrow at 9am", "pulling comps on 55 Birch now"],
    [schedule('remind them about 55 Birch', fireAt), delegate('comps on 55 Birch')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'remind me about 55 Birch tomorrow 9am and pull comps on it' });

  assert.ok(out.delegatedTask, 'the lookup was still delegated');
  const bubbles = out.text!.split('\n---\n');
  assert.equal(bubbles[0], 'pulling comps on 55 Birch now', 'the holding line for the lookup leads');
  assert.ok(bubbles.length > 1 && bubbles.slice(1).join(' ').trim().length > 0,
    'the reminder confirmation was not swallowed by the delegation holding line');
});

// An envelope whose bubbles carry `re`, the way a burst reply quotes each of their texts.
function makeTaggedResult(bubbles: { text: string; re: number | null }[], toolCalls: LlmToolCall[]): LlmResult {
  const base = makeResult([], toolCalls);
  return { ...base, text: JSON.stringify({ ...JSON.parse(base.text as string), bubbles }) };
}

test('burst + delegate: her beat and her answer to their other text both ship, and the look keeps its own text', async () => {
  const a = baseArgs();
  const res = makeTaggedResult(
    [
      { text: 'on the commit thing, lemme check', re: 1 },
      { text: 'and who, the ppl reachin out to work with u', re: 2 },
    ],
    [delegate('average commit frequency for solo projects on GitHub')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'no i mean, just search the average commit of solo project on github\n\nwho?' });

  assert.ok(out.delegatedTask);
  assert.equal(out.text, '[[re:1]]on the commit thing, lemme check\n---\n[[re:2]]and who, the ppl reachin out to work with u');
  assert.equal(out.delegatedTask!.lookRe, 1, 'the late answer threads to the text the look came from');
  assert.equal(out.delegatedTask!.holdingText, 'on the commit thing, lemme check\n---\nand who, the ppl reachin out to work with u');
});

test('one text, two asks: her answer to the other ask ships ahead of the leaving line', async () => {
  const a = baseArgs();
  const res = makeResult(
    ['the ppl reachin out to work with u', 'lemme check the commit thing'],
    [delegate('average commit frequency for solo projects on GitHub')],
  );
  const out = await processConvoResult({ ...a, res, textToSend: 'search the avg commits for solo github projects. also who did u mean?' });

  assert.ok(out.delegatedTask);
  assert.equal(out.text, 'the ppl reachin out to work with u\n---\nlemme check the commit thing');
  assert.equal(out.delegatedTask!.lookRe, undefined, 'nothing was quoted, so the default threading stands');
});
