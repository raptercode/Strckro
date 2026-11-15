#!/usr/bin/env bash
# Strckro release bootstrap. Serve this file verbatim over HTTPS.
set -Eeuo pipefail
umask 077

REPO_URL='https://github.com/raptercode/Strckro'
LEGACY_REPO_URL='https://github.com/raptercode/dashboard-portal-control'
VERSION=''
DOMAIN=''
EMAIL=''
NODE_MAJOR='24'
NO_UI=false
UI_PUBLIC=false
UI_PORT=''
WORK_DIR=''
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'Usage: install.sh [--version v1.2.1] [--domain=portal.example.com] [--email=admin@example.com] [--node-major=20|22|24|26]' \
    'Without --version, installs the latest published stable release.' \
    'Since v1.2.0, omitting domain and email starts the temporary Setup UI on 127.0.0.1.' \
    '  --no-ui       Use terminal prompts for missing settings and the initial password.' \
    '  --ui-port=N   Change the Setup UI port (default 8787).' \
    '  --ui-public   Listen on all interfaces over plain HTTP. Use only on a trusted network.' \
    'Pinned releases before v1.2.0 use terminal prompts.'
}
bad_argument() { printf 'ERROR: %s\n' "$*" >&2; usage >&2; exit 64; }
while (( $# )); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --version|--domain|--email|--node-major|--ui-port)
      (( $# >= 2 )) && [[ -n "$2" && "$2" != --* ]] || bad_argument "Missing value for $1"
      case "$1" in
        --version) VERSION="$2" ;;
        --domain) DOMAIN="$2" ;;
        --email) EMAIL="$2" ;;
        --node-major) NODE_MAJOR="$2" ;;
        --ui-port) UI_PORT="$2" ;;
      esac
      shift 2 ;;
    --version=*) VERSION="${1#*=}"; [[ -n "$VERSION" ]] || bad_argument 'Empty version'; shift ;;
    --domain=*) DOMAIN="${1#*=}"; [[ -n "$DOMAIN" ]] || bad_argument 'Empty domain'; shift ;;
    --email=*) EMAIL="${1#*=}"; [[ -n "$EMAIL" ]] || bad_argument 'Empty email'; shift ;;
    --node-major=*) NODE_MAJOR="${1#*=}"; shift ;;
    --no-ui) NO_UI=true; shift ;;
    --ui-public) UI_PUBLIC=true; shift ;;
    --ui-port=*) UI_PORT="${1#*=}"; [[ -n "$UI_PORT" ]] || bad_argument 'Empty Setup UI port'; shift ;;
    *) bad_argument "Unknown argument: $1" ;;
  esac
done
[[ -z "$VERSION" || "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || bad_argument 'Version must be a stable tag such as v1.1.0'
[[ "$NODE_MAJOR" =~ ^(20|22|24|26)$ ]] || bad_argument 'Node major must be 20, 22, 24 or 26'
if [[ -n "$UI_PORT" ]]; then
  [[ "$UI_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$UI_PORT >= 1 && 10#$UI_PORT <= 65535 )) || bad_argument 'Setup UI port must be between 1 and 65535'
  UI_PORT=$((10#$UI_PORT))
fi
for tool in curl tar sha256sum mktemp dpkg python3 openssl; do
  command -v "$tool" >/dev/null || die "Required command missing: $tool (bootstrap needs Python 3 and OpenSSL 3 for signature verification)"
done
[[ -r /etc/os-release ]] || die 'An Ubuntu or Debian server is required'
OS_RELEASE="$(. /etc/os-release; printf '%s:%s' "${ID:-}" "${VERSION_ID:-}")"
case "$OS_RELEASE" in
  ubuntu:22.04|ubuntu:24.04|ubuntu:25.04|debian:12|debian:13) ;;
  *) die 'Ubuntu 22.04, 24.04 or 25.04, or Debian 12 or 13 is required' ;;
esac
ARCHITECTURE="$(dpkg --print-architecture)"
[[ "$ARCHITECTURE" == amd64 || "$ARCHITECTURE" == arm64 ]] || die 'amd64 or arm64 is required'
if (( EUID != 0 )); then
  command -v sudo >/dev/null || die 'sudo is required for installation'
fi

if [[ -z "$VERSION" ]]; then
  RELEASE_URL="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 --output /dev/null --write-out '%{url_effective}' "${REPO_URL}/releases/latest")" || die 'Could not resolve latest stable release'
  VERSION="${RELEASE_URL##*/}"
  [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Latest release is not a supported stable tag'
  # Accept the historical GitHub repository name for signed older releases.
  case "$RELEASE_URL" in
    "$REPO_URL/releases/tag/$VERSION"|"$LEGACY_REPO_URL/releases/tag/$VERSION") ;;
    *) die 'Unexpected latest release URL' ;;
  esac
fi

# Older pinned releases do not recognise the Setup UI flags.
SUPPORTS_UI=true
if [[ "$VERSION" == v0.* || "$VERSION" == v1.0.* || "$VERSION" == v1.1.* ]]; then
  SUPPORTS_UI=false
  [[ ( "$OS_RELEASE" == ubuntu:24.04 || "$OS_RELEASE" == ubuntu:25.04 ) && "$ARCHITECTURE" == amd64 ]] || die 'This pinned release requires Ubuntu 24.04 or 25.04 on amd64'
fi
USE_UI=false
if [[ "$SUPPORTS_UI" == true && "$NO_UI" == false && -z "$DOMAIN" && -z "$EMAIL" ]]; then
  USE_UI=true
fi
if [[ "$USE_UI" == true ]]; then
  exec 3</dev/null
else
  # The piped script occupies stdin. Give the installer a separate terminal for prompts.
  { exec 3<>/dev/tty; } 2>/dev/null || die 'An interactive terminal is required. Run from an SSH terminal.'
  if [[ -z "$DOMAIN" ]]; then
    printf 'Portal domain (e.g. portal.example.com): ' >&3
    IFS= read -r DOMAIN <&3 || die 'Could not read domain'
  fi
  if [[ -z "$EMAIL" ]]; then
    printf 'TLS email (e.g. admin@example.com): ' >&3
    IFS= read -r EMAIL <&3 || die 'Could not read email'
  fi
  [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$ ]] || bad_argument 'A lower-case FQDN is required'
  [[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || bad_argument 'A valid email is required'
  if (( EUID != 0 )); then
    sudo -v <&3 || die 'sudo authorization failed'
  fi
fi
printf 'Installing Strckro %s (Node %s)\n' "$VERSION" "$NODE_MAJOR" >&2
WORK_DIR="$(mktemp -d)"
cleanup() { [[ -z "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ARCHIVE="strckro-${VERSION#v}.tar.gz"
BASE_URL="${REPO_URL}/releases/download/${VERSION}"
download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 600 --output "$2" "$1" || die "Download failed: $1"
}
verify_manifest() {
  # Match the release signer: sorted UTF-8 JSON with no formatting whitespace.
  python3 -I - "$WORK_DIR" "$VERSION" "$BASE_URL/$ARCHIVE" "$LEGACY_REPO_URL/releases/download/$VERSION/$ARCHIVE" <<'PY' || die 'Invalid signed release manifest'
import base64
import json
import re
import sys
from pathlib import Path

def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result

work, tag, url, legacy_url = Path(sys.argv[1]), *sys.argv[2:]
try:
    with (work / "stable.json").open("rb") as stream:
        body = stream.read(16385)
    if len(body) > 16384:
        raise ValueError("manifest too large")
    manifest = json.loads(body.decode("utf-8"), object_pairs_hook=unique_keys)
    if not isinstance(manifest, dict) or set(manifest) != {"payload", "signature"}:
        raise ValueError("invalid envelope")
    payload = manifest["payload"]
    fields = {"channel", "version", "publishedAt", "archiveUrl", "archiveSha256"}
    if not isinstance(payload, dict) or set(payload) - {"notes"} != fields or not all(isinstance(value, str) for value in payload.values()):
        raise ValueError("invalid payload")
    if payload["channel"] != "stable" or payload["version"] != tag[1:] or payload["archiveUrl"] not in (url, legacy_url):
        raise ValueError("wrong release")
    digest = payload["archiveSha256"]
    if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise ValueError("invalid archive digest")
    signature = base64.b64decode(manifest["signature"], validate=True)
    if len(signature) != 64:
        raise ValueError("invalid Ed25519 signature length")
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
except (ValueError, TypeError, RecursionError):
    sys.exit(1)

(work / "manifest.payload").write_bytes(canonical)
(work / "manifest.sig").write_bytes(signature)
(work / "archive.sha256").write_text(digest.lower(), encoding="ascii")
PY
  cat > "$WORK_DIR/release-key.pem" <<'PEM'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAU20o2KHW9QJvhK9Z34T31SQJ6raPqwyC0fxlZwQbtVA=
-----END PUBLIC KEY-----
PEM
  openssl pkeyutl -verify -pubin -inkey "$WORK_DIR/release-key.pem" -rawin \
    -in "$WORK_DIR/manifest.payload" -sigfile "$WORK_DIR/manifest.sig" > /dev/null 2>&1 || die 'Invalid Ed25519 release signature'
}
download "$BASE_URL/stable.json" "$WORK_DIR/stable.json"
verify_manifest
download "$BASE_URL/$ARCHIVE" "$WORK_DIR/$ARCHIVE"
printf '%s  %s\n' "$(<"$WORK_DIR/archive.sha256")" "$WORK_DIR/$ARCHIVE" | sha256sum --check --status || die 'Release checksum mismatch'
printf 'Release signature and checksum verified\n' >&2
# Official release archives contain regular files and directories at the root.
# Refuse links and special files, as well as absolute/traversing member names.
tar -tzf "$WORK_DIR/$ARCHIVE" > "$WORK_DIR/members" || die 'Invalid release archive'
while IFS= read -r member; do
  case "$member" in
    /*|..|../*|*/../*|*/..) die 'Unsafe archive path' ;;
  esac
done < "$WORK_DIR/members"
tar -tvzf "$WORK_DIR/$ARCHIVE" > "$WORK_DIR/types" || die 'Could not inspect archive'
while IFS= read -r member; do
  [[ "$member" == -* || "$member" == d* ]] || die 'Archive contains links or special files'
done < "$WORK_DIR/types"
mkdir "$WORK_DIR/release"
tar -xzf "$WORK_DIR/$ARCHIVE" --no-same-owner --no-same-permissions -C "$WORK_DIR/release" || die 'Could not extract release'
[[ -f "$WORK_DIR/release/strckro.sh" && -f "$WORK_DIR/release/package.json" ]] || die 'Release is missing its installer or package.json'
INSTALLER=(bash ./strckro.sh "--node-major=$NODE_MAJOR")
if [[ "$USE_UI" == true ]]; then
  if [[ -n "$UI_PORT" ]]; then INSTALLER+=("--ui-port=$UI_PORT"); fi
  if [[ "$UI_PUBLIC" == true ]]; then INSTALLER+=(--ui-public); fi
  printf 'Starting the Strckro Setup UI\n' >&2
else
  INSTALLER+=("--domain=$DOMAIN" "--email=$EMAIL")
  if [[ "$SUPPORTS_UI" == true ]]; then INSTALLER+=(--no-ui); fi
  printf 'Running release installer; password input is hidden\n' >&2
fi
if (( EUID != 0 )); then INSTALLER=(sudo "${INSTALLER[@]}"); fi
INSTALL_STATUS=0
(cd "$WORK_DIR/release" && "${INSTALLER[@]}" <&3) || INSTALL_STATUS=$?
if (( INSTALL_STATUS != 0 )); then
  printf 'ERROR: Release installer failed (exit %s). Review its output and rollback report above.\n' "$INSTALL_STATUS" >&2
  exit "$INSTALL_STATUS"
fi
# Setup UI reports its own result. The terminal installer verifies services, Nginx and HTTPS health.
if [[ "$USE_UI" == true ]]; then exit 0; fi
printf '\nStrckro installed successfully\nVersion: %s\nURL: https://%s\nPortal Node major: %s\nServices and HTTPS health checks: passed\nLogs: sudo journalctl -u dashboard-portal -n 100 --no-pager\n' "$VERSION" "$DOMAIN" "$NODE_MAJOR"
