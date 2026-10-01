// Thin transport layer between the debug web client and the server-side Irises
// "brain". All turn logic (routing, batching, typing delay, memory, providers)
// lives on the server now; this file only sends a message, opens the SSE reply
// stream, and cancels in-flight work.
//
// Requests target same-origin relative URLs because the server serves the built
// app. For split-origin dev, set NEXT_PUBLIC_IRISES_BRAIN_URL to the brain's
// origin (e.g. "http://localhost:8080").
//
// Auth: the server gates /api/web/* like /debug — localhost is open; when the
// operator sets DEBUG_TOKEN, requests need it. Open the page as /?token=XYZ and
// the token is forwarded on every call (EventSource can't set headers, so the
// query param is the one uniform mechanism).

export interface WebEvent {
  seq: number;
  ts: number;
  type: "bubble" | "typing" | "reaction" | "unsend" | "read" | "hello";
  id?: string; // bubble: stable id (React key + reaction target)
  text?: string; // bubble text
  replyTo?: { message_id: string };
  state?: "start" | "stop"; // typing
  messageId?: string; // reaction: the message id it decorates
  reaction?: unknown; // reaction payload {type, emoji?}
}

export interface SendResult {
  ok: boolean;
  chatId?: string;
  /** Server-side id of the inbound message — reaction events target this id. */
  messageId?: string;
}

const BASE_URL = process.env.NEXT_PUBLIC_IRISES_BRAIN_URL ?? "";

/** DEBUG_TOKEN passed by the operator as /?token=XYZ on the page URL (SSR-safe). */
function debugToken(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("token");
}

function withToken(path: string): string {
  const token = debugToken();
  if (!token) return `${BASE_URL}${path}`;
  return `${BASE_URL}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/** POST a user message to the brain. The reply arrives asynchronously over the SSE stream. */
export async function sendMessage(text: string, clientId?: string): Promise<SendResult> {
  const response = await fetch(withToken("/api/web/message"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(clientId ? { text, clientId } : { text })
  });
  if (!response.ok) {
    throw new Error(`Message rejected by the server (${response.status}).`);
  }
  try {
    return (await response.json()) as SendResult;
  } catch {
    return { ok: true };
  }
}

/**
 * Open the long-lived Server-Sent Events reply stream. The browser EventSource
 * auto-reconnects and replays via Last-Event-ID, so this stays open for the
 * whole session (async follow-ups arrive on the same stream). Call
 * `EventSource#close()` on unmount.
 */
export function openStream(
  onEvent: (event: WebEvent) => void,
  clientId?: string
): EventSource {
  const path = clientId
    ? `/api/web/stream?clientId=${encodeURIComponent(clientId)}`
    : "/api/web/stream";
  const source = new EventSource(withToken(path));
  source.onmessage = (event: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(event.data) as WebEvent);
    } catch {
      // Ignore malformed frames; heartbeats (comment lines) never reach here.
    }
  };
  return source;
}

/** Cancel in-flight research on the server (the Stop button). */
export async function cancel(clientId?: string): Promise<void> {
  await fetch(withToken("/api/web/cancel"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(clientId ? { clientId } : {})
  });
}
