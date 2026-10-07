#!/usr/bin/env bash
# Irises install / uninstall — wire this clone to an UNMODIFIED hermes-agent or OpenClaw engine,
# install Irises as a user-level service, and verify the whole thing came up.
#
#   bash ./scripts/engine-setup.sh                      # install (engine auto-detected)
#   bash ./scripts/engine-setup.sh --engine hermes --yes # install, never prompt
#   bash ./scripts/engine-setup.sh --no-service          # do not install a service; run detached
#   bash ./scripts/engine-setup.sh --no-bridge           # leave the engine answering its own channels
#   bash ./scripts/engine-setup.sh --port 3001           # pin a different port
#   bash ./scripts/engine-setup.sh --front 'telegram:*'  # front only the chats you name
#   bash ./scripts/engine-setup.sh --engine-env ask      # show the engine .env lines before writing
#   bash ./scripts/engine-setup.sh --no-gateway-restart  # leave the gateway restart to the operator
#   bash ./scripts/engine-setup.sh --detach-engine       # undo the engine side, keep Irises + data
#   bash ./scripts/engine-setup.sh --uninstall           # remove Irises, keep your data
#   bash ./scripts/engine-setup.sh --uninstall --purge-data   # …and delete $IRISES_HOME too
#
# A SHELL is the only install/update/uninstall path: a person's terminal, or the engine's own
# terminal tool when someone asks the engine to install it (skills/irises-setup-hermes). Irises
# herself never runs this — a rebuild that restarts the process talking to you cannot honestly
# report on itself.
#
# WHAT IT TOUCHES, in order: this clone's .env (chmod 600) · node_modules + dist · optionally
# web/out · a systemd --user unit, a LaunchAgent, or a Task Scheduler task on Windows · the engine's
# .env (backed up first, every added key recorded in $IRISES_HOME/install-manifest.json) · the
# engine's plugin dir · the engine's gateway, which is bounced at the end because the plugin,
# IRISES_FRONT and API_SERVER_* are only read when it starts. The one exception is a run that must
# not bounce it — --no-gateway-restart, or a run INSIDE the hermes gateway (see GATEWAY_RESTART) —
# which says so and prints how to restart it instead.
#
# EXIT CODES
#   0  installed, uninstalled or detached, and verified
#   1  a step failed — read the message; nothing is left half-started that we can tell you about
#   2  wrong usage (unknown flag, unknown engine, bad port)
#   4  Irises did not report the expected build on /health within the budget
#   5  Irises is fine, but its engine's gateway could not be verified back up
# The last line of stdout is `RESULT: <token>` for every run that gets past argument parsing
# (`--help` and usage errors print none) — that is the line for scripts that wrap this one.
#
# Idempotent: re-run it any time. It adopts a server it finds already running and touches no engine
# source code. In the engine's .env it ADOPTS the secrets it finds — API_SERVER_KEY, IRISES_PUSH_TOKEN
# and IRISES_BRIDGE_TOKEN are read back out and reused, never replaced, because both sides read the
# same secret from two files. A key that is PRESENT BUT EMPTY is not a secret to adopt: this install's
# value goes in (said out loud, by name), and --uninstall puts the empty line back. The two keys it
# does take over regardless are the ones that have to name THIS
# install — IRISES_URL and API_SERVER_ENABLED — and it says so, loudly, when it changes either.
# Every key it found in place is recorded in the manifest, and keys this install changed (recorded as
# keysRetargeted) are restored from the pre-install backup on uninstall; keys it adopted or never
# touched are left as you have them — a secret you rotated after the install stays rotated.
set -euo pipefail

source "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/lib/irises-lib.sh"
IRISES_LOG_TAG="irises-setup"

MODE="install"
ENGINE_FLAG=""
ARCHIVE_DATA=0
ASSUME_YES=0
BRIDGE=1
SERVICE=1
PURGE_DATA=0
PORT_FLAG=""
# The front scope this install writes when the engine carries none. `*:*` is what every install has
# written since there was an installer, so it stays the default; IRISES_FRONT_PATTERN is the env
# form of --front, for a wrapper that already has the answer.
FRONT_PATTERN="${IRISES_FRONT_PATTERN:-*:*}"
FRONT_EXPLICIT=0
if [ -n "${IRISES_FRONT_PATTERN:-}" ]; then FRONT_EXPLICIT=1; fi
# What this run may do to the ENGINE's .env: apply (what every install has always done), ask (show
# the lines first and write them only on a yes), print (never write; say what to paste). The keys a
# declined or printed run leaves for the operator, recorded in the manifest so --uninstall knows
# there is nothing of ours in that file to take back out.
ENGINE_ENV_MODE="apply"
ENGINE_ENV_PENDING=""
# A model for Irises's own voice instead of the engine's. Empty = inherit, which is what every
# install has done. The API key is NOT here and never will be: it comes from IRISES_MODEL_API_KEY in
# the environment, because argv is readable by anything else on the box and lands in shell history.
MODEL_LANE=""
MODEL_SLUG=""
MODEL_BASE_URL=""
# The two optional extras the wizard offers and a scripted install can pass. Both are EMPTY by
# default and empty means "leave this clone's .env alone": WEB_ENABLED keeps the env_set_default it
# has always had, and an unset IRISES_TZ keeps the host's own zone. The dashboard password is a
# secret and follows the model key's rule — environment only, never argv.
WEB_FLAG=""
PINGS_FLAG=""
MUSINGS_FLAG=""
TZ_FLAG=""
# Whether this run bounces the engine's gateway at the end — 1 is what every run has always done.
# --no-gateway-restart turns it off, and so does running INSIDE the hermes gateway: hermes marks
# every process it starts with _HERMES_GATEWAY=1, so this script is then a child of a chat turn,
# and a bounce would SIGTERM that turn mid-reply. The run then says why it skipped and how to
# restart instead (in hermes, /restart in a chat lets running turns finish first).
GATEWAY_RESTART=1
GATEWAY_SKIP_WHY=""

usage() {
  cat <<'EOF'
usage: bash ./scripts/engine-setup.sh [options]          # install
       bash ./scripts/engine-setup.sh --uninstall [options]
       bash ./scripts/engine-setup.sh --detach-engine     # undo the engine side only

  --engine hermes|openclaw   which engine this clone talks to (default: auto-detect)
  --yes, -y                  non-interactive: take every default, never prompt
  --no-bridge                leave the engine answering its own channels (no plugin, no fronting)
  --no-service               do not install a user service; run Irises detached instead
  --port N                   pin the port Irises listens on (default 3000)
  --front PATTERNS           which chats Irises fronts: comma-separated <platform>:<glob> items,
                             written to the engine's IRISES_FRONT when it carries none
                             (default *:*, every chat on every platform the engine speaks)
                             — change it later with scripts/configure.sh --front
  --engine-env MODE          what may happen to the ENGINE's .env: apply (default, write the keys),
                             ask (show them first, write on a yes), print (never write; say what to
                             paste). print and a declined ask still install the bridge plugin
  --model-lane LANE          give Irises's own voice a model instead of inheriting the engine's:
                             anthropic | openrouter | openai. Needs --model-slug, and turns
                             ENGINE_MODEL_INHERIT off (deep work still runs on the engine's model)
  --model-slug ID            the model id, exactly as that provider spells it
  --model-base-url URL       required with --model-lane openai; the OpenAI-compatible endpoint
  --web on|off               the browser/CLI debug chat this clone serves (WEB_ENABLED). Unset
                             leaves it as this clone's .env has it (a fresh install: on)
  --pings on|off             she may text first to ask how a thing you left hanging went
                             (THREADING_PINGS_ENABLED). Unset leaves the default: on
  --musings on|off           she may text first about something on her own mind
                             (IRISES_MUSINGS_ENABLED). Unset leaves the default: on
  --tz ZONE                  the IANA zone Irises reads the wall clock in (IRISES_TZ). Unset leaves
                             it unset, which is the host's own zone
  --no-gateway-restart       do not bounce the engine's gateway at the end; print how to restart it
                             instead (the bridge goes live on that restart). Implied when this runs
                             inside the hermes gateway (_HERMES_GATEWAY=1), e.g. from a chat turn
  --uninstall               remove Irises: service, plugin, engine keys. Your data is KEPT, and so
                             is this clone (the exact rm for each is printed)
  --purge-data               with --uninstall: also delete $IRISES_HOME (irises.db + memories)
  --archive-data             with --uninstall: tar $IRISES_HOME to ~/.irises-backup-<ts>.tar.gz
                             first. With --purge-data it is the copy you keep; nothing is deleted
                             if the archive cannot be written
  --detach-engine            undo every engine-side change — the plugin, the keys Irises added, the
                             values it moved — and leave Irises, its service and your data alone.
                             The .bak-irises-* files stay. RESULT: detached
  -h, --help                 this text

environment:
  IRISES_MODEL_API_KEY       the API key for --model-lane. Read from the environment and nowhere
                             else — never a flag, never printed, never logged
  IRISES_FRONT_PATTERN       the env form of --front
  IRISES_DASHBOARD_PASSWORD  the admin dashboard's password (DASHBOARD_PASSWORD). Read from the
                             environment for the same reason as the model key, and never printed

exit codes: 0 ok · 1 a step failed · 2 usage · 4 health not verified · 5 gateway not verified
every run that gets past argument parsing ends its stdout with: RESULT: <token>
(this help text and a usage error print none)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --engine)      ENGINE_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --engine=*)    ENGINE_FLAG="${1#--engine=}"; shift ;;
    --port)        PORT_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --port=*)      PORT_FLAG="${1#--port=}"; shift ;;
    --front)       FRONT_PATTERN="${2:-}"; FRONT_EXPLICIT=1; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --front=*)     FRONT_PATTERN="${1#--front=}"; FRONT_EXPLICIT=1; shift ;;
    --engine-env)  ENGINE_ENV_MODE="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --engine-env=*) ENGINE_ENV_MODE="${1#--engine-env=}"; shift ;;
    --model-lane)  MODEL_LANE="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --model-lane=*) MODEL_LANE="${1#--model-lane=}"; shift ;;
    --model-slug)  MODEL_SLUG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --model-slug=*) MODEL_SLUG="${1#--model-slug=}"; shift ;;
    --model-base-url) MODEL_BASE_URL="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --model-base-url=*) MODEL_BASE_URL="${1#--model-base-url=}"; shift ;;
    --web)         WEB_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --web=*)       WEB_FLAG="${1#--web=}"; shift ;;
    --pings)       PINGS_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --pings=*)     PINGS_FLAG="${1#--pings=}"; shift ;;
    --musings)     MUSINGS_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --musings=*)   MUSINGS_FLAG="${1#--musings=}"; shift ;;
    --tz)          TZ_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --tz=*)        TZ_FLAG="${1#--tz=}"; shift ;;
    --uninstall)   MODE="uninstall"; shift ;;
    --detach-engine) MODE="detach"; shift ;;
    --purge-data)  PURGE_DATA=1; shift ;;
    --archive-data) ARCHIVE_DATA=1; shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    --bridge)      BRIDGE=1; shift ;;
    --no-bridge)   BRIDGE=0; shift ;;
    --service)     SERVICE=1; shift ;;
    --no-service)  SERVICE=0; shift ;;
    --no-gateway-restart) GATEWAY_RESTART=0; GATEWAY_SKIP_WHY="--no-gateway-restart"; shift ;;
    -h|--help)     usage; exit 0 ;;
    --revert)
      err "--revert is gone. Use --uninstall (it removes the plugin, the engine keys and the"
      err "service, and keeps your data), or edit IRISES_FRONT to stop fronting without removing"
      err "anything:  bash ./scripts/engine-setup.sh --uninstall"
      exit 2 ;;
    *) err "unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done

if [ "$GATEWAY_RESTART" = "1" ] && [ "${_HERMES_GATEWAY:-}" = "1" ]; then
  GATEWAY_RESTART=0
  GATEWAY_SKIP_WHY="running inside the hermes gateway"
fi

# How the operator restarts a gateway this run left alone. No literal engine-CLI restart command
# here: hermes's terminal guard reads this file when a chat turn runs it (see the note in section E
# of lib/irises-lib.sh), and one such literal would get the whole install refused.
gateway_restart_hint() { # ENGINE
  case "${1:-}" in
    hermes) printf 'type /restart in any hermes chat (running turns finish first)' ;;
    *)      printf 'restart the %s gateway yourself' "${1:-engine}" ;;
  esac
}

case "$ENGINE_FLAG" in
  ''|hermes|openclaw|off) ;;
  *) err "unknown engine '$ENGINE_FLAG' — expected hermes, openclaw or off"; exit 2 ;;
esac
case "$PORT_FLAG" in
  '') ;;
  *[!0-9]*) err "--port needs a plain port number, got '$PORT_FLAG'"; exit 2 ;;
esac
# Checked HERE, before anything is built, because the engine fronts NOTHING for an IRISES_FRONT it
# cannot parse — which on the other end looks exactly like an install that silently did not work.
# The model override is all-or-nothing: a lane with no slug names no model, and a slug with no lane
# cannot be written at all (the three lanes use three different key names). Both are refused here
# rather than half-applied to this clone's .env.
case "$MODEL_LANE" in
  '')
    if [ -n "$MODEL_SLUG" ] || [ -n "$MODEL_BASE_URL" ]; then
      err "--model-slug / --model-base-url need --model-lane anthropic|openrouter|openai"
      exit 2
    fi ;;
  anthropic|openrouter|openai)
    if [ -z "$MODEL_SLUG" ]; then
      err "--model-lane $MODEL_LANE needs --model-slug (the model id, exactly as that provider spells it)"
      exit 2
    fi
    if [ "$MODEL_LANE" = "openai" ] && [ -z "$MODEL_BASE_URL" ]; then
      err "--model-lane openai needs --model-base-url — an OpenAI-compatible lane is a URL plus a key,"
      err "and guessing api.openai.com for a host that is not it fails at the first call"
      exit 2
    fi
    if [ "$MODEL_LANE" != "openai" ] && [ -n "$MODEL_BASE_URL" ]; then
      err "--model-base-url only applies to --model-lane openai"
      exit 2
    fi ;;
  *) err "unknown --model-lane '$MODEL_LANE' — expected anthropic, openrouter or openai"; exit 2 ;;
esac
case "$WEB_FLAG" in
  ''|on|off) ;;
  *) err "--web takes on or off, got '$WEB_FLAG'"; exit 2 ;;
esac
case "$PINGS_FLAG" in
  ''|on|off) ;;
  *) err "--pings takes on or off, got '$PINGS_FLAG'"; exit 2 ;;
esac
case "$MUSINGS_FLAG" in
  ''|on|off) ;;
  *) err "--musings takes on or off, got '$MUSINGS_FLAG'"; exit 2 ;;
esac
# A zone is checked for SHAPE only. Whether the name is one this box's tzdata knows is the server's
# question (src/pipeline/zonedTime.ts warns and falls back to the host zone), and a script that
# refused a zone a newer tzdata does know would be the worse failure of the two.
case "$TZ_FLAG" in
  '') ;;
  *[[:space:]]*) err "--tz takes one IANA zone name, got '$TZ_FLAG'"; exit 2 ;;
esac
case "$ENGINE_ENV_MODE" in
  apply|ask|print) ;;
  *) err "unknown --engine-env '$ENGINE_ENV_MODE' — expected apply, ask or print"; exit 2 ;;
esac
if ! front_pattern_valid "$FRONT_PATTERN"; then
  err "--front takes comma-separated <platform>:<glob> items, got '$FRONT_PATTERN'"
  err "e.g. --front 'telegram:*'  ·  --front 'telegram:*,whatsapp:+1555*'  ·  the default is '*:*'"
  exit 2
fi

# No TTY = nobody can answer a question, so don't ask one. An agent-driven run lands here (both
# engines spawn shell commands with stdin at /dev/null, so any `read` would hit EOF immediately).
if [ ! -t 0 ] && [ "$ASSUME_YES" != "1" ]; then
  ASSUME_YES=1
  say "stdin is not a terminal — running non-interactive (same as --yes)"
fi
# The library's prompt helpers read THIS, never the terminal: whether a run may ask a question is a
# decision this script has already made, above, out of --yes and the no-TTY case. Published once,
# here, so every ask_* below agrees with the two `[ "$ASSUME_YES" = "1" ]` branches further down.
IRISES_ASSUME_YES="$ASSUME_YES"

ROOT="$(irises_root)"
ENV_FILE="$ROOT/.env"
cd "$ROOT"

# Armed HERE, past every usage exit and before the first byte of real work: the guard releases the
# lock and prints `RESULT: partial` for the two paths that never reach `summary` — a `set -e` abort
# on some statement nobody guarded, and a Ctrl+C. A usage error (exit 2) stays a usage error.
trap 'lifecycle_exit_guard $?' EXIT

rand_token() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }

# A sha for a human: the first seven, or the word `unknown`. dist/version.json legitimately carries
# no sha on a tarball install, and `built:  — NOT confirmed live` reads like a truncation bug in the
# script rather than the one fact it is trying to report.
short_sha() { # [SHA]
  local s="${1:-}"
  if [ -z "$s" ]; then printf 'unknown'; return 0; fi
  printf '%s' "${s:0:7}"
}

# Is KEY one of the names a previous install recorded as ours? Whole-word match against the space
# separated keysAdded list, so IRISES_URL never matches IRISES_URL_EXTRA.
key_was_ours() { # KEY LIST
  local k="${1:-}" list=" ${2:-} "
  if [ -z "$k" ]; then return 1; fi
  case "$list" in *" $k "*) return 0 ;; esac
  return 1
}

# Has --uninstall's restore loop anything to DO to KEY — a pre-install value in the backup that
# differs from what the file says now, or a duplicate to collapse? Asked before the pre-uninstall
# backup is taken, because "did this run change anything" has to be answerable without changing
# anything: a repeat --uninstall that snapshots an already-clean .env and bounces an engine for it is
# the bug this question exists to prevent. Mirrors the loop's own condition exactly, and stays quiet
# about values — it returns a yes or a no, not a diff.
retarget_pending() { # ENGINE_ENV PRE_BACKUP KEY -> 0 = yes
  local f="${1:-}" bak="${2:-}" key="${3:-}"
  if [ -z "$f" ] || [ ! -f "$f" ] || [ -z "$key" ]; then return 1; fi
  if [ "$(env_count "$f" "$key")" -gt 1 ]; then return 0; fi
  if [ -z "$bak" ] || [ ! -f "$bak" ]; then return 1; fi
  if [ "$(env_count "$bak" "$key")" = "0" ]; then return 1; fi
  if [ "$(env_get "$bak" "$key")" != "$(env_get "$f" "$key")" ]; then return 0; fi
  return 1
}

# Four keys in THIS clone's .env are deliberately clobbered on every install — OPS_BACKEND, the
# engine credentials (HERMES_API_KEY / OPENCLAW_TOKEN) and ENGINE_PUSH_TOKEN, which is this clone's
# half of the secret the engine keeps as IRISES_PUSH_TOKEN / IRISES_BRIDGE_TOKEN and is adopted from
# there — because a credential the engine has since rotated is worse than useless: Irises 401s on
# every deep-work call and blames the engine, and nothing in either log says the clone is holding a
# dead key. The clobber is intended. The SILENCE was the bug — an operator who set one of these by
# hand saw no sign it had been replaced.
#
# A credential is reported by NAME ONLY: this script's output gets pasted into chats and issues.
# `show` is for the values that are not secrets (OPS_BACKEND is hermes|openclaw|off, and the script
# prints the engine it chose anyway), where seeing both sides is the whole point of the line.
# A scope this run was TOLD to use, against one the engine already carries. The file wins — an
# IRISES_FRONT already in place is either the operator's or a previous install's, and narrowing it
# from under them on a re-run is how a scope someone widened on purpose quietly snaps back. Said out
# loud, with the one line that changes it, rather than done silently or not mentioned at all.
front_says_kept() { # ENGINE_ENV
  local f="${1:-}" cur
  if [ "$FRONT_EXPLICIT" != "1" ]; then return 0; fi
  cur="$(env_get "$f" IRISES_FRONT)"
  if [ "$cur" = "$FRONT_PATTERN" ]; then return 0; fi
  say "--front asked for $FRONT_PATTERN, and the scope already in $f is what stands."
  # Quoted exactly as configure.sh's own help spells it: a pattern like *:* is a glob the operator's
  # shell would expand against the clone's files before configure.sh ever saw it.
  say "To take it over:  bash ./scripts/configure.sh --front '$FRONT_PATTERN'"
  return 0
}

# What --engine-env ask shows before it writes a byte, and what --engine-env print leaves behind
# instead of writing. One line per key that would CHANGE: `+` for a key the engine does not carry,
# `~` for one it carries with another value, and nothing at all for a key already in place — an
# install that says it is about to write four lines and changes none of them teaches the operator to
# stop reading the preview.
#
# NO SECRET VALUE IS EVER PRINTED, in either direction: the three tokens are named, and the old
# value beside a `~` is shown only for the two that are not secrets (a URL and a boolean). The
# operator is told where to read the real value from, out of a 0600 file they already own.
#
# Sets ENGINE_ENV_PENDING to the keys it listed, which is what the manifest records when nothing is
# written — so --uninstall knows there is nothing of ours in that file to take back out.
engine_env_preview() { # ENGINE_ENV PORT TOKEN
  local f="${1:-}" port="${2:-}" token="${3:-}" kv key val cur n secret listed=0
  ENGINE_ENV_PENDING=""
  say "These lines go into $f (backed up first to .bak-irises-<timestamp>):"
  for kv in \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_KEY=$(env_get "$ENV_FILE" HERMES_API_KEY)" \
    "IRISES_PUSH_TOKEN=$token" \
    "IRISES_URL=http://127.0.0.1:$port" \
    "IRISES_BRIDGE_TOKEN=$token" \
    "IRISES_FRONT=$FRONT_PATTERN"
  do
    key="${kv%%=*}"; val="${kv#*=}"
    case "$key" in
      IRISES_BRIDGE_TOKEN|IRISES_FRONT) if [ "$BRIDGE" != "1" ]; then continue; fi ;;
    esac
    secret=0
    case "$key" in API_SERVER_KEY|IRISES_PUSH_TOKEN|IRISES_BRIDGE_TOKEN) secret=1 ;; esac
    n="$(env_count "$f" "$key")"
    cur="$(env_get "$f" "$key")"
    if [ "$n" = "0" ]; then
      listed=1
      ENGINE_ENV_PENDING="$ENGINE_ENV_PENDING $key"
      if [ "$secret" = "1" ]; then
        say "  + $key=<this install's value, not shown>"
      else
        say "  + $key=$val"
      fi
      continue
    fi
    # IRISES_FRONT is the one key an install never takes over: a scope already in the file stands.
    if [ "$key" = "IRISES_FRONT" ]; then continue; fi
    if [ "$cur" = "$val" ] && [ "$n" -le 1 ]; then continue; fi
    listed=1
    ENGINE_ENV_PENDING="$ENGINE_ENV_PENDING $key"
    if [ "$secret" = "1" ]; then
      say "  ~ $key=<this install's value, not shown>$(if [ "$n" -gt 1 ]; then printf '     (%s copies, collapsed onto one line)' "$n"; elif [ -z "$cur" ]; then printf '     (the line is there and empty)'; fi)"
    else
      say "  ~ $key=$val     (was ${cur:-empty})"
    fi
  done
  if [ "$listed" = "0" ]; then
    say "  (nothing — every key Irises writes is already in that file with this install's value)"
  fi
  ENGINE_ENV_PENDING="${ENGINE_ENV_PENDING# }"
  return 0
}

# The other half of the same disclosure: what to do by hand when the answer was no. Same key list,
# same silence about values — the OpenClaw path has always ended this way, and a declined hermes
# install ends the same way now.
engine_env_manual() { # ENGINE_ENV PORT
  local f="${1:-}" port="${2:-}" key
  warn "nothing was written to $f. Irises is up on :$port, but the engine cannot reach it — and"
  warn "will not front anything — until these are in that file:"
  for key in $ENGINE_ENV_PENDING; do
    case "$key" in
      API_SERVER_ENABLED)  warn "  API_SERVER_ENABLED=true" ;;
      API_SERVER_KEY)      warn "  API_SERVER_KEY        — the value is HERMES_API_KEY in $ENV_FILE (0600); copy it across" ;;
      IRISES_PUSH_TOKEN)   warn "  IRISES_PUSH_TOKEN     — the value is ENGINE_PUSH_TOKEN in $ENV_FILE (0600)" ;;
      IRISES_BRIDGE_TOKEN) warn "  IRISES_BRIDGE_TOKEN   — the same ENGINE_PUSH_TOKEN value (one secret, two names)" ;;
      IRISES_URL)          warn "  IRISES_URL=http://127.0.0.1:$port" ;;
      IRISES_FRONT)        warn "  IRISES_FRONT=$FRONT_PATTERN" ;;
    esac
  done
  warn "then restart the engine's gateway, which is where it reads all of them."
  return 0
}

announce_overwrite() { # KEY NEWVALUE [show]
  local key="${1:-}" new="${2:-}" show="${3:-}" cur
  cur="$(env_get "$ENV_FILE" "$key")"
  if [ -z "$cur" ] || [ "$cur" = "$new" ]; then return 0; fi
  if [ "$show" = "show" ]; then
    say "updating $key in .env: $cur → $new"
  else
    say "updating $key in .env to the engine's live value (the old one is replaced, not kept)"
  fi
}

# ══ install ══════════════════════════════════════════════════════════════════
do_install() {
  local engine port kind node_bin unit="" plugin_dir="" adopted=0
  local keys_added="" keys_pre="" prev_added="" backup="" restore_from="" token engine_env=""
  local keys_retargeted="" prev_retargeted=""
  local sha="" live_sha="" gateway_ok=1 result="ok" rc=0 mem_mb="" v=""
  # Did THIS run put anything of ours in the engine's .env? Only a hermes install that wrote can say
  # true, and only `true` makes --uninstall (and --detach-engine) touch that file at all.
  local engine_env_write=1 engine_env_applied=false engine_env_pending=""

  # ── 1. prerequisites. PATH first: a non-login shell (and every agent-spawned run) can be missing
  #      node entirely — on the production VPS node lives at ~/.local/bin/node and nothing puts it
  #      on PATH for a non-interactive command.
  augment_path
  require_tools git curl npm || exit 1
  require_node_version 22.13 || exit 1
  node_bin="$(command -v node)"
  say "node:  $node_bin ($(node -v))"
  say "clone: $ROOT"

  # ── 2. engine: DETECT and READ only. Nothing is written to the engine until Irises itself is up,
  #      so a failed build can never leave keys pointing at a server that does not exist.
  engine="$(engine_kind "$ENGINE_FLAG")" || exit 2
  case "$engine" in
    hermes)
      engine_env="$(hermes_home)/.env"
      if [ ! -d "$(hermes_home)" ]; then
        die 1 "hermes not found (no $(hermes_home)) — install hermes-agent first, or pass --engine off"
      fi
      say "engine: hermes at $(hermes_home)"
      ;;
    openclaw)
      if ! command -v openclaw >/dev/null 2>&1; then
        die 1 "the openclaw CLI is not on PATH — install OpenClaw first, or pass --engine off"
      fi
      say "engine: OpenClaw at $(openclaw_home)"
      ;;
    off)
      say "engine: none (standalone) — no engine wiring, no gateway bounce"
      ;;
  esac

  # ── 3. port. Probe BEFORE any write: an install that edits config and then fails to bind leaves
  #      a half-wired engine pointing at nothing.
  port="${PORT_FLAG:-}"
  if [ -z "$port" ]; then
    port="$(env_get "$ENV_FILE" PORT)"
    if [ -z "$port" ]; then port="3000"; fi
  fi
  if tcp_open 127.0.0.1 "$port"; then
    live_sha="$(wait_health_sha "http://127.0.0.1:$port" "" 2 || true)"
    if [ -n "$live_sha" ]; then
      say "an Irises is already on :$port (build $(short_sha "$live_sha")) — this run will adopt it"
      adopted=1
    else
      err "something else already holds :$port and it is not Irises."
      err "free the port, or choose another:  bash ./scripts/engine-setup.sh --port 3001"
      exit 1
    fi
  fi

  lock_acquire || exit 1

  # ── 4. this clone's .env. chmod 600 from the start (the old script created it with touch → 0644,
  #      world-readable secrets). Never overwrite a value the operator set — except the port, which
  #      is what --port is for.
  if [ ! -e "$ENV_FILE" ]; then ( umask 077; : > "$ENV_FILE" ); fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  env_set "$ENV_FILE" PORT "$port"
  env_set_default "$ENV_FILE" WEB_ENABLED "true"
  say "Irises will listen on :$port (deploy/app.env's 8080 is for the Docker image behind Caddy)"
  # The optional extras, each written only when it was ASKED for. env_set, not env_set_default: a
  # flag that was passed is an answer, and an answer that loses to the value already in the file is
  # a switch the operator flipped and watched do nothing.
  if [ -n "$WEB_FLAG" ]; then
    if [ "$WEB_FLAG" = "on" ]; then
      env_set "$ENV_FILE" WEB_ENABLED "true"
      say "WEB_ENABLED=true — the browser chat and \`npm run chat\` are on"
    else
      env_set "$ENV_FILE" WEB_ENABLED "false"
      say "WEB_ENABLED=false — no browser chat on :$port; the engine's own channels are unaffected"
    fi
  fi
  if [ -n "$PINGS_FLAG" ]; then
    if [ "$PINGS_FLAG" = "on" ]; then v=true; else v=false; fi
    env_set "$ENV_FILE" THREADING_PINGS_ENABLED "$v"
    say "THREADING_PINGS_ENABLED=$v — whether she texts first about a thing you left hanging"
  fi
  if [ -n "$MUSINGS_FLAG" ]; then
    if [ "$MUSINGS_FLAG" = "on" ]; then v=true; else v=false; fi
    env_set "$ENV_FILE" IRISES_MUSINGS_ENABLED "$v"
    say "IRISES_MUSINGS_ENABLED=$v — whether she texts first about what is on her own mind"
  fi
  if [ -n "$TZ_FLAG" ]; then
    env_set "$ENV_FILE" IRISES_TZ "$TZ_FLAG"
    say "IRISES_TZ=$TZ_FLAG — the wall clock Irises reads, and the one quiet hours are counted in"
  fi
  if [ -n "${IRISES_DASHBOARD_PASSWORD:-}" ]; then
    env_set "$ENV_FILE" DASHBOARD_PASSWORD "$IRISES_DASHBOARD_PASSWORD"
    say "DASHBOARD_PASSWORD was taken from IRISES_DASHBOARD_PASSWORD in the environment and written"
    say "to $ENV_FILE (0600) — the value is not printed here or anywhere else"
  fi

  if [ "$engine" = "hermes" ]; then
    # Reuse the engine's own API key when it has one. env_get is last-wins, exactly like dotenv, so
    # a hermes .env carrying two API_SERVER_KEY blocks yields the LIVE one.
    local ekey
    ekey="$(env_get "$engine_env" API_SERVER_KEY)"
    if [ -z "$ekey" ]; then ekey="$(rand_token)"; fi
    announce_overwrite OPS_BACKEND hermes show
    env_set "$ENV_FILE" OPS_BACKEND hermes
    env_set_default "$ENV_FILE" HERMES_BASE_URL "http://127.0.0.1:8642"
    announce_overwrite HERMES_API_KEY "$ekey"
    env_set "$ENV_FILE" HERMES_API_KEY "$ekey"
    # The push token, adopted exactly like the API key above. This clone's ENGINE_PUSH_TOKEN and the
    # engine's IRISES_PUSH_TOKEN / IRISES_BRIDGE_TOKEN are ONE secret read from two files (src/webhook/
    # enginePush.ts and src/channels/bridge/inboundRouter.ts both check ENGINE_PUSH_TOKEN), so
    # whichever side already has one decides for both.
    #
    # This is the bug that made the rule: a throwaway clone installed against a developer's real
    # hermes generated its own token, wrote it over the engine's IRISES_PUSH_TOKEN, and --uninstall
    # then correctly left that pre-existing key alone — so their real Irises 403'd every engine push
    # with no line anywhere saying why. env_set, not env_set_default: the two sides MUST match, and a
    # clone value that disagrees with the engine's is the failure, not a preference to protect.
    local pushtok
    pushtok="$(env_get "$engine_env" IRISES_PUSH_TOKEN)"
    if [ -z "$pushtok" ] && [ "$BRIDGE" = "1" ]; then pushtok="$(env_get "$engine_env" IRISES_BRIDGE_TOKEN)"; fi
    if [ -z "$pushtok" ]; then pushtok="$(env_get "$ENV_FILE" ENGINE_PUSH_TOKEN)"; fi
    if [ -z "$pushtok" ]; then pushtok="$(rand_token)"; fi
    announce_overwrite ENGINE_PUSH_TOKEN "$pushtok"
    env_set "$ENV_FILE" ENGINE_PUSH_TOKEN "$pushtok"
    local k v
    for k in ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY OPENAI_BASE_URL; do
      v="$(env_get "$engine_env" "$k")"
      if [ -n "$v" ]; then env_set_default "$ENV_FILE" "$k" "$v"; fi
    done
  elif [ "$engine" = "openclaw" ]; then
    local otoken
    otoken="$(openclaw config get gateway.auth.token 2>/dev/null | tr -d '"' || true)"
    if [ -z "$otoken" ] || [ "$otoken" = "undefined" ]; then
      die 1 "could not read gateway.auth.token from OpenClaw — is its gateway configured?"
    fi
    announce_overwrite OPS_BACKEND openclaw show
    env_set "$ENV_FILE" OPS_BACKEND openclaw
    env_set_default "$ENV_FILE" OPENCLAW_URL "ws://127.0.0.1:18789"
    announce_overwrite OPENCLAW_TOKEN "$otoken"
    env_set "$ENV_FILE" OPENCLAW_TOKEN "$otoken"
    env_set_default "$ENV_FILE" ENGINE_PUSH_TOKEN "$(rand_token)"
  else
    announce_overwrite OPS_BACKEND off show
    env_set "$ENV_FILE" OPS_BACKEND off
  fi

  # ── 4b. the voice model, when the operator picked one. AFTER the engine-key block above, because
  #      this overrides what that block adopted: env_set, not env_set_default.
  # Guarded, because a half-written override is worse than none: the _PROVIDER keys and
  # ENGINE_MODEL_INHERIT=off can land while the model keys do not, and Irises then boots pointed at
  # a lane with no model. configure.sh:958 stops on the same failure for the same reason.
  if [ -n "$MODEL_LANE" ]; then
    model_override_write "$ENV_FILE" "$MODEL_LANE" "$MODEL_SLUG" "$MODEL_BASE_URL" ||
      die 1 "could not write the voice model override to $ENV_FILE"
  fi

  if [ -z "$(env_get "$ENV_FILE" ANTHROPIC_API_KEY)" ] \
     && [ -z "$(env_get "$ENV_FILE" OPENROUTER_API_KEY)" ] \
     && [ -z "$(env_get "$ENV_FILE" OPENAI_API_KEY)" ]; then
    warn "no ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY in $ENV_FILE"
    warn "Irises's own voice needs one (the engine key only covers deep work) — add it and restart"
  fi

  # ── 5. build. --include=dev FORCES devDependencies even under NODE_ENV=production (the documented
  #      prod env in deploy/app.env): tsc, cpx and tsx live there, so a bare `npm ci` strips the
  #      build toolchain and `npm run build` then dies with "tsc: not found".
  #
  #      Both are guarded, and not for form's sake: bare, they exit this script with the TOOL's code,
  #      and tsc's 2 is `--port` usage while its 4 is "health not verified" — a build failure that
  #      reports itself as one of the two documented outcomes it is not.
  say "installing dependencies + building (npm ci --include=dev && npm run build)"
  #      A 400 MB box swaps its way through this for minutes, and that thrash is enough to drop the
  #      SSH session the install is running in — which kills the install. Say so before it happens.
  mem_mb="$(mem_available_mb)"
  case "${mem_mb:-}" in
    ''|*[!0-9]*) ;;
    *) if [ "$mem_mb" -lt 300 ]; then
         warn "only ${mem_mb} MB of memory is free — this build can take several minutes, and the"
         warn "swap thrash can drop an SSH session with it. Run it inside tmux or screen if you can."
       fi ;;
  esac
  npm ci --include=dev || die 1 "npm ci failed — see above"
  npm run build || die 1 "the build failed — see above"
  sha="$(built_sha "$ROOT")"
  if [ -z "$sha" ]; then
    warn "dist/version.json carries no sha — health will be verified by liveness only"
  else
    say "built $(short_sha "$sha")"
  fi

  # OpenClaw's gateway client goes in AFTER npm ci, or ci prunes anything not in the lockfile.
  if [ "$engine" = "openclaw" ]; then
    say "installing @openclaw/gateway-client (optional dep, OpenClaw mode only)"
    npm install --no-save "@openclaw/gateway-client" \
      || warn "that failed — Irises will report the engine as unavailable until it installs"
  fi

  web_build "$ROOT"

  # ── 6. the service. This is the default: a nohup server does not survive a reboot, and nothing
  #      else on the box knows how to bring Irises back.
  kind="$(service_kind)"
  if [ "$SERVICE" = "0" ]; then
    say "--no-service — Irises will run detached; nothing will restart it after a reboot"
    kind="none"
  fi
  if [ "$adopted" = "1" ]; then
    # Adopt whatever is already serving :$port, so a re-run converts a hand-launched server into a
    # managed one instead of fighting it for the port.
    local pid
    pid="$(server_pid)"
    if [ -n "$pid" ]; then
      say "stopping the server we found (pid $pid) so the service can own the port"
      server_stop 20
    else
      warn "an Irises answers on :$port but no pidfile at $(irises_home)/irises.pid names it"
      if ! command -v pgrep >/dev/null 2>&1; then
        # No pgrep (Git Bash ships none), so there is no honest way to tell that server from any
        # other node on the box — and guessing here would end someone else's process.
        err "there is no pgrep on this box, so we cannot match it by command line either."
        die 1 "stop that server yourself, then re-run (its pidfile, when it writes one, is $(irises_home)/irises.pid)"
      fi
      if ask_yn "stop it by process match (pgrep -f dist/index.js under $ROOT) and take over?" y; then
        # Unix-only by the pgrep gate above: is_our_server confirms each candidate is OUR server
        # before anything is signalled.
        # server_stop_pid, not a bare kill: it WAITS for the pid to go and escalates to SIGKILL if it
        # does not. A bare kill plus a flat `sleep 3` was a guess, and a server that ignored SIGTERM
        # for four seconds took the port with it into the service install.
        local p
        for p in $(pgrep -f "$ROOT/dist/index.js" 2>/dev/null || true); do
          if is_our_server "$p"; then say "stopping pid $p"; server_stop_pid "$p" 10; fi
        done
      else
        die 1 "leaving it alone — stop it yourself, then re-run"
      fi
    fi
  fi
  case "$kind" in
    none)
      server_start_detached "$ROOT" \
        || die 1 "could not start Irises detached — see $(irises_home)/logs/server.log"
      ;;
    *)
      unit="$(service_install "$ROOT" "$node_bin")" || die 1 "could not install the $kind service"
      service_restart || die 1 "the $kind service would not start — check $(irises_home)/logs/server.log"
      say "Irises is a $kind service now ($unit)"
      ;;
  esac

  # ── 7. verify the build we just made is the build that answers. "Something answers /health" was
  #      the old check, and it is satisfied by the OLD process still holding the port.
  if ! live_sha="$(wait_health_sha "http://127.0.0.1:$port" "$sha" 60)"; then
    err "Irises did not report build $(short_sha "$sha") on http://127.0.0.1:$port/health within 60s"
    err "read the log:  tail -n 40 $(irises_home)/logs/server.log"
    err "'EADDRINUSE' there means something else holds :$port; a missing voice-model key shows there too"
    summary health-failed \
      "engine:   $engine" \
      "built:    $(short_sha "$sha") — NOT confirmed live" \
      "service:  $kind${unit:+ ($unit)}" \
      "log:      $(irises_home)/logs/server.log"
    exit 4
  fi
  say "health OK on :$port — build $(short_sha "$live_sha") is live"

  # ── 8. engine-side writes. Now, not earlier: the engine only ever points at a server we have
  #      SEEN answer. Back the file up first, and record exactly which keys were ours so
  #      --uninstall can put it back without guessing.
  if [ "$engine" = "hermes" ]; then
    # The push token this install will hand the engine — read before the preview below, which has to
    # be able to say which keys carry it without printing the value of any of them.
    token="$(env_get "$ENV_FILE" ENGINE_PUSH_TOKEN)"
    # CONSENT, before the first byte. `apply` is what every install has done since there was one, and
    # is still the default; `ask` shows the lines and writes them on a yes; `print` never writes. A
    # declined ask and a print take the same path — the one the OpenClaw install has always taken:
    # say exactly what to put in the file, name the secrets rather than printing them, and record in
    # the manifest that this engine .env carries nothing of ours, so --uninstall takes nothing out
    # of it.
    case "$ENGINE_ENV_MODE" in
      apply) ;;
      ask)
        engine_env_preview "$engine_env" "$port" "$token"
        if ! ask_yn "Write them now?" y; then
          engine_env_write=0
          say "not writing to $engine_env — the lines are yours to apply"
        fi
        ;;
      print)
        engine_env_preview "$engine_env" "$port" "$token"
        engine_env_write=0
        ;;
    esac
    if [ "$engine_env_write" = "1" ]; then
      if [ ! -f "$engine_env" ]; then
        say "creating $engine_env (chmod 600) — hermes only writes this file when it stores a secret,"
        say "so an empty one is normal on an OAuth/portal install"
        ( umask 077; : > "$engine_env" )
        chmod 600 "$engine_env" 2>/dev/null || true
      fi
      backup="$(env_backup "$engine_env" pre-install)"
      # …and the one the manifest keeps is the OLDEST of them. `backup` above is this run's snapshot,
      # which on a re-install already carries the IRISES_URL the FIRST install wrote — restoring from
      # it would put back a value of ours and call it the operator's. So a previous manifest's backup
      # wins, as long as it is still on disk and describes the same engine .env: that file is the only
      # record of what the engine looked like before Irises ever wrote to it.
      restore_from="$backup"
      local prev_backup prev_env
      prev_backup="$(manifest_read "$(manifest_path)" engineEnvBackup 2>/dev/null || true)"
      prev_env="$(manifest_read "$(manifest_path)" engineEnvFile 2>/dev/null || true)"
      if [ -n "$prev_backup" ] && [ -f "$prev_backup" ] && [ "$prev_env" = "$engine_env" ]; then
        restore_from="$prev_backup"
        say "--uninstall will restore from the first install's backup ($prev_backup)"
      fi
      # …and for the same reason the list of keys to restore FROM it is carried too (unioned at the end
      # of this block): install 2 finds IRISES_URL already naming this install and changes nothing, so
      # a list recomputed from this run alone would be empty — and the uninstall after it would leave
      # install 1's IRISES_URL in the engine's .env for good. Only from a manifest about THIS .env.
      if [ "$prev_env" = "$engine_env" ]; then
        prev_retargeted="$(manifest_read "$(manifest_path)" keysRetargeted 2>/dev/null || true)"
      fi
      # What the LAST install recorded as ours. "Already in the file" is not the same question as "not
      # ours": on every re-run every key we added the first time is already there, and classifying by
      # presence alone made the second install record the whole set as pre-existing — so the manifest
      # forgot them, and a later --uninstall left API_SERVER_*, IRISES_PUSH_TOKEN, IRISES_URL,
      # IRISES_BRIDGE_TOKEN and IRISES_FRONT behind in the engine's .env while claiming a clean removal.
      prev_added="$(manifest_read "$(manifest_path)" keysAdded 2>/dev/null || true)"
      if [ -n "$prev_added" ]; then
        say "a previous install recorded these engine keys as ours: $prev_added"
      fi
      # One positional argument per pair, accumulated in an array. The old form built a
      # newline-separated string and word-split it at the call — which meant a value containing
      # whitespace (an IRISES_URL behind a proxy path, a key someone pasted with a trailing space)
      # split into bogus half-lines in the engine's .env. bash 3.2 has no `+=`, hence the index.
      local pairs_n=0 key val kv cur adopt="" was_pre=0
      local pairs_arr=()
      for kv in \
        "API_SERVER_ENABLED=true" \
        "API_SERVER_KEY=$(env_get "$ENV_FILE" HERMES_API_KEY)" \
        "IRISES_PUSH_TOKEN=$token" \
        "IRISES_URL=http://127.0.0.1:$port"
      do
        key="${kv%%=*}"; val="${kv#*=}"
        if [ "$(env_count "$engine_env" "$key")" != "0" ]; then
          was_pre=0
          if key_was_ours "$key" "$prev_added"; then
            keys_added="$keys_added $key"
          else
            keys_pre="$keys_pre $key"
            was_pre=1
          fi
          cur="$(env_get "$engine_env" "$key")"
          # A key already in the file is not a key to overwrite. Which of the four this is decides
          # what happens to the value that is there, and every branch is a rule, not a preference:
          case "$key" in
            API_SERVER_KEY|IRISES_PUSH_TOKEN)
              # ADOPTED. Both are one secret shared with this clone, and the clone took its side of
              # them from here in step 4 — so `cur` is already what we would write. The env_set is
              # only ever a collapse: production carried two API_SERVER_KEY blocks with different
              # values, and only the last one was in effect.
              #
              # Except when the line is there and EMPTY, which is not a secret to adopt: `API_SERVER_KEY=`
              # authenticates nothing, and step 4 already generated this side a value when it read that
              # blank. Writing the blank back would have wired both halves to nothing and called it
              # adoption. `cur` is left as it was found on purpose — it is what the retarget check below
              # compares against, so the move is recorded and --uninstall puts the empty line back.
              adopt="$cur"
              if [ -z "$cur" ]; then
                adopt="$val"
                say "the engine's $key was empty — set it to this install's value (--uninstall puts it back)"
              elif [ "$(env_count "$engine_env" "$key")" != "1" ]; then
                say "adopting the engine's existing $key (collapsing $(env_count "$engine_env" "$key") copies)"
              else
                say "adopting the engine's existing $key"
              fi
              env_set "$engine_env" "$key" "$adopt"
              ;;
            IRISES_URL)
              # TAKEN OVER, out loud. The engine has to reach THIS install, so a value naming another
              # port or host cannot stand — but it is also the operator's line, so it is named (a URL
              # is not a secret) and it is restored from the pre-install backup by --uninstall.
              if [ "$cur" != "$val" ]; then
                warn "IRISES_URL in $engine_env pointed at $cur; this install ($val) takes over"
                warn "(--uninstall puts it back from $restore_from)"
              fi
              env_set "$engine_env" "$key" "$val"
              ;;
            API_SERVER_ENABLED)
              # TAKEN OVER too: with the engine's API server off there is no deep work, and an install
              # that silently leaves it off is an install that does not work. Restored on --uninstall.
              if [ "$cur" != "$val" ]; then
                warn "API_SERVER_ENABLED in $engine_env was $cur; Irises needs $val to reach the engine's API"
                warn "(--uninstall puts it back from $restore_from)"
              fi
              env_set "$engine_env" "$key" "$val"
              ;;
            *)
              # Anything added to the list above later, reported by NAME only: the shape of a value we
              # have not thought about is not something to print into a terminal that gets pasted.
              if [ "$cur" != "$val" ]; then
                say "$key in $engine_env now carries this install's value (--uninstall puts it back)"
              fi
              env_set "$engine_env" "$key" "$val"
              ;;
          esac
          # RETARGETED or not, decided by the FILE rather than by the branch above: an env_set that
          # wrote back the value already there changed nothing, and --uninstall must not "restore" a key
          # this install never moved — an API_SERVER_KEY the operator rotated a month later would go
          # back to a dead value and take every other client of the engine down with it. Adopted keys
          # and duplicate-collapses therefore compare equal and are never recorded. Only pre-existing
          # keys are tracked: one of ours is removed whole on uninstall, not restored.
          if [ "$was_pre" = "1" ] && [ "$(env_get "$engine_env" "$key")" != "$cur" ]; then
            keys_retargeted="$keys_retargeted $key"
          fi
        else
          keys_added="$keys_added $key"
          pairs_arr[$pairs_n]="$key=$val"
          pairs_n=$((pairs_n + 1))
        fi
      done
      if [ "$pairs_n" -gt 0 ]; then
        env_append_block "$engine_env" "Irises server" "${pairs_arr[@]}"
      fi
      if [ "$BRIDGE" = "1" ]; then
        if [ "$(env_count "$engine_env" IRISES_BRIDGE_TOKEN)" = "0" ]; then
          keys_added="$keys_added IRISES_BRIDGE_TOKEN"
          env_append_block "$engine_env" "bridge mode" "IRISES_BRIDGE_TOKEN=$token"
        else
          was_pre=0
          cur="$(env_get "$engine_env" IRISES_BRIDGE_TOKEN)"
          if key_was_ours IRISES_BRIDGE_TOKEN "$prev_added"; then
            keys_added="$keys_added IRISES_BRIDGE_TOKEN"
          else
            keys_pre="$keys_pre IRISES_BRIDGE_TOKEN"
            was_pre=1
          fi
          # ADOPTED like IRISES_PUSH_TOKEN, and for the same reason: the bridge token IS the push token
          # in this design (inboundRouter.ts and enginePush.ts both check ENGINE_PUSH_TOKEN), and step 4
          # already took this clone's copy from whichever of the two the engine had. So this env_set
          # writes back the value that is there — except in the one case where the engine held a
          # DIFFERENT value under each name, which no server can satisfy: the push token wins, said out
          # loud by name, and --uninstall puts the other back.
          #
          # A present-but-empty line is the third case, and it is not adoption either: `IRISES_BRIDGE_TOKEN=`
          # authenticates nothing, so this install's value goes in and is recorded as a move.
          if [ -z "$cur" ]; then
            say "the engine's IRISES_BRIDGE_TOKEN was empty — set it to this install's value"
            say "(--uninstall puts the empty line back from $restore_from)"
          elif [ "$cur" != "$token" ]; then
            warn "IRISES_BRIDGE_TOKEN in $engine_env did not match IRISES_PUSH_TOKEN — one secret, two names."
            warn "Both now carry the push token; --uninstall puts this one back from $restore_from"
          else
            say "adopting the engine's existing IRISES_BRIDGE_TOKEN"
          fi
          env_set "$engine_env" IRISES_BRIDGE_TOKEN "$token"
          # The one branch here that CAN move a pre-existing value, tracked the same way as the four
          # above: adopted (equal) leaves the list alone, the two-names mismatch does not.
          if [ "$was_pre" = "1" ] && [ "$(env_get "$engine_env" IRISES_BRIDGE_TOKEN)" != "$cur" ]; then
            keys_retargeted="$keys_retargeted IRISES_BRIDGE_TOKEN"
          fi
        fi
        if [ "$(env_count "$engine_env" IRISES_FRONT)" = "0" ]; then
          keys_added="$keys_added IRISES_FRONT"
          env_append_block "$engine_env" "front scope (edit to narrow, e.g. telegram:*)" "IRISES_FRONT=$FRONT_PATTERN"
          # The default scope is still the loud one, because it still means what it says. A scope the
          # operator NAMED is a decision they already made, so it is reported, not warned about.
          if [ "$FRONT_PATTERN" = "*:*" ]; then
            warn "IRISES_FRONT=*:*  — Irises now answers EVERY chat on EVERY platform this engine fronts."
            warn "Narrow it in $engine_env (patterns are fnmatch globs over <platform>:<chat_id>)."
          else
            say "IRISES_FRONT=$FRONT_PATTERN — Irises answers only the chats that match; the engine keeps the rest."
            say "Widen or narrow it in $engine_env (patterns are fnmatch globs over <platform>:<chat_id>)."
          fi
        elif key_was_ours IRISES_FRONT "$prev_added"; then
          # Ours from the last install, and left exactly as it stands — a scope narrowed by hand after
          # that install is the operator's, even though the line itself came from us.
          keys_added="$keys_added IRISES_FRONT"
          say "keeping the IRISES_FRONT this install already set ($(env_get "$engine_env" IRISES_FRONT))"
          front_says_kept "$engine_env"
        else
          keys_pre="$keys_pre IRISES_FRONT"
          say "keeping your IRISES_FRONT ($(env_get "$engine_env" IRISES_FRONT))"
          front_says_kept "$engine_env"
        fi
      fi
      engine_env_applied=true
    else
      engine_env_manual "$engine_env" "$port"
      engine_env_pending="$ENGINE_ENV_PENDING"
      # Nothing of ours went into that file, so there is nothing for a later --uninstall to put back
      # — including anything an EARLIER install moved, whose record this manifest is about to
      # overwrite. engineEnvApplied=false is what says so, in one place, to both of them.
      prev_retargeted=""
      prev_added=""
    fi
    # The plugin is a copy into the engine's own plugin dir, not a line in its .env, so it lands
    # whichever way the question above was answered.
    if [ "$BRIDGE" = "1" ]; then
      # plugin_dir is set only when the refresh actually put the plugin there — the summary and the
      # manifest both read it, and neither may claim a plugin that is not on disk.
      if plugin_refresh hermes "$ROOT"; then
        plugin_dir="$(hermes_home)/plugins/irises-bridge"
      else
        warn "the plugin did not install — fronting will not work yet"
      fi
      say "fail policy: if Irises is down the engine answers fronted chats itself"
      say "(set IRISES_BRIDGE_FAIL=closed in $engine_env for silence instead)"
    else
      say "--no-bridge: the engine keeps answering its own channels. API_SERVER_* is still wired,"
      say "so Irises can do deep work through it."
    fi
    # The union promised above: what an earlier install of THIS clone moved is still moved, however
    # little this run had left to do. The manifest is overwritten wholesale, so a list not carried
    # here is a list forgotten.
    for key in $prev_retargeted; do
      if ! key_was_ours "$key" "$keys_retargeted"; then
        keys_retargeted="$keys_retargeted $key"
      fi
    done
    if [ -n "${keys_retargeted# }" ]; then
      say "--uninstall will put these back from $restore_from (and nothing else):${keys_retargeted}"
    fi
  elif [ "$engine" = "openclaw" ] && [ "$BRIDGE" = "1" ]; then
    if plugin_refresh openclaw "$ROOT"; then
      plugin_dir="$(openclaw_home)/extensions/irises-bridge"
    else
      warn "the plugin did not install — fronting will not work yet"
    fi
    # The token is NOT printed. This script's output gets pasted into chats, issues and pastebins,
    # and IRISES_BRIDGE_TOKEN is the whole authentication between the gateway and Irises — so the
    # operator is told the key name and where to read the value from a 0600 file they already own.
    warn "give the OpenClaw GATEWAY process these three variables (its own env, not this clone's):"
    warn "  IRISES_BRIDGE_TOKEN   — the value is ENGINE_PUSH_TOKEN in $ENV_FILE (0600); copy it across"
    warn "  IRISES_URL=http://127.0.0.1:$port"
    warn "  IRISES_FRONT=whatsapp:*,telegram:123    # empty = front NOTHING"
  fi

  # ── 9. the manifest: what to undo, what was never ours, and which of the latter we moved. It
  #      OVERWRITES the previous one, which is why keysAdded and keysRetargeted are both carried
  #      forward above rather than recomputed from this run's view of the engine .env alone.
  #      A warn, not a die: the engine is already wired and Irises is already answering, so aborting
  #      here would leave a working install reported as a failure. --uninstall has a fallback for a
  #      missing manifest.
  manifest_write "$(manifest_path)" \
    "root=$ROOT" \
    "irisesHome=$(irises_home)" \
    "port=$port" \
    "engine=$engine" \
    "engineEnvFile=${engine_env:-}" \
    "engineEnvBackup=${restore_from:-}" \
    "pluginDir=${plugin_dir:-}" \
    "serviceKind=$kind" \
    "serviceUnit=${unit:-}" \
    "nodeBin=$node_bin" \
    "keysAdded=${keys_added# }" \
    "keysPreExisting=${keys_pre# }" \
    "keysRetargeted=${keys_retargeted# }" \
    "bridge=$BRIDGE" \
    "frontPattern=$FRONT_PATTERN" \
    "engineEnvApplied=$engine_env_applied" \
    "modelLane=${MODEL_LANE:-inherit}" \
    "engineEnvPending=$engine_env_pending" \
    || warn "could not write the install manifest — --uninstall will have to fall back to the marker comments"

  # ── 10. the gateway. ALWAYS, when an engine is configured: the plugin, IRISES_FRONT and
  #       API_SERVER_* are only read when the gateway starts, so an install that skips this is an
  #       install that does nothing until the operator works out why. Hence a skipped bounce is
  #       said out loud, with the way to do it, rather than left for the operator to discover.
  if [ "$engine" != "off" ]; then
    if [ "$GATEWAY_RESTART" = "0" ]; then
      gateway_ok="skipped"
      warn "gateway NOT restarted ($GATEWAY_SKIP_WHY) — the bridge goes live once you $(gateway_restart_hint "$engine")"
    elif ! gateway_restart "$engine" 90; then
      gateway_ok=0
      result="gateway-failed"
      rc=5
    fi
  fi

  if [ "$adopted" = "1" ] && [ "$result" = "ok" ]; then result="adopted"; fi

  summary "$result" \
    "engine:    $engine${plugin_dir:+ (bridge plugin at $plugin_dir)}" \
    "build:     $(short_sha "$live_sha") — confirmed live on http://127.0.0.1:$port/health" \
    "service:   $kind${unit:+ ($unit)}" \
    "data:      $(irises_home)  (irises.db + memories/ — never touched by an update)" \
    "logs:      $(irises_home)/logs/server.log" \
    "gateway:   $(if [ "$engine" = "off" ]; then printf 'n/a (standalone)'; elif [ "$gateway_ok" = "skipped" ]; then printf 'NOT restarted (%s) — to go live, %s' "$GATEWAY_SKIP_WHY" "$(gateway_restart_hint "$engine")"; elif [ "$gateway_ok" = "1" ]; then printf 'bounced and verified'; else printf 'NOT verified — bounce it yourself'; fi)" \
    "talk to it: $(if [ -d "$ROOT/web/out" ]; then printf 'http://127.0.0.1:%s  ·  npm run chat' "$port"; else printf 'npm run chat   (web UI not built — IRISES_WEB=1 to build it)'; fi)" \
    "update it: bash scripts/update.sh        remove it: bash scripts/engine-setup.sh --uninstall"
  exit "$rc"
}

# ── uninstall, step by step ───────────────────────────────────────────────────
# The five things an uninstall does, each one its own function so that --detach-engine can run the
# three that are about the ENGINE and leave the two that are about IRISES alone. The bodies are the
# ones do_uninstall carried before there was a second caller: they read and write do_uninstall's
# own locals (bash scopes those dynamically, so a step sees the caller's frame), and the two `local`
# lines that used to sit mid-body — `present`/`restored` and `size` — moved up into that frame,
# because the summary reads them after the step that sets them has returned.

# After a detach there is still an Irises here — a service, a clone, a database — and still a
# manifest describing it. What that manifest may no longer claim is anything on the engine's side:
# the keys are back, the plugin is gone, and a later --uninstall reading those lists would "restore"
# values that are already restored and bounce a gateway for nothing.
detach_manifest_step() {
  local root_v home_v port_v kind_v unit_v node_v front_v model_v
  if [ ! -f "$man" ]; then
    say "there was no install manifest, so there is none to rewrite"
    return 0
  fi
  root_v="$(manifest_read "$man" root)"
  home_v="$(manifest_read "$man" irisesHome)"
  port_v="$(manifest_read "$man" port)"
  kind_v="$(manifest_read "$man" serviceKind)"
  unit_v="$(manifest_read "$man" serviceUnit)"
  node_v="$(manifest_read "$man" nodeBin)"
  front_v="$(manifest_read "$man" frontPattern)"
  model_v="$(manifest_read "$man" modelLane)"
  if manifest_write "$man" \
    "root=${root_v:-$ROOT}" \
    "irisesHome=${home_v:-$home}" \
    "port=${port_v:-$port}" \
    "engine=$engine" \
    "engineEnvFile=${engine_env:-}" \
    "engineEnvBackup=" \
    "pluginDir=" \
    "serviceKind=${kind_v:-}" \
    "serviceUnit=${unit_v:-}" \
    "nodeBin=${node_v:-}" \
    "keysAdded=" \
    "keysPreExisting=" \
    "keysRetargeted=" \
    "bridge=0" \
    "frontPattern=${front_v:-}" \
    "engineEnvApplied=false" \
    "engineEnvPending=" \
    "modelLane=${model_v:-inherit}"; then
    man_state="rewritten at $man — it records no engine-side change any more"
    say "the manifest now records nothing on the engine's side: an --uninstall after this one"
    say "removes the service and leaves $engine exactly as it stands"
  else
    man_state="STILL at $man, describing an attachment that is gone — remove it yourself"
    warn "could not rewrite $man"
    failed=1
  fi
  return 0
}

stop_service_step() {
  # ── 1. stop and remove the service (or the detached server). service_installed knows all three
  #      backends — a bare unit/plist check reports "not installed" on Windows, where the install is
  #      a Task Scheduler entry and no file of ours at all.
  kind="$(service_kind)"
  if service_installed; then
    did_something=1
    svc_found=1
    say "stopping and removing the $kind service"
    service_stop || true
    service_uninstall || { err "could not fully remove the service"; failed=1; }
  else
    say "no service installed (no unit, no plist, no scheduled task)"
  fi
  local pid
  pid="$(server_pid)"
  if [ -n "$pid" ]; then
    did_something=1
    server_stop 20
  fi
  # The old setup script left a second pidfile in the clone root; clear both so nothing later
  # mistakes a dead pid for a live server.
  for f in "$home/irises.pid" "$ROOT/irises.pid"; do
    if [ -f "$f" ]; then rm -f "$f"; say "removed $f"; fi
  done
  return 0
}

remove_plugin_step() {
  # ── 2. the bridge plugin. Run on the strength of the plugin_dir we KNOW about, not on the dir
  #      still being there: plugin_remove also DISABLES the plugin in the engine's own config, and
  #      that is the half that matters. Someone who deleted the directory by hand and then ran
  #      --uninstall was left with a gateway still configured to load a plugin that is gone.
  #      did_something, though, still tracks the DIRECTORY: a disable we cannot observe the result of
  #      is not evidence of a change, and treating it as one would make every repeat --uninstall
  #      bounce the gateway again (see the engine keys below for the same rule).
  if [ -n "$plugin_dir" ]; then
    if [ -d "$plugin_dir" ]; then
      did_something=1
      plugin_found=1
    else
      say "$plugin_dir is already gone — still disabling the plugin in the engine's config"
    fi
    plugin_remove "$engine" || failed=1
  else
    if [ "$engine" != "off" ]; then say "no bridge plugin to remove (nothing names one)"; fi
  fi
  return 0
}

restore_engine_env_step() {
  # ── 3. the engine's keys. LOOK BEFORE TOUCHING: the second --uninstall in a row used to take a
  #      fresh backup of an already-clean .env and bounce the gateway for it, because did_something
  #      was set on the strength of the manifest listing keys rather than the file still holding any.
  #      So count first, and let `removed`/`restored` be the only things that say a change happened.
  #
  #      BOTH lists are counted, and that is the fix for the install that had nothing to add: an
  #      engine already carrying a full Irises wiring leaves keysAdded EMPTY and keysRetargeted
  #      naming IRISES_URL, and a `present` computed from keysAdded alone skipped the restore with
  #      it — so the engine went on pointing at a clone that no longer existed, and the summary said
  #      ok. A manifest-less run has no keysRetargeted at all, so the repeat --uninstall above stays
  #      the no-op it has to be.
  if [ -n "${engine_env:-}" ] && [ -f "$engine_env" ]; then
    # shellcheck disable=SC2086  # keys_added is a space-separated key list by construction
    for k in $keys_added; do
      if [ "$(env_count "$engine_env" "$k")" != "0" ]; then present=1; fi
    done
    # shellcheck disable=SC2086  # keys_retargeted is a space-separated key list by construction
    for k in $keys_retargeted; do
      if retarget_pending "$engine_env" "$pre_backup" "$k"; then present=1; fi
    done
  fi
  if [ "$present" = "1" ]; then
    backup="$(env_backup "$engine_env" pre-uninstall)"
    if [ -n "$keys_added" ]; then
      # shellcheck disable=SC2086  # keys_added is a space-separated key list by construction
      removed="$(env_remove_irises_block "$engine_env" $keys_added)"
      case "$removed" in ''|*[!0-9]*) removed=0 ;; esac
      say "removed $removed Irises key(s) from $engine_env (backup: ${backup:-none})"
      if [ "$removed" -gt 0 ]; then did_something=1; fi
    else
      say "this install added no key of its own to $engine_env — it found every one of them already"
      say "in place, so there is nothing to remove, only values to put back (backup: ${backup:-none})"
    fi
    # The pre-existing keys the install CHANGED — keysRetargeted, not keysPreExisting. Removing them
    # is not the question: the install overwrote them (IRISES_URL has to name this install,
    # API_SERVER_ENABLED has to be true), and leaving those values behind is how a throwaway install
    # outlives itself. The pre-install backup is the only record of what they said, so each one goes
    # back to what it said there, by name.
    #
    # And ONLY those. Restoring every pre-existing key would revert an operator's later edit — an
    # API_SERVER_KEY rotated last week, a push token changed by hand — to whatever the file said on
    # install day, silently breaking every other client of the engine. A key this install adopted or
    # never touched is the operator's, at whatever value they now have it, including a duplicate they
    # put there themselves.
    # shellcheck disable=SC2086  # keys_retargeted is a space-separated key list by construction
    for k in $keys_retargeted; do
      n="$(env_count "$engine_env" "$k")"
      if [ -n "$pre_backup" ] && [ -f "$pre_backup" ] && [ "$(env_count "$pre_backup" "$k")" != "0" ]; then
        old="$(env_get "$pre_backup" "$k")"
        cur="$(env_get "$engine_env" "$k")"
        if [ "$old" != "$cur" ] || [ "$n" -gt 1 ]; then
          if [ "$n" -gt 1 ]; then
            say "collapsing $n copies of $k onto one line (dotenv reads the last one)"
          fi
          if env_set "$engine_env" "$k" "$old"; then
            say "restored $k to its pre-install value"
            restored=$((restored + 1))
            did_something=1
          else
            err "could not restore $k in $engine_env — its pre-install value is in $pre_backup"
            failed=1
          fi
        fi
      else
        if [ "$n" -gt 1 ]; then
          say "collapsing $n copies of $k onto its live value (dotenv reads the last one)"
          env_set "$engine_env" "$k" "$(env_get "$engine_env" "$k")"
        fi
        if [ -n "$pre_backup" ]; then
          warn "$k left exactly as it stands — $pre_backup would have restored it, and it is gone"
        else
          warn "$k left exactly as it stands — this install recorded no pre-install backup to restore from"
        fi
      fi
    done
    if [ -n "$keys_pre" ]; then
      say "keys that were there before Irises: $keys_pre"
      if [ -n "$keys_retargeted" ]; then
        say "of those, this install changed: $keys_retargeted ($restored put back from the backup)."
        say "The rest are left exactly as you have them now — a value you changed after the install"
        say "stays changed."
      else
        say "this install changed none of them, so all of them are left exactly as you have them now"
      fi
    fi
  elif [ -n "${engine_env:-}" ]; then
    say "nothing of ours to remove from ${engine_env}"
  fi
  return 0
}

bounce_gateway_step() {
  # ── 4. the gateway, so the engine actually forgets the plugin (it loads plugins only at start).
  if [ "$engine" != "off" ] && [ "$did_something" = "1" ]; then
    if [ "$GATEWAY_RESTART" = "0" ]; then
      gateway_ok="skipped"
      warn "gateway NOT restarted ($GATEWAY_SKIP_WHY) — the engine forgets the plugin once you $(gateway_restart_hint "$engine")"
    elif ! gateway_restart "$engine" 90; then
      gateway_ok=0
      result="gateway-failed"
      rc=5
    fi
  fi
  return 0
}

data_step() {
  # ── 5. the data. KEPT by default: irises.db and memories/ are the only irreplaceable things here.
  if [ -d "$home" ]; then size="$(du -sh "$home" 2>/dev/null | cut -f1 || printf unknown)"; fi
  # The copy you keep, taken BEFORE the gate below and not after it: an archive offered after the
  # rm has already run is a sentence, not an option. A failed archive cancels the purge outright —
  # deleting the only copy of something because the backup of it could not be written is the one
  # outcome this flag exists to prevent.
  if [ "$ARCHIVE_DATA" = "1" ]; then
    local tarball=""
    if [ -d "$home" ]; then
      tarball="$(archive_home "")" || tarball=""
      if [ -n "$tarball" ]; then
        say "archived $home ($size) to $tarball"
      else
        err "could not archive $home — so nothing here is deleted"
        failed=1
        PURGE_DATA=0
      fi
    else
      say "no $home to archive"
    fi
  fi
  if [ "$PURGE_DATA" = "1" ]; then
    local answer=""
    if [ "$ASSUME_YES" = "1" ]; then
      warn "--purge-data with --yes: deleting $home ($size) without asking"
      answer="delete"
    else
      warn "this deletes $home ($size) — irises.db and every memory file, with no backup."
      printf '\033[31m[%s]\033[0m type the word delete to confirm: ' "$IRISES_LOG_TAG"
      read -r answer || answer=""
    fi
    if [ "$answer" = "delete" ]; then
      case "$home" in
        ""|/|"$HOME"|"$HOME/") die 1 "refusing to delete '$home' — that is not an Irises state directory" ;;
      esac
      rm -rf "$home"
      say "removed $home"
    else
      # Not a failure: --purge-data is a request to be ASKED, and declining is the answer. The
      # uninstall itself succeeded; exiting 1 here made "your data was kept" read as "something
      # broke", which is the one message an operator must not get wrong about their own database.
      say "your data was KEPT: $home ($size) — you did not type 'delete'"
      say "remove it yourself when you are sure:  rm -rf $home"
    fi
  else
    if [ -d "$home" ]; then
      say "your data is KEPT: $home ($size)"
      say "remove it yourself when you are sure:  rm -rf $home"
      say "(or re-run with --purge-data)"
    fi
  fi
  return 0
}

# ══ uninstall ════════════════════════════════════════════════════════════════
# No node gate here on purpose: this path needs bash, git and curl only, so it still works on a box
# whose node has since been upgraded away or removed.
do_uninstall() {
  local man engine engine_env plugin_dir kind home port f
  local failed=0 gateway_ok=1 result="ok" rc=0 did_something=0
  local keys_added keys_pre backup pre_backup="" man_state="none was found"
  local keys_retargeted="" has_retargeted=0 k=""
  local removed=0 svc_found=0 plugin_found=0
  # Set inside the step functions below, read by the summary after they return. bash scopes locals
  # dynamically, so this frame is the one they write into — but only if the names live HERE.
  local n old cur present=0 restored=0 size="unknown"

  augment_path
  require_tools curl || failed=1

  man="$(manifest_path)"
  home="$(irises_home)"
  if [ -f "$man" ]; then
    say "reading the install manifest: $man"
    man_state="read"
    engine="$(manifest_read "$man" engine)"
    engine_env="$(manifest_read "$man" engineEnvFile)"
    plugin_dir="$(manifest_read "$man" pluginDir)"
    keys_added="$(manifest_read "$man" keysAdded)"
    keys_pre="$(manifest_read "$man" keysPreExisting)"
    keys_retargeted="$(manifest_read "$man" keysRetargeted)"
    pre_backup="$(manifest_read "$man" engineEnvBackup)"
    port="$(manifest_read "$man" port)"
    # PRESENT-but-empty and ABSENT are two different manifests and one empty string, so the key is
    # looked for by name: an install that moved nothing writes an empty list and means it, while a
    # manifest from before this script recorded no list at all and needs the fallback below.
    if grep -q '"keysRetargeted"' "$man" >/dev/null 2>&1; then has_retargeted=1; fi
    if [ "$has_retargeted" = "0" ] && [ -n "$keys_pre" ]; then
      keys_retargeted=""
      for k in $keys_pre; do
        case "$k" in IRISES_URL|API_SERVER_ENABLED) keys_retargeted="$keys_retargeted $k" ;; esac
      done
      keys_retargeted="${keys_retargeted# }"
      say "this manifest predates keysRetargeted, so which pre-existing keys that install actually"
      say "changed is not recorded. Only the two an install HAS to take over are put back${keys_retargeted:+ ($keys_retargeted)};"
      say "everything else it found in place is left exactly as it stands now."
    fi
    # An install that wrote nothing to the engine's .env — `--engine-env print`, or an `ask` that was
    # answered no — recorded engineEnvApplied=false. Nothing of ours is in that file, so nothing of
    # ours comes out of it: no backup, no removal, no restore. A manifest written before this key
    # existed says nothing at all, and silence means the install DID write, which is what every
    # install before it did.
    if [ "$(manifest_read "$man" engineEnvApplied)" = "false" ]; then
      say "the manifest records nothing of ours in the engine's .env — so nothing comes out of it"
      local pending
      pending="$(manifest_read "$man" engineEnvPending)"
      if [ -n "$pending" ]; then
        say "it left these for you to apply by hand: $pending"
        say "if you did apply them, they are yours now — remove them from $engine_env yourself"
      fi
      engine_env=""
      keys_added=""
      keys_retargeted=""
    fi
  else
    warn "no install manifest at $man — falling back to detection"
    warn "(a pre-rewrite install left none. The four keys Irises ever writes — IRISES_PUSH_TOKEN,"
    warn "IRISES_BRIDGE_TOKEN, IRISES_URL, IRISES_FRONT — are then matched by VALUE against THIS"
    warn "clone, and only the ones that name it are removed, with any marker comment they leave.)"
    engine="$(engine_kind "$ENGINE_FLAG")"
    keys_pre=""
    keys_retargeted=""
    port="$(irises_port)"
    case "$engine" in
      hermes)   engine_env="$(hermes_home)/.env";   plugin_dir="$(hermes_home)/plugins/irises-bridge" ;;
      openclaw) engine_env="";                      plugin_dir="$(openclaw_home)/extensions/irises-bridge" ;;
      *)        engine_env="";                      plugin_dir="" ;;
    esac
    # Without a manifest, "ours" cannot be settled by NAME. A completed uninstall takes the manifest
    # with it (step 6), so "no manifest" also means "already uninstalled" — and on that box an
    # IRISES_URL or an IRISES_PUSH_TOKEN belongs to whichever OTHER Irises is still wired to this
    # engine, if any. Deleting it by name is the same defect this list caused once already, arriving
    # from the other end. So each key is matched by VALUE against THIS clone:
    #
    #   IRISES_URL                            only when it names this clone's port
    #   IRISES_PUSH_TOKEN, IRISES_BRIDGE_TOKEN  only when they carry this clone's ENGINE_PUSH_TOKEN
    #   IRISES_FRONT                          only when one of those three matched — the front scope
    #                                         carries no value of ours, so nothing in the line itself
    #                                         says who wrote it, and the other keys are what settle it
    #
    # A key that does not match is NAMED and left exactly as it stands. API_SERVER_* is not in the
    # list at all: the engine may well have had its API server on before Irises existed, and turning
    # it off would break everything else that talks to it.
    keys_added=""
    local mine=0 clone_token="" skipped="" cur_val=""
    clone_token="$(env_get "$ENV_FILE" ENGINE_PUSH_TOKEN)"
    warn "API_SERVER_ENABLED / API_SERVER_KEY will be LEFT ALONE (no manifest = no proof they were ours)"
    if [ -n "$engine_env" ] && [ -f "$engine_env" ]; then
      if [ "$(env_count "$engine_env" IRISES_URL)" != "0" ]; then
        cur_val="$(env_get "$engine_env" IRISES_URL)"
        if [ "$cur_val" = "http://127.0.0.1:$port" ] || [ "$cur_val" = "http://localhost:$port" ]; then
          keys_added="$keys_added IRISES_URL"
          mine=1
        else
          skipped="$skipped IRISES_URL"
        fi
      fi
      for k in IRISES_PUSH_TOKEN IRISES_BRIDGE_TOKEN; do
        if [ "$(env_count "$engine_env" "$k")" = "0" ]; then continue; fi
        if [ -n "$clone_token" ] && [ "$(env_get "$engine_env" "$k")" = "$clone_token" ]; then
          keys_added="$keys_added $k"
          mine=1
        else
          skipped="$skipped $k"
        fi
      done
      if [ "$(env_count "$engine_env" IRISES_FRONT)" != "0" ]; then
        if [ "$mine" = "1" ]; then keys_added="$keys_added IRISES_FRONT"; else skipped="$skipped IRISES_FRONT"; fi
      fi
      keys_added="${keys_added# }"
      if [ -n "$keys_added" ]; then
        say "these engine keys carry values of this clone's, so they are ours to remove: $keys_added"
      else
        say "no key in $engine_env carries a value of this clone's — not its port (:$port), not its"
        say "push token — so nothing here is provably ours and no engine key is touched."
      fi
      if [ -n "$skipped" ]; then
        say "left exactly as they stand:$skipped — those values name some other Irises, not this"
        say "clone. Remove them by hand if that install is gone too; nothing else of Irises reads them."
      fi
    fi
  fi
  if [ -z "$engine" ]; then engine="off"; fi
  if [ -z "$port" ]; then port="$(irises_port)"; fi

  # ── detach: the engine's three steps, and none of Irises's own. "As if Irises had never been
  #    installed" is scoped to the ENGINE — the plugin dir, every key the manifest records as added,
  #    every value it records as moved, and the gateway bounce that makes the engine forget all of
  #    it. The .bak-irises-* files stay, deliberately: they are the only record of what that file
  #    said before, and they cost nothing. Irises itself — the service, this clone, your data — is
  #    not touched, which is the whole difference between this and --uninstall.
  if [ "$MODE" = "detach" ]; then
    # Said rather than refused: both flags are about the data directory, and a detach does not go
    # near it. Silently accepting a --purge-data that deletes nothing is the version of this that
    # sends someone looking for their database.
    if [ "$PURGE_DATA" = "1" ] || [ "$ARCHIVE_DATA" = "1" ]; then
      warn "--purge-data / --archive-data do nothing here: a detach never touches $home."
      warn "They belong to --uninstall, which is the mode that can remove your data."
    fi
    if [ "$ASSUME_YES" != "1" ]; then
      say "about to undo every engine-side change: the bridge plugin, the keys Irises added to"
      say "${engine_env:-that engine .env}, and the values it moved. The .bak-irises-* backups stay."
      say "Irises keeps running, its service stays installed, and your data ($home) is untouched."
      if ! ask_yn "go ahead?" n; then
        say "aborted — nothing changed"
        summary noop "nothing was detached"
        exit 0
      fi
    fi

    lock_acquire || exit 1

    remove_plugin_step
    restore_engine_env_step
    bounce_gateway_step
    detach_manifest_step

    if [ "$failed" = "1" ] && [ "$result" = "ok" ]; then result="partial"; rc=1; fi
    if [ "$result" = "ok" ]; then result="detached"; fi
    if [ "$did_something" = "0" ] && [ "$failed" = "0" ]; then
      say "nothing to detach — no plugin of ours, no engine key of ours"
    fi

    summary "$result" \
      "engine:   $engine — $removed key(s) removed, $restored put back${backup:+, backup at $backup}" \
      "plugin:   $(if [ -n "$plugin_dir" ] && [ -d "$plugin_dir" ]; then printf 'STILL PRESENT at %s' "$plugin_dir"; elif [ "$plugin_found" = "1" ]; then printf 'removed'; else printf 'none was installed'; fi)" \
      "gateway:  $(if [ "$engine" = "off" ]; then printf 'n/a'; elif [ "$did_something" = "0" ]; then printf 'not bounced (nothing changed)'; elif [ "$gateway_ok" = "skipped" ]; then printf 'NOT restarted (%s) — %s' "$GATEWAY_SKIP_WHY" "$(gateway_restart_hint "$engine")"; elif [ "$gateway_ok" = "1" ]; then printf 'bounced and verified'; else printf 'NOT verified — bounce it yourself'; fi)" \
      "manifest: $man_state" \
      "Irises:   still installed and still running — this detached it from the engine, nothing more" \
      "data:     $home — untouched" \
      "attach it again: bash ./scripts/engine-setup.sh        remove it: bash ./scripts/engine-setup.sh --uninstall"
    exit "$rc"
  fi

  if [ "$ASSUME_YES" != "1" ]; then
    say "about to remove: the Irises service, the bridge plugin, and the keys Irises added to the engine"
    say "your data ($home) is KEPT unless --purge-data is passed"
    if ! ask_yn "go ahead?" n; then
      say "aborted — nothing changed"
      summary noop "nothing was removed"
      exit 0
    fi
  fi

  lock_acquire || exit 1

  stop_service_step
  remove_plugin_step
  restore_engine_env_step
  bounce_gateway_step
  data_step

  # ── 6. the manifest. It describes an install that is not here any more: its keysAdded name keys
  #      that have just been removed and its engineEnvBackup restores values already restored, so a
  #      later run reading it would be acting on a record of the past. It goes when the run went
  #      cleanly (--purge-data has already taken it with the directory), and stays on a partial one,
  #      where the operator may still need to finish the removal by hand.
  if [ -f "$man" ]; then
    if [ "$failed" = "1" ]; then
      man_state="kept at $man — this uninstall was partial"
      warn "keeping $man: this run did not finish, and it is the record of what is left"
    elif rm -f "$man"; then
      man_state="removed"
      say "removed the install manifest ($man) — the install it described is gone"
    else
      man_state="STILL at $man — remove it yourself"
      warn "could not remove $man"
    fi
  elif [ "$man_state" = "read" ]; then
    man_state="removed"
  fi

  # ── 7. the clone, and the engine patch series. Neither is ours to delete.
  say "this clone is NOT deleted. When you are done with it:  rm -rf $ROOT"
  if [ "$engine" = "hermes" ]; then
    local checkout patch
    checkout="$(hermes_home)/hermes-agent"
    patch="$ROOT/bridge/hermes/photon-reply-context/0001-photon-inbound-reply-context.patch"
    if [ -d "$checkout/.git" ] && [ -f "$patch" ]; then
      # Two honest signals: the branch the bundle's apply.sh leaves behind, or the patch applying
      # cleanly IN REVERSE (which is only possible when it is currently applied).
      if git -C "$checkout" rev-parse --verify --quiet irises/photon-reply-context >/dev/null 2>&1 \
         || git -C "$checkout" apply --reverse --check "$patch" >/dev/null 2>&1; then
        warn "the Photon reply-context patch series is applied to $checkout."
        warn "It is an engine-side change Irises asked for, and this uninstall does NOT revert it."
        warn "To revert it yourself:"
        warn "  git -C $checkout apply --reverse $patch"
        warn "  (then bounce the gateway; see bridge/hermes/photon-reply-context/README.md)"
      fi
    fi
  fi

  if [ "$failed" = "1" ] && [ "$result" = "ok" ]; then result="partial"; rc=1; fi
  if [ "$did_something" = "0" ] && [ "$failed" = "0" ]; then
    say "nothing to uninstall — no service, no plugin, no engine keys of ours"
  fi

  summary "$result" \
    "service:  $(if service_installed; then printf 'STILL INSTALLED — remove it by hand'; elif [ "$svc_found" = "1" ]; then printf 'removed'; else printf 'none was installed'; fi)" \
    "plugin:   $(if [ -n "$plugin_dir" ] && [ -d "$plugin_dir" ]; then printf 'STILL PRESENT at %s' "$plugin_dir"; elif [ "$plugin_found" = "1" ]; then printf 'removed'; else printf 'none was installed'; fi)" \
    "engine:   $engine — $removed key(s) removed, $restored put back${backup:+, backup at $backup}" \
    "manifest: $man_state" \
    "gateway:  $(if [ "$engine" = "off" ]; then printf 'n/a'; elif [ "$did_something" = "0" ]; then printf 'not bounced (nothing changed)'; elif [ "$gateway_ok" = "skipped" ]; then printf 'NOT restarted (%s) — %s' "$GATEWAY_SKIP_WHY" "$(gateway_restart_hint "$engine")"; elif [ "$gateway_ok" = "1" ]; then printf 'bounced and verified'; else printf 'NOT verified — bounce it yourself'; fi)" \
    "data:     $(if [ -d "$home" ]; then printf '%s KEPT (%s)' "$home" "$size"; else printf 'deleted'; fi)" \
    "clone:    $ROOT kept — rm -rf it yourself"
  exit "$rc"
}

case "$MODE" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
  detach)    do_uninstall ;;
esac
