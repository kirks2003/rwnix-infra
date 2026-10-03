# kandev104: opencode a1-qwen38-27b setup

## Filesystem changes

### `/data/home/.config/opencode/opencode.jsonc`

Provider definition for the Qwen 3.8-27B model served by the GPU-1
llama.cpp endpoint (via NPM reverse proxy on gpu-1):

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

Mode: `600` (kandev)

### `/data/home/.bashrc` / `.profile`

Adds `/data/.npm-global/bin` to PATH so opencode is available without
specifying the full path (set up by the initial container provisioning):

```
export PATH="/data/.npm-global/bin:$PATH"
```

## Verification

The qwen endpoint is reachable from within the kandev104 container
(and from docker-1-pve-104 host) via the GPU-1 NPM reverse proxy:

```
$ echo "hello" | opencode run -m qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf
> build · Qwen3.8-27B-UD-Q8_K_XL.gguf
Hello! How can I help you today?
```

## What was done (2026-10-03)

1. Backed up the existing `opencode.jsonc` as `opencode.jsonc.bak`
2. Added the `qwen` provider definition (same format as NBG sandbox) pointing
   to the GPU-1 llama.cpp NPM endpoint
   (`qwen38-27b-mtp.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at`)
3. Verified the JSON is valid and the file mode is `600`
4. Tested with `opencode run -m qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf` —
   model responded correctly
5. Added `a1-qwen38-27b` Kandev agent profile to the `agent_profiles` table
   in `/data/data/kandev.db`:
   ```sql
   -- Linked to the opencode-acp agent (6131b727-...)
   -- Model: qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf, mode: build
   -- Inserted with id=fd40b2af-366a-42e6-92f8-77669f4eb2c7
   ```
6. Verified both profiles exist: `a1-deepseek-v4.0-flash` and `a1-qwen38-27b`

## Current state

Two Kandev agent profiles are now configured:

| Name | Model | Enabled |
|---|---|---|
| `a1-deepseek-v4.0-flash` | `a1-dsv4f/a1-dsv4f` | yes |
| `a1-qwen38-27b` | `qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf` | yes |

To use via CLI:
```
opencode run -m qwen/Qwen3.8-27B-UD-Q8_K_XL.gguf
```
