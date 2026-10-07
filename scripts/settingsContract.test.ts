// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// THE RULE: every install-time setting is reachable from BOTH the install wizard and Configure — in
// the flag scripts (their --help) and in the menu (the section a person walks) — or this fails.
//
// Why it is a test and not a convention. The wizard and Configure ask the same questions at two
// different moments, and the way they come apart is not a bug anyone sees in review. A setting the
// installer takes and configure.sh does not can only be changed by re-installing — on a live box,
// over a setting as small as a timezone. A flag configure.sh grew and the menu never learned is a
// setting only the operator who reads --help knows is there, which is the one who did not need the
// menu. Both halves look complete from inside their own file; the person who finds out is the one
// changing one thing on a box that is already running.
//
// So the table below IS the list of install-time settings, and each row names the literal that has
// to appear in all four places. Assertion (d) then reads the installer's own argument parser and
// diffs it against the table BOTH ways, so neither side can move alone: a flag added to the
// installer with no row here fails, and a row here naming a flag the installer dropped fails too.
//
// Adding an install-time setting? Add a row, a `--flag` in configure.sh, and a Configure entry in
// scripts/irises.sh. That is the whole contract.
//
// Secrets are in the table by NAME only (IRISES_MODEL_API_KEY, IRISES_DASHBOARD_PASSWORD). They are
// settings like any other and have to be re-settable, but they travel in the environment rather
// than on argv, so what both helps and both menu sections have to carry is the VARIABLE name.
//
// What is deliberately NOT in the table: configure.sh's own flags that no install ever takes.
// --model-inherit undoes a model override, which is a thing only an already-configured box can have
// — the installer has nothing to hand back — so it is configure-only by design, not a missing row,
// and assertion (d)'s reverse diff reads the INSTALLER's parser and so never asks about it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const IRISES_SH = readFileSync(join(REPO, 'scripts/irises.sh'), 'utf8');
const ENGINE_SETUP_SH = readFileSync(join(REPO, 'scripts/engine-setup.sh'), 'utf8');
const CONFIGURE_SH = readFileSync(join(REPO, 'scripts/configure.sh'), 'utf8');

/** A script's own --help, as an operator reads it. Read from the SCRIPT, never re-typed here: a
 *  help text this file quoted back at itself would pass while saying nothing. */
function helpOf(script: string): string {
  const r = spawnSync('/bin/bash', [join(REPO, 'scripts', script), '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(r.status, 0, `bash scripts/${script} --help exited ${r.status}: ${r.stderr}`);
  return `${r.stdout}\n${r.stderr}`;
}

const INSTALL_HELP = helpOf('engine-setup.sh');
const CONFIGURE_HELP = helpOf('configure.sh');

interface Setting {
  /** What a person would call it — used in failure messages only. */
  name: string;
  /** Literals that must appear in `engine-setup.sh --help`. */
  installHelp: string[];
  /** …in `configure.sh --help`. */
  configureHelp: string[];
  /** …in the `# ── N) install` section of scripts/irises.sh. */
  installMenu: string[];
  /** …in the `# ── N) configure` section of scripts/irises.sh. */
  configureMenu: string[];
}

const SETTINGS: readonly Setting[] = [
  { name: 'port', installHelp: ['--port'], configureHelp: ['--port'], installMenu: ['--port'], configureMenu: ['--port'] },
  // The one row whose four literals differ, and deliberately: the installer's switch is a pair of
  // bare flags (a service is the default, --no-service opts out, and only that one is in its usage),
  // while configure.sh takes a value it can read back off a box — `--service on|off`.
  {
    name: 'service',
    installHelp: ['--no-service'],
    configureHelp: ['--service'],
    installMenu: ['--service', '--no-service'],
    configureMenu: ['--service'],
  },
  { name: 'front', installHelp: ['--front'], configureHelp: ['--front'], installMenu: ['--front'], configureMenu: ['--front'] },
  { name: 'model lane', installHelp: ['--model-lane'], configureHelp: ['--model-lane'], installMenu: ['--model-lane'], configureMenu: ['--model-lane'] },
  { name: 'model slug', installHelp: ['--model-slug'], configureHelp: ['--model-slug'], installMenu: ['--model-slug'], configureMenu: ['--model-slug'] },
  { name: 'model base URL', installHelp: ['--model-base-url'], configureHelp: ['--model-base-url'], installMenu: ['--model-base-url'], configureMenu: ['--model-base-url'] },
  { name: 'browser chat', installHelp: ['--web'], configureHelp: ['--web'], installMenu: ['--web'], configureMenu: ['--web'] },
  { name: 'thread pings', installHelp: ['--pings'], configureHelp: ['--pings'], installMenu: ['--pings'], configureMenu: ['--pings'] },
  { name: 'musings', installHelp: ['--musings'], configureHelp: ['--musings'], installMenu: ['--musings'], configureMenu: ['--musings'] },
  { name: 'timezone', installHelp: ['--tz'], configureHelp: ['--tz'], installMenu: ['--tz'], configureMenu: ['--tz'] },
  // Env-only settings. No flag anywhere, in either script, by design — so the four places carry the
  // variable's name and the reverse diff below never sees them.
  {
    name: 'model API key',
    installHelp: ['IRISES_MODEL_API_KEY'],
    configureHelp: ['IRISES_MODEL_API_KEY'],
    installMenu: ['IRISES_MODEL_API_KEY'],
    configureMenu: ['IRISES_MODEL_API_KEY'],
  },
  {
    name: 'dashboard password',
    installHelp: ['IRISES_DASHBOARD_PASSWORD'],
    configureHelp: ['IRISES_DASHBOARD_PASSWORD'],
    installMenu: ['IRISES_DASHBOARD_PASSWORD'],
    configureMenu: ['IRISES_DASHBOARD_PASSWORD'],
  },
];

/**
 * The menu, cut into the sections its own comment markers declare: `# ── N) name ───…`. A section
 * runs to the next numbered marker, so the unnumbered ones (`# ── asking ──`, `# ── the top menu ──`)
 * belong to whichever section they follow. The map is by NAME, not by number, because the numbers
 * move every time an entry is inserted and the sections do not.
 *
 * Comment lines are cut out of the body. The claim this file makes is that the menu COMPOSES the
 * flag, and this script's house style is to explain in prose which flag a block is about — so a
 * section whose only `--tz` is the comment above a deleted question would satisfy an unstripped
 * match while asking the operator nothing.
 */
function menuSections(src: string): Map<string, { n: number; body: string }> {
  const re = /^# ── (\d+)\) (\w+)/gm;
  const marks: Array<{ n: number; name: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) marks.push({ n: Number(m[1]), name: m[2], at: m.index });
  const out = new Map<string, { n: number; body: string }>();
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : src.length;
    const code = src.slice(mark.at, end).split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    out.set(mark.name, { n: mark.n, body: code });
  });
  return out;
}

const SECTIONS = menuSections(IRISES_SH);

/**
 * A script's argument parser: from its `while [ $# -gt 0 ]; do` to the `done` that closes it. Read
 * rather than assumed, because the whole point of (d) is that the PARSER is the truth about what a
 * script accepts — a usage text can advertise a flag that was deleted, and does, eventually.
 */
function parserBody(src: string, where: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.trim() === 'while [ $# -gt 0 ]; do');
  assert.ok(start >= 0, `${where} has no \`while [ $# -gt 0 ]; do\` argument parser to read`);
  let depth = 1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*done\b/.test(l)) {
      depth--;
      if (depth === 0) return lines.slice(start, i + 1).join('\n');
    } else if (/(^|;)\s*do\s*$/.test(l)) {
      depth++;
    }
  }
  assert.fail(`${where}'s argument parser is never closed by a \`done\``);
}

/** Every flag a parser has a case arm for: `--front)` and `--front=*)` are one flag, `--yes|-y)` is
 *  two. The `*)` catch-all does not match, which is what makes this the list of KNOWN flags. */
function caseArmFlags(body: string): string[] {
  const re = /^\s*((?:-{1,2}[a-z][a-z-]*(?:=\*)?)(?:\|-{1,2}[a-z][a-z-]*(?:=\*)?)*)\)/gm;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    for (const raw of m[1].split('|')) {
      const flag = raw.replace(/=\*$/, '');
      if (!out.includes(flag)) out.push(flag);
    }
  }
  return out;
}

/** Installer flags that are not settings: they choose what the RUN does, not what the box is left
 *  configured as, so there is nothing for Configure to change later. */
const NON_SETTING = [
  '--engine', '--yes', '-y', '--bridge', '--no-bridge', '--engine-env',
  '--uninstall', '--detach-engine', '--purge-data', '--archive-data', '--no-gateway-restart',
  '--revert', '-h', '--help',
];

const flagsOf = (lists: string[][]) => {
  const out: string[] = [];
  for (const l of lists) for (const lit of l) if (lit.startsWith('--') && !out.includes(lit)) out.push(lit);
  return out;
};

// (a) + (b) — both helps.
for (const s of SETTINGS) {
  test(`${s.name} is in engine-setup.sh --help`, () => {
    for (const lit of s.installHelp) {
      assert.ok(
        INSTALL_HELP.includes(lit),
        `bash scripts/engine-setup.sh --help never mentions ${lit} — the install takes ${s.name}, so its usage has to say how`,
      );
    }
  });

  test(`${s.name} is in configure.sh --help`, () => {
    for (const lit of s.configureHelp) {
      assert.ok(
        CONFIGURE_HELP.includes(lit),
        `bash scripts/configure.sh --help never mentions ${lit} — a setting the install takes has to be changeable afterwards without re-installing`,
      );
    }
  });
}

// (c) — both menu sections.
test('scripts/irises.sh has an install section and a configure section', () => {
  assert.ok(SECTIONS.has('install'), 'no `# ── N) install ──` marker in scripts/irises.sh');
  assert.ok(SECTIONS.has('configure'), 'no `# ── N) configure ──` marker in scripts/irises.sh — Configure is how a person changes a setting without the flags');
});

test('the menu\'s section numbers are a complete run with no gaps or repeats', () => {
  const ns = [...SECTIONS.values()].map(s => s.n).sort((a, b) => a - b);
  assert.deepEqual(
    ns,
    ns.map((_, i) => i + 1),
    `the \`# ── N) name ──\` markers number ${ns.join(',')} — they are the numbers the top menu offers, so an inserted entry has to renumber every marker below it`,
  );
});

for (const s of SETTINGS) {
  test(`${s.name} is reachable from the menu's install wizard`, () => {
    const body = SECTIONS.get('install')?.body ?? '';
    for (const lit of s.installMenu) {
      assert.ok(body.includes(lit), `the install section of scripts/irises.sh never composes ${lit}`);
    }
  });

  test(`${s.name} is reachable from the menu's Configure`, () => {
    const body = SECTIONS.get('configure')?.body ?? '';
    for (const lit of s.configureMenu) {
      assert.ok(
        body.includes(lit),
        `the configure section of scripts/irises.sh never composes ${lit} — the wizard asks for ${s.name} at install time and nothing in the menu asks for it again`,
      );
    }
  });
}

// (d) — the reverse direction, read off the installer's own parser, diffed both ways.
test('every installer flag that is a setting has a row here, and every row is an installer flag', () => {
  const arms = caseArmFlags(parserBody(ENGINE_SETUP_SH, 'scripts/engine-setup.sh'));
  assert.ok(arms.length > 5, `only ${arms.length} case arms found in engine-setup.sh's parser — the extraction, not the script, is what broke`);

  const tabled = flagsOf(SETTINGS.map(s => [...s.installHelp, ...s.installMenu]));
  const settings = arms.filter(f => !NON_SETTING.includes(f));

  for (const f of settings) {
    assert.ok(
      tabled.includes(f),
      `scripts/engine-setup.sh accepts ${f} and nothing re-sets it afterwards: add a row to scripts/settingsContract.test.ts and a Configure entry to scripts/irises.sh (or list ${f} in NON_SETTING if it steers the run rather than the box)`,
    );
  }
  for (const f of tabled) {
    assert.ok(
      arms.includes(f),
      `scripts/settingsContract.test.ts still claims ${f} as an install-time setting, but the installer no longer accepts ${f} — drop the row, or the flag came back under another name`,
    );
  }
});

// (e) — configure.sh's help cannot advertise a flag its parser dropped.
test('every flag configure.sh documents is a flag configure.sh parses', () => {
  const arms = caseArmFlags(parserBody(CONFIGURE_SH, 'scripts/configure.sh'));
  for (const f of flagsOf(SETTINGS.map(s => s.configureHelp))) {
    assert.ok(
      arms.includes(f),
      `bash scripts/configure.sh --help documents ${f} but its argument parser has no case arm for it — the help is what an operator types from, and an undocumented drop is a usage error at 3am`,
    );
  }
});
