// The machine-data store: one SQLite database (node:sqlite — no dependency)
// holding everything relational: conversations, profiles, prefs, the short
// memory tier, the cold archive under all of them, reply-threading indexes,
// the token ledger, the error log, and diagnostics. The curated medium/long
// tiers live as markdown files instead (files.ts + the memoryMedium/memoryLong
// repositories).
//
// Exactly ONE DatabaseSync per process: a second ':memory:' open would be a
// fresh empty database, and a second file handle a needless writer. Opened
// lazily on first use so merely importing src/db/* (tsc, pure-function tests)
// never creates the state dir.

import { DatabaseSync, StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { dbPath, irisesHome, ensureDir } from './stateDir.js';
import os from 'node:os';

function isUnderTmp(p: string): boolean {
  const real = (x: string) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const rel = path.relative(real(os.tmpdir()), real(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Bump only for changes CREATE IF NOT EXISTS cannot express (column changes,
// index rewrites); branch on the old version before setting the new one.
const SCHEMA_VERSION = 1;

// All timestamps are INTEGER epoch ms, app clock (user_profiles keeps its epoch-
// SECONDS quirk at the repository boundary). JSONB columns become *_json TEXT
// with JSON.parse/stringify at the repository boundary. "trigger" is a SQLite
// keyword — quoted everywhere.
const DDL = `
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  handle     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_profiles (
  handle     TEXT PRIMARY KEY,
  name       TEXT,
  facts_json TEXT NOT NULL DEFAULT '[]',
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_seen ON user_profiles(last_seen DESC);

CREATE TABLE IF NOT EXISTS agent_prefs (
  handle     TEXT PRIMARY KEY,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- Per-chat affect memory: the last hidden status (mood/gauges/meta-prompt) plus a short mood
-- trail, so mood has continuity turn-to-turn. Never user-visible; strengthens the model's logic.
CREATE TABLE IF NOT EXISTS affect_state (
  chat_id           TEXT PRIMARY KEY,
  status_json       TEXT NOT NULL DEFAULT '{}',
  mood_history_json TEXT NOT NULL DEFAULT '[]',
  updated_at        INTEGER NOT NULL
);

-- Relationship climate: weeks-scale standing register, the slow counterpart to affect_state's
-- per-turn weather. Keyed by the MEMORY handle (group-aware pseudo-handle), not chat_id —
-- affect_state's chat keying is the historical outlier, not the pattern.
CREATE TABLE IF NOT EXISTS relationship_climate (
  handle       TEXT PRIMARY KEY,
  dials_json   TEXT    NOT NULL DEFAULT '{}',
  moves_json   TEXT    NOT NULL DEFAULT '[]',
  last_eval_at INTEGER NOT NULL DEFAULT 0,
  eval_count   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

-- Familiarity: how well she knows this person, as one stored 1-100 level plus the two lived-exchange
-- counters it is partly made of. Keyed by the MEMORY handle, like relationship_climate. The level is
-- arithmetic over the stores (persona/familiarity.ts) written by the post-reply pass
-- (memory/familiarityPass.ts), and it never reaches a prompt: the turn reads it as a band. A handle
-- with no row reads as a stranger, and a room never gets a row.
CREATE TABLE IF NOT EXISTS familiarity (
  handle      TEXT PRIMARY KEY,
  level       INTEGER NOT NULL DEFAULT 1,
  turns       INTEGER NOT NULL DEFAULT 0,
  active_days INTEGER NOT NULL DEFAULT 0,
  last_day    TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

-- Conversational threading: what recurs in a person's life (themes — values, tensions, goals, the
-- phrases they coin) and what they left hanging (loops — a pending outcome with a how-did-it-go
-- attached), plus the offer ledger that bills every time one of them is surfaced.
--
-- Keyed by the MEMORY handle, like relationship_climate and every other memory tier above it. What
-- someone keeps circling back to is a property of the PERSON, not of a chat window, and a group's
-- shared identity gets its own row for free under the same key. (affect_state's chat keying is the
-- historical outlier — do not copy it here.)
--
-- Nothing in this table costs an LLM call to fill. Capture piggybacks the hidden status envelope
-- the convo model already emits on every reply, and selection is pure code reading this one row
-- before the turn. So the inventory only ever grows on turns that were already paid for, and an
-- empty table is the honest resting state — a handle with no row reads back as the default
-- inventory, which renders nothing at all.
CREATE TABLE IF NOT EXISTS thread_inventory (
  handle            TEXT PRIMARY KEY,
  themes_json       TEXT    NOT NULL DEFAULT '[]',
  loops_json        TEXT    NOT NULL DEFAULT '[]',
  offers_json       TEXT    NOT NULL DEFAULT '[]',
  pending_json      TEXT    NOT NULL DEFAULT 'null',
  turns_since_offer INTEGER NOT NULL DEFAULT 0,
  last_harvest_at   INTEGER NOT NULL DEFAULT 0,
  harvest_count     INTEGER NOT NULL DEFAULT 0,
  last_ping_at      INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

-- The rhythm ledger: the last few extra beats a chat's replies carried, the idle streak, and the
-- spacing clock for moment offers. Four small numbers read before every turn and written after
-- every turn, which is why they ride as one json blob rather than four columns.
--
-- Keyed by CHAT, following affect_state rather than the memory tiers beside it, and deliberately:
-- rhythm is a property of the ROOM. Three sharp replies in a group are three sharp replies whoever
-- typed at her, and the fourth turn goes quiet for everyone in it. The handle column is carried
-- alongside (not as the key) purely so the dashboard and a per-person sweep can find the rows a
-- handle is responsible for.
--
-- Costs no LLM call to fill: the kind comes from the hidden status envelope the convo model already
-- emits, everything else is arithmetic. A chat with no row reads back as the default state, which
-- renders nothing at all.
CREATE TABLE IF NOT EXISTS hook_state (
  chat_id    TEXT PRIMARY KEY,
  handle     TEXT NOT NULL DEFAULT '',
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sent_messages (
  message_id    TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  content       TEXT NOT NULL,
  reply_root_id TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sent_messages_chat ON sent_messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sent_messages_reply_root
  ON sent_messages(chat_id, reply_root_id) WHERE reply_root_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sent_messages_created ON sent_messages(created_at);

-- Bubbles Irises took back (state/unsend.ts). The newest row per chat is the unsend cooldown.
CREATE TABLE IF NOT EXISTS unsent_messages (
  message_id TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  why        TEXT NOT NULL,
  unsent_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unsent_messages_chat ON unsent_messages(chat_id, unsent_at DESC);

CREATE TABLE IF NOT EXISTS inbound_messages (
  message_id    TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  sender_handle TEXT,
  content       TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_chat ON inbound_messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_created ON inbound_messages(created_at);

CREATE TABLE IF NOT EXISTS memory_short (
  id           TEXT PRIMARY KEY,
  agent_handle TEXT NOT NULL,
  chat_id      TEXT,
  kind         TEXT NOT NULL,
  request      TEXT,
  content      TEXT NOT NULL,
  meta_json    TEXT NOT NULL DEFAULT '{}',
  task_id      TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_short_handle ON memory_short(agent_handle, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_short_expiry ON memory_short(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_short_task
  ON memory_short(agent_handle, kind, task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS proactive_deliveries (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}', dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  deliver_after INTEGER, created_at INTEGER NOT NULL, delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proactive_dedupe ON proactive_deliveries(dedupe_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proactive_due ON proactive_deliveries(status, deliver_after) WHERE status = 'pending';

-- Inbound claims for the bridge door: one row per (platform, chat_id, message_id) already turned
-- into a turn, so a plugin retrying a forward whose 202 never landed is answered instead of
-- re-asked. Deliberately NOT folded into inbound_messages: that table's ON CONFLICT DO UPDATE is
-- load-bearing for reply resolution and has to stay an upsert, which is the exact opposite of a
-- claim. Ephemeral (24h), pruned on write.
CREATE TABLE IF NOT EXISTS bridge_inbound_seen (
  seen_key TEXT PRIMARY KEY, chat_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_inbound_seen_created ON bridge_inbound_seen(created_at);

-- One row per background ops run. The registry that decides "is research running right now?" is a
-- process-local map by design (state/opsCoordination.ts) — it dies with the VM, which is correct,
-- because a crashed run never resumes. But then nothing can say afterwards that a run was CUT OFF,
-- and the user is left holding a "give me a minute" that never lands. This row is that memory, and
-- only that: it is NOT a queue. Nothing re-runs off it — a stranded row is marked 'lost' and owned
-- up to once, in her voice, because re-running a leg costs real money and can repeat a side effect.
-- 'pending_approval' is the other end of the same table: an action parked waiting for the user's yes.
CREATE TABLE IF NOT EXISTS ops_tasks (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, kind TEXT NOT NULL, request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('pending_approval','running','retrying','delivered','failed','cancelled','lost','declined','expired')),
  started_at INTEGER NOT NULL, leg_started_at INTEGER NOT NULL, budget_ms INTEGER,
  retry_of TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL, settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ops_tasks_live ON ops_tasks(status, leg_started_at)
  WHERE status IN ('running','retrying');
CREATE INDEX IF NOT EXISTS idx_ops_tasks_chat ON ops_tasks(chat_id, started_at DESC);

-- Cold storage under every tier: rows retired anywhere upstream (a superseded medium entry,
-- an expired short row, a pruned message, an evicted profile fact) land here so "search your
-- own past" has something to read. The source column is deliberately CHECK-less — the repo owns
-- the union (memoryArchive.ts ARCHIVE_SOURCES), and a CHECK would need a schema bump to add
-- a feed. Searched via memory_archive_fts (FTS5 when the build has it, LIKE otherwise).
CREATE TABLE IF NOT EXISTS memory_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_handle TEXT,
  chat_id TEXT,
  source TEXT NOT NULL,
  kind TEXT,
  request TEXT,
  content TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  archived_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_archive_handle ON memory_archive(agent_handle, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_archive_chat ON memory_archive(chat_id, archived_at DESC);

-- Semantic recall's companion vectors. A SEPARATE table, not a column: the archive's DDL is
-- CREATE IF NOT EXISTS and a new column would be this schema's first real migration.
-- ON DELETE CASCADE is live (PRAGMA foreign_keys=ON above) and is the forget-leak guard —
-- a vector that outlived its archive row is a forgotten memory still semantically reachable.
CREATE TABLE IF NOT EXISTS memory_archive_embeddings (
  archive_id INTEGER PRIMARY KEY REFERENCES memory_archive(id) ON DELETE CASCADE,
  vector     BLOB    NOT NULL,   -- float32, L2-normalized (cosine == dot product)
  dims       INTEGER NOT NULL,
  model      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_archive_emb_model ON memory_archive_embeddings(model);

CREATE TABLE IF NOT EXISTS forget_epochs (
  agent_handle TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT,
  chat_id TEXT,
  task_id TEXT,
  role TEXT NOT NULL,
  label TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER GENERATED ALWAYS AS
    (input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) STORED,
  latency_ms INTEGER,
  fallback_from TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  stop_reason TEXT,
  max_tokens_sent INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_handle  ON token_usage(handle, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_chat    ON token_usage(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_task    ON token_usage(task_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_truncated ON token_usage(created_at DESC) WHERE truncated;

CREATE TABLE IF NOT EXISTS diagnostic_turns (
  key        TEXT PRIMARY KEY,
  chat_id    TEXT,
  handle     TEXT,
  source     TEXT,
  "trigger"  TEXT,
  started_at INTEGER,
  last_at    INTEGER NOT NULL,
  turn_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diagnostic_turns_handle ON diagnostic_turns(handle, last_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnostic_turns_last   ON diagnostic_turns(last_at DESC);

CREATE TABLE IF NOT EXISTS diagnostic_turn_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  chat_id TEXT,
  handle TEXT,
  source TEXT NOT NULL,
  "trigger" TEXT,
  agents_json TEXT NOT NULL DEFAULT '[]',
  event_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  turn_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (key, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_dth_key_last    ON diagnostic_turn_history(key, last_at DESC);
CREATE INDEX IF NOT EXISTS idx_dth_handle_last ON diagnostic_turn_history(handle, last_at DESC);
CREATE INDEX IF NOT EXISTS idx_dth_last        ON diagnostic_turn_history(last_at DESC);

CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL DEFAULT 'error',
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT,
  chat_id TEXT,
  handle TEXT,
  task_id TEXT,
  fingerprint TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_errlog_created     ON error_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errlog_source      ON error_log(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errlog_category    ON error_log(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errlog_severity    ON error_log(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errlog_fingerprint ON error_log(fingerprint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errlog_handle      ON error_log(handle, created_at DESC);
`;

// The archive's full-text index is OPTIONAL: fts5 is a compile-time SQLite option and
// node:sqlite ships whatever the bundled amalgamation was built with. Created (with its
// sync triggers) on a best-effort basis after the base DDL; when it fails the archive still
// works and searchArchive degrades to a LIKE scan. Archive rows are immutable, so INSERT +
// DELETE triggers are the whole contract — there is no UPDATE path to mirror.
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_archive_fts
  USING fts5(content, request, content='memory_archive', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS memory_archive_fts_ai AFTER INSERT ON memory_archive BEGIN
  INSERT INTO memory_archive_fts(rowid, content, request) VALUES (new.id, new.content, new.request);
END;
CREATE TRIGGER IF NOT EXISTS memory_archive_fts_ad AFTER DELETE ON memory_archive BEGIN
  INSERT INTO memory_archive_fts(memory_archive_fts, rowid, content, request)
    VALUES ('delete', old.id, old.content, old.request);
END;
`;

let db: DatabaseSync | null = null;
let fts = false;
const stmts = new Map<string, StatementSync>();

/** True when memory_archive_fts exists on this connection (fts5 compiled in). */
export function ftsAvailable(): boolean {
  getDb();
  return fts;
}

/** The process-wide database, opened and bootstrapped on first use. */
export function getDb(): DatabaseSync {
  if (db) return db;
  const p = dbPath();
  if (p !== ':memory:') ensureDir(irisesHome());
  // Named at open, and flagged when new: a wrong IRISES_HOME otherwise boots a fresh, empty store
  // with nothing to say her memory is simply somewhere else.
  if (p !== ':memory:') console.log(`[db] store: ${p}${fs.existsSync(p) ? '' : ' (created — new, empty)'}`);
  const opened = new DatabaseSync(p);
  try {
    if (p !== ':memory:') opened.exec('PRAGMA journal_mode=WAL');
    opened.exec('PRAGMA busy_timeout=5000');
    opened.exec('PRAGMA synchronous=NORMAL');
    opened.exec('PRAGMA foreign_keys=ON');
    const v = (opened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (v > SCHEMA_VERSION) {
      throw new Error(`[db] ${p} has schema v${v}, newer than this build (v${SCHEMA_VERSION}) — refusing to open`);
    }
    opened.exec(DDL);
    try {
      opened.exec(FTS_DDL);
      fts = true;
    } catch (error) {
      fts = false;
      // A file written by an FTS-capable build carries the triggers; without the virtual table
      // they make every archive INSERT fail. Dropping them keeps the archive writable here.
      try { opened.exec('DROP TRIGGER IF EXISTS memory_archive_fts_ai; DROP TRIGGER IF EXISTS memory_archive_fts_ad;'); } catch { /* nothing to drop */ }
      console.warn('[db] fts5 unavailable — archive search falls back to LIKE scans', error);
    }
    if (v < SCHEMA_VERSION) opened.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } catch (err) {
    try { opened.close(); } catch { /* already broken */ }
    throw err;
  }
  db = opened;
  return db;
}

/** Prepared-statement cache keyed by SQL. Statements die with the connection. */
export function stmt(sql: string): StatementSync {
  let s = stmts.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmts.set(sql, s);
  }
  return s;
}

/** Shutdown/test seam: close the handle so the next getDb() reopens fresh. */
export function closeDb(): void {
  stmts.clear();
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
}

/**
 * Test seam: drop every row (schema stays) and wipe the per-handle memory files.
 * Replaces the old `mem.<table>.clear()` pattern from the deleted Map store.
 */
export function resetStorageForTests(): void {
  // A test file run outside `npm test` (a bare `tsx --test <file>`) never gets the runner's
  // DATA_BACKEND=memory, lands on the real store, and this wipes the person's whole history and
  // memories. Only an ephemeral store may be reset: the memory driver, or a home under the OS temp dir.
  if (dbPath() !== ':memory:' && !isUnderTmp(irisesHome())) {
    throw new Error(`resetStorageForTests refused to wipe ${irisesHome()} — run tests through npm test (DATA_BACKEND=memory)`);
  }
  const d = getDb();
  d.exec(`
    DELETE FROM messages;
    DELETE FROM user_profiles;
    DELETE FROM agent_prefs;
    DELETE FROM affect_state;
    DELETE FROM relationship_climate;
    DELETE FROM familiarity;
    DELETE FROM thread_inventory;
    DELETE FROM hook_state;
    DELETE FROM sent_messages;
    DELETE FROM unsent_messages;
    DELETE FROM inbound_messages;
    DELETE FROM memory_short;
    DELETE FROM forget_epochs;
    DELETE FROM proactive_deliveries;
    DELETE FROM bridge_inbound_seen;
    DELETE FROM ops_tasks;
    DELETE FROM token_usage;
    DELETE FROM error_log;
    DELETE FROM diagnostic_turns;
    DELETE FROM diagnostic_turn_history;
    DELETE FROM memory_archive_embeddings;
  `);
  // Its own statement, and tolerant: the delete goes through the BASE table so the FTS delete
  // trigger keeps the index in sync, but a DB carrying triggers without the virtual table
  // (FTS-capable writer, FTS-less reader) would throw and take the whole reset with it.
  try { d.exec('DELETE FROM memory_archive'); } catch { /* trigger-less/partial FTS state */ }
  try { fs.rmSync(path.join(irisesHome(), 'memories'), { recursive: true, force: true }); } catch { /* best-effort */ }
}
