# rwnix-infra

## Rules

### Deploy after testing — always

Recurring mistake (user-reported repeatedly, 2026-10-04): a fix verified in the git worktree but never rolled out to the live host, so the user keeps seeing the old behavior and re-reports the same bug. Changes to live-deployed services (e.g. `jarvis/`) are only complete when the live instance is running them. The user tests the running service, not the worktree.

1. Verify the implementation in the worktree (unit + browser tests, regression test for the reported symptom).
2. Immediately deploy with the documented procedure. For Jarvis (vm104 is **not** a git checkout; files are copied in): back up first (`/home/ubuntu/docker/jarvis-code.bak-<ts>.tgz`, code only, `.env` untouched), sync the changed files to `/home/ubuntu/docker/jarvis`, then `docker compose up -d --build` on vm104 (see `jarvis/DEPLOYMENT.md`).
3. Verify the live instance: container `healthy`, `/api/health` ok, and the served artifacts match the source (md5 of the served `app.js` / key strings in served HTML/CSS).
4. Only then report completion; when static assets changed, tell the user a browser hard refresh (Ctrl+Shift+R) is needed.

Never report a fix as done based on worktree tests alone.

See `kandev-opencode-dsv4f-setup.md` for the Kandev opencode setup details.
See `kandev-opencode-qwen-setup.md` for the Kandev opencode a1-qwen38-27b setup details.
See `kandev-credential-setup.md` for the Kandev GitHub PAT credential setup.
See `kandev-ssh-ps1-setup.md` for the kandev104 SSH key and PS1/bash settings.
See `scripts/check-hosts/` for the mesh-test script and host list (copies; source of truth is `kirks2003/rw_mesh`).
See `scripts/host/mesh-password-rotate.py` for the emergency password rotation tool (copy; source of truth is `kirks2003/rw_mesh`).
See `jarvis/README.md` for the browser voice assistant (wake word, Whisper STT, brain, HAL 9000 answer voice, MCP web-search toggle) and `jarvis/DEPLOYMENT.md` for its live deployment, the gpu-1 Whisper/TTS service, the MCP web-search server and the measured voice-pipeline findings.
