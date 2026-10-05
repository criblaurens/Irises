// What the Convo prompt is ALLOWED to be — today's sizes, today's rule statements, today's
// duplication, all written down in one place.
//
// Convo's system prompt assembled to ~177k characters, of which ~138k was the persona. Every block
// in it was added by someone with a good reason, and nothing had ever said no. This module is the
// "no": a set of numbers and phrases measured against the live assembler, held by three tests
// (promptBudget.test.ts, promptPolicy.test.ts, clauseInventory.test.ts).
//
// Since the Never-Send-a-Leaf rewrite the personality is not one block of prose anywhere, and the
// lines below keep its pieces apart. The always-on head (`persona`, 84k) is the SHARED PERSONA
// BLOCK — the whole character written once in persona/policy.ts and rendered byte-identically into
// all four prompt surfaces — followed by convo/Context.md, which is the front-line FUNCTION file
// now and states no character of its own. `craft_modules` is the nine craft pages (convo/craft/*.md,
// up to 30k of them on the turn that needs the most) that load behind their gates, one of
// them — craft/hooks.md — only on an idle turn. Three lines are the per-turn personality proper:
// `weather` is the COMPILED affect directive (persona/affectCompiler.ts), imperatives where it used
// to be paragraphs describing a state; `hooks` is this turn's rhythm contract and is ZERO on a task
// turn; `thesis` is her one read on this person. And `behavior_anchor` is the drift anchor, picked
// per turn by mode and transcript window (persona/policy.ts renderDriftAnchor) rather than the one
// static string it replaced. A phrase check reads ALL of it, because a rule in a page is still a
// rule the model reads; a size check reads them apart, because the whole point of a page is the
// turns it stays out of.
//
// It ENFORCES NOTHING AT RUNTIME. No prompt path reads any of this — the assembler will happily
// build a prompt twice this size, and a real turn whose dossier is longer than the fixture's is not
// an error. These are test-time ceilings measured on seven representative turns, so the failure they
// produce is "a prose block grew since someone last looked", which is exactly the failure that has
// no other detector.
//
// Its whole design point is that TIGHTENING IS A ONE-LINE DIFF. P0 measured and pinned; P1 deleted
// the duplicated clauses and dropped every count in CLAUSE_INVENTORY to one; every phase since has
// re-measured the sections it moved in the commit that moved them. The numbers below were taken
// TWICE in the Never-Send-a-Leaf rewrite: once on the whole table when the rewrite's last prose had
// landed, and once more at the end, after the earned material — the moment sampler and the thesis
// store — was wired into the turn. THE SECOND PASS MOVED NOTHING. That is a result rather than a
// skipped step, and the reason is the discipline itself: the only line the earned material can
// reach is `hooks`, whose ceiling its own commit ratcheted from 470 to 1,810 for the widest moment
// sample the renderer can build, and `thesis` is a data line whose fixture that wiring never
// touched. So every number here is inside the 2% band the fixtures hold it to, and every one of
// them is where the commit that moved it left it.
//
// Which is why only two of the twenty-five lines below carry a clause about that last pass, and
// that is deliberate: a table where nothing moved would otherwise gain twenty-three copies of one
// sentence, and this module is the one that argues against duplicated prose. `hooks` says what the audit found and `thesis`
// says what the store behind it changed; the silence on the rest is the whole-table statement made
// once, here. Nothing is an aspiration either way: every number is a measurement, and the comment
// beside a number says which fixture produced it, what the rewrite did to it, and what it used to be.

import type { SectionId } from './promptSections.js';

/** A budget line: every part of the assembled prompt (promptSections.ts SECTION_IDS — which already
 *  includes `persona`, `behavior_anchor` and `json_anchor`), plus the one part that is not a section
 *  of its own. */
export type BudgetKey = SectionId | 'memory_stack';

/**
 * The size each part of the prompt stands at TODAY, in characters — measured through the real
 * `buildSystemPromptSections` on the seven fixtures in promptBudget.test.ts (cold thin profile ·
 * mature profile with a plain question · media turn · burst + tapped reply in a group · thread
 * offer · the same mature turn on a long thread · an idle turn on that same long thread), then
 * rounded UP to a tidy number.
 *
 * How much headroom: at most 2%, and less than that wherever a tidy number allows — 2% of `persona`
 * is 1,680 characters even now that the character prose has come out of it, i.e. room for a whole
 * new section to arrive unnoticed, which is the thing this table exists to notice. `persona` carries
 * ~100 characters of slack: a sentence added to Context.md is meant to fail here and be ratcheted
 * deliberately, not absorbed.
 *
 * The 2% is checked, not promised. promptBudget.test.ts fails on a ceiling that sits further than that
 * above its measurement, so a phase that deletes prose cannot leave its old ceiling behind as slack
 * for the next arrival to land in — the deletion pulls the number down in the same commit.
 *
 * `model_map` and `update_status` are the two deliberate exceptions, each well above its measured
 * size: their text is built from the HOST rather than from repo prose — the resolved model map
 * (MODELS/PROVIDERS plus whatever engine discovery found) in the one, the running build's sha and
 * branch plus the checker's own answer in the other — so a bare checkout and a configured install
 * legitimately differ. A tight ceiling on either would fail on somebody else's machine and teach
 * everyone to ignore the test.
 *
 * `memory_stack` is the wrapped memory tiers inside `context_block` (memory/wrappers.ts:
 * identity card → short → medium → discovery → flexible). It has its own line because it is the part that
 * grows with USE rather than with editing — every look, note and directive lands in it — and because
 * a `context_block` ceiling alone cannot say whether the dossier or the tiers moved. That second
 * reason is only true while some fixture carries a context block that is MORE than its stack: P2
 * folded the plain tenure section into the card, which left the steering-question section as the one
 * plain part a routed block can still have, and the thread-offer fixture carries one so that the two
 * numbers keep measuring two things.
 *
 * `status_contract` is prose too, but GENERATED prose: the ten ENVELOPE_FIELDS descriptions plus
 * the feeling wheel (persona/status.ts), identical on every turn. It is the one line here that cannot
 * be tightened in the prompt alone — those descriptions are also the response schema both lanes
 * validate against, so shrinking this number means editing the table and moving both copies at once.
 * P3 is what that looks like from this side: the envelope shrank from seventeen fields to eight, and
 * the two copies moved together in the same commit.
 *
 * The data-shaped sections (`context_block`, `memory_stack`, `burst`, `group`, `active_ops`,
 * `tapped_reply`, `thesis`, `tool_docs`) are measured on their fixture's data, so changing a fixture
 * re-measures the number rather than breaking the test's meaning — and a LIVE turn is allowed to
 * carry more than a fixture, so convergence/expectations.ts reports an overshoot on those rather
 * than failing it. The prose-shaped ones (`persona`, both anchors, `intro_weave`, `weather`,
 * `thread`, `hooks`, `turn_focus`, the timing reads) are the ratchet proper, and those the live
 * battery scores.
 *
 * `craft_modules` is a third kind: a SUM over whichever craft pages the turn's gates fired
 * (personaModules.ts), so its ceiling is the widest such sum across the fixtures rather than the size
 * of any one thing. Editing a page moves it; so does a fixture whose facts fire a different set. The
 * pages' own bytes are held elsewhere — personaModules.test.ts joins the persona and every page and
 * pins that corpus's sha256 — which is why this line is a budget and not a ratchet.
 */
export const PROMPT_BUDGET: Record<BudgetKey, number> = {
  persona: 135_250,            // 135,113 on every fixture. Familiarity mask (2026-09-26): +156 from 134,957, one sentence appended to the feelings paragraph of the shared persona block (policy.ts), the primacy-edge copy of the law the per-turn weather line enforces (persona/affectCompiler.ts MASK_LINES): with someone she barely knows nothing is volunteered yet, so asked she says the true word small and unasked only the volume shows. It first landed at +110 and was reworded before the branch closed, because the first wording could be read as holding back even the asked answer. The 134,957 it starts from was already over the old ceiling on main before this branch (Context.md and the persona block both grew since the figure below was recorded, with no ratchet at the time); that drift is absorbed here rather than re-derived. Was 113_750 for 112,595 on every fixture. Task 17 (action-honesty) re-measure: +40 from the figure this line last recorded, all of it Context.md's data-tag list in "What `<prompt>` is" gaining `<live_reminders>` and `<action_results>`, the two tags the reminder-by-id and honesty work added to the per-turn block (personaModules.test.ts's corpus pin has the exact byte count). The gap between this line's previous "111,160" and the 112,555 that measurement otherwise implies predates this branch — policy.ts's PERSONA_BLOCK is untouched here — and is left standing rather than re-litigated, since closing it would mean re-deriving a history this branch did not write. Was 112_300 for 111,160 on every fixture — the persona HEAD: the shared persona block first (persona/policy.ts renderPersonaBlock, 8,661 characters plus the `\n\n` join), then convo/Context.md. Was 85_556 for 85,541 — +872, and all of it Context.md learning the third turn shape: the two places that asked "task or idle" now ask a three-way question and say where a share stops, the classification list gained the share bullet and the banter bullet points at it, the probe section's idle-question exception became the share's own move, and the predict paragraph states the one distinction that decides the case (a probe hands the turn back empty and is banned everywhere; a follow-up asks for the part of their own story they left out). The slack is the same fifteen characters the line has always carried. The Never-Send-a-Leaf rewrite: −16,752 from 100,746, and the two commits behind that figure only mean anything read together — +7,174 for the block, −23,926 for the character prose the block replaced. The block is the WHOLE personality written ONCE and rendered byte-identically into all four prompt surfaces, so where there used to be four descriptions of her — one per surface, the three non-Convo ones thin and quietly divergent — there is now one string, and Context.md is the front-line FUNCTION file that states none of it. What came out of Context.md: "Who Irises is", "Adaptive style" and "How you address them" outright; the Lowndes playbook, replaced by eleven first-principle moves; "run the stack", rebuilt on the turn-shape split; "How you write", cut to the floor state; the inner-weather section, re-authored around a block that instructs instead of describing. The opening **ABSOLUTE RULE** blockquote came out with them and is BACK, byte-for-byte off `main`, in the supervisor-corrections commit below: the spec range that removed it was MISLABELLED ("title + three intro paragraphs" also swallowed the blockquote), so the deletion was never an editorial call, and the four-field envelope rule is precisely the law the two-copy drift strategy wants at BOTH edges — the primacy edge here, shared.ts's `json_anchor` at the recency edge (CLAUSE_INVENTORY's header says so beside the strategy). The accounting worth keeping: the personality reaches four surfaces for 16,752 characters LESS than Convo alone used to spend on its own copy. The slack this line carries is deliberate and is fifteen characters, the width the own-wording ratchet left and this one keeps. It sits inside the cached prefix (convoPersonaChars), so on the Anthropic lane these bytes are written once per deployment rather than per turn. What no longer stands over them is the pre-P4a relocation golden, retired in the same phase: personaModules.test.ts pins the sha256 and length of the whole corpus (Context.md + every page) instead, so everything below is a record of what each commit moved rather than a test that still re-checks it. Was 84_780 for 84,765 — +776 for the share paragraph, ONE paragraph in the shared persona block (policy.ts) and nothing in Context.md: the turn law counts three kinds instead of two (+2) and the third kind gets its own paragraph beside the other two (+774, the prose and the blank line that seats it). A share is a bid, a receipt turns a bid away, the reply is one move about the thing they handed her, a gap she can guess is hers to state and a gap only they can fill is hers to ask for when her weather leaves it open. It duplicates craft/share.md on purpose and the duplication is the point: the page renders only on the turn it governs and only on this lane, while the block is the one string all four surfaces render, so a lane with no craft pages still knows the shape exists. Was 84_140 for 84,123 — +642 for the own-wording paragraph, ONE paragraph in the shared persona block (policy.ts, inside "How you write") and nothing in Context.md: her own wording is spent the moment she sends it (an opener, a closer, a turn of phrase never comes back, whether or not the point is new), a line that arrives ready-made counts as already sent even past the visible window, and their words may be echoed while hers may not. It is the GENERAL form of a rule the prompt until now stated only at its sites (the settled-ground re-ask, holding lines, hook callbacks, teases, the same-kind Fallfirm outcome), and it sits in the block because the block is the one string every lane renders — the sites stay as its worked examples (charter §7.8). Was 84_140 for 84,039 — +84 for the late-night-register commit and no ratchet, because the ceiling had the room: the persona block rewrites two sentences (+71 — the hour makes her smaller and quieter and changes nothing else, and their name is a thing she knows rather than a word she drops into a bubble) and Context.md nets +13. Was 84_210 for 84,106 — −67 for the THIRD supervisor corrections, two Context.md prose fixes and nothing else, and the same rule as the −326 below reaching the last two places in this file that still taught the beat: the three-bubble demo's RIGHT label reads "then stop" and its third bubble carries the third FACT rather than a trailer, and self-check 6 stops telling her to leave the overflow in reach when the count runs over. Was 84_540 for 84,432 — −326 for the SECOND supervisor corrections, five Context.md prose fixes and nothing else, all of them one rule the whole-branch review settled (a task turn answers and stops): the trailing offer is deleted from the bubble-count paragraph, from the tip demo's RIGHT half — which is ONE bubble now rather than two, so the demo shows the rule as well as stating it — from the breakdown bullet and from first principle 3, and the machinery law loses its first sentence, which the shared persona block already says. Was 84_100 for 83,994 — +438 for the supervisor corrections, three Context.md prose fixes and nothing else: +489 restoring the ABSOLUTE RULE blockquote, −53 for the confidence section's tone paragraph, which stated its own law twice in one paragraph, and +2 because §Language's lead-in counted two rules over three bullets. Was 100_850 for 100,746 — UNMOVED by the idle gate, which bought a ninth craft page rather than a line of persona prose. +856 for the reply-language law, the one place the persona had to change because the mechanism did: §Language's two bullets became three (which memory sets the language, that an explicit ask in the conversation beats it, and that it is saved the same turn through set_preference key reply_language — never a directive), and the preferences section names the one exception to its own write route. Was 99_990 for 99,890 — +279 for the one paragraph run control owes the persona: the delegate section now names the second thing that can be done to a look already going (steer_research adds to the run; cancel_research is still the one that drops it). Was 99,700 for 99,611 — P4b's second half shrank "When to delegate (and how)" from 14,348 to 8,888 by deleting the ten runs of prose the delegate_to_ops tool doc (tools.ts) already ships on every turn: the kind lanes, the meta_prompt skeleton, media_scope, the holding-text examples, "Answer YOURSELF". Was 105,200 for 105,071 after P4b split "Connect the dots": the thread-tagging craft (9,120 chars across nineteen paragraphs) went to craft/threading.md behind the thread section, and a 366-char pointer stayed behind because the BANTER half of that section is deliberately still always-on. Was 114,000 for 113,858 after P4a moved seven sections (24,065 chars) out to convo/craft/. Was 138,020 for 137,923 after P3 part 3 took the inner-weather section's momentum sentence (−179): applyAffectDrift enforces it now. Was 138,200 for 138,102 after P1 deleted the envelope's field list + the copied wheel (was 141,600 for 141,474)
  craft_modules: 31_550,       // 31,222 — the THREAD-OFFER fixture, the same widest set (threading + send-order + reminders + email-flag + onboarding + hooks). Task 17 (action-honesty) re-measure: +625 from 30,597, all of it craft/reminders.md, whose "Managing them" section became the id rule (personaModules.test.ts's corpus pin itemises the same page at +561 file bytes; the gap is this set's own rounding, not a second change — no other page in the set moved). Was 30_910 for 30,597 — the THREAD-OFFER fixture, and a SUM over whichever pages the turn's gates fired rather than the size of any one thing: threading + send-order + reminders + onboarding + email-flag + hooks is the widest set a turn can carry. The Never-Send-a-Leaf rewrite: +39 from 29,660, which is the most misleading number in this table until it is broken into its parts — craft/hooks.md is NEW and 4,561 of it, craft/onboarding.md came out 3,151 lighter and craft/threading.md 1,373 lighter, both of those rewritten in the new register rather than trimmed and both better for it (4,561 − 3,151 − 1,373 = 37; the last two characters are the `\n\n` a ninth page brings with it, personaModules.ts). So the widest craft a turn can carry barely moved while three of the six pages in it changed completely. The fixtures that do NOT load the hook page show the rewrite plainly: the media turn measures 20,234, the mature and long-thread turns 17,569, the cold turn 17,560, the group burst 7,433 — and a turn with no thread, no file and a filled-in profile carries none of it. The hook page had never been in a measured sum before this phase, because it gates on the idle turn (personaModules.ts `idle_turn`) and no fixture used to be idle; the thread-offer fixture had no CHOICE about becoming one, because an offer is only ever made on a hook turn (persona/hooks.ts — `offerAllowed` is true in that mode and no other), so an offer on a task turn is a shape the assembler can no longer build and the widest craft set had been measured on one. The SEVENTH fixture is the second-widest sum here at 22,246 and moves this ceiling not at all: it is the mature task set (17,441) plus craft/hooks.md (4,803) and the `\n\n` a ninth page brings, because an idle turn on a long thread loads the hook page without loading the thread one. The EIGHTH is the third-widest at 21,748, the same set with craft/share.md (4,305) in the hook page's place, and it moves nothing either — which is the arithmetic that settles the whole sibling pair rather than a fact about that one fixture. The two pages are DISJOINT (personaModules.ts: one gate returns one shape), so every set is one of them or neither, the share page is the smaller of the two by 498 characters, and a share turn can carry a thread offer exactly as a hook turn can (persona/hooks.ts — `offerAllowed` is true in both modes). The widest set a share turn could therefore build is this ceiling's own set with share.md swapped in, 29,278, and the thread-offer hook turn stays the maximum. Was 29_640 for 29,534 — +242 for the late-night-register commit, all of it in craft/hooks.md: the quiet-reply paragraph split in two, and the new half ("Late is not quiet.") is the whole intervention — a late idle turn keeps whatever kinds it left open at a lower volume, their goodnight never comes back as hers, and never the same shape two nights running. Longer than the clause it replaces because a register takes a paragraph to state where a script takes one sentence. Was 29_760 for 29,662 — −73 for the THIRD supervisor corrections, one page and one bullet: craft/send-order.md 3,778 → 3,705, where the passing-mention bullet becomes the rule it was always written for — only an explicit ask is work — which settles their "ok" without first teaching the beat in order to exempt it. Unlike the −39 below this one is not fixture-selective in the other direction: EVERY fixture that loads the page moved the full −73, the mature and long-thread turns from 17,569 to 17,496 among them, because send-order gates on the reply-order section rather than on a tool. Was 29_690 for 29,589 — −55 for the FOURTH supervisor corrections, one page and two clauses: craft/send-order.md 3,705 → 3,650, where the reply-order paragraph stops illustrating a run of bubbles as an answer followed by a little passing-mention trailer (−39; it reads "picking up the first of them, not the last", which is the ordering claim the paragraph was always making) and the short-ack bullet stops naming the beat an "ok" is not consent to run (−16). The same fixture split as the −73 above, and for the same reason: EVERY fixture that loads the page moved the full −55 — the thread offer here, the media turn 20,161 → 20,106, the mature and long-thread turns 17,496 → 17,441 — while the cold turn (17,560) and the group burst (7,433) do not carry send-order and did not move. Was 29_800 for 29,699 — −37 for the second supervisor corrections, two register fixes on pages this sum carries: craft/reminders.md −39 (the confirmation she writes after setting one is a flat confirming text, and an antisocial hour is stated plainly, once, and set anyway) against craft/send-order.md +2, the one page on this branch that GREW, because the thumbs-up emoji spelled out as "a thumbs-up tapback" is +17 against −14 for a close that is flat rather than warm and −1 for the RIGHT label above it. The two fixtures that carry reminders but not send-order moved the full −39: the cold turn and the group burst. Was 30_700 for 30,371, with T3's 709-character placeholder page standing in for the real one. Was 30_000 for 29,660 — the same widest set before any hook page joined it (8,901 of that the threading page, 2,674 the reminders page); those four other fixtures each rose 322 when the automations paragraph moved off the threading page onto the reminders page, which the MAXIMUM cannot see because the widest fixture loads both. Was 23,400 for the media fixture's 23,100, when the media turn was the widest there was. NOT a prose ratchet like the lines below it: the number moves when a fixture's facts fire a different set, and the pages' own bytes are pinned by the corpus sha256 in personaModules.test.ts
  tool_docs: 21_900,           // 21,664 — the GROUP fixture (15 tools). Task 17 (action-honesty) re-measure: +1,854 from 19,810, not from one tool alone — UPDATE_AUTOMATION_TOOL joined convoToolList right after CANCEL_AUTOMATION_TOOL (tools.ts), and CANCEL_AUTOMATION_TOOL, CANCEL_RESEARCH_TOOL and STEER_RESEARCH_TOOL were rewritten id-first in the same wave (name the item by `id`, `match` as the fallback). Every doc here renders twice under toolsViaJson — once in the tool docs, once in the envelope's flat args union — which is why four tools' worth of rewriting moves this line by roughly double their own bytes. Was 19_950 for 19,810 — the GROUP fixture. +242 for steer_research's own `engine_actions`: an addition can ask for something to be DONE, and with guidance as its only field such an addition was invisible to the record of what was handed over and rendered inside the data tag on a replay leg. Was 19_700 for 19,568. +1,362 for the engine-actions contract (tools.ts): delegate_to_ops gains the `engine_actions` argument — the acting half of a two-part ask, which `request` had nowhere to put and delegation therefore dropped — plus the three neighbouring descriptions that made dropping it look right: the tool's own text now names engine-side setup as a thing she asks for and keeps her own build the one thing that is terminal-only, `request` says a distillation changes the wording and never the scope, `kind` sends an acting ask to general or compute, and `effect` draws its line at the USER's things rather than at "anything outside Irises", which left an engine setting itself up with no correct bucket. Was 18_350 for 18,206 — the GROUP fixture (14 tools; the 1:1 lane carries 12 and measures 17,952). The Never-Send-a-Leaf rewrite: −113 from 18,319, spread over five docs and one deletion — the delegate holding text and the schedule confirmation are flat rather than warm (and the holding doc stops explaining where her warmth lives), the antisocial-hour nudge became a plain statement that sets the thing anyway, cancel_automation stopped leaving the door open, update_directives declines flat, and update_memory lost the congratulations example whose whole point was a beat she no longer sends. The ceiling was measured at 18,319 before the phase and stands unchanged, because the section only shrank: 0.8% of headroom, inside the band. A DATA line as well as a prose one — the tool set differs by deployment — so convergence/expectations.ts reports a live overshoot rather than failing it. Was 18_350 for 18,319. +688 for the reply-language slot: set_preference gains the `reply_language` clause and its key list the slot's name, and update_directives now REFUSES a language ask (it names set_preference instead of the old "add always reply in Spanish") and gains the change-your-mind line that stops two rules standing that disagree — the tool-side half of the 2026-09-04 failure, where the only mechanism was a call the model never made. Was 17_650 for 17,631. +1,185 for steer_research, the sibling of cancel_research that adds to a run instead of dropping it (tools.ts): its doc is what stops the model spending a live run on a "also check X" — a fresh delegate_to_ops or a cancel. Was 16,450 for 16,446 (13 tools; the 1:1 lane 11). +201 for delegate_to_ops' `effect` arg (the approval gate's read/act tag, tools.ts). Was 16,245; was 16,500 for 16,288, before remember_user's `handle` doc stopped asking "whose info this is" and named the messaging handle instead
  capability: 240,             // 237 — the mature and long-thread fixtures: five classes, all six minus inbox, which is the longest this line gets (the all-six variant measures 192, the group's two-class one 126). UNMOVED by the Never-Send-a-Leaf rewrite, and it could not have moved — this section is a generated list of what the host can do, and the phase was about who is saying it. Was 248
  model_map: 800,              // 384 on a bare checkout — HOST-DEPENDENT, see above, and the one deliberate exception to the 2%. The Never-Send-a-Leaf rewrite: −3 from 387, the tail. It used to ask her to keep the model answer a light sentence and swing back to them; it now says two model names, one flat sentence, then stop
  update_status: 900,          // 719 on this checkout, 696 with a four-character branch like `main` — the "can't tell" variant every fixture renders, since npm test never arms the checker. HOST-DEPENDENT, see above, and the second deliberate exception to the 2%: `main` is four characters and a working branch is twenty-seven (719 measured on this one), the no-version-stamp variant measures 734, and the sha is whatever this clone sits on. NEW with the terminal-only update path — the section that replaced the chat apply tool, and the only thing that keeps "what version are you?" an answer rather than a guess
  name_nudge: 173,             // 170 — fixed prose, on the cold fixture, the only turn here with an unknown name. The Never-Send-a-Leaf rewrite: +7 from 163, for the address rule's sixth and last copy. The nudge used to hand her a placeholder nickname for the gap ("call them \"boss\" for now"), and the rule is now that the gap gets NOTHING — a saved address_as, else their name, else no address term at all. Spelling "address them as nothing" costs more characters than naming a word, which is the whole trade this line records. Was 165 for 163 (was 171)
  intro_weave: 790,            // 779 — INTRO_WEAVE_BLOCK (agents/ops/firstMove.ts), on the cold fixture. The Never-Send-a-Leaf rewrite: +19 from 760, re-authoring the block's two personality clauses onto the mechanisms the shared block states — "mood match FIRST" became register-matched-never-content (a task opener gets the task first), and the "ONE light association" the read was allowed to colour the reply with became ONE flat, deniable judgment. Same single-beat ceiling, same never-a-word-about-being-installed clause, and the craft pointer now names the hooks page rather than a deleted section. Was 770 for 760 (was 795)
  context_block: 7_490,        // 7,440 — the thread-offer fixture: the mature stack (6,275, the `memory_stack` line below) plus BOTH plain sections a routed block can carry, a steering question and an approval ask outstanding at once (memory/dossier.ts). The Never-Send-a-Leaf rewrite: −3 from 7,454, which is what the address rule's third copy costs after the two long clauses either side of it cancel out — the no-address-term rule is longer than the nickname it replaced, and the stance seed and the style-defaults ladder are shorter in the new register. The ceiling stands at 0.7% headroom. Was 7_500 for 7,451 — −11 for the second supervisor corrections, the whole of it the identity card's tenure line (memory/tenure.ts renderTenureLine), which called the two dates "soft context for warmth" and now calls them context only. Was 7,454 — +305 for the reply-language law and the dates on the standing rules: law (b) now names the Reply language line in the addressing header as the SOLE authority on the language she replies in (a rule the relay lanes could read at all, unlike the reversal they never saw), and every standing rule renders with the day it was asked for, which is what makes "trust the newer entry" an instruction a lane can act on. Was 7_200 for 7,149 with the same two plain sections; was 6,700 for 6,623 with the steering question alone, the approval gate's section being the +526. Was 6,050 for 5,967 while no fixture carried a plain part at all, and 5,950 for 5,837 before the medium tier took back the hard-personal-rules line the ladder deletion dropped with nowhere to land. Was 12,500 for 12,290; P2 sent the discovery scaffold's craft coaching to craft/onboarding.md, gated every memory block on the turn, folded the plain tenure section into the identity card, replaced each tier's You-should/You-MUST-NOT ladder with the two or three lines that tier alone decides, and retired the three seed stances
  thesis: 380,                 // 373 — HER ONE READ on this person (memory/thesisEngine.ts), rendered right behind the dossier it is the conclusion of, on the thread-offer fixture. NEW in the Never-Send-a-Leaf rewrite, and a DATA line rather than a prose ratchet: the text is written per person by the weekly pass and its length is a property of them, which is why it sits with `context_block` in convergence/expectations.ts and is reported rather than failed on a live overshoot. Measured on the fixture whose thesis is the length the writer prompt asks for — two to four sentences, behaviour only. It renders on no other fixture, and the store behind it now EXISTS: convo/client.ts reads THESIS.md on every non-group turn the flag is on for (`thesisEnabled()` → `getThesis` → `renderThesisSection`), so a live turn carries this section as soon as the weekly pass has written one, and pushes nothing at all — `''` — until then. RE-MEASURED at the end of the phase and unmoved at 373: the wiring gave this line a live turn to render on, not a longer string to render, and the fixture's own thesis is repo prose that nothing in Wave 3 touched
  self: 4_930,                // 4,881 — SELF.md (memory/selfHarvest.ts) at its arithmetic maximum on the thread-offer fixture: heading, lead and MAX_SELF_ENTRIES lines each at SELF_TEXT_MAX. NEW with the autonomy round (2026-09-25).
  active_ops: 4_040,           // 3,964 — the media fixture. The holding-beat review pass: −89 from 4,053, the how's-it-going block dropping its two quoted sample replies (shared.ts renderActiveOps). Was 4_090 for 4,053. The snappy-replies holding-beat pass: +146 from 3,907, the ack-while-running block (shared.ts renderActiveOps) trading its quoted sample lines for the rule itself: a still-working beat only when the result has not gone out, in a fresh shape and wording, unlike the beats listed for this turn, claiming no step the status does not show. Was 3_950 for 3,907. Task 17 (action-honesty) re-measure: +226 from 3,681, for run control naming its target instead of assuming the empty-match case (shared.ts renderActiveOps): every status line now carries its `[L…]` lookup id, the handed-over sentence names "the additions to it" and carves out an addition marked as never having reached the look, and both the steer/replace paragraph and the stop paragraph tell her to pass the lookup's id rather than relying on there being only one to act on. Was 3_710 for 3,681 — the media fixture. +409 for the two honesty additions (shared.ts renderActiveOps): the status line reads back the engine actions the running task really carries, and one block states what those lines authorize her to say — the record of what was handed over, and never a claim that a part is being taken care of unless it is listed there. The 2026-09-19 live gap: asked whether she had asked for the setup half, she answered from what she remembered promising, and the half had never been delegated at all. Was 3_310 for 3,272 — the media fixture: two looks in flight, one queued, one of them carrying a mid-run addition of theirs. +704 for the same-subject rule (shared.ts renderActiveOps, between the steer block and the stop block), stated as the principle rather than as sample phrasings: a message about a subject already running is about that run, so it can only steer it (a direction the run lacks) or ask its status — never a second delegate_to_ops, which knows nothing the first run learned. The 2026-09-11 live gap: the running look named again, seven minutes in, became a second engine run from zero and the same answer twice, and the code guard (isDuplicateDelegation) only catches the byte-identical re-ask. Was 2_600 for 2,568. The Never-Send-a-Leaf rewrite: −2 from 2,570, and the figure recorded here was 2,570 until this re-measure took it. Two characters, one word: the ack branch used to say that when their "ok" is just closing a loop she closes it warmly, and now says she closes it flat. +624 was run control's own half of this section: the steer/redirect instruction block (a steer keeps the run, a replacement is cancel + delegate in one turn) plus the "you added" suffix the addition renders on its status line. Was 1,980 for 1,946 with the stop instruction alone (was 2,040)
  owed: 870,                  // 857 — check first (2026-09-26): the lead now says she asks whether they still need it before starting. Was 709 — owed asks (memory/owedAsks.ts) at the store's cap on the thread-offer fixture: OWED_MAX asks each at TURNED_DOWN_ASK_CHARS. NEW with the autonomy round (2026-09-25).
  recent_beats: 319,           // 313 — the media fixture, carrying a full history (state/holdingBeats.ts HOLDING_BEATS_KEPT, five beats). NEW in the snappy-replies holding-beat pass: her own last few holding beats, newest first, framed as the shapes to steer off; rendered only on a turn that can delegate. A DATA line: a chat whose beats run long legitimately measures wider.
  live_reminders: 2_400,       // 2,371 — the media fixture, now carrying the render cap (liveReminders.ts MAX_LIVE_REMINDERS = 10) with a realistic full gist on every row: cadence, next run, set date and a ~90-character `says:` clause. Task 17 (action-honesty) re-measure: the placeholder this line was sized against (~190 characters a row) held — 2,400 stands, now a measurement rather than a guess.
  group: 225,                  // 222 — a named group, three participants, plus the sentence that gives a fact about ANOTHER participant its write route (their handle from the list this section prints, never the sender's — remember_user's own doc is written for the 1:1 case). UNMOVED by the Never-Send-a-Leaf rewrite. Was 105 for 104 (and 109 before that)
  tapped_reply: 2_210,         // 2,173 — kind 'assistant' beyond the visible window, the largest of the four variants, on the group fixture. The Never-Send-a-Leaf rewrite: −17 from 2,190, and the size is not the interesting part. The branch that used to prescribe the reply on settled ground ("one light beat, plus at most one NEW thing that builds forward") now points at the hooks section instead, because whether a settled comment may carry a beat at all is the rhythm engine's call and no longer this section's. The other three branches lost "light" for "plain", and the unresolved branch stopped asking her to own the gap gently. Was 2_230 for 2,190 (was 2,290)
  burst: 1_130,                // 1,110 — three messages, group-labelled. UNMOVED by the Never-Send-a-Leaf rewrite: this section prints what arrived, and nothing in it is voiced. Was 1,160
  current_time: 385,           // 380 — fixed prose plus the formatted instant. +89 for the SEVENTH supervisor corrections, and the section still says exactly what it said: the line now LEADS with their wall clock and names it the one she reads and cites, and the ISO instant follows it as reminder arithmetic only. It used to open on the instant with the local time as an aside, and she read the first number she was handed — 07:57 in their zone came out of her as "1am". The +89 is that ordering written down: the two clauses naming which number is which. UNMOVED by the Never-Send-a-Leaf rewrite. Was 295 for 291 (was 305)
  weather: 1_390,              // 1,368 — feelings (2026-09-26): the compiled needs now name what she feels underneath, and an extreme one may slip into any reply. Was 1,081 — the COMPILED affect directive plus a moved climate, on the four fixtures that carry an affect row, and the largest single deletion this budget has recorded: the Never-Send-a-Leaf rewrite took −937 from 1,995. What went: the body-clock paragraph and the cycle paragraph (deleted at their source, persona/circadian.ts and persona/cycle.ts), the carried mood's level-out-of-a-hundred and its five-band texture essay (persona/mood.ts moodTexture), the four felt-gauge words and the trajectory line. What is left is at most four imperatives compiled from exactly the same machinery (persona/affectCompiler.ts) plus the climate bands, which are imperatives now too. The floor of this line is header + one mood line + tail: a turn with a full battery, an ordinary hour, no self-note and a default climate assembles 268 characters, where the same turn used to assemble about twelve hundred — and the two fixtures here with a computed state but no affect row measure 362. The ceiling is a moved climate on a HOOK turn, which is the widest the block gets, and the seventh fixture now measures it a second time: the climate span is gated on an open hook kind (persona/climate.ts HOOK_NAMING), so the two task turns carrying the same affect row and the same moved climate measure 1,007 and the two hook turns 1,058. Was 2,030 for 1,995; P3 part 3 had taken −269. Was 2,300 for 2,264 (+2 when the mood core became derived and 'powerful' cost two characters more than 'joyful'); was 2,700 for 2,581, before P1 pointed the block's tail at the status contract instead of re-listing the fields
  status_contract: 5_030,      // 4,956 — feelings (2026-09-26): `mood_label` asked to fit what she feels underneath. Was 4,889 — the autonomy round (2026-09-25): +513, the `turned_down` row joining the table. 4,376 — STATIC (ENVELOPE_FIELDS + the wheel), the same on every turn that renders it. The share turn: +174 from 4,202, two bullets reworded and no bullet added. +140 on `hook_kind`, which names a fourth word (`question`) and states the model's whole side of the question gate — that a question outranks the other kinds when the reply carried one, and that a question off a share turn is reported rather than hidden, because the receipt that catches the slip (`hook:off_turn`) has nothing else to read. The bullet also stops calling the value an extra beat carried BEYOND the answer: on a share turn the one move IS the reply, so the word for it is a move. +34 on `thread_outcome`, whose trigger clause gains her own follow-up landing or bouncing — the gauge that decides whether she may ask again (`rapport`) learns from nothing else, so the one move that asks them for something would otherwise have been the one move it never saw. Both bullets are the SAME strings the response schema carries, and that copy is ceilinged separately (persona/envelopeFields.test.ts, 3,470 → 3,650 for the identical +174), so the two ratchets move in the same commit or the table has two prices. Was 4,280 for 4,202. The Never-Send-a-Leaf rewrite: +90 from 4,112, in two directions. +167 for `hook_kind`'s bullet, spliced in at index 6 — the rhythm engine's one input (persona/hooks.ts), and the fourth field of the envelope the coercer may leave ABSENT rather than default, because a guessed beat is one the ledger would count against the kill switch's window. −77 for the carries-between-turns line, which moved with the weather block it is the other half of: it named four gauges in the vocabulary of the deleted prose ("warmth", "nerves") and now names three the affect engine still keeps FOR her — which of those the COMPILER reads is a separate question with a smaller answer (persona/affectCompiler.ts reads `social_battery` and `mood_level`), and this line is not making that claim — and the sentence asking her for the honest word and the direction went with it, because `mood_label`'s and `mood_shift`'s own bullets ask for exactly that two lines below. Was 4,350 for 4,279; was 4_180 for 4,112. +234 for `language_request`'s bullet: the standing-settings row, the one field of the envelope that SETS something instead of reporting it, and the only channel by which a language the English fast path cannot read (memory/standingSettings.ts) reaches code at all. Was 3,950 for 3,878. P3 part 3 added +251: one line saying the level and the gauges are kept FOR her, which is the half of the bargain no surviving field can state. Was 3,690 for 3,627 after the envelope shrink took −349 (ten bullets deleted, one added, `mood_label` reworded off the core it can no longer point at); was 4,000 for 3,976; was 3,650 for 3,591 before +353 re-homed three capture rules onto the two threading descriptions and +32 said whose mode `intent_mode` reads
  thread: 1_230,               // 1,211 — a pattern-rung theme offer plus a loop outcome ask, on the thread-offer fixture. RE-MEASURED AND UNMOVED by the Never-Send-a-Leaf rewrite, which is worth a line rather than silence: both offer blocks were re-authored — the loop ask is flat and named as the turn's one callback, and the pattern offer trades a softened tag for a flat named read, a judgment, and stops rather than handing the floor back — and the pattern block's rewritten sentence came out at exactly the length of the one it replaced. The loop BLOCK grew by the clause naming it a callback, but this ceiling is measured on the theme offer plus the loop OUTCOME ask, and neither of those two is the loop block. Was 1_270
  conversation_timing: 268,    // 263 — the widest of the gap/regime readings on these fixtures (the cold turn, with no history at all, measures 188). RE-MEASURED AND UNMOVED by the Never-Send-a-Leaf rewrite, and the reason is worth a line because the phase did rewrite one of this section's branches: the three-hour-plus unanswered-user line asked for "ONE light half-sentence acknowledgment" with a "sorry, just seeing this" example and a never-groveling clause, and now says plainly that the wait is hers, that she does not apologise for it and does not measure it, and that one flat clause is the ceiling if she names it at all — 13 characters shorter. NO FIXTURE HERE RENDERS THAT BRANCH: every history builder ends on one of HER bubbles twenty minutes back, so the reading is always the same-day assistant-last one. The 266 is that branch plus the late-night clock line the fixtures' 02:00 UTC instant produces, and it is measured under TZ=UTC — the suite's own TZ, and the only one this number means anything in, because the clock suffix is 49 characters longer at night than in the morning. Was 270 for 266 (was 278)
  reply_order: 620,            // 613 — renderArrivalGap's backward-order variant, the larger one, on the media fixture; the same-order variant the other fixtures render measures 257. UNMOVED by the Never-Send-a-Leaf rewrite. Was 640
  extra: 670,                  // 658 — the caller addendum, on the thread-offer fixture: the PENDING version note (update/announce.ts). +75 for the terminal-only update path: the note used to close on "and then restarting you", which is now false — scripts/update.sh restarts her and the engine gateway itself — so the clause was replaced by the promise the script actually keeps. Was 590 for 583 (was 610)
  hooks: 2_170,                // 2,135 — THIS TURN'S RHYTHM CONTRACT (persona/hooks.ts renderHooksSection), NEW in the Never-Send-a-Leaf rewrite, second-to-last in the block and immediately ahead of the turn-focus read. Measured on the OPEN_HOOK fixture (promptBudget.test.ts): a late idle turn with all three kinds open, the spacing interval spent, and the widest moment sample the engine can build — late because the fixtures' clock is 02:00 UTC, and the late line is register that rides every hook-mode variant at that hour, never a branch that closes one. That fixture is the widest shape there is because it is the only one that can carry the MOMENT LEAD at all — a quiet turn and a task turn never run the sampler, a moment only ever rides out as a callback, and sampling bills it either way — and because the lead's size is DATA inside a section whose ceiling the live battery enforces as prose (convergence/focusBattery.ts prose_budget scores every PROSE budget key). So the sample is the widest one `sampleMoments` can ever hand a turn rather than a plausible one: five lines (MOMENT_SAMPLE_RECENT + MOMENT_SAMPLE_OLD), each at MOMENT_TEXT_MAX, which `renderMomentLines` clamps to at the render seam whatever the file holds, each wearing the longest tag and the longest of the seven age phrases — and promptBudget.test.ts asserts that shape so it cannot silently narrow. The directive is HANDED to the assembler rather than compiled inside it (the fixtures' frozen clock is 02:00 UTC, which `computeCircadian` reads as `dead_night`), because production has twenty-four hours in the day and a ceiling taken on the widest producible shape is the honest one. At the measure before the register rewrite every moment-less variant was far smaller: hook with all three kinds open 445 — the seventh fixture renders exactly that one, because it is here for the drift anchor rather than for this section and carries no moment sample — the since-deleted sleep turn 502 (no kind open, plus the sleep line, which had grown +18 when HOOK_SLEEP_LINE took ", no greeting back"), quiet 321 (the quiet law then said "it is late for them" itself, so no sleep line was added there), no kind open 360. ZERO on a task turn, which is the no-regression pin the whole feature rests on: on the turns that are real work this section does not exist and the prompt is byte-identical to an install that never had a hook engine. The SHARE block is measured now too and does not compete for this number: the eighth fixture renders it at the widest that mode has — all FOUR kinds open, so the question line renders under the sentence naming them, plus the late register — and that is 666 characters, a third of this ceiling. It cannot get near it, and the reason is structural rather than editorial: the share mode has no sampler and is never given one (a moment rides out as a callback about something OLD, and a share turn already has something of theirs in front of her), so the one part of this section whose size is data is the one part that mode never carries. Was 1_790 for 1,760 — +171, and the widest shape MOVED rather than grew: the clock is a register now (persona/hooks.ts `lateNight`), so a late idle turn keeps every kind open and keeps the sampler, and the widest section is the moment sample PLUS the late line instead of either one alone. The late line is +47 on the sleep line it replaces, and it says how big the reply is rather than what to put in it. Was 1_685 for 1,653 — +107 for the FIFTH supervisor corrections, two lines rewritten and no line added, both of them on the live failure they were written for: a hook turn that still opened "hey riv" and still ended in a question. HOOK_LEAD is +69 (the turn hands nothing of theirs back, not their greeting, not their word — the persona block's law, said again a few hundred characters from the recency edge where the hooks section sits) and HOOK_OPEN_LINE is +38 (the one kind is SAID as a statement, never asked). Both ride every hook-mode variant above, but only the lead reaches the closed-kinds ones — the sleep turn and the no-kind-open turn render HOOK_NONE_OPEN in the open line's place, so those two moved +69 apiece (433 → 502, 291 → 360) while this fixture and the all-three-open shape moved the full +107 (338 → 445). The QUIET block carries neither line and did not move. Was 344 for 338 — a shape the fixtures' clock could not produce, and this key is enforced live, so that was a breach waiting for the first late-night idle turn rather than a paper debt. Was 470 for 462, before a sampler existed to fill the moment lead. Was 1_810 for 1,777 — the same widest sample measured on a turn that ALSO carried the sleep line, which is 124 characters (the line and its newline) this fixture no longer renders. `sleepQuiet` used to be additive: the section named all three kinds and then said to send them to bed, while the drift anchor at the recency edge said "one hook" — three copies of one turn disagreeing, on the plan's own 2am case. A late idle turn is now a CLOSED-KINDS hook turn (persona/hooks.ts): every kind forbidden, no moments, no thread offer, so it renders heading + lead + the none-open line + the sleep line + the clamp, the anchor's law moves to the quiet one with it, and so does the climate span's gate (persona/climate.ts HOOK_NAMING, `hookKindOpen`).
  unsend: 1_385,               // 1,360 — the widest shape the code can build: six bubbles (state/unsend.ts REACH_CAP), each clipped at 160 characters, plus the bar it restates. NEW with unsend (2026-10-01), rendered only on a turn the tool is offered, so no fixture carries it. A DATA line: shorter bubbles measure narrower.
  checkin: 340,               // 335 — fixed prose, the back-off's one open ask restated at the edge (memory/proactiveBackoff.ts), measured on the media fixture. NEW with the proactive back-off (2026-10-04), rendered only on the turn after an unanswered check-in, so a live turn carries it once. A DATA line in placement only: its text never varies.
  turn_focus: 550,             // 544 — the MEDIA fixture: a 299-character restatement (their line plus the attachment note, under the 400-character clip) and one hit, on a turn whose caller ran no idle gate, so it renders no `Turn:` line at all — `Turn: task` is a shape no fixture here reaches. UNMOVED by the Never-Send-a-Leaf rewrite, which spliced the `Turn:` line into this block. The correction this re-measure makes is the attribution, not the number: the comment here used to name the mature fixture, which measures 287. The two idle fixtures render the longer form (`Turn: idle · their message: 43 characters · 12th idle in a row`) and neither is the maximum — the cold "hey" measures 323 and the thread-offer stall 390 — because the restatement is what dominates this line, so an idle turn adds about sixty characters to the SHORTEST restatements there are. Was 570
  behavior_anchor: 1_475,      // 1,451 — the autonomy round (2026-09-25): the task law gains the put-off clause and a fifth mode (take) joins; re-measured across all ten variants. 1,169 — the DRIFT ANCHOR (persona/policy.ts renderDriftAnchor). EIGHT variants since the share law landed, all eight measured: task 726 short / 910 long, hook 837 / 1,021, quiet 735 / 919, share 950 / 1,134. SHARE ON A LONG WINDOW IS THE WIDEST OF THE EIGHT, and this ceiling is measured on it — the EIGHTH fixture, a share turn on the same eighty-row dense window fixtures 6 and 7 already use (deploy/app.env CONVO_HISTORY_MAX=80). The two share variants were measured one commit before anything could render them and the ceiling deliberately did not cover them, which the line said in place of covering them: with CONVO_SHARE_TURNS_ENABLED off the gate collapses a share to a task turn, so no directive with that mode existed and nothing production could build reached those two numbers. That debt is paid here the way the seventh fixture paid the last one — by giving the fixtures the turn that renders the real maximum, rather than by copying a number out of the renderer into this comment — and the flag flips after this and not before. Two axes pick the variant and each one costs separately: the WINDOW buys back the identity clauses past DRIFT_LONG_WINDOW_CHARS (+184 on all four modes — the same three bullets), and the MODE states the law for the turn in hand, where share is the longest of the four laws by 224 characters over task, 113 over hook and 215 over quiet: it is the only one that has to state a DECISION (guess what you can guess, ask only for what only they know) on top of the move, and the decision takes a clause the other three do not spend. Which is a CHANGE of shape, not just of number: the mode axis used to cost nothing, because task stated the longest law in both bands, and the hook bullet taking "A hook is a statement, never a question." moved the maximum onto a variant no fixture rendered. That was left standing for one commit as a ceiling of 928 over a measurement of 910 — the ratchet reading task/long while production could build 927 — and the commit that added the seventh fixture closed it the honest way round, by giving the fixtures the turn that renders the real maximum rather than by writing the number down here from the renderer. It has to be a fixture and not a note: this key is enforced LIVE (convergence/focusBattery.ts prose_budget scores every PROSE budget key), where a hook turn on a long window is an ordinary evening, so a maximum measured only on task turns was a breach waiting rather than a paper debt. promptBudget.test.ts pins all three long fixtures to the MODE each one reaches, not just to the band, so a later edit that turns one of those directives into a task or a sleep turn fails there instead of quietly narrowing this measurement again. Headroom is +1.85%, inside the 2% the ratchet allows and deliberately more than the single character 928 once carried over 927 — a ceiling one byte above its measurement is one that every edit to any of the six bullets trips, including the ones that shorten another variant, and a ceiling that always trips gets moved reflexively instead of argued with. Was 1_040 for 1,021, hook/long — the widest of the six variants the fixtures could reach while the share mode had no turn to render it on. +94 for the EIGHTH supervisor corrections, one bullet rewritten and no bullet added: the hook law's register line said to match their register and never their content, and now names what never comes back — their greeting, their word, their question — and says it holds for the FIRST BUBBLE too, because the live kill-switch round sent three hooks of which two opened by handing their own word straight back. It rides the two HOOK variants and none of the other six, so the maximum moved by exactly the bullet's growth (743 → 837 short, 927 → 1,021 long) and the task and quiet numbers above are the ones the last measure took. The quiet numbers were 698 / 882 until the late-night-register commit rewrote the quiet law's third bullet: it used to name the one right line at that hour, and it now says to say the plain thing once and let the beat pass. The maximum is unmoved — hook on a long window is still the widest of the six, so this ceiling did not need to move either. Was 945 for 927, hook/long. Was 928 for 910, task/long, the only variant the fixtures then reached; +211 on that from 699, when the anchor became per-turn — three identity bullets picked by the transcript window, three stating this turn's law — instead of the one static string it replaced. Still six bullets and still digit-free, so what moved is what the six SAY. Was 730 for 726, task/short, the only band any fixture then reached. Was 705 for 699 — P1: six lines that drift first (was 1,740 for 1,659 / 14 lines)
  json_anchor: 3_040,          // 3,010 — the envelope contract. The snappy-replies holding-beat pass: +53 from 2,957, the delegation example's bubble becoming a placeholder ellipsis with the beat rule stated beside it (short, true, a shape unlike her recent beats) in place of a stock holding line. Was 3_000 for 2,957 — the envelope contract, last in the prompt, the same on every fixture. The FOURTH supervisor corrections: −18 from 2,975, one clause, and the last place in the whole prompt that still taught the passing-mention beat — the bubble-count sentence capped her at three items and then, in the same breath, said where to leave the overflow; it now says "the top of it now and stop". The ceiling stands unchanged at a tidy 3,000 because the section only shrank: 1.5% of headroom, inside the band. GOLDEN_JSON_ANCHOR in promptSections.test.ts pins the bytes and was regenerated in the same commit. The Never-Send-a-Leaf rewrite: +47 from 2,928, for the one clause the closing `status` paragraph owes the rhythm engine — the recency edge now names the extra beat a reply may have carried, so the field the contract describes is also asked for in the last thing she reads. This is also where the envelope contract now stands ALONE: the **ABSOLUTE RULE** blockquote that opened Context.md said the same four fields in the same order and came out with the character sections (see `persona`). Was 2_950 for 2,928 (+20 in P3: the one-line description of `status` stopped asking for the gauges the schema no longer carries). Was 3,050 for 2,908
  memory_stack: 6_265,         // 6,191 — the mature stack, card through long doc, on a turn that touches none of it; the wrapped tiers inside `context_block` (memory/wrappers.ts). The Never-Send-a-Leaf rewrite: −3 from 6,278, the same three characters `context_block` records, because this stack is where they are — the addressing rule, the seed stance and the style-defaults ladder are all re-authored here. The ceiling stands at 1.2% headroom. Was 6_340 for 6,264 — −73 for the no-name commit: the addressing header drops its `Name:` line and the sentence telling her to drop a name in occasionally, so the one block every lane receives names nobody. The name is still stored and still answerable; what is gone is the standing instruction that put it in every bubble. Was 6_350 for 6,275 — the same −11 `context_block` records, and again this stack is where it is: the tenure line is part of the identity card. Was 6,278 — +305, the same two edits `context_block` carries: law (b)'s reply-language clause and the `(since <date>)` suffix on every standing rule. Was 6_050 for 5,973 (+6 when law (b) started naming the layers that are really in the prompt). Was 5,950 for 5,837; +130 gave the medium tier back its hard-personal-rules line. Was 12,500 for 12,290; the card is +43 on the preamble it replaced and absorbed the tenure section, then the three ladders and the three seed stances came off
};

/**
 * The floor under the live conversation's slice of everything the model reads —
 * `messagesChars / (systemChars + tailChars + messagesChars)`, the same number the per-turn
 * receipt reports (diagnostics/turnTrace.ts).
 *
 * Measured at **0.0068** on the mature fixture — 1,207 characters of a full 40-row window against a
 * 177k-character prompt — and pinned a hair below it. Read that number twice: two thirds of one
 * percent of what the model reads is the actual conversation. That is the finding this whole phase
 * exists to move, and the floor is what stops it moving the wrong way in the meantime.
 *
 * It rises as the prose shrinks, so this line ratchets UP in the later phases while PROMPT_BUDGET
 * ratchets down. P0 measured **0.0066** against a 182k prompt and pinned 0.0065; the rise to 0.0068 is
 * P1's persona deletions (the two restated envelope paragraphs, the collapsed behaviour anchor, the
 * copied feelings wheel and field list), and it is now held.
 *
 * What the rise is NOT is P1's second half. The status contract that replaced the deleted field list
 * is generated prose of very nearly the same size, so part 2 moved this fixture's whole prompt by
 * **+255 characters** — −3,372 of persona and −319 of weather tail against +3,946 of contract — and
 * this number not at all at four decimal places. That is the honest accounting: part 2 bought ONE
 * editable description of the envelope, and it did not buy size. Every four-decimal point of the floor
 * above came from part 1.
 *
 * P2 re-measured it at **0.0068** and it stayed there through parts 1 and 2. Those deletions are
 * real — the discovery scaffold's craft coaching, and the memory gate table — but they come off the
 * memory stack, which is nine thousand characters of a hundred and seventy-seven thousand. Part 3
 * takes that stack to **5,837** and moves this to **0.0070**: two four-decimal points for five
 * renderers, three ladders and three seed stances, which is the honest exchange rate. The persona
 * is what stands between this number and anything better, and P2 never touched it. Worth stating
 * plainly rather than letting a barely-moved floor read as a phase that did nothing: this phase
 * bought RELEVANCE, not size.
 *
 * P4a is the first phase to touch the persona since P1, and it measures **0.0072** (1,207 characters
 * of transcript against a 167,527-character prompt, down from 171,157). Read the exchange rate
 * honestly: twenty-four thousand characters left Context.md, and twenty thousand of them came
 * straight back on THIS turn as craft pages the gates fired — because a mature turn with an open
 * identity slot and a flagged email loads four of the seven. What P4a bought is not this number; it
 * is that the number now MOVES with the turn instead of standing still. A turn that taps no
 * craft — no history to order, no file, no burst, a filled-in profile — carries 24k less prompt for
 * the same conversation, and nothing before this could tell those two turns apart.
 *
 * P4b's split measured **0.0075** on the same fixture (1,207 characters against a 158,740-character
 * prompt, down from 167,527), and that time the mature turn kept the whole saving: it carries no
 * thread, so the nine thousand characters of thread-tagging craft that used to stand in the persona
 * on every turn are simply not there. The turn that DOES carry a thread still pays for them — and
 * that is the turn where they are about to be used.
 *
 * P4b's delegate shrink measures **0.0078** (1,207 against 153,280), and this one every turn keeps:
 * 5,460 characters the delegate tool's own doc was already saying left the persona, so nothing
 * anywhere gates them back in.
 *
 * The reply-language slot takes it back to **0.0076** (1,207 against 157,350, up from 153,280), and
 * this is the one direction the floor is allowed to move down: the work was a MECHANISM, not a size,
 * and it cost prose in five places at once — the status contract's new field, the two tool docs that
 * now refuse a language ask, law (b) and the ladder naming the Reply language line, the dates on
 * every standing rule, and §Language's third bullet. Stated plainly rather than hidden in a wider
 * band: the phase spent 4,070 characters of scaffolding to stop a stale rule outliving its reversal
 * in the four lanes that never see the reversal, and the floor is re-measured under it rather than
 * left a phase behind.
 *
 * The Never-Send-a-Leaf rewrite takes it to **0.0088** (1,207 characters against 136,555, up from
 * 157,350) — twelve four-decimal points, the largest move this floor has recorded, and it went both
 * directions to get there. The halves are worth naming apart, because they are two different kinds
 * of work.
 *
 * DOWN first. The shared persona block spent 7,174 characters on this surface and the drift anchor
 * 27 more, which took the floor to 0.0073 — the largest single FALL here. What that bought is the
 * thing no size on this surface can show: the same 7,172 bytes are what the Composer relay and both
 * Fallfirm voices read too, where the personality used to be four thinner and quietly divergent
 * descriptions. Three surfaces gained a whole person; this one paid for it. Beside that, the
 * envelope's tenth field (`hook_kind` — 167 characters of contract, 47 of anchor) and the affect
 * compiler (−937 of weather and −77 of contract) are fifth-decimal moves, and the compiler is
 * the honest illustration of the exchange rate: a thousand characters of prose deleted bought one
 * four-decimal point, because what it bought was a block that INSTRUCTS instead of describing, not
 * size. The hook wiring bought nothing here at all and that is its own result — the fixture this
 * floor is measured on is a TASK turn, the one shape the whole phase adds nothing to (no hooks
 * section, no `Turn: idle` clause, the same drift anchor), so a floor that holds while two idle
 * fixtures grow is the closest thing to a measurement of the feature's central claim. The idle
 * fixtures are not candidates for this floor: the share of a prompt a THREE-CHARACTER message
 * occupies is not a reading about anything.
 *
 * UP after, and much further. The prose commit gave back 23,926 characters of Context.md and 3,151
 * of craft/onboarding.md — the one rewritten page a mature TASK turn loads, craft/threading.md
 * needing a thread on the turn and craft/hooks.md an idle one — and that accounting closed to the
 * character: 163,751 − 136,674 = 27,077 = 23,926 + 3,151. Read the two commits as the one trade the
 * personality rebuild was for: the block spent 7,174 on this surface and the prose commit gave back
 * 23,926, because the character it states is now said ONCE for four surfaces instead of four times
 * for one each. The lane-prose commit took another 119 off the same fixture (136,674 → 136,555) and
 * the fix commit after it moved this fixture not at all, neither of them touching the fourth decimal
 * place, and most of what they rewrote is invisible from here on purpose: the Composer relay and
 * both Fallfirm voices have no budget table, and their Context.md files are not in Convo's prompt at
 * all.
 *
 * DOWN one fourth-decimal point after the supervisor corrections, which is the smallest move this
 * line can record: +438 characters of Context.md on this fixture (136,555 → 136,993) — the restored
 * ABSOLUTE RULE blockquote, less one repeated clause in the confidence section — took the share from
 * 0.0088 to 0.0087. The envelope contract standing at the primacy edge as well as the recency one
 * costs the transcript that point, and it is worth it.
 *
 * So the floor stood at 0.0087 after those corrections, and the persona is still what stands between
 * this number and anything better — it is 84k of what the model reads now rather than 108k.
 *
 * The earned material was the thing this line said would move it next, and the final re-measure is
 * where that prediction is SETTLED rather than carried forward one more phase: it did not move it,
 * and it could not have. This floor is measured on the mature fixture, which is a TASK turn — no
 * hooks section, no moment lead, the same drift anchor — and the one part of the earned material
 * that reaches a task turn is the thesis, which is DATA. A floor pinned on a person-shaped string
 * would be a reading about one fixture's thesis rather than about the scaffolding around the
 * conversation, so that fixture deliberately carries none and the measurement is the same 1,207
 * characters against 136,993 it was. The arithmetic says the same thing about the LIVE turn the
 * wiring bought: the thread-offer fixture's thesis is 373 characters, and 373 more scaffolding takes
 * this share from 0.008733 to 0.008710 — the same 0.0087 the receipt reports at the four decimal
 * places it keeps. What moves this line next is the persona, as it has been since P1.
 *
 * UP one fourth-decimal point again in the second supervisor-corrections commit, and it is the
 * cheapest rise this line has recorded: 374 characters came off this fixture — 326 of Context.md, 37
 * of craft (the reminders page), 11 of the identity card's tenure line — and took the share from
 * 0.0087 to 0.0088. Nothing was bought to spend it, which is what makes it cheap: the rule the
 * whole-branch review settled is that a task turn answers and stops, so what left the prompt is
 * prose describing a beat she no longer sends.
 *
 * This receipt also CORRECTS a number two paragraphs up. The fixture was last recorded at 136,993
 * characters and had in fact measured 136,942 since the fix wave, which gated the climate span on an
 * OPEN hook kind (persona/climate.ts HOOK_NAMING) and so stopped rendering it on a task turn — 51
 * characters that never moved the fourth decimal place and were therefore never re-measured here.
 * The honest figure now is 1,207 characters of transcript against 136,568, and both halves of that
 * gap are recorded on this line rather than one of them.
 *
 * So the floor stands at 0.0088, and the persona is still what stands between this number and
 * anything better.
 *
 * UNMOVED by the third supervisor-corrections commit, and recorded anyway — which is the lesson of
 * the correction above, where 51 characters went unrecorded precisely because they were too small to
 * move the fourth decimal place. 140 characters came off this fixture (67 of Context.md, 73 of
 * craft/send-order.md, both of them the last copies of the passing-mention beat), taking it from
 * 136,568 to 136,428 and the share from 0.008838 to 0.008847. That is still 0.0088 at the four
 * decimal places this line keeps, so the constant below is untouched and both halves of the reading
 * — 1,207 characters of transcript against 136,428 — are written down here rather than inferred.
 *
 * UNMOVED again by the fourth supervisor-corrections commit, on the same terms: 73 characters came
 * off this fixture (55 of craft/send-order.md, 18 of the JSON anchor — the last two copies of the
 * passing-mention beat anywhere in the prompt), taking it from 136,428 to 136,355 and the share from
 * 0.008847 to 0.008852. Still 0.0088 at four decimal places, so the constant stands, and the reading
 * behind it is 1,207 characters of transcript against 136,355.
 *
 * Then DOWN to 0.0087 for the own-wording paragraph — the first move this line has recorded in the
 * wrong direction, and bought on purpose: +642 characters in the shared persona block (policy.ts,
 * the persona ceiling above records the paragraph), which is prose every lane renders and the one
 * place a rule about her own wording can be stated once. The mature fixture measures 137,097 with
 * the same 1,207 characters of transcript, and the traced share reads 0.0087 at the four decimal
 * places this line keeps, so the floor follows it down rather than standing a hair above the reading
 * it is meant to sit under. Nothing else in the prompt moved.
 *
 * Then DOWN to 0.0086 for the share paragraph, which is the same purchase made a second time and on
 * the same terms: +776 characters in the shared persona block (policy.ts, and the persona ceiling
 * above itemises them), the third turn shape stated where all four surfaces read it rather than only
 * where the craft page that teaches it in full renders. The reading is 1,207 characters of
 * transcript against 138,752 of system prompt — 0.008624, and 0.0086 at the four decimal places this
 * line keeps — so the floor follows the share down rather than standing a hair above it.
 *
 * That reading also CORRECTS the fixture figure one paragraph up, for the reason the earlier
 * correction on this line records: a move too small for the fourth decimal place is a move nothing
 * re-measures. The honest sequence is 137,097 recorded, 137,976 measured immediately before this
 * commit, 138,752 after it. Of that gap, 174 characters are this branch's own and are visible from
 * here because the status contract renders on every turn, this task one included: the envelope
 * learned a fourth move and two field descriptions were rewritten for it (persona/status.ts). The
 * rest of the gap predates the branch. The craft page the commit before this one added is in
 * neither figure and could not be — it renders on the turn it governs, and this fixture is a task
 * turn, which is the same reason the hooks section has never appeared in this measurement either.
 *
 * Then DOWN to 0.0071 for the engine-actions branch, the same purchase on the same terms: a
 * delegated ask can now carry the half of itself that asks the engine to DO something, and a
 * mid-run addition can too, so `delegate_to_ops` gained one argument and three sharpened
 * descriptions and `steer_research` gained the matching one (tool_docs above itemises both). Tool
 * descriptions render twice under toolsViaJson — once in the tool docs, once in the envelope's flat
 * args union — so the section's +1,604 is roughly double that against the whole prompt. The reading
 * is 1,207 characters of transcript against 167,817 of system prompt, which the trace divides by
 * the two together: 0.007141, and 0.0071 at the four decimal places this line keeps. The floor
 * follows the share down rather than standing a hair above the reading it is meant to sit under.
 *
 * Then DOWN to 0.0070 for the Task 17 (action-honesty) re-measure. The mature fixture's system
 * prompt now measures 170,281 characters against the same 1,207-character transcript — 0.007038,
 * and 0.0070 at the four decimal places this line keeps. Most of the +2,464 is `tool_docs`:
 * UPDATE_AUTOMATION_TOOL joined TOOLS_1TO1 in this same task (that line above has the full
 * accounting), and the id-addressed rewrite of CANCEL_AUTOMATION_TOOL, CANCEL_RESEARCH_TOOL and
 * STEER_RESEARCH_TOOL — already live on this branch before this task reached it — had never been
 * charged against this line until now. The rest is `persona`'s own +40 (Context.md's two new data
 * tags, see that line above). The floor follows the share down rather than standing a hair above
 * the reading it is meant to sit under.
 *
 * Then DOWN to 0.0069 for the curious-while-newly-acquainted change: the onboarding craft page
 * (craft/onboarding.md) now asks her to ask about someone she barely knows noticeably more than
 * usual, and the mature fixture's discovery state still loads that page, so its added paragraph is
 * charged here. Same terms as above: the floor follows the share down.
 *
 * Then DOWN to 0.0065 for the bubbly voice bank: Context.md and craft/hooks.md gained a large,
 * deliberately varied set of joke, reaction, mood, question and rant examples so the voice does not
 * overfit to a handful of lines. Same terms: the floor follows the share down.
 *
 * Then DOWN to 0.0064: the same bank's questions now carry their `?` (a few split into two bubbles),
 * and the bubble law says a question keeps it. Same terms.
 *
 * Then DOWN to 0.0063: Context.md gained a stretched-word bank (the shapes, a set of in-the-moment
 * examples, and the four ways a stretch goes wrong) so elongation shows up often and looks right.
 *
 * Then DOWN to 0.0062: craft/onboarding.md (loaded by the mature fixture's discovery state) gained
 * the first principles of why people answer cheap questions and shrug at open ones, with examples.
 * Then DOWN to 0.006 (2026-09-25, the autonomy round): the persona block took on the mood tiers, the
 * take law and earned praise, and the status contract gained the `turned_down` row.
 */
export const MIN_TRANSCRIPT_SHARE = 0.006;

/**
 * Phrases that must exist in the persona, verbatim — the rules whose deletion would be silent.
 *
 * Every one of these was ADDED to Context.md deliberately (see the commits behind "Predict, don't
 * interview", the banter frame and the three-check gate), and every one of them is a behaviour the
 * live thread depends on. Prose has no test, so a rewrite that drops a clause looks like a tidy-up in
 * review. These strings are that test: promptPolicy.test.ts checks each one against
 * `convoPersonaWithCraft()` — the whole corpus, see the note below — and names the id that went
 * missing.
 *
 * A phrase here is an ANCHOR, not a quotation of the whole rule: the shortest fragment that could
 * only come from that clause. Rewording the paragraph around it is fine and expected; losing the
 * anchor means the rule itself is gone, or has been paraphrased into something that no longer says
 * the same thing. If you meant to change it, change it here in the same commit.
 *
 * Scanned against the whole CORPUS — the shared persona block, Context.md and every craft page
 * (personaModules.ts convoPersonaWithCraft) — rather than the core file alone: P4a moved seven
 * sections out into pages, and a rule that lands in one of them is still a rule she reads. Two KINDS
 * of row now prove that widening was worth having: `response_overrules` moved to craft/hooks.md in
 * the prose commit, and the eight manifesto rows below live in the shared block rather than in any
 * lane's file.
 *
 * What the corpus does NOT include is the two static bookends after `</prompt>` — the drift anchor
 * and the JSON contract are rendered by the assembler, not concatenated here. So a law the drift
 * anchor restates at the recency edge is anchored on the copy that lives in the corpus, which is the
 * one an editor can delete by accident. `flat_task_answer` is the case: the anchor's task bullet reads
 * "This is a task turn: answer it flat, with the real numbers, and nothing else." and this row points
 * at the sentence in the shared block that bullet is a retelling of.
 */
export const RULE_ANCHORS: Array<{ id: string; personaAnchor: string }> = [
  // Guess before you ask — the default for every open turn (Context.md, "Connect the dots").
  { id: 'predict_dont_interview', personaAnchor: "Predict, don't interview — a guess from your model of them is how knowing them shows." },
  // …and when something genuinely must be resolved, it still lands as a statement.
  { id: 'probe_as_statement', personaAnchor: "The probe wears a statement's clothes." },
  // The three-check gate every remembered thing passes before it reaches a bubble.
  { id: 'three_check_gate', personaAnchor: 'The gate — run three checks before any memory enters a bubble' },
  // The play frame: a tease carries the real layer AND the play layer.
  { id: 'banter_play_frame', personaAnchor: 'Banter — the play frame.' },
  // The four safe bends, which is what keeps teasing off their wound.
  { id: 'four_safe_bends', personaAnchor: 'Four bends that stay safe' },
  // Their read of the joke outranks hers, immediately. The clause left Context.md in the prose commit
  // and now lives ONCE, in craft/hooks.md, where the beat it governs is taught — which is why this
  // list is scanned over the corpus and not over the core file.
  { id: 'response_overrules', personaAnchor: 'Their response overrules your framing, instantly.' },
  // Rich memory plus "hey" is still one line back — a greeting, or the turn's one hook. Re-pinned in
  // the prose commit: the old anchor ("A greeting gets a greeting.") stated the law as a ban on
  // saying anything, and the hook engine makes it a choice between two shapes.
  { id: 'greeting_gets_greeting', personaAnchor: 'A greeting gets a greeting, or a hook — never an inventory.' },
  // The threading default, stated as a default rather than a fallback.
  { id: 'when_unsure_dont', personaAnchor: "When unsure, don't" },
  // Anti-sycophancy, and Context.md's ONLY statement of it. It used to be the tail of the
  // `epistemic_trigger` bullet in the envelope's field list, so P1's deletion of that list would have
  // taken a behaviour rule with it; it was kept as its own sentence in the inner-weather section and
  // anchored here so the next rewrite of that paragraph cannot lose it quietly.
  { id: 'concede_to_information', personaAnchor: 'you concede to information, never to insistence' },
  // ── the manifesto, from the shared persona block (persona/policy.ts PERSONA_POLICY) ───────────
  // Eight laws that arrived with the character rather than with a lane, so all four prompt surfaces
  // state them in the same bytes. They are anchored HERE because Convo's corpus is the one surface
  // with a phrase test at all — losing them from the block loses them everywhere at once.
  //
  // The task law: a turn that asks for something real gets the answer and nothing stapled to it.
  { id: 'flat_task_answer', personaAnchor: 'You answer it flat, with the real numbers,' },
  // The three moves that resolve a tension in their favour and signal fear.
  { id: 'never_defend', personaAnchor: 'You do not defend: when they poke at you, you flip it or you let it stand' },
  { id: 'never_wink', personaAnchor: 'You do not wink: announcing that a line was a joke ends the joke' },
  { id: 'never_suck_up', personaAnchor: 'You do not suck up: no pet names you were not asked for' },
  // A thinking sound goes out alone in its own bubble, picked by what is going on in her.
  { id: 'thinking_sound_bubble', personaAnchor: 'A sound before words gets a bubble of its own.' },
  // Register is copied, content never is — the leaf reply this whole branch is named after.
  { id: 'mirror_register_not_content', personaAnchor: 'Mirroring: match their register and never their content.' },
  // Tricks get refused, tasks never do.
  { id: 'toy_and_tool', personaAnchor: 'You refuse to be a toy and you never refuse to be a tool.' },
  // What each of the three hook kinds DOES, which is what makes one of them the right one.
  { id: 'hook_budget', personaAnchor: 'A judgment closes. A tangent opens.' },
  // The kill switch, stated in prose as well as enforced in code (persona/hooks.ts selectHook).
  { id: 'kill_switch', personaAnchor: 'you say one plain thing or nothing at all' },
];


/**
 * The four `confidence_level` bands and the reply each one buys.
 *
 * P1 deleted the two restatements of this mapping — Context.md's opening `ABSOLUTE RULE` and its
 * `FINAL REMINDER` — which left it stated only in the JSON anchor. That is one home, and the one at
 * the recency edge, but it is a code file: the persona's own confidence section then taught how to
 * SCORE at length and never said what the score BUYS, so a persona editor reading Context.md end to
 * end could not find the mapping at all. It is back in that section as one compressed sentence, and
 * the JSON anchor keeps its copy last. That is the same arrangement as the bubble law — the section
 * owns the teaching, the anchor states the operational law at the edge — and, like the bubble law,
 * two copies need a test to keep them in step.
 *
 * Each row pins what its band buys IN EACH COPY, because the two are deliberately worded for their
 * own place rather than duplicated byte for byte. Read the two columns side by side: they have to
 * describe the same reply. Reword the prose around a phrase freely; losing one means that copy now
 * promises a different reply than the other, which is the drift no other test can see.
 */
export const CONFIDENCE_BANDS: ReadonlyArray<{ band: string; personaShape: string; anchorShape: string }> = [
  { band: '0-30', personaShape: 'get the missing details', anchorShape: 'ask for the missing details' },
  { band: '30-60', personaShape: 'one short confirm', anchorShape: 'confirm with ONE short question' },
  { band: '60-80', personaShape: 'walk it through', anchorShape: 'walk it through' },
  { band: '80-100', personaShape: 'straight answer', anchorShape: 'straight answer, first bubble, no preamble' },
];

/** One counted clause: the phrase, how many times the assembled prompt carries it today, and how
 *  that total splits between the per-turn body and the two static anchors after `</prompt>`. */
export interface ClauseCount {
  id: string;
  /** Counted as a plain substring of the assembled prompt (`String.split(phrase).length - 1`). */
  phrase: string;
  /** TODAY's total. This number is the ratchet: deleting a duplicate drops the count by one, in the
   *  same commit as the deletion. */
  count: number;
  /** How many of those copies live in the behaviour/JSON anchors rather than ahead of them — i.e.
   *  how many are the recency-edge RETELLING rather than the clause's own home in the persona
   *  corpus (Context.md, or the craft page P4a moved its section to). The remainder
   *  (`count - anchorCopies`) is what the persona itself carries, so a 2/1 row is a rule plus its
   *  anchor and a 2/0 row is two copies inside the corpus. Checked rather than annotated:
   *  clauseInventory.test.ts counts both halves. */
  anchorCopies: number;
  /** Which copies make up `count`, so a later pass tightens the right one — and any copy the count
   *  CANNOT see. A clause whose text is an ENVELOPE_FIELDS description also reaches the model on the
   *  response schema every turn, which is not part of the system prompt, so only this string can say
   *  so (clauseInventory.test.ts checks that it does). */
  where: string;
}

/**
 * How many times each load-bearing clause reaches the model on one turn.
 *
 * P0 measured four of these arriving TWICE — once in the persona's own section, once in the
 * behaviour anchor at the recency edge. The second copy was a deliberate retelling of rules that
 * decay across a 146k-character prompt (charter §11.3), but a retelling can drift from its source,
 * and a rule stated twice is a rule nobody can edit. P1 collapsed those four: the anchor went to six
 * identity lines and stated no rule that had its own section, so every row below is pinned at
 * exactly ONE copy, in the one place that owns it.
 *
 * T6 re-opened the second copy, deliberately and in one place only. The drift anchor that replaced
 * the static one holds THREE identity bullets plus three MODE bullets, and the mode bullets restate
 * the task, idle and quiet laws — laws that DO have a home of their own, the shared persona block
 * (persona/policy.ts PERSONA_BLOCK). What makes that copy invisible here is that it is SEMANTIC
 * rather than literal: the block hard-wraps its paragraphs, so the bullet and the sentence it
 * restates share no exact substring, and every row below is counted by substring. No row counts the
 * copy and none can until a prose commit writes the two halves as one shared sentence — so
 * `anchorCopies` is still 0 everywhere, and still means exactly what it says: of the copies this
 * table COUNTS, how many are the recency-edge retelling.
 *
 * One rule now stands at BOTH edges on purpose, and it is the only one: the four-field JSON envelope.
 * Context.md opens on the ABSOLUTE RULE blockquote and shared.ts's `json_anchor` closes on the same
 * contract, so it is the first thing she reads and the last. That is the two-copy strategy used
 * deliberately rather than drifted into — the envelope is the one law whose failure costs the whole
 * turn rather than a beat of it, and it is Convo's own function contract, not a character rule. No
 * row below counts it either — by choice, not because it is uncountable. The two copies are written
 * for their own place (a blockquote naming the four fields and their order, an anchor that then
 * teaches each field), but unlike the mode bullets above they are NOT disjoint: one 97-character run
 * stands in both, ` ONE JSON object and nothing else: ` through the JSON example's opening
 * `{"confidence_level":85,"tool_calls":null,"bubbles":[{"text":"`, and the 32-character clause inside
 * it is the quotable half. So a row pinned on that span would be an ordinary 2 / anchorCopies 1 row —
 * a rule plus its anchor, the shape the paragraph above describes — since Context.md line 3 sits in
 * the body and `json_anchor` sits inside the `bookends` slice, which opens at the behaviour anchor.
 * The span is left unpinned because the pair is already held in step end-to-end by the goldens
 * (promptSections.test.ts's GOLDEN_JSON_ANCHOR) plus the corpus pin (personaModules.test.ts), which
 * check the whole of both copies rather than one clause inside them. Add a row here only if a later
 * pass wants a THIRD copy to fail this count too.
 *
 * Read `anchorCopies` and `where` before changing a `count`. `predict_named` in particular is 2/0
 * for a reason that is NOT duplication: both copies are in Context.md because the second one is a
 * cross-reference pointing at the section, and deleting a pointer is not a tightening.
 *
 * Counted over the whole corpus, not one turn's prompt: clauseInventory.test.ts assembles its fixture
 * with CONVO_PERSONA_MODULES off, so every craft page is present exactly once (see that file's
 * header). A page that loads on some turns and not others must not make a pinned count flicker.
 */
export const CLAUSE_INVENTORY: readonly ClauseCount[] = [
  {
    id: 'predict_clause',
    phrase: 'from your model of them',
    count: 1,
    anchorCopies: 0,
    where: "Context.md's \"Predict, don't interview\" header — P1 deleted the behaviour anchor's retelling",
  },
  {
    id: 'predict_named',
    phrase: "Predict, don't interview",
    count: 2,
    anchorCopies: 0,
    where: 'the section itself + the cross-reference to it from "Answer first" — a POINTER, not a duplicate',
  },
  {
    id: 'probe_clause',
    phrase: "probe wears a statement's clothes",
    count: 1,
    anchorCopies: 0,
    where: "its own section header in Context.md — P1 deleted the behaviour anchor's copy",
  },
  {
    id: 'four_bends_clause',
    phrase: 'Four bends that stay safe',
    count: 1,
    anchorCopies: 0,
    where: "Context.md only — P1 deleted the behaviour anchor's tease line, which had retold this one",
  },
  {
    id: 'tease_wound_clause',
    phrase: 'never their wound',
    count: 1,
    anchorCopies: 0,
    where: "the four-bends parenthetical — P1 deleted the behaviour anchor's tease line",
  },
  {
    id: 'response_overrules_clause',
    phrase: 'Their response overrules your framing, instantly.',
    count: 1,
    anchorCopies: 0,
    where: "craft/hooks.md only — it moved there in the prose commit, where the beat it governs is taught; P1 deleted the behaviour anchor's copy",
  },
  {
    id: 'three_check_gate_clause',
    phrase: 'The gate — run three checks before any memory enters a bubble',
    count: 1,
    anchorCopies: 0,
    where: 'Context.md only',
  },
  {
    // Re-pinned in the prose commit. The clause used to end at "A greeting gets a greeting." — a law
    // with one legal reply — and the hook engine gives an idle turn a second one, so the sentence now
    // names both shapes and rules out the third. Same single home, new words.
    id: 'greeting_clause',
    phrase: 'A greeting gets a greeting, or a hook — never an inventory.',
    count: 1,
    anchorCopies: 0,
    where: 'the "what you never do with what you know" list — P1 deleted the behaviour anchor\'s copy',
  },
  {
    id: 'greeting_example_wrong',
    phrase: 'WRONG, "hey" after four quiet days, you inventoried their life:',
    count: 1,
    anchorCopies: 0,
    where: 'the WRONG half of the greeting demo pair',
  },
  {
    // Re-pinned with the clause above: the demo's RIGHT half now shows a greeting plus one HOOK
    // ("four days. the reno still standing?") rather than a light callback, because that is the beat
    // the engine actually clears on an idle turn.
    id: 'greeting_example_right',
    phrase: 'RIGHT, a greeting, one hook max:',
    count: 1,
    anchorCopies: 0,
    where: 'the RIGHT half of the greeting demo pair',
  },
  {
    // The one clause P1 found actually CONTRADICTING itself rather than merely repeating: the schema
    // ranked a pending thing over a theme and never mentioned a resolution, Context.md ranked a
    // resolution over a theme and never mentioned a loop. The full order is now stated once.
    id: 'thread_note_precedence',
    phrase: 'a resolution outranks a pending loop',
    count: 1,
    anchorCopies: 0,
    where: "the status contract's thread_note bullet — and, off-prompt, the response schema built from the same description (ENVELOPE_FIELDS, persona/status.ts); the persona's half-rule is gone",
  },
  {
    // The capture rule with no other home. P1 deleted Context.md's `thread_note` bullet as a duplicate
    // of the schema, but this clause was in the persona ONLY — and the nearest surviving line pushes
    // the other way ("Venting or distress → theme reads stay closed completely", about SURFACING). So
    // its deletion would have quietly stopped loops being minted on exactly the turns worth catching.
    // Pinned here for the same reason a RULE_ANCHORS phrase is: the next tidy-up fails out loud.
    id: 'thread_note_capture_when_heavy',
    phrase: 'Catch a loop even on a venting or overwhelmed turn',
    count: 1,
    anchorCopies: 0,
    where: "the status contract's thread_note bullet — and, off-prompt, the response schema built from the same description (ENVELOPE_FIELDS, persona/status.ts)",
  },
];
