// The approval gate: a delegation that would have the ENGINE act in the world does not start when
// it is built. It is parked in `ops_tasks` at `pending_approval`, written to `agent_prefs` beside
// pending_clarification, and she asks in one line whether to go ahead — through the same
// system-note re-ask the unkept-promise guard uses, because the holding line she already wrote
// ("on it, emailing them now") is a claim about work that must not have started.
//
// End-to-end through processConvoResult with the model faked at the lane seam (the pattern of
// routingGate.test.ts): the DB is the real ephemeral SQLite, so the row, the pref and the prompt
// section the NEXT turn reads are all the live ones.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext, type ConvoTurnContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination, getActiveOps, markOpsStart, shortApprovalId, shortLookupId } from '../../state/opsCoordination.js';
import { clearTraces, getTraces } from '../../diagnostics/trace.js';
import { listPendingApprovals, getOpsTask, insertPendingApproval } from '../../db/repositories/opsTasks.js';
import { getPreference } from '../../db/repositories/memory.js';
import { closeDb, stmt } from '../../db/sqlite.js';
import { buildContextBlock } from '../../memory/dossier.js';
import { approvalAskFallback } from '../ops/sideEffects.js';
import { buildTaskPrompt } from '../ops/client.js';
import { __setConsentLlmForTests } from '../ops/consent.js';
import { setPreference } from '../../db/repositories/memory.js';
import { PENDING_ASK_TTL_MS } from '../../memory/dossier.js';
import { groupHandle } from '../../memory/identity.js';
import type { LlmResult, LlmToolCall, LlmRequest } from '../../llm/types.js';

const ACT_ASK = 'email my landlord that rent is late';
const READ_ASK = 'how much does a flight to bali cost in november';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 90,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function delegate(request: string, effect?: string): LlmToolCall {
  return { name: 'delegate_to_ops', input: { kind: 'general', request, ...(effect ? { effect } : {}) } };
}

let seq = 0;
function args(textToSend: string) {
  __resetOpsCoordination();
  clearTraces();
  laneCalls = 0;
  const sender = `+1555820${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia(), textToSend };
}

/** The re-ask seam: a turn context whose `call` records what it was asked and answers as she would. */
function reasker(bubbles: string[]) {
  const seen: LlmRequest[] = [];
  const turn: ConvoTurnContext = {
    system: 'persona',
    messages: [{ role: 'user', content: 'hey' }],
    tools: [],
    call: async (req: LlmRequest) => { seen.push(req); return makeResult(bubbles); },
  };
  return { turn, seen };
}

// The classify lane, faked for the whole file: the resolution reaches it only for a reply the
// English lexicon cannot settle, and a real call here would be a network hop in a unit suite.
let laneCalls = 0;
let laneVerdict = 'UNCLEAR';
__setConsentLlmForTests(async () => {
  laneCalls++;
  return { text: laneVerdict, toolCalls: [], stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test' };
});

function receipt(label: string): Record<string, unknown> | undefined {
  const ev = getTraces().find(e => e.label === label);
  return ev ? ((ev.detail ?? {}) as Record<string, unknown>) : undefined;
}

async function withGate<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.OPS_APPROVAL_GATE;
  if (value === undefined) delete process.env.OPS_APPROVAL_GATE;
  else process.env.OPS_APPROVAL_GATE = value;
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env.OPS_APPROVAL_GATE;
    else process.env.OPS_APPROVAL_GATE = prior;
  }
}

// ── an action is parked and asked about ──────────────────────────────────────

test("an act delegation never starts: it is parked, asked about, and the next turn's prompt says so", async () => {
  const a = args(ACT_ASK);
  const { turn, seen } = reasker(['want me to send that to your landlord?']);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it, emailing them now'], [delegate(ACT_ASK, 'act')]),
    turn,
  });

  // NOTHING to kick off: index.ts starts a run only from `delegatedTask`, so a null one is the park.
  assert.equal(out.delegatedTask, null, 'no task goes back for kickoff');
  assert.equal(getActiveOps(a.chatId).length, 0, 'and nothing is marked in flight');

  // The row outlives the process, at the one status the stranded sweep ignores.
  const parked = listPendingApprovals(a.chatId);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].status, 'pending_approval');
  assert.equal(parked[0].request, ACT_ASK);
  assert.equal(parked[0].chatId, a.chatId, 'the row is keyed by chat, like every other ops_tasks row');
  const task = parked[0].meta.task as Record<string, unknown>;
  assert.equal(task.effect, 'act', 'the whole task is serialized, ready to run on a yes');
  assert.equal(task.request, ACT_ASK);
  assert.deepEqual(task.approval, { askedAt: parked[0].startedAt });

  // The pref beside pending_clarification — what the next turn's resolution reads.
  const pref = await getPreference<{ taskId: string; request: string; kind: string; askedAt: number }>(a.handle, 'pending_approval');
  assert.ok(pref, 'the pref is written');
  assert.equal(pref!.taskId, parked[0].id);
  assert.equal(pref!.request, ACT_ASK);
  assert.equal(pref!.kind, 'general');
  assert.equal(typeof pref!.askedAt, 'number');

  // She ASKED, in her own words, and the holding line she wrote first is gone.
  assert.equal(seen.length, 1, 'exactly one extra call');
  const note = String(seen[0].messages.at(-1)?.content ?? '');
  assert.match(note, /^SYSTEM: you were about to have the engine email my landlord that rent is late/);
  assert.match(note, /no tool calls/);
  assert.equal(out.text, 'want me to send that to your landlord?');
  assert.doesNotMatch(out.text ?? '', /emailing them now/);

  assert.deepEqual(receipt('ops:approval'), { decision: 'requested', trigger: 'both', taskId: parked[0].id, reasons: ['act'] });
  assert.deepEqual(receipt('convo:approval_ask'), { resolved: 'reasked', variant: 'park' });

  // And the next turn is told the ask is open — the whole reason the park is durable.
  const block = await buildContextBlock(a.handle, 'yes');
  assert.match(block, /## You asked them to approve an action/);
  assert.match(block, /email my landlord that rent is late/);
  assert.match(block, /has NOT started/);
});

test('a read-tagged delegation whose request would act is parked by the lexicon alone', async () => {
  const ask = 'send my landlord an email about the rent being late';
  const a = args(ask);
  const { turn } = reasker(['you want me to send that email?']);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['looking into it'], [delegate(ask, 'read')]),
    turn,
  });
  assert.equal(out.delegatedTask, null, 'the model said read; the words said otherwise');
  assert.equal(listPendingApprovals(a.chatId).length, 1);
  assert.equal(receipt('ops:approval')?.trigger, 'lexicon');
});

// ── a look is untouched ──────────────────────────────────────────────────────

test('a research ask kicks off exactly as before, with a not_needed receipt', async () => {
  const a = args(READ_ASK);
  const { turn, seen } = reasker(['unused']);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['checking flights now'], [delegate(READ_ASK)]),
    turn,
  });
  assert.ok(out.delegatedTask, 'the look goes out');
  assert.equal(out.delegatedTask!.effect, 'read');
  assert.equal(out.delegatedTask!.approval, undefined);
  assert.equal(out.text, 'checking flights now', 'her own holding line ships');
  assert.equal(seen.length, 0, 'no re-ask is spent');
  assert.equal(listPendingApprovals(a.chatId).length, 0, 'no row');
  assert.equal(await getPreference(a.handle, 'pending_approval'), undefined, 'no pref — nothing was ever written');
  assert.deepEqual(receipt('ops:approval'), { decision: 'not_needed', trigger: 'none' });
  assert.equal(receipt('convo:approval_ask'), undefined);
});

test('quoted words inside a request are data — a song title does not park a lookup', async () => {
  const ask = "search for the song 'send me an angel'";
  const a = args(ask);
  const { turn } = reasker(['unused']);
  const out = await processConvoResult({ ...a, res: makeResult(['looking that up'], [delegate(ask)]), turn });
  assert.ok(out.delegatedTask, 'still just a lookup');
  assert.equal(out.delegatedTask!.effect, 'read');
  assert.equal(receipt('ops:approval')?.decision, 'not_needed');
});

test('the park stands the routing floor down — it must never replace a parked ask with a live look', async () => {
  // The floor fires on a turn with no delegation, and a parked turn has none by construction. Left
  // alone it would force a look for the same message the user has not authorized yet.
  const ask = 'how much do i owe, and pay the landlord the balance';
  const a = args(ask);
  const { turn } = reasker(['want me to pay that off?']);
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ask, 'act')]), turn });
  assert.equal(out.delegatedTask, null, 'nothing was forced out behind the parked ask');
  assert.equal(receipt('convo:routing_gate'), undefined, 'the floor never even evaluated');
});

// ── the ask, when the model cannot deliver it ────────────────────────────────

test('a re-ask that comes back empty or with a tool call falls back to one code line', async () => {
  const a = args(ACT_ASK);
  const turn: ConvoTurnContext = {
    system: 'persona', messages: [], tools: [],
    call: async () => makeResult([], [delegate(ACT_ASK, 'act')]),
  };
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]), turn });
  assert.equal(out.delegatedTask, null, 'still parked');
  assert.equal(out.text, approvalAskFallback(ACT_ASK));
  assert.deepEqual(receipt('convo:approval_ask'), { resolved: 'fallback', variant: 'park' });
  assert.equal(listPendingApprovals(a.chatId).length, 1, 'the park does not depend on the ask landing');
});

test('a re-ask that throws still asks — the code line ships and the row stands', async () => {
  const a = args(ACT_ASK);
  const turn: ConvoTurnContext = {
    system: 'persona', messages: [], tools: [],
    call: async () => { throw new Error('lane down'); },
  };
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]), turn });
  assert.equal(out.text, approvalAskFallback(ACT_ASK));
  assert.deepEqual(receipt('convo:approval_ask'), { resolved: 'fallback', variant: 'park' });
  assert.equal(listPendingApprovals(a.chatId).length, 1);
});

test('with no turn context at all (a caller that passes none) the fallback carries the ask', async () => {
  const a = args(ACT_ASK);
  const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]) });
  assert.equal(out.delegatedTask, null);
  assert.equal(out.text, approvalAskFallback(ACT_ASK));
  assert.deepEqual(receipt('convo:approval_ask'), { resolved: 'fallback', variant: 'park' });
});

// ── the off path ─────────────────────────────────────────────────────────────

test('OPS_APPROVAL_GATE=off: an action kicks off exactly as today — no row, no pref, no ask, no receipt', async () => {
  const a = args(ACT_ASK);
  const { turn, seen } = reasker(['unused']);
  const out = await withGate('off', () => processConvoResult({
    ...a,
    res: makeResult(['on it, emailing them now'], [delegate(ACT_ASK, 'act')]),
    turn,
  }));

  const task = out.delegatedTask;
  assert.ok(task, 'the task goes back for kickoff, as it would have before any of this existed');
  // The whole object, field by field: the gate off must change NOTHING about the task but the one
  // new data field the tool arg feeds.
  assert.deepEqual(task, {
    id: task!.id,
    chatId: a.chatId,
    agentHandle: a.handle,
    kind: 'general',
    request: ACT_ASK,
    effect: 'act',
    metaPrompt: `The user asked: "${ACT_ASK}". Work out what they actually need, use whatever tools fit (the web, their email if connected, your own past chats), and return a concrete, useful answer.`,
    heldMemory: undefined,
    memoryHits: 0,
    addressHint: undefined,
    dealHint: undefined,
    replyToMessageId: undefined,
    attempt: 1,
    originConfidence: 90,
    media: undefined,
    recalledAgeMs: undefined,
    createdAt: task!.createdAt,
    // Set after the loop, off the line that shipped — the composer continues straight from it.
    holdingText: 'on it, emailing them now',
    holdingAt: task!.holdingAt,
  });
  assert.equal(task!.approval, undefined, 'no handshake happened');
  assert.equal(seen.length, 0, 'no re-ask');
  assert.equal(listPendingApprovals(a.chatId).length, 0, 'no row');
  assert.equal(await getPreference(a.handle, 'pending_approval'), undefined, 'no pref — nothing was ever written');
  assert.equal(receipt('ops:approval'), undefined, 'and the gate files nothing when it is not there');
  assert.equal(receipt('convo:approval_ask'), undefined);
  // Her own holding line ships untouched (the salvage floor keeps the holding-shaped opener).
  assert.match(out.text ?? '', /emailing them now/);
});

test('OPS_APPROVAL_GATE=off: a read delegation is byte-identical to the flag-on read path', async () => {
  const on = args(READ_ASK);
  const onOut = await withGate(undefined, () => processConvoResult({
    ...on, res: makeResult(['checking flights now'], [delegate(READ_ASK)]),
  }));
  const off = args(READ_ASK);
  const offOut = await withGate('off', () => processConvoResult({
    ...off, res: makeResult(['checking flights now'], [delegate(READ_ASK)]),
  }));
  // Everything but the four fields a second run cannot repeat (the id, the two chat keys and the
  // two clocks) has to be the same object either side of the flag.
  const shape = (t: typeof onOut.delegatedTask) =>
    ({ ...t, id: 'x', chatId: 'x', agentHandle: 'x', createdAt: 0, holdingAt: 0 });
  assert.deepEqual(shape(offOut.delegatedTask), shape(onOut.delegatedTask));
  assert.equal(offOut.text, onOut.text);
});

test('the tool arg is still accepted and coerced with the gate off', async () => {
  for (const junk of ['banana', '', 'READ']) {
    const a = args(READ_ASK);
    const out = await withGate('off', () => processConvoResult({
      ...a, res: makeResult(['on it'], [delegate(READ_ASK, junk)]),
    }));
    assert.equal(out.delegatedTask!.effect, 'read', junk);
  }
  // ...and an 'act' tag is still read as one, so a flip of the flag needs no other change.
  const a = args(ACT_ASK);
  const out = await withGate('off', () => processConvoResult({
    ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'ACT')]),
  }));
  assert.equal(out.delegatedTask!.effect, 'act');
});

test('a parked action holds the one delegation slot — a second call this turn parks nothing', async () => {
  const a = args(ACT_ASK);
  const { turn, seen } = reasker(['want me to send that?']);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it'], [delegate(ACT_ASK, 'act'), delegate('book the 9am flight', 'act')]),
    turn,
  });
  assert.equal(out.delegatedTask, null);
  assert.equal(listPendingApprovals(a.chatId).length, 1, 'first-wins, exactly as an un-parked delegation does');
  assert.equal(listPendingApprovals(a.chatId)[0].request, ACT_ASK);
  assert.equal(seen.length, 1, 'and one question, about the action that was parked');
});

// ── the row's own clock ──────────────────────────────────────────────────────

test('the parked row carries the ask time as its clock, and nothing settles it here', async () => {
  const a = args(ACT_ASK);
  const before = Date.now();
  const { turn } = reasker(['go ahead?']);
  await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]), turn });
  const row = getOpsTask(listPendingApprovals(a.chatId)[0].id);
  assert.ok(row);
  assert.ok(row!.startedAt >= before && row!.startedAt <= Date.now(), 'askedAt is the row clock');
  assert.equal(row!.settledAt, null, 'a question waiting is not a settled row');
  assert.equal(row!.kind, 'general');
});

// ── the answer ───────────────────────────────────────────────────────────────
// The resolving turn: she asked, they replied, and the reply is read BEFORE anything can be handed
// back for kickoff. A yes promotes the parked row and returns the task she asked about — index.ts
// starts it at the one site that has ever started a run (INV-1, inside this turn's lock).

/** Park one action and hand back everything the next turn needs to answer it. */
async function park(request = ACT_ASK): Promise<{ a: ReturnType<typeof args>; row: ReturnType<typeof listPendingApprovals>[number] }> {
  const a = args(request);
  const { turn } = reasker(['want me to go ahead?']);
  await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(request, 'act')]), turn });
  const row = listPendingApprovals(a.chatId)[0];
  assert.ok(row, 'the action is parked');
  return { a, row };
}

/** The same chat and sender, one turn later, with the receipts and the lane counter reset. */
function answer(a: ReturnType<typeof args>, text: string): ReturnType<typeof args> {
  clearTraces();
  laneCalls = 0;
  return { ...a, textToSend: text };
}

test('a yes promotes the parked row and hands the authorized task back for kickoff', async () => {
  const { a, row } = await park();
  const { turn, seen } = reasker(['never asked']);
  const out = await processConvoResult({ ...answer(a, 'go'), res: makeResult(['okay, sending it now']), turn });

  assert.ok(out.delegatedTask, 'the task she asked about goes back for kickoff');
  assert.equal(out.delegatedTask!.id, row.id, 'the parked id, not a new one');
  assert.equal(out.delegatedTask!.request, ACT_ASK);
  assert.equal(out.delegatedTask!.effect, 'act');
  assert.equal(out.delegatedTask!.approval?.askedAt, row.startedAt);
  assert.equal(typeof out.delegatedTask!.approval?.approvedAt, 'number');

  // The durable half moved with it, and the marker the section reads is gone.
  const promoted = getOpsTask(row.id);
  assert.equal(promoted?.status, 'running');
  assert.equal(promoted?.settledAt, null);
  assert.ok(promoted!.startedAt >= row.startedAt, 'promotion re-stamps the clock as a real leg');
  assert.equal(await getPreference(a.handle, 'pending_approval'), null, 'the ask is settled, so the pref is gone');

  // The brief the engine will read carries the one line that lifts its read-only limit.
  assert.match(buildTaskPrompt(out.delegatedTask!), /^AUTHORIZED ACTION: the user explicitly approved this exact action at /m);

  const rec = receipt('ops:approval');
  assert.equal(rec?.decision, 'approved');
  assert.equal(rec?.taskId, row.id);
  assert.equal(typeof rec?.latencyMs, 'number');
  assert.equal(seen.length, 0, 'no extra call — the section already told her to hold the line');
  assert.equal(laneCalls, 0, 'and the English lexicon settled it for free');
});

test('the holding line on an approved yes is not read as an unkept promise', async () => {
  // The pending_approval section tells her to write a holding line with NO tool call, so on the
  // approving turn the reply is "on it" with an empty envelope — and the promotion that backs it up
  // happens inside this function, not in the model's tool calls. With the honesty guard running
  // first, every single approved yes burned one corrective re-ask and shipped its "honest" retry
  // ("i can't send that from here") over the top of an action that WAS starting.
  const { a, row } = await park();
  const { turn, seen } = reasker(['i cannot do that']);
  const out = await processConvoResult({ ...answer(a, 'yes'), res: makeResult(['on it']), turn });

  assert.equal(receipt('convo:unkept_promise'), undefined, 'the promoted action IS the work behind the line');
  assert.equal(seen.length, 0, 'so no corrective re-ask is spent');
  assert.equal(out.delegatedTask?.id, row.id, 'and the action she was authorized to run still goes out');
  assert.equal(out.text, 'on it', 'her holding line ships, not a retry that denies it');
});

test('a no declines the row and starts nothing', async () => {
  const { a, row } = await park();
  const { turn } = reasker(['never asked']);
  const out = await processConvoResult({ ...answer(a, 'nope, leave it'), res: makeResult(["okay, dropping it"]), turn });

  assert.equal(out.delegatedTask, null, 'nothing goes back for kickoff');
  const settled = getOpsTask(row.id);
  assert.equal(settled?.status, 'declined');
  assert.ok(settled!.settledAt, 'a declined row is settled');
  assert.equal(await getPreference(a.handle, 'pending_approval'), null, 'the marker is dropped');
  assert.equal(receipt('ops:approval')?.decision, 'declined');
  assert.equal(out.text, 'okay, dropping it', 'her own line stands — the section told her what to say');
});

test('an unclear reply leaves the action parked, exactly as it was', async () => {
  const { a, row } = await park();
  laneVerdict = 'UNCLEAR';
  const out = await processConvoResult({ ...answer(a, 'hmm what did you find'), res: makeResult(['nothing yet']), turn: reasker([]).turn });

  assert.equal(out.delegatedTask, null);
  assert.equal(getOpsTask(row.id)?.status, 'pending_approval', 'still waiting on them');
  assert.ok(await getPreference(a.handle, 'pending_approval'), 'and the pref keeps the section live');
  assert.equal(receipt('ops:approval')?.decision, 'unclear');
});

test('the classify lane is consulted only for a reply the lexicon cannot settle, and only while pending', async () => {
  const { a } = await park();
  // Settled by the English list: no call.
  const yes = answer(a, 'go ahead');
  await processConvoResult({ ...yes, res: makeResult(['on it']), turn: reasker([]).turn });
  assert.equal(laneCalls, 0);

  // Nothing pending any more: still no call, whatever they say.
  const after = answer(a, 'envíalo ahora');
  await processConvoResult({ ...after, res: makeResult(['sure']), turn: reasker([]).turn });
  assert.equal(laneCalls, 0, 'the lane is never a per-turn tax');

  // Pending and unreadable to the lexicon: exactly one call, and its verdict decides.
  const { a: b, row } = await park('cancel my gym membership');
  laneVerdict = 'YES';
  const out = await processConvoResult({ ...answer(b, 'sí, hazlo'), res: makeResult(['on it']), turn: reasker([]).turn });
  assert.equal(laneCalls, 1);
  assert.equal(out.delegatedTask?.id, row.id, 'a non-English yes runs the action through the lane alone');
  laneVerdict = 'UNCLEAR';
});

// ── the clock runs out ───────────────────────────────────────────────────────

/** Age the ask past its TTL by rewriting the marker's clock (the row keeps its own). */
async function age(a: ReturnType<typeof args>): Promise<void> {
  const pref = await getPreference<{ taskId: string; request: string; kind: string; askedAt: number }>(a.handle, 'pending_approval');
  assert.ok(pref);
  await setPreference(a.handle, 'pending_approval', { ...pref!, askedAt: Date.now() - PENDING_ASK_TTL_MS - 1 });
}

test('a yes after the ask expired re-asks instead of running, and the next yes is fresh approval', async () => {
  const { a, row } = await park();
  await age(a);

  const { turn, seen } = reasker(['that one expired — still want me to email them?']);
  const out = await processConvoResult({ ...answer(a, 'yes go'), res: makeResult(['sending it now']), turn });

  assert.equal(out.delegatedTask, null, 'a stale yes must never execute');
  assert.equal(getOpsTask(row.id)?.status, 'expired');
  assert.equal(seen.length, 1, 'she re-asks once, through the same system-note mechanism');
  assert.match(String(seen[0].messages.at(-1)?.content ?? ''), /^SYSTEM: .*expired/);
  assert.equal(out.text, 'that one expired — still want me to email them?');
  const decisions = getTraces().filter(e => e.label === 'ops:approval').map(e => (e.detail as { decision?: string }).decision);
  assert.deepEqual(decisions, ['expired', 'reconfirm']);

  // A fresh row is parked for the re-ask, and the pref points at it.
  const parked = listPendingApprovals(a.chatId);
  assert.equal(parked.length, 1);
  assert.notEqual(parked[0].id, row.id, 'the expired row stays expired — the re-ask gets its own');
  const pref = await getPreference<{ taskId: string; reconfirm?: boolean }>(a.handle, 'pending_approval');
  assert.equal(pref?.taskId, parked[0].id);
  assert.equal(pref?.reconfirm, true);

  // And the next yes runs it, as a fresh approval.
  const again = await processConvoResult({ ...answer(a, 'yes'), res: makeResult(['on it']), turn: reasker([]).turn });
  assert.equal(again.delegatedTask?.id, parked[0].id);
  assert.equal(again.delegatedTask?.approval?.reconfirm, true, 'the brief knows this one was re-confirmed');
  assert.equal(getOpsTask(parked[0].id)?.status, 'running');
  assert.equal(receipt('ops:approval')?.decision, 'approved');
});

test('an expired ask the turn did not answer settles the row and keeps one grace window open', async () => {
  const { a, row } = await park();
  await age(a);
  laneVerdict = 'UNCLEAR';
  const out = await processConvoResult({ ...answer(a, 'anyway what about the rent thing'), res: makeResult(['what about it?']), turn: reasker([]).turn });

  assert.equal(out.delegatedTask, null);
  assert.equal(getOpsTask(row.id)?.status, 'expired', 'the row is settled the moment the clock runs out');
  assert.equal(receipt('ops:approval')?.decision, 'expired');
  assert.equal(listPendingApprovals(a.chatId).length, 0, 'nothing is parked any more');
  const pref = await getPreference<{ expiredAt?: number }>(a.handle, 'pending_approval');
  assert.equal(typeof pref?.expiredAt, 'number', 'the marker stays, stamped, for a yes that is still coming');
});

test('a yes inside the grace window re-asks; past it the marker lapses and a yes means nothing', async () => {
  // Inside: the yes arrives two turns after the ask expired, and still gets one re-ask.
  const { a } = await park();
  await age(a);
  laneVerdict = 'UNCLEAR';
  await processConvoResult({ ...answer(a, 'hmm let me think about that'), res: makeResult(['sure']), turn: reasker([]).turn });
  const { turn, seen } = reasker(['that one expired — still want me to send it?']);
  const late = await processConvoResult({ ...answer(a, 'yes do it'), res: makeResult(['sending it']), turn });
  assert.equal(late.delegatedTask, null, 'a stale yes still never executes');
  assert.equal(seen.length, 1, 'it re-asks, exactly as it does on the expiring turn');
  assert.equal(listPendingApprovals(a.chatId).length, 1, 'and parks a fresh row for the answer');

  // Past it: the whole grace window has gone by, so the marker retires and the gate is out of it.
  const b = await park('cancel my gym membership');
  await age(b.a);
  await processConvoResult({ ...answer(b.a, 'hmm let me think about that'), res: makeResult(['sure']), turn: reasker([]).turn });
  const stale = await getPreference<{ expiredAt: number }>(b.a.handle, 'pending_approval');
  await setPreference(b.a.handle, 'pending_approval', { ...stale!, expiredAt: Date.now() - PENDING_ASK_TTL_MS - 1 });
  const gone = await processConvoResult({ ...answer(b.a, 'yes do it'), res: makeResult(['do what?']), turn: reasker(['x']).turn });
  assert.equal(gone.delegatedTask, null);
  assert.equal(gone.text, 'do what?', 'no re-ask — there is nothing left to re-ask about');
  assert.equal(await getPreference(b.a.handle, 'pending_approval'), null, 'the marker is gone');
  assert.equal(receipt('ops:approval')?.decision, 'lapsed');
  assert.equal(listPendingApprovals(b.a.chatId).length, 0);
});

test('a no during the grace window drops the ask without re-asking', async () => {
  const { a, row } = await park();
  await age(a);
  laneVerdict = 'UNCLEAR';
  await processConvoResult({ ...answer(a, 'hmm let me think about that'), res: makeResult(['sure']), turn: reasker([]).turn });
  const out = await processConvoResult({ ...answer(a, 'no, forget it'), res: makeResult(['okay']), turn: reasker(['x']).turn });
  assert.equal(out.delegatedTask, null);
  assert.equal(out.text, 'okay', 'her own line stands');
  assert.equal(getOpsTask(row.id)?.status, 'expired', 'the row settled on the expiring turn and stays settled');
  assert.equal(await getPreference(a.handle, 'pending_approval'), null);
  assert.equal(receipt('ops:approval')?.decision, 'declined');
});

test('a yes with nothing pending is not the gate\'s business', async () => {
  const a = args('go ahead');
  const out = await processConvoResult({ ...a, res: makeResult(['with what?']), turn: reasker([]).turn });
  assert.equal(out.delegatedTask, null);
  assert.equal(out.text, 'with what?');
  assert.equal(receipt('ops:approval'), undefined, 'no decision to file');
  assert.equal(laneCalls, 0);
});

// ── the cancel path ──────────────────────────────────────────────────────────

test('cancel_research on a parked action declines it instead of claiming nothing is running', async () => {
  const { a, row } = await park();
  const out = await processConvoResult({
    ...answer(a, 'actually forget it'),
    res: makeResult(['dropped it'], [{ name: 'cancel_research', input: { match: '' } }]),
    turn: reasker([]).turn,
  });

  assert.equal(getOpsTask(row.id)?.status, 'declined');
  assert.equal(await getPreference(a.handle, 'pending_approval'), null, 'the marker is dropped');
  assert.equal(out.text, 'dropped it', 'her own confirmation stands — no "nothing was running" correction');
  const rec = getTraces().filter(e => e.label === 'ops:approval').map(e => e.detail as { decision?: string; via?: string });
  assert.ok(rec.some(d => d.decision === 'declined' && d.via === 'cancel'), 'the decline is on the record');
});

test('"cancel that" on a parked action keeps her acknowledgement: the decline is what the cancel found', async () => {
  // "cancel" is a decline word, so the consent read settles the row before the tool loop runs. The
  // cancel_research she wrote beside it then found no parked row and nothing running, and its
  // "nothing is being looked up" miss replaced the "dropped it" that was true.
  const { a, row } = await park();
  const out = await processConvoResult({
    ...answer(a, 'cancel that'),
    res: makeResult(['dropped it'], [{ name: 'cancel_research', input: { match: '' } }]),
    turn: reasker([]).turn,
  });

  assert.equal(getOpsTask(row.id)?.status, 'declined');
  assert.equal(receipt('ops:approval')?.decision, 'declined', 'the consent read is what declined it');
  assert.equal(out.text, 'dropped it', 'her acknowledgement stands, with no nothing-found correction');
  assert.equal(receipt('convo:outcome_pass'), undefined, 'and no second look is spent on a miss that is not one');
});

test('a cancel that names nothing declines only the live ask: an older park, or one two days stale, stands', async () => {
  // A park overwrites the marker, so an earlier park's row sits at pending_approval with nobody's ask
  // pointing at it, and a row nobody answered sits there for days. An empty cancel declined every one
  // of them, including actions they had never been asked about on this turn.
  const { a, row } = await park();
  const earlier = randomUUID();
  const stale = randomUUID();
  const DAY = 24 * 60 * 60 * 1000;
  insertPendingApproval({ id: earlier, chatId: a.chatId, kind: 'general', request: 'book the 9am flight', meta: {} }, Date.now() - 60_000);
  insertPendingApproval({ id: stale, chatId: a.chatId, kind: 'general', request: 'cancel my gym membership', meta: {} }, Date.now() - 2 * DAY);

  laneVerdict = 'UNCLEAR';
  await processConvoResult({
    ...answer(a, 'actually forget it'),
    res: makeResult(['dropped it'], [{ name: 'cancel_research', input: { match: '' } }]),
    turn: reasker([]).turn,
  });

  assert.equal(getOpsTask(row.id)?.status, 'declined', 'the ask their marker names is the one dropped');
  assert.equal(getOpsTask(earlier)?.status, 'pending_approval', 'an earlier park nobody asked about this turn stands');
  assert.equal(getOpsTask(stale)?.status, 'pending_approval', 'and a two-day-old row is out of the cancel\'s reach');

  // Words that fit the earlier park AND a lookup that is running: one of each, so neither is acted on.
  markOpsStart(a.chatId, 'run-flight', { kind: 'general', request: 'cheapest flight to bali' });
  const { turn, seen } = reasker([]);
  await processConvoResult({
    ...answer(a, 'stop the flight thing'),
    res: makeResult(['dropped it'], [{ name: 'cancel_research', input: { match: 'flight' } }]),
    turn,
  });
  assert.equal(getOpsTask(earlier)?.status, 'pending_approval', 'the parked flight is not declined');
  assert.equal(getActiveOps(a.chatId).length, 1, 'and the running flight lookup is not stopped');
  const shown = String(seen.at(-1)?.messages.at(-1)?.content ?? '');
  assert.ok(shown.includes(shortApprovalId(earlier)) && shown.includes(shortLookupId('run-flight')), 'the candidates name both ids');
});

test('in a group, a cancel from one member retires the ask it drops, so its owner\'s yes runs nothing', async () => {
  // The marker lives on the prefs of whoever asked, and a decline cleared only the SENDER's. B's
  // cancel settled A's row, A's marker survived it, and A's "yes" then rebuilt the task from the
  // declined row's stored brief and ran the action someone in the chat had just called off.
  __resetOpsCoordination();
  clearTraces();
  const chatId = randomUUID();
  const owner = `+1555840${(seq++).toString().padStart(4, '0')}`;
  const other = `+1555840${(seq++).toString().padStart(4, '0')}`;
  const turnFrom = (sender: string, textToSend: string) => ({
    chatId, handle: groupHandle(chatId), history: [], media: emptyMedia(), textToSend,
    chatContext: { isGroupChat: true, participantNames: ['Sam', 'Jo'], chatName: 'the flat', senderHandle: sender } as ChatContext,
  });

  await processConvoResult({ ...turnFrom(owner, ACT_ASK), res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]), turn: reasker(['want me to go ahead?']).turn });
  const row = listPendingApprovals(chatId)[0];
  assert.ok(row, 'the owner\'s action is parked');

  await processConvoResult({
    ...turnFrom(other, 'nah leave the landlord out of it'),
    res: makeResult(['dropped it'], [{ name: 'cancel_research', input: { match: 'landlord' } }]),
    turn: reasker([]).turn,
  });
  assert.equal(getOpsTask(row.id)?.status, 'declined');

  const out = await processConvoResult({ ...turnFrom(owner, 'yes'), res: makeResult(['on it']), turn: reasker(['nothing is running']).turn });
  assert.equal(out.delegatedTask, null, 'the action someone called off does not run');
  assert.equal(await getPreference(owner, 'pending_approval'), null, 'and the owner\'s ask went with the row');
});

test('an action parked in a room and approved from the asker\'s own chat still relays as the room', async () => {
  // The marker is keyed on the sender alone, so the yes can come from their one-to-one, and that turn
  // is not a group turn. The task is rebuilt from the parked brief and relayed back to the room, so
  // the room stamp has to ride the brief itself or the relay speaks with the member's own band.
  __resetOpsCoordination();
  clearTraces();
  const room = randomUUID();
  const owner = `+1555850${(seq++).toString().padStart(4, '0')}`;
  await processConvoResult({
    chatId: room, handle: groupHandle(room), history: [], media: emptyMedia(), textToSend: ACT_ASK,
    chatContext: { isGroupChat: true, participantNames: ['Sam', 'Jo'], chatName: 'the flat', senderHandle: owner } as ChatContext,
    res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]), turn: reasker(['want me to go ahead?']).turn,
  });
  const row = listPendingApprovals(room)[0];
  assert.ok(row, 'the action is parked in the room');
  assert.equal((row.meta.task as { room?: boolean }).room, true, 'the parked brief carries the room');

  const out = await processConvoResult({
    chatId: randomUUID(), handle: owner, history: [], media: emptyMedia(), textToSend: 'yes',
    chatContext: { isGroupChat: false, participantNames: [], chatName: null, senderHandle: owner },
    res: makeResult(['on it']), turn: reasker(['never asked']).turn,
  });
  assert.ok(out.delegatedTask, 'the yes from their own chat runs it');
  assert.equal(out.delegatedTask!.chatId, room, 'and its receipt goes back to the room');
  assert.equal(out.delegatedTask!.room, true, 'so the relay speaks in front of the room');
});

test('a parked action keeps its question when a cancel in the same turn misses', async () => {
  // The question is the one thing a parked turn owes: without it the action sits parked and nobody
  // was asked. A cancel that missed beside it used to REPLACE the whole reply with its correction,
  // so the user read "nothing's being looked up" and never saw the question at all.
  const a = args(ACT_ASK);
  const { turn } = reasker(['want me to send that to your landlord?']);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it, emailing them now'], [
      delegate(ACT_ASK, 'act'),
      { name: 'cancel_research', input: { match: 'flights' } },
    ]),
    turn,
  });

  assert.equal(listPendingApprovals(a.chatId).length, 1, 'the action is parked, not declined');
  assert.ok(out.text, 'never silent');
  assert.match(out.text!, /want me to send that to your landlord\?/, 'the question ships');
  assert.match(out.text!, /couldnt track that one down/, 'and the miss is still said, after it');
  assert.ok(out.text!.indexOf('landlord?') < out.text!.indexOf('couldnt track'), 'the question leads');
});

// ── the off path ─────────────────────────────────────────────────────────────

test('OPS_APPROVAL_GATE=off: a yes resolves nothing — no read, no lane, no promotion', async () => {
  const { a, row } = await park();
  await withGate('off', async () => {
    const out = await processConvoResult({ ...answer(a, 'go'), res: makeResult(['on it']), turn: reasker([]).turn });
    assert.equal(out.delegatedTask, null, 'nothing is promoted with the gate off');
    assert.equal(getOpsTask(row.id)?.status, 'pending_approval', 'the row is left exactly as it was');
    assert.ok(await getPreference(a.handle, 'pending_approval'), 'and so is the marker');
    assert.equal(receipt('ops:approval'), undefined);
    assert.equal(laneCalls, 0);
  });
});

// ── when the durable half is lost ────────────────────────────────────────────
// LAST in the file on purpose: it makes the insert genuinely throw by dropping the table out from
// under it, then closes the db so the next file opens a fresh one with the DDL re-applied (the
// pattern opsTasks.test.ts uses for the same reason).

test('a lost park row still asks — and says so, with the same receipt the run sink files', async () => {
  const a = args(ACT_ASK);
  const { turn } = reasker(['want me to send it?']);
  stmt('DROP TABLE ops_tasks').run();
  try {
    const out = await processConvoResult({ ...a, res: makeResult(['on it'], [delegate(ACT_ASK, 'act')]), turn });
    assert.equal(out.delegatedTask, null, 'a lost row must never become a started action');
    assert.equal(out.text, 'want me to send it?', 'she still asks');
    assert.equal(receipt('ops:approval')?.decision, 'requested');
    assert.equal(receipt('ops:durable-write-lost')?.at, 'approval');
    const pref = await getPreference(a.handle, 'pending_approval');
    assert.ok(pref, 'the pref still carries the ask, so the next turn can still resolve it');
  } finally {
    closeDb();
  }
});
