# Configuration reference

> This page was moved out of the README on 2026-09-19 and keeps the original, longer wording. hermes-agent is the tested engine. Every OpenClaw path described here is written but **untested** against a live gateway.

## Configuration

**On top of an engine you normally set none of this** — Irises auto-detects the backend, reuses the engine's key, and inherits its model (see [Models](#models)). Everything here is optional override. The supported way to change any of it on an installed box is the menu's **Configure** entry or `bash scripts/configure.sh` ([Changing settings after the install](INSTALL.md#changing-settings-after-the-install)), which previews the edit, backs the file up and restarts into it; editing `.env` by hand and restarting her yourself is still perfectly fine. Config is environment variables, layered lowest → highest: `deploy/app.env` (committed, non-secret baseline) loads first, then **engine auto-discovery** fills in / updates what it can from your engine, then your local `.env` layers on top and wins over both. The knobs you're most likely to touch:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` · `OPENROUTER_API_KEY` · `OPENAI_API_KEY` | The three LLM lanes (`OPENAI_BASE_URL` points the generic one) — auto-reused from the engine when present; set to override |
| `OPS_BACKEND` | `hermes` or `openclaw` — **auto-detected**; set to force one. Unset + no engine found = deep work offline (Convo still chats) |
| `HERMES_BASE_URL` · `HERMES_API_KEY` | hermes-agent's OpenAI-compatible API server + cron REST |
| `OPENCLAW_URL` · `OPENCLAW_TOKEN` | OpenClaw gateway WebSocket |
| `ENGINE_PUSH_TOKEN` | One secret guarding both engine-facing routes (push + bridge inbound) |
| `IRISES_HOME` · `DATA_BACKEND` | State dir (default `~/.irises`) · `memory` = ephemeral run |
| `IRISES_TZ` | Your wall clock (IANA zone) when the box lives somewhere you don't — a VPS in another region, a container on UTC. Default: the host's zone |
| `WEB_ENABLED` · `DEBUG_TOKEN` | Web debug chat (browser + `npm run chat` CLI) + its access gate |


### Full configuration reference



**Engine (the deep half)** — see [docs/ENGINES.md](ENGINES.md)

| Variable | Purpose |
|----------|---------|
| `OPS_BACKEND` | `hermes` \| `openclaw`; **auto-detected at boot** from the installed engine — set to force one. Unset + none found = deep work offline, no local fallback. |
| `ENGINE_MODEL_INHERIT` | `off` to stop Irises's voice roles inheriting the engine's model and keep its own shipped models (default: on). |
| `HERMES_BASE_URL` · `HERMES_API_KEY` | hermes API server (default `http://127.0.0.1:8642`) and its `API_SERVER_KEY` (auto-derived from `~/.hermes/.env` when unset). |
| `OPENCLAW_URL` · `OPENCLAW_TOKEN` · `OPENCLAW_AGENT_ID` | Gateway WS (default `ws://127.0.0.1:18789`), auth token, agent (default `main`). |
| `HERMES_CAPABILITIES` · `OPENCLAW_CAPABILITIES` | Optional comma list from `web,inbox,files,code,media,scheduling` — what the operator declares the engine can do, so Irises never promises more. On hermes, live `/v1/toolsets` discovery overrides it; on OpenClaw it is the only source. Unset = unknown. |
| `ENGINE_ONBOARDING` | `off` disables the one-time engine-mode onboarding sent at boot (both engines). |
| `FIRST_MOVE_ENABLED` | `false` skips the one-time install introduction (engine memory pull + her first text). One-shot state lives in `$IRISES_HOME/first-move.json`, so restarts and updates never re-fire it. |
| `ENGINE_PUSH_TOKEN` | Shared secret for `POST /api/engine/push` (`x-engine-token`) **and** `POST /api/bridge/inbound` (`x-bridge-token`). Unset = loopback-only. |
| `ENGINE_TIMEOUT_MS` · `ENGINE_MAX_CONCURRENT` | Per-call budget (default `OPS_TASK_TIMEOUT_MS − 15s`) and the engine-call semaphore (default 2). |
| `HERMES_RUN_TRANSPORT` | `runs` (default) \| `chat` — which transport a hermes delegation speaks. `runs` = `POST /v1/runs` + SSE events, the one that lets stop and `steer_research` reach an in-flight leg; `chat` = the old blocking `/v1/chat/completions` body, no run control. Falls back to `chat` on its own for an image-bearing task or a hermes with no runs API. |
| `OPS_CANCEL_ENGINE_ABORT` | On give-up (user says stop, or Irises's own leg timeout) also tell the engine to stop working — hermes `POST /v1/runs/{id}/stop`, OpenClaw's abort RPC. `off` reverts to dropping the connection locally (the orphaned-run bug this exists to fix). Both engines. Default on. |
| `OPS_APPROVAL_GATE` | Park a delegation that would act in the world until the user says yes in that chat. `off` = kick it off immediately, no question, no parked row. Default on. |
| `HERMES_BRIDGE_URL` · `IRISES_PUSH_URL` | Where Irises sends bridge replies (default `http://127.0.0.1:8655`) and the push URL embedded in engine cron jobs. |

**Channels**

| Variable | Purpose |
|----------|---------|
| `WEB_ENABLED` · `WEB_DEBUG_HANDLE` · `WEB_DEBUG_CHAT_ID` | Web channel toggle + its synthetic single-user identity (browser chat and the `npm run chat` CLI). |

**Data, access, and behavior**

| Variable | Purpose |
|----------|---------|
| `IRISES_HOME` · `DATA_BACKEND` | Where the local store lives (SQLite + memory markdown); `memory` = ephemeral. |
| `IRISES_CYCLE_ANCHOR` | "Day 1" of the hidden 28-day affect cycle (ISO date, default `2026-01-01`). Never surfaced to the user; only sets the mood-baseline phase math. |
| `IRISES_TZ` | IANA zone for the user's wall clock: every clock the Convo model reads (the current time, transcript stamps, "your last one at", the daypart words), the overnight quiet hours (9pm–8am), and any reminder set without naming a zone. Default: the host's own zone, then UTC. A per-user `agent_tz` saved from chat still wins over it. |
| `DEBUG_TOKEN` | Gates `/debug` **and** the web chat endpoints (unset = localhost-only). |
| `DASHBOARD_PASSWORD` | Gates `/dashboard`. **Has a built-in default — set your own before exposing the port.** |
| `PORT` · `NODE_ENV` | Listen port (3000 dev, 8080 in the image) and persona caching mode. |
| `<ROLE>_PROVIDER` · `<ROLE>_MODEL` · `<ROLE>_MODEL_OPENROUTER` · `<ROLE>_MAX_TOKENS` · `<ROLE>_EFFORT` · `<ROLE>_THINKING` | Per-role model routing and reasoning knobs (see below). |
| `OPS_TASK_TIMEOUT_MS` · `OPS_RETRY_ENABLED` · `OPS_PROGRESS_*` · `OPS_MAX_PROGRESS_PINGS` | Delegation deadline (4 min), the single cheap retry, and the "still on it" ping throttle. |
| `ROUTING_GATE` | `off` disables the grounding screen that forces data questions through the engine. |
| `CONVO_ROUTING_GATE_MEMORY_AWARE` | `off` makes that screen text-only again: it stops standing down for a data question she answered off something she already holds, and a delegation stops carrying what she holds to the engine (it rides beside the brief, in the task's own field, never inside it). Default on. |
| `CONVO_HOOKS_ENABLED` | The idle-turn machinery: the idle gate, the hook selector and kill switch, the per-turn hooks section and its craft page, and the quiet re-ask. `off` removes the machinery, not the character (that is a branch). Default on. |
| `CONVO_SHARE_TURNS_ENABLED` | The third turn shape. A message that hands her something and asks for nothing is a share, and she answers it as one, with at most one follow-up question her mood allows. `off` answers a share flat as a task, exactly as before. Subordinate to `CONVO_HOOKS_ENABLED`. Default on. |
| `LEAF_EXAMPLES_EXTRA` | Not a switch: extra comma-separated tokens for the idle gate's English fast path, read at call time. Adding one only ever widens the free path; the classify layer still catches what the examples miss. Empty by default. |
| `REFUSAL_FLOOR` | `off` disables the screen that catches a reply falsely claiming it can't reach something the engine can, and delegates instead. |
| `MEMORY_PROVENANCE_ENABLED` | Stamp every durable fact `stated` \| `seeded` \| `inferred` so a guess is never cited as testimony. **Default off** — the one default-off switch in the focus set, because it changes what a memory file contains (the read side parses stamps either way). |
| `BATCH_SETTLE_MS` · `TYPING_CPM` · `TYPING_DELAY_MAX_MS` · `TYPING_TRAILING_STOP_MS` | Batching + simulated-typing pacing, and the guarded trailing typing-stop that keeps a stateful indicator (Photon) from burning after a reply. |
| `LLM_DAILY_TOKEN_CAP` · `OPS_TASK_TOKEN_BUDGET` · `LLM_MAX_INPUT_TOKENS_EST` | Cost circuit breakers (tripping fails loud, never re-billed on the other lane). |
| `DIAGNOSTICS_ENABLED` · `DIAGNOSTICS_*` | `/debug` trace buffer sizing and retention. |

**Updates** — see [docs/DEPLOY.md](DEPLOY.md#updating-a-git-clone-install)

| Variable | Purpose |
|----------|---------|
| `UPDATE_CHECK_ENABLED` | The periodic `git ls-remote` poll that notices a newer build on this clone's branch. It reads refs only — never pulls, never restarts. `false` disarms it: no `update` field on `/health`, no amber dashboard card, no chat mention, and Irises then says plainly that she can't tell whether one is waiting. Default on. Disarms itself anyway with no `.git` (a Docker image) or an unknown build sha. |
| `UPDATE_CHECK_INTERVAL_MS` | How often to poll. Default 6h (`21600000`), floored at 15min; a non-numeric value falls back to the default. First check is 60s after boot. |
| `UPDATE_CHECK_BRANCH` | Which remote ref to compare against. Default: this clone's own current branch. |
| `UPDATE_ANNOUNCE_ENABLED` | Whether a waiting upgrade is mentioned **in chat** — once per chat per build, woven into a reply at a natural opening (30+ min of quiet, or their first message ever), otherwise pushed to recently-active chats — plus the short "back on the new build" after the script restarts her. `false` keeps detection, `/health` and the dashboard card, and sends nothing. Default on. |
| `UPDATE_ANNOUNCE_ACTIVE_WINDOW_MS` | The "recently active" audience window for that mention. Default 48h (`172800000`), capped at 20 chats. |
| `IRISES_SKIP_WEB_BUILD` · `IRISES_WEB` | Read by the scripts, not the server: `IRISES_SKIP_WEB_BUILD=1` skips the optional web-client rebuild during install and update; `IRISES_WEB=1` asks for it on a box that has never built it. |

**Memory features** — see [docs/MEMORY_ARCHITECTURES.md](MEMORY_ARCHITECTURES.md)

| Variable | Purpose |
|----------|---------|
| `MEMORY_SEMANTIC_RECALL` | `on` adds the embedding leg to archive recall (background backfill on the OpenRouter key, never a per-turn call). **Off by default** — off means no client is even built. |
| `EMBEDDINGS_MODEL` · `EMBEDDINGS_DIMENSIONS` · `MEMORY_EMBED_*` · `MEMORY_VECTOR_CANDIDATES` · `MEMORY_SEMANTIC_MIN_SCORE` | Semantic-recall knobs: model, vector width (changing it re-embeds the archive), backfill pacing, scan ceiling, and the cosine floor a hit must clear. |
| `MEMORY_RECALL_EXPANSION` | Paraphrase tolerance for keyless installs — one tiny classify call widens a recall query with synonyms (appended *after* the user's own words). Ignored while embeddings are active. Default on. |
| `NOTE_GROOM_ENABLED` · `NOTE_GROOM_THROTTLE_MS` | Fold near-duplicate saved notes into one (throttled, locally re-validated; retired notes stay in the archive). Default on / 6h. |
| `RELATIONSHIP_CLIMATE_ENABLED` | The weeks-scale standing register (ease / candor / playfulness), one classify eval per 22h inside code-owned clamps. `false` stops both the eval and the read immediately; the stored row survives. Default on. |
| `CONVO_FAMILIARITY_ENABLED` | The familiarity mask: a per-person level from 1 to 100 of how well she knows someone, built from what she holds about them and paced by the days they have actually talked. Its band decides how much of her mood reaches the reply, so a stranger gets her composed and someone close gets the whole weather. A room is always a stranger. `off` renders every mood layer as before, and the stored level survives. Default on. |
| `CONVO_THREADING_ENABLED` | The theme + open-loop inventory. Zero extra LLM calls; `false` gates both the harvest and the pre-turn read, and the stored inventory survives being turned off. Default on. |
| `MEMORY_MOMENTS_ENABLED` | The nightly moments pass and the per-turn sampler. Off = no moments written or offered; the file survives. Default on. |
| `MEMORY_THESIS_ENABLED` | The weekly thesis rewrite and the per-turn thesis section. Off = no read written or rendered; the file survives. Default on. |
| `MEMORY_SELF_ENABLED` | The daily SELF.md pass (her own stances, tastes, lessons, changes of mind) and the per-turn self section. Off = nothing written or rendered; the file survives. Default on. |
| `IRISES_MUSINGS_ENABLED` | Lets her text first about something on her own mind, apart from anything the user set up. Bounds: one a day at most, only at hours (in their timezone) when that person usually texts, learned from their last two weeks (10:00–21:00 until there is enough history), only after recent contact and a quiet chat, never a room. Default on. |
| `THREADING_PINGS_ENABLED` | Lets her *start* a message about a loop left hanging. **Default on** (`configure.sh --pings on\|off`); hard bounds — one ping per person per week, 48h of silence first, never a group, never twice about the same thing. |
| `FIRST_MOVE_ENABLED` | The one-time install introduction described above. Default on. |

`.env.example` is the annotated local template; `deploy/app.env` carries the shared baseline.



## Models

**By default, Irises speaks on your engine's model.** Deep work already runs on the engine; on top of that, at boot Irises reads your hermes/OpenClaw's configured **model, provider, endpoint, and key** and points its own three voice roles at the *same model on the same API* — so the voice works whatever the engine runs on, including a non-OpenRouter, non-Anthropic ("obscure") OpenAI-compatible API (OpenAI, Azure, vLLM, deepseek-direct, Groq, a self-hosted gateway…). Every reachable lane gets the engine's own slug; nothing is swapped in for it, and the only reshaping is spelling an id the way its API takes it (the Anthropic Messages lane wants a bare `claude-…`, not `anthropic/claude-…`). So the big model you chose for deep work is also the one answering chat — its cost and its latency included. A foreign auth/protocol Irises can't call directly (Bedrock, Vertex, Gemini-native, OAuth) keeps a working fallback lane and warns. Nothing to configure. *(Auto endpoint/key inheritance is implemented for hermes; an OpenClaw user on an obscure API sets it by hand — see [docs/ENGINES.md](ENGINES.md#model-inheritance).)*

There are **three lanes**: `anthropic` (native SDK, honours `ANTHROPIC_BASE_URL`), `openrouter` (openrouter.ai + its proprietary extras), and `openai` (a generic OpenAI-compatible client whose endpoint is `OPENAI_BASE_URL`). Want a cheaper or faster voice, or a different endpoint? Override any role independently: `<ROLE>_MODEL` / `<ROLE>_MODEL_OPENROUTER` / `<ROLE>_MODEL_OPENAI` / `<ROLE>_PROVIDER`, plus `OPENAI_BASE_URL` / `OPENROUTER_BASE_URL` — anything you set wins over what's inherited. To stop inheriting and keep Irises's own shipped models, set `ENGINE_MODEL_INHERIT=off`. The live model map (voice vs. deep-work) shows in `/health`, the `/dashboard` overview, and `npx tsx ./scripts/print-model-map.ts` — and Irises will tell you in chat if you ask.

With **no engine** (the debug/standalone path) Irises falls back to its own shipped models — three roles, OpenRouter-primary with an Anthropic fallback lane:

| Role | Standalone default | Anthropic fallback |
|------|-----------------|--------------------|
| **Convo** — front line (and the Composer re-voice) | `openai/gpt-5.6-luna:nitro` | `claude-sonnet-5` |
| **Classify** — routing, preference screens, failure triage | `openai/gpt-5.6-luna:nitro` | `claude-sonnet-4-6` |
| **Fallfirm** — holding beats + recovery voice | `openai/gpt-5.6-luna:nitro` | `claude-sonnet-4-6` |
| **Transcribe** — voice memos *(never inherited — needs an audio model)* | `google/gemini-3.5-flash-lite:nitro` | *(OpenRouter only)* |

`<ROLE>_PROVIDER` picks the primary lane per role (`anthropic` | `openrouter` | `openai`); the first configured other lane becomes the automatic fallback on 5xx / 429 / network errors.

