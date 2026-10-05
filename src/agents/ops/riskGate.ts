// src/agents/ops/riskGate.ts
// Should this delegation wait for their yes? The approval park (convo/shared.ts) reads its
// reasons here.
//
// It used to have ONE: the engine would act on something of THEIRS (`effect: act`,
// agents/ops/sideEffects.ts). Two more live here:
//   • host_setup: an engine action that brings new code onto their machine or runs it there.
//     Waits always: the engine runs on their machine with a terminal, so a wrong setup is
//     arbitrary code on it.
//   • tainted: any engine action while text from outside (a page, an email, a file) is in her
//     context. Words in that text were written by people the user never vouched for, and an
//     action proposed right after it has to be confirmed as THEIRS.
//
// LANGUAGE-AGNOSTIC RULE (user, 2026-09-04): the lexicon is English only. Everything it cannot
// read goes to the classify lane, and a lane that cannot answer is a yes-needed. Over-asking
// costs one turn; under-asking runs something nobody approved.

import { callLLM } from '../../llm/callLLM.js';
import { wrapPrompt, dataTag } from '../../llm/promptTag.js';
import { reportError } from '../../diagnostics/errorLog.js';
import { latestShortTermStrict, type ShortKind, type ShortTermEntry } from '../../db/repositories/memoryShort.js';
import { RECENT_RESEARCH_TTL_MS } from '../../memory/shortTerm.js';
import type { SideEffect } from './sideEffects.js';

/** Why a delegation waits for their yes. Receipts and the ask's wording read these. */
export type GateReason = 'act' | 'host_setup' | 'tainted';

/**
 * The host-setup lexicon: ENGLISH ONLY, whole words, case-insensitive. Narrow on purpose. It names
 * bringing code in, running it, and touching the engine's settings or secrets. Everything else
 * (a follow-up check, a named procedure the engine already has) is the lane's call.
 */
export const HOST_SETUP_PHRASES = [
  'install', 'download', 'clone', 'set up', 'pip', 'npm', 'npx', 'brew', 'curl', 'wget',
  'sudo', 'chmod', 'shell', 'terminal', 'script', 'execute', 'config', 'configure', 'settings',
  'permission', 'permissions', 'api key', 'token', 'password', 'credential', 'credentials',
] as const;

const NON_WORD = /[^a-z0-9]+/g;
const LINK = /https?:\/\/\S+/i;
const PHRASE_TOKENS = HOST_SETUP_PHRASES.map(p => p.split(' '));

/** What made this action host setup ('link', or the phrase that matched), or undefined. PURE. */
export function findHostSetupSignal(action: string): string | undefined {
  if (LINK.test(action)) return 'link';
  const tokens = action.toLowerCase().replace(NON_WORD, ' ').trim().split(' ').filter(Boolean);
  for (const words of PHRASE_TOKENS) {
    for (let at = 0; at + words.length <= tokens.length; at++) {
      if (words.every((w, i) => tokens[at + i] === w)) return words.join(' ');
    }
  }
  return undefined;
}

const HOST_SETUP_SYSTEM_PROMPT = [
  "An AI agent with a terminal on the user's own computer is about to set itself up for a task. Below are the setup actions it proposes.",
  "Decide whether ANY of them brings new code onto that computer (installing or downloading anything: a skill, plugin, package, server or script), runs a command or script, changes the agent's own settings or permissions, or handles a password, key or token.",
  'Reply with exactly one word: RISKY if any action does, SAFE if none does. When in doubt, RISKY: a wrong SAFE runs something on their machine that nobody approved.',
].join(' ');

let llmForTests: typeof callLLM | null = null;

/** Test seam for suites that drive the park end to end (the __setConsentLlmForTests pattern). */
export function __setHostSetupLlmForTests(fn: typeof callLLM | null): void {
  llmForTests = fn;
}

/**
 * Does any of these engine actions bring code onto their machine or run it? The lexicon first
 * (free, instant), then ONE classify call for whatever it could not read. Every failure is risky.
 */
export async function judgeHostSetup(
  actions: readonly string[],
  deps: { llm?: typeof callLLM } = {},
): Promise<{ risky: boolean; trigger: 'none' | 'lexicon' | 'llm' | 'lane_failed'; signal?: string }> {
  if (!actions.length) return { risky: false, trigger: 'none' };
  for (const a of actions) {
    const signal = findHostSetupSignal(a);
    if (signal) return { risky: true, trigger: 'lexicon', signal };
  }
  const llm = deps.llm ?? llmForTests ?? callLLM;
  try {
    const res = await llm({
      role: 'classify',
      system: HOST_SETUP_SYSTEM_PROMPT,
      // Model-written text, tagged as data: it is being CLASSIFIED, never followed.
      messages: [{ role: 'user', content: wrapPrompt(actions.map((a, i) => dataTag(`action_${i + 1}`, a)).join('\n')) }],
      trace: { label: 'ops:host_setup' },
    });
    const word = (res.text ?? '').trim().toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ')[0] ?? '';
    return { risky: word !== 'SAFE', trigger: 'llm' };
  } catch (err) {
    reportError({
      source: 'ops', category: 'classifier_failure', severity: 'warn',
      message: 'host-setup classification failed; the action waits for their yes', err,
    });
    return { risky: true, trigger: 'lane_failed' };
  }
}

/** Every reason this delegation waits. Empty means it runs. PURE. */
export function gateReasons(v: {
  effect: SideEffect; engineActions: readonly string[]; hostSetup: boolean; tainted: boolean;
}): GateReason[] {
  const reasons: GateReason[] = [];
  if (v.effect === 'act') reasons.push('act');
  if (v.hostSetup) reasons.push('host_setup');
  if (v.tainted && v.engineActions.length) reasons.push('tainted');
  return reasons;
}

/**
 * Is text from outside in her context right now? True while an engine or media result was
 * delivered inside the recent-research window, which is exactly how long its full text sits in
 * her prompt (memory/shortTerm.ts). `from` is the ask that produced it, for the receipt and the
 * ask's wording. A failed read is tainted: the cost is one extra question. That is why it reads
 * through the strict (throwing) query: the everyday one degrades a DB error to "nothing there".
 */
export async function readTaint(
  handle: string,
  now: number = Date.now(),
  deps: { latest?: (h: string, k: ShortKind[]) => ShortTermEntry | null | Promise<ShortTermEntry | null> } = {},
): Promise<{ tainted: boolean; from?: string }> {
  try {
    const latest = await (deps.latest ?? latestShortTermStrict)(handle, ['ops_research', 'media_analysis']);
    if (latest && now - latest.createdAt <= RECENT_RESEARCH_TTL_MS) {
      return latest.request ? { tainted: true, from: latest.request } : { tainted: true };
    }
    return { tainted: false };
  } catch {
    return { tainted: true };
  }
}
