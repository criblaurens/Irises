// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The cold archive (tier 0): insert/search round-trip, the handle-vs-chat scope that keeps one
// user's past out of another's, ranking, the content cap, the per-handle row cap, purge, and
// ALL THREE search backends — FTS5 as the build provides it, a forced LIKE pass (the fallback
// must answer the same question the same way), and the hybrid vector path, which must answer it
// the same way TOO and only then add the paraphrases the other two structurally cannot reach.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';
// Pin the store's notion of "current" so the fake embedder's 64-dim vectors ARE the current ones.
process.env.EMBEDDINGS_MODEL = 'test/fake-embed';
process.env.EMBEDDINGS_DIMENSIONS = '64';
// The hybrid path needs BOTH the flag and a registered embedder (archiveSearchBackend reads the
// flag at call time, so a runtime flip can't leave diagnostics claiming a search that isn't
// happening). No key is set and no real embedder is ever registered here — this only unlocks the
// fake below.
process.env.MEMORY_SEMANTIC_RECALL = 'on';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveEntries, searchArchive, purgeArchiveFor, sweepArchiveCaps, listArchiveFor,
  archiveSearchBackend, __setArchiveBackendForTests,
  ARCHIVE_CONTENT_MAX_CHARS, ARCHIVE_MAX_ROWS_PER_HANDLE,
  type ArchiveInput, type ArchiveSearchBackend,
} from './memoryArchive.js';
import {
  setArchiveEmbedder, archiveEmbedder, backfillArchiveEmbeddings, encodeVector, l2Normalize,
  type Embedder,
} from './memoryArchiveVectors.js';
import { stmt, ftsAvailable } from '../sqlite.js';

let seq = 0;
function freshHandle(): string {
  return `+1555200${(seq++).toString().padStart(4, '0')}`;
}

// ── The fake embedder ───────────────────────────────────────────────────────
// A fixture map keyed by EXACT text (for the cases that need a specific cosine) over a
// deterministic hashed bag-of-words fallback at 64 dims. No network, no provider, no SDK.

const DIMS = 64;

function basis(i: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[i] = 1;
  return v;
}

/** A unit vector at cosine `wa` from `a` (given a ⟂ b, both unit). */
function mix(a: Float32Array, b: Float32Array, wa: number): Float32Array {
  const wb = Math.sqrt(1 - wa * wa);
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = a[i] * wa + b[i] * wb;
  return l2Normalize(v);
}

function bagOfWords(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    v[h % DIMS] += 1;
  }
  return l2Normalize(v);
}

const FIXTURES = new Map<string, Float32Array>();
let embedCalls = 0;

const fakeEmbedder: Embedder = async (texts) => {
  embedCalls++;
  return texts.map(t => FIXTURES.get(t) ?? bagOfWords(t));
};

/** Every assertion below is run once per backend — the LIKE path is the degraded-build contract,
 *  and the vector path must not change ANY of their answers. */
const BACKENDS: ArchiveSearchBackend[] = ['fts5', 'like', 'vector'];

function withBackend(backend: ArchiveSearchBackend, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    __setArchiveBackendForTests(backend);
    if (backend === 'vector') setArchiveEmbedder(fakeEmbedder);
    try {
      await fn();
    } finally {
      __setArchiveBackendForTests(null);
      setArchiveEmbedder(null);
    }
  };
}

/** Archive rows and, when an embedder is registered, embed them: the hybrid path is only hybrid
 *  if the rows actually have vectors (production gets them from the background backfill). */
async function archive(entries: ArchiveInput[]): Promise<void> {
  await archiveEntries(entries);
  if (archiveEmbedder()) await backfillArchiveEmbeddings({ batchSize: 50, maxBatches: 4 });
}

// Node 22.x — the engines floor and the low end of the CI matrix — bundles a SQLite amalgamation
// without fts5, so demanding the virtual table would fail on a Node this package supports. The
// invariant that holds everywhere is that the backend is never ambiguous: fts5 when the build
// compiles it in, the documented LIKE fallback when it does not, nothing else. The forced-LIKE
// cases below prove that fallback answers the same queries the same way.
test('archive search uses fts5 when the build compiles it in, and says so when it does not', () => {
  assert.equal(archiveSearchBackend(), ftsAvailable() ? 'fts5' : 'like');
});

for (const backend of BACKENDS) {
  test(`[${backend}] archive round-trip: an entry is searchable by a word in its content`, withBackend(backend, async () => {
    const h = freshHandle();
    await archive([{
      source: 'medium_superseded', agentHandle: h, kind: 'fact', request: 'brokerage',
      content: 'works at Keller Williams in the Cedar Park office', createdAt: Date.now() - 86_400_000,
    }]);
    const hits = await searchArchive({ query: 'keller', handle: h });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].entry.source, 'medium_superseded');
    assert.equal(hits[0].entry.request, 'brokerage');
    assert.match(hits[0].snippet, /Keller/);
  }));

  test(`[${backend}] scoping: another handle's archive is invisible`, withBackend(backend, async () => {
    const mine = freshHandle();
    const theirs = freshHandle();
    await archive([
      { source: 'message_pruned', agentHandle: mine, chatId: `chat-mine-${backend}`, content: 'my lake cabin is called the shack' },
      { source: 'message_pruned', agentHandle: theirs, chatId: `chat-theirs-${backend}`, content: 'their lake cabin is called the barn' },
    ]);
    const hits = await searchArchive({ query: 'lake cabin', handle: mine, chatId: `chat-mine-${backend}` });
    assert.equal(hits.length, 1);
    assert.match(hits[0].entry.content, /the shack/);

    // An unscoped search reaches nothing at all rather than everything.
    assert.deepEqual(await searchArchive({ query: 'lake cabin' }), []);
  }));

  test(`[${backend}] scoping: a chat's rows are reachable without the handle`, withBackend(backend, async () => {
    const h = freshHandle();
    await archive([
      { source: 'message_pruned', chatId: `chat-shared-${backend}`, content: 'the juniper closing moved to friday' },
    ]);
    assert.equal((await searchArchive({ query: 'juniper', chatId: `chat-shared-${backend}` })).length, 1);
    assert.equal((await searchArchive({ query: 'juniper', handle: h })).length, 0);
  }));

  test(`[${backend}] ranking: a two-term match outranks a one-term match`, withBackend(backend, async () => {
    const h = freshHandle();
    await archive([
      { source: 'short_expired', agentHandle: h, content: 'notes about the marathon' },
      { source: 'short_expired', agentHandle: h, content: 'the boston marathon training plan, week nine' },
    ]);
    const hits = await searchArchive({ query: 'boston marathon', handle: h });
    assert.equal(hits.length, 2);
    assert.match(hits[0].entry.content, /boston marathon/);
    assert.ok(hits[0].score >= hits[1].score);
  }));

  test(`[${backend}] a query of pure punctuation finds nothing (and never throws)`, withBackend(backend, async () => {
    const h = freshHandle();
    await archive([{ source: 'short_expired', agentHandle: h, content: 'anything at all' }]);
    embedCalls = 0;
    assert.deepEqual(await searchArchive({ query: '   *** ', handle: h }), []);
    // The no-tokens early return sits BEFORE the embedding call: a query that can't match
    // anything must not cost a provider round-trip.
    assert.equal(embedCalls, 0);
  }));

  test(`[${backend}] FTS operators in a user query are data, not syntax`, withBackend(backend, async () => {
    const h = freshHandle();
    await archive([{ source: 'short_expired', agentHandle: h, content: 'the hendersons want a fence quote' }]);
    // Would be a syntax error (or a wildly different query) if the tokens reached MATCH raw.
    const hits = await searchArchive({ query: 'hendersons NEAR("x" OR *', handle: h });
    assert.equal(hits.length, 1);
  }));
}

// ── Hybrid-only behaviour ───────────────────────────────────────────────────
// What the vector leg ADDS, and — more importantly — what it is not allowed to take away.

function withVector(embedder: Embedder, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    __setArchiveBackendForTests('vector');
    setArchiveEmbedder(embedder);
    try {
      await fn();
    } finally {
      __setArchiveBackendForTests(null);
      setArchiveEmbedder(null);
    }
  };
}

function archiveIdFor(handle: string): number {
  return Number((stmt('SELECT id FROM memory_archive WHERE agent_handle = ? ORDER BY id DESC LIMIT 1')
    .get(handle) as { id: number }).id);
}

// The paraphrase pair: no token in common, cosine 0.99 apart.
const LAKE = basis(3);
FIXTURES.set('my lake cabin is called the shack', LAKE);
FIXTURES.set('vacation house near open water', mix(LAKE, basis(11), 0.99));
// The weak-match trio: a lexical hit orthogonal to the query, and a semantic near-miss at 0.20.
const GATE = basis(20);
FIXTURES.set('gate code', GATE);
FIXTURES.set('the gate code for the ranch is 4421', basis(22));
FIXTURES.set('unrelated musings about breakfast cereal', mix(GATE, basis(21), 0.20));
// A row both legs find.
const SEPTIC = basis(30);
FIXTURES.set('septic pump', SEPTIC);
FIXTURES.set('the septic pump was serviced in march', mix(SEPTIC, basis(31), 0.95));

test('[vector] a paraphrase with NO shared tokens is recalled', withVector(fakeEmbedder, async () => {
  const h = freshHandle();
  await archive([{ source: 'message_pruned', agentHandle: h, content: 'my lake cabin is called the shack' }]);

  const hits = await searchArchive({ query: 'vacation house near open water', handle: h });
  assert.equal(hits.length, 1, 'the semantic leg found what shares no word with the query');
  assert.match(hits[0].entry.content, /the shack/);
  assert.ok(hits[0].snippet.length > 0);

  // The same query on either lexical backend reaches nothing at all — this is the whole gap.
  for (const lexical of ['fts5', 'like'] as const) {
    __setArchiveBackendForTests(lexical);
    assert.deepEqual(await searchArchive({ query: 'vacation house near open water', handle: h }), [], lexical);
  }
  __setArchiveBackendForTests('vector');
  await purgeArchiveFor({ handle: h });
}));

test('[vector] a weak semantic match below the min-score floor cannot displace a lexical hit', withVector(fakeEmbedder, async () => {
  const h = freshHandle();
  await archive([
    { source: 'short_expired', agentHandle: h, content: 'the gate code for the ranch is 4421' },
    { source: 'short_expired', agentHandle: h, content: 'unrelated musings about breakfast cereal' },
  ]);

  const hits = await searchArchive({ query: 'gate code', handle: h });
  assert.equal(hits.length, 1);
  assert.match(hits[0].entry.content, /4421/);

  // Drop the floor under it and the same row DOES surface — proving the floor is what excluded
  // it, not the fixture being unreachable.
  const floor = process.env.MEMORY_SEMANTIC_MIN_SCORE;
  process.env.MEMORY_SEMANTIC_MIN_SCORE = '0.1';
  try {
    const loosened = await searchArchive({ query: 'gate code', handle: h });
    assert.ok(loosened.some(x => /breakfast cereal/.test(x.entry.content)), 'the 0.20 match is real, just too weak');
  } finally {
    if (floor === undefined) delete process.env.MEMORY_SEMANTIC_MIN_SCORE;
    else process.env.MEMORY_SEMANTIC_MIN_SCORE = floor;
  }
  await purgeArchiveFor({ handle: h });
}));

test('[vector] fusion dedups by archive id', withVector(fakeEmbedder, async () => {
  const h = freshHandle();
  await archive([{ source: 'short_expired', agentHandle: h, content: 'the septic pump was serviced in march' }]);
  const hits = await searchArchive({ query: 'septic pump', handle: h });
  assert.equal(hits.length, 1, 'one row found twice is one hit');
  // Both legs ranked it first: 1/(60+1) twice.
  assert.ok(Math.abs(hits[0].score - 2 / 61) < 1e-9, `score ${hits[0].score} is the summed reciprocal rank`);
  await purgeArchiveFor({ handle: h });
}));

test('[vector] a null embedder result degrades to the lexical result, identically', async () => {
  const h = freshHandle();
  const nullEmbedder: Embedder = async () => null;
  __setArchiveBackendForTests('vector');
  setArchiveEmbedder(nullEmbedder);
  try {
    await archive([
      { source: 'short_expired', agentHandle: h, content: 'the boston marathon training plan, week nine' },
      { source: 'short_expired', agentHandle: h, content: 'notes about the marathon' },
      { source: 'short_expired', agentHandle: h, content: 'a marathon of meetings on tuesday' },
    ]);
    const degraded = await searchArchive({ query: 'boston marathon', handle: h });
    __setArchiveBackendForTests('fts5');
    const lexical = await searchArchive({ query: 'boston marathon', handle: h });
    assert.equal(degraded.length, 3);
    assert.deepEqual(degraded, lexical, 'not merely similar — the same result');
  } finally {
    __setArchiveBackendForTests(null);
    setArchiveEmbedder(null);
  }
  await purgeArchiveFor({ handle: h });
});

test('[vector] with no vectors in scope the embedder is never called at all', async () => {
  const h = freshHandle();
  let calls = 0;
  const countingEmbedder: Embedder = async (texts) => { calls++; return texts.map(bagOfWords); };
  __setArchiveBackendForTests('vector');
  setArchiveEmbedder(countingEmbedder);
  try {
    // Archived but NOT backfilled: exactly the state a fresh install (or a just-changed model) is
    // in. A scan over zero vectors can't answer, so the query round trip must not happen.
    await archiveEntries([
      { source: 'short_expired', agentHandle: h, content: 'the cistern was drained in april' },
    ]);
    const hits = await searchArchive({ query: 'cistern', handle: h });
    assert.equal(calls, 0, 'no vectors in scope ⇒ no query embedding');
    assert.equal(hits.length, 1, 'and the lexical leg still answers');

    // Once a vector exists for this scope, the leg comes back — proving the skip was about the
    // empty table, not about the embedder being unreachable.
    await backfillArchiveEmbeddings({ batchSize: 10, maxBatches: 1 });
    const before = calls;
    await searchArchive({ query: 'cistern', handle: h });
    assert.equal(calls, before + 1, 'with vectors present the query IS embedded');
  } finally {
    __setArchiveBackendForTests(null);
    setArchiveEmbedder(null);
  }
  await purgeArchiveFor({ handle: h });
});

test('[vector] hit contract unchanged: ≤limit hits, snippet ≤300 chars, deterministic order', withVector(fakeEmbedder, async () => {
  const h = freshHandle();
  const filler = 'and then a great deal of surrounding narration that pads this entry well past the snippet window. ';
  const rows: ArchiveInput[] = [];
  const anchor = basis(40);
  for (let i = 0; i < 10; i++) {
    const content = `${filler.repeat(3)} the quarterly report for unit ${i} landed. ${filler.repeat(3)}`;
    FIXTURES.set(content, mix(anchor, basis(41 + i), 0.99 - i * 0.01));
    rows.push({ source: 'message_pruned', agentHandle: h, content });
  }
  FIXTURES.set('quarterly report', anchor);
  await archive(rows);

  const hits = await searchArchive({ query: 'quarterly report', handle: h });
  assert.equal(hits.length, 6, 'capped at the default limit');
  for (const hit of hits) assert.ok(hit.snippet.length <= 300, `snippet ${hit.snippet.length} chars`);
  const again = await searchArchive({ query: 'quarterly report', handle: h });
  assert.deepEqual(again.map(x => x.entry.id), hits.map(x => x.entry.id), 'same query, same order');
  assert.equal(new Set(hits.map(x => x.entry.id)).size, 6, 'no id appears twice');
  await purgeArchiveFor({ handle: h });
}));

test('[vector] vectors with mismatched model/dims are ignored, not mis-compared', withVector(fakeEmbedder, async () => {
  const h = freshHandle();
  const content = 'my dinghy is moored at the pier';
  FIXTURES.set(content, mix(LAKE, basis(12), 0.99));
  await archiveEntries([{ source: 'message_pruned', agentHandle: h, content }]);
  const id = archiveIdFor(h);
  const vec = FIXTURES.get(content)!;

  // A vector written by a model this build no longer uses: semantically close, but in another
  // space entirely. Comparing it would be worse than not having it.
  const write = (model: string, dims: number, blob: Buffer) => stmt(
    `INSERT OR REPLACE INTO memory_archive_embeddings (archive_id, vector, dims, model, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, blob, dims, model, Date.now());

  write('test/other-embed', DIMS, encodeVector(vec));
  assert.deepEqual(await searchArchive({ query: 'vacation house near open water', handle: h }), [], 'wrong model');

  write('test/fake-embed', 32, encodeVector(vec.subarray(0, 32)));
  assert.deepEqual(await searchArchive({ query: 'vacation house near open water', handle: h }), [], 'wrong dims');

  // Written under THIS build's model and width, the very same vector is found — the exclusions
  // above were about the label, not the data.
  write('test/fake-embed', DIMS, encodeVector(vec));
  assert.equal((await searchArchive({ query: 'vacation house near open water', handle: h })).length, 1);
  await purgeArchiveFor({ handle: h });
}));

test('content is sliced to ARCHIVE_CONTENT_MAX_CHARS', async () => {
  const h = freshHandle();
  await archiveEntries([{ source: 'message_pruned', agentHandle: h, content: `sprawling ${'x'.repeat(ARCHIVE_CONTENT_MAX_CHARS + 500)}` }]);
  const [entry] = await listArchiveFor(h);
  assert.equal(entry.content.length, ARCHIVE_CONTENT_MAX_CHARS);
});

// A dossier line the cap evicted (or a stray section's line, relocated) is not thrown away: it
// lands here under 'long_evicted' with its section, its (since …) date and why it left, so
// recall_memory can still answer for something the long doc no longer has room to say.
test('long_evicted: an evicted dossier line keeps its section, stamp date and reason', async () => {
  const h = freshHandle();
  await archive([
    {
      source: 'long_evicted', agentHandle: h, kind: 'dossier_line',
      request: '## Running jokes',
      content: 'calls the neighbour cat the landlord',
      meta: { section: '## Running jokes', since: '2026-07-13', reason: 'cap' },
      createdAt: Date.UTC(2026, 6, 13, 12, 0, 0),
    },
    {
      source: 'long_evicted', agentHandle: h, kind: 'dossier_line',
      request: '## Their world',
      content: 'brother visits from Surabaya every Ramadan',
      meta: { section: '## Their world', since: null, reason: 'relocated' },
    },
  ]);

  const rows = await listArchiveFor(h);
  assert.equal(rows.length, 2, 'both lines were stored — long_evicted is a known source');
  const byContent = new Map(rows.map(r => [r.content, r]));

  const capped = byContent.get('calls the neighbour cat the landlord')!;
  assert.equal(capped.source, 'long_evicted');
  assert.equal(capped.kind, 'dossier_line');
  assert.equal(capped.request, '## Running jokes');
  assert.deepEqual(capped.meta, { section: '## Running jokes', since: '2026-07-13', reason: 'cap' });
  assert.equal(capped.createdAt, Date.UTC(2026, 6, 13, 12, 0, 0), 'the stamp date at noon UTC, not the eviction time');

  const relocated = byContent.get('brother visits from Surabaya every Ramadan')!;
  assert.deepEqual(relocated.meta, { section: '## Their world', since: null, reason: 'relocated' });
  assert.ok(relocated.createdAt > Date.UTC(2026, 6, 13), 'an unstamped line falls back to now');

  // The point of archiving it: it is still recallable.
  const hits = await searchArchive({ query: 'landlord', handle: h });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entry.source, 'long_evicted');
});

test('an unknown source is refused, not stored', async () => {
  const h = freshHandle();
  await archiveEntries([{ source: 'not_a_real_source' as never, agentHandle: h, content: 'should not land' }]);
  assert.equal((await listArchiveFor(h)).length, 0);
});

test('archiveEntries never throws, even on a broken row', async () => {
  // Empty content is skipped rather than inserted (NOT NULL would reject it anyway).
  await archiveEntries([{ source: 'short_expired', agentHandle: freshHandle(), content: '' }]);
});

// Both cap enforcement points in one test: filling a handle to the cap is the expensive part
// (ARCHIVE_MAX_ROWS_PER_HANDLE raw inserts), so the per-insert eviction and the sweep share it.
test('the per-handle cap evicts oldest-first, on insert and in the sweep', async () => {
  const h = freshHandle();
  const other = freshHandle();
  const insert = stmt(
    `INSERT INTO memory_archive (agent_handle, source, content, meta_json, created_at, archived_at)
     VALUES (?, 'message_pruned', ?, '{}', ?, ?)`
  );
  // archived_at = i + 1 makes "oldest" unambiguous.
  for (let i = 0; i < ARCHIVE_MAX_ROWS_PER_HANDLE; i++) insert.run(h, `row ${i}`, i + 1, i + 1);
  insert.run(other, 'untouched', 1, 1);

  const count = (handle: string) =>
    (stmt('SELECT count(*) AS n FROM memory_archive WHERE agent_handle = ?').get(handle) as { n: number }).n;
  const oldest = (handle: string) =>
    (stmt('SELECT content FROM memory_archive WHERE agent_handle = ? ORDER BY archived_at ASC, id ASC LIMIT 1').get(handle) as { content: string }).content;

  // At the cap: one more insert stays at the cap and drops the oldest row.
  await archiveEntries([{ source: 'short_expired', agentHandle: h, content: 'the newest thing they said' }]);
  assert.equal(count(h), ARCHIVE_MAX_ROWS_PER_HANDLE);
  assert.equal(oldest(h), 'row 1', 'row 0 was evicted');
  assert.equal((await searchArchive({ query: 'newest', handle: h }))[0]?.entry.content, 'the newest thing they said');

  // Rows planted around the repository (or an older build) are caught by the daily sweep.
  for (let i = 0; i < 3; i++) insert.run(h, `extra ${i}`, 1_000_000 + i, 1_000_000 + i);
  assert.equal(await sweepArchiveCaps(), 3);
  assert.equal(count(h), ARCHIVE_MAX_ROWS_PER_HANDLE);
  assert.equal(oldest(h), 'row 4', 'the sweep also took the oldest three');
  assert.equal(count(other), 1, 'a handle under the cap is untouched');

  // Leave the table small for the tests after this one.
  await purgeArchiveFor({ handle: h });
  await purgeArchiveFor({ handle: other });
});

test('purgeArchiveFor drops by handle and by chat, leaving everything else', async () => {
  const h = freshHandle();
  const keep = freshHandle();
  await archiveEntries([
    { source: 'short_expired', agentHandle: h, chatId: 'chat-purge', content: 'forget me' },
    { source: 'short_expired', chatId: 'chat-purge', content: 'chat-scoped, no handle' },
    { source: 'short_expired', agentHandle: keep, chatId: 'chat-other', content: 'keep me' },
  ]);
  const removed = await purgeArchiveFor({ handle: h, chatId: 'chat-purge' });
  assert.equal(removed, 2);
  assert.equal((await listArchiveFor(h)).length, 0);
  assert.equal((await searchArchive({ query: 'forget', chatId: 'chat-purge' })).length, 0);
  assert.equal((await searchArchive({ query: 'keep', handle: keep })).length, 1);
});
