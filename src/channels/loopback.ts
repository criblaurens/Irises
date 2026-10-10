import type { Request } from 'express';

// Exact match, never a substring: `includes('127.0.0.1')` also accepts a real remote address that
// merely CONTAINS the loopback text — `includes('::1')` matched every IPv6 client on a prefix that
// happens to end in `::1` (2001:db8::1, fe80::1ff:…), which is a live address on most dual-stack
// VPSes. The tokenless mode is the dev fallback that guards doors which can make Irises speak
// (/api/web/message, /debug, /dashboard, /api/bridge/inbound, /api/engine/push), so the check is
// shared here rather than re-spelled at each door.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(ip: string | undefined | null): boolean {
  return LOOPBACK.has(ip || '');
}

export function isLoopback(req: Request): boolean {
  return isLoopbackAddress(req.ip || req.socket?.remoteAddress || '');
}
