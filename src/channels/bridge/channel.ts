// The bridge channel: Irises fronting the ENGINE's own channel connections (WhatsApp, Signal,
// Discord, Slack, LINE, … — every platform the engine has, current and future). The engine keeps
// owning the bot/number; its bridge plugin forwards fronted inbound turns to Irises and suppresses
// the engine's own reply, and this channel sends Irises's replies back out through the engine
// (EngineBackend.channelSend). chatId scheme: `eng:<platform>:<chat_id>`.
import { getEngineBackend } from '../../agents/ops/engineBackend.js';
import type { Channel, ChatInfo } from '../types.js';

/** Parse `eng:<platform>:<chat_id>` (the chat id itself may contain colons). */
export function parseBridgeChatId(chatId: string): { platform: string; target: string } | null {
  if (!chatId.startsWith('eng:')) return null;
  const rest = chatId.slice(4);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { platform: rest.slice(0, sep), target: rest.slice(sep + 1) };
}

// Per-chat metadata learned from inbound forwards (group flag, display name, the live thread) so
// getChat and sendMessage can answer without a network hop. In-memory: after a restart the next
// inbound repopulates it, and the default (1:1, no thread) is the safe assumption for anything unseen.
const chatMeta = new Map<string, { isGroup: boolean; name?: string; threadId?: string }>();
const CHAT_META_CAP = 2000;

export function noteBridgeChat(chatId: string, meta: { isGroup: boolean; name?: string; threadId?: string }): void {
  if (chatMeta.size >= CHAT_META_CAP && !chatMeta.has(chatId)) {
    const oldest = chatMeta.keys().next().value;
    if (oldest) chatMeta.delete(oldest);
  }
  // Last-inbound-wins, threadId INCLUDED: a whole-record overwrite is the point. Telegram forum
  // topics are per-message, so when the newest inbound carries no thread the conversation moved out
  // of the topic — keeping the old id would post the reply into a thread nobody is reading.
  chatMeta.set(chatId, meta);
}

// Bridge typing is OFF by default: the engine adapter may or may not expose a chat-action primitive
// for a given platform, and when it can't, a "live typing hold" is pure dead air (see index.ts
// sendBubbles). Defaulting off makes the safe outcome — no invisible holds — the default; an operator
// flips BRIDGE_TYPING=on only for platforms where the plugin's register-time log confirmed the adapter
// has a chat-action method. When on, caps.typing=true re-enables the per-bubble typing pacing.
const BRIDGE_TYPING = process.env.BRIDGE_TYPING === 'on';

export const bridgeChannel: Channel = {
  kind: 'bridge',
  caps: { threading: true, reactions: false, groupOps: false, contactCard: false, typing: BRIDGE_TYPING },

  async sendMessage(chatId, text, replyTo) {
    const parsed = parseBridgeChatId(chatId);
    if (!parsed) throw new Error(`[bridge] malformed bridge chatId "${chatId}"`);
    const engine = getEngineBackend();
    if (!engine) throw new Error('[bridge] no engine configured (OPS_BACKEND unset) — cannot deliver');
    // The engine's platforms do their own message splitting/formatting; send as one unit. threadId
    // rides from the last inbound: on a threaded platform (a Telegram forum topic) a reply sent
    // without it lands in the group's General instead of the topic the user is reading.
    const sent = await engine.channelSend(parsed.platform, parsed.target, text, {
      ...(chatMeta.get(chatId)?.threadId ? { threadId: chatMeta.get(chatId)!.threadId } : {}),
      ...(replyTo ? { replyToId: String(replyTo.message_id) } : {}),
    });
    return {
      chat_id: chatId,
      // The PLATFORM's id when the engine reported one: that is the id a later tapped reply arrives
      // with, so it's what makes recordSentBubble → resolveTappedReply match. The synthetic id is
      // only a fallback (an engine that can't tell us) — it never matches anything inbound.
      message: { id: sent.messageId || `eng-out-${Date.now().toString(36)}`, parts: [{ type: 'text', value: text }], sent_at: new Date().toISOString(), delivery_status: 'sent', is_read: false },
    };
  },

  // Typing is forwarded THROUGH the engine's own channel adapter (channelTyping), but only when
  // BRIDGE_TYPING is on AND the backend implements the optional seam. Best-effort and fire-and-forget:
  // channelTyping swallows its own errors and no-ops when the adapter lacks a chat-action method, so a
  // typing call can never delay or break a turn. When off/unsupported these degrade to the old no-op.
  async startTyping(chatId) {
    if (!BRIDGE_TYPING) return;
    const parsed = parseBridgeChatId(chatId);
    const engine = getEngineBackend();
    if (!parsed || !engine?.channelTyping) return;
    const threadId = chatMeta.get(chatId)?.threadId;
    void engine.channelTyping(parsed.platform, parsed.target, 'start', threadId ? { threadId } : {});
  },
  async stopTyping(chatId) {
    if (!BRIDGE_TYPING) return;
    const parsed = parseBridgeChatId(chatId);
    const engine = getEngineBackend();
    if (!parsed || !engine?.channelTyping) return;
    void engine.channelTyping(parsed.platform, parsed.target, 'stop');
  },
  // The engines don't expose read receipts for external senders uniformly — quiet no-op.
  async markAsRead() { /* no-op */ },

  async getChat(chatId): Promise<ChatInfo> {
    const meta = chatMeta.get(chatId);
    const isGroup = meta?.isGroup ?? false;
    return {
      id: chatId,
      display_name: meta?.name ?? null,
      handles: isGroup
        ? [{ handle: chatId, service: 'bridge' }, { handle: 'eng:irises', service: 'bridge' }, { handle: 'eng:other', service: 'bridge' }]
        : [{ handle: chatId, service: 'bridge' }, { handle: 'eng:irises', service: 'bridge' }],
      is_group: isGroup,
      service: 'bridge',
    };
  },

  async sendReaction() { /* caps.reactions=false — never called; explicit no-op for safety */ },

  // Through the engine's own adapter (delete_message). False when the engine can't, or the platform
  // refused: the bubble is still there, and the caller says so.
  async unsendMessage(chatId, messageId) {
    const parsed = parseBridgeChatId(chatId);
    const engine = getEngineBackend();
    if (!parsed || !engine?.channelUnsend) return false;
    return engine.channelUnsend(parsed.platform, parsed.target, messageId);
  },
};
