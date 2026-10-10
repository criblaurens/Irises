// The rhythm engine, WIRED. persona/hooks.test.ts owns the arithmetic and the rendered bytes; this
// file owns everything that happens around them on a real turn: which section the directive puts in
// the prompt and where, what the two flags cost when they are off, the one corrective re-ask a
// broken quiet turn gets, and the ledger row the turn leaves behind.
//
// Four seams, four shapes of test. The assembler is pure, so those cases are argument tuples. The
// quiet guard calls the model, so those go through the injected `turn.call` seam the promise guard's
// suite uses. The ledger is a store write, so those run end to end against the ephemeral backend —
// including in a GROUP, which is the one place this engine deliberately does not fence itself off.
// And the pre-read that decides everything the first three are handed lives in convo/client.ts, so
// the last block drives `chat` itself through its own injected lane (the forgetEngine precedent).

process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';
// The recall second pass is driven for real in the quiet-guard block below, and query expansion
// defaults ON in production and dispatches a REAL classify call when nothing is injected. Pinned off
// for the file, the recallMemory.test.ts way, so nothing here can reach a provider.
process.env.MEMORY_RECALL_EXPANSION = 'off';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  buildSystemPromptSections, enforceQuiet, processConvoResult, QUIET_CORRECTION,
  quietStoodDownReceipt,
  type ChatContext, type ConvoTurnContext, type PersonaTurn,
} from './shared.js';
import { chat } from './client.js';
import { clearIdleClassifyCache } from './idleClassify.js';
import { craftModuleText } from './personaModules.js';
import { DYN_SECTION_IDS, type SectionId } from './promptSections.js';
import { REACTION_TOOL, DELEGATE_TO_OPS_TOOL } from './tools.js';
import {
  HOOK_HEADING, HOOK_NONE_OPEN, HOOK_LATE_LINE, HOOK_WORDS, MOMENTS_LEAD, QUIET_LAW, renderHooksSection,
  SHARE_HEADING, SHARE_LATE_LINE, SHARE_LEAD, SHARE_QUESTION_LINE,
  type HookDirective, type HookSelectReport, type HookState,
} from '../../persona/hooks.js';
import type { ThreadTurn } from '../../memory/threadHarvest.js';
import { getHookState, saveHookState } from '../../db/repositories/hookState.js';
import { saveRelationshipClimate } from '../../db/repositories/relationshipClimate.js';
import { defaultClimate } from '../../persona/climate.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import type { ComputedState } from '../../persona/status.js';
import { groupHandle } from '../../memory/identity.js';
import { resetStorageForTests } from '../../db/sqlite.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { LlmRequest, LlmResult, LlmToolCall } from '../../llm/types.js';
import type { StoredMessage, UserProfile } from '../../db/types.js';

// A frozen clock, the same pin promptBudget.test.ts installs and for the same reason: the assembler
// reads the wall clock for its time and timing sections, so "the same turn twice is the same bytes"
// is only true while the clock is held still. Pinned by hand rather than with node:test's
// MockTimers, which prints an ExperimentalWarning.
const FROZEN_MS = Date.UTC(2026, 0, 6, 2, 0, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

// NO LANE, deliberately. Every model call in this file is either injected at the seam or must FAIL,
// and the idle classifier is the one that would otherwise reach a network from a unit test: a short
// message the English fast path cannot read goes to layer 3, and layer 3 is a real `callLLM`
// (convo/idleClassify.ts). Blank keys read as unconfigured everywhere (llm/laneKeys.ts), so the call
// throws instantly and the gate reads `unclear` → a task turn, which is the failing-toward-task
// behaviour the whole design rests on. The runner gives each test file its own process, so this is
// file-local.
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.OPENROUTER_API_KEY = '';
process.env.OPENAI_API_KEY = '';

beforeEach(() => {
  resetStorageForTests();
  __resetOpsCoordination();
  clearTraces();
  // Process-local and keyed on the text alone, so one case's verdict would otherwise be the next
  // case's cache hit — and `cached: true` is a thing these tests assert about.
  clearIdleClassifyCache();
  delete process.env.CONVO_HOOKS_ENABLED;
  delete process.env.MEMORY_THESIS_ENABLED;
  delete process.env.MEMORY_MOMENTS_ENABLED;
  delete process.env.CONVO_UNKEPT_PROMISE_GUARD;
  delete process.env.CONVO_SHARE_TURNS_ENABLED;
});

// ── the three modes through the assembler ────────────────────────────────────

const PROFILE: UserProfile = {
  handle: '+15550001111', name: 'Sam', facts: ['runs a nursery'], firstSeen: 1, lastSeen: 2,
};
const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'any word on the cedars', handle: '+15550001111', at: Date.UTC(2026, 0, 6, 1, 40) },
  { role: 'assistant', content: 'six to eight weeks from the north supplier', at: Date.UTC(2026, 0, 6, 1, 42) },
];
const CONTEXT_BLOCK = '## Who you are talking to\nSam, three months in.';
/** The clock-computed half of her weather, on this file's own frozen instant. Only the heavy-share
 *  case below needs it: the internal-weather block — and therefore the climate span inside it — is
 *  guarded on `computed` being present, so a turn that passes none renders no register at all and
 *  could not tell a line that was dropped from a line that was never built. */
const COMPUTED: ComputedState = {
  cycle: computeCycle(FROZEN_MS, FROZEN_MS),
  circadian: computeCircadian(FROZEN_MS, 'UTC'),
};
const EXTRA = '## One more thing\nAn addendum the caller tacked on.';
const THESIS = '## Your read on them (INTERNAL)\nThey decide fast on money and slowly on people.';
/** A moment sample as `renderMomentLines` hands it over — two lines, in the store's own shape. Only
 *  the flag test needs them: what a real sample costs the `hooks` ceiling is measured next door in
 *  promptBudget.test.ts, and what the sampler does to the ledger is pinned in earnedMaterial.test.ts. */
const MOMENT_LINES = [
  '- (habit, last week) checked the volcano dashboard again and decided nothing',
  '- (embarrassing, a month or two ago) re-did the side gate rather than call the joiner back',
];

const HOOK: HookDirective = {
  idle: true, mode: 'hook', forbidden: [], lateNight: false, moments: false, offerAllowed: true,
};
const QUIET: HookDirective = { ...HOOK, mode: 'quiet', offerAllowed: false };
const TASK: HookDirective = { ...HOOK, idle: false, mode: 'task', offerAllowed: false };
/** The fourth mode, as the selector hands it over: they said something, so `idle` is false, and the
 *  question is one of the kinds the shape leaves open. Only the post-model block below needs it —
 *  what a share turn RENDERS is pinned in persona/hooks.test.ts, and the front-door case that
 *  produces one of these for real is the client seam's. */
const SHARE: HookDirective = { ...HOOK, idle: false, mode: 'share' };

type BuildArgs = Parameters<typeof buildSystemPromptSections>;

/** One assembled turn, varying only the per-turn persona struct. Everything else is the same shape
 *  every case, so a difference in the output is a difference the directive caused. */
function build(personaTurn?: PersonaTurn): BuildArgs {
  return [
    { isGroupChat: false, participantNames: [], chatName: null, senderHandle: PROFILE.handle, senderProfile: PROFILE },
    CONTEXT_BLOCK, [], EXTRA, undefined, HISTORY, 'hmm', 'UTC',
    undefined, undefined, null, undefined, undefined, undefined,
    { text: 'hmm', hits: [] }, undefined, personaTurn,
  ];
}

/** The whole prompt text one build hands the model, in reading order: the system message, then the
 *  per-turn tail (the history sits between them on the wire, convo/client.ts). The hook section, the
 *  thesis and the drift anchor all ride the tail; reading both halves keeps every byte-identity pin
 *  below a pin on everything the build produced. */
const textOf = (built: ReturnType<typeof buildSystemPromptSections>): string => `${built.system}\n\n${built.tail}`;

const sectionsOf = (personaTurn?: PersonaTurn): SectionId[] =>
  buildSystemPromptSections(...build(personaTurn)).sections.map(s => s.name);

/** The two halves of the thread block, as the pre-turn read hands them over (memory/threadHarvest.ts
 *  ThreadTurn). Only the collision case needs them: what they RENDER is persona/threads.test.ts's,
 *  and all this file asks is that the block exist on the turn. */
const LOOP_TURN: ThreadTurn = {
  offer: { material: 'loop', rungCeiling: 'fact', label: 'the cedars order', note: 'waiting on the north supplier', id: 'l1' },
  outcomeAsk: null,
};
const OUTCOME_ASK_TURN: ThreadTurn = {
  offer: null,
  outcomeAsk: { label: 'the cedars order', material: 'loop' },
};

/** `build` with the thread slot filled. By index, because the parameter list is positional and a
 *  second hand-written tuple would be a second thing to keep in step with the signature. */
function buildWithThread(personaTurn: PersonaTurn, thread: ThreadTurn): BuildArgs {
  const args = build(personaTurn);
  args[12] = thread;
  return args;
}

test('a TASK turn renders no hooks section — and not one byte differs from a turn with no directive', () => {
  const task = buildSystemPromptSections(...build({ hooks: TASK, moments: [], thesis: '' }));
  const none = buildSystemPromptSections(...build());
  assert.ok(!task.sections.some(s => s.name === 'hooks'));
  // The no-regression pin the whole feature rests on: on the turns that are actually work, the
  // prompt is what an install that never had a hook engine would have built.
  assert.equal(textOf(task), textOf(none));
});

test('a QUIET turn renders the quiet block, and a HOOK turn the open-kinds one', () => {
  const quiet = buildSystemPromptSections(...build({ hooks: QUIET, moments: [], thesis: '' }));
  assert.ok(textOf(quiet).includes(renderHooksSection(QUIET)));
  assert.ok(textOf(quiet).includes(QUIET_LAW));
  // A quiet block never names a kind as hers to spend: the mode has already spent the beat, and
  // naming one would be an instruction to think about it. The fourth word is the exception that
  // states the rule rather than breaking it — QUIET_LAW has always carried "no question", inside the
  // clause that FORBIDS the three things a quiet turn may not do, and a ban is the one place a kind
  // may appear. So the sweep is the three carrying kinds, and the question is pinned to its ban.
  const quietBlock = renderHooksSection(QUIET);
  for (const w of HOOK_WORDS) {
    if (w === 'question') continue;
    assert.ok(!quietBlock.includes(w), w);
  }
  assert.ok(quietBlock.includes('No hook, no question, no offer'), 'the one naming is the prohibition');
  assert.equal(quietBlock.split('question').length - 1, 1, 'and it appears there and nowhere else');

  const hook = buildSystemPromptSections(...build({ hooks: HOOK, moments: [], thesis: '' }));
  // FOUR kinds since f7afa57 made the question a first-class hook kind (gated by the affect ceiling
  // and the group rule rather than banned outright), so an unfiltered HOOK turn opens all four.
  assert.ok(textOf(hook).includes('Open to you this turn: a judgment, a callback, a tangent or a question.'));

  // …and only the ALLOWED kinds reach the prompt. Three of the four are forbidden here so exactly one
  // survives: forbidding judgment and tangent alone would still leave the question, which f7afa57
  // made a first-class kind — the assertion below is about the FILTER, not about how many kinds the
  // mode happens to leave open, and the four-kind case above already covers the joining.
  const narrowed: HookDirective = { ...HOOK, forbidden: ['judgment', 'tangent', 'question'] };
  const one = buildSystemPromptSections(...build({ hooks: narrowed, moments: [], thesis: '' }));
  assert.ok(textOf(one).includes('Open to you this turn: a callback.'));
});

test('a SHARE turn that also carries a thread block has its question spent before the section renders', () => {
  // TWO BLOCKS, ONE QUESTION. The thread block holds out a question of its own — a loop is asked
  // ("one flat, plain question … the one hook this turn carries"), a fact-rung theme is offered as
  // one — and the share section's fourth kind is the other. The dose is one per reply, so on the
  // turn that carries both, the section renders from a copy with the question closed (convo/shared.ts
  // at the hooks push site). This is the only place in the build where a directive is narrowed by
  // something other than the selector, which is why it is pinned against the selector's own output
  // rather than against a literal.
  const open: PersonaTurn = { hooks: SHARE, moments: [], thesis: '' };

  // The same turn with nothing standing beside it: all four kinds named, and the line saying what a
  // follow-up IS rides under them.
  const alone = buildSystemPromptSections(...build(open));
  assert.ok(textOf(alone).includes('Open to you this turn: a judgment, a callback, a tangent or a question.'));
  assert.ok(textOf(alone).includes(SHARE_QUESTION_LINE));

  const withLoop = buildSystemPromptSections(...buildWithThread(open, LOOP_TURN));
  assert.ok(withLoop.sections.some(s => s.name === 'thread'), 'the thread block really rendered');
  assert.ok(textOf(withLoop).includes('Open to you this turn: a judgment, a callback or a tangent.'),
    'the three moves she makes out of what she holds survive; the one that asks them does not');
  assert.ok(!textOf(withLoop).includes(SHARE_QUESTION_LINE), 'a ban she reads is a kind she is thinking about');
  // And the section is byte-for-byte the one a selector that had closed the kind itself would have
  // produced — the copy narrows the directive, it does not render a fourth variant of the block.
  assert.ok(textOf(withLoop).includes(renderHooksSection({ ...SHARE, forbidden: ['question'] })));

  // The OUTCOME-ASK half qualifies too, and it is not the looser case it looks like: that block only
  // renders the turn after she floated or asked something, which is the same shape the ledger's own
  // tail closes — they are answering her, and the next move is what she makes of the answer.
  const withAsk = buildSystemPromptSections(...buildWithThread(open, OUTCOME_ASK_TURN));
  assert.ok(withAsk.sections.some(s => s.name === 'thread'));
  assert.ok(!textOf(withAsk).includes(SHARE_QUESTION_LINE));

  // Nothing wrote back: the directive the caller handed in is what the receipt and the ledger read,
  // and it still says what her weather and her ledger allowed, not what this prompt had room for.
  assert.deepEqual(SHARE.forbidden, []);

  // An IDLE turn beside the same block is untouched, because there was nothing to touch — hook mode
  // never names the question whatever the selector says, so the two blocks cannot collide there.
  const idleWithLoop = buildSystemPromptSections(...buildWithThread({ hooks: HOOK, moments: [], thesis: '' }, LOOP_TURN));
  assert.ok(textOf(idleWithLoop).includes(renderHooksSection(HOOK)));
});

test('a HEAVY share turn never reads a band line naming a kind its section closed', () => {
  // The register's half of the same contradiction the collision case closes, and the only seam where
  // `heavy` is read outside the selector. Weight shuts judgment and tangent in the directive
  // (persona/hooks.ts), and two of the four band lines that name a kind are playfulness's — so a
  // weather block gated on the MODE alone would hand someone emptying the tank "a tangent is
  // welcome" beside a section naming only a callback. The assembler narrows the reading by weight
  // for exactly this (`kindOpen && !heavy`).
  //
  // The climate moves ONE dial, into the band whose line is a tangent, so what the span costs a
  // heavy turn is the whole span: with no bullet left, the lead-in and the clamp go too
  // (persona/climate.ts `renderBands`), and the assertion is an absence with nothing to hide in.
  const climate = { ...defaultClimate(), dials: { ease: 35, candor: 45, playfulness: 40 }, evalCount: 30 };
  const TANGENT_LINE = '- Running bits and shorthand carry between you now. A tangent or a bend is welcome.';
  const withClimate = (hooks: HookDirective): string => {
    const args = build({ hooks, moments: [], thesis: '' });
    args[9] = COMPUTED;
    args[11] = climate;
    return textOf(buildSystemPromptSections(...args));
  };

  // The control: an ordinary share turn, every kind open, and the register says the same thing the
  // section does.
  const light = withClimate(SHARE);
  assert.ok(light.includes(TANGENT_LINE), 'the band line rides a share turn that can spend the kind');
  assert.ok(light.includes('Open to you this turn: a judgment, a callback, a tangent or a question.'));

  // …and the same climate on the turn someone let the tank out. The selector's own output is used
  // rather than a hand-built struct: `heavy` and the two kinds it closes are one decision, and a
  // fixture that set the flag without the bans would pin a shape the engine never produces.
  const heavy: HookDirective = { ...SHARE, heavy: true, forbidden: ['judgment', 'tangent'] };
  const weighted = withClimate(heavy);
  assert.ok(!weighted.includes(TANGENT_LINE), 'no kind the weight closed is named back to her');
  assert.ok(!weighted.includes('standing register'), 'and the span it was the only bullet of is gone whole');
  assert.ok(weighted.includes('Open to you this turn: a callback or a question.'),
    'while the section still names what the weight left');
});

test('the two new sections land where the vocabulary says they do', () => {
  // The ids first, because the assembler asserts nothing about order — promptSections.ts does, and
  // the push sites have to agree with it.
  const ids = [...DYN_SECTION_IDS] as string[];
  assert.equal(ids[ids.indexOf('context_block') + 1], 'thesis', 'her read follows the dossier it concludes');
  assert.equal(ids[ids.indexOf('extra') + 1], 'hooks');
  assert.equal(ids[ids.indexOf('hooks') + 1], 'turn_focus', 'and turn_focus is still last');

  const rendered = sectionsOf({ hooks: HOOK, moments: [], thesis: THESIS });
  assert.deepEqual(rendered.slice(rendered.indexOf('context_block'), rendered.indexOf('context_block') + 2),
    ['context_block', 'thesis']);
  assert.deepEqual(rendered.slice(-5), ['extra', 'hooks', 'turn_focus', 'behavior_anchor', 'json_anchor']);
});

test('the drift anchor takes its mode from the same directive the section does', () => {
  // Two readings of one decision. They are rendered a hundred and fifty thousand characters apart,
  // and a turn whose edge says "answer it flat" while its section says "carry a hook" would be the
  // one contradiction this whole arrangement exists to prevent.
  const quiet = buildSystemPromptSections(...build({ hooks: QUIET, moments: [], thesis: '' }));
  const task = buildSystemPromptSections(...build({ hooks: TASK, moments: [], thesis: '' }));
  const anchorOf = (s: string) => s.slice(s.lastIndexOf('## Still the same Irises, this far down'));
  assert.notEqual(anchorOf(textOf(quiet)), anchorOf(textOf(task)));
});

test('an empty thesis is never pushed, so Wave 3 costs today nothing', () => {
  assert.ok(!sectionsOf({ hooks: HOOK, moments: [], thesis: '' }).includes('thesis'));
  assert.ok(!sectionsOf({ hooks: HOOK, moments: [], thesis: '   \n ' }).includes('thesis'));
});

test('each flag OFF is byte-identical to an install that never had the feature', () => {
  // All THREE features loaded at once, which is what makes the all-off assertion below mean
  // anything: a struct carrying a hook directive, a non-empty moment sample and a thesis. The
  // directive opens the moment lead (`moments: true`) — without that the sample is dropped by the
  // renderer's own gate and the moments flag would be tested against bytes that were never going to
  // render either way.
  const full: PersonaTurn = {
    hooks: { ...HOOK, moments: true }, moments: MOMENT_LINES, thesis: THESIS,
  };
  const bare = textOf(buildSystemPromptSections(...build()));

  process.env.CONVO_HOOKS_ENABLED = 'off';
  process.env.MEMORY_THESIS_ENABLED = 'off';
  process.env.MEMORY_MOMENTS_ENABLED = 'off';
  try {
    assert.equal(textOf(buildSystemPromptSections(...build(full))), bare, 'all off: nothing is added');
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
    delete process.env.MEMORY_THESIS_ENABLED;
    delete process.env.MEMORY_MOMENTS_ENABLED;
  }
  // …and the comparison has teeth: with the flags at their defaults the same struct changes the
  // prompt in all three places.
  const on = textOf(buildSystemPromptSections(...build(full)));
  assert.notEqual(on, bare);
  assert.ok(on.includes(THESIS));
  for (const line of MOMENT_LINES) assert.ok(on.includes(line));

  // Each flag is read at CALL time and gates only its own section.
  process.env.CONVO_HOOKS_ENABLED = 'off';
  try {
    const hooksOff = textOf(buildSystemPromptSections(...build(full)));
    assert.ok(hooksOff.includes(THESIS), 'the thesis is not the hook flag\'s business');
    assert.ok(!hooksOff.includes(QUIET_LAW));
    for (const line of MOMENT_LINES) {
      assert.ok(!hooksOff.includes(line), 'the moments ride INSIDE the hooks section, so they go with it');
    }
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
  }

  // The moments flag is gated at the PUSH SITE like its two siblings, so a caller holding a stale
  // sample — the flag flipped between the read and the build, or any future caller that fills the
  // struct without re-reading it — cannot put moment lines into a MEASURED section on an install
  // that turned them off. The hooks section itself still renders: it is not the moments' business
  // either.
  process.env.MEMORY_MOMENTS_ENABLED = 'off';
  try {
    const momentsOff = textOf(buildSystemPromptSections(...build(full)));
    assert.ok(momentsOff.includes(HOOK_HEADING), 'the hook turn is not the moments flag\'s business');
    assert.ok(momentsOff.includes(THESIS));
    assert.ok(!momentsOff.includes(MOMENTS_LEAD), 'no lead, because there is nothing to lead with');
    for (const line of MOMENT_LINES) assert.ok(!momentsOff.includes(line));
  } finally {
    delete process.env.MEMORY_MOMENTS_ENABLED;
  }
});

// ── the quiet guard ──────────────────────────────────────────────────────────

const SENDER = '+15550001111';

/** One reply as the lane really hands it back under `toolsViaJson`: the calls appear BOTH inside the
 *  envelope text (where the model wrote them) and on `LlmResult.toolCalls` (where callLLM parses them
 *  back to), because every guard in shared.ts reads the parsed field. A tapback is therefore an
 *  envelope with no bubbles AND a send_reaction call — not an empty envelope. */
function envelope(bubbles: string[], hookKind?: string, toolCalls: LlmToolCall[] = []): LlmResult {
  const status: Record<string, unknown> = {
    mood_label: 'content', mood_shift: 'steady', intent_mode: 'sharing_update',
    terminal_closure: false, epistemic_trigger: 'none', meta_prompt: 'let it be quiet',
  };
  if (hookKind) status.hook_kind = hookKind;
  return {
    text: JSON.stringify({
      confidence_level: 85,
      tool_calls: toolCalls.length ? toolCalls.map(t => ({ name: t.name, args: t.input })) : null,
      bubbles: bubbles.map(text => ({ text, re: null })),
      status,
    }),
    toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test',
  };
}

/** The reaction call a tapback turn carries. */
const TAPBACK: LlmToolCall[] = [{ name: 'send_reaction', input: { type: 'like' } }];

function turnCtx(call: (req: LlmRequest) => Promise<LlmResult>): ConvoTurnContext {
  return {
    system: 'SYSTEM PROMPT (persona + this turn)',
    messages: [{ role: 'user', content: 'hmm' }],
    tools: [REACTION_TOOL, DELEGATE_TO_OPS_TOOL],
    call,
  };
}

function guardArgs(res: LlmResult) {
  return { res, chatId: randomUUID(), handle: SENDER, turn: undefined as ConvoTurnContext | undefined };
}

function quietReceipt() {
  return getTraces().find(e => e.type === 'event' && e.label === 'convo:quiet_guard')?.detail as
    Record<string, unknown> | undefined;
}

/** EVERY quiet-guard row this turn filed, not just the first — the one-per-visible-turn rule is a
 *  claim about the count, and `quietReceipt` above cannot see a second one. */
function quietGuardReceipts() {
  return getTraces().filter(e => e.type === 'event' && e.label === 'convo:quiet_guard');
}

const LOUD = ['three sharp things in a row already', 'and here is a fourth one for good measure'];

test('a quiet turn she got RIGHT files the healthy no-op and never calls', async () => {
  let calls = 0;
  const res = envelope(['mm']);
  const out = await enforceQuiet({ ...guardArgs(res), turn: turnCtx(async () => { calls++; return res; }) }, ['mm'], undefined);
  assert.equal(calls, 0);
  assert.equal(out.fired, false);
  assert.equal(out.res, res, 'the reply is untouched');
  // The no-op IS the receipt: a battery has to be able to tell a forced-quiet turn she got right
  // from a forced-quiet turn that never happened.
  assert.deepEqual(quietReceipt(), { forced: true, emitted: null, bubbles: 1, retried: false, resolved: 'clean' });
});

test('a loud reply gets ONE re-ask carrying its own text and the correction, and a quiet retry wins', async () => {
  const seen: LlmRequest[] = [];
  const original = envelope(LOUD, 'judgment');
  const fixed = envelope(['fair enough']);
  const out = await enforceQuiet(
    { ...guardArgs(original), turn: turnCtx(async req => { seen.push(req); return fixed; }) },
    LOUD, 'judgment',
  );
  assert.equal(seen.length, 1, 'exactly one re-ask');
  assert.deepEqual(seen[0].messages.slice(-2), [
    { role: 'assistant', content: original.text },
    { role: 'user', content: QUIET_CORRECTION },
  ]);
  assert.equal(seen[0].trace?.label, 'convo:quiet_retry', 'the CALL and the decision are separate labels');
  assert.equal(out.res, fixed);
  assert.deepEqual(quietReceipt(), { forced: true, emitted: 'judgment', bubbles: 2, retried: true, resolved: 'quiet' });
});

test('the correction states the law she was already given, and asks for a null hook_kind', () => {
  // The re-ask restates rather than introduces: the same sentence her prompt carried this turn.
  assert.ok(QUIET_CORRECTION.startsWith(QUIET_LAW));
  assert.match(QUIET_CORRECTION, /hook_kind/);
  assert.match(QUIET_CORRECTION, /one short bubble|tapback/);
});

test('a retry that is still loud keeps the ORIGINAL — never a dropped turn, never edited text', async () => {
  const original = envelope(LOUD);
  const stillLoud = envelope(['still going', 'and going']);
  const out = await enforceQuiet(
    { ...guardArgs(original), turn: turnCtx(async () => stillLoud) },
    LOUD, undefined,
  );
  assert.equal(out.res, original, 'a bad retry is worse than a long bubble');
  assert.equal(out.fired, true);
  assert.equal(quietReceipt()?.resolved, 'kept_original');
});

test('a tapback retry — a reaction and no words — is a legal quiet reply and is accepted', async () => {
  const original = envelope(LOUD);
  const tapback = envelope([], undefined, TAPBACK);
  const out = await enforceQuiet({ ...guardArgs(original), turn: turnCtx(async () => tapback) }, LOUD, undefined);
  assert.equal(out.res, tapback);
  assert.equal(quietReceipt()?.resolved, 'quiet');
});

test('an EMPTY retry with no tool call keeps the ORIGINAL — a bubble-less reply needs a tapback behind it', async () => {
  // The small-into-large swap this guard exists to refuse. An accepted empty envelope reaches the
  // silent-turn block downstream, spends the silent retry, and lands on the Fallfirm floor: a machine
  // line traded for a reply that was one bubble too long.
  const original = envelope(LOUD);
  const nothing = envelope([]);
  const out = await enforceQuiet({ ...guardArgs(original), turn: turnCtx(async () => nothing) }, LOUD, undefined);
  assert.equal(out.res, original, 'empty bubbles are legal only next to a send_reaction');
  assert.equal(quietReceipt()?.resolved, 'kept_original');
});

test('a thrown re-ask ships the original and is reported as a spent recovery', async () => {
  const original = envelope(LOUD);
  const out = await enforceQuiet(
    { ...guardArgs(original), turn: turnCtx(async () => { throw new Error('lane down'); }) },
    LOUD, undefined,
  );
  assert.equal(out.res, original);
  assert.deepEqual(quietReceipt(), { forced: true, emitted: null, bubbles: 2, retried: true, resolved: 'kept_original' });
});

// ── one re-ask per turn, and the ledger, through the real turn ───────────────

function turnArgs(over: Partial<Parameters<typeof processConvoResult>[0]> = {}) {
  const chatContext: ChatContext = {
    isGroupChat: false, participantNames: [], chatName: null, senderHandle: SENDER,
  };
  return {
    chatId: randomUUID(),
    handle: SENDER,
    chatContext,
    history: [] as StoredMessage[],
    media: emptyMedia(),
    textToSend: 'hmm',
    ...over,
  };
}

function hookArgs(directive: HookDirective, state?: Partial<HookState>) {
  const report: HookSelectReport = {
    reason: directive.mode === 'quiet' ? 'kill_switch' : directive.idle ? 'hook' : 'not_idle',
    idleLayer: directive.idle ? 'fast_path' : 'veto',
    forbidden: directive.forbidden,
    lastKinds: state?.lastKinds ?? [],
  };
  return {
    directive,
    report,
    state: { lastKinds: [], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0, ...state },
    forgetEpoch: 0,
    // The sampler's own answer for the turn (convo/client.ts). False everywhere in this file: what a
    // moment offer does to the ledger is pinned next door, in convo/earnedMaterial.test.ts.
    momentOffered: false,
  };
}

test('the promise guard goes first, and its firing stands the quiet re-ask down', async () => {
  // Honesty outranks rhythm, and a reply asked twice has stopped being hers. The draft below is BOTH
  // failures at once: it promises work with no tool call and nothing running, on a forced-quiet turn.
  const calls: string[] = [];
  await processConvoResult({
    ...turnArgs(),
    res: envelope(['on it', 'checking that now']),
    hooks: hookArgs(QUIET),
    turn: turnCtx(async req => {
      calls.push(String(req.trace?.label));
      return envelope(['nothing running on my end']);
    }),
  });
  assert.deepEqual(calls, ['convo:unkept_retry'], 'ONE extra call on the turn, and it is the honesty one');
  // …and the receipt is filed anyway, saying so. This is the half that keeps the kill switch
  // scorable: the guard files on every forced turn it EVALUATES precisely so a battery can tell a
  // quiet turn she got right from a forced turn that never happened, and a turn where the guard
  // never ran reads as "never happened" from the ring. Without this row, three hooks followed by a
  // promise-breaking draft would look exactly like a switch that had stopped firing.
  assert.deepEqual(quietReceipt(), {
    forced: true, emitted: null, bubbles: 2, retried: false, resolved: 'stood_down',
  });
});

test('a re-ask that comes back an empty envelope plus a schema dump is not a quiet reply', async () => {
  // The dump walks straight through the accept test's one exception: no bubbles is legal ONLY next
  // to a real send_reaction, and one argless entry per offered tool says "there is a call behind it"
  // while carrying nothing at all. Accepted, the schema-echo guard downstream empties the list and
  // the turn reaches the silent-turn floor with no text, no reaction and no call — a machine line
  // traded for a reply that was one bubble too long, which is the exact swap this guard exists to
  // refuse. So the retry is judged on its KEPT calls, and here it reads as the empty envelope it is.
  const dump: LlmToolCall[] = [{ name: 'send_reaction', input: {} }, { name: 'delegate_to_ops', input: {} }];
  const out = await processConvoResult({
    ...turnArgs(),
    res: envelope(LOUD, 'judgment'),
    hooks: hookArgs(QUIET),
    turn: turnCtx(async () => envelope([], undefined, dump)),
  });
  assert.equal(out.text, LOUD.join('\n---\n'), 'the loud reply stands, unedited');
  assert.equal(out.reaction, null, 'the argless send_reaction was never a tapback');
  assert.deepEqual(quietReceipt(), {
    forced: true, emitted: 'judgment', bubbles: 2, retried: true, resolved: 'kept_original',
  });
  assert.deepEqual(
    getTraces().filter(e => e.label === 'convo:silent_turn'), [],
    'and no silent-turn floor engages, because nothing empty was ever adopted',
  );
});

// The row itself, at its own seam. PURE — it returns the receipt rather than filing it, because the
// pass that builds it may be a pass that discards its draft, and a receipt about text nobody reads
// is worse than no receipt at all.
test('the stood-down row reports a turn that was forced and never re-asked', () => {
  assert.deepEqual(quietStoodDownReceipt(['on it', 'checking that now'], undefined), {
    forced: true, emitted: null, bubbles: 2, retried: false, resolved: 'stood_down',
  });
  // A kind she emitted is still reported: the guard did not evaluate the turn, and what she wrote
  // shipped unchecked — which is exactly the case a battery must not read as a clean pass.
  assert.deepEqual(quietStoodDownReceipt(['fair enough'], 'judgment'), {
    forced: true, emitted: 'judgment', bubbles: 1, retried: false, resolved: 'stood_down',
  });
  // A tapback turn: no bubbles at all, and the row still exists, because "forced quiet" and "a row
  // in the ring" have to mean the same thing whichever way the turn went.
  assert.deepEqual(quietStoodDownReceipt([], undefined).bubbles, 0);
});

// ONE re-ask and ONE row per USER-VISIBLE turn — and the pass that owns both is the one that SHIPS.
// The recall second pass re-enters processConvoResult with the archive snippets appended, makes its
// own model call, discards the first pass's draft and returns from there, so fencing the guard off
// `archivePass` takes it off the only reply the user reads: the ring would carry a clean row about a
// draft nobody saw, and the battery would score a PASS off text that never went out.
test('a spent re-ask does not stop the shipping pass being read — it evaluates and cannot call again', async () => {
  const calls: string[] = [];
  const args = {
    ...turnArgs(),
    res: envelope(LOUD, 'tangent'),
    hooks: hookArgs(QUIET),
    turn: turnCtx(async req => { calls.push(String(req.trace?.label)); return envelope(['mm']); }),
  };
  await processConvoResult(args);
  assert.deepEqual(calls, ['convo:quiet_retry'], 'a first pass with nothing spent yet gets the one call');
  assert.equal(quietGuardReceipts().length, 1);
  assert.equal(quietReceipt()?.resolved, 'quiet');

  // The same loud draft on a pass that inherits a spent re-ask: read, reported, never re-asked. The
  // resolution is the guard's own worst case, honestly — that text is what would ship.
  clearTraces();
  calls.length = 0;
  await processConvoResult({ ...args, archivePass: true, quietSpent: true });
  assert.deepEqual(calls, [], 'the turn\'s one corrective call is gone');
  assert.equal(quietGuardReceipts().length, 1, 'still one row for one thing the user sees once');
  assert.deepEqual(quietReceipt(), {
    forced: true, emitted: 'tangent', bubbles: 2, retried: false, resolved: 'kept_original',
  });
});

// The other half of the same rule: a pass that RECURSES leaves no row behind, so the turn's one row
// is the shipping pass's. Driven through the real recall path — the first pass calls recall_memory,
// the second answers from the archive — because that is the only way the recursion happens for real.
test('a forced-quiet turn that recalls files exactly one row, and it reads the reply that ships', async () => {
  const calls: string[] = [];
  let n = 0;
  const args = {
    ...turnArgs(),
    // A CLEAN first draft that asks the archive: the row it would have filed says 'clean', and the
    // reply the user actually gets is the loud one below. The old fence filed the first and shipped
    // the second unchecked.
    res: envelope(['mm'], undefined, [{ name: 'recall_memory', input: { query: 'the cedars' } }]),
    hooks: hookArgs(QUIET),
    turn: turnCtx(async req => {
      calls.push(String(req.trace?.label));
      n += 1;
      return n === 1 ? envelope(LOUD, 'tangent') : envelope(['mm']);
    }),
  };
  await processConvoResult(args);
  assert.deepEqual(calls, ['convo:archive_recall', 'convo:quiet_retry'],
    'the second pass made the reply, and the guard on it spent the turn\'s one call');
  const rows = quietGuardReceipts();
  assert.equal(rows.length, 1, 'one row for one user-visible turn');
  assert.deepEqual(quietReceipt(), {
    forced: true, emitted: 'tangent', bubbles: 2, retried: true, resolved: 'quiet',
  }, 'and it reads the SECOND pass\'s draft — the first pass\'s clean row went with its discarded text');
});

test('a forced-quiet turn with no promise in it does reach the quiet guard', async () => {
  await processConvoResult({
    ...turnArgs(),
    res: envelope(LOUD, 'tangent'),
    hooks: hookArgs(QUIET),
    turn: turnCtx(async () => envelope(['mm'])),
  });
  assert.equal(quietReceipt()?.resolved, 'quiet');
});

test('a task turn that hooked anyway is counted and receipted, and is NOT re-asked', async () => {
  const calls: string[] = [];
  await processConvoResult({
    ...turnArgs(),
    res: envelope(['six to eight weeks, same as last time'], 'judgment'),
    hooks: hookArgs(TASK),
    turn: turnCtx(async req => { calls.push(String(req.trace?.label)); return envelope(['x']); }),
  });
  assert.deepEqual(calls, [], 'a second call over one envelope field is not worth a turn\'s recovery');
  assert.equal(quietReceipt(), undefined);
  const off = getTraces().find(e => e.label === 'hook:off_turn')?.detail;
  assert.deepEqual(off, { emitted: 'judgment', idle: false, mode: 'task' });
});

test('a HOOK turn that ASKED is off-turn too — the one ban an idle turn carries', async () => {
  // The second shape of the same receipt, in the form f7afa57 left it: the question is no longer
  // banned on an idle turn by the shape itself, so the ban that makes this a slip comes from the
  // DIRECTIVE's `forbidden` list — the affect ceiling is closed, or the group closes the room
  // (shared.ts). An open ceiling with an empty `forbidden` is a valid question and correctly gets no
  // row; that boundary is the next test.
  //
  // The cost of the slip outlives the beat either way: the ledger tail is now `question`, which is
  // what hands the NEXT short message a share turn it did not earn (persona/idle.ts
  // `followUpOutstanding`). So the row has to exist, and it has to say which mode had no room for the
  // move — a reader who only saw `emitted: 'question'` would go looking for the task answer that
  // never happened.
  const calls: string[] = [];
  const args = turnArgs();
  await processConvoResult({
    ...args,
    res: envelope(['what did they end up saying'], 'question'),
    hooks: hookArgs({ ...HOOK, forbidden: ['question'] }),
    turn: turnCtx(async req => { calls.push(String(req.trace?.label)); return envelope(['x']); }),
  });
  assert.deepEqual(calls, [], 'the same bargain as the task case: counted, never re-asked');
  assert.equal(quietReceipt(), undefined, 'nothing forced this turn quiet');
  const off = getTraces().find(e => e.label === 'hook:off_turn')?.detail;
  assert.deepEqual(off, { emitted: 'question', idle: true, mode: 'hook' });
  assert.deepEqual((await getHookState(args.chatId)).lastKinds, ['question'],
    'and the ledger records what shipped, the way it does for a violation');
});

test('the three CARRYING kinds on a hook turn are not off-turn, and a question on a SHARE turn is its move', async () => {
  // The boundary, from both sides. An idle turn is what the other three kinds are FOR, so a row
  // there would fire on the engine working. And on a share turn every kind including the question is
  // shape-legal: what closes the question there is the affect ceiling or the no-two-running rule,
  // both inside the shape, and a slip against those is read off the trace and the ledger rather than
  // filed as a turn that carried the wrong sort of move.
  for (const kind of ['judgment', 'callback', 'tangent'] as const) {
    clearTraces();
    await processConvoResult({ ...turnArgs(), res: envelope(['mm'], kind), hooks: hookArgs(HOOK) });
    assert.equal(getTraces().find(e => e.label === 'hook:off_turn'), undefined, `${kind} is what an idle turn is for`);
  }
  for (const kind of ['judgment', 'callback', 'tangent', 'question'] as const) {
    clearTraces();
    await processConvoResult({ ...turnArgs(), res: envelope(['mm'], kind), hooks: hookArgs(SHARE) });
    assert.equal(getTraces().find(e => e.label === 'hook:off_turn'), undefined, `${kind} is open to a share turn`);
  }
});

test('the ledger records what shipped — a violation counts as its emitted kind', async () => {
  const args = turnArgs();
  await processConvoResult({
    ...args,
    res: envelope(['a whole paragraph of a reply that is very much not one short bubble at all'], 'judgment'),
    hooks: hookArgs(QUIET),
    // No turn context, so the one recovery cannot be spent and the loud reply really ships.
  });
  const state = await getHookState(args.chatId);
  assert.deepEqual(state.lastKinds, ['judgment'], 'the run really did get another sharp beat');
  assert.equal(state.idleStreak, 1);
});

test('a task turn ends the idle streak; the ledger row is written either way', async () => {
  const args = turnArgs();
  await processConvoResult({
    ...args,
    res: envelope(['six to eight weeks']),
    hooks: hookArgs(TASK, { idleStreak: 4, lastKinds: ['callback'] }),
  });
  const state = await getHookState(args.chatId);
  assert.deepEqual(state.lastKinds, ['callback', 'none']);
  assert.equal(state.idleStreak, 0, 'one real ask is them sending something');
});

test('a ROOM accumulates a ledger too — three hooked replies make the fourth turn quiet', async () => {
  // The one write in processConvoResult that is deliberately OUTSIDE the non-group guard. Every
  // other per-person write down there is fenced off a room because it records a property of a
  // PERSON; this one records how fast SHE has been talking, and three sharp replies in a room are
  // three sharp replies whoever typed at her.
  const chatId = randomUUID();
  const handle = groupHandle(chatId);
  const chatContext: ChatContext = {
    isGroupChat: true, participantNames: ['Sam', 'Ada'], chatName: 'nursery crew', senderHandle: SENDER,
  };
  for (const kind of ['judgment', 'callback', 'tangent'] as const) {
    const state = await getHookState(chatId);
    await processConvoResult({
      ...turnArgs({ chatId, handle, chatContext }),
      res: envelope(['mm'], kind),
      hooks: { ...hookArgs(HOOK), state },
    });
  }
  const state = await getHookState(chatId);
  assert.deepEqual(state.lastKinds, ['judgment', 'callback', 'tangent']);
  assert.equal(state.idleStreak, 3);
});

test('with the flag off nothing is written and no receipt is filed', async () => {
  process.env.CONVO_HOOKS_ENABLED = 'off';
  try {
    const args = turnArgs();
    // The caller passes no directive at all when the flag is off (convo/client.ts), which is what is
    // reproduced here: nothing to record against, so nothing is recorded.
    await processConvoResult({ ...args, res: envelope(['mm'], 'judgment'), hooks: null });
    assert.deepEqual(await getHookState(args.chatId), { lastKinds: [], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0 });
    assert.equal(quietReceipt(), undefined);
    assert.equal(getTraces().find(e => e.label === 'hook:off_turn'), undefined);
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
  }
});

// ── the client seam: the pre-read on a REAL turn ─────────────────────────────
// Everything above drives the assembler and processConvoResult directly, which cannot see the block
// that decides what to hand them. These cases go through the front door (convo/client.ts `chat`)
// with the model faked at the lane seam and nothing else stubbed — the forgetEngine/routingGate
// pattern — so the idle facts, the flag gate, the thread veto, the craft fact and the three
// turn-focus fields are all the turn's own.

/** A capturing fake lane: every request the client made, and one fixed reply for each. */
function fakeLane(res: LlmResult): { seen: LlmRequest[]; call: (req: LlmRequest) => Promise<LlmResult> } {
  const seen: LlmRequest[] = [];
  return { seen, call: async (req: LlmRequest) => { seen.push(req); return res; } };
}

/** The prompt text the lane was handed: the system message, then the per-turn tail, which rides as
 *  its own user message right before theirs (convo/client.ts). */
function promptSeen(req: LlmRequest): string {
  const tail = req.messages[req.messages.length - 2];
  return `${req.system ?? ''}\n\n${typeof tail?.content === 'string' ? tail.content : ''}`;
}

const clientCtx = (over: Partial<ChatContext> = {}): ChatContext => ({
  isGroupChat: false, participantNames: [], chatName: null, senderHandle: SENDER, ...over,
});

const receipt = (label: string) =>
  getTraces().find(e => e.type === 'event' && e.label === label)?.detail as Record<string, unknown> | undefined;

/** EVERY row under a label, because two of the claims down here are claims about the COUNT: one
 *  reading of the turn files one `idle:classify` row whether the prefetch answered it or the gate
 *  did, and a second row is the prefetch warming a cache instead of handing over its promise. */
const receipts = (label: string) => getTraces().filter(e => e.type === 'event' && e.label === label);

/** The ledger tail that makes her last move a FOLLOW-UP question — the one question of hers that is
 *  owed nothing but a turn. Seeded before the turn so the real read picks it up, exactly the way the
 *  climate is seeded above: this is the fact `persona/idle.ts` reads to tell a bid from an answer,
 *  and a test that handed it in directly would be testing the gate rather than the wiring. */
const seedFollowUp = (chatId: string) =>
  saveHookState(chatId, SENDER, { lastKinds: ['question'], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0 });

test('an IDLE message through the front door renders the hooks block, the Turn line, and leaves a ledger row', async () => {
  const chatId = randomUUID();
  // A relationship that has actually MOVED, stored before the turn so the real read picks it up
  // (db/repositories/relationshipClimate.ts, handle-keyed like the memory tiers). Without it this
  // turn renders no climate span at all, and the span is the other place this turn is described: it
  // rides every Convo turn whatever the mode, so it and the hooks section have to agree about what
  // is open. Every dial here is past its silent band — candor below its floor, which is also the
  // thing that closes one kind on this turn — so the hook-naming band lines are live rather than
  // silently absent.
  await saveRelationshipClimate(SENDER, {
    ...defaultClimate(), dials: { ease: 70, candor: 30, playfulness: 60 }, evalCount: 30,
  });
  const { seen, call } = fakeLane(envelope(['hey you']));
  await chat(chatId, 'hey', emptyMedia(), clientCtx(), call);

  assert.equal(seen.length, 1, 'one front-line call');
  const system = promptSeen(seen[0]);
  assert.ok(system.includes(HOOK_HEADING), 'the hooks section reached the prompt');
  // All three turn-focus fields at once, as one rendered line: the reading, the raw TYPED length, and
  // the stored streak plus this turn (the ledger row is written after the reply, so what is in hand
  // at prompt time is how many idle turns came BEFORE this one — zero, here).
  assert.ok(system.includes('Turn: idle · their message: 3 characters · 1st idle in a row'),
    `no Turn line in: ${system.slice(system.indexOf('Turn: '), system.indexOf('Turn: ') + 80)}`);

  const select = receipt('hooks:select');
  assert.equal(select?.idleLayer, 'fast_path', 'a known English stall costs no call at all');
  assert.equal(receipt('idle:classify'), undefined, '…so layer 3 was never reached');

  // THE 2AM CASE, end to end, and the reason it lands here rather than needing a fixture of its
  // own: this file's frozen clock is 02:00 UTC, which `computeCircadian` reads as `dead_night` and
  // `compileAffect` turns into `lateNight` — so every turn the front door produces on this clock is
  // a late one. (`convo/earnedMaterial.test.ts` runs the same front door on an afternoon clock.)
  //
  // The hour is a REGISTER and nothing more. It used to close every kind, shut the sampler and the
  // thread offer and take a `sleep` bucket of its own, which left one sentence — go to bed — as the
  // only content a late idle turn could carry, restated in seven prompt surfaces. Now the turn is an
  // ordinary idle turn: the kinds are open, the anchor states the HOOK law, and the one thing the
  // clock adds is the register line saying the reply is small.
  assert.equal(select?.reason, 'hook', 'the clock is not a reason for anything');
  // The one kind closed here is the CLIMATE's doing, not the hour's: this chat's candor sits below
  // its floor band, which is what `compileAffect` reads as `no_judgment`. The question used to sit
  // beside it, closed by the SHAPE with no condition attached; f7afa57 removed that unconditional
  // ban, so an idle turn now forbids the question only when the ceiling or the room does — neither of
  // which is doing anything here.
  assert.deepEqual(select?.forbidden, ['judgment'], 'the clock closes nothing of its own');
  assert.ok(system.includes(HOOK_LATE_LINE), 'the register line rode along');
  assert.ok(system.includes('Open to you this turn: a callback, a tangent or a question.'),
    'under an open line naming the kinds the register left');
  assert.ok(!system.includes(HOOK_NONE_OPEN));
  // The anchor's law at the recency edge is the HOOK one, and it agrees with the section.
  assert.ok(system.includes('- This is an idle turn: one hook, of a kind the hooks section above still allows, and only one.'),
    'the drift anchor states the hook law');
  assert.ok(!system.includes('- Your weather closed the beat, or you have been sharp three times running with nothing left to hand them: this reply is one plain short bubble, a tapback, or nothing.'),
    '…and not the quiet law, which is not this turn');
  // NOTHING in the assembled prompt tells her to send them to bed — the complaint that produced
  // this design was that one line arriving every night, from seven places at once.
  assert.ok(!system.includes('should sleep'), 'no prompt surface tells her what to send at this hour');
  assert.equal(quietReceipt(), undefined, 'the clock forces nothing');

  // …and the standing register, which is why this chat carries a moved climate: it renders on every
  // Convo turn whatever the mode, and four of its twelve band lines name a hook kind
  // (persona/climate.ts HOOK_NAMING). They are gated on whether a KIND IS OPEN (`hookKindOpen`),
  // never on the mode — and a late turn HAS kinds open, so they ride it here, saying the same thing
  // the section's open line says. That agreement is the pin: the register and the section are two
  // readings of one directive.
  const weather = system.slice(system.indexOf('standing register'), system.indexOf('Re-report your `status`'));
  assert.ok(weather.length > 0 && weather.includes('- No runway at all with this person.'),
    'the climate span really rendered on this turn');
  assert.ok(weather.includes('- Directness has been landing badly. No judgment this turn.'),
    'the band line that closed judgment says so, on a turn that has a beat to spend');
  assert.ok(weather.includes('- A tangent, a callback, or a bend is expected of you here. Reach further.'),
    '…and the register names exactly the kinds the section left open');

  // The SAME reading also gates the hook craft page (convo/personaModules.ts `idle_turn`), which is
  // the other thing the pre-read hands the assembler. Read as the page off disk rather than as a
  // literal, so the assertion survives the prose commit that replaces today's placeholder.
  assert.ok(system.includes(craftModuleText('hooks')), 'the craft page loaded off the same reading');

  // A row exists: the defaults a missing row degrades to are an empty window and a zero streak.
  const state = await getHookState(chatId);
  assert.deepEqual(state.lastKinds, ['none'], 'she carried no hook, which is still a ledger entry');
  assert.equal(state.idleStreak, 1);
});

test('a TASK message closes the thread offer, renders no hooks block, and still counts a stray hook', async () => {
  const chatId = randomUUID();
  const { seen, call } = fakeLane(envelope(['six to eight weeks, same as last time'], 'judgment'));
  await chat(chatId, 'deploy the cedars order', emptyMedia(), clientCtx(), call);

  const system = promptSeen(seen[0]);
  assert.ok(!system.includes(HOOK_HEADING), 'work gets the answer, flat');
  assert.ok(system.includes('Turn: task'));

  // Layer 3 was reached and, with no lane configured, failed toward task — the whole point of the
  // asymmetry (persona/idle.ts). The receipt is what says the fallback ran at all.
  const classified = receipt('idle:classify');
  assert.equal(classified?.verdict, 'failed');
  assert.equal(classified?.cached, false);
  // ONE row, and this is the prefetch's own pin. The call was started in parallel with the memory
  // read (convo/client.ts) and the gate consumed the PENDING PROMISE rather than a warmed cache — a
  // prefetch that warmed the cache instead would file a second row here, cached or not, and the live
  // round reads two rows on one turn as exactly that failure.
  assert.equal(receipts('idle:classify').length, 1, 'one reading, one receipt, prefetched or not');
  assert.equal(receipt('hooks:select')?.reason, 'not_idle');

  // The rhythm engine's one veto over the thread engine: selection never ran, so nothing was billed.
  const threads = receipt('threads:select');
  assert.equal(threads?.reason, 'offer_suppressed');

  // …and the envelope field she should not have sent on a work turn is counted, not re-asked.
  assert.deepEqual(receipt('hook:off_turn'), { emitted: 'judgment', idle: false, mode: 'task' });
  assert.deepEqual((await getHookState(chatId)).lastKinds, ['judgment']);
});

test('with the hook flag OFF the whole pre-read is inert — no section, no line, no call, no receipt', async () => {
  process.env.CONVO_HOOKS_ENABLED = 'off';
  const chatId = randomUUID();
  try {
    // 'hey' is the message that DID render a hooks block one case up, so both absences below are
    // absences the flag caused rather than absences of an idle turn.
    const { seen, call } = fakeLane(envelope(['hey you']));
    await chat(chatId, 'hey', emptyMedia(), clientCtx(), call);
    const system = promptSeen(seen[0]);
    assert.ok(!system.includes(HOOK_HEADING));
    assert.ok(!system.includes('Turn: idle') && !system.includes('Turn: task'),
      'absent is a third state: no claim about the turn is made at all');
    assert.equal(receipt('hooks:select'), undefined);
    assert.deepEqual(await getHookState(chatId), { lastKinds: [], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0 });

    // …and a work message, which is the shape that reaches layer 3 and closes the thread offer when
    // the engine is live: no lane is spent on it, and the thread engine offers exactly as it did
    // before any of this existed.
    const work = fakeLane(envelope(['six to eight weeks, same as last time']));
    await chat(randomUUID(), 'deploy the cedars order', emptyMedia(), clientCtx(), work.call);
    assert.equal(receipt('idle:classify'), undefined, 'no gate runs, so no classify call is made');
    assert.notEqual(receipt('threads:select')?.reason, 'offer_suppressed');
  } finally {
    delete process.env.CONVO_HOOKS_ENABLED;
  }
});

test('the gate reads what they TYPED, not the annotated message the machinery built', async () => {
  // The one deliberate deviation from the brief, pinned. The tapped-reply tag is app metadata folded
  // into `textToSend` so it persists in history, and it is long enough on its own to blow the
  // forty-character veto — which would make an idle turn impossible to have by tapping reply on
  // anything. The quoted text below also carries a question mark, so a gate reading the annotated
  // string would veto this turn twice over. (The attachment note, the other annotation, needs no
  // pin: a file that really arrived is already a structural veto in its own right.)
  const chatId = randomUUID();
  const { seen, call } = fakeLane(envelope(['sleep on it']));
  await chat(chatId, 'hmm', emptyMedia(), clientCtx({
    repliedToText: 'six to eight weeks from the north supplier, unless you want the southern yard too?',
  }), call);

  const last = seen[0].messages[seen[0].messages.length - 1];
  assert.ok(String(last.content).startsWith('[replying to your earlier text:'),
    'the annotation really did ride along on the message');
  // …and it rides as their message, last and stamped, with this turn's tail as its own untimed user
  // message right ahead of it (convo/client.ts) — the stamp labels what they sent, never the tail.
  const tail = seen[0].messages[seen[0].messages.length - 2];
  assert.equal(tail.role, 'user');
  assert.equal(tail.timestamp, undefined, 'the tail carries no arrival stamp');
  assert.ok(String(tail.content).startsWith('<prompt>\n') && String(tail.content).includes('## Last thing before you type'));
  assert.ok(last.timestamp, 'their message keeps its own');
  assert.ok(!(seen[0].system ?? '').includes(HOOK_HEADING), 'the hook section is not in the system message');
  assert.ok(promptSeen(seen[0]).includes(HOOK_HEADING), 'and the turn is still idle');
  assert.equal(receipt('hooks:select')?.idleLayer, 'fast_path', 'decided on the typed word alone');
});

// ── the third shape, through the same front door ─────────────────────────────
// The turn every piece of this build exists for, assembled by the real client: the gate reads a
// share, the selector takes the bid branch, the section and the anchor state the share law, the
// craft page loads, the `Turn:` line says so, and the ledger records a turn on which they SPOKE.
//
// It is reached through the FOLLOW-UP relaxation rather than through the classifier, and that is
// deliberate twice over. This file has no lane, so a layer-3 share is unreachable here by
// construction — and the answer-to-her-question turn is the share shape with the most machinery
// behind it: her last move was the one question of hers that asks for nothing to be done, so their
// next message is more of their own story and not the answer to a piece of work.

test('a SHARE turn through the front door renders the share block, the anchor law, the craft page and the Turn line', async () => {
  process.env.CONVO_SHARE_TURNS_ENABLED = 'on';
  const chatId = randomUUID();
  await seedFollowUp(chatId);
  const { seen, call } = fakeLane(envelope(['the northern yard never says anything on a friday']));
  await chat(chatId, 'hmm', emptyMedia(), clientCtx(), call);

  const system = promptSeen(seen[0]);
  assert.ok(system.includes(SHARE_HEADING) && system.includes(SHARE_LEAD), 'the share section reached the prompt');
  assert.ok(!system.includes(HOOK_HEADING), 'and not the hook section, which is the other shape');
  // The line at the recency edge, with the character count and NO streak clause: the count of turns
  // in a row they sent nothing ended on this turn, so printing it here would be a checkable fact
  // that is false (convo/turnFocus.ts).
  assert.ok(system.includes('Turn: share · their message: 3 characters\n'), 'the reading, in full');
  assert.ok(!system.includes('idle in a row'), 'a share turn ends the streak, so it carries none');

  const select = receipt('hooks:select');
  assert.equal(select?.reason, 'share', 'its own bucket, tellable from an idle turn that left the same kinds open');
  assert.equal(select?.mode, 'share');
  assert.equal(select?.idle, false, 'they said something');
  // The gate's own two fields, which the mode cannot be read backwards into: the reading, and why a
  // short-looking message went where it went. 'hmm' is three characters of pure example text, so no
  // signal fired at all — the ledger's follow-up is the whole reason this is a share.
  assert.equal(select?.shape, 'share');
  assert.deepEqual(select?.signals, []);
  assert.equal(select?.idleLayer, 'fast_path');
  assert.equal(receipt('idle:classify'), undefined, 'the follow-up relaxation costs no call at all');

  // THE DOSE, end to end. One move, never two — and the kind list is what enforces it. The ledger
  // tail no longer closes the question here: f7afa57 removed the share branch's back-to-back ban, so
  // two questions in a row are permitted and the repeat rule fires only once TWO of a kind already
  // sit at the tail (persona/hooks.ts `repeatedTailKind`). What closes a kind on this turn is the
  // climate's `no_judgment` band, the same one the idle case above reads.
  assert.deepEqual(select?.forbidden, ['judgment'], 'the climate closes the judgment, not the ledger');
  assert.ok(system.includes('Open to you this turn: a callback, a tangent or a question. One of them, never two, and it is the reply, not a beat after one.'));
  // …and because the question IS open on this turn, the line that says what a follow-up is renders
  // (persona/hooks.ts: it is pushed only when `allowed` includes the question). It used to be absent
  // here, back when the ledger tail banned the kind — the line is the open case's, never a ban's.
  assert.ok(system.includes(SHARE_QUESTION_LINE), 'the follow-up line rides an open question');
  // The hour is a register here exactly as it is on an idle turn (this file's clock is 02:00 UTC).
  assert.ok(system.includes(SHARE_LATE_LINE), 'the same volume rule, in the share block\'s own words');

  // The law at the recency edge, and the page behind it — both off the SAME reading, which is the
  // whole point of deriving the two craft facts once in the client.
  assert.ok(system.includes('- This is a share turn: they handed you something and asked for nothing. The reply is about that thing, one move, shaped by what the share section above leaves open. Never a receipt, never nothing.'),
    'the drift anchor states the share law');
  assert.ok(system.includes(craftModuleText('share')), 'the share craft page loaded off the same reading');
  assert.ok(!system.includes(craftModuleText('hooks')), '…and the hook page did not, because this is not that turn');

  // The ledger: the move she carried (none, here) appended, and the streak ENDED — the count is how
  // many turns in a row they sent nothing, and this was not one of them.
  const state = await getHookState(chatId);
  assert.deepEqual(state.lastKinds, ['question', 'none']);
  assert.equal(state.idleStreak, 0, 'a share ends the streak exactly as a task turn does');
});

test('with the share flag OFF the same turn is byte-identical to one whose ledger never held a question', async () => {
  // The flag's whole contract, at the seam that consumes it: with CONVO_SHARE_TURNS_ENABLED off, the
  // ledger fact the share shape reads changes NOTHING. The same message, the same handle and the
  // same empty world, differing only in a tail of `question` — and the two prompts have to come out
  // the same string, because with the switch off the follow-up relaxation does not exist and 'hmm'
  // is the idle turn it always was.
  //
  // Set here in the word an operator would type, not left to the default: the default flipped on
  // the commit that finished the shape, and this test is the one that has to keep measuring the OFF
  // path after it — a way back nobody exercises is a way back nobody has.
  process.env.CONVO_SHARE_TURNS_ENABLED = 'off';
  const seeded = randomUUID();
  await seedFollowUp(seeded);
  const first = fakeLane(envelope(['mm']));
  await chat(seeded, 'hmm', emptyMedia(), clientCtx(), first.call);
  const withTail = promptSeen(first.seen[0]);

  // A pristine world for the control, so the only thing that differs between the two turns is the
  // ledger row one of them was seeded with.
  resetStorageForTests();
  clearTraces();
  const plain = randomUUID();
  const second = fakeLane(envelope(['mm']));
  await chat(plain, 'hmm', emptyMedia(), clientCtx(), second.call);

  assert.equal(withTail, promptSeen(second.seen[0]), 'not one byte of the prompt knows about the tail');
  assert.ok(withTail.includes(HOOK_HEADING) && withTail.includes('Turn: idle'), 'both are the idle turn they were before');
  assert.ok(!withTail.includes(SHARE_HEADING) && !withTail.includes('Turn: share'));
  assert.ok(!withTail.includes(craftModuleText('share')), 'and the share page is not on this build');
});
