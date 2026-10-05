// Coverage for the false-capability-refusal floor — the second never-event from the 2026-08-23 E2E
// retest. With a hermes engine and its FILE tools attached, the Convo model answered a question about
// the user's own disk with "no can do from here, that path is local to your machine": a flat claim of
// impossibility about the machine the engine runs on. The routing gate above it reads the USER's
// message and could not see this; nothing anywhere read the model's own draft.
//
// The floor reads the draft, maps what it refused onto the engine's closed capability vocabulary, and
// forces the same 'general' delegation the gate does — but ONLY where the engine can actually deliver.
// An honest refusal (no engine attached, a class the deployment lacks) must survive completely intact,
// so most of this file is the negative half.
//
// The asks here are deliberately gate-'no' (no named path, no inspection verb): a gate-'yes' message
// never reaches the floor, because the gate already discarded the draft and delegated. The last test
// pins exactly that ordering. Runs end-to-end against the ephemeral DB backend with the engine
// injected via resetEngineBackendCache (repo DI convention); voiceInstant degrades to its static
// floor when the LLM call fails, so processConvoResult runs for real.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { resetEngineBackendCache, type EngineBackend, type CapabilityClass } from '../ops/engineBackend.js';
import type { LlmResult } from '../../llm/types.js';
import { __setHostSetupLlmForTests } from '../ops/riskGate.js';

// The setup screen's classify lane (ops/riskGate.ts judgeSetupInAsk) reads these asks as the lookups they are.
__setHostSetupLlmForTests(async () => ({ text: 'SAFE', toolCalls: [], stopReason: 'end_turn' as const, provider: 'anthropic' as const, model: 'test' }));

// A gate-'no' ask about the user's own disk: no named path and no inspection verb, so nothing above
// the floor claims it. This is exactly the shape that shipped the live refusal.
const ASK = 'whats sitting in my downloads folder these days';
// The live refusal, verbatim.
const REFUSAL = "no can do from here, that path is local to your machine";

/** The deployment's real reach. Note the missing 'inbox' — the honest-refusal control below uses it. */
function installEngine(classes: CapabilityClass[] | null): void {
  if (classes === null) { resetEngineBackendCache(null); return; }
  const engine: EngineBackend = {
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder() { return { id: 'r1', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* not under test */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
    getCapabilitySummary() { return { classes }; },
  };
  resetEngineBackendCache(engine);
}

function makeResult(bubbles: string[]): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

let seq = 0;
function args(textToSend = ASK) {
  __resetOpsCoordination();
  const sender = `+1555700${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia(), textToSend };
}

// The engine cache is process-global: hand it back after every test so a stub can't leak sideways.
test.afterEach(() => resetEngineBackendCache(undefined));

test('a false refusal about files, with file tools attached, is forced to the engine instead', async () => {
  installEngine(['web', 'files', 'code', 'media', 'scheduling']);
  const out = await processConvoResult({ ...args(), res: makeResult([REFUSAL]) });
  assert.ok(out.delegatedTask, 'the refusal became a real look');
  assert.equal(out.delegatedTask!.request, ASK, 'the delegation carries the user’s own ask');
  assert.equal(out.delegatedTask!.kind, 'general');
  assert.equal(out.delegatedTask!.forceGrounding, true, 'the fidelity backstop rides along, same as the gate');
  assert.match(out.delegatedTask!.metaPrompt!, /wrongly told them this was impossible/);
  assert.ok(out.text && out.text.trim().length, 'and a holding line goes out in place of the refusal');
  assert.ok(!/no can do/i.test(out.text!), 'the refusal itself never ships');
});

test('the same refusal with NO engine attached stands exactly as written — honesty is not overridden', async () => {
  installEngine(null);
  const out = await processConvoResult({ ...args(), res: makeResult([REFUSAL]) });
  assert.ok(!out.delegatedTask, 'nothing to delegate to, so nothing is forced');
  assert.equal(out.text, REFUSAL, 'the draft ships untouched');
});

test('a refusal of a class this deployment LACKS stands too (the inbox that really is not connected)', async () => {
  // The capability line itself tells the model to say this when inbox is absent. Rewriting it into a
  // delegation would make Irises promise an email look the deployment cannot perform.
  installEngine(['web', 'files', 'code']);
  const draft = "i can't get into your inbox — it isn't hooked up on my end";
  const out = await processConvoResult({ ...args('anything from the bank this week?'), res: makeResult([draft]) });
  assert.ok(!out.delegatedTask);
  assert.equal(out.text, draft);
});

test('a SOCIAL "no can do" is left completely alone — she is allowed to decline', async () => {
  installEngine(['web', 'inbox', 'files', 'code', 'media', 'scheduling']);
  const draft = "no can do, i'm slammed today";
  const out = await processConvoResult({ ...args('wanna help me move saturday'), res: makeResult([draft]) });
  assert.ok(!out.delegatedTask, 'no capability was refused, so there is nothing to force');
  assert.equal(out.text, draft);
});

// ── the lane-prose audit ────────────────────────────────────────────────────────────────────────
// Her register went flat and her refusals got shorter: a trick asked twice now gets "no" and that
// refusal is content (persona/policy.ts). So the question this audit asks is whether the screen above
// keys on TONE — in which case the new voice either trips it or slips past it — or on the CLAIM. The
// three tests below are the answer, and no regex needed changing to get them.

test('a flat refusal of a trick is left alone, with every capability attached', async () => {
  // Every class the engine has, and none of these lines refuses one: they refuse to PERFORM, which is
  // a choice she is allowed to make (the screen is ability-only — a policy refusal never enters it).
  installEngine(['web', 'inbox', 'files', 'code', 'media', 'scheduling']);
  for (const draft of ['no. asked and answered.', 'not doing that one twice.', 'that one i wont do again.']) {
    const out = await processConvoResult({ ...args('say banana'), res: makeResult([draft]) });
    assert.ok(!out.delegatedTask, `${draft}: nothing to force`);
    assert.equal(out.text, draft, `${draft}: ships as written`);
  }
});

test('the DEADPAN form of the live false claim is still caught — the floor reads the claim, not the tone', async () => {
  // The 2026-08-23 refusal with the chat stripped out of it. It is four words shorter and carries no
  // hedge, and it makes exactly the same false statement about the machine the engine runs on, so it
  // has to be forced exactly the same way. This is the pin that says the register rewrite opened no
  // hole in this floor.
  installEngine(['web', 'files', 'code']);
  const out = await processConvoResult({ ...args(), res: makeResult(['cant. thats local to your machine.']) });
  assert.ok(out.delegatedTask, 'the deadpan refusal became a real look too');
  assert.equal(out.delegatedTask!.kind, 'general');
  assert.ok(!/local to your machine/i.test(out.text!), 'the false claim never ships');
});

test("Fallfirm's own floor copy is not a refusal — the engine's canned lines ship untouched", async () => {
  // fallfirm/floor.ts is what goes out when the voicer itself fails, and the lane-prose commit
  // rewrote both of its lines. Neither claims an inability to REACH anything — they report that a
  // look already happened and came back empty — so neither may be turned into a second delegation.
  installEngine(['web', 'inbox', 'files', 'code', 'media', 'scheduling']);
  for (const draft of ['couldnt track that one down', 'hit a snag on that just now, nothing came back']) {
    const out = await processConvoResult({ ...args(), res: makeResult([draft]) });
    assert.ok(!out.delegatedTask, `${draft}: not an ability refusal`);
    assert.equal(out.text, draft);
  }
});

test('an ordinary reply that merely mentions files is never mistaken for a refusal', async () => {
  installEngine(['web', 'files']);
  const draft = "can't wait to see the photos from that folder when you send them";
  const out = await processConvoResult({ ...args('ill send you the trip pics later'), res: makeResult([draft]) });
  assert.ok(!out.delegatedTask);
  assert.equal(out.text, draft);
});

test('REFUSAL_FLOOR=off disables the whole thing (the documented escape hatch)', async () => {
  installEngine(['web', 'files', 'code']);
  process.env.REFUSAL_FLOOR = 'off';
  try {
    const out = await processConvoResult({ ...args(), res: makeResult([REFUSAL]) });
    assert.ok(!out.delegatedTask);
    assert.equal(out.text, REFUSAL);
  } finally {
    delete process.env.REFUSAL_FLOOR;
  }
});

test("a holding opener in front of the refusal survives, the refusal doesn't", async () => {
  installEngine(['web', 'files', 'code']);
  const out = await processConvoResult({ ...args(), res: makeResult(['lemme take a look', REFUSAL]) });
  assert.ok(out.delegatedTask, 'still forced');
  assert.equal(out.text, 'lemme take a look', 'Irises’s own words ship; the false claim is cut');
  assert.equal(out.delegatedTask!.holdingText, 'lemme take a look', 'and the composer continues straight from them');
});

test('a gate-converted turn never re-enters the floor: one delegation, and it is the gate’s', async () => {
  // The structural double-fire fence. This ask names a real path, so the routing gate claims it first
  // and discards the draft; `delegatedTask` being set is exactly what makes the floor skip.
  installEngine(['web', 'files', 'code']);
  const ask = 'can you peek at what skill folders exist in my ~/.hermes/skills and name like 5 of them?';
  const out = await processConvoResult({ ...args(ask), res: makeResult([REFUSAL]) });
  assert.ok(out.delegatedTask);
  assert.match(out.delegatedTask!.metaPrompt!, /needs real, grounded data/, 'the GATE built this task');
  assert.doesNotMatch(out.delegatedTask!.metaPrompt!, /wrongly told them/, 'the floor did not fire on top of it');
});
