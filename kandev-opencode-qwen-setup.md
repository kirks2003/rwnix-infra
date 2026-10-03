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
| Compose env | `SHELL=/bin/bash`, `KANDEV_RESTART_ADAPTER=supervisor`, and others (see below) |
| `extra_hosts` | 41 hostname→IP mappings (VIE-1 hub tunnel IPs) |

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

Three providers defined — DeepSeek V4 Flash (GPU-2 vLLM), Qwen 3.8-27B
(GPU-1 llama.cpp, via NPM reverse proxy), and OVH AI Endpoints Qwen 3.6-27B:

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
    },
    "ovh": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ovhcloud-ai",
      "options": {
        "baseURL": "https://qwen-3-6-27b.endpoints.kepler.ai.cloud.ovh.net/api/openai_compat/v1",
        "apiKey": "<OVH AI Endpoints API key>"
      },
      "models": {
        "Qwen3.6-27B": {
          "name": "Qwen3.6-27B (OVH AI Endpoints)",
          "limit": { "context": 128000, "output": 131072 }
        }
      }
    }
  },
  "model": "a1-dsv4f/a1-dsv4f",
  "agent": {
    "qwen3.8-27b": {
      "description": "Qwen 3.8 27B self-hosted agent (llama.cpp via the qwen provider)",
      "mode": "primary",
      "model": "qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf"
    }
  },
  "permission": {
    "*": "allow",
    "question": "deny"
  }
}
```

Mode: `600` (kandev). The config is byte-identical to the NBG sandbox
(after accounting for runtime host differences).

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

Seven profiles are now configured, referencing three ACP backends:

| Name | Model | Agent | Mode | Enabled |
|---|---|---|---|---|
| `a1-deepseek-v4.0-flash` | `a1-dsv4f/a1-dsv4f` | opencode-acp | build | yes |
| `a1-qwen38-27b` | `qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf` | opencode-acp | build | yes |
| `rw_ovhcloud-qwen3.6-27b` | `ovh/Qwen3.6-27B` | opencode-acp | build | yes |
| `rw_openrouter-qwen3.8-27b` | `openrouter/qwen/qwen3.8-27b` | opencode-acp | build | yes |
| `rw_openrouter-DeepSeek-V4.1-Flash` | `openrouter/deepseek/deepseek-v4.1-flash` | opencode-acp | build | yes |
| `rw-claude-Opus5.5` | `opus` | claude-acp | bypassPermissions | yes |
| `a1-copilot-GPT-5.5` | `gpt-5.5` | copilot-acp | autopilot | yes |

The three ACP agent backends:

| Agent ID | Name |
|---|---|
| `6131b727-40c9-4c02-9bf2-4d5d906918ce` | `opencode-acp` |
| `f9771637-2d1e-4e3b-84ca-aad8290bc14b` | `claude-acp` |
| `d01a2bc4-6fc7-424f-847d-8b4f66c7bfb6` | `copilot-acp` |

The managed runtime settings needed to start the ACP backends already
existed in the DB (from the base image): `managed_runtime.default.*` and
`managed_runtime.active.*` entries for `claude-acp`, `copilot-acp`, and
`opencode-acp`. Only the agent rows and profile rows were missing and
have been added.

All profiles use `auto_approve=1`, `allow_indexing=0`.

## Verification

```
$ echo "hello" | opencode run -m qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf
> build · Qwen3.8-27B-UD-Q8_K_XL.gguf
Hello! How can I help you today?

$ echo "hello" | opencode run -m a1-dsv4f/a1-dsv4f
> build · a1-dsv4f
Hello! How can I help you today?

$ echo "hello" | opencode run -m ovh/Qwen3.6-27B
> build · Qwen3.6-27B
Hello! How can I help you today?
```

All three endpoints are reachable from within the container. The qwen
endpoint serves `Qwen3.8-27B-UD-Q8_K_XL.gguf` via llama.cpp on GPU-1,
the dsv4f endpoint serves `deepseek-v4-flash` via vLLM on GPU-2, and the
ovh endpoint serves `Qwen3.6-27B` via OVH AI Endpoints.

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
9. **Added `ovh` provider** and `agent` section to `opencode.jsonc` to match
   NBG sandbox exactly — three providers total (`a1-dsv4f`, `qwen`, `ovh`)
   plus the `qwen3.8-27b` opencode agent
10. **Verified** full config parity — byte-identical to NBG after normalizing
    API keys; tested all three models via `opencode run`
11. **Cloned remaining agent profiles from NBG:** created `claude-acp` and
    `copilot-acp` agent rows, then added 5 profiles:
    `rw-claude-Opus5.5`, `a1-copilot-GPT-5.5`, `rw_ovhcloud-qwen3.6-27b`,
    `rw_openrouter-qwen3.8-27b`, `rw_openrouter-DeepSeek-V4.1-Flash`.
    Kandev104 now has all 7 profiles matching NBG.

## Caveats and findings

### ACP backends not running

The supervisor (`agentctl`) runs with `KANDEV_RESTART_ADAPTER=supervisor` and
the `managed_runtime.*` settings exist in the DB for `opencode-acp`,
`claude-acp`, and `copilot-acp`. However, the ACP backends do **not** start
automatically on this container. The same configuration works on the NBG/VIE-1
sandboxes (Kandev v0.94.0) but not on kandev104 (Kandev v0.96.0).

Impact:
- All 7 agent profiles are defined in the DB but cannot execute via the
  Kandev run system — the ACP backends don't advertise available models.
- The Kandev UI profile editor shows no models in the model picker dropdown
  (no ovhcloud, no openrouter, no claude models visible).
- Models work via CLI: `su -l -c "opencode run -m <provider>/<model>" kandev`

Workaround: use opencode CLI directly:
```
ssh -J vm104 -p 2222 kandev@127.0.0.1
kandev@kandev104:~ $ echo "hello" | opencode run -m ovh/Qwen3.6-27B
kandev@kandev104:~ $ echo "hello" | opencode run -m qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf
kandev@kandev104:~ $ echo "hello" | opencode run -m a1-dsv4f/a1-dsv4f
```

### No `openrouter` provider in opencode config

The `rw_openrouter-*` profiles reference models like
`openrouter/qwen/qwen3.8-27b`. An `openrouter` provider was added to
`opencode.jsonc` on both NBG and kandev104 (same API key from
`auth.json`). The provider serves three models:

| Model reference | Name |
|---|---|
| `openrouter/qwen/qwen3.8-27b` | Qwen 3.8 27B (OpenRouter) |
| `openrouter/deepseek/deepseek-v4.1-flash` | DeepSeek V4.1 Flash (OpenRouter) |
| `openrouter/anthropic/claude-fable-5.1` | Claude Fable 5.1 (OpenRouter) |

### GPU endpoint reachability

The GPU-1 endpoint DNS (`qwen38-27b-mtp.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at`)
resolves to an IP behind the Exoscale security group that allows traffic
from NBG (`152.53.118.212`) and VIE-1 (`152.53.35.177`) — traffic from
`192.168.54.111` (vm104) reaches it through owrt002's NAT, which appears
to be permitted by the current security group configuration.

### Git operations

The `kandev.db` had no `github_workspace_connections` or `secrets` table
entries, so git push from the Kandev workspace credential lease does not
work for this container — use the NBG or VIE-1 sandbox for git operations
on the `rwnix-infra` repo.

### MCP servers

No MCP servers are configured in the Kandev profiles (no `vikunja` or
other MCP entries in `agent_profile_mcp_configs`).
