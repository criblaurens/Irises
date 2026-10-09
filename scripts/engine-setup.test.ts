// Run with: npm test   (scripts/**/*.test.ts is in the test glob). NOTHING HERE INSTALLS ANYTHING —
// but two tests do run `--uninstall --yes` for real, so they run it inside a throwaway HOME /
// IRISES_ROOT / IRISES_HOME / HERMES_HOME (see `sandbox()`), never against this machine — and they
// skip themselves on Windows, where one probe escapes that sandbox (see `SKIP_ON_WINDOWS`). Everything
// else is the ARGUMENT and EXIT-CODE contract: the parts an operator or a wrapping script depends on
// and that a rewrite silently changes. The install path, and the lifecycle end to end, is covered by
// scripts/e2e/lifecycle-sandbox.sh (npm run e2e:lifecycle).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'engine-setup.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');

function run(args: string[]): { out: string; err: string; code: number } {
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

/**
 * A throwaway everything for the tests that really execute the uninstaller.
 *
 * IRISES_HOME alone is NOT a sandbox, and that was the bug in these two tests. `service_installed`
 * reads $HOME/.config/systemd/user/irises.service and $HOME/Library/LaunchAgents/
 * ai.irises.server.plist regardless of IRISES_HOME, and `engine_kind` reads the CLONE's .env
 * OPS_BACKEND before it ever looks at the shell — so on a box with Irises actually installed,
 * `npm test` stopped and deleted the service and bounced the engine's gateway.
 *
 * All four roots therefore move into one mkdtemp dir, and the fixture clone's .env pins
 * OPS_BACKEND=off so no engine is detected, nothing is written to any engine, and no gateway is
 * bounced. IRISES_ROOT is what the library's irises_root() honours, and the script's ROOT (its cwd,
 * $ROOT/irises.pid, the clone .env it reads) comes from it.
 */
function sandbox(): { env: Record<string, string>; root: string; state: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'irises-uninstall-'));
  const home = join(tmp, 'home');
  const state = join(tmp, 'state');
  const root = join(tmp, 'root');
  for (const d of [home, state, root]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, '.env'), 'OPS_BACKEND=off\nPORT=3999\n');
  return {
    root,
    state,
    env: {
      HOME: home,
      IRISES_HOME: state,
      IRISES_ROOT: root,
      HERMES_HOME: join(tmp, 'hermes'),
    },
  };
}

/**
 * …and the one box the sandbox above cannot reach. On Windows the install is a Task Scheduler entry,
 * so `service_installed` runs `schtasks //Query //TN Irises` — a query against a machine-wide
 * registry that no HOME, IRISES_HOME, IRISES_ROOT or HERMES_HOME redirects. On a Windows dev box
 * with Irises actually installed, `npm test` would therefore delete the real scheduled task and
 * stop the live server. Every test that EXECUTES the uninstaller carries this gate; the
 * argument-and-exit-code tests (`--help`, an unknown flag, `--revert`, `--port`) never get that far
 * and stay unconditional. node reports `win32` under Git Bash, which is where these would run.
 */
const SKIP_ON_WINDOWS = {
  skip:
    process.platform === 'win32'
      ? 'the uninstall probe reaches Task Scheduler, which the sandbox cannot scope'
      : false,
};

function runUninstall(args: string[], box = sandbox()) {
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...box.env },
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1, box };
}

test('--help documents every flag it accepts, and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, r.err);
  for (const flag of ['--engine', '--uninstall', '--yes', '--no-bridge', '--no-service', '--no-gateway-restart', '--port', '--purge-data']) {
    assert.ok(r.out.includes(flag), `--help must document ${flag}\n${r.out}`);
  }
  assert.ok(!r.out.includes('set -euo pipefail'), 'the help text stops at the header');
  assert.match(r.out, /RESULT:/, 'the machine-readable last line is part of the contract');
});

test('an unknown flag exits 2 and points at --help', () => {
  const r = run(['--frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--frobnicate/);
  assert.match(r.err, /--help/);
});

test('an unknown engine exits 2 without touching anything', () => {
  const r = run(['--engine', 'banana', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /banana/);
});

test('--revert is gone and says so, with exit 2', () => {
  const r = run(['--revert']);
  assert.equal(r.code, 2, 'a silent no-op would let someone believe bridge mode was undone');
  assert.match(r.err, /--uninstall/);
});

test('--port rejects a non-numeric value with exit 2', () => {
  const r = run(['--port', 'http://3000', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /port/i);
});

test('--no-gateway-restart is accepted, and a run inside the hermes gateway implies it', () => {
  // The setup skill has hermes run this from a chat turn; a bounce there would SIGTERM that turn.
  // --help after the flag proves the parser took it (an unknown flag exits 2 before --help).
  assert.equal(run(['--no-gateway-restart', '--help']).code, 0);
  assert.match(SOURCE, /\$\{_HERMES_GATEWAY:-\}" = "1" \][^\n]*\n\s*GATEWAY_RESTART=0/);
  // Every gateway step checks the switch before it bounces: the install's and the shared uninstall/detach one.
  const bounces = SOURCE.match(/if \[ "\$GATEWAY_RESTART" = "0" \]; then\n\s*gateway_ok="skipped"/g) ?? [];
  assert.equal(bounces.length, 2, 'the install bounce and bounce_gateway_step both honour GATEWAY_RESTART');
  assert.equal((SOURCE.match(/gateway_restart "\$engine" 90/g) ?? []).length, 2, 'no third, unguarded bounce');
  // …and the skip tells the operator how to restart, in the words a hermes chat understands.
  assert.match(SOURCE, /type \/restart in any hermes chat/);
});

test('the exit-code table is documented in the header', () => {
  const r = run(['--help']);
  for (const line of ['0 ', '1 ', '2 ', '4 ', '5 ']) assert.ok(r.out.includes(line), `${r.out}`);
  assert.match(r.out, /4[^\n]*health/i);
  assert.match(r.out, /5[^\n]*gateway/i);
});

test('--uninstall on a box with nothing installed says so and still exits 0', SKIP_ON_WINDOWS, () => {
  // No manifest, no service, no plugin: an uninstall that finds nothing to do is a SUCCESS. The
  // opposite (exit 1) would make the documented "run it again if unsure" advice a lie.
  const r = runUninstall(['--uninstall', '--yes']);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /RESULT: ok/);
  assert.match(r.out, /nothing/i);
  // The sandbox is not decoration: every path it reports has to be one we made up for it. If this
  // run ever talks about the real $HOME again, it is signalling the real service and the real engine.
  assert.ok(r.out.includes(r.box.state), `the run must work inside the sandbox:\n${r.out}`);
  assert.ok(r.out.includes(r.box.root), `and report the fixture clone, not this checkout:\n${r.out}`);
  assert.ok(!r.out.includes(process.cwd()), `this checkout is never touched:\n${r.out}`);
});

test('--uninstall never deletes data without --purge-data, and prints the exact rm', SKIP_ON_WINDOWS, () => {
  const r = runUninstall(['--uninstall', '--yes']);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /rm -rf/, 'the command to remove the data is printed, never run');
  assert.ok(
    r.out.includes(`rm -rf ${r.box.state}`),
    `the rm names the sandbox's data dir, so it is the sandbox that was inspected:\n${r.out}`,
  );
  assert.match(r.out, /--purge-data/);
  assert.ok(existsSync(r.box.state), 'and the data dir it printed is still there');
});

test('--uninstall documents that the clone is never deleted', () => {
  const r = run(['--help']);
  assert.match(r.out, /clone/i);
});

test('front_says_kept points at configure.sh instead of a hand edit', () => {
  // The line used to hand the operator a key to paste and a gateway to bounce themselves, which is
  // two steps to get wrong. There is a verb for it now, and it does the bounce.
  // Quoted, and pinned quoted: the scope this prints is routinely a glob (`*:*`), and an
  // unquoted pointer is a line that expands against the operator's cwd the moment they paste it.
  assert.match(
    SOURCE,
    /configure\.sh --front '\$FRONT_PATTERN'/,
    'the kept-scope line names the verb that changes it, with the pattern quoted',
  );
  assert.ok(
    !SOURCE.includes('then bounce the engine’s gateway') && !SOURCE.includes("then bounce the engine's gateway"),
    'the hand-edit instructions are gone: configure.sh owns the restart',
  );
});

test('the voice-model override is the library\'s, not a second copy in this script', () => {
  // A local definition SHADOWS the one sourced from the lib, so install and configure would write
  // different bytes into the same .env and only one of them would be the tested one.
  assert.ok(
    !/^model_override_write\(\)/m.test(SOURCE),
    'scripts/lib/irises-lib.sh owns model_override_write; this script only calls it',
  );
  assert.match(SOURCE, /model_override_write "\$ENV_FILE" "\$MODEL_LANE" "\$MODEL_SLUG" "\$MODEL_BASE_URL"/);
});
