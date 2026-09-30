import { runTask, legBudgetFor } from './ops/client.js';
import { withDeadline, DeadlineError } from './deadline.js';
import { setPreference } from '../db/repositories/memory.js';
import { addShortTerm } from '../db/repositories/memoryShort.js';
import { composeWithComposer } from './composerCore.js';
import { markOpsDone, isOpsCancelled, noteOpsProgress, markOpsRetry, getOpsEtaStatus, getOpsEngineActions, getUnappliedSteers, normalizeRequest } from '../state/opsCoordination.js';
import { detectCause, decide, splitMiss, retryTaskFor, steerReplayTaskFor, type TriageDecision } from './ops/triage.js';
import { selectInterveningUserMessages } from './interveningMessages.js';
import { redactInternalTools } from './guardrails.js';
import { getEngineBackend } from './ops/engineBackend.js';
import { voiceOutcome } from './fallfirm/client.js';
import { type Outcome } from './fallfirm/floor.js';
import { voiceInstant, type VoiceInstantOpts } from './fallfirm/voiceInstant.js';
import { type PingBudget, ProgressGate, runPingCycle } from './progressGate.js';
import { record } from '../diagnostics/trace.js';
import { peekPendingInbound, selectUnseenPending } from '../state/inboundGlance.js';
import type { SpeakContent, SpeakOpts, SpeakResult } from '../state/mouth.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { OpsTask, OpsResult, OpsDebrief, OpsDebriefSink } from './types.js';
// Slim note: proactive follow-ups no longer materialize locally — the ENGINE owns scheduling
// (its cron fires and delivers back through the /api/engine/push endpoint), so the old
// data.followups → automations path is gone along with the automations table itself.

// The mouth contract (state/mouth.ts, implemented by index.ts): `content` may be pre-voiced text or
// a voicer thunk that runs only once it owns the per-chat lock — the freshness guarantee every
// follow-up below leans on. 'dropped' means a staleness guard suppressed the send (that is a
// deliberate outcome, not a failure).
export type SendFollowUp = (chatId: string, content: SpeakContent, opts?: SpeakOpts) => Promise<SpeakResult>;

// Hard deadline on one Ops run — `legBudgetFor(task)` below, read once per leg. Without a deadline
// a hung tool HTTP call or a slow multi-step loop leaves the user's holding text dangling FOREVER —
// they sit waiting until they ask "how's it going?". On timeout the normal catch below sends the
// honest snag line and `finally` clears the in-flight marker, so a re-ask runs fresh.
//
// PER LEG, not per process: legBudgetFor (ops/client.ts) reads OPS_TASK_TIMEOUT_MS for an ordinary
// task and the wider walled-URL browser budget for a task the engine was told to open a page for —
// browser work that legitimately runs 6-15 minutes must not be abandoned at 4 with the answer
// already on its way back. Unarmed, it returns the same OPS_TASK_TIMEOUT_MS reading as before.
//
// Whichever leg budget is in play, it sits UNDER opsCoordination's staleness horizon, which is what
// keeps "still on it" wording, the ETA and the in-flight dedup truthful for a task's whole lifetime.
// That relationship is now DERIVED rather than hoped for: `opsStaleMs` (state/opsCoordination.ts) is
// the widest configured leg budget — this deadline or the wider browser one — plus its slack, so
// arming a 15-minute browser budget widens the horizon with it. It used to be a flat five minutes,
// and an armed browser run went silent at five while it was genuinely still working.

/** Combine the user-cancel signal with an internal one (a per-leg timeout abort) so aborting EITHER
 *  stops the run. Used so a timed-out primary Ops leg is actually torn down at its next step check —
 *  instead of running its tool loop concurrently with a retry leg for minutes. */
function combineSignals(user: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (!user) return internal;
  if (typeof (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return AbortSignal.any([user, internal]);
  }
  const c = new AbortController();
  if (user.aborted || internal.aborted) c.abort();
  else {
    const onAbort = () => c.abort();
    user.addEventListener('abort', onAbort, { once: true });
    internal.addEventListener('abort', onAbort, { once: true });
  }
  return c.signal;
}

// What this turn actually is, from the agent's point of view (never the machinery's):
// a real answer to hand over, a look that came back with nothing usable, or a transient snag
// (timeout / rate limit / crash) where the ASK was fine but the run failed — that last one must
// NOT read as the miss re-aim ("which one did you mean?").
type ComposeMoment = 'answer' | 'miss' | 'transient' | 'needs_info';

// Ops's own "I came up empty" fallback strings (see ops/client.ts). When a summary IS one of
// these — or is empty — there is no real answer to hand over, so it's a miss even though the
// status is 'ok'. Lowercased, trimmed compare. (This is the seam, not a leak scrubber: it gives
// the composer an honest signal so it never gets told garbage is "a verified answer, relay it".)
const OPS_NON_ANSWERS = new Set([
  'no result',
  // NOTE: 'ran into a problem completing that' (the runTask catch-all crash string) is
  // deliberately NOT here — it always rides status:'error' and must classify as 'transient' (an
  // infra snag), not a miss.
]);

function classifyResult(result: OpsResult): ComposeMoment {
  const s = (result.summary ?? '').trim();
  // error/rate_limited = the run FAILED (crash, timeout, provider cap), not "nothing found" — voice
  // as a transient snag, distinct from the miss re-aim. EXCEPT the vision "couldn't read the photo"
  // failures, which ARE a miss (ask the user to resend), not an infra hiccup — so let those fall
  // through to the OPS_NON_ANSWERS check below.
  if ((result.status === 'error' || result.status === 'rate_limited') && !OPS_NON_ANSWERS.has(s.toLowerCase())) {
    return 'transient';
  }
  if (result.status !== 'ok' && !OPS_NON_ANSWERS.has(s.toLowerCase())) return 'miss'; // not_found
  if (s.length < 3) return 'miss';                         // empty / single token
  if (OPS_NON_ANSWERS.has(s.toLowerCase())) return 'miss'; // Ops's explicit "came up empty"
  // The explicit seam for an LLM-authored empty-handed summary: the Ops persona starts those
  // with "NO RESULT:" (possibly inside its ANSWER: framing). Not keyword sniffing — it's a
  // declared protocol between the two agents.
  const lower = s.toLowerCase();
  if (lower.startsWith('no result') || lower.startsWith('answer: no result')) return 'miss';
  return 'answer';
  // Note (charter §10.2 / plan RR#1): a long but content-free / reasoning-shaped summary still
  // reads as 'answer' here; the composer's own fidelity gate ("one concrete fact you'd stake your
  // name on?") is the backstop for that. We deliberately don't try to detect garbage by keyword.
}

// Inert private note telling the composer which beat it's on. Must stay BYTE-IDENTICAL to the
// "which beat you're on" reference in composer/Context.md — Haiku keys off the surface form, and
// the wording is deliberately harmless if it ever slips into a bubble (plan RR#3).
const BEAT_FIRST = '(just making sure)';
const BEAT_SECOND = "(couldn't get that one)";

/**
 * Compose Irises's user-facing follow-up. The composer persona (src/agents/composer/Context.md)
 * carries all the HOW — fidelity, bubble splitting, the seamless voice, the two-strike miss
 * behavior. This just hands over what came back as Irises's OWN finding, in machinery-free words,
 * and (for a miss) the inert beat note. Facts come only from `instruction`, placed last.
 */
/**
 * The clause that keeps a required engine action from vanishing on the way to the user.
 *
 * The composer persona drops the ACTIONS line the way it drops SOURCE — correctly, for the ordinary
 * run, where what the engine DID is back-office nobody asked about. It is exactly wrong for a task
 * that carried `engineActions`: the user asked for those, was told they were on their way, and a
 * failed one that gets dropped as back-office becomes a promise nothing ever keeps.
 *
 * The other moments matter as much. A miss, a snag or a steering question hands the composer no
 * result content at all, so nothing there would stop a reply that reads as if the setup had gone
 * through. Returns '' for a task that carried none — the overwhelming majority — so the instruction
 * those compose from stays exactly what it was. Pure; exported for unit tests.
 */
export function engineActionRelay(task: OpsTask, moment: ComposeMoment, summary = ''): string {
  const n = task.engineActions?.length ?? 0;
  if (!n) return '';
  const count = n === 1 ? '1 thing' : `${n} things`;
  if (moment !== 'answer') {
    // Silence is what this whole branch exists to stop: she promised a setup and the promise simply
    // went missing. So the only two options are both spoken ones.
    return `\n\nthey also asked you to get ${count} set up as part of this, and nothing came back saying they were done — so never word this as if they were. give it one flat clause that it hasn't landed, no guess about why, and don't dwell on it.`;
  }
  // The engine owes a report per item on the ACTIONS line, and an answer without one has reported
  // nothing about the setup. Telling the composer to work every action into the answer from that
  // would be asking it to invent an outcome — the same failure as the claim this branch started on,
  // one layer further out.
  if (!/^\s*ACTIONS\s*:/m.test(summary)) {
    return `\n\nthey also asked you to get ${count} done as part of this, and what came back carries no report on them at all — so you do not know whether any of it happened. give it one flat clause: say plainly that you don't have confirmation on that part yet and you'll say when you do. never imply it landed, and never guess.`;
  }
  return `\n\nbeyond the question, they asked you to get ${count} done as part of this. whether each one landed is part of their answer, not back-office you drop: work it in as one short plain clause, in their words not the machinery's. if one of them did NOT land, say so plainly and say what stopped it, before you hand over the rest. never let one go unmentioned, and never claim more than what came back says happened.`;
}

/**
 * The clause that keeps an addition the look never took in from being answered as if it had.
 *
 * A mid-run addition (steer_research) that the run could not take, or that arrived after its leg
 * ended, is kept with the task and never reached the engine. The live turn said so plainly, and
 * promised nothing: the answer that comes back was gathered without it. So the follow-up must not
 * read as though it covers the addition. Returns '' when every addition landed, which is nearly
 * always, and outside the answer moment, where there is no answer to over-claim. Pure and exported,
 * like engineActionRelay.
 */
export function steerRelay(unapplied: readonly string[], moment: ComposeMoment): string {
  if (moment !== 'answer' || !unapplied.length) return '';
  const said = unapplied.map(s => `"${s}"`).join('; ');
  return `\n\nwhile you were looking they also added: ${said}. the look already under way could not take that in, so what came back may not cover it. never word the answer as if it does, and if it doesn't cover it, say so in one flat clause.`;
}

async function composeFollowUp(
  result: OpsResult,
  task: OpsTask,
  moment: ComposeMoment,
  extras: { missingFields?: string[]; giveUp?: boolean } = {},
): Promise<string> {
  const { chatId, agentHandle: handle } = task;
  const attempt = task.attempt ?? 1;

  let instruction: string;
  if (moment === 'needs_info') {
    // Triage found the ask is genuinely under-specified — only they can fill it in. Same two-strike
    // marker as a miss (their reply flows back as the refinement), but the question is AIMED: ask for
    // exactly these details. Framed as Irises mid-look needing a steer, never as anything failing.
    const fields = (extras.missingFields ?? []).filter(Boolean).join('; ');
    instruction = `${BEAT_FIRST}\nwhat they wanted you to look into: "${task.request}"\nto pin this down you need one specific thing only they can give you: ${fields}. ask for exactly that as your OWN natural question, like you're mid-look and just need their steer — "which address is the martinez one under?" energy. one short bubble, ending on the question. never mention anything not working, anything you tried, or any process behind the curtain.`;
  } else if (moment === 'miss') {
    // No failure content is handed over — only the inert beat note and their own ask, so the
    // composer can aim a steering question (first beat) or offer a real adjacent thing (second).
    // giveUp (a triage "no productive retry" verdict, e.g. unanswerable) takes the soft second beat
    // regardless of attempt — never re-interrogate when we already know asking more won't help.
    const beat = (attempt >= 2 || extras.giveUp) ? BEAT_SECOND : BEAT_FIRST;
    instruction = `${beat}\nwhat they wanted you to look into: "${task.request}"`;
  } else if (moment === 'transient') {
    // The run itself failed (timeout / rate limit / crash) — the ASK was fine. Tell them honestly
    // that YOU hit a snag and will get back to it, and DON'T ask them to restate the question (that
    // wrongly implies they were unclear). No fact content to relay.
    // The retry ladder is already spent by the time this composes (triage ran it), so nothing here
    // may promise another try. The engine's own name is the one piece of machinery she may name: it
    // is their install, and "it acted up" is the true reason.
    const engine = getEngineBackend()?.name ?? 'hermes';
    instruction = `the look itself broke on your end this time (a timeout or a hiccup; the ask was fine and none of it is on them). own it in one flat line, the size of what you promised when you left. you may say it was their ${engine} acting up, named as theirs ("your ${engine}"), never ops, an engine, a system or a model, and never the technical detail. then leave them something of yours: your own take on what they asked, plainly as your guess and never as a finding, or where your head goes on it given what you know about them. a heavy ask gets a careful plain line and no joke. never tell them to nudge you, ping you, ask again or rephrase, and never promise another try. what they wanted: "${task.request}"`;
  } else {
    // Selection framing, not inventory framing: the composer gets THE QUESTION next to the result,
    // answers that, and holds the rest as one offer. "exactly as written" scopes fidelity to the
    // facts it relays — without the question here, a rich Ops pull reads as "relay all of this".
    instruction = `here's what you came back with. what they asked: "${task.request}". answer THAT, told to them: the part that meets them leads, a couple of bubbles, not a report. anything in here that's true but beside their question, hold it — no mention of what else you hold, and never a "want me to?" question. after the answer, one line that hands the thread back if the moment earns one, or none. whatever you do relay — every number, date, name, ~ and maybe — stays exactly as written:\n\n${result.summary}`;

    // The read behind this look was shaky: Convo scored its comprehension of the ask below the
    // clean-delegation band when it launched. The answer is still real — but it answers Convo's
    // READING of the question, so the user deserves one light "here's what i looked at" caveat and
    // an open door to re-aim. In-flight signal only (task field), never from memory.
    if (typeof task.originConfidence === 'number' && task.originConfidence < 60) {
      instruction += `\n\none more thing about this one: when you started this look you were only partly sure what they meant (you read it as "${task.request}"). so as you answer, make WHICH thing you looked at unmistakable — name the deal/property/document in your first or second bubble, the way a person says "so for the maple st contract..." — flat, no opening added, no apology tour: never say you were unsure, never mention scores, checks, or anything behind the curtain. the facts themselves stay exact as always.`;
    }
  }

  // What they asked to have DONE as well as found. Appended for every moment, because the moments
  // that hand the composer no result content are exactly the ones where a reply could read as if the
  // setup had gone through. Empty for a task that carried none.
  instruction += engineActionRelay(task, moment, result.summary ?? '');
  // And what they ADDED mid-run that the look never took in. Empty on almost every run.
  instruction += steerRelay(getUnappliedSteers(chatId, task.id), moment);

  // Continue straight from the exact holding line Irises last sent, so the late reply reads as one
  // seamless thread, not a fresh delivery. This is a continuity anchor only — never a fact source.
  // The continuation is SEMANTIC, spelled out hard: a literal-minded model used to retype the
  // holding line and glue its answer on with no whitespace ("...a Pine property nownothing under
  // 'Pine'..."), which shipped as one fused bubble. composerCore's stripEchoedHolding pass (fed the
  // same holdingText below) is the code backstop.
  if (task.holdingText) {
    instruction += `\n\nthe last thing you said to them is below: the move you made when you left, and your reply is its payoff. it's ALREADY on their screen — never retype it or any part of it. your reply is the next text after it: fresh words that pick up where it left off, not a continuation of its sentence:\n"${task.holdingText}"`;
  }
  // Her own note from the delegating turn: what she read about them and what the answer should be
  // told against. Context about the PERSON only; the result above stays the one fact source.
  if (task.threadNote) {
    instruction += `\n\nthe note you left yourself when you went to look (context about them and how you meant to come back, never a fact about the world): "${task.threadNote}"`;
  }

  // How long they actually waited on the holding line (single app clock: task.createdAt and now
  // are both stamped by this process). Most looks land in seconds-to-minutes and deserve no
  // mention; past 10 minutes the composer is told the look ran long — and told to say NOTHING about
  // it. The gate stays because the note only makes sense on a real wait; the duration is gone
  // because a wait she names is a wait she made theirs to absorb.
  const waitMs = Date.now() - task.createdAt;
  if (waitMs > 10 * 60_000) {
    instruction += `\n\nthis look ran long on your end. deliver the answer flat: no apology, no nod to the wait, never a duration.`;
  }

  try {
    // The assembly itself (voice window, composer memory layer, <prompt> wrapper, format anchor
    // last, two-attempt ladder, echo tripwire) lives in composerCore.ts — shared with the proactive
    // path. Everything above is the framing this moment needs; the callback below adds the two
    // clauses that can only be written once the history is in hand.
    return await composeWithComposer({
      chatId,
      handle,
      buildInstruction: history => {
        let text = instruction;

        // Messages the user sent WHILE Ops ran (after the holding line). Computed over the FULL
        // fetched history (not the sliced voice window, so a long burst can't push them out) and on
        // a SINGLE clock. If any exist, tell the composer to nod to them, but ONLY as context: every
        // fact still comes from the result.
        const intervening = selectInterveningUserMessages(history, task.holdingAt);
        if (intervening.length) {
          text += `\n\nwhile you were looking they also texted you (this is CONTEXT, never a fact source): "${intervening.join(' / ')}". give it one light, natural nod — if it's just an ack ("ok"/"thanks"), don't belabor it, just deliver. every figure, date and name still comes ONLY from above; never treat their texts as facts.`;
        }

        // Texts that arrived so recently they haven't even entered history yet (still in the inbound
        // settle queue / mid-processing) — invisible to the window above, but ON THE USER'S SCREEN.
        // Without this glance the reply reads as if their newest texts don't exist. They are NOT
        // answered here (the live thread picks them up next turn, and answering would double-say);
        // the composer just must not compose blind to them.
        const pendingNow = selectUnseenPending(peekPendingInbound(chatId), history).slice(0, 4);
        if (pendingNow.length) {
          text += `\n\njust now — while you're typing this — they sent: "${pendingNow.join(' / ')}" (CONTEXT only, never a fact source). you haven't answered those yet and this reply is NOT the place: you're mid-delivery, and the live thread picks them up next, so don't answer them and don't promise anything about them. deliver what you found; only if one of them clearly changes what they want from THIS answer, add one short beat that you saw their newer text and it's next.`;
        }
        return text;
      },
      holdingText: task.holdingText,
      room: task.room,
      trace: { chatId, handle, taskId: result.taskId, label: 'composer' },
      errorDetail: { moment },
    });
  } catch (err) {
    console.error('[orchestrator] composeFollowUp failed — handing to Fallfirm', err);
    // The composer's own attempts failed. Fallfirm is the second-chance voicer: it re-voices the
    // outcome in Irises's tone (a fresh, simpler call often succeeds where the composer's did not),
    // and if IT fails too, voiceOutcome drops to the hardcoded floor. We never relay result.summary
    // here (raw ANSWER/SOURCE/FLAGS); Fallfirm gets a description of the SITUATION, not the facts —
    // for 'answer' the real facts are already stashed in recent_research and answered on the re-ask.
    let outcome: Outcome;
    if (moment === 'needs_info') {
      const fields = (extras.missingFields ?? []).filter(Boolean).join('; ');
      outcome = { kind: 'nothing_found', summary: `you need one specific thing from them to finish: ${fields}`, nextStep: 'ask for exactly that, naturally, as your own question', originalRequest: task.request };
    } else if (moment === 'miss') {
      outcome = (attempt >= 2 || extras.giveUp)
        ? { kind: 'nothing_found', summary: "couldn't track that one down after a couple looks", nextStep: 'stop there, one line, no offer', originalRequest: task.request }
        : { kind: 'nothing_found', summary: 'you need them to narrow down which one they mean', nextStep: 'ask a short steering question (which one exactly)', originalRequest: task.request };
    } else if (moment === 'transient') {
      outcome = { kind: 'failed', summary: 'you hit a snag pulling this up on your end (not their fault)', nextStep: 'own it in one flat line and leave them your own quick take on what they asked, said as a guess; never ask them to ping, nudge or ask again', originalRequest: task.request };
    } else {
      outcome = { kind: 'failed', summary: 'you have their answer but sending it glitched on your end', nextStep: "tell them to ping again and you'll fire it right over" };
    }
    return voiceOutcome(outcome, chatId, handle);
  }
}

/**
 * Fire-and-forget: run the delegated Ops task, then send a re-voiced follow-up.
 * Never rejects: all errors are handled so the floating promise is safe.
 */
export async function runOpsAndFollowUp(task: OpsTask, sendFollowUp: SendFollowUp, signal?: AbortSignal): Promise<void> {
  // "Waiting on Ops" reassurances are for a GENUINELY long wait ONLY — the holding text ("one sec,
  // pulling that fresh") already covers short and normal runs. User directive: at most 3 messages per
  // task (holding + 1 mid-run update + final). The mid-run update fires only after 5 minutes of
  // silence, with at least 5 minutes between pings, and a hard cap of 1 per run. Without this
  // restraint runTask fires an onProgress for EVERY tool call, so a multi-tool run spilled its whole
  // play-by-play into the chat. The ProgressGate is the one throttle both the tool milestones and
  // the fallback heartbeat pass through, and the gate freezes the instant Ops settles. A shared
  // PingBudget across legs enforces the run-wide cap. Sends ride the per-chat mouth (unpaced, but
  // NEVER the lock-bypassing 'critical' lane — that could split a live reply's bubbles); a ping that
  // queues behind the eventual answer or a live reply is DROPPED by the mouth's staleness guards
  // instead of landing late.
  const PROGRESS_QUIET_MS = Number(process.env.OPS_PROGRESS_QUIET_MS || 300_000); // silence for the first 5 min
  const PROGRESS_GAP_MS = Number(process.env.OPS_PROGRESS_GAP_MS || 300_000);     // then once every 5 min
  const MAX_PROGRESS_PINGS = Number(process.env.OPS_MAX_PROGRESS_PINGS || 1);

  // One budget for the entire run — the primary and retry legs draw from the same pool, so the total
  // mid-run update count can never exceed MAX_PROGRESS_PINGS regardless of how many legs fire.
  const pingBudget: PingBudget = { remaining: MAX_PROGRESS_PINGS };

  // Per-leg ping machinery. Each leg (primary, then the cheap retry) gets its OWN gate, so
  // when the primary run is abandoned by a timeout its still-running loop's late onProgress calls hit
  // a stopped gate and are suppressed — they can never leak a ping for a discarded result. The gate
  // throttles FIRST, then runPingCycle voices + re-checks isStopped before sending (see progressGate).
  const makePings = (quietMs: number) => {
    const gate = new ProgressGate({ quietMs, gapMs: PROGRESS_GAP_MS, maxPings: MAX_PROGRESS_PINGS, budget: pingBudget });
    const voiceAndPing = (kind: VoiceInstantOpts['kind'], key: string): Promise<void> =>
      runPingCycle(
        gate, key,
        () => {
          // The ETA the user was already promised at delegation time — read, never re-derived, so a
          // ping can only repeat that number or say less (never a fresh, contradicting one).
          const status = getOpsEtaStatus(task.chatId, task.id);
          const eta = status ? { phrase: status.phrase, state: status.state as 'early' | 'closing' | 'overrun', remainingPhrase: status.remainingPhrase } : undefined;
          return voiceInstant({ kind, request: task.request, addressHint: task.addressHint, dealHint: task.dealHint, eta }, task.chatId, task.agentHandle);
        },
        text => {
          // A cancel_research that landed while this ping was being voiced must suppress it too — a
          // "still on it" / "taking a harder look" beat after the user asked for silence is a
          // contradiction (the gate's isStopped check doesn't observe cancellation).
          if (isOpsCancelled(task.chatId, task.id)) return;
          // The ping was voiced EARLY (the gate reserved its throttle slot before the slow voice
          // call), so the mouth re-checks staleness the instant the send actually owns the lock:
          //   • gate.isStopped — the answer settled while this ping queued: drop it, never land a
          //     "still on it" after (or between the bubbles of) the real answer;
          //   • isOpsCancelled — they asked for silence while it queued;
          //   • staleIfSpokenSince — Irises said something after this was voiced (e.g. a live reply
          //     to an intervening text): the ping is blind to that message, so it's stale — drop.
          // paced:false keeps it snappy once it owns the mouth (a ping is meta, not prose).
          const voicedAt = Date.now();
          void sendFollowUp(task.chatId, text, {
            paced: false,
            dropIf: () => gate.isStopped || isOpsCancelled(task.chatId, task.id),
            staleIfSpokenSince: voicedAt,
          }).catch(() => { /* progress is best-effort */ });
        },
      )
        // TERMINAL catch — the one that makes the floated calls below safe. Every caller of
        // voiceAndPing floats it (`void …`), and one of them fires from inside a setTimeout where
        // there is no caller at all. An unhandled rejection is FATAL in this process
        // (diagnostics/errorLog.ts installs a handler that exits(1)), so an unguarded ping could
        // kill the VM mid-delegation: the in-flight run's promise chain, its deadline timer and the
        // whole in-memory trace ring die with it, and under any supervisor the restart makes the
        // delegation look like it hung forever — no engine:*:start, no ops:timeout, no snag line.
        // A reassurance is never worth that.
        .catch(err => { console.error('[orchestrator] progress ping failed (ignored)', err); });
    return { gate, voiceAndPing };
  };
  const pingStops: Array<() => void> = [];
  const stopAllPings = () => { for (const s of pingStops) s(); };

  let finalSent = false; // the double-send latch: never voice a failure after an answer already shipped
  try {
    record({
      type: 'delegation', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
      label: `delegate:${task.kind}`, detail: { request: task.request, metaPrompt: task.metaPrompt, addressHint: task.addressHint, dealHint: task.dealHint },
    });

    // ── Primary leg ──────────────────────────────────────────────────────────
    const primary = makePings(PROGRESS_QUIET_MS);
    // Fallback reassurance the moment the wait crosses "long", in case Ops is deep in one slow tool.
    const primaryHeartbeat = setTimeout(() => { void primary.voiceAndPing('heartbeat', 'heartbeat'); }, PROGRESS_QUIET_MS);
    (primaryHeartbeat as { unref?: () => void }).unref?.();
    const stopPrimary = () => { primary.gate.stop(); clearTimeout(primaryHeartbeat); };
    pingStops.push(stopPrimary);

    // The sink lets us read the (partial) debrief even if the run is abandoned by the deadline below.
    const sink: OpsDebriefSink = {};
    let timedOut = false;
    let result: OpsResult;
    // Internal abort so a timed-out primary leg is torn down (its loop exits at the next step check)
    // BEFORE a retry leg starts — otherwise two Ops loops on the same task.id would run tools
    // concurrently for minutes. Combined with the user-cancel signal so cancel_research still reaches it.
    const primaryAbort = new AbortController();
    // This leg's deadline, decided before the leg starts and read only here: the same number runTask
    // hands the engine transport, and the one its ops:kickoff receipt reports as budgetMs.
    const legMs = legBudgetFor(task);
    // Keep the promise: on timeout we must WAIT for the aborted leg to actually settle before a
    // second leg starts, or the two legs bill tools + LLM steps concurrently.
    const primaryRun = runTask(task, milestoneKey => { noteOpsProgress(task.chatId, task.id, milestoneKey); void primary.voiceAndPing('progress', milestoneKey); }, combineSignals(signal, primaryAbort.signal), sink);
    try {
      result = await withDeadline(primaryRun, legMs, `ops task ${task.id}`);
    } catch (err) {
      // Only a deadline becomes a triageable synthetic result; a genuine throw goes to the outer catch.
      if (!(err instanceof DeadlineError)) throw err;
      timedOut = true;
      primaryAbort.abort(); // stop the abandoned loop so it doesn't keep hitting tools alongside a retry
      // The signal reaches the SDKs, so the in-flight request aborts in milliseconds — the race is
      // only a bound against a pathological hang (e.g. a tool that ignores aborts).
      await Promise.race([primaryRun.catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
      // Snapshot the sink NOW (deep-copy the arrays): the abandoned run may still mutate them in place.
      const snap: OpsDebrief | undefined = sink.debrief
        ? { ...sink.debrief, toolsRun: [...sink.debrief.toolsRun], corpus: [...sink.debrief.corpus], endedAt: Date.now(), failure: { cause: 'timeout' } }
        : undefined;
      record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:timeout', detail: { ms: legMs, steps: snap?.steps, tools: snap?.toolsRun.map(t => t.name) } });
      // trace:false — the ops:timeout event above already carries the ERROR-side story for this turn.
      reportError({
        source: 'ops', category: 'timeout', message: `ops task ${task.id} exceeded its ${legMs}ms deadline`,
        detail: { timeoutMs: legMs, kind: task.kind, steps: snap?.steps }, chatId: task.chatId, handle: task.agentHandle, taskId: task.id, trace: false,
      });
      result = { taskId: task.id, kind: task.kind, status: 'error', summary: 'ran into a problem completing that', debrief: snap };
    }
    stopPrimary(); // freeze primary pings before triage; a retry leg gets its own gate

    // User cancelled this lookup (cancel_research). Deliver NOTHING — Convo already confirmed the
    // drop in the live turn, so a late follow-up would land as a contradiction. This guard, not the
    // loop's abort check, is the load-bearing half.
    if (isOpsCancelled(task.chatId, task.id)) {
      record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:cancelled', detail: { request: task.request } });
      return;
    }

    // ── Steer replay ─────────────────────────────────────────────────────────
    // The engine ACCEPTED a mid-run addition and then never applied it: the steer landed after its
    // final model response (hermes reports it as `pending_steer` on the terminal event). So the
    // answer in hand is real but does not contain the last thing the user asked for, and delivering
    // it as-is reads as Irises having ignored them. Replay it ONCE as a refinement leg — the same
    // `retryOf` path a triage retry uses, which is also what makes the replay the LAST leg (its
    // task's retryOf turns canRetry false, so triage below cannot add a third run on top of an
    // answer that already succeeded).
    //
    // No seed corpus, for the same reason the retry leg carries none: this is a fresh pass at the
    // whole ask, and grounding must rest on what it actually re-fetches.
    const unapplied = result.steerUnapplied?.trim();
    let ladderTask = task;
    if (unapplied && !task.retryOf && !isOpsCancelled(task.chatId, task.id)) {
      record({
        type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
        label: 'ops:steer-replay', detail: { steer: unapplied.slice(0, 200), attempt: task.attempt ?? 1 },
      });
      // Keep the in-flight clock fresh so "still on it" and the dedupe guard stay truthful across a
      // second leg the user never explicitly asked for (see markOpsRetry).
      markOpsRetry(task.chatId, task.id);
      // The registry, not the task: anything a steer asked to have DONE landed there after this task
      // object was built, and the replay is the leg that has to carry it as an instruction.
      const replayTask = steerReplayTaskFor(task, unapplied, getOpsEngineActions(task.chatId, task.id));
      const replay = makePings(PROGRESS_QUIET_MS);
      pingStops.push(() => replay.gate.stop());
      const replayAbort = new AbortController();
      const replayRun = runTask(replayTask, milestoneKey => { noteOpsProgress(replayTask.chatId, replayTask.id, milestoneKey); void replay.voiceAndPing('progress', milestoneKey); }, combineSignals(signal, replayAbort.signal), undefined, undefined);
      try {
        result = await withDeadline(replayRun, legBudgetFor(replayTask), `ops steer-replay ${task.id}`);
        ladderTask = replayTask;
      } catch (err) {
        // The replay died — keep the FIRST leg's answer. It is a real answer that merely misses the
        // addition, which beats voicing a snag over work that succeeded. The engine was asked to say
        // in FLAGS when a steer arrived too late (ops/steer.ts), so the gap is not silent either.
        console.warn('[orchestrator] steer replay failed; keeping the pre-steer answer', err);
        if (err instanceof DeadlineError) {
          replayAbort.abort();
          await Promise.race([replayRun.catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
        }
      }
      replay.gate.stop();
      record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:steer-replay-result', detail: { status: result.status, replayed: ladderTask !== task } });
    }

    let moment = classifyResult(result);
    let triage: TriageDecision | undefined;

    // ── Triage ───────────────────────────────────────────────────────────────
    // Only for failing outcomes (a real answer is already good). Triage reasons about the cause;
    // a retry verdict runs ONE cheap same-model second attempt.
    if (moment !== 'answer') {
      const cause = detectCause(result, timedOut);
      // Only a genuine empty miss needs the LLM splitter; every other cause is deterministic.
      // `ladderTask` is the original task on every ordinary path and the REPLAY task when a steer
      // replay ran — its retryOf is what keeps the ladder at two legs total.
      triage = cause === 'empty_miss' ? await splitMiss(result, ladderTask) : decide(cause, ladderTask);
      record({
        type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:triage',
        // `directive` rides along so a trace says what the second pass was actually told (it is what
        // retryTaskFor folds onto the retry brief) — absent on every decision that carries none.
        detail: { cause: triage.cause, action: triage.action, missingFields: triage.missingFields, deterministic: triage.deterministic, attempt: task.attempt ?? 1, directive: triage.directive },
      });

      if (triage.action === 'retry' && !isOpsCancelled(task.chatId, task.id)) {
        // Cheap same-role retry for a transient lane blip: re-run the ORIGINAL brief on the same
        // engine. A fresh attempt clears a since-recovered blip; whatever it returns is final.
        record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:retry', detail: { cause: triage.cause, attempt: task.attempt ?? 1 } });
        // Keep the in-flight clock fresh so dedupe + "still on it" stay truthful if the primary's
        // llm_error landed late (see markOpsRetry). No ETA extension — a retry is meant to be quick.
        markOpsRetry(task.chatId, task.id);

        // A retry is deliberately SILENT: its gate carries the normal quiet window so a milestone can
        // still note progress, but there's no "taking a harder look" announcement and no heartbeat — the
        // retry deadline sits inside the quiet window, so a slow retry just waits.
        const retry = makePings(PROGRESS_QUIET_MS);
        pingStops.push(() => retry.gate.stop());

        // Same task.id + user signal keep cancel/dedupe/trace-continuity/markOpsDone working; retryOf
        // keeps the role on `ops` and blocks a retry-of-retry. This is a from-scratch fresh attempt (not a
        // trail continuation — the retry model is never told to reuse prior work), so it seeds NO prior
        // corpus: grounding rests only on what this pass actually re-fetches. retryTaskFor owns the ONE
        // difference a second leg may carry: triage's directive, folded onto the brief, so an escalation
        // that had something new to say does not re-send byte-identical bytes. A transient retry has no
        // directive and gets the original brief unchanged.
        // Built off `ladderTask`, not `task`: on the ordinary path they are the same object, and
        // when a steer replay ran it is the replay task — so a retry after one carries the
        // addition the user made instead of quietly re-running the brief that predates it. (Today
        // a replay's `retryOf` makes `canRetry` false, so triage cannot ask for this; that is a
        // bound, not a reason to hand the wrong brief down if it ever changes.)
        const retryTask: OpsTask = retryTaskFor(ladderTask, triage);
        const t0 = Date.now();
        const retryAbort = new AbortController();
        const retryRun = runTask(retryTask, milestoneKey => { noteOpsProgress(retryTask.chatId, retryTask.id, milestoneKey); void retry.voiceAndPing('progress', milestoneKey); }, combineSignals(signal, retryAbort.signal), undefined, undefined);
        try {
          result = await withDeadline(retryRun, legBudgetFor(retryTask), `ops retry ${task.id}`);
        } catch (err) {
          // Retry died too (deadline or throw) — keep the FIRST result and its classification. The
          // transient ladder is spent here, so this is the incident, not the primary's own blip.
          console.warn('[orchestrator] retry run failed; keeping first result', err);
          reportError({
            source: 'ops', category: 'retry_exhausted', severity: 'warn', err,
            detail: { stage: 'ops_retry', cause: triage.cause }, chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
          });
          if (err instanceof DeadlineError) {
            retryAbort.abort();
            await Promise.race([retryRun.catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
          }
        }
        retry.gate.stop();
        moment = classifyResult(result);
        // Re-triage on the RETRY's result. The retry is usually the FIRST pass to actually research (an
        // llm_error typically dies before any tool ran), so its outcome deserves the same triage the
        // primary would have gotten. Use retryTask: its retryOf makes canRetry false (no retry-of-retry),
        // an INFO_HOLE still earns a targeted ask_user, and a fresh transient error gives up.
        // detectCause(result, false): a timed-out/failed retry kept the original 'transient' result,
        // so this only re-triages a retry that genuinely ran and came back soft.
        if (moment !== 'answer' && !isOpsCancelled(task.chatId, task.id)) {
          const retryCause = detectCause(result, false);
          triage = retryCause === 'empty_miss' ? await splitMiss(result, retryTask) : decide(retryCause, retryTask);
        }
        record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:retry-result', detail: { status: result.status, moment, ms: Date.now() - t0, nextAction: triage.action } });
      }

      // No deeper ladder beyond the single retry — the engine IS the strong model, and whatever the
      // retry returns is final.
    }

    // Info-hole → a TARGETED question (rides the two-strike marker). ask_user is only ever returned for
    // attempt 1 (triage downgrades it to give_up on ≥2), so this only fires on a first look.
    if (triage?.action === 'ask_user' && moment === 'miss' && (task.attempt ?? 1) < 2) moment = 'needs_info';
    const giveUp = triage?.action === 'give_up';

    stopAllPings(); // final result in hand — no more "still on it" before the (slower) compose+send

    // Authoritative delivery guard, checked as LATE as possible: triage (a ~1-2s classify call) and a
    // retry leg opened async windows AFTER the primary cancel-check above, so a cancel_research
    // landing in either window must still suppress everything — no marker, no send.
    if (isOpsCancelled(task.chatId, task.id)) {
      record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:cancelled', detail: { request: task.request } });
      return;
    }

    const attempt = task.attempt ?? 1;

    // Deliver through the mouth: the durable markers AND the compose call run inside the per-chat
    // lock (the voicer thunk below). Two invariants this buys:
    //   • composeFollowUp reads the genuinely-latest thread — any reply Convo sent while Ops ran is
    //     already recorded, and the thread CANNOT move between compose and send (nothing else can
    //     own the mouth) — so the follow-up can never "jump the convo";
    //   • pending_clarification/recent_research commit before any later turn can read them, because
    //     the next turn's own LLM call queues behind this same lock — no turn can see the two-strike
    //     marker before the steering question that explains it is on their screen.
    // Latency split of the follow-up: composeMs = the composer LLM call; followupMs = the whole
    // mouth-lock-wait + durable writes + compose + paced send. deliverMs (recorded below) is the
    // remainder. composeMs is set inside the thunk, so it's a mutable closure var.
    let composeMs = 0;
    const followupStart = Date.now();
    const delivery = await sendFollowUp(task.chatId, async () => {
      // The authoritative cancel guard, now inside the mouth: triage and the retry leg opened
      // async windows, and the queue wait itself is one more — re-checked here before any durable
      // state commits, so a cancelled lookup never writes markers or delivers.
      if (isOpsCancelled(task.chatId, task.id)) return null;

      // Two-strike state — stored ONLY when we actually asked them to narrow (a BEAT_FIRST miss or a
      // needs_info question), so their next reply is read as the refinement. A give_up (soft
      // BEAT_SECOND) is terminal, so no marker. AWAIT so the durable marker is committed BEFORE the
      // in-flight flag clears in `finally` — otherwise a fast "ok" could land in the gap and Convo
      // would re-delegate.
      const askedToNarrow = moment === 'needs_info' || (moment === 'miss' && !giveUp);
      if (askedToNarrow && attempt < 2) {
        await setPreference(task.agentHandle, 'pending_clarification', {
          request: task.request, kind: task.kind, metaPrompt: task.metaPrompt, attempt, at: Date.now(),
          missingFields: triage?.missingFields,
        }).catch(err => console.error('[orchestrator] failed to persist pending_clarification', err));
      } else if (attempt >= 2) {
        await setPreference(task.agentHandle, 'pending_clarification', null)
          .catch(err => console.error('[orchestrator] failed to clear pending_clarification', err));
      }

      // Stash the research so Convo can answer same-topic follow-ups without re-delegating. ONLY on a
      // real answer — never a miss.
      if (moment === 'answer') {
        const summary = redactInternalTools(result.summary);
        // Two independent durable writes — the 24h short-term row (the tier Convo's context block
        // reads) and the legacy recent_research prefs stash (dual-write during
        // the soak window). Run them together: Promise.all still awaits BOTH to completion before we
        // proceed, preserving the markers-commit-before-any-later-read invariant (the next turn's LLM
        // call queues behind this same mouth lock), just without the needless serial round trip. Each
        // keeps its own .catch, so a single failure can't reject the batch.
        await Promise.all([
          addShortTerm({
            agentHandle: task.agentHandle, chatId: task.chatId, kind: 'ops_research',
            // topicKey: the normalized ask, so the short-tier renderer can tell whether a LATER turn is
            // still on THIS topic (renders the look full) or has moved on (collapses it to a digest line).
            // The row is written at delivery, so createdAt already IS "delivered-at" — no separate flag.
            request: task.request, content: summary, meta: { taskKind: task.kind, attempt, topicKey: normalizeRequest(task.kind, task.request) }, taskId: task.id,
          }).catch(err => console.error('[orchestrator] failed to persist short-term research', err)),
          setPreference(task.agentHandle, 'recent_research', {
            request: task.request, kind: task.kind, summary, at: Date.now(),
          }).catch(err => console.error('[orchestrator] failed to persist recent_research', err)),
        ]);
      }

      const composeStart = Date.now();
      const composed = await composeFollowUp(result, task, moment, { missingFields: triage?.missingFields, giveUp });
      composeMs = Date.now() - composeStart;
      return composed;
    }, {
      // Anchor the out-of-band answer to the user's original question: the FIRST bubble natively
      // quotes the message that asked (replyToMessageId was set to that, never a trailing "thanks"),
      // then the rest flows naturally — a person quotes once to anchor, not on every line.
      replyTo: task.replyToMessageId ? { message_id: task.replyToMessageId } : undefined,
      // composeFollowUp is itself a multi-second LLM call — a cancel_research can land during it.
      // The mouth re-checks this as the LAST thing before the send, so a cancelled lookup never
      // delivers after Convo confirmed the drop.
      dropIf: () => isOpsCancelled(task.chatId, task.id),
    });
    const followupMs = Date.now() - followupStart;
    record({
      type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
      label: 'ops:followup-timing',
      detail: { composeMs, deliverMs: Math.max(0, followupMs - composeMs), followupMs, delivered: delivery === 'sent', moment },
    });
    if (delivery !== 'sent') {
      record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:cancelled', detail: { request: task.request, afterCompose: true } });
      return;
    }
    finalSent = true;
  } catch (err) {
    // A cancelled run that errored needs no voicing either — they asked for silence.
    if (isOpsCancelled(task.chatId, task.id)) {
      record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:cancelled', detail: { request: task.request, afterError: true } });
      return;
    }
    // The answer already shipped — a late failure (e.g. a post-send throw) must NOT voice a "snag"
    // on top of a delivered answer. Record it and stay silent.
    if (finalSent) {
      record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:late-error-after-send', detail: { error: String((err as Error)?.message ?? err) } });
      return;
    }
    // The ASK was fine, the run/handoff didn't finish. Fallfirm voices the transient snag in-character
    // (never asks them to rephrase); floor underneath if it fails too. Voiced under the mouth like
    // every delivery, with the cancel guard re-checked there — silence stays honored even when the
    // cancel lands while this snag line queues.
    console.error('[orchestrator] runOpsAndFollowUp failed', err);
    try {
      await sendFollowUp(
        task.chatId,
        () => voiceOutcome(
          { kind: 'failed', summary: 'you hit a snag pulling this up on your end (not their fault)', nextStep: "tell them to nudge you in a bit and you'll grab it", originalRequest: task.request },
          task.chatId, task.agentHandle,
        ),
        { dropIf: () => isOpsCancelled(task.chatId, task.id) },
      );
    } catch { /* give up silently */ }
  } finally {
    stopAllPings(); // safety: kill every gate + heartbeat on every exit path
    // End-to-end latency for the whole delegation, on the single app clock (Convo stamping
    // task.createdAt → this exit): the one number the <60s target is measured against.
    record({ type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id, label: 'ops:duration', detail: { kind: task.kind, ms: Date.now() - task.createdAt } });
    // Clear this task's in-flight marker LAST, so it outlives the result handoff above. Per-taskId
    // clear means a concurrent distinct task's marker survives. How it ended rides along for the
    // next turn's recently-ended list (a cancel was noted when it was stopped).
    markOpsDone(task.chatId, task.id, finalSent ? 'delivered' : 'failed');
  }
}

// Slim: runMmAndFollowUp is gone. Media the user texts now rides the SAME delegation seam as
// everything else — Convo delegates with task.media attached, the engine adapter maps the files
// (inline image blocks / fetchable URLs), and the Composer re-voices the engine's read.
