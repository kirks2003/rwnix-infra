# kandev104: opencode setup

## Container details

| Property | Value |
|---|---|
| Host | docker-1-pve-104 (`192.168.54.111`) |
| Container name | `kandev104` |
| Image | `kandev:v0.96.0-ssh` (base `ghcr.io/kdlbs/kandev:v0.96.0@sha256:33c9211a…`) |
| Bridge | `kandev104` (`10.75.0.0/24`), fixed IP `10.75.0.2` |
| UI port | `192.168.54.111:38431` (proxied by both hub NPMs as `kandev104.<FQDN>`) |
| Container SSH | `127.0.0.1:2222` (key-only, accessed via `ssh -J vm104 -p 2222 …@127.0.0.1`) |
| opencode version | 1.18.34 (`/data/.npm-global/bin/opencode`) |

## Access paths

From NBG sandbox:
```
ssh -o StrictHostKeyChecking=accept-new -J ubuntu@vm104 -p 2222 kandev@127.0.0.1
```

From VIE-1 sandbox:
```
ssh -o StrictHostKeyChecking=accept-new -J ubuntu@vm104 -p 2222 kandev@127.0.0.1
```

Note: `vm104` is `192.168.54.111`, reached via the owrt002 WireGuard tunnel
on both hubs. The VIE-1 sandbox routes through `10.2.1.2`; from VIE-1, first
hop to `vm104` via `pve104` is required if direct mesh routing is unavailable.

## Filesystem changes

### `/data/home/.config/opencode/opencode.jsonc`

Two providers defined — DeepSeek V4 Flash (GPU-2 vLLM) and Qwen 3.8-27B
(GPU-1 llama.cpp, via NPM reverse proxy):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "a1-dsv4f": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "a1-dsv4f",
      "options": {
        "baseURL": "https://ds4-flash.gpu-2-de-fra-1-exo.csdc-nm.at/v1",
        "apiKey": "<vLLM API key>"
      },
      "models": {
        "a1-dsv4f": {
          "id": "deepseek-v4-flash",
          "name": "a1-dsv4f",
          "limit": { "context": 1000000, "output": 131072 }
        }
      }
    },
    "qwen": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "qwen38-27b-selfhosted",
      "options": {
        "baseURL": "https://qwen38-27b-mtp.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1",
        "apiKey": "<llama.cpp API key>"
      },
      "models": {
        "Qwen3.8-27B-UD-Q8_K_XL.gguf": {
          "name": "Qwen3.8-27B (self-hosted)",
          "limit": { "context": 262144, "output": 131072 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  },
  "model": "a1-dsv4f/a1-dsv4f",
  "permission": {
    "*": "allow",
    "question": "deny"
  }
}
```

Mode: `600` (kandev). The provider key names and model structure match the
NBG sandbox format exactly.

### `/data/home/.bashrc` — PS1 (kandev user)

```
export PATH="/data/.npm-global/bin:$PATH"
PS1='\[\033[1;32m\]\u\[\033[1;37m\]@\[\033[1;36m\]kandev104\[\033[00m\]:\[\033[1;34m\]$PWD\[\033[00m\] \$> '
```

Green prompt with static `kandev104` label, matching the NBG/VIE-1 sandbox
PS1 convention.

### `/root/.bashrc` — PS1 (root user)

```
export PATH="/data/.npm-global/bin:$PATH"
PS1='\[\033[1;31m\]\u\[\033[1;37m\]@\[\033[1;36m\]kandev104\[\033[00m\]:\[\033[1;34m\]$PWD\[\033[00m\] \$> '
```

Red prompt (root colour), same `kandev104` label.

### `/data/home/.ssh/` — SSH keys

The shared `kandev` Ed25519 key (`SHA256:/1xfmrDI0Y4EjdD…`) is stored:

| File | Mode | Description |
|---|---|---|
| `id_ed25519` | 600 | Private key |
| `id_ed25519.pub` | 644 | Public key (`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO3zTbZIypUXyz7RxvBbQuE0aWobb6mLpqym55BqnvN3 kandev`) |
| `kandev` | symlink → `id_ed25519` | Convenience symlink |
| `kandev.pub` | symlink → `id_ed25519.pub` | Convenience symlink |
| `authorized_keys` | 600 | Same public key (pre-existing, allows key-only login as `kandev@`) |

This is the same key used on all NBG/VIE-1 mesh hosts, routers, PVE hosts
and GPU hosts for the `kandev` user. It is **not** a GitHub deploy key (the
repo uses a PAT for git operations).

## Kandev agent profiles (`/data/data/kandev.db`)

The `agent_profiles` table holds two profiles, both linked to the
`opencode-acp` agent (`6131b727-40c9-4c02-9bf2-4d5d906918ce`):

| Name | Model | Agent display | Mode | Enabled |
|---|---|---|---|---|
| `a1-deepseek-v4.0-flash` | `a1-dsv4f/a1-dsv4f` | OpenCode | build | yes |
| `a1-qwen38-27b` | `qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf` | OpenCode | build | yes |

Profile IDs:
- `a1-deepseek-v4.0-flash`: `25dff9b2-82a5-4a8b-a867-4a58df6ebc16`
- `a1-qwen38-27b`: `fd40b2af-366a-42e6-92f8-77669f4eb2c7`

Both use `auto_approve=1`, `allow_indexing=0`. The `a1-deepseek-v4.0-flash`
profile was set up previously (see `kandev-opencode-dsv4f-setup.md`).

## Verification

```
$ echo "hello" | opencode run -m qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf
> build · Qwen3.8-27B-UD-Q8_K_XL.gguf
Hello! How can I help you today?

$ echo "hello" | opencode run -m a1-dsv4f/a1-dsv4f
> build · a1-dsv4f
Hello! How can I help you today?
```

Both GPU endpoints are reachable from within the container (routed via
pve104 → owrt002 → mesh hubs → Exoscale GPU security groups). The qwen
endpoint serves the `Qwen3.8-27B-UD-Q8_K_XL.gguf` model via llama.cpp
on GPU-1. The dsv4f endpoint serves `deepseek-v4-flash` via vLLM on GPU-2.

## What was done (2026-10-03)

1. **Backed up** the existing `opencode.jsonc` as `opencode.jsonc.bak`
   and `opencode.jsonc.bak2`
2. **Added `qwen` provider** to `opencode.jsonc` (initially as
   `a1-qwen38-27b`, then corrected to `qwen` to match NBG sandbox format)
3. **Verified** the JSON is valid, file mode `600`
4. **Added Kandev agent profile** `a1-qwen38-27b` to the `agent_profiles`
   table in `kandev.db` (same schema as the existing dsv4f profile, linked
   to the `opencode-acp` agent)
5. **Copied SSH keys** — transferred the shared `kandev` Ed25519 key pair
   from the NBG sandbox to `/data/home/.ssh/` with symlinks
6. **Set PS1** — green for `kandev` user, red for `root`, both with static
   `kandev104` label, matching the NBG/VIE-1 sandbox PS1 convention
7. **Tested** both models via `opencode run`
8. **Verified** agent profiles in Kandev DB (2 profiles visible)

## Caveats and findings

- The Kandev backend/ACP supervisor runs on this container (port 38429),
  but the `KANDEV_RESTART_ADAPTER=supervisor` mode is not configured to
  auto-start opencode ACP servers, so the agent profiles are defined in
  the DB but not usable as Kandev run profiles without additional setup.
- The GPU-1 endpoint DNS (`qwen38-27b-mtp.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at`)
  resolves to an IP behind the Exoscale security group that allows traffic
  from NBG (`152.53.118.212`) and VIE-1 (`152.53.35.177`) — traffic from
  `192.168.54.111` (vm104) reaches it through owrt002's NAT, which appears
  to be permitted by the current security group configuration.
- The `kandev.db` had no `github_workspace_connections` or `secrets` table
  entries, so git push from the Kandev workspace credential lease does not
  work for this container — use the NBG or VIE-1 sandbox for git operations
  on the `rwnix-infra` repo.
- No MCP servers are configured in the Kandev profiles (no `vikunja` or
  other MCP entries in `agent_profile_mcp_configs`).
