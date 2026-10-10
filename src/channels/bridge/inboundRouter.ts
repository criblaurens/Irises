// Inbound door for engine-fronted chats: the bridge plugins (bridge/hermes, bridge/openclaw —
// installed INTO the engines via their official plugin mechanisms) POST every fronted inbound
// message here, having suppressed the engine's own reply. From here it is a completely normal
// Irises turn: enqueueInbound → Convo → (deep work back on the engine) → Composer → the bridge
// channel delivers through the engine's connection.
//
// This file is only the DOOR: auth, one call into ./contract.ts, one claim against
// bridge_inbound_seen, the receipt, and the answer. What a v1 payload IS lives in the contract;
// mapBridgeMedia and normalizeTimestamp are re-exported from here because they were born here and
// callers (and bridge.test.ts, the byte-identity oracle for the coercions) import them from this
// path.
//
// Auth mirrors /api/engine/push: ENGINE_PUSH_TOKEN set → x-bridge-token must match exactly;
// unset → loopback-only (dev). One token guards both engine-facing doors on purpose — the setup
// script provisions it once into the engine's plugin environment.
import { Router, type Request } from 'express';
import { noteBridgeChat } from './channel.js';
import { isLoopback } from '../loopback.js';
import { parseBridgeInbound } from './contract.js';
import { claimBridgeInbound, bridgeInboundDedupEnabled } from '../../db/repositories/bridgeInboundSeen.js';
import { record } from '../../diagnostics/trace.js';
import type { AgentClient, EnqueueInbound } from '../../index.js';

export { mapBridgeMedia, normalizeTimestamp } from './contract.js';

function authorized(req: Request): boolean {
  const token = process.env.ENGINE_PUSH_TOKEN;
  if (token) return req.headers['x-bridge-token'] === token;
  return isLoopback(req);
}

export function createBridgeInboundRouter(deps: { enqueueInbound: EnqueueInbound; agentClient: AgentClient }): Router {
  const router = Router();

  router.post('/api/bridge/inbound', (req, res) => {
    if (!authorized(req)) {
      res.status(403).json({ error: 'forbidden — send x-bridge-token' });
      return;
    }
    const parsed = parseBridgeInbound(req.body);
    if (!parsed.ok) {
      // A 400 used to leave NO trace at all — the incident-06889fa blind spot, where a Python
      // datetime in `timestamp` silenced every inbound forward with nothing to read afterwards.
      // One receipt per outcome: a rejection emits THIS and not bridge:inbound.
      record({ type: 'event', label: 'bridge:inbound-rejected', detail: { reason: parsed.error, field: parsed.field } });
      res.status(400).json({ error: parsed.error });
      return;
    }
    const v = parsed.value;
    const detail: Record<string, unknown> = {
      engine: v.engine, platform: v.platform, isGroup: v.isGroup, chars: v.text.length,
      media: v.mediaCount, schemaVersion: v.schemaVersion, truncated: v.truncated,
      ...(parsed.ignoredFields.length ? { ignored: parsed.ignoredFields } : {}),
    };

    // Idempotency BEFORE any side effect: the plugins claim the turn from their engine before Irises
    // acknowledges, and the Hermes one retries three times, so a 202 that never landed comes back.
    // A synthetic eng-in- id is minted per request and could never match a retry — claiming it would
    // only fill the table with keys nothing will ever look up.
    const dedupe = !bridgeInboundDedupEnabled() ? undefined
      : !v.hasPlatformMessageId ? 'unkeyed'
      : claimBridgeInbound(v.platform, v.chatId, v.messageId) === 'duplicate' ? 'hit' : 'miss';
    if (dedupe === 'hit') {
      // 200, not 202: nothing was accepted THIS time, and the plugin should stop retrying. No
      // noteBridgeChat, no enqueue — the first POST already owns this turn.
      record({
        type: 'event', chatId: v.chatId, label: 'bridge:inbound',
        detail: { ...detail, decision: 'duplicate', reason: 'message_id already claimed', dedupe },
      });
      res.status(200).json({ ok: true, chatId: v.chatId, duplicate: true });
      return;
    }

    noteBridgeChat(v.chatId, {
      isGroup: v.isGroup,
      name: v.chatName,
      // The plugin has always forwarded thread_id; dropping it here is what sent replies to a
      // Telegram forum topic back into the group's General.
      threadId: v.threadId,
    });
    record({
      type: 'event', chatId: v.chatId, label: 'bridge:inbound',
      detail: { ...detail, decision: 'accepted', ...(dedupe ? { dedupe } : {}) },
    });
    // Reply-to: the contract carries the quoted CONTENT alongside the id when the plugin forwarded
    // it, so the model sees what was replied to even if the id can't be resolved to a stored
    // bubble/inbound row.
    deps.enqueueInbound(deps.agentClient, v.chatId, v.from, v.text, v.messageId, v.media, v.replyTo, v.receivedAt);
    res.status(202).json({ ok: true, chatId: v.chatId });
  });

  return router;
}
