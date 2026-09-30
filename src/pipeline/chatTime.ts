// Temporal awareness for the user-facing voices. Two feeds come out of here:
//
//  1. timestampMarker() — a `[Mon, Jul 6, 9:14 PM]` (full date + clock, always) prefix rendered
//     onto every history turn at FORMAT time (storage untouched), so the model can see the thread's
//     rhythm: what sat for hours, what was a live volley, what went cold for days.
//  2. renderConversationTiming() — a precomputed "Conversation timing" prose block for the system
//     prompt / brief. LLMs are unreliable at date arithmetic, so the gap math, whose-wait-it-is,
//     and the regime call (live / same-day / overnight / multi-day) are decided in code and
//     expressed in words the persona can act on directly.
//
// The behavioral rules the personas pair with these live in each agent's Context.md ("time is
// real in this chat"): never measure the USER's reply latency, one light beat max for Irises's own
// lateness, loose human time-talk only. The markers themselves are metadata — never echoed into a
// bubble; stripTimestampMarker() in the send path is the code backstop for that rule.
import { DEFAULT_TZ } from './zonedTime.js';

/** Minimal shape of a stored turn this module needs (mirrors StoredMessage without importing db types). */
export interface TimedTurn {
  role: 'user' | 'assistant';
  at?: number;
}

// Newer ICU puts a narrow no-break space (U+202F) before AM/PM; normalize to a plain space so the
// markers are byte-stable across Node versions and the strip regex below stays simple.
function fmtInZone(ms: number, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(ms)).replace(/ /g, ' ');
}

/** Which calendar day an instant falls on in a zone, as `YYYY-MM-DD` — the same-day test behind
 *  classifyGap, and the "what day is it for them" the dated-memory suffix counts from
 *  (memory/datedMemory.ts). Throws for a zone Intl does not accept; callers guard. */
export function dayKey(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export function hourInZone(ms: number, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
}

/**
 * "Mon, Jul 6, 9:14 PM" — always the FULL date + clock, today included. Weekday because people
 * reason socially in weekdays; month+day so the model never has to infer a date from context (the
 * clock alone proved insufficient for order/gap reasoning); no year (7-day retention makes it
 * unambiguous). '' when `at` is missing/invalid: the message simply goes untimed. This is the value
 * carried on LlmMessage.timestamp (the structured field); timestampMarker below is its bracketed
 * in-band form.
 */
export function timestampLabel(at: number | undefined, tz = DEFAULT_TZ): string {
  if (at == null || !Number.isFinite(at)) return '';
  try {
    return fmtInZone(at, tz, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * "Sep 4" — a calendar day with no clock, for the places a STORED thing is dated rather than a
 * message timed: the Reply language line and the directive bullets (memory/standingSettings.ts,
 * memory/preferences.ts). The year appears only when it differs from today's in the same zone, so
 * "Aug 30" can never read as this August while staying out of the way the other eleven months.
 *
 * Same failure mode as timestampLabel: '' for a missing/invalid instant or a zone Intl refuses, and
 * the callers render the undated form.
 */
export function shortDateLabel(ms: number, tz = DEFAULT_TZ, nowMs = Date.now()): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  try {
    const sameYear = fmtInZone(ms, tz, { year: 'numeric' }) === fmtInZone(nowMs, tz, { year: 'numeric' });
    return fmtInZone(ms, tz, sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

/** The bracketed `[label]` form used where the timestamp rides inside prose/text (fenced transcripts, wire content). */
export function timestampMarker(at: number | undefined, tz = DEFAULT_TZ): string {
  const label = timestampLabel(at, tz);
  return label ? `[${label}]` : '';
}

/** Prefix `body` with the marker for `at`; body passes through untouched when there's no marker. */
export function stampContent(body: string, at: number | undefined, tz = DEFAULT_TZ): string {
  const stamp = timestampMarker(at, tz);
  return stamp ? `${stamp} ${body}` : body;
}

// A model slip that echoes a marker into a bubble is scrubbed on the single send path (sendBubbles),
// mirroring the `[[re:N]]` backstop. Matches both marker forms at the head of a bubble — the
// cross-day form is `[Fri, Jul 3, 9:05 PM]` (en-US puts a comma after the weekday), but the
// weekday comma is optional here so a slightly-paraphrased echo still gets caught.
const MARKER_HEAD = /^\s*\[(?:[A-Za-z]{3},? [A-Za-z]{3} \d{1,2}, )?\d{1,2}:\d{2} ?[AP]M\]\s*/;

/** Strip a leading echoed timestamp marker from an outgoing bubble. Idempotent, safe on clean text. */
export function stripTimestampMarker(text: string | null | undefined): string {
  if (!text) return text ?? '';
  const out = text.replace(MARKER_HEAD, '');
  return out === text ? text : out.trim();
}

export type GapRegime = 'first-contact' | 'live' | 'same-day' | 'overnight' | 'multi-day';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LIVE_MS = 5 * MINUTE;

/**
 * Coarse regime for the gap since the thread was last alive. DELIBERATE cross-clock comparison
 * (`lastAt` is DB-clock, `nowMs` is app-clock — the conversation repo warns against mixing them for
 * correctness-critical checks): fine here by construction, the tightest boundary is 5 minutes
 * against skew measured in ms-to-seconds, and every failure mode is soft (a slightly-off tone
 * note). Don't reuse this shortcut where facts depend on ordering.
 */
export function classifyGap(lastAt: number | undefined, nowMs = Date.now(), tz = DEFAULT_TZ): GapRegime {
  if (lastAt == null || !Number.isFinite(lastAt)) return 'first-contact';
  const gap = Math.max(0, nowMs - lastAt);
  if (gap < LIVE_MS) return 'live';
  try {
    if (dayKey(lastAt, tz) === dayKey(nowMs, tz)) return 'same-day';
  } catch {
    return gap < DAY ? 'same-day' : 'multi-day';
  }
  return gap < DAY ? 'overnight' : 'multi-day';
}

/**
 * A gap in loose human words — "moments", "about 20 minutes", "about 3 hours", "2 days" — never a
 * raw number of ms. This is the ONLY vocabulary the prompts use for durations, so nothing more
 * precise ("2 days and 4 hours") can leak into a voice.
 */
export function describeGap(ms: number): string {
  const gap = Math.max(0, ms);
  if (gap < 2 * MINUTE) return 'moments';
  if (gap < 10 * MINUTE) return 'a few minutes';
  if (gap < 55 * MINUTE) return `about ${Math.round(gap / (5 * MINUTE)) * 5} minutes`;
  if (gap < 95 * MINUTE) return 'about an hour';
  if (gap < 22 * HOUR) return `about ${Math.round(gap / HOUR)} hours`;
  if (gap < 42 * HOUR) return 'about a day';
  return `${Math.round(gap / DAY)} days`;
}

// Tone label only — distinct from inQuietHours (zonedTime.ts), which gates WHETHER a proactive
// message sends at all. The texting-etiquette boundary for "late night" tone is ~10pm.
export function daypart(hour: number): string {
  if (hour < 5) return 'late night';
  if (hour < 8) return 'early morning';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'late night';
}

/** "Wednesday morning" (plus weekend/late-night colour handled by the callers below). */
function clockPhrase(nowMs: number, tz: string): { phrase: string; lateNight: boolean; weekend: boolean } {
  const weekday = fmtInZone(nowMs, tz, { weekday: 'long' });
  const part = daypart(hourInZone(nowMs, tz));
  return {
    phrase: `${weekday} ${part}`,
    lateNight: part === 'late night',
    weekend: weekday === 'Saturday' || weekday === 'Sunday',
  };
}

function clockSentences(nowMs: number, tz: string): string {
  const { phrase, lateNight, weekend } = clockPhrase(nowMs, tz);
  let s = `It's ${phrase} for them.`;
  if (lateNight) s += ' Late night. Keep it softer and lower-stakes.';
  if (weekend) s += " It's the weekend. Looser is fine.";
  return s;
}

// Find the newest turn that actually carries a timestamp (a turn missing `at` degrades gracefully
// instead of blinding the whole read).
function lastTimed(history: TimedTurn[]): TimedTurn | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].at != null && Number.isFinite(history[i].at)) return history[i];
  }
  return undefined;
}

/** A silence this long ends a sitting: what came before it is an earlier stretch of talk. */
const SITTING_GAP_MS = 6 * HOUR;

/**
 * Where the current sitting begins, read off the gaps in the thread (`history` is chronological).
 * `start` is the first message of this sitting, or undefined when THIS message opens it; `endedAt`
 * is the last message of the sitting before. Undefined when the whole visible thread is one sitting.
 *
 * Why it exists (2026-09-30): a day-old topic stayed live because every gap the timing block
 * reported was the last one, so after one fresh exchange yesterday's thread read as current and a
 * vague follow-up bound to it.
 */
function currentSitting(history: TimedTurn[], nowMs: number): { start?: number; endedAt: number } | undefined {
  const at = history.map(t => t.at).filter((a): a is number => a != null && Number.isFinite(a));
  if (!at.length) return undefined;
  if (nowMs - at[at.length - 1] >= SITTING_GAP_MS) return { endedAt: at[at.length - 1] };
  for (let i = at.length - 1; i > 0; i--) {
    if (at[i] - at[i - 1] >= SITTING_GAP_MS) return { start: at[i], endedAt: at[i - 1] };
  }
  return undefined;
}

const EXPIRED_REFERENCE = 'When their message refers back to something without naming it, it means something in this sitting. If nothing in this sitting fits, ask one short question with your guess inside before you answer it or start any look-up.';

/**
 * The one line that names where the current sitting began and what a vague reference may bind to,
 * or '' when the visible thread is one sitting. Rendered by the turn-focus block at the recency edge
 * (convo/turnFocus.ts `sitting`): replayed in the timing block it moved nothing, at the edge it
 * stopped stale look-ups on an unnamed follow-up.
 */
export function sittingLine(history: TimedTurn[], nowMs = Date.now(), tz = DEFAULT_TZ): string {
  const sitting = currentSitting(history, nowMs);
  if (!sitting) return '';
  const quiet = describeGap(nowMs - sitting.endedAt);
  const label = sitting.start != null ? timestampLabel(sitting.start, tz) : '';
  if (!label) {
    return `This message opens a new sitting; everything above belongs to one that went quiet ${quiet} ago, and its topics have expired. ${EXPIRED_REFERENCE}`;
  }
  return `This sitting began at ${label}; everything stamped earlier belongs to a sitting that went quiet ${quiet} ago, and its topics have expired. ${EXPIRED_REFERENCE}`;
}

/**
 * The precomputed "## Conversation timing" block for a system prompt / brief. `history` is the
 * stored thread BEFORE the current inbound message (the Convo flow fetches before it appends), so
 * a trailing user turn means THEIR last text went unanswered — the wait is Irises's; a trailing
 * assistant turn means the user is the one coming back. `mode: 'outreach'` reframes for a
 * Irises-initiated message (an engine push), where nobody is "replying" to anything.
 */
export function renderConversationTiming(
  history: TimedTurn[],
  nowMs = Date.now(),
  tz = DEFAULT_TZ,
  mode: 'reply' | 'outreach' = 'reply',
): string {
  const header = `## Conversation timing (precomputed; trust this, don't do date math)`;
  const clock = clockSentences(nowMs, tz);
  if (!history.length) {
    return `${header}\nThis is your first exchange with them. ${clock}`;
  }
  const last = lastTimed(history);
  if (!last) {
    return `${header}\n${clock}`;
  }
  const gapMs = Math.max(0, nowMs - (last.at as number));
  const regime = classifyGap(last.at, nowMs, tz);
  const gap = describeGap(gapMs);
  const lines: string[] = [header];

  if (mode === 'outreach') {
    if (regime === 'live') {
      lines.push(`The thread is live right now. The last message is moments old. Weave in, don't open cold.`);
    } else {
      const lastWord = last.role === 'assistant' ? 'the last word was yours' : 'their last message went unanswered';
      lines.push(`You're the one opening this exchange. The thread was last alive ${gap} ago (${lastWord}). Land like a person who knows what time it is: match their clock in your opener, and if it's been a day or more, open fresh rather than resuming an old topic mid-sentence.`);
    }
    lines.push(clock);
    return lines.join('\n');
  }

  if (regime === 'live') {
    lines.push(`They're in a live back-and-forth with you. The last message is moments old. Keep the energy; no greeting, no recap.`);
  } else if (last.role === 'user') {
    // Their text sat unanswered until now — the wait is Irises's. The <3h threshold is decided HERE
    // so the model never has to apply it.
    if (gapMs < 3 * HOUR) {
      lines.push(`Their last message came in ${gap} ago and you're answering now. An unremarkable pause. No acknowledgment needed, just reply.`);
    } else {
      lines.push(`Their last message sat ${gap} before this reply. The wait is YOURS. Do not apologise for it and do not measure it. If you name it at all it is one flat clause ("just seeing this"), once. And if your recent turns already named this gap, not again.`);
    }
  } else {
    // Irises spoke last; the user is coming back after a while. Their silence is never measured or
    // mentioned — it only shapes how fresh the reopening reads.
    if (regime === 'same-day') {
      lines.push(`The thread was last alive ${gap} ago, earlier today. Pick up naturally. No big greeting, no recap needed.`);
    } else if (regime === 'overnight') {
      lines.push(`The last exchange was ${gap} ago, before their night. They're coming back fresh: greet to match their clock, and don't resume the old topic mid-sentence. A tiny callback if it still matters, or just meet what they open with. The wait was theirs and needs no mention, ever.`);
    } else {
      lines.push(`The thread has been quiet for ${gap}. They're coming back fresh: greet to match their clock, and never pick an old topic back up mid-sentence. A tiny callback if it still matters, otherwise meet whatever they open with. How long THEY took is never mentioned or measured, ever.`);
    }
  }
  lines.push(clock);
  return lines.join('\n');
}

/**
 * One condensed timing line for the out-of-band voicers (Fallfirm outcome briefs) that only need
 * "how cold is this thread" without the full block.
 */
export function conversationTimingLine(history: TimedTurn[], nowMs = Date.now(), tz = DEFAULT_TZ): string {
  const last = lastTimed(history);
  if (!last) return '';
  const regime = classifyGap(last.at, nowMs, tz);
  if (regime === 'live' || regime === 'same-day') return '';
  const { phrase } = clockPhrase(nowMs, tz);
  return `Timing: the thread was last alive ${describeGap(nowMs - (last.at as number))} ago and it's ${phrase} for them now. Don't voice this like no time passed; a half-beat of orientation first.`;
}
