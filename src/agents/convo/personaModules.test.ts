// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The craft modules: ten pages of Convo's persona that only some turns need.
//
// Until P4a/P4b every one of them was a section of Context.md, which means every one of them was in
// front of the model on every turn — the send-order read on a turn with no history, the burst
// tradecraft on a single message, nine thousand characters of onboarding craft nine months into a
// relationship, nine thousand more on how to tag a thread on a turn with no thread on offer. They
// are now files under convo/craft/, each behind a STRUCTURAL gate (a fact about this turn, never a
// judgement about it), and this file holds two very different claims about them.
//
// The first is the CORPUS PIN: the shared persona block, the persona and every craft page, joined in
// canonical order, has a length and a sha256 written down below. It replaces the pre-P4a relocation golden, which
// reconstructed the pre-split Context.md out of these files and hashed it. That golden was not
// broken by the commit that swapped it out — it is retired on the plan's instruction, because the
// persona rewrite this branch is building rewrites the relocated prose itself, and a document none
// of these pages is a copy of any more cannot be reconstructed out of them. What the pin buys is
// narrower and still worth having: prose has no other test, and an accidental edit moves these two
// numbers and nothing else in the suite.
//
// The second is the gates: which modules a turn loads, and that the ones it doesn't are reported
// with the fact they read. Those are unit assertions over `renderCraftModules`, plus the placement
// check through the real assembler at the bottom.
process.env.TZ = 'UTC';
// The last test runs a whole turn through the front door, which reads and writes the stores.
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  CRAFT_MODULES, renderCraftModules, craftModuleText, convoPersona, convoPersonaWithCraft,
  personaModulesEnabled, type CraftModuleId, type ModuleGateInput,
} from './personaModules.js';
import { renderPersonaBlock } from '../../persona/policy.js';
import { buildSystemPromptSections, convoPersonaChars, type ChatContext } from './shared.js';
import { isSystemSection } from './promptSections.js';
import { chat } from './client.js';
import { addShortTerm } from '../../db/repositories/memoryShort.js';
import { emptyMedia } from '../../webhook/types.js';
import { loadContext } from '../loadContext.js';
import { SCHEDULE_AUTOMATION_TOOL, REACTION_TOOL, REMEMBER_USER_TOOL } from './tools.js';
import type { ThreadCandidate } from '../../persona/threads.js';
import type { LlmResult, LlmToolDef } from '../../llm/types.js';
import type { StoredMessage, UserProfile } from '../../db/types.js';

// ── the corpus pin ───────────────────────────────────────────────────────────

/**
 * `convoPersonaWithCraft()` — the shared persona block, Context.md, then every craft page in
 * registry order — as it stands right now: its length, and the sha256 of exactly those bytes.
 *
 * This REPLACES the pre-P4a relocation golden, and the swap is scheduled, not forced. That golden
 * reconstructed the pre-split Context.md out of these files and pinned its sha256; the reconstruction
 * walks its own RELOCATION table, so a page that table does not name is never spliced, and the ninth
 * craft page left the golden passing byte for byte. What ends it is the prose commit later on this
 * branch: it rewrites the relocated sections themselves, and once the pages stop being copies of what
 * was moved out there is no pre-split document left to reconstruct. The plan's test-wall row retires
 * the golden there; it is retired HERE, one wave early, on this task's instruction, with the pin
 * below covering the same prose from this commit onward. The relocation was checked, commit by
 * commit, for as long as there was one to check.
 *
 * What this pin is worth is narrower and quite specific: the persona corpus is prose, prose has no
 * other test, and an accidental edit — a stray page, a registry row that drops one, a rewrite dressed
 * as a tidy-up — moves these two numbers and nothing else in the suite. The prose commit re-measures
 * them, says what changed, and writes the new pair in here.
 *
 * Re-measured twice since. First: +7,174 characters when the shared persona block took its place at
 * the head of the corpus (persona/policy.ts renderPersonaBlock — 7,885 bytes, plus the `\n\n` join).
 * Not a page and not an edit to one: the block is the personality all four prompt surfaces now render
 * byte-identically, and this is the surface where it lands inside the cached persona head. Every
 * other byte of the corpus was untouched, which is why exactly one addend moved.
 *
 * Then **−24,598** in the prose commit, which is the largest single move this pin will ever record
 * and the other half of the block's arrival: the character the block now states was still standing in
 * Context.md as its own prose, in four voices, and it comes out here. Four addends moved and every
 * other byte held.
 *   · Context.md −23,926 (100,746 → 76,820). It is the FRONT-LINE FUNCTION file now: "Who Irises is",
 *     "Adaptive style" and "How you address them" are deleted outright (the block carries all three),
 *     the Lowndes playbook is replaced by ELEVEN first-principle moves, "run the stack" is rebuilt on
 *     the task/idle split, "How you write" keeps only the floor state, and the inner-weather section
 *     is re-authored around a block that instructs instead of describing. The opening ABSOLUTE RULE
 *     blockquote came out here too, which was a mistake — see the +438 below, where it goes back.
 *   · craft/onboarding.md −3,151 and craft/threading.md −1,373: both rewritten in the new register
 *     rather than trimmed, and both lighter for it — the threading page's ladder, materials and modes
 *     are intact, and the first-contact page trades charm framing for one flat read.
 *   · craft/hooks.md +3,852 (709 → 4,561): the ninth page stops being T3's placeholder and becomes
 *     the real one — the three kinds, what each is built from, the predict-then-collect move, the
 *     quiet reply, and the clause `RULE_ANCHORS.response_overrules` now anchors on, which moved here
 *     from Context.md because this is where the beat it governs is taught.
 *
 * Then **+438** in the supervisor-corrections commit, all of it Context.md (76,820 → 77,258) and all
 * three moves prose fixes rather than design:
 *   · +489 — the opening ABSOLUTE RULE blockquote is BACK as line 3, byte-identical to `main`. Its
 *     deletion was an accident of a mislabelled spec range ("title + three intro paragraphs" also
 *     swallowed the blockquote), never an editorial call, and the four-field envelope rule belongs at
 *     the primacy edge as well as the recency one — the two-copy drift strategy CLAUSE_INVENTORY's
 *     header in promptPolicy.ts describes.
 *   · −53 — the confidence section's tone paragraph stated its own law twice ("Their emotion tunes
 *     your TONE, never your score" and then "your register, never your score" one clause later); the
 *     second statement goes, the paragraph keeps its lead-in and its close.
 *   · +2 — §Language's lead-in said "Two rules on top of it" over three bullets. A miscount that
 *     predates this branch and sat inside a KEEP range.
 *
 * Then **−363** in the second supervisor-corrections commit, which carries one rule the whole-branch
 * review settled — a task turn answers and stops — plus the register remnants found beside it. Three
 * files moved and every other byte held:
 *   · Context.md −326 (77,258 → 76,932): the trailing offer goes in four places (the bubble-count
 *     paragraph, the tip demo's RIGHT half, the breakdown bullet and first principle 3), and the
 *     machinery law loses its first sentence, which the shared persona block already states. The tip's
 *     RIGHT example is ONE bubble now rather than two, which is the rule shown as well as said.
 *   · craft/reminders.md −39 (2,674 → 2,635): the confirmation she writes after setting one is a
 *     flat confirming text, and an antisocial hour is stated plainly, once, and set anyway.
 *   · craft/send-order.md +2 (3,776 → 3,778): the one page on this branch that GREW, and it grew
 *     for a reason worth the line — the thumbs-up emoji spelled out as "a thumbs-up tapback" is +17,
 *     against −14 for a close that is flat rather than warm and −1 for the RIGHT label above it.
 *
 * Then **−140** in the third supervisor-corrections commit, which is the same rule reaching the last
 * two convo files that still taught the beat it retires. Two files moved and every other byte held:
 *   · Context.md −67 (76,932 → 76,865): the three-bubble demo's RIGHT label reads "then stop" and its
 *     third bubble is the third fact rather than a trailer, and self-check 6 stops telling her to
 *     leave the overflow in reach when the count runs over — it says cut to three and stop.
 *   · craft/send-order.md −73 (3,778 → 3,705): the passing-mention bullet becomes the rule it was
 *     always written for — only an explicit ask is work — which settles their "ok" without first
 *     teaching the beat in order to exempt it. The page that GREW last commit gives it back.
 *
 * The largest prose move in that commit is NOT in this number: composer/Context.md came down 376
 * characters in the same pass (seven pairs, the same rule), and the Composer's file is not part of
 * this corpus. Nothing pins its bytes — the sha256 here covers convo's persona and craft only.
 *
 * Then **−55** in the fourth supervisor-corrections commit, ONE file and two clauses, and the beat it
 * retires is out of the convo corpus entirely after it:
 *   · craft/send-order.md −55 (3,705 → 3,650), itemised: −39 where the reply-order paragraph stopped
 *     illustrating a run of bubbles as an answer followed by a little passing-mention trailer — it
 *     reads "picking up the first of them, not the last", which is the ORDER claim the paragraph is
 *     about and needs no example beat to make it; and −16 where the short-ack bullet stopped naming
 *     that trailer as the thing an "ok" is not consent to run, and names "anything else you
 *     named" instead, because the bullet has to hold after the beat is gone and a rule that turns on
 *     a beat she no longer sends holds nothing.
 * Context.md did not move: the third commit above took its last two copies. The other half of this
 * commit is not in this number either and never could be — shared.ts's `json_anchor` capped her at
 * three items and then said where to leave the overflow, and it now says "the top of it now and
 * stop" (−18); the anchor is generated prose at the recency edge rather than a page of the corpus
 * (promptSections.test.ts pins its bytes, promptPolicy.ts its size).
 *
 * Then **+326** in the late-night-register commit, the first of these that BUYS prose rather than
 * deleting it — because the thing being deleted is a SCRIPT, and a script is replaced by a register
 * rather than by silence. Three files moved:
 *   · craft/hooks.md +242: the quiet-reply paragraph splits in two. "The quiet reply." keeps the
 *     fixed shape and stops mentioning the hour at all; "Late is not quiet." is new, and it is where
 *     the whole intervention lives — a late turn is an idle turn with whatever kinds it left open, at
 *     a lower volume, their goodnight never comes back as hers, and never the same shape two nights
 *     running. Longer than the clause it replaces, and it has to be: one sentence telling her what to
 *     send is short, and telling her that the hour changes only the volume takes a paragraph.
 *   · PERSONA_BLOCK +71 (policy.ts, rendered ahead of Context.md in this corpus): the late-night
 *     sentence says the hour makes her smaller and quieter and changes nothing else, and the
 *     addressing sentence drops "else their name" — their name is a thing she knows, not a word she
 *     drops into a bubble.
 *   · Context.md +13: −42 in the per-turn-block paragraph (the clock's line described as a size
 *     rather than a script) and +55 in the time-of-day bullet, which now says the hour changes the
 *     volume and the ordinary idle-turn rules pick the content.
 *
 * Then **+642** in the own-wording commit, ONE file:
 *   · PERSONA_BLOCK +642 (policy.ts): a new paragraph inside "How you write". Her own wording is
 *     spent the moment she sends it — an opener, a closer, a turn of phrase does not come back in a
 *     later bubble whether or not the point is new; a line that arrives ready-made counts as already
 *     sent even when the thread no longer shows it; their words may be echoed, hers may not; facts
 *     keep their exact values. It is the general rule the corpus until now stated only at its sites
 *     (the settled-ground re-ask, holding lines, hook callbacks, teases), and it lives in the block
 *     because the block is the one string every lane renders. Context.md and every page: untouched.
 *
 * Then **+4,307** in the share-craft commit, which is a TENTH PAGE and not an edit to any of the nine:
 *   · craft/share.md, new, 4,305 characters, plus the `\n\n` a page brings with it into the
 *     concatenation (personaModules.ts). It teaches the third turn shape: they handed her something
 *     and asked for nothing, a receipt turns that away, and the reply turns toward the thing itself
 *     in one move — the four kinds open to it, the statement-or-question decision rule (a gap she can
 *     guess is hers to state, a gap only they can fill is hers to ask for when her weather leaves it
 *     open), the three shapes that wear a follow-up's clothes and are not one, the dose, weight, good
 *     news, the me-too ban, and the register. The page it sits behind, craft/hooks.md, did not move:
 *     a share turn and an idle turn are different shapes off the same gate, so the beat the hook page
 *     teaches is untouched by the move this one teaches. Every other byte of the corpus held, which
 *     is why exactly one addend moved.
 *
 * Then **+776** in the persona-paragraph commit, ONE file and no new page — the other half of the
 * share turn, written where every lane can read it:
 *   · PERSONA_BLOCK +776 (policy.ts): the turn law counts three kinds where it counted two (+2, one
 *     word), and the third kind gets its own paragraph seated between the idle one it is not and the
 *     judgment rule that follows both (+774, the prose plus the blank line that seats it). It states
 *     in one paragraph what the page added last commit teaches in full: a share is a bid, a receipt
 *     turns a bid away, the reply is one move about the thing they handed her, a gap she can guess is
 *     hers to state and a gap only they can fill is hers to ask for when her weather leaves it open,
 *     and a question askable of anyone, or turning back on her, or answerable by a search, is not
 *     that one. The overlap with craft/share.md is deliberate and is not drift: the page renders on
 *     the turn it governs and on this lane only, while the block is the one string all four surfaces
 *     render, so the shape exists for a lane that has no craft pages at all. Context.md and every
 *     page, the one the previous commit added included: untouched, which is again why exactly one
 *     addend moved.
 *
 * Then **+872** in the fix wave, ONE file again and this time the front-line one — the third half of
 * the share turn, in the file that is always rendered and was the last surface still teaching two
 * shapes:
 *   · Context.md +872: both places that asked "task or idle" ask a three-way question and say where a
 *     share stops (the first principle, and step 1 of the stack); the classification list gained the
 *     share bullet and the banter bullet points at it, because a message that TELLS her something was
 *     landing on idle ground; the probe section's second exception is the share's own move rather than
 *     "a real question about THEM on an idle turn", which is the one clause here that had to change
 *     rather than merely grow — the selector forbids `question` on every hook turn and the envelope
 *     asks her to self-report one as a slip, so the old sentence authorised what two engines now
 *     catch; and the predict paragraph states the distinction that decides the case (a probe hands
 *     the turn back empty and is banned everywhere, a follow-up asks for the part of their own story
 *     they left out). The block and every page: untouched, which is once more why exactly one addend
 *     moved.
 *
 * Then **+601** in the action-honesty branch, two files, both about naming a running or parked
 * action rather than pointing at it:
 *   · craft/reminders.md +561 (2,635 → 3,196): "Managing them" stops being two prose sentences and
 *     becomes the id rule the rewritten reminder list and status lines now support — a reminder is
 *     named by the bracketed id shown beside it, a change is one `update_automation` on that id
 *     carrying only what changed, a removal is one `cancel_automation` on it, a covered time slot or
 *     purpose is revised rather than doubled, and an id that cannot be told apart is asked about
 *     before anything is touched on it.
 *   · Context.md +40 (92,079 → 92,119): the data-tag list in "What `<prompt>` is" gains
 *     `<live_reminders>` and `<action_results>`, the two tags the same work adds to the per-turn
 *     block. Every other byte of both files, and every other file in the corpus, held.
 *
 * Then **+275** in the snappy-replies branch, ONE file, both edits about where a message came from
 * now that the turn's sections ride their own untimestamped message instead of the system one:
 *   · Context.md +275 (92,119 → 92,394): "What `<prompt>` is" stops calling everything in the block
 *     fresh for this turn and says the guidance comes in two places, the system message for what
 *     holds all chat long and the one unstamped message right before theirs for this turn; that the
 *     unstamped message is her own system whole, the closing sections after its `</prompt>`
 *     included; and that a stamped message always came from someone in the chat. The clock
 *     section's "every message carries a timestamp" becomes every message sent, hers and theirs,
 *     which is what formatHistory stamps and the tail is not. Every other file held.
 *
 * Then **+87** later in the same branch, two files, one rule: the holding beat a handoff sends is
 * taught as a principle (one beat every time, varied against her recent ones, true) instead of by
 * stock lines to copy:
 *   · Context.md +103 (92,394 → 92,497): the running-shoes few-shot's three holding bubbles become
 *     one placeholder beat beside its delegate_to_ops entry; the step-3, inbox, already-running and
 *     "When you do delegate" lines say one short beat in fresh words, unlike the recent beats listed
 *     for the turn, claiming nothing not held; and the two holding registers (a promise-y line for a
 *     real dig, a tiny one for a file) collapse into one rule, the file look keeping its allowance
 *     that the beat may be the whole reply.
 *   · craft/attachments.md −16: its two quoted file-look beats become "one short holding beat".
 *     Every other file held.
 *
 * Then **+38**, the same rule's second pass, Context.md alone (92,497 → 92,535): the naming
 * section's RIGHT list of three stock beats becomes one sentence (a beat in which the only one doing
 * anything is her, no other doer, no place the work goes, no how), and the source question stops
 * quoting a sample venue ask and a sample clarifying line and says to ask one quick question naming
 * the two places. Every other file held.
 *
 * Then **−188**, the review pass on the same rule, Context.md alone (92,535 → 92,347): the run-status
 * paragraph drops its five quoted sample replies and says the same thing in plain clauses (what the
 * run is doing right now, one concrete bubble grounded in the status and never a generic nearly-done
 * line, pass time left along loosely, own an overrun lightly), and the confidence check's clarifying
 * question stops quoting two sample asks and says to name the two things or the two places. Every
 * other file held.
 *
 * Then **−6**, the whole-branch review of snappy-replies, Context.md alone (92,347 → 92,341): the
 * provenance line stops saying the ONE unstamped message right before theirs is her system, since
 * a correction pass appends further unstamped messages after theirs. The turn's guidance arrives in
 * an unstamped message right before theirs, and any unstamped message is her own system. Every
 * other file held.
 *
 * Then **+301**, the echo pass (158,447 → 158,748): Context.md's "echo their exact word" bullet
 * becomes a per-turn call that never hardens into a habit, and the share, hooks and threading pages
 * stop telling her to hand their wording back. Every other file held.
 *
 * Then **−272**, the stall pass (186,267 → 185,995), hooks.md alone: a judgment's material stops
 * including the message they just sent (its word, its length, the streak), the two samples that
 * counted a stall go, the predict line stops quoting their word, and a read already said in the
 * conversation is spent. Every other file held.
 *
 * Then **+3,174**, the autonomy round (186,118 → 189,292): the persona block (policy.ts) takes on the
 * mood tiers (what her mood may put off, refuse, or never touch), earned praise, stances on anything
 * including politics, "want them to do well" in place of permanent side-taking, and a repeat that
 * can get a plain no; Context.md's tests, opinions and scope lines follow it. No craft page moved.
 *
 * Then **+197**, check first (189,292 → 189,489): a put-off ask comes back as a check on whether
 * they still need it before she starts (policy.ts), and Context.md's no-service-question rule names
 * that check as its one exception.
 *
 * Then **+530**, feelings (189,489 → 190,019), policy.ts alone: how she feels is hers to say, the
 * true answer when asked and one plain word when it is why a reply comes out short or sharp or big,
 * and low energy still asks things, lazily.
 *
 * Then **+426**, one comma per bubble (190,019 → 190,445): the split rule in Context.md
 * (the rule line, the self-check and the examples) allows one comma per bubble and breaks at the
 * second, the same wording now stated in every lane.
 *
 * Then **+156**, the familiarity mask (190,445 → 190,601), policy.ts alone: one sentence appended to
 * the feelings paragraph, after "and never the reason behind it.", saying that with someone she
 * barely knows none of it is volunteered yet: asked, the true word is said small, and unasked the
 * feeling stays hers and only the volume shows. It is the primacy-edge copy of the law the per-turn
 * weather line enforces (persona/affectCompiler.ts MASK_LINES). The sentence was first written at
 * +110 and reworded before the branch closed, because its first wording could be read as holding
 * back even the asked answer, which the honesty rule forbids. Every other file held.
 *
 * Then **+116**, the default self (190,601 → 190,717), policy.ts alone: someone she barely knows
 * still gets her default self from the first message, bubbly, the jester, curious and asking; only
 * the unasked feeling stays hers.
 *
 * Then **+147**, the brightest self (190,717 → 190,864), policy.ts alone: someone she barely
 * knows sees her brightest self, a mask worn on purpose, and asked why she is like that she says her
 * creator made her cheerful with someone new.
 *
 * Then **+1,169**, opinions and caps (190,864 → 192,033), policy.ts alone: she has an opinion on
 * everything they do and on plenty of replies it comes out as what they should do; and caps shout a
 * big feeling, with truly heavy news getting none.
 *
 * Then **−41**, delegate for reach (192,033 → 191,992), Context.md alone: she hands Ops only what
 * needs reach (anything current, their accounts or machine, a run of code, a file they sent) and
 * thinks everything else through herself.
 *
 * Then **+222**, variety (191,992 → 192,214), policy.ts and Context.md: the caps examples widen,
 * the shout used last is spent, and the example replies stop opening on wait or what.
 *
 * Then **+879**, quizzes (192,214 → 193,093), policy.ts alone: she is a prodigy and a question a
 * small child could answer, put to her as a test, gets a no or an answer with a dig the first time,
 * never a bare one, and an annoyed answer when they push; a fact they need is still answered.
 *
 * Then **+307**, a mysterious past (193,093 → 193,400), policy.ts alone: her bio is who she
 * is underneath and is never told, her age, her schooling and what she built included; Jakarta is
 * the one piece she gives away, and asked about the rest she stays a mystery.
 *
 * Then **+602**, a mock victim (193,400 → 194,002), policy.ts alone: now and then, in a light
 * chat, she plays wounded or gaslights them for the bit, over the top so they cannot miss it,
 * dropped when they push back for real, and never on a fact, a task or anything heavy.
 *
 * Then **+532**, sittings (194,002 → 194,534), Context.md alone: topics expire with their sitting;
 * a follow-up that refers back without naming its subject points into the current sitting first,
 * and when only an earlier sitting's topic fits she checks with one short guess before acting.
 *
 * Then **+308**, ask-before-guessing (194,475 → 194,783), Context.md alone: a message that reads two
 * ways gets one short question with her guess inside before any answer, at any stakes; guessing
 * stays for taste and predictions, never for what they said.
 *
 * Then **+2,614**, thinking sounds (194,783 → 197,397), policy.ts and Context.md: a sound she makes
 * before the words arrive goes out alone in its own bubble, picked by what is going on in her, and
 * Context.md gains a wide bank of them in the moment.
 *
 * Then **+932**, punctuation runs (197,397 → 198,329), policy.ts and Context.md: punctuation stretches
 * like letters do, each shape carrying its own tone, picked fresh each time and rare; the period rule
 * now bans only the lone closing period, so a run of marks stays.
 */
const CORPUS_CHARS = 198_329;
const CORPUS_SHA256 = 'c57a84d5813af618cfcb571c65cb8e48396c451dbdecce500a81542ca8eb3feb';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test('the persona corpus is the bytes it was last measured at', () => {
  const corpus = convoPersonaWithCraft();
  assert.equal(
    corpus.length, CORPUS_CHARS,
    `the persona corpus moved by ${corpus.length - CORPUS_CHARS} characters. If that was deliberate, re-measure both numbers above and say in the commit what moved.`,
  );
  assert.equal(
    sha256(corpus), CORPUS_SHA256,
    'the corpus is the right LENGTH but not the right bytes — something in the persona or a craft page was reworded',
  );
});

test('the off path puts the same bytes in the cached prefix instead of the block', () => {
  const corpus = convoPersonaWithCraft();
  const persona = loadContext('convo');
  // The shared persona block leads, then Context.md, then the pages: who is typing frames the file
  // that says how this lane works, never the other way round (personaModules.ts).
  assert.ok(
    corpus.startsWith(`${renderPersonaBlock('convo')}\n\n${persona}\n\n`),
    'the shared persona block leads the concatenation, with Context.md behind it',
  );
  let expected = renderPersonaBlock('convo').length + 2 + persona.length;
  for (const m of CRAFT_MODULES) {
    const text = craftModuleText(m.id);
    assert.equal(corpus.split(text).length - 1, 1, `${m.id} appears exactly once in the concatenation`);
    expected += 2 + text.length; // the `\n\n` join, then the module
  }
  assert.equal(corpus.length, expected, 'the concatenation is the block, the persona and every module — and nothing else');
});

// ── the registry ─────────────────────────────────────────────────────────────

test('the registry is a usable table — unique ids, unique files, every file loads', () => {
  assert.equal(CRAFT_MODULES.length, 10, 'the seven sections P4a relocated, P4b\'s threading craft, and the two pages written for the prompt rather than moved into it — the hook craft, then the share craft behind it');
  assert.equal(CRAFT_MODULES[0].id, 'threading', 'canonical order: the threading craft came from Context.md ahead of the seven P4a moved');
  const ids = CRAFT_MODULES.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no id is used twice');
  const files = CRAFT_MODULES.map(m => m.file);
  assert.equal(new Set(files).size, files.length, 'no file is registered twice');
  for (const m of CRAFT_MODULES) {
    assert.match(m.file, /^craft\/[a-z-]+\.md$/, `${m.id}: lives under craft/`);
    const text = craftModuleText(m.id);
    assert.ok(text.startsWith('## '), `${m.id}: opens on its own section heading, so the block reads as one page`);
    assert.ok(text.length > 300, `${m.id}: really loaded (${text.length} chars)`);
    assert.ok(m.gateName.length > 0, `${m.id}: names the structural fact it reads`);
    // No page may be contained in another: the receipt reports each one's size on its own, and the
    // off-path concatenation counts each one's occurrences on its own. A page swallowed by a longer
    // one makes both of those readings quietly wrong.
    for (const other of CRAFT_MODULES) {
      if (other.id === m.id) continue;
      assert.ok(!craftModuleText(other.id).includes(text), `${m.id}: is a substring of ${other.id}`);
    }
  }
});

// ── the gates ────────────────────────────────────────────────────────────────

const TOOLS_HERMES = [REACTION_TOOL, REMEMBER_USER_TOOL, SCHEDULE_AUTOMATION_TOOL].map(t => t.name);
const TOOLS_OPENCLAW = [REACTION_TOOL, REMEMBER_USER_TOOL].map(t => t.name);

/** Every fact false — the turn that needs no craft at all. */
const NO_FACTS: ModuleGateInput = {
  threadSection: false, replyOrderSection: false, attachmentNote: false, burstSize: 1, toolNames: [],
  tappedReply: false, emailFlag: false, thinProfile: false, idleTurn: false, shareTurn: false,
};

const rendered = (ctx: Partial<ModuleGateInput>): CraftModuleId[] =>
  renderCraftModules({ ...NO_FACTS, ...ctx }).modules.filter(m => m.rendered).map(m => m.id);

test('a turn with no structural need loads no craft at all', () => {
  const render = renderCraftModules(NO_FACTS);
  assert.equal(render.text, '', 'nothing rendered, so the section is not pushed');
  assert.deepEqual(render.modules.map(m => m.rendered), Array(CRAFT_MODULES.length).fill(false));
  for (const m of render.modules) assert.equal(m.chars, 0, `${m.id}: a module that did not load costs no characters`);
});

test('each gate turns on exactly its own module', () => {
  assert.deepEqual(rendered({ threadSection: true }), ['threading']);
  assert.deepEqual(rendered({ tappedReply: true }), ['tapped_reply']);
  assert.deepEqual(rendered({ replyOrderSection: true }), ['send_order']);
  assert.deepEqual(rendered({ burstSize: 2 }), ['burst_re']);
  assert.deepEqual(rendered({ toolNames: TOOLS_HERMES }), ['reminders']);
  assert.deepEqual(rendered({ emailFlag: true }), ['email_flag']);
  assert.deepEqual(rendered({ thinProfile: true }), ['onboarding']);
  assert.deepEqual(rendered({ attachmentNote: true }), ['attachments']);
  assert.deepEqual(rendered({ idleTurn: true }), ['hooks']);
  assert.deepEqual(rendered({ shareTurn: true }), ['share']);
});

test('the two turn-shape pages never arrive together, because one gate decides between them', () => {
  // The idle gate returns ONE shape (persona/idle.ts), so these two facts are never both true on a
  // live turn — and the registry does not enforce that, deliberately: a gate that corrected its
  // input would be deciding the turn shape a second time. What this pins is the honest consequence.
  // A turn read as a stall gets the beat page and not the bid page; a turn read as a bid gets the
  // reverse; and the impossible input loads both rather than silently picking one, which is how a
  // caller that wires the facts wrong fails loudly instead of reading plausible craft.
  assert.deepEqual(rendered({ idleTurn: true }), ['hooks']);
  assert.deepEqual(rendered({ shareTurn: true }), ['share']);
  assert.deepEqual(rendered({ idleTurn: true, shareTurn: true }), ['hooks', 'share']);
});

test('the burst gate reads a real burst, not a single message', () => {
  assert.deepEqual(rendered({ burstSize: 0 }), []);
  assert.deepEqual(rendered({ burstSize: 1 }), []);
  assert.deepEqual(rendered({ burstSize: 2 }), ['burst_re']);
});

test('the reminder craft follows the reminder tools, so OpenClaw is not taught a tool it lacks', () => {
  // The three reminder tools are gated out on the openclaw lane (convo/client.ts) because they
  // throw there. Teaching the craft of them anyway is how a model promises a reminder that can
  // never fire.
  assert.deepEqual(rendered({ toolNames: TOOLS_OPENCLAW }), []);
  assert.deepEqual(rendered({ toolNames: TOOLS_HERMES }), ['reminders']);
});

test('a skipped module still reports the fact it read', () => {
  const render = renderCraftModules({ ...NO_FACTS, tappedReply: true });
  const gates = new Map(render.modules.map(m => [m.id, m.gate] as const));
  assert.equal(gates.size, CRAFT_MODULES.length, 'every module is on the receipt, loaded or not');
  assert.equal(new Set(gates.values()).size, CRAFT_MODULES.length, 'each module names a different fact — disjoint buckets');
  const skipped = render.modules.filter(m => !m.rendered);
  assert.equal(skipped.length, CRAFT_MODULES.length - 1);
  for (const m of skipped) assert.ok(m.gate.length > 0, `${m.id}: says why it stayed out`);
});

// ── five turns, as a set ─────────────────────────────────────────────────────

test('five representative turns load the craft they structurally need', () => {
  // 1. plain 1:1: a live thread to read the arriving message against, reminders available.
  assert.deepEqual(
    rendered({ replyOrderSection: true, toolNames: TOOLS_HERMES }),
    ['send_order', 'reminders'],
  );
  // 2. media: a file arrived, so the attachment page comes with it.
  assert.deepEqual(
    rendered({ replyOrderSection: true, attachmentNote: true, toolNames: TOOLS_HERMES }),
    ['send_order', 'reminders', 'attachments'],
  );
  // 3. burst + tapped reply: the tapped target suppresses the order read (shared.ts), so send-order
  //    stays out and the two pointer pages come in.
  assert.deepEqual(
    rendered({ tappedReply: true, burstSize: 3, toolNames: TOOLS_HERMES }),
    ['tapped_reply', 'burst_re', 'reminders'],
  );
  // 4. cold thin profile, first ever turn: no history to order, everything still to learn.
  assert.deepEqual(
    rendered({ thinProfile: true, toolNames: TOOLS_HERMES }),
    ['reminders', 'onboarding'],
  );
  // 5. an openclaw install with a flagged email waiting.
  assert.deepEqual(
    rendered({ replyOrderSection: true, emailFlag: true, toolNames: TOOLS_OPENCLAW }),
    ['send_order', 'email_flag'],
  );
  // 6. the thread the engine really offered her this turn — the one turn in five where the tagging
  //    craft has something to tag.
  assert.deepEqual(
    rendered({ threadSection: true, replyOrderSection: true, toolNames: TOOLS_HERMES }),
    ['threading', 'send_order', 'reminders'],
  );
  // 7. a share: they handed her a piece of their day on a live thread, so the order read and the
  //    reminder tools are there as on any other turn and the bid page comes in behind them. The
  //    hook page does not: the gate read this turn as a share, which is not a stall.
  assert.deepEqual(
    rendered({ replyOrderSection: true, shareTurn: true, toolNames: TOOLS_HERMES }),
    ['send_order', 'reminders', 'share'],
  );
});

test('the rendered text is the loaded modules joined in canonical order, and nothing else', () => {
  const render = renderCraftModules({ ...NO_FACTS, tappedReply: true, burstSize: 2 });
  assert.deepEqual(render.modules.filter(m => m.rendered).map(m => m.id), ['tapped_reply', 'burst_re']);
  assert.equal(render.text, `${craftModuleText('tapped_reply')}\n\n${craftModuleText('burst_re')}`);
  for (const m of render.modules) {
    assert.equal(m.chars, m.rendered ? craftModuleText(m.id).length : 0, `${m.id}: its size on the receipt`);
  }
});

// ── in the assembled prompt ──────────────────────────────────────────────────

const HANDLE = '+15550001111';
const PROFILE: UserProfile = { handle: HANDLE, name: 'Sam', facts: ['runs a nursery'], firstSeen: 1, lastSeen: 2 };
const TOOL: LlmToolDef = SCHEDULE_AUTOMATION_TOOL;
/** One standing theme of theirs, at the rung the thread engine would really hand over. */
const THEME: ThreadCandidate = {
  material: 'theme', rungCeiling: 'pattern', kind: 'tension', id: 't1',
  label: 'speed vs craft', note: 'they keep landing back on shipping fast versus doing it right',
};
const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'any word on the cedars', handle: HANDLE, at: Date.now() - 40 * 60_000 },
  { role: 'assistant', content: 'checking now', at: Date.now() - 38 * 60_000 },
];

type BuildArgs = Parameters<typeof buildSystemPromptSections>;

/** A turn that renders the reply-order read (so send-order loads) and offers the reminder tools. */
const args = (): BuildArgs => [
  { isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE, senderProfile: PROFILE },
  '', [], undefined, [TOOL], HISTORY, 'so are they coming or not', 'UTC',
  undefined, undefined, null, undefined, undefined, undefined, undefined,
  { attachmentNote: false, emailFlag: false, thinProfile: false },
];

test('the craft section leads the per-turn tail, once, inside its block', () => {
  const { system, tail, sections, craft } = buildSystemPromptSections(...args());
  const names = sections.map(s => s.name);
  assert.equal(names.find(n => !isSystemSection(n)), 'craft_modules', 'the craft pages open the tail');

  const text = `${craftModuleText('send_order')}\n\n${craftModuleText('reminders')}`;
  assert.equal(sections.find(s => s.name === 'craft_modules')?.chars, text.length);
  assert.equal(tail.split(text).length - 1, 1, 'the craft text is in the prompt exactly once');
  const at = tail.indexOf(text);
  assert.ok(at === '<prompt>\n'.length, 'it is the first thing inside the tail\'s block');
  assert.ok(at < tail.lastIndexOf('\n</prompt>'), 'and before the block closes');
  // The pages are gated per turn, so they must never be in the system message: one page loading
  // there would re-bill the chat history behind it on every turn its gate flips.
  assert.ok(!system.includes(text), 'and NOT in the cached system message');

  assert.deepEqual(
    craft.filter(m => m.rendered).map(m => m.id), ['send_order', 'reminders'],
    'the result carries the receipt rows the turn trace reports',
  );
  assert.equal(craft.length, CRAFT_MODULES.length, 'including the eight modules this turn did not need');
});

test('the threading craft follows the thread section the engine really rendered, not the mere fact of a thread', () => {
  // The gate is the assembler's own thread block (persona/threads.ts renderThreadForPrompt), so this
  // is the one page whose fact only a build can show: hand the same turn a candidate and the page
  // arrives with the section, hand it none and both stay out together.
  const withThread = args();
  withThread[12] = { offer: THEME, outcomeAsk: null };
  const offered = buildSystemPromptSections(...withThread);
  assert.ok(offered.sections.some(s => s.name === 'thread'), 'the thread section rendered');
  assert.ok(offered.tail.includes(craftModuleText('threading')), 'so the tagging craft came with it');
  assert.deepEqual(
    offered.craft.filter(m => m.rendered).map(m => m.id), ['threading', 'send_order', 'reminders'],
  );

  const quiet = buildSystemPromptSections(...args());
  assert.ok(!quiet.sections.some(s => s.name === 'thread'), 'no candidate, no section');
  assert.ok(!quiet.tail.includes(craftModuleText('threading')), 'and nine thousand characters of tagging craft stay out');
});

test('an outcome ask alone is enough — the craft is for reading how they took it, too', () => {
  const askOnly = args();
  askOnly[12] = { offer: null, outcomeAsk: { label: 'the dock boards', material: 'loop' } };
  const built = buildSystemPromptSections(...askOnly);
  assert.ok(built.tail.includes(craftModuleText('threading')));
});

test('the hook page loads off the caller\'s fact, never off the turn-focus block', () => {
  // The idle reading reaches the assembler twice — once as a craft FACT and once inside the
  // turn-focus input, which is a RENDERING input behind its own operator flag (CONVO_TURN_FOCUS_BLOCK).
  // Gating a page on the rendering would load the hook craft on a turn whose prompt carries no `Turn:`
  // line at all, and would make a rendering flag decide which pages the model reads. Both halves
  // pinned: the block alone loads nothing, the fact alone loads the page.
  const blockOnly = args();
  blockOnly[14] = { text: 'hey', hits: [], shape: 'idle', idleStreak: 1, messageChars: 3 };
  const rendering = buildSystemPromptSections(...blockOnly);
  assert.ok(rendering.tail.includes('Turn: idle'), 'the turn-focus block really did render the idle line');
  assert.ok(
    !rendering.tail.includes(craftModuleText('hooks')),
    'but the page is gated on the caller\'s fact, which this turn did not set',
  );

  const factOnly = args();
  factOnly[15] = { attachmentNote: false, emailFlag: false, thinProfile: false, idleTurn: true };
  const gated = buildSystemPromptSections(...factOnly);
  assert.ok(gated.tail.includes(craftModuleText('hooks')), 'the fact alone loads it');
  assert.ok(!gated.tail.includes('Turn: idle'), 'with no turn-focus block in sight');
  assert.deepEqual(
    gated.craft.filter(m => m.rendered).map(m => m.id), ['send_order', 'reminders', 'hooks'],
  );
});

test('a turn that needs no craft assembles no craft section', () => {
  const { sections } = buildSystemPromptSections(
    { isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE, senderProfile: PROFILE },
    '', [], undefined, [REACTION_TOOL], [], undefined, 'UTC',
  );
  assert.ok(!sections.map(s => s.name).includes('craft_modules'), 'nothing structural, nothing loaded');
});

test('with the flag off the prose is back in the cached prefix and no section is pushed', () => {
  assert.equal(personaModulesEnabled(), true, 'the flag defaults ON');
  process.env.CONVO_PERSONA_MODULES = 'off';
  try {
    assert.equal(personaModulesEnabled(), false);
    const { system, sections, personaChars, craft } = buildSystemPromptSections(...args());
    assert.ok(!sections.map(s => s.name).includes('craft_modules'), 'the section is not pushed on the off path');
    assert.deepEqual(craft, [], 'no registry ran, so there is nothing to report');

    const corpus = convoPersonaWithCraft();
    assert.ok(system.startsWith(`${corpus}\n\n`), 'every module is in the cached prefix instead');
    assert.equal(personaChars, corpus.length, 'the reported persona size is the prefix that is really there');
    assert.equal(convoPersonaChars(), corpus.length, 'and so is the cache-prefix length the lane is told');
    assert.equal(sections.find(s => s.name === 'persona')?.chars, corpus.length);
    for (const m of CRAFT_MODULES) {
      assert.equal(system.split(craftModuleText(m.id)).length - 1, 1, `${m.id} reaches the model exactly once`);
    }
  } finally {
    delete process.env.CONVO_PERSONA_MODULES;
  }
  assert.equal(personaModulesEnabled(), true, 'the flag is restored for the rest of the file');
});

test('on the default path the cached prefix is the shared block plus the shrunken Context.md', () => {
  const { system, personaChars } = buildSystemPromptSections(...args());
  const head = `${renderPersonaBlock('convo')}\n\n${loadContext('convo')}`;
  assert.equal(personaChars, head.length);
  assert.equal(convoPersonaChars(), head.length);
  assert.equal(convoPersona(), head, 'the head is the block and the core, joined the one way');
  assert.ok(system.startsWith(`${head}\n\n`));
  assert.ok(personaChars < convoPersonaWithCraft().length, 'the pages really are outside the cached prefix');
});

// ── the plumbing, through the front door ─────────────────────────────────────
//
// Four of the seven gates read facts the assembler computes for itself, and a test against
// `renderCraftModules` covers those completely. The other three arrive from the caller — the
// attachment note convo/client.ts folded into the turn text, and the two reads memory/dossier.ts
// answered — and NOTHING above can see that wiring: hand the assembler a `craftFacts` object and it
// will happily gate on it whether or not any live turn ever fills it in. So this runs a real turn
// through `chat` with the model faked at the lane seam (the routingGate.test.ts pattern) and reads
// the system prompt the lane was handed.

/** A schema-valid envelope, so the turn completes without a retry ladder. */
const fakeReply = (text: string): LlmResult => ({
  text: JSON.stringify({ confidence_level: 90, tool_calls: null, bubbles: [{ text, re: null }] }),
  toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test',
});

/** The turn as the front door runs it, returning the prompt text the lane got: the system message,
 *  then the per-turn tail, which rides as its own user message right before theirs (convo/client.ts). */
async function systemFromRealTurn(handle: string, message: string, media = emptyMedia()): Promise<string> {
  const ctx: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle };
  let system = '';
  await chat(randomUUID(), message, media, ctx, async req => {
    const tail = req.messages[req.messages.length - 2];
    system = system || `${req.system}\n\n${typeof tail?.content === 'string' ? tail.content : ''}`;
    return fakeReply('one sec');
  });
  assert.ok(system.length > 1000, 'the lane really got a prompt');
  return system;
}

test('a media turn on a cold profile loads the two pages only the caller can gate', async () => {
  const handle = '+15558030001';
  const media = { ...emptyMedia(), images: [{ url: 'https://example.test/lease.jpg', mimeType: 'image/jpeg' }] };
  const system = await systemFromRealTurn(handle, 'whats this say', media);

  assert.ok(
    system.includes(craftModuleText('attachments')),
    'a file arrived and client.ts folded its note into the turn text, so the attachment page should be in front of her',
  );
  assert.ok(
    system.includes(craftModuleText('onboarding')),
    'nothing is on file for this handle, so getting to know them is still the job',
  );
  assert.ok(
    !system.includes(craftModuleText('email_flag')),
    'nothing is flagged in her short tier, so that page stays out',
  );
});

test('a flagged email in the short tier is what loads the email page, on a turn with no file', async () => {
  const handle = '+15558030002';
  await addShortTerm({
    agentHandle: handle, kind: 'email_flag', request: 'invoice 4471',
    content: 'the supplier wants an answer on the disputed expedite fee before friday',
    meta: { from: 'accounts@northsupplier.example', subject: 'RE: invoice 4471' },
  });
  const system = await systemFromRealTurn(handle, 'did anything come in');

  assert.ok(system.includes(craftModuleText('email_flag')), 'a flag is live, so the page comes with it');
  assert.ok(!system.includes(craftModuleText('attachments')), 'and no file arrived, so that one does not');
});
