# kandev104: SSH keys and PS1/bash setup

## SSH keys

The shared `kandev` Ed25519 key pair is stored in `/data/home/.ssh/`:

| File | Mode | Description |
|---|---|---|
| `id_ed25519` | 600 | Private key |
| `id_ed25519.pub` | 644 | Public key |
| `kandev` | symlink → `id_ed25519` | Convenience symlink |
| `kandev.pub` | symlink → `id_ed25519.pub` | Convenience symlink |
| `authorized_keys` | 600 | Same public key (pre-existing, allows key-only login) |

Fingerprint: `SHA256:/1xfmrDI0Y4EjdD+PZOPIYnruP0BHiDCQ3ZC7vVBc9Y` (Ed25519)

This is the shared `kandev` key used across the entire mesh — NBG, VIE-1, all
OpenWrt routers, PVE hosts, GPU hosts, and VM hosts. It is authorized for
key-only SSH login as both `kandev` and `root` on kandev104.

It is **not** a GitHub deploy key. The `rwnix-infra` repo uses a GitHub PAT
for git operations (see `kandev-credential-setup.md`).

## PS1 / bash settings

### `kandev` user (`/data/home/.bashrc`)

Green prompt with static `kandev104` label, matching the NBG/VIE-1 sandbox
PS1 convention:

```
export PATH="/data/.npm-global/bin:$PATH"
PS1='\[\033[1;32m\]\u\[\033[1;37m\]@\[\033[1;36m\]kandev104\[\033[00m\]:\[\033[1;34m\]$PWD\[\033[00m\] \$> '
```

### `root` user (`/root/.bashrc`)

Red prompt (root colour), same `kandev104` label:

```
export PATH="/data/.npm-global/bin:$PATH"
PS1='\[\033[1;31m\]\u\[\033[1;37m\]@\[\033[1;36m\]kandev104\[\033[00m\]:\[\033[1;34m\]$PWD\[\033[00m\] \$> '
```

### Color scheme

| User | Colour | Escape code |
|---|---|---|
| `kandev` | green | `\[\033[1;32m\]` |
| `root` | red | `\[\033[1;31m\]` |
| separator `@` | white | `\[\033[1;37m\]` |
| hostname label | cyan | `\[\033[1;36m\]` |
| path | blue | `\[\033[1;34m\]` |

## What was done (2026-10-03)

1. Transferred the shared `kandev` Ed25519 private and public key files to
   `/data/home/.ssh/id_ed25519` and `id_ed25519.pub` via scp through the
   two-hop SSH path (NBG sandbox → vm104 → container loopback 2222)
2. Set file permissions: private key `600`, public key `644`
3. Created convenience symlinks `kandev → id_ed25519` and
   `kandev.pub → id_ed25519.pub` (same pattern as NBG/VIE-1 sandboxes)
4. Verified fingerprint matches `SHA256:/1xfmrDI0Y4EjdD…`
5. Set PS1 for `kandev` user in `/data/home/.bashrc`: green prompt with
   static `kandev104` hostname label, full `$PWD`, `\$>` prompt ending
6. Set PS1 for `root` user in `/root/.bashrc`: same format but red colour
7. Verified effective PS1 on both users via `bash -l -i -c 'printf "%s\n" "$PS1"'`

## Verification

The SSH key is correctly installed and the prompt renders:

```
$ ssh -J vm104 -p 2222 kandev@127.0.0.1
kandev@kandev104:/data/home $ ssh-keygen -lf ~/.ssh/id_ed25519
256 SHA256:/1xfmrDI0Y4EjdD+PZOPIYnruP0BHiDCQ3ZC7vVBc9Y kandev (ED25519)
```

## Caveats

- The SSH key is copied only to the `kandev` user's `.ssh/` directory. Root's
  access comes from the entrypoint script which copies `/data/home/.ssh/`
  contents to `/root/.ssh/` at container start.
- If the container is recreated without preserving `/data`, the SSH keys need
  to be re-deployed (they live in the bind-mounted `./data` directory).
- The PS1 uses a static `kandev104` label rather than the dynamic `\h` or
  `\H` hostname escape, matching the NBG/VIE-1 sandbox convention.
