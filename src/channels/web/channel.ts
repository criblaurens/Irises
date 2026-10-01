// The web debug Channel — turns the brain's outbound calls (bubbles, typing, reactions, read) into
// Server-Sent Events pushed to any connected browser tab. Per chatId it keeps a set of live SSE
// responses plus a small replay ring buffer keyed by a monotonic `seq`, so:
//   - a follow-up that fires while the tab is closed still buffers (sendMessage never throws with no
//     client attached — it just buffers), and
//   - on reconnect the browser's EventSource sends Last-Event-ID and we replay everything after it.
// Voicing order == on-screen order because every bubble (live reply and async Ops follow-up) flows
// through the same per-chat mouth lock in the brain and lands here in order.
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Channel } from '../types.js';
import { webChatInfo } from './identity.js';

export interface WebEvent {
  seq: number;
  ts: number;
  type: 'bubble' | 'typing' | 'reaction' | 'unsend' | 'read' | 'hello';
  // bubble
  id?: string;
  text?: string;
  replyTo?: { message_id: string };
  // typing
  state?: 'start' | 'stop';
  // reaction
  messageId?: string;
  reaction?: unknown;
}

interface WebSession {
  clients: Set<Response>;
  buffer: WebEvent[];
  seq: number;
}

const RING = 200;        // replay buffer depth per chat
const MAX_SESSIONS = 64; // clientId is caller-supplied — bound the map so junk ids can't grow it forever
const sessions = new Map<string, WebSession>();

function session(chatId: string): WebSession {
  let s = sessions.get(chatId);
  if (!s) {
    // At the cap, evict the oldest session with no connected clients (never a live one).
    if (sessions.size >= MAX_SESSIONS) {
      for (const [key, existing] of sessions) {
        if (existing.clients.size === 0) { sessions.delete(key); break; }
      }
    }
    s = { clients: new Set(), buffer: [], seq: 0 };
    sessions.set(chatId, s);
  }
  return s;
}

function serialize(ev: WebEvent): string {
  // One SSE frame. JSON has no literal newlines, so a single `data:` line is safe.
  return `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** Buffer an event into the replay ring and broadcast it to every connected client for this chat. */
function push(chatId: string, ev: Omit<WebEvent, 'seq' | 'ts'>): WebEvent {
  const s = session(chatId);
  const full: WebEvent = { ...ev, seq: ++s.seq, ts: Date.now() };
  s.buffer.push(full);
  if (s.buffer.length > RING) s.buffer.shift();
  const frame = serialize(full);
  for (const res of s.clients) {
    try { res.write(frame); } catch { /* client went away mid-write; 'close' handler cleans up */ }
  }
  return full;
}

/**
 * Attach a new SSE client, replay anything it missed after `lastEventId`, and wire cleanup.
 * NOTE: the ring holds the last RING events — a client offline long enough for the buffer to
 * overflow past its last seq silently misses the intervening events (acceptable for a debug
 * channel; documented in docs/CHANNELS.md).
 */
export function attachWebClient(chatId: string, res: Response, lastEventId?: number): void {
  const s = session(chatId);
  s.clients.add(res);
  try {
    if (lastEventId != null && Number.isFinite(lastEventId)) {
      for (const ev of s.buffer) {
        if (ev.seq > lastEventId) res.write(serialize(ev));
      }
    } else {
      // Fresh connection: a hello lets the client confirm the stream is live.
      res.write(serialize({ type: 'hello', seq: s.seq, ts: Date.now() }));
    }
  } catch { /* client vanished mid-replay; the close handler below cleans up */ }
  res.on('close', () => { s.clients.delete(res); });
}

/** Number of currently-connected clients for a chat (diagnostics/tests). */
export function webClientCount(chatId: string): number {
  return sessions.get(chatId)?.clients.size ?? 0;
}

export const webChannel: Channel = {
  kind: 'web',
  // No group ops in a browser; threading + reactions render as UI affordances. Typing dots are real
  // here — startTyping/stopTyping push `type:'typing'` SSE events the browser renders.
  caps: { threading: true, reactions: true, groupOps: false, contactCard: false, typing: true },

  async sendMessage(chatId, text, replyTo) {
    const id = 'web-out-' + randomUUID();
    push(chatId, {
      type: 'bubble',
      id,
      text,
      replyTo: replyTo ? { message_id: replyTo.message_id } : undefined,
    });
    // Return a SendMessageResponse-shaped result so recordSentBubble()/lookupSentBubble() work across channels.
    return {
      chat_id: chatId,
      message: {
        id,
        parts: [{ type: 'text', value: text }],
        sent_at: new Date().toISOString(),
        delivery_status: 'sent',
        is_read: false,
      },
    };
  },

  async startTyping(chatId) { push(chatId, { type: 'typing', state: 'start' }); },
  async stopTyping(chatId) { push(chatId, { type: 'typing', state: 'stop' }); },
  async markAsRead(chatId) { push(chatId, { type: 'read' }); },
  async getChat(chatId) { return webChatInfo(chatId); },
  async sendReaction(chatId, messageId, reaction) {
    push(chatId, { type: 'reaction', messageId, reaction });
  },
  async unsendMessage(chatId, messageId) {
    push(chatId, { type: 'unsend', messageId });
    return true;
  },
};
