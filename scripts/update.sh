#!/usr/bin/env bash
# Irises updater — pull the latest code onto a git-clone install, rebuild, restart, and prove the
# new build is the one answering; only THEN refresh the engine's plugin copy and bounce its gateway,
# so a run that rolls back leaves the engine on the plugin that matches the code it went back to.
#
#   bash scripts/update.sh                      # apply (asks first), restart, verify
#   bash scripts/update.sh --yes                # no questions
#   bash scripts/update.sh --check              # report only (0 up to date, 10 update available)
#   bash scripts/update.sh --no-restart         # apply to disk, leave the running server alone
#   bash scripts/update.sh --no-gateway-restart # skip the engine gateway bounce
#   bash scripts/update.sh --rollback-to SHA    # go back to a build this clone already has
#
# --no-restart skips the IRISES restart and nothing else: the bridge plugin is still refreshed and
# the engine's gateway is still bounced (~12s of engine downtime), and Irises goes on serving the
# OLD build — against the NEW plugin — until you restart it yourself. Pass --no-gateway-restart as
# well if you want nothing but this clone's disk touched.
#
# IRISES_SKIP_WEB_BUILD=1 skips the web client rebuild outright (a small box, or no web UI in use).
# The web build is optional and never blocks an update either way — see web_build() in the library.
#
# --rollback-to is the recovery path, and it is not part of the update flow: it never fetches, never
# looks at origin, and asks the clone one question — is that commit here. It then resets to it,
# rebuilds, restarts, verifies, refreshes the engine's plugin copy and bounces the gateway, exactly
# as a failed update's automatic rollback does. It moves the CODE only: $IRISES_HOME is not rolled
# back with it, so a schema the newer build wrote stays written.
#
# Docker installs update by rebuilding the image, not with this script — see docs/DEPLOY.md § 5.
#
# SAFE BY DESIGN
#   • fast-forward only — a diverged local branch is never force-merged
#   • refuses to APPLY onto a tree with uncommitted changes to tracked files (--check still reports)
#   • takes the single lifecycle lock, so an update and an install cannot race on git/npm/dist
#   • ROLLS BACK: if the build fails, or the restarted server does not report the new build, the
#     tree, node_modules and dist all go back to where they were, and the old build is put back up
#   • leaves $IRISES_HOME (your data) untouched, always
# After the restart, Irises mentions the upgrade in chat itself — from the receipt this writes.
#
# EXIT CODES
#   0   applied and verified, already up to date, or nothing upstream to apply
#   1   preflight refused (not a git clone, dirty tree, a foreign process on our port, detached
#       HEAD, another run holds the lock, origin unreachable, or the pull could not fast-forward)
#   2   wrong usage (unknown flag)
#   3   the build failed — the clone is back where it was; the running server was never touched
#   4   the built code did not answer /health — rolled back to the old build and restarted
#   5   Irises IS updated and live, but its engine's gateway could not be verified back up
#   10  --check only: an update is available
#   --rollback-to reuses 3 (the rebuild at the target failed), 4 (it built but would not serve) and
#       5 (Irises is on the target build, but its engine's gateway could not be verified back up)
#   130/143  stopped mid-run by a signal (Ctrl+C / SIGTERM); RESULT: partial, read the messages above
# Every run that gets past the flags ends with `RESULT: <token>` as its last line of stdout:
#   ok | noop | up-to-date | update-available | rolled-back | gateway-failed — or `partial` for a
#   run that stopped before finishing, which is one of: nothing had been changed yet; an undo failed
#   and the tree/node_modules/dist may be inconsistent; or the run stopped abnormally (an unguarded
#   error, or a Ctrl+C) and the exit guard printed the line, in which case the tree may be
#   fast-forwarded with nothing undone. Read the messages above either way.
set -euo pipefail

source "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/lib/irises-lib.sh"
IRISES_LOG_TAG="irises-update"

CHECK=0
ASSUME_YES=0
ROLLBACK_TO=""
DO_RESTART=1
DO_GATEWAY=1

while [ $# -gt 0 ]; do
  case "$1" in
    --check)               CHECK=1; shift ;;
    --yes|-y)              ASSUME_YES=1; shift ;;
    --no-restart)          DO_RESTART=0; shift ;;
    --no-gateway-restart)  DO_GATEWAY=0; shift ;;
    --rollback-to)         ROLLBACK_TO="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --rollback-to=*)       ROLLBACK_TO="${1#--rollback-to=}"; shift ;;
    -h|--help)             sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --restart)
      err "--restart is gone: an update restarts Irises and verifies the new build every time."
      err "If you want the old behaviour — apply to disk and leave the process alone — use --no-restart."
      exit 2 ;;
    *) err "unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done

# A sha, and a sha this clone can be at: 7 to 40 hex characters. Checked with the flags rather than
# down where it is used, so a typo is a usage error that changes nothing and prints no RESULT line.
if [ -n "$ROLLBACK_TO" ]; then
  case "$ROLLBACK_TO" in
    *[!0-9a-fA-F]*) err "--rollback-to takes a git sha (7-40 hex characters), got '$ROLLBACK_TO'"; exit 2 ;;
  esac
  if [ "${#ROLLBACK_TO}" -lt 7 ] || [ "${#ROLLBACK_TO}" -gt 40 ]; then
    err "--rollback-to takes a git sha of 7 to 40 hex characters, got '$ROLLBACK_TO'"
    err "(fewer than 7 is ambiguous, and a rollback is not a thing to guess at)"
    exit 2
  fi
  if [ "$CHECK" = "1" ]; then
    err "--check and --rollback-to ask for opposite things: one reports and changes nothing, the"
    err "other changes everything. Run them separately."
    exit 2
  fi
fi

# The library's prompt helpers read this, never the terminal — the decision is --yes, and it is made
# up there in the flags.
# shellcheck disable=SC2034  # read by the sourced library (lib/irises-lib.sh), not by this file
IRISES_ASSUME_YES="$ASSUME_YES"

# Armed HERE, past every usage exit and before the first byte of real work: the guard releases the
# lock and leaves ONE machine-readable line on stdout (`RESULT: partial`) for the paths that never
# reach `summary` — a `set -e` abort on some statement nobody guarded, and a Ctrl+C. It never
# changes the exit code, and it is harmless on a `--check` run, which takes no lock.
trap 'lifecycle_exit_guard $?' EXIT

ROOT="$(irises_root)"
ENV_FILE="$ROOT/.env"
cd "$ROOT"
PORT="$(irises_port)"
STATE_DIR="$(irises_home)"
UPDATE_LOG="$STATE_DIR/logs/update.log"
UPDATE_LOG_ON=0

# ── preflight ────────────────────────────────────────────────────────────────
# Tools first: `git rev-parse` on a box without git would otherwise report "not a git clone", which
# sends the reader looking for the wrong problem.
augment_path
require_tools git curl npm || exit 1
require_node_version 22.13 || exit 1
git rev-parse --git-dir >/dev/null 2>&1 || {
  err "this is not a git clone — nothing to pull."
  err "Docker installs update by rebuilding the image (docs/DEPLOY.md § 5)."
  exit 1
}

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || die 1 "detached HEAD — check out a branch first (e.g. git checkout main)"

# A dirty tree is uncommitted changes to TRACKED files. Untracked ones are fine (.env, dist/,
# web/out are gitignored anyway); it is local edits to committed code that a fast-forward cannot
# reconcile. `--check` only reads and reports, so it warns instead of refusing — being told what is
# waiting upstream is useful even mid-edit, and it is the apply that has to be strict.
# If web/package-lock.json is the only entry, it is almost certainly the old updater's
# `npm run install:web`; the library's web build uses ci, which does not rewrite it.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  if [ "$CHECK" = "1" ]; then
    warn "the working tree has uncommitted changes to tracked files — an APPLY would refuse it:"
    git status --short --untracked-files=no >&2
  else
    err "the working tree has uncommitted changes to tracked files — a clean pull needs them gone:"
    git status --short --untracked-files=no >&2
    if [ "$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')" = "1" ] \
       && git status --porcelain --untracked-files=no | grep -q 'web/package-lock.json'; then
      err "that one file is the old updater's footprint. Clear it and re-run:"
      err "  git checkout -- web/package-lock.json"
    else
      err "stash them (git stash) or commit them, then re-run."
    fi
    exit 1
  fi
fi

# --check is read-only (fetch + report), so it takes no lock — and nothing to log.
if [ "$CHECK" != "1" ]; then
  lock_acquire || exit 1

  # From here the whole run — stdout AND stderr — is duplicated into $UPDATE_LOG. What the operator
  # lost in the incident behind this was the OUTPUT: their SSH session died in the memory thrash of
  # the build, and everything after the `tsc` line (a finished build, a written receipt, a verified
  # restart on the new sha) went with it. Two details make the log worth having in exactly that case:
  #   • the tee IGNORES HUP itself, inside the process substitution, before exec'ing — a tee that
  #     dies with the terminal leaves the script writing into a closed pipe, which is a SIGPIPE and
  #     a log truncated mid-build: the same silence with extra steps;
  #   • fd 1 and 2 become that pipe, so once the pty is gone the script's own writes still succeed
  #     instead of failing with EIO half-way through the apply.
  # `exec` ONCE, never a pipeline around the script: `… | tee` would hand the caller tee's exit code
  # and break every exit code in the header, and the `RESULT:` line with them.
  # Process substitution is bash-only and absent in POSIX mode and in a restricted shell, so it is
  # PROBED in a subshell and applied through eval: a `>(` this shell cannot parse must not become a
  # syntax error in the middle of an update. The probe needs its own subshell because the `2>/dev/null`
  # that silences it would otherwise be restored over the real redirection's `2>&1`.
  if command -v tee >/dev/null 2>&1 \
     && mkdir -p "$STATE_DIR/logs" 2>/dev/null \
     && ( eval 'exec 9> >(cat >/dev/null)' ) 2>/dev/null \
     && printf '=== update started %s ===\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$UPDATE_LOG" 2>/dev/null; then
    eval 'exec > >(trap "" HUP; exec tee -a "$UPDATE_LOG") 2>&1'
    UPDATE_LOG_ON=1
  else
    warn "this run is NOT being logged to $UPDATE_LOG (no tee, no process substitution, or no room)"
  fi

  # HUP is ignored from the moment we hold the LOCK, not from the apply. Everything past this point
  # can outlive the session that started it — the repair path below rebuilds without asking anything
  # at all — and a hangup used to kill the script outright, which is how the incident ended with the
  # lock dir still on disk holding a dead pid: bash runs no EXIT trap when it dies of a signal nobody
  # caught. Ignoring it here (children inherit that, so the build survives too) means the run always
  # reaches its own ending, and the lock always comes back.
  #
  # A run that loses its terminal AT THE CONFIRMATION PROMPT is not left waiting either: `read` gets
  # EOF from the gone stdin, the abort branch takes it as a "no", and the summary says nothing
  # changed. That is also what a piped stdin has always done, which is the behaviour it borrows.
  trap '' HUP
  if [ "$UPDATE_LOG_ON" = "1" ]; then
    say "progress is also written to $UPDATE_LOG — if this session drops, reconnect and: tail -f $UPDATE_LOG"
  fi
fi

# None of this is a rollback's business: --rollback-to asks the clone for a commit it already
# has, and origin has no say in it. A box whose network is down is exactly where a rollback
# gets typed, so the fetch — and the origin-branch comparison that needs it — is skipped there.
if [ -z "$ROLLBACK_TO" ]; then
  # The named branch FIRST: a single-branch clone (`git clone --single-branch`, which is what a small
  # box or a CI image often has) fetches only its own branch's refspec, so the wide form would never
  # bring anything down for any other branch — and it silently reports success while doing it. The
  # wide fetch is the fallback, because the narrow form fails with "couldn't find remote ref" for a
  # branch that exists only here (a worktree, a local experiment), which is indistinguishable from a
  # network that is down. Only BOTH failing is treated as "origin unreachable".
  say "fetching from origin …"
  git fetch --quiet origin "$BRANCH" 2>/dev/null || git fetch --quiet origin \
    || die 1 "could not fetch from origin — check the network, then re-run"

  if ! git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
    say "branch $BRANCH does not exist on origin — there is nothing upstream to pull"
    if [ "$CHECK" = "1" ]; then
      summary up-to-date "branch $BRANCH has no counterpart on origin — no upstream commits to apply"
      exit 0
    fi
    summary noop "branch $BRANCH has no counterpart on origin — no upstream commits to apply"
    exit 0
  fi

  OLD="$(git rev-parse HEAD)"
  NEW="$(git rev-parse "refs/remotes/origin/$BRANCH")"
  # Both are full 40-char shas: scripts/stamp-version.js writes `git rev-parse HEAD` verbatim, so a
  # plain string comparison below is sound. (/health may shorten it — wait_health_sha does the prefix
  # matching for that case.)
  BUILT="$(built_sha "$ROOT")"
fi

write_receipt() { # OLD NEW  (equal shas → an empty changelog, which still fires the boot announce)
  # KEEP the argument list identical to the pre-rewrite call: scripts/write-update-receipt.js reads
  # OLD, NEW and BRANCH off argv and the commit lines off stdin, and src/update/receipt.ts consumes
  # what it writes at boot. This is the whole channel through which Irises learns she was upgraded.
  # Written through a temp file and moved into place: `> …/update-receipt.json` truncates the file
  # before the pipeline runs, so a node that then failed left an EMPTY receipt behind — which
  # src/update/receipt.ts has to parse and reject at every boot until someone deletes it.
  local tmp
  RECEIPT_OK=0
  mkdir -p "$STATE_DIR" || {
    warn "could not create $STATE_DIR — no receipt, so nothing will be announced in chat"
    return 0
  }
  tmp="$STATE_DIR/update-receipt.json.tmp.$$"
  if git --no-pager log --oneline "$1..$2" \
     | node "$ROOT/scripts/write-update-receipt.js" "$1" "$2" "$BRANCH" > "$tmp" \
     && mv "$tmp" "$STATE_DIR/update-receipt.json"; then
    say "wrote the update receipt to $STATE_DIR/update-receipt.json"
    RECEIPT_OK=1
    return 0
  fi
  rm -f "$tmp"
  warn "could not write the update receipt (the upgrade still applied; Irises just won't announce it)"
  return 0
}
RECEIPT_OK=0

# Where the receipt's changelog starts: the build that was RUNNING (dist/version.json), not HEAD.
# Commits made in this clone move HEAD before any update runs, so HEAD..NEW is empty on exactly the
# path a developer uses every time — and an empty changelog is what made Irises insist "same build".
# Falls back to the given sha when dist was never stamped or its sha isn't an ancestor of NEW
# (amended or rebased away), since `git log` on an unknown sha would fail the receipt under pipefail.
receipt_base() { # FALLBACK NEW
  if [ -n "$BUILT" ] && git merge-base --is-ancestor "$BUILT" "$2" 2>/dev/null; then
    printf '%s' "$BUILT"
  else
    printf '%s' "$1"
  fi
}

# Take the receipt back. Called on every path that undoes a build: nothing should announce an
# upgrade that is being reversed.
withdraw_receipt() {
  if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/update-receipt.json" ]; then
    rm -f "$STATE_DIR/update-receipt.json"
    say "withdrew the update receipt — there is no upgrade to announce"
  fi
  return 0
}

# Put everything back: the tree, the dependencies, and the build. The old updater had no rollback at
# all, so a failed `npm ci` after the merge left HEAD new, node_modules wiped and dist old — a state
# nobody could get out of without knowing the sha to reset to.
rollback_to() { # SHA
  local sha="${1:-}"
  warn "rolling back to ${sha:0:7}"
  if ! git reset --hard "$sha" >/dev/null 2>&1; then
    err "git reset --hard ${sha:0:7} FAILED — this clone needs hands:"
    err "  cd $ROOT && git reset --hard ${sha} && npm ci --include=dev && npm run build"
    return 1
  fi
  if ! npm ci --include=dev; then
    err "npm ci during the rollback FAILED — node_modules is incomplete:"
    err "  cd $ROOT && npm ci --include=dev && npm run build"
    return 1
  fi
  if ! npm run build; then
    err "npm run build during the rollback FAILED — dist/ is stale:"
    err "  cd $ROOT && npm run build"
    return 1
  fi
  say "rolled back to ${sha:0:7}"
  return 0
}

# The 408 MB box this was written for pushes `npm ci` and `tsc` deep into swap for minutes at a
# time, and that thrash is what killed the operator's SSH session mid-build. The run survives it now
# (HUP is ignored from the lock onwards, and the log above outlives the terminal), but nobody should have to
# guess why their terminal went quiet — so say it before it happens. Warning only; nothing is gated
# on the number, and macOS reports none at all (mem_available_mb stays empty there).
warn_if_low_memory() {
  local mb
  mb="$(mem_available_mb)"
  case "${mb:-}" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$mb" -lt 300 ]; then
    warn "only ${mb} MB of memory is free — this build can take several minutes, and the swap"
    warn "thrash can freeze or drop an SSH session. The run keeps going if the session goes."
    if [ "$UPDATE_LOG_ON" = "1" ]; then warn "watch it with:  tail -f $UPDATE_LOG"; fi
  fi
  return 0
}

# What the web step actually did on THIS run, for the summary. web_build() never fails an update, so
# "web/out exists" on its own says nothing about whether it was rebuilt just now — the marker taken
# before the call is what separates the two.
WEB_MARKER=""
web_state() { # -> a line that is true whatever web_build() decided to do
  if [ "${IRISES_SKIP_WEB_BUILD:-}" = "1" ]; then
    printf 'skipped (IRISES_SKIP_WEB_BUILD=1)'
  elif [ ! -d "$ROOT/web" ]; then
    printf 'n/a (no web client in this clone)'
  elif [ ! -d "$ROOT/web/out" ]; then
    printf 'not built here (the terminal chat needs none; opt in with IRISES_WEB=1)'
  elif [ -n "$WEB_MARKER" ] && [ "$ROOT/web/out" -nt "$WEB_MARKER" ]; then
    printf 'rebuilt'
  else
    printf 'web/out is from an earlier build — see the web lines above'
  fi
}

# ── roll back to a build this clone already has ──────────────────────────────
# The recovery path, and deliberately a separate one: it is typed by hand with a sha in it, it does
# not look at origin, and it does not care whether an update is waiting. What it does after the
# reset is what a failed update's own rollback does — rebuild, restart, verify, refresh the engine's
# plugin copy, bounce the gateway — because the engine's copy of the plugin has to match the code
# that is now on disk, and a gateway only reads it at start.
if [ -n "$ROLLBACK_TO" ]; then
  if ! git cat-file -e "${ROLLBACK_TO}^{commit}" 2>/dev/null; then
    err "there is no commit ${ROLLBACK_TO} in this clone."
    err "a rollback goes to a build this clone already has — see what it has:"
    err "  git --no-pager log --oneline -20"
    exit 1
  fi
  TARGET="$(git rev-parse --verify "${ROLLBACK_TO}^{commit}")"
  CURRENT="$(git rev-parse HEAD)"
  if [ "$TARGET" = "$CURRENT" ]; then
    say "HEAD is already ${TARGET:0:7} — there is nothing to roll back"
    summary noop "HEAD is already at ${TARGET:0:7}"
    exit 0
  fi
  say "rolling back ${CURRENT:0:7} -> ${TARGET:0:7} on $BRANCH"
  git --no-pager log -1 --format='    %h %s' "$TARGET" || true
  warn "this moves the CODE. $STATE_DIR — irises.db, the memories — is NOT rolled back with it, so"
  warn "anything the newer build wrote there stays written, and the older code has to live with it."
  if [ "$ASSUME_YES" != "1" ]; then
    if ! ask_yn "roll back to ${TARGET:0:7}?" n; then
      say "aborted — nothing changed"
      summary noop "aborted at the confirmation prompt"
      exit 0
    fi
  fi
  # The same question the apply path asks one line before it changes anything, for the same reason:
  # if something that is not the managed Irises holds the port, the restart at the end of this run
  # cannot succeed, and finding that out after the reset would mean rolling the rollback back.
  if [ "$DO_RESTART" = "1" ] \
     && tcp_open 127.0.0.1 "$PORT" && [ -z "$(server_pid)" ] && ! service_installed; then
    err "a process that is not the managed Irises is listening on :$PORT:"
    err "  there is no live pid in $STATE_DIR/irises.pid, and no Irises service is installed"
    err "the usual cause is a dev server (npm run dev) in another terminal."
    err "stop it and re-run. Nothing has been changed — this refusal is before the reset."
    exit 1
  fi
  trap 'lifecycle_exit_guard 130' INT
  trap 'lifecycle_exit_guard 143' TERM
  warn_if_low_memory
  if ! rollback_to "$TARGET"; then
    summary partial \
      "the move to ${TARGET:0:7} FAILED part way — see the commands above" \
      "the tree, node_modules and dist may all disagree; the running server was not restarted" \
      "data:     $STATE_DIR — untouched, as always"
    exit 3
  fi
  # Nothing may announce an upgrade that has just been taken away again.
  withdraw_receipt
  ROLLBACK_RESTART="skipped (--no-restart) — ${TARGET:0:7} is on disk, not running"
  if [ "$DO_RESTART" = "1" ]; then
    if ! irises_restart_verify "$ROOT" "$PORT" "$TARGET" 45; then
      summary partial \
        "the clone is at ${TARGET:0:7}, but it did not come back up" \
        "there is nothing left to undo — going forward again is: bash scripts/update.sh" \
        "read $STATE_DIR/logs/server.log, then: cd $ROOT && npm start"
      exit 4
    fi
    ROLLBACK_RESTART="restarted, build ${TARGET:0:7} verified live"
  fi
  ENGINE="$(engine_kind)"
  PLUGIN_STATE="n/a (standalone install — no engine)"
  if [ "$ENGINE" != "off" ]; then
    if plugin_refresh "$ENGINE" "$ROOT"; then
      PLUGIN_STATE="refreshed — the engine now has the plugin that matches ${TARGET:0:7}"
    else
      PLUGIN_STATE="NOT refreshed — see the warning above"
    fi
  fi
  GATEWAY_STATE="skipped (--no-gateway-restart)"
  RC=0
  RESULT=rolled-back
  if [ "$ENGINE" = "off" ]; then
    GATEWAY_STATE="n/a (standalone install)"
  elif [ "$DO_GATEWAY" = "1" ]; then
    if gateway_restart "$ENGINE" 90; then
      GATEWAY_STATE="bounced and verified"
    else
      GATEWAY_STATE="NOT verified — bounce it yourself once you know why"
      RESULT=gateway-failed
      RC=5
    fi
  fi
  summary "$RESULT" \
    "rolled back: ${CURRENT:0:7} -> ${TARGET:0:7} on $BRANCH" \
    "plugin:   $PLUGIN_STATE" \
    "Irises:   $ROLLBACK_RESTART" \
    "gateway:  $GATEWAY_STATE" \
    "data:     $STATE_DIR — untouched, and NOT rolled back with the code" \
    "forward again whenever you want it: bash scripts/update.sh"
  exit "$RC"
fi

# Every path below that restarts Irises takes the gateway with it, so the engine never runs on
# against a server that came up after it did. Sets GATEWAY_STATE; returns 1 on an unverified bounce.
bounce_gateway() {
  local engine
  engine="$(engine_kind)"
  if [ "$engine" = "off" ]; then GATEWAY_STATE="n/a (standalone install)"; return 0; fi
  if [ "$DO_GATEWAY" != "1" ]; then GATEWAY_STATE="skipped (--no-gateway-restart)"; return 0; fi
  if gateway_restart "$engine" 90; then GATEWAY_STATE="bounced and verified"; return 0; fi
  GATEWAY_STATE="NOT verified — bounce it yourself once you know why"
  return 1
}

# ── compare ──────────────────────────────────────────────────────────────────
# Local ahead of origin (your own unpushed commits): nothing to pull, but HEAD may not be built or
# running yet. Treated as level with origin, so the repair below builds it, restarts, refreshes the
# plugin and bounces the gateway — one command after any commit, pushed or not.
AHEAD=0
if [ "$OLD" != "$NEW" ] && git merge-base --is-ancestor "$NEW" HEAD; then
  AHEAD=1
  NEW="$OLD"
fi
if [ "$OLD" = "$NEW" ]; then
  if [ -n "$BUILT" ] && [ "$BUILT" != "$NEW" ] && [ "$CHECK" != "1" ]; then
    # HEAD is current but dist/ was stamped from another commit: a previous update advanced HEAD and
    # then its build (or its box) died. Reporting "up to date" would strand that half-applied state.
    warn "code is at ${NEW:0:7} but the built version is ${BUILT:0:7} — a previous build didn't finish"
    say "repairing the build"
    warn_if_low_memory
    if ! ( npm ci --include=dev && npm run build ); then
      err "the repair build failed at ${NEW:0:7}"
      err "  cd $ROOT && npm ci --include=dev && npm run build"
      # Nothing to roll back to: HEAD was already at ${NEW:0:7} before this run, and origin is there
      # too. So this is not `rolled-back` — the clone is exactly as broken as we found it.
      summary partial \
        "nothing was undone, because nothing had changed: the repair build failed at ${NEW:0:7}" \
        "HEAD was already at ${NEW:0:7} when this run started — there was no rollback to make" \
        "run the two commands above by hand once you know why the build failed"
      exit 3
    fi
    WEB_MARKER="$(mktemp 2>/dev/null || printf '')"
    web_build "$ROOT"
    # Read the marker BEFORE removing it: `-nt` is also true when the file it compares against is
    # gone, so a deleted marker would report every run as a rebuild.
    WEB_STATE="$(web_state)"
    [ -z "$WEB_MARKER" ] || rm -f "$WEB_MARKER"
    write_receipt "$(receipt_base "$NEW" "$NEW")" "$NEW"
    REPAIR_RESTART="skipped (--no-restart) — the repaired build is on disk; restart Irises yourself"
    REPAIR_RESULT=ok
    REPAIR_RC=0
    if [ "$DO_RESTART" = "1" ]; then
      if ! irises_restart_verify "$ROOT" "$PORT" "$NEW" 45; then
        withdraw_receipt
        summary partial \
          "nothing was undone, because nothing had changed: the repaired build ${NEW:0:7} did not answer /health" \
          "the tree and dist are at ${NEW:0:7} — there is no older build to go back to" \
          "read $STATE_DIR/logs/server.log, then: cd $ROOT && npm start"
        exit 4
      fi
      REPAIR_RESTART="restarted, build ${NEW:0:7} verified live"
    fi
    # The update that died here advanced HEAD before its build, so it never reached its own plugin
    # refresh either: the engine still holds the previous sha's copy. Refreshed before the bounce,
    # because the bounce is when the engine loads it — the same order the apply path keeps below.
    REPAIR_ENGINE="$(engine_kind)"
    REPAIR_PLUGIN="n/a (standalone install — no engine)"
    if [ "$REPAIR_ENGINE" != "off" ]; then
      if plugin_refresh "$REPAIR_ENGINE" "$ROOT"; then
        REPAIR_PLUGIN="refreshed"
      else
        REPAIR_PLUGIN="NOT refreshed — see the warning above"
      fi
    fi
    if ! bounce_gateway; then REPAIR_RESULT=gateway-failed; REPAIR_RC=5; fi
    summary "$REPAIR_RESULT" \
      "repaired an unfinished build at ${NEW:0:7} (the code was already there)" \
      "web UI:   $WEB_STATE" \
      "Irises:   $REPAIR_RESTART" \
      "plugin:   $REPAIR_PLUGIN" \
      "gateway:  $GATEWAY_STATE" \
      "data:     $STATE_DIR — untouched, as always"
    exit "$REPAIR_RC"
  fi
  if [ "$AHEAD" = "1" ]; then
    say "local $BRANCH is ahead of origin — nothing upstream to pull"
    summary noop "local $BRANCH is ahead of origin/$BRANCH"
    exit 0
  fi
  say "already up to date ($(git rev-parse --short HEAD), branch $BRANCH)"
  summary up-to-date "HEAD and origin/$BRANCH are both $(git rev-parse --short HEAD)"
  exit 0
fi

COUNT="$(git rev-list --count "$OLD..$NEW")"
say "update available: ${OLD:0:7} -> ${NEW:0:7} ($COUNT commit(s) on $BRANCH)"
git --no-pager log --oneline "$OLD..$NEW" | sed 's/^/    /'

if [ "$CHECK" = "1" ]; then
  say "(--check) not applying. Run 'bash scripts/update.sh' to apply."
  summary update-available "${OLD:0:7} -> ${NEW:0:7} ($COUNT commit(s) on $BRANCH)"
  exit 10
fi

if [ "$ASSUME_YES" != "1" ]; then
  printf '\033[36m[%s]\033[0m apply this update now? [y/N] ' "$IRISES_LOG_TAG"
  read -r yn || yn=''    # EOF (piped stdin) must not abort under set -e
  case "$yn" in
    y|Y|yes|YES) ;;
    *) say "aborted — nothing changed"; summary noop "aborted at the confirmation prompt"; exit 0 ;;
  esac
fi

# Who holds the port — the last thing checked before the first thing changes. If :$PORT answers but
# there is no live pid of ours and no service to cycle, then the restart at the end of this run
# cannot succeed: something else (almost always `npm run dev` in another terminal) owns that bind.
# The check used to live inside irises_restart_verify, which is far too late to be useful — by then a
# perfectly good update had been merged, built and receipted, and refusing there rolled all of it
# back and signed off telling the reader Irises was down, while the dev server went on answering.
# It then lived in preflight, ABOVE the fetch and the compare, which is too early: a box that had
# nothing to apply exited 1 over a port nobody was going to touch instead of reporting
# `RESULT: up-to-date`. Here is the one spot that is both: every read-only outcome (up-to-date,
# noop, update-available, the confirmation abort) has already reported and exited, and the
# fast-forward below is still one line away, so a refusal here changes nothing. `--check` exits
# above this line, and `--no-restart` never touches the process, so neither cares who has the port.
if [ "$DO_RESTART" = "1" ] \
   && tcp_open 127.0.0.1 "$PORT" && [ -z "$(server_pid)" ] && ! service_installed; then
  err "a process that is not the managed Irises is listening on :$PORT:"
  err "  there is no live pid in $STATE_DIR/irises.pid, and no Irises service is installed"
  err "the usual cause is a dev server (npm run dev) in another terminal."
  err "stop it and re-run. Nothing has been changed — this refusal is before the pull."
  err "(or apply to disk only, and restart Irises yourself: bash scripts/update.sh --no-restart)"
  exit 1
fi

# ── apply, with a rollback around the parts that can fail ────────────────────
# HUP has been ignored since the lock, up at the top. What is added here is the other half: the two
# signals that SHOULD end a run — a Ctrl+C, a supervisor's SIGTERM — now end it THROUGH the guard,
# so from the first changed byte onwards there is no way out that skips releasing the lock and
# leaving the one `RESULT:` line a caller parses.
trap 'lifecycle_exit_guard 130' INT
trap 'lifecycle_exit_guard 143' TERM

# The exact sha we compared and listed above, not the ref: what gets applied is what was announced.
say "fast-forwarding to origin/$BRANCH (${NEW:0:7})"
git merge --ff-only "$NEW" || {
  err "fast-forward failed — your local $BRANCH has diverged from origin."
  err "reconcile it yourself (git log, git rebase/merge) — this updater never force-merges."
  exit 1
}

say "installing dependencies + building (npm ci --include=dev && npm run build)"
warn_if_low_memory
if ! ( npm ci --include=dev && npm run build ); then
  err "the build failed at ${NEW:0:7}"
  rollback_to "$OLD" || {
    summary partial \
      "an undo FAILED: the build failed at ${NEW:0:7} and the rollback could not put the clone back" \
      "the tree, node_modules and dist may all disagree — see the commands above" \
      "the running server was never touched; it is still serving whatever it had"
    exit 3
  }
  summary rolled-back \
    "build failed at ${NEW:0:7}; the clone is back at ${OLD:0:7}" \
    "the running server was never touched — it is still serving ${OLD:0:7}" \
    "plugin:   untouched (still the previous copy)"
  exit 3
fi
NEW_BUILT="$(built_sha "$ROOT")"
if [ -z "$NEW_BUILT" ]; then
  # dist/version.json carries no sha (scripts/stamp-version.js could not reach git). The server
  # falls back to `git rev-parse HEAD` for /health in exactly that case, so the sha to expect is
  # still the one we merged — never an empty expectation, which would accept ANY answer.
  warn "the build left no sha in dist/version.json — verifying against ${NEW:0:7} instead"
  NEW_BUILT="$NEW"
fi
say "built ${NEW_BUILT:0:7}"

WEB_MARKER="$(mktemp 2>/dev/null || printf '')"
web_build "$ROOT"
WEB_STATE="$(web_state)"
[ -z "$WEB_MARKER" ] || rm -f "$WEB_MARKER"

write_receipt "$(receipt_base "$OLD" "$NEW")" "$NEW"

RESTART_STATE="skipped (--no-restart) — the new build is on disk, not running"
if [ "$DO_RESTART" = "1" ]; then
  if irises_restart_verify "$ROOT" "$PORT" "$NEW_BUILT" 45; then
    RESTART_STATE="restarted, build ${NEW_BUILT:0:7} verified live"
  else
    # The new build compiles but will not serve. Take the receipt back, restore the old build, and
    # put it back up.
    withdraw_receipt
    err "the new build did not come up — rolling back"
    if rollback_to "$OLD"; then
      if irises_restart_verify "$ROOT" "$PORT" "$OLD" 45; then
        bounce_gateway || true
        summary rolled-back \
          "${NEW:0:7} would not serve; rolled back to ${OLD:0:7}" \
          "Irises is back up on the OLD build — nothing was announced in chat" \
          "plugin:   untouched (still the previous copy)" \
          "gateway:  $GATEWAY_STATE" \
          "the failure is in $STATE_DIR/logs/server.log"
        exit 4
      fi
      summary rolled-back \
        "${NEW:0:7} would not serve; the clone is back at ${OLD:0:7}, but it did not come back up" \
        "plugin:   untouched (still the previous copy)" \
        "Irises is DOWN — read $STATE_DIR/logs/server.log, then: cd $ROOT && npm start"
      exit 4
    fi
    summary partial \
      "an undo FAILED: ${NEW:0:7} would not serve and the rollback could not put the clone back" \
      "the tree, node_modules and dist may all disagree — see the commands above" \
      "Irises is DOWN — put the clone back by hand first, then: cd $ROOT && npm start"
    exit 4
  fi
else
  say "(--no-restart) the new build is on disk; restart Irises yourself to run it"
fi

# LAST, and only now. The bridge plugin is a COPY, so a repo update always leaves a stale one on the
# engine; it is refreshed every time (the gateway is bounced right below regardless, and "only when
# bridge/ changed" quietly skipped a refresh whenever a previous update's copy had failed). What it
# may NOT do is run before the restart is verified: a rollback undoes the clone, not the engine's
# copy, so a refresh up there left the engine loading the NEW plugin against OLD code — a mismatch
# nothing in either summary mentioned. The only ordering this step actually needs is to precede the
# bounce, since plugins load at gateway start.
ENGINE="$(engine_kind)"
PLUGIN_STATE="n/a (standalone install — no engine)"
if [ "$ENGINE" != "off" ]; then
  if plugin_refresh "$ENGINE" "$ROOT"; then
    PLUGIN_STATE="refreshed"
  else
    PLUGIN_STATE="NOT refreshed — see the warning above"
  fi
fi

GATEWAY_STATE="skipped (--no-gateway-restart)"
RC=0
RESULT=ok
if [ "$ENGINE" = "off" ]; then
  GATEWAY_STATE="n/a (standalone install)"
elif [ "$DO_GATEWAY" = "1" ]; then
  if gateway_restart "$ENGINE" 90; then
    GATEWAY_STATE="bounced and verified"
  else
    GATEWAY_STATE="NOT verified — bounce it yourself once you know why"
    RESULT=gateway-failed
    RC=5
  fi
fi

ANNOUNCE="Irises will mention the upgrade in chat itself, once it is up"
if [ "$RECEIPT_OK" != "1" ]; then
  ANNOUNCE="no receipt was written, so nothing will be announced in chat — the upgrade still applied"
elif [ "$DO_RESTART" != "1" ]; then
  ANNOUNCE="she will mention the upgrade the next time she starts — the receipt is waiting"
fi
if [ "$(env_get "$ENV_FILE" UPDATE_ANNOUNCE_ENABLED)" = "false" ]; then
  ANNOUNCE="chat announcements are off (UPDATE_ANNOUNCE_ENABLED=false)"
fi

summary "$RESULT" \
  "updated:  ${OLD:0:7} -> ${NEW:0:7} ($COUNT commit(s) on $BRANCH)" \
  "web UI:   $WEB_STATE" \
  "plugin:   $PLUGIN_STATE" \
  "Irises:   $RESTART_STATE" \
  "gateway:  $GATEWAY_STATE" \
  "data:     $STATE_DIR — untouched, as always" \
  "$ANNOUNCE"
exit "$RC"
