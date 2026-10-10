import { Router, Request, Response } from 'express';
import { authed, checkPassword, passwordConfigured, rateLimited, sessionCookie } from './auth.js';
import { isLoopback } from '../../channels/loopback.js';
import { LOGIN_PAGE } from './views/login.js';
import { buildAppPage } from './assemble.js';
import { registerTurnRoutes } from './api/turns.js';
import { registerOverviewRoutes } from './api/overview.js';
import { registerAnalyticsRoutes } from './api/analytics.js';
import { registerErrorRoutes } from './api/errors.js';
import { registerMemoryRoutes } from './api/memory.js';
import { registerUserRoutes } from './api/users.js';
import { registerTurncostRoutes } from './api/turncost.js';
import { registerAffectRoutes } from './api/affect.js';

// ---------------------------------------------------------------------------
// /dashboard — password-gated admin GUI. Views: system-health Overview, the
// ORCHESTRATION GRAPH (every prompt sent/received between the agents, rendered
// as a live flow diagram with full payload drill-down), LLM analytics, the
// agent-wide error log, user roster, full turn history + search, a per-user
// memory inspector, and the per-user INNER STATE panel (the affect trail, the
// climate dials, the thread inventory, and the last twenty turn:trace receipts).
// Every turn is persisted (diagnosticTurnHistory) so history survives restarts.
// ---------------------------------------------------------------------------

export function createAdminDashboardRouter(): Router {
  const router = Router();

  // Runs before every /dashboard route below — login, API, page. With no DASHBOARD_PASSWORD
  // configured the dashboard is loopback-only: a deploy that forgot to set one must not serve
  // prompts and memory to the internet. With one configured this middleware is a no-op.
  router.use((req: Request, res: Response, next) => {
    if (passwordConfigured() || isLoopback(req)) { next(); return; }
    res.status(403).send('forbidden — set DASHBOARD_PASSWORD to use the dashboard from another machine');
  });

  router.post('/dashboard/login', (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) { res.status(429).json({ error: 'too many attempts, wait a minute' }); return; }
    const password = typeof (req.body as { password?: unknown })?.password === 'string'
      ? (req.body as { password: string }).password : '';
    if (!checkPassword(password)) { res.status(401).json({ error: 'wrong password' }); return; }
    res.setHeader('Set-Cookie', sessionCookie(req));
    res.json({ ok: true });
  });

  router.post('/dashboard/logout', (req: Request, res: Response) => {
    res.setHeader('Set-Cookie', sessionCookie(req, true));
    res.json({ ok: true });
  });

  registerTurnRoutes(router);
  registerOverviewRoutes(router);
  registerAnalyticsRoutes(router);
  registerErrorRoutes(router);
  registerMemoryRoutes(router);
  registerUserRoutes(router);
  registerTurncostRoutes(router);
  registerAffectRoutes(router);

  // Assembled once at boot — the page is static; all data flows through the API.
  const APP_PAGE = buildAppPage();
  router.get('/dashboard', (req: Request, res: Response) => {
    res.status(200).set('Content-Type', 'text/html');
    res.send(authed(req) ? APP_PAGE : LOGIN_PAGE);
  });

  return router;
}
