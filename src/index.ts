import './loadEnv.js';   // MUST be first — loads deploy/app.env + local .env before anything reads process.env
import { installProcessErrorHandlers, reportError } from './diagnostics/errorLog.js';
// Before any other module-level work runs: an uncaughtException / unhandled rejection now
// leaves a durable fatal row (flushed on the way out) instead of only a stdout line the
// restart wipes.
installProcessErrorHandlers();
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { resolveChannel, registerChannel } from './channels/registry.js';
import { webChannel } from './channels/web/channel.js';
import { createWebRouter } from './channels/web/routes.js';
import type { MediaAttachment } from './channels/types.js';
import * as convoClient from './agents/convo/client.js';
import { getUserProfile, addMessage, hasHistory } from './state/conversation.js';
import { runOpsAndFollowUp } from './agents/orchestrator.js';
import { ensureEngineOnboarded } from './agents/ops/engineOnboarding.js';
import { initFirstMove } from './agents/ops/firstMove.js';
import { createEnginePushRouter } from './webhook/enginePush.js';
import { createProactiveDelivery } from './pipeline/proactiveDelivery.js';
import { shouldShareContactCard, shouldStartTypingEarly } from './pipeline/turnGates.js';
import { bridgeChannel } from './channels/bridge/channel.js';
import { createBridgeInboundRouter } from './channels/bridge/inboundRouter.js';
import { voiceOutcome } from './agents/fallfirm/client.js';
import { ensureChatId } from './db/repositories/memory.js';
import { startRetentionTimers } from './db/retention.js';
import { initSemanticRecall } from './memory/semanticRecall.js';
import { initThreadPings } from './memory/threadPings.js';
import { initMusings } from './memory/musings.js';
import { getVersion } from './update/version.js';
import { getModelMap } from './llm/modelMap.js';
import { getUpdateStatus, startUpdateChecker } from './update/checker.js';
import { createUpdateAnnouncer } from './update/announce.js';
import { writePidFileAtBoot } from './update/pidfile.js';
import { markOpsStart, setOpsTaskSink } from './state/opsCoordination.js';
import { createOpsTaskRecovery, opsDurableTasksEnabled } from './state/opsTaskDurability.js';
import { estimateOpsEta } from './agents/etaEstimate.js';
import { browserLegBudgetFor } from './agents/ops/client.js';
import { withChatLock } from './state/sendQueue.js';
import { LiveTurn } from './state/liveTurn.js';
import { createMouth, type SpeakContent, type SpeakOpts, type SpeakResult } from './state/mouth.js';
import { registerPendingInboundProvider } from './state/inboundGlance.js';
import { isTypingFresh as isTypingFreshAt, shouldFlush, effectiveSettleMs } from './state/batchTiming.js';
import { typingDelayMs as pacedTypingDelayMs, holdLoop, type PacingConfig } from './state/pacing.js';
import { createTypingLifecycle } from './state/typingStop.js';
import { mergeBurst, splitBurstBySender } from './state/burstMerge.js';
import { warmIdleClassify } from './agents/convo/idleClassify.js';
import { warmReachClassify } from './agents/convo/reachClassify.js';
import { classifyNeeded } from './persona/idle.js';
import { hooksEnabled, shareTurnsEnabled } from './persona/featureFlags.js';
import { resolveOutboundBubbles, resolveReactionTarget, stripReplyTag } from './state/replyThreading.js';
import { noteSend, countSendsSince, lastSendAt } from './state/outboundLog.js';
import { stripTimestampMarker } from './pipeline/chatTime.js';
import { recordSentBubble } from './db/repositories/sentMessages.js';
import { executeUnsend, noteInbound, noteSentBubble, type UnsendRequest } from './state/unsend.js';
import { recordInboundMessage } from './db/repositories/inboundMessages.js';
import { resolveTappedReply, type ResolvedReply } from './state/replyResolution.js';
import { createDiagnosticsRouter } from './diagnostics/dashboard.js';
import { createAdminDashboardRouter } from './diagnostics/adminDashboard.js';
import { beginTurn } from './diagnostics/trace.js';
import { recordTurnTrace, type TurnTraceDraft } from './diagnostics/turnTrace.js';
import { loadContext } from './agents/loadContext.js';
import { redactInternalTools, stripOpsScaffolding } from './agents/guardrails.js';
import { splitIntoBubbles, splitIntoBubblesWithSplits } from './pipeline/bubbles.js';
import { remainderAfterPrefix } from './pipeline/earlyEmit.js';
import { buildBubbleReport, noteBubbleReport } from './pipeline/bubbleJson.js';
import type { OpsTask } from './agents/types.js';

// Short, stable fingerprint of a persona body so /health can confirm which version is live.
function personaFingerprint(body: string): { chars: number; hash: string } {
  let h = 0;
  for (let i = 0; i < body.length; i++) h = (Math.imul(h, 31) + body.charCodeAt(i)) | 0;
  return { chars: body.length, hash: (h >>> 0).toString(16).padStart(8, '0') };
}

// The bubble pipeline (cleanResponse / splitSentences / splitIntoBubbles + the 20-word-ceiling
// splitLongBubble backstop) lives in the pure, unit-tested ./pipeline/bubbles module.

// Track message count per chat for contact card sharing.
// A contact-card share (on a channel that supports it) posts IRISES'S OWN card. Re-sharing it every few
// messages reads as self-promo spam mid-conversation, so it's opt-in and off by default;
// when enabled, the card still goes out on the FIRST message (so Irises's name/photo replace
// the bare number) and then on the interval.
const chatMessageCount = new Map<string, number>();
const CONTACT_CARD_PROMO = process.env.CONTACT_CARD_PROMO === 'true';
const CONTACT_CARD_INTERVAL = Number(process.env.CONTACT_CARD_INTERVAL || 5); // every N messages, when promo enabled

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Health check — includes a live-persona fingerprint so you can confirm which
// Context.md version the running process is actually serving (in dev it reflects
// the latest file via loadContext's mtime hot-reload).
app.get('/health', (_req, res) => {
  const u = getUpdateStatus();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    // Which BUILD is live (git sha/branch), and whether the checker has seen a newer one upstream.
    version: getVersion(),
    update: { available: u.updateAvailable, remoteSha: u.remoteSha, lastCheckAt: u.lastCheckAt, lastCheckOk: u.lastCheckOk },
    // The model map: which model Irises's voice runs on vs. the engine's deep-work model (zero-auth
    // diagnostics; the dashboard renders the same data as a card).
    models: getModelMap(),
    persona: {
      convo: personaFingerprint(loadContext('convo')),
      composer: personaFingerprint(loadContext('composer')),
      fallfirm: personaFingerprint(loadContext('fallfirm')),
      fallfirmProgress: personaFingerprint(loadContext('fallfirm', 'Progress.md')),
    },
  });
});

// Types for debounce queue
import { IncomingMedia, ReplyTo, hasMedia, emptyMedia } from './webhook/types.js';

interface PendingMessage {
  from: string;
  text: string;
  messageId: string;
  media: IncomingMedia;
  incomingReplyTo?: ReplyTo;
  receivedAt: number;   // epoch ms this message was enqueued — used for reply-gap detection
}

// Reaction shape used by the channel sendReaction call. `re` (optional) is the 1-based [msg N] index
// of a burst message to tapback instead of the latest — resolved to an id via resolveReactionTarget.
type Reaction = { type: 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question'; re?: number } | { type: 'custom'; emoji: string; re?: number };

// Result returned by an agent's chat(). New orchestration fields (delegatedTask,
// optional so the legacy Deepseek agent still satisfies it.
interface AgentChatResult {
  text: string | null;
  reaction: Reaction | null;
  renameChat: string | null;
  rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null;
  generatedImage: { url: string; prompt: string } | null;
  groupChatIcon: { prompt: string } | null;
  removeMember: string | null;
  delegatedTask?: OpsTask | null;
  unsend?: UnsendRequest | null;
  // The bubble-count guard fired on the parse behind `text` (agents/convo/shared.ts → ChatResponse).
  // Rides the reply itself so the send boundary reports the cap against the reply it ships; optional
  // so an agent that doesn't parse a bubble envelope still satisfies this shape.
  hardCapped?: boolean;
  // This turn's receipt, minus the bubbles — the send boundary attaches those and files it as one
  // `turn:trace` event (diagnostics/turnTrace.ts). Optional for the same reason as hardCapped: an
  // agent that never built a prompt has nothing to attribute.
  turnTrace?: TurnTraceDraft;
}

export interface AgentClient {
  chat: (chatId: string, userMessage: string, media: IncomingMedia, chatContext?: unknown) => Promise<AgentChatResult>;
  getGroupChatAction: (message: string, sender: string, chatId: string) => Promise<{ action: 'respond' | 'react' | 'ignore'; reaction?: Reaction }>;
  generateImage: (prompt: string) => Promise<string | null>;
}

// ── Channel-routed outbound wrappers ─────────────────────────────────────────
// Every outbound call resolves its transport from the chatId prefix (channels/registry.ts), so the
// SAME send path below speaks over the web/CLI debug channel (SSE) or the engine bridge with no
// change. Optional ops (reactions, group ops, contact card) are guarded by the channel's caps, so
// a channel that can't do one simply skips it instead of throwing.
const sendMessage = (chatId: string, text: string, replyTo?: ReplyTo, media?: MediaAttachment[]) =>
  resolveChannel(chatId).sendMessage(chatId, text, replyTo, media);
// Every "typing" assertion in this file goes through the lifecycle (state/typingStop.ts), which is
// what makes the explicit stop at the end of a reply safe: it knows whether a start landed after
// that stop and so whether the trailing safety stop would be killing a NEW turn's dots. Keeps a
// Promise return type because two call sites `await` it; the assertion itself is fire-and-forget by
// design (the gateway leg is slow enough that awaiting it once stalled the reply), so the promise is
// already-resolved rather than the channel's round trip. `typingLifecycle` is declared further down,
// with the other TYPING_* knobs it needs — these arrows only ever run per-turn, long after module
// init, so the later binding is resolved by the time anyone calls them.
const startTyping = (chatId: string): Promise<void> => { typingLifecycle.noteStart(chatId); return Promise.resolve(); };
const stopTyping = (chatId: string) => resolveChannel(chatId).stopTyping(chatId);
/** The reply (or the silent turn) is over — clear the dots, with the trailing safety stop. */
const releaseTyping = (chatId: string) => { typingLifecycle.release(chatId); };
const markAsRead = (chatId: string) => resolveChannel(chatId).markAsRead(chatId);
const getChat = (chatId: string) => resolveChannel(chatId).getChat(chatId);
const sendReaction = (chatId: string, messageId: string, reaction: Reaction, operation?: 'add' | 'remove') => {
  const ch = resolveChannel(chatId);
  return ch.caps.reactions ? ch.sendReaction(chatId, messageId, reaction, operation) : Promise.resolve();
};
const unsendMessage = (chatId: string, messageId: string): Promise<boolean> => {
  const ch = resolveChannel(chatId);
  return ch.unsendMessage ? ch.unsendMessage(chatId, messageId) : Promise.resolve(false);
};
const shareContactCard = (chatId: string) => {
  const ch = resolveChannel(chatId);
  return ch.caps.contactCard && ch.shareContactCard ? ch.shareContactCard(chatId) : Promise.resolve();
};
const renameGroupChat = (chatId: string, displayName: string) => {
  const ch = resolveChannel(chatId);
  return ch.caps.groupOps && ch.renameGroupChat ? ch.renameGroupChat(chatId, displayName) : Promise.resolve();
};
const setGroupChatIcon = (chatId: string, iconUrl: string) => {
  const ch = resolveChannel(chatId);
  return ch.caps.groupOps && ch.setGroupChatIcon ? ch.setGroupChatIcon(chatId, iconUrl) : Promise.resolve();
};
const removeParticipant = (chatId: string, handle: string) => {
  const ch = resolveChannel(chatId);
  return ch.caps.groupOps && ch.removeParticipant ? ch.removeParticipant(chatId, handle) : Promise.resolve();
};

interface PendingChat {
  chatId: string;
  messages: PendingMessage[];
  timer: NodeJS.Timeout | null;
  lastActivityAt: number;         // time of the last message — the rolling-settle anchor
  isProcessing: boolean;
  // The batch currently being processed (spliced out of `messages`, its turn not yet recorded to
  // history). Held here ONLY so the pending-inbound glance below can see it — an out-of-band voicer
  // must know these texts exist even though neither the queue nor history contains them yet.
  inFlightBatch: PendingMessage[] | null;
  // The run being answered right now, which a newer text from its sender replaces while it is still
  // only being written (state/liveTurn.ts). Null between runs.
  turn: LiveTurn | null;
  agentClient: AgentClient;
}

const pendingChats = new Map<string, PendingChat>();

// Let out-of-band voicers (the Composer's late Ops reply) glance at texts that have ARRIVED but not
// yet entered history — the settle queue plus the batch mid-processing. Without this, a follow-up
// composed while the user is mid-burst reads as if their newest texts don't exist ("jumping the
// convo"). Read-only; raw texts only.
registerPendingInboundProvider(chatId => {
  const p = pendingChats.get(chatId);
  if (!p) return [];
  return [...(p.inFlightBatch ?? []), ...p.messages].map(m => m.text?.trim() ?? '').filter(Boolean);
});
// When Irises last sent a bubble to each chat, and how many she's sent since a given instant, both live
// in state/outboundLog.ts now (noteSend / lastSendAt / countSendsSince). A reply is "gapped" — and so
// needs a native quote to stay connected to the message it answers — when Irises has sent bubbles since
// that message arrived (they now sit between them in the UI); the same log tells the prompt, per
// message, how many sends landed after it was typed so a stale queued message isn't re-answered blind.
// SINGLE source of truth for "is the user typing", with the time it was last set so a stale
// 'started' (no matching 'stopped' — common on some transports) self-expires. Lives outside PendingChat
// so it also survives between batches (waitForUserQuiet reads it during sends).
const typingState = new Map<string, { isTyping: boolean; at: number }>();

// Reply pacing / latency. All env-overridable. Before every bubble we hold a LIVE typing
// indicator for a simulated-typing beat (based on character count), refreshed so it never
// lapses into dead air. "Fast but human": the FIRST bubble gets only a short beat (the user
// already waited through batching + the LLM call with dots showing); later bubbles pace at a
// fast-texter speed with a floor, a cap, and slight jitter. Pure math in state/pacing.ts.
// Pacing is channel-agnostic — the web SSE channel gets the same beats, so a debug session
// reads at the same cadence as a phone thread.
// Burst batching: a ROLLING window (message-driven; the user typing indicator is unreliable so we
// don't use it). We wait for quiet after the LAST message, and every new message RESETS that window
// — so a whole burst is compiled and answered once. The window GROWS with the burst: the base is
// BATCH_SETTLE_MS and each additional message adds BATCH_SETTLE_INCREMENT_MS (someone firing off a
// lot is clearly mid-thought), capped at BATCH_MAX_SETTLE_MS. E.g. 1.8s, 2.2s, 2.6s, … up to 4s.
const BATCH_SETTLE_MS = Number(process.env.BATCH_SETTLE_MS || 1800);                    // base quiet window (1st message)
const BATCH_SETTLE_INCREMENT_MS = Number(process.env.BATCH_SETTLE_INCREMENT_MS || 400); // added per extra message in the burst
const BATCH_MAX_SETTLE_MS = Number(process.env.BATCH_MAX_SETTLE_MS || 4000);            // ceiling on the (grown) window
const PAUSE_WHILE_TYPING = process.env.PAUSE_WHILE_TYPING === 'true';          // pause our send while the user is mid-typing (default OFF)

// The rolling window for the current burst, grown by how many messages are already queued.
function burstSettleMs(pending: PendingChat): number {
  return effectiveSettleMs(pending.messages.length, BATCH_SETTLE_MS, BATCH_SETTLE_INCREMENT_MS, BATCH_MAX_SETTLE_MS);
}
const USER_QUIET_WAIT_MS = Number(process.env.USER_QUIET_WAIT_MS || 600);      // quiet required after the user stops typing before we send (only when PAUSE_WHILE_TYPING)
const TYPING_CPM = Number(process.env.TYPING_CPM || 1100);                     // chars/min; ≈220 WPM fast texter (raised from 800 so fewer bubbles hit the cap → snappier)
const TYPING_DELAY_MAX_MS = Number(process.env.TYPING_DELAY_MAX_MS || 2000);   // hard cap: after this, stop simulating and just send the bubble (tightened from 3000)
const TYPING_DELAY_MIN_MS = Number(process.env.TYPING_DELAY_MIN_MS || 400);    // floor: even a 5-char bubble still reads as typed, not machine-gunned (lowered from 600)
const TYPING_FIRST_BUBBLE_MAX_MS = Number(process.env.TYPING_FIRST_BUBBLE_MAX_MS || 600); // bubble 1 only: dots were already up through the LLM call (lowered from 800 so first ink lands sooner)
const TYPING_JITTER_PCT = Number(process.env.TYPING_JITTER_PCT || 15);         // ±% humanizing wobble on the hold; 0 disables
const TYPING_REFRESH_MS = Number(process.env.TYPING_REFRESH_MS || 2000);       // re-ping the typing indicator this often so it stays visible (no dead air)
const TYPING_TRAILING_STOP_MS = Number(process.env.TYPING_TRAILING_STOP_MS || 4500); // second, guarded stop after a reply — must EXCEED the 3s typing round-trip timeout on both sides (channelTyping's abort here, `.result(timeout=3)` in the plugin), or an in-flight start can still land after it
// On a channel with NO visible typing indicator (bridge with BRIDGE_TYPING off, or an adapter with no
// chat-action), a full per-bubble simulated-typing HOLD is pure dead air — a delay the user sees as an
// unexplained gap. There we skip the hold and space multi-bubble replies by just this small gap so they
// still land in order and read as separate sends. 0 = fire bubbles back-to-back.
const BRIDGE_BUBBLE_GAP_MS = Number(process.env.BRIDGE_BUBBLE_GAP_MS || 400);
const PACING: PacingConfig = { cpm: TYPING_CPM, minMs: TYPING_DELAY_MIN_MS, maxMs: TYPING_DELAY_MAX_MS, firstBubbleMaxMs: TYPING_FIRST_BUBBLE_MAX_MS, jitterPct: TYPING_JITTER_PCT };

// One lifecycle for the whole process (the maps inside are keyed by chat). Lives here rather than
// beside the outbound wrappers above because it needs TYPING_TRAILING_STOP_MS; the wrappers reach
// down to it through arrows, so the ordering is only a declaration detail. Timers are unref'd for
// the same reason withTypingKeptAlive unrefs its interval: a pending 4.5s stop must never be the
// reason the process stays alive.
const typingLifecycle = createTypingLifecycle({
  now: Date.now,
  start: chatId => { void resolveChannel(chatId).startTyping(chatId); },
  stop: chatId => { void resolveChannel(chatId).stopTyping(chatId); },
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
}, { trailingStopMs: TYPING_TRAILING_STOP_MS });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function setTyping(chatId: string, isTyping: boolean) {
  typingState.set(chatId, { isTyping, at: Date.now() });
}

// Thin wrapper over the pure batchTiming helper (typing only counts as fresh for one settle
// window after the last event, so a stale 'started' with no 'stopped' self-expires).
function isTypingFresh(chatId: string): boolean {
  return isTypingFreshAt(typingState.get(chatId), Date.now(), BATCH_SETTLE_MS);
}

async function waitForUserQuiet(chatId: string) {
  if (!PAUSE_WHILE_TYPING) return;              // disabled by default: never hold our send for the user's typing
  if (!isTypingFresh(chatId)) return;

  console.log(`[main] Pausing agent send because user is currently typing...`);
  await stopTyping(chatId);
  // Wait out the typing, then require an extra quiet window; loop if they start again. Bounded by
  // typing-staleness (isTypingFresh self-expires), so this can never spin forever.
  do {
    while (isTypingFresh(chatId)) await sleep(250);
    await sleep(USER_QUIET_WAIT_MS);
  } while (isTypingFresh(chatId));
}

async function processPendingChat(chatId: string) {
  const pending = pendingChats.get(chatId);
  if (!pending || pending.isProcessing) return;
  if (pending.messages.length === 0) { pendingChats.delete(chatId); return; }

  pending.isProcessing = true;
  let superseded = false;
  try {
    const messagesToProcess = pending.messages.splice(0);
    if (messagesToProcess.length === 0) return;
    // Visible to the pending-inbound glance until this batch's turn has fully recorded (cleared in
    // finally): from here to addMessage these texts exist nowhere else a voicer could see them.
    pending.inFlightBatch = messagesToProcess;

    // A turn has exactly ONE identity (`from` picks whose memory loads, whose data the engine reads,
    // whose profile the reply addresses), so a multi-sender group batch becomes one turn per
    // CONSECUTIVE same-sender run, answered in arrival order. 1:1 chats and single-sender
    // bursts are one run — identical to the old single-turn path.
    const runs = splitBurstBySender(messagesToProcess);
    if (runs.length > 1) console.log(`[main] Batch spans ${runs.length} sender runs — answering each in turn`);

    for (const run of runs) {
      const turn = new LiveTurn(run[0].from);
      pending.turn = turn;
      // Combine the run into ONE agent turn. mergeBurst keeps the per-message ids + numbered
      // manifest (older code discarded everything but the last id) so each outgoing bubble can
      // thread back to the specific incoming message it answers.
      const merged = mergeBurst(run);
      console.log(`[main] Processing ${run.length} queued message${run.length === 1 ? '' : 's'} as one prompt`);
      try {
        await processMessage(
          pending.agentClient,
          chatId,
          merged.from,
          merged.combinedText,
          merged.lastMessageId,
          merged.media,
          merged.incomingReplyTo,
          merged.incomingMessageIds,
          merged.manifest,
          merged.earliestReceivedAt,
          // Late-arrival fold: once the turn owns the chat mouth, it drains anything that queued
          // while it waited and answers the full, latest burst. SAME-SENDER only: a late text from
          // another sender stays queued and becomes its own next batch instead of riding along
          // under this run's identity. Drained lates join `messagesToProcess` (= inFlightBatch) so
          // the pending-inbound glance keeps seeing them until this turn records them.
          {
            batch: run,
            drain: () => {
              const late: PendingMessage[] = [];
              for (let i = 0; i < pending.messages.length; ) {
                if (pending.messages[i].from === merged.from) late.push(...pending.messages.splice(i, 1));
                else i++;
              }
              if (late.length) messagesToProcess.push(...late);
              return late;
            },
          },
          turn,
        );
      } catch (error) {
        if (turn.signal.aborted) {
          // A newer text replaced this reply before any of it was real. Back to the front of the
          // queue, this run (drained lates included) then the runs after it, ahead of the new text,
          // to be answered once as the burst it is.
          console.log(`[main] newer message landed while the reply was being written — answering the whole burst instead (chat ${chatId})`);
          superseded = true;
          pending.messages.unshift(...run, ...messagesToProcess.filter(m => !run.includes(m)));
          messagesToProcess.length = 0;
          break;
        }
        console.error(`[main] Error processing run for ${merged.from} in chat ${chatId}:`, error);
        // A turn that dies here usually answered nobody — the user is left on read. Durable, not just
        // logged. The exception is a turn whose opening already went out early (processMessage tags
        // it): they have that much, and the report says so rather than calling it silence.
        const answeredInPart = (error as { answeredInPart?: number } | null)?.answeredInPart;
        if (answeredInPart) console.error(`[main] the failed turn had already sent ${answeredInPart} bubble(s) early — they have its opening, recorded to history (chat ${chatId})`);
        reportError({
          source: 'convo', category: 'turn_failure', err: error, chatId, handle: merged.from,
          ...(answeredInPart ? { detail: { answeredInPart } } : {}),
        });
      } finally {
        if (pending.turn === turn) pending.turn = null;
        // This run's texts (including drained lates — same object identities) are recorded now:
        // stop advertising them to the pending-inbound glance while later runs process.
        for (const m of run) {
          const i = messagesToProcess.indexOf(m);
          if (i !== -1) messagesToProcess.splice(i, 1);
        }
      }
    }
  } catch (error) {
    console.error(`[main] Error processing debounced chat ${chatId}:`, error);
    reportError({ source: 'convo', category: 'turn_failure', err: error, chatId, detail: { scope: 'debouncedBatch' } });
  } finally {
    pending.isProcessing = false;
    pending.inFlightBatch = null;
    // Messages that arrived while we were processing become the next batch. A replaced reply's burst
    // goes as soon as the newest text's own settle window closes (onTick measures it from that text),
    // with the classifiers warmed for the burst as it now stands.
    if (superseded) {
      warmBurst(chatId, pending);
      scheduleTick(chatId, 0);
    } else if (pending.messages.length > 0) scheduleTick(chatId, BATCH_SETTLE_MS);
    else pendingChats.delete(chatId);
  }
}

// ONE self-rescheduling timer per chat. Purely message-driven — it does not consult the (flaky)
// user typing indicator, so a reply is flushed reliably `BATCH_SETTLE_MS` after the last message.
function scheduleTick(chatId: string, delayMs: number) {
  const pending = pendingChats.get(chatId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => onTick(chatId), Math.max(50, delayMs));
}

function onTick(chatId: string) {
  const pending = pendingChats.get(chatId);
  if (!pending) return;                                  // chat deleted → stop (no timer leak)
  pending.timer = null;
  if (pending.isProcessing) { scheduleTick(chatId, BATCH_SETTLE_MS); return; }
  if (pending.messages.length === 0) { pendingChats.delete(chatId); return; }

  const now = Date.now();
  const settle = burstSettleMs(pending);   // grows with how many messages are queued this burst
  if (shouldFlush(pending, now, settle)) { void processPendingChat(chatId); return; }

  // Not ready: re-arm for the time remaining in the (rolling, grown) settle window.
  const remSettle = settle - (now - pending.lastActivityAt);
  scheduleTick(chatId, Math.max(remSettle, 50));
}

interface SendBubbleOpts {
  replyToFirst?: ReplyTo;         // thread-reply attaches only to the first bubble (fallback when no targets)
  targets?: (ReplyTo | undefined)[]; // per-bubble native-reply targets, aligned by bubble index (overrides replyToFirst)
  record?: boolean;               // append the joined text to history (default true)
  paced?: boolean;                // simulate typing between bubbles (default true). false = send now (critical alerts)
}

// Simulated typing time for a bubble — pure math in state/pacing.ts (floor/cap/jitter, plus the
// tighter first-bubble cap: the user already waited through batching + the LLM call with dots up).
function typingDelayMs(text: string, isFirstBubble: boolean): number {
  return pacedTypingDelayMs(text, PACING, isFirstBubble);
}

// Hold the typing indicator visible for `totalMs`, re-pinging it every TYPING_REFRESH_MS so it
// never auto-expires into dead air. Pings are fire-and-forget (the channel's startTyping swallows
// its own errors) so their HTTP round trips no longer stack on top of the sleep budget. `finalPing`
// re-asserts the dots right before we return so they're fresh at the exact send moment — the
// caller passes false before the LAST bubble, where a ping racing past the final send would
// re-show dots after the reply completed.
async function holdTyping(chatId: string, totalMs: number, finalPing: boolean): Promise<void> {
  await holdLoop(totalMs, TYPING_REFRESH_MS, finalPing, {
    sleep,
    ping: () => { void startTyping(chatId); },
    now: Date.now,
  });
}

// Keep the typing indicator alive for the duration of an async task (chiefly the LLM
// generation call). A single startTyping ping auto-expires after a few seconds on the
// platform, so a reply that takes longer than that leaves a dead-air gap ("dots vanish,
// then the message pops in later"). This re-pings every TYPING_REFRESH_MS while `work`
// runs and is GUARANTEED to stop on resolve OR reject, so no interval ever leaks.
async function withTypingKeptAlive<T>(chatId: string, work: Promise<T>): Promise<T> {
  // Nothing to keep alive on a channel that shows no dots — skip the ping loop entirely instead of
  // firing a no-op startTyping every couple seconds for the whole LLM call.
  if (!resolveChannel(chatId).caps.typing) return work;
  void startTyping(chatId);
  const timer = setInterval(() => { void startTyping(chatId); }, TYPING_REFRESH_MS);
  (timer as { unref?: () => void }).unref?.();  // don't keep the process alive just for this
  try {
    return await work;
  } finally {
    clearInterval(timer);
    // Stopping the interval only stops NEW pings — on Photon the dots it already lit stay lit until
    // told to stop, so every exit from here (settle OR reject) must clear them. This is the catch-all
    // for the turns sendBubbles never sees: a reaction-only turn, a silent tool-only turn, a voicer
    // thunk that returns nothing. A DOUBLE release (sendBubbles below, then this) is harmless — the
    // second stop is idempotent and just reschedules the one trailing timer. The mouth's voicer case
    // — release here, then sendBubbles re-starts for the first bubble — is exactly what the
    // trailing-stop guard is for: that later start suppresses this release's trailing stop.
    releaseTyping(chatId);
  }
}

/**
 * The per-bubble guardrail every user-facing bubble passes, whichever path sends it (sendBubbles, or
 * the early sink that sends a sentence while the reply is still being written): strip a leaked
 * `[[re:N]]` routing tag, strip an echoed timestamp marker, scrub internal tool names and raw Ops
 * scaffolding. Returns '' for a bubble that was nothing but those, which the caller drops.
 */
function prepareBubble(raw: string): string {
  let stripped = stripReplyTag(raw);
  if (stripped !== raw) console.warn('[guardrail] stripped a reply-routing tag from a user-facing bubble');
  // History turns now carry `[9:14 AM]`-style timestamp markers (chatTime.ts); a model slip that
  // echoes one at the head of a bubble is scrubbed here, same rationale as the [[re:N]] backstop.
  const unstamped = stripTimestampMarker(stripped);
  if (unstamped !== stripped) {
    console.warn('[guardrail] stripped an echoed timestamp marker from a user-facing bubble');
    stripped = unstamped;
  }
  return stripOpsScaffolding(redactInternalTools(stripped));
}

/**
 * Send ONE already-prepared bubble: the pacing hold (or the no-dots gap), the send, the sent-bubble
 * record, and the dots re-asserted when more is coming. The body of sendBubbles' loop, lifted out so
 * the early sink sends through exactly the same steps a normal reply does. It never puts the dots
 * down and never logs the delivery: both are once per reply, so the caller does them after its last
 * bubble. `typingVisible` defaults to the channel's own answer; sendBubbles passes the one it read.
 */
async function sendOneBubble(
  chatId: string,
  text: string,
  opts: { isFirst: boolean; isLast: boolean; replyTo?: ReplyTo; paced?: boolean; typingVisible?: boolean },
): Promise<void> {
  const { isFirst, isLast, replyTo } = opts;
  const paced = opts.paced !== false;
  const typingVisible = opts.typingVisible ?? resolveChannel(chatId).caps.typing;
  if (paced && typingVisible) {
    await waitForUserQuiet(chatId);
    // Hold a LIVE typing indicator for a simulated-typing beat before every bubble (the
    // first gets only a short beat — the user already waited through the LLM call), then
    // send. No freshness ping before the last bubble: it could race past the send and
    // re-show dots after the reply is done.
    await holdTyping(chatId, typingDelayMs(text, isFirst), !isLast);
    await waitForUserQuiet(chatId);
  } else if (paced && !isLast && BRIDGE_BUBBLE_GAP_MS > 0) {
    // No visible dots: skip the simulated-typing hold (dead air) and keep only a small inter-bubble
    // gap so a multi-bubble reply still reads as separate sends rather than one wall of text.
    await sleep(BRIDGE_BUBBLE_GAP_MS);
  }
  const sent = await sendMessage(chatId, text, replyTo);
  // Remember this bubble by its channel message id so a later inbound reply_to can be resolved
  // back to what Irises said. `replyTo?.message_id` is the anchor this bubble was threaded to (an
  // inbound id) — the join key when a later tapped reply collapses to that thread root.
  // Fire-and-forget; never blocks the send.
  if (sent?.message?.id) void recordSentBubble(chatId, sent.message.id, text, replyTo?.message_id);
  if (sent?.message?.id) noteSentBubble(chatId, sent.message.id, text);
  // If MORE bubbles are coming, re-assert the dots immediately so there's no dark gap — the user
  // sees "bubble → dots again" = more coming. Not after the last one, where a ping racing past the
  // send would read as "still typing" with nothing behind it. Fire-and-forget: startTyping swallows
  // its own errors, and the next bubble's hold re-pings anyway. Only meaningful where dots show.
  if (paced && typingVisible && !isLast) void startTyping(chatId);
}

/**
 * Send pre-split bubbles with a live typing indicator. Before every bubble we hold the
 * typing indicator for a simulated-typing beat (character count at a fast-texter speed,
 * floored/capped/jittered — and only a SHORT beat before the first bubble, since the user
 * already waited through the LLM call), refreshing it so it never lapses into dead air, then
 * send. That makes each bubble read as typed out. waitForUserQuiet keeps us from talking over
 * the user.
 * Single send path for the live reply and out-of-band follow-ups (Ops, engine push) —
 * and for EVERY channel, so web and the bridge pace exactly the same.
 */
async function sendBubbles(chatId: string, rawBubbles: string[], opts: SendBubbleOpts = {}): Promise<number> {
  if (rawBubbles.length === 0) return 0;
  // Hard guardrail: this is the single send path for EVERY user-facing bubble (live reply,
  // Ops follow-up, engine push). Per bubble we (1) strip any `[[re:N]]` reply-routing tag
  // — a backstop so a model slip from ANY agent can never leak it, even when targets aren't supplied
  // — (2) scrub internal tool names, and (3) strip raw Ops summary scaffolding (ANSWER:/SOURCE:/
  // FLAGS:/Subject:/Sender: labels), so nothing — a model slip, or the composer-failure path that
  // falls back to Ops' raw summary — can ever reach the user as a labeled machine block. A bubble
  // that is empty after stripping (e.g. it was only a tag or a bare SOURCE:/FLAGS: line) is dropped
  // so we never send blank text over the channel. Inter-agent text (meta-prompts to Ops) never passes through
  // here. `targets` (aligned to rawBubbles by index) gives each surviving bubble its own native
  // reply target; without it we fall back to replyToFirst.
  const prepared: { text: string; replyTo?: ReplyTo }[] = [];
  for (let i = 0; i < rawBubbles.length; i++) {
    const text = prepareBubble(rawBubbles[i]);
    if (!text) continue;
    const replyTo = opts.targets?.[i] ?? (i === 0 ? opts.replyToFirst : undefined);
    prepared.push({ text, replyTo });
  }
  if (prepared.length === 0) return 0;

  const paced = opts.paced !== false;
  // Does THIS channel actually show a typing indicator? On one that does (web, or the bridge with
  // BRIDGE_TYPING on + a capable adapter), the per-bubble hold is real feedback — the dots are up
  // while we "type". On one that doesn't, the same hold is pure DEAD AIR: an unexplained gap with no
  // dots. There we drop the hold and only space multi-bubble replies by a small gap.
  const typingVisible = resolveChannel(chatId).caps.typing;
  for (let i = 0; i < prepared.length; i++) {
    const { text, replyTo } = prepared[i];
    await sendOneBubble(chatId, text, { isFirst: i === 0, isLast: i === prepared.length - 1, replyTo, paced, typingVisible });
  }
  // The reply is fully out, so put the dots down EXPLICITLY. This used to be left implicit on the
  // theory that "sending a message clears the recipient's typing dots" — true on the web channel,
  // where the browser hides them on any incoming bubble, but false on Photon over the bridge, whose
  // indicator is stateful: it stays lit until it is told to stop. Hence the leak this fixes (dots
  // burning after every reply). Unconditional on `paced`: an unpaced delivery (a critical alert, a
  // progress ping) still runs under withTypingKeptAlive's dots, and they have to come down too.
  // The release also schedules the guarded trailing stop that catches a start still in flight
  // through the gateway when this stop went out — see state/typingStop.ts.
  if (typingVisible) releaseTyping(chatId);
  // Log this send (ONE entry per delivery ≈ one assistant history row): so a later message answered
  // after these bubbles is treated as "gapped" and gets a quote, and so a queued message that predates
  // this send is flagged stale to the next turn's prompt (outboundLog.countSendsSince).
  noteSend(chatId);
  if (opts.record !== false) await addMessage(chatId, 'assistant', prepared.map(p => p.text).join(' '));
  // How many bubbles actually went out. Zero means every one cleaned to nothing and this returned
  // before the dots came down or the delivery was logged, which a caller closing a delivery it
  // started elsewhere (the early sink) has to know.
  return prepared.length;
}

/**
 * Send an out-of-band message (Ops follow-up, progress ping, proactive alert, post-OAuth reply)
 * through the per-chat mouth (state/mouth.ts). `content` may be pre-voiced text, or a VOICER THUNK
 * that runs only once it owns the chat lock — at which point every earlier outbound has been fully
 * sent and recorded, so whatever the thunk reads (conversation history) is exactly the thread its
 * reply will land on. That is the temporal-consistency guarantee: no follow-up is ever voiced
 * against a thread that moves before it sends. `dropIf` / `staleIfSpokenSince` let pre-voiced
 * content (pings) be dropped at the last instant instead of landing stale. A `priority: 'critical'`
 * alert (suspected fraud) still BYPASSES the queue and the typing pacing — the one deliberate
 * exception, where interleaving a live reply beats delaying an emergency.
 */
const speak = createMouth({
  sendBubbles: async (chatId, bubbles, opts) => { await sendBubbles(chatId, bubbles, opts); },
  splitIntoBubbles,
  lastSpokenAt: chatId => lastSendAt(chatId),
  voiceTimeoutMs: Number(process.env.FOLLOWUP_VOICE_TIMEOUT_MS || 120_000),
  // The user sees "Irises is typing…" while a follow-up composes under the lock, not dead air.
  keepTypingAlive: withTypingKeptAlive,
});
async function sendFollowUp(chatId: string, content: SpeakContent, opts: SpeakOpts = {}): Promise<SpeakResult> {
  // replyTo quotes only the FIRST bubble (the Composer's late reply anchors to the original
  // question on its first line, then flows naturally — a person doesn't re-quote every bubble).
  return speak(chatId, content, opts);
}

// Every message Irises STARTS (engine reminders/mail/memos, update notes) goes through this one
// pipeline: whose memory the chat maps to, idempotency against engine retries, quiet-hours deferral
// as a durable row, and Composer voicing with a Fallfirm degrade underneath.
const proactive = createProactiveDelivery({ sendFollowUp });


// The core processing logic extracted from the webhook handler. `lateArrivals`, when given, lets
// the turn fold in messages that arrive while it WAITS for the chat mouth (see the drain block
// inside the critical section below); `batch` must be the same array the pending-inbound glance
// reads (pending.inFlightBatch), so drained texts stay visible to out-of-band voicers.
async function processMessage(agentClient: AgentClient, chatId: string, from: string, text: string, messageId: string, media: IncomingMedia, incomingReplyTo?: ReplyTo, incomingMessageIds: string[] = [], manifest: { text: string; handle: string; receivedAt: number }[] = [], earliestReceivedAt = 0, lateArrivals?: { batch: PendingMessage[]; drain: () => PendingMessage[] }, turn?: LiveTurn) {

  const start = Date.now();
  console.log(`[main] Processing message from ${from}`);

  // Open a new diagnostics turn: everything recorded from here (classify, convo, delegation,
  // the async Ops→Composer tail via taskId) groups under this user message in /dashboard.
  beginTurn(chatId, from, text, incomingReplyTo?.message_id);

  // Track message count for this chat
  const count = (chatMessageCount.get(chatId) || 0) + 1;
  chatMessageCount.set(chatId, count);

  // Share Irises's own card on the very first message (name/photo instead of a bare number);
  // the every-N-messages re-share is opt-in via CONTACT_CARD_PROMO (default off — it reads
  // as self-promo spam mid-conversation). `count` alone resets on restart, so it needs the durable
  // half: a chat with stored messages has already met Irises (turnGates.ts).
  const shouldShareContact = shouldShareContactCard(count, await hasHistory(chatId), { enabled: CONTACT_CARD_PROMO, interval: CONTACT_CARD_INTERVAL });

  // Mark as read, get chat info, and fetch user profile in parallel. Typing is NOT in here: in a
  // group we don't yet know whether Irises will speak at all (see below).
  const parallelTasks: Promise<unknown>[] = [markAsRead(chatId), getChat(chatId), getUserProfile(from)];
  if (shouldShareContact) {
    console.log(`[main] Sharing contact card (message #${count})`);
    parallelTasks.push(shareContactCard(chatId));
  }
  const [, chatInfo, senderProfile] = await Promise.all(parallelTasks) as [void, Awaited<ReturnType<typeof getChat>>, Awaited<ReturnType<typeof getUserProfile>>];
  console.log(`[timing] markAsRead+getChat+getProfile${shouldShareContact ? '+shareContact' : ''}: ${Date.now() - start}ms`);
  if (senderProfile?.name) {
    console.log(`[main] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
  }

  // Group-chat detection: trust the channel's own flag when present; the participant-count
  // heuristic is the fallback only (it misfires when one person appears twice under
  // two handles).
  const isGroupChat = typeof chatInfo.is_group === 'boolean' ? chatInfo.is_group : chatInfo.handles.length > 2;
  const participantNames = chatInfo.handles.map(h => h.handle);

  // Dots only once a reply is certain: 1:1, or any media (which skips the classifier). Showing them
  // for a group text Irises then ignores reads as it starting to answer and thinking better of it.
  // Remembered, not re-derived: on Photon the dots stay lit until stopped, so every exit between
  // here and withTypingKeptAlive (whose finally releases) has to put down whatever THIS turn lit —
  // and only that. Releasing dots this turn never lit would blank a concurrent follow-up's
  // indicator, which is mid-delivery outside the chat lock we haven't taken yet.
  const startedTypingEarly = shouldStartTypingEarly(isGroupChat, hasMedia(media));
  if (startedTypingEarly) void startTyping(chatId);

  // In group chats, check if agent should respond, react, or ignore
  // Always respond to any media (image/audio/video/doc) - someone sending media is clearly communicating
  if (isGroupChat && !hasMedia(media)) {
    await waitForUserQuiet(chatId);
    const { action, reaction: quickReaction } = await agentClient.getGroupChatAction(text, from, chatId);

    if (action === 'ignore') {
      console.log(`[main] Ignoring group chat message`);
      // Record it anyway (the react path already did): the next turn's history must show what was
      // said in the room, or Irises answers "what did Sam just say?" having never heard it.
      await addMessage(chatId, 'user', text, from);
      if (startedTypingEarly) releaseTyping(chatId);   // silent exit before the keep-alive's finally
      return;
    }

    if (action === 'react') {
      // Just send a reaction, no full response needed
      if (quickReaction) {
        await sendReaction(chatId, messageId, quickReaction);
        console.log(`[timing] quick reaction: ${Date.now() - start}ms`);

        // Save to conversation history so agent knows what happened (include sender for group chats)
        await addMessage(chatId, 'user', text, from);
        const reactionDisplay = quickReaction.type === 'custom' ? (quickReaction as { type: 'custom'; emoji: string }).emoji : quickReaction.type;
        await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);

        console.log(`[main] Reacted to ${from} with ${reactionDisplay}`);
      } else {
        // Classifier said react but named no reaction: nothing gets sent, so this branch is an
        // ignore — and it must record the message like the ignore branch does, or the room's
        // history loses what was said ("what did Sam just say?" with no record of it).
        await addMessage(chatId, 'user', text, from);
      }
      // Same as the ignore branch: a reaction (or a named-nothing non-reaction) is the end of the
      // turn, and it never reaches withTypingKeptAlive's finally.
      if (startedTypingEarly) releaseTyping(chatId);
      return;
    }

    console.log(`[main] Agent should respond to this group message`);
    void startTyping(chatId); // now it's certain — the classifier said respond
  } else if (isGroupChat) {
    console.log(`[main] Responding to group media (skipping classifier)`);
  }

  // If the user tapped reply on an earlier message, resolve WHAT they meant, thread-aware: one of
  // Irises's own bubbles, the user's own thread root (the transport collapses a tapped reply to the
  // root — for a reply on an Ops answer that's the originating question), or an honest unresolved.
  // `let`: re-resolved if a late-drained message brings a different tapped-reply target.
  let repliedTo: ResolvedReply | undefined = incomingReplyTo ? await resolveTappedReply(incomingReplyTo.message_id, chatId, incomingReplyTo.content) : undefined;

  // Get agent's response (typing indicator shows while this runs)
  await waitForUserQuiet(chatId);

  // The turn's WHOLE life — think (the LLM call, which reads history) → speak (every bubble) →
  // remember (the history record) — is ONE per-chat critical section. Holding the mouth across the
  // LLM call, not just the sends, is what makes the agents one entity in time (INV-2, extended):
  //   • no follow-up (an Ops answer or engine push) can land between this turn's history read and its reply,
  //     so the reply is never voiced blind to a message that would precede it on screen;
  //   • a queued follow-up voices only AFTER this reply is sent and recorded, so it speaks with
  //     full awareness of it. Order of voicing === order on screen === order in history.
  // withTypingKeptAlive wraps the WHOLE critical section (queue wait included): the dots stay live
  // while this turn waits for a follow-up mid-delivery and through its own LLM call, so a queued
  // turn never reads as dead air. sendBubbles manages its own dots per bubble; overlap is harmless.
  let turnOut: AgentChatResult | null = null;
  let opsCancel: AbortController | null = null;
  await withTypingKeptAlive(chatId, withChatLock(chatId, async () => {
  // Fold in texts that arrived while this turn WAITED for the mouth (a follow-up mid-delivery, a
  // long prior send). The turn hasn't started thinking yet, so a message that would otherwise sit
  // a whole settle-cycle behind joins THIS reply instead — the way a person reads every new text
  // on their screen before starting to type. Never runs one message behind under bursty chatting.
  // Group-chat classification ran on the original batch only (a drained late rides along — we had
  // already decided to respond); `from` deliberately stays the original sender (their profile was
  // fetched above), the manifest still labels each message's own handle.
  if (lateArrivals) {
    const late = lateArrivals.drain();
    if (late.length) {
      console.log(`[main] folding ${late.length} late-arriving message(s) into this turn`);
      lateArrivals.batch.push(...late); // same array the pending-inbound glance reads — stays exact
      const remerged = mergeBurst(lateArrivals.batch);
      if ((remerged.incomingReplyTo?.message_id ?? null) !== (incomingReplyTo?.message_id ?? null)) {
        incomingReplyTo = remerged.incomingReplyTo;
        repliedTo = incomingReplyTo ? await resolveTappedReply(incomingReplyTo.message_id, chatId, incomingReplyTo.content) : undefined;
      }
      text = remerged.combinedText;
      messageId = remerged.lastMessageId;
      media = remerged.media;
      incomingMessageIds = remerged.incomingMessageIds;
      manifest = remerged.manifest;
      earliestReceivedAt = remerged.earliestReceivedAt;
    }
  }
  // Everything queued is in. From here until the reply commits, a newer text replaces it.
  turn?.arm();
  // Per-message staleness, computed AFTER the drain so a folded-in late message is measured against the
  // sends that actually preceded it: how many of Irises's bubbles landed after each text-bearing message
  // arrived. arrivals[i].sendsAfterArrival > 0 ⇒ [msg i+1] was typed before bubbles it never saw, so the
  // prompt tells the model to check whether those already answered it before re-answering (outboundLog).
  const arrivals = manifest.map(m => ({
    receivedAt: m.receivedAt,
    sendsAfterArrival: m.receivedAt > 0 ? countSendsSince(chatId, m.receivedAt) : 0,
  }));
  const staleArrivals = arrivals.filter(a => a.sendsAfterArrival > 0).length;
  if (staleArrivals) console.log(`[main] ${staleArrivals}/${arrivals.length} queued message(s) predate later sends`);

  // ── the early sink ────────────────────────────────────────────────────────────────────────────
  // What `chat()` calls with each sentence of the reply the moment the model has written it, on the
  // turns its early-emit gate arms (agents/convo/client.ts; pipeline/earlyEmit.ts). A sentence goes
  // out through the same steps as any other bubble: the send law's split (so it is shaped exactly as
  // it would be inside the whole reply), the per-bubble guardrail, and sendOneBubble's pacing, typing
  // and sent-bubble record. `sentEarly` is what the channel actually took, bubble by bubble, which is
  // what the remainder below is cut against.
  //
  // Bubble 1's thread target is the one resolveOutboundBubbles gives a single message's first bubble
  // (a burst never arms, so its per-bubble tags never reach here): anchored to their message when they
  // tapped reply or the reply is gapped, else none. Both reads are the ones the send block below
  // makes, taken now because the first bubble can leave before the reply exists. The early sends log
  // no delivery (the delivery is logged once, by whatever sends last), so the send log the `gapped`
  // read below makes still hasn't moved since this one.
  const earlyAnchor = (incomingReplyTo || (earliestReceivedAt > 0 && countSendsSince(chatId, earliestReceivedAt) > 0))
    ? { message_id: messageId }
    : undefined;
  const sentEarly: string[] = [];
  // It reports what of the sentence actually went out rather than throwing, so a send that fails on
  // its second piece still leaves the first one in the turn's record.
  const earlySend = async (sentence: string): Promise<{ shown: string; error?: unknown }> => {
    // A bubble on their screen is the reply becoming real: no newer text replaces it after this.
    if (turn && !turn.commit()) return { shown: '', error: turn.signal.reason };
    const shown: string[] = [];
    try {
      for (const piece of splitIntoBubbles(sentence)) {
        const bubble = prepareBubble(piece);
        if (!bubble) continue;
        // First means first on their screen, which only this side knows: `chat()`'s own `isFirst` is
        // the same thing whenever the first sentence's pieces all survive the guardrail.
        const first = sentEarly.length === 0;
        await sendOneBubble(chatId, bubble, { isFirst: first, isLast: false, replyTo: first ? earlyAnchor : undefined });
        sentEarly.push(bubble);
        shown.push(bubble);
      }
    } catch (error) {
      return { shown: shown.join(' '), error };
    }
    return { shown: shown.join(' ') };
  };

  // A turn that dies after its opening went out early did answer, in part: that part is on their
  // screen, so it goes in the history (nothing else will record it, the convo client never reached
  // its own write) and the delivery is logged and its dots put down, the way a finished send would.
  // The error still propagates, tagged, so the failure is reported as the partial answer it was.
  const closeEarlyOnFailure = async (error: unknown): Promise<never> => {
    if (sentEarly.length) {
      await addMessage(chatId, 'assistant', sentEarly.join(' ')).catch(err => console.error('[main] failed to record the early bubbles of a failed turn', err));
      if (resolveChannel(chatId).caps.typing) releaseTyping(chatId);
      noteSend(chatId);
      if (error && typeof error === 'object') (error as { answeredInPart?: number }).answeredInPart = sentEarly.length;
    }
    throw error;
  };

  const out = await agentClient.chat(chatId, text, media, {
    isGroupChat,
    participantNames,
    chatName: chatInfo.display_name,
    senderHandle: from,
    senderProfile,
    incomingMessageId: messageId,
    repliedTo,
    // Deprecated alias kept for the soak — 'assistant' only; every reader prefers `repliedTo`.
    repliedToText: repliedTo?.kind === 'assistant' ? repliedTo.text : undefined,
    // On a burst (2+ text-bearing messages), hand the model the numbered manifest so it can tag
    // each bubble [[re:N]] with the message it answers. Omitted for a single message (no tagging).
    burstManifest: manifest.length > 1 ? manifest : undefined,
    // Per-message arrival truth (aligned to burstManifest / [msg N]), so the prompt can flag a queued
    // message Irises has already sent past as answering an older state of the thread.
    arrivals,
    earlySend,
    supersede: turn,
  }).catch(closeEarlyOnFailure);
  turnOut = out;
  const { text: responseText, reaction, renameChat, rememberedUser, generatedImage, groupChatIcon, removeMember, delegatedTask, hardCapped, turnTrace, unsend } = out;
  console.log(`[timing] agent: ${Date.now() - start}ms`);
  console.log(`[debug] responseText: ${responseText ? `"${responseText.substring(0, 50)}..."` : 'null'}, renameChat: ${renameChat || 'null'}, generatedImage: ${generatedImage ? 'yes' : 'null'}, removeMember: ${removeMember || 'null'}`);
  // Send reaction if agent wants to. On a burst the model may target a specific [msg N] via `re` (e.g.
  // tapback the one message a later send already answered); resolveReactionTarget maps it to that id,
  // falling back to the latest message when there's no valid target.
  if (reaction) {
    await sendReaction(chatId, resolveReactionTarget(reaction.re, incomingMessageIds, messageId), reaction);
    console.log(`[timing] reaction: ${Date.now() - start}ms`);
  }

  // Take back one bubble of her previous reply before this reply's bubbles go out. Either way it
  // lands in her history, so she knows whether they can still see it.
  if (unsend) {
    const outcome = await executeUnsend(chatId, unsend, unsendMessage);
    if (outcome.status === 'invalid') console.warn(`[main] unsend: bubble ${unsend.bubble} was not on offer (chat ${chatId})`);
    else {
      console.log(`[main] unsend ${outcome.status} (${unsend.why}, chat ${chatId})`);
      const quoted = outcome.text.replace(/\s+/g, ' ').slice(0, 80);
      await addMessage(chatId, 'assistant', outcome.status === 'unsent'
        ? `[unsent "${quoted}"; they no longer see it]`
        : `[tried to unsend "${quoted}"; it did not go through, they still see it]`);
    }
  }

  // Rename group chat if agent wants to
  if (renameChat && isGroupChat) {
    await renameGroupChat(chatId, renameChat);
    console.log(`[timing] renameChat: ${Date.now() - start}ms`);
  }

  // Remove member from group chat if agent wants to
  if (removeMember && isGroupChat) {
    try {
      await removeParticipant(chatId, removeMember);
      console.log(`[timing] removeMember: ${Date.now() - start}ms`);
    } catch (error) {
      console.error(`[main] Failed to remove member ${removeMember}:`, error);
    }
  }

  // Send text response if there is one
  let finalText = responseText;

  // If agent renamed chat but didn't send text, Fallfirm voices the confirmation (group chats only)
  if (!finalText && renameChat && isGroupChat) {
    console.log(`[main] Agent renamed chat without text, voicing acknowledgment`);
    finalText = await voiceOutcome({ kind: 'confirmed', summary: 'you renamed the group chat', facts: `the new name is "${renameChat}"` }, chatId, from);
  }

  // If agent used remember_user without text, just log it - no automatic acknowledgments
  if (!finalText && rememberedUser) {
    console.log(`[main] Agent saved user info without text response (no auto-ack)`);
  }

  // Per-bubble native reply threading. In a burst the model tags each bubble [[re:N]]; resolve those
  // to the specific incoming message ids so each answer quotes the text it belongs to. On a single
  // message we anchor the FIRST bubble to it (then flow) only when it needs it: they tapped reply, OR
  // the reply is "gapped" — Irises already sent bubbles after this message arrived (e.g. a burst reply
  // to earlier messages), so those now sit between it and this reply and a bare reply would look detached.
  const isBurst = incomingMessageIds.length > 1;
  // "Gapped" ⟺ Irises sent at least one bubble after the earliest message arrived. Equivalent to the old
  // lastSend > earliestReceivedAt (sends are monotonic, so any-after ⟺ latest-after); the log hasn't
  // moved since the pre-LLM read (Convo's own sends happen below, in sendBubbles).
  const gapped = earliestReceivedAt > 0 && countSendsSince(chatId, earliestReceivedAt) > 0;
  const anchorFirstTo = (incomingReplyTo || gapped) ? { message_id: messageId } : undefined;

  // What the bubble law did to this reply — and the last field the turn receipt is missing. Seeded
  // as "nothing shipped" so every exit below (a reaction-only turn, a turn that produced nothing at
  // all) still has an honest reading to file: an empty list capped nothing and split nothing.
  let bubbleReport = buildBubbleReport([], { hardCapped: false, splits: 0 });
  // Whether bubbles went out early and nothing has closed that delivery yet (see after the block).
  let earlyDeliveryOpen = sentEarly.length > 0;

  if (finalText || generatedImage || groupChatIcon) {
    // Split into bubbles, strip the routing tags, and compute each bubble's native-reply target.
    const split = finalText ? splitIntoBubblesWithSplits(finalText) : { bubbles: [] as string[], splits: 0 };
    const { bubbles, targets } = finalText
      ? resolveOutboundBubbles(split.bubbles, incomingMessageIds, { isBurst, anchorFirstTo })
      : { bubbles: [] as string[], targets: [] as (ReplyTo | undefined)[] };

    // What the bubble law did to THIS reply, read ONCE, here: this is the only place the list that
    // actually ships is known, and both caps are otherwise invisible (each only logs). `hardCapped`
    // rides `out` from the parse that produced this very text (never a process-wide tally, which
    // would attach another chat's or another agent's cap to this receipt); `splits` comes from the
    // split above. Also parked per chat (lastBubbleReport) for an out-of-band reader — see the
    // ordering note there; a turn receipt assembled here uses the returned report directly.
    // Part of the reply may already be on their screen (the early sink above): then only what follows
    // it is sent, cut with the same comparison the history row was settled with (convo/shared.ts). A
    // turn that sent nothing early takes none of this and runs exactly as it always has.
    // Compared as cleaned (sendBubbles' own per-bubble guardrail), because what went early was cleaned
    // on its way out: a final bubble still carrying an echoed `[9:14 AM]` marker is the line already
    // on their screen, and comparing it raw would read as a new one and send it twice.
    const remainder = sentEarly.length
      ? remainderAfterPrefix(bubbles.map(prepareBubble).filter(Boolean), sentEarly)
      : null;
    if (remainder?.diverged) console.log(`[main] the reply changed after ${sentEarly.length} bubble(s) went out early — sending only what is new (chat ${chatId})`);
    // The report reads the reply as it reached them: what went early, then what follows it.
    const shipped = remainder ? [...sentEarly, ...remainder.rest] : bubbles;
    bubbleReport = noteBubbleReport(chatId, buildBubbleReport(shipped, { hardCapped: hardCapped === true, splits: split.splits }));

    // If we're delegating, thread the LATE Ops follow-up to the message that actually asked, not the
    // last burst message (which may be a "thanks"). Prefer the message a holding bubble quoted; else,
    // in a burst, default to the FIRST message (the substantive ask usually leads).
    if (delegatedTask) {
      const quoted = targets.find(t => t?.message_id)?.message_id;
      if (quoted) delegatedTask.replyToMessageId = quoted;
      else if (isBurst && incomingMessageIds.length) delegatedTask.replyToMessageId = incomingMessageIds[0];
    }

    // Send text messages first (before generating image). The Convo client already
    // recorded the assistant turn, so don't double-record here (record: false).
    if (remainder) {
      // Only the rest, unthreaded: the one bubble a single message's reply anchors is the first, and
      // that one already went. sendBubbles puts the dots down and logs the delivery after its last.
      if (remainder.rest.length > 0 && await sendBubbles(chatId, remainder.rest, { record: false }) > 0) {
        earlyDeliveryOpen = false;
      }
      console.log(`[timing] sendMessage (${sentEarly.length} early + ${remainder.rest.length} after): ${Date.now() - start}ms`);
    } else if (bubbles.length > 0) {
      await sendBubbles(chatId, bubbles, {
        targets,
        record: false,
      });
      console.log(`[timing] sendMessage (${bubbles.length} text msg${bubbles.length !== 1 ? 's' : ''}): ${Date.now() - start}ms`);
    }

    // Now generate and send image if requested
    if (generatedImage) {
      await startTyping(chatId);
      console.log(`[main] Generating image after sending text...`);
      const imageUrl = await agentClient.generateImage(generatedImage.prompt);
      if (imageUrl) {
        await new Promise(resolve => setTimeout(resolve, 300));
        // Record a placeholder so a reply tapped on the image bubble resolves to something meaningful
        // (this path bypasses sendBubbles, hence the explicit recordSentBubble).
        const sentImg = await sendMessage(chatId, '', undefined, [{ url: imageUrl }]);
        if (sentImg?.message?.id) void recordSentBubble(chatId, sentImg.message.id, `[you sent a generated image: ${generatedImage.prompt.slice(0, 80)}]`);
        await addMessage(chatId, 'assistant', `[generated an image: ${generatedImage.prompt.substring(0, 50)}...]`);
        console.log(`[timing] generateImage + sendImage: ${Date.now() - start}ms`);
      } else {
        const line = await voiceOutcome({ kind: 'failed', summary: "generating that image didn't work", nextStep: 'ask them to try again' }, chatId, from);
        const sentFail = await sendMessage(chatId, line);
        if (sentFail?.message?.id) void recordSentBubble(chatId, sentFail.message.id, line);
        console.log(`[main] Image generation failed`);
      }
    }

    // Generate and set group chat icon if requested
    if (groupChatIcon && isGroupChat) {
      await startTyping(chatId);
      console.log(`[main] Generating group chat icon...`);
      const imageUrl = await agentClient.generateImage(groupChatIcon.prompt);
      if (imageUrl) {
        await setGroupChatIcon(chatId, imageUrl);
        await addMessage(chatId, 'assistant', `[set group chat icon]`);
        console.log(`[timing] generateIcon + setIcon: ${Date.now() - start}ms`);
      } else {
        const line = await voiceOutcome({ kind: 'failed', summary: "setting the group chat icon didn't work", nextStep: 'ask them to try again' }, chatId, from);
        const sentFail = await sendMessage(chatId, line);
        if (sentFail?.message?.id) void recordSentBubble(chatId, sentFail.message.id, line);
        console.log(`[main] Group icon generation failed`);
      }
    }

    const threaded = anchorFirstTo || targets.some(Boolean);
    const extras = [threaded && 'thread', generatedImage && 'image', groupChatIcon && 'icon', removeMember && 'removeMember'].filter(Boolean).join(', ');
    console.log(`[timing] total: ${Date.now() - start}ms (${extras || 'text only'})`);
  } else if (reaction) {
    console.log(`[main] Reaction-only response (saved to history for context)`);
  }

  // A reply that went out early and left nothing after it never reached sendBubbles, which is what
  // puts the dots down and logs the delivery once a reply is out. Close it here the same way: the
  // dots come down now rather than at the lock's exit, and the send log gets its one entry, so the
  // next turn reads this one as sent.
  if (earlyDeliveryOpen) {
    if (resolveChannel(chatId).caps.typing) releaseTyping(chatId);
    noteSend(chatId);
    // With no text left at all the send block never read the bubbles, so the receipt's reading is
    // still "nothing shipped". What shipped is what went early.
    if (!finalText) bubbleReport = noteBubbleReport(chatId, buildBubbleReport(sentEarly, { hardCapped: false, splits: 0 }));
  }

  // ── the turn receipt ────────────────────────────────────────────────────────────────────────
  // ONE `turn:trace` per user-visible turn, filed here and nowhere else. This is the only point
  // that knows BOTH halves: what was in front of the model (the draft the Convo turn returned —
  // prompt sections and sizes, the pre-turn gates, the emitted status and what it had to be coerced
  // into, this turn's focus hits) and what actually came out (the bubble reading above). It sits
  // AFTER every exit of the send block, so it is unconditional by construction: a normal reply, a
  // reaction-only turn, a tool-only turn and a turn that shipped nothing all file one — the last of
  // those with `bubbles.count` 0 and `outcome.silent` true, which is the whole point of firing on
  // the no-op. Names and numbers only (it persists 30 days), flag and never-throw guard inside.
  //
  // The one turn that files nothing: a THROW between the agent call above and this line (sendBubbles,
  // sendReaction, an image generation). That reply never went out, and the error log plus reportError
  // already own that story — the receipt is about what the model was shown for a reply that shipped.
  // Closing it would mean a try/finally around the whole send block, i.e. re-indenting this critical
  // section for a diagnostic; if a receipt for a died-mid-send turn is ever wanted, that is the shape
  // it takes and `bubbleReport` already holds the honest "nothing shipped" reading for it.
  recordTurnTrace(turnTrace, { chatId, handle: from, bubbles: bubbleReport });

  // Mark delegated work in-flight AND kick it off, at the END of the critical section (after the
  // holding line has already been sent above — Ops therefore starts once the ack is out, never before
  // it). markOpsStart stays INSIDE the lock (INV-1, airtight): between the delegation decision and this
  // marker no other turn can even start its LLM call, so none can observe "delegated but unmarked" and
  // double-run the same ask. The AbortController is registered alongside so a user cancel
  // (cancel_research) reaches the running loop. The follow-up arrives via sendFollowUp, which
  // re-acquires the mouth and VOICES under it. A media_read task goes to MM (silent run), everything
  // else to Ops (progress-pinged).
  if (delegatedTask) {
    if (isGroupChat) delegatedTask.room = true;
    opsCancel = new AbortController();
    // The estimate is chosen ONCE here and read by every later ping (opsCoordination), so it takes
    // the leg budget this task will actually run on — a walled-URL browser look gets minutes, and a
    // ping must never call minute three of it an overrun.
    markOpsStart(chatId, delegatedTask.id, { kind: delegatedTask.kind, request: delegatedTask.request, engineActions: delegatedTask.engineActions, estimate: estimateOpsEta({ kind: delegatedTask.kind, request: delegatedTask.request, engineActions: delegatedTask.engineActions, forceGrounding: delegatedTask.forceGrounding, budgetMs: browserLegBudgetFor(delegatedTask) ?? undefined }) }, opsCancel);
    // chatId in the line: this is the only observable marker that a turn delegated, and without it a
    // log-only diagnosis (trace buffer full or unreachable) can't tell WHICH chat delegated.
    console.log(`[main] Delegating ${delegatedTask.kind} task to the engine (chat ${chatId})`);
    void runOpsAndFollowUp(delegatedTask, sendFollowUp, opsCancel.signal);
  }
  })); // end withChatLock — think + speak went out as one ordered, uninterleaved unit

  console.log(`[main] Reply sent to ${from}`);
}

/**
 * Warm the classifiers for the burst as it stands (the last same-sender run in the queue). Called on
 * every inbound text, and again when a replaced reply's run goes back in front of the newer text, so
 * the restarted turn finds its verdicts already computed for the string it will read.
 */
function warmBurst(chatId: string, pending: PendingChat): void {
  // Classify DURING the settle window (the user chose this over folding the classifier into the
  // convo call): the verdict for the burst as it stands right now is computed while we wait for
  // them to stop typing, so the gate in chat() reads a finished (or in-flight, joined) answer and
  // never adds its own latency. A newer text changes the combined string, so its own warm call
  // replaces this one's relevance; the stale entry is simply never read.
  //
  // The string warmed is the one chat() will read. A turn is one CONSECUTIVE same-sender run
  // (processPendingChat), merged by mergeBurst and handed to chat() untouched, where the gate trims
  // it — so the run this text just joined, merged the same way, is that string. In a 1:1 the run is
  // the whole burst. In a group every run is warmed at its own last text, which is the last moment
  // it was the run still growing; a group message the room gate then ignores costs five tokens.
  //
  // Every condition is the prefetch's own in chat(), asked of the same functions with the same
  // facts: the hooks flag (with it off no gate runs, so there is nothing to warm for), no media (a
  // voice memo folds its transcript into the text later, and any attachment changes the gate's
  // facts), the text-bearing count as the burst size, and the share flag, without which every
  // signal is a veto and the share turns — the slow ones — would never be warmed. Read per text
  // rather than once: an env flip between two texts of one burst costs at most one wasted call.
  // The one miss: a text that lands while this chat's turn waits for the mouth is warmed as a run of
  // its own, and the turn then folds it into the remerged whole — a different string, so that turn
  // makes its own call exactly as it did before the warm existed.
  const run = splitBurstBySender(pending.messages).at(-1) ?? [];
  const from = run.at(-1)?.from;
  if (!from) return;
  const burstText = mergeBurst(run).combinedText.trim();
  if (hooksEnabled() && burstText && run.every(m => !hasMedia(m.media))
      && classifyNeeded(burstText, {
        attachmentNote: false,
        burstSize: run.filter(m => m.text?.trim()).length,
      }, { shareTurns: shareTurnsEnabled(), takeTurns: shareTurnsEnabled() })) {
    warmIdleClassify({ chatId, handle: from }, burstText);
  }
  // The reach judge reads every burst, not just the idle-shaped ones: the long, detailed ask the idle
  // gate skips is the one most likely to need reach. Warmed here so the verdict lands during the
  // settle, before the early-emit pre-check and the routing gate read it (convo/reachClassify.ts).
  if (burstText) warmReachClassify({ chatId, handle: from }, burstText);
}

/**
 * Enqueue one inbound message into the per-chat batching/mouth pipeline. This is the SINGLE inbound
 * entry every channel funnels through — the web/CLI channel and the engine bridge — so
 * burst-merge, the rolling settle window, the late-arrival fold, the mouth lock, and diagnostics
 * all apply uniformly regardless of transport.
 */
export function enqueueInbound(
  agentClient: AgentClient,
  chatId: string,
  from: string,
  text: string,
  messageId: string,
  media: IncomingMedia,
  incomingReplyTo?: ReplyTo,
  receivedAt?: number,
): void {
  if (!pendingChats.has(chatId)) {
    pendingChats.set(chatId, {
      chatId, messages: [], timer: null, lastActivityAt: 0, isProcessing: false, inFlightBatch: null, turn: null, agentClient,
    });
  }
  const pending = pendingChats.get(chatId)!;
  // receivedAt is the message's real platform send time when the bridge forwarded one (normalized
  // upstream); it feeds arrivals/gap detection. Falls back to now when absent (web/CLI, or an engine
  // that doesn't forward timestamps) — exactly the prior behavior.
  pending.messages.push({ from, text, messageId, media, incomingReplyTo, receivedAt: receivedAt ?? Date.now() });
  noteInbound(chatId);
  // Their reply is still being written: drop it, so the burst is answered once with this text in it
  // (processPendingChat puts the run back in front of this one). Only when this text would join that
  // run — in a group, another sender's run queued in between keeps its place and this one waits.
  const joinsTurn = (pending.inFlightBatch ?? []).every(m => m.from === from) && pending.messages.every(m => m.from === from);
  if (joinsTurn) pending.turn?.supersedeBy(from);

  warmBurst(chatId, pending);

  // Index this inbound message's id → text so a LATER tapped reply that the transport collapses to
  // the thread root (this user's own message) resolves to what they said. Sits HERE, in the single
  // inbound entry point, so web/bridge inherit it for free. Fire-and-forget; the burst settle
  // window guarantees the write lands well before any turn reads it. Media-only messages carry no
  // resolvable text, so they're skipped.
  if (text?.trim()) void recordInboundMessage(chatId, messageId, text, from);

  // Reset the rolling window from THIS message; its length grows with the burst size (5s, 6s, …).
  pending.lastActivityAt = Date.now();
  // They just sent — they're not mid-typing THIS message anymore (feeds only waitForUserQuiet).
  setTyping(chatId, false);
  scheduleTick(chatId, burstSettleMs(pending));
}

/** Feed a channel's typing-indicator event into the send-pause tracker (opt-in waitForUserQuiet).
 *  DORMANT: no surviving inbound door emits typing events (web/CLI and the bridge don't forward
 *  them), so this — and the PAUSE_WHILE_TYPING knob it feeds — is inert until a channel wires it. */
export function setTypingInbound(chatId: string, isTyping: boolean): void {
  setTyping(chatId, isTyping);
}

/** The enqueueInbound signature — channel routers receive it via dependency injection. */
export type EnqueueInbound = typeof enqueueInbound;

// The ENGINE owns email and every other account connection. Engine-initiated
// proactive messages (reminders, mail nudges, background findings) arrive here instead, voiced
// by the Composer in Irises's tone (Fallfirm underneath) and delivered through the per-chat mouth
// like any follow-up.
app.use(createEnginePushRouter({ deliver: proactive.deliver }));

// In-app prompt diagnostics dashboard (guarded by DEBUG_TOKEN / localhost).
app.use(createDiagnosticsRouter());

// Admin orchestration dashboard — the password-gated GUI at /dashboard showing the
// agent-to-agent prompt flow graph per chat/user (password: DASHBOARD_PASSWORD).
app.use(createAdminDashboardRouter());

// ── Channels ─────────────────────────────────────────────────────────────────
// The web/CLI debug channel (chat with Irises in the browser or via `npm run chat` — no external
// messaging setup needed) is on unless WEB_ENABLED=false. The bridge fronts the engine's own channel
// connections. Outbound routes by chatId prefix (channels/registry).
if (process.env.WEB_ENABLED !== 'false') {
  registerChannel(webChannel);
  app.use(createWebRouter({ enqueueInbound, agentClient: convoClient as unknown as AgentClient }));
}
// Bridge mode: engine-fronted chats (eng:<platform>:<chat>) — the engine's irises-bridge plugin
// forwards fronted inbound turns to /api/bridge/inbound (having suppressed the engine's own reply)
// and Irises answers back out through the engine's channel connections (EngineBackend.channelSend).
// Registered whenever an engine is configured; inert until a plugin actually posts.
if (process.env.OPS_BACKEND) {
  registerChannel(bridgeChannel);
  app.use(createBridgeInboundRouter({ enqueueInbound, agentClient: convoClient as unknown as AgentClient }));
}

// Serve the web debug client's static build (web/out from `npm run build:web`) at `/`, LAST so it
// never shadows the API/webhook routes above. Same-origin as /api/web/* → no CORS for the SSE stream.
// Missing in dev (use `npm run dev:web` on its own port instead) — express.static just 404s then.
const WEB_OUT = path.resolve(process.cwd(), 'web/out');
app.use(express.static(WEB_OUT));

// …and `/` is the URL the setup script and the engine skills tell people to open, so an unbuilt web
// client must not answer it with express's bare `Cannot GET /`. Checked per request (not at boot) so
// a build that lands while the server is up is picked up without a restart.
const WEB_NOT_BUILT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Irises · web client not built</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--mut:#8b93a7;--acc:#6ea8fe;--ok:#5bd6a0;--line:#262b36}
*{box-sizing:border-box}body{margin:0;padding:2rem 1rem;font:15px/1.6 -apple-system,system-ui,sans-serif;background:var(--bg);color:#e7eaf0}
main{max-width:44rem;margin:0 auto}
h1{font-size:1.15rem;margin:0 0 .2rem}
.ok{color:var(--ok);font-weight:600}
p{color:var(--mut)}
code{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.1rem .35rem;color:#e7eaf0}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.7rem .9rem;overflow:auto;margin:.5rem 0}
a{color:var(--acc)}
ul{padding-left:1.1rem}
li{margin:.35rem 0}
</style></head><body><main>
<h1><span class="ok">Irises is running.</span> The web chat UI just isn't built yet.</h1>
<p>The server is up and answering on this port — only the browser client's static build
(<code>web/out</code>) is missing, so there is nothing to show at <code>/</code>.</p>
<p>To build it, from the Irises install folder:</p>
<pre>npm run install:web &amp;&amp; npm run build:web</pre>
<p>Then restart Irises and reload this page.</p>
<p>In the meantime:</p>
<ul>
  <li><code>npm run chat</code> — talk to Irises in the terminal, from the same install folder. No build needed.</li>
  <li><a href="/health">/health</a> — live right now, if you want to confirm the server and which build is running.</li>
</ul>
</main></body></html>`;
app.get('/', (_req, res) => {
  const index = path.join(WEB_OUT, 'index.html');
  if (existsSync(index)) { res.sendFile(index); return; }
  res.status(200).set('Content-Type', 'text/html').send(WEB_NOT_BUILT_PAGE);
});

// Start server
app.listen(PORT, () => {
  // Slim boot: no local schedulers or email watchers — the ENGINE owns reminders and mail.
  // Its cron jobs deliver back through POST /api/engine/push, voiced by the Composer.
  // The only local timers are storage retention sweeps (short-tier expiry, 7d message
  // windows, ledger age-out, LONG revision caps) + the error/history prunes that arm
  // inside their own modules.
  startRetentionTimers();
  // Semantic recall over the cold archive: registers the real embedder and arms the background
  // vector backfill. A no-op unless MEMORY_SEMANTIC_RECALL is on and the OpenRouter lane has a
  // key — and this is the ONLY importer of that module, which is what keeps the test suite
  // structurally unable to reach an embeddings provider.
  initSemanticRecall();
  // The proactive sweep: quiet-hours deferrals whose morning has come, and rows a restart stranded
  // mid-delivery (boot + every 60s, unref'd like the retention timers).
  proactive.start();
  // Durable ops-task state: a row per background run, so a task a restart killed can be owned up to
  // — once, honestly, claiming no result — instead of leaving a holding line that never lands.
  // Registering the sink is what turns the feature on: with the flag off nothing is registered, the
  // registry's hooks stay one false `if` each, and no timer is armed.
  if (opsDurableTasksEnabled()) {
    const opsRecovery = createOpsTaskRecovery({ deliver: proactive.deliver });
    setOpsTaskSink(opsRecovery.sink);
    opsRecovery.start();
  }
  // Thread-revisit pings: the hourly sweep that asks how a thing they left hanging went. On unless
  // THREADING_PINGS_ENABLED says off (scripts/configure.sh --pings).
  initThreadPings({ deliver: proactive.deliver });
  // Her own texts: the hourly sweep that lets her start a conversation because something is on HER
  // mind (memory/musings.ts). Its own line, apart from every setup of theirs; IRISES_MUSINGS_ENABLED.
  initMusings({ deliver: proactive.deliver });

  // Update mechanism: a pidfile so scripts/update.sh can cycle this process, a periodic check of the
  // git remote for a newer build, and — woven through Convo, or pushed through the proactive pipeline
  // above — a proactive "upgrade available" note plus a "back on the new build" confirmation after
  // the operator applies it. APPLYING is terminal-only (scripts/update.sh); nothing here can do it.
  writePidFileAtBoot();
  const updateAnnouncer = createUpdateAnnouncer({ deliver: proactive.deliver });
  startUpdateChecker({ onUpdateDetected: sha => void updateAnnouncer.onUpdateDetected(sha) });
  void updateAnnouncer.announceUpgradeAppliedIfReceipt();

  // Engine-mode doctrine: sent once per content version to whichever engine is configured, so it
  // saves the standing section into its own instructions by its own hand.
  void ensureEngineOnboarded();
  // The first move: once per install, after the doctrine has landed, ask the engine what it already
  // knows about its user, seed that into her own memory, and either text them first (only where the
  // engine confirms real prior history on that chat) or arm the introduction to ride her reply to
  // their own first text. Default ON — one message following one deliberate install.
  initFirstMove({ deliver: proactive.deliver });

  console.log(`
  Irises — a general, casual, do-anything assistant
  Server running on http://localhost:${PORT}

  Endpoints:
    POST /api/web/message         - Web / CLI chat → Convo→Ops
    POST /api/bridge/inbound      - Engine bridge inbound (OpenClaw/Hermes)
    POST /api/engine/push         - Engine push door (scheduled/proactive delivery)
    GET  /debug                   - Prompt diagnostics
    GET  /dashboard               - Admin orchestration
    GET  /health                  - Health check

  Chat with Irises over the web debug client or the terminal (npm run chat).
  Bridge mode fronts your engine's own messaging (WhatsApp, Telegram, Signal, …).
  `);
});
