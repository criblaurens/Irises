#!/usr/bin/env bash
# Apply the Photon unsend patch to a Hermes Agent tree (git checkout or not).
#   ./apply.sh [--check] [HERMES_DIR]     default HERMES_DIR: $HERMES_AGENT_DIR or ~/Downloads/hermes-agent-main
# Idempotent: an already-applied tree is reported and left alone. Never restarts the gateway.
set -euo pipefail

PATCH="$(cd "$(dirname "$0")" && pwd)/0001-photon-unsend.patch"
CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; shift; fi
TARGET="${1:-${HERMES_AGENT_DIR:-$HOME/Downloads/hermes-agent-main}}"

[ -f "$TARGET/plugins/platforms/photon/adapter.py" ] || { echo "apply.sh: no Photon plugin under $TARGET" >&2; exit 1; }
cd "$TARGET"

# A marker, not `patch -R --dry-run`: Apple's patch silently ignores -R on an unapplied tree.
if grep -q 'MAX_SENT_HANDLES' plugins/platforms/photon/sidecar/index.mjs \
	&& grep -q '"/unsend"' plugins/platforms/photon/adapter.py; then
	echo "photon-unsend: already applied in $TARGET"
	exit 0
fi
if ! patch -p1 --forward --dry-run --silent < "$PATCH" >/dev/null 2>&1; then
	echo "photon-unsend: patch does not apply cleanly to $TARGET (the Photon plugin has moved on); nothing changed" >&2
	exit 1
fi
if [ "$CHECK" = 1 ]; then
	echo "photon-unsend: would apply to $TARGET"
	exit 0
fi
patch -p1 --forward --silent < "$PATCH"
echo "photon-unsend: applied to $TARGET. Restart the gateway to load it."
