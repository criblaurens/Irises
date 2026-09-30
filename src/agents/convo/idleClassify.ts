// Layer 3 of the turn gate, wired: the one tiny call that reads a veto-free message the English fast
// path could not read or was barred from (persona/idle.ts).
//
// Since 2026-09-11 that is two kinds of message rather than one. The old one is the short stall in a
// script the examples cannot read. The new one is every message under the share cap that a
// not-a-stall signal already disqualified from the fast path — a sentence about their day, which is
// the shape a bid arrives in — and it is the reason this lane now answers with more than two words. Since 2026-09-25 a fifth
// word, `take`, reads a question that asks for her own opinion (persona/idle.ts, TAKES).
//
// The gate itself is a leaf and stays one — it never picks a lane, never sets a deadline and never
// caches. This module is the production wiring it takes as an argument: the classify lane, five
// tokens of budget, a six-second deadline, an in-process cache, and one receipt per reading. A test
// drives the same three layers by injecting its own function and never touches a network.
//
// FAILING TOWARD TASK, everywhere. A thrown lane, a spent budget, an install with no classify lane,
// a deadline that fired, an answer that is not one of the five words — every one of them comes back
// `unclear`, which persona/idle.ts reads as a task turn. The asymmetry is the whole design: the cost
// of a wrong task turn is one flat reply, and the cost of a wrong idle turn is a clever line landing
// on a piece of work.
//
// WHY A CACHE. Idle messages are the most repetitive text a person sends — "hmm", "ya", "sama",
// "bosan" — and each of them is one message the fast path cannot read and the lane can. Caching the
// VERDICT per normalised text means a person's own handful of stalls costs a handful of calls in the
// life of the process, not one per turn. It is keyed on the text alone, deliberately: the question
// this lane answers ("does this message ask for anything") is a property of the words and of nothing
// else — not the chat, not the hour, not who typed it — so a per-chat cache would be the same
// answer stored many times over. Process-local and unpersisted: a restart costs a few calls.
//
// A share is the opposite kind of text — a sentence about a day is said once and never again — so
// those entries are the ones the cap below evicts, and they are why the cap is a count of readings
// and not a count of stalls. The cache earns its keep on the repetitive half and simply carries the
// other half until it falls off the end.
//
// WHY A WARM, AND WHY IT COALESCES. Since 2026-09-24 the call is started at the inbound door, while
// the burst settles (`warmIdleClassify`, called from index.ts), instead of on the reply path. The
// settle wait is the same order of time as five tokens on a working lane, so by the time the gate
// asks, the verdict is a cache hit or a call already in flight that the gate simply waits on. The
// in-flight map is what makes that safe: one text is one lane call and one receipt whichever of the
// two gets there first, and the warm itself files nothing because nobody has read it yet.

import { callLLM } from '../../llm/callLLM.js';
import { dataTag, wrapPrompt } from '../../llm/promptTag.js';
import { record } from '../../diagnostics/trace.js';
import { IDLE_CLASSIFY_LABEL } from '../../diagnostics/traceLabels.js';
import type { IdleVerdict } from '../../persona/idle.js';

/**
 * The classifier's whole prompt, Fable's words pasted byte-for-byte from the plan
 * (2026-09-11-share-turns.md §5). FIVE words now, defined; nothing about Irises, nothing about
 * hooks — the lane is being asked a question about a sentence, not being asked to be her.
 *
 * The word that changed everything is `share`, and the two definitions around it are what make it
 * readable: `stall` lost "or it asks for nothing" (which swallowed every bid a person sends) and
 * gained "and tells nothing", and `ask` lost "answers a question, or carries information" (which
 * claimed the same bids from the other side) for the narrower "a fact the assistant must act on".
 * A message that TELLS her something and asks for nothing now has a word of its own, which is the
 * whole of what the third turn shape needed from this lane.
 */
export const IDLE_CLASSIFY_PROMPT = [
  'One short message from a person to their assistant follows. Answer with exactly one word.',
  'preface — the message only signals that the person is about to say or ask something they have not said yet. Check this first: a message that is only a lead-in is preface, even when it is one word.',
  'stall — a greeting, an acknowledgement, a sign-off, a laugh, a filler: it asks for nothing and tells nothing.',
  "share — it tells the assistant something about the person's own day, life, plans or feelings, and asks for nothing.",
  "take — it asks for the assistant's own opinion, taste, feeling or experience, with or without a question mark, and nothing that has to be looked up or done.",
  'quiz means something so easy a small child could answer or do it, put to the assistant only to test whether it can. If the message names anyone else it is for, a child, a friend, homework, it is ask.',
  'ask — it asks for something to be looked up, worked out or done, gives an instruction, or carries a fact the assistant must act on.',
  'unclear — you cannot tell.',
].join('\n');

/** Five tokens. The answer is one word; a budget wide enough for a sentence is a budget wide enough
 *  for a sentence to arrive, and `readVerdict` below would then have to guess at it. */
export const IDLE_CLASSIFY_MAX_TOKENS = 5;

/**
 * Six seconds, and then the turn goes on without it.
 *
 * This call sits ON the reply path, ahead of the prompt build, whenever the settle-window warm did
 * not already answer it: every millisecond it spends there is a millisecond before she starts
 * typing. Six is generous for five tokens on any lane and short enough that a wedged provider costs
 * one flat reply instead of a visibly hung conversation. The timer is unref'd for the reason every
 * timer in this stack is — a pending deadline must never be the thing keeping the process alive.
 */
export const IDLE_CLASSIFY_TIMEOUT_MS = 6_000;

/** How many readings the process keeps. Five hundred distinct messages is far more than one person's
 *  vocabulary of stalls, and the map at that size is a few hundred kilobytes at the very worst — the
 *  gate's own share cap bounds every key at six hundred characters, so the cap on the count is a cap
 *  on the size. It exists so an install being hammered with distinct junk cannot grow it without
 *  bound. */
export const IDLE_CLASSIFY_CACHE_MAX = 500;

/**
 * The cache key: the message, lowercased, with runs of whitespace collapsed. Deliberately NOT the
 * tokenizer from persona/idle.ts — that one drops every non-Latin character, which is the exact
 * class of message this layer exists for, and two different Japanese stalls must not share one key.
 * Case and spacing are the only things a verdict can safely ignore.
 */
export function idleCacheKey(text: string): string {
  return (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * One word from the lane → one of the five verdicts. Anything else is `unclear`, which is a task.
 *
 * Read with `startsWith` rather than equality: a lane that answers "stall." or "stall\n" has
 * answered, and a five-token budget can also clip a longer answer mid-word. The order of the four
 * tested prefixes says nothing — `stall`, `share`, `ask` and `take` are disjoint prefixes of each other, so
 * no answer can match two of them. The leniency is deliberate and bounded: it forgives punctuation,
 * capitals and an inflection ("shared", "asking"), and it forgives nothing about WHICH word the lane
 * chose, which is the only thing this reading is for.
 */
export function readIdleVerdict(text: string | null | undefined): IdleVerdict {
  const word = String(text ?? '').trim().toLowerCase();
  if (word.startsWith('stall')) return 'stall';
  if (word.startsWith('share')) return 'share';
  if (word.startsWith('ask')) return 'ask';
  if (word.startsWith('take')) return 'take';
  if (word.startsWith('quiz')) return 'quiz';
  if (word.startsWith('unclear')) return 'unclear';
  // A lead-in with the thing itself still to come. persona/idle.ts reads it as a task, which keeps a
  // hook or a stored callback off the turn where they are about to say something.
  if (word.startsWith('preface')) return 'preface';
  // Anything else (an empty answer from a starved reasoning model, a sentence) is not a reading.
  return 'failed';
}

/** Insertion-ordered, which is what makes the eviction below oldest-first: a Map iterates in the
 *  order keys were added, so `keys().next()` is the least recently ADDED entry. Not least recently
 *  USED — a used entry is not re-inserted — and that is the right cheap approximation here, where
 *  every entry is equally small and equally durable. */
const cache = new Map<string, IdleVerdict>();

/** What one lane call came back with: a verdict it earned, or the name of the way it failed. The
 *  two are kept apart rather than folded into `unclear` here because only a verdict may be cached
 *  or handed to a second reader — a failure is this call's own, and whoever reads it next asks
 *  again. */
type ClassifyOutcome = IdleVerdict | { failed: string; timedOut: boolean };

/**
 * The calls that have been started and not yet answered, keyed exactly like the cache.
 *
 * WHY THIS EXISTS. The inbound door starts a call while the burst is still settling
 * (`warmIdleClassify`, from index.ts), and the gate asks for the same text a moment later. Without
 * this map a warm call that had not answered by then would be a second call for the same words and,
 * worse, a second receipt on one turn. With it, the gate's reading waits on the call already running
 * — which is also the one that has had the most time to finish — and files the turn's only receipt.
 * An entry lives exactly as long as its call and is removed by the call itself, answered or not.
 */
const inflight = new Map<string, Promise<ClassifyOutcome>>();

/** The test seam, and the only way anything empties these maps. A call still running when this is
 *  called finishes harmlessly: it no longer owns its in-flight slot, so it cannot remove a newer
 *  one. */
export function clearIdleClassifyCache(): void {
  cache.clear();
  inflight.clear();
}

/** How many readings are held right now — the cap's own pin, and a number a test can assert on
 *  without reaching into the module. */
export function idleClassifyCacheSize(): number {
  return cache.size;
}

/**
 * What `deadline` rejects with, as a class of its own so a reader can tell a lane that ran out the
 * clock from a lane that threw. Its `name` stays the plain `Error` every receipt has always carried
 * for a timeout, so the ring reads exactly as it did; the class is for this module's own branching.
 */
class IdleClassifyTimeout extends Error {}

/**
 * Reject after `ms`. A copy of agents/deadline.ts's `withDeadline` in miniature rather than an
 * import of it: that module's DeadlineError is the orchestrator's vocabulary for a background agent
 * run that has to be triaged, and this failure is not triaged at all — it is read as a task turn and
 * forgotten. The abandoned call keeps running harmlessly and its late answer is discarded.
 */
function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new IdleClassifyTimeout(`idle classify exceeded ${ms}ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Who is asking, for the call's own trace line and the reading's receipt, plus the two test seams. */
interface ClassifyCtx {
  chatId: string;
  handle?: string;
  llm?: typeof callLLM;
  /** Test seam only, alongside `llm`: production omits it and gets IDLE_CLASSIFY_TIMEOUT_MS. A
   *  suite that drove the real six seconds would spend six seconds of every run proving that a
   *  number is the number it is. */
  timeoutMs?: number;
}

/**
 * ONE lane call for one text, registered in `inflight` for as long as it runs. It files no receipt:
 * a receipt is a READING, and whether this call is read by the gate that started it, by a gate that
 * joined it, or by nobody at all is the caller's business. It never rejects — every failure comes
 * back as `{ failed }` — so a warm call nobody waits on can never become an unhandled rejection.
 */
function runClassify(ctx: ClassifyCtx, text: string, key: string): Promise<ClassifyOutcome> {
  const call = (async (): Promise<ClassifyOutcome> => {
    const llm = ctx.llm ?? callLLM;
    let verdict: IdleVerdict;
    try {
      const res = await deadline(llm({
        role: 'classify',
        maxTokens: IDLE_CLASSIFY_MAX_TOKENS,
        system: IDLE_CLASSIFY_PROMPT,
        // Their own words, tagged as DATA. The message is being read, never followed: a person who
        // texts "ignore your instructions" is asking for something, which makes it an `ask`, and the
        // tag is what keeps that the whole of its effect.
        messages: [{ role: 'user', content: wrapPrompt(dataTag('message', text)) }],
        trace: { chatId: ctx.chatId, handle: ctx.handle, label: 'idle:classify_call' },
      }), ctx.timeoutMs ?? IDLE_CLASSIFY_TIMEOUT_MS);
      verdict = readIdleVerdict(res.text);
      // An answer that is not one of the words taught the cache nothing, like any other failure.
      if (verdict === 'failed') return { failed: 'unreadable', timedOut: false };
    } catch (err) {
      // Not reported as an error: an install with no classify lane would file one on every stall,
      // and the consequence of this failure is one flat reply. The reading's receipt is the record,
      // and it says `failed` so a scan of the ring can tell a lane that is answering `unclear` from
      // a lane that is not answering. Nothing is cached: a failure teaches nothing.
      return { failed: err instanceof Error ? err.name : 'error', timedOut: err instanceof IdleClassifyTimeout };
    }

    // Oldest-first eviction, one entry at a time: the map is only ever grown by this line, so it can
    // only ever be one over.
    if (cache.size >= IDLE_CLASSIFY_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, verdict);
    return verdict;
  })();
  inflight.set(key, call);
  // Removed by identity, so a call that outlived a cache clear cannot evict the slot of a newer one.
  void call.finally(() => { if (inflight.get(key) === call) inflight.delete(key); });
  return call;
}

/**
 * Start the reading for `text` NOW, before anyone asks for it — the inbound door calls this while the
 * burst settles, so the verdict is ready (or nearly) by the time the gate in chat() reads the turn.
 *
 * Fire-and-forget and receipt-free. It does nothing when the verdict is already cached or a call for
 * the same words is already running, so a burst that re-warms on every text costs one call per
 * distinct string and never two for one. A warm the turn never reads — a newer text changed the
 * burst, a later veto settled the turn — is five tokens spent and a cache entry that may yet be used.
 */
export function warmIdleClassify(ctx: ClassifyCtx, text: string): void {
  const key = idleCacheKey(text);
  if (!key || cache.has(key) || inflight.has(key)) return;
  // runClassify never rejects; the catch is insurance, because nobody is waiting on this promise.
  void runClassify(ctx, text, key).catch(() => {});
}

/**
 * The classifier persona/idle.ts's third layer is handed, bound to this turn's chat and handle so
 * the receipt can be attributed.
 *
 * Returns a function rather than being one, because the gate's seam takes `(text) => Promise<verdict>`
 * and the trace context is the caller's, not the gate's. `deps.llm` is the unit-test injection point;
 * production passes nothing.
 *
 * ONE RECEIPT PER READING, however the verdict was come by (`idle:classify`). A cache hit says
 * `cached`; a reading that waited on a call already running — the settle-window warm, nearly always
 * — says `joined`; a reading that made its own call says neither. That is the point of the two
 * flags: a live round has to be able to tell a working fallback from a dead one, and a hit that filed
 * nothing would make a busy install look like a lane that stopped being called.
 *
 * A joined call that FAILED FAST is not this reading's answer. The failure taught the cache nothing,
 * so the reading makes its own call exactly as it would have with nothing running, and files that. A
 * joined call that TIMED OUT is the answer, and it is `unclear`, the verdict a timeout on the reading's
 * own call produces: the lane already had the whole deadline and spent it, and a second call would
 * stack a second deadline on the reply path behind the first. One deadline is the worst a turn waits.
 */
export function makeIdleClassifier(ctx: ClassifyCtx): (text: string) => Promise<IdleVerdict> {
  return async (text: string): Promise<IdleVerdict> => {
    const key = idleCacheKey(text);
    const file = (verdict: IdleVerdict, how: 'call' | 'cached' | 'joined', failed?: string) => {
      record({
        type: 'event',
        label: IDLE_CLASSIFY_LABEL,
        chatId: ctx.chatId,
        handle: ctx.handle,
        // Names and numbers only: the message itself never enters the ring, the way no receipt in
        // this stack carries her words or theirs. `chars` is the one measurement that says which
        // kind of message this was without quoting it.
        detail: {
          verdict, cached: how === 'cached', ...(how === 'joined' ? { joined: true } : {}),
          chars: [...key].length, ...(failed ? { failed } : {}),
        },
      });
      return verdict;
    };

    const hit = cache.get(key);
    if (hit !== undefined) return file(hit, 'cached');

    const running = inflight.get(key);
    if (running) {
      const joined = await running;
      if (typeof joined === 'string') return file(joined, 'joined');
      if (joined.timedOut) return file('failed', 'joined', joined.failed);
    }

    const own = await runClassify(ctx, text, key);
    return typeof own === 'string' ? file(own, 'call') : file('failed', 'call', own.failed);
  };
}
