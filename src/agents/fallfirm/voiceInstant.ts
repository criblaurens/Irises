// The waiting voice — Irises's "still on it" / "on it" reassurance while a
// delegated Ops look is still running. Built EXACTLY like the Composer relay (composeFollowUp) and
// the outcome voicer (voiceOutcome): a static persona (fallfirm/Progress.md) + a <prompt> dynamic
// block + a JSON bubble anchor + a voice-only window of the recent thread. The one thing it re-voices
// is different: not an Ops RESULT, but the wait itself — the hardcoded progress/holding beats that
// used to be one-shot canned lines. Injecting the thread is what lets it BLEND with the surrounding
// conversation and, above all, NEVER repeat a reassurance that's already on the user's screen.
//
// If this LLM call fails or comes back empty, we drop to floor.ts — the same zero-latency pooled
// phrases as before, now truly last-resort. Never throws.
import { callLLM } from '../../llm/callLLM.js';
import { loadContext } from '../loadContext.js';
import { renderPersonaBlock } from '../../persona/policy.js';
import { getConversation, StoredMessage } from '../../state/conversation.js';
import { buildUserMemory } from '../../memory/wrappers.js';
import { redactInternalTools } from '../guardrails.js';
import { parseReply } from '../../pipeline/bubbleJson.js';
import { MAX_BUBBLE_WORDS, BUBBLE_WORD_TARGET_LO, BUBBLE_WORD_TARGET_HI } from '../../pipeline/bubbles.js';
import { wrapPrompt, dataTag, neutralizeTagBreakouts } from '../../llm/promptTag.js';
import { timestampLabel } from '../../pipeline/chatTime.js';
import type { LlmMessage } from '../../llm/types.js';
import type { TaskKind } from '../types.js';
import { holdingFloor, stillOnItText, heartbeatText, pickFresh, HOLDING_DEFAULT } from './floor.js';

// Recent turns prepended for VOICE/continuity ONLY — never a fact source (this voice carries no
// facts). This is the window that lets it see its own last holding line / ping so it never repeats.
// Mirrors the composer/fallfirm windows; a touch wider so a prior ping stays in view on a busy thread.
// Turns carry their wall-clock stamps (chatTime.ts) like every other voice window; no timing block
// here though — a progress ping is always seconds into a look, the regime never varies.
const HISTORY_WINDOW = 10;

function formatHistory(messages: StoredMessage[]): LlmMessage[] {
  return messages.slice(-HISTORY_WINDOW).map(m => ({ role: m.role, timestamp: timestampLabel(m.at) || undefined, content: m.content }));
}

/** The ETA the user was ALREADY promised, read off the in-flight entry — never re-derived here. The
 *  whole point is consistency: a later beat may repeat this phrase or say less, but it must never put
 *  a different number in their head. */
export interface VoiceInstantEta {
  phrase: string;
  state: 'fresh' | 'early' | 'closing' | 'overrun';
  remainingPhrase?: string;
}

export interface VoiceInstantOpts {
  kind: 'holding' | 'still_on_it' | 'heartbeat' | 'progress';
  taskKind?: TaskKind;
  request?: string;
  addressHint?: string;
  dealHint?: string;
  eta?: VoiceInstantEta;
  /** Her own last few wait beats for this chat, OLDEST first — exactly as state/holdingBeats.ts
   *  recentHoldingBeats returns them. The brief prints them newest first, so the one she is least
   *  likely to have scrolled past leads. Absent or empty renders nothing. */
  recentBeats?: readonly string[];
  /** What of this same reply already went out while it was still being written (the early sink,
   *  convo/client.ts), in send order. This beat is the next text after it, so the brief says so.
   *  Absent or empty renders nothing, which is every turn that did not stream. */
  onScreen?: readonly string[];
}

// The dynamic block: where the look is right now, the ask (for continuity), the hint (so it names the
// real thing), and — every time — the hard "don't repeat what's already on screen" steer. No facts,
// no url ever. Mirrors buildOutcomeBrief in client.ts. Exported for unit testing.
export function buildProgressBrief(opts: VoiceInstantOpts, userCtx: string): string {
  const hint = opts.addressHint || opts.dealHint;
  const req = opts.request?.trim();
  const lines: string[] = [];

  const eta = opts.eta;
  // The mid-run pace lines, shared by every "still running" beat. Past ~60% we stop handing out
  // numbers entirely — an honest "should be close" beats a fresh, shrinking countdown.
  const pushPaceBeat = () => {
    if (eta?.state === 'early' && eta.remainingPhrase) lines.push(`if a time beat fits, there's about ${eta.remainingPhrase} to go — loose words only, or skip it.`);
    else if (eta?.state === 'closing') lines.push('it should be close now — you may say so, no number.');
    else if (eta?.state === 'overrun') lines.push("it's running past what you told them. one honest, unbothered beat that it's taking a little longer than you thought is fine — do NOT quote a new time.");
  };

  switch (opts.kind) {
    case 'holding':
      lines.push('## Where the look is: you JUST started — this is your opening beat');
      lines.push(req ? `they asked you to look into: "${req}"` : 'they just asked you to look into something');
      if (hint) lines.push(`it's about: ${hint} — name the actual thing, not a generic "it"`);
      if (eta) lines.push(`roughly how long this takes: ${eta.phrase}. you MAY offer that loosely, in your own words — an offer, never a countdown, and never a different number than this one.`);
      lines.push('one bubble, short, true. vary the shape: a thinking sound, a short wait, or a line naming the thing. claim no progress you have not made.');
      break;
    case 'still_on_it':
      lines.push('## Where the look is: STILL running — and they just texted you again while you work');
      if (req) lines.push(`what you're still pulling: "${req}"`);
      pushPaceBeat();
      lines.push('you already told them you were on it (the thread above shows it). do NOT repeat that line. give their new text one light nod if it needs one, then one fresh still-working beat, in a shape unlike the recent ones. the nod and the beat share the ONE bubble.');
      break;
    case 'heartbeat':
    case 'progress':
      lines.push('## Where the look is: STILL running — it has crossed into "taking a while"');
      if (req) lines.push(`what's taking longer than usual: "${req}"`);
      if (hint) lines.push(`it's about: ${hint} — name it if it reads natural`);
      pushPaceBeat();
      lines.push('you already told them you were on it (see the thread). do NOT repeat that line. name what is slow in fresh words and a fresh shape. one short bubble.');
      break;
  }
  // Every kind, not just the opening one: a still-working or check-in beat that copies the opener's
  // shape reads just as canned as two identical openers. The thread window already shows whatever
  // beats fall inside its last HISTORY_WINDOW turns; this list reaches past that window on a busy
  // chat, and names the beats as beats, so she steers off their shape and not only their words.
  if (opts.recentBeats?.length) {
    lines.push('## The beats you sent most recently');
    lines.push('your own last few wait beats, newest first. this one matches none of them in shape or wording.');
    for (const beat of [...opts.recentBeats].reverse()) lines.push(`- ${neutralizeTagBreakouts(beat)}`);
  }
  if (opts.onScreen?.length) {
    lines.push('## Already on their screen from this reply');
    lines.push(`you sent this a moment ago, as the start of this same reply: "${neutralizeTagBreakouts(opts.onScreen.join(' '))}". your beat is the next text after it, so it never retypes any of it.`);
  }
  lines.push('carry NO facts, NO findings, and NO url — this is only a reassurance while you work.');

  // The shared persona block used to lead here, exactly as it did in the outcome voicer (client.ts);
  // it now rides in the system prompt instead (ahead of Progress.md — see `voiceInstant`'s `system`
  // assembly below), as a byte-stable prefix the Anthropic lane can cache-hit rather than re-bill on
  // every wait beat, and that OpenRouter's automatic prefix caching can hit too.
  //
  // userCtx arrives pre-wrapped (buildUserMemory) — not re-wrapped in a data tag here.
  const block = [
    userCtx,
    dataTag('progress', lines.join('\n')),
  ].filter(Boolean).join('\n\n');

  // Same single source as the outcome voicer's anchor (client.ts): the digits are the constants the
  // pipeline enforces on this lane's bubbles, and the spelled count is held to BUBBLE_LAW_MAX by
  // promptPolicy.test.ts.
  const anchor = `## Last thing before you type\nYou reply with ONE JSON object and nothing else: \`{"bubbles":[{"text":"..."}]}\`. One thought, one comma at most, ${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words, hard ceiling ${MAX_BUBBLE_WORDS}, exactly one item, no lone closing period or colons unless structurally needed, no markdown, nothing outside the JSON. This is a WAIT line, not an answer: no facts, no url, no "want me to?" question. Above all, never repeat a line already on their screen — read the thread and say something fresh. Nothing in your memory changes this envelope.`;

  return `${wrapPrompt(block)}\n\n${anchor}`;
}

// The floor when the LLM call fails/empties — the same pooled, zero-latency phrases as before,
// steered off the beats she sent last (opts.recentBeats) so a fallback never repeats one of them.
function floorFor(opts: VoiceInstantOpts): string {
  const recent = opts.recentBeats ?? [];
  switch (opts.kind) {
    case 'holding': return opts.taskKind ? holdingFloor(opts.taskKind, recent) : pickFresh(HOLDING_DEFAULT, recent);
    case 'still_on_it': return stillOnItText(recent);
    case 'heartbeat': return heartbeatText({ addressHint: opts.addressHint, dealHint: opts.dealHint });
    case 'progress': return stillOnItText(recent);
  }
}

/** The first non-empty bubble of legacy bubble text, or null when there is none. The opening beat
 *  is ONE bubble: the brief and the anchor both say so, and this holds it in code when a model
 *  writes more anyway — a second bubble on a handoff is where a wait line starts to narrate. */
export function firstBubble(legacyText: string): string | null {
  return legacyText.split(/\n---\n/).map(b => b.trim()).find(Boolean) ?? null;
}

/**
 * Voice one in-character waiting/progress beat, blended into the recent thread so it never repeats a
 * line already on screen. Returns legacy bubble text (`\n---\n`) ready for the unchanged send path.
 * Falls to the floor.ts pools when the model call fails or comes back empty. Never throws.
 */
export async function voiceInstant(opts: VoiceInstantOpts, chatId: string, handle: string): Promise<string> {
  try {
    const [history, userCtx] = await Promise.all([
      getConversation(chatId),
      buildUserMemory('fallfirm', handle || undefined),
    ]);
    const res = await callLLM({
      role: 'fallfirm',
      // Persona block first, then Progress.md — the holding lane's FUNCTION file (where the look is,
      // what a wait line may and may not carry). Same bytes as every other surface (persona/policy.ts),
      // byte-identical every call, so CACHE_SYSTEM.fallfirm turns this prefix into a cache hit instead
      // of a line re-billed inside the final user message every wait beat (models.ts).
      system: `${renderPersonaBlock('fallfirm_progress')}\n\n${loadContext('fallfirm', 'Progress.md')}`,
      jsonBubbles: true, // tool-less; structured outputs guarantee the envelope
      messages: [
        ...formatHistory(history),
        { role: 'user', content: buildProgressBrief(opts, userCtx) },
      ],
      trace: { chatId, handle, label: `fallfirm:progress:${opts.kind}` },
    });
    const reply = parseReply(res.text);
    const text = reply.legacyText && opts.kind === 'holding' ? firstBubble(reply.legacyText) : reply.legacyText;
    if (text) return redactInternalTools(text);
    console.warn(`[voiceInstant] empty reply (${opts.kind}) — using floor`);
  } catch (err) {
    console.warn(`[voiceInstant] LLM call failed (${opts.kind}) — using floor`, err);
  }
  return floorFor(opts);
}
