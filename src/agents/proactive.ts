// The voice of a message NO ONE ASKED FOR. Everything else Irises says is a reply — a live turn, a
// late Ops follow-up, a progress beat. These eight kinds start the thread themselves: a reminder the
// user set coming due, mail they asked to be watched for, a background finding, an update note, a
// callback on a thread they left hanging — carrying nothing to hand over — once per install the
// first text of all, sent before a thread between them exists, a musing: a thought of her own, which
// nobody set up and nothing came due for (memory/musings.ts), and a check-in: the back-off's one ask
// whether they still want her texting first, after her own texts went unanswered
// (memory/proactiveBackoff.ts).
//
// Same Composer persona and the same assembly as the reactive path (composerCore.ts), plus one thing
// a reply never needs: an ORIENTATION beat. A text arriving out of nowhere has to say why it's
// arriving in its first bubble, grounded in what the user themselves set up — "you asked me friday
// to flag this" — never announcement-shaped and never "my system fired". Two kinds skip it, the
// introduction and the check-in: nothing was set up, so there is nothing to place.
//
// Fidelity is stricter here than anywhere: the payload is the ONLY fact source. The thread above is
// register and continuity, nothing more. On conflict the payload wins, silently. The one standing
// thread this module reads for itself (readContinuity, below) lives under the same rule and one
// tighter: it is offered to three of the eight kinds only, and never to the user's own setups.

import { composeWithComposer } from './composerCore.js';
import { voiceOutcome } from './fallfirm/client.js';
import type { Outcome } from './fallfirm/floor.js';
import { getThreadInventory, threadingEnabled } from '../db/repositories/threadInventory.js';
import { topStandingThread } from '../persona/threads.js';
import { isGroupHandle } from '../memory/identity.js';
import { listRecentReminders, PROACTIVE_REMINDER_MAX_AGE_MS } from '../db/repositories/proactive.js';
import { timestampLabel } from '../pipeline/chatTime.js';

// `proactive_deliveries.kind` is a bare TEXT column with no CHECK, so a new kind needs no migration.
export type ProactiveKind = 'reminder' | 'email' | 'memo' | 'update' | 'callback' | 'introduction' | 'musing' | 'checkin';

/** The check-in's payload (memory/threadPings.ts sends it when the back-off asks). */
export const CHECKIN_PAYLOAD = 'whether they still want you texting them first';

export interface ProactivePayload {
  kind: ProactiveKind;
  /** The substance, relayed exactly. The ONLY fact source for the turn. */
  text: string;
  /** Extra caller-specific framing (which update moment this is, how urgent the mail was, …). */
  framing?: string;
}

// The branch trigger. Must stay BYTE-IDENTICAL to the "when you're the one starting it" phrase in
// composer/Context.md — the persona keys off the surface form, and the wording is deliberately
// harmless if it ever slips into a bubble (same contract as BEAT_FIRST/BEAT_SECOND in
// orchestrator.ts).
export const PROACTIVE_MARK = '(no one texted you, this one starts with you)';

// The second mark, stacked under the first for the one text that has no thread beneath it at all.
// Must stay BYTE-IDENTICAL to the "when it's the very first text ever" phrase in composer/Context.md
// — change both or neither. Harmless in a bubble, like the mark above it.
export const INTRODUCTION_MARK = '(this is the very first text between you, no thread exists yet)';

/** How the Composer is pointed at each kind. Never "a job fired" — always the user's own setup
 *  coming due, in words that could be spoken out loud without cracking the seam. */
const COMPOSER_FRAMING: Record<ProactiveKind, string> = {
  reminder: 'a reminder they set with you earlier just came due — orient them first (one short beat that ties this text to what they asked you to flag), then deliver it, flat and brief, like you remembered on your own',
  email: 'something just landed in their email that they asked you to watch for — say in your first beat that it just came in, then surface what matters, brief and useful',
  memo: 'you have something for them from work you were doing in the background on their behalf — one beat placing it, then hand it over naturally',
  update: 'you have a light note about yourself to pass on — one beat placing why it is coming now, then the note, casual and once, never announcement-shaped',
  // A kind with nothing in hand. The framings above hand something OVER; this one asks (the check-in
  // below is the other), and so the "never open with a question" rule bends here — the question
  // still comes last, after the beat that places the thing.
  callback: "you're circling back on something you two keep coming back to — nothing new in hand, no result, no reminder due, just you asking how it went. one short beat placing the thing first, grounded and in their word for it, never question-shaped — then the question itself, once, flat, and it ends your message. only two proactives carry a question at all, this and the check-in on whether they still want you texting first, and here it is a callback: the one hook this text carries. you hold no outcome: nothing guessed, nothing assumed — you don't know how it went; that is exactly why you're asking.",
  // No orientation beat (the check-in is the other kind without one), because there is nothing to
  // orient them to: no setup of theirs came due, no thread runs above it. She was installed minutes
  // ago and speaks first.
  introduction: "you're texting them first, ever — you were just set up on their phone and they haven't said a word to you. no orientation beat: nothing was set up, there's nothing to place. open as yourself — you're Irises, and they can call you Iris or Ilish or Lish, your words, never a form. then, if the lines below carry details: pick TWO at most, make ONE flat judgment out of them — a dry, checkable read on how they operate, stated, deniable, never a compliment and never a question mark doing the work — and stop. if the lines below are empty you're newly acquainted, never blank: one bold deniable read about how they probably operate instead. hard rules: nothing sensitive, never their name even if you hold it, never 'i was told' or anything that smells like a file was read — you just moved in, you noticed things. 1-2 short bubbles after the intro line, then you're done.",
  // The one kind nobody set up and nothing came due for: something is on HER mind (memory/musings.ts).
  // The payload is a seed to grow a thought from, never a fact to hand over, which is why the
  // instruction below labels it as a seed instead of as what she is delivering.
  musing: "no one texted you and nothing of theirs came due: this one starts with you, because something is on your mind. the line below is a seed, a thing you hold, or a thing you keep about them, or a thread of theirs, and what you send is a thought grown from it: a take, a thing you keep turning over, something that connects to them. the seed itself stays unread; they only ever see the thought. one or two short bubbles, and end somewhere they can jump in; a question may end it, or a statement with room after it. never a service offer, never a check-in, and never announce that they were on your mind, the thought itself is the proof. never a reminder, and nothing sensitive: if the seed touches their body, health, family, or anything they did not choose, leave it and send nothing.",
  // The back-off's one ask (memory/proactiveBackoff.ts).
  checkin: "no one texted you, and the last few texts you started went unanswered. this one asks them, once, whether they still want you starting conversations at all. no orientation beat: nothing of theirs came due, so there is nothing to place. one short beat of your own if you want one, then the question, flat, and it ends your message. keep no score: no count, no recap of what went unanswered, no guilt, no pleading, no promise about what happens next, and no hurt in it. their answer, or no answer, settles it.",
};

/** The Fallfirm framings for the same eight kinds — the degrade path when the Composer's own
 *  ladder is spent. Substance rides `facts` (relayed exactly); this is only the framing. */
const FALLFIRM_FRAMING: Record<ProactiveKind, string> = {
  reminder: 'a reminder they set with you is due — deliver it now, flat and brief, like you remembered on your own',
  email: 'something just landed in their email that they asked you to watch for — surface it now, brief and useful',
  memo: 'you have something for them from work you were doing in the background — hand it over naturally',
  update: 'you have a light note about yourself to pass on — mention it once, casual and brief, never a changelog',
  callback: "you're checking in on something you two keep coming back to — place it in their words, then one flat question, and stop",
  introduction: "you're introducing yourself for the very first time — you're Irises, they can call you Iris or Lish, one flat line, then stop",
  // Never reached: a musing that the Composer cannot voice is dropped (voiceProactive), because the
  // Fallfirm path relays its payload as facts and a seed read out verbatim is the one thing a musing
  // must never be. Present because the map is total over the kinds.
  musing: 'something of yours is on your mind: one short thought of your own, and stop',
  checkin: 'ask once whether they still want you texting first: one flat line, no guilt, and stop',
};

/** The Outcome Fallfirm voices when the Composer could not. `framing` from the caller (the update
 *  paths' availability/applied guidance) rides along with the per-kind line. */
export function fallfirmOutcomeFor(payload: ProactivePayload): Outcome {
  return {
    kind: 'confirmed',
    summary: [FALLFIRM_FRAMING[payload.kind], payload.framing].filter(Boolean).join(' '),
    facts: payload.text,
  };
}

/** What a callback's payload actually IS, said once more right before she reads it. Every other kind
 *  hands over a fact and the generic clause above is enough; a callback hands over a THREAD, and the
 *  failure mode is not a rounded detail but an invented outcome — "how did the interview go, sounds
 *  like it went well". Kind-specific, and only for this kind: repeating it for reminder/email would
 *  be telling the model it holds no news about news it is literally carrying. */
const CALLBACK_FIDELITY = 'the line below is the thread itself, in words they have used — the only thing you may point at. you hold no outcome and no news: nothing gets guessed, assumed, or hoped into a fact.';

/** The one way a reminder may go unsent: she judged that nothing in it is new to them. Offered only
 *  when earlier reminder texts are in view, and stripped in voiceProactive so it never reaches a
 *  bubble. */
export const SKIP_MARK = '[[skip]]';

/** How many earlier reminder texts she sees, and how much of each. The window is the reminder
 *  retention itself, so a weekly or monthly job's previous run is still in reach. */
const EARLIER_REMINDERS_LIMIT = 6;
const EARLIER_REMINDER_MAX_CHARS = 2000;

/** A reminder text this chat already heard — the payload of an earlier delivery. */
export interface EarlierReminder {
  at: number;
  text: string;
}

/** A repeating reminder is voiced against what they already heard. Chat-scoped on purpose: a text
 *  from a different reminder of theirs still counts as heard, and she is the one who judges which of
 *  them bear on this one. */
function earlierRemindersBlock(earlier: EarlierReminder[]): string {
  const lines = earlier.map(r => {
    const label = timestampLabel(r.at);
    const text = r.text.length > EARLIER_REMINDER_MAX_CHARS ? `${r.text.slice(0, EARLIER_REMINDER_MAX_CHARS)}…` : r.text;
    return `${label ? `[${label}] ` : ''}"${text}"`;
  });
  return [
    'reminders repeat, and they already heard these earlier reminder texts from you, oldest first. they are here so you can tell what is new:',
    ...lines,
    `what they already heard is old news. carry a piece of it forward only when it has moved since, when they still need it to act, or when hearing it every time is the whole point of the reminder. lead with what is new or changed. an earlier text from a different reminder of theirs still counts as heard. when nothing in what you're delivering is new to them, it is your call: one short beat that says so, or nothing at all. to send nothing, reply with exactly ${SKIP_MARK} and nothing else.`,
  ].join('\n');
}

/** Earlier reminder texts are a second thing in view on the tightest-fidelity kind, so the contract
 *  names what they may do: subtract, and anchor a change. Nothing else. */
const EARLIER_REMINDERS_FIDELITY = 'the earlier reminder texts above only decide what gets left out and what changed: nothing from them is said again, except as the before-side of a change.';

/** A standing thread offered to a proactive turn as COLOUR — a register to speak in, never a second
 *  fact source. Label and note are model-authored prose, sanitized at the door by
 *  `sanitizeThreadText` (status.ts): one line, capped, no angle brackets, backticks or braces. */
export interface ProactiveContinuity {
  label: string;
  note: string;
}

/** Which kinds may be coloured. `reminder` and `email` are excluded on purpose and permanently:
 *  those two relay the USER'S OWN setups — a time they asked to be held to, mail they asked to be
 *  watched for — and carry the tightest fidelity contract in the engine. Nothing goes near them
 *  that could add a word she was not handed. `memo`/`update`/`callback` are hers to shape, so a
 *  thread may tint the register there. `introduction` is out for a third reason: the payload is the
 *  only thing she holds about a person she has never spoken to, and by definition no thread between
 *  them can exist yet. */
const CONTINUITY_KINDS: ReadonlySet<ProactiveKind> = new Set<ProactiveKind>(['memo', 'update', 'callback']);

/** Collapse to the comparable core of a label — the payload's label arrives quoted from the ping
 *  (`"<label>" — <note>`), the candidate's arrives bare. */
function labelKey(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The continuity line, or nothing. Two ways it comes back empty:
 *   • the kind is not one of the three colourable ones (above);
 *   • REDUNDANCY: a `callback` payload IS a thread already, so if the standing candidate is the
 *     same loop — compared by label, since a loop and a theme may legitimately carry the same
 *     words (the engine does no cross-class dedupe) — the line is dropped. A thread nodding to
 *     itself is noise, and worse, it reads to the model as two sources for one thing. */
function continuityLineFor(payload: ProactivePayload, continuity: ProactiveContinuity | null | undefined): string | undefined {
  if (!continuity || !CONTINUITY_KINDS.has(payload.kind)) return undefined;
  if (payload.kind === 'callback') {
    const quoted = /^\s*"([^"]+)"/.exec(payload.text);
    if (labelKey(quoted?.[1] ?? payload.text) === labelKey(continuity.label)) return undefined;
  }
  return `a standing thread you and they share, for voice only — "${continuity.label}": ${continuity.note}. if what you are delivering naturally touches it, one dry half-line may nod to it as a callback; it adds no fact, changes no fact, and is dropped without a trace when it does not fit.`;
}

/** The turn's instruction: the branch mark, the framing, the optional continuity colour, the
 *  fidelity contract, then the payload LAST (recency — the facts are the final thing the model
 *  reads before it writes). The colour sits ABOVE the fidelity clause deliberately: whatever it
 *  suggests, the very next thing read is the sentence saying the payload wins. An introduction
 *  stacks its own mark on the line right under the first: it is still a text no one asked for, and
 *  additionally the first one there has ever been. */
function buildProactiveInstruction(payload: ProactivePayload, continuity?: ProactiveContinuity | null, earlier?: EarlierReminder[]): string {
  const withEarlier = payload.kind === 'reminder' && !!earlier?.length;
  return [
    payload.kind === 'introduction' ? `${PROACTIVE_MARK}\n${INTRODUCTION_MARK}` : PROACTIVE_MARK,
    COMPOSER_FRAMING[payload.kind],
    payload.framing,
    continuityLineFor(payload, continuity),
    withEarlier ? earlierRemindersBlock(earlier!) : undefined,
    'the line below is the only place your facts come from. the thread above is there for voice, register and continuity ONLY — never for content, never as a second source. if the thread and this line disagree, this line wins, silently, with no mention of the difference. nothing here gets rounded, filled in, or guessed at: if a detail is not below, it does not exist.',
    payload.kind === 'callback' ? CALLBACK_FIDELITY : undefined,
    withEarlier ? EARLIER_REMINDERS_FIDELITY : undefined,
    payload.kind === 'musing'
      ? `the seed, yours to grow a thought from and never to read out:\n"${payload.text}"`
      : `what you're delivering:\n"${payload.text}"`,
  ].filter(Boolean).join('\n\n');
}

/**
 * The pre-read: the one standing thread, if any, this person has earned. Read-only — no budget is
 * spent, no cooldown moves, nothing here can change what the reactive path offers next turn.
 *
 * Gated exactly like every other threading read: the flag, a real handle, and never a group (no
 * personal themes in a room). Everything degrades to null SILENTLY — a continuity read failing must
 * cost the colour and nothing else. The message itself was promised to the user and still goes.
 */
async function readContinuity(handle: string): Promise<ProactiveContinuity | null> {
  if (!threadingEnabled() || !handle || isGroupHandle(handle)) return null;
  try {
    const top = topStandingThread(await getThreadInventory(handle), Date.now());
    return top ? { label: top.label, note: top.note } : null;
  } catch (err) {
    console.error('[proactive] continuity read failed — voicing without the colour', err);
    return null;
  }
}

/** The reminder texts this chat already heard, oldest first. The push being voiced is still pending,
 *  so it is never in its own history. Any failure reads as no history: voiced exactly as before. */
async function readEarlierReminders(chatId: string): Promise<EarlierReminder[]> {
  try {
    const rows = await listRecentReminders(chatId, Date.now() - PROACTIVE_REMINDER_MAX_AGE_MS, EARLIER_REMINDERS_LIMIT);
    return rows.reverse().map(r => ({ at: r.createdAt, text: r.text }));
  } catch (err) {
    console.error('[proactive] earlier-reminder read failed — voicing without history', err);
    return [];
  }
}

/** Honour the skip mark: a bubble that is only the mark goes, the mark is cut from any other, and
 *  nothing left is '' (the mouth's silent drop). A beat sent with the mark still ships. */
function applySkipMark(text: string): string {
  if (!text.includes(SKIP_MARK)) return text;
  return text
    .split('\n---\n')
    .map(part => part.split(SKIP_MARK).join('').trim())
    .filter(Boolean)
    .join('\n---\n');
}

/**
 * Voice one proactive delivery in Irises's own tone. Degrades to Fallfirm (and, under that, the
 * hardcoded floor) exactly like the reactive path, so a proactive message NEVER goes silent once
 * its moment has come. `handle` may be '' when no memory identity resolved.
 */
export async function voiceProactive(payload: ProactivePayload, chatId: string, handle: string): Promise<string> {
  const continuity = await readContinuity(handle);
  const earlier = payload.kind === 'reminder' ? await readEarlierReminders(chatId) : [];
  try {
    const text = await composeWithComposer({
      chatId,
      handle,
      buildInstruction: () => buildProactiveInstruction(payload, continuity, earlier),
      trace: { chatId, handle, label: 'composer-proactive' },
      errorDetail: { proactiveKind: payload.kind },
    });
    return earlier.length ? applySkipMark(text) : text;
  } catch (err) {
    // A musing is the one kind whose moment can simply pass: nobody is owed it, and the Fallfirm
    // path would relay the seed as facts. Empty text is a silent drop at the mouth.
    if (payload.kind === 'musing') {
      console.error('[proactive] composer failed on a musing — dropping it', err);
      return '';
    }
    console.error('[proactive] composer failed — handing to Fallfirm', err);
    return voiceOutcome(fallfirmOutcomeFor(payload), chatId, handle);
  }
}

/** Test seam: the instruction builder and the continuity pre-read (private to the module otherwise). */
export const _internal = { buildProactiveInstruction, readContinuity, readEarlierReminders, applySkipMark };
