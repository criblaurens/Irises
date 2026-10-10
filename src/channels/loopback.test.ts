import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackAddress } from './loopback.js';

// The whole point of this file: the tokenless guards used to match with `includes('::1')`, which is
// true for every IPv6 client whose address happens to END in `::1` — a live address on most
// dual-stack VPSes. Each rejected row below is a real address that the old substring check let in.
test('loopback addresses are matched exactly, never by substring', () => {
  const allowed = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  const rejected = [
    '2001:db8::1',
    '2a01:4f8:c0c:1::1a2b',
    'fe80::1ff:fe23:4567:890a',
    '10.0.0.1',
    '192.168.1.5',
    '127.0.0.10',
    '::ffff:10.0.0.1',
    '',
    undefined,
    null,
  ];
  for (const ip of allowed) {
    assert.equal(isLoopbackAddress(ip), true, `${ip} is loopback and must be allowed`);
  }
  for (const ip of rejected) {
    assert.equal(isLoopbackAddress(ip), false, `${String(ip)} is not loopback and must be refused`);
  }
});
