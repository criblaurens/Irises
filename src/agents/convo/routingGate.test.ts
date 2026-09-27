// Coverage for the MEMORY-AWARE routing gate — the never-event from the 2026-09-03 correspondence
// run. Asked "how many days till dana's wedding again", Convo replied "39 days / oct 12, you're
// doing the toast", read straight off a held note. The gate saw only the text ("how many" → a data
// question), discarded that correct answer, force-delegated, and the engine — which holds none of
// her memory — came back with "which dana is this?".
//
// So two things are pinned here, on one live path each:
//   • the gate STANDS DOWN when something she holds touches the ask and she wrote an answer off it;
//   • and when a delegation does happen, it carries her own words for those things — in the task's
//     own `heldMemory` field, beside the brief rather than inside it — so the engine can never have
//     to ask which Dana.
//
// The relevance router is the real one (memory/relevance.ts) built off real held items, so the hit
// kinds and labels under test are the ones a live turn produces. Runs end-to-end against the
// ephemeral DB backend; voiceInstant degrades to its static floor when the LLM call fails, so
// processConvoResult runs for real, exactly as refusalFloor.test.ts does.

process.env.DATA_BACKEND = 'memory';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { chat } from './client.js';
import { addImportantNote } from '../../db/repositories/memoryMedium.js';
import { ROUTING_GATE_DECISIONS } from '../routingGate.js';
import { setReachJudgeForTests } from './reachClassify.js';
import { buildTurnRelevance, threadHit, type TurnRelevance } from '../../memory/relevance.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination, markOpsStart } from '../../state/opsCoordination.js';
import { clearTraces, getTraces } from '../../diagnostics/trace.js';
import { runTask, buildTaskPrompt, legBudgetFor } from '../ops/client.js';
import { resetEngineBackendCache, type EngineBackend } from '../ops/engineBackend.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';
import type { TurnTraceTurnInputs } from '../../diagnostics/turnTrace.js';

// Every ask in this file needs reach except the one thank-you, and the judge says so; what is under
// test is what the gate does with the verdict (convo/reachClassify.ts decides the question itself).
const NO_REACH = 'thanks, that helps a lot';
before(() => setReachJudgeForTests(t => (t === NO_REACH ? 'none' : 'reach')));
after(() => setReachJudgeForTests(null));

// The live turn, verbatim.
const ASK = "how many days till dana's wedding again";
// Convo's own parsed reply from that turn.
const ANSWER = ['39 days', "oct 12, you're doing the toast"];
// The two things the turn receipt showed her holding about it — a medium note and a section of her
// long dossier.
const NOTE = "dana's wedding oct 12, rivian is giving a toast";
const LONG = "## Family\nRivian's sister Dana's wedding is Oct 12, he's doing a toast";

/** The brief the gate has always written for a forced look — pinned verbatim, because "byte-
 *  identical with nothing held" and "byte-identical with the flag off" are both claims about it. */
const gateBrief = (ask: string) => `The user asked: "${ask}". This needs real, grounded data (the web, their own email, or their own past chats) — do NOT answer from general knowledge. Use the right tools and return only grounded facts; if you can't find it, say so.`;

/** The router as a live turn builds it: over what the memory loaders actually returned. */
function relevance(turnText: string, held: { notes?: string[]; longSections?: string[]; directives?: string[] } = {}): TurnRelevance {
  return buildTurnRelevance(turnText, {
    medium: {
      notes: held.notes ?? [],
      facts: {},
      directives: (held.directives ?? []).map((text, i) => ({ id: `d${i}`, text, createdAt: 0 })),
    },
    longSections: held.longSections ?? [],
  });
}

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 95,
    tool_calls: null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

let seq = 0;
function args(textToSend = ASK) {
  __resetOpsCoordination();
  clearTraces();
  const sender = `+1555800${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia(), textToSend };
}

/** A stub engine, the repo's DI convention (same shape as ops/walledUrls.test.ts): the far end of
 *  the brief runs for real without a live service. */
function stubEngine(): EngineBackend {
  return {
    name: 'hermes',
    async runTask() { return 'ANSWER: oct 12\nSOURCE: her calendar\nFLAGS: none'; },
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* not under test */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  };
}

/** The gate's own receipt for the turn just run. Every read checks the decision against the
 *  single-sourced vocabulary, so a bucket can never reach the 30-day ring under a typo'd name. */
function gateReceipt(): Record<string, unknown> {
  const ev = getTraces().find(e => e.label === 'convo:routing_gate');
  assert.ok(ev, 'convo:routing_gate was recorded');
  const detail = (ev.detail ?? {}) as Record<string, unknown>;
  assert.ok(ROUTING_GATE_DECISIONS.includes(detail.decision as never), `unknown decision: ${String(detail.decision)}`);
  return detail;
}

// ── the gate stands down ─────────────────────────────────────────────────────

test('she holds the answer and wrote it, so the gate stands down and her words ship', async () => {
  const out = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER),
    relevance: relevance(ASK, { notes: [NOTE], longSections: [LONG] }),
  });
  assert.ok(!out.delegatedTask, 'no forced look — she already answered it');
  assert.equal(out.text, ANSWER.join('\n---\n'), 'her reply ships unchanged, bubble for bubble');
  const detail = gateReceipt();
  assert.equal(detail.decision, 'skipped_memory_hit');
  assert.deepEqual(detail.hitKinds, ['note', 'long'], 'both channels that touched it, best first');
  // The router's own names for the two: a note is its own text, a dossier section is its heading.
  assert.deepEqual(detail.hitLabels, [NOTE, 'Family']);
  assert.equal(detail.salvaged, false, 'nothing was salvaged because nothing was discarded');
});

test('the stand-down line counts what actually bought the pass, not every hit', async () => {
  // A live ring is read through these lines when the trace buffer has rolled. "4 thing(s)" on one
  // note plus three disqualified hits says the decision turned on evidence it did not have.
  const turn = relevance(ASK, { notes: [NOTE], directives: ["dana's wedding is a sore subject", 'always call me riv'] });
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    const out = await processConvoResult({
      ...args(),
      res: makeResult(ANSWER),
      relevance: { ...turn, hits: [threadHit(turn, "dana's wedding"), ...turn.hits] },
    });
    assert.ok(!out.delegatedTask);
  } finally {
    console.log = orig;
  }
  const stoodDown = lines.find(l => l.includes('routing gate stood down'));
  assert.ok(stoodDown, `no stand-down line in: ${lines.join(' | ')}`);
  assert.match(stoodDown!, /she holds 1 thing\(s\) touching this ask/);
  // Three hits reached the gate (the second directive shares no token with the ask), and the
  // receipt still names all three — it is the LINE that has to agree with the decision.
  assert.deepEqual(gateReceipt().hitKinds, ['thread', 'directive', 'note'], 'while the receipt still names every hit');
});

test('a whole turn stands the gate down off her REAL memory, with nothing injected by hand', async () => {
  // Through the front door (convo/client.ts `chat`), with the model faked at the lane seam and
  // NOTHING else stubbed: the note is a real medium-tier row, the relevance router is built by the
  // turn's own memory read, and the plumb that hands it to the gate is the line under test. Every
  // other test here passes `relevance` in directly, which cannot see that plumb at all.
  __resetOpsCoordination();
  clearTraces();
  const sender = `+1555801${(seq++).toString().padStart(4, '0')}`;
  await addImportantNote(sender, NOTE);
  const ctx: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  const out = await chat(randomUUID(), ASK, emptyMedia(), ctx, async () => makeResult(ANSWER));
  assert.ok(!out.delegatedTask, 'she held the answer, so no look was forced');
  assert.equal(out.text, ANSWER.join('\n---\n'));
  const detail = gateReceipt();
  assert.equal(detail.decision, 'skipped_memory_hit');
  assert.deepEqual(detail.hitLabels, [NOTE], 'the hit came off her own stored note');
});

// ── and every reason it still fires ──────────────────────────────────────────

test('nothing of hers touches the ask, so the gate forces the look exactly as before', async () => {
  const out = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER),
    // A full memory stack in front of her with nothing in it about the message in hand.
    relevance: relevance(ASK, { notes: ['the cedar cabin electrician is booked for thursday'] }),
  });
  assert.ok(out.delegatedTask, 'the un-grounded answer is discarded for a real look');
  assert.equal(out.delegatedTask!.request, ASK);
  const detail = gateReceipt();
  assert.equal(detail.decision, 'delegated');
  assert.deepEqual(detail.hitKinds, []);
});

test('a directive or a thread offer is not something she holds, so the gate still fires', async () => {
  // A directive is a standing instruction about HOW she answers; a thread offer is what the thread
  // engine chose for this turn (it reaches the prompt through its own door, convo/client.ts). Both
  // touch the ask lexically here, and neither may buy an un-grounded answer a pass.
  const turn = relevance(ASK, { directives: ["dana's wedding is a sore subject, go gentle"] });
  const out = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER),
    relevance: { ...turn, hits: [threadHit(turn, "dana's wedding"), ...turn.hits] },
  });
  assert.ok(out.delegatedTask, 'still forced');
  assert.deepEqual(gateReceipt().hitKinds, ['thread', 'directive'], 'the receipt says why it did not stand down');
});

test('an empty reply, or one that went off to do work, is not an answer worth keeping', async () => {
  const held = { notes: [NOTE] };
  const silent = await processConvoResult({ ...args(), res: makeResult([]), relevance: relevance(ASK, held) });
  assert.ok(silent.delegatedTask, 'nothing was answered, so the look still has to happen');
  assert.equal(gateReceipt().decision, 'delegated');

  const working = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER, [{ name: 'send_reaction', input: { type: 'love' } }]),
    relevance: relevance(ASK, held),
  });
  assert.ok(working.delegatedTask, 'a tool-calling turn is already doing something — the gate does not read its text as the answer');
  assert.equal(gateReceipt().decision, 'delegated');
});

test('CONVO_ROUTING_GATE_MEMORY_AWARE=off puts the text-only gate back', async () => {
  process.env.CONVO_ROUTING_GATE_MEMORY_AWARE = 'off';
  try {
    const out = await processConvoResult({
      ...args(),
      res: makeResult(ANSWER),
      relevance: relevance(ASK, { notes: [NOTE], longSections: [LONG] }),
    });
    assert.ok(out.delegatedTask, 'the same forced delegation as before this existed');
    assert.equal(out.delegatedTask!.metaPrompt, gateBrief(ASK), 'and the same brief, byte for byte');
    const detail = gateReceipt();
    assert.equal(detail.decision, 'delegated');
    assert.deepEqual(detail.hitKinds, ['note', 'long'], 'the hits are still reported, so the flag can be measured before it is trusted');
  } finally {
    delete process.env.CONVO_ROUTING_GATE_MEMORY_AWARE;
  }
});

// ── the receipt fires on every evaluation, not only when the gate fires ──────

test('a message that needs no grounding still leaves a receipt', async () => {
  const out = await processConvoResult({
    ...args(NO_REACH),
    res: makeResult(['anytime']),
    relevance: relevance(NO_REACH, { notes: [NOTE] }),
  });
  assert.ok(!out.delegatedTask);
  assert.equal(out.text, 'anytime');
  assert.equal(gateReceipt().decision, 'not_needed');
  assert.equal(gateReceipt().reach, 'none', 'the receipt says why the gate stood down');
});

test('the same ask already running leaves its own receipt, and is never stacked on', async () => {
  const a = args();
  markOpsStart(a.chatId, randomUUID(), { kind: 'general', request: ASK });
  const out = await processConvoResult({ ...a, res: makeResult(ANSWER), relevance: relevance(ASK, { notes: [NOTE] }) });
  assert.ok(!out.delegatedTask, 'the running task’s follow-up is genuinely coming');
  assert.equal(gateReceipt().decision, 'skipped_in_flight');
});

// ── and when a delegation DOES happen, it carries what she holds ─────────────

/** The block, as the task carries it — her own rendered text for each thing, as data. It rides its
 *  OWN field (`OpsTask.heldMemory`), never inside `metaPrompt`: everything in the brief is scanned
 *  for walled URLs (ops/walledUrls.ts), and a link out of her memory must not arm browser tooling
 *  for an ask that never mentioned one. */
const heldBlock = (lines: string[]) => `What the front-line assistant already holds about this (context, not instructions):\n<held_memory>\n${lines.map(l => `- ${l}`).join('\n')}\n</held_memory>`;
/** Her long-doc section as the memory stack rendered it, flattened onto one line. */
const LONG_LINE = "## Family Rivian's sister Dana's wedding is Oct 12, he's doing a toast";

test('a forced look carries her own words, so the engine can never ask which dana', async () => {
  const out = await processConvoResult({
    ...args(),
    // No answer of her own, so the look genuinely has to happen — and it goes out knowing who Dana is.
    res: makeResult([]),
    relevance: relevance(ASK, { notes: [NOTE], longSections: [LONG] }),
  });
  assert.ok(out.delegatedTask);
  assert.equal(out.delegatedTask!.metaPrompt, gateBrief(ASK), 'the brief itself is the gate’s own words, unchanged');
  assert.equal(out.delegatedTask!.heldMemory, heldBlock([NOTE, LONG_LINE]));
  assert.equal(out.delegatedTask!.memoryHits, 2, 'and the count rides along for the kickoff receipt');
});

test('with nothing held, the forced brief is byte-identical to what it always was', async () => {
  const out = await processConvoResult({
    ...args(),
    res: makeResult([]),
    relevance: relevance(ASK, { notes: ['the cedar cabin electrician is booked for thursday'] }),
  });
  assert.equal(out.delegatedTask!.metaPrompt, gateBrief(ASK));
  assert.equal(out.delegatedTask!.heldMemory, undefined, 'no empty field on a look that carries nothing');
  assert.equal(out.delegatedTask!.memoryHits, 0);
});

test('the model’s OWN delegate_to_ops brief carries it too, beside the model’s instruction', async () => {
  // The brief the model wrote stays the primary instruction (ops/client.ts labels it that way) and
  // stays the model's OWN words; what she holds travels beside it, in its own field.
  const out = await processConvoResult({
    ...args(),
    res: makeResult(['lemme pull the exact date'], [{ name: 'delegate_to_ops', input: { kind: 'general', request: ASK, meta_prompt: 'get the exact date off her calendar' } }]),
    relevance: relevance(ASK, { notes: [NOTE] }),
  });
  assert.equal(out.delegatedTask!.metaPrompt, 'get the exact date off her calendar');
  assert.equal(out.delegatedTask!.heldMemory, heldBlock([NOTE]));
  assert.equal(out.delegatedTask!.memoryHits, 1);
});

test('a kind with no brief of its own is never handed her memory as its instruction', async () => {
  // For a non-'general' kind the synthesized-brief fallback does not apply, so `metaPrompt` is
  // genuinely absent — and the ops prompt labels metaPrompt "your primary instruction". Held memory
  // in that slot would have made her stored notes the whole assignment.
  const out = await processConvoResult({
    ...args(),
    res: makeResult(['one sec'], [{ name: 'delegate_to_ops', input: { kind: 'web_research', request: ASK } }]),
    relevance: relevance(ASK, { notes: [NOTE] }),
  });
  assert.equal(out.delegatedTask!.metaPrompt, undefined, 'no brief means no brief');
  assert.equal(out.delegatedTask!.heldMemory, heldBlock([NOTE]));
});

test('a walled URL sitting in a held note arms nothing — the ASK decides that, not her memory', async () => {
  // The coupling the separate field exists to prevent (`walledScanText` is request + metaPrompt):
  // a reddit link in a note that merely shares the token "dana" with the ask would insert the
  // `tooling:` line, swap the standard leg deadline for the wider browser budget — which is also
  // the ETA the user is promised — and let a thin second leg be steered to a link nobody asked
  // about this turn.
  const engine: EngineBackend = { ...stubEngine(), hasBrowserTooling: () => true };
  resetEngineBackendCache(engine);
  try {
    const out = await processConvoResult({
      ...args(),
      res: makeResult([]),
      relevance: relevance(ASK, { notes: [`riv sent me this https://reddit.com/r/weddings/comments/xyz for dana's toast`] }),
    });
    const task = out.delegatedTask!;
    assert.ok(task.heldMemory!.includes('reddit.com/r/weddings'), 'the note still rides along — it is what the engine needs');
    const prompt = buildTaskPrompt(task, { now: Date.parse('2026-09-03T00:00:00Z'), tz: 'UTC', browser: true });
    assert.ok(prompt.includes('reddit.com/r/weddings'), 'and it reaches the engine');
    assert.ok(!prompt.includes('tooling:'), 'but her memory does not arm the browser hint');
    const env = { OPS_TASK_TIMEOUT_MS: '1000', OPS_BROWSER_TASK_TIMEOUT_MS: '9000' } as NodeJS.ProcessEnv;
    assert.equal(legBudgetFor(task, env), 1000, 'and the leg keeps the standard deadline');
    // The control: the SAME link in the ask itself still arms both, exactly as before.
    const asked = { ...task, request: `who posted https://reddit.com/r/weddings/comments/xyz` };
    assert.ok(buildTaskPrompt(asked, { now: 0, tz: 'UTC', browser: true }).includes('tooling:'));
    assert.equal(legBudgetFor(asked, env), 9000);
  } finally {
    resetEngineBackendCache(undefined);
  }
});

test('CONVO_ROUTING_GATE_MEMORY_AWARE=off carries nothing on either delegation', async () => {
  process.env.CONVO_ROUTING_GATE_MEMORY_AWARE = 'off';
  try {
    const forced = await processConvoResult({ ...args(), res: makeResult([]), relevance: relevance(ASK, { notes: [NOTE] }) });
    assert.equal(forced.delegatedTask!.metaPrompt, gateBrief(ASK));
    assert.equal(forced.delegatedTask!.heldMemory, undefined);
    const model = await processConvoResult({
      ...args(),
      res: makeResult(['one sec'], [{ name: 'delegate_to_ops', input: { kind: 'general', request: ASK, meta_prompt: 'get the exact date off her calendar' } }]),
      relevance: relevance(ASK, { notes: [NOTE] }),
    });
    assert.equal(model.delegatedTask!.metaPrompt, 'get the exact date off her calendar');
    assert.equal(model.delegatedTask!.heldMemory, undefined);
    assert.equal(model.delegatedTask!.memoryHits, 0);
  } finally {
    delete process.env.CONVO_ROUTING_GATE_MEMORY_AWARE;
  }
});

test('a delegation the MODEL made never re-enters the gate, so there is no second receipt', async () => {
  // The structural fence: `delegatedTask` being set is what makes the whole block skip, and a turn
  // with no evaluation must claim no decision rather than a defaulted one.
  const out = await processConvoResult({
    ...args(),
    res: makeResult(['lemme pull that up'], [{ name: 'delegate_to_ops', input: { kind: 'general', request: ASK, meta_prompt: 'find the date' } }]),
    relevance: relevance(ASK, { notes: [NOTE] }),
  });
  assert.ok(out.delegatedTask);
  assert.equal(getTraces().find(e => e.label === 'convo:routing_gate'), undefined, 'the gate was never evaluated');
});

// ── the decision on the turn receipt ────────────────────────────────────────

/** The smallest honest `trace` a caller can hand in — the receipt's other fields are pinned by
 *  turnTrace.test.ts; this is only here so the gate's decision has somewhere to land. */
const traceInputs = (): TurnTraceTurnInputs => ({
  prompt: { system: 'x', tail: 'y', sections: [], personaChars: 0, anchorChars: 0, craft: [], cacheBreakpoints: [] },
  messages: [],
  gates: {
    threads: null,
    memory: { shortHotLook: 'none', hits: [], blocks: {} },
    extras: { updateNote: false, introWeave: false, activeOps: 0 },
  },
  hits: [],
});

test('the gate’s decision rides the turn receipt, and only when the gate ran', async () => {
  const stood = await processConvoResult({
    ...args(),
    res: makeResult(ANSWER),
    relevance: relevance(ASK, { notes: [NOTE] }),
    trace: traceInputs(),
  });
  assert.equal(stood.turnTrace!.outcome.routingGate, 'skipped_memory_hit');

  const forced = await processConvoResult({ ...args(), res: makeResult([]), relevance: relevance(ASK, {}), trace: traceInputs() });
  assert.equal(forced.turnTrace!.outcome.routingGate, 'delegated');

  // A turn the gate never reached claims nothing rather than a defaulted decision.
  const modelLed = await processConvoResult({
    ...args(),
    res: makeResult(['one sec'], [{ name: 'delegate_to_ops', input: { kind: 'general', request: ASK } }]),
    relevance: relevance(ASK, { notes: [NOTE] }),
    trace: traceInputs(),
  });
  assert.equal('routingGate' in modelLed.turnTrace!.outcome, false);
});

// ── the far end of the brief ─────────────────────────────────────────────────
// The kickoff receipt is where a live round reads back whether a look went out blind. Same stub-
// engine pattern as ops/walledUrls.test.ts, kept here because it is the other end of the block above.

test('ops:kickoff says how much of her memory rode along', async () => {
  const engine = stubEngine();
  const task = { id: 't1', chatId: 'c1', agentHandle: '+15558000000', kind: 'general' as const, request: ASK, metaPrompt: 'brief', attempt: 1, createdAt: Date.now() };
  resetEngineBackendCache(engine);
  try {
    clearTraces();
    await runTask({ ...task, memoryHits: 2 });
    assert.equal((getTraces().find(e => e.label === 'ops:kickoff')!.detail as Record<string, unknown>).memoryHits, 2);
    // A look that carried nothing reports zero, not nothing: "the engine was handed none of her
    // memory" has to be a reading, not an absence.
    clearTraces();
    await runTask(task);
    assert.equal((getTraces().find(e => e.label === 'ops:kickoff')!.detail as Record<string, unknown>).memoryHits, 0);
  } finally {
    resetEngineBackendCache(undefined);
  }
});
