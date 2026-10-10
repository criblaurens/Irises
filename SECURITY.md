# Security

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting on
[criblaurens/Irises](https://github.com/criblaurens/Irises/security/advisories/new) — the **Report a
vulnerability** button under the repository's *Security* tab. That opens a private thread with the
maintainer, and it is the fastest route.

If you cannot use GitHub, open a public issue that says only that you have a security report and how
to reach you, with no details. A maintainer will move it to a private channel.

Please include: what you found, how to reproduce it, which version or commit you tested, and what an
attacker gets from it. You will get an acknowledgement, and credit in the fix commit if you want it.

## What Irises holds, and what that means for a deploy

Irises is a personal assistant: it stores conversations, a memory of the person it talks to, and
whatever the engine behind it can reach. Treat a deployment as sensitive by default.

**Exposed surfaces.** The server binds every network interface. Four doors have their own guard:

| Door | Guard |
|------|-------|
| `/dashboard` | `DASHBOARD_PASSWORD`; **unset leaves it answering localhost only** |
| `/debug` | `DEBUG_TOKEN`; unset leaves it answering localhost only |
| `/api/web/message`, `/api/web/stream` | `DEBUG_TOKEN`; unset leaves them answering localhost only |
| `/api/engine/push`, `/api/bridge/inbound` | `ENGINE_PUSH_TOKEN`; unset leaves them answering localhost only |

The "localhost only" fallback is an exact address match on the peer address. It is a development
convenience, not a control: **set the tokens and the password on anything reachable beyond the
machine it runs on**, and put TLS in front of it (the Docker path does, through Caddy).

Two consequences worth stating plainly:

- A reverse proxy does not change the peer address unless it is on the same host — if you front
  Irises with a proxy on another machine, the fallback sees the proxy, and loopback-only becomes
  proxy-only. Set the tokens.
- `IRISES_BRIDGE_FAIL=open` (the default) means the engine answers fronted chats itself when Irises
  is unreachable. That keeps the assistant useful; it also means a crashed Irises degrades to the
  engine's own voice rather than to silence.

**Secrets.** Keys are read from the environment or the clone's `.env` (mode 600) and are never
printed by the installer, never taken as command-line flags — argv is readable by any other process
on the box — and never logged. If you find a path that prints or logs one, that is a security bug
and we would like to hear about it.

**Engine-side changes.** The installer records every key it adds to your engine's `.env` in
`~/.irises/install-manifest.json`, after backing that file up, and `--uninstall` puts back exactly
what it changed. Nothing outside that manifest is touched.

## Supported versions

This is a personal project with no LTS branches. Security fixes land on `main`; update with
`bash scripts/update.sh`. Only the latest release is supported.
