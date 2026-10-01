# Installing, configuring, updating and removing Irises

> This page was moved out of the README on 2026-09-19 and keeps the original, longer wording. hermes-agent is the tested engine. Every OpenClaw path described here is written but **untested** against a live gateway.

## Installing on an engine

Then you are the person I built this for. Irises sits **in front of the engine you already have**, and she can appear on **every channel your engine already speaks**. Your hermes or OpenClaw keeps doing all the deep work and keeps owning every bot and number — a tiny bridge plugin, installed through the engine's own plugin system, hands the chats you choose to Irises's voice and leaves the rest alone.

Install it in a terminal on the machine the engine runs on (on Windows, that terminal is **Git Bash** — it ships with the Git for Windows you already need for the clone — or a **WSL2** shell):

```bash
git clone https://github.com/criblaurens/irises && cd irises
bash ./scripts/irises.sh          # the menu: install or repair, configure, update, uninstall, status, advanced
```

That is the front door for a person: a plain terminal menu that asks which engine, which chats Irises fronts, which port, whether she runs as a service, and whether she keeps inheriting your engine's model — then **prints the exact command it is about to run** and runs it. Nothing happens that you have not read first. `npm run setup` is the same thing under a name npm users expect.

The menu composes the two lifecycle scripts; it never re-implements them. Those scripts stay the **scripted path** — a deploy, a CI job or an agent runs them with flags and never sees a prompt:

```bash
bash ./scripts/engine-setup.sh --engine hermes --yes   # or: --engine openclaw
```

Piping answers into the menu works too, but it is the flag scripts that are stable for automation: a piped run still walks the menu, and end-of-input quits with exit `2` and a pointer back to the flags.

**The terminal is the only install path**, and that is deliberate: the installer restarts the engine gateway at the end, and an agent that ran it from a gateway-hosted chat would be killing its own supervisor mid-reply. Your engine can still *walk you through it* — the two setup skills are **guides, not installers**. Your agent explains what Irises is, runs the read-only prerequisite checks, hands you the exact commands to run yourself, and verifies the result once you report back:

```bash
# hermes:
hermes skills install https://raw.githubusercontent.com/criblaurens/irises/main/skills/irises-setup-hermes/SKILL.md
#   then, in any hermes chat:  /irises-setup-hermes

# OpenClaw:
openclaw skills install git:criblaurens/irises
#   then ask OpenClaw to run the  irises-setup-openclaw  skill
```

The setup defaults to **bridge mode**: it installs the plugin, and then the two engines part ways. On **hermes** it writes `IRISES_FRONT=*:*` into `~/.hermes/.env` itself, so Irises fronts every chat out of the box. On **OpenClaw** it edits no engine config: it prints the three variables — `IRISES_BRIDGE_TOKEN`, `IRISES_URL`, `IRISES_FRONT` — for you to set on the gateway process yourself, and until you do, nothing is fronted. (`--no-bridge` installs without the plugin or the fronting.) Either way it restarts the engine gateway at the end so the engine picks up its new API-server setting and its plugins. To front only some conversations, say so **at install**: the menu asks which chats Irises fronts, and `--front 'telegram:*,whatsapp:+1555*'` is the flag form (default `*:*`, every chat on every platform your engine speaks). It is still a plain engine-side setting afterwards, and changing it later is one command from the Irises folder: `bash ./scripts/configure.sh --front 'telegram:*'` (or `--front none` to front nothing and leave the plugin installed and inert) rewrites `IRISES_FRONT` in the engine's own `.env` and bounces the gateway, which reads that key only when it starts. On **OpenClaw** it prints the `IRISES_FRONT=…` line instead of writing anything, because that gateway reads its own process environment rather than a file this clone can edit — setting it there and restarting the gateway stays yours. Patterns are matched against `<platform>:<chat_id>`, and everything not matched the engine keeps handling itself. Editing the file by hand and restarting the gateway yourself still works, and is the fallback when the clone cannot reach it. If the hook errors, the default `IRISES_BRIDGE_FAIL=open` lets the engine answer rather than go silent — I'd rather you get a boring reply than no reply.

Whatever goes into the **engine's own `.env`** is yours to approve: run from the menu, the installer lists the exact lines it wants to add or retarget — key names and non-secret values, never a secret's value — and writes them only on a yes (`--engine-env ask`). Decline, or pass `--engine-env print`, and it writes nothing to that file, prints the block for you to paste, and records in the manifest that there is nothing of ours in there to take back out later. `--engine-env apply` is the default and is what every install has always done.

After each restart hermes posts its own short "gateway online" note in your home channel. That is hermes talking, not Irises; silence it per platform with `<platform>.gateway_restart_notification: false` in hermes's own config if you'd rather not see it (Irises never edits hermes's config). The full story is in [docs/ENGINES.md § Gateway restart notifications](ENGINES.md#gateway-restart-notifications).

On OpenClaw, Irises also teaches the engine its **engine-mode discipline automatically, once, at boot** — one chat message the agent saves to its own instructions. Nothing for you to run by hand.

> **v1 gap:** scheduling reminders through Irises requires the **hermes** engine (it uses hermes's cron REST API). On OpenClaw the reminder tools are not offered at all — so Irises never promises a reminder that can't fire — while everything else runs full-reach there: real code, the engine's own skills, parallel subagents, artifacts.

Full guide, diagrams, and security notes: **[docs/ENGINES.md](ENGINES.md)**.

## Quick start, in full

Irises is meant to sit on top of the engine you already run, so the install is one command in a terminal on that machine:

```bash
git clone https://github.com/criblaurens/irises && cd irises
bash ./scripts/irises.sh          # or: npm run setup — same menu
```

The menu opens on a status line (engine, whether Irises is installed and on which build, service, port) over six entries — **install or repair**, **configure**, **update**, **uninstall**, **status**, **advanced** — and every one of them ends in a printed command line you could have typed yourself. **Configure** re-asks the install's own questions on a box that is already installed — port, service, fronted chats, voice model, browser chat, timezone, dashboard password, any documented `.env` key — with no wizard, no `npm ci` and no rebuild (see [Changing settings after the install](#changing-settings-after-the-install)). The install wizard runs in seven steps and its sixth is **optional extras**, skipped unless you ask for it: the browser chat UI, your timezone, and the dashboard password (typed unseen, and left blank keeps the shipped default rather than changing anything). Going back is a numbered option on the steps that offer it, so every prompt answers to a number. On the uninstall menu the default is **Back** — everything else there takes something away, and an Enter meant for the menu above should not be one of them. Prefer to type it? The scripted path is unchanged and is what deploys and agents use:

```bash
bash ./scripts/engine-setup.sh --engine hermes --yes   # or: --engine openclaw
```

On Windows those are the same commands, run in **Git Bash** (bundled with Git for Windows) or inside **WSL2**.

That is honestly the whole setup. On boot Irises **auto-detects your engine** (`OPS_BACKEND` is set for you), **reuses the engine's API key**, and makes her own voice **inherit the engine's actual model** — the slug you picked, not something chosen for you — on that same lane, with that same key. That holds everywhere she can reach: **OpenRouter**, direct **Anthropic**, official **OpenAI**, and any self-hosted or third-party **OpenAI-compatible** host (Azure, Groq, a local vLLM, and the rest). Only a host none of her lanes can speak at all — Bedrock, Vertex, Gemini-native, Copilot and the other OAuth/SigV4-shaped ones — leaves her on her own shipped models, and she says so in the log; deep work still runs on the engine there, as it always does. Know what that buys and what it costs: whatever your engine runs for deep work now answers your chat turns too, at its price and its pace. And that reading happens once, at her own boot, not on a live watch: change the engine's model later and her voice keeps the old one until she restarts too — bounce her service (see [Start, stop, status, logs](#start-stop-status-logs)) and the new model takes hold. **There is no `.env` to write.** (You still can — see [Configuration](CONFIGURATION.md#configuration) — anything you set wins.) If you would rather she spoke on a model of her own, the install can do that instead of inheriting: pick a lane (Anthropic, OpenRouter, or any OpenAI-compatible endpoint) and a model id, and the installer writes that model for all three voice roles into this clone's `.env` along with `ENGINE_MODEL_INHERIT=off`. Be clear about what that second part means: her voice stops borrowing the engine's model **and its key and endpoint**, so the key you give is the key she speaks on. Deep work still runs on the engine's own model, always. The key is read from `IRISES_MODEL_API_KEY` in the environment and from nowhere else — never a flag, never printed, never logged, because argv is readable by anything else on the box and lands in your shell history.

The script is idempotent and prints every change before making it. In order: it checks node/git/curl, finds your engine (read-only), then checks the port — a **healthy Irises already answering there is adopted** rather than fought over, and only a foreign process holding it is refused. Next it writes your `.env` (mode 600) with `PORT=3000` pinned (the committed `deploy/app.env` baseline `8080` is the Docker image's port), *then* installs deps and builds, registers Irises as a **user-level service** (`systemd --user` on Linux, a LaunchAgent on macOS, a Task Scheduler task named `Irises` on Windows, with a detached `nohup` fallback where none of those exists), waits for her to answer `/health` on the new build — and only then touches the engine: enables its API surface if needed, installs the bridge plugin, records every engine-side key it added in `~/.irises/install-manifest.json` after backing the engine's env file up, and restarts the engine gateway last so all of it goes live. It leaves her running at `http://127.0.0.1:3000` and prints a summary with an honest exit code.

Flags — every one of them is a question the menu asks, and every default is what an install has always done: `--yes` for a fully non-interactive run, `--no-bridge` to install without the plugin or fronting, `--no-service` to skip the service registration, `--port N` to pick another port, `--front PATTERNS` to front only the chats you name (default `*:*`), `--engine-env ask|print` to preview or refuse the engine-side `.env` edit (default `apply`), `--model-lane` + `--model-slug` (+ `--model-base-url` for an OpenAI-compatible host) to give her voice its own model, `--web on|off` for the browser/CLI debug chat this clone serves (`WEB_ENABLED`; unset leaves your `.env` as it is, which on a fresh install means on), `--tz ZONE` for the wall clock she reads (`IRISES_TZ`; unset means the host's own zone, and a zone you pass is written even when it matches that zone, so moving the box later does not silently move her clock), `--detach-engine` to undo the engine side and keep Irises, and `--uninstall` to take it all back out (see [Updating](#updating)). Two values are environment-only, never flags, because argv is readable by everything else on the box: `IRISES_MODEL_API_KEY` for the model lane's key and `IRISES_DASHBOARD_PASSWORD` for the admin dashboard's (`DASHBOARD_PASSWORD`); neither is ever printed. Start/stop/status/logs and the uninstall one-liner are in that same section; `bash ./scripts/engine-setup.sh --help` is the full list.

A few minutes later Irises makes her [first move](ENGINES.md#first-move-install-introduction) — she pulls what your engine already remembers about you and, where the engine confirms you've really talked there before, sends a short hello; otherwise she simply waits for your first message. Full guide, bridge mode, and security notes: **[docs/ENGINES.md](ENGINES.md)**.

> **Prerequisites:** Node 22.13+ (the local store uses the builtin `node:sqlite`), git, curl. No database, and — when you install onto an engine — no keys or config of your own: Irises reuses what the engine already has. On Windows you also need a bash: Git Bash or WSL2.

> **Windows is honest but young.** The Windows paths — the Git Bash install, the `Irises` Task Scheduler task, the WSL2 branch — are covered by stub tests only; nobody has yet run them on a real Windows box. Treat Linux and macOS as the tested platforms and tell me what breaks on yours. Under WSL2, reboot survival needs systemd enabled in `/etc/wsl.conf` (`[boot] systemd=true`); without it the installer uses the detached fallback, which does not come back by itself.

> **Prefer to be walked through it?** Install the setup skill for your engine ([commands above](#installing-on-an-engine)) and ask for it. It is a guide: your agent explains the install, runs the read-only prerequisite checks, hands you these commands to run yourself, and verifies the result afterwards. It never clones, builds, starts, or restarts anything — see the note above for why.

<details>
<summary><b>Debug: run standalone, with no engine at all</b></summary>

<br/>

This is the **debug path** — Irises with no deep-work engine behind it. Convo still chats, but every research/email/files/reminders request answers honestly that its deep half is offline. I use this to hack on the persona and pipeline without an engine running.

```bash
# 1. install both packages (server + web client)
npm install && npm run install:web

# 2. add a key + force offline + pin the port
cp .env.example .env
#   set ANTHROPIC_API_KEY and/or OPENROUTER_API_KEY (no engine to borrow one from here), and set:
#     OPS_BACKEND=off      # pins debug/offline + skips engine discovery (needed if a hermes/OpenClaw
#                          # is installed on this machine, which Irises would otherwise auto-detect)
#     PORT=3000            # deploy/app.env defaults PORT to 8080 (the Caddy proxy); pin 3000 so the
#                          # server and `npm run chat` (which defaults to 3000) agree

# 3. run the brain  →  http://localhost:3000   (leave this running)
npm run dev

# 4. in a SECOND terminal, talk to Irises — browser (npm run dev:web) or the REPL:
npm run chat
#   if your server runs on another port (e.g. the 8080 default), point chat at it:
#     npm run chat -- --url http://127.0.0.1:8080
```

> One-off, without editing `.env`: `OPS_BACKEND=off PORT=3000 npm run dev`.

</details>

<details>
<summary><b>Build & run scripts</b></summary>

<br/>

| Script | What it does |
|--------|--------------|
| `npm run setup` | The lifecycle menu (`bash ./scripts/irises.sh`) — install or repair, configure, update, uninstall, status, advanced |
| `bash ./scripts/configure.sh --show` | Live settings report (read-only); its flags change one or several settings in one previewed run — see [Changing settings after the install](#changing-settings-after-the-install) |
| `npm run dev` | Server in watch mode (`tsx`) on `:3000` |
| `npm run dev:web` | Web debug client (Next dev server) |
| `npm run chat` | Terminal REPL onto the same web-chat endpoints (`/cancel`, `/quit`) |
| `npm run build` | `tsc` → `dist/`, then copy each agent's `Context.md` + bundled `*.txt` |
| `npm run copy:context` | The persona/asset copy step on its own |
| `npm run build:web` | Static web client → `web/out/` (served by the server at `/` in prod) |
| `npm start` | Run the built server (`node dist/index.js`) |
| `npm test` | Unit tests for `src/` and `scripts/` (Node test runner via `tsx --test`, TZ pinned to UTC, ephemeral `DATA_BACKEND=memory`) |
| `npm run typecheck:scripts` | Type-check `scripts/` (the REPL, the convergence batteries, the update helpers) |
| `npm run install:web` | Install the web client's dependencies |

> The build **must** copy the persona files — the loader fails fast on the first turn that needs a missing `Context.md` rather than serving a persona-less agent.

`npm run chat` also takes `-- --url http://host:8080 --token <DEBUG_TOKEN> --client-id mylane` for pointing at a remote instance.

</details>

## Updating

One command, in a terminal on the machine Irises runs on, from the Irises folder (Git Bash or WSL2 on Windows):

```bash
bash scripts/update.sh
```

Or open the menu (`bash ./scripts/irises.sh` → **Update**) and let it ask first. It shows you the pending commits before anything is applied and then offers four ways to take them: apply now; **check only**, which reports and changes nothing; apply to disk and restart Irises yourself later; or apply without bouncing the engine's gateway. Each one is the flag run below, printed before it runs.

It fast-forward `git pull`s the current branch, reinstalls deps and rebuilds (`npm ci && npm run build`, plus the web client when you use it), writes an update receipt — then, in this order, **restarts Irises and verifies the new build is the one answering, refreshes the engine bridge plugin, and bounces the engine gateway**. The plugin comes after the verified restart on purpose: a rollback undoes this clone, not the engine's copy of the plugin, so refreshing it earlier would leave the engine loading new plugin code against the old build. Nothing is left for you to restart, and there is nothing to do in chat. On a small box the build can take minutes and may outlive a dropped SSH session; the run keeps going and logs to `~/.irises/logs/update.log`.

If the new build doesn't compile, or compiles and then fails to come up, the script **rolls back**: the worktree returns to the commit you were on, that build is rebuilt, and it comes back up. A bad build costs you a few minutes, not your assistant. It's careful in the other directions too — fast-forward only (it never auto-merges divergent local commits), it refuses a dirty working tree, it takes a single-updater lock so two runs can't race on git and the build, and it never touches your data under `$IRISES_HOME`.

**Putting a build back by hand** is a separate thing, and deliberately harder to reach than the update itself: `bash scripts/update.sh --rollback-to <sha>` resets this clone to a commit it already has, rebuilds, restarts, verifies, and refreshes the plugin and the gateway exactly as a failed update's automatic rollback does. It never fetches and never looks at origin — it asks the clone one question, is that commit here. In the menu it lives under **Advanced**, offers the build you were on before the last update, and asks you to type the target sha out in full agreement before it moves; a script cannot trip that prompt by passing `--yes`. What it does **not** move is your data: `$IRISES_HOME` stays as the newer build left it, so a schema that build wrote stays written.

Flags: `--check` (report only — exit `10` if an update is available, `0` if not), `--yes` (skip the prompt), `--no-restart` (pull and build, leave the running server alone — but the bridge plugin is still refreshed and the engine gateway still bounced, ~12s, and Irises goes on serving the old build against the new plugin until you restart it, so add `--no-gateway-restart` if you want nothing but the disk touched), `--no-gateway-restart` (leave the engine gateway alone; the refreshed plugin loads on its next restart). Exit codes are listed in [docs/DEPLOY.md](DEPLOY.md#updating-a-git-clone-install).

After the gateway comes back, hermes posts its own short "gateway online" note in your home channel — hermes's message, not Irises's, silenced per platform with `<platform>.gateway_restart_notification: false` in hermes's config ([details](ENGINES.md#gateway-restart-notifications)).

**Irises notices on its own, too.** The running server periodically checks the remote for a newer build and surfaces it — on `/health` (`version` + `update` fields), on the `/dashboard` overview card, and in chat: she mentions a waiting upgrade once to recently-active chats, woven naturally into the conversation, hands you the same `bash scripts/update.sh` line verbatim, and says a short "back on the new build" once she's on it. Ask her what version she is and she'll tell you; ask her to apply it and she'll tell you she can't and give you the command once — there is no chat command for an update, by design. Tune or silence all of it with the `UPDATE_*` env vars (see [Configuration](CONFIGURATION.md#configuration)): `UPDATE_ANNOUNCE_ENABLED=false` keeps her quiet about it, `UPDATE_CHECK_ENABLED=false` stops the checking (and then she says plainly that she can't tell).

### Changing settings after the install

The questions the wizard asked are all re-askable on a box that is already installed, with no wizard, no `npm ci` and no rebuild. In the menu (`bash ./scripts/irises.sh` → **2) Configure Irises**) the entry opens on the live settings report and offers the port and whether she runs as a service, which chats she fronts, the model her voice runs on (or handing it back to the engine), the browser chat UI, the timezone, the dashboard password, and setting or unsetting any documented `.env` key. Each entry prints the flag command it is about to run, the same as everywhere else in the menu.

The flag form is `scripts/configure.sh`. `--show` is read-only — no lock, no write, no restart — and names secrets rather than printing them (`<set>` / `<unset>`):

```bash
bash scripts/configure.sh --show                        # every setting, and where its value came from
bash scripts/configure.sh --tz Europe/Paris             # or --tz host to follow this machine
bash scripts/configure.sh --web off                     # the browser/CLI debug chat (WEB_ENABLED)
bash scripts/configure.sh --front 'telegram:*'          # which chats she fronts (engine-side)
bash scripts/configure.sh --front none                  # front nothing; the plugin stays, inert
bash scripts/configure.sh --port 3001                   # takes the engine's IRISES_URL with it, when that key is ours
bash scripts/configure.sh --service on                  # or: --service off, to run detached
IRISES_MODEL_API_KEY=… bash scripts/configure.sh --model-lane openrouter --model-slug <id>
bash scripts/configure.sh --model-inherit               # back to inheriting the engine's model
bash scripts/configure.sh --set CONVO_EFFORT=low        # any documented key; repeatable
IRISES_SET_VALUE=… bash scripts/configure.sh --set OPENROUTER_API_KEY   # a secret, off argv
bash scripts/configure.sh --unset IRISES_TZ
```

A run previews every change first as `+` / `~` / `-` lines against the file it would touch (a secret's value is never in there — it prints as `<set>`, and the old one as `not shown`), asks once, backs each file up next to itself (`.env.bak-irises-<timestamp>`), and writes. What happens next depends on whose file changed. A change in **this clone's `.env`** ends with Irises **restarted and the same build checked back off `/health`** — that file is read once at boot, so a change nobody restarted into is a change that silently did not take; `--no-restart` leaves the running server on the old values — with one exception, `--service on|off`, where installing or removing the unit *is* the start or the stop, so it happens whatever that flag says (and the summary says so). A change in the **engine's `.env`** — `--front`, and the `IRISES_URL` a `--port` move takes with it *when the install wrote that key and it still names the old port* — ends with the engine's **gateway bounced**, because it reads those keys only when it starts. A run that restarted Irises bounces the gateway too, whatever file changed, so the engine never runs on against a server that came up after it; `--no-gateway-restart` skips the bounce in both cases. A `--port` always restarts Irises, and so always bounces the gateway; whether it writes the engine's `.env` at all depends on that key. A `--front`-only run touches nothing of hers, so it takes no backup here and does not restart her, and says so. `--yes` is the non-interactive form for scripts. On Windows the `--service on|off` arm drives Task Scheduler, which — like the rest of the Windows path — is stub-tested only, so treat it as unproven until you have run it on Git Bash. Exit codes: `0` applied, nothing to change, or `--show` · `1` a step failed or was refused · `2` bad usage · `4` restarted but `/health` did not report this build · `5` configured and live, but the gateway could not be verified back up. Every run past the flags ends its stdout with `RESULT: ok|noop|health-failed|gateway-failed|partial`.

The generic editor has two rules worth knowing before you reach for it. A `--set` key has to be one `.env.example` or `deploy/app.env` documents, so a typo cannot sit in the file doing nothing — `--allow-unknown` is the override for the handful of real keys those files only describe in prose. And a key whose name ends in `_KEY`, `_TOKEN`, `_PASSWORD` or `_SECRET` may not carry its value on the command line: pass the name alone and put the value in `IRISES_SET_VALUE` (the dashboard password is `IRISES_DASHBOARD_PASSWORD`, whose presence is itself the request and needs no flag). `PORT`, `IRISES_FRONT`, `OPS_BACKEND`, the engine credentials and `IRISES_HOME` are refused there and point you at the flag instead — each of them is written in more places than this clone's `.env`, and only a flag or a re-install moves them all together.

Every setting the installer asks about has to be reachable from all four places `scripts/settingsContract.test.ts` checks — `engine-setup.sh --help`, `configure.sh --help`, the menu's Install section and the menu's Configure section — and `npm test` fails when one of them is missing it.

### Start, stop, status, logs

The installer registers Irises as a **user-level service**, so she returns after a reboot and none of this needs root:

```bash
# Linux — systemd --user
systemctl --user status irises
systemctl --user restart irises
systemctl --user stop irises

# macOS — LaunchAgent
launchctl print gui/$(id -u)/ai.irises.server
launchctl kickstart -k gui/$(id -u)/ai.irises.server
launchctl bootout gui/$(id -u)/ai.irises.server

# Windows — the Task Scheduler task named Irises (cmd or PowerShell)
schtasks /Query /TN Irises
schtasks /Run /TN Irises
schtasks /End /TN Irises
#   from Git Bash, double the slashes:  schtasks //Query //TN Irises
#   (MSYS rewrites a lone /Query into a Windows path before schtasks ever sees it)

# any platform
tail -f "${IRISES_HOME:-$HOME/.irises}/logs/server.log"
curl -s http://127.0.0.1:3000/health
```

On Windows the launcher the task runs is `%USERPROFILE%\.irises\irises-start.cmd` and the log it appends to is `%USERPROFILE%\.irises\logs\server.log`; the task restarts Irises on failure. Under WSL2 it is the Linux `systemd --user` path instead, which needs systemd enabled in `/etc/wsl.conf` (`[boot] systemd=true`) to survive a reboot. All of the Windows paths are stub-tested only — not yet verified on a real Windows box.

On a box with none of the three (a bare container, a shell with no user session bus) the installer falls back to a detached `nohup` launch that outlives the shell that started it. Stop that one with `kill $(cat "${IRISES_HOME:-$HOME/.irises}/irises.pid")`.

### Uninstall

```bash
bash scripts/engine-setup.sh --uninstall
```

It stops and unregisters the service, removes the engine bridge plugin and the engine-side keys the installer added (from the manifest it wrote at install, after backing the engine's env file up), puts the keys that were already in that file back to their pre-install values **only where the install changed them** — the two it has to take over (`IRISES_URL`, which must name this install, and `API_SERVER_ENABLED`) go back to what they said before the install ran, even if you repointed them since, and everything else stays exactly as you have it now, including the engine's `API_SERVER_KEY` and `IRISES_PUSH_TOKEN`, which are adopted rather than replaced — bounces the engine gateway **if it actually removed something** — so a second run on an already-clean box does not cycle your engine for nothing — and **keeps your data**. Add `--purge-data` to delete `$IRISES_HOME` (memory, dossier, SQLite) as well; that one asks you to type the word `delete` first (unless you also pass `--yes`) and is not reversible. The clone itself is never deleted; the script prints the `rm -rf` for you.

**"Uninstall" is rarely the rung you want**, so the menu (`bash ./scripts/irises.sh` → **Uninstall**) offers the whole ladder and lets you stop partway down:

1. **Stop the service only** — nothing is removed, and starting it again is one command.
2. **Detach from the engine** (`--detach-engine`) — undo every engine-side change and keep Irises. The plugin comes out, every key the manifest records as added is removed, every key it records as retargeted goes back to the value in the recorded backup, `IRISES_FRONT` is unset, and the gateway is bounced: **your engine is left as if Irises had never been installed**, except that the `.bak-irises-*` backups stay. The Irises service, this clone, and everything under `$IRISES_HOME` are untouched — she keeps running, with no engine in front of her. A later `--uninstall` then finds nothing of ours in the engine and does nothing to it. The run ends `RESULT: detached`, and the data flags are meaningless there: a detach never archives and never deletes.
3. **Uninstall and keep your data** (`--uninstall`) — the paragraph above.
4. **Uninstall and delete your data** (`--uninstall --purge-data`) — and the menu offers to archive first, which is `--archive-data`: a `~/.irises-backup-<timestamp>.tar.gz` of `$IRISES_HOME` written before anything is removed. If that archive cannot be written, nothing is deleted.

Docker/VM installs update by rebuilding the image instead — see [docs/DEPLOY.md](DEPLOY.md) § 5.

