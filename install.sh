#!/usr/bin/env bash
# Public bootstrap (Ubuntu 22.04/24.04/25.04 and Debian 12/13, amd64 or arm64): serve this file as https://dashboard-portal.cloud/install.sh.
set -Eeuo pipefail
umask 077

REPO='https://github.com/raptercode/Strckro'
VERSION=''
NODE_MAJOR='24'
DOMAIN=''
EMAIL=''
NO_UI=false
UI_PUBLIC=false
UI_PORT='8787'
TMP_DIR=''
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'Latest stable: curl -fsSL https://dashboard-portal.cloud/install.sh | bash' \
    'Specific version: curl -fsSL https://dashboard-portal.cloud/install.sh | bash -s -- --version v1.1.0' \
    'Version tags must include v (e.g. v1.1.0). A domain and a valid TLS email are required.' \
    'Default: a temporary Setup UI web page collects them and shows live progress. It listens on 127.0.0.1 only;' \
    'the installer prints an ssh -L command and a one-time URL token (--ui-port=N, default 8787).' \
    '  --ui-public  listen on all interfaces over plain HTTP (only the token protects it; use on a trusted network).' \
    '  --no-ui      no web page: prompt for domain and email in the terminal (or pass --domain=D --email=E).' \
    'Supported hosts: Ubuntu 22.04, 24.04, 25.04 and Debian 12, 13 on amd64 or arm64.' \
    'Portal Node major defaults to 24; advanced option: --node-major=20|22|24|26.'
}
while (( $# )); do
  case "$1" in
    --version)
      [[ $# -ge 2 && -z "$VERSION" ]] || die '--version needs one version.'
      VERSION="$2"; shift 2 ;;
    --version=*) [[ -z "$VERSION" ]] || die 'Duplicate version.'; VERSION="${1#*=}"; shift ;;
    --node-major) [[ $# -ge 2 ]] || die '--node-major needs one major.'; NODE_MAJOR="$2"; shift 2 ;;
    --node-major=*) NODE_MAJOR="${1#*=}"; shift ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --email=*) EMAIL="${1#*=}"; shift ;;
    --no-ui) NO_UI=true; shift ;;
    --ui-public) UI_PUBLIC=true; shift ;;
    --ui-port) [[ $# -ge 2 ]] || die '--ui-port needs one port.'; UI_PORT="$2"; shift 2 ;;
    --ui-port=*) UI_PORT="${1#*=}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done
[[ -z "$VERSION" || "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Version must look like v1.1.0.'
[[ "$NODE_MAJOR" =~ ^(20|22|24|26)$ ]] || die 'Node major must be 20, 22, 24 or 26.'
[[ "$UI_PORT" =~ ^[0-9]{1,5}$ && "$UI_PORT" -ge 1 && "$UI_PORT" -le 65535 ]] || die '--ui-port must be a port number.'
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die 'A lower-case fully qualified domain is required.'
[[ -z "$EMAIL" || "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die 'A valid email is required.'
# The Setup UI is the default whenever neither a domain nor an email was supplied.
UI=true
if [[ "$NO_UI" == true || -n "$DOMAIN" || -n "$EMAIL" ]]; then UI=false; fi
[[ "$(uname -s)" == 'Linux' ]] || die 'Run on an Ubuntu or Debian server.'
source /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04|ubuntu:25.04|debian:12|debian:13) ;;
  *) die 'This release supports Ubuntu 22.04, 24.04 or 25.04 and Debian 12 or 13 only.' ;;
esac
case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) die 'This release supports amd64 and arm64 only.' ;;
esac
for tool in curl tar sha256sum mktemp; do command -v "$tool" >/dev/null || die "Required tool missing: $tool (on a minimal Debian image: apt-get install -y curl ca-certificates)"; done
if [[ $EUID -ne 0 ]]; then command -v sudo >/dev/null || die 'A sudo-capable account is required.'; fi
if [[ "$UI" == true ]]; then
  # No prompts and no terminal input: the page collects the settings and the installer it starts reads the
  # generated owner password from a pipe. stdin is the script under curl | bash, so the child gets /dev/null.
  exec 3>&1
  printf 'Strckro installation (Setup UI)\n' >&3
else
  # stdin contains the script when invoked through curl | bash. Keep every prompt,
  # sudo and the underlying password setup on the controlling terminal instead.
  { exec 3<>/dev/tty; } 2>/dev/null || die 'An interactive terminal is required; run the command over an interactive SSH session.'
  printf 'Strckro installation\n' >&3
  if [[ -z "$DOMAIN" ]]; then read -r -p 'Portal domain (e.g. portal.example.com): ' DOMAIN <&3; fi
  if [[ -z "$EMAIL" ]]; then read -r -p 'Email for TLS certificates: ' EMAIL <&3; fi
fi
[[ "$UI" == true ]] || [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die 'A lower-case fully qualified domain is required.'
[[ "$UI" == true ]] || [[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die 'A valid email is required.'
download() { curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --silent --show-error "$@"; }
if [[ -z "$VERSION" ]]; then
  RELEASE_URL="$(download -o /dev/null -w '%{url_effective}' "$REPO/releases/latest")"
  VERSION="${RELEASE_URL##*/}"
  [[ "$RELEASE_URL" == "$REPO/releases/tag/$VERSION" && "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Could not resolve the latest stable release.'
fi
TMP_DIR="$(mktemp -d /tmp/strckro-bootstrap.XXXXXX)"
trap '[[ -z "$TMP_DIR" ]] || rm -rf -- "$TMP_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ARCHIVE="strckro-${VERSION#v}.tar.gz"
printf 'Downloading Strckro %s...\n' "$VERSION" >&3
download "$REPO/releases/download/$VERSION/$ARCHIVE" -o "$TMP_DIR/$ARCHIVE"
download "$REPO/releases/download/$VERSION/$ARCHIVE.sha256" -o "$TMP_DIR/$ARCHIVE.sha256"
# Check exactly one digest for the requested archive; never execute filenames
# supplied by a remote checksum file or allow extra checksum entries.
CHECKSUM="$(cat "$TMP_DIR/$ARCHIVE.sha256")"
[[ "$CHECKSUM" =~ ^([a-fA-F0-9]{64})[[:space:]]+\*?([^[:space:]]+)$ ]] || die 'Invalid release checksum file.'
EXPECTED_HASH="${BASH_REMATCH[1]}"
[[ "${BASH_REMATCH[2]}" == "$ARCHIVE" ]] || die 'Checksum names a different archive.'
printf '%s  %s\n' "$EXPECTED_HASH" "$TMP_DIR/$ARCHIVE" | sha256sum --check --status || die 'Release checksum verification failed.'
mkdir "$TMP_DIR/release"
tar --extract --gzip --file "$TMP_DIR/$ARCHIVE" --directory "$TMP_DIR/release" --no-same-owner --no-same-permissions
[[ -f "$TMP_DIR/release/strckro.sh" && -f "$TMP_DIR/release/package.json" ]] || die 'Release is missing the installer or package metadata.'
cd "$TMP_DIR/release"
if [[ "$UI" == true ]]; then
  INSTALLER_ARGS=("--node-major=$NODE_MAJOR" "--ui-port=$UI_PORT")
  if [[ "$UI_PUBLIC" == true ]]; then INSTALLER_ARGS+=(--ui-public); fi
  if [[ $EUID -eq 0 ]]; then
    bash ./strckro.sh "${INSTALLER_ARGS[@]}" </dev/null
  else
    sudo -- bash ./strckro.sh "${INSTALLER_ARGS[@]}" </dev/null
  fi
elif [[ $EUID -eq 0 ]]; then
  bash ./strckro.sh "--domain=$DOMAIN" "--email=$EMAIL" "--node-major=$NODE_MAJOR" --no-ui <&3
else
  sudo -- bash ./strckro.sh "--domain=$DOMAIN" "--email=$EMAIL" "--node-major=$NODE_MAJOR" --no-ui <&3
fi
