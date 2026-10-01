import { callLLM } from '../../llm/callLLM.js';
import { transcribeAudio } from '../../llm/transcribe.js';
import { convoToolList } from './tools.js';
import { rememberMedia } from './mediaRecall.js';
import { getPreference, ensureChatId, getForgetEpoch } from '../../db/repositories/memory.js';
import { memoryHandle, isGroupHandle } from '../../memory/identity.js';
import { getUserProfile } from '../../db/repositories/profiles.js';
import { buildContextBlockWithHot } from '../../memory/dossier.js';
import { memoryRelevanceEnabled, shortEntryLabel, threadHit } from '../../memory/relevance.js';
import { renderedTurnFocusHits, type TurnFocusHit, type TurnFocusInput } from './turnFocus.js';
import { getActiveOps, getRecentlyEndedOps } from '../../state/opsCoordination.js';
import { getConversation, addMessage } from '../../state/conversation.js';
import { recentHoldingBeats } from '../../state/holdingBeats.js';
import { getEngineBackend } from '../ops/engineBackend.js';
import { pendingIntroWeave } from '../ops/firstMove.js';
import { timestampLabel } from '../../pipeline/chatTime.js';
import { DEFAULT_TZ } from '../../pipeline/zonedTime.js';
import { getAffectState } from '../../db/repositories/affectState.js';
import { unsendOffer } from '../../state/unsend.js';
import {
  getRelationshipClimate, relationshipClimateEnabled,
} from '../../db/repositories/relationshipClimate.js';
import { getFamiliarity } from '../../db/repositories/familiarity.js';
import { familiarityBandFor, type FamiliarityBand } from '../../persona/familiarity.js';
import { getHookState } from '../../db/repositories/hookState.js';
import { readMoments, writeMoments } from '../../db/repositories/moments.js';
import { getThesis } from '../../db/repositories/thesis.js';
import { renderThesisSection } from '../../memory/thesisEngine.js';
import { readSelf } from '../../db/repositories/self.js';
import { renderSelfSection } from '../../memory/selfHarvest.js';
import { readOwedAsks, renderOwedSection, type OwedAsk } from '../../memory/owedAsks.js';
import {
  billOffers, renderMomentLines, sampleMoments, MOMENT_RECENT_EXCLUDE_MS,
} from '../../persona/moments.js';
import { pickThreadForTurn, type ThreadTurn } from '../../memory/threadHarvest.js';
import {
  classifyNeeded, endsInQuestion, isIdleTurn,
  type IdleFacts, type IdleReading, type IdleVerdict,
} from '../../persona/idle.js';
import { makeIdleClassifier } from './idleClassify.js';
import { curiosityPercent, defaultHookState, selectHook, type HookDirective, type HookSelectReport } from '../../persona/hooks.js';
import { familiarityEnabled, hooksEnabled, momentsEnabled, selfEnabled, shareTurnsEnabled, thesisEnabled } from '../../persona/featureFlags.js';
import { compileAffect, type CarriedIntent } from '../../persona/affectCompiler.js';
import { AFFECT_FRESH_MS } from '../../persona/threads.js';
import { classifyConsent } from '../ops/consent.js';
import { bandForDial, defaultClimate } from '../../persona/climate.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import { cycleAnchorMs } from '../../persona/config.js';
import type { ComputedState } from '../../persona/status.js';
import { hasMedia, type IncomingMedia } from '../../webhook/types.js';
import { reportError } from '../../diagnostics/errorLog.js';
import { record } from '../../diagnostics/trace.js';
import { HOOKS_SELECT_LABEL, MOMENTS_OFFER_LABEL } from '../../diagnostics/traceLabels.js';
import type { LlmMessage, LlmRequest, LlmResult, LlmToolDef } from '../../llm/types.js';
import {
  buildSystemPromptSections, processConvoResult, formatHistory, emptyExtras, callConvoLLM, annotateTappedReply,
  parkedApprovalStanding, withOnScreenNote, type ConvoStreamCommit,
} from './shared.js';
import { reachFlagged, warmReachClassify } from './reachClassify.js';
import { createEnvelopeStream } from '../../pipeline/envelopeStream.js';
import { BUBBLE_HARD_CAP } from '../../pipeline/bubbleJson.js';
import {
  cleanEarlySentence, sentenceBlocker, streamArmed, streamFirstBubbleEnabled,
} from '../../pipeline/earlyEmit.js';
import { liveRemindersFor } from './liveReminders.js';
import { helpText } from '../fallfirm/floor.js';
import { claimPendingUpdateNote } from '../../update/announce.js';
import type { ChatContext, ChatResponse, Reaction } from './shared.js';
import type { CraftTurnFacts } from './personaModules.js';

// Shared front-line types/helpers live in ./shared.js. Re-export the types so existing imports of
// `./convo/client.js` still resolve.
export type {
  StandardReactionType, ReactionType, Reaction,
  ChatContext, ImageInput, AudioInput, ChatResponse,
} from './shared.js';

/** How long a quiet stretch has to be before this turn counts as an OPENING — the same half hour
 *  the threading engine treats as the start of a conversation rather than the middle of one. */
export const UPDATE_NOTE_MIN_GAP_MS = 30 * 60 * 1000;

/**
 * May the one-off version note be claimed on this turn? PURE.
 *
 * The claim is one-shot per chat per version, so WHERE it is claimed decides whether the note
 * interrupts: taken three messages into a live back and forth it spends itself on the turn where
 * "by the way, you have an upgrade waiting" arrives instead of an answer. An opening is a real
 * quiet stretch before this message, or their very first message ever — and an unclaimed note is
 * not a lost note, it is simply still waiting at the next one.
 */
export function updateNoteOpening(gapMs: number, historyRows: number): boolean {
  return historyRows === 0 || gapMs >= UPDATE_NOTE_MIN_GAP_MS;
}

/**
 * The Convo model doesn't receive the file bytes itself, so a media turn gets a bracketed text note
 * telling it a file arrived and to open it via a delegated look (its own eyes — see the attachments
 * craft page, convo/craft/attachments.md). The note is framed as "open it to look", NEVER "you can't
 * see it": Irises must never tell the user she can't see/read a file. Audio is folded in as a
 * transcript (the cheap fast path) UNLESS transcription failed, in which case the note flags the
 * voice memo for a listen. The note rides textToSend so it persists in history and the model sees it
 * every turn.
 *
 * Whether this note came back is ALSO the gate on that craft page (personaModules.ts), plumbed
 * through `craftFacts` at the assembler call below: the page and the note arrive together.
 */
function describeAttachments(media: IncomingMedia, opts: { transcriptionFailed: boolean }): string {
  const bits: string[] = [];
  const n = (c: number, one: string, many: string) => (c === 1 ? one : `${c} ${many}`);
  if (media.images.length) bits.push(n(media.images.length, 'a photo', 'photos'));
  if (media.video.length) bits.push(n(media.video.length, 'a video', 'videos'));
  if (media.docs.length) bits.push(n(media.docs.length, 'a document', 'documents'));
  if (opts.transcriptionFailed) bits.push('a voice memo (transcription not folded in yet — delegate a look to listen)');
  if (!bits.length) return '';
  return `[they attached ${bits.join(' + ')} — the contents aren't unpacked into this note. to see/read what's inside, open it with delegate_to_ops (media_scope "this_turn"); that IS you looking. never guess at what's inside before opening it, and NEVER tell them you can't see/open it.]`;
}

/**
 * The early sink for ONE armed turn: the impure half of pipeline/earlyEmit.ts. It reads the model's
 * envelope as it streams (pipeline/envelopeStream.ts) and hands each finished sentence of the reply
 * to `send` the moment it closes, for as long as every check keeps reading clean.
 *
 * It only ever gets stricter. The first thing that fails disarms it for the rest of the turn and
 * nothing more goes out early; whatever the model writes after that point is the ordinary pipeline's
 * to judge, exactly as if nothing had streamed:
 *   • a `tool_calls` verdict that is anything but a confirmed empty one (the reader fails closed and
 *     reports it before the first sentence can exist), because a turn that acts can have its reply
 *     cut to a holding line or replaced by the results;
 *   • a sentence the per-sentence scan blocks (a promise, a claim, a refusal, an internal leak), or one
 *     that cleans down to nothing;
 *   • a sentence from a bubble at or past the count guard's last kept slot (bubbleJson.ts
 *     collectBubbles keeps the first BUBBLE_HARD_CAP-1 bubbles and the LAST one, so a bubble in
 *     between may not survive the parse, and one that went out early could not be taken back);
 *   • a send that fails, so an opening can never arrive with a hole in it.
 *
 * Sends run strictly in order on one chain, never overlapping: the send path paces each bubble, and
 * a second sentence must not overtake the first. `settled()` is that chain, and the turn waits on it
 * before it settles the reply, so `sent` is final by then: exactly what reached their screen, down to
 * the pieces of a sentence whose send failed partway (the sink reports what it got out).
 *
 * `committed()` is whether any sentence was handed to the sink at all, which is final the moment the
 * lane returns (it drops deltas after that). It is the question the recovery paths ask: a streamed
 * reply with nothing committed is a reply nobody has seen, so the ordinary retries may still run on
 * it; one with something committed may not answer over the top of it. `freeze()` disarms for good,
 * for a caller about to make a call of its own that must not stream.
 */
function armEarlySend(
  send: NonNullable<ChatContext['earlySend']>,
  ask: string,
  chatId: string,
  handle: string | undefined,
  taskTurn: boolean,
): {
  onTextDelta: (delta: string) => void; end: () => void; settled: () => Promise<void>; sent: string[];
  committed: () => boolean; freeze: () => void;
} {
  let armed = true;
  let failed = false;
  let queued = 0;
  let why: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  const sent: string[] = [];
  const disarm = (reason: string) => {
    if (!armed) return;
    armed = false;
    why = reason;
  };
  const stream = createEnvelopeStream({
    onToolCalls: empty => { if (!empty) disarm('tool_calls'); },
    onSentence: (bubble, text) => {
      if (!armed) return;
      if (bubble >= BUBBLE_HARD_CAP - 1) { disarm('hard_cap'); return; }
      const clean = cleanEarlySentence(text);
      const blocked = clean ? sentenceBlocker(clean, ask, taskTurn) : 'empty';
      if (blocked) { disarm(blocked); return; }
      queued++;
      const isFirst = queued === 1;
      chain = chain.then(async () => {
        if (failed) return;
        let error: unknown;
        try {
          const out = await send(clean, isFirst);
          if (out.shown) sent.push(out.shown);
          error = out.error;
        } catch (err) {
          error = err ?? new Error('early send failed');
        }
        if (error !== undefined) {
          failed = true;
          disarm('send_failed');
          console.warn(`[convo] early send failed — the rest of the reply goes out whole (chat ${chatId})`, error);
        }
      });
    },
  });
  let ended = false;
  return {
    onTextDelta: delta => {
      if (!armed) return;
      // The lane calls this from inside its stream reader, which must never see a throw from here.
      try { stream.push(delta); } catch (err) {
        disarm('reader_error');
        console.warn(`[convo] envelope reader threw — early send disarmed (chat ${chatId})`, err);
      }
    },
    end: () => {
      if (ended) return;
      ended = true;
      stream.end();
      // A turn that ends armed ran clean to the last sentence; `why` stays null for it.
      armed = false;
      // One receipt per armed turn, whichever way it went: how many sentences went out early and what,
      // if anything, stopped the rest. A turn that never armed files none, which is how "not eligible"
      // reads apart from "eligible and a check said no".
      record({ type: 'event', label: 'convo:early_send', chatId, handle, detail: { queued, disarmed: why } });
    },
    settled: () => chain,
    sent,
    committed: () => queued > 0,
    freeze: () => disarm('frozen'),
  };
}

export async function chat(
  chatId: string,
  userMessage: string,
  media: IncomingMedia,
  chatContext?: ChatContext,
  /**
   * The front-line model call, injectable for tests only (the repo's DI convention: `callLLM`'s own
   * `run`, `splitMiss`'s llm, the engine-backend stubs). Production callers pass nothing and get
   * `callConvoLLM`, unchanged.
   *
   * It exists because everything between the memory read and the reply — the relevance router
   * handed to the routing gate, the turn-focus hits, the receipt — is assembled HERE and nowhere
   * else, so a test that starts at `processConvoResult` cannot see any of it. The same function is
   * handed to `turn.call` below, so the retry ladders use the fake too.
   */
  call?: (req: LlmRequest, stream?: ConvoStreamCommit) => Promise<LlmResult>,
): Promise<ChatResponse> {
  const cmd = userMessage.toLowerCase().trim();

  if (cmd === '/help') {
    // A deterministic command card, not an outcome — served from the audited floor (see helpText),
    // deliberately NOT routed through Fallfirm, which is instructed to hide system/command names.
    return { text: helpText(), ...emptyExtras() };
  }

  const history = await getConversation(chatId);
  // Two identities ride every turn: `sender` (the person texting — per-person facilities like
  // profiles and automations) and `handle` (WHOSE MEMORY this turn reads/writes). They are
  // the same in a 1:1; in a GROUP chat the memory identity is the group's own fresh
  // `group:<chatId>` pseudo-handle, so no member's personal memory ever loads into (or is
  // written from) a group conversation.
  const sender = chatContext?.senderHandle;
  const handle = memoryHandle(chatContext, chatId);
  if (handle && !isGroupHandle(handle)) {
    // 1:1 only: prefs.chat_id is a proactive SEND target (engine push deliveries) — a group turn
    // must not repoint it, or a member's private delivery lands in the room.
    void ensureChatId(handle, chatId); // so engine-initiated pushes can reach them
  }

  // Read ONCE for the turn, and read HERE because the prefetch below is the first thing that needs
  // it: everything the rhythm pre-read does further down hangs off this flag, and two reads of one
  // env var in one turn is a turn that could start a classify call for a gate that never runs.
  const hooksOn = hooksEnabled();
  // Read ONCE for the same reason, one line down because it answers a narrower question: whether the
  // gate may return the third shape at all. Two reads — the prefetch's `classifyNeeded` and the gate
  // below — could answer differently if the env flipped between them, and a turn whose prefetch was
  // started under the share law and whose gate ran under the two-shape one either wastes a five-token
  // call or, the other way round, pays for it in latency on the turn it was meant to save.
  const shareOn = shareTurnsEnabled();

  // ── the classify prefetch ─────────────────────────────────────────────────────────────────────
  // Layer 3 of the turn gate, started in PARALLEL with the memory read rather than behind it. The
  // call is five tokens and a six-second deadline (convo/idleClassify.ts), and every millisecond of
  // it used to sit between their message and the first byte of the prompt, because the gate runs
  // after the dossier comes back and the gate is what asks.
  //
  // Since 2026-09-24 this is usually not the first ask. The inbound door already started the call
  // while the burst settled (index.ts enqueueInbound → `warmIdleClassify`), so the reading this line
  // starts is nearly always a cache hit or a join onto that call, and it only makes a call of its own
  // on a turn the door could not warm — a late text folded in, a warm that failed. The classifier
  // coalesces: a call already running for the same words is waited on rather than repeated, and the
  // warm itself files no receipt, so one text stays one lane call and one `idle:classify` receipt
  // whichever side got there first (convo/idleClassify.ts).
  //
  // THE PROMISE IS STILL THREADED. The reading is started here and the pending promise itself is what
  // the gate consumes, through the same classifier instance, because a second reading of the same
  // text would be a second receipt, and the live round reads "two receipts on one turn" as a broken
  // prefetch. The coalescing keeps a second reading from costing a second lane call; only threading
  // the promise keeps it from filing a second receipt.
  //
  // Two conditions, both about being able to promise the gate the SAME message. A voice memo folds
  // its transcript into the text further down, so the string the gate reads does not exist yet; and
  // `classifyNeeded` answers whether layer 3 will be reached at all, from the facts available before
  // the memory read (persona/idle.ts). The prediction is one-directional: a call this starts on a
  // turn a later veto settles is five tokens wasted, and the gate's own identity check below is what
  // makes a wrong guess about the TEXT cost nothing at all.
  const classifyIdle = makeIdleClassifier({ chatId, handle });
  const earlyText = userMessage.trim();
  const earlyClassify: Promise<IdleVerdict> | null = hooksOn
    && media.audio.length === 0
    && classifyNeeded(earlyText, {
      // The attachment note as it WILL be built below: with no audio on the turn there is no
      // transcription to fail, so this is the same string that call produces, asked of the same
      // function rather than guessed at.
      attachmentNote: !!describeAttachments(media, { transcriptionFailed: false }),
      burstSize: chatContext?.burstManifest?.length ?? 1,
    }, { shareTurns: shareOn, takeTurns: shareOn })
    ? classifyIdle(earlyText)
    : null;
  // The classifier swallows its own failures (it files `unclear` and returns), so this can only be
  // insurance — but an unconsumed rejection is a process-level event, and this promise is deliberately
  // allowed to go unconsumed when the gate reads a different string than the one predicted.
  if (earlyClassify) void earlyClassify.catch(() => {});

  // ONE engine read for the turn: it picks the delegate tool's lane, gates the reminder tools, feeds
  // the capability summary further down, and gates the live reminders read just below — all four
  // must agree on the same engine. Read HERE, ahead of the parallel batch, so that read can start
  // with it.
  const engine = getEngineBackend();
  const engineName = engine?.name ?? null;
  // The reminders standing for them (convo/liveReminders.ts), started now so the engine round trip
  // runs beside the memory reads instead of after them, and awaited just before the prompt is built.
  // Never rejects, and never outlasts its budget: a slow engine reads as null, which renders nothing.
  const liveRemindersRead = liveRemindersFor(engine, chatId, chatContext?.senderHandle);
  // Whether an approval is parked on this sender, for the early-emit gate below: the same pref the
  // approval resolution reads after the call (convo/shared.ts parkedApprovalStanding). Started here so
  // it rides beside the memory batch instead of adding a round trip in front of the model call, and
  // only on a turn that could arm at all: a caller with a sink, the switch on, not a room. So the kill
  // switch costs nothing, not even this read. Never rejects (a failed read is parked). The switch is
  // read ONCE, here, and the gate below takes the same answer.
  const streamOn = !!chatContext?.earlySend && streamFirstBubbleEnabled() && !(chatContext?.isGroupChat ?? false);
  const parkedRead: Promise<boolean> = streamOn
    ? parkedApprovalStanding(chatContext?.senderHandle)
    : Promise.resolve(false);

  // Read ONCE for the turn: it decides whether the ledger row is read below and whether the two
  // compiles get a band at all, and those have to agree.
  const familiarityOn = familiarityEnabled();
  const [context, agentTz, climate, thesisDoc, whoProfile, holdingBeats, selfFile, owedAsks, familiarityRow] = handle
    ? await Promise.all([
        // Pass the current turn text so the short-tier renderer can gate whether the freshest research
        // look renders in full (on-topic follow-up) or collapses to a settled digest line (topic moved on).
        // The WithHot variant also reports which look that was, so the turn-focus block can name it.
        buildContextBlockWithHot(handle, userMessage),
        getPreference<string>(handle, 'agent_tz'),
        // The weeks-scale standing register with THIS identity (climate.ts). Handle-keyed like the
        // memory tiers beside it, unlike the chat-keyed affect read below. Defaults when there's no
        // identity to key on, and a default climate renders nothing at all.
        // Two structural gates, both resolving to the default register (i.e. to nothing rendered):
        // the feature flag, and a GROUP identity — the eval never runs for a group, so a group row
        // can only exist as legacy or hand-written data, and "a group has no standing register" is
        // a property worth stating here rather than inheriting from what the writer happens to skip.
        relationshipClimateEnabled() && !isGroupHandle(handle)
          ? getRelationshipClimate(handle)
          : Promise.resolve(defaultClimate()),
        // Her ONE read on this person (memories/<handle>/THESIS.md), rewritten weekly by
        // memory/thesisRewrite.ts and rendered right behind the dossier it is the conclusion of. Read
        // HERE, in the same parallel batch as the dossier, because the prompt assembler is
        // synchronous and this is a file read — the same reason the intro weave arrives as a value.
        // Two structural gates, both resolving to no section at all: the feature flag, and a GROUP
        // identity — a room has no `them` for her to have a read about, and the pass that writes the
        // file skips a group for the same reason, so a group file can only be legacy or hand-written.
        thesisEnabled() && !isGroupHandle(handle) ? getThesis(handle) : Promise.resolve(null),
        // Their name, for the recency-edge self/them contrast the turn-focus block draws
        // (convo/turnFocus.ts `who`). Same handle-keyed read the dossier's "Who they are" renders
        // from, pulled here so the edge can name the far side of the contrast without a second parse
        // of the markdown. Null for a group or a not-yet-named person, which the block handles.
        getUserProfile(handle),
        // Her own last few holding beats in THIS chat (state/holdingBeats.ts), for the `recent_beats`
        // section the handoff rules point at. Chat-keyed, unlike the handle-keyed reads above: the
        // beat history belongs to the conversation. A pref read, so it rides this batch rather than
        // adding a round trip of its own. A turn with no handle gets no beats (the fallback below),
        // which is harmless: such a turn is rarely a delegating one.
        recentHoldingBeats(chatId),
        // What SHE holds with this person (memories/<handle>/SELF.md): the stances, tastes, lessons
        // and changes of mind the daily pass wrote down from her own lines (memory/selfHarvest.ts).
        // Same two gates as the thesis, for the same reasons: the flag, and a room has no `them`.
        selfEnabled() && !isGroupHandle(handle) ? readSelf(handle) : Promise.resolve(null),
        // What her mood put off for them and still owes (memory/owedAsks.ts). A pref read.
        !isGroupHandle(handle) ? readOwedAsks(handle) : Promise.resolve([] as OwedAsk[]),
        // How well she knows them (persona/familiarity.ts): the stored level the post-reply pass
        // keeps. Handle-keyed like the climate. Two gates, and both skip the read: the flag, and a
        // room, which is front stage and never has a level of its own.
        familiarityOn && !isGroupHandle(handle) ? getFamiliarity(handle) : Promise.resolve(null),
      ])
    : [{ block: '', hotLook: null, turn: null, gates: {}, craft: {}, pendingAsk: false }, undefined, defaultClimate(), null, null, [], null, [] as OwedAsk[], null];
  const contextBlock = context.block;
  // The read as the `thesis` dyn section, or '' — which pushes nothing, so an install with no thesis
  // builds a prompt byte-identical to one that never had the feature. `renderThesisSection` splits
  // the document again on its way through: the evidence tail is the weekly pass's private input and
  // has no business in a prompt (memory/thesisEngine.ts).
  const thesisSection = thesisDoc ? renderThesisSection(thesisDoc.docMd) : '';
  const selfSection = selfFile ? renderSelfSection(selfFile.entries) : '';
  const owedSection = renderOwedSection(owedAsks, Date.now());
  // THE MASK for this turn, decided once and handed to both compiles below — the hook engine's and
  // the weather block's (it rides `personaTurn` to the assembler) — so the two can never disagree
  // about how much of her mood shows. A room is a stranger and no row is the bottom of the scale
  // (persona/familiarity.ts familiarityBandFor). Undefined with the flag off: no mask at all, which
  // compiles exactly as before the feature existed.
  const familiarity: FamiliarityBand | undefined = familiarityOn
    ? familiarityBandFor({ group: isGroupHandle(handle), level: familiarityRow?.level ?? null })
    : undefined;

  // THE zone for this turn, resolved once here and handed to everything that renders a clock: the
  // circadian baseline, the tapped-reply date label that rides into durable history, the transcript
  // stamps, this turn's own stamp, and (as the assembler's `agentTz`) every clock inside the prompt.
  // Every one of those used to resolve its own zone or fall through to DEFAULT_TZ — the host's, UTC
  // in production — so a single prompt could carry two clocks seven hours apart. One value means
  // they cannot disagree. No stored preference → DEFAULT_TZ, exactly as before.
  const userTz = agentTz || DEFAULT_TZ;

  // Irises's hidden affect state: her persisted prior-turn mood/gauges/meta-prompt for THIS chat,
  // plus the clock-computed cycle/circadian baseline for right now (anchored to the user's tz).
  // Feeds the "internal weather" prompt block and is re-merged with the model's emitted status
  // after the reply. Never user-visible.
  const affectState = await getAffectState(chatId);
  const nowMs = Date.now();
  const computed: ComputedState = {
    cycle: computeCycle(nowMs, cycleAnchorMs()),
    circadian: computeCircadian(nowMs, userTz),
  };

  // Transcribe audio (in parallel) and fold into the text — the cheap fast path for voice memos, so
  // Convo answers them at text-model latency without a background file read.
  const transcriptionResults = await Promise.all(media.audio.map(a => transcribeAudio(a.url, a.mimeType)));
  const transcriptions = transcriptionResults.filter((t): t is string => Boolean(t));
  const transcriptionFailed = transcriptionResults.some(t => !t);

  let textToSend = userMessage.trim();
  if (transcriptions.length) {
    const t = transcriptions.join('\n');
    textToSend = textToSend ? `[Voice memo transcript: "${t}"]\n\n${textToSend}` : `[Voice memo transcript: "${t}"]\n\nRespond naturally.`;
  }

  // THEIR OWN WORDS, before any of the machinery below is folded in: what they typed, plus a voice
  // memo's transcript, and nothing else. The idle gate reads THIS rather than `textToSend`
  // (persona/idle.ts's `none` layer names the arrangement — "the attachment note the caller
  // stripped"), because the two annotations below are app metadata rather than a message: the
  // attachment note is already a structural veto in its own right, and the tapped-reply tag would
  // push every settled-ground comment past the length veto and make an idle turn impossible to have
  // by tapping one. A caption-less media turn leaves this EMPTY, and an empty message is a turn no
  // layer can read, which the gate calls work.
  const typedText = textToSend;

  // The Convo model doesn't receive the raw image/video/doc bytes (or a memo whose transcription
  // failed). A bracketed note tells it a file arrived and to open it via delegate_to_mm; on a
  // caption-less media turn the note stands in as the whole message so the model still has something
  // to act on. Framed as "open it to look", never "you can't see it" — Irises never disclaims sight.
  const attachNote = describeAttachments(media, { transcriptionFailed });
  if (attachNote) textToSend = textToSend ? `${textToSend}\n\n${attachNote}` : attachNote;

  // If they tapped reply on an earlier message, fold that context into the message itself so it
  // persists in history and reaches the API — not just this turn's system prompt. Thread-aware:
  // one of Irises's bubbles, the user's own thread root, or an honest unresolved marker.
  const repliedTo = chatContext?.repliedTo ?? (chatContext?.repliedToText ? { kind: 'assistant' as const, text: chatContext.repliedToText } : undefined);
  if (textToSend) textToSend = annotateTappedReply(textToSend, repliedTo, userTz);

  if (textToSend) await addMessage(chatId, 'user', textToSend, chatContext?.senderHandle);

  // The list itself — order included — lives in tools.ts (convoToolList); the flags are read HERE so
  // that function stays pure and testable.
  const tools: LlmToolDef[] = convoToolList({
    engineName,
    isGroupChat: chatContext?.isGroupChat ?? false,
    unsendBubbles: unsendOffer(chatId),
  });

  // Label the current turn with when it actually ARRIVED, not lock-acquisition time — a message that
  // queued behind the chat lock (while a follow-up delivered) would otherwise read as arriving after
  // bubbles it actually preceded. arrivals[0] is the earliest text-bearing message (queue order). The
  // DB record time is untouched (see addMessage above) so record order = lock order stays single-clock.
  const arrivedAt = chatContext?.arrivals?.[0]?.receivedAt ?? 0;
  const messages: LlmMessage[] = [
    ...formatHistory(history, chatContext?.isGroupChat ?? false, userTz),
    // Text-only: Convo never ingests media natively — the engine opens files.
    { role: 'user', timestamp: timestampLabel(arrivedAt > 0 ? arrivedAt : Date.now(), userTz) || undefined, content: textToSend || '...' },
  ];

  // Synchronous read of what Ops is working on for this chat RIGHT NOW (in-memory, race-free).
  const activeOps = getActiveOps(chatId);

  // `gapMs` is the real opening before this message. It gates two things, for the same reason: the
  // loop stage below (a reopening callback belongs at the START of a conversation) and the version
  // note just under here.
  //
  // The stored rows carry `at`, but the type allows it to be absent (older rows, hand-built
  // fixtures), and an absent or non-finite stamp must read as "no idea how long it's been" — which
  // is Infinity, the value that makes both gates PASS. That is the right direction: a loop still has
  // to clear quiet-since-capture, the cooldown, the present-topic check and the turn/day budgets,
  // and treating an undated thread as mid-conversation would silently disable the callback on any
  // install whose history predates the stamps.
  const lastAt = history.length ? history[history.length - 1].at : undefined;
  const gapMs = typeof lastAt === 'number' && Number.isFinite(lastAt) ? nowMs - lastAt : Infinity;

  // If a version update is pending and this chat hasn't been told yet, weave a one-off mention into
  // this reply (claimed once per chat per version — this suppresses the cold proactive push for it).
  // Only at an OPENING: the claim is one-shot, so claiming it three messages into a live back and
  // forth spends it on the turn where "by the way, you have an upgrade waiting" arrives instead of
  // an answer. Mid-conversation the claim is left unconsumed and the note waits — it is still there
  // at the next real opening, which comes around within the hour.
  // Read ONCE for the turn: the gate and the receipt that reports it must not be able to disagree
  // because someone flipped the env between two calls.
  const gatesOn = memoryRelevanceEnabled();
  const updateOpening = !gatesOn || updateNoteOpening(gapMs, history.length);
  const updateNote = updateOpening ? claimPendingUpdateNote(chatId) : null;

  // What the active engine can actually do this deployment (closed vocabulary). Read INSTANTLY from
  // the backend's cached summary — this returns synchronously and never triggers a blocking fetch (the
  // adapter refreshes in the background), so it adds no latency to the turn. null when no engine, when
  // the backend doesn't do capability discovery, or before the first refresh has answered.
  const capabilitySummary = engine?.getCapabilitySummary?.() ?? null;

  // ── the rhythm pre-read ───────────────────────────────────────────────────────────────────────
  // What KIND of turn this is, and what a reply to it is allowed to carry. It runs HERE, ahead of
  // the thread pre-read, because its answer gates that one: a task turn makes no thread offer.
  //
  // Three steps, all of them decided before a single prompt byte is assembled:
  //   1. the turn gate (persona/idle.ts) — the structural reads, then the English fast path, then at
  //      most one tiny classify call for a message the fast path could not read or was barred from;
  //   2. the compiled affect directive (persona/affectCompiler.ts) — the same gauges the weather
  //      block renders, read for what they CLOSE rather than for what they say;
  //   3. the selector (persona/hooks.ts) — the ledger, the kill switch, the group rules.
  //
  // The whole block is gated by CONVO_HOOKS_ENABLED, read once at the top of the turn (`hooksOn`,
  // up beside the prefetch that is the flag's other consumer). Off means no turn gate runs at all —
  // so no classify call is ever made, by the gate or by the prefetch — the directive is null, the
  // `Turn:` line and the `hooks` section are never rendered, the hook and share craft pages never
  // load, and the thread engine offers exactly as it did before any of this existed.

  // The ledger row for this chat, and the epoch it was read under: the write at the end of the turn
  // is fenced on the epoch, so a /forget landing mid-turn cannot have its wipe undone by a save that
  // read the pre-forget state. Defaults (and epoch 0) with the flag off — nothing is read and
  // nothing will be written.
  //
  // Read BEFORE the gate rather than after it, which is the 2026-09-11 move: the gate now needs the
  // ledger's tail kind to tell her own confirm question from her own follow-up, and a row read after
  // the decision cannot inform it. It is the same row, read the same way, one await earlier.
  const hookState = hooksOn ? await getHookState(chatId) : defaultHookState();
  const hookEpoch = hooksOn ? getForgetEpoch(handle ?? '') : 0;

  // The facts the gate reads the turn against — every one of them computed somewhere else and passed
  // in, which is what keeps that module a leaf.
  //
  // The two question facts are SEPARATE on purpose, and the separation is the whole share shape.
  // `pendingAsk` is an action parked behind a word of theirs (the memory read's own reading), and it
  // is a work veto that nothing relaxes: "yes please" after "want me to send it?" is the most
  // load-bearing task turn there is. `endsInQuestion` is the weaker punctuation read, and it is owed
  // an answer in the same way UNLESS the only question standing is the follow-up she asked on a share
  // turn, which asked for nothing to be done — their reply to that is more of their own story, not a
  // piece of work. The ledger tail is what tells the two apart.
  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
  const idleFacts: IdleFacts = {
    attachmentNote: !!attachNote,
    burstSize: chatContext?.burstManifest?.length ?? 1,
    activeOps: activeOps.length > 0,
    pendingAsk: context.pendingAsk,
    endsInQuestion: endsInQuestion(lastAssistant?.content),
    // The rhythm ledger's tail, and nothing more: the move her LAST reply carried. `question` there
    // means the question outstanding is a follow-up (persona/hooks.ts records the emitted kind), and
    // with the hook flag off the state is the default, whose window is empty and whose tail is
    // therefore nothing at all.
    followUpOutstanding: hookState.lastKinds[hookState.lastKinds.length - 1] === 'question',
    // The consent reader's PURE half only (agents/ops/consent.ts classifyConsent). The lane half of
    // that module is for a turn where an approval is really parked and the words are worth a call;
    // here the question is only "did they answer yes or no", one settled word is the whole signal,
    // and a turn gate that could spend a second call on every stall would be a per-turn tax.
    consent: classifyConsent(typedText),
  };
  const idle: IdleReading = hooksOn
    ? await isIdleTurn(
        typedText, idleFacts,
        // The prefetch, consumed. The identity check is the whole of the seam: when the message the
        // gate is reading is the one the prefetch predicted, the pending promise IS the answer, and
        // when it is not — a voice memo, a caller that reshaped the text — the classifier is called
        // for real on the string actually in hand. The same instance either way, so one reading files
        // one receipt whichever branch runs.
        t => (earlyClassify && t === earlyText ? earlyClassify : classifyIdle(t)),
        // Takes ride the share switch: the same classify layer reads both, and a take is only ever a
        // task whose answer is her opinion (persona/idle.ts, TAKES).
        { shareTurns: shareOn, takeTurns: shareOn },
      )
    : { shape: 'task', layer: 'none', signals: [] };
  // The gate's answer as the two craft gates take it: a boolean each, because a gate answers one
  // question about one page (convo/personaModules.ts) and a union there would be a gate deciding the
  // turn shape a second time. Derived once, here, beside the reading itself — the selector and the
  // `Turn:` line take `idle.shape` whole, and a turn that was a share in the prompt and an idle turn
  // in the ledger is the contradiction this pre-read exists to make impossible.
  const idleTurn = idle.shape === 'idle';
  const shareTurn = idle.shape === 'share';
  const isGroupChat = chatContext?.isGroupChat ?? false;
  let hookDirective: HookDirective | null = null;
  let hookReport: HookSelectReport | null = null;
  if (hooksOn) {
    // LAST TURN'S READ OF WHAT THEY WERE DOING, while it is still fresh enough to describe this one.
    // The compiler is pure and has no clock, so the freshness window is the caller's — the same six
    // hours the thread engine takes over the same row (persona/threads.ts AFFECT_FRESH_MS, and the
    // same both-ended comparison: a stamp from the future is as unusable as a stale one). Past the
    // window the read arrives as NOTHING rather than as a neutral mode, which is the direction that
    // restricts nothing: an old "venting" must not make today's share heavy, and an old "joking"
    // must not close today's question.
    const last = affectState.last;
    const carried: CarriedIntent | undefined =
      last && nowMs - last.at <= AFFECT_FRESH_MS && nowMs >= last.at
        ? { intentMode: last.intent_mode }
        : undefined;
    // The affect directive is compiled from exactly the row the weather block is rendered from, so
    // "her mood closed the hook" and "her mood set the register" can never be two different reads of
    // the same turn.
    const affectDirective = compileAffect(last, computed, climate, carried, familiarity);
    const picked = selectHook(
      // The gate's own reading, whole. The selector is the one place the three kinds are still three
      // — everything downstream of it reads the MODE it produced (persona/hooks.ts `HookMode`), which
      // splits an idle turn in two and leaves the other two alone.
      hookState, idle.shape, idle.layer,
      // The two ceilings ride along from the same compile: the question gate and the weight flag are
      // read ONLY by the share branch, and carried on every other turn so nothing downstream has to
      // ask which branch produced the directive it is holding.
      {
        hooks: affectDirective.hooks,
        question: affectDirective.question,
        heavy: affectDirective.heavy,
        lateNight: affectDirective.lateNight,
        playfulnessBand: bandForDial(climate, 'playfulness'),
        lastOutcome: last?.thread_outcome ?? null,
        englishLooseness: affectDirective.englishLooseness,
        spent: affectDirective.spent,
        low: affectDirective.low,
        stranger: affectDirective.mask === 'stranger',
        curiosity: curiosityPercent(last?.mood_core, last?.mood_label),
        ...(Number(process.env.DODGE_COOLDOWN_MS) > 0 ? { dodgeCooldownMs: Number(process.env.DODGE_COOLDOWN_MS) } : {}),
        slip: affectDirective.feelingSlip || undefined,
      },
      isGroupChat, nowMs, idle.take === true, idle.quiz === true,
    );
    hookDirective = picked.directive;
    hookReport = picked.report;
    // EVERY turn the selector ran, including — especially — the ordinary task turn where it decided
    // nothing. Same doctrine as `threads:select` next door: a healthy no-op IS the receipt, and an
    // engine that stopped running and an engine that keeps finding nothing to say are otherwise
    // indistinguishable.
    //
    // The gate's own two fields ride along beside the selector's: `shape` is the reading the mode was
    // derived FROM (a `hook` and a `quiet` mode are both an idle turn, so the mode cannot be read
    // backwards into it), and `signals` is why a short-looking message went to layer 3 at all — the
    // pair a live round needs to tell a share the classifier found from a share the ledger's own
    // follow-up handed over.
    record({
      type: 'event', label: HOOKS_SELECT_LABEL, chatId, handle,
      detail: {
        ...picked.report,
        mode: picked.directive.mode,
        idle: picked.directive.idle,
        moments: picked.directive.moments,
        shape: idle.shape,
        take: idle.take === true,
        ...(idle.quiz ? { quiz: true } : {}),
        signals: [...idle.signals],
      },
    });
  }

  // ── the moment offer ─────────────────────────────────────────────────────────────────────────
  // At most five of the episodes she keeps about this person, put in front of her so a callback has
  // something to be made of (persona/moments.ts). Gated three ways, and each gate closes it for its
  // own reason: the DIRECTIVE (an idle hook turn, callback not forbidden, the spacing interval spent,
  // not a group — persona/hooks.ts decided all four), the FLAG, and a group identity, which the
  // directive already covers and which is repeated here because every per-person read in this file
  // is fenced off a room at its own call site.
  //
  // Billed on the OFFER, not on the use: the model may well decline all five, and billing only what
  // she reached for would let the same three ride out on every idle turn until one of them stuck.
  // The write is fire-and-forget under the /forget fence, exactly like the thread offer's own bill —
  // a turn must never wait on a diary, and a wipe that lands mid-turn must not be undone by it.
  let momentLines: string[] = [];
  let momentOffered = false;
  if (hookDirective?.moments && momentsEnabled() && handle && !isGroupHandle(handle)) {
    // Read BEFORE the file, and this ordering is the whole fence. The write at the bottom refuses
    // itself when the epoch has moved since the state it is writing was read, so the epoch it
    // compares against has to be older than that read — an epoch taken AFTER `readMoments` is a
    // comparison of a value against itself, which can only ever match, and a `/forget` landing in
    // the window between the read and the write would have its wipe undone by a bill built from the
    // pre-forget file. (`hookEpoch` above is the same instant for the same reason; this one is
    // separate so the two fences stay independent of each other's read order.)
    const momentEpoch = getForgetEpoch(handle);
    const file = await readMoments(handle);
    // A degraded read is NOT an empty file (db/repositories/moments.ts), and this branch would
    // WRITE: billing what a mangled file happened to parse would rewrite it from that fragment, in
    // the one tier that archives nothing. So an unreadable file offers nothing and is left alone —
    // receipted as its own skip, because a diary that stopped being readable and a diary with
    // nothing in it are otherwise the same silence.
    if (file.degraded) {
      record({
        type: 'event', label: MOMENTS_OFFER_LABEL, chatId, handle,
        detail: { skipped: 'degraded' },
      });
    } else {
      // The store enforces the 24-hour no-repeat itself, and this is the caller's own copy of the
      // same veto — the extra one `sampleMoments` documents. Same window, computed off the same
      // rows, so the two can never disagree about what "just used" means.
      const excludeIds = new Set(
        file.entries.filter(e => e.lastOfferedAt > 0 && nowMs - e.lastOfferedAt < MOMENT_RECENT_EXCLUDE_MS).map(e => e.id),
      );
      // `now` is also the seed: the same turn replayed against the same file makes the same offer,
      // which is what makes the `moments:offer` receipt below mean anything.
      const sample = sampleMoments(file.entries, nowMs, excludeIds, nowMs);
      momentLines = renderMomentLines(sample, nowMs);
      // THE RENDERED LINES, not the sample, are what decides whether an offer happened — and the two
      // can differ. `renderMomentLines` drops an entry whose text collapses to empty, and the store
      // mints exactly that from a segment that is only an annotation line (a hand edit, a truncated
      // write — db/repositories/moments.ts `parseSegment` keeps the id, the tag and the clock and
      // hands back `text: ''`). Billed off the sample, such a file would charge `offered` and
      // `last_offered` on a moment nothing put in front of her, reset the spacing counter — costing
      // the next four idle turns their callback — and render no lead at all.
      //
      // What IS still billed off the sample is which ids the bill touches, deliberately: an entry
      // that rendered nothing rode out beside ones that did, and stamping it keeps it out of the next
      // day's draws instead of letting it eat a slot every turn.
      if (momentLines.length > 0) {
        momentOffered = true;
        const ids = new Set(sample.map(e => e.id));
        void writeMoments(handle, billOffers(file.entries, ids, nowMs), file.lastHarvestAt, file.preserved, {
          ifForgetEpoch: momentEpoch,
        }).catch(err => console.warn('[convo] moment offer bill failed', err));
      }
      // EVERY run of the sampler, including — especially — the one that put nothing in front of her.
      // Same doctrine as `hooks:select` and `threads:select` above: the healthy no-op IS the receipt.
      // A sampler that stopped running and a sampler that keeps drawing nothing are otherwise
      // indistinguishable from the ring, and the two have completely different causes — an empty
      // file, a whole file held out by the 24-hour window, or five draws that all rendered to
      // nothing. The four numbers say which, and none of them is her words or a moment's text.
      record({
        type: 'event', label: MOMENTS_OFFER_LABEL, chatId, handle,
        detail: { offered: sample.length, rendered: momentLines.length, held: file.entries.length, excluded: excludeIds.size },
      });
    }
  }

  // At most ONE standing thread of theirs to put in front of her this turn — an open loop worth a
  // plain "how did it go", or a theme that has earned a light tag — chosen, budgeted and billed by
  // pure code (memory/threadHarvest.ts → persona/threads.ts). Awaited: it is a single indexed row
  // read, and its output shapes the system prompt built on the next line. `gapMs` — the loop stage's
  // hard gate — is computed above, beside the other gate that reads it.
  //
  // `allowOffer` is the rhythm engine's one veto over it: the OFFER is closed on a task turn and on
  // a quiet one, so nothing is selected and nothing is billed, while the outcome ask and the pending
  // machine keep running exactly as they always have (see pickThreadForTurn). With the hook flag off
  // the directive is null and this reads `true`, which is the pre-hook behaviour byte for byte.
  const thread: ThreadTurn = handle && !isGroupHandle(handle)
    ? await pickThreadForTurn(handle, affectState, {
        incomingText: textToSend, gapMs, chatId, allowOffer: hookDirective?.offerAllowed ?? true,
      })
    : { offer: null, outcomeAsk: null };

  // The install introduction, when this turn is the very first word they have ever sent her: the
  // first-move machine couldn't text them proactively (no confirmed history on that chat, or no
  // channel at all), so her reply to their own opener carries it instead. Awaited here rather than
  // inside buildSystemPrompt because it can re-key the seeded memory onto the handle that actually
  // texted — a store write, and the prompt assembler is synchronous. Null on every turn but one,
  // ever, from a cached state read; a group handle never gets it.
  const introWeave = handle ? await pendingIntroWeave(handle) : null;

  // What this turn is ABOUT, for the block that goes last inside <prompt> (convo/turnFocus.ts):
  // their message, plus the held things that touch it. Nothing is re-derived here — the relevance
  // router already scored every held channel during the memory read (memory/relevance.ts), and the
  // standing thread arrives through its own door because the thread engine picks its offer AFTER
  // that read (see threadHit, and the sequencing note on buildContextBlockWithHot).
  //
  // The offer leads, and not because it scored best: it is the one item here that was CHOSEN for
  // this turn rather than merely found, and a loop is offered precisely when it is off-topic. The
  // router's own hits follow, best first; the block prints the first two.
  //
  // With CONVO_MEMORY_RELEVANCE off there is no router, and the block falls back to P0's two
  // sources — the offer plus the one research look the memory stack rendered in FULL — so the
  // prompt is byte-identical to an install that never had P2.
  const hits: TurnFocusHit[] = context.turn
    ? [
        ...(thread.offer ? [threadHit(context.turn, thread.offer.label)] : []),
        ...context.turn.hits,
      ].map(h => ({ label: h.label, source: h.kind }))
    : [
        ...(thread.offer ? [{ label: thread.offer.label, source: 'thread' as const }] : []),
        ...(context.hotLook ? [{ label: shortEntryLabel(context.hotLook), source: 'research' as const }] : []),
      ];
  const turnFocus: TurnFocusInput = {
    text: textToSend, hits,
    // Who the two of them are, named at the recency edge (convo/turnFocus.ts). Group chats get no
    // contrast — there is no single `them` to draw it against — so it rides only a 1:1 identity.
    ...(handle && !isGroupHandle(handle) ? { who: { them: whoProfile?.name ?? null } } : {}),
    // …plus the turn's own reading, when the gate actually ran. The three fields travel together and
    // are absent together: with CONVO_HOOKS_ENABLED off no `Turn:` line renders at all and the block
    // is byte-identical to the one every install built before the gate existed (convo/turnFocus.ts).
    // The streak is the STORED count plus this turn — the ledger row is written after the reply, so
    // what is in hand here is how many idle turns came BEFORE this one. The renderer drops it on a
    // share turn, where the count describes the silences before they spoke rather than this turn;
    // that reading belongs there, with the other three, and not to a caller filling a struct.
    ...(hooksOn
      ? { shape: idle.shape, take: idle.take === true, idleStreak: hookState.idleStreak + 1, messageChars: [...typedText].length }
      : {}),
  };

  // Held in a variable (not inlined): recall_memory's second pass re-invokes the model with this
  // SAME system + messages, minus the recall tool (see processConvoResult).
  //
  // The measuring variant of the assembler: the system message and the per-turn tail, plus a
  // per-section size table — the sizes are what the turn receipt reports, and they are free here
  // (see convo/promptSections.ts).
  // The three structural facts behind the craft-module gates (convo/personaModules.ts), none of them
  // re-derived: the attachment note this turn's text already carries, and the two reads the memory
  // loaders answered on the way past (memory/dossier.ts). Everything else a gate needs — the
  // reply-order read, the burst, the tapped reply, the tool list — the assembler is already holding.
  // The two turn-shape facts are the gate's, not the renderer's: they arrive on this struct rather
  // than off the turn-focus input, because that one sits behind its own operator flag and a gate that
  // read it would drop a craft page on the strength of a rendering switch (convo/shared.ts says the
  // same thing at the seam that consumes them). Mutually exclusive by construction — one reading
  // returns one shape — and nothing downstream re-checks that.
  const craftFacts: CraftTurnFacts = { ...context.craft, attachmentNote: !!attachNote, idleTurn, shareTurn };
  // What the per-turn persona engines decided (convo/shared.ts PersonaTurn), all three live now: the
  // hook directive (which the `hooks` section and the drift anchor's mode read), the sampled moment
  // lines that ride inside that section when the directive allows one, and her one read on this
  // person. Each renders nothing when it is empty.
  const personaTurn = { hooks: hookDirective, moments: momentLines, thesis: thesisSection, self: selfSection, owed: owedSection, familiarity };
  // What stands live beyond the running lookups (convo/shared.ts LiveState): their reminders, read
  // above within its budget, the lookups that ended in the last few minutes, and her own recent
  // holding beats from the batch above.
  const liveState = { reminders: await liveRemindersRead, endedOps: getRecentlyEndedOps(chatId), holdingBeats };
  const prompt = buildSystemPromptSections(chatContext, contextBlock, activeOps, updateNote ?? undefined, tools, history, textToSend, userTz, affectState, computed, capabilitySummary, climate, thread, introWeave, turnFocus, craftFacts, personaTurn, liveState);
  const system = prompt.system;

  // What the model is actually sent: the system message (the persona and what is stable for this
  // chat), the history, then THIS turn's tail as its own user message, and their message last,
  // byte-identical to what it was before the tail existed. The order is the cache: the system
  // message and the history rows the previous turn already sent are the same bytes it sent, so the
  // provider can serve them from its prefix cache, and only the rows since, the tail and their
  // message are new input.
  //
  // The tail is its own message, and carries no timestamp, for two reasons. The lane prefixes a
  // message's stamp onto the front of its whole content (llm/timedMessages.ts), so folding the tail
  // into their message would label the directive block with their arrival time. And their message
  // stays last and untouched: the JSON anchor that closes the tail is then the last thing ahead of
  // it, and nothing the model reads after the envelope contract is anything but what they said.
  //
  // Stored history never sees the tail — addMessage above wrote their text alone — so a later turn's
  // history rows carry none of it. Everything that re-invokes the model this turn (the envelope
  // retry, the recall and error-log passes, the silent-turn retry) spreads THIS list and appends
  // after it, so each of those calls is a cache hit on this one.
  const tailMessage: LlmMessage = { role: 'user', content: prompt.tail };
  const turnMessages: LlmMessage[] = [...messages.slice(0, -1), tailMessage, messages[messages.length - 1]];

  // ── the early-emit gate ──────────────────────────────────────────────────────────────────────
  // May this turn's first sentence go out the moment the model writes it (pipeline/earlyEmit.ts)?
  // Only on a turn no post-check can rewrite, and every fact is one this turn already holds: the
  // hook mode the selector picked, the routing gate's own pre-check on the same text it will read
  // (no freshness read: that can only stand the gate down, never make it fire), the chat and turn
  // shape, and the parked-approval read started beside the memory batch. Nothing new is awaited in
  // front of the call but that read, which has long since landed. A caller with no sink never arms.
  // Warm the reach judge on their own words (a no-op when the door already did): a voice-memo
  // transcript or a remerged burst is a different string from the one the door saw, and the gate
  // below needs its verdict by the time the Convo call returns. `typedText`, never `textToSend`: the
  // tapped-reply tag and the attachment note are app metadata, and keying on them would miss the
  // door's reading and cost every tapped reply its early bubble.
  warmReachClassify({ chatId, handle }, typedText);
  const earlySend = chatContext?.earlySend;
  const early = earlySend && streamArmed({
    enabled: streamOn,
    hasParkedApproval: await parkedRead,
    hookMode: hookDirective?.mode,
    groundingFlagged: reachFlagged(textToSend, typedText),
    isGroupChat,
    introOrFirstMove: !!introWeave,
    isBurst: (chatContext?.burstManifest?.length ?? 1) > 1,
  })
    ? armEarlySend(earlySend, textToSend, chatId, handle, (hookDirective?.mode ?? 'task') === 'task')
    : null;

  const firstReq: LlmRequest = {
    role: 'convo',
    system,
    // Where that system string's stable prefixes end — the persona head, then the end of the
    // system message, which changes only when this chat's tools, roster or model map do. The
    // Anthropic lane caches each of them instead of cache-writing the system every call. Read off
    // the sizes the assembler just reported, so no part of the string is measured twice.
    systemCacheBreakpoints: prompt.cacheBreakpoints,
    tools,
    jsonBubbles: true,   // force the schema-valid envelope at the API on BOTH providers
    toolsViaJson: true,  // tools are WRITTEN into that envelope (tool_calls), never sent natively
    messages: turnMessages,
    trace: { chatId, handle, label: 'convo' },
  };

  try {
    let res: LlmResult;
    // Whether the draft took a second call: a stream that broke before any of it went out is re-run
    // once, below, and that re-run is a convo call like any other, so it counts against the turn's cap.
    let reran = false;
    try {
      res = await (call ?? callConvoLLM)(
        // The early sink, on an armed turn only. The OpenAI-compatible lanes stream when it is set; the
        // Anthropic lane ignores it and the turn simply runs whole, as it does unarmed. The envelope
        // retry asks the sink whether anything went out before it decides it may resend.
        early ? { ...firstReq, onTextDelta: early.onTextDelta } : firstReq,
        early ? { committed: early.committed, freeze: early.freeze } : undefined,
      );
    } finally {
      // Nothing streams past the call, and every early send lands before the reply is settled against
      // them: the sends are part of this turn's critical section, like the rest of its bubbles.
      early?.end();
      await early?.settled();
    }
    // A streamed reply the lane could not finish (it broke, or the call ran out of time, after text
    // had started to arrive) comes back as a partial with stopReason 'error' rather than a throw
    // (llm/types.ts LlmResult.emitted). What happens to it depends on whether any of it went out.
    if (early && res.emitted && res.stopReason === 'error') {
      if (!early.committed()) {
        // Nobody has seen a word of it, so it is recovered exactly the way an unstreamed turn's
        // failure would be: one more call, unstreamed, whose own lane fallback applies. Parsing the
        // partial instead would ship whatever the repair tier made of a cut envelope.
        console.warn(`[convo] streamed reply broke before any of it went out — one unstreamed re-run (chat ${chatId})`);
        record({ type: 'event', label: 'convo:stream_rerun', chatId, handle });
        res = await (call ?? callConvoLLM)({ ...firstReq, trace: { chatId, handle, label: 'convo:stream_rerun' } });
        reran = true;
      } else {
        // Part of it is on their screen. The reply is then exactly that and nothing more: the sentences
        // that went out were whole, and everything after them is a cut envelope the repair tier would
        // close mid-word, or a tool call cut mid-argument. Handed on as an envelope of those sentences
        // alone, so the reply settles to "nothing left to send" and the record is what they saw.
        console.warn(`[convo] streamed reply broke after ${early.sent.length} sentence(s) went out — keeping only those (chat ${chatId})`);
        record({ type: 'event', label: 'convo:stream_cut', chatId, handle, detail: { shown: early.sent.length } });
        res = {
          ...res,
          text: JSON.stringify({ tool_calls: null, bubbles: early.sent.map(text => ({ text, re: null })) }),
          toolCalls: [],
        };
      }
    }
    const onScreen = early?.sent ?? [];
    const result = await processConvoResult({
      res, chatId, handle, chatContext, textToSend, typedText, history, media,
      // A pass that replaces the draft after part of it went out is told what is on their screen:
      // every such pass calls through `turn.call`, so it is wrapped here, once.
      turn: {
        system, messages: turnMessages, tools,
        call: onScreen.length ? withOnScreenNote(call ?? callConvoLLM, onScreen) : call,
        cacheBreakpoints: prompt.cacheBreakpoints,
      },
      emittedPrefix: onScreen,
      // The broken stream and its re-run are two calls already spent, so the passes after the draft
      // share the one call left under MAX_CONVO_CALLS_PER_TURN instead of the usual two.
      callBudget: reran ? { used: 2 } : undefined,
      computed,
      // Her last few holding beats, the same list the `recent_beats` section above printed — so a
      // beat voiced down there when the draft held none steers off them too, without a second read.
      recentBeats: holdingBeats,
      // THE zone this turn already resolved (above, from the stored `agent_tz` preference) — so a
      // reminder with no explicit timezone in the tool call rides the USER's clock, not the host's,
      // and a listed reminder's next-run time renders in it too.
      userTz,
      introWoven: !!introWeave,
      // The turn's ONE relevance verdict, already built during the memory read above — the routing
      // gate reads it so it can stop discarding an answer she held the source for, and a delegation
      // carries those hits into its brief. Null with CONVO_MEMORY_RELEVANCE off, which is the gate's
      // pre-P2 text-only behavior.
      relevance: context.turn,
      // What the rhythm engine decided for this turn, and its receipt — both by reference, both
      // already computed above. The ledger write, the quiet guard and the trace all read THESE, so
      // nothing downstream can re-derive a different answer to "what kind of turn was this".
      hooks: hookDirective
        ? { directive: hookDirective, report: hookReport, state: hookState, forgetEpoch: hookEpoch, momentOffered }
        : null,
      // What was in front of the model this turn, for its one receipt (diagnostics/turnTrace.ts).
      // Every value here is already computed above — nothing is re-derived, nothing is re-read, and
      // no prompt text travels: the assembler's own section sizes, the verdicts the pre-turn reads
      // already made, and the hit labels the turn-focus block rendered.
      trace: {
        prompt,
        // The list the model was sent, tail included: the receipt measures the tail off `prompt`
        // and leaves that message out of the transcript's numbers (diagnostics/turnTrace.ts).
        messages: turnMessages,
        gates: {
          // The selection engine's accounting, straight off the pre-turn read. Null when selection
          // never ran (threading off, or a group identity — a room has no threads of its own).
          threads: thread.report ?? null,
          // The rhythm engine's, the same way. Null when the selector never ran (CONVO_HOOKS_ENABLED
          // off), which is a different reading from a selector that ran and said `not_idle`.
          hooks: hookReport,
          // Whether the freshest held look is in front of her in FULL (it touched this message), or
          // only as its settled digest line, or whether no memory rendered at all — plus everything
          // else the stack held that touched the message, which is the reading that says whether a
          // full memory stack had anything to do with what she was asked.
          memory: {
            shortHotLook: context.hotLook ? 'full' : contextBlock ? 'digest' : 'none',
            hits: (context.turn?.hits ?? []).map(h => ({ label: h.label, kind: h.kind })),
            // What the gate table did with each block it rendered, straight off the renderers that
            // decided it (memory/wrappers.ts). Empty with CONVO_MEMORY_RELEVANCE off — no gate ran.
            // The version note's row is added here because this is where that one is decided.
            blocks: gatesOn
              ? {
                  ...context.gates,
                  update_note: updateOpening
                    ? { verdict: updateNote ? 'full' : 'dropped', reason: updateNote ? 'gap_open' : 'nothing_held' }
                    : { verdict: 'dropped', reason: 'mid_conversation' },
                }
              : context.gates,
          },
          extras: { updateNote: !!updateNote, introWeave: !!introWeave, activeOps: activeOps.length },
        },
        // What the block actually PRINTED, asked of the block itself rather than re-derived: the
        // whole ranked set rides on gates.memory.hits above, and the two receipts read as a pair —
        // what she was shown, against what there was to show.
        hits: renderedTurnFocusHits(hits).map(h => h.label),
      },
    });
    // Stash this turn's media for a LATER text follow-up to recall (delegate_to_mm media_scope
    // "earlier"). Written AFTER processConvoResult so an "earlier" recall THIS turn still resolves to
    // the PRIOR file — writing it before would let a new-media turn that references an earlier file
    // recall the file just sent. URLs + mimeTypes only; overwrites the last stash.
    if (handle && hasMedia(media)) void rememberMedia(handle, chatId, media);
    return result;
  } catch (error) {
    console.error('[convo] API error:', error);
    throw error;
  }
}

export type GroupChatAction = 'respond' | 'react' | 'ignore';

export async function getGroupChatAction(message: string, sender: string, chatId: string): Promise<{ action: GroupChatAction; reaction?: Reaction }> {
  const history = await getConversation(chatId);
  const recent = history.slice(-4).map(m => (m.role === 'assistant' ? `Irises: ${m.content}` : `${m.handle || 'Someone'}: ${m.content}`)).join('\n');
  try {
    const res = await callLLM({
      role: 'classify',
      maxTokens: 20,
      system: `Classify how the assistant "Irises" should handle a group-chat message. Reply with one of: "respond" (default when addressed/asked/mentioned or unsure), "react:like" / "react:love" / "react:laugh" (brief ack only), or "ignore" (human-to-human, not about Irises).`,
      messages: [{ role: 'user', content: `${recent ? `Recent:\n${recent}\n\n` : ''}New from ${sender}: "${message}"\n\nHow should Irises handle this?` }],
      trace: { chatId, handle: sender, label: 'classify' },
    });
    const answer = (res.text || 'ignore').toLowerCase().trim();
    if (answer.includes('respond')) return { action: 'respond' };
    if (answer.includes('react')) {
      const reaction: Reaction = answer.includes('love') ? { type: 'love' } : answer.includes('laugh') ? { type: 'laugh' } : { type: 'like' };
      return { action: 'react', reaction };
    }
    return { action: 'ignore' };
  } catch (error) {
    console.error('[convo] groupChatAction error:', error);
    // 'ignore' is the safe default, but it is indistinguishable from a deliberate stay-out: a
    // classifier that fails every call makes Irises go silently mute in the room with nothing durable
    // saying why. Reported so the mute is visible.
    reportError({ source: 'convo', category: 'classifier_failure', severity: 'warn', err: error, chatId });
    return { action: 'ignore' };
  }
}

/** Irises does not generate images; stub keeps the webhook-handler contract type-safe. */
export async function generateImage(_prompt: string): Promise<string | null> {
  return null;
}
