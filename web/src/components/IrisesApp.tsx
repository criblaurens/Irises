"use client";

import Image from "next/image";
import { ArrowUp, RotateCcw, Square, Trash2 } from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { cancel, openStream, sendMessage, type WebEvent } from "@/lib/server-client";
import type { ChatMessage, ReactionMark } from "@/lib/types";
import styles from "./IrisesApp.module.css";

type StreamStatus = "connecting" | "connected" | "reconnecting";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `local-${Math.random().toString(36).slice(2)}`;
}

// Standard tapback types → the glyph users expect; custom reactions carry their own emoji.
const TAPBACK_EMOJI: Record<string, string> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓"
};

function reactionGlyph(reaction: { type?: string; emoji?: string }): string {
  return reaction.emoji ?? TAPBACK_EMOJI[reaction.type ?? ""] ?? "•";
}

export function IrisesApp() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const endRef = useRef<HTMLDivElement | null>(null);
  // Reaction events already applied — bubbles de-dupe by id, but reactions have no id of their
  // own, so a Last-Event-ID replay would double-apply them without this guard.
  const appliedReactions = useRef<Set<string>>(new Set());

  // Translate a server WebEvent into local view-model updates. All updates use
  // functional setState so the callback never captures stale state.
  const handleEvent = useCallback((event: WebEvent) => {
    switch (event.type) {
      case "hello":
        setStreamStatus("connected");
        return;
      case "typing":
        setTyping(event.state !== "stop");
        return;
      case "bubble": {
        setTyping(false);
        setMessages((current) => {
          if (event.id && current.some((message) => message.id === event.id)) {
            return current; // de-dupe replayed events (Last-Event-ID reconnect)
          }
          return [
            ...current,
            {
              id: event.id ?? newId(),
              role: "assistant",
              content: event.text ?? ""
            }
          ];
        });
        return;
      }
      case "reaction": {
        if (!event.messageId) return;
        const key = `${event.seq}:${event.messageId}`;
        if (appliedReactions.current.has(key)) return; // replayed event
        appliedReactions.current.add(key);
        const mark = (event.reaction ?? {}) as ReactionMark;
        setMessages((current) =>
          current.map((message) =>
            message.id === event.messageId
              ? { ...message, reactions: [...(message.reactions ?? []), mark] }
              : message
          )
        );
        return;
      }
      case "unsend": {
        if (!event.messageId) return;
        setMessages((current) =>
          current.map((message) =>
            message.id === event.messageId ? { ...message, content: "Irises unsent a message" } : message
          )
        );
        return;
      }
      case "read":
      default:
        // No client-visible effect for read receipts / unknown types.
        return;
    }
  }, []);

  // Open the reply stream once for the whole session. EventSource auto-reconnects,
  // so async follow-ups (deep research answers) arrive on this same stream.
  useEffect(() => {
    const source = openStream(handleEvent);
    source.onopen = () => setStreamStatus("connected");
    source.onerror = () => setStreamStatus("reconnecting");
    return () => source.close();
  }, [handleEvent]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages.length, typing]);

  async function submitMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = input.trim();
    if (!content || typing) return;

    setInput("");
    setError(null);
    const localId = newId();
    setMessages((current) => [
      ...current,
      { id: localId, role: "user", content }
    ]);
    setTyping(true); // optimistic: Irises is about to reply
    try {
      const result = await sendMessage(content);
      // Adopt the server's inbound message id — reaction events target it, so the
      // optimistic bubble must carry it for Irises's tapbacks to land on this message.
      if (result?.messageId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === localId ? { ...message, id: result.messageId! } : message
          )
        );
      }
    } catch (sendError) {
      setTyping(false);
      setError(
        sendError instanceof Error
          ? sendError.message
          : "The message could not be sent."
      );
    }
  }

  async function stopReply() {
    setTyping(false);
    try {
      await cancel();
    } catch {
      // Best effort; the server may already have finished.
    }
  }

  async function retryLastMessage() {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser || typing) return;
    setError(null);
    setTyping(true);
    try {
      await sendMessage(lastUser.content);
    } catch (sendError) {
      setTyping(false);
      setError(
        sendError instanceof Error
          ? sendError.message
          : "The message could not be sent."
      );
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  }

  function clearThread() {
    if (
      messages.length > 0
      && !window.confirm("Clear this thread from the view?")
    ) {
      return;
    }
    setMessages([]);
    setTyping(false);
    setInput("");
    setError(null);
  }

  const statusLabel =
    streamStatus === "connected"
      ? "connected to the Irises brain"
      : streamStatus === "reconnecting"
        ? "reconnecting…"
        : "connecting…";

  return (
    <main className={styles.app}>
      <section className={styles.chat}>
        <header className={styles.topbar}>
          <div className={styles.headerIdentity}>
            <div className={styles.brand}>
              Irises<span>.</span>
            </div>
            <div className={styles.identity}>
              <Image
                src="/irises-avatar.png"
                alt=""
                width={42}
                height={42}
                priority
              />
              <div>
                <strong>Irises</strong>
                <span>{statusLabel}</span>
              </div>
            </div>
          </div>
          <div className={styles.topActions}>
            <button
              className={styles.iconButton}
              onClick={clearThread}
              aria-label="Clear thread"
            >
              <Trash2 size={18} />
            </button>
          </div>
        </header>

        <div className={styles.messages} aria-live="polite">
          {messages.map((message, index, all) => (
            <MessageBubble
              key={message.id}
              message={message}
              showAvatar={
                message.role === "assistant"
                && (index === 0 || all[index - 1]?.role !== "assistant")
              }
            />
          ))}

          {typing && (
            <div className={styles.assistantRow}>
              <Image
                className={styles.messageAvatar}
                src="/irises-avatar.png"
                alt=""
                width={32}
                height={32}
              />
              <div className={styles.typing} aria-label="Irises is typing">
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className={styles.composerArea}>
          {error && (
            <div className={styles.errorBanner} role="alert">
              <span>{error}</span>
              {messages.some((message) => message.role === "user") && (
                <button onClick={() => void retryLastMessage()}>
                  <RotateCcw size={14} />
                  Retry
                </button>
              )}
            </div>
          )}
          <form className={styles.composer} onSubmit={submitMessage}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Message"
              rows={1}
              maxLength={16_000}
              aria-label="Message Irises"
            />
            {typing ? (
              <button
                type="button"
                className={styles.sendButton}
                onClick={() => void stopReply()}
                aria-label="Stop response"
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className={styles.sendButton}
                disabled={!input.trim()}
                aria-label="Send message"
              >
                <ArrowUp size={19} />
              </button>
            )}
          </form>
          <p className={styles.composerNote}>
            Irises replies stream in from the server. Shift+Enter adds a new line.
          </p>
        </div>
      </section>
    </main>
  );
}

function MessageBubble({
  message,
  showAvatar
}: {
  message: ChatMessage;
  showAvatar: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className={styles.userRow}>
        <div className={styles.assistantBubbleGroup}>
          <div className={styles.userBubble}>{message.content}</div>
          {message.reactions && message.reactions.length > 0 && (
            <div className={styles.reactions} aria-label="Reactions">
              {message.reactions.map((reaction, index) => (
                <span key={index}>{reactionGlyph(reaction)}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.assistantRow}>
      {showAvatar ? (
        <Image
          className={styles.messageAvatar}
          src="/irises-avatar.png"
          alt=""
          width={32}
          height={32}
        />
      ) : (
        <span className={styles.avatarSpacer} />
      )}
      <div className={styles.assistantBubbleGroup}>
        <div className={styles.assistantBubble}>{message.content}</div>
        {message.reactions && message.reactions.length > 0 && (
          <div className={styles.reactions} aria-label="Reactions">
            {message.reactions.map((reaction, index) => (
              <span key={index}>{reactionGlyph(reaction)}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
