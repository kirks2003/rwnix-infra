# kandev104: opencode a1-dsv4f setup

## Filesystem changes

### `/data/home/.config/opencode/opencode.jsonc`

Provider definition for the DeepSeek V4 Flash model served by the GPU-2
vLLM endpoint:

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
specifying the full path.

```
export PATH="/data/.npm-global/bin:$PATH"
```

## Kandev DB (`/data/data/kandev.db`)

Table `agent_profiles`, row `25dff9b2-82a5-4a8b-a867-4a58df6ebc16`:

| Column | Before | After |
|---|---|---|
| `name` | `a1-deepseek-v4.0-flash` | unchanged |
| `model` | `opencode/big-pickle` (default) | `a1-dsv4f/a1-dsv4f` |
| `enabled` | `true` | unchanged |

Updated via:
```sql
UPDATE agent_profiles SET model='a1-dsv4f/a1-dsv4f' WHERE id='25dff9b2-...';
```

Backup: `/data/data/kandev.db.bak-pre-model-fix`

## What remains

The profile exists in the DB with the correct model reference, but the
opencode ACP server process does not start on kandev104. On the NBG/VIE-1
containers, ACP servers are managed by the Kandev supervisor
(`KANDEV_RESTART_ADAPTER=supervisor`) which is not set up on the fresh
kandev104 container.

To use the model on kandev104 via CLI (not Kandev agent profile):
```
opencode run -m a1-dsv4f/a1-dsv4f
```
