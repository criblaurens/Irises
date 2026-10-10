#!/usr/bin/env bash
# Irises configure — change what the install chose, on a clone that is already installed: no wizard,
# no `npm ci`, no rebuild. One setting or several, previewed, applied, and then PROVEN by restarting
# Irises and reading the build back off /health — because .env is parsed once at boot (src/loadEnv.ts
# has no reload path), so a change nobody restarted into is a setting that silently did not take.
#
#   bash scripts/configure.sh --show                    # report only; changes nothing
#   bash scripts/configure.sh --tz Europe/Paris         # one setting, asks before writing
#   bash scripts/configure.sh --web off --yes           # no questions
#   bash scripts/configure.sh --port 3001               # moves the engine's IRISES_URL with it
#   bash scripts/configure.sh --front 'telegram:*'      # which chats Irises fronts (engine .env)
#   bash scripts/configure.sh --model-inherit           # hand the voice back to the engine's model
#   IRISES_SET_VALUE=… bash scripts/configure.sh --set OPENROUTER_API_KEY
#
# FLAGS
#   --show                 print every setting, one line each, with where the value came from.
#                          Read-only: no lock, no write, no restart
#   --port N               the port Irises listens on (1-65535)
#   --service on|off       run Irises as a user service, or detached
#   --front PATTERNS|none  which chats Irises fronts: comma-separated <platform>:<glob> items, or
#                          the word none to front nothing. It lives in the ENGINE's .env
#   --model-lane LANE      give Irises's own voice a model of its own: anthropic | openrouter |
#                          openai. Needs --model-slug (deep work still runs on the engine's model)
#   --model-slug ID        the model id, exactly as that provider spells it
#   --model-base-url URL   required with --model-lane openai; the OpenAI-compatible endpoint
#   --model-inherit        drop the override and go back to inheriting the engine's model
#   --web on|off           the browser/CLI debug chat this clone serves (WEB_ENABLED)
#   --pings on|off         she may text first to ask how a thing you left hanging went
#                          (THREADING_PINGS_ENABLED; default on)
#   --musings on|off       she may text first about something on her own mind
#                          (IRISES_MUSINGS_ENABLED; default on)
#   --tz ZONE|host         the IANA zone Irises reads the wall clock in (host = this machine's own)
#   --set KEY=VALUE        set any documented key in this clone's .env (repeatable)
#   --set KEY              …with the value taken from IRISES_SET_VALUE, which is how a key whose
#                          value is a secret is set. At most one bare KEY per run
#   --unset KEY            remove a key from this clone's .env (repeatable)
#   --allow-unknown        allow a --set of a key neither .env.example nor deploy/app.env documents
#   --yes, -y              non-interactive: no questions, take the obvious answer
#   --no-restart           write the settings, leave the running server on the old ones. A
#                          --service on|off transition starts or stops Irises anyway — installing a
#                          unit and leaving it stopped is a state nobody asked for
#   --no-gateway-restart   skip the gateway bounce that follows any Irises restart or engine write
#   -h, --help             this text
#
# ENVIRONMENT. Secrets travel this way and never on argv: a command line is readable by every other
# process on the box (ps, /proc) and lands in shell history.
#   IRISES_MODEL_API_KEY       the API key for --model-lane. Without one it is ignored, with a
#                              warning — the same thing the installer does
#   IRISES_DASHBOARD_PASSWORD  the /dashboard admin password (DASHBOARD_PASSWORD). Its presence is
#                              itself the request: it needs no flag
#   IRISES_SET_VALUE           the value for a bare `--set KEY`
#
# THE GENERIC EDITOR (--set / --unset)
#   • a KEY is A-Z, 0-9 and _, starting with a letter
#   • a key whose name ends in _KEY, _TOKEN, _PASSWORD or _SECRET may not carry its value on argv:
#     pass the name alone and put the value in IRISES_SET_VALUE
#   • PORT, IRISES_FRONT, OPS_BACKEND, HERMES_API_KEY, OPENCLAW_TOKEN, ENGINE_PUSH_TOKEN and
#     IRISES_HOME are refused. Each is written in more places than this clone's .env — the engine's
#     .env, the install manifest, the service unit — and a flag or a re-install is what moves them
#     all together
#   • a --set key has to be one .env.example or deploy/app.env documents, so a typo cannot go in
#     silently and sit there doing nothing until someone reads the file. Some real keys are only
#     described in PROSE in those files and so do not match: CONVO_MODEL_OPENAI /
#     CLASSIFY_MODEL_OPENAI / FALLFIRM_MODEL_OPENAI, and ANTHROPIC_BASE_URL. Use --allow-unknown
#   • DATA_BACKEND and EMBEDDINGS_DIMENSIONS change WHAT is stored and WHERE; they are warned about
#     and then applied, and nothing already written is migrated
#
# STDIN: run from the menu, this script's stdin IS the menu's stdin. So under --yes (and with no
# TTY, which this treats as the same thing) nothing here reads a line, and anything it shells out to
# gets </dev/null. Eat one line and the menu loses its next answer.
#
# EXIT CODES
#   0   applied, nothing needed changing, or --show
#   1   a step failed or was refused
#   2   wrong usage (an unknown flag, a value that cannot be right, or nothing to configure)
#   4   Irises restarted but /health did not report the build this clone is on
#   5   Irises is configured and live, but its engine's gateway could not be verified back up
#   130/143  stopped mid-run by a signal (Ctrl+C / SIGTERM); RESULT: partial, read the messages
# Every run that gets past the flags ends its stdout with `RESULT: <token>`:
#   ok | noop | health-failed | gateway-failed | partial
# `partial` is a run that stopped before finishing — read the messages above to see how far it got.
# --show ends with `RESULT: ok` as well, so a wrapper always has one line to read. A usage error
# (exit 2) and this help text print none.
set -euo pipefail

source "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/lib/irises-lib.sh"
# shellcheck disable=SC2034  # read by the sourced library (lib/irises-lib.sh), not by this file
IRISES_LOG_TAG="irises-configure"

# The report and the preview print with this, not with `say`: the menu shows both inline, and a log
# tag stamped on every line of a twelve-line report is noise around the thing being read.
ui() { printf '%s\n' "$*"; }

SHOW=0
PORT_FLAG=""
SERVICE_FLAG=""
FRONT_FLAG=""
FRONT_SET=0
MODEL_LANE=""
MODEL_SLUG=""
MODEL_BASE_URL=""
MODEL_INHERIT=0
WEB_FLAG=""
PINGS_FLAG=""
MUSINGS_FLAG=""
TZ_FLAG=""
SET_BARE=""
ALLOW_UNKNOWN=0
ASSUME_YES=0
DO_RESTART=1
DO_GATEWAY=1
# Parallel indexed arrays, because bash 3.2 (what macOS ships) has no associative ones and no `+=`.
SET_KEYS=()
SET_VALS=()
UNSET_KEYS=()

# `--set` is the one flag with two shapes, so the split lives in a function instead of twice in the
# case arm (once for `--set X` and once for `--set=X`).
push_set() { # KEY=VALUE | KEY
  local arg="${1:-}"
  if [ -z "$arg" ]; then
    err "--set takes KEY=VALUE, or a bare KEY whose value comes from IRISES_SET_VALUE (try --help)"
    exit 2
  fi
  case "$arg" in
    *=*)
      SET_KEYS[${#SET_KEYS[@]}]="${arg%%=*}"
      SET_VALS[${#SET_VALS[@]}]="${arg#*=}"
      ;;
    *)
      if [ -n "$SET_BARE" ]; then
        err "--set takes at most one bare KEY per run: the value comes from IRISES_SET_VALUE, and"
        err "one environment variable cannot carry two ('$SET_BARE' and '$arg')"
        exit 2
      fi
      SET_BARE="$arg"
      ;;
  esac
}

push_unset() { # KEY
  local arg="${1:-}"
  if [ -z "$arg" ]; then err "--unset takes a KEY (try --help)"; exit 2; fi
  UNSET_KEYS[${#UNSET_KEYS[@]}]="$arg"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --show)                SHOW=1; shift ;;
    --port)                PORT_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --port=*)              PORT_FLAG="${1#--port=}"; shift ;;
    --service)             SERVICE_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --service=*)           SERVICE_FLAG="${1#--service=}"; shift ;;
    --front)               FRONT_FLAG="${2:-}"; FRONT_SET=1; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --front=*)             FRONT_FLAG="${1#--front=}"; FRONT_SET=1; shift ;;
    --model-lane)          MODEL_LANE="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --model-lane=*)        MODEL_LANE="${1#--model-lane=}"; shift ;;
    --model-slug)          MODEL_SLUG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --model-slug=*)        MODEL_SLUG="${1#--model-slug=}"; shift ;;
    --model-base-url)      MODEL_BASE_URL="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --model-base-url=*)    MODEL_BASE_URL="${1#--model-base-url=}"; shift ;;
    --model-inherit)       MODEL_INHERIT=1; shift ;;
    --web)                 WEB_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --web=*)               WEB_FLAG="${1#--web=}"; shift ;;
    --pings)               PINGS_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --pings=*)             PINGS_FLAG="${1#--pings=}"; shift ;;
    --musings)             MUSINGS_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --musings=*)           MUSINGS_FLAG="${1#--musings=}"; shift ;;
    --tz)                  TZ_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --tz=*)                TZ_FLAG="${1#--tz=}"; shift ;;
    --set)                 push_set "${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --set=*)               push_set "${1#--set=}"; shift ;;
    --unset)               push_unset "${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --unset=*)             push_unset "${1#--unset=}"; shift ;;
    --allow-unknown)       ALLOW_UNKNOWN=1; shift ;;
    --yes|-y)              ASSUME_YES=1; shift ;;
    --no-restart)          DO_RESTART=0; shift ;;
    --no-gateway-restart)  DO_GATEWAY=0; shift ;;
    -h|--help)             sed -n '2,83p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done

# ── validation ───────────────────────────────────────────────────────────────
# ALL of it up here, before the exit guard is armed and before a single file is opened, so a typo is
# a usage error that changes nothing and prints no RESULT line (update.sh:83-105, same reason).

# A key a human may type, as `case` globs: nothing forks, so the same predicate is affordable in a
# loop over a whole .env later.
key_valid() { # KEY
  case "${1:-}" in
    ''|*[!A-Z0-9_]*) return 1 ;;
    [A-Z]*)          return 0 ;;
  esac
  return 1
}

# Keys the generic editor will not touch, each with the reason and the thing to use instead. They
# are not refused for being dangerous to the file: they are refused because this clone's .env is not
# the only place they are written, and editing one of them here leaves the engine's .env, the
# manifest or the service unit disagreeing with it.
reserved_key() { # KEY -> 0 when refused, and says why on stderr
  case "${1:-}" in
    PORT)
      err "PORT is --port's: a port move also rewrites the engine's IRISES_URL and the install"
      err "manifest, and verifies Irises back up on the new one. Use:  --port N"
      return 0 ;;
    IRISES_FRONT)
      err "IRISES_FRONT is --front's, and it lives in the ENGINE's .env, not this clone's — setting"
      err "it here would change nothing at all. Use:  --front 'telegram:*'  or  --front none"
      return 0 ;;
    OPS_BACKEND|HERMES_API_KEY|OPENCLAW_TOKEN|ENGINE_PUSH_TOKEN)
      err "$1 is engine wiring — which engine, and the credentials the two of them talk over. It is"
      err "set by the install, together with the plugin and the keys on the engine's side."
      err "Re-run the install:  bash scripts/engine-setup.sh"
      return 0 ;;
    IRISES_HOME)
      err "IRISES_HOME is where your data lives and the service unit embeds it, so a .env edit and"
      err "the running service would point at two different directories. Uninstall and re-install"
      err "with the new home:  bash scripts/engine-setup.sh --uninstall"
      return 0 ;;
  esac
  return 1
}

# Is KEY one that .env.example or deploy/app.env actually documents? A grep for the ASSIGNMENT —
# commented out or not — and never a word match: both files discuss engine-side keys in prose, and a
# key that only ever appears in a sentence must not become settable here on the strength of that.
documented_key() { # KEY
  local key="${1:-}" root ex app
  root="$(irises_root)"
  ex="$root/.env.example"
  app="$root/deploy/app.env"
  # A test sandbox — and any hand-set IRISES_ROOT — points the root at a directory holding a .env
  # and nothing else. Fall back to the clone this script is IN, which always carries both files.
  if [ ! -f "$ex" ] && [ ! -f "$app" ]; then
    root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
    ex="$root/.env.example"
    app="$root/deploy/app.env"
  fi
  if [ ! -f "$ex" ]; then ex=/dev/null; fi
  if [ ! -f "$app" ]; then app=/dev/null; fi
  grep -qE "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?${key}=" "$ex" "$app"
}

# One gate for every key --set and --unset name, in the order that makes the FIRST message the most
# useful one: a reserved key is refused whether or not a value came with it, so someone who typed
# `--set PORT` is told about --port rather than about IRISES_SET_VALUE.
check_key() { # KEY MODE(set|unset) WITH_VALUE(1|0)
  local key="${1:-}" mode="${2:-set}" with_value="${3:-0}"
  if ! key_valid "$key"; then
    err "--$mode takes a KEY of A-Z, 0-9 and _ starting with a letter, got '$key'"
    exit 2
  fi
  # Reserved BEFORE the secret rule, and that order is the whole point of this function: a key this
  # editor will not touch at all must not first send the operator away to re-run the same refused
  # command through IRISES_SET_VALUE. `--set HERMES_API_KEY=x` is both, and "engine wiring" is the
  # answer that ends it in one step.
  if reserved_key "$key"; then exit 2; fi
  if [ "$with_value" = "1" ] && is_secret_key "$key"; then
    err "--set $key=VALUE puts a secret on the command line (visible to every process on the box,"
    err "kept in shell history) — use:  IRISES_SET_VALUE=… bash scripts/configure.sh --set $key"
    exit 2
  fi
  if [ "$mode" = "set" ] && [ "$ALLOW_UNKNOWN" != "1" ] && ! documented_key "$key"; then
    err "$key is not a key .env.example or deploy/app.env documents — a typo here is silent at boot."
    err "Pass --allow-unknown if you mean it"
    exit 2
  fi
  # Applied, not refused: someone asking for either of these usually means it. What they do not
  # always know is that the data already written stays in the shape the old value put it in.
  case "$key" in
    DATA_BACKEND|EMBEDDINGS_DIMENSIONS)
      warn "$key changes what Irises stores and where — nothing already written is migrated" ;;
  esac
  return 0
}

case "$PORT_FLAG" in
  '') ;;
  *[!0-9]*) err "--port takes a plain port number 1-65535, got '$PORT_FLAG'"; exit 2 ;;
  *)
    # Length first: bash's arithmetic would choke on a 30-digit "port" before the range test ran.
    if [ "${#PORT_FLAG}" -gt 5 ] || [ "$PORT_FLAG" -lt 1 ] || [ "$PORT_FLAG" -gt 65535 ]; then
      err "--port takes a port number 1-65535, got '$PORT_FLAG'"
      exit 2
    fi ;;
esac

case "$SERVICE_FLAG" in
  ''|on|off) ;;
  *) err "--service takes on or off, got '$SERVICE_FLAG'"; exit 2 ;;
esac

# Checked HERE rather than where it is used, because the engine fronts NOTHING for an IRISES_FRONT
# it cannot parse — which on the other end looks exactly like a configure run that did not work.
if [ "$FRONT_SET" = "1" ]; then
  case "$FRONT_FLAG" in
    none) ;;
    *)
      if ! front_pattern_valid "$FRONT_FLAG"; then
        err "--front takes comma-separated <platform>:<glob> items, or the word none, got '$FRONT_FLAG'"
        err "e.g. --front 'telegram:*'  ·  --front 'telegram:*,whatsapp:+1555*'  ·  --front '*:*'"
        exit 2
      fi ;;
  esac
fi

# The two halves of the model setting ask for opposite things, so one run cannot want both.
if [ "$MODEL_INHERIT" = "1" ]; then
  if [ -n "$MODEL_LANE" ] || [ -n "$MODEL_SLUG" ] || [ -n "$MODEL_BASE_URL" ]; then
    err "--model-inherit hands Irises's voice back to the engine's model; --model-lane/--model-slug/"
    err "--model-base-url pin one instead. Run whichever you meant, on its own."
    exit 2
  fi
fi
# The override is all-or-nothing (engine-setup.sh's rule, and it has to stay the same rule): a lane
# with no slug names no model, and a slug with no lane cannot be written at all, because the three
# lanes use three different key names.
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
# Warned about and ignored, NOT refused — the installer behaves the same way. A shell that exported
# the key once, for one command, must still be able to run every other configure command in it.
if [ -n "${IRISES_MODEL_API_KEY:-}" ] && [ -z "$MODEL_LANE" ]; then
  warn "IRISES_MODEL_API_KEY is set in the environment and ignored — it only applies with --model-lane"
fi

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
  *[[:space:]]*) err "--tz takes one IANA zone name, or the word host, got '$TZ_FLAG'"; exit 2 ;;
esac

i=0
while [ "$i" -lt "${#SET_KEYS[@]}" ]; do
  check_key "${SET_KEYS[$i]}" set 1
  i=$((i + 1))
done
if [ -n "$SET_BARE" ]; then
  check_key "$SET_BARE" set 0
  if [ -z "${IRISES_SET_VALUE:-}" ]; then
    err "--set $SET_BARE takes its value from IRISES_SET_VALUE, and that is unset or empty."
    err "Use:  IRISES_SET_VALUE=… bash scripts/configure.sh --set $SET_BARE"
    err "(to remove the key instead:  bash scripts/configure.sh --unset $SET_BARE)"
    exit 2
  fi
fi
i=0
while [ "$i" -lt "${#UNSET_KEYS[@]}" ]; do
  # An UNSET of a key nothing documents is fine: the whole point is to take out a line that should
  # not be there, and a key already in the file is proof enough that it exists.
  check_key "${UNSET_KEYS[$i]}" unset 0
  i=$((i + 1))
done

# A --set or --unset of a key --model-lane itself writes is two answers to one question, and the
# preview cannot show which of them wins: every line in it is measured against the file ON DISK, not
# against the other entries of the same plan, so both would be listed as if both were the outcome.
# The lane API keys are deliberately NOT on this list — the override only writes one when
# IRISES_MODEL_API_KEY says to, and the operator's own --set of it is a different request.
refuse_lane_key() { # KEY
  local key="${1:-}" k
  for k in $(model_override_keys "$MODEL_LANE"); do
    if [ "$k" = "$key" ]; then
      # One line, not two: a refusal an operator greps for has to be findable as the sentence it is.
      err "$key is written by --model-lane $MODEL_LANE — set the lane's model with the model flags, or drop --model-lane and set the key alone"
      exit 2
    fi
  done
  return 0
}
if [ -n "$MODEL_LANE" ]; then
  i=0
  while [ "$i" -lt "${#SET_KEYS[@]}" ]; do
    refuse_lane_key "${SET_KEYS[$i]}"
    i=$((i + 1))
  done
  if [ -n "$SET_BARE" ]; then refuse_lane_key "$SET_BARE"; fi
  i=0
  while [ "$i" -lt "${#UNSET_KEYS[@]}" ]; do
    refuse_lane_key "${UNSET_KEYS[$i]}"
    i=$((i + 1))
  done
fi

# IRISES_DASHBOARD_PASSWORD counts as a setting here, exactly like a flag: it carries no flag
# because a password on argv is readable by every other process on the box, so its PRESENCE in the
# environment is the request. Counting it in both directions is what makes `--show` with it set a
# usage error rather than a silently dropped password, and a run carrying only it not "nothing".
HAVE_SETTING=0
if [ -n "$PORT_FLAG" ] || [ -n "$SERVICE_FLAG" ] || [ "$FRONT_SET" = "1" ] ||
   [ -n "$MODEL_LANE" ] || [ "$MODEL_INHERIT" = "1" ] || [ -n "$WEB_FLAG" ] || [ -n "$TZ_FLAG" ] ||
   [ -n "$PINGS_FLAG" ] || [ -n "$MUSINGS_FLAG" ] ||
   [ "${#SET_KEYS[@]}" -gt 0 ] || [ -n "$SET_BARE" ] || [ "${#UNSET_KEYS[@]}" -gt 0 ] ||
   [ -n "${IRISES_DASHBOARD_PASSWORD:-}" ]; then
  HAVE_SETTING=1
fi

# A report of the OLD values followed by a write of new ones is not what anybody asking for both
# wanted, and there is no ordering of the two that is.
if [ "$SHOW" = "1" ] && [ "$HAVE_SETTING" = "1" ]; then
  err "--show reports and changes nothing; a setting changes something. Run them separately:"
  err "  bash scripts/configure.sh --show"
  exit 2
fi
if [ "$SHOW" = "0" ] && [ "$HAVE_SETTING" = "0" ]; then
  err "nothing to configure — see what is set with:  bash scripts/configure.sh --show   (or --help)"
  exit 2
fi

ROOT="$(irises_root)"
ENV_FILE="$ROOT/.env"
cd "$ROOT"
augment_path

# Armed HERE, past every usage exit and before the first byte of real work: the guard releases the
# lock and leaves ONE machine-readable line on stdout (`RESULT: partial`) for the paths that never
# reach `summary` — a `set -e` abort on some statement nobody guarded, and a Ctrl+C. It never
# changes the exit code, and it is harmless on a --show run, which takes no lock.
trap 'lifecycle_exit_guard $?' EXIT

# Did the install that wrote this manifest put our keys in the ENGINE's .env? Three writes hang off
# the answer: the report's front line, the `--front` rewrite and the `--port` move of IRISES_URL.
#
# `engineEnvApplied` only exists in manifests written since --engine-env shipped (Sept 2026). Every
# installer older than that flag wrote the engine's keys unconditionally — there was no way to
# decline — so on an older manifest the field is ABSENT, and absent is not a "no".
#
# Production is why this function exists. The VPS manifest predates the flag, so `--show` reported
# `fronts: n/a (the engine .env carries nothing of ours)` while that box was fronting `*:*` through
# a plugin the same install had put there, and both --front and --port would have refused to touch
# the file they wrote themselves. An empty value is read the same way as an absent one on purpose:
# manifest_update rewrites all 18 keys, so the first configure run on an old manifest turns the
# absence into `engineEnvApplied: ""`, and that must not flip a working box into refusing.
#
# The manifest itself is still the proof: no manifest, or one that names no engine .env, is a "no".
engine_env_applied() { # MANIFEST -> 0 = our keys are in the engine's .env
  local man="${1:-}" v
  v="$(manifest_read "$man" engineEnvApplied)"
  if [ "$v" = "true" ]; then return 0; fi
  if [ -n "$v" ]; then return 1; fi
  if [ -f "$man" ] && [ -n "$(manifest_read "$man" engineEnvFile)" ]; then return 0; fi
  return 1
}

# ── --show ───────────────────────────────────────────────────────────────────
# One line per setting, `label: value (source)`, and never a secret VALUE — a key is disclosed by
# NAME plus <set>/<unset>, which is the whole house rule in one place.
#
# It has to render on a clone that was never installed, because that is the moment the report is
# most wanted. Nothing here guards for a missing file: env_get, env_count, manifest_read and
# built_sha all return empty on one, and an extra `[ -f ]` per line would only fork more.
show_report() {
  local man v w src kind installed running sha engine reason pair
  local ef front lane slug role out key pending

  man="$(manifest_path)"

  v="$(irises_port)"
  if [ -n "$(env_get "$ENV_FILE" PORT)" ]; then
    src=".env"
  elif [ -n "$(env_get "$ROOT/deploy/app.env" PORT)" ]; then
    src="deploy/app.env"
  else
    src="default"
  fi
  ui "  port:               $v  ($src)"

  kind="$(service_kind)"
  if service_installed; then installed="yes"; else installed="no"; fi
  if [ "$installed" = "yes" ]; then
    # Installed: ask the service manager. Not installed: the pidfile is the only liveness there is,
    # because a detached run has no unit to query.
    if service_status; then running="yes"; else running="no"; fi
  else
    if [ -n "$(server_pid)" ]; then running="yes"; else running="no"; fi
  fi
  ui "  service:            $kind  (installed $installed · running $running)"

  sha="$(built_sha "$ROOT")"
  if [ -n "$sha" ]; then
    ui "  build:              $(printf '%.7s' "$sha")  (dist/version.json)"
  else
    ui "  build:              not built  (npm run build)"
  fi

  if [ -f "$man" ]; then
    ui "  manifest:           $man  (present)"
  else
    ui "  manifest:           $man  (none)"
  fi

  # The source is worked out the way the port line's is, and for a sharper reason: engine_kind falls
  # back to PROBING this box when no file says, so a line that always named OPS_BACKEND sent the
  # operator to a key — on a clone with no .env, to a file — that never carried the answer it shows.
  engine="$(engine_kind 2>/dev/null || printf off)"
  if [ -n "$(env_get "$ENV_FILE" OPS_BACKEND)" ]; then
    src=".env OPS_BACKEND"
  elif [ -n "$(env_get "$ROOT/deploy/app.env" OPS_BACKEND)" ]; then
    src="deploy/app.env OPS_BACKEND"
  else
    src="detected on this box"
  fi
  ui "  engine:             $engine  ($src)"

  # IRISES_FRONT is the ENGINE's key, so it is only readable when this install actually put it
  # there: a bridge plugin, and an engine .env we were allowed to write.
  ef="$(manifest_read "$man" engineEnvFile)"
  if [ "$engine" = "hermes" ] && [ "$(manifest_read "$man" bridge)" = "1" ] &&
     engine_env_applied "$man"; then
    if [ "$(env_count "$ef" IRISES_FRONT)" = "0" ]; then
      ui "  fronts:             not set  (engine .env)"
    else
      front="$(env_get "$ef" IRISES_FRONT)"
      if [ -z "$front" ]; then
        ui "  fronts:             nothing (IRISES_FRONT is empty)  (engine .env)"
      else
        ui "  fronts:             $front  (engine .env)"
      fi
    fi
  else
    if [ "$engine" = "off" ]; then
      reason="no engine"
    elif [ "$(manifest_read "$man" bridge)" != "1" ]; then
      reason="no bridge plugin"
    else
      reason="the engine .env carries nothing of ours"
    fi
    ui "  fronts:             n/a ($reason)"
  fi

  # An install run with `--engine-env print`, or whose `ask` was answered no, wrote nothing to the
  # engine's .env and recorded what it would have written. Naming those keys here is the difference
  # between a report that says "n/a" and one that says what is missing — --uninstall says the same
  # thing at the other end of the install's life (engine-setup.sh:1298-1306).
  if [ "$(manifest_read "$man" engineEnvApplied)" = "false" ]; then
    pending="$(manifest_read "$man" engineEnvPending)"
    if [ -n "$pending" ]; then
      ui "  engine .env:        nothing of ours applied — left for you to add: $pending"
    fi
  fi

  # Inheritance is the default and it is wide: with it on, boot-time engine discovery supplies the
  # model AND the key and base URL under it. A CONVO_PROVIDER in this clone's .env is the other
  # tell — it beats discovery whatever ENGINE_MODEL_INHERIT says.
  v="$(env_get "$ENV_FILE" ENGINE_MODEL_INHERIT)"
  case "$v" in
    off|false|0|no) w="off" ;;
    *)              w="on" ;;
  esac
  if [ "$w" = "on" ] && [ -z "$(env_get "$ENV_FILE" CONVO_PROVIDER)" ]; then
    ui "  voice model:        inherited from the engine  (ENGINE_MODEL_INHERIT is not off)"
  else
    out=""
    for role in CONVO CLASSIFY FALLFIRM; do
      lane="$(env_get "$ENV_FILE" "${role}_PROVIDER")"
      case "$lane" in
        openrouter) slug="$(env_get "$ENV_FILE" "${role}_MODEL_OPENROUTER")" ;;
        openai)     slug="$(env_get "$ENV_FILE" "${role}_MODEL_OPENAI")" ;;
        *)          slug="$(env_get "$ENV_FILE" "${role}_MODEL")" ;;
      esac
      if [ -z "$lane" ]; then lane="the shipped lane"; fi
      if [ -z "$slug" ]; then slug="not set"; fi
      out="$out · ${role}: $slug on $lane"
    done
    ui "  voice model:        ${out# · }  (.env)"
  fi

  v="$(env_get "$ENV_FILE" WEB_ENABLED)"
  if [ "$v" = "false" ]; then w="off"; else w="on"; fi
  if [ -n "$v" ]; then src=".env"; else src="default"; fi
  ui "  browser chat:       $w  ($src)"

  # Both are on unless the key says off (src/memory/threadPings.ts, src/persona/featureFlags.ts).
  for pair in "THREADING_PINGS_ENABLED:thread pings:       " "IRISES_MUSINGS_ENABLED:musings:            "; do
    v="$(env_get "$ENV_FILE" "${pair%%:*}")"
    case "$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" in
      ''|true|1|on|yes) w="on" ;;
      *) w="off" ;;
    esac
    if [ -n "$v" ]; then src=".env"; else src="default"; fi
    ui "  ${pair#*:}$w  ($src)"
  done

  v="$(env_get "$ENV_FILE" IRISES_TZ)"
  if [ -n "$v" ]; then
    ui "  timezone:           $v  (.env)"
  else
    ui "  timezone:           host zone  (IRISES_TZ unset)"
  fi

  if [ -n "$(env_get "$ENV_FILE" DASHBOARD_PASSWORD)" ]; then
    ui "  dashboard password: <set>  (.env)"
  else
    ui "  dashboard password: <unset> — /dashboard is localhost-only  (.env carries none)"
  fi

  out=""
  for key in ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY; do
    if [ -n "$(env_get "$ENV_FILE" "$key")" ]; then
      out="$out · $key <set>"
    else
      out="$out · $key <unset>"
    fi
  done
  ui "  lane keys:          ${out# · }  (.env, by name only)"

  ui "  data:               $(irises_home)"

  summary ok "report only — nothing was changed"
  return 0
}

if [ "$SHOW" = "1" ]; then
  show_report
  exit 0
fi

# Below the --show dispatch on purpose: the menu prints this report inline under Status, and --show
# asks nothing, so a line about stdin has no business heading it.
#
# No TTY = nobody can answer a question, so don't ask one. An agent-driven run lands here (both
# engines spawn shell commands with stdin at /dev/null, so any `read` would hit EOF immediately).
if [ ! -t 0 ] && [ "$ASSUME_YES" != "1" ]; then
  ASSUME_YES=1
  say "stdin is not a terminal — running non-interactive (same as --yes)"
fi
# The library's prompt helpers read THIS, never the terminal: whether a run may ask a question is a
# decision this script has already made, above, out of --yes and the no-TTY case. Published before
# the first prompt below, which is the only rule about where it goes.
# shellcheck disable=SC2034  # read by the sourced library (lib/irises-lib.sh), not by this file
IRISES_ASSUME_YES="$ASSUME_YES"

# A signal trap's `exit` fires the EXIT trap as well, and the RESULT line is latched there, so the
# two overlap by design: exactly one line, whichever got to it first. 130/143 are the codes a shell
# reports for Ctrl+C and SIGTERM, and a caller reading them must not see a different number here.
trap 'lifecycle_exit_guard 130' INT
trap 'lifecycle_exit_guard 143' TERM

# ── the plan ─────────────────────────────────────────────────────────────────
# Every write this run would make, collected BEFORE a byte is touched, because the preview, the
# "nothing to change" decision and the apply all have to read the SAME list. Three separate walks
# over the flags would be three chances to disagree, and the one that disagreed silently would be
# the preview — the one thing the operator answers a question about.
#
# The list they share is not this plan but LISTED_IDX, the indices preview_plan actually PRINTED: an
# entry whose key already carries the value asked for is dropped there, and the apply walks the same
# set so it cannot write one the operator was never shown. Written anyway, `--front <what it already
# is> --tz Europe/Paris` backed up and rewrote the ENGINE's .env and bounced its gateway over a
# single previewed line, and the mirror case restarted Irises for a value that never moved.
#
# Four parallel indexed arrays, because bash 3.2 (what macOS ships) has no associative ones.
P_FILE=()
P_OP=()
P_KEY=()
P_VAL=()

plan_add() { # FILE OP(set|unset) KEY [VALUE]
  P_FILE[${#P_FILE[@]}]="${1:-}"
  P_OP[${#P_OP[@]}]="${2:-set}"
  P_KEY[${#P_KEY[@]}]="${3:-}"
  P_VAL[${#P_VAL[@]}]="${4:-}"
}

if [ -n "$WEB_FLAG" ]; then
  if [ "$WEB_FLAG" = "on" ]; then
    plan_add "$ENV_FILE" set WEB_ENABLED true
  else
    plan_add "$ENV_FILE" set WEB_ENABLED false
  fi
fi
if [ -n "$PINGS_FLAG" ]; then
  if [ "$PINGS_FLAG" = "on" ]; then v=true; else v=false; fi
  plan_add "$ENV_FILE" set THREADING_PINGS_ENABLED "$v"
fi
if [ -n "$MUSINGS_FLAG" ]; then
  if [ "$MUSINGS_FLAG" = "on" ]; then v=true; else v=false; fi
  plan_add "$ENV_FILE" set IRISES_MUSINGS_ENABLED "$v"
fi

# `host` is the ABSENCE of the key, not a zone by that name: with IRISES_TZ unset
# src/pipeline/zonedTime.ts reads this machine's own zone, which is what "host" means.
if [ -n "$TZ_FLAG" ]; then
  if [ "$TZ_FLAG" = "host" ]; then
    plan_add "$ENV_FILE" unset IRISES_TZ
  else
    plan_add "$ENV_FILE" set IRISES_TZ "$TZ_FLAG"
  fi
fi

# No flag carries this one: a password on argv is readable by every other process on the box, so
# the variable's presence in the environment is the whole request.
if [ -n "${IRISES_DASHBOARD_PASSWORD:-}" ]; then
  plan_add "$ENV_FILE" set DASHBOARD_PASSWORD "$IRISES_DASHBOARD_PASSWORD"
fi

# The override goes into the plan key by key so the PREVIEW and the noop decision can see each line
# — but the WRITE below is one call to the lib's model_override_write, so install and configure put
# the same bytes in the file and print the same explanation.
#
# MODEL_IDX records the plan INDICES that call covers, not the key names. By name, an operator's own
# `--set CONVO_PROVIDER=anthropic` alongside a lane would be previewed and then thrown away, because
# its key is one the override also writes — a preview that promises a line and an apply that
# discards it. By index, only the override's own entries are skipped, and the operator's entry for
# the same key applies AFTER the override call, in plan order: the last word is theirs, which is
# exactly what the preview showed them.
MODEL_IDX=""
if [ -n "$MODEL_LANE" ]; then
  for key in $(model_override_keys "$MODEL_LANE"); do
    case "$key" in
      *_PROVIDER)           plan_add "$ENV_FILE" set "$key" "$MODEL_LANE" ;;
      ENGINE_MODEL_INHERIT) plan_add "$ENV_FILE" set "$key" off ;;
      OPENAI_BASE_URL)      plan_add "$ENV_FILE" set "$key" "$MODEL_BASE_URL" ;;
      *)                    plan_add "$ENV_FILE" set "$key" "$MODEL_SLUG" ;;
    esac
    MODEL_IDX="$MODEL_IDX $((${#P_KEY[@]} - 1))"
  done
  if [ -n "${IRISES_MODEL_API_KEY:-}" ]; then
    LANE_KEY="$(model_lane_key "$MODEL_LANE")"
    plan_add "$ENV_FILE" set "$LANE_KEY" "$IRISES_MODEL_API_KEY"
    MODEL_IDX="$MODEL_IDX $((${#P_KEY[@]} - 1))"
  fi
fi

if [ "$MODEL_INHERIT" = "1" ]; then
  # No lane: take out the whole removable set, whichever lane the override was last written on.
  for key in $(model_override_keys); do
    plan_add "$ENV_FILE" unset "$key"
  done
  # Named, never removed. The operator pays for these and may have had them in the file long before
  # Irises wrote a model line; undoing OUR choice of model must not cost them a credential.
  for key in ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY OPENAI_BASE_URL; do
    if [ -n "$(env_get "$ENV_FILE" "$key")" ]; then
      say "keeping $key — the value you gave stays in $ENV_FILE; remove it with --unset $key if you mean to"
    fi
  done
fi

i=0
while [ "$i" -lt "${#SET_KEYS[@]}" ]; do
  plan_add "$ENV_FILE" set "${SET_KEYS[$i]}" "${SET_VALS[$i]}"
  i=$((i + 1))
done
if [ -n "$SET_BARE" ]; then
  plan_add "$ENV_FILE" set "$SET_BARE" "${IRISES_SET_VALUE:-}"
fi
i=0
while [ "$i" -lt "${#UNSET_KEYS[@]}" ]; do
  plan_add "$ENV_FILE" unset "${UNSET_KEYS[$i]}"
  i=$((i + 1))
done

# ── the engine side of this run ──────────────────────────────────────────────
# Read ONCE, here: the plan, the preview, the apply and the gateway step all have to agree about
# which file the engine's keys live in and whether this install was ever allowed to write to it.
MAN="$(manifest_path)"
ENGINE="$(engine_kind 2>/dev/null || printf off)"
ENGINE_ENV="$(manifest_read "$MAN" engineEnvFile)"
# A hermes install whose manifest is gone still has exactly one engine .env, and it is where hermes
# keeps its own. The guess only ever serves the LOOKUP: every write below also needs
# engineEnvApplied=true, which no missing manifest can report.
if [ -z "$ENGINE_ENV" ] && [ "$ENGINE" = "hermes" ]; then ENGINE_ENV="$(hermes_home)/.env"; fi
if engine_env_applied "$MAN"; then ENGINE_ENV_APPLIED=true; else ENGINE_ENV_APPLIED=false; fi
BRIDGE="$(manifest_read "$MAN" bridge)"

# Recording what moved is best-effort, always: a clone installed before the manifest existed, or one
# whose $IRISES_HOME was wiped, must still be configurable. manifest_update refuses a file that is
# not there, so the absence is said out loud here and the run carries on.
manifest_record() { # KEY=VALUE…
  if [ ! -f "$MAN" ]; then
    say "no install manifest at $MAN — nothing to record"
    return 0
  fi
  manifest_update "$MAN" "$@" ||
    warn "could not update $MAN — --uninstall may have to guess what this run changed"
  return 0
}

# ── the port ─────────────────────────────────────────────────────────────────
# Three places, not one: this clone's PORT, the IRISES_URL the engine calls back on, and the manifest
# --uninstall reads. That is the whole reason reserved_key refuses `--set PORT`.
CUR_PORT="$(irises_port)"
NEW_PORT=""
PORT_URL_MOVED=0
if [ -n "$PORT_FLAG" ] && [ "$PORT_FLAG" != "$CUR_PORT" ]; then
  NEW_PORT="$PORT_FLAG"
  # PREFLIGHT, before the preview and before the lock. Learning this AFTER the write leaves .env
  # naming a port Irises can never bind, and the restart then verifies against whatever is already
  # answering there — update.sh:571-579 refuses the same way, for the same reason.
  if tcp_open 127.0.0.1 "$NEW_PORT"; then
    err "something already listens on :$NEW_PORT — pick another port, or stop it first"
    exit 1
  fi
  plan_add "$ENV_FILE" set PORT "$NEW_PORT"
  # The engine calls Irises back on IRISES_URL, so a port move that leaves it behind stops every
  # inbound message without an error anywhere. It is ours to move only where the install actually
  # wrote it AND it still names the port we are moving off; anything else is the operator's own.
  PORT_URL_STRAY=0
  if [ "$ENGINE_ENV_APPLIED" = "true" ] && [ -n "$ENGINE_ENV" ]; then
    case "$(env_get "$ENGINE_ENV" IRISES_URL)" in
      "http://127.0.0.1:$CUR_PORT"|"http://localhost:$CUR_PORT")
        plan_add "$ENGINE_ENV" set IRISES_URL "http://127.0.0.1:$NEW_PORT"
        PORT_URL_MOVED=1 ;;
      *) PORT_URL_STRAY=1 ;;
    esac
  elif [ "$ENGINE" != "off" ]; then
    # Only when there IS an engine: on a standalone clone no IRISES_URL exists anywhere, and a
    # warning about one would send the operator looking for a file that was never written.
    PORT_URL_STRAY=1
  fi
  if [ "$PORT_URL_STRAY" = "1" ]; then
    warn "IRISES_URL in ${ENGINE_ENV:-the engine .env} does not name :$CUR_PORT — it was not ours to move; set it yourself if the engine should follow"
  fi
fi

# ── what Irises fronts ───────────────────────────────────────────────────────
# IRISES_FRONT is the ENGINE's key: it decides which chats the gateway hands over at all, and it is
# read only when that gateway starts. `none` is an EMPTY value, never a removed key.
FRONT_VALUE=""
FRONT_PLANNED=0
FRONT_PRINTED=0
if [ "$FRONT_SET" = "1" ]; then
  if [ "$FRONT_FLAG" != "none" ]; then FRONT_VALUE="$FRONT_FLAG"; fi
  case "$ENGINE" in
    off)
      err "no engine is configured (OPS_BACKEND=off) — nothing fronts anything; install against an engine first"
      exit 1 ;;
    openclaw)
      # OpenClaw's gateway reads its own process environment, not a file this script can edit, so
      # saying the line exactly is the only honest thing to do (engine-setup.sh:972-975 does the
      # same for the same reason).
      warn "OpenClaw is wired from its own side — set this on the gateway process, then restart it:"
      warn "  IRISES_FRONT=$FRONT_VALUE"
      FRONT_PRINTED=1 ;;
    *)
      if [ "$BRIDGE" != "1" ]; then
        err "this install carries no bridge plugin (--no-bridge) — re-run the install with the bridge to front chats"
        exit 1
      fi
      if [ "$ENGINE_ENV_APPLIED" != "true" ]; then
        err "the engine .env carries nothing of ours (the install was declined or printed) — add IRISES_FRONT there yourself, then bounce the gateway"
        exit 1
      fi
      # Only where it would actually move, the way --port only plans IRISES_URL where the file still
      # names the old port. FRONT_PLANNED is what the manifest step below reads, so a front planned
      # at the value it already carries recorded a frontPattern and a keysRetargeted for a byte that
      # never moved — the manifest claiming a scope this run took over, which is the list
      # --uninstall then puts back.
      #
      # The test is the preview's own: an ABSENT key still plans (absent is not empty, and
      # `--front none` has to be able to write the empty value the gateway reads as "front
      # nothing"), and so does a duplicated one, because collapsing it onto one line is a change.
      if [ "$(env_count "$ENGINE_ENV" IRISES_FRONT)" != "1" ] ||
         [ "$(env_get "$ENGINE_ENV" IRISES_FRONT)" != "$FRONT_VALUE" ]; then
        plan_add "$ENGINE_ENV" set IRISES_FRONT "$FRONT_VALUE"
        FRONT_PLANNED=1
      fi ;;
  esac
fi

# ── the service ──────────────────────────────────────────────────────────────
# Planned LAST on purpose: it is not a line in any file, so it prints under no file heading, and a
# preview reads wrong if it lands in the middle of one.
#
# All three backends go through the lib, and two of them are exercised for real by the tests on the
# machines that have them. The Windows (schtasks) arm is STUB-TESTED ONLY — no Windows box runs
# these tests — so treat a change to it as unproven until someone runs it on Git Bash.
SERVICE_PLAN=""
SERVICE_KIND=""
if [ -n "$SERVICE_FLAG" ]; then
  SERVICE_KIND="$(service_kind)"
  if [ "$SERVICE_FLAG" = "on" ]; then
    if [ "$SERVICE_KIND" = "none" ]; then
      err "no user service manager on this box (systemd --user, launchd or Task Scheduler) — Irises can only run detached here"
      exit 1
    fi
    if ! service_installed; then
      SERVICE_PLAN=on
      plan_add service service on "$SERVICE_KIND"
    fi
  else
    if service_installed; then
      SERVICE_PLAN=off
      plan_add service service off "$SERVICE_KIND"
    fi
  fi
fi

# A --front an engine reads from its own environment changes nothing on this box, so a run that
# asked for only that has nothing left to preview, lock, write or restart.
if [ "$FRONT_PRINTED" = "1" ] && [ "${#P_KEY[@]}" -eq 0 ]; then
  summary ok "front: printed, not applied (OpenClaw is wired from its own side)"
  exit 0
fi

# ── the preview ──────────────────────────────────────────────────────────────
# What the apply will do, line by line, before the one question. A key already carrying the value
# asked for is NOT listed: a preview that announces four lines and moves none teaches the operator
# to stop reading it, and the count of what it did list is also what decides there is nothing to do.
#
# NO SECRET VALUE IS EVER PRINTED, in either position — not the new value and not the old one. A
# secret is disclosed by NAME plus `<set>`, and what it replaces is `not shown` (the house rule, and
# the same shape engine-setup.sh's own preview uses).
LISTED=0
# The plan INDICES this preview printed, in the shape MODEL_IDX uses, and the only list the apply
# below walks. By index rather than by key, for MODEL_IDX's reason: two entries can name one key —
# an override's and the operator's own line overruling it — and only one of them may be the skipped
# one.
LISTED_IDX=""
CHANGED_KEYS=""
# Two files can move in one run — this clone's .env and the ENGINE's — and each announces itself
# once, above its own first line. The heading waits for that line: a run whose every value is
# already in place says "nothing to change" and must not first announce changes to anything.
PREVIEW_CLONE_HEADER=0
PREVIEW_ENGINE_HEADER=0
preview_header() { # FILE
  if [ "${1:-}" = "$ENV_FILE" ]; then
    if [ "$PREVIEW_CLONE_HEADER" = "1" ]; then return 0; fi
    PREVIEW_CLONE_HEADER=1
  else
    if [ "$PREVIEW_ENGINE_HEADER" = "1" ]; then return 0; fi
    PREVIEW_ENGINE_HEADER=1
  fi
  ui "changes to ${1:-} (backed up first to .bak-irises-<timestamp>):"
  return 0
}
preview_plan() {
  local i=0 idx f op key val n cur note name
  while [ "$i" -lt "${#P_KEY[@]}" ]; do
    idx="$i"
    f="${P_FILE[$i]}"
    op="${P_OP[$i]}"
    key="${P_KEY[$i]}"
    val="${P_VAL[$i]}"
    i=$((i + 1))
    # The service is not a line in a file but a transition, so it prints as one — under no heading,
    # and named `service` in the summary, where it also has a line of its own.
    if [ "$op" = "service" ]; then
      if [ "$key" = "on" ]; then
        ui "  ~ service: detached → $val"
      else
        ui "  ~ service: $val → detached"
      fi
      LISTED=$((LISTED + 1))
      LISTED_IDX="$LISTED_IDX $idx"
      case " $CHANGED_KEYS " in
        *" service "*) ;;
        *) CHANGED_KEYS="$CHANGED_KEYS service" ;;
      esac
      continue
    fi
    n="$(env_count "$f" "$key")"
    cur="$(env_get "$f" "$key")"
    if [ "$op" = "unset" ]; then
      # Nothing to take out is nothing to say.
      if [ "$n" = "0" ]; then continue; fi
      preview_header "$f"
      ui "  - $key"
    else
      if [ "$n" != "0" ] && [ "$n" -le 1 ] && [ "$cur" = "$val" ]; then continue; fi
      preview_header "$f"
      # Duplicated keys are collapsed onto one line by env_set, and that is a change in its own
      # right even when the live (last) value already matches — so it is said out loud.
      note=""
      if [ "$n" -gt 1 ]; then note="     ($n copies, collapsed onto one line)"; fi
      if is_secret_key "$key"; then
        if [ "$n" = "0" ]; then
          ui "  + $key=<set>$note"
        else
          ui "  ~ $key=<set>     (was not shown)$note"
        fi
      else
        if [ "$n" = "0" ]; then
          ui "  + $key=$val$note"
        else
          ui "  ~ $key=$val     (was ${cur:-empty})$note"
        fi
      fi
    fi
    LISTED=$((LISTED + 1))
    LISTED_IDX="$LISTED_IDX $idx"
    # Named once, in the order the plan first reaches it. Two entries CAN name one key — an override
    # and the operator's own line overruling it — and both are previewed, because both are written;
    # but a summary that says OPENROUTER_API_KEY twice reads like a bug rather than a precedence.
    # An engine key is prefixed, because IRISES_URL in that summary means nothing without the file.
    if [ "$f" = "$ENV_FILE" ]; then name="$key"; else name="engine:$key"; fi
    case " $CHANGED_KEYS " in
      *" $name "*) ;;
      *) CHANGED_KEYS="$CHANGED_KEYS $name" ;;
    esac
  done
  CHANGED_KEYS="${CHANGED_KEYS# }"
  LISTED_IDX="${LISTED_IDX# }"
  return 0
}

# Was this plan entry one the preview printed? The apply, the backups and the restart decision all
# ask this and nothing else — the preview is the contract, and an entry outside it is a write the
# operator never agreed to.
listed_idx() { # INDEX
  case " $LISTED_IDX " in
    *" ${1:-} "*) return 0 ;;
  esac
  return 1
}

preview_plan
if [ "$LISTED" = "0" ]; then
  # No lock, no backup, no restart: a run that bounced the server to write nothing is the reason
  # people stop trusting a configure verb they ran twice.
  summary noop "nothing to change — every value asked for is already in $ENV_FILE"
  exit 0
fi

if ! ask_yn "Apply?" y; then
  summary noop "nothing was applied"
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────
# The lock from here, and the same one install and update take: two lifecycle runs rewriting .env at
# once is the same corruption whichever pair they are. The EXIT guard above releases it on every
# path out, including a Ctrl+C in the middle of the restart.
lock_acquire || exit 1

# Does this run move this clone's .env at all? A front-only run does not, and a file that did not
# move must not be backed up, must not be chmodded, and must not cost Irises a restart. Read off the
# LISTED set, not off the plan: an entry already carrying its value was dropped by the preview and
# moves nothing, so a plan that holds only those moves nothing either.
PLAN_HAS_CLONE=0
i=0
while [ "$i" -lt "${#P_FILE[@]}" ]; do
  if listed_idx "$i" && [ "${P_FILE[$i]}" = "$ENV_FILE" ]; then PLAN_HAS_CLONE=1; fi
  i=$((i + 1))
done

# Once, before the first write, and the path is what the summary hands the operator to go back to.
BACKUP=""
if [ "$PLAN_HAS_CLONE" = "1" ]; then
  BACKUP="$(env_backup "$ENV_FILE" configure)"
  # A clone that never had a .env gets one at 0600 from the start — engine-setup.sh:516 makes it the
  # same way, and a `touch` would leave secrets world-readable.
  if [ ! -e "$ENV_FILE" ]; then ( umask 077; : > "$ENV_FILE" ); fi
fi

# Which of the two files this run actually wrote to. CLONE_CHANGED is what decides the restart
# below — .env is parsed once at boot — and the override counts, because every one of ITS plan
# entries is skipped in the walk and a run carrying nothing else would otherwise look untouched.
CLONE_CHANGED=0
ENGINE_CHANGED=0
ENGINE_BACKUP=""

# The override is ONE lib call covering several plan entries, so it cannot be skipped entry by
# entry: it goes when the preview listed at least one of them, and stays out — with nothing marked
# changed — when it listed none, which is a lane already written exactly as asked for.
if [ -n "$MODEL_LANE" ]; then
  MODEL_LISTED=0
  for mi in $MODEL_IDX; do
    if listed_idx "$mi"; then MODEL_LISTED=1; fi
  done
  if [ "$MODEL_LISTED" = "1" ]; then
    model_override_write "$ENV_FILE" "$MODEL_LANE" "$MODEL_SLUG" "$MODEL_BASE_URL" || exit 1
    CLONE_CHANGED=1
  fi
fi

i=0
while [ "$i" -lt "${#P_KEY[@]}" ]; do
  key="${P_KEY[$i]}"
  f="${P_FILE[$i]}"
  # Not in the preview, not written: a key already carrying the value asked for is a line nobody was
  # shown, and writing it costs a backup, a rewrite and whichever of the two restarts below it marks.
  if ! listed_idx "$i"; then i=$((i + 1)); continue; fi
  # The service transition is not a file write. It happens below, once both .env files are settled.
  if [ "${P_OP[$i]}" = "service" ]; then i=$((i + 1)); continue; fi
  # These entries — and only these — are the ones the call above already wrote, in the shape the
  # installer writes them. Anything else naming the same key is the operator's and still applies.
  case " $MODEL_IDX " in
    *" $i "*) i=$((i + 1)); continue ;;
  esac
  if [ "$f" = "$ENV_FILE" ]; then
    CLONE_CHANGED=1
  else
    # Once, before the first byte of the ENGINE's file, and the install backs it up the same way:
    # --uninstall restores the keys it retargeted FROM a backup, so a write with none behind it is
    # a removal nothing can undo.
    if [ "$ENGINE_CHANGED" = "0" ]; then ENGINE_BACKUP="$(env_backup "$f" configure)"; fi
    ENGINE_CHANGED=1
  fi
  if [ "${P_OP[$i]}" = "unset" ]; then
    env_unset "$f" "$key" >/dev/null
  else
    env_set "$f" "$key" "${P_VAL[$i]}" || exit 1
  fi
  i=$((i + 1))
done
# Said out loud, not swallowed: this file carries API keys and the dashboard password, and a mode a
# chmod could not set is the difference between a 0600 file and one every user on the box can read.
if [ "$CLONE_CHANGED" = "1" ]; then
  chmod 600 "$ENV_FILE" 2>/dev/null ||
    warn "could not chmod 600 $ENV_FILE — it may be readable by other users on this box"
fi

# ── what the manifest has to learn ───────────────────────────────────────────
# --uninstall reads this file to put the engine's .env back and to take the right service out, so a
# setting that moved and a manifest still naming the old one is an uninstall that guesses wrong.
#
# Collected into ONE call: manifest_update rewrites the whole file every time, so a run that moved
# the port and the front would otherwise write it twice and say so twice. The positional list is
# free here — the argument loop consumed it long ago. (The service transition below records itself,
# after it has actually happened.)
#
# A key that was in the engine's .env before Irises ever touched it and now points at us is
# RETARGETED: that list, and only that list, is what --uninstall and the detach restore from the
# pre-install backup. Accumulated in ONE variable across both keys that can move — a second
# `keysRetargeted=` computed from the manifest would have been read before the first was written,
# and would drop it.
RETARGETED="$(manifest_read "$MAN" keysRetargeted)"
RETARGETED_MOVED=0
retarget() { # KEY — record a PRE-EXISTING engine key this run pointed at us
  case " $(manifest_read "$MAN" keysPreExisting) " in
    *" ${1:-} "*) ;;
    # Ours to begin with: --uninstall takes it OUT rather than putting a value back, so it must
    # never land here.
    *) return 0 ;;
  esac
  case " $RETARGETED " in
    *" ${1:-} "*) return 0 ;;
  esac
  RETARGETED="$RETARGETED ${1:-}"
  RETARGETED_MOVED=1
  return 0
}

set --
if [ -n "$NEW_PORT" ]; then
  set -- "$@" "port=$NEW_PORT"
  if [ "$PORT_URL_MOVED" = "1" ]; then retarget IRISES_URL; fi
fi
# The same bookkeeping IRISES_URL gets, for the same reader: an operator's own IRISES_FRONT that
# this run narrowed is a scope --uninstall has to put back, and an unrecorded one is left on ours.
if [ "$FRONT_PLANNED" = "1" ]; then
  set -- "$@" "frontPattern=$FRONT_VALUE"
  retarget IRISES_FRONT
fi
if [ "$RETARGETED_MOVED" = "1" ]; then set -- "$@" "keysRetargeted=${RETARGETED# }"; fi
# The lane the voice is on is recorded the same way the install records it (engine-setup.sh:953), and
# for the same readers: --uninstall and the detach rewrite carry modelLane forward, so a run that
# moved the model and left the manifest naming the old lane hands the next script a stale answer.
# The two are mutually exclusive — the parser refuses --model-inherit with --model-lane.
if [ "$MODEL_INHERIT" = "1" ]; then set -- "$@" "modelLane=inherit"; fi
if [ -n "$MODEL_LANE" ]; then set -- "$@" "modelLane=$MODEL_LANE"; fi
if [ "$#" -gt 0 ]; then manifest_record "$@"; fi

# ── the restart, and the proof ───────────────────────────────────────────────
# .env is parsed once at boot (src/loadEnv.ts has no reload path), so a setting nobody restarted
# into is a setting that silently did not take. Verifying that SOMETHING answers /health is not
# enough either — the old process still holding the port answers exactly the same way — so the sha
# this clone is built from goes in and has to come back.
#
# What the summary hands back about the backups: an engine-only run took none of this clone's.
if [ "$PLAN_HAS_CLONE" = "1" ]; then
  BACKUP_SHOWN="${BACKUP:-none (new file)}"
else
  # Named by what happened, not by the path: an engine-only run must not print this clone's .env
  # anywhere, or the operator goes and reads a file that has nothing of this run in it.
  BACKUP_SHOWN="none — this run changed nothing of this clone's own"
fi
if [ -n "$ENGINE_BACKUP" ]; then BACKUP_SHOWN="$BACKUP_SHOWN · engine: $ENGINE_BACKUP"; fi

RESTART_STATE=""
SERVICE_STATE="unchanged"
# Set once Irises was actually cycled onto the new settings, by either arm below. The gateway is
# bounced after it: the engine and the server it hands chats to come up together, so a restart of
# one is never left running against a gateway that booted before it.
IRISES_RESTARTED=0
SHA="$(built_sha "$ROOT")"
# The port the proof has to target is the one this run ASKED for. .env already carries it, so
# irises_port would agree — but a verification that reads back its own write proves nothing.
PORT_NOW="${NEW_PORT:-$CUR_PORT}"

if [ -n "$SERVICE_PLAN" ]; then
  # The transition IS the restart — installing the unit starts Irises, removing it starts her
  # detached — so it REPLACES the generic step below rather than running before it, and it runs
  # whatever --no-restart says: a service installed and left stopped is neither state anyone asked
  # for. The health check is wait_health_sha directly, because irises_restart_verify would cycle
  # her a second time to prove what the transition just did.
  if [ -z "$SHA" ]; then warn "no dist/version.json — verifying liveness only"; fi
  if [ "$SERVICE_PLAN" = "on" ]; then
    PID="$(server_pid)"
    if [ -n "$PID" ]; then server_stop 20; fi
    # Absolute, because a unit, a plist and a Task Scheduler action all inherit essentially no PATH
    # and a bare `node` there resolves to nothing at boot. augment_path ran above, so this is the
    # same node every other lifecycle step picked.
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    if [ -z "$NODE_BIN" ]; then
      err "no node on PATH — a $SERVICE_KIND service cannot resolve one at boot; install node and re-run"
      exit 1
    fi
    UNIT="$(service_install "$ROOT" "$NODE_BIN")" || { err "could not install the $SERVICE_KIND service"; exit 1; }
    service_restart || { err "the $SERVICE_KIND service would not start — check $(irises_home)/logs/server.log"; exit 1; }
    manifest_record "serviceKind=$SERVICE_KIND" "serviceUnit=$UNIT"
    SERVICE_STATE="installed ($SERVICE_KIND, $UNIT)"
    RESTART_STATE="started by the $SERVICE_KIND service"
  else
    # The pid is read BEFORE the removal: every backend stops the service on its way out, launchd's
    # bootout can return before the process is actually gone, and once the unit is removed there is
    # nothing left to ask which pid was its.
    PID="$(server_pid)"
    service_uninstall
    if [ -n "$PID" ]; then server_stop_pid "$PID" 20; fi
    server_start_detached "$ROOT" || { err "could not start Irises detached — see $(irises_home)/logs/server.log"; exit 1; }
    manifest_record "serviceKind=none" "serviceUnit="
    SERVICE_STATE="removed — Irises runs detached; nothing restarts it after a reboot"
    RESTART_STATE="started detached"
  fi
  # Said in the summary rather than left to be worked out: the operator passed --no-restart and the
  # server moved anyway, and a run that does not name the one flag it did not honour reads like a
  # bug in the flag.
  if [ "$DO_RESTART" = "0" ]; then
    RESTART_STATE="$RESTART_STATE — a --service transition is the start/stop itself, so --no-restart does not apply"
  fi
  if ! wait_health_sha "http://127.0.0.1:$PORT_NOW" "$SHA" 60 >/dev/null; then
    summary health-failed \
      "changed:   $CHANGED_KEYS" \
      "backup:    $BACKUP_SHOWN" \
      "service:   $SERVICE_STATE" \
      "Irises:    $RESTART_STATE, but /health did not report build $(printf '%.7s' "${SHA:-unknown}") on :$PORT_NOW within 60s — read $(irises_home)/logs/server.log"
    exit 4
  fi
  RESTART_STATE="$RESTART_STATE — build $(printf '%.7s' "${SHA:-unknown}") verified live on :$PORT_NOW"
  IRISES_RESTARTED=1
elif [ "$CLONE_CHANGED" = "0" ]; then
  # BEFORE the --no-restart arm, because there is nothing here for --no-restart to be skipping: an
  # engine-only run changed the ENGINE's file and nothing of hers. Tested the other way round, the
  # run announced a new value in a .env it never opened, and told the operator to go restart Irises
  # for a change she does not read.
  # It does not name this clone's .env either: that file was never opened, and a path in this
  # sentence is a path the operator goes and looks at for a change that is not in it.
  RESTART_STATE="not restarted — only the engine's side changed"
  say "not restarting: only the engine's side changed, and Irises reads none of it at boot"
elif [ "$DO_RESTART" = "0" ]; then
  RESTART_STATE="skipped (--no-restart) — the change is on disk; restart Irises yourself"
  say "not restarting: --no-restart. The new value is in $ENV_FILE and takes at her next start"
  # The engine was moved to the new port and she was not, so every inbound message is POSTed at a
  # port nothing is listening on — no error on either side, just silence until someone restarts her.
  if [ "$PORT_URL_MOVED" = "1" ]; then
    warn "the engine now calls Irises on :$NEW_PORT while she still listens on :$CUR_PORT — inbound messages land nowhere until you restart her"
  fi
elif ! service_installed && [ -z "$(server_pid)" ]; then
  # Not a failure, and it must not read like one: there is nothing to restart, and the value will
  # be read the first time she does start.
  RESTART_STATE="not running — the change takes effect at her next start"
  say "no service installed and nothing running — $RESTART_STATE"
else
  if [ -z "$SHA" ]; then
    warn "no dist/version.json — verifying liveness only"
  fi
  if ! irises_restart_verify "$ROOT" "$PORT_NOW" "$SHA" 60; then
    summary health-failed \
      "changed:   $CHANGED_KEYS" \
      "backup:    $BACKUP_SHOWN" \
      "service:   $SERVICE_STATE" \
      "Irises:    restarted, but /health did not report build $(printf '%.7s' "${SHA:-unknown}") within 60s — read $(irises_home)/logs/server.log"
    exit 4
  fi
  IRISES_RESTARTED=1
  if [ -n "$SHA" ]; then
    RESTART_STATE="restarted — build $(printf '%.7s' "$SHA") verified live on :$PORT_NOW"
  else
    RESTART_STATE="restarted — live on :$PORT_NOW (no dist/version.json to check the build against)"
  fi
fi

# ── the engine's gateway ─────────────────────────────────────────────────────
# IRISES_URL and IRISES_FRONT are read when the gateway STARTS and at no other moment, so an engine
# write nobody bounced is a setting that changed a file and nothing else. And a restart of Irises
# always takes the gateway with it, engine-side change or not.
GATEWAY_STATE="n/a (no engine-side change, Irises not restarted)"
if { [ "$ENGINE_CHANGED" = "1" ] || [ "$IRISES_RESTARTED" = "1" ]; } && [ "$ENGINE" != "off" ]; then
  if [ "$DO_GATEWAY" = "0" ]; then
    if [ "$ENGINE_CHANGED" = "1" ]; then
      GATEWAY_STATE="skipped (--no-gateway-restart) — the engine reads IRISES_URL / IRISES_FRONT only when its gateway starts"
    else
      GATEWAY_STATE="skipped (--no-gateway-restart) — Irises restarted, the gateway did not"
    fi
  elif gateway_restart "$ENGINE" 90; then
    GATEWAY_STATE="bounced and verified"
  else
    # Nothing is rolled back, and the summary says so: Irises herself is configured and answering,
    # and undoing that over an engine we could not verify would break the half that works.
    # engine-setup.sh:1005-1014 reports its own install the same way.
    summary gateway-failed \
      "changed:   $CHANGED_KEYS" \
      "backup:    $BACKUP_SHOWN" \
      "Irises:    $RESTART_STATE" \
      "service:   $SERVICE_STATE" \
      "gateway:   NOT verified back up — nothing of this run was undone, and Irises is on the new settings" \
      "next:      find out why, then bounce it by hand; the engine reads the change only at its next start"
    exit 5
  fi
fi

summary ok \
  "changed:   $CHANGED_KEYS" \
  "backup:    $BACKUP_SHOWN" \
  "Irises:    $RESTART_STATE" \
  "service:   $SERVICE_STATE" \
  "gateway:   $GATEWAY_STATE" \
  "show:      bash scripts/configure.sh --show"
exit 0
