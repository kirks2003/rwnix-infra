#!/bin/sh
set -eu

if [ "$(id -u)" != 0 ]; then
    exec "$@"
fi

mkdir -p /data/home /data/ssh /data/ssh/host_keys /root/.ssh /run/sshd
# /data itself ends up root-owned (sshd StrictModes), so on a fresh data dir
# kandev could not create its top-level paths: create them before the chown.
for dir in .npm-global attachments backups cache data logs plugins quick-chat \
        repos sessions supervisor tasks tmp; do
    mkdir -p "/data/$dir"
done
touch /data/.kandev-backend.lock
chown -R kandev:kandev /data
chown root:root /data /data/ssh /data/ssh/host_keys
chmod 755 /data /data/ssh
chmod 700 /data/ssh/host_keys /root/.ssh

if [ ! -f /data/ssh/authorized_keys ]; then
    cp /data/home/.ssh/authorized_keys /data/ssh/authorized_keys
fi
chown root:root /data/ssh/authorized_keys
chmod 644 /data/ssh/authorized_keys

# OpenSSH rejects foreign-owned config files, including symlink targets.
for file in config known_hosts kandev kandev.pub id_ed25519 id_ed25519.pub; do
    if [ -f "/data/home/.ssh/$file" ]; then
        rm -f "/root/.ssh/$file"
        cp -L "/data/home/.ssh/$file" "/root/.ssh/$file"
        chown root:root "/root/.ssh/$file"
        chmod 600 "/root/.ssh/$file"
    fi
done

# Root shares the kandev shell setup (PS1 policy: red for root via $EUID).
if [ -f /data/home/.bashrc ]; then
    cp -L /data/home/.bashrc /root/.bashrc
    chown root:root /root/.bashrc
    chmod 644 /root/.bashrc
fi

for type in rsa ecdsa ed25519; do
    key="/data/ssh/host_keys/ssh_host_${type}_key"
    if [ ! -f "$key" ]; then
        ssh-keygen -q -t "$type" -N "" -f "$key"
    fi
    chown root:root "$key" "$key.pub"
    chmod 600 "$key"
    chmod 644 "$key.pub"
done

/usr/sbin/sshd -t \
    -h /data/ssh/host_keys/ssh_host_rsa_key \
    -h /data/ssh/host_keys/ssh_host_ecdsa_key \
    -h /data/ssh/host_keys/ssh_host_ed25519_key
# No syslog in the container: run sshd in the foreground with stderr logging
# and append UTC-timestamped lines to a root-owned file that the host's
# fail2ban jail `kandev-sshd` reads (/home/ubuntu/docker/kandev/data/sshd-log/).
mkdir -p /data/sshd-log
chown root:root /data/sshd-log
chmod 755 /data/sshd-log
setsid sh -c '/usr/sbin/sshd -D -e \
    -h /data/ssh/host_keys/ssh_host_rsa_key \
    -h /data/ssh/host_keys/ssh_host_ecdsa_key \
    -h /data/ssh/host_keys/ssh_host_ed25519_key 2>&1 |
    while IFS= read -r line; do
        printf "%s sshd: %s\n" "$(date -u "+%Y-%m-%d %H:%M:%S")" "$line"
    done >> /data/sshd-log/sshd.log' </dev/null >/dev/null 2>&1 &
exec gosu kandev "$@"
