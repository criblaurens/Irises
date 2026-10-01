// Coverage for the unkept-promise guard — the honesty backstop under the one failure the persona
// names as unrecoverable: a reply that PROMISES work while calling no tool, with nothing running.
//
// The live shape (VPS, 2026-09-02): the user asked for a browser look and got "yeah, i already told
// hermes to use the browser … still on it, hang tight" with `tool_calls: null` and no run in flight —
// the earlier one had finished hours before. Two halves are pinned here: the pure lexicon/verdict,
// and the ONE corrective re-ask in the call path (through the injected `turn.call` seam, so the three
// ways a re-ask can land are all real turns end-to-end against the ephemeral DB backend).

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  detectUnkeptPromise, renderPromiseCorrection, unkeptPromiseGuardEnabled, PROMISE_PHRASES,
  detectUnbackedClaim, dropClaims,
} from './unkeptPromise.js';
import { processConvoResult, type ChatContext, type ConvoTurnContext } from './shared.js';
import {
  REACTION_TOOL, DELEGATE_TO_OPS_TOOL, RECALL_MEMORY_TOOL, SCHEDULE_AUTOMATION_TOOL, CANCEL_AUTOMATION_TOOL,
} from './tools.js';
import { resetEngineBackendCache, type EngineBackend } from '../ops/engineBackend.js';
import { emptyMedia } from '../../webhook/types.js';
import { markOpsStart, __resetOpsCoordination } from '../../state/opsCoordination.js';
import { getTraces, clearTraces, record } from '../../diagnostics/trace.js';
import type { LlmRequest, LlmResult, LlmToolCall } from '../../llm/types.js';

// What the user asked in the live failure — deliberately a message the routing gate reads as social
// ('no'), which is exactly why the fabricated claim shipped: no other gate was going to fire. In
// English like every other fixture here: her voice is L1 English, and no other language belongs in
// this file's fixtures any more than in the lexicon (user rule 2026-09-04).
const ASK = 'try asking hermes to use the browser feature';
// And the reply it produced, bubble for bubble.
const FABRICATED = ['yeah, i already told hermes to use the browser', 'still on it, hang tight'];

// ── the lexicon and the verdict (pure) ───────────────────────────────────────

test('the live failure reads as an unkept promise: a claim of work with no tool and nothing running', () => {
  assert.deepEqual(detectUnkeptPromise(FABRICATED, null, 0), {
    promised: true, phrase: 'on it', unkept: true,
  });
});

test('a real delegation with a holding line is a KEPT promise — the work is actually being done', () => {
  const verdict = detectUnkeptPromise(['on it, gimme a sec'], [{ name: 'delegate_to_ops' }], 0);
  assert.equal(verdict.promised, true, 'the words are still a promise');
  assert.equal(verdict.unkept, false, 'but the turn backed them with a tool call');
});

test('"still on it" while research is genuinely in flight is kept too', () => {
  const verdict = detectUnkeptPromise(['still on it', 'hang tight'], null, 1);
  assert.equal(verdict.promised, true);
  assert.equal(verdict.unkept, false, 'an active run is what makes the line true');
});

test('a reply that promises nothing is not a promise at all', () => {
  assert.deepEqual(detectUnkeptPromise(['haha yeah cats do that', 'mine sits on the keyboard'], null, 0), {
    promised: false, unkept: false,
  });
});

// The short-wait rows and the thinking sound (unkeptPromise.ts, "The short waits"): a wait whose only
// reading is "wait for me" is a promise with nothing behind it when no look runs; a bare hum is a
// reaction and ships as written.
test('a short wait with nothing behind it is a promise, and a bare thinking sound is not', () => {
  assert.equal(detectUnkeptPromise(['one sec'], null, 0).unkept, true);
  assert.equal(detectUnkeptPromise(['give me a sec'], null, 0).unkept, true);
  assert.equal(detectUnkeptPromise(['hmm'], null, 0).promised, false);
});

// The lane-prose audit, the half that outlived the prose's example holding lines (the delegate doc
// and the JSON anchor now state the beat rule instead of listing lines to copy, so there is no taught
// line left to loop over): the flat, dry lines the register produces that are NOT promises. Each of
// these has to ship exactly as written — a corrective re-ask on an honest reply is the failure this
// lexicon's shortness buys away.
test('the flat register\'s honest lines are not promises', () => {
  for (const line of [
    'worth checking with a doctor before you rely on this',   // bare "checking" is not a row, on purpose
    'checking that yourself is the faster route',
    'cant. thats local to your machine',                      // a refusal, the other guard's business
    'couldnt track that one down',                            // fallfirm's own floor copy
    'hit a snag on that just now, nothing came back',
    'nothing came back from it. say the word and i run it again.',
    'the application window already closed',
  ]) {
    assert.equal(detectUnkeptPromise([line], null, 0).promised, false, line);
  }
});

test('phrases match as whole phrases inside one clause, never across a break', () => {
  // The letters are there in both, the promise is not: the words sit on either side of a break.
  assert.equal(detectUnkeptPromise(['moving on. it can wait'], null, 0).promised, false);
  assert.equal(detectUnkeptPromise(['hang on, it broke again'], null, 0).promised, false);
  // And no substring hits inside longer words.
  assert.equal(detectUnkeptPromise(['depends on itself really'], null, 0).promised, false);
});

// Observed on the 2026-10-01 bench: "your counselor rough on it?" fired the guard, and the re-ask
// rewrote the reply and dropped the unsend the first pass had made.
test('"on it" as the object of a verb or an adjective, or inside a question, is not a promise', () => {
  for (const line of ['your counselor rough on it?', 'id sleep on it tbh', 'u still on it?']) {
    assert.equal(detectUnkeptPromise([line], null, 0).promised, false, line);
  }
  for (const line of ['on it', 'ok on it', "i'm on it", 'hermes is on it']) {
    assert.equal(detectUnkeptPromise([line], null, 0).phrase, 'on it', line);
  }
});

test('matching is blind to case and punctuation', () => {
  assert.equal(detectUnkeptPromise(['ON IT!'], null, 0).phrase, 'on it');
  assert.equal(detectUnkeptPromise(['[[re:1]]ON IT, checking on that'], null, 0).phrase, 'on it');
});

test('every phrase in the single-source lexicon is one the detector actually fires on', () => {
  for (const phrase of PROMISE_PHRASES) {
    const verdict = detectUnkeptPromise([`ok ${phrase} ya`], null, 0);
    assert.equal(verdict.unkept, true, `"${phrase}" should read as a promise`);
    // The reported phrase is the FIRST lexicon hit, which is not always the longest one: "on it"
    // sits inside "still on it". Either reading names the same promise, so the verdict is what
    // matters and the phrase only has to be a real lexicon entry the line actually contains.
    assert.ok(verdict.phrase && `ok ${phrase} ya`.includes(verdict.phrase), `"${phrase}" → ${verdict.phrase}`);
  }
  assert.equal(new Set(PROMISE_PHRASES).size, PROMISE_PHRASES.length, 'no duplicate phrases');
  for (const p of PROMISE_PHRASES) assert.equal(p, p.toLowerCase(), 'the lexicon is stored lowercase');
});

test('the corrective re-ask names the phrase and forbids claiming work is in progress', () => {
  assert.equal(
    renderPromiseCorrection('still on it'),
    'SYSTEM: your reply promised work ("still on it") but called no tool and nothing is running for them. Reply again as ONE JSON object: either include the delegate_to_ops entry that actually does the work, or say plainly what you can and can\'t do right now — never claim work is in progress.',
  );
});

test('the flag defaults ON and reads at call time', () => {
  delete process.env.CONVO_UNKEPT_PROMISE_GUARD;
  assert.equal(unkeptPromiseGuardEnabled(), true);
  process.env.CONVO_UNKEPT_PROMISE_GUARD = 'off';
  assert.equal(unkeptPromiseGuardEnabled(), false);
  delete process.env.CONVO_UNKEPT_PROMISE_GUARD;
});

// ── the one corrective re-ask (through the DI seam) ──────────────────────────

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

const fabricated = () => makeResult(FABRICATED);

let seq = 0;
function turnCtx(call: (req: LlmRequest) => Promise<LlmResult>): ConvoTurnContext {
  return {
    system: 'SYSTEM PROMPT (persona + this turn)',
    messages: [{ role: 'user', content: ASK }],
    tools: [REACTION_TOOL, DELEGATE_TO_OPS_TOOL, RECALL_MEMORY_TOOL],
    call,
  };
}

function args() {
  __resetOpsCoordination();
  clearTraces();
  delete process.env.CONVO_UNKEPT_PROMISE_GUARD;
  const sender = `+1555700${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return {
    chatId: randomUUID(),
    handle: chatContext.senderHandle!,
    chatContext,
    history: [],
    media: emptyMedia(),
    textToSend: ASK,
  };
}

// The DECISION receipt, not the re-ask's LLM call: in production the seam resolves to
// callConvoLLM → callLLM, which records the request's own trace label into THIS ring as a
// `type: 'llm'` entry, so a label-only lookup is only correct while the two labels differ (they do,
// and the test below pins it). Filtering on the type as well makes the idiom right either way.
function receipt() {
  return getTraces().find(e => e.type === 'event' && e.label === 'convo:unkept_promise')?.detail;
}

test('an unkept promise gets ONE re-ask showing the model its own reply and the correction', async () => {
  const seen: LlmRequest[] = [];
  const original = fabricated();
  await processConvoResult({
    ...args(),
    res: original,
    turn: turnCtx(async req => {
      seen.push(req);
      return makeResult(["i can't run the browser from here", 'which side do you want me to try']);
    }),
  });
  assert.equal(seen.length, 1, 'exactly one re-ask');
  assert.equal(seen[0].system, 'SYSTEM PROMPT (persona + this turn)', 'the same turn, re-asked');
  assert.ok(seen[0].tools?.some(t => t.name === 'delegate_to_ops'), 'the full tool list still stands');
  assert.deepEqual(seen[0].messages.slice(-2), [
    { role: 'assistant', content: original.text },
    { role: 'user', content: renderPromiseCorrection('on it') },
  ], 'its own slip, then the correction');
});

test('the re-ask\'s call and the decision receipt land under SEPARATE labels in the ring', async () => {
  // In production `turn.call` resolves to callConvoLLM → callLLM, which records the request's own
  // `trace.label` into this same ring as `{ type: 'llm', … }` (src/llm/callLLM.ts) — so the fake
  // seam does that here too, and the ring below is shaped the way a real turn shapes it. Every
  // consumer in the repo matches by label alone with no type filter
  // (scripts/convergence/loopBattery.ts), so one label for both entries would make
  // `find(label === 'convo:unkept_promise')` return the LLM call instead of the decision, and a
  // label count in a live round double every trigger. Same split as the siblings:
  // `convo:silent_retry` (the call) vs `convo:silent_turn` (the decision).
  await processConvoResult({
    ...args(),
    res: fabricated(),
    turn: turnCtx(async req => {
      const out = makeResult(["i can't run the browser from here"]);
      record({
        type: 'llm', role: 'convo', label: req.trace?.label,
        chatId: req.trace?.chatId, handle: req.trace?.handle, response: out.text,
      });
      return out;
    }),
  });
  assert.deepEqual(
    getTraces().filter(e => (e.label ?? '').startsWith('convo:unkept')).map(e => `${e.type} ${e.label}`),
    ['llm convo:unkept_retry', 'event convo:unkept_promise'],
    'the call and the decision are told apart by label alone',
  );
  assert.deepEqual(receipt(), { phrase: 'on it', retried: true, resolved: 'honest' });
});

test('a re-ask that delegates for real is accepted and the delegation is dispatched', async () => {
  const out = await processConvoResult({
    ...args(),
    res: fabricated(),
    turn: turnCtx(async () => makeResult(['hang tight, checking on that'], [
      { name: 'delegate_to_ops', input: { kind: 'general', request: 'use the browser to look at the feature', meta_prompt: null } },
    ])),
  });
  assert.ok(out.delegatedTask, 'the work the promise claimed is now actually running');
  assert.ok(out.text && out.text.trim().length, 'and a holding line goes out with it');
  assert.deepEqual(receipt(), { phrase: 'on it', retried: true, resolved: 'tool_call' });
});

test('an honest re-ask replaces the fabricated claim and says so in the receipt', async () => {
  const out = await processConvoResult({
    ...args(),
    res: fabricated(),
    turn: turnCtx(async () => makeResult(["i can't run the browser from here"])),
  });
  assert.equal(out.text, "i can't run the browser from here");
  assert.deepEqual(receipt(), { phrase: 'on it', retried: true, resolved: 'honest' });
});

test('a re-ask that promises again keeps the ORIGINAL reply — never a dropped turn', async () => {
  let calls = 0;
  const out = await processConvoResult({
    ...args(),
    res: fabricated(),
    turn: turnCtx(async () => { calls++; return makeResult(['hang tight, still on it']); }),
  });
  assert.equal(calls, 1, 'one re-ask, never a loop');
  assert.equal(out.text, FABRICATED.join('\n---\n'), 'the turn still ships something');
  assert.deepEqual(receipt(), { phrase: 'on it', retried: true, resolved: 'kept_original' });
});

test('a re-ask that comes back empty keeps the original too', async () => {
  const out = await processConvoResult({
    ...args(),
    res: fabricated(),
    turn: turnCtx(async () => makeResult([])),
  });
  assert.equal(out.text, FABRICATED.join('\n---\n'), 'an empty envelope is not an honest answer');
  assert.deepEqual(receipt(), { phrase: 'on it', retried: true, resolved: 'kept_original' });
});

test('a re-ask whose call throws keeps the original reply', async () => {
  const out = await processConvoResult({
    ...args(),
    res: fabricated(),
    turn: turnCtx(async () => { throw new Error('provider down'); }),
  });
  assert.equal(out.text, FABRICATED.join('\n---\n'));
  assert.deepEqual(receipt(), { phrase: 'on it', retried: true, resolved: 'kept_original' });
});

test('with no turn context there is nothing to re-ask, and the receipt says so', async () => {
  const out = await processConvoResult({ ...args(), res: fabricated() });
  assert.equal(out.text, FABRICATED.join('\n---\n'));
  assert.deepEqual(receipt(), { phrase: 'on it', retried: false, resolved: 'kept_original' });
});

test('a promise with research actually running is left alone: no re-ask, no receipt', async () => {
  let calls = 0;
  const a = args();
  markOpsStart(a.chatId, 'task1', { kind: 'general', request: 'the earlier browser look' });
  const out = await processConvoResult({
    ...a,
    res: makeResult(['still on it', 'hang tight']),
    turn: turnCtx(async () => { calls++; return makeResult(['unused']); }),
  });
  assert.equal(calls, 0);
  assert.equal(receipt(), undefined, 'nothing was decided, so nothing is filed');
  assert.equal(out.text, 'still on it\n---\nhang tight');
});

test('a promise the reply backed with its own delegation is left alone too', async () => {
  let calls = 0;
  const out = await processConvoResult({
    ...args(),
    res: makeResult(['on it, one sec'], [
      { name: 'delegate_to_ops', input: { kind: 'general', request: ASK, meta_prompt: null } },
    ]),
    turn: turnCtx(async () => { calls++; return makeResult(['unused']); }),
  });
  assert.equal(calls, 0);
  assert.equal(receipt(), undefined);
  assert.ok(out.delegatedTask);
});

// The per-turn receipt only needs a prompt it can measure — the sizes are not what this pins.
const TRACE_INPUTS = {
  prompt: { system: 'SYSTEM PROMPT (persona + this turn)', tail: 'TAIL (this turn)', sections: [], personaChars: 0, anchorChars: 0, craft: [], cacheBreakpoints: [] },
  messages: [{ content: ASK }],
  gates: {
    threads: null,
    memory: { shortHotLook: 'none' as const, hits: [], blocks: {} },
    extras: { updateNote: false, introWeave: false, activeOps: 0 },
  },
  hits: [],
};

test('the turn receipt says the guard fired on this turn', async () => {
  const out = await processConvoResult({
    ...args(),
    res: fabricated(),
    trace: TRACE_INPUTS,
    turn: turnCtx(async () => makeResult(["i can't run the browser from here"])),
  });
  assert.equal(out.turnTrace?.outcome.unkeptPromise, true);
});

test('and says nothing about it on a turn that promised nothing', async () => {
  const out = await processConvoResult({
    ...args(),
    res: makeResult(['haha yeah cats do that']),
    trace: TRACE_INPUTS,
  });
  assert.equal('unkeptPromise' in out.turnTrace!.outcome, false, 'absent = the guard never fired');
});

test('flag off: the fabricated reply ships exactly as it did before the guard existed', async () => {
  let calls = 0;
  const a = args();
  process.env.CONVO_UNKEPT_PROMISE_GUARD = 'off';
  const out = await processConvoResult({
    ...a,
    res: fabricated(),
    turn: turnCtx(async () => { calls++; return makeResult(['unused']); }),
  });
  delete process.env.CONVO_UNKEPT_PROMISE_GUARD;
  assert.equal(calls, 0, 'no re-ask');
  assert.equal(receipt(), undefined, 'and no receipt');
  assert.equal(out.text, FABRICATED.join('\n---\n'));
});

// ── the unbacked-claim half ──────────────────────────────────────────────────
// The incident's last turn said a change had landed ("got it, revised the morning one") with no call
// behind it at all. A claim is checked against what the turn actually changed, and shares the one
// re-ask with the promise check above.

test('"got it, revised" with nothing changed this turn gets exactly one re-ask', async () => {
  // A claim is a STATEMENT that a change landed. The same words asked, offered, planned or denied
  // are the honest replies to a turn that changed nothing, so none of these may cost a re-ask.
  for (const line of [
    "i'll set it for 7?",
    'want me to set it to govt news instead?',
    'all set?',
    'i can set it for 7 if you want',
    "can't set it to 7, that slot's taken",
    "i haven't changed it yet",
    "i haven't cancelled it yet",
    'done for today',
    'changed my mind, keep it',
    'updated?',
  ]) {
    assert.equal(detectUnbackedClaim([line], null, false).claimed, false, line);
  }
  for (const line of [
    'got it, revised', 'done', 'switched it', '[[re:1]]done', 'got it, revised the morning one', 'updated it to 8am',
    'i revised the morning one', 'got it revised the morning one', 'ok revised the morning one',
    "i've updated your brief to govt news", 'i changed the 7am one to govt news',
  ]) {
    assert.equal(detectUnbackedClaim([line], null, false).unbacked, true, line);
  }
  // The routing tag survives a dropped claim whole (its colon is not a clause break).
  assert.equal(dropClaims('[[re:1]]all set, digging in now'), '[[re:1]]digging in now');

  const seen: LlmRequest[] = [];
  const out = await processConvoResult({
    ...args(),
    res: makeResult(['got it, revised']),
    turn: turnCtx(async req => {
      seen.push(req);
      return makeResult(["i haven't changed it yet, which one did you mean?"]);
    }),
  });
  assert.equal(seen.length, 1, 'one re-ask');
  assert.match(String(seen[0].messages[seen[0].messages.length - 1].content), /"revised"/, 'naming the claim');
  assert.equal(out.text, "i haven't changed it yet, which one did you mean?", 'the honest answer is accepted');

  // A re-ask that only talks must be honest on both counts: trading the claim for a promise nothing
  // keeps, or the promise for a claim nothing backs, keeps the original instead.
  const traded = await processConvoResult({
    ...args(),
    res: makeResult(['got it, revised']),
    turn: turnCtx(async () => makeResult(['my bad, on it now'])),
  });
  assert.equal(traded.text, 'got it, revised', 'a claim traded for an unkept promise is not accepted');
  const tradedBack = await processConvoResult({
    ...args(),
    res: fabricated(),
    turn: turnCtx(async () => makeResult(['got it, switched it'])),
  });
  assert.equal(tradedBack.text, FABRICATED.join('\n---\n'), 'a promise traded for an unbacked claim is not accepted');
});

test('a bare completion word on a turn that asked for nothing is about their day, never a claim', () => {
  // Observed live (2026-09-24 latency round): "finally finished the deck", then "lol". The draft
  // said the deck was done, the bare "done" read as her claiming a change, and the forced re-ask
  // shipped an apology for an action nobody asked about. A share or idle turn asked for nothing, so
  // a completion word there is about THEIR thing.
  const banter = { taskTurn: false };
  for (const line of ['done', 'deck: done', 'all done, go rest', 'fixed', 'all set for tomorrow then']) {
    assert.equal(detectUnbackedClaim([line], null, false, banter).claimed, false, line);
  }
  // A verb with its object still says SHE changed something, whatever the turn asked for.
  for (const line of ['got it, revised the morning one', 'switched it', 'i changed the 7am one to govt news', 'cancelled it']) {
    assert.equal(detectUnbackedClaim([line], null, false, banter).unbacked, true, line);
  }
  // And a task turn keeps the whole lexicon, which is also the default when the turn kind is unknown.
  assert.equal(detectUnbackedClaim(['done'], null, false, { taskTurn: true }).unbacked, true);
  assert.equal(detectUnbackedClaim(['done'], null, false).unbacked, true);
});

test('a claim on the outcome pass that calls nothing, beside a miss nothing fixed, falls back', async () => {
  // The first pass set one reminder and missed a cancel. The pass called nothing and wrote "all
  // done … the gym one is gone", and the trash reminder that landed used to back the whole line,
  // so a cancel that never happened shipped as done. With a miss still standing and no call of its
  // own, nothing the pass says can be backed by what an earlier pass did.
  resetEngineBackendCache({
    name: 'hermes',
    async runTask() { throw new Error('not under test'); },
    async createReminder(spec) { return { id: 'aa11bb22cc33', title: spec.title ?? spec.instruction, schedule: spec.cron ?? '' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* not under test */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
  } satisfies EngineBackend);
  try {
    let calls = 0;
    const out = await processConvoResult({
      ...args(),
      res: makeResult(['ok'], [
        { name: 'schedule_automation', input: { instruction: 'take the trash out', schedule_kind: 'cron', cron: '0 21 * * *' } },
        { name: 'cancel_automation', input: { match: 'gym' } },
      ]),
      turn: {
        ...turnCtx(async () => {
          calls++;
          return makeResult(['all done, trash every night at 9 and the gym one is gone']);
        }),
        tools: [REACTION_TOOL, SCHEDULE_AUTOMATION_TOOL, CANCEL_AUTOMATION_TOOL],
      },
    });
    assert.equal(calls, 1, 'the pass, and no re-ask on top of it');
    assert.doesNotMatch(out.text!, /gym one is gone/, 'the unbacked claim does not ship');
  } finally {
    resetEngineBackendCache(undefined);
  }
});
