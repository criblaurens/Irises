# Photon unsend — Hermes patch

Lets Irises take back one of her own iMessages (spec:
`docs/superpowers/specs/2026-10-01-unsend-design.md`). The `irises-bridge` plugin's `/unsend`
calls the platform adapter's `delete_message`, and the Photon adapter has none upstream, so it
answers "can't" on iMessage until this patch is applied. Telegram needs nothing: Hermes already
implements `delete_message` there.

| File | Change |
| --- | --- |
| `plugins/platforms/photon/sidecar/index.mjs` | `/send` keeps each outbound message in a small LRU; new `/unsend {spaceId, messageId}` calls `space.unsend` (falling back to `space.getMessage` after a restart) and answers `{unsent}` |
| `plugins/platforms/photon/adapter.py` | `delete_message` override that calls the sidecar's `/unsend`, never raising |

Made against the Hermes tree at `~/Downloads/hermes-agent-main` (not a git checkout, so this is a
plain `patch -p1` diff). iMessage allows an unsend for about two minutes; Irises only offers one
inside that window.

```sh
./apply.sh --check     # dry run
./apply.sh             # apply, then restart the gateway
```

Not yet run against a live Photon sidecar: the local Hermes has no Photon platform connected.
