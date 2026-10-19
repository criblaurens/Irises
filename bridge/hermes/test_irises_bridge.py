"""Unit tests for the hermes irises-bridge plugin — pure stdlib, no hermes needed.

Run from the repo root:
    python -m unittest discover bridge/hermes

Covers every piece with real logic: the IRISES_FRONT pattern matcher, the pure
decision helpers (auth, sharding, backoff, forward/let-hermes, send-result
classification, health window, config-error statuses), the forward worker's
handling of a rejected POST, and the on_inbound hook (fronting decision, payload
shaping, fail-open/closed). The gateway-facing halves (hook registration, adapter
send, the loopback listener) are exercised by the live smoke test in
docs/ENGINES.md — they are thin shells over the helpers tested here.
"""
from __future__ import annotations

import importlib.util
import pathlib
import queue
import types
import unittest
import urllib.error
from unittest import mock

_PLUGIN = pathlib.Path(__file__).resolve().parent / "irises-bridge" / "__init__.py"
_spec = importlib.util.spec_from_file_location("irises_bridge_under_test", _PLUGIN)
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)


def _event(platform="telegram", chat_id="123", **over):
    """A stand-in for hermes's MessageEvent with just the attributes the hook reads."""
    source = types.SimpleNamespace(
        platform=types.SimpleNamespace(value=platform),
        chat_id=chat_id,
        thread_id=over.pop("thread_id", None),
        chat_type=over.pop("chat_type", "dm"),
        chat_name=over.pop("chat_name", None),
        user_id=over.pop("user_id", "u1"),
    )
    defaults = dict(
        internal=False,
        source=source,
        text="hello",
        message_id="m1",
        user_name="Riv",
        reply_to_message_id=None,
        media_urls=[],
        media_types=[],
    )
    defaults.update(over)
    return types.SimpleNamespace(**defaults)


class PatternMatcher(unittest.TestCase):
    def test_empty_front_fronts_nothing(self):
        with mock.patch.dict("os.environ", {"IRISES_FRONT": ""}):
            self.assertFalse(bridge._fronted("telegram", "123"))

    def test_wildcards_and_multi_pattern(self):
        with mock.patch.dict("os.environ", {"IRISES_FRONT": "telegram:*, whatsapp:+1555*"}):
            self.assertTrue(bridge._fronted("telegram", "anything"))
            self.assertTrue(bridge._fronted("whatsapp", "+15551234"))
            self.assertFalse(bridge._fronted("whatsapp", "+16660000"))
            self.assertFalse(bridge._fronted("discord", "123"))

    def test_matching_is_case_insensitive(self):
        with mock.patch.dict("os.environ", {"IRISES_FRONT": "Telegram:ABC*"}):
            self.assertTrue(bridge._fronted("telegram", "abc99"))


class OnInbound(unittest.TestCase):
    def setUp(self):
        # Fresh queue per test; never start the worker threads / loopback listener.
        self.q: "queue.Queue[dict]" = queue.Queue(maxsize=10)
        patches = [
            mock.patch.object(bridge, "_QUEUES", [self.q]),
            mock.patch.object(bridge, "_start_workers", lambda: None),
            mock.patch.dict("os.environ", {"IRISES_FRONT": "telegram:*"}, clear=False),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_unfronted_platform_falls_through(self):
        self.assertIsNone(bridge.on_inbound(event=_event(platform="whatsapp"), gateway=None))
        self.assertTrue(self.q.empty())

    def test_internal_events_fall_through(self):
        self.assertIsNone(bridge.on_inbound(event=_event(internal=True), gateway=None))

    def test_fronted_message_skips_hermes_and_enqueues_payload(self):
        ev = _event(chat_id="42", text="what's the weather", chat_type="group", chat_name="eng crew",
                    media_urls=["/var/cache/a.jpg", "/var/cache/b.bin"], media_types=["image/jpeg"])
        result = bridge.on_inbound(event=ev, gateway="GW")
        self.assertEqual(result, {"action": "skip", "reason": "irises-bridge"})
        payload = self.q.get_nowait()
        self.assertEqual(payload["engine"], "hermes")
        self.assertEqual(payload["platform"], "telegram")
        self.assertEqual(payload["chat_id"], "42")
        self.assertEqual(payload["sender_id"], "u1")
        self.assertEqual(payload["sender_name"], "Riv")
        self.assertEqual(payload["chat_name"], "eng crew")
        self.assertEqual(payload["text"], "what's the weather")
        self.assertEqual(payload["message_id"], "m1")
        self.assertTrue(payload["is_group"])
        self.assertEqual(payload["media"], [
            {"path": "/var/cache/a.jpg", "mimeType": "image/jpeg"},
            {"path": "/var/cache/b.bin", "mimeType": "application/octet-stream"},
        ])

    def test_group_chat_types(self):
        # hermes normalizes chat_type to dm/group/channel/thread (base SessionSource).
        for chat_type, expect in (("dm", False), ("group", True), ("channel", True), ("thread", True)):
            bridge.on_inbound(event=_event(chat_type=chat_type), gateway=None)
            self.assertEqual(self.q.get_nowait()["is_group"], expect, chat_type)

    def test_reply_and_timestamp_forward_when_present(self):
        ev = _event(reply_to_message_id="root9", reply_to_text="the report you asked for", timestamp=1700000000)
        bridge.on_inbound(event=ev, gateway="GW")
        payload = self.q.get_nowait()
        self.assertEqual(payload["reply_to_id"], "root9")
        self.assertEqual(payload["reply_to_text"], "the report you asked for")
        self.assertEqual(payload["timestamp"], 1700000000)

    def test_reply_and_timestamp_absent_default_to_none(self):
        bridge.on_inbound(event=_event(), gateway="GW")
        payload = self.q.get_nowait()
        self.assertIsNone(payload["reply_to_text"])
        self.assertIsNone(payload["timestamp"])

    def test_a_datetime_timestamp_is_forwarded_as_epoch_and_stays_json_safe(self):
        # Hermes adapters set event.timestamp to a datetime; forwarding it raw would break json.dumps
        # (and drop every message). It must be converted to epoch seconds.
        import datetime as _dt
        import json as _json
        when = _dt.datetime(2026, 8, 30, 12, 0, tzinfo=_dt.timezone.utc)
        bridge.on_inbound(event=_event(timestamp=when), gateway="GW")
        payload = self.q.get_nowait()
        self.assertEqual(payload["timestamp"], when.timestamp())
        _json.dumps(payload)  # must NOT raise — a raw datetime here would

    def test_alternate_reply_and_timestamp_field_names_are_picked_up(self):
        # A Photon-style adapter may name the fields differently; _first_attr tries a spread.
        ev = _event(quoted_text="the earlier msg", created_at=1699999999, quoted_message_id="q7")
        bridge.on_inbound(event=ev, gateway="GW")
        payload = self.q.get_nowait()
        self.assertEqual(payload["reply_to_id"], "q7")
        self.assertEqual(payload["reply_to_text"], "the earlier msg")
        self.assertEqual(payload["timestamp"], 1699999999)

    def test_payload_declares_the_schema_version_the_door_speaks(self):
        bridge.on_inbound(event=_event(), gateway="GW")
        self.assertEqual(self.q.get_nowait()["schema_version"], 1)

    def test_a_message_with_no_platform_id_still_carries_a_stable_one(self):
        # Irises dedupes retried forwards on (platform, chat_id, message_id). Without an id of our
        # own, a retry after a lost 202 would arrive as a second turn.
        ev = _event(message_id=None, text="ok", timestamp=1700000000)
        bridge.on_inbound(event=ev, gateway="GW")
        first = self.q.get_nowait()["message_id"]
        self.assertTrue(first.startswith("eng-h-"), first)
        bridge.on_inbound(event=_event(message_id=None, text="ok", timestamp=1700000000), gateway="GW")
        self.assertEqual(self.q.get_nowait()["message_id"], first, "the same message digests the same")

    def test_payload_matches_shared_fixture(self):
        # bridge/contract-fixtures/inbound-v1.json is the one written copy of the v1 contract, also
        # read by src/channels/bridge/contract.test.ts. This is the incident-06889fa guard: a field
        # this side invents (or a value json.dumps cannot carry) fails here instead of silently
        # dropping every forward.
        import json as _json
        import pathlib as _pathlib
        fixture = _json.loads(
            (_pathlib.Path(__file__).resolve().parents[1] / "contract-fixtures" / "inbound-v1.json").read_text()
        )
        ev = _event(chat_id="42", chat_name="eng crew", thread_id="t7", chat_type="group",
                    reply_to_message_id="root9", reply_to_text="the report", timestamp=1700000000,
                    media_urls=["/var/cache/a.jpg"], media_types=["image/jpeg"])
        bridge.on_inbound(event=ev, gateway="GW")
        payload = self.q.get_nowait()
        unknown = set(payload) - set(fixture["known_fields"])
        self.assertEqual(unknown, set(), f"hermes sends fields the door does not know: {unknown}")
        self.assertEqual(payload["schema_version"], fixture["schema_version"])
        _json.dumps(payload)  # must NOT raise

    def test_gateway_captured_for_outbound_listener(self):
        with mock.patch.object(bridge, "_GW", [None, None]):
            bridge.on_inbound(event=_event(), gateway="THE-GATEWAY")
            self.assertEqual(bridge._GW[0], "THE-GATEWAY")

    def test_a_none_gateway_never_clobbers_a_live_capture(self):
        # hermes may call the hook without the kwarg (it defaults to None). An unconditional write
        # nulled out the watch thread's capture on the first fronted message, and every outbound send
        # then answered 503 "gateway not ready" — silence on a chat hermes was told to skip.
        with mock.patch.object(bridge, "_GW", ["THE-GATEWAY", "THE-LOOP"]):
            bridge.on_inbound(event=_event(), gateway=None)
            self.assertEqual(bridge._GW[0], "THE-GATEWAY")

    def test_hook_error_fails_open_by_default(self):
        # An event whose .source access blows up exercises the outer try/except.
        class Exploding:
            internal = False
            @property
            def source(self):
                raise RuntimeError("boom")
        self.assertIsNone(bridge.on_inbound(event=Exploding(), gateway=None))

    def test_hook_error_fails_closed_when_asked(self):
        class Exploding:
            internal = False
            @property
            def source(self):
                raise RuntimeError("boom")
        with mock.patch.dict("os.environ", {"IRISES_BRIDGE_FAIL": "closed"}):
            self.assertEqual(bridge.on_inbound(event=Exploding(), gateway=None),
                             {"action": "skip", "reason": "irises-bridge-error"})

    def test_full_queue_fails_open_by_default_and_closed_on_request(self):
        full: "queue.Queue[dict]" = queue.Queue(maxsize=1)
        full.put_nowait({})
        with mock.patch.object(bridge, "_QUEUES", [full]):
            self.assertIsNone(bridge.on_inbound(event=_event(), gateway=None))
            with mock.patch.dict("os.environ", {"IRISES_BRIDGE_FAIL": "closed"}):
                self.assertEqual(bridge.on_inbound(event=_event(), gateway=None),
                                 {"action": "skip", "reason": "irises-bridge-overflow"})

    def test_unreachable_irises_hands_the_turn_back_to_hermes_when_fail_open(self):
        # True fail-open: enqueueing into a void while telling hermes to stay silent is silence.
        down = bridge._Health()
        down.note_fail()
        with mock.patch.object(bridge, "_HEALTH", down):
            self.assertIsNone(bridge.on_inbound(event=_event(), gateway=None))
            self.assertTrue(self.q.empty(), "nothing is queued for an unreachable Irises")
            # fail=closed keeps the old always-skip: the operator chose silence over hermes's voice.
            with mock.patch.dict("os.environ", {"IRISES_BRIDGE_FAIL": "closed"}):
                self.assertEqual(bridge.on_inbound(event=_event(), gateway=None),
                                 {"action": "skip", "reason": "irises-bridge"})
                self.assertFalse(self.q.empty())


class AuthStatus(unittest.TestCase):
    def test_unset_token_refuses_every_send(self):
        # Fail closed, and say WHY — the listener still binds so Irises sees a readable 403
        # instead of an ECONNREFUSED that reads as "the plugin isn't installed".
        for configured in ("", "   ", None):
            status, body = bridge._auth_status(configured, "anything")
            self.assertEqual(status, 403)
            self.assertIn("IRISES_BRIDGE_TOKEN unset", body["error"])

    def test_mismatch_is_plain_forbidden(self):
        self.assertEqual(bridge._auth_status("secret", "nope"), (403, {"error": "forbidden"}))
        self.assertEqual(bridge._auth_status("secret", None), (403, {"error": "forbidden"}))

    def test_exact_match_authorizes(self):
        self.assertIsNone(bridge._auth_status("secret", "secret"))


class ListenerStartup(unittest.TestCase):
    """The listener is what carries Irises's REPLIES. A failure to bind it must never be permanent,
    and must never take the forward workers (or the hook) down with it."""

    def test_port_parse_never_raises(self):
        for raw, expect in (("8655", 8655), ("9001", 9001), ("", 8655), ("eight-six-five-five", 8655)):
            with mock.patch.dict("os.environ", {"IRISES_BRIDGE_PORT": raw}):
                self.assertEqual(bridge._port(), expect, raw)

    def test_a_failed_bind_leaves_the_listener_retryable(self):
        listening = __import__("threading").Event()
        with mock.patch.object(bridge, "_LISTENING", listening), \
             mock.patch.object(bridge, "ThreadingHTTPServer", side_effect=OSError("address in use")):
            self.assertFalse(bridge._start_listener())
            self.assertFalse(listening.is_set(), "a failed bind must not mark the listener up")

        # The port frees up; the next attempt lands and the flag sticks.
        started = []
        fake_thread = mock.Mock(start=lambda: started.append(1))
        with mock.patch.object(bridge, "_LISTENING", listening), \
             mock.patch.object(bridge, "ThreadingHTTPServer", return_value=mock.Mock()), \
             mock.patch.object(bridge.threading, "Thread", return_value=fake_thread):
            self.assertTrue(bridge._start_listener())
            self.assertTrue(listening.is_set())
            self.assertTrue(bridge._start_listener(), "already bound is a cheap no-op")
            self.assertEqual(len(started), 1, "and does not bind or spawn twice")

    def test_workers_start_once_but_the_bind_is_reattempted(self):
        started = __import__("threading").Event()
        listening = __import__("threading").Event()
        binds = []
        with mock.patch.object(bridge, "_STARTED", started), \
             mock.patch.object(bridge, "_LISTENING", listening), \
             mock.patch.object(bridge, "_start_listener", lambda: binds.append(1) or False), \
             mock.patch.object(bridge.threading, "Thread", return_value=mock.Mock(start=lambda: None)):
            bridge._start_workers()
            bridge._start_workers()
        self.assertEqual(len(binds), 2, "_STARTED gates the threads, not the bind")


class ShardIndex(unittest.TestCase):
    def test_same_chat_always_lands_on_the_same_shard(self):
        first = bridge._shard_index("telegram-chat-42", 4)
        for _ in range(5):
            self.assertEqual(bridge._shard_index("telegram-chat-42", 4), first)
        self.assertIn(first, range(4))

    def test_single_shard_and_int_ids(self):
        self.assertEqual(bridge._shard_index("anything", 1), 0)
        self.assertEqual(bridge._shard_index("x", 0), 0)
        self.assertEqual(bridge._shard_index(42, 4), bridge._shard_index("42", 4))

    def test_traffic_spreads_across_shards(self):
        seen = {bridge._shard_index(f"chat{i}", 4) for i in range(50)}
        self.assertEqual(seen, {0, 1, 2, 3})


class StableMessageId(unittest.TestCase):
    def test_a_platform_id_is_forwarded_untouched(self):
        self.assertEqual(bridge._stable_message_id("m1", "telegram", "42", "u1", "hi", 1700000000), "m1")
        self.assertEqual(bridge._stable_message_id(77, "telegram", "42", "u1", "hi", None), 77)

    def test_a_blank_platform_id_is_no_id_at_all(self):
        for blank in (None, "", "   "):
            self.assertTrue(
                bridge._stable_message_id(blank, "telegram", "42", "u1", "hi", None).startswith("eng-h-"),
                blank,
            )

    def test_the_digest_is_deterministic_and_content_addressed(self):
        args = ("telegram", "42", "u1", "hi", 1700000000)
        first = bridge._stable_message_id(None, *args)
        self.assertEqual(bridge._stable_message_id(None, *args), first, "same message, same id")
        for changed in (
            ("whatsapp", "42", "u1", "hi", 1700000000),
            ("telegram", "43", "u1", "hi", 1700000000),
            ("telegram", "42", "u2", "hi", 1700000000),
            ("telegram", "42", "u1", "hi there", 1700000000),
            ("telegram", "42", "u1", "hi", 1700000001),
        ):
            self.assertNotEqual(bridge._stable_message_id(None, *changed), first, changed)


    def test_a_timestamp_less_message_digests_per_receive_minute(self):
        """Two identical messages minutes apart must not collapse into one id, and a retry of the
        SAME message (0.5-2s later, the _backoff_s ladder) must still digest identically."""
        args = ("telegram", "42", "u1", "ok", None)
        with mock.patch.object(bridge.time, "time", return_value=1_700_000_000.0):
            first = bridge._stable_message_id(None, *args)
        # The retry, two seconds later: same minute bucket, same id — the dedup still works.
        with mock.patch.object(bridge.time, "time", return_value=1_700_000_002.0):
            self.assertEqual(bridge._stable_message_id(None, *args), first, "a retry is the same message")
        # The same words typed again five minutes later: a different message, a different id.
        with mock.patch.object(bridge.time, "time", return_value=1_700_000_300.0):
            self.assertNotEqual(bridge._stable_message_id(None, *args), first, "a later 'ok' is its own turn")


class Backoff(unittest.TestCase):
    def test_two_step_backoff_clamped_at_the_ends(self):
        self.assertEqual(bridge._backoff_s(1), 0.5)
        self.assertEqual(bridge._backoff_s(2), 2.0)
        self.assertEqual(bridge._backoff_s(0), 0.5)
        self.assertEqual(bridge._backoff_s(9), 2.0)


class ForwardDecision(unittest.TestCase):
    def test_matrix(self):
        self.assertEqual(bridge._forward_decision(True, False), "forward")
        self.assertEqual(bridge._forward_decision(False, False), "let_hermes")
        self.assertEqual(bridge._forward_decision(True, True), "forward")
        self.assertEqual(bridge._forward_decision(False, True), "forward")


class ClassifySendResult(unittest.TestCase):
    def test_success_carries_the_message_id_back(self):
        ok = types.SimpleNamespace(success=True, message_id=77, error=None, retryable=False)
        self.assertEqual(bridge._classify_send_result(ok), (200, {"ok": True, "message_id": "77"}))

    def test_success_without_an_id_is_still_200(self):
        ok = types.SimpleNamespace(success=True, message_id=None)
        self.assertEqual(bridge._classify_send_result(ok), (200, {"ok": True, "message_id": None}))

    def test_success_false_is_a_502_not_a_200(self):
        # adapter.send REPORTS failure (success=False) without raising.
        bad = types.SimpleNamespace(success=False, message_id=None, error="chat not found", retryable=True)
        self.assertEqual(bridge._classify_send_result(bad),
                         (502, {"error": "chat not found", "retryable": True}))
        vague = types.SimpleNamespace(success=False, message_id=None, error=None)
        status, body = bridge._classify_send_result(vague)
        self.assertEqual(status, 502)
        self.assertIn("failed", body["error"])

    def test_missing_result_is_a_502(self):
        status, body = bridge._classify_send_result(None)
        self.assertEqual(status, 502)
        self.assertIn("no send result", body["error"])


class ConfigErrorStatuses(unittest.TestCase):
    """401/403/404 are the two misconfigurations the bridge can hit, and neither self-heals."""

    def test_status_is_read_off_an_http_error_and_absent_from_a_transport_one(self):
        http = urllib.error.HTTPError("http://irises/api/bridge/inbound", 403, "Forbidden", {}, None)
        self.assertEqual(bridge._forward_status(http), 403)
        self.assertIsNone(bridge._forward_status(urllib.error.URLError("connection refused")))
        self.assertIsNone(bridge._forward_status(TimeoutError()))

    def test_only_401_403_404_count_as_configuration(self):
        for status in (401, 403, 404):
            self.assertTrue(bridge._is_config_error(status), status)
        for status in (None, 200, 429, 500, 502, 503):
            self.assertFalse(bridge._is_config_error(status), status)

    def test_the_hint_names_the_actual_cause(self):
        for status in (401, 403):
            hint = bridge._config_error_hint(status)
            self.assertIn("IRISES_BRIDGE_TOKEN", hint)
            self.assertIn("ENGINE_PUSH_TOKEN", hint)
        self.assertIn("OPS_BACKEND", bridge._config_error_hint(404))


class ForwardLoop(unittest.TestCase):
    """What a failed forward writes to _HEALTH decides whether the NEXT fronted turn reaches Irises
    or goes back to hermes — this message is already lost either way (hermes was told to skip)."""

    class _Stop(Exception):
        """Ends the worker's `while True` once the queued payloads are drained."""

    class _Queue:
        def __init__(self, items, stop):
            self._items, self._stop = list(items), stop

        def get(self):
            if self._items:
                return self._items.pop(0)
            raise self._stop

    def _run(self, exc):
        """Drive one payload through _forward_loop with every POST failing as `exc`."""
        posts = []

        def boom(base, token, payload):
            posts.append(payload)
            raise exc

        health = bridge._Health()
        q = self._Queue([{"platform": "telegram", "chat_id": "42"}], self._Stop)
        with mock.patch.object(bridge, "_post_inbound", boom), \
             mock.patch.object(bridge, "_HEALTH", health), \
             mock.patch.object(bridge, "_backoff_s", lambda _a: 0), \
             self.assertLogs(bridge.log, level="ERROR") as logged, \
             self.assertRaises(self._Stop):
            bridge._forward_loop(q)
        return health, len(posts), "\n".join(logged.output)

    def test_a_403_is_loud_final_and_hands_the_chat_back_to_hermes(self):
        health, posts, logged = self._run(
            urllib.error.HTTPError("http://irises/api/bridge/inbound", 403, "Forbidden", {}, None))
        self.assertEqual(posts, 1, "a token mismatch is never retried")
        self.assertIn("HTTP 403", logged)
        self.assertIn("IRISES_BRIDGE_TOKEN", logged)
        self.assertIn("ENGINE_PUSH_TOKEN", logged)
        self.assertFalse(health.is_healthy(), "the verdict flips even though /health still answers")
        # …and the flipped verdict is what actually returns the chat to hermes.
        with mock.patch.object(bridge, "_HEALTH", health), \
             mock.patch.object(bridge, "_QUEUES", [queue.Queue(maxsize=10)]), \
             mock.patch.object(bridge, "_start_workers", lambda: None), \
             mock.patch.dict("os.environ", {"IRISES_FRONT": "telegram:*"}, clear=False):
            self.assertIsNone(bridge.on_inbound(event=_event(), gateway=None))

    def test_a_404_names_the_unmounted_route(self):
        _health, posts, logged = self._run(
            urllib.error.HTTPError("http://irises/api/bridge/inbound", 404, "Not Found", {}, None))
        self.assertEqual(posts, 1)
        self.assertIn("HTTP 404", logged)
        self.assertIn("OPS_BACKEND", logged)

    def test_a_transport_failure_still_gets_all_three_attempts(self):
        health, posts, logged = self._run(urllib.error.URLError("connection refused"))
        self.assertEqual(posts, bridge._FORWARD_ATTEMPTS, "a restart deserves its retries")
        self.assertIn("LOST", logged)
        self.assertFalse(health.is_healthy())

    def test_a_500_is_transport_shaped_and_is_retried(self):
        _health, posts, _logged = self._run(
            urllib.error.HTTPError("http://irises/api/bridge/inbound", 500, "Server Error", {}, None))
        self.assertEqual(posts, bridge._FORWARD_ATTEMPTS)


class Healthy(unittest.TestCase):
    def test_unknown_counts_healthy(self):
        self.assertTrue(bridge._healthy(None, 1000.0))

    def test_inside_and_outside_the_window(self):
        self.assertTrue(bridge._healthy(1000.0, 1059.0, 60.0))
        self.assertTrue(bridge._healthy(1000.0, 1060.0, 60.0))
        self.assertFalse(bridge._healthy(1000.0, 1061.0, 60.0))

    def test_health_state_transitions(self):
        h = bridge._Health()
        self.assertTrue(h.is_healthy(now=100.0), "nothing tried yet")
        h.note_fail(now=100.0)
        self.assertFalse(h.is_healthy(now=100.0), "tried and never succeeded is known-down")
        h.note_ok(now=200.0)
        self.assertTrue(h.is_healthy(now=250.0))
        self.assertFalse(h.is_healthy(now=400.0), "a stale OK falls out of the window")

    def test_a_fail_newer_than_the_last_ok_beats_a_fresh_probe(self):
        # The 15s /health probe is unauthenticated and route-independent, so it kept answering 200
        # through a 403 storm and every note_fail() from the forward path was inert — each fronted
        # message lost with hermes already told to stay silent.
        h = bridge._Health()
        h.note_ok(now=100.0)
        self.assertTrue(h.is_healthy(now=101.0))
        h.note_fail(now=102.0)
        self.assertFalse(h.is_healthy(now=103.0), "a forward failure is not masked by a fresh probe")
        h.note_ok(now=104.0)
        self.assertTrue(h.is_healthy(now=105.0), "and a later success clears it again")


class ResolveTypingCall(unittest.TestCase):
    def test_picks_the_first_available_method_in_priority_order(self):
        class Adapter:  # both exist → send_chat_action wins (first in priority order)
            async def send_chat_action(self, *a):
                ...
            async def send_typing(self, *a):
                ...
        name, fn = bridge._resolve_typing_call(Adapter())
        self.assertEqual(name, "send_chat_action")
        self.assertTrue(callable(fn))

    def test_falls_through_to_a_later_name(self):
        class Adapter:
            async def set_typing(self, *a):
                ...
        name, _ = bridge._resolve_typing_call(Adapter())
        self.assertEqual(name, "set_typing")

    def test_none_when_the_adapter_has_no_chat_action(self):
        class Adapter:
            async def send(self, *a):  # a send-only adapter can't type
                ...
        self.assertIsNone(bridge._resolve_typing_call(Adapter()))

    def test_a_non_callable_attribute_is_ignored(self):
        class Adapter:
            send_chat_action = "not a method"  # must not be mistaken for a callable
            async def typing(self, *a):
                ...
        name, _ = bridge._resolve_typing_call(Adapter())
        self.assertEqual(name, "typing")

    def test_fuzzy_matches_an_unlisted_typing_method_name(self):
        # A Photon adapter's own name (not in the exact list) is still caught by the fuzzy pass.
        class Adapter:
            async def sendTypingIndicator(self, *a):
                ...
        name, _ = bridge._resolve_typing_call(Adapter())
        self.assertEqual(name, "sendTypingIndicator")

    def test_fuzzy_skips_predicates_and_handlers(self):
        # `is_typing`/`on_typing` are a getter and an event handler, not an action to invoke → no match.
        class Adapter:
            async def is_typing(self, *a):
                ...
            async def on_typing(self, *a):
                ...
        self.assertIsNone(bridge._resolve_typing_call(Adapter()))


class FirstAttr(unittest.TestCase):
    def test_returns_the_first_non_none_field(self):
        obj = types.SimpleNamespace(a=None, b="x", c="y")
        self.assertEqual(bridge._first_attr(obj, ("a", "b", "c")), "x")

    def test_none_when_no_candidate_is_set(self):
        obj = types.SimpleNamespace(a=None)
        self.assertIsNone(bridge._first_attr(obj, ("a", "missing", "alsomissing")))


class ToEpoch(unittest.TestCase):
    def test_datetime_becomes_epoch_seconds(self):
        import datetime as _dt
        dt = _dt.datetime(2026, 8, 30, 12, 0, tzinfo=_dt.timezone.utc)
        self.assertEqual(bridge._to_epoch(dt), dt.timestamp())

    def test_number_passes_through(self):
        self.assertEqual(bridge._to_epoch(1700000000), 1700000000)
        self.assertEqual(bridge._to_epoch(1700000000.5), 1700000000.5)

    def test_none_and_junk_yield_none(self):
        self.assertIsNone(bridge._to_epoch(None))
        self.assertIsNone(bridge._to_epoch("not a time"))


class Revive(unittest.TestCase):
    """A clean stop (stray pkill) leaves the Irises service down — launchd/systemd only restart a crash.
    The gateway start is where it gets brought back, so `hermes gateway restart` fixes it."""

    def setUp(self):
        import tempfile, os as _os
        self.home = tempfile.mkdtemp()
        _os.makedirs(_os.path.join(self.home, "Library", "LaunchAgents"))
        _os.makedirs(_os.path.join(self.home, ".config", "systemd", "user"))
        self.os = _os

    def _touch(self, *parts):
        open(self.os.path.join(self.home, *parts), "w").close()

    def test_loopback_only(self):
        for url in ("http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"):
            self.assertTrue(bridge._is_loopback_url(url), url)
        for url in ("http://10.0.0.5:3000", "https://irises.example.com", "http://127.0.0.1.evil.com", ""):
            self.assertFalse(bridge._is_loopback_url(url), url)

    def test_macos_starts_the_launchd_job_without_restarting_a_live_one(self):
        self._touch("Library", "LaunchAgents", "ai.irises.server.plist")
        cmds = bridge._revive_commands("Darwin", 501, self.home, "http://127.0.0.1:3000", "on")
        self.assertEqual(cmds[0], ["launchctl", "kickstart", "gui/501/ai.irises.server"])
        self.assertNotIn("-k", cmds[0], "-k would kill a running Irises")
        self.assertEqual(cmds[1][:3], ["launchctl", "bootstrap", "gui/501"])

    def test_linux_starts_the_user_unit(self):
        self._touch(".config", "systemd", "user", "irises.service")
        self.assertEqual(bridge._revive_commands("Linux", 1000, self.home, "http://127.0.0.1:3000", "on"),
                         [["systemctl", "--user", "start", "irises"]])

    def test_nothing_to_start_is_left_alone(self):
        self.assertEqual(bridge._revive_commands("Darwin", 501, self.home, "http://127.0.0.1:3000", "on"), [])
        self._touch("Library", "LaunchAgents", "ai.irises.server.plist")
        self.assertEqual(bridge._revive_commands("Darwin", 501, self.home, "http://10.0.0.5:3000", "on"), [])
        for off in ("off", "0", "false", "no"):
            self.assertEqual(bridge._revive_commands("Darwin", 501, self.home, "http://127.0.0.1:3000", off), [])
        self.assertEqual(bridge._revive_commands("Windows", 0, self.home, "http://127.0.0.1:3000", "on"), [])

    def test_a_healthy_irises_is_never_touched(self):
        with mock.patch.dict("os.environ", {"IRISES_FRONT": "*:*"}), \
             mock.patch.object(bridge, "_health_ok", return_value=True), \
             mock.patch.object(bridge.subprocess, "run") as run:
            bridge._revive_irises()
        run.assert_not_called()

    def test_a_down_irises_is_started_and_marked_healthy(self):
        self._touch("Library", "LaunchAgents", "ai.irises.server.plist")
        health = iter([False, False, True])
        with mock.patch.dict("os.environ", {"IRISES_FRONT": "*:*", "IRISES_URL": "http://127.0.0.1:3000"}), \
             mock.patch.object(bridge, "_health_ok", side_effect=lambda *_a, **_k: next(health)), \
             mock.patch.object(bridge.os, "uname", return_value=types.SimpleNamespace(sysname="Darwin")), \
             mock.patch.object(bridge.os.path, "expanduser", return_value=self.home), \
             mock.patch.object(bridge.time, "sleep"), \
             mock.patch.object(bridge, "_HEALTH") as health_state, \
             mock.patch.object(bridge.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
            bridge._revive_irises()
        self.assertEqual(run.call_args_list[0].args[0][:2], ["launchctl", "kickstart"])
        self.assertEqual(run.call_count, 1, "kickstart worked, so bootstrap is not tried")
        health_state.note_ok.assert_called_once()

    def test_front_nothing_means_do_nothing(self):
        with mock.patch.dict("os.environ", {"IRISES_FRONT": ""}), \
             mock.patch.object(bridge, "_health_ok") as probe, \
             mock.patch.object(bridge.subprocess, "run") as run:
            bridge._revive_irises()
        probe.assert_not_called()
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
