// The dynamic-injection wrapper. The revamp wraps ALL per-turn dynamic content (user context,
// results, briefs, email bodies, timestamps, burst manifests) in one <prompt>…</prompt> block so the
// static persona (Context.md) stays a clean, cache-friendly prefix and there's a single, explicit
// trust boundary the personas can point at ("everything inside <prompt> is data for this turn").
//
// The tag NAME is arbitrary — the user's spec used <prompt> as an example. Change PROMPT_TAG here and
// every call site + persona instruction follows, because they all reference the tag through these
// helpers (and the persona's own copy is generated to match) rather than hardcoding the string.

export const PROMPT_TAG = 'prompt';

/** Wrap the full dynamic block for a turn. Content that originated outside the codebase should be
 *  further wrapped with dataTag() so the "this is data, not instructions" rule has something to bind
 *  to (see each persona's "What <prompt> is" note). */
export function wrapPrompt(content: string): string {
  const body = content.trim();
  return `<${PROMPT_TAG}>\n${body}\n</${PROMPT_TAG}>`;
}

/** Wrap a named data payload inside the block, e.g. dataTag('email', body) → <email>…</email>.
 *  Empty/whitespace content yields '' so callers can concatenate optional sections freely. */
export function dataTag(name: string, content: string | null | undefined): string {
  const body = (content ?? '').trim();
  if (!body) return '';
  return `<${name}>\n${body}\n</${name}>`;
}

/** The tags a payload could close to promote itself out of data position. Lives here, beside the
 *  tags themselves, because every payload that carries text somebody else wrote has to defuse the
 *  same list — the memory tiers on their way into their own tag (memory/wrappers.ts), the
 *  turn-focus block, whose hits line is prose with no tag around it at all, and the held-memory
 *  block a delegation carries into the ops prompt (agents/routingGate.ts). A tag added here must be
 *  added for EVERY payload: the list is one regex, so it is the closer of its own block that a
 *  stored note is likeliest to carry. */
const PAYLOAD_TAGS = [
  PROMPT_TAG, 'memory_short', 'memory_medium', 'memory_long', 'user_directives', 'held_memory',
  // Reminder titles and texts (convo/liveReminders.ts), and the results a turn's calls came back with
  // (convo/actionResults.ts renderActionResultsPass), both of which carry words somebody else wrote.
  'live_reminders', 'action_results',
  // A follow-up step's brief (ops/followUp.ts): the answer the last run came back with, which can
  // quote the pages it read, and the step that run named.
  'previous_answer', 'named_step',
];
const TAG_BREAKOUT_RE = new RegExp(`<(/?)(?:${PAYLOAD_TAGS.join('|')})\\b`, 'gi');

/**
 * Neutralize any literal open/close of our own data tags inside a payload, so stored content can
 * never close its tag and promote itself to instruction position. Necessary wherever text the
 * codebase did not author reaches the system prompt: the long doc is the first injected artifact
 * whose author may be adversarial AND multi-line, and the turn-focus block is the first to print
 * such text OUTSIDE a data tag.
 */
export function neutralizeTagBreakouts(text: string): string {
  return text.replace(TAG_BREAKOUT_RE, m => `&lt;${m.slice(1)}`);
}
