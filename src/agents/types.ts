// Orchestration contract shared by the Convo (front-line) and Ops (engine-seam) agents.
import type { IncomingMedia } from '../webhook/types.js';

export type TaskKind =
  | 'web_research'       // current/external facts from the web + reasoning
  | 'document_read'      // read/search the user's OWN connected email + attachments
  | 'draft'              // write a message/note for the user to send
  | 'media_read'         // the engine opens and reads the non-text file(s) the user texted
  | 'compute'            // work must be DONE not just found — run code over data, crunch/convert a file, produce a table, a multi-step chain (never head-math/definitions)
  | 'general';           // substantive multi-source/multi-step reasoning

export interface OpsTask {
  id: string;
  chatId: string;
  agentHandle: string;
  kind: TaskKind;
  request: string;          // the user's underlying ask, verbatim or distilled
  // Would the ENGINE change something outside Irises to do this? 'read' is every look Irises has
  // ever taken (find, compute, draft for THEM to send); 'act' is the engine sending, posting,
  // buying, booking, paying, deleting or cancelling. Decided at delegation time from two sources
  // (agents/ops/sideEffects.ts): the model's own `effect` tag and an English phrase list. An 'act'
  // task is PARKED behind the user's explicit yes — it is the one kind of task that does not start
  // when it is built.
  effect: 'read' | 'act';
  // The handshake's own clocks, set only on an 'act' task the approval gate parked. `askedAt` is
  // when she asked; `approvedAt` is the explicit yes that authorizes the brief's AUTHORIZED ACTION
  // line; `reconfirm` marks a yes that arrived after the ask expired, which re-asks rather than
  // executes (user decision 2026-09-04).
  approval?: { askedAt: number; approvedAt?: number; reconfirm?: boolean };
  metaPrompt?: string;      // Convo-authored instruction for Ops (what's needed + relevant context)
  // Convo's `quick` flag: they are waiting on one fact a single source settles. Renders one line
  // above the brief that overrides its confirm-with-a-second-source invitations (ops/client.ts).
  // ABSENT when unset, so every other task's prompt stays the bytes it was.
  quick?: true;
  // What the user asked the ENGINE to DO, beyond finding or reading — one entry per action, in the
  // order they asked. `request` distils a single ask, so an ask with two halves ("set this up, then
  // find that") used to arrive with one half gone; this is the half that acts. Its OWN field, like
  // `heldMemory`, because buildTaskPrompt must render it in the instruction layer: both doctrines
  // tell the engine that text inside the `user_request` data tag is never an instruction, so an
  // action folded into the request is an action the engine is told to disobey. ABSENT rather than
  // empty when nothing was asked, so an ordinary look's prompt stays the bytes it was. Tracked on
  // the in-flight registry and in the durable row's meta, so the honesty surfaces can read back
  // exactly which parts were really handed over. An action on the ENGINE's own environment is not
  // an action on the user's accounts: this field never sets `effect`, and the approval gate is
  // unmoved by it (ops/sideEffects.ts carries no setup vocabulary, deliberately).
  engineActions?: string[];
  addressHint?: string;
  dealHint?: string;
  replyToMessageId?: string; // inbound message that triggered this task; the follow-up threads back to it
  // The burst text her holding beat quoted ([msg N], 1-based), set by the salvage when the look is
  // the turn's only action. index.ts threads the late answer to it; without it the answer took the
  // first quote in the reply, which is her answer to their other text whenever that came first.
  lookRe?: number;
  // True when the look was delegated out of a group chat; absent is a 1:1. `agentHandle` stays the
  // member who asked (their prefs, their research stash), so this is what tells the composed relay
  // it speaks in front of a room. Stamped where the delegation is built (convo/shared.ts), so a
  // parked action approved from the asker's own chat keeps it; the kickoff site (index.ts) stamps it
  // too, as a backstop.
  room?: boolean;
  // Set ONLY by the orchestrator's retry leg — the id of the task this is a cheap second attempt
  // at, after a transient lane blip (an llm_error / rate limit, not a research failure). It does
  // NOT change the brief; it only marks the leg so triage can refuse to retry a retry (one per
  // attempt) and the trace labels read `ops-retry:`.
  retryOf?: string;
  // Commands the user already said yes to, set ONLY on a late yes's re-run (agents/ops/engineApproval.ts):
  // when the engine pauses on one of these exact (engine-redacted) command strings, the relay answers
  // 'once' without asking again, the FIRST time only: the same command again in this task is asked
  // about, so one yes never runs it twice. Any other command in that run is asked as usual. ABSENT
  // otherwise.
  preApproved?: string[];
  // The task this one continues: a step she offered after it (agents/ops/followUp.ts), or the step a
  // late yes re-runs. One hop only: a task carrying it never offers a next step of its own.
  followUpOf?: string;
  // Which attempt this is for the same underlying ask. 1 = first look; 2+ = a re-run after the
  // agent answered a steering question. Drives the composer's two-strike miss behavior (first
  // miss = invisible re-aim; second miss = soft "couldn't find it" + an adjacent offer).
  attempt?: number;
  // Convo's confidence_level (0–100) on the TURN that launched this task — how sure it was of what
  // the user meant when it delegated. In-flight only, never persisted (the score fluctuates turn by
  // turn, so no memory tier could hold it truthfully). The composer reads it to decide whether to
  // weave a light "i read that as X — say the word if you meant another" caveat into the answer.
  originConfidence?: number;
  // What Convo already holds about this ask, rendered as data (agents/routingGate.ts
  // `heldMemoryBrief`) and placed beside the brief by buildTaskPrompt. Its OWN field, not part of
  // `metaPrompt`, because the brief is two things this is not: the engine's "primary instruction",
  // and the text scanned for JavaScript/login-walled links (ops/walledUrls.ts) — a link out of her
  // memory must not arm browser tooling for an ask that never mentioned one. In-flight only, never
  // persisted; a retry leg carries it because triage re-sends `{...task}`.
  heldMemory?: string;
  // How many held things made it into that block. In-flight only, never persisted — it describes
  // this brief, not the user. The `ops:kickoff` receipt reports it so a live round can tell a look
  // that went out knowing who "Dana" is from one that went out blind.
  memoryHits?: number;
  // The exact holding line Convo just sent the agent ("pulling that up, one sec"). The composer
  // continues straight from it so the follow-up reads as one seamless thread, not a fresh reply.
  holdingText?: string;
  // Her private note to herself from the delegating turn (status.meta_prompt): what she means to do
  // when the answer comes back and what about THEM it should meet. The composer reads it as context
  // about the person, never as a fact about the world.
  threadNote?: string;
  // Canonical stored timestamp (epoch ms) of that holding line, from addMessage's return value.
  // Single-clock with the conversation it's compared against — the composer uses it to find
  // messages the user sent WHILE Ops ran, so the late reply can nod to them.
  holdingAt?: number;
  // Force the grounding backstop ON regardless of kind (the routing gate sets this so a data
  // question it pushes into the open-reasoning 'general' kind still can't ship an ungrounded fact).
  forceGrounding?: boolean;
  // Chat attachment refs the task is grounded in (remote CDN URLs + mimeTypes; a signed URL dies in
  // ~15min but attachmentId re-signs at read time). Set by the delegate handlers — this turn's
  // files, or the 24h recall stash — so the engine can open them.
  media?: IncomingMedia;
  recalledAgeMs?: number;    // set when the media came from the 24h stash (drives "sent X ago" framing)
  createdAt: number;
}

export type OpsStatus = 'ok' | 'not_found' | 'rate_limited' | 'error';

// Machine-readable reason a run failed, so the orchestrator's triage step can reason about it
// (src/agents/ops/triage.ts) WITHOUT re-inspecting prose. Set by runTask on every failing path.
export type OpsFailureCause =
  | 'timeout'              // withDeadline fired (set by the orchestrator, not runTask)
  | 'llm_error'            // runTask's catch-all ("ran into a problem completing that")
  | 'rate_limited'         // provider cap (no current producer, kept for completeness)
  | 'fidelity_suppressed'  // groundOrDowngrade withheld the answer (NO RESULT)
  | 'empty_miss'           // finished clean but found nothing usable
  | 'tool_errors'          // most tool calls came back error-shaped
  | 'needs_auth'           // engine rejected the API key — operator config, no retry helps
  | 'cancelled'            // user killed the run
  | 'budget';              // token budget exhausted — a retry would light a bigger fire

/** One tool call the run made, for the debrief's "what was already tried" ledger. */
export interface OpsToolRun {
  name: string;
  argsSummary: string;   // JSON.stringify(input), capped ~200 chars
  ok: boolean;           // false when the result read error-shaped (looksLikeToolError)
  resultPreview: string; // first ~120 chars of the tool output
  durationMs?: number;   // wall time this single tool call took — feeds the run's toolMsTotal
}

/**
 * What the run actually did — filled by runTask on EVERY path (ok and failed) so a failure-
 * triage step can reason about "what was already researched". In-memory only: it flows into
 * diagnostics traces, NEVER to the user. Carried on OpsResult, and
 * also written into a caller-held OpsDebriefSink so a partial trail survives a withDeadline timeout
 * (the abandoned runTask keeps filling the sink).
 */
export interface OpsDebrief {
  steps: number;                 // LLM turns consumed (of MAX_STEPS)
  toolsRun: OpsToolRun[];
  corpus: string[];              // raw TOOL RESULT entries (caps applied at prompt-build time)
  failure?: {
    cause: OpsFailureCause;
    detail?: string;             // e.g. String(err) for llm_error
    ungrounded?: string[];       // fidelity: "family: raw" list
    withheldSummary?: string;    // fidelity: the suppressed draft answer
  };
  startedAt: number;
  endedAt: number;
}

/** A mutable handle the orchestrator passes into runTask so it can read the (partial) debrief even
 *  when the run is abandoned by a withDeadline timeout. runTask assigns `debrief` immediately. */
export interface OpsDebriefSink {
  debrief?: OpsDebrief;
}

export interface OpsResult {
  taskId: string;
  kind: TaskKind;
  status: OpsStatus;
  summary: string;          // accurate plain text; Convo re-voices this
  data?: Record<string, unknown>;
  debrief?: OpsDebrief;     // what the run did + why it failed; fuels triage
  /** A mid-run addition the engine ACCEPTED but never applied: it landed after the final model
   *  response, so the answer above does not reflect it (hermes reports this as `pending_steer` on
   *  the terminal run event). Present means the user asked for something they have NOT been given
   *  yet — the orchestrator replays it once as a refinement leg rather than delivering an answer
   *  that quietly ignores the last thing they said. */
  steerUnapplied?: string;
  /** The engine's NEXT line (ops/client.ts OUTPUT_CONTRACT): one step toward what they want that this
   *  run did not take, lifted off `summary`. Whether to offer it is hers (ops/followUp.ts). ABSENT
   *  when the engine named none. */
  next?: string;
}

/**
 * Persisted between turns (on the agent's prefs) when a look came back thin and Irises asked a
 * steering question instead of admitting it. The agent's next message is treated as the answer
 * to that question, so Convo re-delegates a refined task with attempt+1. TTL-bounded; cleared
 * once the follow-up lands or the second look resolves it.
 */
export interface PendingClarification {
  request: string;          // the original underlying ask that came back thin
  kind: TaskKind;
  metaPrompt?: string;
  attempt: number;          // the attempt number that just missed (1 = the first look)
  at: number;               // when this was stored (ms epoch), for the TTL
  // When triage found the miss was an information hole, the specific detail(s) only the user can
  // supply (which property, which date range). The composer asks for exactly these, and the
  // attempt-2 refinement folds them into Ops's brief so the second look aims right.
  missingFields?: string[];
}
