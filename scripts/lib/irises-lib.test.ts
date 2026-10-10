// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// The lib is exercised the way the lifecycle scripts use it: sourced into a bash shell that already
// has `set -euo pipefail` in force, on a SCRATCH PATH built from symlinks to the few real tools the
// lib may use plus stub executables that log their argv and environment. That combination is the
// point — the two bugs this library exists to kill are (a) a function that returns non-zero as its
// last command and aborts its caller under `set -e`, and (b) a tool the lib assumed was on PATH.
//
// The scratch PATH deliberately does NOT include /usr/bin, so `service_kind` can be observed with
// systemctl/launchctl genuinely absent. Tests that need them ask for them by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'scripts', 'lib', 'irises-lib.sh');

/** Tools the lib is allowed to reach for. Anything missing on the host is skipped silently. */
const DEFAULT_TOOLS = [
  'cat', 'rm', 'mkdir', 'cp', 'mv', 'chmod', 'find', 'grep', 'sed', 'head', 'tail', 'cut', 'tr',
  'sleep', 'date', 'printf', 'ps', 'uname', 'id', 'dirname', 'basename', 'du', 'curl', 'node',
  'npm', 'git', 'awk', 'sort', 'stat', 'env', 'sh', 'pgrep', 'mktemp', 'kill', 'touch', 'ln', 'od',
  // bash: the stubs below are `#!/usr/bin/env bash` scripts, so the interpreter has to be reachable
  // on the scratch PATH or every stub invocation dies with "env: bash: No such file or directory".
  'bash',
];

function realPath(tool: string): string | null {
  const r = spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8', env: process.env });
  const p = (r.stdout ?? '').trim();
  return r.status === 0 && p.length > 0 ? p : null;
}

export interface LibRun { out: string; err: string; code: number; log: string[]; dir: string }
export interface RunOpts {
  /** Extra tool names to symlink onto the scratch PATH (e.g. 'systemctl', 'launchctl'). */
  tools?: string[];
  /** name -> bash body. Written executable onto the scratch PATH, shadowing any real tool. */
  stubs?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
}

/** Source the lib under `set -euo pipefail` and run `body`. */
export function runLib(body: string, opts: RunOpts = {}): LibRun {
  const dir = mkdtempSync(join(tmpdir(), 'irises-lib-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const log = join(dir, 'stub.log');
  for (const tool of [...DEFAULT_TOOLS, ...(opts.tools ?? [])]) {
    const real = realPath(tool);
    if (real && !existsSync(join(bin, tool))) symlinkSync(real, join(bin, tool));
  }
  for (const [name, script] of Object.entries(opts.stubs ?? {})) {
    // Unlink first. A stub for a tool that is also in DEFAULT_TOOLS (node, npm, uname…) already has
    // a SYMLINK at this path pointing at the real binary, and writeFileSync follows it — writing the
    // stub straight into the host's node/npm install. Removing the link makes the stub a plain file
    // that shadows the real tool, which is all the scratch PATH ever wanted.
    rmSync(join(bin, name), { force: true });
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
  }
  const script = join(dir, 'body.sh');
  writeFileSync(script, ['set -euo pipefail', `source ${JSON.stringify(LIB)}`, body, ''].join('\n'));
  const res = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    cwd: opts.cwd ?? dir,
    env: {
      PATH: bin,
      HOME: home,
      NO_COLOR: '1',
      STUB_LOG: log,
      IRISES_HOME: join(dir, 'state'),
      ...(opts.env ?? {}),
    },
  });
  return {
    out: res.stdout ?? '',
    err: res.stderr ?? '',
    code: res.status ?? -1,
    log: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    dir,
  };
}

/**
 * A health endpoint in its OWN process, answering every path with the Irises /health shape.
 *
 * It cannot live in this process: runLib is spawnSync, which stops this event loop dead, so an
 * in-process http server never accepts the lib's curl — it just times out after -m 5. The child
 * re-reads `shaFile` on every request, which is how a test flips which build is "live".
 */
export function startHealthServer(shaFile: string): { base: string; stop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'irises-health-'));
  const portFile = join(dir, 'port');
  const src = join(dir, 'health-server.mjs');
  writeFileSync(src, [
    "import http from 'node:http';",
    "import { readFileSync, renameSync, writeFileSync } from 'node:fs';",
    'const [shaPath, portPath] = process.argv.slice(2);',
    'const srv = http.createServer((_q, s) => {',
    "  let sha = '';",
    "  try { sha = readFileSync(shaPath, 'utf8').trim(); } catch { sha = ''; }",
    "  s.setHeader('content-type', 'application/json');",
    "  s.end(JSON.stringify({",
    "    status: 'ok',",
    '    version: { sha, shortSha: sha.slice(0, 7) },',
    "    update: { remoteSha: 'c'.repeat(40) },",
    '  }));',
    '});',
    // Written to a sibling and renamed into place: the poll below only checks that the file
    // EXISTS, so a plain write can be observed empty and the harness then reads '' as the port.
    "srv.listen(0, '127.0.0.1', () => {",
    "  writeFileSync(portPath + '.tmp', String(srv.address().port));",
    "  renameSync(portPath + '.tmp', portPath);",
    '});',
    '',
  ].join('\n'));
  const child = spawn(process.execPath, [src, shaFile, portFile], { stdio: 'ignore' });
  let port = '';
  for (let i = 0; i < 200 && port === ''; i += 1) {
    if (existsSync(portFile)) port = readFileSync(portFile, 'utf8').trim();
    if (port === '') spawnSync('/bin/sleep', ['0.05']);
  }
  if (port === '') {
    child.kill('SIGKILL');
    throw new Error('the health server child never reported a port');
  }
  return { base: `http://127.0.0.1:${port}`, stop: () => { child.kill('SIGKILL'); } };
}

/** A scratch clone root with a .env (and optionally deploy/app.env) for the path/engine resolvers. */
export function fixtureRoot(env: string, appEnv?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'irises-root-'));
  writeFileSync(join(root, '.env'), env);
  if (appEnv !== undefined) {
    mkdirSync(join(root, 'deploy'), { recursive: true });
    writeFileSync(join(root, 'deploy', 'app.env'), appEnv);
  }
  return root;
}

test('the lib is valid bash and safe to source twice', () => {
  execFileSync('/bin/bash', ['-n', LIB], { encoding: 'utf8' });
  const r = runLib([
    `source ${JSON.stringify(LIB)}`,
    `source ${JSON.stringify(LIB)}`,
    'say "sourced three times, still fine"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sourced three times, still fine/);
});

test('sourcing the lib runs nothing and prints nothing', () => {
  const r = runLib('true');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
});

test('say goes to stdout; log, warn and err go to stderr; die carries its exit code', () => {
  const r = runLib('say hello; log quietly; warn careful; err broken; die 7 "gone"');
  assert.equal(r.code, 7);
  assert.match(r.out, /\[irises\] hello/);
  assert.match(r.err, /\[irises\] quietly/);
  assert.match(r.err, /\[irises\] careful/);
  assert.match(r.err, /\[irises\] broken/);
  assert.match(r.err, /\[irises\] gone/);
  assert.ok(!r.out.includes('careful'), 'warn must not pollute stdout — RESULT lines are parsed there');
  assert.ok(!r.out.includes('quietly'), 'log is for value-returning functions whose stdout is captured');
});

test('env_get matches dotenv: last assignment wins, export prefix, quotes, inline comments', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, [
    '# a comment',
    'API_SERVER_KEY=first',
    '  export  API_SERVER_KEY = second  ',
    'QUOTED="a b # not a comment"',
    "SINGLE='c d'",
    'OPS_BACKEND=hermes             # hermes | openclaw — AUTO-DETECTED; set to force one',
    'EMPTY=',
    'NODE_OPTIONS=--max-old-space-size=512   # heap cap',
  ].join('\n'));
  const r = runLib([
    `printf 'KEY=[%s]\\n' "$(env_get ${JSON.stringify(f)} API_SERVER_KEY)"`,
    `printf 'QUOTED=[%s]\\n' "$(env_get ${JSON.stringify(f)} QUOTED)"`,
    `printf 'SINGLE=[%s]\\n' "$(env_get ${JSON.stringify(f)} SINGLE)"`,
    `printf 'BACKEND=[%s]\\n' "$(env_get ${JSON.stringify(f)} OPS_BACKEND)"`,
    `printf 'EMPTY=[%s]\\n' "$(env_get ${JSON.stringify(f)} EMPTY)"`,
    `printf 'OPTS=[%s]\\n' "$(env_get ${JSON.stringify(f)} NODE_OPTIONS)"`,
    `printf 'ABSENT=[%s]\\n' "$(env_get ${JSON.stringify(f)} NOPE)"`,
    `printf 'NOFILE=[%s]\\n' "$(env_get /nonexistent/file KEY)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /KEY=\[second\]/, 'dotenv is last-wins; the production hermes .env has two API_SERVER_KEY blocks');
  assert.match(r.out, /QUOTED=\[a b # not a comment\]/);
  assert.match(r.out, /SINGLE=\[c d\]/);
  assert.match(r.out, /BACKEND=\[hermes\]/, 'the inline comment must not become part of the engine kind');
  assert.match(r.out, /EMPTY=\[\]/);
  assert.match(r.out, /OPTS=\[--max-old-space-size=512\]/);
  assert.match(r.out, /ABSENT=\[\]/);
  assert.match(r.out, /NOFILE=\[\]/);
});

test('env_set rewrites in place, collapses duplicates, and appends when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-env-'));
  const f = join(dir, '.env');
  writeFileSync(f, 'A=1\nAPI_SERVER_KEY=old1\nB=2\nAPI_SERVER_KEY=old2\n# trailing comment');
  const r = runLib([
    `env_set ${JSON.stringify(f)} API_SERVER_KEY live`,
    `env_set ${JSON.stringify(f)} NEW_KEY newval`,
    `printf 'COUNT=%s\\n' "$(env_count ${JSON.stringify(f)} API_SERVER_KEY)"`,
    `printf 'VALUE=%s\\n' "$(env_get ${JSON.stringify(f)} API_SERVER_KEY)"`,
    `printf 'NEW=%s\\n' "$(env_get ${JSON.stringify(f)} NEW_KEY)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /COUNT=1/, 'the duplicate block is collapsed to one line');
  assert.match(r.out, /VALUE=live/);
  assert.match(r.out, /NEW=newval/);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^A=1$/m, 'unrelated keys survive');
  assert.match(body, /^B=2$/m);
  assert.match(body, /^# trailing comment$/m, 'a file with no trailing newline keeps its last line');
  assert.equal(body.slice(-1), '\n', 'the rewrite always leaves a trailing newline');
});

test('env_set_default never overwrites a value the user already set', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, 'PORT=3999\nBLANK=\n');
  const r = runLib([
    `env_set_default ${JSON.stringify(f)} PORT 3000`,
    `env_set_default ${JSON.stringify(f)} BLANK filled`,
    `env_set_default ${JSON.stringify(f)} FRESH yes`,
    `printf 'PORT=%s BLANK=%s FRESH=%s\\n' "$(env_get ${JSON.stringify(f)} PORT)" "$(env_get ${JSON.stringify(f)} BLANK)" "$(env_get ${JSON.stringify(f)} FRESH)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PORT=3999 BLANK=filled FRESH=yes/);
});

test('env_append_block writes one dated marker above its keys, on a file with no trailing newline', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, 'MODEL=gpt');   // no trailing newline: the bug that glued two keys into one line
  const r = runLib(`env_append_block ${JSON.stringify(f)} "bridge mode" IRISES_URL=http://127.0.0.1:3000 IRISES_FRONT='*:*'`);
  assert.equal(r.code, 0, r.err);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^MODEL=gpt$/m, 'the pre-existing last line is not glued to our first key');
  assert.match(body, /^# — added by Irises setup \(\d{4}-\d{2}-\d{2}\) — bridge mode —$/m);
  assert.match(body, /^IRISES_URL=http:\/\/127\.0\.0\.1:3000$/m);
  assert.match(body, /^IRISES_FRONT=\*:\*$/m);
});

test('env_remove_irises_block drops our keys plus the orphaned marker, and counts them', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, [
    'ANTHROPIC_API_KEY=keepme',
    '',
    '# — added by Irises setup (2026-09-01) — reminder push-back —',
    'IRISES_PUSH_TOKEN=abc',
    '',
    '# — added by Irises setup (2026-09-01) — bridge mode —',
    'IRISES_BRIDGE_TOKEN=def',
    'KEEP_THIS=1',
    '',
  ].join('\n'));
  const r = runLib([
    `printf 'REMOVED=%s\\n' "$(env_remove_irises_block ${JSON.stringify(f)} IRISES_PUSH_TOKEN IRISES_BRIDGE_TOKEN)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REMOVED=2/);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^ANTHROPIC_API_KEY=keepme$/m);
  assert.match(body, /^KEEP_THIS=1$/m);
  assert.ok(!body.includes('IRISES_PUSH_TOKEN'), body);
  assert.ok(!body.includes('IRISES_BRIDGE_TOKEN'), body);
  assert.ok(!body.includes('reminder push-back'), 'a marker whose keys all went must go too');
  assert.ok(!body.includes('bridge mode'), body);
});

test('env_remove_irises_block takes the empty line env_append_block added with the block', () => {
  // The exact shape env_append_block leaves behind: one empty line, the marker, the keys. An
  // uninstall that removed the marker and the keys but kept the empty line grew the engine's .env
  // by one blank line per install/uninstall cycle, and the file never came back byte-identical.
  const dir = mkdtempSync(join(tmpdir(), 'irises-env-'));
  const f = join(dir, '.env');
  writeFileSync(f, 'A=1\n\n# — added by Irises setup (2026-09-01) — x —\nK=v\n');
  const r = runLib(`printf 'REMOVED=%s\\n' "$(env_remove_irises_block ${JSON.stringify(f)} K)"`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REMOVED=1/);
  assert.equal(readFileSync(f, 'utf8'), 'A=1\n', 'the file is back to exactly what it was');

  // …and a blank line that is NOT ours — no marker under it — is the operator's own spacing.
  const g = join(dir, 'spaced.env');
  writeFileSync(g, 'A=1\n\nK=v\nB=2\n');
  const r2 = runLib(`printf 'REMOVED=%s\\n' "$(env_remove_irises_block ${JSON.stringify(g)} K)"`);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(readFileSync(g, 'utf8'), 'A=1\n\nB=2\n', 'a blank line of the operator\'s stays put');
});

test('env_unset removes every assignment of each key and nothing else', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, ['A=1', '', 'B=2', 'export B=3', '# a comment', 'C=4', '', ''].join('\n'));
  const r = runLib(`printf 'REMOVED=%s\\n' "$(env_unset ${JSON.stringify(f)} B C)"`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REMOVED=3/, 'the duplicate `export B=3` counts as its own assignment');
  assert.equal(
    readFileSync(f, 'utf8'),
    'A=1\n\n# a comment\n\n',
    'only the named assignments go — the comment, the operator\'s blank line and the trailing blank stay',
  );
});

test('env_unset on a missing file prints 0 and succeeds', () => {
  // Sourced under `set -euo pipefail`: a non-zero return here would abort the whole caller, which
  // is the class of bug this harness exists to catch.
  const r = runLib([
    'rc=0',
    'out="$(env_unset /nonexistent/.env B)" || rc=$?',
    'printf \'REMOVED=%s RC=%s\\n\' "$out" "$rc"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REMOVED=0 RC=0/);
});

test('is_secret_key names keys, tokens, passwords, secrets and API_SERVER_KEY, and nothing else', () => {
  const probes = [
    'OPENROUTER_API_KEY', 'ENGINE_PUSH_TOKEN', 'DASHBOARD_PASSWORD', 'X_SECRET', 'API_SERVER_KEY',
    'PORT', 'WEB_ENABLED', 'KEYBOARD', 'TOKENIZER', 'IRISES_FRONT',
  ];
  const r = runLib(probes
    .map((k) => `if is_secret_key ${k}; then printf '${k}=secret\\n'; else printf '${k}=plain\\n'; fi`)
    .join('\n'));
  assert.equal(r.code, 0, r.err);
  for (const k of probes.slice(0, 5)) assert.match(r.out, new RegExp(`^${k}=secret$`, 'm'), k);
  for (const k of probes.slice(5)) assert.match(r.out, new RegExp(`^${k}=plain$`, 'm'), k);
});

test('env_backup copies to a 0600 sibling and prints ONLY its path on stdout', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, 'SECRET=shhh\n', { mode: 0o644 });
  const r = runLib(`env_backup ${JSON.stringify(f)} pre-uninstall`);
  assert.equal(r.code, 0, r.err);
  const backup = r.out.trim();
  assert.match(backup, /\.env\.bak-irises-\d{8}-\d{6}$/, 'callers capture this — a log line here would corrupt the path');
  assert.equal(readFileSync(backup, 'utf8'), 'SECRET=shhh\n');
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.match(r.err, /backed up/);
});

test('irises_home resolves .env over the shell over app.env over ~/.irises', () => {
  const withEnv = fixtureRoot('IRISES_HOME=~/from-dotenv\n', 'IRISES_HOME=/from-appenv\n');
  const appOnly = fixtureRoot('# nothing here\n', 'IRISES_HOME=/from-appenv\n');
  const bare = fixtureRoot('# nothing here\n');
  const call = (root: string, shell?: string) => runLib('irises_home', {
    env: { IRISES_ROOT: root, ...(shell ? { IRISES_HOME: shell } : { IRISES_HOME: '' }) },
  });
  const a = call(withEnv, '/from-shell');
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /\/home\/from-dotenv$/, 'a leading ~ expands against HOME');
  const b = call(appOnly, '/from-shell');
  assert.equal(b.out, '/from-shell');
  const c = call(appOnly);
  assert.equal(c.out, '/from-appenv', 'deploy/app.env is a legitimate operator config tier');
  const d = call(bare);
  assert.match(d.out, /\/home\/\.irises$/);
});

test('portable_timeout kills a hung command and reports 124', () => {
  const started = Date.now();
  const r = runLib([
    'rc=0',
    'portable_timeout 2 sleep 30 || rc=$?',
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'), { env: { IRISES_FORCE_TIMEOUT_FALLBACK: '1' } });
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=124/);
  assert.ok(elapsed < 15000, `the bash fallback must not wait for the command (took ${elapsed}ms)`);
});

test('portable_timeout passes a fast command through with its own exit code', () => {
  const r = runLib([
    'rc=0; portable_timeout 10 sh -c "exit 3" || rc=$?; printf "RC=%s\\n" "$rc"',
    'rc2=0; portable_timeout 10 sh -c "exit 0" || rc2=$?; printf "RC2=%s\\n" "$rc2"',
  ].join('\n'), { env: { IRISES_FORCE_TIMEOUT_FALLBACK: '1' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=3/);
  assert.match(r.out, /RC2=0/);
});

test('portable_timeout can time-box a shell FUNCTION (timeout(1) cannot exec one)', () => {
  const r = runLib([
    'slow() { sleep 30; }',
    'rc=0; portable_timeout 2 slow || rc=$?; printf "RC=%s\\n" "$rc"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=124/);
});

test('require_tools names every missing tool and returns 1', () => {
  const r = runLib([
    'rc=0; require_tools cat definitely-not-here also-missing || rc=$?',
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.match(r.err, /definitely-not-here/);
  assert.match(r.err, /also-missing/);
});

test('require_node_version accepts the node running these tests', () => {
  const r = runLib('require_node_version 22.13; printf "OK\\n"');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /OK/);
});

test('require_node_version fails loudly when the only node is too old', () => {
  // IRISES_NODE_CANDIDATES pins the fallback search to a path that does not exist; otherwise a
  // Homebrew or nvm node on the developer's own machine would satisfy the floor and pass this test.
  const r = runLib([
    'rc=0; require_node_version 22.13 || rc=$?; printf "RC=%s\\n" "$rc"',
  ].join('\n'), {
    stubs: { node: 'if [ "${1:-}" = "-p" ]; then echo "18.20.0"; else echo "v18.20.0"; fi' },
    env: { IRISES_NODE_CANDIDATES: '/nonexistent/bin/node' },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.match(r.err, /22\.13/);
});

test('augment_path appends the common bin dirs it needs and never drops the caller PATH', () => {
  const r = runLib('augment_path; printf "PATH=%s\\n" "$PATH"');
  assert.equal(r.code, 0, r.err);
  const line = r.out.split('\n').find(l => l.startsWith('PATH='))!;
  assert.ok(line.includes('/bin:') || line.endsWith('/bin'), line);
  assert.ok(line.includes('/usr/bin'), 'a non-login shell PATH must still reach the base tools');
  assert.match(line, /^PATH=[^:]*\/bin:/, 'the caller PATH stays first — an explicit node choice wins');
});

test('augment_path picks the newest nvm node >= 22 and ignores older trees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-nvm-'));
  for (const v of ['v18.20.0', 'v22.9.0', 'v22.17.0', 'v24.1.0', 'garbage']) {
    mkdirSync(join(dir, 'versions', 'node', v, 'bin'), { recursive: true });
  }
  const r = runLib('augment_path; printf "PATH=%s\\n" "$PATH"', { env: { NVM_DIR: dir } });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(join(dir, 'versions', 'node', 'v24.1.0', 'bin')), r.out);
  assert.ok(!r.out.includes('v18.20.0'), 'below the floor');
  assert.ok(!r.out.includes('v22.9.0'), 'only the newest is added');
});

test('mem_available_mb is a number on Linux and empty elsewhere', () => {
  const r = runLib('printf "MB=[%s]\\n" "$(mem_available_mb)"');
  assert.equal(r.code, 0, r.err);
  const m = /MB=\[(.*)\]/.exec(r.out);
  assert.ok(m, r.out);
  if (process.platform === 'linux') assert.match(m![1], /^\d+$/);
  else assert.equal(m![1], '');
});

test('tcp_open sees a listening socket and rejects a closed port', async () => {
  const http = await import('node:http');
  const srv = http.createServer((_q, s) => s.end('ok'));
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as { port: number }).port;
  try {
    const open = runLib(`rc=0; tcp_open 127.0.0.1 ${port} || rc=$?; printf "OPEN=%s\\n" "$rc"`);
    assert.equal(open.code, 0, open.err);
    assert.match(open.out, /OPEN=0/);
  } finally {
    srv.close();
  }
  const closed = runLib('rc=0; tcp_open 127.0.0.1 1 || rc=$?; printf "CLOSED=%s\\n" "$rc"');
  assert.equal(closed.code, 0, closed.err);
  assert.match(closed.out, /CLOSED=1/);
});

// ── section E: engine, gateway, plugins, web ────────────────────────────────────────────────────

/** A stub that records `argv` plus the environment bits we assert on, then exits with $STUB_RC. */
const RECORDING_STUB = [
  '{',
  '  printf "%s argv:%s\\n" "$(basename "$0")" "$*"',
  '  printf "%s env:HERMES_RESTART_AFTER_TURN_TIMEOUT=%s\\n" "$(basename "$0")" "${HERMES_RESTART_AFTER_TURN_TIMEOUT:-unset}"',
  '  printf "%s env:HERMES_RESTART_DRAIN_TIMEOUT=%s\\n" "$(basename "$0")" "${HERMES_RESTART_DRAIN_TIMEOUT:-unset}"',
  '  printf "%s env:_HERMES_GATEWAY=%s\\n" "$(basename "$0")" "${_HERMES_GATEWAY:-unset}"',
  '} >> "$STUB_LOG"',
  'exit "${STUB_RC:-0}"',
].join('\n');

test('engine_kind reads OPS_BACKEND past its inline comment, and honours an override', () => {
  const root = fixtureRoot('OPS_BACKEND=hermes             # hermes | openclaw — AUTO-DETECTED\n');
  const a = runLib('engine_kind', { env: { IRISES_ROOT: root } });
  assert.equal(a.code, 0, a.err);
  assert.equal(a.out, 'hermes');
  const b = runLib('engine_kind openclaw', { env: { IRISES_ROOT: root } });
  assert.equal(b.out, 'openclaw');
  const off = fixtureRoot('OPS_BACKEND=off\n');
  assert.equal(runLib('engine_kind', { env: { IRISES_ROOT: off } }).out, 'off');
  const junk = fixtureRoot('OPS_BACKEND=banana\n');
  const j = runLib('engine_kind', { env: { IRISES_ROOT: junk } });
  assert.equal(j.out, 'off');
  assert.match(j.err, /banana/);
});

test('engine_kind falls back to what is installed when OPS_BACKEND is unset', () => {
  const root = fixtureRoot('# no backend pinned\n');
  const withHermes = runLib('engine_kind', { env: { IRISES_ROOT: root, HERMES_HOME: root } });
  assert.equal(withHermes.out, 'hermes', 'the hermes home existing is the proof of installation');
  const withClaw = runLib('engine_kind', {
    env: { IRISES_ROOT: root, HERMES_HOME: join(root, 'nope') },
    stubs: { openclaw: 'exit 0' },
  });
  assert.equal(withClaw.out, 'openclaw');
  const neither = runLib('engine_kind', { env: { IRISES_ROOT: root, HERMES_HOME: join(root, 'nope') } });
  assert.equal(neither.out, 'off');
});

test('hermes_run finds ~/.local/bin/hermes when PATH is minimal, and strips _HERMES_GATEWAY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-hcli-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'hermes'), `#!/usr/bin/env bash\n${RECORDING_STUB}\n`, { mode: 0o755 });
  const r = runLib([
    'printf "CLI=%s\\n" "$(hermes_cli)"',
    'hermes_run plugins enable irises-bridge',
  ].join('\n'), { env: { HOME: home, _HERMES_GATEWAY: '1' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CLI=.*\.local\/bin\/hermes/, 'the real location on a Mac, which the old resolver missed');
  assert.ok(r.log.includes('hermes argv:plugins enable irises-bridge'), r.log.join('\n'));
  assert.ok(
    r.log.includes('hermes env:_HERMES_GATEWAY=unset'),
    'inherited _HERMES_GATEWAY=1 makes the CLI refuse gateway work with exit 1',
  );
});

test('hermes_run falls back to the venv python module form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-hcli-'));
  const hhome = join(dir, 'hermes');
  mkdirSync(join(hhome, 'hermes-agent', 'venv', 'bin'), { recursive: true });
  writeFileSync(join(hhome, 'hermes-agent', 'venv', 'bin', 'python'), `#!/usr/bin/env bash\n${RECORDING_STUB}\n`, { mode: 0o755 });
  const r = runLib([
    'printf "CLI=%s\\n" "$(hermes_cli)"',
    'hermes_run gateway status',
  ].join('\n'), { env: { HERMES_HOME: hhome } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CLI=.*venv\/bin\/python -m hermes_cli\.main/);
  assert.ok(r.log.includes('python argv:-m hermes_cli.main gateway status'), r.log.join('\n'));
});

test('hermes_cli is empty and hermes_run returns 127 when no CLI exists', () => {
  const r = runLib([
    'printf "CLI=[%s]\\n" "$(hermes_cli)"',
    'rc=0; hermes_run gateway status || rc=$?; printf "RC=%s\\n" "$rc"',
  ].join('\n'), { env: { HERMES_HOME: '/nonexistent' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CLI=\[\]/);
  assert.match(r.out, /RC=127/);
});

test('gateway_restart bounces hermes through its CLI with both drain caps capped', () => {
  // The engine's /v1/health must answer from ANOTHER process (see startHealthServer). Otherwise the
  // probe falls through to the service/process branch — and on any machine that actually runs hermes
  // that branch says "up" no matter what this fixture does, so the http path is never exercised.
  const shaFile = join(mkdtempSync(join(tmpdir(), 'irises-gw-')), 'live-sha');
  writeFileSync(shaFile, 'a'.repeat(40));
  const { base, stop } = startHealthServer(shaFile);
  const root = fixtureRoot(`OPS_BACKEND=hermes\nHERMES_BASE_URL=${base}\n`);
  try {
    const r = runLib('gateway_restart hermes 20', {
      env: { IRISES_ROOT: root, _HERMES_GATEWAY: '1' },
      stubs: { hermes: RECORDING_STUB },
    });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const argv = r.log.find(l => l.startsWith('hermes argv:'));
    assert.ok(argv, r.log.join('\n'));
    assert.match(argv!, /^hermes argv:gateway re?start$/, 'the verb is assembled at runtime, and still arrives whole');
    assert.ok(r.log.includes('hermes env:HERMES_RESTART_AFTER_TURN_TIMEOUT=45'), r.log.join('\n'));
    assert.ok(r.log.includes('hermes env:HERMES_RESTART_DRAIN_TIMEOUT=10'), r.log.join('\n'));
    assert.ok(r.log.includes('hermes env:_HERMES_GATEWAY=unset'), r.log.join('\n'));
    assert.match(r.out, /gateway is back/);
  } finally {
    stop();
  }
});

test('gateway_restart reports failure (1) when the gateway never answers again', () => {
  const root = fixtureRoot('OPS_BACKEND=hermes\nHERMES_BASE_URL=http://127.0.0.1:1\n');
  const r = runLib('rc=0; gateway_restart hermes 4 || rc=$?; printf "RC=%s\\n" "$rc"', {
    env: { IRISES_ROOT: root },
    // pgrep too, and not for neatness: the service probe's last resort is "is a gateway PROCESS
    // alive?", which on a developer's own machine (one running hermes) is true no matter what this
    // fixture does. Stubbing it is what makes "the gateway never answers again" the actual scenario.
    stubs: { hermes: RECORDING_STUB, systemctl: 'exit 1', launchctl: 'exit 1', pgrep: 'exit 1' },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.match(r.err, /did not come back/);
});

test('gateway_restart on an engine that is off does nothing and succeeds', () => {
  const root = fixtureRoot('OPS_BACKEND=off\n');
  const r = runLib('gateway_restart', { env: { IRISES_ROOT: root } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /engine is off/);
});

test('gateway_restart bounces openclaw through its own CLI and waits on the gateway port', async () => {
  const net = await import('node:net');
  const srv = net.createServer(sock => sock.end());
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as { port: number }).port;
  const root = fixtureRoot(`OPS_BACKEND=openclaw\nOPENCLAW_URL=ws://127.0.0.1:${port}\n`);
  try {
    const r = runLib('gateway_restart openclaw 20', {
      env: { IRISES_ROOT: root },
      stubs: { openclaw: RECORDING_STUB },
    });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const argv = r.log.find(l => l.startsWith('openclaw argv:'));
    assert.match(argv!, /^openclaw argv:gateway re?start$/);
    assert.match(r.out, /gateway is back/);
  } finally {
    srv.close();
  }
});

test('plugin_refresh copies the hermes plugin without __pycache__ and enables it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const root = join(dir, 'clone');
  mkdirSync(join(root, 'bridge', 'hermes', 'irises-bridge', '__pycache__'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', '__init__.py'), 'x = 1\n');
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', 'plugin.yaml'), 'name: irises-bridge\n');
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', '__pycache__', 'stale.pyc'), 'junk');
  const hhome = join(dir, 'hermes');
  mkdirSync(join(hhome, 'plugins', 'irises-bridge'), { recursive: true });
  writeFileSync(join(hhome, 'plugins', 'irises-bridge', 'REMOVED_UPSTREAM.py'), 'old\n');
  const r = runLib(`plugin_refresh hermes ${JSON.stringify(root)}`, {
    env: { HERMES_HOME: hhome },
    stubs: { hermes: RECORDING_STUB },
  });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(hhome, 'plugins', 'irises-bridge', '__init__.py')));
  assert.ok(!existsSync(join(hhome, 'plugins', 'irises-bridge', '__pycache__')), 'stale bytecode must not ship');
  assert.ok(
    !existsSync(join(hhome, 'plugins', 'irises-bridge', 'REMOVED_UPSTREAM.py')),
    'rm before cp: cp -R onto an existing dir merges and leaves deleted files behind',
  );
  assert.ok(r.log.includes('hermes argv:plugins enable irises-bridge'), r.log.join('\n'));
});

test('plugin_refresh deletes the openclaw target first, because install refuses an existing dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const root = join(dir, 'clone');
  mkdirSync(join(root, 'bridge', 'openclaw', 'irises-bridge'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'openclaw', 'irises-bridge', 'package.json'), '{"name":"irises-bridge"}');
  const state = join(dir, 'openclaw');
  mkdirSync(join(state, 'extensions', 'irises-bridge'), { recursive: true });
  writeFileSync(join(state, 'extensions', 'irises-bridge', 'old.js'), 'stale\n');
  const r = runLib(`plugin_refresh openclaw ${JSON.stringify(root)}`, {
    env: { OPENCLAW_STATE_DIR: state },
    stubs: { openclaw: RECORDING_STUB },
  });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(state, 'extensions', 'irises-bridge')), 'the CLI copies it back in; we only clear the way');
  const argv = r.log.find(l => l.startsWith('openclaw argv:plugins install'));
  assert.ok(argv, r.log.join('\n'));
  assert.match(argv!, /bridge\/openclaw\/irises-bridge$/);
});

test('plugin_remove disables then deletes, on both engines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const hhome = join(dir, 'hermes');
  const state = join(dir, 'openclaw');
  mkdirSync(join(hhome, 'plugins', 'irises-bridge'), { recursive: true });
  mkdirSync(join(state, 'extensions', 'irises-bridge'), { recursive: true });
  const h = runLib('plugin_remove hermes', { env: { HERMES_HOME: hhome }, stubs: { hermes: RECORDING_STUB } });
  assert.equal(h.code, 0, h.err);
  assert.ok(h.log.includes('hermes argv:plugins disable irises-bridge'), h.log.join('\n'));
  assert.ok(!existsSync(join(hhome, 'plugins', 'irises-bridge')));
  const o = runLib('plugin_remove openclaw', { env: { OPENCLAW_STATE_DIR: state }, stubs: { openclaw: RECORDING_STUB } });
  assert.equal(o.code, 0, o.err);
  assert.ok(o.log.includes('openclaw argv:plugins disable irises-bridge'), o.log.join('\n'));
  assert.ok(!existsSync(join(state, 'extensions', 'irises-bridge')), 'openclaw has no `plugins uninstall` — rm is the removal');
});

// ── the engine CLI can neither wait on stdin nor hang ───────────────────────────────────────────
//
// Both of these are the same production failure: a plugin refresh where the hermes CLI decided to
// ask something (capability consent for a plugin it does not consider bundled) with the terminal as
// its stdin and no time limit. The prompt is invisible — the caller sent the CLI's output to
// /dev/null — so the update simply stops, holding the lifecycle lock, for as long as anyone leaves
// it there.

test('hermes_run hands the CLI /dev/null, so a prompt cannot eat the caller\'s stdin', () => {
  // A CLI that prompts does `read` on its stdin. On a terminal that BLOCKS, which is untestable
  // here (a spawned child's stdin is already at EOF) — so the caller's stdin is given a line
  // instead: a CLI that can reach it consumes that line, and one handed /dev/null cannot.
  const promptingStub = [
    'if read -r line; then',
    '  printf "hermes stdin:%s\\n" "$line" >> "$STUB_LOG"',
    'else',
    '  printf "hermes stdin:closed\\n" >> "$STUB_LOG"',
    'fi',
    'printf "hermes argv:%s\\n" "$*" >> "$STUB_LOG"',
    'exit 0',
  ].join('\n');
  const r = runLib(
    'printf "operator-typing\\n" | hermes_run plugins enable irises-bridge',
    { stubs: { hermes: promptingStub } },
  );
  assert.equal(r.code, 0, r.err);
  assert.ok(r.log.includes('hermes argv:plugins enable irises-bridge'), r.log.join('\n'));
  assert.ok(
    r.log.includes('hermes stdin:closed'),
    `the CLI must see EOF, not the terminal (or this pipe):\n${r.log.join('\n')}`,
  );
  assert.ok(
    !r.log.some(l => l.includes('operator-typing')),
    'a CLI that can read the caller\'s stdin can also block on it',
  );
});

test('plugin_refresh and plugin_remove time-box the CLI instead of hanging on it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const root = join(dir, 'clone');
  mkdirSync(join(root, 'bridge', 'hermes', 'irises-bridge'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', 'plugin.yaml'), 'name: irises-bridge\n');
  const hhome = join(dir, 'hermes');
  mkdirSync(join(hhome, 'plugins', 'irises-bridge'), { recursive: true });
  // 60s in production; 2s here, through the same hook the budget is read from. hermes_run is a
  // FUNCTION, so portable_timeout takes its bash watchdog path either way.
  const env = { HERMES_HOME: hhome, IRISES_PLUGIN_CLI_TIMEOUT: '2' };
  const hung = { hermes: 'sleep 30' };

  const started = Date.now();
  const refresh = runLib([
    `rc=0; plugin_refresh hermes ${JSON.stringify(root)} || rc=$?`,
    'printf "RC=%s\\n" "$rc"',
    'printf "SURVIVED\\n"',
  ].join('\n'), { env, stubs: hung });
  const elapsed = Date.now() - started;
  assert.equal(refresh.code, 0, `${refresh.out}\n${refresh.err}`);
  assert.ok(elapsed < 20000, `the refresh waited on the CLI for ${elapsed}ms`);
  assert.match(refresh.out, /RC=0/, 'the plugin was copied — only the enable could not be confirmed');
  assert.match(refresh.out, /SURVIVED/);
  assert.match(refresh.err, /did not answer within 2s/);
  assert.match(refresh.err, /hermes plugins enable irises-bridge/, 'the warn hands over the manual command');
  assert.ok(existsSync(join(hhome, 'plugins', 'irises-bridge', 'plugin.yaml')), 'the copy still happened');

  const remove = runLib([
    'rc=0; plugin_remove hermes || rc=$?',
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'), { env, stubs: hung });
  assert.equal(remove.code, 0, `${remove.out}\n${remove.err}`);
  assert.match(remove.out, /RC=0/);
  assert.match(remove.err, /did not answer within 2s/);
  assert.ok(
    !existsSync(join(hhome, 'plugins', 'irises-bridge')),
    'a CLI that will not answer must not keep the plugin dir on the box',
  );
});

test('web_build skips a fresh install, builds an install that already serves web/out, never fails', () => {
  const npmStub = 'printf "npm argv:%s\\n" "$*" >> "$STUB_LOG"; exit "${NPM_RC:-0}"';
  const mk = (withOut: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'irises-web-'));
    mkdirSync(join(root, 'web', 'node_modules'), { recursive: true });
    if (withOut) mkdirSync(join(root, 'web', 'out'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"irises"}');
    return root;
  };
  const fresh = runLib(`web_build ${JSON.stringify(mk(false))}`, { stubs: { npm: npmStub } });
  assert.equal(fresh.code, 0, fresh.err);
  assert.deepEqual(fresh.log, [], 'not one npm call on a box that never served the page');
  assert.match(fresh.out, /web UI not built here/);

  const serving = runLib(`web_build ${JSON.stringify(mk(true))}`, { stubs: { npm: npmStub } });
  assert.equal(serving.code, 0, serving.err);
  assert.equal(serving.log.length, 2, serving.log.join('\n'));
  assert.match(serving.log[0], /^npm argv:--prefix .*\/web ci$/, 'ci, not install: install rewrites web/package-lock.json and dirties the tree');
  assert.match(serving.log[1], /^npm argv:run build:web$/);

  const failing = runLib(`web_build ${JSON.stringify(mk(true))}; printf "SURVIVED\\n"`, {
    stubs: { npm: npmStub }, env: { NPM_RC: '1' },
  });
  assert.equal(failing.code, 0, failing.err);
  assert.match(failing.out, /SURVIVED/, 'a next build that dies of memory must not abort the lifecycle action');
  assert.match(failing.err, /web client build failed/);

  const opted = runLib(`web_build ${JSON.stringify(mk(false))}`, { stubs: { npm: npmStub }, env: { IRISES_WEB: '1' } });
  assert.equal(opted.code, 0, opted.err);
  assert.equal(opted.log.length, 2, 'IRISES_WEB=1 opts a fresh install in');

  const skipped = runLib(`web_build ${JSON.stringify(mk(true))}`, { stubs: { npm: npmStub }, env: { IRISES_SKIP_WEB_BUILD: '1' } });
  assert.deepEqual(skipped.log, []);
  assert.match(skipped.out, /IRISES_SKIP_WEB_BUILD=1/);
});

// ── section F: service, process, health, manifest, lock, summary ────────────────────────────────

test('service_kind is none with no systemctl and no launchctl on PATH', () => {
  const r = runLib('service_kind');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'none', 'the scratch PATH has neither — the detached fallback must be chosen');
});

test('service_kind needs systemctl AND a reachable user bus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const bus = join(dir, 'run');
  mkdirSync(bus, { recursive: true });
  writeFileSync(join(bus, 'bus'), '');
  const noBus = runLib('service_kind', {
    stubs: { systemctl: 'exit 0', uname: 'echo Linux' },
    env: { XDG_RUNTIME_DIR: join(dir, 'absent') },
  });
  assert.equal(noBus.out, 'none', 'systemctl present but no user bus is the fresh-SSH case');
  const withBus = runLib('service_kind', {
    stubs: { systemctl: 'exit 0', uname: 'echo Linux' },
    env: { XDG_RUNTIME_DIR: bus, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(bus, 'bus')}` },
  });
  assert.equal(withBus.out, 'systemd');
  const mac = runLib('service_kind', { stubs: { launchctl: 'exit 0', uname: 'echo Darwin' } });
  assert.equal(mac.out, 'launchd');
});

test('service_install renders the systemd unit with an absolute node, PATH, logs and reload, and prints only its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  const root = join(dir, 'clone');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\nNODE_OPTIONS=--max-old-space-size=512   # heap cap\n');
  const r = runLib(`service_install ${JSON.stringify(root)} /usr/local/bin/node`, {
    stubs: { systemctl: 'printf "systemctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Linux', loginctl: 'printf "loginctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0' },
    env: { HOME: home, IRISES_HOME: state, IRISES_ROOT: root, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const unitPath = join(home, '.config', 'systemd', 'user', 'irises.service');
  assert.equal(r.out.trim(), unitPath, 'callers capture this — the "wrote" line must be on stderr');
  const unit = readFileSync(unitPath, 'utf8');
  assert.match(unit, /^ExecStart="\/usr\/local\/bin\/node" ".*\/clone\/dist\/index\.js"$/m, 'a bare `node` never resolves in a unit, and an unquoted path splits at its spaces');
  assert.match(unit, new RegExp(`^WorkingDirectory=${root}$`, 'm'));
  assert.match(unit, new RegExp(`^Environment="IRISES_HOME=${state}"$`, 'm'));
  assert.match(unit, /^Environment="NODE_OPTIONS=--max-old-space-size=512"$/m, 'app.env sets it too late for V8 — the unit is the only place it works');
  assert.match(unit, /^Environment="PATH=[^"]*\/usr\/bin[^"]*"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^TimeoutStopSec=30$/m);
  assert.match(unit, new RegExp(`^StandardOutput=append:${state}/logs/server\\.log$`, 'm'));
  assert.match(unit, new RegExp(`^StandardError=append:${state}/logs/server\\.log$`, 'm'));
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.ok(r.log.some(l => l === 'systemctl argv:--user daemon-reload'), r.log.join('\n'));
  assert.ok(r.log.some(l => l === 'systemctl argv:--user enable irises'), r.log.join('\n'));
  assert.ok(r.log.some(l => l.startsWith('loginctl argv:enable-linger')), 'without linger the unit dies at logout');
});

test('service_install quotes the systemd ExecStart, so a path with a space or a % still starts', () => {
  // systemd splits ExecStart on whitespace: unquoted, `/home/alice/My Projects/Irises/dist/index.js`
  // became TWO arguments (node was handed `/home/alice/My`), so the service never came up on exactly
  // the clones whose path has a space in it. `%` is a specifier to systemd and doubles in every value,
  // quoted or not — hence `%%` in the assertions below.
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  const root = join(dir, 'My Projects', '50%off');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\nNODE_OPTIONS=--max-old-space-size=50%   # odd but legal\n');
  const r = runLib(`service_install ${JSON.stringify(root)} /usr/local/bin/node`, {
    stubs: { systemctl: 'exit 0', uname: 'echo Linux', loginctl: 'exit 0' },
    env: { HOME: home, IRISES_HOME: state, IRISES_ROOT: root, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'irises.service'), 'utf8');
  assert.match(unit, /^ExecStart="\/usr\/local\/bin\/node" ".*My Projects\/50%%off\/dist\/index\.js"$/m,
    'both arguments are quoted, and the % is doubled');
  assert.match(unit, /^WorkingDirectory=.*My Projects\/50%%off$/m,
    'WorkingDirectory takes the rest of the line, so it is escaped but NOT quoted');
  assert.match(unit, /^Environment="NODE_OPTIONS=--max-old-space-size=50%%"$/m, 'Environment values double % too');
});

test('service_install renders the LaunchAgent plist that stays stopped after a clean stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  const root = join(dir, 'clone');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\n');
  const r = runLib(`service_install ${JSON.stringify(root)} /opt/homebrew/bin/node`, {
    stubs: { launchctl: 'printf "launchctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Darwin' },
    env: { HOME: home, IRISES_HOME: state, IRISES_ROOT: root },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const plistPath = join(home, 'Library', 'LaunchAgents', 'ai.irises.server.plist');
  assert.equal(r.out.trim(), plistPath);
  const plist = readFileSync(plistPath, 'utf8');
  assert.match(plist, /<key>Label<\/key>\s*<string>ai\.irises\.server<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, new RegExp(`<string>${root}/dist/index.js</string>`));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    'a plain KeepAlive=true would relaunch the server we just asked to stop');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, new RegExp(`<key>StandardOutPath</key>\\s*<string>${state}/logs/server.log</string>`));
  assert.ok(r.log.some(l => /^launchctl argv:bootstrap gui\/\d+ .*ai\.irises\.server\.plist$/.test(l)), r.log.join('\n'));
});

test('service_install escapes the LaunchAgent plist, so a path with & or < stays valid XML', () => {
  // A macOS clone can legally sit under `/Users/me/Irises & Co/<x>`. Printed raw, the `&` makes the
  // plist unparseable ("unknown ampersand-escape sequence") and `launchctl bootstrap` refuses it, so
  // the install fails on a path the filesystem is perfectly happy with. `_xml_escape` already existed
  // for the Windows task definition; this branch simply was not calling it.
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  const root = join(dir, 'Irises & Co', '<x>');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\n');
  const r = runLib(`service_install ${JSON.stringify(root)} /opt/homebrew/bin/node`, {
    stubs: { launchctl: 'exit 0', uname: 'echo Darwin' },
    env: { HOME: home, IRISES_HOME: state, IRISES_ROOT: root },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const plistPath = join(home, 'Library', 'LaunchAgents', 'ai.irises.server.plist');
  const plist = readFileSync(plistPath, 'utf8');
  assert.ok(plist.includes('Irises &amp; Co'), 'the ampersand is escaped');
  assert.ok(plist.includes('&lt;x&gt;'), 'the angle brackets are escaped');
  assert.ok(!/Irises & Co/.test(plist), 'no RAW ampersand survives into the XML');
  // The real oracle, when it is available: launchd itself uses this parser.
  if (process.platform === 'darwin') {
    const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.equal(lint.status, 0, `plutil -lint rejected the plist: ${lint.stdout}${lint.stderr}`);
  }
});

test('service_restart and service_uninstall use the right verbs per platform', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(join(home, '.config', 'systemd', 'user', 'irises.service'), '[Service]\n');
  const linux = runLib('service_restart; service_uninstall', {
    stubs: { systemctl: 'printf "systemctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Linux' },
    env: { HOME: home, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
  });
  assert.equal(linux.code, 0, linux.err);
  assert.ok(linux.log.includes('systemctl argv:--user restart irises'), linux.log.join('\n'));
  assert.ok(linux.log.includes('systemctl argv:--user disable irises'), linux.log.join('\n'));
  assert.ok(!existsSync(join(home, '.config', 'systemd', 'user', 'irises.service')), 'the unit file goes with it');

  const home2 = join(dir, 'home2');
  mkdirSync(join(home2, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home2, 'Library', 'LaunchAgents', 'ai.irises.server.plist'), '<plist/>\n');
  const mac = runLib('service_restart; service_uninstall', {
    stubs: { launchctl: 'printf "launchctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Darwin' },
    env: { HOME: home2 },
  });
  assert.equal(mac.code, 0, mac.err);
  assert.ok(mac.log.some(l => /^launchctl argv:kickstart -k gui\/\d+\/ai\.irises\.server$/.test(l)), mac.log.join('\n'));
  assert.ok(mac.log.some(l => /^launchctl argv:bootout gui\/\d+\/ai\.irises\.server$/.test(l)), mac.log.join('\n'));
  assert.ok(!existsSync(join(home2, 'Library', 'LaunchAgents', 'ai.irises.server.plist')));
});

test('is_our_server and server_pid only ever claim a live Irises process', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-pid-'));
  const stale = runLib([
    `printf '999999\\n' > "$(irises_home)/irises.pid"`,
    'printf "PID=[%s]\\n" "$(server_pid)"',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(stale.code, 0, stale.err);
  assert.match(stale.out, /PID=\[\]/, 'a dead pid is not a server');

  const mine = runLib([
    'printf "SELF=%s\\n" "$(is_our_server $$ && echo yes || echo no)"',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.match(mine.out, /SELF=no/, 'this bash is not dist/index.js');
  const junk = runLib('printf "JUNK=%s\\n" "$(is_our_server not-a-pid && echo yes || echo no)"', { env: { IRISES_HOME: state } });
  assert.match(junk.out, /JUNK=no/);
});

test('server_stop_pid ends the one pid it was handed and waits to see it go', () => {
  // The pidfile path and the installer's adopt-by-command-line path both signal through here, so
  // this is where "did it actually die?" is answered. A real child, killed for real: `sleep 30`
  // would outlive the whole suite if the graceful phase were the only thing that ever ran.
  const r = runLib([
    'sleep 30 &',
    'p=$!',
    'rc=0; server_stop_pid "$p" 5 || rc=$?',
    'printf "RC=%s\\n" "$rc"',
    'if _pid_alive "$p"; then printf "STILL-ALIVE\\n"; else printf "GONE\\n"; fi',
  ].join('\n'));
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /RC=0/, 'a stop is never an abort — the caller has a summary to print');
  assert.match(r.out, /GONE/, `sleep 30 survived server_stop_pid:\n${r.out}\n${r.err}`);
  const nothing = runLib('rc=0; server_stop_pid "" 5 || rc=$?; printf "RC=%s\\n" "$rc"');
  assert.match(nothing.out, /RC=0/, 'no pid is nothing to do, not a failure');
  const nonsense = runLib('rc=0; server_stop_pid not-a-pid 5 || rc=$?; printf "RC=%s\\n" "$rc"');
  assert.match(nonsense.out, /RC=0/, 'and a junk pid is never passed to kill');
});

test('wait_health_sha waits for the sha the new build stamped, ignoring update.remoteSha', () => {
  const oldSha = 'a'.repeat(40);
  const newSha = 'b'.repeat(40);
  const shaFile = join(mkdtempSync(join(tmpdir(), 'irises-sha-')), 'live-sha');
  writeFileSync(shaFile, oldSha);
  const { base, stop } = startHealthServer(shaFile);
  try {
    const ok = runLib(`wait_health ${base} 5 && printf "\\nHEALTH=ok\\n"`);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /HEALTH=ok/);

    const wrong = runLib(`rc=0; wait_health_sha ${base} ${newSha} 3 || rc=$?; printf "\\nRC=%s\\n" "$rc"`);
    assert.match(wrong.out, /RC=1/, 'the old build answering must NOT be read as the new build');

    writeFileSync(shaFile, newSha);
    const right = runLib(`wait_health_sha ${base} ${newSha} 5; printf "\\nRC=0\\n"`);
    assert.equal(right.code, 0, right.err);
    assert.match(right.out, new RegExp(newSha));
    const short = runLib(`wait_health_sha ${base} ${newSha.slice(0, 7)} 5; printf "\\nRC=0\\n"`);
    assert.equal(short.code, 0, 'a short sha from dist/version.json must match the full one');
  } finally {
    stop();
  }
});

test('wait_health fails within its budget when nothing is listening', () => {
  const started = Date.now();
  const r = runLib('rc=0; wait_health http://127.0.0.1:1 3 || rc=$?; printf "RC=%s\\n" "$rc"');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.ok(Date.now() - started < 20000);
});

test('irises_restart_verify restarts through the service and proves the expected sha answers', () => {
  const oldSha = 'a'.repeat(40);
  const newSha = 'b'.repeat(40);
  const dir = mkdtempSync(join(tmpdir(), 'irises-rv-'));
  const home = join(dir, 'home');
  const root = join(dir, 'clone');
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(home, '.config', 'systemd', 'user', 'irises.service'), '[Service]\n');
  const shaFile = join(dir, 'live-sha');
  writeFileSync(shaFile, oldSha);
  const { base, stop } = startHealthServer(shaFile);
  const port = base.slice(base.lastIndexOf(':') + 1);
  try {
    const r = runLib(
      `rc=0; irises_restart_verify ${JSON.stringify(root)} ${port} ${newSha} 20 || rc=$?; printf "RC=%s\\n" "$rc"`,
      {
        stubs: {
          // The service restart is the ONLY thing that flips which sha /health reports here. Before
          // it the old build is still answering on that port — the exact shape of a restart that
          // never took, which is what this function exists to tell apart from a real one.
          systemctl: [
            'printf "systemctl argv:%s\\n" "$*" >> "$STUB_LOG"',
            'case "$*" in *"restart irises") printf "%s" "$WANT_SHA" > "$SHA_FILE" ;; esac',
            'exit 0',
          ].join('\n'),
          uname: 'echo Linux',
        },
        env: {
          HOME: home,
          XDG_RUNTIME_DIR: dir,
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null',
          WANT_SHA: newSha,
          SHA_FILE: shaFile,
        },
      },
    );
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.match(r.out, /RC=0/);
    assert.ok(r.log.includes('systemctl argv:--user restart irises'), r.log.join('\n'));
    assert.match(r.out, new RegExp(`restarted — build ${newSha.slice(0, 7)} is live on :${port}`));
  } finally {
    stop();
  }
});

test('irises_restart_verify refuses when the port is held and there is no server of ours to cycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-rv-'));
  const shaFile = join(dir, 'live-sha');
  writeFileSync(shaFile, 'a'.repeat(40));
  const { base, stop } = startHealthServer(shaFile);
  const port = base.slice(base.lastIndexOf(':') + 1);
  try {
    // No unit and no plist under this run's HOME, no pidfile in its IRISES_HOME: nothing of ours to
    // cycle, and something is plainly answering on that port. Starting a second server there would
    // fail to bind and then "verify" against whatever is already listening.
    const r = runLib(
      `rc=0; irises_restart_verify ${JSON.stringify(dir)} ${port} ${'a'.repeat(40)} 5 || rc=$?; printf "RC=%s\\n" "$rc"`,
    );
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.match(r.out, /RC=1/);
    assert.match(r.err, new RegExp(`something took :${port}`));
  } finally {
    stop();
  }
});

test('irises_restart_verify fails within its budget when nothing answers', () => {
  const root = mkdtempSync(join(tmpdir(), 'irises-rv-'));
  const started = Date.now();
  // nohup/setsid stubbed to a bare success: server_start_detached must report "started" without a
  // node process ever existing, so what is under test is the verification, not the launch.
  const r = runLib(
    `rc=0; irises_restart_verify ${JSON.stringify(root)} 1 ${'b'.repeat(40)} 2 || rc=$?; printf "RC=%s\\n" "$rc"`,
    { stubs: { nohup: 'exit 0', setsid: 'exit 0' } },
  );
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /RC=1/);
  assert.match(r.out, /starting the detached server/);
  assert.match(r.err, /no \/health answer reporting bbbbbbb on :1 within 2s/);
  assert.ok(Date.now() - started < 20000);
});

test('model_lane_key maps the three lanes and refuses a fourth', () => {
  const r = runLib([
    `printf 'ANTHROPIC=[%s]\\n' "$(model_lane_key anthropic)"`,
    `printf 'OPENROUTER=[%s]\\n' "$(model_lane_key openrouter)"`,
    `printf 'OPENAI=[%s]\\n' "$(model_lane_key openai)"`,
    'rc=0',
    'out="$(model_lane_key azure)" || rc=$?',
    `printf 'AZURE=[%s] RC=%s\\n' "$out" "$rc"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ANTHROPIC=\[ANTHROPIC_API_KEY\]/);
  assert.match(r.out, /OPENROUTER=\[OPENROUTER_API_KEY\]/);
  assert.match(r.out, /OPENAI=\[OPENAI_API_KEY\]/);
  assert.match(r.out, /AZURE=\[\] RC=1/, 'an unknown lane prints nothing and says so in its exit code');
});

test('model_override_write writes the three roles, the provider, the lane key from the environment, and ENGINE_MODEL_INHERIT=off', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-model-')), '.env');
  writeFileSync(f, 'PORT=3000\n', { mode: 0o644 });
  const r = runLib(`model_override_write ${JSON.stringify(f)} openrouter m ''`, {
    env: { IRISES_MODEL_API_KEY: 'zzz-not-a-key' },
  });
  assert.equal(r.code, 0, r.err);
  const body = readFileSync(f, 'utf8');
  for (const role of ['CONVO', 'CLASSIFY', 'FALLFIRM']) {
    assert.match(body, new RegExp(`^${role}_MODEL_OPENROUTER=m$`, 'm'), body);
    assert.match(body, new RegExp(`^${role}_PROVIDER=openrouter$`, 'm'), body);
  }
  assert.match(body, /^OPENROUTER_API_KEY=zzz-not-a-key$/m, 'the key travels by environment and lands in the file');
  assert.match(body, /^ENGINE_MODEL_INHERIT=off$/m, 'applyModel() only stops inheriting keys and base URL when this is off');
  assert.match(body, /^PORT=3000$/m, 'the operator\'s own keys are untouched');
  assert.ok(!r.out.includes('zzz-not-a-key'), 'a secret must never reach stdout');
  assert.ok(!r.err.includes('zzz-not-a-key'), 'a secret must never reach stderr');
  assert.equal(statSync(f).mode & 0o777, 0o600, 'the file holds a key now, so it ends 0600');
});

test('model_override_write on the openai lane writes OPENAI_BASE_URL and warns when no key is in the environment', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-model-')), '.env');
  writeFileSync(f, '');
  const r = runLib(`model_override_write ${JSON.stringify(f)} openai m https://x.example/v1`);
  assert.equal(r.code, 0, r.err);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^OPENAI_BASE_URL=https:\/\/x\.example\/v1$/m);
  assert.match(body, /^CONVO_MODEL_OPENAI=m$/m);
  assert.ok(!/^OPENAI_API_KEY=/m.test(body), 'with nothing in the environment the lane key is left alone');
  assert.match(r.err, /no IRISES_MODEL_API_KEY/, 'the operator is told the voice cannot call the lane yet');
});

test('model_override_keys lists what --model-inherit may remove and keeps the lane keys out of it', () => {
  const r = runLib([
    `printf 'ALL=[%s]\\n' "$(model_override_keys)"`,
    `printf 'OPENAI=[%s]\\n' "$(model_override_keys openai)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  const all = (/ALL=\[(.*)\]/.exec(r.out)?.[1] ?? '').split(/\s+/).filter(Boolean);
  assert.equal(all.length, 13, `every removable key, once: ${all.join(' ')}`);
  assert.ok(all.includes('ENGINE_MODEL_INHERIT'), all.join(' '));
  assert.ok(!all.includes('OPENROUTER_API_KEY'), 'a key the operator paid for is never on the removal list');
  assert.ok(!all.includes('OPENAI_BASE_URL'), 'the no-lane form leaves the base URL where it is');
  const openai = (/OPENAI=\[(.*)\]/.exec(r.out)?.[1] ?? '').split(/\s+/).filter(Boolean);
  assert.ok(openai.includes('OPENAI_BASE_URL'), openai.join(' '));
  assert.ok(openai.includes('CONVO_MODEL_OPENAI'), openai.join(' '));
  assert.ok(!openai.includes('CONVO_MODEL_OPENROUTER'), 'a lane owns only its own model keys');
  assert.ok(!openai.includes('OPENAI_API_KEY'), openai.join(' '));
});

test('model_override_write refuses an unknown lane before writing anything', () => {
  // The write is a loop of env_set calls, so a lane the case arms do not cover used to get halfway
  // through — the three _PROVIDER keys and ENGINE_MODEL_INHERIT=off written against a lane nothing
  // can dispatch, leaving the clone unable to speak in its own voice and no line saying why. The
  // lane is checked once, up front, and the file is left exactly as it was found.
  const f = join(mkdtempSync(join(tmpdir(), 'irises-model-')), '.env');
  writeFileSync(f, 'PORT=3000\n');
  const before = readFileSync(f, 'utf8');
  const r = runLib([
    'rc=0',
    `model_override_write ${JSON.stringify(f)} azure m '' || rc=$?`,
    `printf 'RC=%s\\n' "$rc"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/, 'an unknown lane is a refusal, not a partial write');
  assert.match(r.err, /unknown lane 'azure'/, 'and it names the lane it was handed');
  assert.match(r.err, /anthropic, openrouter or openai/, 'plus the three it does know');
  assert.equal(readFileSync(f, 'utf8'), before, 'not one byte of the .env moved');
});

test('manifest_write and manifest_read round-trip without node, and survive a reformat', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-man-'));
  const p = join(state, 'install-manifest.json');
  const r = runLib([
    `manifest_write ${JSON.stringify(p)} engine=hermes root=/home/ubuntu/irises port=3000 serviceKind=systemd 'keysAdded=API_SERVER_ENABLED IRISES_PUSH_TOKEN' keysPreExisting=API_SERVER_KEY`,
    `printf 'ENGINE=%s\\n' "$(manifest_read ${JSON.stringify(p)} engine)"`,
    `printf 'ADDED=[%s]\\n' "$(manifest_read ${JSON.stringify(p)} keysAdded)"`,
    `printf 'PRE=%s\\n' "$(manifest_read ${JSON.stringify(p)} keysPreExisting)"`,
    `printf 'MISSING=[%s]\\n' "$(manifest_read ${JSON.stringify(p)} nope)"`,
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ENGINE=hermes/);
  assert.match(r.out, /ADDED=\[API_SERVER_ENABLED IRISES_PUSH_TOKEN\]/);
  assert.match(r.out, /PRE=API_SERVER_KEY/);
  assert.match(r.out, /MISSING=\[\]/);
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
  assert.equal(parsed.engine, 'hermes', 'it must be valid JSON for anyone who looks at it');
  assert.equal(parsed.serviceKind, 'systemd');
  writeFileSync(p, JSON.stringify(parsed));    // one line: the grep reader misses, node must catch it
  const reformatted = runLib(`printf 'ENGINE=%s\\n' "$(manifest_read ${JSON.stringify(p)} engine)"`, { env: { IRISES_HOME: state } });
  assert.match(reformatted.out, /ENGINE=hermes/);
});

/** Every key engine-setup.sh writes — the same list IRISES_MANIFEST_KEYS names, in that order. */
const MANIFEST_KEYS = [
  'root', 'irisesHome', 'port', 'engine', 'engineEnvFile', 'engineEnvBackup', 'pluginDir',
  'serviceKind', 'serviceUnit', 'nodeBin', 'keysAdded', 'keysPreExisting', 'keysRetargeted',
  'bridge', 'frontPattern', 'engineEnvApplied', 'modelLane', 'engineEnvPending',
];

test('manifest_update rewrites the named fields and carries every other field forward', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-manu-'));
  const p = join(state, 'install-manifest.json');
  const r = runLib([
    `manifest_write ${JSON.stringify(p)} ${MANIFEST_KEYS.map(k => `${k}=v-${k}`).join(' ')}`,
    `manifest_update ${JSON.stringify(p)} port=4001 frontPattern=telegram:1`,
    ...MANIFEST_KEYS.map(k => `printf '%s=[%s]\\n' ${k} "$(manifest_read ${JSON.stringify(p)} ${k})"`),
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /^port=\[4001\]$/m);
  assert.match(r.out, /^frontPattern=\[telegram:1\]$/m);
  for (const k of MANIFEST_KEYS) {
    if (k === 'port' || k === 'frontPattern') continue;
    assert.match(r.out, new RegExp(`^${k}=\\[v-${k}\\]$`, 'm'),
      `${k} was dropped by the rewrite — --uninstall reads it:\n${r.out}`);
  }
  const raw = readFileSync(p, 'utf8');
  assert.match(raw, /"schema": "1"/);
  assert.match(raw, /"writtenAt": "/, 'manifest_write refreshes it — the update must go through it');
});

test('manifest_read reverses both of manifest_write escapes, so manifest_update never doubles a backslash', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-manb-'));
  const p = join(state, 'install-manifest.json');
  // A Windows clone root and an engine .env path with a quote in it: manifest_write escapes `\` and
  // then `"`, and a reader that only reverses the second one grows the value every rewrite.
  const backslashed = 'C:\\Irises\\clone';
  const both = 'C:\\Users\\R&D\\a "quoted" \\"pair\\"';
  const read = (k: string, label: string) => `printf '${label}=[%s]\\n' "$(manifest_read ${JSON.stringify(p)} ${k})"`;
  const r = runLib([
    `manifest_write ${JSON.stringify(p)} 'root=${backslashed}' 'engineEnvFile=${both}' port=3000`,
    read('root', 'ONE'),
    read('engineEnvFile', 'ONEB'),
    `manifest_update ${JSON.stringify(p)} port=4001`,
    read('root', 'TWO'),
    read('engineEnvFile', 'TWOB'),
    `manifest_update ${JSON.stringify(p)} port=4002`,
    read('root', 'THREE'),
    read('engineEnvFile', 'THREEB'),
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  for (const label of ['ONE', 'TWO', 'THREE']) {
    assert.ok(r.out.includes(`${label}=[${backslashed}]`),
      `${label} is not the value that was written — a rewrite grew it:\n${r.out}`);
    assert.ok(r.out.includes(`${label}B=[${both}]`),
      `${label}B is not the value that was written — a rewrite grew it:\n${r.out}`);
  }
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
  assert.equal(parsed.root, backslashed, 'and the file on disk still says what the installer meant');
  assert.equal(parsed.engineEnvFile, both);
  assert.equal(parsed.port, '4002');
});

test('manifest_update refuses an unknown key and a missing manifest without writing', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-manu-'));
  const p = join(state, 'install-manifest.json');
  const seed = runLib(
    `manifest_write ${JSON.stringify(p)} ${MANIFEST_KEYS.map(k => `${k}=v-${k}`).join(' ')}`,
    { env: { IRISES_HOME: state } },
  );
  assert.equal(seed.code, 0, seed.err);
  const before = readFileSync(p, 'utf8');
  const unknown = runLib(
    `rc=0; manifest_update ${JSON.stringify(p)} port=4001 prot=4002 || rc=$?; printf "RC=%s\\n" "$rc"`,
    { env: { IRISES_HOME: state } },
  );
  assert.equal(unknown.code, 0, unknown.err);
  assert.match(unknown.out, /RC=1/);
  assert.match(unknown.err, /manifest_update: unknown key prot/);
  assert.equal(readFileSync(p, 'utf8'), before,
    'a typo in one key must not half-apply the others');

  // A bare word passes the known-key test (KEY=VALUE's key half of `port` IS `port`) but carries no
  // value to overlay, so accepting it would silently do nothing the caller asked for.
  const bare = runLib(
    `rc=0; manifest_update ${JSON.stringify(p)} port || rc=$?; printf "RC=%s\\n" "$rc"`,
    { env: { IRISES_HOME: state } },
  );
  assert.equal(bare.code, 0, bare.err);
  assert.match(bare.out, /RC=1/);
  assert.match(bare.err, /manifest_update: not a KEY=VALUE argument: port/);
  assert.equal(readFileSync(p, 'utf8'), before, 'and it must not rewrite the manifest either');

  const gone = join(state, 'no-such-manifest.json');
  const missing = runLib(
    `rc=0; manifest_update ${JSON.stringify(gone)} port=4001 || rc=$?; printf "RC=%s\\n" "$rc"`,
    { env: { IRISES_HOME: state } },
  );
  assert.equal(missing.code, 0, missing.err);
  assert.match(missing.out, /RC=1/);
  assert.ok(!existsSync(gone), 'a manifest that was never written must not be invented here');
});

test('lock_acquire keeps a second run out and reclaims a lock whose holder is gone', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-lock-'));
  const held = runLib([
    'lock_acquire',
    'rc=0; ( lock_acquire ) || rc=$?; printf "SECOND=%s\\n" "$rc"',
    'lock_release',
    'lock_acquire && printf "AFTER_RELEASE=ok\\n"',
    'lock_release',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, /SECOND=1/);
  assert.match(held.out, /AFTER_RELEASE=ok/);
  const stale = runLib([
    'mkdir -p "$(irises_home)/lifecycle.lock"',
    'printf "999999\\n" > "$(irises_home)/lifecycle.lock/pid"',
    'lock_acquire && printf "RECLAIMED=ok\\n"',
    'lock_release',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(stale.code, 0, stale.err);
  assert.match(stale.out, /RECLAIMED=ok/);
});

test('summary prints its lines and ends with exactly one RESULT line on stdout', () => {
  const r = runLib('summary rolled-back "old -> new reverted" "server untouched"');
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n').filter(Boolean);
  assert.equal(lines[lines.length - 1], 'RESULT: rolled-back');
  assert.equal(lines.filter(l => l.startsWith('RESULT:')).length, 1);
  assert.match(r.out, /old -> new reverted/);
  assert.match(r.out, /server untouched/);
});

// ── guarded mutations and the RESULT safety net ─────────────────────────────────────────────────
//
// Both of these exist because of the same failure mode: the callers run `set -euo pipefail`, so a
// single unguarded statement that fails on a read-only mount or a full disk takes the WHOLE script
// down where it stands — past the function's own warn/return, past the summary, so stdout carries
// no `RESULT:` line at all and a caller parsing it cannot tell "failed" from "still running".

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

test('plugin_refresh reports a read-only plugins dir instead of silently claiming success', {
  // chmod does not bind root, so the copy would just succeed and there would be nothing to observe.
  skip: IS_ROOT ? 'running as root: a 0555 directory is still writable' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-ro-'));
  const root = join(dir, 'clone');
  mkdirSync(join(root, 'bridge', 'hermes', 'irises-bridge'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', 'plugin.yaml'), 'name: irises-bridge\n');
  const hhome = join(dir, 'hermes');
  const plugins = join(hhome, 'plugins');
  mkdirSync(plugins, { recursive: true });
  chmodSync(plugins, 0o555);
  try {
    const r = runLib([
      // The form the lifecycle scripts actually use. Note that it also SUPPRESSES set -e inside the
      // function body (bash propagates that into a function called in a `||` list), which is exactly
      // why an unguarded `cp -R` was invisible: it failed, the function carried on and returned 0.
      `rc=0; plugin_refresh hermes ${JSON.stringify(root)} || rc=$?`,
      'printf "RC=%s\\n" "$rc"',
      'printf "SURVIVED\\n"',
    ].join('\n'), { env: { HERMES_HOME: hhome }, stubs: { hermes: RECORDING_STUB } });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.match(r.out, /RC=1/, 'a copy that could not happen must be reported, not returned as success');
    assert.match(r.out, /SURVIVED/, 'and the calling script must still reach its next line');
    assert.ok(!r.out.includes('refreshed'), `it must not claim a refresh that never happened:\n${r.out}`);
    assert.match(r.err, new RegExp(plugins.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the error names the directory the operator has to fix');
  } finally {
    chmodSync(plugins, 0o755);
  }
});

test('model_override_write returns 1 and stops at the first write it cannot make', {
  // chmod does not bind root, so every write would just succeed and there would be nothing to see.
  skip: IS_ROOT ? 'running as root: a 0444 file in a 0555 directory is still writable' : false,
}, () => {
  // Both callers guard this call — engine-setup.sh with `|| die 1`, configure.sh with `|| exit 1` —
  // and neither guard can fire while the function returns 0 for writes that never happened. A
  // half-written override is the failure it exists to prevent: the clone boots on a lane with no
  // model, in nobody's voice, with nothing in the output saying why.
  const dir = mkdtempSync(join(tmpdir(), 'irises-model-ro-'));
  const f = join(dir, '.env');
  writeFileSync(f, 'PORT=3000\n');
  const before = readFileSync(f, 'utf8');
  // Both, because env_set writes a sibling temp file first: a read-only .env alone still leaves the
  // directory writable, and the write would get as far as the copy-back.
  chmodSync(f, 0o444);
  chmodSync(dir, 0o555);
  try {
    const r = runLib([
      'rc=0',
      `model_override_write ${JSON.stringify(f)} openrouter m '' || rc=$?`,
      'printf "RC=%s\\n" "$rc"',
      'printf "SURVIVED\\n"',
    ].join('\n'), { env: { IRISES_MODEL_API_KEY: 'zzz-not-a-key' } });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.match(r.out, /RC=1/, 'a write it could not make is a refusal the caller can see');
    assert.match(r.out, /SURVIVED/, 'and the calling script still reaches its own guard');
    assert.equal(readFileSync(f, 'utf8'), before, 'the file is exactly as it was found');
    assert.ok(!r.out.includes('zzz-not-a-key'), `a secret never reaches stdout:\n${r.out}`);
    assert.ok(!r.err.includes('zzz-not-a-key'), `a secret never reaches stderr:\n${r.err}`);
  } finally {
    chmodSync(dir, 0o755);
    chmodSync(f, 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lifecycle_exit_guard prints RESULT: partial when a script dies before its summary', () => {
  const aborted = runLib([
    "trap 'lifecycle_exit_guard $?' EXIT",
    'false',
  ].join('\n'));
  assert.notEqual(aborted.code, 0, 'the abort keeps its exit code — the guard only reports');
  const results = aborted.out.split('\n').filter(l => l.startsWith('RESULT:'));
  assert.deepEqual(results, ['RESULT: partial'], aborted.out);
  assert.match(aborted.err, /aborted with exit 1 before the summary/);
});

test('lifecycle_exit_guard stays silent once summary has printed a RESULT', () => {
  const clean = runLib([
    "trap 'lifecycle_exit_guard $?' EXIT",
    'summary ok "all done"',
  ].join('\n'));
  assert.equal(clean.code, 0, clean.err);
  const results = clean.out.split('\n').filter(l => l.startsWith('RESULT:'));
  assert.deepEqual(results, ['RESULT: ok'], 'exactly one RESULT line, and never a second one');
  assert.ok(!clean.out.includes('partial'), clean.out);
});

test('service_install refuses a relative NODE_BIN, which its own error already promised', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const root = join(dir, 'clone');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\n');
  const r = runLib([
    `rc=0; service_install ${JSON.stringify(root)} node || rc=$?`,
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'), {
    stubs: { systemctl: 'exit 0', uname: 'echo Linux' },
    env: { IRISES_ROOT: root, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/, 'a bare `node` in a unit or plist never resolves — it must be caught here');
  assert.match(r.err, /absolute/i);
  assert.ok(!existsSync(join(r.dir, 'home', '.config', 'systemd', 'user', 'irises.service')),
    'and nothing is written on the way out');
});

test('wait_health_sha reads a /health body that has whitespace around its colons', () => {
  const sha = 'd'.repeat(40);
  const body = `{ "status" : "ok" , "version" : { "sha" : "${sha}" } , "update" : { "remoteSha" : "${'c'.repeat(40)}" } }`;
  const r = runLib(`printf 'GOT=[%s]\\n' "$(wait_health_sha http://127.0.0.1:1 ${sha} 3)"`, {
    // A pretty-printer (or a reverse proxy that reformats JSON) is all it takes; the strict
    // '"sha":"…"' pattern then matched nothing and the updater timed out on a healthy server.
    stubs: { curl: `printf '%s' ${JSON.stringify(body)}` },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, new RegExp(`GOT=\\[${sha}\\]`), r.out);
});

// ── Windows: Git Bash / WSL2 ────────────────────────────────────────────────────────────────────
//
// There is no Windows box behind any of these: every one is stubs. `uname` prints what MSYS2
// prints, and `cygpath`/`schtasks`/`powershell.exe`/`tasklist`/`taskkill` log their argv and answer
// with canned output. That pins the SHAPE of every Windows call — the flags, the doubled slashes,
// the CRLF launcher, which helper is reached for on which platform — and nothing at all about how
// Windows then behaves. The Windows paths stay unverified on Windows until someone installs there.

/** `cygpath -w`: prefix C:\fake and flip the slashes. Enough to prove win_path is in the chain. */
const CYGPATH_STUB = [
  'printf "cygpath argv:%s\\n" "$*" >> "$STUB_LOG"',
  'in_path=""',
  'for a in "$@"; do case "$a" in -*) ;; *) in_path="$a" ;; esac; done',
  `printf 'C:\\\\fake%s\\n' "$(printf '%s' "$in_path" | tr '/' '\\\\')"`,
].join('\n');

const SCHTASKS_STUB = [
  'printf "schtasks argv:%s\\n" "$*" >> "$STUB_LOG"',
  'exit "${SCHTASKS_RC:-0}"',
].join('\n');

/**
 * PowerShell as every Windows arm reaches for it: log the argv, succeed, print nothing. It does NOT
 * perform the UTF-16 conversion service_install asks it for, which is deliberate — the XML assertions
 * below read the UTF-8 file bash wrote and the stub left untouched.
 */
const POWERSHELL_STUB = [
  'printf "powershell argv:%s\\n" "$*" >> "$STUB_LOG"',
  'exit "${POWERSHELL_RC:-0}"',
].join('\n');

/** Git Bash as the lib sees it: an MSYS uname, cygpath, PowerShell, and a Task Scheduler that says yes. */
const WIN_STUBS: Record<string, string> = {
  uname: 'echo MSYS_NT-10.0-22631',
  cygpath: CYGPATH_STUB,
  schtasks: SCHTASKS_STUB,
  'powershell.exe': POWERSHELL_STUB,
};

test('irises_platform tells Git Bash, WSL2, macOS and Linux apart', () => {
  for (const os of ['MSYS_NT-10.0-22631', 'MINGW64_NT-10.0-22631', 'CYGWIN_NT-10.0']) {
    const w = runLib('irises_platform', { stubs: { uname: `echo ${os}` } });
    assert.equal(w.out, 'windows', `${os} is Git Bash / Cygwin: ${w.err}`);
  }
  assert.equal(runLib('irises_platform', { stubs: { uname: 'echo Darwin' } }).out, 'macos');
  const linux = runLib('irises_platform', { stubs: { uname: 'echo Linux' } });
  assert.match(linux.out, /^(linux|wsl)$/, 'WSL2 is a Linux kernel that names microsoft in /proc/version');
  const host = runLib('irises_platform');
  assert.match(host.out, /^(linux|macos|wsl|windows)$/, `unstubbed, it must still answer: ${host.err}`);
  const junk = runLib('irises_platform', { stubs: { uname: 'exit 1' } });
  assert.equal(junk.out, 'linux', 'an unknown uname is treated as the POSIX default, not as an error');
});

test('win_path converts through cygpath and passes the path through unchanged without one', () => {
  const converted = runLib('win_path /c/irises/dist', { stubs: WIN_STUBS });
  assert.equal(converted.code, 0, converted.err);
  assert.equal(converted.out.trim(), String.raw`C:\fake\c\irises\dist`);
  const bare = runLib('win_path /c/irises/dist', { stubs: { uname: 'echo MSYS_NT-10.0-22631' } });
  assert.equal(bare.out, '/c/irises/dist', 'no cygpath (WSL2, a stripped MSYS) must not mangle the path');
});

test('service_kind is schtasks on Git Bash, and none when Task Scheduler is unreachable', () => {
  const yes = runLib('service_kind', { stubs: WIN_STUBS });
  assert.equal(yes.out, 'schtasks', yes.err);
  const no = runLib('service_kind', { stubs: { uname: 'echo MSYS_NT-10.0-22631' } });
  assert.equal(no.out, 'none', 'a locked-down box with no schtasks takes the detached fallback');
  assert.equal(runLib('service_task_name', { stubs: WIN_STUBS }).out, 'Irises');
});

test('service_install writes a CRLF launcher .cmd, registers the task from XML, prints only the launcher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-win-'));
  const root = join(dir, 'clone');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\nNODE_OPTIONS=--max-old-space-size=512   # heap cap\n');
  const r = runLib(`service_install ${JSON.stringify(root)} "/c/Program Files/nodejs/node.exe"`, {
    stubs: WIN_STUBS,
    env: { IRISES_ROOT: root, IRISES_HOME: state },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const launcher = join(state, 'irises-start.cmd');
  assert.equal(r.out.trim(), launcher, 'callers capture this — every other line belongs on stderr');

  const cmd = readFileSync(launcher, 'utf8');
  assert.ok(
    cmd.split('\n').filter(Boolean).every(l => l.endsWith('\r')),
    `cmd.exe wants CRLF; a lone LF has mangled multi-line set blocks:\n${JSON.stringify(cmd)}`,
  );
  assert.match(cmd, /^@echo off\r$/m);
  assert.ok(cmd.includes(String.raw`set "IRISES_HOME=C:\fake`), cmd);
  assert.ok(cmd.includes('set "NODE_OPTIONS=--max-old-space-size=512"'), cmd);
  assert.ok(cmd.includes(String.raw`set "PATH=C:\fake\c\Program Files\nodejs;%PATH%"`), cmd);
  assert.ok(cmd.includes(String.raw`cd /d "C:\fake`), cmd);
  assert.ok(cmd.includes(String.raw`node.exe"`), cmd);
  assert.ok(cmd.includes(String.raw`dist\index.js`), cmd);
  assert.ok(cmd.includes(String.raw`logs\server.log`), 'schtasks cannot redirect — the launcher must');
  assert.ok(cmd.includes('2>&1'), cmd);
  assert.ok(existsSync(join(state, 'logs')), 'and the log dir exists before the task ever fires');

  const create = r.log.find(l => l.startsWith('schtasks argv://Create'));
  assert.ok(create, r.log.join('\n'));
  assert.ok(
    create!.includes('//Create //TN Irises //XML'),
    'the flag form cannot express restart-on-failure, so the task is registered from XML',
  );
  assert.ok(create!.includes(String.raw`//XML C:\fake`), 'the XML path crosses out of bash: win_path first');
  assert.ok(create!.includes(' //F'), 'a re-install must replace the task, not fail on it');

  // The three settings the //SC ONLOGON flag form could not carry, plus the two it could.
  const xmlPath = join(state, 'irises-task.xml');
  assert.ok(existsSync(xmlPath), `service_install must write the task definition:\n${r.err}`);
  const xml = readFileSync(xmlPath, 'utf8');
  assert.ok(xml.includes('<RestartOnFailure>'), xml);
  assert.ok(xml.includes('<Count>3</Count>'), 'three restarts, a minute apart — systemd/launchd parity');
  assert.ok(
    xml.includes('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'),
    'without PT0S the default three-day limit kills a healthy server',
  );
  assert.ok(xml.includes('<LogonTrigger>'), "still starts at this user's logon");
  assert.ok(xml.includes('<RunLevel>LeastPrivilege</RunLevel>'), 'what //RL LIMITED used to say');
  assert.ok(
    xml.includes(`<Command>${String.raw`C:\fake`}`) && xml.includes(String.raw`irises-start.cmd</Command>`),
    `the action is the launcher, in Windows spelling:\n${xml}`,
  );

  // ENCODING. Some Windows builds refuse a task definition that is not Unicode ("The task XML is
  // malformed"), which is why hermes writes its own as UTF-16. bash cannot emit UTF-16, so the file
  // is written UTF-8 and handed to PowerShell to rewrite in place — and the declaration has to
  // agree with the bytes the parser eventually sees, not with the ones bash wrote.
  assert.ok(xml.includes('encoding="UTF-16"'), `the declaration has to match the converted file:\n${xml}`);
  const convert = r.log.find(l => l.includes('WriteAllText'));
  assert.ok(convert, `the XML must be converted to UTF-16 before schtasks reads it:\n${r.log.join('\n')}`);
  assert.ok(convert!.includes(String.raw`irises-task.xml`), `it converts the task XML, not something else:\n${convert}`);
  assert.ok(convert!.includes('[Text.Encoding]::Unicode'), `UTF-16 LE with a BOM:\n${convert}`);
  assert.ok(convert!.includes(String.raw`C:\fake`), `the path crosses out of bash: win_path first:\n${convert}`);
  assert.ok(
    r.log.findIndex(l => l.includes('WriteAllText')) < r.log.findIndex(l => l.startsWith('schtasks argv://Create')),
    `converting after //Create would register the UTF-8 file:\n${r.log.join('\n')}`,
  );

  const unconverted = runLib([
    `rc=0; service_install ${JSON.stringify(root)} "/c/Program Files/nodejs/node.exe" || rc=$?`,
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'), {
    stubs: WIN_STUBS,
    env: { IRISES_ROOT: root, IRISES_HOME: state, POWERSHELL_RC: '1' },
  });
  assert.match(unconverted.out, /RC=1/, 'a task XML we could not convert is a failed install, not a broken task');
  assert.ok(
    !unconverted.log.some(l => l.startsWith('schtasks argv://Create')),
    `and schtasks is never handed the file we know it may refuse:\n${unconverted.log.join('\n')}`,
  );

  const failed = runLib([
    `rc=0; service_install ${JSON.stringify(root)} "/c/Program Files/nodejs/node.exe" || rc=$?`,
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'), {
    stubs: WIN_STUBS,
    env: { IRISES_ROOT: root, IRISES_HOME: state, SCHTASKS_RC: '1' },
  });
  assert.match(failed.out, /RC=1/, 'a refused //Create is a failed install, not a silent one');
  assert.match(failed.err, /schtasks/);
});

test('service_restart, service_uninstall and service_installed drive Task Scheduler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-win-'));
  const state = join(dir, 'state');
  mkdirSync(state, { recursive: true });

  const restart = runLib('service_restart', { stubs: WIN_STUBS, env: { IRISES_HOME: state } });
  assert.equal(restart.code, 0, `${restart.out}\n${restart.err}`);
  const ended = restart.log.findIndex(l => l.includes('//End //TN Irises'));
  const ran = restart.log.findIndex(l => l.includes('//Run //TN Irises'));
  assert.ok(ended >= 0, restart.log.join('\n'));
  assert.ok(ran > ended, `//End has to land before //Run:\n${restart.log.join('\n')}`);

  const launcher = join(state, 'irises-start.cmd');
  const taskXml = join(state, 'irises-task.xml');
  writeFileSync(launcher, '@echo off\r\n');
  writeFileSync(taskXml, '<Task/>\n');
  const un = runLib('service_uninstall', { stubs: WIN_STUBS, env: { IRISES_HOME: state } });
  assert.equal(un.code, 0, un.err);
  assert.ok(un.log.some(l => l.includes('//Delete //TN Irises //F')), un.log.join('\n'));
  assert.ok(!existsSync(launcher), 'the launcher goes with the task');
  assert.ok(!existsSync(taskXml), 'and so does the XML the task was registered from');

  const probe = 'service_installed && printf "INSTALLED\\n" || printf "ABSENT\\n"';
  const present = runLib(probe, { stubs: WIN_STUBS, env: { IRISES_HOME: state } });
  assert.match(present.out, /INSTALLED/, 'a //Query that exits 0 is an installed task');
  const gone = runLib(probe, {
    stubs: { ...WIN_STUBS, schtasks: 'exit 1' },
    env: { IRISES_HOME: state },
  });
  assert.match(gone.out, /ABSENT/);

  // The point of service_installed: Tasks 5–7 ask it instead of testing the two files themselves.
  const home = join(dir, 'unit-home');
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(join(home, '.config', 'systemd', 'user', 'irises.service'), '[Service]\n');
  const withUnit = runLib(probe, { stubs: { uname: 'echo Linux' }, env: { HOME: home } });
  assert.match(withUnit.out, /INSTALLED/, 'the systemd unit existing is still an install');
  const withNothing = runLib(probe, { stubs: { uname: 'echo Linux' } });
  assert.match(withNothing.out, /ABSENT/);
});

test('is_our_server asks PowerShell for the command line on Windows, and server_pid trusts tasklist', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-winpid-'));
  writeFileSync(join(state, 'irises.pid'), '4242\n');
  const psOurs = String.raw`
printf 'powershell argv:%s\n' "$*" >> "$STUB_LOG"
printf 'C:\\Program Files\\nodejs\\node.exe C:\\irises\\dist\\index.js\n'
`;
  const tasklistLive = String.raw`
printf 'tasklist argv:%s\n' "$*" >> "$STUB_LOG"
printf '"node.exe","4242","Console","1","120,000 K"\n'
`;
  const ours = runLib([
    'printf "OURS=%s\\n" "$(is_our_server 4242 && echo yes || echo no)"',
    'printf "PID=[%s]\\n" "$(server_pid)"',
  ].join('\n'), {
    stubs: { uname: 'echo MSYS_NT-10.0-22631', 'powershell.exe': psOurs, tasklist: tasklistLive },
    env: { IRISES_HOME: state },
  });
  assert.equal(ours.code, 0, `${ours.out}\n${ours.err}`);
  assert.match(ours.out, /OURS=yes/, 'a backslash in the command line must match dist/index.js too');
  assert.match(ours.out, /PID=\[4242\]/);
  assert.ok(
    ours.log.some(l => l.includes('Win32_Process') && l.includes('ProcessId=4242')),
    `Git Bash has no /proc and no ps -o command=:\n${ours.log.join('\n')}`,
  );
  assert.ok(
    ours.log.some(l => l.startsWith('tasklist argv:') && l.includes('PID eq 4242')),
    `the pidfile holds a WINDOWS pid, which kill -0 knows nothing about:\n${ours.log.join('\n')}`,
  );

  const notOurs = runLib('printf "OURS=%s\\n" "$(is_our_server 4242 && echo yes || echo no)"', {
    stubs: { uname: 'echo MSYS_NT-10.0-22631', 'powershell.exe': "printf 'notepad.exe\\n'" },
  });
  assert.match(notOurs.out, /OURS=no/, 'a recycled pid must never be signalled');

  const dead = runLib('printf "PID=[%s]\\n" "$(server_pid)"', {
    stubs: { uname: 'echo MSYS_NT-10.0-22631', tasklist: 'exit 0', 'powershell.exe': psOurs },
    env: { IRISES_HOME: state },
  });
  assert.match(dead.out, /PID=\[\]/, 'no tasklist row means the pidfile is stale');
});

test('a tasklist that FAILS is not read as a dead server — PowerShell is asked first', () => {
  // The distinction the branch turns on: tasklist answering "no such pid" is the pidfile being stale,
  // but tasklist being MISSING or erroring says nothing about the server. Reading the second as the
  // first turns a restart into a no-op and reports health-failed over a server that is still serving.
  const state = mkdtempSync(join(tmpdir(), 'irises-winpid2-'));
  writeFileSync(join(state, 'irises.pid'), '4242\n');
  const psAliveAndOurs = String.raw`
printf 'powershell argv:%s\n' "$*" >> "$STUB_LOG"
case "$*" in
  *Get-Process*) exit 0 ;;
esac
printf 'C:\\Program Files\\nodejs\\node.exe C:\\irises\\dist\\index.js\n'
`;
  const r = runLib('printf "PID=[%s]\\n" "$(server_pid)"', {
    stubs: {
      uname: 'echo MSYS_NT-10.0-22631',
      tasklist: 'printf "tasklist argv:%s\\n" "$*" >> "$STUB_LOG"; exit 1',
      'powershell.exe': psAliveAndOurs,
    },
    env: { IRISES_HOME: state },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /PID=\[4242\]/, 'a live server must not look dead just because tasklist failed');
  assert.ok(
    r.log.some(l => l.includes('Get-Process') && l.includes('4242')),
    `PowerShell is the fallback that settles it:\n${r.log.join('\n')}`,
  );
});

test('server_stop terminates the tree with taskkill on Windows and polls tasklist for the result', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-winstop-'));
  writeFileSync(join(state, 'irises.pid'), '4242\n');
  const r = runLib('server_stop 5; printf "SURVIVED\\n"', {
    stubs: {
      uname: 'echo MSYS_NT-10.0-22631',
      'powershell.exe': String.raw`printf 'C:\\node.exe C:\\irises\\dist\\index.js\n'`,
      // The row disappears once taskkill has run — that is what makes the poll observable.
      tasklist: String.raw`
printf 'tasklist argv:%s\n' "$*" >> "$STUB_LOG"
if [ -f "$STUB_LOG.dead" ]; then exit 0; fi
printf '"node.exe","4242","Console","1","120,000 K"\n'
`,
      taskkill: String.raw`printf 'taskkill argv:%s\n' "$*" >> "$STUB_LOG"; : > "$STUB_LOG.dead"`,
    },
    env: { IRISES_HOME: state },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(r.log.includes('taskkill argv://PID 4242 //T //F'), r.log.join('\n'));
  assert.ok(
    r.log.filter(l => l.startsWith('tasklist argv:')).length >= 2,
    `liveness is polled after the kill, not assumed:\n${r.log.join('\n')}`,
  );
  assert.match(r.out, /SURVIVED/);
  assert.ok(!r.err.includes('SIGTERM'), 'there is no SIGTERM to send on Windows, so none is claimed');
});

test('server_start_detached hands Windows to Start-Process with both streams redirected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-winstart-'));
  const root = join(dir, 'clone');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  const r = runLib(`server_start_detached ${JSON.stringify(root)}`, {
    stubs: {
      ...WIN_STUBS,
      'powershell.exe': String.raw`printf 'powershell argv:%s\n' "$*" >> "$STUB_LOG"; exit 0`,
    },
    env: { IRISES_HOME: state },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const call = r.log.find(l => l.includes('Start-Process'));
  assert.ok(call, `there is no setsid and no working nohup in Git Bash:\n${r.log.join('\n')}`);
  assert.ok(call!.includes('-WindowStyle Hidden'), call);
  assert.ok(call!.includes(String.raw`dist\index.js`), call);
  assert.ok(call!.includes(String.raw`logs\server.log'`), call);
  assert.ok(call!.includes(String.raw`logs\server.log.err'`), 'PowerShell refuses one file for both streams');
  assert.ok(existsSync(join(state, 'logs')), 'the log dir is created before the process needs it');
});

test('tcp_open falls back to a PowerShell TcpClient on Windows', () => {
  const open = runLib('rc=0; tcp_open 127.0.0.1 1 || rc=$?; printf "RC=%s\\n" "$rc"', {
    stubs: {
      uname: 'echo MSYS_NT-10.0-22631',
      'powershell.exe': String.raw`printf 'powershell argv:%s\n' "$*" >> "$STUB_LOG"; exit 0`,
    },
  });
  assert.equal(open.code, 0, open.err);
  assert.match(open.out, /RC=0/);
  assert.ok(open.log.some(l => l.includes('TcpClient')), open.log.join('\n'));
  const shut = runLib('rc=0; tcp_open 127.0.0.1 1 || rc=$?; printf "RC=%s\\n" "$rc"', {
    stubs: { uname: 'echo MSYS_NT-10.0-22631', 'powershell.exe': 'exit 1' },
  });
  assert.match(shut.out, /RC=1/);
});

test('augment_path picks up the Git Bash node locations when they exist', () => {
  const appdata = mkdtempSync(join(tmpdir(), 'irises-appdata-'));
  mkdirSync(join(appdata, 'npm'), { recursive: true });
  const r = runLib('augment_path; printf "PATH=%s\\n" "$PATH"', { env: { APPDATA: appdata } });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(join(appdata, 'npm')), `%APPDATA%\\npm is where npm -g puts binaries:\n${r.out}`);
  const without = runLib('augment_path; printf "PATH=%s\\n" "$PATH"');
  assert.ok(!without.out.includes(':/npm'), 'an unset APPDATA must not add /npm');
  assert.ok(!without.out.includes('Program Files/nodejs'), 'nor a nodejs dir this box does not have');
});
