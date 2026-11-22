# Test-only image: a systemd-booted OS that looks like a fresh VPS (no Node, no nginx).
# Deliberately minimal; the installer itself must install everything else.
ARG BASE=ubuntu:24.04
FROM ${BASE}
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus sudo curl ca-certificates iproute2 procps openssl \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
# Units that make no sense (or hang) inside a container.
RUN systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service sys-kernel-debug.mount sys-kernel-tracing.mount \
      getty.target console-getty.service systemd-logind.service || true
# Docker base images may block service autostart (policy-rc.d exit 101); a real host does not.
RUN rm -f /usr/sbin/policy-rc.d
# TEST-ONLY certbot stand-in (see shims/certbot); /usr/local/sbin precedes /usr/bin in PATH and sudo's secure_path.
COPY shims/certbot /usr/local/sbin/certbot
RUN chmod 0755 /usr/local/sbin/certbot
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
