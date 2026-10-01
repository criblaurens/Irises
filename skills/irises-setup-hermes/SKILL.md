---
name: irises-setup-hermes
description: "Guide a person through installing Irises — a user-facing front-end (web chat / CLI, plus the engine bridge) that uses this hermes as its deep-work engine. Explains it, checks prerequisites, hands over the exact terminal commands, and verifies afterwards. It does not install anything itself."
version: 2.0.0
author: Irises
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Irises, assistant, persona, frontend, setup]
prerequisites:
  commands: [git, node, npm]
---

# Irises Setup (hermes engine) — a guide, not an installer

**You do not install Irises. The person does, in their own terminal.** Your job is to explain what
Irises is, check that the box can run it, hand over the exact commands, set the right expectations,
and verify the result once they say they are done.

Why it works this way: the installer's last step restarts the hermes gateway, because the API server
and the bridge plugin are only read when the gateway comes up. Run from a gateway-hosted session,
that final bounce kills the supervisor running your own turn, mid-reply — your answer never lands,
and the person is left guessing whether the install finished. So the command belongs in a human's
shell, not in yours.

## What Irises is (say this in your own words)

A user-facing texting assistant — a fast conversational front line — that delegates ALL deep work
(research, email, files, reminders, memory) to this hermes. This hermes stays completely unmodified;
Irises talks to it only through the OpenAI-compatible API server (`API_SERVER_ENABLED`) and the cron
REST API.

Irises rides **on top of** this hermes: on boot it auto-detects it (sets `OPS_BACKEND=hermes`),
reuses this hermes's API key, and makes its own voice **inherit this hermes's provider, endpoint and
model** — including when this hermes runs on an OpenAI-compatible or otherwise obscure API (OpenAI,
Azure, vLLM, deepseek-direct, Groq, a self-hosted gateway…), not just OpenRouter or Anthropic. The
voice runs this hermes's OWN model on every lane it can reach — no stand-in slug is substituted — so
chat turns cost and pace what this hermes's model does; deep work uses that same model, as always.
There is nothing to configure by hand.

## 1. Check the prerequisites (read-only — these you MAY run)

```bash
node --version          # needs 22.13+ (Irises's local store uses the builtin node:sqlite)
git --version
hermes gateway status
```

That is the entire list of commands you are allowed to run in this skill, plus the health check in
step 5. If `node --version` is below 22.13, look for a newer Node already on the box (nvm under
`~/.nvm/versions/node/`, or Homebrew) and tell the person which one to put on `PATH` — do not attempt
a system install, and do not install it for them.

On **Windows**, the person needs a bash to run the install in: **Git Bash**, which ships with the Git
for Windows they already need for the clone, or a **WSL2** shell. Say so up front, and say the honest
part too — the Windows paths are stub-tested only and have not yet been run on a real Windows box,
so Linux and macOS are the platforms with mileage on them.

## 2. Hand them the install (they run this, you do not)

Give them these two commands, exactly as written, and tell them to run them in a terminal on this
machine (Git Bash or WSL2 if that machine is Windows):

```bash
git clone https://github.com/criblaurens/irises ~/irises && cd ~/irises
bash ./scripts/irises.sh
```

The second command opens a menu — install or repair, configure, update, uninstall, status, advanced —
that asks which engine, which chats Irises fronts, which port, whether she runs as a service, and
whether her own voice keeps inheriting this hermes's model. It prints the exact command it is about
to run before running it, so they can see and keep what it did. `npm run setup` is the same menu.

If they would rather not be asked anything, the one-shot form does the same install with every
default:

```bash
bash ./scripts/engine-setup.sh --engine hermes --yes
```

`--yes` means non-interactive: assume every default, never prompt. `~/irises` is just the usual
spot — any folder they pick is fine, and the second command must run from inside whichever folder
they chose.

What the script does, so you can answer questions about it (it is short and commented — they can read
it first):

- checks node 22.13+, git, curl, and that the port is free,
- writes the Irises `.env` (mode 600): `OPS_BACKEND=hermes`, the API key, a generated
  `ENGINE_PUSH_TOKEN`, and `PORT=3000` (the committed `deploy/app.env` baseline says `8080`, which is
  the Docker image's port behind Caddy, so a local install pins 3000). No database — Irises persists
  to `~/.irises` on its own,
- reuses the Anthropic / OpenRouter / OpenAI key (and `OPENAI_BASE_URL`) this hermes already uses,
  for Irises's own small voice models, and never overwrites a value they set themselves,
- installs dependencies and builds; the web client is rebuilt only when it was built before,
- registers Irises as a **user-level service** — `systemd --user` on Linux, a LaunchAgent on macOS, a
  Task Scheduler task named `Irises` on Windows, with a detached `nohup` fallback where none of those
  exists — so she survives a reboot without root,
- waits for her to answer `/health` on the new build, and only then touches hermes: enables the
  hermes API server if it is not already on (the documented `API_SERVER_ENABLED` switch plus a
  generated key, appended to hermes's own environment config after a backup, every change printed
  first and recorded in `~/.irises/install-manifest.json`). Run from the menu, that edit is shown
  first — the exact lines, key names and non-secret values, never a secret's value — and made only on
  a yes; decline it and the installer writes nothing to hermes's env file and prints the block for
  them to paste instead, with fronting simply staying off until they do,
- sets up **bridge mode by default** and writes `IRISES_FRONT`, so Irises fronts every chat on every
  platform out of the box unless they narrow it (the menu asks; the flag form is `--front`, and the
  default is `*:*` — see the consequences below). `--no-bridge` skips the plugin and the fronting,
- optionally gives Irises's own voice a model instead of inheriting this hermes's — the menu's model
  step, or `--model-lane` + `--model-slug`. Tell them what that trade is: the voice then runs on the
  key they supply (given through `IRISES_MODEL_API_KEY` in their environment, never as a flag) and
  stops borrowing this hermes's key and endpoint. Deep work still runs on this hermes's model,
- optionally writes two of this clone's own settings, which the menu offers as skippable extras and
  the flags spell `--web on|off` (`WEB_ENABLED` — the browser chat UI and `npm run chat`; unset leaves
  the clone's `.env` alone, and a fresh install has it on) and `--tz ZONE` (`IRISES_TZ` — the wall
  clock she reads; unset means the host's own zone). The admin dashboard's password goes the way the
  model key does: `IRISES_DASHBOARD_PASSWORD` in their environment, never a flag, never printed —
  leaving it blank keeps the shipped default rather than changing anything,
- **restarts the hermes gateway last**, so the API server and the bridge plugin are live, and prints a
  summary with an honest exit code.

## 3. Set these three expectations before they run it

- **The gateway will restart at the end.** Any hermes chat in flight ends there. This is normal and
  it is the step that turns the bridge on: until it happens, hermes still answers its own channels.
- **Hermes will announce its own return** — *"♻️ Gateway online — Hermes is back and ready."* — in
  their home channel, after that restart and after every future one. That is hermes's message, not
  Irises's. If they would rather not see it, hermes silences it per platform with
  `<platform>.gateway_restart_notification: false` in hermes's own config. Mention it as optional;
  never edit hermes's config for them.
- **The default `IRISES_FRONT=*:*` means Irises answers everything.** They can narrow it at install
  rather than afterwards — the menu asks which chats she fronts, and the flag is `--front`. With
  bridge mode on, a person texting any
  channel this hermes owns (iMessage, WhatsApp, Discord, …) reaches Irises, who answers in her own
  voice and uses hermes as her engine. Hermes is unchanged, still reachable directly in a terminal
  (`hermes`), still transparently answers anything `IRISES_FRONT` does not cover — and answers
  everything whenever Irises is down (fail-open, so a broken front never drops messages). Narrow the
  scope by editing the `IRISES_FRONT` line in hermes's env to fnmatch patterns over
  `<platform>:<chat_id>`, or with `bash ./scripts/configure.sh --front '<patterns>'`; blanking it
  (`--front none`) makes the plugin inert from the gateway's next start, which is when that value is
  read — so the edit and the gateway restart go together. Tell them their operator and control chats
  are inside `*:*` too.

Also worth saying once: **shortly after that restart, Irises usually texts first** — a one-time
introduction, sent only on a chat this hermes has genuinely exchanged messages in before (the "first
move", see Notes). A text from her out of the blue is the feature working, not a glitch.

## 4. Never do any of this

- **Never clone, install, build, or start anything.** Not in a temp folder, not "just to check".
- **Never open the menu.** `bash ./scripts/irises.sh` and `npm run setup` are the person's command,
  not yours — it installs, updates, uninstalls and detaches, and every one of those ends in a gateway
  bounce. Hand it over; do not run it, and do not pipe answers into it on their behalf.
- **Never run the setup script or the updater**, and never run any command that restarts or cycles
  the gateway or its supervisor — not through the hermes CLI's own gateway subcommands, not through
  `systemctl`, `launchctl`, `kickstart`, `schtasks`, or direct process control. That guard is
  correct; do not route around it.
- **Never touch another Irises checkout** that already exists somewhere on this machine.
- **Never edit hermes's config**, including for the restart-notification key above.

## 5. Verify after they report back (read-only)

```bash
curl -s http://127.0.0.1:3000/health
```

Use the port they actually installed on if it is not 3000. A JSON body with a `version` object is a
healthy install. Then tell them where to talk to her: any fronted engine channel, the web chat at
`http://127.0.0.1:3000`, or `npm run chat` in the clone for a terminal session. If the health check
fails, point them at `~/.irises/logs/server.log` and the script's own output — do not try to fix it by
starting anything.

## 6. The other commands, for later

All of them are in the same menu (`bash ./scripts/irises.sh`, from the Irises folder), and all of them
are theirs to run, never yours.

**Change a setting** (from the Irises folder, in their terminal) — the port, the service, which chats
she fronts, the model her voice runs on, the browser chat, the timezone, the dashboard password, or
any documented `.env` key, without re-running the installer:

```bash
bash ./scripts/configure.sh --show              # report only: every setting and where it came from
bash ./scripts/configure.sh --tz Europe/Paris   # the wall clock she reads
bash ./scripts/configure.sh --front 'telegram:*'  # narrow which chats she fronts (or --front none)
bash ./scripts/configure.sh --model-inherit     # hand her voice back to this hermes's model
```

Each run previews what it would change, asks once, backs the file up, and writes. A change to one of
Irises's own settings then restarts her and checks the build back off `/health`; a `--front` change
is this hermes's `.env`, so it bounces the gateway instead and leaves her running untouched. A
`--port` always restarts her, and takes `IRISES_URL` in this hermes's `.env` with it — and bounces
the gateway — only where the install wrote that key and it still names the port being moved off.
Hand these over and read back what they report — never run them yourself: a `--front` or `--port`
change can edit this hermes's own `.env` and bounce the gateway, so a run from a gateway-hosted chat
would kill the supervisor mid-reply, the same reason the install is theirs.

**Update** (from the Irises folder, in their terminal):

```bash
bash ./scripts/update.sh
```

It pulls, rebuilds, restarts Irises, and restarts the hermes gateway. If the new build fails to
compile or fails to come up, it rolls back to the build that was running. There is no chat command for
it — Irises will say so herself if asked, and hand over that same line. She does check for new builds
on her own and mentions one once, in chat, when it is waiting.

**Uninstall** (from the Irises folder):

```bash
bash ./scripts/engine-setup.sh --uninstall
```

Stops and unregisters the service, removes the bridge plugin and the engine-side keys the installer
added, restarts the gateway, and keeps their data. `--purge-data` deletes `~/.irises` too, and that is
not reversible — `--archive-data` alongside it writes a `~/.irises-backup-<timestamp>.tar.gz` first,
and nothing is deleted if that archive cannot be written.

**Detach** (from the Irises folder) — the middle rung, and usually the one someone actually wants when
they say they want this hermes back:

```bash
bash ./scripts/engine-setup.sh --detach-engine
```

It undoes every engine-side change — the bridge plugin, the keys Irises added, the values it moved,
`IRISES_FRONT` — and bounces the gateway, so **this hermes is left as if Irises had never been
installed, except that the `.bak-irises-*` backup files stay**. Irises herself is untouched: her
service keeps running, the clone stays, and `~/.irises` — her memory and database — is left alone.
They can attach her again later by running the install once more.

## Notes

- Details, security notes, and troubleshooting live in `docs/ENGINES.md` inside the clone.
- **Which model is live:** Irises's voice model vs. this hermes's deep-work model show in `/health`,
  on the `/dashboard` overview, and via `npx tsx ./scripts/print-model-map.ts`. Irises will also tell
  the person her model plainly if they ask in chat, and her build, and whether an update is waiting.
  Override any voice role with `<ROLE>_PROVIDER` / `<ROLE>_MODEL_OPENROUTER` / `<ROLE>_MODEL_OPENAI` /
  `<ROLE>_MODEL`, or turn inheritance off with `ENGINE_MODEL_INHERIT=off` (see `docs/ENGINES.md`
  § Model inheritance).
- On its first boot, Irises sends this hermes a one-time **engine-mode onboarding** over the API
  server: how to recognize a delegated request, the reply contract, the full-reach invitation and its
  hard limits (including never messaging the user on any channel itself). Hermes appends it to its own
  SOUL.md by its own hand — nothing in hermes is edited by Irises. To remove it later, tell hermes by
  chat to delete that section; to skip the send entirely, set `ENGINE_ONBOARDING=off` in the Irises
  `.env`. The text is printed by `npx tsx ./scripts/print-engine-doctrine.ts` inside the clone.
- Once after that, Irises makes the **first move**: she asks this hermes what it already knows about
  its user — a normal chat message hermes answers in its own words, nothing in hermes is read or
  edited — and keeps a sanitized version in her own memory so her first words are not cold. Then she
  either texts the user first, **only** on a chat this hermes has genuinely exchanged messages in
  before, or sends nothing at all and folds the introduction into her reply the first time they text
  her. Exactly once per install; skip it with `FIRST_MOVE_ENABLED=false` in the Irises `.env`.
