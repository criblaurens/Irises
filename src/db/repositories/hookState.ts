// The persisted rhythm ledger: the last few kinds of extra beat a CHAT's replies carried, the idle
// streak, and the spacing clock for moment offers.
//
// Keyed by chat_id, following affect_state rather than the memory tiers — and it is the right key
// here rather than the historical outlier it is there. What a person keeps circling back to belongs
// to the PERSON; how fast she has been talking belongs to the ROOM. Three sharp replies in a group
// are three sharp replies whoever typed at her, so the fourth turn goes quiet for everyone in it,
// and a room accumulates a ledger exactly like a one-to-one chat does. The `handle` column rides
// alongside the key so the dashboard and the per-handle sweep can find whose rows these are; it is
// never read back into the state.
//
// Read doctrine is threadInventory.ts's, which is relationshipClimate.ts's: reads DEGRADE, never
// throw. A missing row, a mangled blob, a hand-edited counter — each falls back to the safest thing
// that still lets the turn proceed, which is the DEFAULT state (the one that renders nothing and
// forbids nothing). This sits on the reply path: a read failing here must cost the rhythm and
// nothing else. The safe direction is unmistakable — degrading to defaults can only ever open a
// hook back up, never force a quiet turn onto someone who never earned one.
//
// Writes carry the /forget fence (getForgetEpoch, see memory.ts). The window it closes is the TURN,
// not the dispatch: the ledger row is read at the top of convo/client.ts, before the prompt is even
// built, and written inside processConvoResult before the ChatResponse is returned — the channel
// send happens after that, out in src/index.ts. So between the read and the write sit the model
// call, the tool loop and up to two corrective re-asks, which is many seconds during which a
// /forget can land, and a save that read the pre-forget state must not put back what the wipe
// removed. The write itself is awaited (see convo/shared.ts): the fence is what makes it safe, not
// the ordering against the send.

import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { getForgetEpoch } from './memory.js';
import { defaultHookState, HOOK_RUN_LIMIT, HOOK_WORDS, type HookKind, type HookState } from '../../persona/hooks.js';

type Row = { chat_id: string; handle: string; state_json: string; updated_at: number };

// The union as a runtime set. Held here rather than exported from persona/hooks.ts for the reason
// relationshipClimate.ts holds its own VALID_KEYS: validating stored data is the STORE's job, and
// the engine stays a pure description of the shape. HOOK_WORDS itself IS imported, because the
// engine's rendered sentence is built out of that same array — two copies of the word list would
// let a kind be storable and unnameable at once.
const HOOK_KINDS: ReadonlySet<string> = new Set<string>([...HOOK_WORDS, 'none']);

function intOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt;
}

/** A stored epoch-ms stamp → a non-negative integer. Anything unreadable becomes 0, which every
 *  clock in this stack reads as "never" — and "never written" is the safe direction for a ledger
 *  whose only job is to hold something back. */
function stampOr(v: unknown, dflt = 0): number {
  return Math.max(0, intOr(v, dflt));
}

/** Counters can only be non-negative. A negative `idleSinceMoment` hand-edited into a row would
 *  hold a callback back for four turns longer than the interval it is documented to be. */
function countOr(v: unknown, dflt = 0): number {
  return Math.max(0, intOr(v, dflt));
}

/** Stored JSON → the kind window. An unreadable entry is DROPPED rather than coerced to `none`,
 *  because `none` is not a neutral filler — it is the entry that breaks a run, so inventing one
 *  would hand back a hook the kill switch had already taken away. Capped at the tail, most recent
 *  last, exactly as the engine caps it on the way in. */
function coerceKinds(raw: unknown): HookKind[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((k): k is HookKind => typeof k === 'string' && HOOK_KINDS.has(k))
    .slice(-HOOK_RUN_LIMIT);
}

/** Stored JSON → a whole state. One shape, coerced field by field: a garbled streak is still the
 *  right chat's ledger, and losing the kind window over it would cost the kill switch its memory. */
function coerceHookState(raw: unknown): HookState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultHookState();
  const s = raw as Record<string, unknown>;
  return {
    lastKinds: coerceKinds(s.lastKinds),
    idleStreak: countOr(s.idleStreak),
    idleSinceMoment: countOr(s.idleSinceMoment),
    updatedAt: stampOr(s.updatedAt),
    ...(typeof s.quizzedAt === 'number' && Number.isFinite(s.quizzedAt) ? { quizzedAt: s.quizzedAt } : {}),
  };
}

/**
 * The stored ledger for a chat — DEFAULTS for an unknown chat, a corrupt row, or a read error.
 * Never throws: this sits on the reply path, where a ledger read failing must cost the rhythm and
 * nothing else.
 */
export async function getHookState(chatId: string): Promise<HookState> {
  try {
    const r = stmt(
      'SELECT chat_id, handle, state_json, updated_at FROM hook_state WHERE chat_id = ?'
    ).get(chatId) as Row | undefined;
    if (!r) return defaultHookState();
    let raw: unknown;
    try { raw = JSON.parse(r.state_json); } catch { raw = null; }
    return coerceHookState(raw);
  } catch (error) {
    logDbError('getHookState', error);
    return defaultHookState();
  }
}

/**
 * Upsert the whole ledger. `opts.ifForgetEpoch` is the epoch the CALLER read before it started
 * working: when it no longer matches, a /forget landed mid-turn and this write would put back a
 * rhythm the user asked to be forgotten, so the save is refused. Returns whether it was written — a
 * fenced-out write must never be reported upstream as applied.
 *
 * `handle` is stored, never read back. It is the sweep key, not the identity: the identity is the
 * chat, and a group row carries whichever handle spoke last quite deliberately — any of them is
 * enough for the dashboard to find the room.
 */
export async function saveHookState(
  chatId: string,
  handle: string,
  state: HookState,
  opts?: { ifForgetEpoch?: number },
): Promise<boolean> {
  if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
    console.warn('[memory] hook state save aborted — /forget landed mid-turn');
    return false;
  }
  try {
    stmt(
      `INSERT INTO hook_state (chat_id, handle, state_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         handle = excluded.handle,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`
    ).run(
      chatId,
      handle,
      // Coerced on the way IN as well as out, so a caller that built a state by hand can never put
      // an unknown kind or a negative counter into the store for a later read to trust.
      JSON.stringify(coerceHookState(state)),
      // The ROW's write time (wall clock), which is what a dashboard sorts by — not the engine's
      // injected `updatedAt`, which stays inside the blob where the pure engine put it.
      Date.now(),
    );
    return true;
  } catch (error) {
    logDbError('saveHookState', error);
    return false;
  }
}

/** Drop the row, so the next read returns defaults. The /forget and test seam — by PRIMARY KEY,
 *  because the chat id is what /forget has in scope on the convo path. */
export async function clearHookState(chatId: string): Promise<void> {
  try {
    stmt('DELETE FROM hook_state WHERE chat_id = ?').run(chatId);
  } catch (error) {
    logDbError('clearHookState', error);
  }
}

/** Every row a handle is responsible for, dropped in one sweep. The dashboard's seam: a person who
 *  asks to be forgotten from a surface that knows their handle and not their chat ids still has
 *  their rhythm wiped, in every room the handle reached. */
export async function clearHookStateForHandle(handle: string): Promise<void> {
  try {
    stmt('DELETE FROM hook_state WHERE handle = ?').run(handle);
  } catch (error) {
    logDbError('clearHookStateForHandle', error);
  }
}
