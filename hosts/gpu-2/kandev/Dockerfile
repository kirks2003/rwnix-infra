FROM ghcr.io/kdlbs/kandev:v0.96.0@sha256:33c9211aea048af542fb68da80088dc28ab3ed947378dd12f97d98e7d2d2bf93

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        openssh-client openssh-server openssh-sftp-server \
        sshpass iputils-ping netcat-openbsd curl \
    && apt-get clean \
    && usermod -s /bin/bash kandev \
    && mkdir -p /run/sshd /etc/ssh/sshd_config.d \
    && rm -f /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub \
        /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub \
        /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub \
    && printf 'AuthorizedKeysFile /data/ssh/authorized_keys\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nPubkeyAuthentication yes\nStrictModes yes\nMaxAuthTries 3\nX11Forwarding no\n' \
        > /etc/ssh/sshd_config.d/00-kandev.conf

COPY entrypoint.sh /docker/entrypoint.sh
RUN chmod 755 /docker/entrypoint.sh
ENTRYPOINT ["/usr/bin/tini", "--", "/docker/entrypoint.sh"]
CMD ["kandev", "start", "--backend-port", "38429", "--verbose"]
