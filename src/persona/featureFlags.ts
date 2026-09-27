// The switches the persona engines ship, in one leaf.
//
// They live together, and away from the engines they gate, for one reason: every engine here is a
// pure module that a test imports for the price of a string (persona/hooks.ts, persona/moments.ts,
// memory/thesisEngine.ts), and a flag parsed inside one of them makes the OTHER engines' callers
// import it to ask a yes/no question. So the question lives in a file that imports nothing at all,
// and the engines stay about their own arithmetic. Same reason policy.ts next door is a leaf.
//
// WHAT THEY DO NOT DO: none of these rolls the CHARACTER back. She is the persona block and the lane
// files now, and a prompt is not a runtime switch — flipping every flag here off leaves the same
// person answering, with less machinery around her. Rolling the character back is a branch revert,
// and the plan says so under Verification rather than leaving an operator to discover it at 3am.
//
// House shape, four lines each, read at CALL time (turnFocus.ts's `turnFocusBlockEnabled` is the
// template): unset or empty is ON, and only `true | 1 | on | yes` keep it on after that — so garbage
// is OFF, and a flip needs no restart. Each one is a row in scripts/flagDocs.test.ts, which reads
// its default out of the parser below and fails unless deploy/app.env and .env.example both say the
// same word beside the same var.
//
// A switch that is still landing keeps the same four lines with the empty default inverted, so every
// intermediate build is inert and the last commit of the series is the only one that changes a reply
// (memory/provenance.ts's `provenanceEnabled` is that template). The body is what has to be
// byte-identical either way; the default is only which side of it ships today.

/**
 * The hook machinery (env: CONVO_HOOKS_ENABLED). Default ON.
 *
 * Off removes the MACHINERY, never the doctrine: no idle gate reading the turn, no `Turn:` line in
 * the turn-focus block, no selector, no `hooks` dyn section, no `craft/hooks.md` gate, no quiet
 * re-ask, and nothing written to the rhythm ledger. What survives is the persona block, which still
 * teaches the task/idle law — because that is the character, and the character has no switch.
 *
 * The off path is byte-identical to an install that never had the feature, with
 * CONVO_PERSONA_MODULES at its default. The exception is worth stating: with the module gate OFF the
 * whole craft corpus rides the cached persona head every turn, so `craft/hooks.md` is in the prompt
 * either way and this flag cannot take it out.
 */
export function hooksEnabled(): boolean {
  const v = (process.env.CONVO_HOOKS_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * Moments (env: MEMORY_MOMENTS_ENABLED). Default ON.
 *
 * Gates both ends of the store she keeps about a person that is not facts: the nightly harvest pass
 * that writes `memories/<handle>/MOMENTS.md`, and the sampling that offers one back inside the
 * `hooks` section for a callback. Off means no pass runs, nothing is written or pruned, and a file an
 * earlier install wrote is simply never read — the prompt is what it would have been without the
 * feature, and `/forget` still wipes the file either way.
 */
export function momentsEnabled(): boolean {
  const v = (process.env.MEMORY_MOMENTS_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * The thesis (env: MEMORY_THESIS_ENABLED). Default ON.
 *
 * Gates the weekly rewrite that keeps her one read on this person in `memories/<handle>/THESIS.md`,
 * and the `thesis` dyn section that hands that read to Convo. Off means the pass never runs and the
 * section never renders, so an existing file goes stale in place rather than being deleted — the one
 * asymmetry worth knowing, and the reason turning it back on costs a week rather than a restart.
 */
export function thesisEnabled(): boolean {
  const v = (process.env.MEMORY_THESIS_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * The third turn shape (env: CONVO_SHARE_TURNS_ENABLED). Default ON.
 *
 * Gates the whole share turn: the idle gate's third verdict, the share section beside the turn
 * block, its craft page, the drift anchor that reads for it, and the one follow-up question the
 * affect compiler may leave open. Off, the gate maps a share back onto a task, so a message that
 * hands her something and asks for nothing is answered flat exactly as it was before the shape
 * existed — the prompt is byte-identical, down to the bytes, which is the contract the flag exists
 * to keep and what hookWiring's off-path pin measures.
 *
 * Subordinate to CONVO_HOOKS_ENABLED: with the machinery off there is no gate to read a third
 * shape, so this switch has nothing to turn on. It shipped default OFF for the length of the series
 * that built it, so every half-built commit was inert on a live box and only one commit could ever
 * change a reply; this is that commit, and the shape behind the default is whole. The switch stays
 * because the byte-identical off path is the only way back that costs a restart rather than a
 * revert — a shape that turns out to interrogate has to be stoppable by an operator, not by a
 * deploy.
 */
export function shareTurnsEnabled(): boolean {
  const v = (process.env.CONVO_SHARE_TURNS_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * Her own self (env: MEMORY_SELF_ENABLED). Default ON.
 *
 * Gates both ends of `memories/<handle>/SELF.md`: the daily pass that writes down the stances,
 * tastes, lessons and changes of mind SHE asserted with this person (memory/selfHarvest.ts), and the
 * `self` dyn section that hands them back so she stays the same person across the window. Off means
 * no pass, no section, and an existing file goes stale in place.
 */
export function selfEnabled(): boolean {
  const v = (process.env.MEMORY_SELF_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * Her own texts (env: IRISES_MUSINGS_ENABLED). Default ON.
 *
 * Gates the sweep that lets her text first because something is on HER mind (memory/musings.ts):
 * a seed from SELF.md, a moment she keeps, or a theme of theirs, voiced by the proactive pipeline as
 * a `musing`. Its own line, apart from anything the user set up: no reminder, no cron job, no
 * watched mail rides it. On by default because the owner asked for her to start conversations
 * (scripts/configure.sh --musings off turns it off); the bounds live in the sweep (one a day at most,
 * daytime where they are, never on a quiet thread they left, never a room).
 */
export function musingsEnabled(): boolean {
  const v = (process.env.IRISES_MUSINGS_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * The familiarity mask (env: CONVO_FAMILIARITY_ENABLED). Default ON.
 *
 * Gates all four ends of how well she knows a person (persona/familiarity.ts): the post-reply pass
 * that counts the turn and slews the stored level (memory/familiarityPass.ts), the turn-time read
 * that hands the band to both compiles of a turn (agents/convo/client.ts), the musings gate that
 * keeps her own texts to people she knows (memory/musings.ts), and the Composer's read-only read
 * that masks a relayed reply the same way (agents/composerCore.ts). Off means no ledger read or
 * write, no gate, and every reply compiled with no mask at all: the per-turn prompt byte for byte
 * as it stood before the feature. The persona block's one sentence about the mask (policy.ts) is
 * prose, and prose has no switch. It shipped OFF for the length of the series that built it, so
 * every half-built commit was inert on a live box; this is the commit that finished it, and the
 * switch stays because the off path is the way back that costs a restart rather than a revert.
 */
export function familiarityEnabled(): boolean {
  const v = (process.env.CONVO_FAMILIARITY_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}
