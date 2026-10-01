// The JSON-bubble boundary. Every user-facing agent now REPLIES with a JSON envelope
// (`{"bubbles":[{"text":"…","re"?:N}]}`) instead of `---`-separated prose — JSON is far more
// steerable than a prose "put --- between thoughts" rule. This module is the ONE place that turns
// that envelope back into the legacy internal wire format (`[[re:N]]first\n---\nsecond`), so every
// downstream consumer — guardrails, splitIntoBubbles, resolveOutboundBubbles, sendBubbles, history
// recording — stays byte-for-byte unchanged (they already speak that format).
//
// Design (mirrors the sibling AICommenter parser in Martins-Crib): a validation-gated 4-tier parse
// (fenced JSON → direct parse → outermost-brace extract → jsonrepair) so a truncated or lightly
// malformed reply still lands, and — critically — anything that ISN'T a valid envelope falls back to
// the raw text unchanged, which the legacy splitter (bubbles.ts) then handles. No user turn is ever
// dropped, and a persona that hasn't been flipped to JSON yet (plain `---` prose) passes straight
// through. See docs/PROMPTING_CHARTER.md §10.1 (code backstops) and the plan for the full rationale.

import { jsonrepair } from 'jsonrepair';
import type { LlmToolDef } from '../llm/types.js';
import { STATUS_SCHEMA_PROP } from '../persona/status.js';
import { MAX_BUBBLE_WORDS, BUBBLE_WORD_TARGET_LO, BUBBLE_WORD_TARGET_HI } from './bubbles.js';

/** One chat bubble. `re` (optional) is the 1-based index of the burst message this bubble answers —
 *  it renders back into the legacy `[[re:N]]` routing prefix that replyThreading.ts resolves. */
export interface BubbleJson {
  text: string;
  re?: number;
}

/** A tool call the model WROTE into its envelope (`tool_calls: [{name, args}]`) instead of emitting
 *  a native provider tool call — the toolsViaJson protocol (see LlmRequest.toolsViaJson). */
export interface EnvelopeToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** The full parsed reply: bridged text plus the optional per-turn self-reported confidence.
 *  `confidenceLevel` is the AICommenter `convinced_level` analog (0–100) — how confident the model
 *  is in the facts/answer this turn. undefined when the model omitted it or it was out of range.
 *  `toolCalls` are the envelope-written tool calls (toolsViaJson roles only; undefined otherwise).
 *  `wasEnvelope` is the retry signal: false means NO tier produced a valid envelope (prose slip). */
export interface ParsedReply {
  legacyText: string | null;
  confidenceLevel?: number;
  toolCalls?: EnvelopeToolCall[];
  wasEnvelope: boolean;
  /** The raw hidden `status` object the model emitted (mood/gauges/meta-prompt), if any. Swallowed
   *  from the user-facing text exactly like confidence_level; the persona layer coerces it (coerceStatus). */
  statusRaw?: Record<string, unknown>;
  /** The runaway guard fired on THIS parse: the model wrote more than BUBBLE_HARD_CAP bubbles and
   *  collectBubbles dropped the middle. A property of this parse and nothing else — a parse whose
   *  bubbles are discarded (tool-call extraction, a retry-validation parse) carries its own flag and
   *  can never colour another reply's. The send boundary reports the flag of the parse that produced
   *  the reply it ships (index.ts → buildBubbleReport). */
  hardCapped: boolean;
}

/** MM's parsed reply: bridged bubbles plus the two MM-only channels. Unlike ParsedReply there is
 *  deliberately NO raw-text passthrough — MM output is user-bound pre-voiced text, so a non-envelope
 *  reply yields legacyText null (the caller retries, then degrades to Fallfirm; raw model text must
 *  never ship unbridged). */
export interface MmParsedReply {
  legacyText: string | null;   // bridged bubbles ("a\n---\nb"), null when empty or not an envelope
  analysis: string | null;     // the user-invisible full read of the file, null when absent/empty
  couldNotOpen: boolean;       // the envelope's could_not_open flag (strict === true)
  wasEnvelope: boolean;        // false = no tier validated (drives the corrective retry)
}

/** Internal: a validated envelope — bubbles + optional confidence/tool calls — pre-bridge.
 *  `source` is the canonical object that validated (first object wins in the merged-array case),
 *  so schema-specific parsers (parseMmReply) can read their extra fields; parseReply ignores it. */
interface Envelope {
  bubbles: BubbleJson[];
  confidenceLevel?: number;
  toolCalls?: EnvelopeToolCall[];
  source?: Record<string, unknown>;
  /** The count guard fired while collecting THIS envelope's bubbles (see collectBubbles). */
  hardCapped: boolean;
}

// ── the bubble-count thresholds, in two numbers ──────────────────────────────────────────────────
// The LAW is the count the Convo/Fallfirm prompts state as the maximum ("at most 3 items") and that
// the BubbleReport flags as "over". The Composer prompt drops this cap (it says "as many short
// thoughts as the moment needs"), but the report still keys off this to detect runaway verbosity.
export const BUBBLE_LAW_MAX = 3;

// The runaway GUARD: a reply over this many bubbles is a model failure, not a real text, so cap it
// before a runaway model fans out hundreds of sends. A cap hit means the model is being wildly too
// verbose and needs reinforcing (§10.1).
export const BUBBLE_HARD_CAP = 15;

/** The guard's original name, kept so existing importers compile. Same number, one source. */
export const MAX_BUBBLES = BUBBLE_HARD_CAP;

// The one sentence both envelope schemas use to describe a bubble's text.
const BUBBLE_TEXT_DESCRIPTION = `one thought, one send; one comma at most, a second comma means two bubbles. Aim for ${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words. Avoid periods and colons`;

// The exact envelope shape, as a JSON Schema for OpenRouter structured outputs (response_format:
// json_schema). This ENFORCES valid JSON at the API — the fix for weaker tool-calling models
// (deepseek-v4-flash) that otherwise emit prose text when a tool set is present. Verified to coexist
// with `tools`: the model still emits a tool_call when it needs one (content null); otherwise it emits
// schema-valid JSON. Strict mode requires every property listed in `required` + additionalProperties
// false, so the two optionals are nullable-and-required (`confidence_level` / `re` = null when N/A) —
// parseReply already drops a null/out-of-range value. Kept in lockstep with validateEnvelope above.
export const BUBBLE_ENVELOPE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  // `status` is LAST on purpose: it is the hidden, least-critical field, so a max_tokens
  // truncation (tier-4 keeps the PREFIX) drops it before the user-facing bubbles.
  required: ['confidence_level', 'bubbles', 'status'],
  properties: {
    confidence_level: { type: ['integer', 'null'], description: '0-100, how sure you are of what they mean and the answer; null if not applicable to this reply' },
    bubbles: {
      type: 'array',
      description: 'each item is one short text bubble you send, in order',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 're'],
        properties: {
          text: { type: 'string', description: BUBBLE_TEXT_DESCRIPTION },
          re: { type: ['integer', 'null'], description: '1-based index of the incoming burst message this bubble quotes, or null' },
        },
      },
    },
    status: STATUS_SCHEMA_PROP,
  },
};

// MM's direct-voice envelope (the media agent texts the user itself — no composer re-voice).
// Two channels in one reply: `bubbles` (the texts Irises sends) and `analysis` (the rich private
// read persisted for the other agents; the user never sees it). Property order is deliberate
// chain-of-thought: the model writes could_not_open (the gate), then the full extraction, THEN the
// bubbles it grounds in that extraction. Strict-mode + Gemini-safe: every field required,
// additionalProperties false, NO nullable/multi-primitive unions (MM is the first role sending
// response_format to Gemini via OpenRouter — type unions are its classic schema-translation 400).
export const MM_ENVELOPE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['could_not_open', 'analysis', 'bubbles'],
  properties: {
    could_not_open: { type: 'boolean', description: 'true ONLY when the file itself could not be read at all (corrupt/blank/unopenable). False otherwise, including when the content is merely hard to read' },
    analysis: { type: 'string', description: 'your full private read of the file: what it is, every name, number, date, amount, deadline and commitment in it, read-quality issues, research-worthy follow-ups. The user never sees this.' },
    bubbles: {
      type: 'array',
      description: 'the texts you send the user, in order (empty only when could_not_open is true)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: BUBBLE_TEXT_DESCRIPTION },
        },
      },
    },
  },
};

/**
 * The toolsViaJson envelope: BUBBLE_ENVELOPE_SCHEMA extended with a `tool_calls` field, built
 * per-request from the tools actually offered (so `name` is a hard enum — the schema forbids
 * invented tools). Used when a role's tools are WRITTEN into the reply instead of sent as the
 * native `tools` API param — the fix for weak-model providers where tools + response_format
 * coexistence silently drops the schema (deepseek-v4-flash first-party et al.).
 *
 * Shape decisions (all strict-mode driven: every property required, additionalProperties false,
 * optionals expressed as nullable):
 *   - `args` is ONE flat union object of every offered tool's parameters, each nullable — the model
 *     nulls the fields its tool doesn't use. Rejected: args-as-JSON-string (weak-model escaping
 *     errors, no grammar check inside the string) and per-tool anyOf (13-branch unions are where
 *     grammar-constrained providers and Gemini's schema translation choke).
 *   - every arg is typed `[<primitive>, 'null']` with NO per-arg enums and no multi-primitive
 *     unions (Gemini's classic 400) — allowed values live in the description + the prompt's tool
 *     docs, and extraction/dispatch validate in code (e.g. delegate kind coerces to 'general').
 *   - top-level property order `confidence_level, tool_calls, bubbles` is deliberate: on a
 *     max_tokens truncation, tier-4 repair keeps the PREFIX — losing bubbles is recoverable (the
 *     voiceInstant holding floor covers a delegate turn), losing the tool call ships a holding
 *     text whose promise nothing keeps.
 * Tool-less callers keep the plain BUBBLE_ENVELOPE_SCHEMA (this returns it verbatim then).
 */
export function buildEnvelopeSchema(tools?: LlmToolDef[]): Record<string, unknown> {
  if (!tools?.length) return BUBBLE_ENVELOPE_SCHEMA;

  const argProps: Record<string, unknown> = {};
  for (const t of tools) {
    const props = (t.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
    for (const [key, def] of Object.entries(props)) {
      if (argProps[key]) continue; // first tool's description wins; per-tool semantics live in the prompt docs
      // Only boolean survives as a non-string primitive; an untyped arg (set_preference.value) and
      // every enum'd arg flatten to string — extraction coerces "true"/numeric strings back.
      const base = def.type === 'boolean' ? 'boolean' : 'string';
      const enumNote = Array.isArray(def.enum) ? `one of: ${(def.enum as unknown[]).join(' | ')}. ` : '';
      argProps[key] = {
        type: [base, 'null'],
        description: `${enumNote}${typeof def.description === 'string' ? def.description : ''}`.trim() || undefined,
      };
    }
  }

  const base = BUBBLE_ENVELOPE_SCHEMA.properties as Record<string, unknown>;
  return {
    type: 'object',
    additionalProperties: false,
    // `status` is LAST for the same truncation reason as the base schema (prefix-preserving repair
    // drops the hidden field before tool_calls/bubbles).
    required: ['confidence_level', 'tool_calls', 'bubbles', 'status'],
    properties: {
      // Non-nullable here (unlike the base schema): the tool-carrying roles run the confidence
      // gate on EVERY turn (<60 clarify, 60+ delegate), so "not applicable" doesn't exist — live
      // smoke showed a provider happily emitting null when the schema leaves the door open.
      confidence_level: { type: 'integer', description: '0-100, how sure you are of what they mean and what the answer is. Set it every reply' },
      tool_calls: {
        type: ['array', 'null'],
        description: 'one entry per action you actually take this turn, and nothing else: a tool you are not using gets no entry at all. null when this reply is words only',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'args'],
          properties: {
            name: { type: 'string', enum: tools.map(t => t.name), description: 'which tool to run' },
            args: {
              type: 'object',
              additionalProperties: false,
              required: Object.keys(argProps),
              properties: argProps,
              description: "that tool's arguments. Fill only the fields it needs, set every other field to null",
            },
          },
        },
      },
      bubbles: base.bubbles,
      status: STATUS_SCHEMA_PROP,
    },
  };
}

// re is a 1..2-digit index into the burst manifest; anything else is a model slip and is dropped
// (the bubble still sends, just unthreaded) rather than producing a bogus quote target.
const MAX_RE = 99;

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// jsonrepair throws on input it can't rescue; swallow to '' so the follow-up JSON.parse just misses.
function safeRepair(s: string): string {
  try {
    return jsonrepair(s);
  } catch {
    return '';
  }
}

// Pull the outermost {...} or [...] out of prose-wrapped output ("sure! {…} hope that helps").
// Picks whichever bracket opens FIRST so a bare-array envelope isn't mis-sliced into its first object.
function extractOutermost(s: string): string | null {
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  if (firstObj === -1 && firstArr === -1) return null;
  const useObj = firstArr === -1 || (firstObj !== -1 && firstObj < firstArr);
  const open = useObj ? firstObj : firstArr;
  const close = s.lastIndexOf(useObj ? '}' : ']');
  return close > open ? s.slice(open, close + 1) : null;
}

// Index of the first opening bracket ({ or [) in the string, or -1. Used to anchor tier-4 repair.
function firstBracketIndex(s: string): number {
  const o = s.indexOf('{');
  const a = s.indexOf('[');
  if (o === -1) return a;
  if (a === -1) return o;
  return Math.min(o, a);
}

// Canonical-envelope check: a `bubbles` array OR a `tool_calls` array marks the object as ours —
// both are magic keys prose can't accidentally repair into. Accepting tool_calls-only objects is
// load-bearing for the truncation story: the schema orders tool_calls BEFORE bubbles precisely so
// a max_tokens cut keeps the action; tier-4 repair of that prefix yields an object with tool_calls
// and NO bubbles key, which must still validate (null text → the callers' holding floors fire).
function isEnvelopeObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Array.isArray((v as { bubbles?: unknown }).bubbles)
    || Array.isArray((v as { tool_calls?: unknown }).tool_calls);
}

// Pull the envelope-level confidence (0–100) off a canonical object, or undefined. Tolerant of a
// couple of key/format variants a model might emit; a numeric value is rounded and CLAMPED into
// [0,100] (so "150" → 100, "-5" → 0), a non-numeric ("high") is dropped. Never fails the envelope —
// the bubbles ship regardless, this is a side signal (charter §4.1 calibration).
function extractConfidence(v: Record<string, unknown>): number | undefined {
  const raw = v.confidence_level ?? v.confidenceLevel ?? v.confidence;
  let n: number | undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) n = raw;
  else if (typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw.trim())) n = parseFloat(raw);
  if (n == null) return undefined;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// Args whose consumers do STRICT `=== true` checks (disconnect confirm, needs_ops, a reminder's
// distinct claim) or store a typed preference value — the flat union schema types them
// string-compatible (no multi-primitive unions, Gemini's classic 400), so a "true"/"42" string is
// coerced back to its real primitive here.
const BOOLEAN_ARGS = new Set(['confirmed', 'needs_ops', 'distinct']);

function coerceArgValue(key: string, val: unknown): unknown {
  if (typeof val !== 'string') return val;
  const s = val.trim();
  if (BOOLEAN_ARGS.has(key) || key === 'value') {
    if (/^true$/i.test(s)) return true;
    if (/^false$/i.test(s)) return false;
  }
  if (key === 'value' && /^-?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  return val;
}

// Pull the envelope-written tool calls (`tool_calls: [{name, args}]`) off a canonical object, or
// undefined. Tolerant, mirroring extractConfidence: the array or an item's args may arrive as a
// JSON STRING (a model slip) — parse/repair it; null-valued args are STRIPPED so downstream
// truthiness checks (`input.meta_prompt ? …`) behave; an item with no usable name is dropped.
// Never fails the envelope — the bubbles ship regardless, bad tool calls just don't dispatch.
function extractToolCalls(v: Record<string, unknown>): EnvelopeToolCall[] | undefined {
  let raw = v.tool_calls ?? v.toolCalls;
  if (typeof raw === 'string' && raw.trim()) {
    raw = tryParse(raw) ?? tryParse(safeRepair(raw));
  }
  if (!Array.isArray(raw)) return undefined;

  const out: EnvelopeToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name !== 'string' || !name.trim()) continue;

    let args = (item as { args?: unknown }).args ?? (item as { arguments?: unknown }).arguments ?? (item as { input?: unknown }).input;
    if (typeof args === 'string' && args.trim()) {
      args = tryParse(args) ?? tryParse(safeRepair(args));
    }
    const input: Record<string, unknown> = {};
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      for (const [k, val] of Object.entries(args as Record<string, unknown>)) {
        if (val == null) continue;
        input[k] = coerceArgValue(k, val);
      }
    }
    out.push({ name: name.trim(), input });
  }
  return out.length ? out : undefined;
}

// Extract one bubble from a raw item — an object with a `text` field, or a bare string. Returns null
// for an item with no usable text (dropped, not fatal). `re` is coerced from an int or numeric string
// and range-checked; anything else is dropped so the bubble still sends, just unthreaded.
function coerceBubble(item: unknown): BubbleJson | null {
  let text: string | undefined;
  let re: number | undefined;

  if (typeof item === 'string') {
    text = item;
  } else if (item && typeof item === 'object') {
    const t = (item as { text?: unknown }).text;
    if (typeof t === 'string') text = t;
    else if (typeof t === 'number' || typeof t === 'boolean') text = String(t);

    const r = (item as { re?: unknown }).re;
    if (typeof r === 'number' && Number.isInteger(r) && r >= 1 && r <= MAX_RE) re = r;
    else if (typeof r === 'string' && /^\d{1,2}$/.test(r.trim())) {
      const n = parseInt(r, 10);
      if (n >= 1 && n <= MAX_RE) re = n;
    }
  }

  if (text == null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return re != null ? { text: trimmed, re } : { text: trimmed };
}

// Collect items into bubbles. Over the guard we keep the first BUBBLE_HARD_CAP-1 PLUS the final
// bubble — personas put the action/question/consent link last, and the send path's contract is
// "never drop a word" — rather than truncating the tail. A cap hit is a persona slip, so it's
// logged, and reported back as `hardCapped` so it rides THIS parse's result all the way to the
// send boundary (a process-wide tally would attach one parse's hit to another reply's receipt:
// Composer, Fallfirm, a discarded retry-validation parse and a tool-call-only parse all run
// through here, and concurrent chats hold no shared lock).
function collectBubbles(items: unknown[]): { bubbles: BubbleJson[]; hardCapped: boolean } {
  const all: BubbleJson[] = [];
  for (const item of items) {
    const b = coerceBubble(item);
    if (b) all.push(b);
  }
  if (all.length <= BUBBLE_HARD_CAP) return { bubbles: all, hardCapped: false };
  console.warn(`[bubbles] capped a reply at ${BUBBLE_HARD_CAP} bubbles (model overran) — kept the last one`);
  return { bubbles: [...all.slice(0, BUBBLE_HARD_CAP - 1), all[all.length - 1]], hardCapped: true };
}

/**
 * Coerce a parsed value into a clean bubble list, or null if it isn't an envelope. Shape rules:
 *   - canonical object — a `bubbles` array OR a `tool_calls` array (see isEnvelopeObject; a
 *     truncated toolsViaJson reply can lose the bubbles key) → always an envelope (empty/missing
 *     bubbles = a deliberate or truncated tool-only turn)
 *   - array whose items are ALL canonical objects (jsonrepair wraps `\n`-joined multi-block replies
 *     into such an array) → merge their bubbles + tool_calls
 *   - a BARE array of bubble items        → ONLY when `allowBareArray` (tier 1, the whole input parsed
 *     cleanly) AND it yields ≥1 bubble
 * Requiring the canonical OBJECT shape for anything EXTRACTED or REPAIRED (tiers 2–4) is the load-
 * bearing safety property: it stops jsonrepair from manufacturing envelopes out of bracketed prose
 * ("[1]" citations, "[done]", "[$1,800 - $2,000]" ranges, a legacy "[[re:N]]" tag) — all of which can
 * only ever produce a bare array, which is rejected here and falls through to raw passthrough.
 */
function validateEnvelope(v: unknown, allowBareArray: boolean): Envelope | null {
  if (isEnvelopeObject(v)) {
    const items = Array.isArray(v.bubbles) ? (v.bubbles as unknown[]) : [];
    const { bubbles, hardCapped } = collectBubbles(items);
    return { bubbles, hardCapped, confidenceLevel: extractConfidence(v), toolCalls: extractToolCalls(v), source: v };
  }
  if (Array.isArray(v) && v.length > 0 && v.every(isEnvelopeObject)) {
    const merged: unknown[] = [];
    const mergedCalls: EnvelopeToolCall[] = [];
    let confidenceLevel: number | undefined;
    for (const o of v) {
      if (Array.isArray(o.bubbles)) merged.push(...(o.bubbles as unknown[]));
      if (confidenceLevel == null) confidenceLevel = extractConfidence(o);
      mergedCalls.push(...(extractToolCalls(o) ?? []));
    }
    const { bubbles, hardCapped } = collectBubbles(merged);
    return { bubbles, hardCapped, confidenceLevel, toolCalls: mergedCalls.length ? mergedCalls : undefined, source: v[0] };
  }
  if (allowBareArray && Array.isArray(v)) {
    const { bubbles, hardCapped } = collectBubbles(v);
    // a bare array that yields no bubble is not a meaningful envelope
    return bubbles.length ? { bubbles, hardCapped } : null;
  }
  return null;
}

/**
 * Parse a model reply into bubbles, or null if it isn't a JSON envelope. Four tiers, each gated by
 * validateEnvelope so prose that merely contains braces (or a jsonrepair "fix" of plain text) can't
 * masquerade as an envelope:
 *   1. strip ```json fences → JSON.parse
 *   2. extract the outermost {…}/[…] → JSON.parse   (prose-wrapped JSON)
 *   3. jsonrepair that candidate                     (trailing commas, single quotes, unquoted keys)
 *   4. jsonrepair the whole string                   (rescues a max_tokens-truncated envelope)
 * Returns the {bubbles, confidenceLevel?} envelope (bubbles may be `[]` for a tool-only turn), or
 * null when nothing validates.
 */
// A weak-model slip: a tool-call item echoes the flat args union AFTER its `args` object, and that
// union carries a `name` arg of its own (remember_user, rename_group_chat). Spilled as null, it is a
// duplicate key, and JSON.parse keeps the last one, so the call loses its tool name and is dropped
// (live, 2026-10-01: an unsend she meant). Renaming the spilled key keeps the name she wrote first.
// Flat args never nest, so `[^{}]` keeps the match inside one item.
const SPILLED_NAME = /("name"\s*:\s*"[^"]*"\s*,\s*"args"\s*:\s*\{[^{}]*\})([^{}]*?)"name"\s*:\s*null/g;

function parseEnvelope(raw: string | null | undefined): Envelope | null {
  if (!raw || !raw.trim()) return null;

  const stripped = raw
    .replace(/^﻿/, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
    .replace(SPILLED_NAME, '$1$2"spilled_name":null');

  // tier 1 — direct parse of the WHOLE string. The only tier that accepts a bare top-level array,
  // since here the array IS the entire reply (not something scraped out of surrounding prose).
  const t1 = tryParse(stripped);
  if (t1 !== undefined) {
    const v = validateEnvelope(t1, true);
    if (v) return v;
  }

  // tiers 2 + 3 — the outermost brace-delimited candidate → parse, then jsonrepair. Canonical object
  // required (allowBareArray=false), so a bracketed prose fragment can't slip through.
  const candidate = extractOutermost(stripped);
  if (candidate && candidate !== stripped) {
    const t2 = tryParse(candidate);
    if (t2 !== undefined) {
      const v = validateEnvelope(t2, false);
      if (v) return v;
    }
    const repaired = safeRepair(candidate);
    if (repaired) {
      const t3 = tryParse(repaired);
      if (t3 !== undefined) {
        const v = validateEnvelope(t3, false);
        if (v) return v;
      }
    }
  }

  // tier 4 — jsonrepair from the first opening bracket to the end. Rescues a max_tokens-truncated
  // envelope (even with a stray leading char or short prose prefix) and `\n`-joined multi-block
  // replies (jsonrepair wraps those into an array of canonical objects, which validateEnvelope merges).
  // Safe on ordinary prose precisely because validateEnvelope(…, false) demands the canonical
  // `{bubbles:[…]}` shape here — prose (even bracketed prose) can only ever repair into a bare array.
  const open = firstBracketIndex(stripped);
  if (open !== -1) {
    const repairedTail = safeRepair(stripped.slice(open));
    if (repairedTail) {
      const t4 = tryParse(repairedTail);
      if (t4 !== undefined) {
        const v = validateEnvelope(t4, false);
        if (v) return v;
      }
    }
  }

  return null;
}

/**
 * Back-compatible bubbles-only parse: the {bubbles} of a valid envelope (possibly `[]` for a
 * tool-only turn), or null when the reply isn't a JSON envelope. `parseReply` exposes the confidence.
 */
export function parseBubblesJson(raw: string | null | undefined): BubbleJson[] | null {
  const e = parseEnvelope(raw);
  return e ? e.bubbles : null;
}

/**
 * Render parsed bubbles into the legacy internal wire format the send path already consumes:
 * `[[re:2]]first\n---\nsecond`. Returns null for an empty list (a tool-only turn → the caller's
 * never-go-silent fallbacks take over). The `\n---\n` join and `[[re:N]]` prefix are exactly what
 * splitIntoBubbles + resolveOutboundBubbles re-split and resolve, so the round trip is lossless and
 * the per-bubble backstops (splitLongBubble, cleanResponse) still fire on each.
 */
export function bubblesToLegacyText(bubbles: BubbleJson[]): string | null {
  if (!bubbles.length) return null;
  return bubbles
    .map(b => (b.re != null ? `[[re:${b.re}]]${b.text}` : b.text))
    .join('\n---\n');
}

/**
 * The single entry point every user-facing producer calls on `res.text`. Format-agnostic:
 *   - a JSON envelope → legacy `---` text (ready for the unchanged send path)
 *   - a valid EMPTY envelope (`{"bubbles":[]}`) → null (tool-only turn; caller's fallbacks fire)
 *   - anything that isn't an envelope (incl. plain `---` prose from a not-yet-flipped persona, or a
 *     garbled reply) → the raw text UNCHANGED, so the legacy splitter handles it and no turn is lost
 */
export function normalizeLlmText(raw: string | null | undefined): string | null {
  return parseReply(raw).legacyText;
}

/**
 * The full parse every user-facing producer needs: bridged `legacyText` (for the send path) PLUS the
 * self-reported `confidenceLevel` (0–100, for the calibration loop). Same format-agnostic fallback as
 * normalizeLlmText:
 *   - a JSON envelope → { legacyText: bridged `---` text (or null if empty/tool-only), confidenceLevel }
 *   - non-envelope prose (not-yet-flipped persona or garble) → { legacyText: raw } (no confidence)
 *   - empty/whitespace/null → { legacyText: null }
 */
/**
 * MM's parse of its {could_not_open, analysis, bubbles} envelope. Same 4-tier walk as parseReply,
 * with ONE deliberate divergence: NO raw-text passthrough. parseReply falls back to the raw string
 * so a not-yet-flipped persona's prose still ships; MM's reply is pre-voiced user-bound text, so a
 * prose slip must NOT ship — it returns legacyText null / wasEnvelope false, the client retries once
 * with a format corrective, and a second miss degrades to the honest-snag floor (Fallfirm).
 */
export function parseMmReply(raw: string | null | undefined): MmParsedReply {
  const env = parseEnvelope(raw);
  if (env == null) return { legacyText: null, analysis: null, couldNotOpen: false, wasEnvelope: false };
  const src = env.source;
  const rawAnalysis = src?.analysis;
  const analysis = typeof rawAnalysis === 'string' && rawAnalysis.trim() ? rawAnalysis.trim() : null;
  return {
    legacyText: bubblesToLegacyText(env.bubbles),
    analysis,
    couldNotOpen: src?.could_not_open === true,
    wasEnvelope: true,
  };
}

// ── the send boundary's receipt ──────────────────────────────────────────────────────────────────
// Both bubble caps used to be invisible: the count guard only ever printed a console.warn, and so
// did the word ceiling (bubbles.ts). A reply that came out four bubbles long, or as a re-split
// wall, left nothing an attribution pass could read. BubbleReport is that reading — computed once,
// at the one place the list that actually ships is known.

/** What the bubble law did to one delivered reply. Numbers and flags only — never bubble text. */
export interface BubbleReport {
  /** Bubbles actually sent, after both caps and the word-ceiling re-split. */
  count: number;
  /** Words in the longest of them (0 when nothing shipped). */
  maxWords: number;
  /** Over the law the model was told (`count > BUBBLE_LAW_MAX`) — a persona slip, not a break. */
  overLaw: boolean;
  /** The runaway guard fired during the parse: the model wrote more than BUBBLE_HARD_CAP bubbles. */
  hardCapped: boolean;
  /** Word-ceiling splits the backstop had to make (`splitLongBubble`) — a wall got through. */
  splits: number;
}

/**
 * Report on the bubbles that ship. Pure: `hardCapped` and `splits` are the two facts the boundary
 * can't see in the list itself, so they come from the parse (`ParsedReply.hardCapped`, carried down
 * to the boundary on the value the turn returns) and the splitter (splitIntoBubblesWithSplits) that
 * produced it — both per-reply, never a process-wide tally.
 */
export function buildBubbleReport(bubbles: string[], opts: { hardCapped: boolean; splits: number }): BubbleReport {
  const wordsIn = (b: string) => b.split(/\s+/).filter(Boolean).length;
  return {
    count: bubbles.length,
    maxWords: bubbles.reduce((max, b) => Math.max(max, wordsIn(b)), 0),
    overLaw: bubbles.length > BUBBLE_LAW_MAX,
    hardCapped: opts.hardCapped,
    splits: opts.splits,
  };
}

// The last report per chat, so a turn receipt assembled elsewhere can fold it in without the send
// boundary having to thread it back up through the agent layers. Bounded: one entry per chat, and
// a single-host, single-user instance never holds more than a handful of chats — the prune is a
// belt-and-braces guard against a long-lived process seeing an unbounded spread of chat ids.
//
// ORDERING — read this before consuming lastBubbleReport anywhere:
// a turn's report only exists AFTER the send boundary in src/index.ts has run, and that boundary
// runs on the text the Convo turn has already RETURNED. So a read from inside processConvoResult
// (agents/convo/shared.ts) — or from anything else upstream of the return — gets the PREVIOUS
// turn's report, or undefined on the first turn of a chat. There is no ordering that fixes that
// from upstream; the report is a property of the shipped list, which upstream hasn't produced yet.
// The `turn:trace` task therefore consumes the report AT the send boundary, where buildBubbleReport
// returns it directly (noteBubbleReport hands its argument straight back for exactly that). This
// parking spot is for a later, out-of-band reader that only needs "the newest one for this chat".
const REPORT_MEMORY = 32;
const lastReports = new Map<string, BubbleReport>();

/** Park a delivered reply's report under its chat and hand it straight back (see the ordering note
 *  above: it is parked at the send boundary, i.e. after the Convo turn has returned). */
export function noteBubbleReport(chatId: string, report: BubbleReport): BubbleReport {
  lastReports.delete(chatId);              // re-insert so the map's order is least-recent-first
  lastReports.set(chatId, report);
  while (lastReports.size > REPORT_MEMORY) lastReports.delete(lastReports.keys().next().value as string);
  return report;
}

/** The most recent delivered reply's report for this chat, or undefined if it hasn't sent one.
 *  NOT the current turn's report when called from inside the turn: see the ordering note above —
 *  from anywhere upstream of the send boundary this is the PREVIOUS turn's reading. */
export function lastBubbleReport(chatId: string): BubbleReport | undefined {
  return lastReports.get(chatId);
}

/** Words only the reply contract uses: "bubble" as a unit of her own output (the everyday bubble tea,
 *  wrap, bath and gum are exempt), the person called "the user", and the status block's field names. */
const REPLY_MACHINERY = /\bbubbles?\b(?!\s*(?:tea|wrap|bath|gum))|\bthe user\b|\bmeta_prompt\b|\bmood_label\b/i;

export function parseReply(raw: string | null | undefined): ParsedReply {
  if (raw == null) return { legacyText: null, wasEnvelope: false, hardCapped: false };
  const env = parseEnvelope(raw);
  if (env == null) {
    if (!raw.trim()) return { legacyText: null, wasEnvelope: false, hardCapped: false };
    // Garble hardening: a reply that mentions "tool_calls" but failed every tier is broken envelope
    // JSON, not prose — passing it to the legacy splitter would text JSON shrapnel (possibly a
    // meta_prompt naming internal tools) to the user. Swallow the text; the caller's never-go-silent
    // floors take over, and wasEnvelope=false still drives the corrective retry upstream.
    if (raw.includes('"tool_calls"') || raw.includes("'tool_calls'")) {
      console.warn('[bubbles] unparseable reply mentions tool_calls — suppressing it instead of texting JSON shrapnel');
      return { legacyText: null, wasEnvelope: false, hardCapped: false };
    }
    // Same floor for the two other shapes a failed envelope takes. Text that opens with a brace is
    // the envelope itself, cut or broken (a lone "{" included), never something she would text.
    // Text that speaks in her own reply-format vocabulary (the bubble as the unit she writes in,
    // "the user", the status fields) is her drafting notes about the chat, written ABOUT the person
    // rather than TO them. Neither is a reply; the silent-turn floor answers instead.
    if (/^\s*\{/.test(raw) || REPLY_MACHINERY.test(raw)) {
      console.warn('[bubbles] unparseable reply is envelope debris or drafting notes — suppressing it');
      return { legacyText: null, wasEnvelope: false, hardCapped: false };
    }
    // Every user-facing persona is on the JSON envelope now, so a non-JSON reply reaching here is a
    // persona slip (not a routine legacy passthrough). Log it — the legacy splitter still ships the
    // reply, so nothing breaks, but this is the flip-week telemetry signal (charter §13). One line,
    // never throws (mirrors the guardrail tripwire logs). No confidence is available from prose.
    console.warn('[bubbles] reply did not parse as a JSON envelope — using the legacy splitter');
    return { legacyText: raw, wasEnvelope: false, hardCapped: false };
  }
  const rawStatus = env.source?.status;
  return {
    legacyText: bubblesToLegacyText(env.bubbles),
    confidenceLevel: env.confidenceLevel,
    toolCalls: env.toolCalls,
    wasEnvelope: true,
    statusRaw: rawStatus && typeof rawStatus === 'object' ? rawStatus as Record<string, unknown> : undefined,
    hardCapped: env.hardCapped,
  };
}
