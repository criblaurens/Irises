// Engine-conditional delegate tool: delegateToOpsTool picks the lane. The hermes/no-engine lane must
// hand back the CANONICAL object untouched (byte-identity is the contract — its prose is what every
// live hermes turn has been steered by), while the openclaw lane widens exactly two descriptions to
// invite that engine's real surface. Both lanes stay brand-free and schema-identical, and neither
// moves the cache-stable persona head.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELEGATE_TO_OPS_TOOL, delegateToOpsTool } from './tools.js';
import { buildSystemPrompt, convoPersonaChars, type ChatContext } from './shared.js';
import { buildEnvelopeSchema } from '../../pipeline/bubbleJson.js';
import type { LlmToolDef } from '../../llm/types.js';

const ctx: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: '+15550001111' };

type Props = Record<string, Record<string, unknown> & { description?: string }>;
const props = (t: LlmToolDef): Props => (t.inputSchema as { properties: Props }).properties;
const desc = (t: LlmToolDef, key: string): string => String(props(t)[key].description ?? '');

const hermes = delegateToOpsTool('hermes');
const openclaw = delegateToOpsTool('openclaw');

test('hermes and no-engine both return the canonical tool object itself, unmodified', () => {
  assert.equal(delegateToOpsTool('hermes'), DELEGATE_TO_OPS_TOOL);
  assert.equal(delegateToOpsTool(null), DELEGATE_TO_OPS_TOOL);
});

test('openclaw variant: meta_prompt actions clause names the wider surface AND keeps every hard limit', () => {
  const d = desc(openclaw, 'meta_prompt');
  assert.match(d, /run real code/);
  assert.match(d, /parallel workers/);
  assert.match(d, /set itself a follow-up check/);
  // The three hard limits are the whole point of the actions line — widening the surface must not
  // soften any of them.
  assert.match(d, /read-only on their inbox/);
  assert.match(d, /never send or post anything anywhere/);
  assert.match(d, /comes back in ANSWER/);
});

test('openclaw variant: kind description invites a wide sweep and still forbids head-math', () => {
  const d = desc(openclaw, 'kind');
  assert.match(d, /parallel workers/);
  assert.match(d, /never head-math/);
});

test('openclaw variant differs from canonical in exactly the two widened descriptions', () => {
  assert.notEqual(desc(openclaw, 'kind'), desc(hermes, 'kind'));
  assert.notEqual(desc(openclaw, 'meta_prompt'), desc(hermes, 'meta_prompt'));
  assert.equal(desc(openclaw, 'request'), desc(hermes, 'request'));
  assert.equal(desc(openclaw, 'media_scope'), desc(hermes, 'media_scope'));
  assert.equal(openclaw.description, hermes.description);
});

test('openclaw variant keeps the canonical name, required list, property keys and enums', () => {
  assert.equal(openclaw.name, hermes.name);
  const required = (t: LlmToolDef) => (t.inputSchema as { required: string[] }).required;
  assert.deepEqual(required(openclaw), required(hermes));
  assert.deepEqual(Object.keys(props(openclaw)), Object.keys(props(hermes)));
  assert.deepEqual(props(openclaw).kind.enum, props(hermes).kind.enum);
  assert.deepEqual(props(openclaw).media_scope.enum, props(hermes).media_scope.enum);
});

// The approval gate's one tool argument (2026-09-04). Deliberately re-pinned: the canonical object's
// bytes ARE the hermes lane's contract, so a new argument on it is a contract change and this is
// where it is written down. It is NOT in `required` — a model that omits it coerces to 'read', the
// no-friction default, and the engine doctrine still refuses an unauthorized side effect.
test('both lanes carry the effect arg, identically worded, and it stays optional', () => {
  for (const t of [hermes, openclaw]) {
    const effect = props(t).effect;
    assert.deepEqual(effect.enum, ['read', 'act']);
    assert.match(String(effect.description), /read = look things up/);
    assert.match(String(effect.description), /act = the engine itself would send, post, buy, book, pay, delete, cancel/);
  }
  assert.equal(desc(openclaw, 'effect'), desc(hermes, 'effect'));
  assert.deepEqual((hermes.inputSchema as { required: string[] }).required, ['kind', 'request']);
  // And it reaches the model where the descriptions actually travel under toolsViaJson — the flat
  // args union prefixes an enum with its own "one of:" line and keeps the wording after it.
  assert.equal(argDesc([hermes], 'effect'), `one of: read | act. ${desc(hermes, 'effect')}`);
});

// The second argument on the canonical object (2026-09-19), and a contract change re-pinned here for
// the same reason `effect` was: a two-part ask ("set this up, then find that") had nowhere to put the
// acting half, so delegation shipped the research half and dropped the rest. Also NOT in `required`
// — the overwhelming majority of looks ask for nothing done, and an omitted argument must keep them
// byte-identical to what they were. Identical on both lanes: the invitation is the engine's own
// environment, which both engines have.
test('both lanes carry engine_actions, identically worded, optional, and separate from effect', () => {
  for (const t of [hermes, openclaw]) {
    const actions = props(t).engine_actions;
    assert.equal(actions.type, 'array');
    assert.deepEqual(actions.items, { type: 'string' });
    // One entry per action, in order, nothing dropped — the whole point of a list.
    assert.match(String(actions.description), /One entry per action, in the order they asked/);
    // Done FIRST and reported back per item, failures included: a setup that failed must not vanish.
    assert.match(String(actions.description), /reports each one back, including the ones it could not do/);
    // And the bucket the old wording had no room for: acting on itself is not acting on the user.
    assert.match(String(actions.description), /acting on ITSELF is NOT `effect: act`; whether one waits for their go-ahead is decided for you/);
  }
  assert.equal(desc(openclaw, 'engine_actions'), desc(hermes, 'engine_actions'));
  assert.deepEqual((hermes.inputSchema as { required: string[] }).required, ['kind', 'request']);
  assert.match(argDesc([hermes], 'engine_actions'), /One entry per action/);
});

// The belief the incident exposed: engine-side setup read as a forbidden host action. Both lanes
// name it as askable, and both keep the one lifecycle that really is terminal-only.
test('both lanes invite engine-side setup and keep her own build out of it', () => {
  for (const t of [hermes, openclaw]) {
    assert.match(t.description, /set up, installed or configured on the deep look's own side/);
    assert.match(t.description, /a thing you ask for, never a thing you refuse/);
    assert.match(t.description, /YOUR OWN build \(install, update, uninstall\), which happens in a terminal/);
  }
});

// `effect` classified mutation as "anything outside Irises", which left an engine setting itself up
// with no correct bucket — inside the engine, outside Irises. It now names whose things `act` is about.
test('effect draws the line at the USER\'s things, not at the Irises boundary', () => {
  for (const t of [hermes, openclaw]) {
    const d = String(props(t).effect.description);
    assert.match(d, /change anything of THEIRS/);
    assert.match(d, /on its own setup so it can do the job is not that: it stays "read"/);
  }
});

// The kind guidance has to keep an acting ask out of the two read-only kinds, or the engine gets a
// brief shaped like a lookup for work it is supposed to perform.
test('kind guidance sends an ask carrying engine actions to general or compute', () => {
  for (const t of [hermes, openclaw]) {
    assert.match(String(props(t).kind.description), /carries engine_actions is work to be DONE, so it is 'general' or 'compute' — never web_research or document_read/);
  }
});

// `request` is a distillation, and a distillation is where a part of a two-part ask went missing.
test('request says distilling may change the wording and never the scope', () => {
  for (const t of [hermes, openclaw]) {
    assert.match(desc(t, 'request'), /changes the WORDING, never the scope/);
    assert.match(desc(t, 'request'), /every part of what they asked lands here or in engine_actions/);
  }
});

test('both lanes stay brand-free — no tool description ever names an engine', () => {
  for (const t of [hermes, openclaw]) {
    assert.doesNotMatch(t.description, /hermes|openclaw/i);
    for (const [key, def] of Object.entries(props(t))) {
      assert.doesNotMatch(String(def.description ?? ''), /hermes|openclaw/i, `${t.name}.${key} names an engine`);
    }
  }
});

// The envelope schema is the channel the descriptions actually reach the model through under
// toolsViaJson (the flat args union carries them), so pin that the lane choice flows through it.
function argDesc(tools: LlmToolDef[], key: string): string {
  const schema = buildEnvelopeSchema(tools) as {
    properties: { tool_calls: { items: { properties: { args: { properties: Record<string, { description?: string }> } } } } };
  };
  return String(schema.properties.tool_calls.items.properties.args.properties[key].description ?? '');
}

test('envelope schema: the hermes lane emits today\'s schema exactly, the openclaw lane carries the wider actions clause', () => {
  assert.deepEqual(buildEnvelopeSchema([hermes]), buildEnvelopeSchema([DELEGATE_TO_OPS_TOOL]));
  assert.match(argDesc([openclaw], 'meta_prompt'), /run real code/);
  assert.match(argDesc([openclaw], 'meta_prompt'), /parallel workers/);
  assert.doesNotMatch(argDesc([hermes], 'meta_prompt'), /run real code/);
  assert.match(argDesc([openclaw], 'kind'), /parallel workers/);
});

test('the lane choice never moves the persona head (the cached prefix stays byte-identical)', () => {
  // buildSystemPrompt(chatContext, contextBlock, activeOps, extraSection, tools, history, incomingText,
  //   agentTz, affectState, computed, capabilitySummary) — tools is the 5th param.
  const build = (tool: LlmToolDef) =>
    buildSystemPrompt(ctx, '', [], undefined, [tool], [], 'hey', undefined, undefined, undefined, null);
  const personaLen = convoPersonaChars();
  assert.equal(build(openclaw).slice(0, personaLen), build(hermes).slice(0, personaLen), 'persona head is byte-identical');
  // The widened prose does reach the model — it lives in the tool docs, inside <prompt>, after it.
  assert.match(build(openclaw).slice(personaLen), /parallel workers/);
});
