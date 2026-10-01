# Irises + your engine

Irises is the **persona**: a fast, deadpan texting front line (Convo), a re-voicer that makes deep
results land in one voice (Composer), an honest failure voice (Fallfirm), and the glue between
them. Everything **deep** — research, email, reading files, reminders, long-term memory — runs on
an **engine you already have**: [hermes-agent](https://github.com/NousResearch/hermes-agent) or
[OpenClaw](https://github.com/openclaw/openclaw). The engine is never modified; Irises speaks only
its public API, and either side can update independently.

```
                              THE IRISES REPO
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   USER ──text──▶ Channels ──▶ Convo (instant reply)          Irises's voice │
│    ▲             (web chat /                   │                            │
│    │              CLI + bridge)                │ deep work?                 │
│    │                                           ▼                            │
│    └──reply──── Composer ◀───────────── runTask() seam                      │
│                 (re-voices,                    │                            │
│                  hides the seam)               │  OPS_BACKEND = ?           │
│                                        ┌───────┴───────┐                    │
│                                        ▼               ▼                    │
│                                  hermesBackend   openclawBackend            │
│                                        │               │                    │
└────────────────────────────────────────┼───────────────┼────────────────────┘
                                         │               │
                              HTTP :8642 │               │ WS :18789
                              (OpenAI-   │               │ (gateway `agent`
                               compat)   ▼               ▼  RPC, protocol v4)
                                 ┌──────────────┐ ┌──────────────┐
                                 │ HERMES-AGENT │ │   OPENCLAW   │
                                 │ (unmodified) │ │ (unmodified) │
                                 └──────────────┘ └──────────────┘
```

There is deliberately **no built-in research engine**: if no engine is configured, Irises still
chats — and says honestly that its deep half is offline when you ask for more.

**Hermes transport:** a delegated leg runs on `POST /v1/runs` + `GET /v1/runs/{run_id}/events`
(SSE) — one run per leg, control included (see *Run control* below). It falls back to the older
blocking `POST /v1/chat/completions` when `HERMES_RUN_TRANSPORT=chat`, when hermes's own
`/v1/capabilities` (or a live 404 on `/v1/runs`) says the runs API isn't there, or for any task
carrying an image — `/v1/runs` accepts an image content-part without complaint but the run never
sees the picture (unvalidated by hermes's own multimodal path), so image-bearing tasks always take
the chat route regardless of the flag. Either way each run gets a **fresh transcript**: nothing
from the chat's history is replayed into the run body. The session id keeps rotating as before
(see `HERMES_SESSION_ROTATION`) but is now purely a grouping label in hermes's `state.db` — the
`X-Hermes-Session-Key` memory scope, and the engine's own memory of the chat, are unaffected.
OpenClaw is untouched: it still speaks the gateway `agent` RPC.

## Quick start (engine users)

**The install is a terminal command**, run on the machine the engine runs on:

```bash
git clone https://github.com/criblaurens/irises && cd irises
bash ./scripts/irises.sh                           # the menu; `npm run setup` is the same thing
```

The menu is the front door for a person: a status header (engine, installed build, service, port) over
**install or repair**, **configure**, **update**, **uninstall**, **status** and **advanced**. It owns
no lifecycle logic of its own — every entry translates your answers into flags on the lifecycle
scripts, prints the exact command line, and runs it. **Configure** re-asks the install's questions on
a box that is already installed — port and service, fronted chats, voice model, browser chat,
timezone, dashboard password, any documented `.env` key — through `bash ./scripts/configure.sh`, with
no wizard, no `npm ci` and no rebuild. The install wizard is seven steps, and the sixth — **optional
extras** — is skipped unless asked for: the browser chat UI, the timezone, and the dashboard password,
which is typed unseen and, left blank, keeps the shipped default rather than setting anything. Every
prompt answers to a number, going back included, and the uninstall menu defaults to **Back**, because
each of its other entries removes something.

The scripts stay the path for everything that is not a person at a keyboard — a deploy, a CI job, an
agent verifying afterwards:

```bash
bash ./scripts/engine-setup.sh --engine hermes --yes   # or: --engine openclaw
```

The menu reads its answers from stdin rather than from a terminal, so it can be driven by a piped
answer script; end of input quits it cleanly with exit `2` and a pointer at the flags, which is why a
non-interactive caller should use the flags in the first place.

On Windows those two commands run in **Git Bash** (it ships with the Git for Windows the clone needs
anyway) or inside a **WSL2** shell. The Windows paths are stub-tested only and have not yet been run
on a real Windows box — Linux and macOS are the verified platforms.

There is no chat route in, and that is the design: the script's last step bounces the engine gateway,
so an agent running it from a gateway-hosted session would kill the supervisor carrying its own turn,
mid-reply (see *Install / uninstall* below).

**Want to be walked through it?** The two setup skills are **guides, not installers**. Your agent
explains what Irises is, runs the read-only prerequisite checks, hands you the exact commands to run
in your own terminal, and verifies the result once you report back — it clones, builds, starts and
restarts nothing. Install the guide for your engine:

```bash
# hermes
hermes skills install https://raw.githubusercontent.com/criblaurens/irises/main/skills/irises-setup-hermes/SKILL.md
# then, in any hermes chat:   /irises-setup-hermes
```

(The one-liner fetches over plain HTTPS with no credentials, so the repo has to be public — or
otherwise reachable to you anonymously — for it to resolve.)

```bash
# OpenClaw
openclaw skills install git:criblaurens/irises
# then ask your OpenClaw to run the irises-setup-openclaw skill
```

The script is idempotent, prints every change before making it, and never edits engine code. On
hermes it writes up to six keys into `~/.hermes/.env` — `API_SERVER_ENABLED` and `API_SERVER_KEY`
(the documented way to enable its API server), `IRISES_PUSH_TOKEN` and `IRISES_URL`, plus
`IRISES_BRIDGE_TOKEN` and `IRISES_FRONT` in bridge mode — creating the file (mode 600) if hermes has
never written one itself, backing it up first, and recording in
`~/.irises/install-manifest.json` exactly which keys were new so `--uninstall` can put the file back
without guessing. Keys that were already there are left on their own values (a duplicated
`API_SERVER_KEY` is collapsed onto the live one). On OpenClaw it edits no engine config at all: it
*reads* the existing gateway token, and prints the variables you set on the gateway yourself.

**The engine's `.env` is the one file you may want to keep your hands on**, so what happens to it is a
choice: `--engine-env apply` (the default, and what every install has done) writes the keys; `ask` — what
the menu passes — prints the block first and writes it only on a yes; `print` never writes it at all.
The preview is built where the change is computed, so it shows the real thing: one line per key, `+`
for a key being added and `~` for one being retargeted with the value it is being moved off, and the
name but never the value of anything secret. A declined `ask` and a `print` run behave identically —
the engine's env file is left byte-for-byte as it was, no backup is taken because nothing is being
changed, the block is printed for you to apply by hand, and the manifest records that this install put
nothing in that file, so a later uninstall or detach knows there is nothing of ours in there to take
back out. Both still install the bridge plugin and still bounce the gateway; fronting simply stays off
until the keys are in place, which is exactly the position an OpenClaw install has always been in.

Flags: `--yes` runs non-interactively (assume every default, never prompt — which is also what a run
with no terminal on stdin does by itself), `--bridge` / `--no-bridge` choose bridge mode outright,
`--no-service` skips the user-level service, `--port N` picks the port. **Bridge mode is ON by
default, including on a run with no terminal**, and what that means differs by engine: on **hermes**
the installer writes `IRISES_FRONT` itself — `*:*` unless you narrowed it with `--front` — so a
default install fronts every chat on every platform and you narrow that list rather than assuming an
opt-in; on **OpenClaw** it installs the plugin and then *prints* `IRISES_BRIDGE_TOKEN`, `IRISES_URL`
and `IRISES_FRONT` for you to set on the gateway process, and nothing is fronted until you do. The
engine gateway is restarted at the end of every install, with or without bridge mode.

The rest of the surface, each defaulting to what an install has always done: `--front PATTERNS`
(default `*:*`) and its env form `IRISES_FRONT_PATTERN` choose the fronted chats at install time;
`--engine-env apply|ask|print` decides what may happen to the engine's own env file; `--model-lane
anthropic|openrouter|openai` with `--model-slug ID` (and `--model-base-url URL`, required for the
openai lane and refused on the other two) gives Irises's voice a model of its own instead of the
engine's, with the key supplied only through `IRISES_MODEL_API_KEY` in the environment; `--web on|off`
sets whether this clone serves the browser/CLI debug chat (`WEB_ENABLED` — unset leaves the clone's
`.env` as it stands, which on a fresh install is on) and `--tz ZONE` sets the wall clock Irises reads
(`IRISES_TZ` — unset is the host's own zone, and a zone you pass is written even when it equals that
zone, so a box that moves region later keeps the clock its owner chose); and `--detach-engine` undoes
the engine side while leaving Irises alone (see *Taking it out again* below). The admin dashboard's
password follows the model key's rule — `IRISES_DASHBOARD_PASSWORD` in the environment, never a flag,
written into the clone's `.env` (mode 600) as `DASHBOARD_PASSWORD` and never printed; leave it unset
and the dashboard keeps the password that ships with the code, which is a reason to set one rather
than a reason to relax.

`--uninstall` takes the whole install back out again (the user service, the plugin, the
engine-side keys the installer added), bounces the gateway on its way out when it removed something,
and keeps your data unless you add `--purge-data` — with `--archive-data` to tar `$IRISES_HOME` to
`~/.irises-backup-<timestamp>.tar.gz` before anything goes.

What it leaves behind: `PORT=3000` pinned in the Irises `.env` — the committed `deploy/app.env`
baseline of `8080` is the Docker image's port behind Caddy, so pinning 3000 keeps the server, the
printed URL, `npm run chat` and the bridge plugin's `IRISES_URL` default all pointing at one place.
It builds both halves (the server, and the web client where that one is in use), registers Irises as
a **user-level service** — `systemd --user` on Linux, a LaunchAgent on macOS, a Task Scheduler task
named `Irises` on Windows, and a detached `nohup` launch where none of those exists — and
health-checks it until the **new build's own sha** answers on `/health` (not merely "something
answers", which the old process still holding the port satisfies). Then it **leaves Irises running**
and prints the service controls, `npm run chat`, and — only when `web/out` exists in the clone — the
web chat URL (`http://127.0.0.1:3000`); with no web build it points you at `npm run chat` instead and
says `IRISES_WEB=1` builds the browser page. It bounces the gateway last so the API server, the
plugin and the fronting are all live; the only probe it makes against the engine is the
unauthenticated `GET /v1/health` that confirms the gateway came back up. Run the script again on a
box where a healthy Irises already serves that port and it adopts it instead of starting a second one.

## Zero-config discovery (what happens at boot)

Irises is designed to ride **on top of** the engine with no `.env` of its own. On every boot,
`src/agents/ops/engineDiscovery.ts` runs (between the `deploy/app.env` baseline load and your local
`.env`) and fills in — **only what you haven't set yourself** — from the installed engine:

- **`OPS_BACKEND` is auto-detected.** hermes if `~/.hermes/` exists; otherwise OpenClaw if its CLI
  answers with a gateway token. If both are present, hermes wins (reminders need it). Set
  `OPS_BACKEND` yourself to force one — or **`OPS_BACKEND=off`** to force the debug/standalone path
  (deep work offline, discovery skipped entirely) even on a machine that has an engine installed.
- **The engine's credentials are reused.** hermes `HERMES_API_KEY` ← `API_SERVER_KEY` from
  `~/.hermes/.env`; OpenClaw `OPENCLAW_TOKEN` ← `openclaw config get gateway.auth.token`. Loopback
  URLs default in.
- **The LLM key is reused.** `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` are taken from the engine's
  own environment so Irises's small voice models have a key without you copying one.
- **Irises's voice inherits the engine's model** (see below).

Precedence: anything you exported in the shell, or set in local `.env`, always wins over discovery,
which in turn overrides the committed `deploy/app.env` model baseline. In Docker (no engine reachable,
no dotenv files) discovery finds nothing and the compose-injected env stands.

### Model inheritance

Deep work already runs on the engine's model. On top of that, discovery reads the engine's configured
**model + provider + endpoint + key** and points Irises's own voice roles (`convo`, `classify`,
`fallfirm`) at the *same model on the same API* — so Irises's voice works no matter what the engine
runs on, including an "obscure" (non-OpenRouter, non-Anthropic) API, and answers on the model you
actually chose.

| Engine | Where it's read | Keys read |
|---|---|---|
| hermes | `hermes config get model.default / model.provider / model.base_url / model.api_key / model.api_mode` (env/`~/.hermes/config.yaml` fallbacks) | reuses `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from `~/.hermes/.env` |
| OpenClaw | `openclaw config get agents.entries.<agent>.model`, else `agents.defaults.model.primary` | reuses the engine token |

**Which model Irises's voice runs** (all three voice roles, overridable):

| Engine provider | Irises voice lane | Voice model |
|---|---|---|
| `openrouter` | openrouter | the engine's own model |
| `openai` | openai (api.openai.com) | the engine's own model |
| `anthropic` | anthropic | the engine's own model (a leading `anthropic/` comes off — the Messages API takes a bare id) |
| any other OpenAI-compatible (azure, deepseek-direct, vLLM, groq, custom, …) | openai @ the engine's `base_url` | the engine's own model |
| foreign auth/protocol (bedrock, vertex, gemini-native, codex/nous/xai-OAuth) | *not reachable directly* → keeps a working fallback lane + warns | — |

There is no stand-in slug on any lane. Inheritance means the voice runs the model the engine runs,
on the engine's own key — the one reshaping is spelling an id the way its API accepts it. The
trade-off is the honest one: a big deep-work model answers chat turns too, at its price and its
latency. Want a smaller, faster voice than the engine's? Name it per role with `<ROLE>_MODEL` /
`<ROLE>_MODEL_OPENROUTER` / `<ROLE>_MODEL_OPENAI`, or turn inheritance off and keep Irises's own
shipped models. Deep work always uses the engine's real model regardless.

One heads-up is logged rather than acted on: if the inherited model is a reasoning family that thinks
by default (`deepseek-v4*`, `deepseek-r*`, `o1/o3/o4`, `*-thinking`) while the voice roles have no
thinking armed, boot prints which roles run small per-call caps that thinking can spend before an
answer, and what that lane does about it. Nothing is substituted; the line names
`ENGINE_MODEL_INHERIT=off` as the way out.

Transcription and embeddings are never inherited as chat models but do follow the OpenRouter→OpenAI
lane (they degrade to lexical recall / disabled voice-memo transcription, with a note in the model
map, if neither key is present). Turn inheritance off with `ENGINE_MODEL_INHERIT=off`; override any
role with `<ROLE>_MODEL` / `<ROLE>_MODEL_OPENROUTER` / `<ROLE>_MODEL_OPENAI` / `<ROLE>_PROVIDER`, and
point the openai lane anywhere with `OPENAI_BASE_URL`.

**The install can write that override for you** (`--model-lane` + `--model-slug`, or the model step in
the menu): it sets the lane's model and provider keys for all three voice roles plus the lane's API key
in *this clone's* `.env`, and `ENGINE_MODEL_INHERIT=off` alongside them — which is the honest part to
understand, because turning inheritance off is broader than choosing a model. It also stops Irises
reusing the engine's key and endpoint for her voice, so from then on her voice runs on the key you
supplied and nothing else. Deep work is unaffected: that has always run on the engine's own model.
The key reaches the installer only through `IRISES_MODEL_API_KEY` in the environment — never as a
flag, because argv is readable by every other process on the box — and is never printed or logged.
Engine detection and the engine's own API key are outside inheritance and keep working either way.

**Seeing what's live:** the model map (Irises's voice model vs. the engine's deep-work model) shows in
`/health`, on the `/dashboard` overview, and via `npx tsx scripts/print-model-map.ts`. Irises will
also tell you her models in chat if you ask.

> **Note:** the auto openai-lane inheritance (reading `base_url`/`api_key`) is implemented for **hermes**.
> On OpenClaw the `provider/model` slug still routes via the existing heuristic; an OpenClaw user on an
> obscure API can point the voice manually with `<ROLE>_PROVIDER=openai` + `OPENAI_BASE_URL` + `OPENAI_API_KEY`.

## Engine onboarding (the standing discipline)

Deep work only lands right if the engine knows it is *in* engine mode. Irises teaches it once, as a
chat message the engine folds into its OWN durable instructions by its own hand — Irises never edits
engine files. What the discipline installs:

- **Engine-mode recognition** — which requests it governs (the `<prompt>` wrapper, the `task kind:`
  line, the brief, the output contract) and, just as important, which it doesn't: operator chats,
  slash commands, and the engine's own channels keep its normal self.
- **The output contract** — `ANSWER` / `SOURCE` / optional `ACTIONS` / `FLAGS`, nothing before or
  after, no questions back, `NO RESULT:` + one useful sentence when empty-handed, and the fidelity
  rules (figures verbatim, every `~` survives, certainty graded in FLAGS rather than hedged prose).
- **The full-reach invitation, with hard limits** — run real code, use its skills/tools/MCP servers,
  produce artifacts (and, on OpenClaw only, spawn parallel subagents — the hermes lane deliberately
  withholds that phrasing, because Convo's hermes briefs never ask for it). Inbox and accounts stay
  read-only, it never sends or publishes anything, and it **never messages the user directly** on any
  channel it can see: Irises is the only voice the user ever hears. That last one is a live hazard,
  not a formality, on hermes especially — the bridge plugin puts hermes's own channel adapters in the
  same process the engine runs in.

| Engine | How it arrives |
|---|---|
| hermes | **Automatic, at boot.** Irises sends it over the API server whenever `OPS_BACKEND=hermes`, on its own session key. Hermes appends the section to its own SOUL.md itself. Manual fallback + mechanism: `bridge/hermes/engine-onboarding-message.md`. |
| OpenClaw | **Automatic, at boot.** Irises sends it over the gateway `agent` RPC whenever `OPS_BACKEND=openclaw`. Mirror + full mechanism: `bridge/openclaw/engine-onboarding-message.md`. |

Each send is keyed to a **content hash** of that engine's message — `HERMES_ONBOARDING_MESSAGE` in
`src/agents/ops/hermesDoctrine.ts` and `OPENCLAW_ONBOARDING_MESSAGE` in
`src/agents/ops/openclawDoctrine.ts` are the canonical texts. Delivery state lives in
`~/.irises/engine-onboarding.json`, keyed by engine name, so an unchanged message never sends twice
and editing one word re-sends on the next boot. A failed send retries at 30s / 2min / 10min and then
waits for the next boot. `ENGINE_ONBOARDING=off` disables the send entirely (for operators curating
the engine's instructions by hand); to send or read one by hand,
`npx tsx scripts/print-engine-doctrine.ts hermes|openclaw`. To remove the discipline, tell the agent
by chat to delete the section — same door out as in.

Duplicate protection differs by transport: OpenClaw's `agent` RPC takes a version-keyed
`idempotencyKey`, while the hermes API server has none — so the hermes message itself asks the engine
to **replace** any section with the same heading rather than append a second one.

**None of it is load-bearing.** Both adapters prepend a compact engine-mode header to *every*
delegated task — the invitation, the hard limits, the reply shape — so an engine that never got
onboarded, or forgot, still gets the essentials on every single run. Degraded, not broken.

## Run control

hermes's own CLI advertises busy-run controls (`msg=interrupt` · `/queue` · `/bg` · `/steer` ·
Ctrl+C cancel). Irises maps the ones that exist as HTTP onto its own run — hermes only, since
OpenClaw's gateway RPC has no equivalent surface:

- **Give-up = stop.** When the user cancels, or Irises's own leg budget times out, the engine-side
  run is stopped too: `POST /v1/runs/{run_id}/stop` (cooperative — hermes finishes what it's doing,
  then quits; it is not instant). This is the fix for the orphaned-leg bug: Irises used to just drop
  the connection, hermes kept the run going for minutes after the client had already given up, the
  eventual answer landed nowhere, and a retry could stack a second run onto the same session while
  the first was still working. Gated by `OPS_CANCEL_ENGINE_ABORT` (default on — see *Environment
  reference*); off reverts to the old drop-and-forget.
- **Mid-run additions ride `steer_research`.** The Convo tool posts `POST /v1/runs/{run_id}/steer`;
  hermes folds the text in before its next tool result or model call — it never interrupts
  generation. A steer hermes accepts *after* it already produced its final answer comes back on
  that run's own terminal frame as `pending_steer`, unapplied; Irises replays it once as a follow-up
  leg rather than dropping it, bounded to a single replay.
- **One SSE subscriber per run.** hermes pops the event queue the moment a subscriber detaches, and
  a reconnect on the same run 404s — so Irises never tries to reconnect a dropped stream. It polls
  `GET /v1/runs/{run_id}` instead until the run reaches a terminal status.
- **Redirect is cancel + fresh delegation, not a hermes primitive.** hermes's `redirect()` /
  `msg=interrupt` is CLI/TUI-only with no HTTP route. When what the user wants changes mid-run,
  Irises does `cancel_research` and `delegate_to_ops` in the same turn instead.
- **`/queue` and `/bg` have nothing to build.** Every Irises delegation already runs in the
  background, and a message that arrives mid-run is already folded into the follow-up leg — that
  is hermes's queue/bg behavior by construction, not something layered on top of it.
- **Caveats:** stop is cooperative, not instant — a run mid-tool-call can take a few seconds to
  actually quit. `waiting_for_approval` is a dead end on the poll path: nothing in Irises answers a
  hermes approval prompt, so such a run just burns its window and times out (with a stop still
  fired). A parked confirmation (Irises waiting on the user's yes/no for an action) is invisible to
  `steer_research` — it only reaches a run that is actually executing.

Grep the trace for what happened: `engine:hermes:run` (a run's `run_id` at submission — also
`engine:hermes:runs-unsupported` when `/v1/runs` 404s and the leg fell back to chat), `ops:cancelled`
(a stop was fired; `engineNotified` says whether hermes actually heard it), `ops:steer` (one steer
attempt, accepted or not), `ops:steer-replay` / `ops:steer-replay-result` (the follow-up leg run for
a `pending_steer`).

## First move (install introduction)

The engine has lived with this person for months; Irises has known them for zero seconds. Once per
install — after the doctrine above has landed, and retried on a sweep because `engine-setup.sh`
restarts the gateway *last* — she closes that gap herself: she **asks** the engine what it knows
about its user, folds the answer into her own memory, and then either texts them first or waits to
be texted. `FIRST_MOVE_ENABLED=false` turns the whole thing off (a silent install: no ask, no seed,
no introduction).

**What is asked.** One message, on its own session key so the ask never enters chat continuity,
carrying the text in `src/agents/ops/firstMoveAsk.ts` (the canonical wording — read it with
`npx tsx scripts/preview-first-move.ts`). It asks the engine to consult *its own* memory and
channels and reply with ONLY a fenced JSON block: a 3-6 sentence brief, a name, up to five **light**
details (never health, relationships, work stress, money or private struggles), and the one DIRECT
1:1 chat where the two of them actually talk — with `has_history` true *only* if messages were
really exchanged in that exact chat, false when unsure. Unknown is `null`; inventing a value is
forbidden. The ask is content-hashed like the doctrine, so editing it re-pulls on the next boot
while an unchanged one never asks twice.

**What is seeded** (`src/memory/seedFromEngine.ts`), keyed on the bridge handle
`eng:<platform>:<chat_id>`: a first `LONG.md` dossier, the user's name on their profile row, one
medium-tier fact holding the details, and up to two thread themes minted through the normal harvest
path (so a seeded theme is byte-identical to one she noticed herself, and just as unsurfaceable
until a second day's evidence arrives). Two honesty rules run through all of it. It is written
**only into empty memory** — earned memory always outranks a seed, which doubles as the idempotency
test — and **the provenance travels with it**: the dossier says in its own text that this picture
came second-hand from the engine at install, and a standing note tells her to hold it lightly,
verify it naturally in conversation, and never cite it as something they told her.

**Send, or wait.** She texts first (proactive kind `introduction`) **only** when the engine
confirmed `has_history` on a valid channel. Every other outcome — history not confirmed, no channel
in the reply, an unparseable reply, or 24h of failed pulls — arms *nudge mode* instead: **no cold
text is ever sent**, and the introduction rides her reply to the user's own first message. That
asymmetry is the spam-flag rule (iMessage being the motivating case), and it fails toward silence by
construction: `has_history` is coerced to a strict boolean, and anything that is not literally
`true` is false. Nudge mode also covers the case where she was seeded against a predicted handle and
the real inbound arrives on a different one — the seed is re-run against the handle that actually
wrote in. Either way the introduction happens, grounded or not: with an empty profile she introduces
herself ungrounded rather than not at all.

**This is the sanctioned reverse flow, not a new one.** Per *Memory boundary* below, Irises never
reads engine storage: the profile arrives as a **chat reply the engine composed itself**, exactly
like `update_memory` travels outward as a request rather than a write. And it arrives
as *untrusted input* — the reply is sanitized at the door (headings and scope sections stripped so a
reply cannot legislate what she refuses to do, brackets and fences removed because these strings are
quoted into prompts, hard caps on every field, non-`true` history coerced to false) before one
character of it reaches a prompt or a memory tier. Influence through Irises's own pipeline; Irises
decides and writes.

**One-shot, and it stays that way.** State lives in `$IRISES_HOME/first-move.json` (default
`~/.irises`), keyed by engine name, claimed *before* the send. It survives restarts and
`scripts/update.sh`, and an `--uninstall` without `--purge-data` — none of which touch
`$IRISES_HOME` — so the introduction can never fire twice. Deleting the file by hand is the only way to make
her do it again. `ENGINE_ONBOARDING=off` only removes the wait-for-doctrine gate (the first move
still runs); `CONVO_THREADING_ENABLED=false` only skips the seeded themes.

## Bridge mode — Irises on EVERY engine channel

The engine already speaks WhatsApp, Signal, Discord, Slack, LINE, email, … Bridge mode puts
Irises's voice in front of any of those chats **without the engine giving anything up**: a tiny
plugin (shipped in this repo, installed through the engine's own official plugin system — engine
code stays byte-for-byte untouched) forwards each fronted inbound message to Irises and suppresses
the engine's own reply; Irises answers back out **through the engine's connection**. New platforms
the engine gains later are fronted the same way — the plugin is platform-agnostic.

```
 user on WhatsApp/Signal/Discord/LINE/… ──▶ ENGINE gateway (owns the connection)
                                                │ inbound
                                     [irises-bridge plugin]        ← ships in bridge/,
                                       fronted chat?                 installed by
                                        │yes          │no            engine-setup.sh
                                        ▼             ▼
                          forward to Irises      fall through →
                          suppress engine reply  engine answers itself
                                        │
                  POST /api/bridge/inbound  (x-bridge-token = ENGINE_PUSH_TOKEN)
                                        ▼
                    Irises: Convo (instant voice) → engine seam (deep work)
                                        ▼
                    outbound, back through the engine:
                      hermes  → POST :8655/send → gateway.adapters[platform].send()
                      openclaw→ gateway WS `send` RPC (the client Irises already holds)
                                        ▼
                          engine delivers on the SAME channel → user
```

**Mechanisms** (both are documented, public plugin surfaces): hermes — the `pre_gateway_dispatch`
hook (fires for every non-internal inbound message on every platform before auth/dispatch;
returning `skip` suppresses the reply; exceptions fall through to normal dispatch). OpenClaw —
the `before_dispatch` hook (global claiming hook consumed before model dispatch; `{handled: true}`
completes the turn with no agent run; slash commands are explicitly passed through so `/status`
etc. stay with the operator).

### Choosing what Irises fronts

Fronting is **opt-in per chat/platform** and lives in the ENGINE's environment (the plugin must
decide instantly, without calling home):

```
IRISES_FRONT=telegram:*,whatsapp:+1555*,discord:12345
```

Comma-separated glob patterns matched (case-insensitively) against `<platform>:<chat_id>`
(hermes) / `<channel>:<conversation>` (OpenClaw). **Unset or empty = front nothing** — the plugin
is inert and the engine behaves exactly as before. On **hermes** the installer does not leave it
empty: it writes `IRISES_FRONT` into `~/.hermes/.env`, so fronting is live as soon as the gateway
comes back. On **OpenClaw** it writes nothing — it prints this variable (with `IRISES_BRIDGE_TOKEN`
and `IRISES_URL`) for you to set on the gateway process, so an OpenClaw install fronts nothing until
you do. Never pattern your operator/control chats unless you mean it: a fronted chat talks to Irises,
not to the engine.

**It is now a question the install asks**, rather than a value you discover afterwards: the menu's
install wizard offers every chat, only the chats you name, or nothing at all, and the flag form is
`--front 'telegram:*,whatsapp:+1555*'` (`IRISES_FRONT_PATTERN` in the environment). Each
comma-separated item has to be `<platform>:<glob>`; anything else is a usage error that changes
nothing. The default is `*:*` — what every install has written since there was an installer — so a run
that passes no pattern behaves exactly as before, warning included. Choosing nothing at all is
`--no-bridge`: no plugin, no fronting, deep work only. Whatever you pick is recorded in the manifest,
and none of this changes the engine-side variable's own rules: it is still one line in the engine's
environment that you can widen, narrow or blank by hand at any time.

### Failure policy

**Fail-open by default**: if Irises is unreachable (down, deploying, network), the engine answers
fronted chats itself — the user gets a reply in the engine's persona rather than silence. Set
`IRISES_BRIDGE_FAIL=closed` in the engine's environment to prefer silence over a persona glitch.

The hermes plugin decides that from a reachability verdict it keeps live: a `GET /health` probe every
15s plus the outcome of every inbound forward (3 attempts, 0.5s/2s backoff). A confirmed-unreachable
Irises makes the hook return the turn to hermes; anything else — including a gateway that has just
started and tried nothing yet — fronts as normal. So the first message after Irises dies mid-forward
can still be lost (it is logged at ERROR), and everything after it goes to hermes.

### Engine-side environment (set where the GATEWAY runs)

| Key | Default | Meaning |
|---|---|---|
| `IRISES_FRONT` | `*:*` on a hermes install (the installer writes it); on OpenClaw it is *printed for you to set* — and *unset or empty = front nothing*, wherever you set it by hand | comma-separated glob patterns choosing fronted chats. Change it later from the Irises clone with `bash ./scripts/configure.sh --front '<patterns>'` (or `--front none`), which on a hermes install rewrites this key in the engine's `.env` and bounces the gateway. On OpenClaw there is no file for it to edit — the gateway reads its own process environment — so the same command only PRINTS the line for you to set there, and changes nothing; editing the file (or the process environment) yourself and restarting the gateway is the fallback |
| `IRISES_BRIDGE_TOKEN` | — | shared secret; must equal Irises's `ENGINE_PUSH_TOKEN`. Required: unset, the hermes listener still binds but refuses every send with a 403 naming the missing variable (a misconfiguration you can read, instead of anonymous sends on loopback) |
| `IRISES_URL` | `http://127.0.0.1:3000` | where the plugin POSTs inbound messages |
| `IRISES_BRIDGE_FAIL` | `open` | `open` = engine answers on bridge failure; `closed` = silence |
| `IRISES_BRIDGE_PORT` | `8655` | hermes only: loopback listener for Irises's outbound sends |
| `IRISES_BRIDGE_WORKERS` | `2` | hermes only: forward workers / queue shards (a chat is pinned to one, so its messages stay ordered) |
| `HERMES_GATEWAY_BUSY_ACK_ENABLED` | `true` | hermes's OWN var (set in `~/.hermes/.env`): `false` silences the "⚡ Interrupting current task" / queued / steered busy acks globally. Recommended `false` for fronted chats, which do their own batching |

`BRIDGE_TYPING` is set on the **Irises** side (not the gateway): `off` by default; `on` forwards a
typing indicator to the platform through the engine adapter's own chat-action. It's feature-detected in
the plugin — if the adapter has no chat-action, it's a safe no-op (the plugin logs, per platform, whether
it found one). With `BRIDGE_TYPING=off`, replies also land quicker because the per-bubble simulated-typing
hold (invisible without dots) is skipped.

Irises ends every reply with an **explicit typing stop**, then a second guarded stop
`TYPING_TRAILING_STOP_MS` later (default 4500ms). Photon's indicator is stateful — it stays on until
something turns it off — so unlike the web channel, sending the last bubble does not clear it; and
because "start typing" is fire-and-forget through a gateway leg that can take seconds (both sides time
out at 3s), a start issued just before the final send can land *after* the first stop. The trailing
stop catches that one, and is skipped if a new turn has asserted dots in the meantime. Raise
`TYPING_TRAILING_STOP_MS` if your gateway's typing round trip is slower than 3s; it must stay above it.

On the Irises side, `HERMES_BRIDGE_URL` (default `http://127.0.0.1:8655`) points at that hermes
loopback listener; OpenClaw needs nothing extra (outbound rides the existing gateway WS client).

### Caveats you should actually read

- **Engine admission filters run BEFORE the bridge hook.** hermes `require_mention` /
  `allowed_chats` / `ignored_channels` and OpenClaw `dmPolicy` / `groupPolicy` / `requireMention`
  drop messages before the plugin ever sees them. For "Irises sees every message in this chat",
  widen those per-channel gates — and understand what that means: **`IRISES_FRONT` (plus Irises's
  own behavior) becomes the gate** for those chats. Widen admission only for chats you front.
- **hermes**: `HERMES_SAFE_MODE=1` disables all plugins — the bridge silently stops fronting
  (fail-open: hermes answers). The skipped inbound is not written to hermes's own chat history.
- **OpenClaw**: registering `before_dispatch` changes restart-recovery chat admission (the gateway
  defers `before_agent_reply` until after its durable checkpoint — upstream-documented behavior).
  Turns claimed by the bridge are recorded as `before_dispatch_handled`.
- **Media on split hosts**: hermes forwards media as LOCAL cached paths — fine when Irises and the
  engine share a box (the engine re-reads them during deep work); cross-host media is a v2 item.
- **Plugin API stability**: hook names/payloads are public plugin surfaces but less contractual
  than the OpenAI-compat API. Each plugin is ~150 lines pinned to the engine version in this repo;
  if an upstream rename ever lands, it's a small fix — and Irises's own channels keep working
  regardless.
- **Loops**: the bridge only ever forwards *inbound* user messages; Irises's replies leave through
  the engine's outbound path, which does not re-enter the inbound hooks.
- **The engine's "⚡ Interrupting current task" notice**: when a new message lands while a chat's
  gateway session is still busy handling the previous one, hermes (not Irises) emits that notice from its
  per-chat serialization guard (`_active_sessions[session_key]`). It fires on *any* rapid second inbound,
  and the bridge's inbound skip cannot stop it — the busy ack is pushed straight through the adapter with
  no plugin hook on that path (verified against hermes's `VALID_HOOKS`). The only reliable suppression is
  hermes's own env switch **`HERMES_GATEWAY_BUSY_ACK_ENABLED=false`** in `~/.hermes/.env` (it silences ALL
  busy acks — interrupt/queued/steered/redirected — globally; real interrupts still happen, just
  silently). OpenClaw additionally has a `before_agent_reply` hook the bridge claims for fronted chats.
- **Reply-to context**: the plugins forward the quoted message's text (`reply_to_text`, when the engine
  event carries it) and a per-message `timestamp` alongside the reply id, so Irises can show what was
  replied to and stamp the real send time even when it can't resolve the id locally.
  **On Photon/iMessage the engine's own plugin drops the linkage before the bridge ever sees it**:
  Apple's `replyTargetGuid` dies inside the Photon plugin's Node sidecar (the spectrum-ts provider
  builds the message without it), so a tapped reply reaches Irises looking like a plain new message.
  Fixing it needs a patch applied to the Hermes checkout, shipped in
  [`bridge/hermes/photon-reply-context/`](../bridge/hermes/photon-reply-context/) — run its `apply.sh`
  on the Hermes host, restart the gateway, and confirm with the sidecar's line
  `photon-sidecar: inbound reply -> target …` in `~/.hermes/logs/gateway.log`. No Irises code is
  involved; the other channels were never affected.

### Install / uninstall

`bash ./scripts/engine-setup.sh --engine hermes|openclaw` sets bridge mode up as part of the install:
it copies the plugin (via `~/.hermes/plugins/` or `openclaw plugins install`), prints every change
before making it, and restarts the engine gateway at the end so all of it takes effect. The
engine-side wiring then splits by engine:

- **hermes** — the installer writes the token and `IRISES_FRONT=*:*` into `~/.hermes/.env` itself
  (after a backup), and records every key it added in `~/.irises/install-manifest.json` so the
  uninstall can undo exactly those. Fronting is live as soon as the gateway comes back.
- **OpenClaw** — the installer changes no OpenClaw config. It prints the three variables the
  **gateway process** needs in its own environment — `IRISES_BRIDGE_TOKEN` (its value is
  `ENGINE_PUSH_TOKEN` in the Irises `.env`, mode 600; the script deliberately does not print the
  secret, because its output gets pasted into chats and issues), `IRISES_URL`, and `IRISES_FRONT` —
  and stops there. Until you set them and the gateway comes up with them, nothing is fronted.

`--no-bridge` installs Irises without the plugin or the fronting; the gateway is still restarted so
the engine picks up its API-server setting.

Taking it out again, in order of how much you want gone:

- **Pause fronting:** blank `IRISES_FRONT` on the engine side and bring the gateway back. The plugin
  stays installed and goes inert, but not before that restart: the value is read out of the gateway
  process's environment when it starts, and nothing reloads it underneath a running gateway. From
  the Irises clone, `bash ./scripts/configure.sh --front none` does both halves for you — it writes
  the empty value into the engine's `.env` (after a backup) and bounces the gateway; `--front
  '<patterns>'` narrows it to the chats you name instead. The hand edit plus your own restart
  remains the fallback, and on OpenClaw — where the gateway reads its own process environment rather
  than a file this script can edit — it prints the line for you to set there yourself.
- **Disable the plugin:** `hermes plugins disable irises-bridge` /
  `openclaw plugins disable irises-bridge`, then bring the gateway back the way you normally would.
- **Detach from the engine:** `bash ./scripts/engine-setup.sh --detach-engine` — undo every
  engine-side change and keep Irises. The plugin directory is removed, every key the manifest records
  as added is removed, every key it records as retargeted is restored from the recorded backup,
  `IRISES_FRONT` is unset, and the gateway is bounced: **the engine is left as if Irises had never
  been installed, except that the `.bak-irises-*` backup files stay.** The Irises service, this clone
  and `$IRISES_HOME` are untouched — she keeps running, with no engine in front of her, and you can
  install onto the same engine again later. Afterwards the manifest is rewritten with nothing recorded
  as added or retargeted, so a later `--uninstall` is a no-op on the engine: it removes no key and
  bounces no gateway. A detach never touches your data, and the data flags do not apply to it — pass
  `--archive-data` or `--purge-data` with it and they are ignored. The run ends `RESULT: detached`.
  An install whose engine-side keys were never written (`--engine-env print`, or a declined `ask`) has
  nothing in that file to restore, and the detach says so rather than editing it.
- **Remove Irises entirely:** `bash ./scripts/engine-setup.sh --uninstall` — stops and unregisters
  the user-level service, removes the plugin, removes the engine-side keys the installer added (from
  the manifest, after a backup of the engine's env file), bounces the gateway **only when it actually
  removed something** (so a second run on an already-clean box cycles nothing), and keeps your data
  under `$IRISES_HOME`. Add `--purge-data` to delete that too, and `--archive-data` to tar it to
  `~/.irises-backup-<timestamp>.tar.gz` first — nothing is deleted if that archive cannot be written.

The menu (`bash ./scripts/irises.sh` → **Uninstall**) is this same ladder, one rung per entry, plus
stopping the service and leaving everything else in place; it asks about the archive before the purge
and requires the deletion to be typed out in words. All of these are run from a terminal on the
engine's own machine (Git Bash or WSL2 on Windows). The
installer and the uninstaller both cycle the gateway, which is exactly why neither can be run from a
gateway-hosted chat: the agent would be killing its own supervisor mid-turn. The two setup skills are
guides for that reason — they hand the person the commands and verify afterwards, and run nothing
themselves.

### Gateway restart notifications

Install, update and uninstall each end by restarting the engine gateway, and hermes announces its own
return: **"♻️ Gateway online — Hermes is back and ready."**, posted to the user's home channel after
every restart. That message is hermes's, not Irises's — she does not send it and cannot suppress it.

If the user would rather not see it, hermes silences it per platform with

```yaml
<platform>.gateway_restart_notification: false
```

in hermes's own config. Irises never edits hermes's config, and neither the installer nor the setup
skills will touch it, so this is always the operator's own change to make.

## Where to talk to what

```
 TERMINAL
 ├── hermes                    → your engine, directly (unchanged)
 │   openclaw dashboard / tui  → your engine, directly (unchanged)
 └── npm run chat              → Irises (the same brain, from your shell)

 BROWSER   http://localhost:3000        → Irises web chat (DEBUG_TOKEN-gated)
 ANY ENGINE CHANNEL matching IRISES_FRONT → Irises (bridge mode; engine keeps the connection)
```

## Proactive messages (reminders, watched email)

Scheduling lives ON THE ENGINE (its cron), not in Irises. When you ask Irises for a reminder,
it creates an engine cron job whose prompt ends with "deliver the result to Irises"; when the job
fires, the engine does any work needed and POSTs to Irises, which voices it to your chat:

```
 engine cron fires ──▶ engine agent run ──▶ POST /api/engine/push ──▶ Composer/Fallfirm
                        (tools, email,       (x-engine-token)          voice it → your chat
                         research)
```

- `ENGINE_PUSH_TOKEN` guards that endpoint — it can make Irises speak, treat it as a credential.
- Engine-side email watching (the old "flag important mail" feature) is configured on the engine
  (hermes: its email skills + a cron job that ends with the same POST) — see the prompt templates
  the script prints, or write your own; the body contract is
  `{"chatId": "...", "kind": "reminder"|"email"|"memo", "text": "..."}`.
- **v1 gap:** reminders require the hermes engine — the OpenClaw cron wiring is pending (its
  `cron.add` RPC payload needs live verification). On the OpenClaw lane the three reminder tools
  are **not offered to the model at all**, so Irises never confirms a reminder that can't fire; ask
  for one and she says honestly that it isn't hers to set yet. Everything else works on OpenClaw —
  deep work there runs **full-reach**: real code, its own skills, parallel subagents, artifacts.

## Memory boundary (Irises ↔ engine)

Two memories exist side by side, on purpose, with a one-way contract:

- **Irises's own memory** — the short/medium/long tiers, profiles and prefs under
  `IRISES_HOME` (default `~/.irises`): SQLite for machine data, per-handle markdown under
  `memories/` for the curated tiers. Private to Irises and its agents (`0700` dirs);
  it is **never** inside the engine's workspace, and no engine code path can write it.
- **The engine's memory** — whatever the engine keeps for its own sessions (hermes
  `memories/MEMORY.md`/`USER.md`, OpenClaw's workspace + memory index). Irises never
  writes engine storage directly. It **asks**: the `update_memory` tool
  sends a natural-language request through the chat's engine session (`remember()` in
  `src/agents/ops/engineBackend.ts`), and the engine's own memory loop decides what to
  keep, change, or drop.

The one sanctioned reverse flow is *influence, not access*: engine task results land in
Irises's short tier (and can be promoted by Irises's own tools), but the content passes
through Irises's pipeline and injection defenses first — Irises decides and writes.

## Environment reference

All of these are **auto-derived at boot** when an engine is present (see *Zero-config discovery*
above) — set one only to override it.

| Key | Mode | Meaning |
|---|---|---|
| `OPS_BACKEND` | both | `hermes` \| `openclaw` — **auto-detected**; set to force one. Unset + none found = deep work offline (Convo still chats) |
| `ENGINE_MODEL_INHERIT` | both | `off` to stop Irises's voice inheriting the engine's model (default on) |
| `HERMES_BASE_URL` | hermes | default `http://127.0.0.1:8642` |
| `HERMES_API_KEY` | hermes | the `API_SERVER_KEY` from `~/.hermes/.env` — auto-reused |
| `HERMES_CAPABILITIES` | hermes | optional comma list from `web,inbox,files,code,media,scheduling` — the operator's declaration of what this engine can do. Live discovery (`/v1/toolsets`) **overrides** it; the declaration covers the cold cache at boot and an engine that is down. Unset = unknown |
| `OPENCLAW_URL` | openclaw | default `ws://127.0.0.1:18789` |
| `OPENCLAW_TOKEN` | openclaw | `gateway.auth.token` from the OpenClaw config — auto-reused |
| `OPENCLAW_AGENT_ID` | openclaw | default `main` (also picks which agent's model is inherited) |
| `OPENCLAW_CAPABILITIES` | openclaw | same closed vocabulary as `HERMES_CAPABILITIES`. OpenClaw has no discovery path yet, so this is the ONLY source there. Unset = unknown |
| `ENGINE_ONBOARDING` | openclaw, hermes | `off` disables the boot onboarding send (see *Engine onboarding* above) |
| `FIRST_MOVE_ENABLED` | both | default **on**; `false` disables the one-time install introduction entirely — the engine memory pull, the memory seed and her first text (see *First move* above) |
| `ENGINE_PUSH_TOKEN` | both | guards `POST /api/engine/push` AND `POST /api/bridge/inbound` (generated by setup) |
| `HERMES_BRIDGE_URL` | hermes | bridge mode outbound: the plugin's loopback listener (default `http://127.0.0.1:8655`) |
| `HERMES_RUN_TRANSPORT` | hermes | `runs` (default) \| `chat` — which transport a delegated leg speaks. `runs` = `POST /v1/runs` + SSE events (stop/steer reach an in-flight run — see *Run control*); `chat` forces the old blocking `POST /v1/chat/completions` body, no run control. Falls back to `chat` on its own for an image-bearing task, a 404 on `/v1/runs`, or a capability manifest saying the runs API isn't there — only the literal word `chat` turns it off, so a typo fails safe toward keeping run control |
| `HERMES_STREAM` | hermes | `on` streams the research completion (SSE) for a live progress heartbeat on long runs; default `off`, with a safe fallback to the blocking read when the endpoint doesn't stream. **Only affects the `chat` fallback** — the default `runs` transport already streams via `/v1/runs/{id}/events` regardless of this flag. An image-bearing task (always on `chat`) streams even with the flag off: hermes interrupts a chat run only when a streaming client disconnects, so that is how a cancel stops it |
| `OPS_CANCEL_ENGINE_ABORT` | both | default **on**; on give-up (user cancel or Irises's own leg timeout) also notifies the engine so it stops working too — hermes `POST /v1/runs/{id}/stop`, OpenClaw's abort+notify RPC. Anything but `true`/`1`/`on`/`yes` turns it **off**, reverting to dropping the connection locally without telling the engine (the old behavior, and the orphaned-run bug this exists to fix) |
| `BRIDGE_TYPING` | both | `on` forwards a typing indicator through the engine adapter's chat-action (feature-detected, safe no-op otherwise); default `off` — which also makes replies snappier (skips the invisible per-bubble typing hold) |
| `TYPING_TRAILING_STOP_MS` | both | `4500`: how long after a reply's explicit typing stop the guarded second stop fires, catching a fire-and-forget "start" that crossed the gateway *after* it. Must exceed the 3s typing round-trip timeout on both sides; only matters where the indicator is stateful (Photon) |
| `ENGINE_TIMEOUT_MS` | both | per-engine-call budget (default: `OPS_TASK_TIMEOUT_MS` − 15s) |
| `ENGINE_MAX_CONCURRENT` | both | simultaneous engine agent runs (default 3); a further run queues, then fails honestly. Match it to the engine's own concurrent-run cap |
| `IRISES_FRONT` | bridge | engine-side glob list choosing fronted chats (e.g. `telegram:*`) — set where the gateway runs |
| `IRISES_FRONT_PATTERN` | install-time | the env form of the installer's `--front`: which pattern a hermes install writes into `IRISES_FRONT` (default `*:*`). Read by the setup script only; the running server never looks at it |
| `IRISES_MODEL_API_KEY` | install-time | the key for `--model-lane`, read by the setup script from the environment and nowhere else — never a flag, never printed, never logged. It lands in this clone's `.env` under the lane's own key name |
| `IRISES_DASHBOARD_PASSWORD` | install-time | same rule, for the admin dashboard: read from the environment only, written into this clone's `.env` (mode 600) as `DASHBOARD_PASSWORD`, never printed. Unset changes nothing about the dashboard |
| `WEB_ENABLED` · `IRISES_TZ` | — | this clone's own settings, which the install can write for you (`--web on|off`, `--tz ZONE`): the browser/CLI debug chat, and the wall clock Irises reads. Unset, they keep their usual defaults — the chat on, the clock the host's own zone |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | — | Irises's own voice models (setup reuses the engine's when present) |

## Security notes (read before exposing anything)

- **The engine credential is operator-grade.** `API_SERVER_KEY` / the gateway token grant the
  engine's FULL toolset — on default engine configs that includes a real shell on the host. Keep
  both engines loopback-only (the defaults) and never expose :8642 / :18789 publicly.
- **Prompt injection reaches a capable agent.** Whatever users text Irises is distilled into
  engine prompts. If people other than you can reach a fronted chat, consider your engine's
  sandboxing options and keep `IRISES_FRONT` tight.
- **Engine memory scope:** hermes scopes per-chat memory via session keys. OpenClaw's curated
  memory files are per-agent — all Irises chats share one engine-side user model there. The
  onboarding leans into that rather than fighting it: it instructs OpenClaw to keep a SINGLE
  per-agent model of the user, because Irises fronts one person.
- The engine can only make Irises SPEAK via the push endpoint with the right token; it can never
  read Irises state or act as a user.

## Troubleshooting

- *"ran into a problem completing that" on every deep question* — the engine is unreachable.
  Hermes: is `hermes gateway` running, and was it restarted after `API_SERVER_ENABLED=true`?
  Check `curl -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:8642/v1/capabilities`.
  OpenClaw: is the gateway up (`openclaw gateway status`)? Is `@openclaw/gateway-client` installed?
- *Reminders never fire* — hermes engine only (v1); check `GET /api/jobs` on the hermes API for
  the job, and that `ENGINE_PUSH_TOKEN` in the job's environment matches Irises's `.env`.
- *The engine ignores the output contract / narrates its process* — check the onboarding actually
  landed: the `engine:openclaw:onboarded` / `engine:hermes:onboarded` trace event in `/debug`, and a
  record under that engine's key in `~/.irises/engine-onboarding.json`. Re-send by deleting that file
  and rebooting Irises. On hermes you can also confirm by hand: grep its SOUL.md for
  `## Engine mode`, and re-send with
  `npx tsx scripts/print-engine-doctrine.ts hermes` (the curl is in
  `bridge/hermes/engine-onboarding-message.md`).
- *Irises says it can't look at their email, or won't take a file* — read the capability line it is
  working from. hermes discovery reads `GET /v1/toolsets`; a stock hermes has **no email tool at
  all**, so `inbox` can only come from a plugin toolset or from an explicit `HERMES_CAPABILITIES`
  declaration. Check `curl -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:8642/v1/toolsets`
  and confirm the toolset you expect is `enabled` **and** `configured`.
- *Deep answers time out* — engines can take minutes on hard tasks. Raise `OPS_TASK_TIMEOUT_MS`
  (and `ENGINE_TIMEOUT_MS` follows it) if your engine's typical runs exceed 4 minutes.
- *Bridge mode: engine still answers a chat I fronted* — pattern mismatch (check the gateway log:
  the hermes plugin logs its active patterns at registration) or the plugin isn't enabled
  (`hermes plugins list` / `openclaw plugins list`), or `HERMES_SAFE_MODE=1` is set. Patterns match
  the FULL `<platform>:<chat_id>` string, lowercase.
- *Bridge mode: nobody answers a fronted chat* — Irises can't deliver back. hermes: is the loopback
  listener up (plugin logs "outbound listener on 127.0.0.1:8655") and does `HERMES_BRIDGE_URL`
  point at it? OpenClaw: is the gateway WS reachable with `OPENCLAW_TOKEN`? Also check that
  `IRISES_BRIDGE_TOKEN` on the engine equals `ENGINE_PUSH_TOKEN` in Irises's `.env` — the inbound
  door 403s on mismatch (`bridge:inbound` events appear in `/debug` traces when forwarding works).
