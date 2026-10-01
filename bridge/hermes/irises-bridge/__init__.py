"""irises-bridge — front hermes channels with Irises. Zero hermes source changes.

Install (both steps are hermes's own official mechanisms):
    cp -r bridge/hermes/irises-bridge ~/.hermes/plugins/
    hermes plugins enable irises-bridge   # = config.yaml  plugins: { enabled: [irises-bridge] }
Environment (set for the gateway process):
    IRISES_URL           where Irises runs           (default http://127.0.0.1:3000)
    IRISES_BRIDGE_TOKEN  shared secret = Irises's ENGINE_PUSH_TOKEN
    IRISES_FRONT         comma-separated fnmatch patterns over "<platform>:<chat_id>"
                         e.g. "telegram:*"  or  "whatsapp:+1555*,discord:123".
                         EMPTY = front nothing (default — hermes behaves normally).
    IRISES_BRIDGE_PORT   loopback listener for Irises's outbound sends (default 8655)
    IRISES_BRIDGE_FAIL   open (default: on bridge error hermes answers itself) | closed
    IRISES_BRIDGE_WORKERS  forward worker threads / queue shards (default 2). Each chat is
                         pinned to one shard, so a chat's messages stay in order.

How it works (verified against hermes source):
  * `pre_gateway_dispatch` fires for every non-internal inbound message on EVERY platform,
    before auth/sessions/agent (gateway/run.py). Returning {"action": "skip"} suppresses
    hermes's own reply entirely. The hook is called SYNCHRONOUSLY on the gateway event loop,
    so this handler only pattern-matches + enqueues — all I/O happens on worker threads.
  * Outbound: a loopback HTTP listener accepts {"platform","chat_id","text"} from Irises and
    delivers via gateway.adapters[Platform].send(...) — the same in-process call hermes's own
    webhook adapter uses, uniform across every current and future platform.

Testability rule for this file: every DECISION lives in a pure function (the `_`-prefixed
helpers below, covered by bridge/hermes/test_irises_bridge.py). The threads and the HTTP
handler are thin shells that call them.
"""
from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import json
import logging
import os
import queue
import re
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger("plugins.irises_bridge")

# Irises aborts its bridge POST at 20s (hermesBackend.ts channelSend). The handler's whole budget
# has to fit inside that or Irises reports a failure for a send that actually landed:
# the ≤3s gateway re-resolve poll + this wait = 17s < 20s.
_SEND_WAIT_S = 14
_GW_POLL_S = 3.0
_GW_POLL_STEP_S = 0.5
# The inbound payload version this plugin speaks. Irises's door (src/channels/bridge/contract.ts)
# accepts any sender declaring the same MAJOR and refuses one declaring a major it does not know,
# rather than half-understanding it. The field list is written down once, in
# bridge/contract-fixtures/inbound-v1.json, and checked from both sides.
_SCHEMA_VERSION = 1
# Per-POST budget for one inbound forward, times three attempts.
_FORWARD_TIMEOUT_S = 10
_FORWARD_ATTEMPTS = 3
_BACKOFF_S = (0.5, 2.0)
_HEALTH_WINDOW_S = 60.0
_HEALTH_PROBE_S = 15.0
# Forward statuses that are CONFIGURATION, not transport: the shared secret doesn't match, or the
# inbound route isn't mounted at all. No amount of retrying fixes either.
_CONFIG_ERROR_STATUSES = (401, 403, 404)


def _cfg(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _num_workers() -> int:
    try:
        n = int(_cfg("IRISES_BRIDGE_WORKERS", "2") or "2")
    except ValueError:
        n = 2
    return max(1, min(n, 16))


def _port() -> int:
    """The loopback listener's port. Guarded like _num_workers above: an unguarded int() here threw
    ValueError (not OSError, so no except caught it) BEFORE the bind, killing the watch thread
    silently while _STARTED was already set — outbound dead for the life of the process."""
    try:
        return int(_cfg("IRISES_BRIDGE_PORT", "8655") or "8655")
    except ValueError:
        log.warning("irises-bridge: IRISES_BRIDGE_PORT is not a number — using 8655")
        return 8655


# One queue per forward worker. A chat always hashes to the same shard (_shard_index), so its
# messages reach Irises in the order they were sent; separate chats no longer queue behind each
# other's retries.
_QUEUES: "list[queue.Queue[dict]]" = [queue.Queue(maxsize=500) for _ in range(_num_workers())]
# [gateway, loop] — captured by the watch thread at gateway start (and lazily on the first fronted
# message); the outbound listener needs both.
_GW: list = [None, None]
_STARTED = threading.Event()
# Separate from _STARTED on purpose: the forward workers starting is NOT the listener binding, and a
# failed bind must stay retryable instead of leaving inbound alive with outbound permanently dead.
_LISTENING = threading.Event()
_LISTEN_RETRY_S = 30.0
_WATCHING = threading.Event()
# One-time-per-platform typing capability log (see _SendHandler._log_typing_once). A set of
# "<platform>:<supported>" keys; races between forward threads only cost a duplicate log line.
_TYPING_LOGGED: set[str] = set()


def _patterns() -> list[str]:
    return [p.strip().lower() for p in _cfg("IRISES_FRONT").split(",") if p.strip()]


def _fronted(platform: str, chat_id: str) -> bool:
    key = f"{platform}:{chat_id}".lower()
    return any(fnmatch.fnmatch(key, pat) for pat in _patterns())


# ── pure decisions ────────────────────────────────────────────────────────────

def _auth_status(configured_token: str, header_value):
    """None = authorized. Otherwise the (status, body) to reply with.

    An unset token FAILS CLOSED (refuses every send) rather than accepting anything on loopback:
    the listener is still bound, so the misconfiguration surfaces as a readable 403 in Irises's
    logs instead of an ECONNREFUSED that looks like "the plugin isn't installed".
    """
    if not (configured_token or "").strip():
        return 403, {"error": "IRISES_BRIDGE_TOKEN unset — refusing all sends"}
    if header_value != configured_token:
        return 403, {"error": "forbidden"}
    return None


def _shard_index(chat_id, num_shards: int) -> int:
    """Which forward queue a chat belongs to. Stable across processes (hashlib, not hash())."""
    if num_shards <= 1:
        return 0
    digest = hashlib.blake2b(str(chat_id).encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") % num_shards


def _stable_message_id(platform_id, platform, chat_id, sender_id, text, timestamp):
    """The id Irises dedupes retried forwards on — (platform, chat_id, message_id) is its key.

    A platform id is handed straight back (untouched, so the wire bytes for the common case are
    exactly what they were). When the adapter gives us none, a per-attempt id would be no id at
    all: this worker retries a failed POST up to _FORWARD_ATTEMPTS times, and a lost 202 on the
    first attempt would then land as a SECOND turn in the chat. So the fallback is content-
    addressed — the same message digests to the same id no matter how many times it is sent.

    The trade that buys: two identical messages ("ok", "thanks") from the same sender in the same
    chat, carrying the SAME timestamp, collapse to one id and the second is dropped by Irises's
    dedup window. The timestamp is what keeps them apart — so an adapter that forwards NO timestamp
    gets a coarse one from us instead: the minute we received the message in. That is wide enough
    that a retry of the same message digests identically (the whole _backoff_s ladder is 0.5-2s),
    and narrow enough that a second "ok" typed minutes later is its own turn rather than a message
    Irises silently drops. Two identical messages inside the SAME minute still collapse; on a
    channel with no clock of its own that is the smallest gap left, and it is named, not hidden.
    """
    if platform_id is not None and str(platform_id).strip():
        return platform_id
    bucket = timestamp if timestamp is not None else int(time.time() // 60)
    raw = "|".join("" if p is None else str(p) for p in (platform, chat_id, sender_id, text, bucket))
    return "eng-h-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _backoff_s(attempt: int) -> float:
    """Sleep before retrying a failed forward: 0.5s after the first miss, 2s after the second."""
    idx = min(max(attempt, 1), len(_BACKOFF_S)) - 1
    return _BACKOFF_S[idx]


def _forward_status(exc):
    """The HTTP status a failed forward came back with, or None when it never got a response at all
    (connection refused, timeout, DNS). urlopen raises HTTPError — which carries .code — for non-2xx."""
    code = getattr(exc, "code", None)
    return code if isinstance(code, int) else None


def _is_config_error(status) -> bool:
    """True for the statuses that will never succeed on retry (see _CONFIG_ERROR_STATUSES)."""
    return status in _CONFIG_ERROR_STATUSES


def _config_error_hint(status) -> str:
    """Why a forward came back 401/403/404, in the operator's own vocabulary — these are the only two
    ways to get here, and neither is visible from hermes's side without being named."""
    if status == 404:
        return ("Irises has no /api/bridge/inbound route — it is running with OPS_BACKEND unset, so the "
                "bridge router was never mounted (or IRISES_URL points at something that isn't Irises)")
    return ("IRISES_BRIDGE_TOKEN here does not match Irises's ENGINE_PUSH_TOKEN "
            "(re-cloning or regenerating Irises's .env leaves this side holding the stale secret)")


def _forward_decision(healthy: bool, fail_closed: bool) -> str:
    """'forward' = enqueue for Irises and suppress hermes's own reply. 'let_hermes' = return None
    from the hook so hermes answers the chat itself.

    fail-open (default) is only a real fail-open if we hand the turn BACK when Irises is known
    unreachable — enqueueing into a void while telling hermes to stay silent is silence, not
    resilience. fail-closed keeps the old always-skip: the operator asked for silence over a
    hermes-voiced reply.
    """
    if fail_closed or healthy:
        return "forward"
    return "let_hermes"


# Method names a hermes channel adapter MIGHT expose for a typing / chat-action, in priority order.
# Both snake_case and camelCase are listed so a thin wrapper over a camelCase SDK (e.g. Photon's
# `im.chats.setTyping`) is caught either way. If none match exactly, a fuzzy pass catches any
# send/set-style method whose name mentions typing or chat-action, so we don't need the adapter's
# exact name up front — unknown adapters still fall through to a safe no-op.
_TYPING_METHOD_NAMES = ("send_chat_action", "send_typing", "set_typing", "setTyping", "sendTyping", "typing")
_TYPING_NAME_RE = re.compile(r"typing|chat.?action", re.IGNORECASE)
# Prefixes that mark a PREDICATE/GETTER, not an action to invoke — skip these in the fuzzy pass so we
# never call something like `is_typing()` expecting it to SEND a typing state.
_NON_ACTION_PREFIXES = ("is_", "get_", "has_", "on_", "handle_")


def _resolve_typing_call(adapter):
    """Return (name, callable) for a typing/chat-action the adapter exposes, or None when it has none.
    getattr-only feature detection — never assumes any method exists. Exact priority names first, then a
    fuzzy match on any action-style method whose name mentions typing/chat-action (so a Photon adapter's
    own naming is caught even if it isn't in the list above). None → the handler 200-no-ops."""
    for name in _TYPING_METHOD_NAMES:
        fn = getattr(adapter, name, None)
        if callable(fn):
            return name, fn
    for name in dir(adapter):
        if name.startswith("_") or name.startswith(_NON_ACTION_PREFIXES):
            continue
        if not _TYPING_NAME_RE.search(name):
            continue
        fn = getattr(adapter, name, None)
        if callable(fn):
            return name, fn
    return None


def _first_attr(obj, names):
    """First non-None attribute among `names` (feature-detection over differently-named event fields)."""
    for n in names:
        v = getattr(obj, n, None)
        if v is not None:
            return v
    return None


def _to_epoch(value):
    """Normalize a timestamp to epoch SECONDS so it survives json.dumps. Hermes adapters set
    event.timestamp to a datetime (Telegram message.date, Photon's parsed ISO) — json.dumps CANNOT
    serialize a datetime and would raise, failing the whole inbound forward. A datetime → .timestamp();
    a number passes through; anything else → None (the field is simply omitted)."""
    if value is None:
        return None
    ts = getattr(value, "timestamp", None)
    if callable(ts):                       # a datetime-like → epoch float seconds
        try:
            return value.timestamp()
        except Exception:  # noqa: BLE001
            return None
    if isinstance(value, (int, float)):
        return value
    return None


# hermes normalizes each platform's inbound into its own MessageEvent; different adapters (Photon
# included) may name the reply/quote/timestamp fields differently, so we try a spread and take the
# first that's set. All getattr-with-None, so an event lacking every candidate just omits the field.
_REPLY_ID_FIELDS = ("reply_to_message_id", "reply_to_id", "quoted_message_id", "in_reply_to", "replied_to_id")
_REPLY_TEXT_FIELDS = ("reply_to_text", "quoted_text", "quote_text", "quoted_message_text", "reply_text", "replied_text")
_TIMESTAMP_FIELDS = ("timestamp", "date", "created_at", "sent_at", "time", "ts")


def _classify_send_result(result):
    """(status, body) for one adapter.send outcome.

    adapter.send reports failure by RETURNING SendResult(success=False) — it does not raise — so a
    plugin that only catches exceptions answers 200 for messages the platform never delivered.
    """
    if result is None:
        return 502, {"error": "adapter returned no send result"}
    if getattr(result, "success", None) is False:
        detail = str(getattr(result, "error", None) or "adapter reported the send failed")[:300]
        return 502, {"error": detail, "retryable": bool(getattr(result, "retryable", False))}
    message_id = getattr(result, "message_id", None)
    return 200, {"ok": True, "message_id": None if message_id is None else str(message_id)}


def _healthy(last_ok_ts, now: float, window_s: float = _HEALTH_WINDOW_S) -> bool:
    """Was Irises confirmed reachable recently? None = nothing has been tried yet, which counts
    HEALTHY: a freshly started gateway must front its chats, not hand them all back."""
    if last_ok_ts is None:
        return True
    return (now - last_ok_ts) <= window_s


class _Health:
    """Reachability of Irises, written by the forward workers and the /health probe."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last_ok = None
        self._last_fail = None

    def note_ok(self, now: float = None) -> None:
        with self._lock:
            self._last_ok = time.monotonic() if now is None else now

    def note_fail(self, now: float = None) -> None:
        with self._lock:
            self._last_fail = time.monotonic() if now is None else now

    def is_healthy(self, now: float = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            last_ok, last_fail = self._last_ok, self._last_fail
        # A failure NEWER than the last success IS the verdict, however fresh that success is. The
        # /health probe is unauthenticated and independent of the bridge router, so it keeps answering
        # 200 straight through a token mismatch, an unmounted inbound route or a 500 storm — and while
        # a fresh last_ok could mask it, every note_fail() the forward workers wrote was inert and each
        # fronted message was silently lost with hermes already told to stay quiet. The window below
        # still covers genuine reachability (a probe that stops answering at all).
        if last_fail is not None and (last_ok is None or last_fail >= last_ok):
            return False
        return _healthy(last_ok, now)


_HEALTH = _Health()


# ── gateway acquisition ───────────────────────────────────────────────────────

def _resolve_runner():
    """The live GatewayRunner via the module-level weakref gateway.run sets in __init__.

    sys.modules, never `import gateway.run`: plugins load in CLI processes too, where importing
    the gateway module would spin up a second copy and bind the gateway's ports out from under
    the real process. Absent module = not a gateway process = nothing to capture.
    """
    mod = sys.modules.get("gateway.run")
    if mod is None:
        return None
    ref = getattr(mod, "_gateway_runner_ref", None)
    if not callable(ref):
        return None
    try:
        return ref()
    except Exception:  # noqa: BLE001 — a dead weakref must never break dispatch or a send
        return None


def _capture_gateway() -> bool:
    """True once _GW holds a gateway AND a running loop. The loop is set at run start, a beat
    after the runner exists, so a runner without one yet is "not ready", not a failure."""
    if _GW[0] is not None and _GW[1] is not None:
        return True
    runner = _resolve_runner()
    if runner is None:
        return False
    loop = getattr(runner, "_gateway_loop", None)
    if loop is None:
        return False
    _GW[0] = runner
    _GW[1] = loop
    return True


def _await_gateway(budget_s: float = _GW_POLL_S, step_s: float = _GW_POLL_STEP_S) -> bool:
    """Bounded wait for the gateway, for a send that arrives during gateway startup."""
    waited = 0.0
    while True:
        if _capture_gateway():
            return True
        if waited >= budget_s:
            return False
        time.sleep(step_s)
        waited += step_s


def _gateway_watch() -> None:
    """Bind the outbound listener as soon as the gateway is up, instead of waiting for the first
    fronted inbound message — otherwise a restart leaves Irises unable to send until someone
    happens to text in (and its first send fails). A port that is momentarily occupied (a stale
    process still shutting down) is retried rather than being fatal for the process's lifetime."""
    while not _capture_gateway():
        time.sleep(1.0)
    _start_workers()
    while not _LISTENING.is_set():
        time.sleep(_LISTEN_RETRY_S)
        _start_listener()


# ── forward workers (inbound → Irises) ───────────────────────────────────────

def _post_inbound(base: str, token: str, payload: dict) -> None:
    req = urllib.request.Request(
        f"{base}/api/bridge/inbound",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-bridge-token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_FORWARD_TIMEOUT_S) as res:
        res.read()


def _forward_loop(q: "queue.Queue[dict]") -> None:
    base = _cfg("IRISES_URL", "http://127.0.0.1:3000").rstrip("/")
    token = _cfg("IRISES_BRIDGE_TOKEN")
    while True:
        payload = q.get()
        for attempt in range(1, _FORWARD_ATTEMPTS + 1):
            try:
                _post_inbound(base, token, payload)
                _HEALTH.note_ok()
                break
            except Exception as exc:  # noqa: BLE001 — a forward failure must not kill the worker
                status = _forward_status(exc)
                if _is_config_error(status):
                    _HEALTH.note_fail()
                    # LOUD and NOT retried: retrying a misconfiguration only burns the backoff. The
                    # note_fail above is now authoritative, so the NEXT fronted turn goes to hermes
                    # instead of vanishing the same way.
                    log.error("irises-bridge: forward REJECTED with HTTP %s — %s. The message from "
                              "%s:%s is LOST and hermes stayed silent for it; handing the chat back to "
                              "hermes until this is fixed: %s",
                              status, _config_error_hint(status),
                              payload.get("platform"), payload.get("chat_id"), exc)
                    break
                if attempt < _FORWARD_ATTEMPTS:
                    log.warning("irises-bridge: forward attempt %d/%d failed (%s:%s): %s",
                                attempt, _FORWARD_ATTEMPTS,
                                payload.get("platform"), payload.get("chat_id"), exc)
                    time.sleep(_backoff_s(attempt))
                    continue
                _HEALTH.note_fail()
                # LOUD: hermes already stayed silent for this turn, so the user got nothing at all.
                log.error("irises-bridge: forward FAILED after %d attempts — message from %s:%s is "
                          "LOST and hermes stayed silent for it: %s",
                          _FORWARD_ATTEMPTS, payload.get("platform"), payload.get("chat_id"), exc)


def _probe_loop() -> None:
    """Keep the health verdict fresh even in a quiet chat, so the first message after Irises goes
    down is already handed to hermes instead of vanishing."""
    base = _cfg("IRISES_URL", "http://127.0.0.1:3000").rstrip("/")
    while True:
        try:
            with urllib.request.urlopen(f"{base}/health", timeout=5) as res:
                res.read()
                if 200 <= getattr(res, "status", 200) < 300:
                    _HEALTH.note_ok()
                else:
                    _HEALTH.note_fail()
        except Exception:  # noqa: BLE001 — unreachable/500 are both "not healthy"
            _HEALTH.note_fail()
        time.sleep(_HEALTH_PROBE_S)


# ── outbound listener (Irises → hermes channels) ─────────────────────────────

class _SendHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler contract
        denied = _auth_status(_cfg("IRISES_BRIDGE_TOKEN"), self.headers.get("x-bridge-token"))
        if denied is not None:
            self._reply(*denied)
            return
        if self.path == "/typing":
            self._handle_typing()
            return
        if self.path == "/unsend":
            self._handle_unsend()
            return
        if self.path != "/send":
            self._reply(404, {"error": "unknown path"})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        except Exception:  # noqa: BLE001
            self._reply(400, {"error": "invalid json"})
            return
        platform, chat_id, text = body.get("platform"), body.get("chat_id"), body.get("text")
        if not platform or not chat_id or not text:
            self._reply(400, {"error": "platform, chat_id, text required"})
            return
        if not _await_gateway():
            self._reply(503, {"error": "gateway not ready", "retryable": True})
            return
        gateway, loop = _GW
        try:
            from gateway.platforms.base import Platform  # re-exported from gateway.config; dynamic members cover plugin platforms
            try:
                resolved = Platform(platform)
            except ValueError:
                # An unknown NAME is a configuration problem, not a transport one. Constructing the
                # enum before this check turned it into a generic 502, which Irises reads as "the
                # bridge is broken" rather than "that platform name isn't a thing here".
                self._reply(400, {"error": f"platform '{platform}' is not a platform this hermes knows"})
                return
            adapter = gateway.adapters.get(resolved)
            if adapter is None:
                self._reply(400, {"error": f"platform '{platform}' is not connected on this hermes"})
                return
            metadata = {"thread_id": body["thread_id"]} if body.get("thread_id") else None
            reply_to = str(body["reply_to_id"]) if body.get("reply_to_id") else None
            fut = asyncio.run_coroutine_threadsafe(
                adapter.send(str(chat_id), str(text), reply_to=reply_to, metadata=metadata), loop)
            status, payload = _classify_send_result(fut.result(timeout=_SEND_WAIT_S))
            if status != 200:
                log.warning("irises-bridge: send to %s:%s reported failure: %s",
                            platform, chat_id, payload.get("error"))
            self._reply(status, payload)
        except Exception as exc:  # noqa: BLE001
            log.warning("irises-bridge: send to %s:%s failed: %s", platform, chat_id, exc)
            self._reply(502, {"error": str(exc)[:300]})

    def _handle_typing(self) -> None:
        """POST /typing {platform, chat_id, state}. Forwards a typing/chat-action through the adapter's
        OWN primitive when it has one; answers a harmless 200 supported:false otherwise. NEVER returns
        an error status for a missing capability — Irises's channelTyping swallows failures and this is
        cosmetic: it must never look like the send door is broken."""
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        except Exception:  # noqa: BLE001
            self._reply(400, {"error": "invalid json"})
            return
        platform, chat_id = body.get("platform"), body.get("chat_id")
        state = body.get("state", "start")
        if not platform or not chat_id:
            self._reply(400, {"error": "platform, chat_id required"})
            return
        if not _await_gateway():
            self._reply(503, {"error": "gateway not ready", "retryable": True})
            return
        gateway, loop = _GW
        try:
            from gateway.platforms.base import Platform
            try:
                resolved = Platform(platform)
            except ValueError:
                self._reply(400, {"error": f"platform '{platform}' is not a platform this hermes knows"})
                return
            adapter = gateway.adapters.get(resolved)
            if adapter is None:
                self._reply(400, {"error": f"platform '{platform}' is not connected on this hermes"})
                return
            call = _resolve_typing_call(adapter)
            if call is None:
                self._log_typing_unsupported(platform, adapter)
                self._reply(200, {"ok": True, "supported": False})  # adapter has no chat-action → no-op
                return
            name, fn = call
            metadata = {"thread_id": body["thread_id"]} if body.get("thread_id") else None
            try:
                if str(state) == "stop":
                    # STOP: the platform adapters expose a dedicated stop_typing(chat_id). This is not
                    # a nicety — Photon's indicator is STATEFUL: setTyping(guid, True) stays lit until
                    # setTyping(guid, False), so a reply that never stops leaves the dots burning
                    # forever. That is why Irises now sends an explicit stop after EVERY reply (plus a
                    # guarded trailing stop, since a start still crossing this 3s round trip can land
                    # after it — see src/state/typingStop.ts). An adapter WITHOUT stop_typing is left
                    # to its own platform's expiry: there is nothing to call, and inventing a fake
                    # start-with-no-refresh would be worse than waiting it out.
                    stop_fn = getattr(adapter, "stop_typing", None)
                    if callable(stop_fn):
                        asyncio.run_coroutine_threadsafe(stop_fn(str(chat_id)), loop).result(timeout=3)
                else:
                    # START: the base adapter interface is send_typing(chat_id, metadata=None) (Photon and
                    # Telegram both). A Telegram-style send_chat_action instead wants an action STRING.
                    is_chat_action = "chat" in name.lower() and "action" in name.lower()
                    coro = fn(str(chat_id), "typing") if is_chat_action else fn(str(chat_id), metadata)
                    asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=3)
                self._log_typing_once(platform, supported=True, method=name)
                self._reply(200, {"ok": True, "supported": True})
            except Exception as exc:  # noqa: BLE001 — typing is cosmetic; never a hard error
                self._reply(200, {"ok": True, "supported": False, "detail": str(exc)[:200]})
        except Exception as exc:  # noqa: BLE001
            self._reply(200, {"ok": True, "supported": False, "detail": str(exc)[:200]})

    def _handle_unsend(self) -> None:
        """POST /unsend {platform, chat_id, message_id}. Takes back one of Irises's own messages through
        the adapter's delete_message (Telegram has one; the base adapter answers False). A platform that
        can't is a 200 unsent:false, never an error: Irises keeps the bubble and says it's still there."""
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        except Exception:  # noqa: BLE001
            self._reply(400, {"error": "invalid json"})
            return
        platform, chat_id, message_id = body.get("platform"), body.get("chat_id"), body.get("message_id")
        if not platform or not chat_id or not message_id:
            self._reply(400, {"error": "platform, chat_id, message_id required"})
            return
        if not _await_gateway():
            self._reply(503, {"error": "gateway not ready", "retryable": True})
            return
        gateway, loop = _GW
        try:
            from gateway.platforms.base import Platform
            try:
                resolved = Platform(platform)
            except ValueError:
                self._reply(400, {"error": f"platform '{platform}' is not a platform this hermes knows"})
                return
            adapter = gateway.adapters.get(resolved)
            if adapter is None:
                self._reply(400, {"error": f"platform '{platform}' is not connected on this hermes"})
                return
            delete = getattr(adapter, "delete_message", None)
            if not callable(delete):
                self._reply(200, {"ok": True, "unsent": False})
                return
            done = asyncio.run_coroutine_threadsafe(delete(str(chat_id), str(message_id)), loop).result(timeout=8)
            self._reply(200, {"ok": True, "unsent": done is True})
        except Exception as exc:  # noqa: BLE001
            log.warning("irises-bridge: unsend on %s:%s failed: %s", platform, chat_id, exc)
            self._reply(200, {"ok": True, "unsent": False, "detail": str(exc)[:200]})

    @staticmethod
    def _log_typing_once(platform: str, supported: bool, method: str = "") -> None:
        """One log line per platform so the operator can see at runtime whether bridge typing actually
        works there (this is the 'did the adapter have a chat-action?' verification the design calls for)."""
        key = f"{platform}:{supported}"
        if key in _TYPING_LOGGED:
            return
        _TYPING_LOGGED.add(key)
        log.info("irises-bridge: typing forwarded to %s via adapter.%s — BRIDGE_TYPING will show dots", platform, method)

    @staticmethod
    def _log_typing_unsupported(platform: str, adapter) -> None:
        """One-time-per-platform diagnostic when NO typing method matched: names the adapter's public
        methods so the operator (or a bridge tweak) can see the real chat-action name and pin it if the
        auto-detection missed it. Safe/no-op regardless — typing just shows no dots on this platform."""
        key = f"{platform}:False"
        if key in _TYPING_LOGGED:
            return
        _TYPING_LOGGED.add(key)
        try:
            methods = sorted(m for m in dir(adapter) if not m.startswith("_") and callable(getattr(adapter, m, None)))
        except Exception:  # noqa: BLE001 — never let a diagnostic break the handler
            methods = []
        log.info("irises-bridge: %s adapter exposes no recognized typing/chat-action — typing is a no-op "
                 "there (safe; Irises just shows no dots). Adapter methods seen: %s", platform, ", ".join(methods) or "(none)")

    def _reply(self, code: int, obj: dict) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args) -> None:  # silence per-request stderr noise
        pass


def _start_listener() -> bool:
    """Bind the outbound listener. True once it is up (or already was).

    Kept apart from _start_workers because the two failure modes are not the same. Inbound forwarding
    surviving a failed bind means hermes keeps being told to skip fronted chats while Irises's replies
    hit ECONNREFUSED — every fronted chat silent, indefinitely, explained by one startup log line. So
    a bind failure is a WARNING and stays retryable (see _gateway_watch)."""
    if _LISTENING.is_set():
        return True
    port = _port()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), _SendHandler)
    except OSError as exc:
        log.warning("irises-bridge: could not bind outbound listener on %d (%s) — will retry; "
                    "set IRISES_BRIDGE_PORT (and Irises's HERMES_BRIDGE_URL) to move it", port, exc)
        return False
    _LISTENING.set()
    threading.Thread(target=server.serve_forever, name="irises-bridge-send", daemon=True).start()
    log.info("irises-bridge: outbound listener on 127.0.0.1:%d (%d forward worker(s))", port, len(_QUEUES))
    return True


def _start_workers() -> None:
    if not _STARTED.is_set():
        _STARTED.set()
        for i, q in enumerate(_QUEUES):
            threading.Thread(target=_forward_loop, args=(q,), name=f"irises-bridge-forward-{i}", daemon=True).start()
        threading.Thread(target=_probe_loop, name="irises-bridge-probe", daemon=True).start()
    _start_listener()


# ── the hook ──────────────────────────────────────────────────────────────────

def on_inbound(event=None, gateway=None, session_store=None, **_kwargs):
    """pre_gateway_dispatch. MUST return fast — runs synchronously on the gateway loop."""
    fail_closed = _cfg("IRISES_BRIDGE_FAIL", "open").lower() == "closed"
    try:
        if event is None or getattr(event, "internal", False):
            return None
        src = event.source
        platform = getattr(getattr(src, "platform", None), "value", None) or str(getattr(src, "platform", ""))
        chat_id = str(getattr(src, "chat_id", "") or "")
        if not platform or not chat_id or not _fronted(platform, chat_id):
            return None  # not fronted → hermes handles it exactly as before

        # Capture the live gateway + loop for the outbound listener (the watch thread normally got
        # here first — this is the belt-and-braces path). GUARDED: the kwarg defaults to None, and an
        # unconditional write nulled out a working capture on the first fronted message, after which
        # every send answered 503 "gateway not ready".
        if gateway is not None:
            _GW[0] = gateway
        try:
            _GW[1] = asyncio.get_running_loop()
        except RuntimeError:
            pass
        _start_workers()

        if _forward_decision(_HEALTH.is_healthy(), fail_closed) == "let_hermes":
            log.warning("irises-bridge: Irises unreachable — letting hermes answer %s:%s itself (fail=open)",
                        platform, chat_id)
            return None

        sender_id = getattr(src, "user_id", None) or getattr(event, "user_id", None)
        text = getattr(event, "text", "") or ""
        # MUST be epoch, not a datetime — a datetime here breaks json.dumps and drops the message.
        timestamp = _to_epoch(_first_attr(event, _TIMESTAMP_FIELDS))
        payload = {
            "engine": "hermes",
            "platform": platform,
            "chat_id": chat_id,
            "sender_id": sender_id,
            "sender_name": getattr(event, "user_name", None),
            "chat_name": getattr(src, "chat_name", None),
            "text": text,
            # The platform's own id when it has one, else a content digest — see _stable_message_id.
            "message_id": _stable_message_id(
                getattr(event, "message_id", None), platform, chat_id, sender_id, text, timestamp),
            "schema_version": _SCHEMA_VERSION,
            "thread_id": getattr(src, "thread_id", None),
            # Reply id / quoted TEXT / platform send time — tried across the field names different
            # adapters use (Photon included). Irises uses the quote to show what was replied to even when
            # it can't resolve the id, and the timestamp as the message's real receivedAt.
            "reply_to_id": _first_attr(event, _REPLY_ID_FIELDS),
            "reply_to_text": _first_attr(event, _REPLY_TEXT_FIELDS),
            "timestamp": timestamp,
            # hermes normalizes chat_type to dm/group/channel/thread ("supergroup" kept defensively
            # for adapters that pass raw platform values through).
            "is_group": (getattr(src, "chat_type", "") or "").lower() in ("group", "supergroup", "channel", "thread"),
            "media": [
                {"path": url, "mimeType": (list(getattr(event, "media_types", []) or [])[i] if i < len(list(getattr(event, "media_types", []) or [])) else "application/octet-stream")}
                for i, url in enumerate(list(getattr(event, "media_urls", []) or []))
            ],
        }
        try:
            _QUEUES[_shard_index(chat_id, len(_QUEUES))].put_nowait(payload)
        except queue.Full:
            log.warning("irises-bridge: forward queue full — %s", "holding silence (fail=closed)" if fail_closed else "letting hermes answer (fail=open)")
            return {"action": "skip", "reason": "irises-bridge-overflow"} if fail_closed else None
        return {"action": "skip", "reason": "irises-bridge"}
    except Exception as exc:  # noqa: BLE001 — never let a bridge bug break hermes dispatch
        log.warning("irises-bridge: hook error: %s", exc)
        return {"action": "skip", "reason": "irises-bridge-error"} if fail_closed else None


def register(ctx) -> None:
    ctx.register_hook("pre_gateway_dispatch", on_inbound)
    if not _WATCHING.is_set():
        _WATCHING.set()
        threading.Thread(target=_gateway_watch, name="irises-bridge-gateway-watch", daemon=True).start()
    log.info("irises-bridge registered (front: %s)", ", ".join(_patterns()) or "<nothing — set IRISES_FRONT>")
