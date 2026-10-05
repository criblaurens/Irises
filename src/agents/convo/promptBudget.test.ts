// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The ratchet. Convo's system prompt assembles to ~136k characters — ~84k of it the persona — and
// it had only ever grown, one well-argued block at a time. This file measures the prompt through
// the real assembler (buildSystemPromptSections, the Task-1 seam) on eight representative turns and
// holds every part under the ceiling it stands at TODAY (promptPolicy.ts) — so the next block that
// quietly doubles fails here instead of quietly costing the live thread its share of the context.
//
// It shrinks NOTHING itself. Every number in PROMPT_BUDGET was measured on these exact fixtures, and
// the test makes two claims about them, one in each direction: nothing is bigger than its ceiling,
// and no ceiling sits more than 2% above what these fixtures measure. The second claim is what stops
// a phase that deletes prose from leaving its old ceiling behind as slack for the next arrival — the
// phases tighten the numbers, not the test.
//
// Two things every fixture must do, both learned from Task 1:
//   • pass `agentTz: 'UTC'` (argsFor does it for all of them, so it cannot be forgotten) — the
//     conversation-timing and current-time sections render wall-clock text, so a fixture that
//     inherited the host zone would measure a different string outside npm test's TZ=UTC;
//   • run under the frozen clock installed below, for the same reason ("9:59" and "10:00" are not
//     the same length).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPromptSections, formatHistory, type ChatContext } from './shared.js';
import { SECTION_IDS, sectionsChars, type SectionId } from './promptSections.js';
import { PROMPT_BUDGET, MIN_TRANSCRIPT_SHARE, type BudgetKey } from './promptPolicy.js';
import { renderDriftAnchor, DRIFT_LONG_WINDOW_CHARS, type DriftMode } from '../../persona/policy.js';
import { buildTurnTraceDraft, type MeasuredPrompt, type TranscriptMessage } from '../../diagnostics/turnTrace.js';
import {
  REACTION_TOOL, REMEMBER_USER_TOOL, delegateToOpsTool, SET_PREFERENCE_TOOL, SCHEDULE_AUTOMATION_TOOL, UNSEND_TOOL,
  LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL, UPDATE_AUTOMATION_TOOL, CANCEL_RESEARCH_TOOL,
  STEER_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL,
  UPDATE_MEMORY_TOOL, RECALL_MEMORY_TOOL, RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL,
} from './tools.js';
import { INTRO_WEAVE_BLOCK } from '../ops/firstMove.js';
import { renderSelfSection, MAX_SELF_ENTRIES, SELF_TEXT_MAX } from '../../memory/selfHarvest.js';
import { renderOwedSection, OWED_MAX } from '../../memory/owedAsks.js';
import { TURNED_DOWN_ASK_CHARS } from '../../persona/status.js';
import {
  renderUserMemoryWithHot, sanitizeLongDoc, splitSections, profileIsThin,
  type MemoryAudience, type UserMemoryData,
} from '../../memory/wrappers.js';
import { renderPendingClarification, renderPendingApproval } from '../../memory/dossier.js';
import { buildTurnRelevance } from '../../memory/relevance.js';
import { sanitizeDirectives } from '../../memory/preferences.js';
import { coerceStatus, mergeStatus, type AffectState, type ComputedState } from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import { defaultClimate, type RelationshipClimate } from '../../persona/climate.js';
import {
  renderMomentLines, MOMENT_AGE_WORDS, MOMENT_TEXT_MAX, type MomentEntry,
} from '../../persona/moments.js';
import type { HookDirective, TurnKind } from '../../persona/hooks.js';
import type { ThreadCandidate } from '../../persona/threads.js';
import type { ThreadTurn } from '../../memory/threadHarvest.js';
import type { TurnFocusInput } from './turnFocus.js';
import type { CraftTurnFacts } from './personaModules.js';
import type { PersonaTurn, LiveState } from './shared.js';
import type { ActiveOps } from '../../state/opsCoordination.js';
import type { CapabilitySummary, ReminderRef } from '../ops/engineBackend.js';
import type { MediumBundle } from '../../memory/mediumTerm.js';
import type { ShortTermEntry } from '../../db/repositories/memoryShort.js';
import type { AgentMemory } from '../../db/repositories/memory.js';
import type { LlmToolDef } from '../../llm/types.js';
import type { StoredMessage, UserProfile } from '../../db/types.js';

// ── a frozen clock ───────────────────────────────────────────────────────────
// Same pin as promptSections.test.ts, and for the same reason: the assembler reads the wall clock
// (`new Date()` for the clock + timing sections, `Date.now()` for the active-ops elapsed labels), so
// a measured size is only reproducible against a stored ceiling with the clock held still. Pinned by
// hand rather than with node:test's MockTimers, which prints an ExperimentalWarning.
const FROZEN_MS = Date.UTC(2026, 0, 6, 2, 0, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

const MINUTE = 60_000;
const HANDLE = '+15550001111';

// ── the turn, as a named thing ───────────────────────────────────────────────

/** Everything a fixture varies. Deliberately NOT the 15-argument tuple: a positional list of that
 *  length is where a fixture silently measures the wrong section. */
interface TurnSpec {
  chatContext?: ChatContext;
  contextBlock?: string;
  activeOps?: ActiveOps[];
  extraSection?: string;
  tools?: LlmToolDef[];
  history?: StoredMessage[];
  incomingText?: string;
  affect?: AffectState;
  computed?: ComputedState;
  capability?: CapabilitySummary | null;
  climate?: RelationshipClimate;
  thread?: ThreadTurn;
  introWeave?: string | null;
  turnFocus?: TurnFocusInput;
  /** The three craft-module gate facts the assembler can't see (convo/personaModules.ts). Never
   *  hand-written: every fixture builds them with `craftFacts` below, off the same data its memory
   *  stack is rendered from, so the `craft_modules` ceiling is measured on the pages a live turn of
   *  this shape would really load. */
  craft?: CraftTurnFacts;
  /** What the per-turn persona engines decided for this turn (convo/shared.ts PersonaTurn): the hook
   *  directive, the sampled moments, the thesis. Two fixtures carry one — the cold 'hey' turn, which
   *  is where the `hooks` section and the hook craft page are measured, and the thread-offer turn,
   *  which measures those plus `thesis` (an offer is only ever made in hook mode, so the two travel
   *  together). Absent elsewhere, which reads as a task turn with nothing earned — the mode the drift
   *  anchor falls back to, and the shape the no-regression pin is written against. */
  personaTurn?: PersonaTurn;
  /** What stands live for this chat beyond `activeOps` (convo/shared.ts LiveState): the reminders on
   *  the engine, each with its id. One fixture carries one — the media turn, which already carries
   *  research in flight, so this is the turn where a reply may need to name both a run and a
   *  reminder by id in the same breath. Absent elsewhere, which renders no `live_reminders` section
   *  at all, the same as every caller that never reads the engine's list. */
  liveState?: LiveState;
}

type BuildArgs = Parameters<typeof buildSystemPromptSections>;

/** The spec as the assembler's argument tuple. `agentTz` is hard-wired to UTC here so no fixture can
 *  forget it (see the file header). */
function argsFor(s: TurnSpec): BuildArgs {
  return [
    s.chatContext, s.contextBlock ?? '', s.activeOps ?? [], s.extraSection, s.tools, s.history,
    s.incomingText, 'UTC', s.affect, s.computed, s.capability ?? null, s.climate, s.thread,
    s.introWeave, s.turnFocus, s.craft, s.personaTurn, s.liveState,
  ];
}

// ── the real tool list ───────────────────────────────────────────────────────
// Exactly the list convo/tools.ts convoToolList assembles on the hermes lane (the richer of the
// two: the four reminder tools are gated out on openclaw), so the tool_docs ceiling is a production
// size and not a one-tool sketch. UPDATE_AUTOMATION_TOOL sits right after CANCEL_AUTOMATION_TOOL,
// the same place convoToolList puts it — the two read as the pair they are: remove one, or change it
// in place. The two group tools are appended for the group fixture, as the client does.

const TOOLS_1TO1: LlmToolDef[] = [
  REACTION_TOOL, REMEMBER_USER_TOOL, delegateToOpsTool('hermes'), SET_PREFERENCE_TOOL,
  SCHEDULE_AUTOMATION_TOOL, LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL, UPDATE_AUTOMATION_TOOL,
  CANCEL_RESEARCH_TOOL, STEER_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL, UPDATE_MEMORY_TOOL,
  RECALL_MEMORY_TOOL,
];
const TOOLS_GROUP: LlmToolDef[] = [...TOOLS_1TO1, RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL];
// The media fixture also carries the unsend tool and its section at the widest list the code can
// build: six bubbles (state/unsend.ts REACH_CAP), each past the 160-character clip.
const WIDEST_UNSEND: string[] = Array.from({ length: 6 }, (_, i) => `${i + 1} `.padEnd(400, 'w'));

// ── memory stacks, rendered by the real renderer ─────────────────────────────
// The memory stack is the wrapped tier block (preamble → short → medium → discovery → flexible) that
// buildContextBlock puts LAST inside the context block, and it is the fastest-growing part of the
// prompt — hence its own budget line. Rendered here through the same pure function dossier.ts calls
// so `memory_stack` is a measured production string, and spliced into the context block exactly the
// way buildContextBlockWithHot splices it: plain Convo sections first, joined with a blank line.
//
// WITH this turn's relevance router, because a live turn has one: CONVO_MEMORY_RELEVANCE defaults
// ON, so the gate table (memory/wrappers.ts) is what a real prompt is measured through. Handed the
// same things dossier.ts hands it, through the same screens — expired short rows dropped, directives
// past sanitizeDirectives, the long doc split at the granularity the sanitizer screens at. These
// fixtures are clean enough that no screen changes the measurement, which is the point: the day one
// of them stops being clean, the ratchet measures what production would render, not more.

function stack(data: UserMemoryData, turnText: string, audience: MemoryAudience = 'individual'): string {
  const turn = buildTurnRelevance(turnText, {
    short: data.short.filter(e => e.expiresAt > FROZEN_MS),
    medium: {
      ...data.medium,
      directives: sanitizeDirectives(data.medium.directives.filter(d => d && typeof d.text === 'string'), { quiet: true }),
    },
    longSections: splitSections(sanitizeLongDoc(data.longDocMd, { quiet: true })),
  });
  return renderUserMemoryWithHot('convo', data, FROZEN_MS, { audience, currentTurnText: turnText, turn }).text;
}

/** The craft-module gate facts a turn of this shape really produces, computed the way the live path
 *  computes them (memory/dossier.ts for the two memory reads, convo/client.ts for the attachment
 *  note) rather than hand-set per fixture. That is what makes the `craft_modules` ceiling a measured
 *  production size: it is whatever pages THIS data would load, including the day a fixture's data
 *  changes and loads a different set. */
function craftFacts(
  data: UserMemoryData,
  turnText: string,
  audience: MemoryAudience = 'individual',
  shape: TurnKind = 'task',
): CraftTurnFacts {
  return {
    attachmentNote: turnText.includes('[they attached'),
    emailFlag: data.short.some(e => e.kind === 'email_flag' && e.expiresAt > FROZEN_MS),
    thinProfile: audience !== 'group' && profileIsThin(data),
    // The two facts of the five the memory read cannot answer, and they arrive here as ONE argument
    // because the gate that answers them is one gate: the idle reading decided this turn's kind
    // before the prompt was built (persona/idle.ts), and it returns exactly one of the three. Taking
    // the kind rather than two booleans is what makes a fixture that claims both shapes at once
    // unwritable — the pages are disjoint in production (personaModules.ts), and a fixture that
    // loaded craft/hooks.md and craft/share.md together would be measuring a turn no gate can hand
    // the assembler. Each page is measured on the shape it is for: a prompt that says "you may carry
    // one hook", or "they handed you something", with the page teaching that move missing from the
    // craft set would be measuring a turn that cannot happen.
    idleTurn: shape === 'idle',
    shareTurn: shape === 'share',
  };
}

const EMPTY_MEDIUM: MediumBundle = { directives: [], notes: [], facts: {} };

const MATURE_PROFILE: UserProfile = {
  handle: HANDLE,
  name: 'Sam',
  facts: [
    'runs a plant nursery outside bend',
    'has a daughter who plays saturday soccer',
    'fixing up a lake cabin, calls it "the shack"',
    'hard rule: no calls before 10am',
  ],
  firstSeen: Math.floor(FROZEN_MS / 1000) - 270 * 86_400,
  lastSeen: Math.floor(FROZEN_MS / 1000) - 20 * 60,
};

const MATURE_MEDIUM: MediumBundle = {
  directives: [
    { id: 'd1', text: 'keep replies short unless i ask for the detail', createdAt: FROZEN_MS - 90 * 86_400_000 },
    { id: 'd2', text: 'never put anything on a weekday before 10am', createdAt: FROZEN_MS - 40 * 86_400_000 },
    { id: 'd3', text: 'call the nursery "the yard", never "the business"', createdAt: FROZEN_MS - 12 * 86_400_000 },
  ],
  notes: [
    'the cedar order from the north supplier is late and the invoice is disputed',
    'her sister visits the last weekend of every month',
    'the irrigation permit renewal is due before spring',
  ],
  facts: {
    address_as: 'Sam',
    timezone: 'America/Los_Angeles',
    work: 'owns a plant nursery, wholesale and retail',
    style: 'casual, lowercase, short',
  },
};

const MATURE_LEGACY: AgentMemory = { handle: HANDLE, dossierMd: '', prefs: { address_as: 'Sam' } };

/** A dossier at the size the updater is told to keep it ("under ~400 words"), under the canonical
 *  headings — so the flexible tier is measured at its documented ceiling rather than empty. */
const MATURE_LONG_DOC = `## Who they are
Sam. Runs a wholesale-and-retail plant nursery outside Bend, Oregon; six seasonal staff, two vans.
Pacific time. Calls the nursery "the yard".

## How they work
Mornings are for the yard, desk work lands after four. Never wants a call or a slot before 10am on a
weekday — a hard rule, stated twice. Prefers a number and a source over a summary, and will say
"just the number" when a reply runs long. Keeps every supplier thread in one email account and hates
being asked to re-explain a thread she has already forwarded.

## How to text them
Casual, lowercase, short. Reads on the phone between rows, so a wall of text gets skimmed. Fine with
a blunt answer; asks for the reasoning when she wants it. Dislikes exclamation marks and anything
that reads like a newsletter.

## Their world
The cedar order from the north supplier has been late twice this season and the invoice is disputed —
live, and she checks on it most weeks. Fixing up a lake cabin she calls "the shack"; the dock is the
current project. Daughter plays saturday soccer, home games most weeks. Sister visits the last
weekend of every month. An irrigation permit renewal is due before spring and she has been putting
off the paperwork.

## Running jokes
The "budget committee" — her own phrase for the third round of price comparisons. The shack's dock,
which has been "one weekend away" since august.`;

/** The freshest look, hot: ≤45 min old and topically related to the incoming message, so the short
 *  tier renders it in FULL (capped at SHORT_ENTRY_CHARS = 600 by the renderer). Its sibling is older
 *  and collapses to a digest line — the realistic mature shape. */
const MATURE_SHORT: ShortTermEntry[] = [
  {
    id: 's1', agentHandle: HANDLE, kind: 'ops_research', request: 'cedar lead times from the north supplier',
    content: 'The north supplier lists 6-8 weeks on cedar right now, up from 4 in the spring; two of the three regional yards quote the same window and the third is quoting 10. The delay is a mill scheduling backlog rather than raw stock, so partial shipments are possible on request. Freight has not moved. If the order was placed in the first week of december the earliest realistic arrival is mid february, and the disputed invoice line is the expedite fee from the last late shipment, which the supplier has waived twice before when asked in writing.',
    meta: { topicKey: 'cedar' }, createdAt: FROZEN_MS - 12 * MINUTE, expiresAt: FROZEN_MS + 20 * 3600_000,
  },
  {
    id: 's2', agentHandle: HANDLE, kind: 'ops_research', request: 'irrigation permit renewal window',
    content: 'The county renews agricultural irrigation permits between january and march; the form is two pages plus the previous season usage figures, and the fee is unchanged from last year.',
    meta: {}, createdAt: FROZEN_MS - 9 * 3600_000, expiresAt: FROZEN_MS + 14 * 3600_000,
  },
  {
    id: 's3', agentHandle: HANDLE, kind: 'email_flag', request: 'invoice dispute — north supplier',
    content: 'The supplier replied on the disputed expedite fee and wants an answer before the next shipment leaves the mill; they name friday as the cutoff.',
    meta: { from: 'accounts@northsupplier.example', subject: 'RE: invoice 4471', deadlineLabel: 'friday' },
    createdAt: FROZEN_MS - 5 * 3600_000, expiresAt: FROZEN_MS + 18 * 3600_000,
  },
];

/** The turn text the hot look above is measured against — the short tier only renders a look in full
 *  when it shares a salient token with what they just said (memory/topicality.ts). */
const MATURE_TURN_TEXT = 'so are the cedars coming or not';

const MATURE_DATA: UserMemoryData = {
  profile: MATURE_PROFILE, memory: MATURE_LEGACY, medium: MATURE_MEDIUM,
  short: MATURE_SHORT, longDocMd: MATURE_LONG_DOC,
};
const MATURE_STACK = stack(MATURE_DATA, MATURE_TURN_TEXT);

/** Nothing on file at all — the cold install. Renders the discovery scaffold and the default
 *  operating stance, which is the point: a thin profile is not a small prompt. */
const COLD_DATA: UserMemoryData = {
  profile: null, memory: null, medium: EMPTY_MEDIUM, short: [], longDocMd: '',
};
const COLD_STACK = stack(COLD_DATA, 'hey');

const MEDIA_SHORT: ShortTermEntry[] = [
  {
    id: 'm1', agentHandle: HANDLE, kind: 'media_analysis', request: 'the lease pdf they just sent',
    content: 'A 9-page commercial lease for the second yard. Term is five years from march 1 with one five-year option, notice ninety days. Base rent 4,200/month with a 3% annual escalator, plus a triple-net share of taxes and insurance estimated at 900/month. The option period rent is "market as agreed", which is the line worth pushing on. Personal guarantee on page 7 covers the first two years only. No exclusivity clause; the landlord may lease the adjacent bay to another nursery.',
    meta: { topicKey: 'lease' }, createdAt: FROZEN_MS - 3 * MINUTE, expiresAt: FROZEN_MS + 23 * 3600_000,
  },
];

const MEDIA_DATA: UserMemoryData = {
  profile: MATURE_PROFILE, memory: MATURE_LEGACY, medium: MATURE_MEDIUM,
  short: MEDIA_SHORT, longDocMd: MATURE_LONG_DOC,
};
const MEDIA_STACK = stack(MEDIA_DATA, 'the lease pdf, can you read it');

const GROUP_DATA: UserMemoryData = {
  profile: { handle: 'group:nursery', name: null, facts: [], firstSeen: MATURE_PROFILE.firstSeen, lastSeen: MATURE_PROFILE.lastSeen },
  memory: null, medium: { directives: [], notes: ['the crew agreed no yard photos in the chat'], facts: {} },
  short: [], longDocMd: '## Who they are\nThe nursery crew: Sam (owner), Ada (deliveries), Theo (weekends).',
};
const GROUP_STACK = stack(GROUP_DATA, 'did the cedars land', 'group');

/** The two PLAIN sections a routed context block can carry, both through the real renderers
 *  (memory/dossier.ts), never mirrored here: the hand-written tenure mirror that used to sit in this
 *  file had drifted from its renderer by the time anyone compared them.
 *
 *  APPROVAL is the approval gate's — she asked whether to go ahead with an action in the world and
 *  nothing has started; CLARIFICATION is the steering question after a thin look. They are
 *  independent (different asks, different clocks), so the widest plain part is both at once. */
const APPROVAL = renderPendingApproval({
  taskId: 'a1',
  request: 'email the north supplier that the warped pallet is going back',
  kind: 'general',
  askedAt: FROZEN_MS - 4 * MINUTE,
}, FROZEN_MS);

const CLARIFICATION = renderPendingClarification({
  request: 'replacing the warped dock boards',
  missingFields: ['which supplier the pallet came from', 'whether you want the whole pallet returned or the six boards swapped'],
  at: FROZEN_MS - 4 * MINUTE,
});

/** The context block a routed turn assembles: the plain Convo sections first, the wrapped memory
 *  stack last, joined with a blank line the way buildContextBlockWithHot joins them.
 *
 *  It used to lead with a plain "## How long you've known them" section on every turn; the identity
 *  card at the top of the stack carries that clock now (memory/tenure.ts), so a turn with no
 *  steering question outstanding assembles a context block that IS its memory stack. One fixture
 *  carries one, which is what keeps `context_block` and `memory_stack` two measurements: without it
 *  they are two ceilings over one string, and nothing measures the plain part at all. */
const contextBlockWith = (stack: string, ...plain: string[]) => [...plain, stack].join('\n\n');

// ── the rest of the per-turn inputs ──────────────────────────────────────────

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 1), FROZEN_MS),
  circadian: computeCircadian(FROZEN_MS, 'UTC'),
};

function affect(): AffectState {
  const emitted = coerceStatus({
    mood_label: 'hopeful', mood_shift: 'lifted', intent_mode: 'sharing_update',
    terminal_closure: false, epistemic_trigger: 'logic_valid',
    meta_prompt: 'they seem upbeat, keep it light and follow their lead',
  })!;
  // The gauges left the envelope in v2 — they are code's answer now (persona/affectDrift.ts) — so the
  // row she carried IN is STATED here rather than emitted into place. A prompt fixture is about what
  // the weather block renders, not about the drift arithmetic (persona/affectDrift.test.ts owns that).
  const last = {
    ...mergeStatus(emitted, COMPUTED, 0),
    mood_level: 72, anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, patience: 75,
  };
  return { last, moodHistory: [{ level: 72, core: 'powerful', label: 'hopeful', at: 0 }] };
}

/** A climate that has actually moved — at defaults the weather block renders no climate lines. */
const MOVED_CLIMATE: RelationshipClimate = {
  ...defaultClimate(), dials: { ease: 70, candor: 80, playfulness: 60 }, evalCount: 30,
};

const THEME: ThreadCandidate = {
  material: 'theme', rungCeiling: 'pattern', kind: 'tension', id: 't1',
  label: 'speed vs craft',
  note: 'they keep landing back on shipping fast versus doing it right, and it comes up whenever a supplier slips',
};

const ACTIVE_OPS: ActiveOps[] = [
  {
    taskId: 'op1', kind: 'media_analysis', request: 'read the lease pdf they just sent',
    startedAt: FROZEN_MS - 40_000, firstStartedAt: FROZEN_MS - 40_000,
    lastMilestone: 'engine', estimateMs: 120_000, estimatePhrase: 'a couple minutes',
    // One mid-run addition on the look that is actually RUNNING — the live shape of a steer
    // (state/opsCoordination.ts `steers`), and what makes the "you added" suffix a measured part of
    // the active_ops ceiling rather than an unmeasured one.
    steers: ['the option period especially'],
  },
  {
    taskId: 'op2', kind: 'web_research', request: 'commercial lease option-period norms in bend',
    startedAt: FROZEN_MS - 8_000, firstStartedAt: FROZEN_MS - 8_000,
    lastMilestone: 'queued', estimateMs: 180_000, estimatePhrase: 'a few minutes',
  },
];

/** The reminders standing for them at the widest the engine ever hands back — ten rows, the render
 *  cap (liveReminders.ts MAX_LIVE_REMINDERS), each with a real cadence, a next run, a set date and a
 *  gist near the 90-character clamp, so the `live_reminders` ceiling is the full list a mature
 *  install can actually be carrying rather than one or two rows standing in for it. Same world as
 *  MATURE_PROFILE's: the yard, the cedar order, the dock, the permit, soccer, her sister — a person
 *  with nine months on file has this many standing reminders as often as she has none. */
const WIDE_REMINDERS: ReminderRef[] = [
  {
    id: 'a1b2c3d4e5f6', title: 'morning yard check-in', kind: 'cron', expr: '0 7 * * 1-5',
    schedule: 'every weekday at 7am', nextRunAt: '2026-01-06T15:00:00+00:00',
    createdAt: '2025-11-02T18:00:00+00:00',
    instruction: 'ping me at the gate before the crew clocks in so I can walk the rows and see what needs watering before it gets hot out',
  },
  {
    id: 'b2c3d4e5f6a1', title: 'cedar invoice follow-up', kind: 'once',
    schedule: 'once at 2026-01-09 09:00', runAt: '2026-01-09T17:00:00+00:00',
    nextRunAt: '2026-01-09T17:00:00+00:00', createdAt: '2025-12-30T20:00:00+00:00',
    instruction: 'chase the north supplier in writing about the disputed expedite fee if nobody has answered by friday morning',
  },
  {
    id: 'c3d4e5f6a1b2', title: 'irrigation permit renewal', kind: 'once',
    schedule: 'once at 2026-01-15 09:00', runAt: '2026-01-15T17:00:00+00:00',
    nextRunAt: '2026-01-15T17:00:00+00:00', createdAt: '2025-12-20T16:00:00+00:00',
    instruction: 'send the county the renewal form and last season usage figures before the window closes at the end of the month',
  },
  {
    id: 'd4e5f6a1b2c3', title: 'soccer saturday', kind: 'cron', expr: '0 9 * * 6',
    schedule: 'every saturday at 9am', nextRunAt: '2026-01-10T17:00:00+00:00',
    createdAt: '2025-10-14T14:00:00+00:00',
    instruction: 'nothing before eleven on saturdays, soccer runs long and there is no point trying to fit anything else in first',
  },
  {
    id: 'e5f6a1b2c3d4', title: 'sister visits', kind: 'cron', expr: '0 16 28-31 * *',
    schedule: 'last weekend of every month', nextRunAt: '2026-01-30T00:00:00+00:00',
    createdAt: '2025-08-05T12:00:00+00:00',
    instruction: 'tidy the shack and stock the fridge before she gets in, she always asks about the dock first thing',
  },
  {
    id: 'f6a1b2c3d4e5', title: 'well pump plumber', kind: 'once',
    schedule: 'once at 2026-01-08 21:00', runAt: '2026-01-08T21:00:00+00:00',
    nextRunAt: '2026-01-08T21:00:00+00:00', createdAt: '2026-01-04T19:30:00+00:00',
    instruction: 'confirm one oclock with the plumber or tell him the next opening is two weeks out, he has already rescheduled twice',
  },
  {
    id: 'a2b3c4d5e6f7', title: 'mill schedule call', kind: 'cron', expr: '0 15 * * 3',
    schedule: 'every wednesday at 3pm', nextRunAt: '2026-01-07T23:00:00+00:00',
    createdAt: '2025-09-18T13:00:00+00:00',
    instruction: 'call the mill about the cedar and fir swap and ask again whether partial shipments are possible on request',
  },
  {
    id: 'b3c4d5e6f7a2', title: 'dock board photos', kind: 'once',
    schedule: 'once at 2026-01-07 15:00', runAt: '2026-01-07T15:00:00+00:00',
    nextRunAt: '2026-01-07T15:00:00+00:00', createdAt: '2026-01-05T22:00:00+00:00',
    instruction: 'take photos of the whole pallet in daylight against a straight edge before the supplier will talk about a return',
  },
  {
    id: 'c4d5e6f7a2b3', title: 'weekend close-up', kind: 'cron', expr: '0 6 * * *',
    schedule: 'every day at 6pm', nextRunAt: '2026-01-06T23:00:00+00:00',
    createdAt: '2025-07-11T10:00:00+00:00',
    instruction: 'walk the beds, lock the gate and check the irrigation timer before heading out for the night',
  },
  {
    id: 'd5e6f7a2b3c4', title: 'budget committee round three', kind: 'once',
    schedule: 'once at 2026-01-12 18:00', runAt: '2026-01-12T18:00:00+00:00',
    nextRunAt: '2026-01-12T18:00:00+00:00', createdAt: '2025-12-28T09:00:00+00:00',
    instruction: 'compare the three vendor quotes again before the next price comparison and actually pick one this time',
  },
];

/** Her holding-beat history at its fullest — HOLDING_BEATS_KEPT (state/holdingBeats.ts), five, oldest
 *  first as the store returns it — so the `recent_beats` ceiling is the whole list a busy chat carries.
 *  The media turn is where it is measured: two looks are already running there, so it is a chat whose
 *  last few handoffs really did leave beats behind. */
const FULL_BEATS: string[] = [
  'hmm lemme see what the north supplier says',
  'one sec',
  'digging into the cedar lead times',
  'ok give me a minute on that permit',
  'hm, pulling up the lease terms',
];

/** The caller addendum the live turn actually passes: the one-off version note
 *  (update/announce.ts claimPendingUpdateNote — private to that module, so the text is mirrored
 *  here with a stand-in build sha of the same length). */
const UPDATE_NOTE = `## Passing note — you have an upgrade waiting\nA new version of you (build 4f2a91c) is ready for the server you run on. Somewhere natural in THIS reply, mention it once — your own words, one short bubble at most: you've got an upgrade ready, and they can apply it by running \`bash scripts/update.sh\` in your install folder (relay that command exactly, in backticks) — the script pulls, rebuilds and restarts you itself, so there is nothing left for them to restart. Never frame it as a system announcement or read it like a changelog. If this exact moment is the wrong time — they're mid-crisis or asking something urgent — skip it; this note won't come back.`;

/** The media note convo/client.ts folds into the turn text when a file arrives (describeAttachments,
 *  private to that module — mirrored here for the photo case). */
const MEDIA_NOTE = `[they attached a document — the contents aren't unpacked into this note. to see/read what's inside, open it with delegate_to_ops (media_scope "this_turn"); that IS you looking. never guess at what's inside before opening it, and NEVER tell them you can't see/open it.]`;

// ── histories ────────────────────────────────────────────────────────────────

/** A real texting exchange, cycled to whatever length a fixture asks for, so a 40-row history is a
 *  plausible transcript rather than forty copies of one line — the transcript's SIZE is the thing
 *  under measurement, and it has to be an honest size. Alternating and even-length, so the roles
 *  keep alternating across the seam when it repeats. */
const TEXTS: Array<[StoredMessage['role'], string]> = [
  ['user', 'morning, any word on the cedars'],
  ['assistant', 'nothing new since yesterday'],
  ['user', 'the north supplier said two weeks three weeks ago'],
  ['assistant', 'i know. want me to chase the mill schedule instead?'],
  ['user', 'yeah do that'],
  ['assistant', 'on it'],
  ['user', 'also the dock boards came in warped'],
  ['assistant', 'the whole pallet or a few?'],
  ['user', 'maybe six of them'],
  ['assistant', 'that is a return, not a sanding job'],
  ['user', 'ok. soccer is at ten on saturday btw'],
  ['assistant', 'noted, nothing before eleven then'],
  ['user', 'thanks'],
  ['assistant', 'the mill says the backlog is scheduling, not stock'],
  ['user', 'so partial shipments are possible'],
  ['assistant', 'they will do it if you ask in writing'],
  ['user', 'draft that for me later'],
  ['assistant', 'sure. after four?'],
  ['user', 'perfect'],
  ['assistant', 'and the expedite fee is the disputed line, not the freight'],
];

/** The same two people on a working day rather than a passing one: sentences instead of acks, the
 *  reasons attached, the numbers said out loud. Same twenty-row shape and the same alternation, and
 *  the difference that matters here is SIZE — these rows average about a hundred and sixty
 *  characters where the ones above average thirty. Eighty of them is the transcript band where the
 *  drift anchor stops trusting the middle of the prompt (persona/policy.ts
 *  DRIFT_LONG_WINDOW_CHARS), and there is no honest way to reach that band with one-word texts:
 *  forty "ok"s are nine hundred characters. This is what twelve thousand actually looks like. */
const DENSE_TEXTS: Array<[StoredMessage['role'], string]> = [
  ['user', 'the north supplier finally sent the schedule, they have us down for the second week of april for the cedar and the third week for the fir, which is backwards from what we asked for'],
  ['assistant', 'backwards and late. the fir was the one you wanted first because the dock rebuild is the only job with a permit date on it, everything else can slide'],
  ['user', 'right. can you write the mill and ask them to swap the two, and say the permit inspection is the reason, they respond better to a date than to a complaint'],
  ['assistant', 'drafted it and left it in your outbox. one paragraph, the permit date, the two loads, no adjectives. read it before it goes because i put the expedite fee in there too'],
  ['user', 'the expedite fee is the part i keep going back and forth on, they quoted four hundred on the first load and then nine hundred on the second with no explanation at all'],
  ['assistant', 'that is the disputed line. the freight is fine, the fee is what doubled, and the invoice does not say why. ask for the tariff sheet and the number either holds or it does not'],
  ['user', 'ok ask for the sheet. separate thing, the dock boards. six of the twenty came in warped and the supplier wants photos before they will talk about a return at all'],
  ['assistant', 'photos of the whole pallet, not the six, so the warp reads as a batch problem instead of six boards somebody stacked wrong. take them in daylight against a straight edge'],
  ['user', 'good call, the straight edge is in the truck. also i am not going to get to the irrigation permit this week, the renewal window is open until the end of the month right'],
  ['assistant', 'end of the month, and the county takes ten working days on a renewal, so the last day you can send it and still be covered is the eighteenth. that one is a wednesday'],
  ['user', 'put it on the list for the fifteenth then. what else is sitting there that i have not looked at, i feel like there is something with the invoice from february'],
  ['assistant', 'february is closed. what is open is the cedar order, the dock return, the permit renewal and the mill swap. the february invoice was paid short by the expedite fee and nobody chased it'],
  ['user', 'nobody chased it because i forgot. is it worth chasing now or does it just make the current fee conversation harder than it already is'],
  ['assistant', 'it makes it easier. same fee, same supplier, twice, and the second time they doubled it. one conversation, two examples, that is a pattern instead of a complaint'],
  ['user', 'fine, chase both. saturday is soccer at ten so i am useless until noon, and the shack has the plumber coming at one which i will also be useless for'],
  ['assistant', 'nothing before eleven, i know, and i will not put anything on saturday. the plumber is the one who quoted the well pump or the one who did the kitchen line'],
  ['user', 'the well pump. he wants to look at the pressure tank before he quotes, which is fair, but he has already rescheduled twice and i am not holding a day for a maybe'],
  ['assistant', 'then tell him one o clock or the next opening is in two weeks. a person who reschedules twice is telling you what his week looks like, not what yours is worth'],
  ['user', 'i will send that. last thing, my sister is coming the last weekend of the month like always and i want the shack liveable by then, what is actually left to do'],
  ['assistant', 'the dock is not liveable, it is nice to have. what is left is the pump, the kitchen line and the warped boards off the deck so nobody puts a foot through it. three things'],
];

function history(rows: number, texts: Array<[StoredMessage['role'], string]> = TEXTS): StoredMessage[] {
  const out: StoredMessage[] = [];
  // Built newest-first and unshifted, so the finished array is in send order with the freshest row
  // last — the shape the store returns, and the shape both timing reads assume. It therefore ends on
  // one of HER bubbles, which is what gives the reply-order read a run of her own sends to point at.
  for (let i = 0; i < rows; i++) {
    const [role, content] = texts[texts.length - 1 - (i % texts.length)];
    out.unshift({
      role, content,
      handle: role === 'user' ? HANDLE : undefined,
      at: FROZEN_MS - (20 + i * 7) * MINUTE,
    });
  }
  return out;
}

const HISTORY_40 = history(40);
const HISTORY_6 = history(6);
const HISTORY_12 = history(12);
/** The window the box actually ships — `CONVO_HISTORY_MAX=80` in deploy/app.env, twice the code
 *  default — filled with the dense rows. Twelve thousand eight hundred characters of transcript,
 *  which is the only reason this fixture exists: it is the one turn here that renders the drift
 *  anchor's LONG band, and therefore the one that measures `behavior_anchor` at its real maximum. */
const HISTORY_80_DENSE = history(80, DENSE_TEXTS);

// ── what the rhythm engine decided ───────────────────────────────────────────
// Four of the eight fixtures are turns that asked for nothing — three idle, one share — and the
// first two are the two that have to be: the `hooks` section and the `thesis` section are measured
// budget lines, so a fixture has to render each of them or the ceiling is a number nobody took.
// (The other two, fixtures 7 and 8, carry a directive for a reason that has nothing to do with the
// section it renders and everything to do with the one after it — see their own comments, and
// `behavior_anchor`.)
//
// Which two is not arbitrary. The cold "hey" is the idle turn the manifesto is named after. The
// THREAD-OFFER fixture is the other one because it now has no choice: an offer is only ever made on
// a hook turn (persona/hooks.ts — `offerAllowed` is true in that mode and no other), so a thread
// offer and a task turn cannot co-occur in production, and measuring the widest craft set on a task
// turn would measure a shape the assembler can no longer build. That fixture is where
// `craft_modules` reaches its maximum, and the hook page is now part of that maximum.

// `lateNight` is not a choice either. These fixtures run on a frozen clock of 02:00 UTC
// (`FROZEN_MS`), which `computeCircadian` reads as `dead_night`, and `compileAffect` sets the flag
// straight off that slot (persona/affectCompiler.ts — no flag, no store, no mood in it). Every idle
// directive below therefore carries it, and a fixture that turned it off would be measuring a shape
// this clock cannot produce.
//
// What the flag DOES is the whole reason these two directives now look alike. It is a REGISTER: it
// adds one line saying the reply is small and quiet, and it closes no kind, shuts no sampler and
// picks no mode (persona/hooks.ts `selectHook` — the clock has no branch there at all). So a late
// idle turn is an ordinary idle turn, its `behavior_anchor` is the HOOK law like any other idle
// turn's, and the widest `hooks` section there is is late + every kind open + the widest moment
// sample. That is fixture 5, and it is measured on exactly that shape below.
//
// It used to be the opposite: the clock closed all three kinds, shut the sampler and the thread
// offer, and took a bucket of its own, so this fixture measured heading + lead + the none-open line
// + a sentence telling her to send them to bed, and its anchor was the QUIET law. That was one
// script, restated in seven prompt surfaces, arriving every night.
const HOOK_TURN: PersonaTurn = {
  hooks: {
    idle: true, mode: 'hook', forbidden: [], lateNight: true,
    moments: false, offerAllowed: true,
  },
  moments: [],
  thesis: '',
};

/** The OTHER hook turn, and the one the `hooks` ceiling is actually taken on: the same late idle
 *  turn with the spacing interval SPENT, which is what opens the moment lead (a moment can only ride
 *  out as a callback and sampling bills it either way, so the gate sits on the directive). Every
 *  kind open, the register line under the open line, and the widest sample the sampler can build —
 *  the widest section the engine can produce, and therefore the honest ceiling.
 *
 *  Fixture 7 carries the same directive, read at the other end of the prompt: the anchor's hook law
 *  is only reached while a kind is still open (shared.ts translates an all-kinds-closed hook turn
 *  into 'quiet'), and the hook law is the longest of the three. */
const OPEN_HOOK: HookDirective = {
  idle: true, mode: 'hook', forbidden: [], lateNight: true, moments: true, offerAllowed: true,
  playLevel: 3, englishLooseness: 3,
};

/** The share turn's directive, and the widest shape that mode has: every one of its FOUR kinds open,
 *  the question among them, and the late register under the sentence that names them. Fixture 8 is
 *  the only one that carries it, and the reason it is open all the way is the same argument fixture
 *  7's directive is built on, run over a mode with one more kind in it — the anchor states the share
 *  law whatever the section left open (shared.ts maps share to its own law unconditionally, so there
 *  is no all-kinds-closed translation to fall through here), and the SECTION is what narrows: a
 *  closed question drops `SHARE_QUESTION_LINE` and every kind closed drops the whole sentence for
 *  `SHARE_NONE_OPEN`. So this is the honest maximum of both, taken on one turn.
 *
 *  `idle: false` is not a detail: they SENT something. It is what the ledger reads to end the idle
 *  streak, and what the `Turn:` line reads to print the character count without a streak beside it
 *  (convo/turnFocus.ts). `heavy` is absent, which is the same answer as false and the shape the
 *  compiler hands a turn with no weight in it — a heavy share closes the judgment and the tangent
 *  (persona/hooks.ts) and would measure a narrower section than production's widest. */
const OPEN_SHARE: HookDirective = {
  idle: false, mode: 'share', forbidden: [], lateNight: true, moments: false, offerAllowed: true,
  playLevel: 3, englishLooseness: 3,
};

/**
 * The moment sample at its WIDEST, because `hooks` is a prose ceiling the live battery enforces
 * (convergence/focusBattery.ts `prose_budget`) and the moment lead is the one part of that section
 * whose size is data. Five is `MOMENT_SAMPLE_RECENT + MOMENT_SAMPLE_OLD`, the most `sampleMoments`
 * can ever hand a turn; two hundred characters is `MOMENT_TEXT_MAX`, which `renderMomentLines` clamps
 * to at the render seam whatever the file holds; `embarrassing` is the longest tag; and the `at`
 * stamp lands every one of them in `a month or two ago`, the longest of the seven age phrases. Any
 * real sample is therefore smaller than this one, which is exactly what the `hooks` line's own
 * history asks for — it was once ceilinged on a variant the clock could not produce, and that was a
 * breach waiting for the first late-night idle turn rather than a paper debt.
 *
 * Rendered through the REAL renderer rather than written out as literals, the way `stack()` renders
 * the memory tiers above: the prefix this ceiling is measured on is then whatever production would
 * really print, including the day the prefix changes.
 */
const MOMENT_TEXTS: readonly string[] = [
  "spent twenty minutes at midnight making you identify a girl in a mcdonald's japan advert, then asked how you knew, and then asked again the following night about a different ad from that same campaign",
  'checked the volcano dashboard for the third time this month, read out two of the numbers, decided on nothing at all, and then asked whether the dock boards were still on order at the northern supplier',
  'opened the week with a plan for the whole of the back yard, narrowed it down to one bed, then bought the cedar for a fence that is in neither version of that plan and told you it was that same project',
  're-did the whole side gate himself rather than ask the joiner to come back for one afternoon, and then he mentioned the joiner by name twice while explaining why the hinges now sit crooked on the gate',
  'asked you for the schedule, argued with the schedule, then set himself a deadline half a day earlier than the one you had given him and treated the difference as his own idea from the very start of it',
];

/** The idle line fixture 7 arrives on: a running joke restated, no ask anywhere in it. It has to be
 *  idle-shaped rather than borrowed from fixture 2, because that fixture's turn is a question with a
 *  number in the answer — a shape the idle gate never hands a hook directive, and a fixture whose
 *  prompt says "you may carry one hook" over a turn that asked for the cedar dates would be measuring
 *  a turn the engines cannot produce. */
const IDLE_TURN_TEXT = 'anyway the dock is still one weekend away';

/** The share line fixture 8 arrives on: a thing that happened in their day, handed over with no ask
 *  in it anywhere — not a question, not an instruction, and nothing the reply has to go and fetch.
 *  That is the whole of what the gate reads as a share (persona/idle.ts, and the classifier's own
 *  word for it), and it is a different turn from fixture 7's, which restates a running joke and
 *  hands her nothing new. The distinction is the feature: one of them earns a hook and the other
 *  earns a move about the thing itself. */
const SHARE_TURN_TEXT = 'the mill rang while i was loading the truck, they are swapping the two loads after all';

/** Forty days back: inside the 35–75 day band `momentAgeWords` renders as the longest phrase. */
const MOMENT_AT = FROZEN_MS - 40 * 24 * 60 * 60 * 1000;

const MOMENT_SAMPLE: MomentEntry[] = MOMENT_TEXTS.map((text, i) => ({
  id: `mo-${i}`, text, tag: 'embarrassing', at: MOMENT_AT, count: 1, offered: 0, lastOfferedAt: 0,
}));

const MOMENT_LINES: string[] = renderMomentLines(MOMENT_SAMPLE, FROZEN_MS);

/** Her one read on this person (memory/thesisEngine.ts), at about the length the writer prompt asks
 *  for — two to four sentences, behaviour only. A DATA budget line: the size is a property of the
 *  person, not of the checkout, which is why it sits with `context_block` in
 *  convergence/expectations.ts rather than with the prose ratchets. */
const THESIS = `## Your read on them (INTERNAL — never recite, never name; every judgment is made of it)
They decide fast on things that cost money and slowly on things that cost a conversation, which is why the supplier disputes sit open for weeks. They would rather re-do a job than ask someone to fix it, and they read a question about the schedule as a question about their competence.`;

/** What SHE holds with this person (memory/selfHarvest.ts), at the file's own cap: every entry at
 *  the longest a pass may write. A DATA line like the thesis, measured at its arithmetic maximum so
 *  the ceiling is the most the section can ever cost. */
const SELF_SECTION = renderSelfSection(Array.from({ length: MAX_SELF_ENTRIES }, (_, i) => ({
  id: `s${i}`,
  kind: (['stance', 'taste', 'learned', 'changed'] as const)[i % 4],
  text: `${'x'.repeat(SELF_TEXT_MAX - 4)} ${String(i).padStart(3, '0')}`.slice(0, SELF_TEXT_MAX),
  at: FROZEN_MS - i * 60_000,
})));

/** What her mood put off and still owes them (memory/owedAsks.ts), at the store's cap: every ask at
 *  the longest the envelope lets it be, and the longest age phrase a live one can carry. */
const OWED_SECTION = renderOwedSection(Array.from({ length: OWED_MAX }, (_, i) => ({
  ask: `${'y'.repeat(TURNED_DOWN_ASK_CHARS - 2)}${i}`.slice(0, TURNED_DOWN_ASK_CHARS),
  at: FROZEN_MS - 3 * 86_400_000,
})), FROZEN_MS);

// ── the eight fixtures ───────────────────────────────────────────────────────

interface Fixture {
  name: string;
  spec: TurnSpec;
  /** The wrapped memory tiers inside this fixture's context block (the `memory_stack` budget line),
   *  or null for a turn that carries no memory block at all. */
  memoryStack: string | null;
  /** Every section this turn is expected to assemble, in order — so a fixture that silently stops
   *  exercising a section (and stops measuring its ceiling) fails instead of passing quietly. */
  sections: SectionId[];
}

const FIXTURES: Fixture[] = [
  {
    // 1. COLD, thin profile: her first reply ever to this person. No name, nothing on file, the
    // install introduction riding their own opener.
    name: 'cold thin profile',
    spec: {
      chatContext: { isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE },
      contextBlock: COLD_STACK,
      tools: TOOLS_1TO1,
      history: [],
      incomingText: 'hey',
      introWeave: INTRO_WEAVE_BLOCK,
      turnFocus: { text: 'hey', hits: [], shape: 'idle', idleStreak: 1, messageChars: 3 },
      craft: craftFacts(COLD_DATA, 'hey', 'individual', 'idle'),
      personaTurn: HOOK_TURN,
    },
    memoryStack: COLD_STACK,
    sections: [
      'persona', 'tool_docs', 'model_map', 'craft_modules', 'update_status', 'name_nudge',
      'intro_weave', 'context_block', 'current_time', 'conversation_timing', 'hooks', 'turn_focus',
      'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 2. MATURE profile, plain question: nine months of history, a full memory stack, a hot look,
    // her weather — and the 40-row transcript window the live turn actually sends. This is the
    // fixture MIN_TRANSCRIPT_SHARE is measured on.
    name: 'mature profile, plain question',
    spec: {
      chatContext: {
        isGroupChat: false, participantNames: [], chatName: null,
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
      },
      contextBlock: contextBlockWith(MATURE_STACK),
      tools: TOOLS_1TO1,
      history: HISTORY_40,
      incomingText: MATURE_TURN_TEXT,
      affect: affect(),
      computed: COMPUTED,
      capability: { classes: ['web', 'files', 'code', 'media', 'scheduling'], complete: true },
      climate: MOVED_CLIMATE,
      turnFocus: { text: MATURE_TURN_TEXT, hits: [{ label: 'cedar lead times from the north supplier', source: 'research' }] },
      craft: craftFacts(MATURE_DATA, MATURE_TURN_TEXT),
    },
    memoryStack: MATURE_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'craft_modules', 'update_status',
      'context_block', 'current_time', 'weather', 'status_contract', 'conversation_timing',
      'reply_order', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 3. MEDIA turn: a file arrived, two looks are already running, their message queued behind the
    // chat lock while she was sending — so the reply-order read is the backward-order variant — and
    // ten reminders standing on the engine, the render cap, so this is also the turn `live_reminders`
    // takes its ceiling on: a reply here may need to act on a run AND a reminder by id in one breath.
    name: 'media turn with research already running',
    spec: {
      chatContext: {
        isGroupChat: false, participantNames: [], chatName: null,
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
        arrivals: [{ receivedAt: FROZEN_MS - 90_000, sendsAfterArrival: 2 }],
      },
      contextBlock: contextBlockWith(MEDIA_STACK),
      activeOps: ACTIVE_OPS,
      tools: [...TOOLS_1TO1, UNSEND_TOOL],
      history: HISTORY_6,
      incomingText: `the lease pdf, can you read it ${MEDIA_NOTE}`,
      computed: COMPUTED,
      capability: { classes: ['web', 'files', 'media'], complete: false },
      turnFocus: {
        text: `the lease pdf, can you read it ${MEDIA_NOTE}`,
        hits: [{ label: 'the lease pdf they just sent', source: 'research' }],
      },
      craft: craftFacts(MEDIA_DATA, `the lease pdf, can you read it ${MEDIA_NOTE}`),
      liveState: { reminders: WIDE_REMINDERS, holdingBeats: FULL_BEATS, unsendBubbles: WIDEST_UNSEND, checkinAwaiting: true },
    },
    memoryStack: MEDIA_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'craft_modules', 'update_status',
      'context_block', 'active_ops', 'recent_beats', 'live_reminders', 'current_time', 'weather', 'status_contract',
      'conversation_timing', 'reply_order', 'unsend', 'checkin', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 4. BURST + tapped reply, in a group: three texts this turn, and one of them taps an old bubble
    // of hers from before the visible window (the largest tapped-reply variant — it carries the
    // beyond-recall note).
    name: 'burst plus tapped reply in a group',
    spec: {
      chatContext: {
        isGroupChat: true, participantNames: ['Sam', 'Ada', 'Theo'], chatName: 'nursery crew',
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
        repliedTo: {
          kind: 'assistant',
          text: 'the mill quoted six to eight weeks on cedar, and they will split the shipment if you ask in writing',
          sentAtMs: FROZEN_MS - 40 * 86_400_000,
          viaLiveFetch: true,
        },
        burstManifest: [
          { text: 'wait', handle: HANDLE },
          { text: 'this the one you meant?', handle: HANDLE },
          { text: 'ada says the pallet is here', handle: '+15550002222' },
        ],
      },
      contextBlock: contextBlockWith(GROUP_STACK),
      tools: TOOLS_GROUP,
      history: HISTORY_12,
      incomingText: 'this the one you meant?',
      computed: COMPUTED,
      capability: { classes: ['web', 'code'], complete: true },
      turnFocus: { text: 'this the one you meant?', hits: [] },
      craft: craftFacts(GROUP_DATA, 'this the one you meant?', 'group'),
    },
    memoryStack: GROUP_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'group', 'craft_modules',
      'update_status', 'context_block', 'tapped_reply', 'burst', 'current_time', 'weather',
      'status_contract', 'conversation_timing', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 5. THREAD-OFFER turn: her weather carries one standing theme to (maybe) tag, last turn's offer
    // is still owed a bookkeeping answer, and a version note is riding along as the caller addendum.
    // It is also the one fixture carrying BOTH plain sections a routed context block can hold — a
    // steering question and an approval ask, live at the same time — so this is where the context
    // block's plain part is measured, at its widest.
    name: 'thread offer with an outcome ask',
    spec: {
      chatContext: {
        isGroupChat: false, participantNames: [], chatName: null,
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
      },
      contextBlock: contextBlockWith(MATURE_STACK, CLARIFICATION, APPROVAL),
      extraSection: UPDATE_NOTE,
      tools: TOOLS_1TO1,
      history: HISTORY_12,
      incomingText: 'honestly i just want it done right this time',
      affect: affect(),
      computed: COMPUTED,
      capability: { classes: ['web', 'inbox', 'files', 'code', 'media', 'scheduling'], complete: true },
      climate: MOVED_CLIMATE,
      thread: { offer: THEME, outcomeAsk: { label: 'the dock boards', material: 'loop' } },
      turnFocus: {
        text: 'honestly i just want it done right this time',
        hits: [{ label: 'speed vs craft', source: 'thread' }, { label: 'cedar lead times from the north supplier', source: 'research' }],
        idle: true,
        idleStreak: 12,
        messageChars: 43,
      },
      craft: craftFacts(MATURE_DATA, 'honestly i just want it done right this time', 'individual', 'idle'),
      // The one fixture that carries earned material: her read behind the dossier, and the widest
      // moment sample the engine can build inside the hooks section. Both live on THIS turn rather
      // than on the cold one because both are things a nine-month relationship has and a first
      // reply does not — and because the directive has to open the moment lead for them to render
      // at all (`moments: true`, which `sampleMoments`' own spacing interval earns).
      personaTurn: { hooks: OPEN_HOOK, moments: MOMENT_LINES, thesis: THESIS, self: SELF_SECTION, owed: OWED_SECTION },
    },
    memoryStack: MATURE_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'craft_modules', 'update_status',
      'context_block', 'thesis', 'self', 'owed', 'current_time', 'weather', 'status_contract', 'thread',
      'conversation_timing', 'reply_order', 'extra', 'hooks', 'turn_focus', 'behavior_anchor',
      'json_anchor',
    ],
  },
  {
    // 6. THE LONG THREAD: fixture 2's turn — same person, same memory, same ask — on the eighty-row
    // window the box ships (deploy/app.env CONVO_HISTORY_MAX=80) with the dense rows in it. Twelve
    // thousand eight hundred characters of transcript, and it exists for ONE section: past
    // DRIFT_LONG_WINDOW_CHARS the drift anchor buys the identity clauses back (persona/policy.ts),
    // and `behavior_anchor` is a prose ceiling the live battery enforces (convergence/focusBattery.ts
    // prose_budget), so a maximum measured only on short windows is a breach waiting for the first
    // real thread. Everything else here is deliberately fixture 2's, so this row moves exactly two
    // numbers — the anchor's, and whatever the two timing reads make of a longer window.
    name: 'mature profile on a long thread',
    spec: {
      chatContext: {
        isGroupChat: false, participantNames: [], chatName: null,
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
      },
      contextBlock: contextBlockWith(MATURE_STACK),
      tools: TOOLS_1TO1,
      history: HISTORY_80_DENSE,
      incomingText: MATURE_TURN_TEXT,
      affect: affect(),
      computed: COMPUTED,
      capability: { classes: ['web', 'files', 'code', 'media', 'scheduling'], complete: true },
      climate: MOVED_CLIMATE,
      turnFocus: { text: MATURE_TURN_TEXT, hits: [{ label: 'cedar lead times from the north supplier', source: 'research' }] },
      craft: craftFacts(MATURE_DATA, MATURE_TURN_TEXT),
    },
    memoryStack: MATURE_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'craft_modules', 'update_status',
      'context_block', 'current_time', 'weather', 'status_contract', 'conversation_timing',
      'reply_order', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 7. THE LONG THREAD, IDLE: fixture 6's window and fixture 6's person, on the turn where they
    // said something with no ask in it. It exists for ONE number, and for the same reason fixture 6
    // does — `behavior_anchor` is picked on TWO axes, the window and the mode, and until this row
    // the fixtures only ever crossed the window band on a TASK turn. The anchor's hook law is the
    // longest of the three (persona/policy.ts DRIFT_MODE_BULLETS), so hook/long is the widest of the
    // six variants and this is the turn that renders it — a maximum measured on task/long alone was
    // a live breach waiting for the first idle beat in a long thread, not a paper debt
    // (convergence/focusBattery.ts prose_budget scores this key against real traffic, where a hook
    // turn on a long window is an ordinary evening).
    //
    // OPEN_HOOK is the directive on purpose — the same one fixture 5 carries. A hook directive with
    // every kind CLOSED would send the anchor to its QUIET law (shared.ts makes that translation),
    // which is the NARROWEST of the six, so a fixture built on the closed-kinds shape would measure
    // the wrong end of the range. The clock is not what produces that shape — it is a register and
    // closes nothing — so this row is late like every other one here and still gets the hook law.
    // No moment sample: the widest `hooks` section is fixture 5's and this row is not competing for
    // that ceiling — what it is here to measure sits after `</prompt>`.
    name: 'idle turn on a long thread',
    spec: {
      chatContext: {
        isGroupChat: false, participantNames: [], chatName: null,
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
      },
      contextBlock: contextBlockWith(MATURE_STACK),
      tools: TOOLS_1TO1,
      history: HISTORY_80_DENSE,
      incomingText: IDLE_TURN_TEXT,
      affect: affect(),
      computed: COMPUTED,
      capability: { classes: ['web', 'files', 'code', 'media', 'scheduling'], complete: true },
      climate: MOVED_CLIMATE,
      turnFocus: { text: IDLE_TURN_TEXT, hits: [], shape: 'idle', idleStreak: 4, messageChars: 41 },
      craft: craftFacts(MATURE_DATA, IDLE_TURN_TEXT, 'individual', 'idle'),
      personaTurn: { hooks: OPEN_HOOK, moments: [], thesis: '' },
    },
    memoryStack: MATURE_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'craft_modules', 'update_status',
      'context_block', 'current_time', 'weather', 'status_contract', 'conversation_timing',
      'reply_order', 'hooks', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 8. THE LONG THREAD, SHARE: fixture 7's window, fixture 7's person and fixture 7's argument,
    // run over the third turn shape — the turn where they handed her something and asked for
    // nothing. It exists for the same ONE number the two rows above it exist for, and it takes it
    // off them: the anchor's SHARE law is longer than its hook law, so share/long is the widest of
    // the eight variants the renderer now has, and until this row nothing here could reach it. The
    // key is enforced LIVE (convergence/focusBattery.ts prose_budget), where a share turn on a long
    // window is the ordinary evening this whole shape was built for, so the ceiling had to be moved
    // by a fixture that renders the maximum rather than by reading it off the renderer and writing
    // it down — which is exactly how the seventh row moved it onto hook/long.
    //
    // It is also the one row here that measures the SHARE section and the share craft page inside a
    // real prompt. Neither takes its ceiling: `hooks` stands on fixture 5's moment sample, which is
    // three times the widest block the share mode has, and `craft_modules` stands on fixture 5's
    // thread-offer set, which carries craft/threading.md. What this row proves about those two is
    // narrower and still worth a fixture — that the block and the page assemble into a live prompt
    // at all, and that the sum they land in is comfortably under the sum a thread offer already
    // measured.
    //
    // OPEN_SHARE for the same reason fixture 7 carries OPEN_HOOK: the section narrows with the
    // directive and the anchor does not, so the widest shape of the mode is the honest one to
    // measure both on at once. Late like every other row here — the frozen clock is 02:00 and the
    // register rides the directive, closing nothing.
    name: 'share turn on a long thread',
    spec: {
      chatContext: {
        isGroupChat: false, participantNames: [], chatName: null,
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
      },
      contextBlock: contextBlockWith(MATURE_STACK),
      tools: TOOLS_1TO1,
      history: HISTORY_80_DENSE,
      incomingText: SHARE_TURN_TEXT,
      affect: affect(),
      computed: COMPUTED,
      capability: { classes: ['web', 'files', 'code', 'media', 'scheduling'], complete: true },
      climate: MOVED_CLIMATE,
      // No streak, and it is not an omission: a share turn ends the run of silences the count is of
      // (persona/hooks.ts recordHook), so the number in hand at prompt time is about the turns
      // before this message. The character count is kept — it is a fact about the message they
      // really sent, and the one the share section's dose rule turns on.
      turnFocus: { text: SHARE_TURN_TEXT, hits: [], shape: 'share', messageChars: SHARE_TURN_TEXT.length },
      craft: craftFacts(MATURE_DATA, SHARE_TURN_TEXT, 'individual', 'share'),
      personaTurn: { hooks: OPEN_SHARE, moments: [], thesis: '' },
    },
    memoryStack: MATURE_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'craft_modules', 'update_status',
      'context_block', 'current_time', 'weather', 'status_contract', 'conversation_timing',
      'reply_order', 'hooks', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
  },
];

/** The messages array the live turn sends alongside the prompt: the stored window as the model sees
 *  it, plus this turn's own text (convo/client.ts:248-252). In 'UTC', the zone the client hands
 *  formatHistory on a live turn and the same one `argsFor` pins the prompt to — the stamps are the
 *  bulk of the transcript's characters, so they measure on this file's clock, not the host's. */
function messagesFor(f: Fixture): TranscriptMessage[] {
  const { history: rows = [], incomingText, chatContext } = f.spec;
  return [
    ...formatHistory(rows, chatContext?.isGroupChat ?? false, 'UTC'),
    { content: incomingText || '...' },
  ];
}

/** The transcript's share of everything the model read, computed by the SAME code that reports it on
 *  a live turn (diagnostics/turnTrace.ts) rather than by a second copy of the formula. The other
 *  inputs are inert — this reads one number off the prompt measurement. */
function transcriptShare(prompt: MeasuredPrompt, messages: readonly TranscriptMessage[]): number {
  return buildTurnTraceDraft({
    turn: { prompt, messages, gates: { threads: null, hooks: null, memory: { shortHotLook: 'none', hits: [], blocks: {} }, extras: { updateNote: false, introWeave: false, activeOps: 0 } }, hits: [] },
    affect: { raw: null, coerced: null },
    outcome: { wasEnvelope: true, retried: false, silent: false, toolCalls: [] },
  }).prompt.transcriptShare;
}

// ── the assertions ───────────────────────────────────────────────────────────

/** The zone guard, and the reason it is the first test in the file. `argsFor` pins every fixture's
 *  `agentTz` to 'UTC', and that now covers every clock the assembler renders: `conversation_timing`
 *  takes the assembler's resolved zone like `current_time` always did, so the wall-clock prose is the
 *  same string on any host. It did not use to be — that section took no zone at all and fell back to
 *  `DEFAULT_TZ`, the HOST's own zone, resolved once at import (pipeline/zonedTime.ts) and therefore
 *  already fixed before this file's own `process.env.TZ` line runs, which put a run started outside
 *  UTC 49 characters away from the ceilings below on the mature fixture alone.
 *
 *  What is left is smaller and further down: the memory stack renders through
 *  `renderUserMemoryWithHot` with no `timeZone` option, so its dated-memory suffixes and date labels
 *  still resolve `DEFAULT_TZ` themselves and are day-granular — invisible at this frozen 02:00
 *  instant (the mature fixture measures 136,444 characters under TZ=UTC, on a UTC+7 host, on a UTC+14
 *  one and on a US Central one alike), and a different frozen instant near a day boundary would move
 *  it. So the pin stays, and the clock section stays its readable witness: hand it no stored
 *  `agent_tz` and it prints DEFAULT_TZ's wall clock, so the frozen 02:00 instant shows up as
 *  "2:00 AM" in UTC and as something else everywhere else. */
test('the process is in UTC — every ceiling below was measured there', () => {
  const args = argsFor({});
  args[7] = '';  // no stored agent_tz, so the clock falls back to DEFAULT_TZ like the timing block does
  const { tail } = buildSystemPromptSections(...args);
  const clockLine = tail.split('\n').find(l => l.startsWith("Right now it's")) ?? '';
  assert.match(
    clockLine, /2:00 AM/,
    `the frozen clock is ${new Date(FROZEN_MS).toISOString()}, but the current-time section renders `
    + `"${clockLine}" — this process is not in UTC, so the wall-clock sections measure a different `
    + 'length than the ceilings in promptPolicy.ts were taken at. Run the suite with TZ=UTC '
    + '(npm test does), or export TZ=UTC before tsx --test on this file alone.',
  );
});

test('the fixtures assemble the sections they claim to, and nothing is left unmeasured', () => {
  for (const f of FIXTURES) {
    const names = buildSystemPromptSections(...argsFor(f.spec)).sections.map(s => s.name);
    assert.deepEqual(names, f.sections, f.name);
  }
});

test('the measured sections still account for every character of the prompt', () => {
  // Task 1's arithmetic, reused rather than re-derived: if this fails, the budget below is measuring
  // a prompt whose parts no longer add up, and the ceilings mean nothing.
  for (const f of FIXTURES) {
    const { system, tail, sections } = buildSystemPromptSections(...argsFor(f.spec));
    assert.deepEqual(sectionsChars(sections), { system: system.length, tail: tail.length }, f.name);
  }
});

test('every section of every fixture is inside its budget', () => {
  for (const f of FIXTURES) {
    for (const s of buildSystemPromptSections(...argsFor(f.spec)).sections) {
      const ceiling = PROMPT_BUDGET[s.name];
      assert.ok(
        s.chars <= ceiling,
        `${f.name}: the ${s.name} section is ${s.chars} chars, over its ${ceiling}-char budget (promptPolicy.ts). It grew — shrink it, or ratchet the ceiling deliberately.`,
      );
    }
  }
});

test('the memory stack is inside its budget on every fixture that carries one', () => {
  for (const f of FIXTURES) {
    if (f.memoryStack === null) continue;
    const block = f.spec.contextBlock ?? '';
    assert.ok(block.includes(f.memoryStack), `${f.name}: the stack is really inside the context block`);
    assert.ok(
      f.memoryStack.length <= PROMPT_BUDGET.memory_stack,
      `${f.name}: the memory stack is ${f.memoryStack.length} chars, over its ${PROMPT_BUDGET.memory_stack}-char budget (promptPolicy.ts)`,
    );
  }
});

/** The window band fixtures 6, 7 and 8 exist to reach, asserted rather than assumed: a rewrite of
 *  DENSE_TEXTS that quietly fell under DRIFT_LONG_WINDOW_CHARS would leave `behavior_anchor`
 *  measured on the short variants again, and the ceiling would go stale in exactly the silent way
 *  those fixtures were added to stop.
 *
 *  ALL THREE MODES a long window can be in, because the anchor is picked on two axes and the ratchet
 *  only ever sees the maximum. Fixture 6 is the long TASK variant, fixture 7 the long HOOK one, and
 *  fixture 8 the long SHARE one — the widest of the eight (persona/policy.ts DRIFT_MODE_BULLETS: the
 *  share law says the most, because it has to state the guess-or-ask decision as well as the move),
 *  so it is the one the ceiling now stands on. The fourth law, quiet, is the narrowest of the four
 *  and is reached from a hook directive with every kind closed, which is why no fixture spends a
 *  window on it. Pinning the mode each fixture reaches, and not just the band, is what stops a later
 *  edit turning one of these directives into a task turn, or into a hook turn with every kind
 *  closed, and dropping the measurement to a narrower variant with every test here still green. */
test("the long-thread fixtures really are past the drift anchor's window band", () => {
  const cases: Array<[number, string, DriftMode]> = [
    [5, 'mature profile on a long thread', 'task'],
    [6, 'idle turn on a long thread', 'hook'],
    [7, 'share turn on a long thread', 'share'],
  ];
  for (const [i, name, mode] of cases) {
    const f = FIXTURES[i];
    assert.equal(f.name, name);
    const windowChars = (f.spec.history ?? []).reduce((n, m) => n + m.content.length, 0);
    assert.ok(
      windowChars >= DRIFT_LONG_WINDOW_CHARS,
      `${name}: the transcript is ${windowChars} characters, under the ${DRIFT_LONG_WINDOW_CHARS} band — the anchor renders its short variant and nothing here measures the wide one`,
    );
    const anchor = buildSystemPromptSections(...argsFor(f.spec)).sections.find(s => s.name === 'behavior_anchor');
    assert.equal(anchor?.chars, renderDriftAnchor(mode, windowChars).length, `${name}: the anchor it rendered is the long ${mode} variant`);
  }
});

/** The other silent-narrowing guard, the same shape as the one above it: `hooks` is a prose ceiling
 *  the live battery enforces, and the widest thing that section can hold is five moment lines at the
 *  render cap wearing the longest tag and the longest age phrase. A later edit that shortened one of
 *  those texts, or moved a stamp into a narrower age band, would leave the ceiling measured on a
 *  sample smaller than production can build — which is the same failure the `hooks` line already had
 *  once, and which no other test in this file would notice. */
test('the moment sample really is the widest one the renderer can build', () => {
  assert.equal(MOMENT_LINES.length, 5, 'five is MOMENT_SAMPLE_RECENT + MOMENT_SAMPLE_OLD');
  const widestAge = [...MOMENT_AGE_WORDS].sort((a, b) => b.length - a.length)[0];
  for (const [i, text] of MOMENT_TEXTS.entries()) {
    assert.equal(text.length, MOMENT_TEXT_MAX, `moment ${i} is not at the render cap`);
    assert.ok(MOMENT_LINES[i].includes(`(embarrassing, ${widestAge})`), `moment ${i} is not wearing the widest prefix`);
    assert.ok(MOMENT_LINES[i].endsWith(text), `moment ${i} was clamped, so it is not measuring the cap`);
  }
});

/** The largest each budget line reaches across the eight fixtures — the number its ceiling is meant to
 *  be a rounded-up copy of. `memory_stack` comes off the fixtures' own stacks because it is a part of
 *  `context_block` rather than a section of its own. */
function measuredMaxima(): Map<BudgetKey, number> {
  const max = new Map<BudgetKey, number>();
  const bump = (key: BudgetKey, chars: number) => max.set(key, Math.max(max.get(key) ?? 0, chars));
  for (const f of FIXTURES) {
    for (const s of buildSystemPromptSections(...argsFor(f.spec)).sections) bump(s.name, s.chars);
    if (f.memoryStack !== null) bump('memory_stack', f.memoryStack.length);
  }
  return max;
}

/** Budget lines whose bytes come from the host rather than from this tree, so their ceilings are
 *  deliberately loose (promptPolicy.ts states the same exemption beside each). */
const HOST_DEPENDENT: ReadonlySet<BudgetKey> = new Set<BudgetKey>(['model_map', 'update_status']);

/** How much a ceiling may sit above its measurement: enough to round to a tidy number, not enough to
 *  hide a new block. Stated as a fraction so the big prose lines are held tightest in absolute terms,
 *  which is where an unnoticed arrival would cost the most. */
const MAX_HEADROOM = 0.02;

test('no ceiling carries more than 2% of headroom over what the fixtures measure', () => {
  // The other half of the ratchet, and the half that had no test: the budget above only fails when a
  // section GROWS past its ceiling, so a phase that deletes 3k characters of prose leaves the ceiling
  // where it was and the next arrival lands in the slack for free. This fails instead — a deletion
  // now has to pull its own number down in the same commit, which is the "tightening is a one-line
  // diff" the module was built for.
  //
  // `model_map` and `update_status` are exempt, for the reason promptPolicy.ts gives beside them:
  // their text is built from the host — the resolved model map in one, the running build's sha and
  // branch in the other — so a bare checkout and a configured install measure different sizes and a
  // tight ceiling would fail on somebody else's machine. Every other line is deterministic here —
  // fixture data, repo prose, or the frozen clock.
  const measured = measuredMaxima();
  const rows: string[] = [];
  const loose: string[] = [];
  for (const [key, chars] of [...measured].sort((a, b) => b[1] - a[1])) {
    const ceiling = PROMPT_BUDGET[key];
    const headroom = (ceiling - chars) / chars;
    rows.push(`  ${key}: measured ${chars}, ceiling ${ceiling} (+${(headroom * 100).toFixed(1)}%)`);
    if (HOST_DEPENDENT.has(key)) continue;
    if (headroom > MAX_HEADROOM) loose.push(key);
  }
  assert.deepEqual(
    loose, [],
    `these ceilings are cushions rather than measurements — ratchet them down in promptPolicy.ts:\n${rows.join('\n')}`,
  );
});

test('the live conversation keeps its share of the context on a mature turn', () => {
  const f = FIXTURES[1];
  assert.equal(f.name, 'mature profile, plain question');
  const prompt = buildSystemPromptSections(...argsFor(f.spec));
  const messages = messagesFor(f);
  assert.equal(messages.length, 41, 'the 40-row window plus this turn');
  const share = transcriptShare(prompt, messages);
  assert.ok(
    share >= MIN_TRANSCRIPT_SHARE,
    `the transcript is ${share} of the prompt, under the ${MIN_TRANSCRIPT_SHARE} floor (promptPolicy.ts) — the scaffolding grew around the conversation`,
  );
});

test('the transcript floor sits a hair under the measured share, not a phase behind it', () => {
  // The ratchet running the other way, and the same argument as the 2% above: a floor left at an old
  // measurement no longer notices the scaffolding creeping back, because the share can fall by
  // everything the last phase won and still clear it. Same band, read downwards.
  const f = FIXTURES[1];
  assert.equal(f.name, 'mature profile, plain question');
  const share = transcriptShare(buildSystemPromptSections(...argsFor(f.spec)), messagesFor(f));
  assert.ok(
    MIN_TRANSCRIPT_SHARE >= share * (1 - MAX_HEADROOM),
    `the transcript measures ${share} on ${f.name} but the floor stands at ${MIN_TRANSCRIPT_SHARE} — raise it (promptPolicy.ts) so the share the last phase bought is the share that is held`,
  );
});

test('every budget line was measured on a fixture, so no ceiling is invented', () => {
  const seen = new Set<BudgetKey>(FIXTURES.flatMap(f => buildSystemPromptSections(...argsFor(f.spec)).sections.map(s => s.name)));
  if (FIXTURES.some(f => f.memoryStack !== null)) seen.add('memory_stack');
  for (const key of Object.keys(PROMPT_BUDGET) as BudgetKey[]) {
    assert.ok(seen.has(key), `PROMPT_BUDGET.${key} has a ceiling but no fixture renders it — measure it or drop the line`);
  }
  for (const id of SECTION_IDS) {
    assert.ok(id in PROMPT_BUDGET, `the ${id} section has no budget line`);
  }
});

test('a default install adds no weather and no thread — the no-regression pin', () => {
  // The two features that render nothing until something has actually happened: no computed state
  // (so no internal weather), a default climate, and an empty thread inventory. That is the shape an
  // install where neither feature ever engaged assembles — and the pin is stronger than "no section
  // was pushed": handing the assembler a default climate and an empty inventory must produce the
  // SAME BYTES as never passing them at all, which is what makes both features free until used.
  const base: TurnSpec = {
    chatContext: { isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE, senderProfile: MATURE_PROFILE },
    contextBlock: contextBlockWith(MATURE_STACK),
    tools: TOOLS_1TO1,
    history: HISTORY_12,
    incomingText: MATURE_TURN_TEXT,
    turnFocus: { text: MATURE_TURN_TEXT, hits: [] },
  };
  const dormant = buildSystemPromptSections(...argsFor({
    ...base, climate: defaultClimate(), thread: { offer: null, outcomeAsk: null },
  }));
  const names = dormant.sections.map(s => s.name);
  assert.ok(!names.includes('weather'), 'no computed state and a default climate render no weather block');
  assert.ok(!names.includes('thread'), 'an empty thread inventory renders no thread block');

  const neverHadThem = buildSystemPromptSections(...argsFor(base));
  assert.equal(dormant.system, neverHadThem.system, 'a dormant climate and inventory cost the prompt nothing');
  assert.equal(dormant.tail, neverHadThem.tail, 'and nothing in the tail either');
});
