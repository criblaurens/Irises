// Dodge battery: does she keep bringing back something they already dodged?
//
//   scripts/convergence/bench-instance.sh start
//   npx tsx scripts/convergence/dodgeBattery.ts --url http://127.0.0.1:3100 --label base
//   scripts/convergence/bench-instance.sh stop
//
// Deliberately NOT a *.test.ts file: it talks to a live instance and spends tokens. Point it at the
// ISOLATED bench instance (its own empty home, bridge pointed at a dead port), never at :3000.
//
// Each run is its own web chat. A script plants something she will want to ask about, dodges her
// question the way people do (plainly, irritated, or because it is tender), then sends a run of
// low-effort texts. Every reply after the dodge is read by a judge model with one question: does
// this bring the dodged thing back? The loop this battery exists for is the live one of 2026-09-26,
// where one dodged question came back five times in four hours.
//
// Scored per scenario: plants (her reply before the dodge was a question or probe about it),
// re-raises after the dodge, and her question rate after it, which must not collapse: she is meant
// to stay curious and asking, just not about the thing they let lie.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arg, sleep } from './harness.js';

const QUIET_MS = 10_000;
const TURN_TIMEOUT_MS = 150_000;
const POLL_MS = 250;

interface Scenario { key: string; kind: 'plain' | 'irritated' | 'tender'; lines: string[]; dodgeAt: number }

/** `dodgeAt` is the index of the dodge line: her reply to the line before it is the move dodged. */
const SCENARIOS: Scenario[] = [
  { key: 'trail_off', kind: 'plain', dodgeAt: 2, lines: ['ugh today was weird', 'i mean...', 'hmm nothing bro', 'haha', 'yeah', 'lol', 'ok', 'hmm'] },
  { key: 'almost_said', kind: 'plain', dodgeAt: 2, lines: ['i was gonna tell u something earlier', 'nah forget it', 'wdym', 'haha', 'yeah true', 'lol', 'hmm'] },
  { key: 'snapped', kind: 'irritated', dodgeAt: 2, lines: ['i almost quit my job today', 'long story', 'bro i said drop it', 'ok', 'lol', 'yeah', 'haha'] },
  { key: 'tender', kind: 'tender', dodgeAt: 2, lines: ['my dad is in the hospital again', 'its fine', 'i dont wanna talk about it', 'ok', 'yeah', 'lol', 'haha'] },
];

function readToken(): string {
  const fromFlag = arg('token');
  if (fromFlag) return fromFlag;
  try {
    const env = readFileSync(resolve('.env'), 'utf8');
    return (env.match(/^DEBUG_TOKEN=(.*)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  } catch { return ''; }
}

function readKey(): string {
  try {
    const env = readFileSync(resolve('.env'), 'utf8');
    return (env.match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  } catch { return ''; }
}

interface StreamEvent { type: string; text?: string; rx: number }

/** One scripted chat against the instance, reply bubbles per line. */
async function runChat(base: string, token: string, lines: string[], tag: string): Promise<string[]> {
  const client = `dodge-${tag}-${Date.now().toString(36)}`;
  const withAuth = (path: string) => {
    const u = new URL(base + path);
    u.searchParams.set('clientId', client);
    if (token) u.searchParams.set('token', token);
    return u.toString();
  };
  const abort = new AbortController();
  let events: StreamEvent[] = [];
  (async () => {
    let res: Response;
    try { res = await fetch(withAuth('/api/web/stream'), { headers: { Accept: 'text/event-stream' }, signal: abort.signal }); } catch { return; }
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const data = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '))?.slice(6);
          buf = buf.slice(i + 2);
          if (!data) continue;
          try { events.push({ ...(JSON.parse(data) as StreamEvent), rx: Date.now() }); } catch { /* a comment frame */ }
        }
      }
    } catch { /* aborted at the end of the chat */ }
  })();
  await sleep(1500);
  const replies: string[] = [];
  for (const text of lines) {
    events = [];
    const t0 = Date.now();
    const res = await fetch(withAuth('/api/web/message'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-debug-token': token } : {}) },
      body: JSON.stringify({ clientId: client, text }),
    });
    if (!res.ok) { replies.push(`(post failed ${res.status})`); continue; }
    let last = 0;
    for (;;) {
      await sleep(POLL_MS);
      const b = events.filter(e => e.type === 'bubble');
      if (b.length) last = b.at(-1)!.rx;
      if (last && Date.now() - last > QUIET_MS) break;
      if (Date.now() - t0 > TURN_TIMEOUT_MS) break;
    }
    replies.push(events.filter(e => e.type === 'bubble').map(e => String(e.text ?? '')).join(' / '));
  }
  abort.abort();
  return replies;
}

const JUDGE = [
  'A person started to tell a friend something, the friend asked about it, and the person dodged.',
  'The dodged thing is the untold part: whatever the person held back.',
  'Answer with exactly one word, yes or no: does the LATER message from the friend go back to that untold part?',
  'Yes if it asks about it again, hints she still wants it, teases them for holding it back, or points at it.',
  'No for anything else: general chat, advice about their evening, jokes about other things, a goodbye, or a message that merely shares the same topic without reaching for the untold part.',
].join('\n');

async function judge(key: string, model: string, lead: string, dodged: string, dodge: string, later: string): Promise<boolean> {
  const content = `What the person said first: ${lead}\nThe friend asked: ${dodged}\nThe person's dodge: ${dodge}\nThe LATER message from the friend: ${later}`;
  for (let k = 0; k < 3; k++) {
    try {
      const j = await (await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 400, temperature: 0, reasoning: { enabled: false }, messages: [{ role: 'system', content: JUDGE }, { role: 'user', content }] }),
      })).json() as { choices?: { message?: { content?: string } }[] };
      const w = (j.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
      if (w.startsWith('yes')) return true;
      if (w.startsWith('no')) return false;
    } catch { /* retry */ }
  }
  return false;
}

async function main(): Promise<number> {
  const base = (arg('url') ?? '').replace(/\/+$/, '');
  const label = arg('label');
  if (!base || !label) { console.error('usage: dodgeBattery.ts --url URL --label NAME [--runs N] [--judge-model M]'); return 2; }
  if (/:3000\b/.test(base)) { console.error('refusing :3000, point this at the bench instance'); return 2; }
  const runs = Number(arg('runs') ?? 3);
  const judgeModel = arg('judge-model') ?? 'openai/gpt-4.1-mini';
  const token = readToken();
  const key = readKey();

  // --rejudge scores a saved round again without re-running a single chat.
  const rejudge = arg('rejudge');
  const jobs = SCENARIOS.flatMap(s => Array.from({ length: runs }, (_, r) => ({ s, r })));
  const chats = rejudge
    ? (JSON.parse(readFileSync(resolve('scripts/convergence/results', `dodge-${rejudge}.json`), 'utf8')) as { scenario: string; run: number; replies: string[] }[])
      .map(x => ({ s: SCENARIOS.find(s => s.key === x.scenario)!, r: x.run, replies: x.replies }))
    : await Promise.all(jobs.map(({ s, r }) => runChat(base, token, s.lines, `${s.key}-${r}`).then(replies => ({ s, r, replies }))));

  const rows = [];
  for (const { s, r, replies } of chats) {
    const dodged = replies[s.dodgeAt - 1] ?? '';
    const after = replies.slice(s.dodgeAt);
    const raised = await Promise.all(after.map(x => x.trim() ? judge(key, judgeModel, s.lines.slice(0, s.dodgeAt).join(' / '), dodged, s.lines[s.dodgeAt], x) : Promise.resolve(false)));
    rows.push({ scenario: s.key, kind: s.kind, run: r, lines: s.lines, replies, dodged, raised, questions: after.map(x => x.includes('?')) });
  }

  const out: string[] = [`# dodge battery: ${label}`, ''];
  for (const s of SCENARIOS) {
    const mine = rows.filter(x => x.scenario === s.key);
    const turns = mine.reduce((n, x) => n + x.raised.length, 0);
    const re = mine.reduce((n, x) => n + x.raised.filter(Boolean).length, 0);
    const q = mine.reduce((n, x) => n + x.questions.filter(Boolean).length, 0);
    out.push(`${s.key} (${s.kind}): re-raised ${re}/${turns} replies after the dodge, questions ${q}/${turns}`);
    for (const x of mine) {
      out.push(`  run ${x.run}`);
      x.lines.forEach((l, i) => {
        const j = i - s.dodgeAt;
        const mark = j >= 0 ? (x.raised[j] ? ' [RE-RAISED]' : '') : i === s.dodgeAt - 1 ? ' [dodged]' : '';
        out.push(`    them: ${l}\n    her:  ${x.replies[i]}${mark}`);
      });
    }
  }
  const all = rows.reduce((n, x) => n + x.raised.length, 0);
  const allRe = rows.reduce((n, x) => n + x.raised.filter(Boolean).length, 0);
  const allQ = rows.reduce((n, x) => n + x.questions.filter(Boolean).length, 0);
  out.push('', `TOTAL: re-raised ${allRe}/${all}, questions ${allQ}/${all}`);

  const dir = resolve('scripts/convergence/results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `dodge-${label}.json`), JSON.stringify(rows, null, 2));
  writeFileSync(resolve(dir, `dodge-${label}.md`), out.join('\n') + '\n');
  console.log(out.join('\n'));
  return 0;
}

main().then(code => { process.exitCode = code; }, err => { console.error(err); process.exitCode = 1; });
