#!/usr/bin/env bash
# Irises lifecycle end-to-end — install, update, repair, roll back, recover, uninstall, in a sandbox.
#
#   npm run e2e:lifecycle          # or: bash scripts/e2e/lifecycle-sandbox.sh
#   KEEP=1 npm run e2e:lifecycle   # leave the sandbox behind for inspection
#
# NOT part of `npm test`: it starts real servers, binds real ports and takes 3-4 minutes (two stages
# deliberately sit out a wait budget in full). It is the battery that would have caught every bug the unit
# tests cannot see — the ones that only exist when the lifecycle stages run in sequence against each
# other: a rollback that leaves the box with no server, a repair that never repairs, a plugin
# refreshed for code that was then undone, a second uninstall that bounces an engine for nothing.
#
# OFFLINE BY CONSTRUCTION. The scratch PATH carries a stub `npm`:
#   ci    -> hard-link-copies THIS repo's node_modules into the sandbox clone
#   build -> runs the real node_modules/.bin/tsc + cpx + scripts/stamp-version.js
#   web   -> a logged no-op
# So there is no registry traffic, and the build is still a real compile: the two failure stages
# below publish commits that genuinely do not compile, and genuinely compile and then die at module
# load — the cases no unit test can stage.
#
# WHAT IT ASSERTS, in order:
#   1   install    — detached start, /health serving the sha that was built, plugin copied to the
#                    stub engine, engine .env carrying our keys, manifest written, engine CLI called.
#                    The engine's .env is PRE-SEEDED with keys of its own, so this is also where the
#                    push token has to be adopted rather than replaced and IRISES_URL taken over out loud
#   1b  install×2   — a re-run adopts the running server, appends no key twice, the manifest still
#                    names OUR keys as ours instead of forgetting them to "pre-existing", and the
#                    restore point stays the FIRST install's backup
#   2   update      — a commit published to the fake origin is applied, the LIVE sha flips to it, the
#                    receipt is written, the plugin is refreshed, the engine CLI is called, and the
#                    whole run is readable afterwards in $IRISES_HOME/logs/update.log
#   2b  repair      — dist/version.json stamped from a sha nobody has: HEAD is current, so this is
#                    not an update but an unfinished build, and it is rebuilt and re-verified
#   3a  exit 3      — a commit that does not compile: the tree, dist and node_modules all go back,
#                    and the running server is never touched (same pid, same sha, still answering)
#   3   exit 4      — a commit that COMPILES and throws at module load: rolled back, the OLD build is
#                    serving again, and the engine's plugin was NOT refreshed for code that is gone
#   3b  recovery    — the box moves forward again after a rollback, and NOW the plugin is refreshed
#   3c  exit 5      — Irises is updated and live, but the engine's gateway cannot be verified back
#                    up: the update is not undone, and the run says so with its own exit code
#   4   uninstall   — the server stops, the plugin dir is gone, our keys are stripped from the engine
#                    .env, the pre-existing keys this install CHANGED come back to their pre-install
#                    values while an operator edit made after the install survives untouched, the
#                    stale manifest goes, and $IRISES_HOME is KEPT. The engine's .env is compared with
#                    cmp against the file from before stage 1, with that one operator edit applied:
#                    byte-identical, or this stage fails. It runs after TWO installs, so this is also
#                    where 1b's manifest memory is proved
#   5   uninstall×2 — a second one in a row changes nothing: no fresh backup, no gateway bounce, and
#                    — with the manifest now gone — no key deleted just because it is named IRISES_*
#   6   held port   — a foreign listener on our port (`npm run dev`, in real life) is refused in
#                    PREFLIGHT: exit 1, nothing merged, nothing built, no receipt, and the other
#                    process still holding the port it started with
#   7   full wiring — an install onto an engine that ALREADY carries every key Irises writes: it adds
#                    none, so its keysAdded is empty — and the uninstall still has to put the one key
#                    it RETARGETED back, which is the check the restore loop used to sit behind. The
#                    seed also holds a present-but-EMPTY IRISES_BRIDGE_TOKEN, which is not a secret to
#                    adopt: the install writes its own value there and records the move, and the cmp
#                    at the end proves the empty line came back
#   8   the menu    — scripts/irises.sh driven by answers on stdin: the flags it composes are printed
#                    and compared literally, and the install they produce is the one the answers
#                    described — a model override on all three voice roles with ENGINE_MODEL_INHERIT
#                    off, the key passed only through the environment, a narrowed IRISES_FRONT and
#                    the two optional extras. Then the same menu DETACHES (engine .env back to
#                    cmp-equal, plugin gone, Irises still serving) and finally uninstalls with an
#                    archive and a purge, the "type the word delete" gate answered at the menu
#                    rather than by a flag
#   8a  configure   — the same menu changing what 8 chose, one setting at a time and without an
#                    `npm ci` anywhere: a timezone, the browser chat, the front scope, the model
#                    handed back to the engine, one generic key, and last a PORT MOVE. Each answer
#                    has to come out as the right flag, land in the right file (this clone's .env,
#                    the engine's, the manifest) and cost exactly the restart it is worth — Irises
#                    is cycled and re-verified on the same build for a change she reads at boot,
#                    left alone for one only the engine reads, and the gateway is bounced for the
#                    engine's two. The key from stage 8 never reaches the screen again
#
# NOTHING OF YOURS IS TOUCHED. Every stage runs under a throwaway HOME, IRISES_HOME and HERMES_HOME,
# on two ephemeral ports, against a bare origin made from this clone's own objects. The scratch PATH
# is $BIN first, and the three service-manager probes on it are FAILING STUBS rather than absences:
# the library's augment_path re-appends /bin and /usr/bin on every run, so a tool cannot be kept off
# PATH by leaving it out of $BIN — and with the real ones visible, this box's own running engine
# gateway answers the library's service probe and stage 3c can never see its 90s budget expire.
# Stubs that log and exit 1 are how the sandbox stays blind to the machine it runs on.
set -euo pipefail

REPO="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
SANDBOX="$REPO/scripts/e2e/.sandbox"
PASS=0
FAIL=0
STARTED="$(date +%s)"

step()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
ok()    { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()   { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check() { # DESCRIPTION CONDITION-COMMAND…
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}
contains() { case "$2" in *"$1"*) return 0 ;; esac; return 1; }
check_out() { # DESCRIPTION NEEDLE HAYSTACK
  if contains "$2" "$3"; then ok "$1"; else bad "$1 — expected to find: $2"; fi
}
check_no_out() { # DESCRIPTION NEEDLE HAYSTACK
  if contains "$2" "$3"; then bad "$1 — found: $2"; else ok "$1"; fi
}
check_rc() { # DESCRIPTION WANT GOT
  if [ "$2" = "$3" ]; then ok "$1 (exit $2)"; else bad "$1 — exit $3, expected $2"; fi
}
present() { grep -q "$2" "$1" >/dev/null 2>&1; }          # FILE NEEDLE
absent()  { ! grep -q "$2" "$1" >/dev/null 2>&1; }        # FILE NEEDLE
say_sha() { printf '%s' "${1:0:7}"; }

# pgrep IS on the scratch PATH, as a failing stub — that is how the sandbox stays blind to this
# box's own processes (see the header). So the sweep at exit keeps its own absolute handle on the
# real one, taken here before the PATH swap. It only ever matches paths inside the sandbox.
REAL_PGREP="$(command -v pgrep 2>/dev/null || true)"

cleanup() {
  local pid p
  if [ -n "${STATE:-}" ] && [ -f "$STATE/irises.pid" ]; then
    pid="$(cat "$STATE/irises.pid" 2>/dev/null || true)"
    case "${pid:-}" in ''|*[!0-9]*) ;; *) kill "$pid" 2>/dev/null || true ;; esac
  fi
  if [ -n "${CLONE:-}" ] && [ -n "$REAL_PGREP" ]; then
    for p in $("$REAL_PGREP" -f "$CLONE/dist/index.js" 2>/dev/null || true); do
      kill "$p" 2>/dev/null || true
    done
  fi
  foreign_listener_stop
  engine_stub_stop
  if [ "${KEEP:-0}" != "1" ]; then rm -rf "$SANDBOX"; else printf '\nsandbox kept at %s\n' "$SANDBOX"; fi
}

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"
HOME_DIR="$SANDBOX/home"
BIN="$SANDBOX/bin"
ORIGIN="$SANDBOX/origin.git"
CLONE="$SANDBOX/clone"
STATE="$SANDBOX/irises-home"
HERMES="$SANDBOX/engine"
UP="$SANDBOX/upstream"
STUB_LOG="$SANDBOX/stub.log"
mkdir -p "$HOME_DIR" "$BIN" "$STATE" "$HERMES/plugins"
: > "$STUB_LOG"

# Three free high ports, taken in ONE process so they cannot come back equal: a developer's own
# Irises on :3000 and their own engine on :8642 are never disturbed. The third is where stage 8a
# MOVES Irises to, and it has to be free for the same reason the first two do — configure.sh
# refuses a port something already listens on, in preflight, before it writes a byte.
# "Free, not reserved": the kernel handed these out and they were closed again, so a stranger could
# in principle take one between here and the bind. Nothing in this sandbox binds them but us.
PORTS="$(node -e '
const net = require("net");
const a = net.createServer(), b = net.createServer(), c = net.createServer();
a.listen(0, "127.0.0.1", () => b.listen(0, "127.0.0.1", () => c.listen(0, "127.0.0.1", () => {
  process.stdout.write(a.address().port + " " + b.address().port + " " + c.address().port);
  a.close(); b.close(); c.close();
})));
')"
SRV_PORT="$(printf '%s' "$PORTS" | cut -d' ' -f1)"
ENGINE_PORT="$(printf '%s' "$PORTS" | cut -d' ' -f2)"
SRV_PORT2="$(printf '%s' "$PORTS" | cut -d' ' -f3)"

# The stub engine's health surface, so the library's gateway probe has something real to verify a
# bounce against. Started and stopped by name, because stage 3c takes it away on purpose.
HERMES_SRV=""
engine_stub_start() {
  node -e "
const http = require('http');
http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end('{\"status\":\"ok\"}'); })
  .listen($ENGINE_PORT, '127.0.0.1');
" &
  HERMES_SRV=$!
}
engine_stub_stop() {
  if [ -n "${HERMES_SRV:-}" ]; then
    kill "$HERMES_SRV" 2>/dev/null || true
    wait "$HERMES_SRV" 2>/dev/null || true
    HERMES_SRV=""
  fi
}

# A listener that is NOT ours, holding OUR port, with no pidfile behind it: stage 6's stand-in for
# the `npm run dev` a developer left running in another terminal. It accepts a connection and closes
# it — the bind is the whole point, not the protocol.
FOREIGN_SRV=""
foreign_listener_up() { (exec 3<>"/dev/tcp/127.0.0.1/$SRV_PORT") 2>/dev/null; }
foreign_listener_start() {
  local i=0
  node -e "require('net').createServer(s => s.end()).listen($SRV_PORT, '127.0.0.1');" &
  FOREIGN_SRV=$!
  while [ "$i" -lt 15 ]; do
    if foreign_listener_up; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}
foreign_listener_stop() {
  if [ -n "${FOREIGN_SRV:-}" ]; then
    kill "$FOREIGN_SRV" 2>/dev/null || true
    wait "$FOREIGN_SRV" 2>/dev/null || true
    FOREIGN_SRV=""
  fi
}
trap cleanup EXIT

step "sandbox at $SANDBOX (Irises :$SRV_PORT, stub engine :$ENGINE_PORT, 8a moves her to :$SRV_PORT2)"

# ── the scratch PATH ──────────────────────────────────────────────────────────
# nohup and setsid are what server_start_detached needs (setsid is absent on macOS and skipped by
# this loop). ls, cmp and diff are here because the checks below shell out to them — cmp is how the
# uninstall stage proves the engine's .env came back byte-for-byte, and diff prints it when it did not.
for tool in bash sh cat cp rm mv ls mkdir chmod find grep sed head tail cut tr sleep date printf ps \
            uname id dirname basename du curl node git awk sort stat env mktemp kill touch ln wc od \
            cmp diff xargs nohup setsid; do
  real="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$real" ] && [ ! -e "$BIN/$tool" ]; then ln -s "$real" "$BIN/$tool"; fi
done

# npm: offline, and a real compile. `ci` hard-links this repo's node_modules (cp -al where the
# filesystem allows it, cp -R otherwise); `build` runs the actual toolchain out of it. The
# destination is cleared before EITHER copy: a `cp -al` that failed part-way still leaves a
# directory behind, and `cp -R src dst` into an existing dst nests it as dst/node_modules.
cat > "$BIN/npm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "\$*" >> "$STUB_LOG"
case "\$*" in
  *"--prefix"*) exit 0 ;;                       # web install/build: a logged no-op
  *"run build:web"*) exit 0 ;;
  ci*|*" ci"*)
    rm -rf "$CLONE/node_modules"
    cp -al "$REPO/node_modules" "$CLONE/node_modules" 2>/dev/null \
      || { rm -rf "$CLONE/node_modules"; cp -R "$REPO/node_modules" "$CLONE/node_modules"; }
    exit 0 ;;
  *"run build"*)
    cd "$CLONE"
    ./node_modules/.bin/tsc
    ./node_modules/.bin/cpx "src/agents/**/*.md" dist/agents
    ./node_modules/.bin/cpx "src/**/*.txt" dist
    node scripts/stamp-version.js
    exit 0 ;;
  *"install --no-save"*) exit 0 ;;
esac
exit 0
EOF
chmod +x "$BIN/npm"

# The engine CLIs: log argv and succeed. Every lifecycle claim about "the engine was told" is checked
# against this log.
for stub in hermes openclaw; do
  cat > "$BIN/$stub" <<EOF
#!/usr/bin/env bash
printf '$stub %s\n' "\$*" >> "$STUB_LOG"
exit 0
EOF
  chmod +x "$BIN/$stub"
done

# The service managers: log argv and FAIL. See the header — this is what keeps the sandbox from
# reading (or driving) the real box's own services and processes.
for stub in systemctl launchctl pgrep; do
  cat > "$BIN/$stub" <<EOF
#!/usr/bin/env bash
printf 'STUB-$stub %s\n' "\$*" >> "$STUB_LOG"
exit 1
EOF
  chmod +x "$BIN/$stub"
done

# The engine's .env as a developer's own hermes already has it: four keys that were there BEFORE
# Irises, two of which the installer wants for itself.
#
#   IRISES_PUSH_TOKEN  one secret shared with the clone (ENGINE_PUSH_TOKEN there), so it is ADOPTED,
#                      never replaced. A throwaway install that wrote its own token over this one
#                      left the developer's REAL Irises 403ing on every engine push — and the
#                      uninstall, correctly leaving a pre-existing key alone, kept the wrong value.
#                      Adopted also means NOT RESTORED: stage 4 rotates it by hand between the
#                      install and the uninstall, and the uninstall has to leave the new value alone.
#   IRISES_URL         has to name THIS install, so it is taken over — loudly — and put back from
#                      the pre-install backup by --uninstall.
#
# $ENGINE_SEED is the byte-for-byte comparison the last uninstall stage makes: this exact file, plus
# the one line stage 4 rotates, is what the engine's .env has to come back to.
printf 'ANTHROPIC_API_KEY=engine-owned-key\nAPI_SERVER_KEY=pre-existing-engine-key\nIRISES_PUSH_TOKEN=pre-existing-push-token\nIRISES_URL=http://127.0.0.1:1\n' > "$HERMES/.env"
ENGINE_SEED="$SANDBOX/engine-env.seed"
cp "$HERMES/.env" "$ENGINE_SEED"

export PATH="$BIN"
export HOME="$HOME_DIR"
export IRISES_HOME="$STATE"
# irises_home() reads $(irises_root)/.env before the shell, and irises_root honours an exported
# IRISES_ROOT — one left pointing at a real clone would aim stage 8c's purge at the real home.
unset IRISES_ROOT
export HERMES_HOME="$HERMES"
export NO_COLOR=1
export STUB_LOG

engine_stub_start

# ── readers ───────────────────────────────────────────────────────────────────
health_sha() { # the sha /health reports, or empty
  local body got
  body="$(curl -fsS -m 5 "http://127.0.0.1:$SRV_PORT/health" 2>/dev/null || true)"
  got="$(printf '%s' "$body" | grep -o '"sha":"[0-9a-f]\{7,40\}"' | head -1 | cut -d'"' -f4 || true)"
  printf '%s' "$got"
}
expect_sha() { # DESCRIPTION WANT
  local desc="${1:-}" want="${2:-}" got
  got="$(health_sha)"
  # Prefix comparison, both ways, exactly as the library's wait_health_sha does it: /health is free
  # to report a short sha, and the shas this harness holds are full ones. An exact `=` here would
  # turn a correct server into a red line the moment either side shortened.
  if [ -n "$got" ] && [ -n "$want" ]; then
    case "$got" in "$want"*) ok "$desc ($(say_sha "$want"))"; return 0 ;; esac
    case "$want" in "$got"*) ok "$desc ($(say_sha "$want"))"; return 0 ;; esac
  fi
  bad "$desc — /health serves '${got:-nothing}', expected $(say_sha "$want")"
  return 0
}
dist_sha() { # the sha dist/ was stamped from, or empty
  local v
  v="$(grep -o '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]\{7,40\}"' "$CLONE/dist/version.json" 2>/dev/null \
       | head -1 | cut -d'"' -f4 || true)"
  printf '%s' "$v"
}
srv_pid() { cat "$STATE/irises.pid" 2>/dev/null || true; }
key_count() { # FILE KEY
  grep -c "^$2=" "$1" 2>/dev/null || true
}
backups() { ls "$HERMES"/.env.bak-irises-* 2>/dev/null || true; }

# ── the fake origin, the clone, and the upstream working copy ─────────────────
step "publishing a fake origin from $REPO"
git init --quiet --bare "$ORIGIN"
git clone --quiet --no-hardlinks "$REPO" "$CLONE" >/dev/null 2>&1
git -C "$CLONE" remote set-url origin "$ORIGIN"
git -C "$CLONE" config user.name "Irises E2E"
git -C "$CLONE" config user.email "e2e@example.invalid"
BRANCH="$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)"
git -C "$CLONE" push --quiet origin "$BRANCH"
BASE_SHA="$(git -C "$CLONE" rev-parse HEAD)"
# `git init --bare` points HEAD at its own default name (master/main), which is NOT the branch this
# clone is on — so a clone of this origin would land on an unborn branch of the wrong name and every
# push below would fail with "src refspec does not match any". Say what the default branch is, and
# then ask for it by name as well.
git -C "$ORIGIN" symbolic-ref HEAD "refs/heads/$BRANCH"

git clone --quiet --branch "$BRANCH" "$ORIGIN" "$UP"
git -C "$UP" config user.name "Irises E2E"
git -C "$UP" config user.email "e2e@example.invalid"

# A harness that keeps going on a broken sandbox reports the lifecycle scripts as failing when it is
# the sandbox that failed. Every step that builds the fixture is guarded and stops the run instead.
fatal() { printf '\n\033[1;31mHARNESS ERROR\033[0m %s\n\nRESULT: failed\n' "$*"; exit 1; }

# Publish a commit upstream and print its sha. TEXT is appended to src/index.ts, which every stage
# here needs anyway: it is the module whose compile and whose module-load are what fail below.
# Every step returns 1 on its own — errexit does not reliably leave a `$( )` used in an assignment.
publish() { # MESSAGE TEXT
  git -C "$UP" pull --quiet --ff-only origin "$BRANCH" || return 1
  printf '\n%s\n' "$2" >> "$UP/src/index.ts" || return 1
  git -C "$UP" commit --quiet -am "$1" || return 1
  git -C "$UP" push --quiet origin "$BRANCH" || return 1
  git -C "$UP" rev-parse HEAD
}
# Take a published commit back out, so the stages after it see an origin that builds and boots.
unpublish() { # SHA
  git -C "$UP" revert --no-edit "$1" >/dev/null || return 1
  git -C "$UP" push --quiet origin "$BRANCH" || return 1
  git -C "$UP" rev-parse HEAD
}

# The clone's own config: the stub engine, our high port, no web UI. The default data backend
# (SQLite under $IRISES_HOME) is what a real install uses, so it is left at its default here.
# UPDATE_CHECK_ENABLED=false is the one deliberate difference: the server's own checker fetches this
# clone every few minutes, and a background fetch racing the updater's fetch/merge/reset is neither
# what this battery is testing nor something it could tell apart from a real defect.
cat > "$CLONE/.env" <<EOF
OPS_BACKEND=hermes
HERMES_BASE_URL=http://127.0.0.1:$ENGINE_PORT
PORT=$SRV_PORT
ANTHROPIC_API_KEY=sandbox-not-a-real-key
UPDATE_CHECK_ENABLED=false
EOF
chmod 600 "$CLONE/.env"

# ── 1. install ────────────────────────────────────────────────────────────────
step "1/12  install"
set +e
INSTALL_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --engine hermes --yes --no-service 2>&1)"
INSTALL_RC=$?
set -e
printf '%s\n' "$INSTALL_OUT" | sed 's/^/    | /'
check_out "install ends with a RESULT line" "RESULT:" "$INSTALL_OUT"
check_rc "install succeeded" 0 "$INSTALL_RC"
expect_sha "/health serves the sha that was built" "$BASE_SHA"
check "the bridge plugin was copied to the engine" test -f "$HERMES/plugins/irises-bridge/plugin.yaml"
check "no __pycache__ came with it" test ! -d "$HERMES/plugins/irises-bridge/__pycache__"
check "the plugin was enabled through the engine CLI" present "$STUB_LOG" "hermes plugins enable irises-bridge"
check "the gateway was bounced" grep -qE "hermes gateway re?start" "$STUB_LOG"
check "the engine .env was backed up" test -n "$(backups)"
check "IRISES_FRONT was added to the engine" present "$HERMES/.env" '^IRISES_FRONT='
check "IRISES_BRIDGE_TOKEN was added to the engine" present "$HERMES/.env" '^IRISES_BRIDGE_TOKEN='
# The push token, adopted rather than replaced — in BOTH files, because a match is the whole point.
check "the clone adopted the engine's existing push token" \
  present "$CLONE/.env" '^ENGINE_PUSH_TOKEN=pre-existing-push-token$'
check "and the engine's own IRISES_PUSH_TOKEN still holds it" \
  present "$HERMES/.env" '^IRISES_PUSH_TOKEN=pre-existing-push-token$'
# IRISES_URL is the opposite rule: it has to name this install, so it is taken over out loud.
check_out "the install said IRISES_URL was taken over" "takes over" "$INSTALL_OUT"
check_out "and named the value it replaced" "pointed at http://127.0.0.1:1" "$INSTALL_OUT"
check "the engine now points IRISES_URL at this install" \
  present "$HERMES/.env" "^IRISES_URL=http://127.0.0.1:$SRV_PORT\$"
check "the manifest records IRISES_PUSH_TOKEN as pre-existing" \
  present "$STATE/install-manifest.json" '"keysPreExisting": "[^"]*IRISES_PUSH_TOKEN'
check "and IRISES_URL as pre-existing too" \
  present "$STATE/install-manifest.json" '"keysPreExisting": "[^"]*IRISES_URL'
# PRE-EXISTING is not the same question as CHANGED, and only the second one licenses a restore.
# IRISES_URL was taken over, so it is on the retarget list; the push token was adopted — the file
# still says exactly what it said — so it is not, and stage 4 is where that distinction pays.
check "and it records IRISES_URL as one it retargeted" \
  present "$STATE/install-manifest.json" '"keysRetargeted": "[^"]*IRISES_URL'
check "while the adopted push token is NOT on the retarget list" \
  absent "$STATE/install-manifest.json" '"keysRetargeted": "[^"]*IRISES_PUSH_TOKEN'
if [ "$(key_count "$HERMES/.env" API_SERVER_KEY)" = "1" ]; then
  ok "the pre-existing engine key was NOT duplicated"
else
  bad "API_SERVER_KEY appears $(key_count "$HERMES/.env" API_SERVER_KEY) time(s) in the engine .env"
fi
check "the manifest was written" test -f "$STATE/install-manifest.json"
check "the manifest names the plugin dir" present "$STATE/install-manifest.json" 'pluginDir'
check "the server wrote exactly one pidfile" test -f "$STATE/irises.pid"
check "and none in the clone root" test ! -f "$CLONE/irises.pid"
check "no service was installed (detached fallback)" test ! -f "$HOME_DIR/Library/LaunchAgents/ai.irises.server.plist"
# The install writes to this clone's .env, and the sandbox's whole isolation rests on two lines of
# it: our high port, and the stub engine's URL. An install that rewrote HERMES_BASE_URL to a
# default would point every later stage at whatever engine this box is really running.
check "the sandbox's engine URL survived the install" \
  present "$CLONE/.env" "HERMES_BASE_URL=http://127.0.0.1:$ENGINE_PORT"
check "and so did its port" present "$CLONE/.env" "^PORT=$SRV_PORT\$"

# ── 1b. the same install again ────────────────────────────────────────────────
# A second install finds every key the first one added ALREADY in the engine's .env. Classified by
# presence alone that made keysAdded empty, the manifest recorded the whole set as pre-existing, and
# stage 4's uninstall then left IRISES_BRIDGE_TOKEN, IRISES_FRONT and API_SERVER_ENABLED behind in
# the engine's .env — while the script's own header promises removal and invites you to "re-run it
# any time". The manifest has to carry its own memory forward, and the two uninstall stages below now
# run after TWO installs, so their removal assertions are the proof. The same re-run is also where a
# restore point can drift: install 2's own backup already holds install 1's IRISES_URL.
step "1b/12  re-install — idempotent, and the manifest keeps its memory"
: > "$STUB_LOG"
set +e
REINSTALL_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --engine hermes --yes --no-service 2>&1)"
REINSTALL_RC=$?
set -e
printf '%s\n' "$REINSTALL_OUT" | sed 's/^/    | /'
check_out "the re-install ends with a RESULT line" "RESULT:" "$REINSTALL_OUT"
check_rc "the re-install succeeded" 0 "$REINSTALL_RC"
check_out "it adopted the server that was already on the port" "this run will adopt it" "$REINSTALL_OUT"
check_out "and it read the previous manifest" "recorded these engine keys as ours" "$REINSTALL_OUT"
expect_sha "the same build is still what answers" "$BASE_SHA"
MAN="$STATE/install-manifest.json"
check "the manifest still remembers IRISES_BRIDGE_TOKEN as ours" \
  present "$MAN" '"keysAdded": "[^"]*IRISES_BRIDGE_TOKEN'
check "and IRISES_FRONT as ours too" present "$MAN" '"keysAdded": "[^"]*IRISES_FRONT'
check "while the engine's own API_SERVER_KEY is still not claimed" \
  present "$MAN" '"keysPreExisting": "[^"]*API_SERVER_KEY'
check "nor is the push token that was there before us" \
  present "$MAN" '"keysPreExisting": "[^"]*IRISES_PUSH_TOKEN'
# The backup the uninstall restores from has to stay the FIRST install's: this run's own snapshot
# already carries the IRISES_URL install 1 wrote, and restoring from that would put back a value of
# ours and call it the operator's.
check_out "the re-install kept the first install's backup as the restore point" \
  "restore from the first install's backup" "$REINSTALL_OUT"
# …and the list of keys to restore FROM it drifts the same way: this run found IRISES_URL already
# naming this install and changed nothing, so a list recomputed from this run alone would be empty
# and stage 4 would leave install 1's IRISES_URL behind for good.
check "the manifest still remembers IRISES_URL as retargeted, though this run moved nothing" \
  present "$MAN" '"keysRetargeted": "[^"]*IRISES_URL'
check "and still does not claim the push token it only ever adopted" \
  absent "$MAN" '"keysRetargeted": "[^"]*IRISES_PUSH_TOKEN'
if [ "$(key_count "$HERMES/.env" API_SERVER_KEY)" = "1" ]; then
  ok "API_SERVER_KEY is still counted once in the engine .env"
else
  bad "API_SERVER_KEY appears $(key_count "$HERMES/.env" API_SERVER_KEY) time(s) after two installs"
fi
if [ "$(key_count "$HERMES/.env" IRISES_PUSH_TOKEN)" = "1" ]; then
  ok "and IRISES_PUSH_TOKEN too — nothing was appended a second time"
else
  bad "IRISES_PUSH_TOKEN appears $(key_count "$HERMES/.env" IRISES_PUSH_TOKEN) time(s) after two installs"
fi
check "the pre-existing engine key still holds its own value" present "$HERMES/.env" 'pre-existing-engine-key'
check "the plugin is still in place" test -f "$HERMES/plugins/irises-bridge/plugin.yaml"

# ── 2. update ─────────────────────────────────────────────────────────────────
step "2/12  update — a real commit published upstream"
NEXT_SHA="$(publish "e2e: a harmless upstream change" "// e2e: a harmless upstream change")" \
  || fatal "could not publish the update commit to the fake origin"

set +e
CHECK_OUT="$(cd "$CLONE" && bash scripts/update.sh --check 2>&1)"
CHECK_RC=$?
set -e
check_rc "--check reports an available update by exit code" 10 "$CHECK_RC"
check_out "--check reports update-available" "RESULT: update-available" "$CHECK_OUT"
check "--check applied nothing" test "$(git -C "$CLONE" rev-parse HEAD)" = "$BASE_SHA"

: > "$STUB_LOG"
set +e
UPDATE_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
UPDATE_RC=$?
set -e
printf '%s\n' "$UPDATE_OUT" | sed 's/^/    | /'
check_rc "update succeeded" 0 "$UPDATE_RC"
check_out "update reports ok" "RESULT: ok" "$UPDATE_OUT"
expect_sha "the LIVE sha flipped — the new build is what answers" "$NEXT_SHA"
check "the plugin was refreshed again" present "$STUB_LOG" "hermes plugins enable irises-bridge"
check "the gateway was bounced again" grep -qE "hermes gateway re?start" "$STUB_LOG"
# The server consumes the receipt at boot and archives it under updates/ — either state proves it
# was written; a missing pair proves it was not.
if [ -f "$STATE/update-receipt.json" ] || [ -n "$(ls "$STATE"/updates/applied-*.json 2>/dev/null || true)" ]; then
  ok "the update receipt was written (pending or already archived by the boot announce)"
else
  bad "no receipt anywhere — Irises would never mention the upgrade"
fi
check "no update-status.json was left behind" test ! -f "$STATE/update-status.json"
# The run's own log. Everything from the lock onwards is tee'd into it, so an update whose SSH
# session dies in the build can still be read to the end afterwards — the whole point being that it
# reaches the RESULT line and not just the `tsc` line the operator last saw.
if [ -f "$STATE/logs/update.log" ] \
   && present "$STATE/logs/update.log" '=== update started' \
   && present "$STATE/logs/update.log" 'RESULT: ok'; then
  ok "the run was tee'd to logs/update.log, header and RESULT line included"
else
  bad "logs/update.log is missing, has no '=== update started' header, or stops before RESULT: ok"
fi

# ── 2b. repair ────────────────────────────────────────────────────────────────
# HEAD is current and origin has nothing new, but dist/ was stamped from a sha nobody has: a previous
# build (or its box) died half-way. Reporting "up to date" would strand that.
step "2b/12  repair — HEAD is current, dist/ was stamped from a sha that does not exist"
node -e '
const fs = require("fs"), f = process.argv[1];
const o = JSON.parse(fs.readFileSync(f, "utf8"));
o.sha = "0".repeat(40);
fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n");
' "$CLONE/dist/version.json"
: > "$STUB_LOG"
set +e
REPAIR_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
REPAIR_RC=$?
set -e
printf '%s\n' "$REPAIR_OUT" | sed 's/^/    | /'
check_rc "the repair succeeded" 0 "$REPAIR_RC"
check_out "the repair reports ok" "RESULT: ok" "$REPAIR_OUT"
check_out "and says what it repaired" "repaired an unfinished build" "$REPAIR_OUT"
check "dist/ was re-stamped from HEAD" test "$(dist_sha)" = "$NEXT_SHA"
expect_sha "the repaired build is the one answering" "$NEXT_SHA"
# The update that left dist/ half-built died before its plugin refresh too, so a repair finishes it.
check "a repair refreshes the engine's plugin" present "$STUB_LOG" "plugins enable irises-bridge"
check "and the restart takes the gateway with it" grep -qE "hermes gateway re?start" "$STUB_LOG"

# ── 2c. a local commit nobody pushed ──────────────────────────────────────────
# The operator's own commit, not on origin yet: nothing upstream to pull, and the box is still on the
# build from before it. The one command after a commit has to bring it live all the same — build,
# restart, plugin, gateway — rather than signing off "local is ahead, nothing to do".
step "2c/12  a local commit, unpushed — update still builds it and bounces the gateway"
printf '\n%s\n' "// e2e: a local, unpushed change" >> "$CLONE/src/index.ts"
git -C "$CLONE" -c user.name=e2e -c user.email=e2e@example.invalid commit --quiet -am "e2e: local only"
LOCAL_SHA="$(git -C "$CLONE" rev-parse HEAD)"
: > "$STUB_LOG"
set +e
LOCAL_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
LOCAL_RC=$?
set -e
printf '%s\n' "$LOCAL_OUT" | sed 's/^/    | /'
check_rc "the local build succeeded" 0 "$LOCAL_RC"
check_out "it reports ok" "RESULT: ok" "$LOCAL_OUT"
check "dist/ was stamped from the local commit" test "$(dist_sha)" = "$LOCAL_SHA"
expect_sha "the local build is the one answering" "$LOCAL_SHA"
check "the engine's plugin was refreshed" present "$STUB_LOG" "plugins enable irises-bridge"
check "and the gateway was bounced" grep -qE "hermes gateway re?start" "$STUB_LOG"
# Published now, so origin and the clone agree again for every stage after this one — they
# fast-forward onto origin, and a clone left ahead of it would diverge from their commits.
git -C "$CLONE" push --quiet origin "$BRANCH"
NEXT_SHA="$LOCAL_SHA"

# ── 3a. a build that does not compile ─────────────────────────────────────────
step "3a/12  rollback (exit 3) — a commit that does NOT compile"
BADBUILD_SHA="$(publish "e2e: does not compile" 'const irisesE2E: number = "not a number";')" \
  || fatal "could not publish the uncompilable commit to the fake origin"
# Start from no receipt at all, so "no receipt was left" below is an assertion about THIS stage. The
# repair in 2b writes one and the boot announce usually archives it, but "usually" is the word doing
# the work there — a run where it lingered would have made this stage pass on 2b's tidiness.
rm -f "$STATE/update-receipt.json"
PID_BEFORE="$(srv_pid)"
: > "$STUB_LOG"
set +e
BUILD_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
BUILD_RC=$?
set -e
printf '%s\n' "$BUILD_OUT" | sed 's/^/    | /'
check_rc "a build that fails exits 3" 3 "$BUILD_RC"
check_out "and reports rolled-back" "RESULT: rolled-back" "$BUILD_OUT"
check "the tree went back to the previous sha" test "$(git -C "$CLONE" rev-parse HEAD)" = "$NEXT_SHA"
check "dist/ is still the previous build" test "$(dist_sha)" = "$NEXT_SHA"
check "node_modules survived the rollback" test -d "$CLONE/node_modules/typescript"
expect_sha "the running server still answers" "$NEXT_SHA"
if [ -n "$PID_BEFORE" ] && [ "$(srv_pid)" = "$PID_BEFORE" ]; then
  ok "the server was never touched (still pid $PID_BEFORE)"
else
  bad "the server pid changed ($PID_BEFORE -> $(srv_pid)) — a failed BUILD must not restart anything"
fi
check "no receipt was left for a build that never ran" test ! -f "$STATE/update-receipt.json"
check "and the engine was told nothing" absent "$STUB_LOG" "plugins enable irises-bridge"
# shellcheck disable=SC2034  # set for the diff message below, and read from there
REVERT_BUILD_SHA="$(unpublish "$BADBUILD_SHA")" \
  || fatal "could not revert the uncompilable commit upstream"

# ── 3. a build that compiles and dies at boot ────────────────────────────────
step "3/12  rollback (exit 4) — a commit that COMPILES and crashes on boot"
# A top-level throw compiles cleanly and dies while the module is being loaded, before the listener
# ever runs: exactly the failure that used to leave the box with no server at all.
CRASH_SHA="$(publish "e2e: compiles fine, dies at boot" 'throw new Error("e2e boot crash");')" \
  || fatal "could not publish the boot-crash commit to the fake origin"
: > "$STUB_LOG"
set +e
ROLL_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
ROLL_RC=$?
set -e
printf '%s\n' "$ROLL_OUT" | sed 's/^/    | /'
check_rc "a build that will not serve exits 4" 4 "$ROLL_RC"
check_out "and reports rolled-back" "RESULT: rolled-back" "$ROLL_OUT"
# Back to where the CLONE was, which is not the same thing as "one commit back": stage 3a left this
# clone at $NEXT_SHA, so the revert and the crash commit both arrive in this one update, and the only
# build there is to return to is the one that was on disk.
check "the tree went back to the sha this clone was on" test "$(git -C "$CLONE" rev-parse HEAD)" = "$NEXT_SHA"
check "dist/ was re-stamped from the sha it went back to" test "$(dist_sha)" = "$NEXT_SHA"
check "the bad sha is not what dist was stamped from" absent "$CLONE/dist/version.json" "$CRASH_SHA"
expect_sha "the OLD build is serving again — the box is not left down" "$NEXT_SHA"
# "started", not "restarted": the crashed build took the process with it, so the rollback had
# nothing to cycle and had to bring one up from nothing. The needle keeps the tag's `] ` in front
# precisely because "restarted — build" contains "started — build".
check_out "the rollback restart says started (nothing was running)" "] started — build" "$ROLL_OUT"
check "the receipt for the failed build was withdrawn" test ! -f "$STATE/update-receipt.json"
check "node_modules survived the rollback" test -d "$CLONE/node_modules/typescript"
# The refresh runs only AFTER a verified restart. Before that fix a rollback left the engine loading
# the NEW plugin against code that had just been undone, and neither summary mentioned it.
check "the engine still has its plugin" test -f "$HERMES/plugins/irises-bridge/plugin.yaml"
check "the plugin was NOT refreshed for code that was undone" absent "$STUB_LOG" "plugins enable irises-bridge"

# ── 3b. forward again ─────────────────────────────────────────────────────────
step "3b/12  recovery — the box moves forward again after a rollback"
RECOVER_SHA="$(unpublish "$CRASH_SHA")" \
  || fatal "could not revert the boot-crash commit upstream"
: > "$STUB_LOG"
set +e
RECOVER_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
RECOVER_RC=$?
set -e
printf '%s\n' "$RECOVER_OUT" | sed 's/^/    | /'
check_rc "the next update succeeds" 0 "$RECOVER_RC"
check_out "and reports ok" "RESULT: ok" "$RECOVER_OUT"
expect_sha "the LIVE sha is the recovered one" "$RECOVER_SHA"
check "NOW the plugin is refreshed" present "$STUB_LOG" "hermes plugins enable irises-bridge"
check "and the gateway is bounced" grep -qE "hermes gateway re?start" "$STUB_LOG"

# ── 3c. the engine's gateway never comes back ────────────────────────────────
# Irises IS updated and live; it is the ENGINE that cannot be verified. That is exit 5, not a
# rollback: undoing a perfectly good update because someone else's service is down would be worse
# than saying so. This stage sits out the library's 90s budget once, on purpose.
step "3c/12  exit 5 — Irises updates, the engine's gateway cannot be verified"
GW_SHA="$(publish "e2e: another harmless upstream change" "// e2e: another harmless upstream change")" \
  || fatal "could not publish the last update commit to the fake origin"
engine_stub_stop
: > "$STUB_LOG"
set +e
GW_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
GW_RC=$?
set -e
printf '%s\n' "$GW_OUT" | sed 's/^/    | /'
check_rc "an unverifiable gateway exits 5" 5 "$GW_RC"
check_out "and reports gateway-failed" "RESULT: gateway-failed" "$GW_OUT"
check_out "the summary says the bounce was not verified" "NOT verified" "$GW_OUT"
expect_sha "Irises itself IS updated and live" "$GW_SHA"
check "the tree is at the new sha" test "$(git -C "$CLONE" rev-parse HEAD)" = "$GW_SHA"
check_no_out "nothing was rolled back" "RESULT: rolled-back" "$GW_OUT"
check "the bounce was attempted through the engine CLI" grep -qE "hermes gateway re?start" "$STUB_LOG"
check "and the service-manager probe was blind, as the sandbox intends" present "$STUB_LOG" "STUB-"
engine_stub_start

# ── 4. uninstall ──────────────────────────────────────────────────────────────
step "4/12  uninstall — data kept"
: > "$STUB_LOG"
printf 'sandbox\n' > "$STATE/memories-canary.txt"
# THE OPERATOR EDITS THE ENGINE'S .env AFTER THE INSTALL, which is the normal case and not a corner:
# a token rotated because it leaked, a key changed when the engine moved. The installer adopted this
# one, so it never carried a value of ours — and an uninstall that "restored" every pre-existing key
# would put install-day's token back and 403 every other client of the engine on a schedule nobody
# would connect to an Irises removal. Written the way env_set writes (temp file, then copy back onto
# the same inode, so the 0600 and the ownership stand); `sed -i` is not portable to bash 3.2/macOS.
ROTATED_TOKEN="operator-rotated-token"
sed "s/^IRISES_PUSH_TOKEN=.*/IRISES_PUSH_TOKEN=$ROTATED_TOKEN/" "$HERMES/.env" > "$SANDBOX/rotate.tmp"
cat "$SANDBOX/rotate.tmp" > "$HERMES/.env"
rm -f "$SANDBOX/rotate.tmp"
check "the operator's rotation landed in the engine .env" \
  present "$HERMES/.env" "^IRISES_PUSH_TOKEN=$ROTATED_TOKEN\$"
# The comparison file moves with it: the engine's .env must come back to the pre-install file WITH
# this one edit — no more (a restore that stamped on it) and no less (a removal that dropped it).
ENGINE_SEED_ROTATED="$SANDBOX/engine-env.seed-rotated"
sed "s/^IRISES_PUSH_TOKEN=.*/IRISES_PUSH_TOKEN=$ROTATED_TOKEN/" "$ENGINE_SEED" > "$ENGINE_SEED_ROTATED"
set +e
UNINSTALL_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --uninstall --yes 2>&1)"
UNINSTALL_RC=$?
set -e
printf '%s\n' "$UNINSTALL_OUT" | sed 's/^/    | /'
check_rc "uninstall succeeded" 0 "$UNINSTALL_RC"
check_out "uninstall reports ok" "RESULT: ok" "$UNINSTALL_OUT"
if curl -fsS -m 3 "http://127.0.0.1:$SRV_PORT/health" >/dev/null 2>&1; then
  bad "the server is STILL answering on :$SRV_PORT"
else
  ok "the server stopped"
fi
check "the plugin dir is gone" test ! -d "$HERMES/plugins/irises-bridge"
check "the plugin was disabled through the engine CLI" present "$STUB_LOG" "hermes plugins disable irises-bridge"
check "the gateway was bounced so the engine forgets it" grep -qE "hermes gateway re?start" "$STUB_LOG"
check "IRISES_BRIDGE_TOKEN was stripped from the engine" absent "$HERMES/.env" '^IRISES_BRIDGE_TOKEN='
check "IRISES_FRONT was stripped too" absent "$HERMES/.env" '^IRISES_FRONT='
check "and API_SERVER_ENABLED, which this install added" absent "$HERMES/.env" '^API_SERVER_ENABLED='
check "no orphaned Irises marker comment was left" absent "$HERMES/.env" 'added by Irises setup'
check "the engine's OWN key survived" present "$HERMES/.env" '^ANTHROPIC_API_KEY=engine-owned-key'
check "the pre-existing API_SERVER_KEY survived" present "$HERMES/.env" 'pre-existing-engine-key'
# The two keys the install had designs on, and the whole rule in one pair. The token was ADOPTED, so
# the operator's own rotation from a minute ago is what stands — NOT the pre-install value, which is
# what restoring every pre-existing key would have left here. IRISES_URL was TAKEN OVER, so it comes
# BACK — from the first install's pre-install backup.
check "the token the operator rotated after the install is still the rotated one" \
  present "$HERMES/.env" "^IRISES_PUSH_TOKEN=$ROTATED_TOKEN\$"
check "and it was NOT reverted to the pre-install value" \
  absent "$HERMES/.env" '^IRISES_PUSH_TOKEN=pre-existing-push-token$'
check "IRISES_URL is back to the value the engine had" \
  present "$HERMES/.env" '^IRISES_URL=http://127.0.0.1:1$'
check_out "and the uninstall said so, by name" "restored IRISES_URL to its pre-install value" "$UNINSTALL_OUT"
check_no_out "while it never claimed to restore the key it only adopted" \
  "restored IRISES_PUSH_TOKEN" "$UNINSTALL_OUT"
check "the stale manifest is gone" test ! -f "$STATE/install-manifest.json"
check_out "and the summary says so" "manifest: removed" "$UNINSTALL_OUT"
# The strongest assertion in the battery: not "our keys went" but "the file came back". Two installs
# and an uninstall, and the engine's .env is the same bytes it was before any of it, bar the one line
# the operator rotated above — same keys, same values, same order, no stray blank line where a block
# used to be.
check "the engine .env is byte-identical to the file before stage 1, with the operator's edit intact" \
  cmp -s "$ENGINE_SEED_ROTATED" "$HERMES/.env"
if ! cmp -s "$ENGINE_SEED_ROTATED" "$HERMES/.env"; then diff -u "$ENGINE_SEED_ROTATED" "$HERMES/.env" | sed 's/^/    | /' || true; fi
check "the pidfile is gone" test ! -f "$STATE/irises.pid"
check "the data directory is KEPT" test -d "$STATE"
check "and so is what was in it" test -f "$STATE/memories-canary.txt"
check_out "the exact rm was printed rather than run" "rm -rf $STATE" "$UNINSTALL_OUT"
check_out "the clone is explicitly not deleted" "NOT deleted" "$UNINSTALL_OUT"
check "the clone is in fact still there" test -d "$CLONE/.git"

# ── 5. the same uninstall again ───────────────────────────────────────────────
# The second one in a row used to take a fresh backup of an already-clean .env and bounce the engine
# for it, because "the manifest lists keys" was being read as "something changed".
step "5/12  uninstall again — nothing changed, so nothing is done"
BAKS_BEFORE="$(backups)"
: > "$STUB_LOG"
set +e
AGAIN_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --uninstall --yes 2>&1)"
AGAIN_RC=$?
set -e
printf '%s\n' "$AGAIN_OUT" | sed 's/^/    | /'
check_rc "a repeat uninstall succeeds" 0 "$AGAIN_RC"
check_out "and reports ok" "RESULT: ok" "$AGAIN_OUT"
if [ "$(backups)" = "$BAKS_BEFORE" ]; then
  ok "no fresh backup of an already-clean engine .env"
else
  bad "a repeat uninstall backed the engine .env up again"
fi
check "the engine's gateway was NOT bounced for nothing" absent "$STUB_LOG" "gateway"
check_out "and the summary says so" "not bounced (nothing changed)" "$AGAIN_OUT"
check "the data directory is still KEPT" test -f "$STATE/memories-canary.txt"
# The first uninstall took the manifest with it, so this run has none — and matching keys by NAME on
# a box with no other sign of an install would delete the engine's OWN IRISES_PUSH_TOKEN and
# IRISES_URL, which is the defect this battery pre-seeds for, arriving from the other side.
check_out "a manifest-less run says it found no proof anything is ours" "provably ours" "$AGAIN_OUT"
check "the engine .env is STILL byte-identical after a second uninstall" \
  cmp -s "$ENGINE_SEED_ROTATED" "$HERMES/.env"
if ! cmp -s "$ENGINE_SEED_ROTATED" "$HERMES/.env"; then diff -u "$ENGINE_SEED_ROTATED" "$HERMES/.env" | sed 's/^/    | /' || true; fi
check "and the manifest is still gone" test ! -f "$STATE/install-manifest.json"
check "while the data directory it described is not" test -d "$STATE"

# ── 6. someone else has the port ──────────────────────────────────────────────
# The uninstall left the port free and no server of ours anywhere, so this is the one place in the
# battery where a foreign listener can take :$SRV_PORT cleanly. In real life it is `npm run dev` in
# another terminal, and the updater used to fast-forward, build, write the receipt, refuse inside
# the restart, roll a GOOD update back, and sign off with "Irises is DOWN" while the dev server went
# on answering. The refusal belongs in preflight, and this stage is what pins it there: exit 1 with
# the tree, the build and the other process all exactly as they were.
step "6/12  foreign listener — the port is held by something the updater cannot cycle"
foreign_listener_start || fatal "could not put a foreign listener on :$SRV_PORT"
HELD_SHA_BEFORE="$(git -C "$CLONE" rev-parse HEAD)"
HELD_DIST_BEFORE="$(dist_sha)"
HELD_SHA="$(publish "e2e: a commit that must not be applied" "// e2e: must not be applied")" \
  || fatal "could not publish the must-not-apply commit to the fake origin"
# Clear the slate the same way stage 3a does: stage 3c's successful update wrote a receipt, and
# whether the boot announce had already archived it is not this stage's business.
rm -f "$STATE/update-receipt.json"
: > "$STUB_LOG"
set +e
HELD_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
HELD_RC=$?
set -e
printf '%s\n' "$HELD_OUT" | sed 's/^/    | /'
check_rc "a port held by someone else refuses the update" 1 "$HELD_RC"
check_out "the refusal names the port" ":$SRV_PORT" "$HELD_OUT"
check_out "and says to stop it" "stop it" "$HELD_OUT"
check_no_out "nothing was rolled back, because nothing was applied" "RESULT: rolled-back" "$HELD_OUT"
check_out "the run reports partial — it stopped before changing anything" "RESULT: partial" "$HELD_OUT"
check "the tree never moved" test "$(git -C "$CLONE" rev-parse HEAD)" = "$HELD_SHA_BEFORE"
check "the waiting commit is still only upstream" test "$(git -C "$CLONE" rev-parse HEAD)" != "$HELD_SHA"
check "dist/ was never re-stamped" test "$(dist_sha)" = "$HELD_DIST_BEFORE"
check "no receipt was written for an update that never happened" test ! -f "$STATE/update-receipt.json"
check "and the engine was told nothing" absent "$STUB_LOG" "plugins enable irises-bridge"
if foreign_listener_up; then
  ok "the other process still has the port — the updater never went near it"
else
  bad "the listener on :$SRV_PORT is gone — the updater must not touch a process it did not start"
fi
foreign_listener_stop

# ── 7. an engine that is already fully wired ──────────────────────────────────
# Every key Irises writes is ALREADY in the engine's .env — another Irises put them there, or this
# one was removed by hand and its keys stayed. keysAdded is then empty, and the uninstall's restore
# loop used to live behind exactly that check: it put nothing back, and IRISES_URL went on naming a
# clone that no longer existed while the summary said ok.
#
# IRISES_BRIDGE_TOKEN is seeded PRESENT AND EMPTY, which is the second thing this stage pins. An
# empty line is not a secret to adopt — `IRISES_BRIDGE_TOKEN=` authenticates nothing — so the install
# has to write its own value there and record the move, rather than wire both halves to nothing and
# call it adoption. The cmp at the end is what proves the empty line came back.
step "7/12  full pre-existing wiring — the retarget alone is restored"
printf 'ANTHROPIC_API_KEY=engine-owned-key\nAPI_SERVER_ENABLED=true\nAPI_SERVER_KEY=pre-existing-engine-key\nIRISES_PUSH_TOKEN=other-irises-token\nIRISES_URL=http://127.0.0.1:1\nIRISES_BRIDGE_TOKEN=\nIRISES_FRONT=telegram:*\n' > "$HERMES/.env"
FULL_SEED="$SANDBOX/engine-env.seed-full"
cp "$HERMES/.env" "$FULL_SEED"
FULL_HEAD="$(git -C "$CLONE" rev-parse HEAD)"
FULL_MAN="$STATE/install-manifest.json"
: > "$STUB_LOG"
set +e
FULL_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --engine hermes --yes --no-service 2>&1)"
FULL_RC=$?
set -e
printf '%s\n' "$FULL_OUT" | sed 's/^/    | /'
check_rc "an install onto a fully wired engine succeeded" 0 "$FULL_RC"
expect_sha "/health serves the sha that was built" "$FULL_HEAD"
check "the manifest claims no key of its own — every one was already there" \
  present "$FULL_MAN" '"keysAdded": ""'
check "IRISES_URL is on the retarget list all the same" \
  present "$FULL_MAN" '"keysRetargeted": "[^"]*IRISES_URL'
check "while the push token it only adopted is not" \
  absent "$FULL_MAN" '"keysRetargeted": "[^"]*IRISES_PUSH_TOKEN'
check "the clone adopted the other Irises's push token" \
  present "$CLONE/.env" '^ENGINE_PUSH_TOKEN=other-irises-token$'
check "the engine's own IRISES_FRONT scope was kept" present "$HERMES/.env" '^IRISES_FRONT=telegram:\*$'
check_out "the install said the engine's bridge token was empty" \
  "IRISES_BRIDGE_TOKEN was empty" "$FULL_OUT"
check "and put this install's value there instead of an empty secret" \
  present "$HERMES/.env" '^IRISES_BRIDGE_TOKEN=other-irises-token$'
check "recorded as a retarget, so the empty line can come back" \
  present "$FULL_MAN" '"keysRetargeted": "[^"]*IRISES_BRIDGE_TOKEN'

: > "$STUB_LOG"
set +e
FULL_UN_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --uninstall --yes 2>&1)"
FULL_UN_RC=$?
set -e
printf '%s\n' "$FULL_UN_OUT" | sed 's/^/    | /'
check_rc "the uninstall succeeded" 0 "$FULL_UN_RC"
check_out "and reports ok" "RESULT: ok" "$FULL_UN_OUT"
check_out "it says it had no key of its own to remove" "added no key of its own" "$FULL_UN_OUT"
check "IRISES_URL is back to the value the engine had" \
  present "$HERMES/.env" '^IRISES_URL=http://127.0.0.1:1$'
check_out "and the uninstall said so, by name" "restored IRISES_URL to its pre-install value" "$FULL_UN_OUT"
check "the empty bridge-token line is back" present "$HERMES/.env" '^IRISES_BRIDGE_TOKEN=$'
# The whole stage in one line: an install that added nothing, an uninstall that removed nothing, and
# a file that is nevertheless the same bytes it was — every retarget put back, nothing else moved.
check "the engine .env is byte-identical to the fully wired file before this stage" \
  cmp -s "$FULL_SEED" "$HERMES/.env"
if ! cmp -s "$FULL_SEED" "$HERMES/.env"; then diff -u "$FULL_SEED" "$HERMES/.env" | sed 's/^/    | /' || true; fi
check "the gateway was bounced — the engine has to forget the plugin and the URL" \
  grep -qE "hermes gateway re?start" "$STUB_LOG"
check "the manifest is gone" test ! -f "$FULL_MAN"

# ── 8. the menu ───────────────────────────────────────────────────────────────
# The front door, driven the only way a test can drive a wizard: answers on stdin. It is here at the
# end because it needs a clean engine and a clean $IRISES_HOME, and because it is the one stage that
# exercises the THREE scripts together — irises.sh composing flags, engine-setup.sh applying them.
#
# WHAT THIS STAGE IS FOR: the translation. Every answer typed below has to come out as the right
# flag on the command line irises.sh echoes, and that line has to produce the install it describes.
# The wizard drifting from the flags is the failure mode this whole file exists to catch — the menu
# can only be wrong in a way nobody notices if nothing compares the two.
#
# WHAT IT DELIBERATELY DOES NOT EXERCISE: the install child's own engine-.env consent prompt. The
# wizard passes --engine-env ask and does NOT pass --yes, exactly as it does for a person; but the
# child inherits this pipe for stdin, sees no terminal, and takes its documented no-TTY path
# (ASSUME_YES=1), so it answers its own question with the default and writes. That is the same
# behaviour every agent-driven and piped install already has, and the assertions below are on the
# OUTCOME — the keys landed, and they are the ones the answers asked for.
#
# The port answered is the sandbox's own, because a wizard that could be talked into binding 3100 on
# the machine running the battery is not a sandbox any more. The ANSWER is still typed rather than
# defaulted, so the --port on the echoed line is the one that came out of the prompt.
step "8/12  the menu — an install driven by answers, then detach, then uninstall with a purge"
WIZ_MODEL="zzz/e2e-wizard-model"
WIZ_KEY="e2e-not-a-real-openrouter-key"
# A clean engine, carrying no IRISES_FRONT of its own: the scope the wizard asks for is only written
# where the file has none (the rule stage 7 pins from the other side), so this is what makes
# "the answer became IRISES_FRONT" a real assertion.
printf 'ANTHROPIC_API_KEY=engine-owned-key\n' > "$HERMES/.env"
WIZ_SEED="$SANDBOX/engine-env.seed-wizard"
cp "$HERMES/.env" "$WIZ_SEED"
mkdir -p "$STATE"
: > "$STATE/memories-canary.txt"
WIZ_HEAD="$(git -C "$CLONE" rev-parse HEAD)"
: > "$STUB_LOG"
set +e
WIZ_OUT="$(cd "$CLONE" && printf '%s\n' \
  1 y y \
  2 2 "$WIZ_MODEL" "$WIZ_KEY" \
  2 'telegram:*' \
  "$SRV_PORT" n \
  y y y y '' UTC \
  y q \
  | bash scripts/irises.sh 2>&1)"
WIZ_RC=$?
set -e
printf '%s\n' "$WIZ_OUT" | sed 's/^/    | /'
check_rc "the menu ran to its own quit" 0 "$WIZ_RC"
# The line, exactly as composed: this is the assertion that keeps the two surfaces together.
check_out "the wizard printed the command line it composed" \
  "bash scripts/engine-setup.sh --engine hermes --port $SRV_PORT --engine-env ask --no-service --front 'telegram:*' --model-lane openrouter --model-slug $WIZ_MODEL --web on --pings on --musings on --tz UTC" \
  "$WIZ_OUT"
check_out "and named the key as an environment variable that is set" "IRISES_MODEL_API_KEY=<set>" "$WIZ_OUT"
check_no_out "while the key itself never reached the screen" "$WIZ_KEY" "$WIZ_OUT"
check_out "the install it ran reported ok" "RESULT: ok" "$WIZ_OUT"
expect_sha "/health serves the build the wizard installed" "$WIZ_HEAD"
# The model override, as src/loadEnv.ts will read it: three roles, one lane, and the inheritance
# switch that stops applyModel() handing this clone the engine's key and base URL instead.
check "the clone .env carries the Convo model on the openrouter lane" \
  present "$CLONE/.env" "^CONVO_MODEL_OPENROUTER=$WIZ_MODEL\$"
check "and the Classify model" present "$CLONE/.env" "^CLASSIFY_MODEL_OPENROUTER=$WIZ_MODEL\$"
check "and the Fallfirm model" present "$CLONE/.env" "^FALLFIRM_MODEL_OPENROUTER=$WIZ_MODEL\$"
check "with ENGINE_MODEL_INHERIT=off, or the engine's model would still win" \
  present "$CLONE/.env" '^ENGINE_MODEL_INHERIT=off$'
check "the key reached the .env through the environment, never through argv" \
  present "$CLONE/.env" "^OPENROUTER_API_KEY=$WIZ_KEY\$"
check "the extras step wrote the timezone it was given" present "$CLONE/.env" '^IRISES_TZ=UTC$'
check "and the browser chat it was asked for" present "$CLONE/.env" '^WEB_ENABLED=true$'
# The narrowed front scope — the answer that has to survive three hops (menu → flag → engine .env).
check "the engine fronts only the chats the wizard named" present "$HERMES/.env" '^IRISES_FRONT=telegram:\*$'
check "and not every chat on every platform" absent "$HERMES/.env" '^IRISES_FRONT=\*:\*$'
check "the manifest records the scope" present "$STATE/install-manifest.json" '"frontPattern": "telegram:\*"'
check "and the lane Irises's own voice now runs on" present "$STATE/install-manifest.json" '"modelLane": "openrouter"'
check "the plugin went in" test -f "$HERMES/plugins/irises-bridge/plugin.yaml"

# ── 8a. configure, from the menu ──────────────────────────────────────────────
# The verb that did not exist before this branch: changing what stage 8 chose, on the box stage 8
# left running, without an `npm ci`, a rebuild or a plugin copy. It sits here because it needs
# exactly what stage 8 produced — a live server, a manifest, an engine .env carrying our keys — and
# because 8b/8c then have to survive everything it moved.
#
# WHAT THIS STAGE IS FOR, beyond the translation stage 8 pins: the SIDE EFFECTS. A setting is not
# configured when its line is in a file. .env is parsed once at boot, so a change Irises reads costs
# a restart and a re-verified /health; the engine reads IRISES_FRONT and IRISES_URL only when its
# gateway starts, so those cost a bounce — and cost Irises NOTHING, which is the half that is easy
# to get wrong in the direction nobody notices. Each action below therefore checks three things:
# the flag the answer composed, the value where it actually lives, and who was made to restart.
#
# The port move is LAST and it is load-bearing for the rest of the file: it reassigns $SRV_PORT, so
# every later reader (expect_sha, 8c's "nothing answers") follows Irises to where she now is.
step "8a/12  configure from the menu — six settings, each landing where it lives"

CFG_OUT=""
CFG_RC=0
# One shape for every configure action, because they are the same walk: clear the stub log, answer
# the menu, quit, show what the operator would have seen. The three assertions each one owes are
# here; what makes an action itself is asserted at the call site.
cfg_menu() { # ANSWER…
  : > "$STUB_LOG"
  set +e
  CFG_OUT="$(cd "$CLONE" && printf '%s\n' "$@" q | bash scripts/irises.sh 2>&1)"
  CFG_RC=$?
  set -e
  printf '%s\n' "$CFG_OUT" | sed 's/^/    | /'
  check_rc "the menu ran to its own quit" 0 "$CFG_RC"
  # TWO of them, not one: the Configure menu prints `configure.sh --show` over its own entries and
  # that report ends `RESULT: ok` too, so a single occurrence is a check the embedded report satisfies
  # on its own — it would pass for an action that never ran. The second one is the action's.
  check "the child reported its result token, over the report's own" \
    test "$(printf '%s\n' "$CFG_OUT" | grep -c 'RESULT: ok')" -ge 2
  # And the count cannot be the whole story either: the tokens a run FAILS with are named here, where
  # nothing else can supply them.
  check "and nothing in it ended on a failure token" no_bad_result "$CFG_OUT"
  # This verb changes settings on a box that is already built. An `npm ci` in the stub log is a
  # configure that reinstalled — minutes of rebuild for a timezone, and a rebuild is how a live box
  # ends up on code nobody asked it to move to.
  check "configure never reinstalls" absent "$STUB_LOG" '^npm ci'
  # Stage 8 typed this key once, into a prompt that does not echo. Every screen after it — the
  # report the Configure menu prints above its own entries included — has to stay clean of it.
  check_no_out "and the key never reached the screen" "$WIZ_KEY" "$CFG_OUT"
  return 0
}
no_bad_result() { # OUTPUT — configure.sh's own tokens for a run that did not get all the way
  case "${1:-}" in
    *"RESULT: health-failed"*|*"RESULT: gateway-failed"*|*"RESULT: partial"*) return 1 ;;
  esac
  return 0
}
pid_changed() { [ -n "${2:-}" ] && [ "${1:-}" != "${2:-}" ]; }   # BEFORE AFTER
pid_same()    { [ -n "${2:-}" ] && [ "${1:-}" = "${2:-}" ]; }    # BEFORE AFTER
grew()        { [ "${2:-0}" -gt "${1:-0}" ]; }                   # BEFORE AFTER

# 1. the timezone — a value only Irises reads, so she is the only thing that has to be restarted.
CFG_PID="$(srv_pid)"
cfg_menu 2 5 Europe/Paris
check_out "the zone typed became --tz" "bash scripts/configure.sh --tz Europe/Paris" "$CFG_OUT"
# The whole line configure.sh prints, column padding included: "what it replaced" is the half an
# operator reads to decide, and a needle that stopped at the new value would pass on a preview that
# had quietly dropped the `(was …)`.
check_out "the preview showed the change and what it replaced" \
  "~ IRISES_TZ=Europe/Paris     (was UTC)" "$CFG_OUT"
check "the clone .env carries the new zone" present "$CLONE/.env" '^IRISES_TZ=Europe/Paris$'
check "and not the one the wizard installed" absent "$CLONE/.env" '^IRISES_TZ=UTC$'
expect_sha "Irises was restarted and still serves the build she was on" "$WIZ_HEAD"
# The proof that the restart was real and not a health check against the process that never died:
# .env is read at boot, so a server with the old pid is a server on the old timezone.
check "the restart cycled the detached server — a new pid" pid_changed "$CFG_PID" "$(srv_pid)"
check "and the gateway was bounced with her" grep -qE "hermes gateway re?start" "$STUB_LOG"

# 2. the browser chat — the same rung, answered `n` where the prompt defaults to the state the box
# is in (the wizard turned it on, so the default here is `y` and the `n` is a real answer).
CFG_PID="$(srv_pid)"
cfg_menu 2 4 n
check_out "the answer became --web off" "bash scripts/configure.sh --web off" "$CFG_OUT"
check "the clone .env turns the browser chat off" present "$CLONE/.env" '^WEB_ENABLED=false$'
expect_sha "Irises came back on the same build" "$WIZ_HEAD"
# src/index.ts mounts the browser chat at boot and nowhere else, so a run that wrote the line and
# left the old process holding the port is a UI that is still being served. The sha alone cannot
# tell those apart — the process that never died answers /health with exactly the same one.
check "the restart cycled her onto it — a new pid" pid_changed "$CFG_PID" "$(srv_pid)"

# 3. the front scope — the ENGINE's key. Nothing of this clone's moves, so Irises must NOT be
# restarted, and the gateway must be, or the engine goes on fronting what it was told last boot.
CFG_PID="$(srv_pid)"
CFG_BAKS="$(backups | wc -l | tr -d ' ')"
cfg_menu 2 2 2 telegram:1
check_out "the scope became --front, bare because it carries no glob to quote" \
  "bash scripts/configure.sh --front telegram:1" "$CFG_OUT"
check_out "the preview named the engine's file, not this clone's" "changes to $HERMES/.env" "$CFG_OUT"
check "the engine fronts only the chat that was named" present "$HERMES/.env" '^IRISES_FRONT=telegram:1$'
# Anchored on the ASSIGNMENT: the installer's own section header in this file offers `telegram:*` as
# an example of narrowing, so a bare search for the glob matches a comment and proves nothing.
check "and no longer every chat on the platform" absent "$HERMES/.env" '^IRISES_FRONT=telegram:\*$'
check "the manifest followed the scope" present "$STATE/install-manifest.json" '"frontPattern": "telegram:1"'
# --uninstall restores retargeted keys FROM a backup, so a write to the engine's file with none
# behind it is a change nothing can undo. There is one from the install already: this one is NEW.
check "the engine .env was backed up again before it was written" grew "$CFG_BAKS" "$(backups | wc -l | tr -d ' ')"
check "the gateway was bounced — it reads IRISES_FRONT only when it starts" \
  grep -qE "hermes gateway re?start" "$STUB_LOG"
check "and Irises was not restarted for a file she never reads" pid_same "$CFG_PID" "$(srv_pid)"

# 4. the model, handed back to the engine. The override goes out key by key; the KEY the operator
# paid for stays, because undoing our choice of model must not cost them a credential.
CFG_PID="$(srv_pid)"
cfg_menu 2 3 1
check_out "the answer became --model-inherit" "bash scripts/configure.sh --model-inherit" "$CFG_OUT"
check_out "and it said out loud that the lane key stays" "keeping OPENROUTER_API_KEY" "$CFG_OUT"
check "the Convo override is gone" absent "$CLONE/.env" '^CONVO_MODEL_OPENROUTER='
check "and the Classify override" absent "$CLONE/.env" '^CLASSIFY_MODEL_OPENROUTER='
check "and the Fallfirm override" absent "$CLONE/.env" '^FALLFIRM_MODEL_OPENROUTER='
# All three lanes, not just Convo: applyModel() reads them per role, so one left behind is one role
# still pinned to a provider the operator just handed back.
check "and the lane that carried Convo" absent "$CLONE/.env" '^CONVO_PROVIDER='
check "and the lane that carried Classify" absent "$CLONE/.env" '^CLASSIFY_PROVIDER='
check "and the lane that carried Fallfirm" absent "$CLONE/.env" '^FALLFIRM_PROVIDER='
check "and the inheritance switch is not pinned off any more" absent "$CLONE/.env" '^ENGINE_MODEL_INHERIT='
check "while the key the operator pays for is still in the file" \
  present "$CLONE/.env" "^OPENROUTER_API_KEY=$WIZ_KEY\$"
# The manifest carries modelLane for --uninstall and the detach rewrite, so a run that handed the
# model back and left it naming openrouter hands the next script a lane this box is not on.
check "the manifest stopped naming the lane the override was on" \
  present "$STATE/install-manifest.json" '"modelLane": "inherit"'
expect_sha "Irises was restarted onto the inherited model" "$WIZ_HEAD"
check "and the restart was real — a new pid" pid_changed "$CFG_PID" "$(srv_pid)"

# 5. the generic editor — any documented key, with the value on the line because this one is not a
# secret by name (the ones that are travel in IRISES_SET_VALUE and print as <set>).
cfg_menu 2 8 1 CONVO_EFFORT low
check_out "the key and value became one --set argument" \
  "bash scripts/configure.sh --set CONVO_EFFORT=low" "$CFG_OUT"
check "the key landed in this clone's .env" present "$CLONE/.env" '^CONVO_EFFORT=low$'

# 6. LAST: the port. It moves in three places at once — this clone's PORT, the IRISES_URL the engine
# calls back on, and the manifest --uninstall reads — and the whole rest of this file now has to
# follow her there.
CFG_PID="$(srv_pid)"
cfg_menu 2 1 "$SRV_PORT2" n
check_out "the port and the service answer became one line" \
  "bash scripts/configure.sh --port $SRV_PORT2 --service off" "$CFG_OUT"
check_out "the preview moved the engine's callback URL with it" \
  "~ IRISES_URL=http://127.0.0.1:$SRV_PORT2" "$CFG_OUT"
# From here $SRV_PORT is where Irises actually is: health_sha, expect_sha and 8c's "nothing answers"
# all read it at call time, so this one line is what keeps the rest of the battery pointed at her.
OLD_PORT="$SRV_PORT"
SRV_PORT="$SRV_PORT2"
expect_sha "Irises answers on the new port, on the same build" "$WIZ_HEAD"
check "the restart cycled her onto it" pid_changed "$CFG_PID" "$(srv_pid)"
check "and nothing is left listening on the old one" \
  sh -c "! curl -fsS -m 3 http://127.0.0.1:$OLD_PORT/health >/dev/null 2>&1"
check "the engine calls her back on the new port" \
  present "$HERMES/.env" "^IRISES_URL=http://127.0.0.1:$SRV_PORT2\$"
check "the manifest records the move, so --uninstall stops the right server" \
  present "$STATE/install-manifest.json" "\"port\": \"$SRV_PORT2\""
check "the gateway was bounced — IRISES_URL is read only at its start" \
  grep -qE "hermes gateway re?start" "$STUB_LOG"

# 7. the report, read back off the box rather than out of this harness's own variables: six answers
# ago this was a UTC install on :$OLD_PORT fronting every telegram chat on a model of its own.
set +e
SHOW_OUT="$(cd "$CLONE" && bash scripts/configure.sh --show 2>&1)"
set -e
check_out "--show names the lane key as set" "OPENROUTER_API_KEY <set>" "$SHOW_OUT"
check_no_out "and never its value" "$WIZ_KEY" "$SHOW_OUT"
check_out "--show reports the new port" "$SRV_PORT2" "$SHOW_OUT"
check_out "--show reports the timezone" "Europe/Paris" "$SHOW_OUT"
check_out "--show reports the narrowed front" "telegram:1" "$SHOW_OUT"
# And the menu's own Status is that same report — one place to be right about a live box.
set +e
STAT_OUT="$(cd "$CLONE" && printf '%s\n' 5 q | bash scripts/irises.sh 2>&1)"
STAT_RC=$?
set -e
check_rc "the menu ran Status and reached its own quit" 0 "$STAT_RC"
# Tied to what THIS box was configured to six answers ago, not to a label the report would print on
# any machine: `timezone` alone passes for a Status that rendered the word and no value behind it.
check_out "the menu's Status prints the report too" "Europe/Paris" "$STAT_OUT"
check_no_out "without leaking the key into it" "$WIZ_KEY" "$STAT_OUT"

# ── 8b. detach, from the menu ─────────────────────────────────────────────────
# The de-escalation rung: the engine is given back, and Irises keeps running. --yes IS passed here
# (the menu asked the question once already), so the child asks nothing.
#
# The first answer is `4`, not `3`: Configure took entry 2 on the top menu and pushed Update,
# Uninstall, Status and Advanced down one each. A menu key is a fact about the screen, so this
# number and the one in 8c are the two places this file has to be told when that screen changes.
step "8b/12  detach from the menu — the engine is given back, Irises keeps serving"
: > "$STUB_LOG"
set +e
DET_OUT="$(cd "$CLONE" && printf '%s\n' 4 2 y q | bash scripts/irises.sh 2>&1)"
DET_RC=$?
set -e
printf '%s\n' "$DET_OUT" | sed 's/^/    | /'
check_rc "the menu ran to its own quit" 0 "$DET_RC"
check_out "the detach was composed with --yes, so the child asked nothing twice" \
  "bash scripts/engine-setup.sh --detach-engine --yes" "$DET_OUT"
check_out "and reported the detached result token" "RESULT: detached" "$DET_OUT"
check "the plugin is gone from the engine" test ! -d "$HERMES/plugins/irises-bridge"
check "the engine .env is byte-identical to the file before the wizard installed" \
  cmp -s "$WIZ_SEED" "$HERMES/.env"
if ! cmp -s "$WIZ_SEED" "$HERMES/.env"; then diff -u "$WIZ_SEED" "$HERMES/.env" | sed 's/^/    | /' || true; fi
check "the manifest stayed, now recording nothing on the engine's side" \
  present "$STATE/install-manifest.json" '"engineEnvApplied": "false"'
expect_sha "Irises is still serving — a detach is not an uninstall" "$WIZ_HEAD"
check "and her data is untouched" test -f "$STATE/memories-canary.txt"

# ── 8c. uninstall with an archive and a purge ─────────────────────────────────
# The end of the road, and the only path in the whole lifecycle that destroys something
# irreplaceable: the menu runs the "type the word delete" gate ITSELF and then hands the child
# --purge-data --yes, so the gate cannot be satisfied by a flag alone.
step "8c/12  uninstall from the menu — archive first, then delete the data"
: > "$STUB_LOG"
set +e
PURGE_OUT="$(cd "$CLONE" && printf '%s\n' 4 4 y delete q | bash scripts/irises.sh 2>&1)"
PURGE_RC=$?
set -e
printf '%s\n' "$PURGE_OUT" | sed 's/^/    | /'
check_rc "the menu ran to its own quit" 0 "$PURGE_RC"
check_out "the archive answer became --archive-data, ahead of the purge" \
  "bash scripts/engine-setup.sh --uninstall --archive-data --purge-data --yes" "$PURGE_OUT"
check "the archive was written before anything was deleted" \
  test -n "$(ls "$HOME_DIR"/.irises-backup-*.tar.gz 2>/dev/null || true)"
check "the data directory is gone" test ! -d "$STATE"
check "and nothing answers on the port any more" sh -c "! curl -fsS -m 3 http://127.0.0.1:$SRV_PORT/health >/dev/null 2>&1"

engine_stub_stop

step "result"
printf '  %s passed, %s failed  (%ss wall)\n\n' "$PASS" "$FAIL" "$(( $(date +%s) - STARTED ))"
if [ "$FAIL" != "0" ]; then
  printf 'RESULT: failed\n'
  exit 1
fi
printf 'RESULT: ok\n'
exit 0
