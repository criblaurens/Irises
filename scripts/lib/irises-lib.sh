#!/usr/bin/env bash
# Irises shell library — the one place the lifecycle scripts (scripts/engine-setup.sh,
# scripts/update.sh) get their logging, env-file editing, PATH repair, engine wiring, service
# management and health verification. SOURCE it; never execute it.
#
#   source "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/lib/irises-lib.sh"
#
# Four rules this file lives by, each paid for by a real incident:
#
#  1. NO TOP-LEVEL SIDE EFFECTS. Sourcing runs no command, writes nothing, prints nothing, and
#     exports nothing. Every value is computed inside a function, on every call — a module-level
#     constant freezes the wrong root the moment a caller re-points IRISES_HOME.
#  2. `set -euo pipefail` SAFE. Callers run under it. So: no bare `[ x ] && cmd` as a statement
#     (the list returns 1 and takes the caller down), no unguarded `for` loop as a function's last
#     command, every read of a maybe-unset variable written `${VAR:-}`.
#  3. EVERY MUTATION IS GUARDED. Same reason, other direction: an unguarded `mkdir`/`cp`/`>` that
#     fails on a read-only mount or a full disk kills the caller WHERE IT STANDS — past this
#     function's own warn/return, past the script's summary, so stdout never carries the
#     `RESULT: <token>` line the caller parses. Every write below is therefore
#     `cmd || { err "…"; return 1; }`, and `lifecycle_exit_guard` catches whatever still gets past.
#  4. NO FORK PER LINE in the env parser. deploy/app.env is ~900 lines and gets parsed repeatedly;
#     a `$(...)` per line cost whole seconds. The parsers below are pure parameter expansion.
#
# Functions whose OUTPUT IS CAPTURED by callers (env_backup, service_install, wait_health_sha,
# env_get, manifest_read, …) never `say` — they `log` (stderr) or stay silent.

# Sourcing guard: the scripts source this once, but a test harness (or a nested script) may source
# it again, and re-defining functions mid-run is a good way to lose a `local`.
if [ -n "${IRISES_LIB_SOURCED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
IRISES_LIB_SOURCED=1

# ═══ A. logging ═══════════════════════════════════════════════════════════════
# say → stdout. log/warn/err → stderr. That split is load-bearing: the lifecycle scripts end with a
# machine-readable `RESULT: <token>` line on stdout, and a warning must never land in it.

_irises_paint() { # $1=sgr $2=stream(1|2) $3…=message
  local sgr="${1:-0}" stream="${2:-1}"
  shift 2 || true
  local tag="${IRISES_LOG_TAG:-irises}"
  if [ -n "${NO_COLOR:-}" ]; then
    if [ "$stream" = "2" ]; then printf '[%s] %s\n' "$tag" "$*" >&2; else printf '[%s] %s\n' "$tag" "$*"; fi
    return 0
  fi
  if [ "$stream" = "2" ]; then
    printf '\033[%sm[%s]\033[0m %s\n' "$sgr" "$tag" "$*" >&2
  else
    printf '\033[%sm[%s]\033[0m %s\n' "$sgr" "$tag" "$*"
  fi
  return 0
}

say()  { _irises_paint 36 1 "$@"; }
log()  { _irises_paint 36 2 "$@"; }   # informational, but on stderr: for functions whose stdout is captured
warn() { _irises_paint 33 2 "$@"; }
err()  { _irises_paint 31 2 "$@"; }

# die [RC] MESSAGE… — a leading all-digit argument is the exit code (default 1).
die() {
  local rc=1
  case "${1:-}" in
    ''|*[!0-9]*) ;;
    *) rc="$1"; shift ;;
  esac
  err "$@"
  exit "$rc"
}

# ═══ B. paths ═════════════════════════════════════════════════════════════════

# The clone root. BASH_SOURCE[0] inside a function names THIS file, so the root is two levels up
# from scripts/lib. $IRISES_ROOT overrides it — for tests, and for an unusual checkout layout.
irises_root() {
  if [ -n "${IRISES_ROOT:-}" ]; then
    printf '%s' "$IRISES_ROOT"
    return 0
  fi
  local libdir
  libdir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  ( CDPATH='' cd -- "$libdir/../.." && pwd )
}

# $IRISES_HOME exactly as the server resolves it (src/loadEnv.ts loads deploy/app.env first, then
# .env with override:true — so .env beats the shell, and the shell beats app.env).
irises_home() {
  local root h
  root="$(irises_root)"
  h="$(env_get "$root/.env" IRISES_HOME)"
  if [ -z "$h" ]; then h="${IRISES_HOME:-}"; fi
  if [ -z "$h" ]; then h="$(env_get "$root/deploy/app.env" IRISES_HOME)"; fi
  if [ -z "$h" ]; then h="$HOME/.irises"; fi
  case "$h" in
    "~")   h="$HOME" ;;
    "~/"*) h="$HOME/${h#\~/}" ;;
  esac
  printf '%s' "$h"
}

# The port Irises listens on: .env > deploy/app.env > 3000. (app.env pins 8080 for the Docker image
# behind Caddy; on a clone that number wins at boot while every doc assumes 3000 — hence the pin.)
irises_port() {
  local root p
  root="$(irises_root)"
  p="$(env_get "$root/.env" PORT)"
  if [ -z "$p" ]; then p="$(env_get "$root/deploy/app.env" PORT)"; fi
  if [ -z "$p" ]; then p="3000"; fi
  printf '%s' "$p"
}

# ═══ C. env files ═════════════════════════════════════════════════════════════
# These mirror dotenv (v17, the version in package.json) because both engines and Irises itself read
# these files through it:
#   • the LAST assignment of a key wins (production's ~/.hermes/.env carries two API_SERVER_KEY
#     blocks; the live one is the last);
#   • `export KEY=v` and `KEY = v` are assignments;
#   • an UNQUOTED value ends at the first `#` (dotenv's value pattern is [^#\r\n]+), which is why
#     `OPS_BACKEND=hermes   # hermes | openclaw` resolves to `hermes` and not to a paragraph;
#   • one layer of matching quotes is stripped, and a `#` inside quotes is data.

# A failed append to the scratch copy (full disk, read-only mount) reported once, in one place, and
# the half-written scratch file taken away with it. Callers add their own `return 1`.
_irises_tmp_fail() { # TMP
  err "could not write ${1:-} — a full disk or a read-only mount, and the original is untouched"
  rm -f "${1:-}" 2>/dev/null || true
  return 1
}

env_get() { # FILE KEY -> value (empty when the file or key is absent)
  local f="${1:-}" key="${2:-}" line head v=""
  if [ -z "$key" ] || [ ! -f "${f:-}" ]; then return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '#'*|'') continue ;; esac
    case "$line" in 'export '*) line="${line#export }"; line="${line#"${line%%[![:space:]]*}"}" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    head="${line%%=*}"
    head="${head%"${head##*[![:space:]]}"}"
    if [ "$head" != "$key" ]; then continue; fi
    v="${line#*=}"
    v="${v#"${v%%[![:space:]]*}"}"
    case "$v" in
      '"'*) v="${v#\"}"; v="${v%%\"*}" ;;
      "'"*) v="${v#\'}"; v="${v%%\'*}" ;;
      *)    v="${v%%#*}"; v="${v%"${v##*[![:space:]]}"}" ;;
    esac
  done < "$f"
  printf '%s' "$v"
}

env_count() { # FILE KEY -> how many assignment lines name KEY
  local f="${1:-}" key="${2:-}" line head n=0
  if [ -z "$key" ] || [ ! -f "${f:-}" ]; then printf '0'; return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '#'*|'') continue ;; esac
    case "$line" in 'export '*) line="${line#export }"; line="${line#"${line%%[![:space:]]*}"}" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    head="${line%%=*}"
    head="${head%"${head##*[![:space:]]}"}"
    if [ "$head" = "$key" ]; then n=$((n + 1)); fi
  done < "$f"
  printf '%s' "$n"
}

# Set KEY=VALUE. Present → the FIRST assignment is rewritten and every later duplicate dropped;
# absent → appended. Pair it with env_get (last-wins) to collapse a duplicated key onto its LIVE
# value:  env_set "$f" API_SERVER_KEY "$(env_get "$f" API_SERVER_KEY)".
# The whole file is rewritten line by line, so a missing trailing newline is repaired too, and the
# copy-back through `cat >` keeps the original inode (and therefore its mode and ownership).
env_set() { # FILE KEY VALUE
  local f="${1:-}" key="${2:-}" val="${3:-}" line probe head tmp wrote=0
  if [ -z "$f" ] || [ -z "$key" ]; then return 1; fi
  if [ ! -e "$f" ]; then ( umask 077; : > "$f" ) || return 1; fi
  tmp="$f.irises-tmp.$$"
  ( umask 077; : > "$tmp" ) || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    probe="${line#"${line%%[![:space:]]*}"}"
    head=""
    case "$probe" in
      '#'*|'') ;;
      *)
        case "$probe" in 'export '*) probe="${probe#export }"; probe="${probe#"${probe%%[![:space:]]*}"}" ;; esac
        case "$probe" in
          *=*) head="${probe%%=*}"; head="${head%"${head##*[![:space:]]}"}" ;;
        esac
        ;;
    esac
    if [ -n "$head" ] && [ "$head" = "$key" ]; then
      if [ "$wrote" = "0" ]; then
        printf '%s=%s\n' "$key" "$val" >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }
        wrote=1
      fi
      continue
    fi
    printf '%s\n' "$line" >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }
  done < "$f"
  if [ "$wrote" = "0" ]; then
    printf '%s=%s\n' "$key" "$val" >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }
  fi
  cat "$tmp" > "$f" || { err "could not write $f — is it writable?"; rm -f "$tmp" 2>/dev/null || true; return 1; }
  rm -f "$tmp" 2>/dev/null || true
  return 0
}

# Set KEY only when it is absent or empty. A value the operator typed is never overwritten.
env_set_default() { # FILE KEY VALUE
  local f="${1:-}" key="${2:-}" val="${3:-}" cur
  if [ -z "$f" ] || [ -z "$key" ]; then return 1; fi
  cur="$(env_get "$f" "$key")"
  if [ -n "$cur" ]; then
    say "keeping your existing $key — not overwriting"
    return 0
  fi
  env_set "$f" "$key" "$val"
}

# Append a dated, tagged block of assignments. The marker comment is what `--uninstall` falls back
# to when there is no install manifest, so its shape is a contract: `# — added by Irises setup (…`.
env_append_block() { # FILE TAG KEY=VALUE…
  local f="${1:-}" tag="${2:-}" pair last
  if [ -z "$f" ]; then return 1; fi
  shift 2 || true
  if [ "$#" -eq 0 ]; then return 0; fi
  if [ ! -e "$f" ]; then ( umask 077; : > "$f" ) || return 1; fi
  # An append onto a file whose last byte is not a newline GLUES the new key onto the old value —
  # a live run turned a model id and a base URL into one corrupt line that way.
  if [ -s "$f" ]; then
    last="$(LC_ALL=C tail -c1 "$f" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' || true)"
    if [ "$last" != "0a" ]; then
      printf '\n' >> "$f" || { err "could not append to $f — is it writable?"; return 1; }
    fi
  fi
  {
    printf '\n'
    printf '# — added by Irises setup (%s) — %s —\n' "$(date +%F)" "$tag"
    for pair in "$@"; do printf '%s\n' "$pair"; done
  } >> "$f" || { err "could not append the $tag block to $f — is it writable?"; return 1; }
  return 0
}

# Copy FILE to FILE.bak-irises-<timestamp> (0600) and print ONLY the backup path on stdout (callers
# capture it). TAG is for the stderr log line.
env_backup() { # FILE TAG
  local f="${1:-}" tag="${2:-backup}" b
  if [ ! -f "${f:-}" ]; then return 0; fi
  b="$f.bak-irises-$(date +%Y%m%d-%H%M%S)"
  cp "$f" "$b" || { err "could not back up $f to $b"; return 1; }
  chmod 600 "$b" 2>/dev/null || true
  log "backed up $f -> $b ($tag)"
  printf '%s' "$b"
}

# Remove every assignment of the named keys, plus any Irises marker comment that those removals
# leave with nothing under it AND the one empty line env_append_block put above that marker. Prints
# how many assignments went. Other keys, other comments, other blank lines, and the operator's own
# values are untouched — an uninstall that leaves a stray blank line behind every time it runs does
# not return the file to the shape it found.
#
# Two lines are therefore HELD rather than written as they are read: an empty line, and a marker
# comment. They are flushed in file order the moment anything else has to be written, and dropped
# together when the keys under the marker go.
env_remove_irises_block() { # FILE KEY…
  local f="${1:-}"
  if [ ! -f "${f:-}" ]; then printf '0'; return 0; fi
  shift || true
  if [ "$#" -eq 0 ]; then printf '0'; return 0; fi
  local tmp="$f.irises-tmp.$$" line probe head k marker="" blank=0 drop removed=0
  ( umask 077; : > "$tmp" ) || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    probe="${line#"${line%%[![:space:]]*}"}"
    if [ -z "$line" ]; then
      # A held marker with an empty line under it is not the shape env_append_block writes, so it
      # keeps nothing of ours below it: flush it, and hold this line instead. A blank already held
      # is written out — only ONE empty line above a marker was ever ours.
      if [ -n "$marker" ]; then
        if [ "$blank" = "1" ]; then printf '\n' >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }; fi
        printf '%s\n' "$marker" >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }
        marker=""
        blank=0
      fi
      if [ "$blank" = "1" ]; then printf '\n' >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }; fi
      blank=1
      continue
    fi
    case "$probe" in
      '#'*'added by Irises'*)
        if [ -n "$marker" ]; then
          if [ "$blank" = "1" ]; then printf '\n' >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }; fi
          printf '%s\n' "$marker" >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }
          blank=0
        fi
        marker="$line"
        continue
        ;;
    esac
    head=""
    case "$probe" in
      '#'*|'') ;;
      *)
        case "$probe" in 'export '*) probe="${probe#export }"; probe="${probe#"${probe%%[![:space:]]*}"}" ;; esac
        case "$probe" in
          *=*) head="${probe%%=*}"; head="${head%"${head##*[![:space:]]}"}" ;;
        esac
        ;;
    esac
    drop=0
    if [ -n "$head" ]; then
      for k in "$@"; do
        if [ "$head" = "$k" ]; then drop=1; break; fi
      done
    fi
    if [ "$drop" = "1" ]; then
      removed=$((removed + 1))
      # The marker above this key goes with it, and so does the empty line above the marker — that
      # pair is what env_append_block wrote. A held blank with no marker over it is the operator's
      # own spacing above a key we happen to be removing, so it stays.
      if [ -n "$marker" ]; then marker=""; blank=0; fi
      continue
    fi
    if [ "$blank" = "1" ]; then
      printf '\n' >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }
      blank=0
    fi
    if [ -n "$marker" ]; then
      printf '%s\n' "$marker" >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }
      marker=""
    fi
    printf '%s\n' "$line" >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }
  done < "$f"
  # A held blank line at EOF is the file's own trailing spacing and is kept; a marker still held
  # sat at EOF above keys we removed — it goes with them.
  if [ "$blank" = "1" ] && [ -z "$marker" ]; then
    printf '\n' >> "$tmp" || { _irises_tmp_fail "$tmp"; return 1; }
  fi
  cat "$tmp" > "$f" || { err "could not write $f — is it writable?"; rm -f "$tmp" 2>/dev/null || true; return 1; }
  rm -f "$tmp" 2>/dev/null || true
  printf '%s' "$removed"
}

# The ONE definition of "a value that is never printed", for every lifecycle script. A key that
# answers 0 here may not travel on argv (configure.sh's --set refuses it: argv is readable by every
# other process on the box and lands in shell history), and a preview prints `<set>` / `<unset>` for
# it instead of the value. Pure `case` globs so it stays callable in a loop over a whole .env
# without forking anything.
#
# API_SERVER_KEY is already caught by *_KEY; it is spelled out because it is the one key the rule is
# written around by name, and a future rename of it must not quietly drop it out of the pattern.
is_secret_key() { # KEY -> 0 when its VALUE must never be printed
  case "${1:-}" in
    *_KEY|*_TOKEN|*_PASSWORD|*_SECRET|API_SERVER_KEY) return 0 ;;
  esac
  return 1
}

# Remove the named keys from a file that has no Irises marker blocks in it. Same work as
# env_remove_irises_block, under the name that describes what a caller on the CLONE's .env is
# actually doing: env_append_block is only ever called on the ENGINE's .env, so $ROOT/.env never
# carries a `# — added by Irises setup` marker, and a caller dropping plain keys from it should not
# have to reason about marker handling it can never hit.
env_unset() { # FILE KEY… -> count of assignments removed (missing file -> 0)
  env_remove_irises_block "$@"
}

# ═══ D. environment preflight ═════════════════════════════════════════════════

# Which OS this is, in the four flavours that change what the lifecycle scripts may call:
#
#   linux    Ubuntu and friends: systemd --user, /proc, pgrep, timeout(1).
#   macos    bash 3.2, launchd, NO timeout(1) and NO setsid.
#   wsl      a real Linux kernel inside Windows — identical to `linux` for everything we do; named
#            separately only so a message can say where the operator actually is.
#   windows  Git Bash (MSYS2 bash + coreutils + curl + cygpath), which Git for Windows ships and the
#            clone therefore already needs. No PowerShell entry point, no new runtime: the same
#            scripts, with Task Scheduler instead of systemd and tasklist/taskkill instead of kill.
#
# Nothing beyond this file needs to know the mechanism; callers ask service_kind and service_installed.
irises_platform() {
  local os
  os="$(uname -s 2>/dev/null || printf unknown)"
  case "$os" in
    Darwin) printf 'macos'; return 0 ;;
    MSYS_NT*|MINGW*|CYGWIN*) printf 'windows'; return 0 ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then printf 'wsl'; else printf 'linux'; fi
      return 0
      ;;
  esac
  printf 'linux'
}

# Five call sites only ever ask "is this Git Bash?", and each one guards a whole Windows-shaped
# branch. One predicate instead of the same string comparison spelled out five times.
_is_windows() { [ "$(irises_platform)" = "windows" ]; }

# A POSIX path in the form Windows itself understands. Every path that crosses out of bash — into a
# launcher .cmd, into a schtasks argument, into a PowerShell string — goes through here first;
# cmd.exe and Task Scheduler have never heard of /c/Users. Without cygpath (WSL2, a stripped MSYS)
# the path is already the right kind and passes through untouched.
win_path() { # PATH
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "${1:-}"
    return 0
  fi
  printf '%s' "${1:-}"
}

# Newest vX.Y.Z directory under $1 whose major is >= 22, printed as <dir>/vX.Y.Z/bin.
# Zero-padded string comparison, not `-gt`: bash's test evaluates `022` as octal.
_irises_newest_node_dir() { # DIR
  local base="${1:-}" name v maj min pat key best="" bestkey=""
  if [ ! -d "${base:-}" ]; then return 0; fi
  for name in "$base"/*; do
    if [ ! -d "$name/bin" ]; then continue; fi
    v="${name##*/}"; v="${v#v}"
    maj="${v%%.*}"
    case "$maj" in ''|*[!0-9]*) continue ;; esac
    if [ "$maj" -lt 22 ]; then continue; fi
    min="${v#*.}"; min="${min%%.*}"; case "$min" in ''|*[!0-9]*) min=0 ;; esac
    pat="${v##*.}";                  case "$pat" in ''|*[!0-9]*) pat=0 ;; esac
    key="$(printf '%05d%05d%05d' "$maj" "$min" "$pat")"
    if [ -z "$bestkey" ] || [ "$key" \> "$bestkey" ]; then bestkey="$key"; best="$name/bin"; fi
  done
  printf '%s' "$best"
}

# APPEND (never prepend) the dirs a node/npm/git might live in, plus the base system dirs. Appending
# is deliberate: a node the operator put on PATH keeps winning. This exists because a non-login shell
# on the production VPS has no node at all — it lives at ~/.local/bin/node -> ~/.hermes/node/bin/node
# — and an agent-spawned install inherits exactly that PATH. The last two entries are the Git Bash
# spellings of the same problem: the Node installer's own directory, and where `npm -g` puts binaries.
augment_path() {
  local d extra="" newest fnm
  for d in \
    "$HOME/.local/bin" \
    "${HERMES_HOME:-$HOME/.hermes}/node/bin" \
    "$HOME/.volta/bin" \
    "$HOME/.bun/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin" \
    "/c/Program Files/nodejs" \
    "${APPDATA:+$APPDATA/npm}"
  do
    if [ -d "$d" ]; then
      case ":$PATH:$extra:" in *":$d:"*) ;; *) extra="$extra:$d" ;; esac
    fi
  done
  newest="$(_irises_newest_node_dir "${NVM_DIR:-$HOME/.nvm}/versions/node")"
  if [ -n "$newest" ]; then
    case ":$PATH:$extra:" in *":$newest:"*) ;; *) extra="$extra:$newest" ;; esac
  fi
  for fnm in \
    "${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin" \
    "$(_irises_newest_node_dir "${FNM_DIR:-$HOME/.local/share/fnm}/node-versions")"
  do
    if [ -n "$fnm" ] && [ -d "$fnm" ]; then
      case ":$PATH:$extra:" in *":$fnm:"*) ;; *) extra="$extra:$fnm" ;; esac
    fi
  done
  for d in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
    if [ -d "$d" ]; then
      case ":$PATH:$extra:" in *":$d:"*) ;; *) extra="$extra:$d" ;; esac
    fi
  done
  PATH="${PATH}${extra}"
  export PATH
  return 0
}

require_tools() { # NAME…
  local t missing=""
  for t in "$@"; do
    if ! command -v "$t" >/dev/null 2>&1; then missing="$missing $t"; fi
  done
  if [ -n "$missing" ]; then
    err "missing required tool(s):$missing"
    err "PATH is: $PATH"
    return 1
  fi
  return 0
}

# A node candidate that satisfies the floor, printed as an absolute path (empty when there is none).
# IRISES_NODE_CANDIDATES (colon-separated absolute paths) replaces the built-in list when set — the
# unit tests use it so a developer's own Homebrew/nvm node cannot satisfy a "too old" scenario.
_irises_find_node() { # FLOOR (e.g. 22.13)
  local floor="${1:-22.13}" fmaj fmin cand v maj min newest list
  fmaj="${floor%%.*}"; fmin="${floor#*.}"
  case "$fmin" in ''|*[!0-9]*) fmin=0 ;; esac
  if [ -n "${IRISES_NODE_CANDIDATES:-}" ]; then
    list="$IRISES_NODE_CANDIDATES"
  else
    newest="$(_irises_newest_node_dir "${NVM_DIR:-$HOME/.nvm}/versions/node")"
    list="$HOME/.local/bin/node:${HERMES_HOME:-$HOME/.hermes}/node/bin/node:${newest:+$newest/node}:$HOME/.volta/bin/node:/opt/homebrew/bin/node:/usr/local/bin/node:/usr/bin/node"
  fi
  local IFS=':'
  for cand in $list; do
    if [ -z "$cand" ] || [ ! -x "$cand" ]; then continue; fi
    v="$("$cand" -p 'process.versions.node' 2>/dev/null || true)"
    maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
    case "$maj" in ''|*[!0-9]*) continue ;; esac
    case "$min" in ''|*[!0-9]*) min=0 ;; esac
    if [ "$maj" -gt "$fmaj" ] || { [ "$maj" -eq "$fmaj" ] && [ "$min" -ge "$fmin" ]; }; then
      printf '%s' "$cand"
      return 0
    fi
  done
  return 0
}

# 22.13 is the floor because Irises's local store uses the builtin node:sqlite, unflagged from 22.13.
require_node_version() { # FLOOR
  local floor="${1:-22.13}" fmaj fmin have maj min cand
  fmaj="${floor%%.*}"; fmin="${floor#*.}"
  case "$fmin" in ''|*[!0-9]*) fmin=0 ;; esac
  have=""
  if command -v node >/dev/null 2>&1; then
    have="$(node -p 'process.versions.node' 2>/dev/null || true)"
  fi
  maj="${have%%.*}"; min="${have#*.}"; min="${min%%.*}"
  case "$maj" in ''|*[!0-9]*) maj=-1 ;; esac
  case "$min" in ''|*[!0-9]*) min=0 ;; esac
  if [ "$maj" -gt "$fmaj" ] || { [ "$maj" -eq "$fmaj" ] && [ "$min" -ge "$fmin" ]; }; then
    return 0
  fi
  cand="$(_irises_find_node "$floor")"
  if [ -n "$cand" ]; then
    warn "node on PATH is ${have:-absent}; using $cand instead (its dir goes first on PATH)"
    PATH="$(dirname "$cand"):$PATH"
    export PATH
    return 0
  fi
  err "Node $floor+ required (found ${have:-none}) — the local store uses node:sqlite, unflagged from 22.13"
  err "install it, or put a newer node on PATH, then re-run"
  return 1
}

# Time-box a command. Prefers timeout(1), then gtimeout, else a pure-bash watchdog — macOS ships
# NEITHER, which is why engine-setup.sh's `timeout 90 … gateway …` silently failed on every Mac.
# A shell FUNCTION always takes the bash path: an external timeout cannot exec one.
portable_timeout() { # SECS CMD…
  local secs="${1:-30}" rc=0
  shift || true
  if [ "$#" -eq 0 ]; then return 2; fi
  if [ -z "${IRISES_FORCE_TIMEOUT_FALLBACK:-}" ] && [ "$(type -t "$1" 2>/dev/null || true)" != "function" ]; then
    if command -v timeout >/dev/null 2>&1; then
      timeout "$secs" "$@" || rc=$?
      return "$rc"
    fi
    if command -v gtimeout >/dev/null 2>&1; then
      gtimeout "$secs" "$@" || rc=$?
      return "$rc"
    fi
  fi
  local cmd_pid watch_pid
  "$@" &
  cmd_pid=$!
  (
    i=0
    while [ "$i" -lt "$secs" ]; do
      if ! kill -0 "$cmd_pid" 2>/dev/null; then exit 0; fi
      sleep 1
      i=$((i + 1))
    done
    kill -TERM "$cmd_pid" 2>/dev/null || true
    sleep 2
    kill -KILL "$cmd_pid" 2>/dev/null || true
  ) &
  watch_pid=$!
  wait "$cmd_pid" 2>/dev/null || rc=$?
  kill "$watch_pid" 2>/dev/null || true
  wait "$watch_pid" 2>/dev/null || true
  # 143 = SIGTERM, 137 = SIGKILL: our watchdog fired. Report it the way timeout(1) does.
  case "$rc" in 143|137) rc=124 ;; esac
  return "$rc"
}

# Free memory in MB (Linux only — macOS has no single honest number, so callers treat empty as
# "unknown" and skip the gate).
mem_available_mb() {
  local kb
  if [ -r /proc/meminfo ]; then
    kb="$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true)"
    case "${kb:-}" in
      ''|*[!0-9]*) return 0 ;;
      *) printf '%s' "$((kb / 1024))"; return 0 ;;
    esac
  fi
  return 0
}

# Is anything listening on HOST:PORT? bash's /dev/tcp first (no external tool), then — on Git Bash —
# PowerShell, then nc, then lsof.
tcp_open() { # HOST PORT
  local h="${1:-127.0.0.1}" p="${2:-}"
  if [ -z "$p" ]; then return 1; fi
  if (exec 3<>"/dev/tcp/$h/$p") 2>/dev/null; then return 0; fi
  if _is_windows; then
    # Git Bash has /dev/tcp, but neither nc nor lsof, so there is nothing under it. TcpClient is in
    # every .NET on the box. The escaped $c is a PowerShell variable, not a bash one.
    if powershell.exe -NoProfile -NonInteractive -Command \
      "\$c=New-Object Net.Sockets.TcpClient; try { \$c.Connect('$h',$p); exit 0 } catch { exit 1 }" \
      >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi
  if command -v nc >/dev/null 2>&1; then
    if nc -z -w 2 "$h" "$p" >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP@"$h":"$p" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  return 1
}

# ═══ E. engines: detection, gateway lifecycle, bridge plugin, web build ═══════
#
# A NOTE ON THE STRINGS IN THIS SECTION. hermes ships a lifecycle guard
# (cron/lifecycle_guard.py) that blocks a terminal command matching e.g. `hermes gateway
# <bounce-verb>` or `systemctl … <bounce-verb> … hermes-gateway`, AND it recursively reads the
# CONTENTS of any shell script the command references (including ones it sources, to depth 8). So
# if a user ever pastes one of our commands into a hermes chat, a literal of that shape ANYWHERE in
# these files — code or comment — gets the whole thing refused. Every verb and unit name below is
# therefore assembled at runtime from fragments. It costs two lines and buys an install that works
# from inside a chat as well as from a shell. `reload` is deliberately not blocked upstream, which
# is why the systemd fallback uses it: the unit's ExecReload sends SIGUSR1, hermes's own
# drain-aware in-band bounce.

hermes_home() {
  local h="${HERMES_HOME:-$HOME/.hermes}"
  case "$h" in
    "~")   h="$HOME" ;;
    "~/"*) h="$HOME/${h#\~/}" ;;
  esac
  printf '%s' "$h"
}

# OpenClaw profiles can relocate the whole state dir; honour the override, else ~/.openclaw.
openclaw_home() {
  local h="${OPENCLAW_STATE_DIR:-${CLAWDBOT_STATE_DIR:-$HOME/.openclaw}}"
  case "$h" in
    "~")   h="$HOME" ;;
    "~/"*) h="$HOME/${h#\~/}" ;;
  esac
  printf '%s' "$h"
}

# Which engine this clone talks to: an explicit override, else OPS_BACKEND from the clone's .env
# (then app.env, then the shell), else whatever is actually installed. `off` = standalone.
engine_kind() { # [OVERRIDE]
  local override="${1:-}" root v
  case "$override" in
    hermes|openclaw|off) printf '%s' "$override"; return 0 ;;
    '') ;;
    *) err "unknown engine '$override' (hermes|openclaw|off)"; return 1 ;;
  esac
  root="$(irises_root)"
  v="$(env_get "$root/.env" OPS_BACKEND)"
  if [ -z "$v" ]; then v="$(env_get "$root/deploy/app.env" OPS_BACKEND)"; fi
  if [ -z "$v" ]; then v="${OPS_BACKEND:-}"; fi
  case "$v" in
    hermes|openclaw|off) printf '%s' "$v"; return 0 ;;
    '') ;;
    *) warn "OPS_BACKEND='$v' is not hermes|openclaw|off — treating this install as engine-less"
       printf 'off'; return 0 ;;
  esac
  if [ -d "$(hermes_home)" ]; then printf 'hermes'; return 0; fi
  if command -v openclaw >/dev/null 2>&1; then printf 'openclaw'; return 0; fi
  printf 'off'
}

# The hermes CLI as a DISPLAY string (for logs and for "is it there?" checks). Never word-split it —
# call hermes_run instead, which handles the argv and the environment.
hermes_cli() {
  local hhome; hhome="$(hermes_home)"
  if command -v hermes >/dev/null 2>&1; then command -v hermes; return 0; fi
  if [ -x "$HOME/.local/bin/hermes" ]; then printf '%s' "$HOME/.local/bin/hermes"; return 0; fi
  if [ -x "$hhome/hermes-agent/hermes" ]; then printf '%s' "$hhome/hermes-agent/hermes"; return 0; fi
  if [ -x "$hhome/hermes-agent/venv/bin/python" ]; then
    printf '%s -m hermes_cli.main' "$hhome/hermes-agent/venv/bin/python"
    return 0
  fi
  return 0
}

# Invoke the hermes CLI. Three things every caller would otherwise have to remember:
#   • `_HERMES_GATEWAY=1` is inherited by anything the gateway spawns, and the CLI REFUSES gateway
#     lifecycle work (exit 1) when it sees it — so it is always unset here.
#   • $IRISES_HERMES_ENV carries extra KEY=VALUE settings (whitespace-separated, values with no
#     spaces — ours are all integers); it is intentionally unquoted so it word-splits.
#   • STDIN IS /dev/null. Every call here is made from a script whose output is being read by
#     someone else (a log, a pipe, an SSH session that may already be gone), so a CLI that decides
#     to ask something — capability consent for a plugin it does not consider bundled is the real
#     case — would sit on an invisible prompt forever, holding the lifecycle lock. With stdin
#     closed it gets EOF, gives up, and returns a code the caller can report.
hermes_run() { # ARGS…
  local hhome; hhome="$(hermes_home)"
  if command -v hermes >/dev/null 2>&1; then
    set -- "$(command -v hermes)" "$@"
  elif [ -x "$HOME/.local/bin/hermes" ]; then
    set -- "$HOME/.local/bin/hermes" "$@"
  elif [ -x "$hhome/hermes-agent/hermes" ]; then
    set -- "$hhome/hermes-agent/hermes" "$@"
  elif [ -x "$hhome/hermes-agent/venv/bin/python" ]; then
    set -- "$hhome/hermes-agent/venv/bin/python" -m hermes_cli.main "$@"
  else
    return 127
  fi
  local rc=0
  # shellcheck disable=SC2086  # IRISES_HERMES_ENV must split into separate assignments
  env -u _HERMES_GATEWAY ${IRISES_HERMES_ENV:-} "$@" </dev/null || rc=$?
  return "$rc"
}

# Does the engine's own health surface answer RIGHT NOW? Taken BEFORE a bounce as the baseline:
# `hermes gateway status` exits 0 even when the gateway is down, and /v1/health only exists while
# API_SERVER_ENABLED=true — so a gateway with the API server off must not be reported as failed.
_gateway_http_ok() { # ENGINE
  local engine="${1:-}" root base host port
  root="$(irises_root)"
  if [ "$engine" = "hermes" ]; then
    base="$(env_get "$root/.env" HERMES_BASE_URL)"
    if [ -z "$base" ]; then base="http://127.0.0.1:8642"; fi
    # /v1/health takes no auth (gateway/platforms/api_server.py: _handle_health has no auth check).
    if curl -fsS -m 5 "$base/v1/health" >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  base="$(env_get "$root/.env" OPENCLAW_URL)"
  if [ -z "$base" ]; then base="ws://127.0.0.1:18789"; fi
  host="${base#*://}"; host="${host%%/*}"
  port="${host##*:}"; host="${host%%:*}"
  case "$port" in ''|*[!0-9]*) port=18789 ;; esac
  if [ -z "$host" ]; then host=127.0.0.1; fi
  tcp_open "$host" "$port"
}

# hermes only: is the gateway's SERVICE up? Used when HTTP was not answering before the bounce.
# On Windows both engines' gateways are Task Scheduler tasks that only their own CLI knows how to
# drive, so the CLI IS the bounce path there: these service-manager fallbacks find no systemctl and
# no launchctl, return 1, and the CLI branch above has already done the work.
_gateway_service_up() {
  local unit label uid state
  unit="hermes-gateway"
  label="ai.hermes.gateway"
  if command -v systemctl >/dev/null 2>&1; then
    # Through _systemctl_user, like the bounce below: a bare `systemctl --user` in a session with no
    # bus address fails on CONNECT, so a perfectly live gateway reads as down and the caller reports
    # an unverified bounce.
    state="$(_systemctl_user is-active "$unit" 2>/dev/null || true)"
    if [ "$state" = "active" ]; then return 0; fi
  fi
  if command -v launchctl >/dev/null 2>&1; then
    uid="$(id -u)"
    if launchctl print "gui/$uid/$label" 2>/dev/null | grep -q 'state = running'; then return 0; fi
  fi
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -f 'gateway[.]run|hermes_cli[.]main .*gateway' >/dev/null 2>&1; then return 0; fi
  fi
  return 1
}

gateway_probe_mode() { # ENGINE -> http|service
  if _gateway_http_ok "${1:-}"; then printf 'http'; else printf 'service'; fi
}

gateway_wait_healthy() { # ENGINE SECS MODE(http|service)
  local engine="${1:-}" secs="${2:-90}" mode="${3:-http}" i=0
  while [ "$i" -lt "$secs" ]; do
    if [ "$mode" = "http" ]; then
      if _gateway_http_ok "$engine"; then return 0; fi
    else
      if [ "$engine" = "hermes" ]; then
        if _gateway_service_up; then return 0; fi
      else
        if _gateway_http_ok "$engine"; then return 0; fi
      fi
    fi
    sleep 2
    i=$((i + 2))
  done
  return 1
}

_gateway_bounce_hermes_service() { # VERB
  local verb="${1:-}" unit label uid soft
  unit="hermes-gateway"
  label="ai.hermes.gateway"
  soft="re"; soft="${soft}load"
  if command -v systemctl >/dev/null 2>&1; then
    # ExecReload = kill -USR1 = hermes's own drain-aware in-band bounce (and the soft verb is not on
    # the upstream block list, so it survives a paste into a chat). Through _systemctl_user, because
    # a bare `systemctl --user` in a session with no bus address fails on connect, not on the verb.
    if _systemctl_user "$soft" "$unit" >/dev/null 2>&1; then return 0; fi
    if _systemctl_user "$verb" "$unit" >/dev/null 2>&1; then return 0; fi
  fi
  if command -v launchctl >/dev/null 2>&1; then
    uid="$(id -u)"
    if launchctl kickstart -k "gui/$uid/$label" >/dev/null 2>&1; then return 0; fi
  fi
  return 1
}

# Bounce the engine's gateway and VERIFY it came back. Returns 1 on an unverified bounce — the
# caller reports that with its own exit code, because Irises itself may be perfectly updated.
# Worst case wall time: 100s for the CLI call (its own budget is 45+10+15) plus SECS of verification.
gateway_restart() { # [ENGINE] [SECS]
  local engine="${1:-}" secs="${2:-90}" verb mode t0 t1
  if [ -z "$engine" ]; then engine="$(engine_kind)"; fi
  case "$engine" in
    off|'') say "engine is off — no gateway to bounce"; return 0 ;;
  esac
  verb="re"; verb="${verb}start"
  mode="$(gateway_probe_mode "$engine")"
  t0="$(date +%s)"
  if [ "$engine" = "hermes" ]; then
    if [ -n "$(hermes_cli)" ]; then
      say "bouncing the hermes gateway through its own CLI (in-flight turns get 45s, drain 10s)"
      local IRISES_HERMES_ENV="HERMES_RESTART_AFTER_TURN_TIMEOUT=45 HERMES_RESTART_DRAIN_TIMEOUT=10"
      if ! portable_timeout 100 hermes_run gateway "$verb" >/dev/null 2>&1; then
        warn "the hermes CLI could not bounce the gateway — trying the service manager"
        _gateway_bounce_hermes_service "$verb" || true
      fi
    else
      warn "no hermes CLI on this box — trying the service manager"
      _gateway_bounce_hermes_service "$verb" || true
    fi
  else
    if command -v openclaw >/dev/null 2>&1; then
      say "bouncing the OpenClaw gateway (openclaw gateway $verb)"
      if ! portable_timeout 100 openclaw gateway "$verb" >/dev/null 2>&1; then
        warn "openclaw could not bounce its gateway — do it yourself: openclaw gateway $verb"
      fi
    else
      warn "no openclaw CLI on this box — bounce the gateway yourself: openclaw gateway $verb"
    fi
  fi
  if gateway_wait_healthy "$engine" "$secs" "$mode"; then
    t1="$(date +%s)"
    if [ "$mode" = "http" ]; then
      say "gateway is back — verified in $((t1 - t0))s"
    else
      say "gateway is back — verified in $((t1 - t0))s by service state (its HTTP health surface is off)"
    fi
    say "the engine posts its own '♻️ Gateway online' note to your home channel on a planned bounce"
    say "(silence it per platform with <platform>.gateway_restart_notification: false in the engine config)"
    return 0
  fi
  warn "the gateway did not come back within ${secs}s — Irises itself is unaffected"
  warn "check it yourself, then bounce it by hand once the reason is clear"
  return 1
}

# Refresh the bridge plugin from this clone. ALWAYS run on install and update: the plugin is a COPY,
# a lifecycle action bounces the gateway anyway, and plugins load only at gateway start.
# How long the engine CLI gets for a plugins enable/disable before it is treated as hung. The two
# calls are one config edit each and answer in under a second; the budget exists for the case where
# the CLI decides to ask a question nobody can see. $IRISES_PLUGIN_CLI_TIMEOUT is a test hook.
_plugin_cli_secs() { printf '%s' "${IRISES_PLUGIN_CLI_TIMEOUT:-60}"; }

plugin_refresh() { # ENGINE [ROOT]
  local engine="${1:-}" root="${2:-}" pdir ext rc secs
  if [ -z "$root" ]; then root="$(irises_root)"; fi
  case "$engine" in
    hermes)
      pdir="$(hermes_home)/plugins"
      if [ ! -d "$root/bridge/hermes/irises-bridge" ]; then
        warn "no bridge/hermes/irises-bridge in $root — skipping the plugin refresh"
        return 1
      fi
      mkdir -p "$pdir" || { err "could not create $pdir — is $(hermes_home) writable?"; return 1; }
      rm -rf "$pdir/irises-bridge" || { err "could not clear $pdir/irises-bridge — is $pdir writable?"; return 1; }
      cp -R "$root/bridge/hermes/irises-bridge" "$pdir/irises-bridge" || {
        err "could not copy the bridge plugin into $pdir — is it writable, and is there room on the disk?"
        return 1
      }
      find "$pdir/irises-bridge" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
      say "refreshed $pdir/irises-bridge (from this clone, minus __pycache__)"
      if [ -n "$(hermes_cli)" ]; then
        # Time-boxed, and hermes_run has already closed its stdin: a CLI that stops to ask for
        # consent must cost this run a warning, never the rest of the update.
        secs="$(_plugin_cli_secs)"
        rc=0
        portable_timeout "$secs" hermes_run plugins enable irises-bridge >/dev/null 2>&1 || rc=$?
        if [ "$rc" = "0" ]; then
          say "irises-bridge is enabled in the engine's config"
        elif [ "$rc" = "124" ]; then
          warn "the hermes CLI did not answer within ${secs}s (waiting on a prompt nobody can see?)"
          warn "enable it yourself once it does: hermes plugins enable irises-bridge"
        else
          warn "could not enable it through the CLI — run: hermes plugins enable irises-bridge"
        fi
      else
        warn "no hermes CLI here — enable it yourself: hermes plugins enable irises-bridge"
      fi
      return 0
      ;;
    openclaw)
      ext="$(openclaw_home)/extensions"
      if [ ! -d "$root/bridge/openclaw/irises-bridge" ]; then
        warn "no bridge/openclaw/irises-bridge in $root — skipping the plugin refresh"
        return 1
      fi
      mkdir -p "$ext" || { err "could not create $ext — is $(openclaw_home) writable?"; return 1; }
      # `openclaw plugins install` COPIES and REFUSES an existing target ("plugin already exists …
      # delete it first"), so clearing the way is the only way a refresh can succeed.
      rm -rf "$ext/irises-bridge" || { err "could not clear $ext/irises-bridge — is $ext writable?"; return 1; }
      if command -v openclaw >/dev/null 2>&1; then
        if openclaw plugins install "$root/bridge/openclaw/irises-bridge" >/dev/null 2>&1; then
          say "installed irises-bridge into $ext/irises-bridge"
          return 0
        fi
        warn "openclaw plugins install failed — run it yourself:"
        warn "  openclaw plugins install $root/bridge/openclaw/irises-bridge"
        return 1
      fi
      warn "no openclaw CLI here — install it yourself:"
      warn "  openclaw plugins install $root/bridge/openclaw/irises-bridge"
      return 1
      ;;
  esac
  return 0
}

# Take the plugin off the engine: disable it in config (so a stale entry can't warn at every start),
# then delete the copy. OpenClaw has NO `plugins uninstall` — removal IS disable + rm.
plugin_remove() { # ENGINE
  local engine="${1:-}" pdir ext rc secs
  case "$engine" in
    hermes)
      pdir="$(hermes_home)/plugins"
      if [ -n "$(hermes_cli)" ]; then
        secs="$(_plugin_cli_secs)"
        rc=0
        portable_timeout "$secs" hermes_run plugins disable irises-bridge >/dev/null 2>&1 || rc=$?
        if [ "$rc" = "0" ]; then
          say "disabled irises-bridge in the engine's config"
        elif [ "$rc" = "124" ]; then
          warn "the hermes CLI did not answer within ${secs}s — remove 'irises-bridge' from plugins.enabled yourself"
        else
          warn "could not disable it through the CLI — remove 'irises-bridge' from plugins.enabled yourself"
        fi
      else
        warn "no hermes CLI here — remove 'irises-bridge' from plugins.enabled yourself"
      fi
      if [ -d "$pdir/irises-bridge" ]; then
        rm -rf "$pdir/irises-bridge"
        say "removed $pdir/irises-bridge"
      fi
      return 0
      ;;
    openclaw)
      ext="$(openclaw_home)/extensions"
      if command -v openclaw >/dev/null 2>&1; then
        openclaw plugins disable irises-bridge >/dev/null 2>&1 || warn "could not disable irises-bridge through the CLI"
      fi
      if [ -d "$ext/irises-bridge" ]; then
        rm -rf "$ext/irises-bridge"
        say "removed $ext/irises-bridge"
      fi
      return 0
      ;;
  esac
  return 0
}

# The web client — a SEPARATE npm project with a heavy toolchain, and the ONE step allowed to fail.
# Policy: build it only where it is already in use (web/out exists) or on request (IRISES_WEB=1),
# never under 1500 MB of free memory. On the 408 MB VPS `next build` took a bus error mid-build and,
# under `set -e`, aborted the whole update — server updated on disk, never restarted, no receipt.
# `npm --prefix web ci` (not `install`) because install rewrites web/package-lock.json, which then
# trips the updater's own dirty-tree preflight on the next run.
web_build() { # [ROOT] — always returns 0
  local root="${1:-}" mb
  if [ -z "$root" ]; then root="$(irises_root)"; fi
  if [ "${IRISES_SKIP_WEB_BUILD:-}" = "1" ]; then
    say "IRISES_SKIP_WEB_BUILD=1 — skipping the web client build"
    return 0
  fi
  if [ ! -d "$root/web" ]; then return 0; fi
  if [ ! -d "$root/web/out" ] && [ "${IRISES_WEB:-}" != "1" ]; then
    say "web UI not built here — skipping (opt in with IRISES_WEB=1; the terminal chat needs nothing)"
    return 0
  fi
  mb="$(mem_available_mb)"
  if [ -n "$mb" ] && [ "$mb" -lt 1500 ]; then
    warn "only ${mb} MB free — skipping the web build (next build wants ~1 GB and dies mid-way below that)"
    warn "build it when the box has room:  npm --prefix web ci && npm run build:web"
    return 0
  fi
  say "building the web client (npm --prefix web ci && npm run build:web)"
  if npm --prefix "$root/web" ci && ( cd "$root" && npm run build:web ); then
    say "web client built"
    return 0
  fi
  warn "web client build failed — the server half is fine; the browser page is not rebuilt"
  warn "retry when the box has room:  npm --prefix web ci && npm run build:web   (or set IRISES_SKIP_WEB_BUILD=1)"
  return 0
}

# ═══ F. the Irises server: service, process, health, manifest, lock, summary ══
#
# Irises installs as a USER-LEVEL service by default — systemd --user on Linux (with linger, or it
# dies at logout), a LaunchAgent on macOS — because a `nohup` server does not survive a reboot and
# nothing else on the box knows how to bring it back. `--no-service` falls back to the detached
# launch, and then $IRISES_HOME/irises.pid (written by the server itself, src/update/pidfile.ts) is
# the only handle anyone has.

service_name()  { printf 'irises'; }
service_label() { printf 'ai.irises.server'; }
service_unit_path()  { printf '%s/.config/systemd/user/%s.service' "$HOME" "$(service_name)"; }
service_plist_path() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(service_label)"; }

# Windows: the Task Scheduler task name, the launcher it runs, and the XML the task is registered
# from. schtasks cannot redirect output and cannot set environment variables, so the task's whole
# action is "run this one .cmd", and the .cmd does the env, the cd and the >> redirect. Same
# mechanism hermes uses for its own gateway, XML definition included.
service_task_name()     { printf 'Irises'; }
service_launcher_path() { printf '%s/irises-start.cmd' "$(irises_home)"; }
service_task_xml_path() { printf '%s/irises-task.xml' "$(irises_home)"; }

# The three characters that cannot appear raw in XML character data. A Windows path can legally hold
# an `&` (C:\Users\R&D\…), which would otherwise make the task definition unparseable.
_xml_escape() { # TEXT
  local s="${1:-}"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

# One systemd unit ARGUMENT, ready to paste after `ExecStart=`. systemd splits that line on
# whitespace, so an unquoted path under `/home/alice/My Projects/Irises` became three arguments and
# the service never started — the same class of bug as the XML one above, on the other platform.
# `%` is a specifier to systemd (`%h`, `%i`, `%%`) and doubles inside any unit value; `\` and `"`
# need escaping only inside the quotes this adds.
_systemd_quote() { # TEXT -> "escaped"
  printf '"%s"' "$(_systemd_escape "${1:-}")"
}

# The escaping alone, for a value that supplies its OWN quotes (Environment="K=V") or that systemd
# reads as the whole rest of the line (WorkingDirectory=, StandardOutput=append:…), where the % rule
# still applies but the wrapping must not run twice.
_systemd_escape() { # TEXT
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//%/%%}"
  printf '%s' "$s"
}

_irises_xdg() { printf '%s' "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; }

# systemd needs systemctl AND a user bus to talk to (a fresh SSH session with linger off has
# neither, and `systemctl --user` there fails with "Failed to connect to bus"). launchd needs
# launchctl and Darwin. Windows needs schtasks, which Git Bash exposes as `schtasks`. WSL2 is Linux
# and takes the systemd branch. Anything else → none, and the caller uses the detached fallback.
service_kind() {
  local xdg
  case "$(irises_platform)" in
    macos)
      if command -v launchctl >/dev/null 2>&1; then printf 'launchd'; return 0; fi
      ;;
    windows)
      if command -v schtasks >/dev/null 2>&1; then printf 'schtasks'; return 0; fi
      ;;
    linux|wsl)
      if command -v systemctl >/dev/null 2>&1; then
        xdg="$(_irises_xdg)"
        if [ -S "$xdg/bus" ] || [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
          printf 'systemd'
          return 0
        fi
      fi
      ;;
  esac
  printf 'none'
}

# Is Irises installed as a service AT ALL, whichever backend this box gave us? The installer and the
# updater ask this instead of testing the unit and the plist themselves — a two-file check silently
# reports "not installed" on Windows, where the install is a Task Scheduler entry and no file.
service_installed() {
  if [ -f "$(service_unit_path)" ] || [ -f "$(service_plist_path)" ]; then return 0; fi
  if command -v schtasks >/dev/null 2>&1 && schtasks //Query //TN "$(service_task_name)" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

_systemctl_user() { # ARGS…
  local rc=0
  XDG_RUNTIME_DIR="$(_irises_xdg)" systemctl --user "$@" || rc=$?
  return "$rc"
}

# A service PATH built like the engine's own: the node we resolved first, then the user-local dirs,
# then the base system dirs. A unit inherits almost nothing, so this list is the whole world it sees.
_service_path() { # NODE_BIN
  local node="${1:-}" p d
  p="$(dirname "$node")"
  for d in "$HOME/.local/bin" "${HERMES_HOME:-$HOME/.hermes}/node/bin" /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
    case ":$p:" in *":$d:"*) ;; *) p="$p:$d" ;; esac
  done
  printf '%s' "$p"
}

# NODE_OPTIONS from the clone's config, applied where it actually works. deploy/app.env's
# `NODE_OPTIONS=--max-old-space-size=512` is loaded by dotenv AFTER V8 has already sized its heap,
# so on a 1 GB box that documented cap has never once taken effect. In the unit it does.
_service_node_options() { # ROOT
  local root="${1:-}" v
  v="$(env_get "$root/.env" NODE_OPTIONS)"
  if [ -z "$v" ]; then v="$(env_get "$root/deploy/app.env" NODE_OPTIONS)"; fi
  printf '%s' "$v"
}

# Prints ONLY the unit/plist path on stdout — callers capture it. Everything else goes through log/warn.
service_install() { # ROOT NODE_BIN
  local root="${1:-}" node="${2:-}" kind home logs unit plist path opts uid launcher xml xmlwin
  if [ -z "$root" ] || [ -z "$node" ]; then err "service_install needs ROOT and an absolute NODE_BIN"; return 1; fi
  # A unit, a plist and a Task Scheduler action all inherit essentially no PATH, so a relative
  # `node` resolves to nothing at boot. (On Git Bash an absolute path starts with `/` too —
  # /c/Program Files/nodejs/node — and win_path converts it for the launcher.)
  case "$node" in
    /*) ;;
    *) err "service_install needs an ABSOLUTE NODE_BIN — got '$node', which a service cannot resolve"; return 1 ;;
  esac
  kind="$(service_kind)"
  home="$(irises_home)"
  logs="$home/logs"
  mkdir -p "$logs" || { err "could not create $logs — is $home writable?"; return 1; }
  path="$(_service_path "$node")"
  opts="$(_service_node_options "$root")"
  case "$kind" in
    systemd)
      unit="$(service_unit_path)"
      mkdir -p "$(dirname "$unit")" || { err "could not create $(dirname "$unit") — is \$HOME writable?"; return 1; }
      {
        printf '[Unit]\n'
        printf 'Description=Irises — private companion server\n'
        printf 'After=network-online.target\n'
        printf 'Wants=network-online.target\n'
        printf 'StartLimitIntervalSec=0\n'
        printf '\n[Service]\n'
        printf 'Type=simple\n'
        printf 'ExecStart=%s %s\n' "$(_systemd_quote "$node")" "$(_systemd_quote "$root/dist/index.js")"
        printf 'WorkingDirectory=%s\n' "$(_systemd_escape "$root")"
        printf 'Environment="PATH=%s"\n' "$(_systemd_escape "$path")"
        printf 'Environment="IRISES_HOME=%s"\n' "$(_systemd_escape "$home")"
        if [ -n "$opts" ]; then printf 'Environment="NODE_OPTIONS=%s"\n' "$(_systemd_escape "$opts")"; fi
        printf 'Restart=on-failure\n'
        printf 'RestartSec=5\n'
        printf 'KillSignal=SIGTERM\n'
        printf 'TimeoutStopSec=30\n'
        # append: needs systemd 240+ (Ubuntu 20.04+). On anything older systemd refuses to load the
        # unit; swap both lines for `journal` and read it with: journalctl --user -u irises -f
        printf 'StandardOutput=append:%s/server.log\n' "$(_systemd_escape "$logs")"
        printf 'StandardError=append:%s/server.log\n' "$(_systemd_escape "$logs")"
        printf '\n[Install]\n'
        printf 'WantedBy=default.target\n'
      } > "$unit" || { err "could not write $unit — is it writable, and is there room on the disk?"; return 1; }
      log "wrote $unit"
      _systemctl_user daemon-reload || { err "systemctl --user daemon-reload failed"; return 1; }
      _systemctl_user enable "$(service_name)" >/dev/null 2>&1 || warn "could not enable the unit (it will still start now)"
      # Without linger a user unit is killed at logout and never comes back after a reboot.
      if command -v loginctl >/dev/null 2>&1; then
        if ! loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
          warn "could not enable linger — Irises will stop when you log out."
          warn "ask an admin for:  sudo loginctl enable-linger $(id -un)"
        fi
      else
        warn "no loginctl here — if Irises stops at logout, that is why"
      fi
      printf '%s' "$unit"
      return 0
      ;;
    launchd)
      plist="$(service_plist_path)"
      uid="$(id -u)"
      mkdir -p "$(dirname "$plist")" || { err "could not create $(dirname "$plist") — is \$HOME writable?"; return 1; }
      {
        printf '<?xml version="1.0" encoding="UTF-8"?>\n'
        printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        printf '<plist version="1.0">\n<dict>\n'
        printf '    <key>Label</key>\n    <string>%s</string>\n' "$(service_label)"
        printf '    <key>ProgramArguments</key>\n    <array>\n'
        printf '        <string>%s</string>\n' "$(_xml_escape "$node")"
        printf '        <string>%s</string>\n' "$(_xml_escape "$root/dist/index.js")"
        printf '    </array>\n'
        printf '    <key>WorkingDirectory</key>\n    <string>%s</string>\n' "$(_xml_escape "$root")"
        printf '    <key>EnvironmentVariables</key>\n    <dict>\n'
        printf '        <key>PATH</key>\n        <string>%s</string>\n' "$(_xml_escape "$path")"
        printf '        <key>IRISES_HOME</key>\n        <string>%s</string>\n' "$(_xml_escape "$home")"
        if [ -n "$opts" ]; then printf '        <key>NODE_OPTIONS</key>\n        <string>%s</string>\n' "$(_xml_escape "$opts")"; fi
        printf '    </dict>\n'
        printf '    <key>RunAtLoad</key>\n    <true/>\n'
        # KeepAlive as a dict, NOT `true`: a bare true relaunches the server the moment we stop it
        # on purpose, so `service_stop` could never actually stop anything.
        printf '    <key>KeepAlive</key>\n    <dict>\n        <key>SuccessfulExit</key>\n        <false/>\n    </dict>\n'
        printf '    <key>ThrottleInterval</key>\n    <integer>10</integer>\n'
        printf '    <key>ExitTimeOut</key>\n    <integer>30</integer>\n'
        printf '    <key>StandardOutPath</key>\n    <string>%s/server.log</string>\n' "$(_xml_escape "$logs")"
        printf '    <key>StandardErrorPath</key>\n    <string>%s/server.log</string>\n' "$(_xml_escape "$logs")"
        printf '</dict>\n</plist>\n'
      } > "$plist" || { err "could not write $plist — is it writable, and is there room on the disk?"; return 1; }
      log "wrote $plist"
      # Bootstrapping a label that is already loaded fails with EIO; boot it out first so a re-run
      # is a genuine reinstall rather than a no-op.
      launchctl bootout "gui/$uid/$(service_label)" >/dev/null 2>&1 || true
      if ! launchctl bootstrap "gui/$uid" "$plist" >/dev/null 2>&1; then
        err "launchctl bootstrap gui/$uid failed — load it yourself: launchctl bootstrap gui/$uid $plist"
        return 1
      fi
      printf '%s' "$plist"
      return 0
      ;;
    schtasks)
      launcher="$(service_launcher_path)"
      # CRLF throughout. cmd.exe reads a lone LF as part of the token on some builds, which turns
      # `set "IRISES_HOME=…"` into a variable whose value ends in a stray character — and every
      # launcher Windows writes for itself is CRLF, so this is also the shape an operator expects.
      {
        printf '@echo off\r\n'
        # ASCII only in this file: cmd.exe reads it under whatever the machine's OEM codepage is.
        printf 'rem Irises - private companion server. Written by service_install; edits are lost on update.\r\n'
        printf 'set "IRISES_HOME=%s"\r\n' "$(win_path "$home")"
        if [ -n "$opts" ]; then printf 'set "NODE_OPTIONS=%s"\r\n' "$opts"; fi
        printf 'set "PATH=%s;%%PATH%%"\r\n' "$(win_path "$(dirname "$node")")"
        printf 'cd /d "%s"\r\n' "$(win_path "$root")"
        printf '"%s" "%s" >> "%s" 2>&1\r\n' \
          "$(win_path "$node")" "$(win_path "$root/dist/index.js")" "$(win_path "$logs/server.log")"
      } > "$launcher" || { err "could not write $launcher — is $home writable?"; return 1; }
      log "wrote $launcher"
      # WHY AN XML DEFINITION AND NOT `//SC ONLOGON //RL LIMITED`. The flag form cannot express
      # restart-on-failure, so a crashed Irises on Windows stayed down until the next logon, while
      # systemd (Restart=on-failure) and launchd (KeepAlive) bring it straight back. XML is the only
      # way in through schtasks, and it also carries the other two settings the flags cannot reach:
      #   ExecutionTimeLimit PT0S — Task Scheduler's DEFAULT is three days, after which it would
      #                             kill a perfectly healthy long-running server;
      #   Hidden true             — keeps the task out of the default Task Scheduler listing.
      # Same shape hermes registers its own gateway with. The action is still the launcher .cmd, so
      # cmd.exe still allocates a console: a brief console flash at logon is the known cosmetic cost.
      # Element order matters — schtasks validates Settings against the schema sequence, so this is
      # the order Task Scheduler's own export uses, not the order the settings are described above.
      #
      # ENCODING. hermes writes its own task XML as UTF-16 (hermes_cli/gateway_windows.py,
      # _write_scheduled_task_xml: encoding="utf-16"), and it is not being fussy — some Windows
      # builds reject a task definition that is not Unicode with the unhelpful "The task XML is
      # malformed". bash cannot emit UTF-16, so the file is written UTF-8 here and converted in
      # place below by the PowerShell this arm already depends on. The declaration says UTF-16 from
      # the start: the file the parser eventually reads IS UTF-16, and a declaration that disagrees
      # with the byte stream is its own malformed-XML error.
      xml="$(service_task_xml_path)"
      {
        printf '<?xml version="1.0" encoding="UTF-16"?>\n'
        printf '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n'
        printf '  <RegistrationInfo>\n'
        printf '    <Description>Irises - private companion server</Description>\n'
        printf '  </RegistrationInfo>\n'
        printf '  <Triggers>\n'
        printf '    <LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>\n'
        printf '  </Triggers>\n'
        printf '  <Principals>\n'
        printf '    <Principal id="Author">\n'
        # InteractiveToken + LeastPrivilege = runs as the user who installed it, at their logon,
        # with no elevation prompt. The flag form spelled this //RL LIMITED.
        printf '      <LogonType>InteractiveToken</LogonType>\n'
        printf '      <RunLevel>LeastPrivilege</RunLevel>\n'
        printf '    </Principal>\n'
        printf '  </Principals>\n'
        printf '  <Settings>\n'
        printf '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n'
        printf '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n'
        printf '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n'
        printf '    <AllowHardTerminate>true</AllowHardTerminate>\n'
        printf '    <StartWhenAvailable>true</StartWhenAvailable>\n'
        printf '    <Enabled>true</Enabled>\n'
        printf '    <Hidden>true</Hidden>\n'
        printf '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n'
        printf '    <RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>3</Count>\n    </RestartOnFailure>\n'
        printf '  </Settings>\n'
        printf '  <Actions Context="Author">\n'
        printf '    <Exec>\n      <Command>%s</Command>\n    </Exec>\n' "$(_xml_escape "$(win_path "$launcher")")"
        printf '  </Actions>\n'
        printf '</Task>\n'
      } > "$xml" || { err "could not write $xml — is $home writable?"; return 1; }
      # UTF-16 LE with a BOM, which is what [Text.Encoding]::Unicode writes and what Task Scheduler
      # wants. Read and written in one expression so the file is never truncated to nothing.
      xmlwin="$(win_path "$xml")"
      powershell.exe -NoProfile -NonInteractive -Command \
        "[IO.File]::WriteAllText('$xmlwin', [IO.File]::ReadAllText('$xmlwin'), [Text.Encoding]::Unicode)" \
        >/dev/null 2>&1 || {
          err "could not convert $xml to UTF-16 — Task Scheduler refuses a non-Unicode definition"
          err "install without a service instead:  --no-service"
          return 1
        }
      log "wrote $xml (UTF-16)"
      # The doubled slashes are for MSYS2, which would otherwise rewrite a lone //TN into a path
      # before schtasks.exe ever saw it. //F replaces an existing task, so a re-install is a
      # re-install rather than "the task already exists".
      if ! schtasks //Create //TN "$(service_task_name)" //XML "$(win_path "$xml")" //F >/dev/null 2>&1; then
        err "schtasks //Create failed for the task $(service_task_name) — a locked-down box refuses it"
        err "install without a service instead:  --no-service  (then start it yourself after each logon)"
        return 1
      fi
      log "registered the Task Scheduler task $(service_task_name) (at logon, as you, unelevated, restarts on failure)"
      printf '%s' "$launcher"
      return 0
      ;;
  esac
  warn "no user service manager here (no systemd --user, no launchd, no schtasks) — using the detached fallback"
  return 1
}

service_start() {
  local kind uid
  kind="$(service_kind)"
  case "$kind" in
    systemd) _systemctl_user start "$(service_name)" || return 1; return 0 ;;
    launchd) uid="$(id -u)"
             launchctl kickstart "gui/$uid/$(service_label)" >/dev/null 2>&1 || return 1
             return 0 ;;
    schtasks) schtasks //Run //TN "$(service_task_name)" >/dev/null 2>&1 || return 1; return 0 ;;
  esac
  return 1
}

service_stop() {
  local kind uid
  kind="$(service_kind)"
  case "$kind" in
    systemd) _systemctl_user stop "$(service_name)" || return 1; return 0 ;;
    launchd) uid="$(id -u)"
             launchctl kill SIGTERM "gui/$uid/$(service_label)" >/dev/null 2>&1 || true
             return 0 ;;
    schtasks)
      # //End is best-effort: some Windows builds report success without reaping the child, others
      # fail outright when the task is not currently "running". server_stop does the real work.
      schtasks //End //TN "$(service_task_name)" >/dev/null 2>&1 || true
      server_stop 15
      return 0
      ;;
  esac
  return 1
}

service_restart() {
  local kind uid
  kind="$(service_kind)"
  case "$kind" in
    systemd) _systemctl_user restart "$(service_name)" || return 1; return 0 ;;
    launchd) uid="$(id -u)"
             launchctl kickstart -k "gui/$uid/$(service_label)" >/dev/null 2>&1 || return 1
             return 0 ;;
    schtasks)
      # Task Scheduler has no restart verb, and //Run on a task it still believes is running is a
      # no-op — hence stop, a beat for the port to come free, start.
      service_stop || true
      sleep 2
      service_start || return 1
      return 0
      ;;
  esac
  return 1
}

service_status() { # 0 = installed and running
  local kind uid
  kind="$(service_kind)"
  case "$kind" in
    systemd)
      if [ ! -f "$(service_unit_path)" ]; then return 1; fi
      if [ "$(_systemctl_user is-active "$(service_name)" 2>/dev/null || true)" = "active" ]; then return 0; fi
      return 1
      ;;
    launchd)
      if [ ! -f "$(service_plist_path)" ]; then return 1; fi
      uid="$(id -u)"
      if launchctl print "gui/$uid/$(service_label)" 2>/dev/null | grep -q 'state = running'; then return 0; fi
      return 1
      ;;
    schtasks)
      # A registered task says nothing about whether the server is up: an ONLOGON task sits "Ready"
      # between logons, and one whose launcher died is still "Ready". The pidfile is the liveness.
      if ! schtasks //Query //TN "$(service_task_name)" //FO LIST >/dev/null 2>&1; then return 1; fi
      if [ -n "$(server_pid)" ]; then return 0; fi
      return 1
      ;;
  esac
  return 1
}

# Every removal here is reported by its OUTCOME, never by having been attempted: an `rm` that lost
# to a permission or a read-only mount used to print "removed …" anyway, which is the one thing an
# uninstall must not do — the operator walks away believing the file is gone.
service_uninstall() {
  local kind unit plist uid f
  kind="$(service_kind)"
  case "$kind" in
    systemd)
      unit="$(service_unit_path)"
      _systemctl_user stop "$(service_name)" >/dev/null 2>&1 || true
      _systemctl_user disable "$(service_name)" >/dev/null 2>&1 || true
      if [ -f "$unit" ]; then
        if rm -f "$unit" 2>/dev/null; then say "removed $unit"; else warn "could not remove $unit"; fi
      fi
      _systemctl_user daemon-reload >/dev/null 2>&1 || true
      return 0
      ;;
    launchd)
      plist="$(service_plist_path)"
      uid="$(id -u)"
      launchctl bootout "gui/$uid/$(service_label)" >/dev/null 2>&1 || true
      if [ -f "$plist" ]; then
        if rm -f "$plist" 2>/dev/null; then say "removed $plist"; else warn "could not remove $plist"; fi
      fi
      return 0
      ;;
    schtasks)
      schtasks //End //TN "$(service_task_name)" >/dev/null 2>&1 || true
      if ! schtasks //Delete //TN "$(service_task_name)" //F >/dev/null 2>&1; then
        warn "could not delete the task $(service_task_name) — remove it by hand in Task Scheduler"
      fi
      # Both files the install wrote: the launcher .cmd and the XML the task was registered from.
      for f in "$(service_launcher_path)" "$(service_task_xml_path)"; do
        if [ -f "$f" ]; then
          if rm -f "$f" 2>/dev/null; then say "removed $f"; else warn "could not remove $f"; fi
        fi
      done
      return 0
      ;;
  esac
  # Nothing installed here, but a unit/plist/launcher/XML can outlive the tool that detected it.
  for f in "$(service_unit_path)" "$(service_plist_path)" "$(service_launcher_path)" \
           "$(service_task_xml_path)"; do
    if [ -f "$f" ]; then
      if rm -f "$f" 2>/dev/null; then say "removed $f"; else warn "could not remove $f"; fi
    fi
  done
  return 0
}

# Only ever signal a pid we can identify as OUR server: a stale pidfile (an OOM-killed server never
# ran its exit handler) can hold a pid the OS has since handed to something else.
#
# Three ways to read another process's command line, one per platform. Git Bash's `ps` is the MSYS
# one: it has no -o and lists only MSYS processes, so node.exe — started by Windows, not by bash —
# does not even appear in it. Win32_Process is where Windows keeps the command line.
is_our_server() { # PID
  local pid="${1:-}" cmd=""
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  if _is_windows; then
    cmd="$(powershell.exe -NoProfile -NonInteractive -Command \
      "(Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\").CommandLine" 2>/dev/null || true)"
    # `?` matches either slash: Windows spells the same path C:\irises\dist\index.js.
    case "$cmd" in *dist?index.js*) return 0 ;; esac
    return 1
  fi
  if [ -r "/proc/$pid/cmdline" ]; then
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  else
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  fi
  case "$cmd" in *dist/index.js*) return 0 ;; esac
  return 1
}

# Is this pid alive? `kill -0` everywhere but Git Bash, where $IRISES_HOME/irises.pid holds a WINDOWS
# pid (node's own process.pid) that the MSYS signal layer has no translation for — kill -0 on it
# either fails on a live server or, worse, hits an unrelated MSYS process with the same number.
_pid_alive() { # PID
  local pid="${1:-}"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  if _is_windows; then
    if tasklist //FI "PID eq $pid" //FO CSV //NH 2>/dev/null | grep -q "\"$pid\""; then return 0; fi
    return 1
  fi
  if kill -0 "$pid" 2>/dev/null; then return 0; fi
  return 1
}

# The ONE pidfile: $IRISES_HOME/irises.pid, written by the server itself at boot. (The old setup
# script kept a second one in the clone root, which is how a "running" server and a "stale" pidfile
# could both be true at once.)
server_pid() {
  local home pid
  home="$(irises_home)"
  if [ -f "$home/irises.pid" ]; then
    pid="$(cat "$home/irises.pid" 2>/dev/null || true)"
    pid="${pid%%[![:digit:]]*}"
    if [ -n "$pid" ] && _pid_alive "$pid" && is_our_server "$pid"; then
      printf '%s' "$pid"
      return 0
    fi
  fi
  return 0
}

# Stop ONE pid, platform-aware, and wait to see it go. THE place a signal is sent: the pidfile path
# (server_stop) and the installer's adopt-by-command-line path both come through here, so neither has
# to know that Git Bash cannot signal a Windows pid at all. Always returns 0 — a pid that will not
# die is a warning the caller keeps going past, not an abort.
server_stop_pid() { # PID [SECS]
  local pid="${1:-}" secs="${2:-15}" i=0
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  if _is_windows; then
    # There is no SIGTERM to send on Windows and therefore no graceful phase to wait through:
    # taskkill //F terminates outright, and //T takes the tree with it (node spawns the web build
    # and, on an engine box, the bridge). The poll below is only to confirm it actually went.
    taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
    while _pid_alive "$pid" && [ "$i" -lt "$secs" ]; do
      sleep 1
      i=$((i + 1))
    done
    if _pid_alive "$pid"; then
      warn "pid $pid survived taskkill //F for ${secs}s — end it in Task Manager before you continue"
    fi
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  while _pid_alive "$pid" && [ "$i" -lt "$secs" ]; do
    sleep 1
    i=$((i + 1))
  done
  if _pid_alive "$pid"; then
    warn "pid $pid ignored SIGTERM for ${secs}s — sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
  return 0
}

server_stop() { # [SECS]
  local secs="${1:-15}" pid
  pid="$(server_pid)"
  if [ -z "$pid" ]; then return 0; fi
  say "stopping the running server (pid $pid)"
  server_stop_pid "$pid" "$secs"
}

# The --no-service fallback. `setsid` gives the server its own session; macOS has no setsid, so the
# child inherits INT/HUP as ignored instead — otherwise Ctrl+C in the launching terminal kills the
# server it just started (reproduced). Git Bash has neither: an MSYS background job dies with its
# console, so Windows detaches through Start-Process instead.
server_start_detached() { # ROOT [LOG]
  local root="${1:-}" log="${2:-}" home nodebin
  home="$(irises_home)"
  mkdir -p "$home/logs" || { err "could not create $home/logs — is $home writable?"; return 1; }
  if [ -z "$log" ]; then log="$home/logs/server.log"; fi
  say "starting Irises detached — it outlives this shell (log: $log)"
  if _is_windows; then
    nodebin="$(command -v node 2>/dev/null || true)"
    if [ -z "$nodebin" ]; then err "no node on PATH — cannot start the server"; return 1; fi
    # Start-Process inherits this shell's environment, which is the only channel it has for
    # IRISES_HOME (there is no -Environment parameter on Windows PowerShell 5.1). And it refuses one
    # file for both streams, so stderr gets its own .err sibling.
    #
    # -RedirectStandardOutput TRUNCATES the file it is given; it has no append mode. Every other
    # path in this library appends (`>>` on Linux/macOS, `>> "…\server.log" 2>&1` in the launcher
    # .cmd), so this is the one place where restarting the server discards the previous run's log.
    # It is only reached by `--no-service`, where nothing restarts the server but a person — and
    # the service install, which is the default, never comes through here.
    export IRISES_HOME="$home"
    if ! powershell.exe -NoProfile -NonInteractive -Command \
      "Start-Process -WindowStyle Hidden -FilePath '$(win_path "$nodebin")' -ArgumentList '\"$(win_path "$root/dist/index.js")\"' -WorkingDirectory '$(win_path "$root")' -RedirectStandardOutput '$(win_path "$log")' -RedirectStandardError '$(win_path "$log").err'" \
      >/dev/null 2>&1; then
      err "Start-Process could not launch the server — run it yourself: node $root/dist/index.js"
      return 1
    fi
    return 0
  fi
  (
    cd "$root" || exit 1
    if command -v setsid >/dev/null 2>&1; then
      setsid nohup node "$root/dist/index.js" </dev/null >>"$log" 2>&1 &
    else
      trap '' INT HUP
      nohup node "$root/dist/index.js" </dev/null >>"$log" 2>&1 &
    fi
  )
  return 0
}

wait_health() { # URL SECS   (URL is the base, e.g. http://127.0.0.1:3000)
  local url="${1:-}" secs="${2:-30}" i=0
  while [ "$i" -lt "$secs" ]; do
    if curl -fsS -m 5 "$url/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Wait until /health reports the sha we expect, and print it. This is the difference between "a
# server answers" and "the NEW build is live": the old updater only ever checked the former, so a
# restart that silently relaunched the old build looked like a success.
wait_health_sha() { # URL SHA SECS
  local url="${1:-}" want="${2:-}" secs="${3:-45}" i=0 body got
  while [ "$i" -lt "$secs" ]; do
    body="$(curl -fsS -m 5 "$url/health" 2>/dev/null || true)"
    if [ -n "$body" ]; then
      # version.sha is the first lowercase-hex "sha" in the body; update.remoteSha cannot match
      # this pattern (the quote before `Sha` is preceded by `remote`, and the case differs).
      # The whitespace classes match built_sha's: a pretty-printed or proxy-reformatted body
      # (`"sha" : "…"`) is still the same server, and tr flattens it before cut takes field 4.
      got="$(printf '%s' "$body" | grep -o '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]\{7,40\}"' | head -1 | tr -d '[:space:]' | cut -d'"' -f4 || true)"
      if [ -n "$got" ]; then
        if [ -z "$want" ]; then printf '%s' "$got"; return 0; fi
        case "$got" in "$want"*) printf '%s' "$got"; return 0 ;; esac
        case "$want" in "$got"*) printf '%s' "$got"; return 0 ;; esac
      fi
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Restart Irises through whatever owns it, and prove the sha we expect is what answers. Verifying
# only that "something answers /health" is satisfied by the OLD process still holding the port —
# which is exactly how a restart that never took could look like a success. That is why the caller
# hands in the sha it expects rather than asking this for a yes/no.
#
# It is in the lib because both callers need the identical sequence: update.sh after a build, and
# configure.sh after writing a setting the server only reads at boot. A second copy would drift, and
# the half that drifted would be the one reporting success without verifying anything.
irises_restart_verify() { # ROOT PORT EXPECTED_SHA SECS
  local root="${1:-}" port="${2:-}" want="${3:-}" secs="${4:-45}" kind live pid verb=restarted
  # service_installed(), not a look at the unit and the plist: on Windows the install is a Task
  # Scheduler entry and there is no file to find.
  if service_installed; then
    kind="$(service_kind)"
    say "restarting Irises through its $kind service"
    if ! service_restart; then
      err "the $kind service would not restart"
      return 1
    fi
  else
    # No pidfile'd server of ours, but the port is taken: something else is holding it — almost
    # always `npm run dev` in another terminal. Preflight refuses that case before anything is
    # applied, so reaching it HERE means the port was taken while this run was working; this is the
    # safety net, kept because starting a second server on a taken port would lose the bind and then
    # fail verification against whatever is still answering. It says what is true — someone else has
    # the port — and never that Irises is down, because something on :$port plainly is not.
    pid="$(server_pid)"
    if [ -z "$pid" ] && tcp_open 127.0.0.1 "$port"; then
      err "something took :$port during this run, and it is not a server this script can cycle:"
      err "  there is no live pid in $(irises_home)/irises.pid"
      err "whatever holds it is answering there — a dev server (npm run dev), most likely."
      err "stop it and re-run; a second server on that port could not bind at all."
      return 1
    fi
    if [ -z "$pid" ]; then
      say "no service installed and nothing running — starting the detached server"
      verb=started
    else
      say "no service installed — cycling the detached server"
    fi
    server_stop 20
    if ! server_start_detached "$root"; then
      err "could not start the server detached"
      return 1
    fi
  fi
  if ! live="$(wait_health_sha "http://127.0.0.1:$port" "$want" "$secs")"; then
    err "no /health answer reporting ${want:0:7} on :$port within ${secs}s"
    err "read the log:  tail -n 40 $(irises_home)/logs/server.log"
    return 1
  fi
  say "$verb — build ${live:0:7} is live on :$port"
  return 0
}

# The sha dist/ was stamped from (scripts/stamp-version.js). Empty when this clone was never built.
built_sha() { # [ROOT]
  local root="${1:-}" f
  if [ -z "$root" ]; then root="$(irises_root)"; fi
  f="$root/dist/version.json"
  if [ ! -f "$f" ]; then return 0; fi
  printf '%s' "$(grep -o '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]\{7,40\}"' "$f" | head -1 | cut -d'"' -f4 || true)"
}

# ── the voice model override ──────────────────────────────────────────────────
# A model for Irises's OWN VOICE, instead of the engine's. Three keys per voice role, because
# src/loadEnv.ts layers the engine's discovery UNDER this clone's .env — so what is written here is
# what wins at boot, whatever the engine is running.
#
# ENGINE_MODEL_INHERIT=off is not optional and not cosmetic: applyModel() in
# src/agents/ops/engineDiscovery.ts returns early when inheritance is off, and that early return is
# also what suppresses its key and base-URL reuse. Leave inheritance on and the operator's own key
# can end up pointed at the engine's gateway instead of the provider they chose. It is wider than
# "pick a model" and the summary says so: engine detection and the HERMES_API_KEY / OPENCLAW_TOKEN
# this install copies are outside applyModel and go on working, so deep work still runs on the
# engine's model, through the engine.
#
# It lives in the lib rather than in the installer because install and configure must write the SAME
# bytes: a second copy of this would drift, and a half-matching override is the failure mode above.

# Which key each lane's provider is billed through.
model_lane_key() { # LANE -> ANTHROPIC_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY (unknown -> 1)
  case "${1:-}" in
    anthropic)  printf 'ANTHROPIC_API_KEY' ;;
    openrouter) printf 'OPENROUTER_API_KEY' ;;
    openai)     printf 'OPENAI_API_KEY' ;;
    *)          return 1 ;;
  esac
  return 0
}

# THE KEY COMES FROM THE ENVIRONMENT AND NOWHERE ELSE. Never a flag: argv is readable by every other
# process on the box (ps, /proc) and lands in shell history. It is written to this clone's 0600 .env
# and is never printed, logged or named with a value anywhere.
model_override_write() { # FILE LANE SLUG BASE_URL
  local f="${1:-}" lane="${2:-}" slug="${3:-}" base_url="${4:-}" role key_name=""
  # The lane decides which key each of the three roles gets, so a lane nothing dispatches used to be
  # written HALFWAY — the _PROVIDER keys and ENGINE_MODEL_INHERIT=off landed, the model keys did not,
  # and the clone came up voiceless with nothing in the output saying why. Refused whole, up front.
  model_lane_key "$lane" >/dev/null 2>&1 || { err "model_override_write: unknown lane '$lane' — expected anthropic, openrouter or openai"; return 1; }
  say "voice model: $slug on the $lane lane, for all three voice roles"
  # EVERY write is guarded. A read-only .env, a full disk or a mount gone read-only makes env_set
  # return 1, and a function that walked past that would go on to SAY it wrote the model and return
  # 0 — leaving both callers' guards (engine-setup.sh's `|| die 1`, configure.sh's `|| exit 1`) with
  # nothing to fire on, and the operator with a clone that boots in nobody's voice.
  for role in CONVO CLASSIFY FALLFIRM; do
    case "$lane" in
      anthropic)  env_set "$f" "${role}_MODEL" "$slug" || return 1 ;;
      openrouter) env_set "$f" "${role}_MODEL_OPENROUTER" "$slug" || return 1 ;;
      openai)     env_set "$f" "${role}_MODEL_OPENAI" "$slug" || return 1 ;;
    esac
    env_set "$f" "${role}_PROVIDER" "$lane" || return 1
  done
  key_name="$(model_lane_key "$lane" || true)"
  if [ -n "${IRISES_MODEL_API_KEY:-}" ]; then
    env_set "$f" "$key_name" "$IRISES_MODEL_API_KEY" || return 1
    say "$key_name was taken from IRISES_MODEL_API_KEY in the environment and written to $f (0600)"
  else
    warn "no IRISES_MODEL_API_KEY in the environment, so $key_name stays whatever $f had."
    warn "Irises's own voice cannot call the $lane lane without one — add it and restart."
  fi
  if [ "$lane" = "openai" ]; then
    env_set "$f" OPENAI_BASE_URL "$base_url" || return 1
    say "OPENAI_BASE_URL=$base_url"
  fi
  env_set "$f" ENGINE_MODEL_INHERIT off || return 1
  say "ENGINE_MODEL_INHERIT=off — Irises stops inheriting the engine's model, and its keys and base"
  say "URL with it, for her own voice. Deep work still runs on the engine's model, through the engine."
  chmod 600 "$f" 2>/dev/null || true
  return 0
}

# The keys the override OWNS, space-separated on one line. With no LANE this is the whole removable
# set — what handing the voice back to the engine takes out, whichever lane it was last written on.
#
# The lane API keys are NEVER on this list, and neither is OPENAI_BASE_URL in the no-lane form: the
# operator pays for those and they may already have been in the file before Irises touched it.
# Undoing our choice of model must not cost them a credential they still need.
model_override_keys() { # [LANE] -> the keys the override writes and may remove
  local role out=""
  if [ -n "${1:-}" ]; then
    for role in CONVO CLASSIFY FALLFIRM; do
      case "$1" in
        anthropic)  out="$out ${role}_MODEL" ;;
        openrouter) out="$out ${role}_MODEL_OPENROUTER" ;;
        openai)     out="$out ${role}_MODEL_OPENAI" ;;
        *)          return 1 ;;
      esac
    done
    for role in CONVO CLASSIFY FALLFIRM; do out="$out ${role}_PROVIDER"; done
    out="$out ENGINE_MODEL_INHERIT"
    if [ "$1" = "openai" ]; then out="$out OPENAI_BASE_URL"; fi
  else
    for role in CONVO CLASSIFY FALLFIRM; do
      out="$out ${role}_MODEL ${role}_MODEL_OPENROUTER ${role}_MODEL_OPENAI ${role}_PROVIDER"
    done
    out="$out ENGINE_MODEL_INHERIT"
  fi
  printf '%s\n' "${out# }"
  return 0
}

# ── install manifest ──────────────────────────────────────────────────────────
# What the installer touched, so --uninstall can put it back WITHOUT node (the uninstall path must
# work on a box whose node has since gone). We are the only writer, so one key per line is a sound
# contract; a human who reformats it into one line still gets read, via node, below.
manifest_path() { printf '%s/install-manifest.json' "$(irises_home)"; }

manifest_write() { # PATH KEY=VALUE…
  local p="${1:-}" pair key val
  if [ -z "$p" ]; then return 1; fi
  shift || true
  mkdir -p "$(dirname "$p")" || { err "could not create $(dirname "$p") for the install manifest"; return 1; }
  {
    printf '{\n'
    printf '  "schema": "1",\n'
    printf '  "writtenAt": "%s"' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for pair in "$@"; do
      key="${pair%%=*}"
      val="${pair#*=}"
      val="${val//\\/\\\\}"
      val="${val//\"/\\\"}"
      printf ',\n  "%s": "%s"' "$key" "$val"
    done
    printf '\n}\n'
  } > "$p" || { err "could not write the install manifest $p — --uninstall will have to guess instead"; return 1; }
  chmod 600 "$p" 2>/dev/null || true
  say "wrote $p"
  return 0
}

manifest_read() { # PATH KEY
  local p="${1:-}" key="${2:-}" line v
  if [ -z "$key" ] || [ ! -f "${p:-}" ]; then return 0; fi
  # Anchored at the start of the line, because that is the contract manifest_write writes: one key
  # per line. An unanchored match would also hit a REFORMATTED single-line manifest, where the
  # parameter-expansion parse below then returns the rest of the file — so the anchor is what sends
  # that case down to the JSON parser instead.
  line="$(grep -m1 "^[[:space:]]*\"$key\"[[:space:]]*:" "$p" 2>/dev/null || true)"
  if [ -n "$line" ]; then
    v="${line#*:}"
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%,}"
    case "$v" in '"'*) v="${v#\"}"; v="${v%\"}" ;; esac
    # BOTH of manifest_write's escapes, undone in the reverse order it applied them: it does `\`
    # first and `"` second, so `\"` comes off before `\\`, and a value holding a literal `\"`
    # survives the round trip. Reversing only the quotes was enough while nothing re-wrote the file,
    # but manifest_update reads every field and writes it back — so a Windows root (C:\Irises\clone)
    # grew a backslash on every single update until it named a path that does not exist.
    v="${v//\\\"/\"}"
    v="${v//\\\\/\\}"
    printf '%s' "$v"
    return 0
  fi
  # A reformatted (single-line) manifest: fall back to a real JSON parser when one exists.
  if command -v node >/dev/null 2>&1; then
    node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=o[process.argv[2]];if(v!==undefined)process.stdout.write(String(v))}catch(e){}' "$p" "$key" 2>/dev/null || true
  fi
  return 0
}

# Every field the manifest carries — the same list, in the same order, that engine-setup.sh writes at
# the end of an install. It is spelled out here so manifest_update can carry forward the fields it is
# not changing WITHOUT having to parse the file's key order: the reader is line-anchored, and a key
# that never got read is a key --uninstall cannot put back.
IRISES_MANIFEST_KEYS="root irisesHome port engine engineEnvFile engineEnvBackup pluginDir serviceKind serviceUnit nodeBin keysAdded keysPreExisting keysRetargeted bridge frontPattern engineEnvApplied modelLane engineEnvPending"

# Change some fields of an existing manifest and leave the rest exactly as they were. This is a full
# rewrite on purpose: manifest_write is the ONE writer of this file and it writes the whole thing, so
# editing a line in place would make a second JSON writer to keep in sync — and the two would
# disagree the first time the format moved. configure.sh comes through here for port, frontPattern,
# modelLane, serviceKind, serviceUnit and keysRetargeted.
manifest_update() { # PATH KEY=VALUE…
  local p="${1:-}" pair key known have ok
  local args
  args=()
  if [ -z "$p" ] || [ ! -f "$p" ]; then
    err "no install manifest at ${p:-(no path given)} — nothing to update; re-run the installer"
    return 1
  fi
  shift || true
  # Validate EVERY key before writing anything: a typo in the second pair must not leave the first
  # one applied and the run reporting a failure over a manifest that was already changed.
  for pair in "$@"; do
    # A bare word first: `${pair%%=*}` of `port` is `port`, which passes the known-key check below
    # and then never matches the `KEY=` overlay — so without this the caller's change is accepted
    # and silently dropped.
    case "$pair" in
      *=*) ;;
      *) err "manifest_update: not a KEY=VALUE argument: $pair"; return 1 ;;
    esac
    key="${pair%%=*}"
    ok=0
    for known in $IRISES_MANIFEST_KEYS; do
      if [ "$known" = "$key" ]; then ok=1; break; fi
    done
    if [ "$ok" -eq 0 ]; then
      err "manifest_update: unknown key $key"
      return 1
    fi
    args[${#args[@]}]="$pair"
  done
  set --
  for known in $IRISES_MANIFEST_KEYS; do
    pair="$known=$(manifest_read "$p" "$known")"
    if [ "${#args[@]}" -gt 0 ]; then
      for have in "${args[@]}"; do
        case "$have" in "$known="*) pair="$have" ;; esac
      done
    fi
    set -- "$@" "$pair"
  done
  manifest_write "$p" "$@"
}

# ── single-lifecycle lock ─────────────────────────────────────────────────────
# mkdir is atomic, so it is the lock. One lock covers install, update and uninstall: two of them
# racing on git/npm/dist is the same corruption whichever pair it is.
lock_acquire() { # [NAME]
  local name="${1:-lifecycle}" home dir other
  home="$(irises_home)"
  mkdir -p "$home" 2>/dev/null || true
  dir="$home/$name.lock"
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$dir/pid" || warn "took the lock but could not record our pid in $dir/pid"
    IRISES_LOCK_DIR="$dir"
    return 0
  fi
  other="$(cat "$dir/pid" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    err "another Irises lifecycle run holds the lock (pid $other) — not starting a second one"
    return 1
  fi
  rm -rf "$dir" 2>/dev/null || true
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$dir/pid" || warn "took the lock but could not record our pid in $dir/pid"
    IRISES_LOCK_DIR="$dir"
    warn "reclaimed a lock left behind by a dead run (pid ${other:-unknown}) — see the previous run's log under $home/logs/ (update.sh writes update.log)"
    return 0
  fi
  err "could not take the lifecycle lock at $dir"
  return 1
}

# Release ONLY our own lock — never one a concurrent run holds.
lock_release() {
  local dir="${IRISES_LOCK_DIR:-}"
  if [ -z "$dir" ]; then return 0; fi
  if [ "$(cat "$dir/pid" 2>/dev/null || true)" = "$$" ]; then rm -rf "$dir" 2>/dev/null || true; fi
  IRISES_LOCK_DIR=""
  return 0
}

# ── the final block ───────────────────────────────────────────────────────────
# Every lifecycle script ends here, and its LAST line of stdout is always `RESULT: <token>`:
#   ok | noop | adopted | health-failed | rolled-back | gateway-failed | partial | up-to-date | update-available
summary() { # TOKEN LINE…
  local token="${1:-ok}" l
  shift || true
  printf '\n'
  printf '  ── Irises: %s ──\n' "${IRISES_LOG_TAG:-irises}"
  for l in "$@"; do printf '  %s\n' "$l"; done
  printf '\n'
  printf 'RESULT: %s\n' "$token"
  IRISES_SUMMARY_DONE=1
  return 0
}

# The safety net under the RESULT contract. Every lifecycle script installs it as
#   trap 'lifecycle_exit_guard $?' EXIT
# so the paths that never reach `summary` — a `set -e` abort on some statement nobody guarded, a
# Ctrl+C, a SIGTERM from a supervisor — still leave the lock released and ONE machine-readable line
# on stdout. Without it a caller that greps stdout for `RESULT:` gets nothing back and cannot tell a
# failed run from a run that is somehow still going. It never changes the exit code: it EXITS with
# the code it was handed, which is the abort's own from the EXIT trap and 130/143 from the signal
# traps the scripts also point here. Those two paths overlap by design — a signal trap's `exit`
# fires the EXIT trap as well — so the RESULT line is latched: exactly one, whichever got there
# first. Killing the run outright (SIGKILL) is still the one case nothing can report.
lifecycle_exit_guard() { # RC
  local rc="${1:-0}"
  lock_release
  case "$rc" in ''|*[!0-9]*) rc=1 ;; esac
  if [ "$rc" != "0" ] && [ "${IRISES_SUMMARY_DONE:-}" != "1" ]; then
    err "aborted with exit $rc before the summary — see the messages above"
    printf 'RESULT: partial\n'
    IRISES_SUMMARY_DONE=1
  fi
  exit "$rc"
}

# ═══ G. terminal prompts ══════════════════════════════════════════════════════
# The one implementation of "ask a human something" for every lifecycle script. Three rules, and
# each is load-bearing:
#
#  1. NEVER key off `[ -t 0 ]`. Whether a run may ask is a DECISION the script makes (its --yes, its
#     own no-TTY detection) and publishes as IRISES_ASSUME_YES; a helper that re-derives it from the
#     terminal cannot be driven by a test, and answers piped in from a heredoc would be thrown away.
#     Every helper here reads stdin and stdin only.
#  2. THE PROMPT IS NOT THE VALUE. Helpers whose answer a caller captures — ask_choice, ask_text,
#     ask_secret — write the question to STDERR and the answer to STDOUT, so `v="$(ask_text …)"` gets
#     the value and nothing else, and so nothing of a question can ever land in the `RESULT:` line a
#     wrapper parses. (ask_yn returns a status rather than a value, and keeps its prompt on stdout,
#     where engine-setup.sh has always printed it.)
#  3. EOF IS AN ANSWER — the default. A terminal that goes away mid-run (the SSH drop behind
#     update.sh's log) must not leave a lifecycle script blocked on a `read` forever.

# May this run ask a question? Non-zero when the caller has already said "take every default".
ui_interactive() {
  if [ "${IRISES_ASSUME_YES:-}" = "1" ]; then return 1; fi
  return 0
}

# ask_yn QUESTION DEFAULT(y|n) -> 0 = yes
# Moved here from scripts/engine-setup.sh, which had the only copy. Empty input (a bare Enter, or
# EOF) takes DEFAULT, and the brackets show which one that is.
ask_yn() {
  local q="${1:-}" def="${2:-n}" yn="" brackets="[y/N]"
  if [ "$def" = "y" ]; then brackets="[Y/n]"; fi
  if [ "${IRISES_ASSUME_YES:-}" = "1" ]; then
    say "$q — taking '$def' (--yes / non-interactive)"
    if [ "$def" = "y" ]; then return 0; fi
    return 1
  fi
  printf '\033[33m[%s]\033[0m %s %s ' "${IRISES_LOG_TAG:-irises}" "$q" "$brackets"
  read -r yn || yn=""
  case "$yn" in
    '') if [ "$def" = "y" ]; then return 0; fi; return 1 ;;
    y|Y|yes|YES) return 0 ;;
  esac
  return 1
}

# ask_choice PROMPT DEFAULT_INDEX LABEL… -> echoes the chosen 1-based index on stdout.
# Invalid input re-asks (three tries, because a fourth is a stuck pipe rather than a typo), then
# takes the default. Non-interactive echoes the default and says nothing.
ask_choice() {
  local prompt="${1:-choose}" def="${2:-1}" n=0 i tries=0 answer=""
  shift 2 || true
  n="$#"
  if [ "$n" -eq 0 ]; then return 1; fi
  case "$def" in ''|*[!0-9]*) def=1 ;; esac
  if [ "$def" -lt 1 ] || [ "$def" -gt "$n" ]; then def=1; fi
  if [ "${IRISES_ASSUME_YES:-}" = "1" ]; then
    printf '%s' "$def"
    return 0
  fi
  i=1
  for answer in "$@"; do
    printf '  %s) %s\n' "$i" "$answer" >&2
    i=$((i + 1))
  done
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    printf '\033[33m[%s]\033[0m %s [%s]: ' "${IRISES_LOG_TAG:-irises}" "$prompt" "$def" >&2
    read -r answer || answer=""
    case "$answer" in
      '') printf '%s' "$def"; return 0 ;;
      *[!0-9]*) ;;
      *) if [ "$answer" -ge 1 ] && [ "$answer" -le "$n" ]; then printf '%s' "$answer"; return 0; fi ;;
    esac
    warn "pick a number from 1 to $n"
  done
  warn "taking $def"
  printf '%s' "$def"
  return 0
}

# ask_text PROMPT DEFAULT [VALIDATOR_FN] -> echoes the value on stdout.
# VALIDATOR_FN is called with the candidate and decides by exit status. Three failed tries echo the
# DEFAULT and return 1, so a caller can tell "they meant this" from "they never got it right".
ask_text() {
  local prompt="${1:-value}" def="${2:-}" validator="${3:-}" tries=0 answer=""
  if [ "${IRISES_ASSUME_YES:-}" = "1" ]; then
    printf '%s' "$def"
    return 0
  fi
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    printf '\033[33m[%s]\033[0m %s [%s]: ' "${IRISES_LOG_TAG:-irises}" "$prompt" "$def" >&2
    read -r answer || answer=""
    if [ -z "$answer" ]; then answer="$def"; fi
    if [ -z "$validator" ]; then
      printf '%s' "$answer"
      return 0
    fi
    if "$validator" "$answer"; then
      printf '%s' "$answer"
      return 0
    fi
    warn "that is not a value $validator accepts — try again"
  done
  warn "keeping the default instead"
  printf '%s' "$def"
  return 1
}

# ask_secret PROMPT -> echoes the value on stdout, and NEVER anywhere else.
# Non-interactive returns 1 with an empty stdout: a secret is the one thing a --yes run may not
# invent for the operator. The terminal's echo is restored even if the read is interrupted.
ask_secret() {
  local prompt="${1:-secret}" v="" prev_int=""
  if [ "${IRISES_ASSUME_YES:-}" = "1" ]; then return 1; fi
  printf '\033[33m[%s]\033[0m %s ' "${IRISES_LOG_TAG:-irises}" "$prompt" >&2
  if [ -t 0 ]; then
    prev_int="$(trap -p INT 2>/dev/null || true)"
    trap 'stty echo 2>/dev/null || true' INT
    read -rs v || v=""
    if [ -n "$prev_int" ]; then eval "$prev_int"; else trap - INT; fi
    stty echo 2>/dev/null || true
  else
    read -r v || v=""
  fi
  printf '\n' >&2
  printf '%s' "$v"
  return 0
}

# ask_confirm_token PROMPT TOKEN -> 0 only when the operator typed TOKEN exactly.
# The gate in front of anything irreversible. It refuses under IRISES_ASSUME_YES on purpose: a
# --yes that could type the word for them is not a gate, and every caller of this one is a step that
# has to be chosen by a human at the keyboard.
ask_confirm_token() {
  local prompt="${1:-type the word to confirm}" token="${2:-}" answer=""
  if [ -z "$token" ]; then return 1; fi
  if [ "${IRISES_ASSUME_YES:-}" = "1" ]; then
    warn "this step has to be confirmed by hand — a non-interactive run cannot type '$token' for you"
    return 1
  fi
  printf '\033[31m[%s]\033[0m %s ' "${IRISES_LOG_TAG:-irises}" "$prompt" >&2
  # `IFS= read`, not a bare one: the default IFS strips the spaces off what was typed, and " delete "
  # would then pass a gate whose whole promise is that nothing but the word itself does.
  IFS= read -r answer || answer=""
  if [ "$answer" = "$token" ]; then return 0; fi
  return 1
}

# front_pattern_valid PATTERN -> 0 when every comma-separated item is <platform>:<glob>.
# IRISES_FRONT is fnmatch globs over `<platform>:<chat_id>`, and the engine silently fronts NOTHING
# for a line it cannot parse — which looks exactly like an install that did not work.
front_pattern_valid() {
  local p="${1:-}" item rest
  if [ -z "$p" ]; then return 1; fi
  case "$p" in
    ,*|*,|*,,*) return 1 ;;
  esac
  rest="$p"
  while [ -n "$rest" ]; do
    case "$rest" in
      *,*) item="${rest%%,*}"; rest="${rest#*,}" ;;
      *)   item="$rest"; rest="" ;;
    esac
    if [[ ! "$item" =~ ^[A-Za-z0-9_.*-]+:[^,[:space:]]+$ ]]; then return 1; fi
  done
  return 0
}

# archive_home DEST -> a tar.gz of $IRISES_HOME at DEST; echoes the path on stdout.
# Offered in front of --purge-data, which is the only step in the whole lifecycle that destroys
# something irreplaceable. An empty DEST picks $HOME/.irises-backup-<timestamp>.tar.gz.
archive_home() {
  local dest="${1:-}" home base parent
  home="$(irises_home)"
  if [ ! -d "$home" ]; then
    err "there is no $home to archive"
    return 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    err "no tar on this box — copy $home somewhere yourself before deleting it"
    return 1
  fi
  if [ -z "$dest" ]; then dest="$HOME/.irises-backup-$(date +%Y%m%d-%H%M%S).tar.gz"; fi
  base="$(basename "$home")"
  parent="$(dirname "$home")"
  if ! tar -czf "$dest" -C "$parent" "$base" 2>/dev/null; then
    err "could not write $dest — a full disk, or a directory that is not writable"
    rm -f "$dest" 2>/dev/null || true
    return 1
  fi
  chmod 600 "$dest" 2>/dev/null || true
  log "archived $home -> $dest"
  printf '%s' "$dest"
}
