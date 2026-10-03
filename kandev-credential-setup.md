# Kandev workspace credential setup (GitHub PAT)

## Overview

Kandev uses workspace-level credentials to authenticate with GitHub for git
operations (clone, push, fetch) and GitHub Actions automation (auto-fix,
auto-merge, PR management). The credential is stored as an encrypted secret
in the Kandev database (`kandev.db`).

## Credential types

Kandev supports three GitHub connection sources, stored in the
`github_workspace_connections` table:

| Source | Description |
|---|---|
| `pat` | Personal Access Token (classic or fine-grained) |
| `gh_cli` | GitHub CLI (`gh`) authentication |
| `github_app_installation` | GitHub App installation (managed OAuth) |

## How to set up a PAT credential

### Prerequisites

- A GitHub PAT with `repo` scope (for private repos) or `public_repo` scope
  (for public repos). If using fine-grained PATs, grant at minimum
  `Contents: Write` and `Pull Requests: Write` permissions.
- Kandev server access to update the database.

### Step 1: Store the PAT as a workspace secret

The PAT is encrypted at rest in the `secrets` table:

```sql
INSERT INTO secrets (id, name, user_id, scope, workspace_id, encrypted_value, nonce, created_at, updated_at)
VALUES (
  'github:workspace:<workspace_id>:pat',
  'GitHub workspace PAT',
  '',
  'global',
  '',
  <encrypted_token>,
  <nonce>,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
```

The secret ID for the workspace PAT follows the convention
`github:workspace:<workspace_id>:pat`.

### Step 2: Create the workspace connection

Record the connection type and linked GitHub account in
`github_workspace_connections`:

```sql
INSERT INTO github_workspace_connections
  (workspace_id, source, github_host, login, status, credential_generation, created_at, updated_at)
VALUES
  ('<workspace_id>', 'pat', 'github.com', '<github_username>', 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
```

### Step 3: Configure credential mode

The `github_workspace_settings` table controls how credentials are injected
into git operations:

- `managed` — Kandev automatically injects credentials into git operations
  (push, fetch, clone) via credential helpers or URL embedding.
- `executor` — The executor is responsible for its own credential setup.

```sql
UPDATE github_workspace_settings
SET task_git_credentials_mode = 'managed'
WHERE workspace_id = '<workspace_id>';
```

### Step 4: (Optional) Bind GITHUB_TOKEN to a repository

For GitHub Actions workflows that need a `GITHUB_TOKEN`-compatible secret,
create a workspace-scoped secret and bind it to a repository:

```sql
-- Create a GITHUB_TOKEN secret
INSERT INTO secrets (id, name, scope, workspace_id, encrypted_value, nonce, created_at, updated_at)
VALUES (
  '<uuid>', 'GITHUB_TOKEN', 'workspace', '<workspace_id>',
  <encrypted_token>, <nonce>, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

-- Bind it to a repository
INSERT INTO repository_secret_bindings (repository_id, key, secret_id, created_at, updated_at)
VALUES ('<repository_id>', 'GITHUB_TOKEN', '<secret_uuid>', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
```

This makes the token available to the executor's GitHub Actions operations
for that repository.

## Current setup (rwnix-infra workspace)

| Setting | Value |
|---|---|
| Workspace ID | `1f30614b-e0f6-4382-9bf2-89192b6140c8` |
| GitHub connection | PAT (`kirks2003` on `github.com`) |
| Credential mode | `managed` |
| GITHUB_TOKEN bound to | `kirks2003/rwnix-infra` (repo `5029a217`) |
| Local repo path | `/data/repos/workspaces/1f30614b-e0f6-4382-9bf2-89192b6140c8/github/kirks2003/rwnix-infra` |

The PAT is encrypted in the `secrets` table as
`github:workspace:1f30614b-e0f6-4382-9bf2-89192b6140c8:pat`.

With `task_git_credentials_mode = 'managed'`, Kandev automatically injects
the PAT credential into git push, fetch, and clone operations, enabling
Kandev to push branches, create PRs, and trigger GitHub Actions workflows.
