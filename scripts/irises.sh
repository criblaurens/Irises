#!/usr/bin/env bash
# Irises — the front door: install, update, uninstall and detach, from one menu.
#
#   bash ./scripts/irises.sh        # or: npm run setup
#
# IT IMPLEMENTS NOTHING. Every action here ends in a call to scripts/engine-setup.sh,
# scripts/configure.sh or scripts/update.sh with flags, and the exact command line is PRINTED before
# it runs — so a run that went well can be repeated from a script, and a run that did not can be
# reported in one line. The flags stay the supported path for deploys and for agents; this file is
# for the human at the keyboard, who should not have to know them to be in control of what happens
# to their engine.
#
# WHAT IT ADDS over the flags: the questions. Which engine, which chats Irises fronts, which model
# her own voice runs on, what may be written to the engine's .env, what to change AFTERWARDS without
# re-installing, and — on the way out — whether to stop, detach, uninstall or delete. Everything it
# learns becomes flags, which is why the composed command line is printed rather than described.
#
# THE PROMPTS READ STDIN, and stdin only (see the helper block in lib/irises-lib.sh). This script
# never sets IRISES_ASSUME_YES, so a piped heredoc walks the same menu a person does; EOF at a menu
# is an answer too — it quits with exit 2 and points at the flag scripts, because a wizard that
# silently took every default for a terminal that went away is how an install nobody asked for
# happens. A CHILD INHERITS THAT STDIN: under a pipe it sees no TTY and auto-yeses from its own
# no-TTY block, which is what lets a heredoc walk install and configure the whole way through.
#
# THE DOUBLE-PROMPT RULE. The wizard confirms once. Update, uninstall, detach and stop pass --yes to
# the child, whose own y/N would be the same question twice. Two actions do NOT. Install: the
# engine-.env consent preview has to run inside engine-setup.sh, where the diff is computed, so the
# install child is invoked with --engine-env ask instead. Configure: scripts/configure.sh computes
# the +/~/- diff of what a setting would change and asks its own Apply? over it — a question this
# script cannot ask, because it does not know the old values or how the child would read them. So
# NO configure action passes --yes. The one gate this script keeps for itself is the "type the word
# delete" one in front of a purge, and the sha gate in front of a rollback.
#
# EXIT CODES
#   0  the menu was quit (each action reports its own child's exit code on screen)
#   2  stdin ran out with a question still open — nothing was changed
set -euo pipefail

source "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/lib/irises-lib.sh"
IRISES_LOG_TAG="irises"

SCRIPTS_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SETUP_SH="$SCRIPTS_DIR/engine-setup.sh"
UPDATE_SH="$SCRIPTS_DIR/update.sh"
CONFIGURE_SH="$SCRIPTS_DIR/configure.sh"
# How the three children are NAMED on screen: the relative form, from the clone root, which is where
# this script cds to and where a person reading the line will be standing.
SETUP_NAME="scripts/engine-setup.sh"
UPDATE_NAME="scripts/update.sh"
CONFIGURE_NAME="scripts/configure.sh"

ROOT="$(irises_root)"
cd "$ROOT"
augment_path

LAST_RC=0          # the exit code of the child the last action ran
ANSWER=""          # the line the last menu prompt read

# ── asking ────────────────────────────────────────────────────────────────────

# A line of the SCREEN, not of the log. The library's say/warn/err carry a `[irises]` tag, which is
# right for narration an operator pastes into an issue and wrong for a menu — a list of choices with
# a log tag down its left edge reads like output, not like something waiting for an answer.
ui() { printf '%s\n' "$*"; }

# A menu line. Unlike the library's helpers this one tells EOF from an empty line: at a menu, the
# empty line is the default and the EOF is a terminal that is gone.
ask_line() { # PROMPT DEFAULT -> sets ANSWER; returns 1 at EOF
  local prompt="${1:-choose}" def="${2:-}"
  if [ -n "${NO_COLOR:-}" ]; then
    printf '[%s] %s [%s]: ' "$IRISES_LOG_TAG" "$prompt" "$def"
  else
    printf '\033[33m[%s]\033[0m %s [%s]: ' "$IRISES_LOG_TAG" "$prompt" "$def"
  fi
  # IFS= and -r: the answer is taken as typed. A menu key never has leading spaces to strip, and the
  # one prompt where stripping them would matter — the confirm token — is the library's.
  if ! IFS= read -r ANSWER; then
    ANSWER=""
    return 1
  fi
  if [ -z "$ANSWER" ]; then ANSWER="$def"; fi
  return 0
}

# The end of a run that nobody is left to answer for.
eof_quit() {
  printf '\n'
  warn "stdin ran out with a question still open — nothing was changed."
  warn "the scripted path needs no terminal, and takes the same decisions as flags:"
  warn "  bash $SETUP_NAME --help"
  warn "  bash $CONFIGURE_NAME --help"
  warn "  bash $UPDATE_NAME --help"
  exit 2
}

# A value as it would have to be typed into a shell. Anything outside the safe set is single-quoted,
# which is what makes the echoed command line copyable: --front 'telegram:*' has to keep its quotes
# or the shell that re-runs it hands the glob to the filesystem first.
q_arg() { # ARG
  case "${1:-}" in
    '') printf "''" ;;
    *[!A-Za-z0-9_@%+=:,./-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

sha7() { # SHA
  local s="${1:-}"
  if [ -z "$s" ]; then printf 'unknown'; return 0; fi
  printf '%s' "${s:0:7}"
}

# $HOME collapsed back to ~, for a header that has to fit on one line.
tilde() { # PATH
  local p="${1:-}"
  case "$p" in "$HOME"/*) printf '~%s' "${p#"$HOME"}" ;; "$HOME") printf '~' ;; *) printf '%s' "$p" ;; esac
}

# ── running a child ───────────────────────────────────────────────────────────

# Print the command line, then be the thing that runs it. The print is not decoration: it is the
# one guarantee that this menu and the flags cannot drift apart without somebody seeing it, and it
# is what an operator pastes into an issue when the run goes wrong.
#
# A SECRET IS NEVER ON THAT LINE, because it is never in argv: the three this menu can collect go to
# the child in the environment, and the line says `<set>` where the value would be. IRISES_SET_VALUE
# is the third — Configure's generic editor uses it for every key whose name says it holds a secret,
# and a value that reached the printed line through it would be the same leak by another door.
run_child() { # SCRIPT DISPLAY_NAME ARG…
  local script="${1:-}" display="${2:-}" line="" prefix="" a
  shift 2 || true
  for a in "$@"; do line="$line $(q_arg "$a")"; done
  if [ -n "${IRISES_MODEL_API_KEY:-}" ]; then prefix="IRISES_MODEL_API_KEY=<set> "; fi
  if [ -n "${IRISES_DASHBOARD_PASSWORD:-}" ]; then prefix="${prefix}IRISES_DASHBOARD_PASSWORD=<set> "; fi
  if [ -n "${IRISES_SET_VALUE:-}" ]; then prefix="${prefix}IRISES_SET_VALUE=<set> "; fi
  printf '\n'
  say "running, from $ROOT — copy this line to repeat it without the menu:"
  say "  ${prefix}bash ${display}${line}"
  printf '\n'
  set +e
  bash "$script" "$@"
  LAST_RC=$?
  set -e
  return 0
}

# What to do with the box now. Printed after every action, because "it said ok" and "I know where to
# look when it is not" are two different states to leave someone in.
next_steps() {
  local kind port home
  kind="$(service_kind)"
  port="$(irises_port)"
  home="$(irises_home)"
  printf '\n'
  say "── next steps ──"
  say "the last command exited $LAST_RC (its own RESULT: line is above)"
  if service_installed; then
    case "$kind" in
      systemd)  say "the service:  systemctl --user status irises   ·   systemctl --user restart irises" ;;
      launchd)  say "the service:  launchctl print gui/$(id -u)/ai.irises.server" ;;
      schtasks) say "the service:  schtasks /Query /TN Irises" ;;
      *)        say "a service is installed, but no manager on this box claims it" ;;
    esac
  else
    say "no service is installed — Irises runs detached, and nothing restarts it after a reboot"
  fi
  say "logs:         $home/logs/server.log"
  say "update log:   $home/logs/update.log"
  say "health:       curl -s http://127.0.0.1:$port/health"
  say "your data:    $home  (irises.db + memories/ — no update ever touches it)"
  printf '\n'
}

# ── the status header ─────────────────────────────────────────────────────────

engine_where() { # ENGINE
  case "${1:-}" in
    hermes)   tilde "$(hermes_home)" ;;
    openclaw) tilde "$(openclaw_home)" ;;
    *)        printf 'standalone' ;;
  esac
}

status_header() {
  local engine man installed build kind port
  engine="$(engine_kind 2>/dev/null || printf 'off')"
  man="$(manifest_path)"
  build="$(sha7 "$(built_sha "$ROOT")")"
  if [ -f "$man" ]; then installed="yes (build $build)"; else installed="no"; fi
  kind="$(service_kind)"
  if ! service_installed; then kind="$kind, none installed"; fi
  port="$(irises_port)"
  printf '\n'
  ui "Irises"
  ui "  engine: $engine ($(engine_where "$engine"))    installed: $installed    service: $kind    port: $port"
}

health_line() {
  local port body
  port="$(irises_port)"
  body="$(curl -fsS -m 5 "http://127.0.0.1:$port/health" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    warn "nothing answers http://127.0.0.1:$port/health — Irises is not running, or not on that port"
    return 1
  fi
  say "/health on :$port says: $body"
  return 0
}

# What `configure.sh --show` already prints, shown verbatim — the same deal menu_update strikes with
# `update.sh --check`. The manifest this used to read is only what the INSTALL chose; --show reads
# every setting back from where it actually lives now (this clone's .env, the engine's .env, the
# service manager, a default), and says which of those each value came from. Reprinting a subset of
# that in this script's own words would be a second place to be wrong about a live box.
show_report() {
  local out rc
  set +e
  out="$(bash "$CONFIGURE_SH" --show 2>&1)"
  rc=$?
  set -e
  # Verbatim, exactly as menu_update prints `update.sh --check`: --show already indents its own
  # report lines, and a second indent here would push them off a narrow terminal. The blank line is
  # what keeps the report's `RESULT: ok` tail from reading as the first entry of the list below it.
  printf '%s\n\n' "$out"
  return "$rc"
}

# ── 5) status ─────────────────────────────────────────────────────────────────

do_status() {
  status_header
  show_report || true
  health_line || true
  printf '\n'
}

# ── 1) install ────────────────────────────────────────────────────────────────

port_valid() { # VALUE
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$1" -lt 1 ] || [ "$1" -gt 65535 ]; then return 1; fi
  return 0
}

slug_valid() { # VALUE — a model id is whatever the provider says it is, but it is not empty
  case "${1:-}" in
    ''|*[[:space:]]*) return 1 ;;
  esac
  return 0
}

url_valid() { # VALUE
  case "${1:-}" in
    http://*|https://*) return 0 ;;
  esac
  return 1
}

# The host's own zone, which is what an unset IRISES_TZ already means — offered as the default so
# the answer is a confirmation rather than a guess. Never a hard-coded zone.
system_tz() {
  local z=""
  if command -v node >/dev/null 2>&1; then
    z="$(node -e 'try{process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone||"")}catch(e){}' 2>/dev/null || true)"
  fi
  printf '%s' "$z"
}

W_ENGINE=""
W_MODEL_LANE=""
W_MODEL_SLUG=""
W_MODEL_URL=""
W_MODEL_KEY=""
W_FRONT_MODE="every"
W_FRONT=""
W_PORT=""
W_SERVICE=1
W_WEB=""
W_PINGS=""
W_MUSINGS=""
W_TZ=""
W_DASH_PW=""

wiz_engine() { # step 1 — 0 = forward, 1 = back out of the wizard
  local detected pick
  detected="$(engine_kind 2>/dev/null || printf 'off')"
  say "Step 1 of 7 — the engine Irises does deep work through"
  if [ "$detected" != "off" ]; then
    if ask_yn "Install Irises against $detected ($(engine_where "$detected"))?" y; then
      W_ENGINE="$detected"
      return 0
    fi
  else
    say "no engine detected on this box"
  fi
  pick="$(ask_choice "which engine" 1 "hermes" "openclaw" "no engine (standalone)")"
  case "$pick" in
    1) W_ENGINE="hermes" ;;
    2) W_ENGINE="openclaw" ;;
    *) W_ENGINE="off" ;;
  esac
  return 0
}

wiz_disclosure() { # step 2
  say "Step 2 of 7 — what an install touches"
  say "Irises never modifies hermes/OpenClaw code, binaries, or their install. It adds keys to the"
  say "engine's .env — only with your consent, previewed first — and copies a plugin directory into"
  say "the engine's own plugin folder. Both are removed by the uninstaller."
  if ask_yn "Continue?" y; then return 0; fi
  return 1
}

wiz_model() { # step 3
  local pick lane
  W_MODEL_LANE=""; W_MODEL_SLUG=""; W_MODEL_URL=""; W_MODEL_KEY=""
  say "Step 3 of 7 — the model Irises's own voice runs on"
  # `back` is a numbered option rather than the plan's `b`: ask_choice speaks numbers, and a second
  # prompt helper that took a letter would be a second place for EOF and --yes to behave differently.
  pick="$(ask_choice "model" 1 \
    "Inherit the engine's model (recommended)" \
    "Pick a model for Irises's own voice" \
    "back")"
  if [ "$pick" = "3" ]; then return 2; fi
  if [ "$pick" = "1" ]; then return 0; fi
  lane="$(ask_choice "lane" 1 "Anthropic" "OpenRouter" "OpenAI-compatible")"
  case "$lane" in
    1) W_MODEL_LANE="anthropic" ;;
    2) W_MODEL_LANE="openrouter" ;;
    *) W_MODEL_LANE="openai" ;;
  esac
  W_MODEL_SLUG="$(ask_text "model slug" "" slug_valid)" || {
    warn "no model id, so nothing is overridden — Irises will inherit the engine's model"
    W_MODEL_LANE=""
    return 0
  }
  # The key never reaches argv. ask_secret keeps it off the screen as well, and this script keeps it
  # in one variable that is cleared the moment the child has been handed it.
  W_MODEL_KEY="$(ask_secret "API key (not shown, not logged):")" || W_MODEL_KEY=""
  if [ -z "$W_MODEL_KEY" ]; then
    warn "no key given — the install writes the model and provider, and leaves the key in .env as it"
    warn "stands. Irises's own voice cannot call the $W_MODEL_LANE lane until one is there."
  fi
  if [ "$W_MODEL_LANE" = "openai" ]; then
    W_MODEL_URL="$(ask_text "base URL" "https://api.openai.com/v1" url_valid)" || W_MODEL_URL="https://api.openai.com/v1"
  fi
  return 0
}

wiz_front() { # step 4
  local pick
  say "Step 4 of 7 — which chats Irises answers in front of the engine"
  pick="$(ask_choice "chat front" 1 \
    "Front every chat on every platform the engine speaks (*:*)" \
    "Front only chats I name" \
    "Don't front anything (no plugin, deep work only)" \
    "back")"
  if [ "$pick" = "4" ]; then return 2; fi
  case "$pick" in
    1) W_FRONT_MODE="every"; W_FRONT="" ;;
    2) W_FRONT_MODE="named"
       W_FRONT="$(ask_text "patterns, comma-separated (<platform>:<glob>)" "" front_pattern_valid)" || {
         warn "that is not a scope the engine can parse, so nothing is narrowed — ask again"
         return 1
       } ;;
    *) W_FRONT_MODE="none"; W_FRONT="" ;;
  esac
  return 0
}

wiz_port_service() { # step 5
  say "Step 5 of 7 — the port, and whether Irises comes back after a reboot"
  W_PORT="$(ask_text "Port" "$(irises_port)" port_valid)" || W_PORT="$(irises_port)"
  if ask_yn "Install Irises as a service so it starts with your machine?" y; then
    W_SERVICE=1
  else
    W_SERVICE=0
  fi
  return 0
}

wiz_extras() { # step 6
  local tz
  W_WEB=""; W_PINGS=""; W_MUSINGS=""; W_TZ=""; W_DASH_PW=""
  say "Step 6 of 7 — optional extras"
  if ! ask_yn "Set optional extras (dashboard, timezone, texting first)?" n; then return 0; fi
  if ask_yn "Enable the browser chat UI (and npm run chat)?" y; then W_WEB="on"; else W_WEB="off"; fi
  if ask_yn "Let her text first to ask how things you left hanging went?" y; then W_PINGS="on"; else W_PINGS="off"; fi
  if ask_yn "Let her text first about what is on her own mind?" y; then W_MUSINGS="on"; else W_MUSINGS="off"; fi
  W_DASH_PW="$(ask_secret "Dashboard password (blank = /dashboard answers only this machine):")" || W_DASH_PW=""
  # The default offered is the host's own zone, which is what an unset IRISES_TZ already means — so
  # the answer is a confirmation rather than a guess. It is written even when it EQUALS that zone:
  # extras were asked for, this is the answer, and a box that is later moved to another region
  # should keep the clock its owner chose rather than silently follow the move.
  tz="$(system_tz)"
  W_TZ="$(ask_text "Your timezone" "$tz")" || W_TZ="$tz"
  return 0
}

wiz_summary_apply() { # step 7 — 0 = applied or declined cleanly
  local front_desc model_desc extras_desc env_desc
  say "Step 7 of 7 — what is about to happen"
  case "$W_FRONT_MODE" in
    every) front_desc="every chat on every platform the engine speaks (*:*)" ;;
    named) front_desc="only $W_FRONT" ;;
    *)     front_desc="nothing — no bridge plugin, deep work only" ;;
  esac
  if [ -n "$W_MODEL_LANE" ]; then
    model_desc="$W_MODEL_SLUG on the $W_MODEL_LANE lane, for all three voice roles"
  else
    model_desc="inherited from the engine"
  fi
  extras_desc="left as they are"
  if [ -n "$W_WEB" ] || [ -n "$W_TZ" ] || [ -n "$W_DASH_PW" ]; then
    extras_desc="${W_WEB:+browser chat $W_WEB}${W_PINGS:+ · thread pings $W_PINGS}${W_MUSINGS:+ · musings $W_MUSINGS}${W_TZ:+ · timezone $W_TZ}${W_DASH_PW:+ · dashboard password set}"
  fi
  if [ "$W_ENGINE" = "hermes" ]; then
    env_desc="previewed line by line before anything is written"
  else
    env_desc="n/a — this engine is wired from its own side, and the lines are printed for you"
  fi
  say "  engine:    $W_ENGINE ($(engine_where "$W_ENGINE"))"
  say "  port:      $W_PORT"
  say "  service:   $(if [ "$W_SERVICE" = "1" ]; then printf 'yes — Irises starts with the machine'; else printf 'no — detached, nothing restarts it'; fi)"
  say "  model:     $model_desc"
  if [ -n "$W_MODEL_LANE" ]; then
    say "             Irises stops inheriting the engine's model and keys for her own voice."
    say "             Deep work still runs on the engine's model, through the engine."
  fi
  say "  fronts:    $front_desc"
  say "  extras:    $extras_desc"
  say "  engine .env: $env_desc"
  # ask_line prints the default in brackets itself, so the question does not carry its own [Y/n].
  if ! ask_line "Apply this?" "y"; then eof_quit; fi
  case "$ANSWER" in
    y|Y|yes|YES) ;;
    *) say "nothing was applied"; return 0 ;;
  esac

  # The answers, become flags. `set --` rather than an array: it is the one list bash 3.2 (which is
  # what macOS ships) handles the same way everywhere, and run_child passes it on untouched.
  set -- --engine "$W_ENGINE" --port "$W_PORT" --engine-env ask
  if [ "$W_SERVICE" = "1" ]; then set -- "$@" --service; else set -- "$@" --no-service; fi
  case "$W_FRONT_MODE" in
    named) set -- "$@" --front "$W_FRONT" ;;
    none)  set -- "$@" --no-bridge ;;
  esac
  if [ -n "$W_MODEL_LANE" ]; then
    set -- "$@" --model-lane "$W_MODEL_LANE" --model-slug "$W_MODEL_SLUG"
    if [ -n "$W_MODEL_URL" ]; then set -- "$@" --model-base-url "$W_MODEL_URL"; fi
  fi
  if [ -n "$W_WEB" ]; then set -- "$@" --web "$W_WEB"; fi
  if [ -n "$W_PINGS" ]; then set -- "$@" --pings "$W_PINGS"; fi
  if [ -n "$W_MUSINGS" ]; then set -- "$@" --musings "$W_MUSINGS"; fi
  if [ -n "$W_TZ" ]; then set -- "$@" --tz "$W_TZ"; fi
  # The two secrets, handed over in the environment and gone from this process immediately after.
  # --yes is NOT passed: the engine-.env preview is the child's question to ask, and this is the one
  # action where the wizard's single confirmation does not cover it.
  if [ -n "$W_MODEL_KEY" ]; then export IRISES_MODEL_API_KEY="$W_MODEL_KEY"; fi
  if [ -n "$W_DASH_PW" ]; then export IRISES_DASHBOARD_PASSWORD="$W_DASH_PW"; fi
  run_child "$SETUP_SH" "$SETUP_NAME" "$@"
  unset IRISES_MODEL_API_KEY IRISES_DASHBOARD_PASSWORD || true
  W_MODEL_KEY=""; W_DASH_PW=""
  next_steps
  return 0
}

menu_install() {
  local step=1 rc=0
  W_ENGINE=""; W_FRONT_MODE="every"; W_FRONT=""; W_PORT="$(irises_port)"; W_SERVICE=1
  while :; do
    case "$step" in
      1) if wiz_engine; then step=2; else return 0; fi ;;
      2) if wiz_disclosure; then step=3; else return 0; fi ;;
      # `|| rc=$?` rather than a bare call: a step that returns 2 for "back" would otherwise take
      # errexit with it, and the wizard would vanish mid-question.
      3) rc=0; wiz_model || rc=$?; if [ "$rc" = "2" ]; then step=2; else step=4; fi ;;
      4) rc=0; wiz_front || rc=$?
         case "$rc" in 2) step=3 ;; 0) step=5 ;; esac ;;
      5) wiz_port_service; step=6 ;;
      6) wiz_extras; step=7 ;;
      7) wiz_summary_apply; return 0 ;;
      *) return 0 ;;
    esac
  done
}

# ── 2) configure ──────────────────────────────────────────────────────────────

# The wizard's questions, asked again on a box that is already installed. Before this section the
# only way to move a port or a timezone was to re-run the installer over a live clone — an `npm ci`,
# a rebuild and a plugin copy, for a one-line .env change.
#
# NOTHING HERE PASSES --yes. scripts/configure.sh reads the values off disk, prints the +/~/- lines
# of what would change and asks its own Apply? over them. This menu knows neither the old values nor
# what the child would make of them, so the confirmation has to be the child's (see THE DOUBLE-PROMPT
# RULE at the top). Each entry asks, composes flags, runs one child, and comes back to the top menu.

# A .env key as a person types it: first character A-Z, the rest A-Z, 0-9 or _. It mirrors
# configure.sh's own key_valid rather than calling it — the child is a separate process, and a typo
# caught here is a question re-asked instead of a spawned run that exits 2.
key_valid() { # KEY
  case "${1:-}" in
    ''|*[!A-Z0-9_]*) return 1 ;;
    [A-Z]*)          return 0 ;;
  esac
  return 1
}

cfg_port_service() {
  local port svc_def
  say "the port Irises listens on, and whether it comes back after a reboot"
  port="$(ask_text "Port" "$(irises_port)" port_valid)" || port="$(irises_port)"
  # The default offered is the state the box is IN, not the state an install would choose. Someone
  # reaching this menu came to change ONE thing, and an Enter through the other question has to
  # leave it exactly as it was — a default of `y` here would install a service on every port move.
  if service_installed; then svc_def="y"; else svc_def="n"; fi
  if ask_yn "Run Irises as a service so it starts with your machine?" "$svc_def"; then
    set -- --port "$port" --service on
  else
    set -- --port "$port" --service off
  fi
  run_child "$CONFIGURE_SH" "$CONFIGURE_NAME" "$@"
  next_steps
  return 0
}

cfg_front() {
  local pick patterns
  say "which chats Irises answers in front of the engine (this lives in the ENGINE's .env)"
  pick="$(ask_choice "chat front" 1 \
    "Front every chat on every platform the engine speaks (*:*)" \
    "Front only chats I name" \
    "Front nothing (the plugin stays, inert)" \
    "back")"
  case "$pick" in
    1) set -- --front '*:*' ;;
    2) patterns="$(ask_text "patterns, comma-separated (<platform>:<glob>)" "" front_pattern_valid)" || {
         warn "that is not a scope the engine can parse, so nothing was narrowed — nothing changed"
         return 0
       }
       set -- --front "$patterns" ;;
    3) set -- --front none ;;
    *) return 0 ;;
  esac
  run_child "$CONFIGURE_SH" "$CONFIGURE_NAME" "$@"
  next_steps
  return 0
}

cfg_model() {
  local pick lane_pick lane slug key url
  say "the model Irises's own voice runs on — deep work still runs on the engine's model"
  pick="$(ask_choice "model" 1 \
    "Go back to inheriting the engine's model" \
    "Pick a model for Irises's own voice" \
    "back")"
  case "$pick" in
    1) set -- --model-inherit ;;
    2)
      lane_pick="$(ask_choice "lane" 1 "Anthropic" "OpenRouter" "OpenAI-compatible")"
      case "$lane_pick" in
        1) lane="anthropic" ;;
        2) lane="openrouter" ;;
        *) lane="openai" ;;
      esac
      slug="$(ask_text "model slug" "" slug_valid)" || {
        warn "no model id — nothing changed"
        return 0
      }
      # Blank is a real answer here, and a different one from the installer's: the lane's key may
      # already be in this clone's .env from an earlier run, and re-typing a secret to change a
      # model id is how people end up pasting one into the wrong window.
      key="$(ask_secret "API key (not shown, not logged; blank keeps the key already in .env):")" || key=""
      set -- --model-lane "$lane" --model-slug "$slug"
      if [ "$lane" = "openai" ]; then
        url="$(ask_text "base URL" "https://api.openai.com/v1" url_valid)" || url="https://api.openai.com/v1"
        set -- "$@" --model-base-url "$url"
      fi
      if [ -n "$key" ]; then export IRISES_MODEL_API_KEY="$key"; fi ;;
    *) return 0 ;;
  esac
  run_child "$CONFIGURE_SH" "$CONFIGURE_NAME" "$@"
  # Gone from this process the moment the child has it, so nothing later in the session can print it.
  unset IRISES_MODEL_API_KEY || true
  key=""
  next_steps
  return 0
}

cfg_web() {
  local web_def
  say "the browser chat UI this clone serves (WEB_ENABLED)"
  # The default offered is the state the box is IN, on the same rule cfg_port_service states: an
  # Enter through this question has to leave the setting exactly as it was. Anything but an explicit
  # `false` is on — that is how src/ reads the key, and an unset .env is a clone that serves the UI.
  if [ "$(env_get "$ROOT/.env" WEB_ENABLED)" = "false" ]; then web_def="n"; else web_def="y"; fi
  if ask_yn "Enable the browser chat UI (and npm run chat)?" "$web_def"; then
    set -- --web on
  else
    set -- --web off
  fi
  run_child "$CONFIGURE_SH" "$CONFIGURE_NAME" "$@"
  next_steps
  return 0
}

cfg_texting() {
  local pings_def musings_def
  say "whether she texts first (THREADING_PINGS_ENABLED, IRISES_MUSINGS_ENABLED)"
  # Offered as the box is NOW, cfg_web's rule. Both are on unless the key says off.
  case "$(env_get "$ROOT/.env" THREADING_PINGS_ENABLED | tr '[:upper:]' '[:lower:]')" in
    ''|true|1|on|yes) pings_def="y" ;; *) pings_def="n" ;;
  esac
  case "$(env_get "$ROOT/.env" IRISES_MUSINGS_ENABLED | tr '[:upper:]' '[:lower:]')" in
    ''|true|1|on|yes) musings_def="y" ;; *) musings_def="n" ;;
  esac
  if ask_yn "Let her text first to ask how things you left hanging went?" "$pings_def"; then
    set -- --pings on
  else
    set -- --pings off
  fi
  if ask_yn "Let her text first about what is on her own mind?" "$musings_def"; then
    set -- "$@" --musings on
  else
    set -- "$@" --musings off
  fi
  run_child "$CONFIGURE_SH" "$CONFIGURE_NAME" "$@"
  next_steps
  return 0
}

cfg_tz() {
  local tz
  say "the wall clock Irises reads — it is what she calls late, not a formatting preference"
  tz="$(ask_text "Your timezone (type host to follow this machine)" "$(system_tz)")" || tz="$(system_tz)"
  if [ -z "$tz" ]; then
    # system_tz is empty when node is not on PATH, and `--tz ''` is a usage error, not a reset. The
    # word the child takes for "follow this machine" is `host`.
    warn "no zone given — type a zone name, or the word host to follow this machine"
    return 0
  fi
  set -- --tz "$tz"
  run_child "$CONFIGURE_SH" "$CONFIGURE_NAME" "$@"
  next_steps
  return 0
}

cfg_dashboard() {
  local pw
  say "the /dashboard admin password"
  pw="$(ask_secret "New dashboard password (not shown; blank = nothing changes):")" || pw=""
  if [ -z "$pw" ]; then
    say "nothing changed"
    return 0
  fi
  # No flag, and there is none to pass: the variable's PRESENCE is the request (configure.sh --help,
  # ENVIRONMENT). A password on argv is readable by every other process on the box and lands in
  # shell history, so this is the one setting whose whole interface is an environment variable.
  export IRISES_DASHBOARD_PASSWORD="$pw"
  run_child "$CONFIGURE_SH" "$CONFIGURE_NAME"
  unset IRISES_DASHBOARD_PASSWORD || true
  pw=""
  next_steps
  return 0
}

cfg_any_key() {
  local pick key v
  say "any documented key in this clone's .env — the flags above are the ones with side effects"
  pick="$(ask_choice "set or unset" 1 "set a key" "unset a key" "back")"
  if [ "$pick" = "3" ]; then return 0; fi
  key="$(ask_text "KEY (UPPER_SNAKE)" "" key_valid)" || {
    warn "that is not a key name — nothing changed"
    return 0
  }
  if [ "$pick" = "2" ]; then
    set -- --unset "$key"
  elif is_secret_key "$key"; then
    # A key whose NAME says it holds a secret may not carry its value on argv — configure.sh refuses
    # that shape outright, and reads the value out of IRISES_SET_VALUE instead.
    v="$(ask_secret "value (not shown):")" || v=""
    # Blank is nothing changed, never an empty write: `--set KEY` with an empty IRISES_SET_VALUE
    # would blank a credential the operator only meant to look at. cfg_dashboard answers the same
    # way for the same reason — a secret prompt someone backs out of must cost them nothing.
    if [ -z "$v" ]; then
      say "nothing changed"
      return 0
    fi
    export IRISES_SET_VALUE="$v"
    set -- --set "$key"
  else
    v="$(ask_text "value" "")" || v=""
    set -- --set "$key=$v"
  fi
  run_child "$CONFIGURE_SH" "$CONFIGURE_NAME" "$@"
  # Exit 2 is the child's answer to a key neither .env.example nor deploy/app.env documents. The
  # question is asked AFTER the run rather than guessed before it: the child streams to this same
  # terminal, so its reason is on screen above the question, and some real keys are only described
  # in prose in those files — which is what --allow-unknown exists for.
  #
  # Only on the SET branch: an --unset never reaches the documented-key check, so a 2 there is some
  # other usage error and offering --allow-unknown would send the operator to re-run a shape that
  # fails identically.
  if [ "$pick" = "1" ] && [ "$LAST_RC" = "2" ] &&
     ask_yn "The key is not one the docs know. Re-run with --allow-unknown?" n; then
    run_child "$CONFIGURE_SH" "$CONFIGURE_NAME" "$@" --allow-unknown
  fi
  unset IRISES_SET_VALUE || true
  v=""
  next_steps
  return 0
}

menu_configure() {
  while :; do
    printf '\n'
    ui "Configure Irises"
    # The same report Status prints, here as well: an entry is chosen against what the box is set to
    # NOW, and a menu that made someone go back a screen to check would be a menu they guess at.
    show_report || true
    ui "  1) Port and service"
    ui "  2) Which chats Irises fronts"
    ui "  3) The model her voice runs on"
    ui "  4) Browser chat UI"
    ui "  5) Timezone"
    ui "  6) Texting first (thread pings, musings)"
    ui "  7) Dashboard password"
    ui "  8) Set or unset any .env key (advanced)"
    ui "  b) Back"
    # Back is the default, on the same rule as Uninstall: every other entry on this menu changes
    # something, and an Enter meant for the menu above must not be one of them.
    if ! ask_line "choose" "b"; then eof_quit; fi
    case "$ANSWER" in
      b|B) return 0 ;;
      1) cfg_port_service; return 0 ;;
      2) cfg_front; return 0 ;;
      3) cfg_model; return 0 ;;
      4) cfg_web; return 0 ;;
      5) cfg_tz; return 0 ;;
      6) cfg_texting; return 0 ;;
      7) cfg_dashboard; return 0 ;;
      8) cfg_any_key; return 0 ;;
      *) warn "1, 2, 3, 4, 5, 6, 7, 8 or b" ;;
    esac
  done
}

# ── 3) update ─────────────────────────────────────────────────────────────────

# What --check already prints, shown verbatim — it ends in `git log --oneline OLD..NEW`, which is
# the changelog, and reprinting it in this script's own words would be a second place to be wrong.
menu_update() {
  local out rc waiting
  while :; do
    printf '\n'
    ui "Update Irises"
    ui "  1) Apply the update now"
    ui "  2) Check only — report what's waiting, change nothing"
    ui "  3) Apply to disk, restart Irises later"
    ui "  4) Apply without bouncing the engine's gateway"
    ui "  b) Back"
    if ! ask_line "choose" "1"; then eof_quit; fi
    case "$ANSWER" in
      b|B) return 0 ;;
      1|2|3|4) ;;
      *) warn "1, 2, 3, 4 or b"; continue ;;
    esac
    local choice="$ANSWER"
    printf '\n'
    say "asking $UPDATE_NAME what is waiting (nothing is changed by this):"
    set +e
    out="$(bash "$UPDATE_SH" --check 2>&1)"
    rc=$?
    set -e
    printf '%s\n' "$out"
    if [ "$choice" = "2" ]; then
      LAST_RC="$rc"
      next_steps
      return 0
    fi
    if [ "$rc" = "0" ]; then
      say "already up to date — there is nothing to apply"
      return 0
    fi
    if [ "$rc" != "10" ]; then
      warn "the check itself did not finish (exit $rc) — read it above; nothing was applied"
      return 0
    fi
    waiting="$(printf '%s\n' "$out" | grep -c '^[0-9a-f]\{7,\} ' || true)"
    if ! ask_yn "Apply these ${waiting:-0} commits?" n; then
      say "nothing was applied"
      return 0
    fi
    set -- --yes
    case "$choice" in
      3) set -- "$@" --no-restart ;;
      4) set -- "$@" --no-gateway-restart ;;
    esac
    run_child "$UPDATE_SH" "$UPDATE_NAME" "$@"
    next_steps
    return 0
  done
}

# ── 4) uninstall ──────────────────────────────────────────────────────────────

# Stop, and nothing else. The library's own service_stop, not a child script: there is no flag on
# either lifecycle script that stops the service and leaves everything else standing, and inventing
# one for the menu would be lifecycle logic living in two places.
stop_service_only() {
  local kind
  kind="$(service_kind)"
  if ! service_installed; then
    warn "no Irises service is installed, so there is none to stop"
    warn "if Irises is running detached, it holds :$(irises_port) until the box restarts"
    return 0
  fi
  say "stopping the $kind service — nothing is removed, and it starts again on the next boot"
  if service_stop; then
    LAST_RC=0
    say "stopped"
  else
    LAST_RC=1
    warn "the $kind service would not stop — see the manager's own status output"
  fi
  next_steps
  return 0
}

do_detach() {
  say "Detaching undoes every engine-side change: the bridge plugin, the keys Irises added to the"
  say "engine's .env, and the values it moved back to where they were. The .bak-irises-* backups"
  say "stay. Irises itself, its service and your data are untouched — this is the engine's side only."
  if ! ask_yn "Detach from the engine now?" n; then
    say "nothing was detached"
    return 0
  fi
  run_child "$SETUP_SH" "$SETUP_NAME" --detach-engine --yes
  next_steps
  return 0
}

menu_uninstall() {
  local home archive=0
  home="$(irises_home)"
  while :; do
    printf '\n'
    ui "Uninstall Irises"
    ui "  1) Stop the Irises service only — nothing is removed"
    ui "  2) Detach from the engine — undo every engine-side change, keep Irises and your data"
    ui "  3) Uninstall Irises, KEEP my data ($home)"
    ui "  4) Uninstall Irises and DELETE my data"
    ui "  b) Back"
    # The default here is Back, and deliberately: every other entry on this menu takes something
    # away, and an Enter meant for the menu above must not be one of them.
    if ! ask_line "choose" "b"; then eof_quit; fi
    case "$ANSWER" in
      b|B) return 0 ;;
      1) stop_service_only; return 0 ;;
      2) do_detach; return 0 ;;
      3)
        # The one confirmation. The child is handed --yes, so this is the question, not a rehearsal
        # for the child's own.
        say "this removes the service, the bridge plugin and the keys Irises added to the engine."
        say "Your data stays where it is: $home"
        if ! ask_yn "Uninstall Irises and keep your data?" n; then
          say "nothing was removed"
          return 0
        fi
        run_child "$SETUP_SH" "$SETUP_NAME" --uninstall --yes; next_steps; return 0 ;;
      4)
        archive=0
        if ask_yn "Archive $home to ~/.irises-backup-<timestamp>.tar.gz first?" y; then archive=1; fi
        warn "this deletes $home — irises.db and every memory file$(if [ "$archive" = "1" ]; then printf ', with only the archive left'; else printf ', with no backup at all'; fi)"
        # The gate this script keeps rather than delegating: --purge-data --yes deletes without
        # asking, so the asking has to happen HERE, and ask_confirm_token refuses to be satisfied by
        # a non-interactive run at all.
        if ! ask_confirm_token "type the word delete to confirm:" "delete"; then
          say "your data was KEPT — nothing was uninstalled either"
          return 0
        fi
        set -- --uninstall --purge-data --yes
        if [ "$archive" = "1" ]; then set -- --uninstall --archive-data --purge-data --yes; fi
        run_child "$SETUP_SH" "$SETUP_NAME" "$@"
        next_steps
        return 0 ;;
      *) warn "1, 2, 3, 4 or b" ;;
    esac
  done
}

# ── 6) advanced ───────────────────────────────────────────────────────────────

# The newest archived receipt names the build that was on this box before the last update — the one
# fact a rollback needs and the one a person cannot be expected to remember. src/update/receipt.ts
# writes them as applied-<newsha7>-<epoch-ms>.json when the server voices the upgrade.
newest_receipt() {
  local dir
  dir="$(irises_home)/updates"
  if [ ! -d "$dir" ]; then return 1; fi
  ls -t "$dir"/applied-*.json 2>/dev/null | head -1
}

receipt_field() { # FILE KEY
  local f="${1:-}" key="${2:-}" line v
  if [ ! -f "$f" ]; then return 1; fi
  line="$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$f" 2>/dev/null | head -1 || true)"
  if [ -z "$line" ]; then return 1; fi
  v="${line##*:}"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v#\"}"; v="${v%\"}"
  printf '%s' "$v"
}

do_rollback() {
  local receipt old target subject
  receipt="$(newest_receipt || true)"
  if [ -z "$receipt" ]; then
    warn "there is no applied-update receipt in $(irises_home)/updates, so this box has no"
    warn "previously applied build on record. Roll back by sha instead, once you know which:"
    warn "  git --no-pager log --oneline -20"
    warn "  bash $UPDATE_NAME --rollback-to <sha>"
    return 0
  fi
  old="$(receipt_field "$receipt" oldSha || true)"
  if [ -z "$old" ]; then
    warn "$receipt names no oldSha — nothing here says what to go back to"
    return 0
  fi
  if ! git cat-file -e "${old}^{commit}" 2>/dev/null; then
    warn "commit $(sha7 "$old") is not in this clone any more — there is nothing to go back to"
    return 0
  fi
  target="$(sha7 "$old")"
  subject="$(git log -1 --format=%s "$old" 2>/dev/null || true)"
  printf '\n'
  say "the build this box was on before the last update:"
  say "  $target  $subject"
  say "  (from $receipt)"
  warn "this moves the CODE only. Your data in $(irises_home) is NOT rolled back with it, so"
  warn "anything the newer build wrote there stays written and the older code has to live with it."
  if ! ask_confirm_token "type the target sha to confirm ($target):" "$target"; then
    say "nothing was rolled back"
    return 0
  fi
  run_child "$UPDATE_SH" "$UPDATE_NAME" --rollback-to "$old" --yes
  next_steps
  return 0
}

show_manifest() {
  local man
  man="$(manifest_path)"
  if [ ! -f "$man" ]; then
    warn "no install manifest at $man — nothing has been installed here by this script"
    return 0
  fi
  printf '\n'
  say "$man"
  sed 's/^/  /' "$man"
  printf '\n'
  return 0
}

menu_advanced() {
  while :; do
    printf '\n'
    ui "Advanced"
    ui "  1) Detach from the engine (same as Uninstall → 2)"
    ui "  2) Roll back to the previously applied build"
    ui "  3) Show the install manifest"
    ui "  4) Re-run the health check"
    ui "  b) Back"
    if ! ask_line "choose" "b"; then eof_quit; fi
    case "$ANSWER" in
      b|B) return 0 ;;
      1) do_detach; return 0 ;;
      2) do_rollback; return 0 ;;
      3) show_manifest ;;
      4) health_line || true ;;
      *) warn "1, 2, 3, 4 or b" ;;
    esac
  done
}

# ── the top menu ──────────────────────────────────────────────────────────────

main_menu() {
  while :; do
    status_header
    printf '\n'
    ui "  1) Install or repair Irises"
    ui "  2) Configure Irises"
    ui "  3) Update Irises"
    ui "  4) Uninstall Irises"
    ui "  5) Status"
    ui "  6) Advanced"
    ui "  q) Quit"
    if ! ask_line "choose" "1"; then eof_quit; fi
    case "$ANSWER" in
      1) menu_install ;;
      2) menu_configure ;;
      3) menu_update ;;
      4) menu_uninstall ;;
      5) do_status ;;
      6) menu_advanced ;;
      q|Q|quit)
        say "nothing else was changed. The flags are always there:"
        say "  bash $SETUP_NAME --help   ·   bash $CONFIGURE_NAME --show"
        exit 0 ;;
      *) warn "1, 2, 3, 4, 5, 6 or q" ;;
    esac
  done
}

main_menu
