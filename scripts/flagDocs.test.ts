// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// EVERY FLAG THIS PHASE SHIPPED, DOCUMENTED WHERE AN OPERATOR LOOKS — and documented with the
// default the code actually applies.
//
// The two files below are the whole operator-facing surface for a switch: `deploy/app.env` is the
// committed baseline that ships to the box, `.env.example` is what a local install copies. A flag
// that exists only in a doc comment inside src/ is a flag nobody can find, and — worse — a flag
// whose file says "default on" while its parser defaults off is a switch an operator flips in the
// wrong direction during an incident.
//
// So this pins both halves:
//   • the DEFAULT in the table below is read out of the parser itself with the var unset, so it
//     cannot drift from the code;
//   • and each file has to state it, inside that flag's own entry, as the literal words
//     "default <value>" — one phrasing across both files, so the answer is greppable and a switch
//     word ("on") cannot be matched out of some passing sentence about the conversation.
//
// Adding a flag? Add a row here and a line in both files. That is the whole contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { turnTraceEnabled } from '../src/diagnostics/turnTrace.js';
import { themeTopicGateEnabled } from '../src/db/repositories/threadInventory.js';
import { turnFocusBlockEnabled } from '../src/agents/convo/turnFocus.js';
import { memoryRelevanceEnabled } from '../src/memory/relevance.js';
import { routingGateMemoryAwareEnabled } from '../src/agents/routingGate.js';
import { affectDeterministicEnabled } from '../src/persona/status.js';
import { personaModulesEnabled } from '../src/agents/convo/personaModules.js';
import { provenanceEnabled } from '../src/memory/provenance.js';
import { dossierFactGuardEnabled, dossierEditsEnabled } from '../src/memory/dossier.js';
import { mediumSupersedeEnabled } from '../src/memory/mediumSupersede.js';
import { convoHistoryMax } from '../src/db/repositories/conversations.js';
import { walledUrlHintEnabled } from '../src/llm/models.js';
import { hermesSessionRotation, runsTransportEnabled } from '../src/agents/ops/hermesBackend.js';
import { unkeptPromiseGuardEnabled } from '../src/agents/convo/unkeptPromise.js';
import { outcomePassEnabled } from '../src/agents/convo/actionResults.js';
import { starvedRetryEnabled, reasoningDisableEnabled, llmCallTimeoutMs } from '../src/llm/openrouterRequest.js';
import { browserLegBudgetMs, opsCancelEngineAbortEnabled, engineApprovalRelayEnabled } from '../src/agents/ops/engineBackend.js';
import { leafExamplesExtra } from '../src/persona/idle.js';
import { hooksEnabled, momentsEnabled, thesisEnabled, shareTurnsEnabled, selfEnabled, musingsEnabled, familiarityEnabled } from '../src/persona/featureFlags.js';

const REPO = process.cwd();
const APP_ENV = readFileSync(join(REPO, 'deploy/app.env'), 'utf8');
const ENV_EXAMPLE = readFileSync(join(REPO, '.env.example'), 'utf8');

/** A boolean flag's default as an operator reads it, so the doc token and the parser can be
 *  compared without either side hand-typing the other's value. */
const onOff = (v: boolean) => (v ? 'on' : 'off');

interface FlagDoc {
  name: string;
  /** The token the files must state as this flag's default — READ FROM THE PARSER by `probe`. */
  probe: () => string;
}

/** Every flag the conversation-first phase added, plus the ones the Hermes-parity and LLM-hygiene
 *  bundles added alongside it. `probe` runs with the var unset, which is what a default IS. */
const FLAGS: readonly FlagDoc[] = [
  { name: 'TURN_TRACE_ENABLED', probe: () => onOff(turnTraceEnabled()) },
  { name: 'CONVO_THEME_TOPIC_GATE', probe: () => onOff(themeTopicGateEnabled()) },
  { name: 'CONVO_TURN_FOCUS_BLOCK', probe: () => onOff(turnFocusBlockEnabled()) },
  { name: 'CONVO_MEMORY_RELEVANCE', probe: () => onOff(memoryRelevanceEnabled()) },
  { name: 'CONVO_ROUTING_GATE_MEMORY_AWARE', probe: () => onOff(routingGateMemoryAwareEnabled()) },
  { name: 'AFFECT_DETERMINISTIC', probe: () => onOff(affectDeterministicEnabled()) },
  { name: 'CONVO_PERSONA_MODULES', probe: () => onOff(personaModulesEnabled()) },
  { name: 'MEMORY_PROVENANCE_ENABLED', probe: () => onOff(provenanceEnabled()) },
  { name: 'DOSSIER_FACT_GUARD_ENABLED', probe: () => onOff(dossierFactGuardEnabled()) },
  { name: 'MEMORY_DOSSIER_EDITS', probe: () => onOff(dossierEditsEnabled()) },
  { name: 'MEMORY_MEDIUM_SUPERSEDE', probe: () => onOff(mediumSupersedeEnabled()) },
  { name: 'CONVO_HOOKS_ENABLED', probe: () => onOff(hooksEnabled()) },
  { name: 'MEMORY_MOMENTS_ENABLED', probe: () => onOff(momentsEnabled()) },
  { name: 'MEMORY_THESIS_ENABLED', probe: () => onOff(thesisEnabled()) },
  { name: 'MEMORY_SELF_ENABLED', probe: () => onOff(selfEnabled()) },
  { name: 'IRISES_MUSINGS_ENABLED', probe: () => onOff(musingsEnabled()) },
  // The parser answered `off` here for the length of the series that built the shape and answers
  // `on` from the commit that finished it — and both files had to follow it in the same commit,
  // each time, because a doc that says "default off" beside a switch that is on is the one that
  // gets flipped in the wrong direction at 3am. Nothing about this row changed at the flip: it
  // reads the answer out of the parser, which is the whole reason it survives one.
  { name: 'CONVO_SHARE_TURNS_ENABLED', probe: () => onOff(shareTurnsEnabled()) },
  // The familiarity mask ships the same way the share turn did: `off` while its series lands, `on`
  // from the commit that finishes it, both env files following the parser in that same commit.
  { name: 'CONVO_FAMILIARITY_ENABLED', probe: () => onOff(familiarityEnabled()) },
  { name: 'CONVO_HISTORY_MAX', probe: () => String(convoHistoryMax()) },
  { name: 'OPS_WALLED_URL_HINT', probe: () => onOff(walledUrlHintEnabled()) },
  { name: 'HERMES_SESSION_ROTATION', probe: () => hermesSessionRotation() },
  { name: 'CONVO_UNKEPT_PROMISE_GUARD', probe: () => onOff(unkeptPromiseGuardEnabled()) },
  { name: 'CONVO_OUTCOME_PASS', probe: () => onOff(outcomePassEnabled()) },
  { name: 'LLM_STARVED_RETRY', probe: () => onOff(starvedRetryEnabled()) },
  { name: 'LLM_REASONING_DISABLE', probe: () => onOff(reasoningDisableEnabled()) },
  { name: 'LLM_CALL_TIMEOUT_MS', probe: () => String(llmCallTimeoutMs({})) },
  // The env var IS the switch here: unset means every leg keeps the standard deadline.
  { name: 'OPS_BROWSER_TASK_TIMEOUT_MS', probe: () => onOff(browserLegBudgetMs({}) !== null) },
  { name: 'OPS_CANCEL_ENGINE_ABORT', probe: () => onOff(opsCancelEngineAbortEnabled()) },
  { name: 'OPS_ENGINE_APPROVAL_RELAY', probe: () => onOff(engineApprovalRelayEnabled()) },
  // Not a boolean — the token IS the transport name, same shape as HERMES_SESSION_ROTATION above.
  { name: 'HERMES_RUN_TRANSPORT', probe: () => (runsTransportEnabled() ? 'runs' : 'chat') },
  // Not a switch at all — a token LIST, and what an operator needs stated is what the idle gate's
  // fast path runs on when nobody has added anything: the built-in examples alone. `empty` is the
  // parser's own answer to that (an unset or blank var parses to no tokens), so the doc and the code
  // still cannot drift apart, which is the only thing this table is for.
  { name: 'LEAF_EXAMPLES_EXTRA', probe: () => leafExamplesExtra().join(',') || 'empty' },
];

/** The default a flag applies with nothing set — the var is removed for the read and put back. */
function defaultOf(flag: FlagDoc): string {
  const had = Object.prototype.hasOwnProperty.call(process.env, flag.name);
  const prior = process.env[flag.name];
  delete process.env[flag.name];
  try {
    return flag.probe();
  } finally {
    if (had) process.env[flag.name] = prior;
  }
}

/**
 * One flag's own entry: the line that first mentions it, plus the comment lines around it — the run
 * above and the continuation lines below.
 *
 * Both scans stop at any OTHER flag's line, so a default read out of the neighbouring entry can
 * never pass for this one, and the downward scan also stops at the first non-comment line. Every
 * env-file entry in this repo is that shape: a prose run, the (usually commented-out) assignment,
 * and wrapped continuation comments under it.
 */
function docBlock(file: string, name: string): string {
  const lines = file.split('\n');
  const others = FLAGS.map(f => f.name).filter(n => n !== name && !n.includes(name) && !name.includes(n));
  const someoneElse = (l: string) => others.some(n => l.includes(n));
  const at = lines.findIndex(l => l.includes(name));
  if (at < 0) return '';
  let from = at;
  while (from > 0 && lines[from - 1].trim().startsWith('#') && !someoneElse(lines[from - 1])) from--;
  let to = at;
  while (to + 1 < lines.length && lines[to + 1].trim().startsWith('#') && !someoneElse(lines[to + 1])) to++;
  return lines.slice(from, to + 1).join('\n');
}

for (const flag of FLAGS) {
  test(`${flag.name} is documented with its real default`, () => {
    const dflt = defaultOf(flag);
    for (const [where, file] of [['deploy/app.env', APP_ENV], ['.env.example', ENV_EXAMPLE]] as const) {
      const block = docBlock(file, flag.name);
      assert.ok(
        block.length > 0,
        `${where} never mentions ${flag.name} — an operator cannot flip a switch they cannot find`,
      );
      assert.match(
        block,
        new RegExp(`default ${dflt}`, 'i'),
        `${where} documents ${flag.name} without saying "default ${dflt}" — that IS its default, read `
        + `from the parser with the var unset. The doc is what gets read at 3am; it has to agree with the code`,
      );
    }
  });
}

// Decision #7: the box runs a wider transcript than the code default, and the baseline is where
// that choice lives — the default itself stays 40 so nothing else inherits the retune.
test('deploy/app.env raises the Convo transcript window to 80', () => {
  assert.match(APP_ENV, /^CONVO_HISTORY_MAX=80$/m, 'the baseline should SET the wider window, not just describe it');
  assert.equal(defaultOf(FLAGS.find(f => f.name === 'CONVO_HISTORY_MAX')!), '40', 'the code default stays 40');
});

// The web-client rebuild switch is update.sh's, not the server's — same operator, same question.
test('IRISES_SKIP_WEB_BUILD is documented for the operator who runs update.sh', () => {
  for (const [where, file] of [['deploy/app.env', APP_ENV], ['.env.example', ENV_EXAMPLE]] as const) {
    assert.match(file, /IRISES_SKIP_WEB_BUILD/, `${where} never mentions IRISES_SKIP_WEB_BUILD`);
  }
});

// Observed on the VPS: every voice role ran the engine's deepseek-v4-flash while app.env plainly
// said gpt-5.6-luna. The committed model values are only advisory while inheritance is on, and the
// place that has to say so is beside the values themselves.
test('the committed Convo model says inheritance can override it', () => {
  const block = docBlock(APP_ENV, 'CONVO_MODEL_OPENROUTER=');
  assert.match(block, /ENGINE_MODEL_INHERIT/, 'the comment beside the slug never names the switch that overrides it');
});
