# Irises — Setup & Deployment Runbook

> Secrets live in `.env`, which is gitignored — never commit it. If a key ever
> lands in a remote, rotate it in the provider console immediately.

## 1. Prerequisites
- **Node 22.13+** and npm (the local store uses the builtin `node:sqlite`).
- **Anthropic** API key, **OpenRouter** API key (fallback + voice transcription).
- A public HTTPS host for production (any small VM running Docker — §5 handles this with Caddy).
- Optionally, an **engine** (OpenClaw or hermes-agent) for email/reminders/deep work — see
  `docs/ENGINES.md`. Email, OAuth, and push webhooks live on the engine side, not in this app.

---

## 2. Run locally

### 2a. Fastest path (no infra at all)
```bash
git clone https://github.com/criblaurens/Irises.git
cd Irises
npm install
cp .env.example .env
```
Edit `.env` and set at minimum:
```
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-... # for voice + fallback
```
State persists to `~/.irises` out of the box (override with `IRISES_HOME`); add
`DATA_BACKEND=memory` if you want a throwaway run that leaves nothing behind.
Run it:
```bash
npm run dev          # tsx watch (hot reload)
# in another shell:
curl http://localhost:3000/health      # -> {"status":"ok",...}
```
Diagnostics dashboard: open `http://localhost:3000/debug` (localhost is allowed without a token).

### 2b. Connect an engine locally (optional)
Email, reminders, and deep work run on an external engine (OpenClaw or hermes-agent), not in
this app — set `OPS_BACKEND` + the engine keys in `.env` and follow `docs/ENGINES.md`. Without
an engine, the web chat still works; Irises just can't do engine-backed research or reminders.

`npm run build` compiles to `dist/` and copies the agent `Context.md` files; `npm start` runs the built server. Build it once to confirm everything compiles:
```bash
npm run build && npm start
```

---

## 3. Local storage

There is no database to provision. All state lives under **`IRISES_HOME`** (default
`~/.irises`; `/data` inside the Docker image), in the same style as the engines it fronts:

```
$IRISES_HOME/
├── irises.db                # SQLite (node:sqlite): conversations, profiles, prefs,
│                            # short-term memory, reply threading, token ledger,
│                            # error log, diagnostics
└── memories/<handle>/       # per-user curated memory, human-readable markdown
    ├── LONG.md + revisions/ # the long-term doc, every version snapshotted
    ├── MEDIUM.md            # active directives/notes/facts (+ MEDIUM.archive.md lineage)
    └── DOSSIER.md           # the LLM-merged dossier prose
```

- Schema is created automatically on first boot; retention sweeps (hourly/daily/6h) keep
  the store bounded on a small VM.
- **Backing up Irises = backing up this directory** (the `irises_state` volume in compose).
  The database runs in WAL mode, so copy it **quiesced**: `docker compose stop app`, copy the
  volume (all of it — `irises.db` plus any `-wal`/`-shm` siblings), `docker compose start app`.
  For a hot backup use `sqlite3 irises.db ".backup backup.db"` instead of a raw file copy.
- `DATA_BACKEND=memory` runs the same code against an ephemeral root — nothing persists
  (used by the test suite and throwaway runs).
- The daily token caps (`OPS_DAILY_TOKEN_CAP` / `LLM_DAILY_TOKEN_CAP` in `deploy/app.env`)
  enforce out of the box now that the ledger is always present.

---

## 4. Other keys
```
TRANSCRIBE_MODEL=google/gemini-2.5-flash
# per-agent model config lives in deploy/app.env: <AGENT>_PROVIDER (anthropic|openrouter) +
# <AGENT>_MODEL (Anthropic slug) + <AGENT>_MODEL_OPENROUTER (OpenRouter slug) for CONVO /
# CLASSIFY / FALLFIRM. Deep research has no model here — it runs on your engine's model.
# PDF engine: OPENROUTER_PDF_ENGINE.
```

---

## 5. Deploy to a VM

Any small VM running Docker works (1 GB RAM is enough with the compose memory limits). The
stack is two containers via `docker compose`: the app and **Caddy**, which terminates HTTPS
(automatic Let's Encrypt) for a `<VM_IP>.nip.io` host or a real domain and reverse-proxies
to `app:8080`. All secrets live in a single **`/opt/irises/.env`** (chmod 600) read by
Docker Compose; the committed non-secret baseline is `deploy/app.env`.

1. Build and ship the image:
   ```bash
   docker build -t irises:latest .
   # push to any registry the VM can pull from (ghcr.io/<you>/irises:latest, Docker Hub, …),
   # or skip the registry entirely: docker save irises:latest | gzip > irises.tar.gz, scp it
   # to the VM, and docker load < irises.tar.gz there.
   ```
2. On the VM, create `/opt/irises/` and copy in `deploy/docker-compose.yml`,
   `deploy/Caddyfile`, and `deploy/app.env`.
3. Create `/opt/irises/.env` from `deploy/env.vm.example`: set `IMAGE` to your image ref,
   `SITE_ADDRESS` to `<VM_IP>.nip.io` or your domain, and fill in the API keys.
   `chmod 600 /opt/irises/.env`. Open ports 80/443 in the host firewall.
4. Start it:
   ```bash
   cd /opt/irises && docker compose up -d --wait
   ```
5. Optional — a systemd unit so the stack returns after a reboot:
   ```ini
   # /etc/systemd/system/irises.service
   [Unit]
   Description=Irises (docker compose)
   Requires=docker.service
   After=docker.service network-online.target
   [Service]
   Type=oneshot
   RemainAfterExit=yes
   WorkingDirectory=/opt/irises
   ExecStart=/usr/bin/docker compose up -d
   ExecStop=/usr/bin/docker compose down
   [Install]
   WantedBy=multi-user.target
   ```
   Then `systemctl daemon-reload && systemctl enable irises`.

To ship an update: rebuild + push the image, then `docker compose pull && docker compose up -d --wait` on the VM.

### Updating a git-clone install

Installs made with `git clone` + `scripts/engine-setup.sh` (rather than the Docker image) update in
place, from a terminal on the box, in the Irises folder — Git Bash or a WSL2 shell on Windows:

```bash
bash scripts/update.sh        # add --check to preview, --yes to skip the prompt
```

**A deploy runs the flag scripts, not the menu.** `bash ./scripts/irises.sh` (`npm run setup`) is the
interactive entry for a person at a keyboard: it asks, composes these same flags, prints the command
line it is about to run, and runs it. It adds no lifecycle behaviour of its own: it composes the three
lifecycle scripts, `engine-setup.sh`, `configure.sh` and `update.sh`. So anything scripted — this
box's deploy, CI, an agent — keeps calling those with flags and reading the `RESULT:` line. Every
flag below defaults to what the scripts did before the menu existed, so an existing invocation is
unchanged.

The script fast-forward `git pull`s the current branch, runs `npm ci && npm run build` (and the web
client build when `web/out` exists — or `IRISES_WEB=1` asks for it — and the box has ~1.5 GB of
memory free; `IRISES_SKIP_WEB_BUILD=1` skips it outright, and a web build that fails warns instead of
failing the update), writes `$IRISES_HOME/update-receipt.json` — then, in this order, **restarts
Irises** (the user-level service, or the pidfile at `$IRISES_HOME/irises.pid`) **and verifies the new
build is what answers `/health`**, **refreshes the engine bridge plugin**, and **bounces the engine
gateway**. The plugin is refreshed on every run, and always after the restart is verified: a rollback
undoes this clone, not the engine's copy, so a refresh any earlier would leave the engine loading the
new plugin against the old code. Nothing is left for the operator to restart. There is no chat trigger
for any of this and none can be added: the script cycles the gateway, so an agent running it from a
gateway-hosted chat would kill its own supervisor mid-turn. On a small box the build can take minutes
and may outlive a dropped SSH session; the run keeps going and logs to `~/.irises/logs/update.log`.

**Rollback.** If the new commit fails to compile, or compiles and then fails to answer `/health` with
the new build inside the boot window, the script returns the worktree to the commit that was running,
rebuilds THAT, and brings it back up. The failing tree is left in the log, not on the box.
`$IRISES_HOME` (your data) is never touched, a divergent local branch is never auto-merged (the script
stops and tells you to reconcile it), and a single-updater lock stops two runs racing on git and the
build.

**Exit codes** — worth reading if you script it. The last stdout line is always
`RESULT: ok|noop|up-to-date|update-available|rolled-back|gateway-failed`, or `RESULT: partial` for a
run that stopped before finishing (either nothing had been changed yet, or an undo failed and the
tree, `node_modules` and `dist` may be inconsistent — read the messages above it).

| Code | Meaning |
|---|---|
| `0` | already up to date, or updated and healthy |
| `1` | preflight refused: dirty tree, detached HEAD, missing tool, Node below 22.13, no `.git`, another run holds the lock, another process (not the managed Irises) holds the port, or the pull could not fast-forward |
| `2` | bad arguments |
| `3` | the new build failed to compile — **rolled back**, the old build is running |
| `4` | the new build compiled but failed to boot — **rolled back**, the old build is running |
| `5` | Irises is on the new build, but the engine gateway would not restart — fix the gateway by hand |
| `10` | `--check` only: an update is available |

Flags: `--check`, `--yes`, `--no-restart` (pull and build only — the bridge plugin is still refreshed
and the engine gateway still bounced, ~12s, and Irises keeps serving the old build against the new
plugin until you restart it yourself, so pass `--no-gateway-restart` too if you want nothing but this
clone's disk touched), `--no-gateway-restart` (leave the gateway alone; the refreshed plugin loads on
its next restart).

**`--rollback-to SHA`** is the manual recovery path and is not part of the update flow. It takes a git
sha of 7 to 40 hex characters (fewer is ambiguous, and a rollback is not a thing to guess at), and it
**never fetches**: it asks this clone whether it has that commit, and refuses if it does not. It then
resets to it, rebuilds, restarts, verifies the target build is the one answering, refreshes the
engine's plugin copy and bounces the gateway — the same sequence a failed update's automatic rollback
runs. It moves the **code only**: `$IRISES_HOME` is not rolled back with it, so a schema the newer
build wrote stays written and the older code has to live with it. It pairs with `--yes`,
`--no-restart` and `--no-gateway-restart`; with `--check` it is a usage error (`2`), because one
reports and changes nothing while the other changes everything.

| `--rollback-to` outcome | Code | `RESULT:` |
|---|---|---|
| the clone is on the target build, everything verified | `0` | `rolled-back` |
| HEAD was already that commit, or the confirmation was declined — nothing changed | `0` | `noop` |
| refused before touching anything: no such commit here, or a foreign process on the port | `1` | `partial` (the guard's line — nothing had been changed; the messages above say why) |
| bad sha, or `--check` alongside it | `2` | none — a usage error changes nothing and prints no `RESULT` |
| the reset or the rebuild at the target failed part way — tree, `node_modules` and `dist` may disagree | `3` | `partial` |
| it built but would not answer `/health` on the target build — nothing left to undo | `4` | `partial` |
| the clone is on the target build, but the engine gateway could not be verified back up | `5` | `gateway-failed` |

**Changing a setting** on a box that is already installed is `scripts/configure.sh` — no wizard, no
`npm ci`, no rebuild, and no re-run of the installer over a live clone for a one-line `.env` change:

```bash
bash scripts/configure.sh --show                  # report only: no lock, no write, no restart
bash scripts/configure.sh --tz Europe/Paris --yes
bash scripts/configure.sh --port 3001 --yes       # takes the engine's IRISES_URL with it, when that key is ours
bash scripts/configure.sh --front 'telegram:*' --yes   # or --front none, to front nothing
```

It previews the `+` / `~` / `-` lines it would write (a secret prints as `<set>`, never its value),
backs each file up to `.bak-irises-<timestamp>`, and writes. A run that changed something in **this
clone's `.env`** then restarts Irises and verifies this clone's build is what answers `/health` —
that file is parsed once at boot, so an unrestarted change is a change that silently did not take. A
run that changed the **engine's `.env`** (`--front`, and the `IRISES_URL` a `--port` move carries
with it — only where the install wrote that key and it still names the port being moved off; a
`--port` always restarts Irises either way) bounces the engine gateway, which reads those keys only
at its start. A run that restarted Irises bounces the gateway as well, whichever file it changed. A `--front`-only run is therefore engine-side only: it takes no backup of this clone,
does not restart Irises, and says `not restarting: only the engine's side changed, and Irises reads
none of it at boot`. `--yes` is the non-interactive form, `--no-restart` leaves the running server
on the old settings — except under `--service on|off`, where installing or removing the unit IS the
start or the stop and happens regardless (the summary names the flag it did not honour; the Windows
Task Scheduler arm of that transition is stub-tested only, like the rest of the Windows path) — and
`--no-gateway-restart` skips the gateway bounce. It takes the **same single lifecycle lock** as
`engine-setup.sh` and `update.sh`, so a configure cannot race a deploy rewriting the same `.env`.
The lock is taken **after** the preview is confirmed, so two runs serialize their WRITES, not their
plans: a preview is measured against the file as it stood when it was printed (a `--show` takes no
lock at all).
Exit codes are the house contract: `0` applied, nothing needed changing, or `--show` · `1` a step
failed or was refused · `2` bad usage · `4` restarted but `/health` did not report this build · `5`
configured and live, but the engine gateway could not be verified back up. Every run past the flags
ends its stdout with `RESULT: ok|noop|health-failed|gateway-failed|partial`. Secrets never travel on
argv: `IRISES_MODEL_API_KEY`, `IRISES_DASHBOARD_PASSWORD` and `IRISES_SET_VALUE` (for a bare
`--set KEY`) are read from the environment. `bash scripts/configure.sh --help` is the full list.

`scripts/engine-setup.sh` uses the same contract on its own side: `0` ok, `1` a step failed, `2` bad
arguments, `4` Irises never reported the expected build on `/health`, `5` the gateway could not be
verified back up — ending in `RESULT: ok|adopted|partial|health-failed|gateway-failed` for an install,
`RESULT: ok|partial|gateway-failed|noop` for an `--uninstall`, and
`RESULT: detached|partial|gateway-failed|noop` for a `--detach-engine`. A **detach** undoes the engine
side only — plugin, added keys, retargeted values, the gateway bounce — and leaves the Irises service,
this clone and `$IRISES_HOME` alone; `noop` there is the run that was declined at its confirmation, and
a detach that finds nothing of ours left in the engine still ends `detached`, having changed nothing
and bounced no gateway. The data flags (`--purge-data`, `--archive-data`) do not apply to a detach and
are called out in words rather than silently accepted — it never goes near `$IRISES_HOME`. On every
side `partial` is the exit guard's line: the run stopped before its summary (an unguarded error, or a
Ctrl+C), so read the messages above it rather than the token.

**After the gateway restart** hermes posts its own note into the user's home channel — *"♻️ Gateway
online — Hermes is back and ready."* That is hermes's message, not Irises's; she neither sends it nor
can suppress it. Silence it per platform with `<platform>.gateway_restart_notification: false` in
hermes's own config. Irises never edits hermes's config, so that is always the operator's own change.
The canonical account of it is [§ Gateway restart
notifications](ENGINES.md#gateway-restart-notifications).

The running server also checks the remote itself and reports what it finds:

- `GET /health` gains a `version` object (git `sha` / `branch` / build stamp) and an `update` object
  (`available`, `remoteSha`, `lastCheckAt`, `lastCheckOk`).
- The `/dashboard` overview shows a **version** card that turns amber when an update is available.
- In chat, Irises mentions a waiting upgrade once to recently-active chats, relays the
  `bash scripts/update.sh` line verbatim, and says a short "back on the new build" after the script
  restarts her. She also states her own build and whether one is waiting when asked — and says
  plainly that applying it is not something she can do.

Knobs (in `deploy/app.env` / `.env`): `UPDATE_CHECK_ENABLED` (default `true`),
`UPDATE_CHECK_INTERVAL_MS` (default 6h, floored at 15min), `UPDATE_CHECK_BRANCH` (defaults to the
clone's branch), `UPDATE_ANNOUNCE_ENABLED` (default `true` — `false` keeps detection but sends no
chat messages), `UPDATE_ANNOUNCE_ACTIVE_WINDOW_MS` (default 48h, the "recently active" window). A
Docker image built without `.git` reports `version.source: "unknown"`, disables the checker, and
makes Irises say she cannot tell whether an update is waiting.

**Service control.** The installer registers a user-level service, so none of this needs root:

```bash
systemctl --user status irises                     # Linux (systemd --user)
launchctl print gui/$(id -u)/ai.irises.server      # macOS (LaunchAgent)
schtasks /Query /TN Irises                         # Windows (Task Scheduler, cmd or PowerShell)
tail -f "${IRISES_HOME:-$HOME/.irises}/logs/server.log"
```

`schtasks /Run /TN Irises` and `schtasks /End /TN Irises` start and stop the Windows one. From Git
Bash, double the slashes — `schtasks //Query //TN Irises` — because MSYS rewrites a lone `/Query`
into a Windows path before `schtasks.exe` ever sees it. The task is
registered from an XML definition (restart-on-failure, no execution time limit) and its action is the
launcher `%USERPROFILE%\.irises\irises-start.cmd`, which is what appends to
`%USERPROFILE%\.irises\logs\server.log`. Under WSL2 the systemd path is used instead, and reboot
survival there needs systemd enabled in `/etc/wsl.conf` (`[boot] systemd=true`). **The Windows paths
are stub-tested only — no one has yet run them on a real Windows box**; Linux and macOS are the
verified platforms.

Where none of the three exists (a bare container, a shell with no user session bus) the installer
falls back to a detached `nohup` launch; stop that one with
`kill $(cat "${IRISES_HOME:-$HOME/.irises}/irises.pid")`.

**Uninstall.** `bash scripts/engine-setup.sh --uninstall` stops and unregisters the service, removes
the bridge plugin and the engine-side keys the installer added (read from
`$IRISES_HOME/install-manifest.json`, after backing the engine's env file up — with no manifest it
falls back to the `IRISES_*` keys whose values name this clone and leaves `API_SERVER_*` alone), bounces the gateway
**only when it actually removed something** (a re-run on an already-clean box cycles nothing), and
keeps your data; `--purge-data` also deletes `$IRISES_HOME` after you type `delete` to
confirm (`--yes` skips the question), which is not reversible. Of the keys that were already in that
file, only the ones the install actually **changed** are put back from the backup (recorded as
`keysRetargeted`: `IRISES_URL`, which has to name this install, and `API_SERVER_ENABLED` when it was
not already on) — those go back to what the file said on install day even if you repointed them
afterwards, while everything else is left exactly as you have it now, the engine's `API_SERVER_KEY`
and `IRISES_PUSH_TOKEN` included, because those are adopted rather than
replaced — and the manifest is removed with them, so a later manifest-less run removes an `IRISES_*`
key only when its value names this clone (its port, its push token) and leaves another install's keys
alone by name. The clone is never deleted; the script
prints the command. If the Photon reply-context patch series is applied to the hermes checkout, the
uninstall prints the revert instructions rather than touching it.

**Before you ship a change to any of this**, run the lifecycle battery: `npm run e2e:lifecycle`
exercises a real install → update → rollback → uninstall in a sandbox (throwaway `HOME`,
`IRISES_HOME` and engine home, ephemeral ports, an origin made from the clone's own objects) in about
three minutes. It is deliberately not part of `npm test`.

---

## 6. Verification checklist
- `curl https://your-domain.com/health` → 200.
- Open the web chat URL (served at `/`) or run `npm run chat` → Irises replies (paced bubbles).
- Ask "what does AS-IS mean" → answered inline (no delegation).
- Ask a question that needs research → instant ack, then a follow-up.
- `/debug?token=…` shows the prompts and the Convo→Ops delegation graph.
- With an engine connected: ask for a reminder a couple of minutes out → the engine's cron
  delivers it back through `POST /api/engine/push` and Irises pings you proactively.
- Logs: `sudo docker compose -f /opt/irises/docker-compose.yml logs -f app` shows the boot
  banner's endpoint list and `[channels] registered "web"` (plus `"bridge"` when an engine fronts chats).
