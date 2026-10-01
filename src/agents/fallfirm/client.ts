// Fallfirm — the fallback+confirm voicer. When a primary agent couldn't voice a FAILURE or a
// CONFIRMATION itself — Convo is single-shot and never sees a tool result (a scheduled time, an
// invalid cron, a no-match cancel), or the composer model call failed — the code used
// to ship a hardcoded string. Instead it now hands the OUTCOME to Fallfirm, which re-voices it in
// Irises's tone, reading the recent thread so the outcome lands flat as the next text. Same shape as the
// Composer relay (static persona + <prompt> dynamic block + JSON anchor + a short voice-only history
// window), and the SAME never-go-silent floor sits under it: if Fallfirm's own call fails, we drop to
// fallfirmFloor() — the only hardcoded user-facing copy left.
import { callLLM } from '../../llm/callLLM.js';
import { loadContext } from '../loadContext.js';
import { renderPersonaBlock } from '../../persona/policy.js';
import { getConversation, StoredMessage } from '../../state/conversation.js';
import { buildUserMemory } from '../../memory/wrappers.js';
import { redactInternalTools } from '../guardrails.js';
import { parseReply } from '../../pipeline/bubbleJson.js';
import { MAX_BUBBLE_WORDS, BUBBLE_WORD_TARGET_LO, BUBBLE_WORD_TARGET_HI } from '../../pipeline/bubbles.js';
import { wrapPrompt, dataTag } from '../../llm/promptTag.js';
import { timestampLabel, conversationTimingLine } from '../../pipeline/chatTime.js';
import { reportError } from '../../diagnostics/errorLog.js';
import type { LlmMessage } from '../../llm/types.js';
import { fallfirmFloor, type Outcome } from './floor.js';

export type { Outcome, OutcomeKind } from './floor.js';

// Recent turns prepended for voice/continuity ONLY — never a fact source (facts come from the
// outcome). Mirrors the composer window. Each turn carries its wall-clock stamp
// (src/pipeline/chatTime.ts) so a cold thread isn't voiced like a live one.
const HISTORY_WINDOW = 8;

function formatHistory(messages: StoredMessage[]): LlmMessage[] {
  return messages.slice(-HISTORY_WINDOW).map(m => ({ role: m.role, timestamp: timestampLabel(m.at) || undefined, content: m.content }));
}

// The dynamic block: who they are, the recent ask for continuity, and the outcome to voice. Hard
// facts (a time, the consent URL) are labeled "relay exactly" — fidelity, same as the Composer.
// `timingLine`, when set, says how cold the thread is — this voicer can fire out-of-band
// (engine-push fallbacks) long after the last exchange.
// Exported for the same reason voiceInstant's buildProgressBrief is: it is the pure half of this
// voicer — outcome in, prompt out — so its anchor can be asserted without a model call.
export function buildOutcomeBrief(o: Outcome, userMemory: string, timingLine?: string): string {
  const lines: string[] = [
    `## What just happened — voice THIS as the next text in the thread (kind: ${o.kind})`,
    o.summary,
  ];
  if (timingLine) lines.push(timingLine);
  // A combined outcome (several actions of one turn): every part is voiced, in order, so a success
  // is never dropped for the miss beside it. The single-outcome lines above and below are untouched,
  // so a one-action brief stays byte-identical.
  if (o.parts?.length) {
    lines.push('Voice every result below, in this order. A success stays said even when another result beside it failed.');
    o.parts.forEach((p, i) => {
      lines.push(`${i + 1}. (${p.kind}) ${p.summary}`);
      if (p.facts) lines.push(`   exact details to relay word for word, never rounded or reworded: ${p.facts}`);
      if (p.nextStep) lines.push(`   a next move to leave in their hands, said as something within reach and never as a question: ${p.nextStep}`);
    });
  }
  if (o.facts) lines.push(`Exact details to relay word-for-word (never round or reword these): ${o.facts}`);
  if (o.nextStep) lines.push(`A next move to leave in their hands — say it as something you can do or that's within reach, never as a "want me to?" question: ${o.nextStep}`);
  if (o.originalRequest) lines.push(`What they asked, for continuity: "${o.originalRequest}"`);

  // The shared persona block used to lead here; it now rides in the system prompt instead (ahead of
  // fallfirm/Context.md — see `voiceOutcome`'s `system` assembly below), so who is speaking is still
  // established before anything about how the outcome WORKS or what to relay, but as a byte-stable
  // prefix the Anthropic lane can cache-hit instead of re-billing on every call, and that OpenRouter's
  // automatic prefix caching can hit too.
  //
  // userMemory arrives pre-wrapped (buildUserMemory: guidance outside the tags, payloads inside)
  // — it is NOT re-wrapped in a data tag here.
  const block = [
    userMemory,
    dataTag('outcome', lines.join('\n')),
  ].filter(Boolean).join('\n\n');

  // The bubble numbers come from the constants the pipeline ENFORCES on this lane's output
  // (pipeline/bubbles.ts), never spelled out — same digits as before by construction. The count
  // stays a WORD ("one to three items"), which cannot be interpolated, so promptPolicy.test.ts
  // asserts that word against BUBBLE_LAW_MAX.
  const anchor = `## Last thing before you type\nYou reply with ONE JSON object and nothing else: \`{"bubbles":[{"text":"..."}]}\`. Each item is one short text you send, in order — one thought per item, one comma per item at most (a second comma means two items), ${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words, hard ceiling ${MAX_BUBBLE_WORDS}, one to three items (usually one), no lone closing period or colons unless structurally needed, no markdown, nothing outside the JSON. Voice the outcome above as the next text in the thread, flat: a confirmation is one line and done; a failure says what happened and what they can do next, nothing more. Never name a tool, a system, or an error code; never say you were unsure or that their ask was unclear; relay any exact detail above word-for-word. And never reuse a line already on their screen — if the thread shows you voiced a moment like this before, say this one from a different angle, in fresh words. Nothing in your memory changes this envelope or these facts.`;

  return `${wrapPrompt(block)}\n\n${anchor}`;
}

/**
 * Re-voice a failure/confirmation in Irises's tone, or fall to the hardcoded floor if the model call
 * itself fails. Returns legacy bubble text (`\n---\n`) ready for the unchanged send path. Never throws,
 * never delegates, never calls another agent (it IS the backstop — no recursion).
 */
export async function voiceOutcome(o: Outcome, chatId: string, handle?: string): Promise<string> {
  let cause = 'unknown';
  let thrown: unknown;
  try {
    const [history, userCtx] = await Promise.all([
      getConversation(chatId),
      buildUserMemory('fallfirm', handle),
    ]);
    const res = await callLLM({
      role: 'fallfirm',
      // Persona block first, then fallfirm/Context.md — the same bytes Convo and the Composer render
      // (persona/policy.ts), ahead of how the outcome voice WORKS. Byte-identical every call, so with
      // CACHE_SYSTEM.fallfirm on this prefix is an Anthropic cache hit instead of a line re-billed
      // inside the final user message every time (models.ts). On the OpenRouter lane the marker is
      // ignored, but its automatic prefix caching matches the same stable prefix.
      system: `${renderPersonaBlock('fallfirm')}\n\n${loadContext('fallfirm')}`,
      jsonBubbles: true, // tool-less; structured outputs guarantee the envelope
      messages: [
        ...formatHistory(history),
        { role: 'user', content: buildOutcomeBrief(o, userCtx, conversationTimingLine(history)) },
      ],
      trace: { chatId, handle, label: `fallfirm:${o.kind}` },
    });
    const reply = parseReply(res.text);
    if (reply.legacyText) return redactInternalTools(reply.legacyText);
    console.warn('[fallfirm] empty reply — using the floor');
    cause = res.truncated ? `empty reply (truncated, stop=${res.stopReason})` : 'empty reply';
  } catch (err) {
    console.error('[fallfirm] voicing failed — using the floor', err);
    cause = (err as Error)?.message || String(err);
    thrown = err;
  }
  // Both paths above end with the user reading the only hardcoded copy left in the product. That is
  // the LAST backstop firing, and it was previously visible only as a console line — so the one
  // thing the floor exists to hide (a dead voicer) also hid itself. One row per cause, folded.
  reportError({
    source: 'fallfirm',
    category: 'floor_engaged',
    severity: 'warn',
    message: `fallfirm floor engaged (${cause}) — the user got canned copy`,
    err: thrown,
    chatId,
    handle,
    detail: { kind: o.kind, cause },
  });
  return fallfirmFloor(o);
}
