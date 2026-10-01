// Channel abstraction — the seam that lets Irises's one brain speak over multiple transports.
//
// Irises is a user-facing front-end for the OpenClaw/Hermes engines. The outbound path in
// src/index.ts (live replies, the mouth's async Ops follow-ups, engine push deliveries) is keyed by
// chatId; this interface lets the same pipeline voice to the web/CLI debug channel (SSE) and to the
// bridge (engine-fronted chats). The concrete transport is resolved per-chat from the chatId prefix
// — see registry.ts (`web:*` → web, `eng:*` → bridge). The brain never imports a channel directly;
// it only ever calls resolveChannel(chatId).
import type { ReplyTo } from '../webhook/types.js';

// ── Channel data shapes ──────────────────────────────────────────────────────
// The chat / message / reaction types the Channel interface is built on. Transport-neutral: web and
// bridge produce and consume these regardless of the underlying engine platform.
export interface ChatHandle {
  handle: string;
  service: string;
}

export interface ChatInfo {
  id: string;
  display_name: string | null;
  handles: ChatHandle[];
  is_group: boolean;
  service: string;
}

export interface MediaAttachment {
  url: string;
}

// Mirrors the outbound send result so the send path can keep reading `sent?.message?.id` for
// recordSentBubble() across every channel.
export interface SendMessageResponse {
  chat_id: string;
  message: {
    id: string;
    parts: Array<{ type: string; value?: string }>;
    sent_at: string;
    delivery_status: 'pending' | 'queued' | 'sent' | 'delivered' | 'failed';
    is_read: boolean;
  };
}

export interface FetchedMessage {
  id: string;
  chatId: string;
  isFromMe: boolean;       // true when Irises sent it
  senderHandle?: string;   // the sender's handle (for own-thread group attribution)
  text: string;            // text parts joined; a placeholder when the message is media-only
  replyTo?: ReplyTo;
  sentAtMs: number;        // created_at as epoch ms (0 when unparseable)
}

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';

export type Reaction =
  | { type: StandardReactionType }
  | { type: 'custom'; emoji: string };

export type ChannelKind = 'web' | 'bridge';

// What a given transport can do. Optional Channel methods are called only when the matching cap is
// true, so a channel that can't (say) do group ops simply advertises false and the send path skips
// that decoration instead of throwing.
export interface ChannelCaps {
  threading: boolean;    // native reply-to quoting
  reactions: boolean;    // tapback / message reactions
  groupOps: boolean;     // rename / icon / remove participant
  contactCard: boolean;  // shareContactCard
  typing: boolean;       // a live typing indicator is actually shown to the user on this transport
}

export interface Channel {
  readonly kind: ChannelKind;
  readonly caps: ChannelCaps;

  // Core outbound — keyed by chatId. Returns a shape matching SendMessageResponse so the send path
  // can keep reading `sent?.message?.id` for recordSentBubble() across every channel.
  sendMessage(
    chatId: string,
    text: string,
    replyTo?: ReplyTo,
    media?: MediaAttachment[],
  ): Promise<Partial<SendMessageResponse>>;

  startTyping(chatId: string): Promise<void>;
  stopTyping(chatId: string): Promise<void>;
  markAsRead(chatId: string): Promise<void>;
  getChat(chatId: string): Promise<ChatInfo>;

  // chatId is part of the signature so resolveChannel(chatId) works and each channel can target the
  // right conversation.
  sendReaction(
    chatId: string,
    messageId: string,
    reaction: Reaction,
    operation?: 'add' | 'remove',
  ): Promise<void>;

  // Optional live single-message fetch by transport message id — the fallback for thread-aware
  // tapped-reply resolution (state/replyResolution.ts) once the local sent/inbound index has aged
  // out. Only meaningful on a channel with `caps.threading` (a transport with no native reply-to
  // never produces a tapped reply to resolve) whose API can serve a message by id. Absent →
  // resolution degrades to an honest 'unresolved'. Must never throw — return null for "couldn't pull it up".
  getMessage?(chatId: string, messageId: string): Promise<FetchedMessage | null>;

  // Optional: take back one of Irises's own sent messages (state/unsend.ts). True only when the
  // transport confirmed it is gone. Must never throw.
  unsendMessage?(chatId: string, messageId: string): Promise<boolean>;

  // Optional — invoked only when the matching cap is true.
  shareContactCard?(chatId: string): Promise<void>;
  renameGroupChat?(chatId: string, displayName: string): Promise<void>;
  setGroupChatIcon?(chatId: string, iconUrl: string): Promise<void>;
  removeParticipant?(chatId: string, handle: string): Promise<void>;
}
