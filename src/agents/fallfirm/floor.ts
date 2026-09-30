// The irreducible floor — the ONLY hardcoded user-facing copy left in the codebase.
//
// Fallfirm (client.ts) re-voices every failure and confirmation through the LLM so the user never
// sees dev copy. But Fallfirm is itself an LLM call, and "never go silent" is absolute — so when even
// Fallfirm's call throws or comes back empty (provider down, timeout), we still have to say SOMETHING.
// That backup-to-the-backup lives here: a tiny, generic, in-character line per outcome kind, all in
// one audited place. If you're adding a hardcoded user-facing string anywhere else, don't — route it
// through voiceOutcome() instead. Output is the legacy `\n---\n` bubble wire format the send path
// consumes; the per-bubble guardrails (redactInternalTools / stripOpsScaffolding) still run downstream.

import { pick } from '../textVariants.js';
import type { TaskKind } from '../types.js';

/** What happened, from the user's point of view — the thing Fallfirm (or this floor) must relay. */
export type OutcomeKind = 'confirmed' | 'failed' | 'nothing_found';

export interface Outcome {
  kind: OutcomeKind;
  /** Plain description of what happened, for Fallfirm to VOICE (never shown to the user verbatim). */
  summary: string;
  /** Hard facts that must be relayed EXACTLY if voiced (a time, an amount) — fidelity. */
  facts?: string;
  /** Optional steer for the failure ("ask them for the timing again"). */
  nextStep?: string;
  /** What the user originally asked, for seamless continuity. */
  originalRequest?: string;
  /** Several results of ONE turn voiced together, in the order they ran (convo/actionResults.ts
   *  combinedOutcome). `kind` is then the worst of them, and `summary` only frames the list. */
  parts?: Outcome[];
}

/**
 * Last-resort line for when Fallfirm's own LLM call fails. Generic and in-voice; never fabricates
 * specifics. Returns legacy bubble text.
 */
export function fallfirmFloor(o: Outcome): string {
  // A combined outcome is each part's own line, in order — no new copy, and a success beside a miss
  // is still said when the voicer that would have woven them together is down.
  if (o.parts?.length) return o.parts.map(fallfirmFloor).join('\n---\n');
  switch (o.kind) {
    case 'confirmed':
      return withFacts('done, all set', o.facts);
    case 'nothing_found':
      return withFacts("couldnt track that one down", o.facts);
    case 'failed':
    default:
      // A failure that carries facts is one that stopped short on purpose (several things fit, or a
      // similar one already stands) and hands back what does exist. "hit a snag… nothing came back"
      // would contradict the very list after it, so that case leads with a neutral line instead.
      return o.facts
        ? withFacts('nothing changed yet, heres what you already have', o.facts)
        : "couldnt get that one just now, something on my end acted up";
  }
}

// A failure's facts are relayed too. On a miss they are what the user needs next: the items a call
// that missed or matched several could have meant, or the reminder a held create collides with. A
// floor that drops them leaves the user nothing to pick from and no way to know what already stands.
function withFacts(line: string, facts: string | undefined): string {
  return facts ? `${line}\n---\n${facts}` : line;
}

// ── Static command reference (deterministic, deliberately NOT voiced) ─────────────────────────
// `/help` is a fixed reference card, not a failure or confirmation, so it does NOT route through
// voiceOutcome: Fallfirm's anchor is told to "never name a tool, a system," but the whole point of
// this text is to expose the slash-commands verbatim. It's hardcoded user-facing copy, so it lives
// HERE — the one audited home for such copy — rather than inline in convo/client.ts. One bubble
// (internal newlines, no `---` splits). Keep the command names byte-exact with the real handlers.
export function helpText(): string {
  return [
    'commands:',
    '/help - this message',
  ].join('\n');
}

// ── Instant progress/reassurance floor (no model turn to voice it) ────────────────────────────
// These are sent the INSTANT Convo delegates but wrote no line of its own (rare — the model normally
// writes one), or mid-run. Unlike a failure/confirmation, they precede a background Ops run and must
// go out immediately, so — like the long-wait heartbeat — they are NOT routed through Fallfirm's model
// call (that latency would defeat the reassurance). Centralized here so no instant copy is scattered.
//
// Every line below is a small POOL, not a single string — one hardcoded phrase repeated verbatim
// across a conversation reads like a bot. The holding and still-on-it pools go further: they are
// handed her last few beats for the chat (state/holdingBeats.ts, oldest first) and `pickFresh`
// never picks one of those while a fresh line is left. It stays a synchronous, zero-latency lookup:
// the caller already holds that list, nothing is read here.
//
// The holding pools mirror the three beat shapes the prompts teach — a thinking sound, a short
// wait, a line naming the thing — so a fallback beat is as varied as one she writes herself. Each
// line promises only a look that is starting: none claims a result or names what does the looking.

/** One pick from `pool` that is none of `recent` (her last few beats, OLDEST first), at random
 *  among the fresh ones. When every line has been used recently, the least recently used one comes
 *  back: the beat she sent furthest back is the one least likely to still be on their screen, and
 *  the most recent is never repeated. Compared trimmed and case-blind, since a recorded beat went
 *  through the send path. `rand` is the test seam. */
export function pickFresh<T extends string>(pool: readonly T[], recent: readonly string[], rand: () => number = Math.random): T {
  // Every pool here is a non-empty literal, so an empty one is a coding slip, not a runtime case —
  // say so plainly instead of returning `undefined` into the send path.
  if (!pool.length) throw new Error('pickFresh: empty pool');
  const key = (s: string) => s.trim().toLowerCase();
  const lastUsed = new Map<string, number>();
  recent.forEach((beat, i) => lastUsed.set(key(beat), i));
  const fresh = pool.filter(line => !lastUsed.has(key(line)));
  if (fresh.length) return fresh[Math.min(fresh.length - 1, Math.floor(rand() * fresh.length))];
  return pool.reduce((best, line) => (lastUsed.get(key(line))! < lastUsed.get(key(best))! ? line : best));
}

export const HOLDING: Partial<Record<TaskKind, readonly string[]>> = {
  web_research: [
    'hmm lemme look that up', 'hmmm', 'ooh good one, lemme see', 'one sec, looking it up',
    'gimme a sec on this one', 'looking up that one now', 'digging into it now', 'checking on that, hang on',
    'mm lemme dig',
  ],
  document_read: [
    'hmm lemme dig through your inbox', 'hmmm', 'mmm lemme see whats in there', 'checking your inbox now, one sec',
    'gimme a sec, going through your mail', 'searching your email now', 'digging through your inbox, hang on',
    'going through your emails now', 'one sec, scanning your inbox',
  ],
  draft: [
    'hmm lemme write this up', 'mm ok, writing it now', 'gimme a sec to write it', 'give me a bit, putting words together',
    'drafting that now', 'writing that up now', 'putting that draft together now', 'one sec, working on the wording',
    'on it, drafting',
  ],
  // File read — deliberately a tiny human beat (not a "pulling records" line), matching the minimal
  // holding register for a media delegation. Fallback-only; the LLM voicer usually writes its own.
  media_read: [
    'hmm lemme see', 'mm looking at it now', 'ooh ok, opening it', 'one sec, looking at that',
    'gimme a sec with this', 'hold on, opening it up', 'lemme open this up', 'taking a look at that now',
  ],
};

export const HOLDING_DEFAULT: readonly string[] = [
  'hmm', 'hmmm lemme see', 'mm ok, looking into it', 'one sec', 'gimme a bit on this one',
  'hang on, lemme look', 'on it, give me a sec', 'on it, one sec', 'give me a sec on that one',
];

/** Instant holding line when the model delegated without writing one — never one of `recent`, her
 *  last few beats in this chat, oldest first, while the pool has a fresh line left. */
export function holdingFloor(kind: TaskKind, recent: readonly string[] = []): string {
  return pickFresh(HOLDING[kind] ?? HOLDING_DEFAULT, recent);
}

const STILL_ON_IT_POOL: readonly string[] = ['still on that, hang tight', 'still working on that one', 'still on it, one sec more', 'still on it, almost there'];

/** Instant "still working" reassurance when a duplicate delegation was suppressed (nothing new to
 *  pull) — steered off her recent beats the same way. */
export function stillOnItText(recent: readonly string[] = []): string {
  return pickFresh(STILL_ON_IT_POOL, recent);
}

// Plain, no-context heartbeat variants — used when the task carries no address/deal hint, or on the
// (roughly 40%) rolls that skip the hint even when one's available, so leaning on the hint never
// becomes its own predictable pattern.
const HEARTBEAT_GENERIC: readonly string[] = [
  "still on it, this one is bigger pull",
  "still digging, this one taking a bit longer",
  "not done yet, there is more to this one than usual",
  'still working through it, hang tight',
  "give me a bit more, this one got some layers",
];

// Hint-aware variants — used when the task names an address/deal, so the reassurance names the
// actual thing it's stuck on instead of a generic "it".
const HEARTBEAT_WITH_HINT: readonly ((hint: string) => string)[] = [
  hint => `still digging on ${hint}, bigger pull than usual`,
  hint => `${hint} is turning out to be bigger pull`,
  hint => `still on ${hint}, taking a little longer than usual`,
  hint => `more to dig through on ${hint} than i expected`,
];

interface HeartbeatHint { addressHint?: string; dealHint?: string }

/** The one long-wait heartbeat, fired by a timer mid-Ops-run (progress, not a failure/confirmation).
 *  Picks a fresh variant each call, and leans on the task's address/deal hint when there is one so
 *  it names what it's actually stuck on instead of reading as one fixed canned line. */
export function heartbeatText(task?: HeartbeatHint): string {
  const hint = task?.addressHint || task?.dealHint;
  if (hint && Math.random() < 0.6) return pick(HEARTBEAT_WITH_HINT)(hint);
  return pick(HEARTBEAT_GENERIC);
}

