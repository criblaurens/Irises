// The reach judge: the one tiny call that reads a message and says whether answering it needs reach
// she lacks — information that changes, their own accounts or machine, running code, the inside of a
// file or link, or work on the engine's side (docs: 2026-09-27 delegate-for-reach design). The
// routing floor forces a look only on its confident `reach`; everything else she answers herself.
//
// Shaped after idleClassify.ts on purpose: the classify lane, five tokens, a six-second deadline, a
// per-text cache and in-flight coalescing, warmed at the inbound door while the burst settles so the
// verdict is waiting by the time anything reads it. Two readers, one verdict: the early-emit pre-check
// PEEKS (it never waits — an unknown verdict only costs that turn its early bubble) and the gate,
// which runs after the Convo call, READS (awaiting a call still in flight, bounded by the deadline).
//
// FAILING TOWARD HER, everywhere. A thrown lane, a timeout, an unreadable word, an install with no
// lane — each reads `failed`, which the gate treats as "she decides". The floor exists to catch a
// fabricated live fact; a wrong force throws away a correct reply and costs the person half a minute.

import { callLLM } from '../../llm/callLLM.js';
import { dataTag, wrapPrompt } from '../../llm/promptTag.js';
import { isLaneConfigured } from '../../llm/laneKeys.js';
import { needsGrounding } from '../routingGate.js';

export const REACH_CLASSIFY_PROMPT = [
  'One message from a person to their assistant follows, in whatever language they write. Answer with exactly one word.',
  'reach — answering it needs something beyond the message and settled knowledge: information that changes or must be current (prices, weather, news, schedules, availability, the latest of anything), the person\'s own accounts, inbox, files or machine, code run for a result, the contents of a file or link they sent, or something done on the assistant\'s own side. Advice or reasoning that depends on such information counts.',
  'none — it can be answered by thinking, writing, calculating, counting, or knowledge that does not change, or it is about the assistant, the person, or their conversation.',
  'unclear — you cannot tell.',
].join('\n');

export const REACH_CLASSIFY_MAX_TOKENS = 5;
export const REACH_CLASSIFY_TIMEOUT_MS = 6_000;
export const REACH_CLASSIFY_CACHE_MAX = 500;

export type ReachVerdict = 'reach' | 'none' | 'unclear' | 'failed';

export interface ReachCtx {
  chatId: string;
  handle?: string;
  /** Test seam: production omits it and gets the real classify lane. */
  llm?: typeof callLLM;
  /** Test seam: production omits it and gets REACH_CLASSIFY_TIMEOUT_MS. */
  timeoutMs?: number;
}

export function reachCacheKey(text: string): string {
  return (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function readReachWord(text: string | null | undefined): ReachVerdict {
  const word = String(text ?? '').trim().toLowerCase();
  if (word.startsWith('reach')) return 'reach';
  if (word.startsWith('none')) return 'none';
  if (word.startsWith('unclear')) return 'unclear';
  return 'failed';
}

// Earned verdicts only: a failure is never cached, so the next reader of that text gets a fresh try.
const cache = new Map<string, ReachVerdict>();
const inflight = new Map<string, Promise<ReachVerdict>>();
let override: ((text: string) => ReachVerdict) | null = null;

/** Test seam: every reader gets this function's answer, with no lane, cache or call involved. */
export function setReachJudgeForTests(fn: ((text: string) => ReachVerdict) | null): void {
  override = fn;
}

export function clearReachClassifyCache(): void {
  cache.clear();
  inflight.clear();
}

function anyLaneConfigured(): boolean {
  return isLaneConfigured('openrouter') || isLaneConfigured('anthropic') || isLaneConfigured('openai');
}

class ReachClassifyTimeout extends Error {}

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReachClassifyTimeout(`reach classify exceeded ${ms}ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

function runClassify(ctx: ReachCtx, text: string, key: string): Promise<ReachVerdict> {
  const call = (async (): Promise<ReachVerdict> => {
    try {
      const res = await deadline((ctx.llm ?? callLLM)({
        role: 'classify',
        maxTokens: REACH_CLASSIFY_MAX_TOKENS,
        system: REACH_CLASSIFY_PROMPT,
        messages: [{ role: 'user', content: wrapPrompt(dataTag('message', text)) }],
        trace: { chatId: ctx.chatId, handle: ctx.handle, label: 'reach:classify_call' },
      }), ctx.timeoutMs ?? REACH_CLASSIFY_TIMEOUT_MS);
      const verdict = readReachWord(res.text);
      if (verdict === 'failed') return verdict;
      if (cache.size >= REACH_CLASSIFY_CACHE_MAX) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, verdict);
      return verdict;
    } catch {
      return 'failed';
    }
  })();
  inflight.set(key, call);
  void call.finally(() => { if (inflight.get(key) === call) inflight.delete(key); });
  return call;
}

/** Start the reading without waiting for it. A no-op when the text is read, being read, or there is
 *  no lane to read it with. */
export function warmReachClassify(ctx: ReachCtx, text: string): void {
  if (override) return;
  const key = reachCacheKey(text);
  if (!key || cache.has(key) || inflight.has(key)) return;
  if (!ctx.llm && !anyLaneConfigured()) return;
  void runClassify(ctx, text, key);
}

/** The verdict if it is already known, `undefined` while a call is still out. Never waits. */
export function peekReachVerdict(text: string): ReachVerdict | undefined {
  if (override) return override(text);
  const key = reachCacheKey(text);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return undefined;
  return anyLaneConfigured() ? undefined : 'failed';
}

/** The verdict, awaiting a call in flight or making one. Never throws. */
export async function readReachVerdict(ctx: ReachCtx, text: string): Promise<ReachVerdict> {
  if (override) return override(text);
  const key = reachCacheKey(text);
  if (!key) return 'failed';
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const running = inflight.get(key);
  if (running) return running;
  if (!ctx.llm && !anyLaneConfigured()) return 'failed';
  return runClassify(ctx, text, key);
}

/** Where the turn's verdict came from: the structural screen (a link, a path), or the judge. */
export type ReachSource = 'structural' | ReachVerdict | 'pending';

/** The gate's one question: does THIS turn need reach she lacks? Structure answers without a call;
 *  otherwise only a confident `reach` from the judge says yes. Never throws. */
export async function turnNeedsReach(ctx: ReachCtx, text: string): Promise<{ needs: boolean; reach: ReachSource }> {
  if (needsGrounding(text) === 'yes') return { needs: true, reach: 'structural' };
  const verdict = await readReachVerdict(ctx, text);
  return { needs: verdict === 'reach', reach: verdict };
}

/** The early-emit pre-check's reading of the same verdict, without waiting: a verdict still out
 *  counts as flagged, so a turn the gate might yet force never streams its draft early. */
export function reachFlagged(text: string): boolean {
  if (needsGrounding(text) === 'yes') return true;
  const verdict = peekReachVerdict(text);
  return verdict === undefined || verdict === 'reach';
}
