// Web debug channel HTTP routes — the browser (and the CLI, `npm run chat`) talk to Irises's brain here.
//
//   POST /api/web/message  — send a message; runs the SAME batching/mouth pipeline as every channel. 202s
//                            immediately; the reply is NOT in this response — it streams below.
//   GET  /api/web/stream   — long-lived SSE. The live reply AND later async Ops follow-ups arrive
//                            here, in order (same per-chat mouth lock). Reconnect replays via
//                            Last-Event-ID; a `: ping` heartbeat keeps the stream from idling out.
//   POST /api/web/cancel   — Stop button: cancels any in-flight research for this web chat.
//
// `enqueueInbound` is injected (not imported from index.ts) to avoid a runtime import cycle; only the
// AgentClient/EnqueueInbound TYPES are imported from index (erased at runtime).
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { emptyMedia } from '../../webhook/types.js';
import { attachWebClient } from './channel.js';
import { isLoopback } from '../loopback.js';
import { webChatId, WEB_DEBUG_HANDLE } from './identity.js';
import { getActiveOps, requestOpsCancel } from '../../state/opsCoordination.js';
import type { AgentClient, EnqueueInbound } from '../../index.js';

export interface WebRouterDeps {
  enqueueInbound: EnqueueInbound;
  agentClient: AgentClient;
}

const HEARTBEAT_MS = 15_000;

// Guard (same policy as /debug): if DEBUG_TOKEN is set, require it (?token= or x-debug-token);
// otherwise only allow localhost, by exact address match. POST /api/web/message drives a full agent
// turn (LLM spend), so this must never sit open on the internet. EventSource can't set headers,
// hence the query param.
function authorized(req: Request): boolean {
  const token = process.env.DEBUG_TOKEN;
  if (token) return req.query.token === token || req.headers['x-debug-token'] === token;
  return isLoopback(req);
}

export function createWebRouter(deps: WebRouterDeps): Router {
  const router = Router();

  router.post('/api/web/message', (req: Request, res: Response) => {
    if (!authorized(req)) { res.status(403).json({ error: 'forbidden — pass ?token=YOUR_DEBUG_TOKEN' }); return; }
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) { res.status(400).json({ error: 'empty message' }); return; }
    const chatId = webChatId(typeof req.body?.clientId === 'string' ? req.body.clientId : undefined);
    const messageId = 'web-in-' + randomUUID();
    deps.enqueueInbound(deps.agentClient, chatId, WEB_DEBUG_HANDLE, text, messageId, emptyMedia());
    res.status(202).json({ ok: true, chatId, messageId });
  });

  router.get('/api/web/stream', (req: Request, res: Response) => {
    if (!authorized(req)) { res.status(403).json({ error: 'forbidden — pass ?token=YOUR_DEBUG_TOKEN' }); return; }
    const chatId = webChatId(typeof req.query.clientId === 'string' ? req.query.clientId : undefined);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',   // disable proxy buffering for SSE (Caddy also needs flush_interval -1)
    });
    res.write(': connected\n\n');
    const lastRaw = Number(req.headers['last-event-id']);
    attachWebClient(chatId, res, Number.isFinite(lastRaw) ? lastRaw : undefined);
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, HEARTBEAT_MS);
    (heartbeat as { unref?: () => void }).unref?.();
    req.on('close', () => clearInterval(heartbeat));
  });

  router.post('/api/web/cancel', (req: Request, res: Response) => {
    if (!authorized(req)) { res.status(403).json({ error: 'forbidden — pass ?token=YOUR_DEBUG_TOKEN' }); return; }
    const chatId = webChatId(typeof req.body?.clientId === 'string' ? req.body.clientId : undefined);
    const active = getActiveOps(chatId);
    for (const t of active) requestOpsCancel(chatId, t.taskId);
    res.status(202).json({ cancelled: active.length });
  });

  return router;
}
