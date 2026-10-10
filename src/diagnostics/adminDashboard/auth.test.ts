import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { authed, checkPassword, passwordConfigured, sessionCookie } from './auth.js';

// The bug this file pins: the dashboard used to fall back to a password that ships in the public
// source ("adminofirises"), on a server that binds every interface — so a deploy that forgot to set
// DASHBOARD_PASSWORD served every prompt, memory file and trace to anyone who read the repo.

/** The smallest thing authed()/sessionCookie() actually read off a request. */
function req(ip: string, cookie?: string): Request {
  return {
    ip,
    socket: { remoteAddress: ip },
    headers: cookie ? { cookie } : {},
    secure: false,
  } as unknown as Request;
}

function cookieToken(setCookie: string): string {
  const m = /irises_dash=([^;]*)/.exec(setCookie);
  return m ? m[1] : '';
}

test('with no password configured: no password can log in, not even the old shipped one', () => {
  delete process.env.DASHBOARD_PASSWORD;
  assert.equal(passwordConfigured(), false);
  assert.equal(checkPassword(''), false, 'an empty password must never authenticate');
  assert.equal(checkPassword('adminofirises'), false, 'the old shipped default must be dead');
  assert.equal(checkPassword('anything at all'), false);
});

test('with no password configured: loopback is in, another address is not', () => {
  delete process.env.DASHBOARD_PASSWORD;
  assert.equal(authed(req('127.0.0.1')), true);
  assert.equal(authed(req('::1')), true);
  assert.equal(authed(req('::ffff:127.0.0.1')), true);
  assert.equal(authed(req('203.0.113.5')), false, 'a public IPv4 must not reach the dashboard');
  assert.equal(authed(req('2001:db8::1')), false, 'an IPv6 address ending in ::1 must not either');
});

test('with a password configured: it is required, and the cookie it sets is accepted', () => {
  process.env.DASHBOARD_PASSWORD = 's3cret';
  try {
    assert.equal(passwordConfigured(), true);
    assert.equal(checkPassword('s3cret'), true);
    assert.equal(checkPassword('s3cre'), false);
    assert.equal(checkPassword(''), false);

    // No cookie yet: locked out from anywhere, loopback included — a password was set, so the
    // localhost bypass must NOT still apply.
    assert.equal(authed(req('127.0.0.1')), false);
    assert.equal(authed(req('203.0.113.5')), false);

    // The login response's cookie is the credential, and it works from a remote address (that is
    // the point of setting a password: reach it from your laptop over TLS).
    const token = cookieToken(sessionCookie(req('203.0.113.5')));
    assert.ok(token.length > 0, 'login must set a token');
    assert.equal(authed(req('203.0.113.5', `irises_dash=${token}`)), true);
    assert.equal(authed(req('203.0.113.5', 'irises_dash=not-the-token')), false);

    // Rotating the password invalidates the old sessions.
    process.env.DASHBOARD_PASSWORD = 'rotated';
    assert.equal(authed(req('203.0.113.5', `irises_dash=${token}`)), false, 'rotation must kill old sessions');
    assert.equal(checkPassword('s3cret'), false);
  } finally {
    delete process.env.DASHBOARD_PASSWORD;
  }
});
