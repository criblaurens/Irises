// Unsend: Irises taking back ONE bubble of her previous reply (spec:
// docs/superpowers/specs/2026-10-01-unsend-design.md). Very rare by construction. Code decides
// WHEN the tool exists (the bubble is still inside the platform's window, and nothing was unsent in
// this chat for a week); she decides WHETHER, and the irritated ground is checked against her mood.
//
// "Her previous reply" is everything she sent since the person last spoke, held in memory. A
// restart forgets it, which only means no unsend is on offer until she speaks again.
import { getEngineBackend } from '../agents/ops/engineBackend.js';
import { parseBridgeChatId } from '../channels/bridge/channel.js';
import { lastUnsentAt, recordUnsent } from '../db/repositories/unsentMessages.js';
import type { MoodCore } from '../persona/mood.js';

export const UNSEND_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Taken off every window so a takeback never races the platform's cutoff. */
export const UNSEND_MARGIN_MS = 15_000;
/** The irritated ground needs her mood at `mad` and this low. */
export const UNSEND_MOOD_LEVEL_MAX = 25;
const REACH_CAP = 6;

/** How long each platform lets a sender take a message back. A platform not listed has no unsend. */
const PLATFORM_WINDOW_MS: Record<string, number> = {
  telegram: 48 * 60 * 60 * 1000, // Bot API deleteMessage: the bot's own messages, 48h
  photon: 2 * 60 * 1000,         // iMessage unsend
};
const WEB_WINDOW_MS = 2 * 60 * 1000; // the debug lane, so the path can be driven locally

export const UNSEND_WHYS = ['they_are_annoyed', 'i_am_irritated'] as const;
export type UnsendWhy = typeof UNSEND_WHYS[number];
export interface UnsendRequest { bubble: number; why: UnsendWhy }

export interface ReachableBubble { id: string; text: string; at: number }

export function unsendWindowMs(chatId: string): number | null {
  if (chatId.startsWith('web:')) return WEB_WINDOW_MS;
  const parsed = parseBridgeChatId(chatId);
  // An engine with no unsend seam (OpenClaw) would fail every call, so its chats have no window.
  if (!parsed || !getEngineBackend()?.channelUnsend) return null;
  return PLATFORM_WINDOW_MS[parsed.platform] ?? null;
}

const current = new Map<string, ReachableBubble[]>();  // sent since their last message
const previous = new Map<string, ReachableBubble[]>(); // her previous reply: what an unsend can reach
const offered = new Map<string, ReachableBubble[]>();  // the list this turn's tool showed, by number

/** A bubble just went out. Synthetic ids (an engine that reported none) can't be taken back. */
export function noteSentBubble(chatId: string, id: string, text: string, at: number = Date.now()): void {
  if (!id || id.startsWith('eng-out-') || unsendWindowMs(chatId) == null) return;
  const list = current.get(chatId) ?? [];
  list.push({ id, text, at });
  current.set(chatId, list.slice(-REACH_CAP));
}

/** They spoke: what she sent before this is now her previous reply. A burst rotates once. */
export function noteInbound(chatId: string): void {
  const sent = current.get(chatId);
  if (!sent?.length) return;
  previous.set(chatId, sent);
  current.delete(chatId);
}

/** The bubbles this turn may offer, or [] when the tool must not exist. Remembers what it offered
 *  so the call's number resolves against the list she was shown. */
export function unsendOffer(chatId: string, now: number = Date.now()): ReachableBubble[] {
  offered.delete(chatId);
  const windowMs = unsendWindowMs(chatId);
  if (windowMs == null) return [];
  const reach = (previous.get(chatId) ?? []).filter(b => now - b.at < windowMs - UNSEND_MARGIN_MS);
  if (!reach.length) return [];
  if (now - lastUnsentAt(chatId) < UNSEND_COOLDOWN_MS) return [];
  offered.set(chatId, reach);
  return reach;
}

/** The irritated ground holds only when her mood this turn really is there. */
export function moodAllowsIrritatedUnsend(status: { mood_core: MoodCore; mood_level: number } | null | undefined): boolean {
  return status?.mood_core === 'mad' && status.mood_level <= UNSEND_MOOD_LEVEL_MAX;
}

export type UnsendOutcome =
  | { status: 'unsent'; text: string }
  | { status: 'failed'; text: string }
  | { status: 'invalid' };

/** Carry out a validated request through `unsend` (the channel call). Never throws. */
export async function executeUnsend(
  chatId: string,
  req: UnsendRequest,
  unsend: (chatId: string, messageId: string) => Promise<boolean>,
  now: number = Date.now(),
): Promise<UnsendOutcome> {
  const target = offered.get(chatId)?.[req.bubble - 1];
  offered.delete(chatId);
  if (!target) return { status: 'invalid' };
  const windowMs = unsendWindowMs(chatId);
  let ok = false;
  if (windowMs != null && now - target.at < windowMs) {
    try { ok = await unsend(chatId, target.id); } catch { ok = false; }
  }
  if (!ok) return { status: 'failed', text: target.text };
  recordUnsent(chatId, target.id, target.text, req.why, now);
  const prev = previous.get(chatId);
  if (prev) previous.set(chatId, prev.filter(b => b.id !== target.id));
  return { status: 'unsent', text: target.text };
}

/** Test seam: forget every chat's reach. */
export function resetUnsendStateForTests(): void {
  current.clear(); previous.clear(); offered.clear();
}
