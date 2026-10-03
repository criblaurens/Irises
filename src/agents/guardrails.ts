// Output guardrails for anything heading OUT to the user.
//
// Charter (docs/PROMPTING_CHARTER.md): Law 12 / §10.1 "back unrecoverable rules with code" —
// a tool-name leak is classified unrecoverable (a brand reaches the user once and trust is
// dented), so it gets a deterministic backstop. §3 Invariant Core ("never name internal
// machinery"); §9.4 the deliberately triple-guarded hand-back.
//
// This is a TRIPWIRE, not the primary defense. The persona prompts are the primary defense;
// every warning logged below means one of them slipped and needs reinforcing (§10.1, §13).
//
// Policy: the user must never see the name of an internal agent/role, of the deep-work engine, or
// of the underlying model. Irises presents as ONE entity; the back-line roles ("Ops", "Reflexion"),
// the engines ("Hermes", "OpenClaw", "Claude Code"), the working vocabulary those engines narrate
// themselves in ("MCP tools", "subagents") and the model/provider names are all internal machinery.
// Irises's data sources — the web and the user's own email — are ordinary and fine to name, so there
// is no external data-vendor brand to scrub here. The agents may name their internal roles freely to
// EACH OTHER; this only rewrites text on its way to the user, so a model slip — or the
// composer-failure path that relays Ops's raw summary with no model in the loop — can never crack
// the single-entity seam.
//
// HARDCODED OFF (added later): the word-level scrubbing below now ships DISABLED — the master switch
// REDACT_INTERNAL_TOOLS is false, so redactInternalTools is a pass-through and none of the rules run.
// Nothing is removed: the rules and the engine (applyInternalToolRedactions) are kept intact for a
// fork to re-enable by flipping that one constant to true. The policy above describes what the
// scrubbing DOES when switched on, not what currently ships.
//
// Deliberately NOT scrubbed: "gateway". It is too ordinary a word (a gateway community, the gateway
// listing) and a real leak always co-occurs with "openclaw", which IS scrubbed — so gating it would
// buy nothing and cost false positives.

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

const INTERNAL_TOOL_REDACTIONS: RedactionRule[] = [
  // Tool names are machinery too. recall_memory is the one whose name a model is tempted to
  // SAY ("let me check recall_memory") because the turn is literally about remembering — to the
  // user that is just Irises's own memory. Matched as the IDENTIFIER only (underscore/hyphen):
  // the bare bigram "recall memory" is left alone so ordinary prose can never be mangled.
  { pattern: /\b(?:(?:my|the|our)\s+)?recall[_-]memory(?:\s+(?:tool|search|lookup))?\b/gi, replacement: 'my memory' },
  // "Reflexion" is a banned name — the memory curator. To the user, memory work is just
  // Irises remembering things; "my reflexion pass will tidy that up" cracks the seam the same way
  // "ops" does. One rule suffices: "my memory will tidy that up" reads naturally in every shape.
  { pattern: /\b(?:(?:my|the|our)\s+)?reflexion(?:\s+(?:agent|engine|system|process|pass|job))?\b/gi, replacement: 'my memory' },
  // Model/provider names — the "what model are you" leak ("i run on deepseek"). To the user Irises
  // is one entity, not a stack; admitting to being an AI is fine (persona rule), naming the model
  // never is. Two tiers: tokens with NO innocent chat meaning are scrubbed bare; "claude" (a
  // client's name), "gemini" (a zodiac sign) and "hermes" (the god, the handbag, the parcel courier)
  // are scrubbed ONLY in self-referential tech shapes, so "claude is coming by at 3", "she's a
  // gemini" and "hermes says the package lands tuesday" pass untouched.
  { pattern: /\b(?:deepseek|chatgpt|openai|openrouter|anthropic|gpt[-\s]?\d[\w.-]*|gpt)(?:['’]s)?\b/gi, replacement: 'AI' },
  // "Claude Code" is the deep-work engine's product name — a bigram with no innocent chat meaning of
  // its own, so it gets the bare tier, and it must sit ABOVE the gated "claude" rules so the bigram
  // wins before the client-name gate can decline. Accepted rare edge: a client named Claude standing
  // right in front of the word "code" ("claude code the lockbox for me") flattens to "AI" — cheap
  // next to the leak. "claude coded the fix" is safe: the \b after "code" refuses the "d".
  { pattern: /\bclaude[\s-]?code(?:['’]s)?\b/gi, replacement: 'AI' },
  { pattern: /\b((?:built|powered|running|based|trained)\s+(?:on|by)\s+)(?:claude|gemini|hermes)\b/gi, replacement: '$1AI' },
  { pattern: /\b(?:claude|gemini|hermes)(?:['’]s)?\s+(under\s+the\s+hood|behind\s+the\s+scenes)\b/gi, replacement: 'AI $1' },
  // "Ops" is the second banned name — the back-line agent — and "OpenClaw"/"Hermes", the deep-work
  // engines, crack the same seam in the same grammar ("ops is pulling that up", "openclaw came back
  // with the deadline"): to the user there is only Irises doing the work. The rules are ordered
  // most-specific-first and grammar-aware, so the common leak shapes degrade to first-person Irises
  // instead of garbled text. "openclaw" rides along in every shape (one token, no innocent meaning);
  // "hermes" only joins where a role noun makes the machinery reading unambiguous, so the courier and
  // the god keep their sentences. Bare "ops" is guarded against "co-ops" (cooperatives) by the hyphen
  // lookbehind; "oops"/"stops"/"workshops" never match \bops\b at all.
  { pattern: /\b(?:(?:my|the|our)\s+)?(?:(?:ops|openclaw)(?:\s+(?:engine|agent|team|side|system))?|hermes\s+(?:engine|agent|team|side|system))\s+is\b/gi, replacement: "i'm" },
  { pattern: /\b(?:(?:my|the|our)\s+)?(?:(?:ops|openclaw)(?:\s+(?:engine|agent|team|side|system))?|hermes\s+(?:engine|agent|team|side|system))\s+(came back|found|pulled|says|said|has|got)\b/gi, replacement: 'i $1' },
  { pattern: /\s+(?:off\s+)?to\s+(?:(?:my|the|our)\s+)?(?:ops|openclaw)(?:\s+(?:engine|agent|team|side|system))?\b/gi, replacement: '' },
  { pattern: /\b(?:(?:my|the|our)\s+)?(?:ops|openclaw|hermes)\s+(?:engine|agent|team|side|system)\b/gi, replacement: 'me' },
  { pattern: /(?<!-)\bops\b/gi, replacement: 'i' },
  // Whatever "openclaw" the grammar rules above didn't reshape is a leftover brand mention with no
  // sentence shape worth keeping ("i run on openclaw", "openclaw's run finished"), so it flattens to
  // "AI" like the model names. It sits BELOW those rules so the first-person degrade always wins, and
  // it is deliberately NOT folded into the bare ops→"i" rule: that would say "i run on i".
  { pattern: /\bopenclaw(?:['’]s)?\b/gi, replacement: 'AI' },
  // The engines also narrate their own plumbing in Claude-Code vocabulary ("i used an mcp tool",
  // "i spun up 3 subagents"); to the user, that is just Irises doing things. Both are context-gated,
  // because both words are ordinary here: bare "mcp" is a line item on a co-op form (monthly common
  // charges) and "subagent" is real-estate vocabulary in this deployment's own domain. The article
  // comes along on the singular so the rewrite reads like a person ("an mcp tool" → "a tool", never
  // "an my tools").
  { pattern: /\b(?:(?:an?|the|my|our)\s+)?mcp\s+(?:tool|server|integration|connector)\b/gi, replacement: 'a tool' },
  { pattern: /\b(?:(?:the|my|our)\s+)?mcp\s+(?:tools|servers|integrations|connectors)\b/gi, replacement: 'my tools' },
  // Verb-gated hard: only the spawn shapes are machinery. "my subagent showed the house" and "the
  // subagent gets half the commission" are ordinary co-broke talk and must pass through untouched.
  { pattern: /\b(?:spawned|spun\s+up|kicked\s+off)\s+(?:a\s+few\s+|\d+\s+|some\s+|several\s+)?(?:parallel\s+)?sub-?agents?\b/gi, replacement: 'worked a few angles' },
];

// HARDCODED master switch for the word-level scrubbing. Shipped OFF at the owner's request:
// redactInternalTools passes text through untouched, so a model/engine/tool name the persona says
// reaches the user verbatim. Nothing below is removed — the rules in INTERNAL_TOOL_REDACTIONS and the
// engine applyInternalToolRedactions() stay intact. A fork that wants the single-entity scrubbing back
// flips this one constant to true (no other change needed).
const REDACT_INTERNAL_TOOLS = false;

/**
 * The word-level rewrite engine: run every INTERNAL_TOOL_REDACTIONS rule over the text. Always applies
 * the rules regardless of the master switch — this is the preserved scrubbing logic, exported so it is
 * still exercised by the tests and directly callable by a fork that re-enables the feature. The shipped
 * path is redactInternalTools, which is gated OFF by REDACT_INTERNAL_TOOLS above.
 */
export function applyInternalToolRedactions(text: string): string {
  let out = text;
  for (const { pattern, replacement } of INTERNAL_TOOL_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Scrub internal tool names from a single piece of user-facing text. Idempotent and
 * safe to call on every outbound bubble. Logs once per hit so a leak that reaches this
 * far is visible (it means a persona prompt needs reinforcing), without throwing.
 *
 * HARDCODED OFF (REDACT_INTERNAL_TOOLS = false): currently a pure pass-through — the rewrite engine
 * applyInternalToolRedactions() is preserved but not applied. Flip the constant to re-enable.
 */
export function redactInternalTools(text: string | null | undefined): string {
  if (!text) return text ?? '';
  if (!REDACT_INTERNAL_TOOLS) return text;   // disabled by hardcode: replace nothing
  const out = applyInternalToolRedactions(text);
  if (out !== text) {
    console.warn('[guardrail] redacted an internal tool name from user-facing text');
  }
  return out;
}

// The SECOND user-facing invariant, backed by code for the same reason (§10.1): the Ops engine
// writes its result as a labeled, machine-shaped block — "ANSWER:", "SOURCE:", "FLAGS:",
// "NO RESULT:", and, for email findings, "Subject:"/"Sender:"/"Summary:" (see ops/Context.md).
// The Composer persona is supposed to strip every one of those and re-voice into Irises's chat
// voice. When that primary defense doesn't run — the composer-failure fallback that would relay
// Ops' raw summary with no model in the loop (orchestrator.composeFollowUp)
// — this is the deterministic tripwire that keeps the scaffolding off the user's phone.
//
// It does NOT re-voice (no third-person→second-person, no reshaping) — that stays the persona's
// job. It only removes the machine labels so a slipped summary can't land as a labeled block.
// Applied per line because the send path has already split the text into bubbles on newlines/---.

// Whole lines that are pure back-office machinery (the "how"/where the Composer always drops).
const OPS_DROP_LINE = /^\s*(?:SOURCE|FLAGS|ACTIONS)\s*:/i;
// Labels that prefix a real value — drop the label, keep the value.
const OPS_STRIP_LABEL = /^\s*(?:ANSWER|NOTICED|NO RESULT|SUMMARY|SUBJECT|SENDER)\s*:\s*/i;

/**
 * Strip an echoed holding line off the front of a composed reply. The Composer is handed Irises's
 * exact holding text ("checking your inbox for repair requests now") as a continuity anchor; a
 * literal-minded model sometimes RETYPES it and glues its answer on with no whitespace
 * ("...a Pine property nownothing under 'Pine'...", "checking your inbox nowokay i found it"),
 * which ships as one fused bubble — the line is already on the user's screen, so the echo doubles
 * it AND fuses the seam.
 *
 * A holding text is 1–3 bubbles (`---`-separated), and the model most naturally echoes its LAST
 * bubble (the line it was told to "continue straight from"), so we try the full text first, then
 * every individual bubble longest-first, and repeat until nothing more strips (an echo of bubbles
 * 2 then 3 peels off in two passes). A prefix must match an ENTIRE candidate — partial word reuse
 * is never touched — and if stripping would leave nothing, the reply is returned unchanged rather
 * than send blank. Logs on hit (persona-slip telemetry, §10.1/§13).
 */
export function stripEchoedHolding(reply: string, holdingText: string | null | undefined): string {
  if (!reply || !holdingText) return reply ?? '';
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/gi, '');

  // Cut `text`'s head if its normalized form starts with ALL of normalized `candidate`; null = no match.
  const stripPrefix = (text: string, candidate: string): string | null => {
    const target = norm(candidate);
    if (!target) return null;
    let matched = 0;
    let i = 0;
    for (; i < text.length && matched < target.length; i++) {
      const c = text[i].toLowerCase();
      if (!/[a-z0-9]/.test(c)) continue;         // separators/punctuation never break the match
      if (c !== target[matched]) return null;    // diverged: not an echo of this candidate
      matched++;
    }
    if (matched < target.length) return null;    // text is shorter than the candidate
    // Trim the seam: leftover whitespace, --- separators, and leading punctuation the echo left.
    return text.slice(i).replace(/^[\s\-–—.,:;!?]+/, '').trim();
  };

  // Full holding text first (strips the most), then each bubble longest-first.
  const bubbles = holdingText.split(/\s*---\s*|[\r\n]+/).map(s => s.trim()).filter(Boolean);
  const candidates = [holdingText, ...bubbles.sort((a, b) => b.length - a.length)];

  let out = reply;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const c of candidates) {
      const rest = stripPrefix(out, c);
      if (rest !== null && rest) {               // never strip down to blank
        out = rest;
        stripped = true;
        break;                                   // restart: the remainder may echo the next bubble
      }
    }
  }
  if (out !== reply) console.warn('[guardrail] stripped an echoed holding line from a composed reply');
  return out;
}

/**
 * Strip raw Ops summary scaffolding (ANSWER:/SOURCE:/FLAGS:/NO RESULT:/Subject:/Sender:/Summary:
 * labels) from a single piece of user-facing text. Idempotent, never throws, and safe to call on
 * every outbound bubble alongside redactInternalTools. Logs once per hit — a hit means the Composer
 * was bypassed and a persona/fallback path needs reinforcing (§10.1, §13). Never re-voices; only
 * removes the labels so a leaked scaffold degrades to plain text instead of a labeled block.
 */
export function stripOpsScaffolding(text: string | null | undefined): string {
  if (!text) return text ?? '';
  let hit = false;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (OPS_DROP_LINE.test(line)) { hit = true; continue; }        // SOURCE:/FLAGS: → drop the line
    const stripped = line.replace(OPS_STRIP_LABEL, '');            // ANSWER:/Subject:/… → keep value
    if (stripped !== line) hit = true;
    kept.push(stripped);
  }
  if (!hit) return text;
  console.warn('[guardrail] stripped raw Ops scaffolding from user-facing text');
  // Collapse blank lines a dropped SOURCE/FLAGS line may have left behind.
  return kept.join('\n').replace(/\n{2,}/g, '\n').trim();
}
