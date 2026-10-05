// The Convo system prompt, named by section.
//
// buildSystemPromptSections (agents/convo/shared.ts) assembles the front-line prompt out of a fixed
// vocabulary of parts; this module owns their NAMES, the type derived from those names, and the
// arithmetic that turns a measured section list back into the assembled length. Nothing here renders
// anything or knows what a section says — it is deliberately tiny and near dependency-free (one
// import, for the wrapper tag) so the per-turn trace and the prompt-budget test can measure the
// prompt without importing the 1.7k-line assembler.

import { PROMPT_TAG } from '../../llm/promptTag.js';

/**
 * The sections assembled INSIDE a `<prompt>…</prompt>` block, in the exact order the assembler emits
 * them. The prompt is TWO messages now (see SYSTEM_SECTION_NAMES below), and this list is both of
 * their blocks back to back: the four sections that are stable for the whole chat first — they ride
 * the system message — then every per-turn section, which rides the tail message placed after the
 * chat history. The order is load-bearing three times over: charter §11.3's placement rule (static
 * first, volatile per-turn data last) IS this order, the prefix cache only reaches history when the
 * system half holds nothing that moves between turns, and the size arithmetic below counts the
 * `\n\n` joins between whichever sections of each half actually rendered. Every entry is
 * conditional except `model_map`, `update_status` and `current_time`, so a real build carries a
 * subsequence of this list, never all of it.
 *
 * A new section is per-turn unless it is added to SYSTEM_SECTION_NAMES, and it takes its place in
 * the per-turn run wherever its push site sits.
 *
 * `turn_focus` is last on purpose and must STAY last: it restates the message the whole prompt is
 * there to answer, and the recency edge is what makes it a counterweight rather than one more voice
 * in the pile (convo/turnFocus.ts). A new section belongs before it, never after.
 */
export const DYN_SECTION_IDS = [
  // ── the system message's block: stable for the chat ──
  'tool_docs',            // renderToolDocs — under toolsViaJson, the model's only view of its tools
  'capability',           // renderCapabilityLine — what the deep look can do this deployment
  'model_map',            // renderModelMapAwareness — unconditional
  'group',                // "Group chat"
  // ── the tail message's block: this turn ──
  'craft_modules',        // renderCraftModules — the persona pages this turn structurally needs
  'update_status',        // renderUpdateStatus — unconditional
  'name_nudge',           // "Getting their name" — no name on file yet
  'intro_weave',          // the one-shot install introduction (agents/ops/firstMove.ts)
  'context_block',        // buildContextBlock — the dossier plus the wrapped memory tiers
  'thesis',               // her one read on this person (memory/thesisEngine.ts) — '' until it exists
  'self',                 // what SHE holds with this person (memory/selfHarvest.ts) — '' until it exists
  'active_ops',           // renderActiveOps — research already running for this chat
  'owed',                 // renderOwedSection — what her mood put off and still owes them
  'recent_beats',         // renderRecentBeats — her own last few holding beats, to steer off
  'live_reminders',       // renderLiveReminders — their reminders on the engine, each with its id
  'tapped_reply',         // whichever ONE of the four ResolvedReply kinds rendered
  'burst',                // the numbered incoming messages of a burst
  'current_time',         // unconditional
  'weather',              // renderStatusForPrompt — affect + cycle/circadian + climate
  'status_contract',      // renderStatusContract — the hidden envelope's fields, where weather points
  'thread',               // renderThreadForPrompt — the one standing thread on offer
  'conversation_timing',  // renderConversationTiming
  'reply_order',          // renderArrivalGap OR renderReplyOrder — never both
  'unsend',               // the bubbles an unsend can reach — only on a turn the tool is offered
  'checkin',              // the back-off's open ask — only on the turn after an unanswered check-in
  'extra',                // the caller's addendum (`extraSection`)
  'hooks',                // renderHooksSection — this turn's rhythm contract; '' on a task turn
  'turn_focus',           // renderTurnFocus — LAST, always: what they just said and what touches it
] as const;

/**
 * The dyn sections that ride the SYSTEM message, behind the persona — the ones whose bytes are the
 * same on every turn of one chat, and only those. The system message is the head of every request's
 * prefix, so one byte in it that moves between turns re-bills the whole chat history behind it; the
 * prefix cache reaches history only when nothing here can.
 *
 * What qualifies is decided by what a section READS, not by how big it is: the tool list (which
 * varies with group state, i.e. per chat), the deployment's capability summary, the resolved model
 * map, and the group's own name and roster. Everything else is per-turn by construction and rides
 * the tail message after history — including the three that look stable and are not: the craft pages
 * (their gates fire off this turn's shape), the update status (the checker can answer mid-chat), and
 * the dossier (a memory write rewrites it).
 */
export const SYSTEM_SECTION_NAMES: ReadonlySet<string> = new Set<DynSectionId>(['tool_docs', 'capability', 'model_map', 'group']);

/**
 * Every part of the assembled prompt, in reading order: the static persona head and the system
 * message's dyn sections, then the tail message's dyn sections and the two anchors that close it after
 * its `</prompt>`. The persona and the anchors are not dyn sections — they frame the blocks rather
 * than living in one — but they are the biggest costs in the prompt, so the budget test needs them
 * named and measured too.
 */
export const SECTION_IDS = ['persona', ...DYN_SECTION_IDS, 'behavior_anchor', 'json_anchor'] as const;

export type DynSectionId = typeof DYN_SECTION_IDS[number];
export type SectionId = typeof SECTION_IDS[number];

/** One measured part of the assembled prompt. Names and NUMBERS only, never prompt text — this
 *  shape travels into the turn trace, which persists. */
export interface PromptSection {
  name: SectionId;
  chars: number;
}

const DYN_IDS: ReadonlySet<string> = new Set(DYN_SECTION_IDS);

/** True for a section that lives inside `<prompt>…</prompt>` — and therefore pays a `\n\n` join to
 *  each neighbour — rather than framing the block. */
export function isDynSection(name: SectionId): name is DynSectionId {
  return DYN_IDS.has(name);
}

/** True for a part of the SYSTEM message — the persona head and the chat-stable dyn sections behind
 *  it. Everything else is in the tail message. */
export function isSystemSection(name: SectionId): boolean {
  return name === 'persona' || SYSTEM_SECTION_NAMES.has(name);
}

/** The one separator the assembler uses, between every pair of adjacent parts: `\n\n`. */
const SEPARATOR_CHARS = 2;

/** What wrapPrompt puts AHEAD of a dyn block: `<prompt>\n`. Its own constant because it is also the
 *  distance from the start of a block to its first section, which is how a test finds one by offset.
 *  Derived from PROMPT_TAG, so renaming the tag re-measures instead of drifting. */
export const PROMPT_WRAPPER_OPEN = `<${PROMPT_TAG}>\n`.length;

/** The fixed cost of wrapPrompt around a dyn block: `<prompt>\n` ahead of it, `\n</prompt>` after. */
export const PROMPT_WRAPPER_CHARS = PROMPT_WRAPPER_OPEN + `\n</${PROMPT_TAG}>`.length;

/**
 * The two message lengths a measured section list implies — the exhaustiveness check, and the one
 * place the prompt's separator overhead is written down.
 *
 * The assembled prompt is two strings:
 *   system = `${persona}\n\n${wrapPrompt(stable.join('\n\n'))}`
 *   tail   = `${wrapPrompt(perTurn.join('\n\n'))}\n\n${behaviorAnchor}\n\n${anchor}`
 * so the overhead on top of the section texts themselves is exactly, for each half:
 *   • one `\n\n` between each pair of that half's dyn sections that RENDERED — `max(0, n - 1)` of
 *     them, since a section that rendered to nothing was never pushed and pays no join;
 *   • PROMPT_WRAPPER_CHARS for its `<prompt>` wrapper (a half with no dyn sections at all still pays
 *     it — wrapPrompt('') is `<prompt>\n\n</prompt>`, and the arithmetic gets that right because the
 *     wrapper's own two newlines are its opening and closing ones);
 *   • its frame joins: one `\n\n` after the persona in the system, two in the tail (after the block,
 *     and between the two anchors).
 *
 * Exact so long as every dyn section's text is already trimmed: wrapPrompt trims the JOINED body, so
 * a leading blank line on the first rendered section (or a trailing one on the last) would be
 * dropped from the message yet still counted here. Every renderer returns trimmed text today —
 * renderActiveOps, the one that doesn't, is `.trim()`ed at its push site — and
 * promptSections.test.ts pins that invariant so this stays arithmetic rather than an estimate.
 */
export function sectionsChars(sections: readonly PromptSection[]): { system: number; tail: number } {
  const half = (inSystem: boolean, frameJoins: number) => {
    const own = sections.filter(s => isSystemSection(s.name) === inSystem);
    const body = own.reduce((total, s) => total + s.chars, 0);
    const dynCount = own.reduce((n, s) => n + (isDynSection(s.name) ? 1 : 0), 0);
    return body + (Math.max(0, dynCount - 1) + frameJoins) * SEPARATOR_CHARS + PROMPT_WRAPPER_CHARS;
  };
  return { system: half(true, 1), tail: half(false, 2) };
}

/**
 * Where each cache-reusable prefix of the system message ENDS, as character offsets in ascending
 * order — what the Anthropic lane splits `system` at (llm/callLLM.ts buildAnthropicSystem):
 *   1. the static persona head, which is stable for the life of the deployment;
 *   2. the end of the system message itself, which is stable for the life of the chat — the tail is
 *      never in it, so the whole string is a prefix the next turn repeats byte for byte.
 *
 * Derived from the section list the assembler already returned — the same arithmetic as
 * `sectionsChars` — so nothing is re-measured, no text is re-joined, and an offset can never disagree
 * with the string it indexes into. No persona measured, no breakpoints: a caller that declares none
 * gets the lane's whole-system shape.
 */
export function promptCacheBreakpoints(sections: readonly PromptSection[]): number[] {
  const personaChars = sections.find(s => s.name === 'persona')?.chars ?? 0;
  if (personaChars <= 0) return [];
  return [personaChars, sectionsChars(sections).system];
}
