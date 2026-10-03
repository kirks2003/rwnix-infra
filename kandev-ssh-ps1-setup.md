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

Both `kandev` and `root` users share the same `.bashrc` structure — a
conditional EUID check renders the prompt red for root and green for
regular users, plus color-enabled `ls`/`grep` aliases and common shortcuts.

### `kandev` user (`/data/home/.bashrc`)

```
if [ "$EUID" -eq 0 ]; then
    PS1='\[\033[1;31m\]\u\[\033[1;37m\]@\[\033[1;36m\]kandev104\[\033[00m\]:\[\033[1;34m\]$PWD\[\033[00m\] \$> '
else
    PS1='\[\033[1;32m\]\u\[\033[1;37m\]@\[\033[1;36m\]kandev104\[\033[00m\]:\[\033[1;34m\]$PWD\[\033[00m\] \$> '
fi

if [ -x /usr/bin/dircolors ]; then
    test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
    alias ls='ls --color=auto'
    alias grep='grep --color=auto'
fi
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

export PATH="$HOME/scripts/check-hosts:$PATH"
export SCRIPTS="$HOME/scripts/check-hosts"
alias SCRIPTS='cd "$SCRIPTS"'
```

### `root` user (`/root/.bashrc`)

Same content as the `kandev` user file (the EUID conditional handles the
colour automatically). Root's `.bashrc` is written directly rather than
relying on the entrypoint copy, ensuring the red prompt works even if the
entrypoint copy fails.

### `.profile` (`/data/home/.profile`)

Sourced for login shells; sources `.bashrc` when running under bash:

```
# ~/.profile: executed by the command interpreter for login shells.
# Source .bashrc for interactive non-login shells (and aliases)
if [ -n "$BASH_VERSION" ]; then
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi
```

### Color scheme

| Role | Colour | Escape code |
|---|---|---|
| `root` prompt | red | `\[\033[1;31m\]` |
| regular user prompt | green | `\[\033[1;32m\]` |
| separator `@` | white | `\[\033[1;37m\]` |
| hostname label | cyan | `\[\033[1;36m\]` |
| path | blue | `\[\033[1;34m\]` |

### Comparison: NBG sandbox vs kandev104

| Feature | NBG sandbox | kandev104 |
|---|---|---|
| Default shell (`kandev`) | `/bin/bash` | `/bin/bash` |
| PS1 style | conditional EUID (red/green) | conditional EUID (red/green) |
| Hostname label | `kandev.gw-1-vie-1-at-netcup` | `kandev104` |
| dircolors + color aliases | yes (`ls`, `grep`) | yes (`ls`, `grep`) |
| `ll`/`la`/`l` aliases | yes | yes |
| `SCRIPTS` path and alias | yes | yes |
| `.profile` format | bash-version guard | bash-version guard |
| Root `.bashrc` | empty (entrypoint copy) | standalone (EUID conditional) |
| `SHELL` env var | `/bin/bash` | `/bin/bash` |

## What was done (2026-10-03)

1. Transferred the shared `kandev` Ed25519 private and public key files to
   `/data/home/.ssh/id_ed25519` and `id_ed25519.pub` via scp through the
   two-hop SSH path (NBG sandbox → vm104 → container loopback 2222)
2. Set file permissions: private key `600`, public key `644`
3. Created convenience symlinks `kandev → id_ed25519` and
   `kandev.pub → id_ed25519.pub` (same pattern as NBG/VIE-1 sandboxes)
4. Verified fingerprint matches `SHA256:/1xfmrDI0Y4EjdD…`
5. Set initial PS1 for `kandev` user (green) and `root` user (red) with
   static `kandev104` label
6. **Later (comparison fix):** replaced `.bashrc` files with NBG-parity
   version — conditional EUID PS1, dircolors/color aliases, `ll`/`la`/`l`
   shortcuts, `SCRIPTS` path and alias, and NBG-matching `.profile`
7. Verified effective PS1 on both users via `bash -l -i -c`
8. **Found and fixed `SHELL` env var:** the base image
   (`ghcr.io/kdlbs/kandev:v0.96.0`) sets `SHELL=/bin/sh` by default, so the
   Kandev UI terminal launched `/bin/sh` (dash) instead of `/bin/bash` and
   showed only `$`. Added `SHELL: /bin/bash` to the compose environment and
   recreated the container. Now both root and `kandev` users have
   `SHELL=/bin/bash` and the terminal shows the coloured prompt.

## Verification

The SSH key is correctly installed:

```
$ ssh -J vm104 -p 2222 kandev@127.0.0.1
kandev@kandev104:~ $ ssh-keygen -lf ~/.ssh/id_ed25519
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
