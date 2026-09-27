// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The facts Irises reads off when someone asks what version she is, whether an update is waiting, or
// asks her to update herself. There is no tool for that last one any more, so the ONLY thing standing
// between "she says the truth" and "she invents something" is this section — which is why its three
// states, its fallbacks and its one relayed command are pinned here rather than only measured.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderBuildBullet, renderUpdateStatus } from './shared.js';
import { _resetCheckerForTests, _setChecksLiveForTests, type UpdateStatus } from '../../update/checker.js';
import type { VersionInfo } from '../../update/version.js';

const NOW = Date.UTC(2026, 0, 6, 2, 0, 0);
const MINUTE = 60_000;

const VERSION: VersionInfo = {
  sha: '4f2a91c'.padEnd(40, '0'), shortSha: '4f2a91c', branch: 'main', builtAt: null, source: 'stamp',
};

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    current: VERSION, remoteSha: null, updateAvailable: false, lastCheckAt: NOW - 5 * MINUTE,
    lastCheckOk: true, ...over,
  };
}

beforeEach(() => {
  _resetCheckerForTests();
  _setChecksLiveForTests(true);   // the checker armed at boot, which is the live default
});

test('an update waiting: the remote short sha, named as waiting on the server', () => {
  const out = renderUpdateStatus(VERSION, status({ remoteSha: '9ab3c7d'.padEnd(40, '0'), updateAvailable: true }), NOW);
  assert.match(out, /^## Your build and how you get updated \(facts; say them plainly if asked\)$/m);
  assert.match(out, /^- You are running build 4f2a91c on branch main, right now\. This line is the only current one/m);
  assert.match(out, /^- A newer build \(9ab3c7d\) is waiting on the server\.$/m);
  assert.doesNotMatch(out, /No newer build/);
});

test('nothing waiting: the answer carries WHEN it was last checked', () => {
  assert.match(renderUpdateStatus(VERSION, status(), NOW), /^- No newer build is waiting, as of 5 minutes ago\.$/m);
});

test('checks off for this install: she says she cannot tell, never "nothing is waiting"', () => {
  _setChecksLiveForTests(false);
  const out = renderUpdateStatus(VERSION, status({ remoteSha: 'x'.repeat(40), updateAvailable: true }), NOW);
  assert.match(out, /^- You can't tell whether a newer build is waiting \(version checks are off for this install\)\.$/m);
  // …and a stale in-memory verdict cannot leak past the gate as a claim.
  assert.doesNotMatch(out, /is waiting on the server/);
  assert.doesNotMatch(out, /No newer build/);
});

test('the relative-time phrase covers every band, and reads like a person', () => {
  const at = (ago: number) => renderUpdateStatus(VERSION, status({ lastCheckAt: NOW - ago }), NOW);
  assert.match(at(0), /as of just now\./);
  assert.match(at(90_000), /as of just now\./);
  assert.match(at(2 * MINUTE), /as of 2 minutes ago\./);
  assert.match(at(59 * MINUTE), /as of 59 minutes ago\./);
  assert.match(at(60 * MINUTE), /as of 1 hour ago\./);
  assert.match(at(5 * 3_600_000), /as of 5 hours ago\./);
  assert.match(at(25 * 3_600_000), /as of 1 day ago\./);
  assert.match(at(9 * 86_400_000), /as of 9 days ago\./);
  // A clock that went backwards must not print a negative age.
  assert.match(renderUpdateStatus(VERSION, status({ lastCheckAt: NOW + 10 * MINUTE }), NOW), /as of just now\./);
});

test('armed but not yet run: not checked yet since boot, not a silent "nothing waiting"', () => {
  assert.match(renderUpdateStatus(VERSION, status({ lastCheckAt: null, lastCheckOk: false }), NOW),
    /as of not checked yet since boot\./);
});

test('no version stamp and no branch: the build line degrades instead of lying', () => {
  const unknown: VersionInfo = { sha: null, shortSha: null, branch: null, builtAt: null, source: 'unknown' };
  assert.match(renderUpdateStatus(unknown, status(), NOW),
    /^- You can't tell which build you are running \(this install carries no version stamp\)\.$/m);
  const noBranch: VersionInfo = { ...VERSION, branch: null };
  assert.match(renderUpdateStatus(noBranch, status(), NOW), /^- You are running build 4f2a91c, right now\. This line is the only current one/m);
});

test('the terminal command is relayed exactly, once, in backticks — and never a chat command', () => {
  const out = renderUpdateStatus(VERSION, status(), NOW);
  assert.equal(out.split('`bash scripts/update.sh`').length - 1, 1, 'exactly one copy of the command');
  assert.match(out, /You cannot update yourself\./);
  assert.match(out, /restarts you, and restarts the engine gateway/);
  assert.match(out, /There is no chat command for it/);
  // The retired copy: the script restarts her, so she must never send them off to restart a server.
  assert.doesNotMatch(out, /then restart the server/);
});

// 2026-09-19: this is the only sentence in the whole prompt that says "you cannot do X to yourself,
// a person does it in a terminal, there is no chat command." It is true of her own build and it is
// also the nearest neighbour to any ask about setting something up on the deep look's side — which
// is what she refused live, calling it a host action. The scope now travels with the rule.
test('the terminal rule says what it covers, so it cannot be read as covering the deep look', () => {
  const out = renderUpdateStatus(VERSION, status(), NOW);
  assert.match(out, /That rule is about your own build and nothing else\./);
  assert.match(out, /Setting something up on your deep look's side so it can do a job .* is a thing you ask for and it does/);
  assert.match(out, /needs no terminal and no permission/);
  assert.match(out, /never out of reach/);
});

test('every line is trimmed prose, so the section arithmetic stays exact', () => {
  const out = renderUpdateStatus(VERSION, status(), NOW);
  assert.equal(out, out.trim());
  assert.equal(out.split('\n').length, 6, 'a heading and five facts');
  for (const l of out.split('\n').slice(1)) assert.ok(l.startsWith('- '), `"${l}" is a fact bullet`);
});

test('the last upgrade: what changed rides the section; an empty changelog adds nothing', () => {
  const receipt = {
    oldSha: '1a2b3c4'.padEnd(40, '0'), newSha: VERSION.sha!, appliedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    changes: ['4f2a91c Make replies shorter', '9ab3c7d Add a voice bank'],
  };
  const out = renderUpdateStatus(VERSION, status(), NOW, receipt);
  assert.match(out, /^- Your person upgraded you to this build from build 1a2b3c4, 2 hours ago, and it changed you: Make replies shorter; Add a voice bank\./m);
  assert.equal(renderUpdateStatus(VERSION, status(), NOW, { ...receipt, changes: [] }), renderUpdateStatus(VERSION, status(), NOW));
});

test('a message about her version gets the current build restated at the edge, and nothing else does', () => {
  const unknown: VersionInfo = { sha: null, shortSha: null, branch: null, builtAt: null, source: 'unknown' };
  assert.match(renderBuildBullet(VERSION, 'btw what is the build number rn'), /^- Your build right now is 4f2a91c on branch main\./);
  assert.match(renderBuildBullet(VERSION, 'what version are u now'), /4f2a91c/);
  assert.equal(renderBuildBullet(VERSION, 'haha'), '');
  assert.equal(renderBuildBullet(VERSION, undefined), '');
  assert.equal(renderBuildBullet(unknown, 'what version are u'), '');
});
