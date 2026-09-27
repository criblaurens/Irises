// Routing floor. Convo decides on its own whether to delegate to Ops; when it answers a data
// question ITSELF from general knowledge (no delegation), that answer bypasses Ops' grounding
// backstop entirely — the one fabrication path nothing else catches. Whether a message needs reach
// she lacks is judged by a model (convo/reachClassify.ts), because wording is no guide to it and a
// word list read one language only. needsGrounding keeps the two signals that read STRUCTURE, not
// wording, and so need no judge: a link, and a filesystem path with an ask around it.

// Type-only (erased at runtime): this module stays dependency-free so the gate's regexes can be
// unit-tested without dragging the engine adapters into the process. The one runtime import is
// llm/promptTag.js, which has no imports of its own.
import type { CapabilityClass } from './ops/engineBackend.js';
import { dataTag, neutralizeTagBreakouts } from '../llm/promptTag.js';

export type GroundingNeed = 'yes' | 'no' | 'maybe';

// A URL anywhere is a strong signal the message wants something read/looked up (not answered from
// general knowledge) — the domain-neutral analogue of the old street-address short-circuit.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/i;

// The inspection verbs the path screen's ask reads. A weak Convo model aimed at one
// of these either guesses at what it would have found or falsely refuses ("that's local to your
// machine") — the engine runs ON that machine and has the file tools, so both are wrong answers.
const INSPECT = String.raw`(?:check|peek|look|list|read|show|open|browse|inspect|scan|ls)`;
// A concrete filesystem path the user NAMED — "~/.hermes/skills", "/var/log/nginx", "./src". The
// domain-neutral analogue of the URL rule: someone who types a real path wants it READ, and only the
// engine (which runs on that machine, with the file tools) can read it. Two signals AND'd, so a
// path mentioned in passing ("i dropped it in ~/Documents yesterday") stays local.
// Precision: the token must START a word (whitespace / quote / bracket / message start), so
// "and/or", "read/write", "8/22" and "50/50" can't look like paths; an absolute path needs TWO
// segments, so a stray "/" or a slash-command ("/help") isn't one.
const PATH_TOKEN = /(?:^|[\s"'`([])(?:~\/[\w.-]+|\.{1,2}\/[\w.-]+|\/[\w.-]+\/[\w.-]+)/;
// The ask wrapped around that path: a question, a "can you", a please, or an inspection/naming verb.
const PATH_ASK = new RegExp(String.raw`\?|\b(?:can|could|would|will|do) (?:you|u|ya)\b|\bplease\b|\b(?:${INSPECT}|cat|name|tell me|what|which|where|any)\b`, 'i');

export function needsGrounding(text: string): GroundingNeed {
  const t = (text || '').trim();
  if (t.length < 4) return 'no';
  if (URL_RE.test(t)) return 'yes';                                  // a link to read always wins
  if (PATH_TOKEN.test(t) && PATH_ASK.test(t)) return 'yes';          // "what's in ~/.hermes/skills?"
  return 'no';
}

// ── Draft salvage for a delegation turn ─────────────────────────────────────────────────────────
// When a turn delegates to Ops, the model's direct draft can't ship as-is (any RESULT it wrote is
// un-grounded — Convo is single-shot and never sees the tool output). But the draft usually carries
// Irises's own genuinely human holding beat ("hmm", "pulling the comps on 412 Maple now") — and per
// user directive that voice must SHIP whenever it's safe, never be replaced by a generated line. So:
// keep ONE beat, the first bubble that holds the line, and cut at the first bubble that asserts an
// outcome or carries a figure the user themselves didn't say. One, because the handoff beat is one
// bubble by persona design, and because every bubble kept beside it is one more place for a claim to
// ride. Only when no beat survives does the caller fall to the Fallfirm-voiced line — Fallfirm is
// the fallback, never the override.

// A bubble that CLAIMS something happened / was found (or not found) — the fabrication surface.
const CLAIMS_RESULT = /\b(pulled|checked|searched|scanned|went through|found|surfaced|came (?:up|back)|turned up|shows?|says?|looks like|according to|no (?:results?|matches?|luck|record)|nothing (?:surfaced|came|found|matched|there)|couldn'?t find|didn'?t (?:find|see)|there'?s (?:no|nothing)|don'?t have)\b/i;

// A bubble that reads like an in-progress holding line or a still-on-it reassurance — future/
// progressive, no outcome. Mirrors the persona's own example range ("scanning your inbox now",
// "back in a bit", "almost there", "hang tight", "on it").
const HOLDING_LIKE = /\b(one sec|a sec|one more sec|hang on|hang tight|hold on|lemme|let me|gimme|give me|checking|pulling|digging|grabbing|running|scanning|searching|finding|combing|fetching|chasing|tracking down|working on|going through|looking (?:into|up|at|through)|on it|still (?:on|at|working|going)|almost (?:there|done)|back in a (?:bit|sec|min|minute|few)|be right back|won'?t be long|coming (?:up|right up))\b/i;

// A beat that is nothing BUT a thinking sound or a nod ("hmm", "mmm", "ok bet", "hmm 🤔", "hmm...")
// — one of the beat's own shapes, and a whole holding beat on its own. The WHOLE bubble has to be
// sounds and separators: a word count lets a short result ride in on an ack ("ok, done", "yeah it
// closed", "got it, booked"), and every word past the sound is where the claim lives.
const BEAT_SOUND = String.raw`(?:hm+|mm+|um+|uh+|oh+|ooh+|ok(?:ay)?|kk+|bet|gotcha|got it|say less|sure(?: thing)?|alright)`;
const BEAT_SEP = String.raw`[\s,.!…~\p{Extended_Pictographic}\u{FE0F}]`;
const ACK_BEAT = new RegExp(`^${BEAT_SEP}*${BEAT_SOUND}(?:${BEAT_SEP}+${BEAT_SOUND})*${BEAT_SEP}*$`, 'iu');

// A short acknowledgment/empathy opener in front of the beat ("okay that's a real question", "oof,
// the martinez file again", "you're welcome!") — stepped over on the way to the beat, never kept:
// an opener that says more than a sound can carry a claim ("ok, done") that no screen here reads.
// Anchored to interjection openers so a lowercase ASSERTION ("the owner is the delgado trust")
// can't be stepped over as an "ack" to reach the beat behind it.
const ACK_LIKE = /^(?:ok(?:ay)?|kk+|oo+f+|ugh+|ha(?:ha)*|heh+|lol|hm+|oh+|ooh+|whew|sheesh|yeah|yep|yes|sure(?: thing)?|alright|all right|right|fair(?: enough)?|good (?:one|question|call|shout)|got it|gotcha|nice|solid|bet|say less|no worries|no problem|np|of course|absolutely|honestly|anytime|my pleasure|you'?re welcome|welcome|love (?:it|that))\b/i;
const ACK_MAX_WORDS = 8; // an ack is a beat, not a paragraph — anything longer isn't one

// Digit-runs in `text` (e.g. "412", "410000" from "$410,000") — the unit of the grounding check.
const digitRuns = (text: string): string[] => (text.match(/\d+/g) ?? []).map(r => r.replace(/^0+(?=\d)/, ''));

/**
 * Keep the human part of a delegation-turn draft: its ONE holding beat, the first bubble that is
 * holding-like or nothing but a sound/nod (ACK_BEAT), in the legacy `\n---\n` wire format in and out.
 * Short ack openers before it are stepped over and dropped; anything else before it ends the search.
 *
 * `ground` is the user's OWN words for this ask (their message + address/deal hints): a figure the
 * user themselves said ("comps on 412 Maple" → "pulling comps on 412 Maple now") is an echo, not a
 * fabrication, so it survives; any digit NOT in the ground still ends the salvage. With no ground,
 * every figure breaks (the old conservative behavior).
 *
 * Returns null when no bubble holds the line: a draft that is only a reaction salvages nothing and
 * the voiced fallback line takes over.
 */
export function salvageHoldingText(legacyText: string | null, ground?: string): string | null {
  if (!legacyText) return null;
  const groundRuns = ground ? digitRuns(ground) : [];
  for (const bubble of legacyText.split(/\n---\n/).map(b => b.trim()).filter(Boolean)) {
    if (CLAIMS_RESULT.test(bubble)) return null;    // an asserted outcome — the un-grounded part
    if (bubble.includes('?')) return null;          // a question isn't a holding line
    // Figures: safe only when every digit-run is an echo of the user's own ask.
    const runs = digitRuns(bubble);
    if (runs.length && (bubble.includes('$') || !runs.every(r => groundRuns.some(g => g.includes(r))))) return null;
    if (HOLDING_LIKE.test(bubble) || ACK_BEAT.test(bubble)) return bubble;
    if (!(ACK_LIKE.test(bubble) && bubble.split(/\s+/).length <= ACK_MAX_WORDS)) return null; // neither a beat nor a short opener — stop rather than guess
  }
  return null;
}

// ── False-capability-refusal screen ─────────────────────────────────────────────────────────────
// The other half of the same live failure the gate above catches. `needsGrounding` reads the USER's
// message; these two read the MODEL's DRAFT. A weak Convo model, handed a request it could have
// delegated, sometimes writes a flat "no can do from here, that path is local to your machine"
// instead — while an engine WITH the file tools is attached, running on that very machine. Nothing
// else in the pipeline inspects reply text for refusal language: a gate-'yes' turn can't refuse (the
// gate discards the draft), but every phrasing the gate's regexes don't reach ships the refusal.
//
// The two functions split cleanly: `refusalLike` asks "is this an ABILITY refusal at all?" and
// `refusedCapabilities` asks "refusing WHAT, in the engine's own vocabulary?". Only the intersection
// with what the engine can actually do is a false refusal — an honest one (no engine, no inbox
// connected) must survive untouched, so the subject map is the precision half of the pair.

// Ability negations only. A POLICY refusal ("i won't", "i shouldn't", "i'd rather not") is a choice
// Irises is allowed to make and is deliberately excluded — this floor exists for claims of
// IMPOSSIBILITY, which are the ones that are factually wrong when the engine has the tool.
const NO_ABILITY = String.raw`(?:can'?t|cannot|can\s+not|unable to|not able to|no way (?:for me )?to|(?:don'?t|do not) have (?:a |any )?way to|there'?s no way (?:for me )?to)`;

// The closed access-verb list — the verbs that name REACHING something (a file, a mailbox, the web,
// a photo). Kept closed on purpose: an open "can't <verb>" would swallow every ordinary inability
// ("can't promise", "can't tell you why") and turn the floor into an over-delegation machine.
const ACCESS_VERB = String.raw`(?:get (?:to|at|into)|see|view|reach(?: into)?|access|open|read|check|browse|look (?:at|into|in|through)|list|peek|pull up|dig (?:into|through|around)|go through|run|scan|inspect|fetch|retrieve)`;

// The closed SETUP-verb list, kept apart from the access verbs above because it names a different
// thing: preparing the deep look's own side for a job rather than reaching something that already
// exists. Live 2026-09-19, a refusal built on exactly these verbs ("can't install a skill on my
// side") scored zero on the access shapes and shipped as written. Closed for the same reason the
// access list is: an open "can't <verb>" would swallow every ordinary inability. The loosest member
// is `add`, which on its own reaches a fair number of harmless sentences — it is affordable only
// because this list is half of a two-part screen: a shape matched here still has to name a subject
// the class map recognises, and the floor still has to find that class on the live engine.
// The split particle ("set that up", "hook it up") is the common spoken form and gets one word.
const SETUP_VERB = String.raw`(?:install|set ?up|set [\w']+ up|add|configure|enable|hook ?up|hook [\w']+ up|wire ?up)`;

// Words that must never sit between the negation and an access verb: they turn a refusal shape into
// an idiom with the opposite meaning ("can't WAIT to see the photos", "can't BELIEVE what i'm
// seeing", "can't GO wrong"). Screened at every position in the window, so "can't really wait to
// see" is caught as well as the bare form.
const NOT_REFUSAL_WORD = String.raw`(?:wait|believe|be|go|help|stand|imagine|thank|argue|deny|stop|resist|hardly)`;
// Up to three plain words between the negation and its verb ("can't actually get to", "cannot
// directly access"). Zero words is the common case ("can't see"). Punctuation ends the window, which
// is what keeps "i can't. see, the thing is…" out.
const ABILITY_GAP = String.raw`(?:\s+(?!${NOT_REFUSAL_WORD}\b)[\w']+){0,3}\s+`;

// Access-refusal shapes. Anchored on ability (never policy) and, where a verb is involved, on the
// closed list above. Every one of these was either observed live or is a one-word variant of a
// phrasing that was.
const REFUSAL_LIKE: RegExp[] = [
  // The observed opener, verbatim. On its own it says nothing about WHAT is refused — that is
  // refusedCapabilities' job, which is why "no can do, i'm slammed today" scores zero classes.
  /\bno can do\b/i,
  // "can't do that from here" / "…from my end" — a refusal that names the boundary rather than a verb.
  new RegExp(String.raw`\b${NO_ABILITY}\s+do (?:that|this|it|any of that|much (?:here|there))\b[^.!?\n]{0,24}?\bfrom (?:here|my end|my side|this end|where i (?:am|sit))\b`, 'i'),
  // "that path is local to your machine" — the observed justification, which is FALSE for an engine
  // that runs on that machine.
  /\b(?:local|localized|only) to your (?:machine|computer|end|side|box|laptop|system|device|filesystem)\b/i,
  // Negated ability aimed at an access verb: "can't get to your downloads", "unable to read that file".
  new RegExp(String.raw`\b${NO_ABILITY}\b${ABILITY_GAP}\b${ACCESS_VERB}\b`, 'i'),
  // The same claim in noun form: "that's not something i can open", "nothing i can reach from here".
  new RegExp(String.raw`\b(?:not something|nothing) i can\b${ABILITY_GAP}\b${ACCESS_VERB}\b`, 'i'),
  // The setup shapes, in both forms: "can't install a skill on my side", "nothing i can set up here".
  new RegExp(String.raw`\b${NO_ABILITY}\b${ABILITY_GAP}\b${SETUP_VERB}\b`, 'i'),
  new RegExp(String.raw`\b(?:not something|nothing) i can\b${ABILITY_GAP}\b${SETUP_VERB}\b`, 'i'),
  // Flat claims of blindness. "eyes"/"visibility" are the persona-shaped variants a chatty model
  // reaches for when it doesn't want to say "access".
  /\b(?:don'?t|do not) have (?:any |direct |the )?(?:access|eyes|visibility|a view|the ability to (?:see|read|reach|access|open))\b/i,
  /\bno access to\b/i,
  // "that's outside my reach", "beyond what i can reach".
  /\b(?:outside|beyond)(?: of)? (?:my reach|what i can (?:reach|see|access|get to))\b/i,
];

/**
 * Does this draft claim an INABILITY to reach something? The screen, not the verdict — a true refusal
 * of something the engine genuinely can't do also matches here, and is filtered out downstream by
 * intersecting `refusedCapabilities` with the engine's real capability summary. Pure.
 */
export function refusalLike(text: string | null | undefined): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return REFUSAL_LIKE.some(re => re.test(t));
}

// The subject vocabulary: the words a refusal uses for each capability class. Deliberately narrow —
// a class named here that the engine HAS forces a delegation, so a sloppy map over-delegates, while a
// gap only means the refusal ships as written (the pre-floor status quo). MUST stay in CAP_ORDER
// order (web, inbox, files, code, media, scheduling): this array IS the canonical ordering for the
// returned list, kept local so the module needs no runtime import of the engine seam.
const SUBJECT_VOCAB: ReadonlyArray<readonly [CapabilityClass, RegExp]> = [
  ['web', /\b(?:the web|the internet|online|a website|websites?|web ?pages?|urls?|links?|browse the web|search the web|google(?: it)?|look(?:ing)? (?:it |that )?up online)\b/i],
  ['inbox', /\b(?:inbox|e-?mails?|mailbox|gmail|outlook|mail account|your mail)\b/i],
  ['files', /\b(?:files?|filenames?|folders?|subfolders?|directory|directories|dirs?|disk|filesystem|file system|drive|downloads|desktop|documents|paths?|repo|repository|codebase|machine|computer|laptop|locally|local)\b/i],
  // Setting something up on the deep look's own side is work it does with its own code, so the
  // subject words for it belong here — a skill or a plugin it installs for itself, and the setup
  // verbs aimed at one. "a host action" is the justification the live refusal reached for, and it is
  // as false as "local to your machine": the deep look IS that host.
  //
  // "tool" is deliberately absent from both the determiner branch and the setup-verb branch: its
  // everyday senses survive either anchor ("set up a tool shed quote", "the best tool for cutting
  // tile"), and a class named here that the engine HAS force-delegates the turn. It counts only
  // when the sentence says the tool is the engine's OWN, which is the shape this class is about.
  ['code', /\b(?:run (?:code|a script|commands?)|execute|scripts?|the terminal|a terminal|shell|bash|command line|host action|(?:a|an|the|your|my|its|another|new|own) (?:skill|plugin|package|dependency|mcp server)s?|(?:install|set ?up|set [\w']+ up|add|configure|enable)(?:\s+[\w']+){0,2}\s+(?:skills?|plugins?|packages?|dependenc(?:y|ies)|clis?)|tools?\s+(?:for|on)\s+(?:yourself|itself))\b/i],
  ['media', /\b(?:photos?|pictures?|images?|videos?|audio|voice ?memos?|recordings?|screenshots?|pdfs?|attachments?)\b/i],
  ['scheduling', /\b(?:reminders?|remind you|an alarm|schedule (?:that|it|a)|automations?)\b/i],
];
// A named filesystem path in the refusal is 'files' on its own — "no can do, ~/.hermes/skills is
// local to your machine" carries the class in the token, not in a noun.
const PATH_SHAPE = /(?:^|[\s"'`([])(?:~\/|\.{1,2}\/[\w.-]|\/[\w.-]+\/[\w.-])/;

/**
 * WHICH capabilities a draft refuses, in the engine's own closed vocabulary — `[]` when the draft
 * isn't an ability refusal at all, or when it refuses nothing this system has a name for.
 *
 * Subject resolution is draft-first, ask-second: the refusal usually names its own subject ("that
 * path is local to your machine" → files), but a bare "no can do" carries none, and then the user's
 * message supplies it ("what's in my downloads folder" → files). A refusal with no subject in EITHER
 * — the social "no can do, i'm slammed today" — returns `[]` and is left completely alone, which is
 * the single most important negative case here: Irises is allowed to decline things.
 *
 * Pure. The caller intersects the result with what the engine can actually do; a refusal of something
 * genuinely unavailable (no engine, inbox not connected) survives that intersection as honest.
 */
export function refusedCapabilities(draft: string | null | undefined, inbound?: string | null): CapabilityClass[] {
  if (!refusalLike(draft)) return [];
  const fromDraft = subjectClasses(draft || '');
  // The ask is the fallback ONLY — a draft that names its own subject is never widened by the
  // user's wording, so "no can do, your inbox isn't connected" can't pick up 'files' from an
  // unrelated sentence in the ask.
  return fromDraft.length ? fromDraft : subjectClasses(inbound || '');
}

function subjectClasses(text: string): CapabilityClass[] {
  const path = PATH_SHAPE.test(text);
  return SUBJECT_VOCAB
    .filter(([cls, re]) => re.test(text) || (cls === 'files' && path))
    .map(([cls]) => cls);
}

// ── What she already holds, at the Convo→Ops boundary ───────────────────────────────────────────
// The third half of the same live failure, from the 2026-09-03 correspondence run. Asked "how many
// days till dana's wedding again", Convo answered "39 days / oct 12, you're doing the toast" — read
// straight off a held note. `needsGrounding` said 'yes' (the message says "how many"), so the gate
// discarded that answer and force-delegated; the engine, which holds none of her memory, came back
// with "which dana is this?".
//
// Both halves of that are the same blind spot: the gate reads TEXT and never asks what she is
// holding. So there are two questions here, and they take the same hit list:
//
//   • `holdsTheAnswer` — may the gate stand down? Only when something she HOLDS touches the ask
//     AND she actually wrote an answer off it.
//   • `heldMemoryBrief` — when a delegation does happen (the gate's, or the model's own
//     `delegate_to_ops`), what does the engine need so it can't ask "which dana": her own words for
//     the thing, as data, in the task's own `heldMemory` field and never inside the brief.
//
// PURE, and the hits are read STRUCTURALLY (see HeldHit) so this module keeps its dependency-free
// property — the turn relevance router that produces them lives in memory/relevance.ts and pulls in
// the whole memory stack behind it.

/**
 * The hit kinds that count as something she HOLDS about the ask. The memory channels, and only
 * those: a `directive` is a standing instruction about HOW she answers and a `thread` is a
 * conversational offer the engine picked for this turn — neither is data an answer could have come
 * off, so neither may stand the gate down or go into the brief as something she knows.
 */
export const HELD_MEMORY_KINDS = ['note', 'fact', 'long', 'research', 'email'] as const;

/** One hit off the turn relevance router (memory/relevance.ts), as this module reads it: which
 *  channel it came off, what it is CALLED (bounded — this is what the receipt carries), and the held
 *  text itself (unbounded — this is what the engine is handed). Both are needed because they differ
 *  where it matters most: a long-doc section's label is its heading alone, and "Family" tells a
 *  reader who holds none of her memory nothing at all. Structural on purpose — `kind` is a plain
 *  string, so the router's vocabulary stays the router's. */
export interface HeldHit {
  kind: string;
  label: string;
  text: string;
}

/**
 * Which way the gate went, on every turn it was evaluated on. Disjoint buckets, single-sourced
 * array → type (the THEME_KINDS pattern), so a scan of the ring can bucket a month of turns:
 *  - `not_needed` — the message needed no grounding, or a fresh look already answered it;
 *  - `skipped_in_flight` — the same ask is already running, so the gate left it alone;
 *  - `skipped_memory_hit` — she held something about it and answered off that (the new bucket);
 *  - `delegated` — the gate fired and the draft was discarded for a real look.
 */
export const ROUTING_GATE_DECISIONS = ['delegated', 'skipped_memory_hit', 'skipped_in_flight', 'not_needed'] as const;
export type RoutingGateDecision = typeof ROUTING_GATE_DECISIONS[number];

/** The hits that are memory she holds, named — the shared subject of both questions below. */
function heldMemory(hits: readonly HeldHit[]): HeldHit[] {
  return hits.filter(h => (HELD_MEMORY_KINDS as readonly string[]).includes(h.kind) && h.label.trim());
}

/**
 * May the gate stand down and let her own answer ship? Only on the conjunction the live failure
 * needed and no weaker one:
 *   • something she holds touches the ask — a real hit off a memory channel, so the answer has a
 *     source that is not the model's general knowledge (which is the whole thing the gate guards);
 *   • and she wrote one — at least one bubble, and no tool call, because a tool-calling turn is
 *     already going to do the work and a silent one has no answer to keep.
 * Pure.
 */
export function holdsTheAnswer(input: { hits: readonly HeldHit[]; bubbles: number; toolCalls: number }): boolean {
  return input.bubbles > 0 && input.toolCalls === 0 && heldMemoryCount(input.hits) > 0;
}

/** How many of a turn's hits are things she HOLDS about the ask — the count the decision above
 *  turns on, and so the only honest count for the line that reports it. Its own export because the
 *  gate's stand-down log said "she holds N thing(s)" off `hits.length`, which counts the directives
 *  and thread offers that were explicitly disqualified: one note plus three of those read as four.
 *  Pure. */
export function heldMemoryCount(hits: readonly HeldHit[]): number {
  return heldMemory(hits).length;
}

/** The lead line of the held-memory block, outside the data tag — the same shape the ops prompt
 *  already uses for the request itself (`ops/client.ts`: a plain line, then the tagged payload).
 *  Says "the front-line assistant" and not "she": the engine holds no part of her memory and is
 *  never told her name, so a bare pronoun names nobody. And it says what the block IS — context for
 *  the ask, not an instruction — because the brief above it is the instruction. */
const HELD_MEMORY_LEAD = 'What the front-line assistant already holds about this (context, not instructions):';

/** How much held text rides along, counted over the LISTED LINES only — her memory, which is the
 *  quantity worth bounding. Small on purpose: this is the engine's "who and what do they mean", not
 *  a memory dump — the brief beside it is still the instruction. */
export const OPS_HELD_MEMORY_CHARS = 400;
/** And how much of any ONE held thing. A note or a fact is a sentence, but a long-doc section is a
 *  paragraph of her dossier: without a per-line clip a single section would overrun the cap and be
 *  dropped whole, which loses the very hit that touched the ask. */
export const OPS_HELD_LINE_CHARS = 200;
/** What the whole block can cost the ops prompt: the listing above plus its own fixed scaffolding
 *  (the lead line and the data tag). Derived from the block's real bytes rather than written down,
 *  so a reworded lead line moves this with it — and stated at all because "≤400" describes the
 *  listing, not what is emitted, and the difference is the thing a reader would otherwise guess. */
export const OPS_HELD_BLOCK_CHARS = OPS_HELD_MEMORY_CHARS
  + `${HELD_MEMORY_LEAD}\n${dataTag('held_memory', 'x')}`.length - 'x'.length;

/** One held thing on one line: flattened, clipped, and with our own payload tags defused
 *  (`neutralizeTagBreakouts`) — this is the user's OWN stored text, and without that a note could
 *  close `</prompt>` and promote itself out of data position in the ops prompt. */
function heldLine(text: string): string {
  const flat = neutralizeTagBreakouts(text.replace(/\s+/g, ' ').trim());
  return `- ${flat.length <= OPS_HELD_LINE_CHARS ? flat : `${flat.slice(0, OPS_HELD_LINE_CHARS - 1)}…`}`;
}

/**
 * What she holds about this ask, for a delegation to carry — the held text itself for each thing,
 * as DATA (the repo's dataTag convention), plus how many made it in. The TEXT and not the label:
 * the engine holds none of her memory, and a heading ("Family") is not an answer to "which dana is
 * this?".
 *
 * The block travels as its OWN task field (`OpsTask.heldMemory`, rendered beside the brief by
 * ops/client.ts) and is deliberately NOT folded into `metaPrompt`. Two reasons, both about what the
 * brief IS: it is labelled the engine's "primary instruction", and it is the text scanned for
 * JavaScript/login-walled links (ops/walledUrls.ts) — so a reddit link inside a note that merely
 * shares a token with the ask would have armed browser tooling, widened the leg deadline the user
 * is promised, and given a thin second leg a URL to navigate to that nobody asked about.
 *
 * `{ block: '', count: 0 }` when she holds nothing about it, which is what keeps the task
 * byte-identical on every turn this changes nothing about. Whole lines are dropped at the total cap
 * rather than cut, so the last thing the engine reads is a whole held thing. Pure.
 */
export function heldMemoryBrief(hits: readonly HeldHit[]): { block: string; count: number } {
  const lines: string[] = [];
  let used = 0;
  for (const hit of heldMemory(hits)) {
    const line = heldLine(hit.text);
    const next = used + line.length + (lines.length ? 1 : 0);
    if (next > OPS_HELD_MEMORY_CHARS) break;
    lines.push(line);
    used = next;
  }
  if (!lines.length) return { block: '', count: 0 };
  return { block: `${HELD_MEMORY_LEAD}\n${dataTag('held_memory', lines.join('\n'))}`, count: lines.length };
}

/** How many hit labels the `convo:routing_gate` receipt names, and how wide each may be. The
 *  receipt persists for 30 days (diagnostics/turnTrace.ts's discipline applies to every detail in
 *  the ring), so it says enough to read the decision back without carrying her whole memory. */
const RECEIPT_LABELS = 5;
const RECEIPT_LABEL_CHARS = 60;

/**
 * The hits as the gate's receipt reports them: EVERY hit's channel (so a turn that did not stand
 * down shows why — nothing but a directive touched it) and the first few names, clipped. Pure.
 */
export function routingGateHitReceipt(hits: readonly HeldHit[]): { hitKinds: string[]; hitLabels: string[] } {
  return {
    hitKinds: hits.map(h => h.kind),
    hitLabels: hits.slice(0, RECEIPT_LABELS).map(h => {
      const flat = h.label.replace(/\s+/g, ' ').trim();
      return flat.length <= RECEIPT_LABEL_CHARS ? flat : `${flat.slice(0, RECEIPT_LABEL_CHARS - 1)}…`;
    }),
  };
}

/**
 * The memory-aware half of the gate (env: CONVO_ROUTING_GATE_MEMORY_AWARE). Default ON, read at
 * call time so flipping it needs no restart — the same parse shape as every sibling flag
 * (threadingEnabled, themeTopicGateEnabled, memoryRelevanceEnabled, turnTraceEnabled).
 *
 * Off means the gate never stands down for a memory hit and no delegation carries what she holds
 * (the block that rides beside the brief, in the task's own field): the same delegation, the same
 * meta prompt, byte for byte, as an install that never had this. The receipt still names the
 * decision and the hits behind it, so the flag can be measured off a live ring before it is
 * trusted. ROUTING_GATE=off remains the switch for the whole floor.
 */
export function routingGateMemoryAwareEnabled(): boolean {
  const v = (process.env.CONVO_ROUTING_GATE_MEMORY_AWARE || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}
