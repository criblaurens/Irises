import { Router, Request } from 'express';
import { getTraces, clearTraces, diagnosticsEnabled } from './trace.js';
import { isLoopback } from '../channels/loopback.js';

// Guard: if DEBUG_TOKEN is set, require it (?token= or x-debug-token). Otherwise
// only allow localhost, by exact address match. Prompts can contain PII, so don't expose this openly.
function authorized(req: Request): boolean {
  const token = process.env.DEBUG_TOKEN;
  if (token) return req.query.token === token || req.headers['x-debug-token'] === token;
  return isLoopback(req);
}

export function createDiagnosticsRouter(): Router {
  const router = Router();

  router.get('/debug/api/traces', (req, res) => {
    if (!authorized(req)) { res.status(403).json({ error: 'forbidden' }); return; }
    res.json({ enabled: diagnosticsEnabled, events: getTraces() });
  });

  router.post('/debug/api/clear', (req, res) => {
    if (!authorized(req)) { res.status(403).json({ error: 'forbidden' }); return; }
    clearTraces();
    res.json({ ok: true });
  });

  router.get('/debug', (req, res) => {
    if (!authorized(req)) { res.status(403).send('forbidden — append ?token=YOUR_DEBUG_TOKEN'); return; }
    res.status(200).set('Content-Type', 'text/html').send(PAGE);
  });

  return router;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Irises · diagnostics</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--mut:#8b93a7;--acc:#6ea8fe;--ok:#5bd6a0;--err:#ff6b6b;--line:#262b36}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:#e7eaf0}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:.7rem 1rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
header h1{font-size:1rem;margin:0;margin-right:auto}
input,button,select{background:var(--card);color:#e7eaf0;border:1px solid var(--line);border-radius:8px;padding:.35rem .6rem;font:inherit}
button{cursor:pointer}
main{padding:1rem;max-width:1000px;margin:0 auto}
.group{border:1px solid var(--line);border-radius:12px;margin-bottom:1rem;overflow:hidden}
.group>summary{cursor:pointer;padding:.6rem .9rem;background:var(--card);font-weight:600;list-style:none}
.ev{border-top:1px solid var(--line);padding:.55rem .9rem}
.ev .top{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.tag{font-size:.72rem;padding:.05rem .45rem;border-radius:6px;border:1px solid var(--line);color:var(--mut)}
.tag.llm{color:var(--acc);border-color:var(--acc)}
.tag.delegation{color:#d7a3ff;border-color:#d7a3ff}
.tag.followup{color:var(--ok);border-color:var(--ok)}
.muted{color:var(--mut);font-size:.8rem}
pre{background:#0b0d11;border:1px solid var(--line);border-radius:8px;padding:.55rem;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:.4rem 0;max-height:24rem}
details details>summary{cursor:pointer;color:var(--mut);font-size:.82rem;margin-top:.3rem}
.empty{color:var(--mut);text-align:center;padding:3rem}
</style></head><body>
<header>
  <h1>🏡 Irises · prompt diagnostics</h1>
  <input id="filter" placeholder="filter by chat/handle/task/label">
  <label class="muted"><input type="checkbox" id="auto" checked> auto-refresh</label>
  <button id="refresh">refresh</button>
  <button id="clear">clear</button>
</header>
<main id="out"><div class="empty">loading…</div></main>
<script>
const qs = new URLSearchParams(location.search);
const token = qs.get('token') || '';
const esc = s => (s==null?'':String(s)).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function pre(label, val){ if(val==null||val==='') return ''; const txt = typeof val==='string'?val:JSON.stringify(val,null,2);
  return '<details><summary>'+esc(label)+'</summary><pre>'+esc(txt)+'</pre></details>'; }
function evHtml(e){
  const t = new Date(e.ts).toLocaleTimeString();
  const meta = [e.role,e.provider,e.model,e.latencyMs!=null?e.latencyMs+'ms':null].filter(Boolean).join(' · ');
  return '<div class="ev"><div class="top"><span class="tag '+e.type+'">'+esc(e.type)+'</span>'
    +(e.label?'<span class="tag">'+esc(e.label)+'</span>':'')
    +'<span class="muted">'+t+(meta?' · '+esc(meta):'')+'</span></div>'
    + pre('RAW request (wire, sent)', e.rawRequest)
    + pre('messages sent', e.messages)
    + pre('system prompt', e.system)
    + pre('RAW response (wire, unparsed)', e.raw)
    + pre('response', e.response)
    + (e.toolCalls&&e.toolCalls.length?pre('tool calls', e.toolCalls):'')
    + (e.detail?pre('detail', e.detail):'')
    + '</div>';
}
function groupKey(e){ return e.taskId ? ('task '+e.taskId.slice(0,8)) : (e.chatId ? ('chat '+e.chatId) : 'misc'); }
async function load(){
  const r = await fetch('/debug/api/traces'+(token?('?token='+encodeURIComponent(token)):''));
  if(!r.ok){ document.getElementById('out').innerHTML='<div class="empty">forbidden — add ?token=…</div>'; return; }
  const {events} = await r.json();
  const f = document.getElementById('filter').value.toLowerCase();
  const rows = events.filter(e=>!f || JSON.stringify(e).toLowerCase().includes(f));
  const groups = {};
  for(const e of rows){ (groups[groupKey(e)] ||= []).push(e); }
  const keys = Object.keys(groups).sort((a,b)=> (groups[b].at(-1).ts)-(groups[a].at(-1).ts));
  const out = document.getElementById('out');
  if(!keys.length){ out.innerHTML='<div class="empty">no traces yet — send Irises a message</div>'; return; }
  out.innerHTML = keys.map(k=>{
    const evs = groups[k].sort((a,b)=>a.ts-b.ts);
    return '<details class="group" open><summary>'+esc(k)+' · '+evs.length+' events</summary>'+evs.map(evHtml).join('')+'</details>';
  }).join('');
}
document.getElementById('refresh').onclick=load;
document.getElementById('filter').oninput=load;
document.getElementById('clear').onclick=async()=>{ await fetch('/debug/api/clear'+(token?('?token='+encodeURIComponent(token)):''),{method:'POST'}); load(); };
setInterval(()=>{ if(document.getElementById('auto').checked) load(); }, 3000);
load();
</script></body></html>`;
