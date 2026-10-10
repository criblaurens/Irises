import { Request } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { isLoopback } from '../../channels/loopback.js';

// Auth: DASHBOARD_PASSWORD. A correct login sets a stateless HMAC cookie derived
// from the password, so sessions survive restarts and rotating the password
// invalidates every session at once.
//
// UNSET MEANS LOCALHOST-ONLY, NOT "NO PASSWORD". There used to be a fallback to a
// password that ships in this source ("adminofirises"), which meant a deploy on a
// public port — the documented Docker/Caddy path — served every prompt, memory file
// and trace to anyone who read the repo. With no password configured the dashboard
// now answers loopback requests only, and refuses the rest with a 403 telling the
// operator to set one. env.vm.example always claimed this was the behaviour; now it
// is.

const COOKIE = 'irises_dash';
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;

// Read the password per call rather than at module load, so a test (and any embedder) can set it
// without re-importing the module. The derived session token is cached against the password it came
// from, which keeps the property the module always had: the cookie is stateless and survives a
// restart, and rotating the password invalidates every outstanding session at once.
function currentPassword(): string {
  return process.env.DASHBOARD_PASSWORD || '';
}

/** Is a password configured at all? False = localhost-only mode. */
export function passwordConfigured(): boolean {
  return currentPassword().length > 0;
}

let tokenFor = '';
let tokenValue = '';
function sessionToken(): string {
  const pw = currentPassword();
  if (tokenFor !== pw) {
    const secret = createHash('sha256').update(`irises-dashboard-v1:${pw}`).digest();
    tokenValue = createHmac('sha256', secret).update('admin-session').digest('hex');
    tokenFor = pw;
  }
  return tokenValue;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function checkPassword(password: string): boolean {
  // Never let an empty password log in: with no password configured, safeEqual('','')
  // would be true, and the login form would hand out a session to anyone.
  if (!passwordConfigured()) return false;
  return safeEqual(password, currentPassword());
}

function cookieValue(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return rest.join('=');
  }
  return null;
}

export function authed(req: Request): boolean {
  // Localhost-only mode: no password exists to check, and the router has already refused
  // every non-loopback request before it reached a route. Answering on the address rather
  // than on `true` keeps this safe even if a route is ever mounted outside that guard.
  if (!passwordConfigured()) return isLoopback(req);
  const v = cookieValue(req);
  return !!v && safeEqual(v, sessionToken());
}

/** Set-Cookie value for login (or logout with clear=true). The 30-day session token is a
 *  credential — mark it Secure whenever the request came in over HTTPS (direct or via
 *  proxy header), while keeping plain-http localhost dev working. */
export function sessionCookie(req: Request, clear = false): string {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return clear
    ? `${COOKIE}=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
    : `${COOKIE}=${sessionToken()}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure}`;
}

// Light brute-force damper: max 20 login attempts per IP per minute.
const attempts = new Map<string, { count: number; windowStart: number }>();
export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.windowStart > 60_000) { attempts.set(ip, { count: 1, windowStart: now }); return false; }
  a.count++;
  return a.count > 20;
}
