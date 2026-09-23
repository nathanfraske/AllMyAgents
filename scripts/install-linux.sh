#!/usr/bin/env bash
# Download/verify the released Ubuntu remote-execution node, then optionally configure it.
# No source checkout, vendor login, npm, desktop session, SSH fallback, or OS reboot.
set -euo pipefail
usage() {
  printf '%s\n' 'Usage: bash install-linux.sh [--tag vVERSION] [--profile full-machine|elevated-machine|linux-sudo-machine] [--mesh-socket PATH]'
  printf '%s\n' 'Without --profile, only installs the package; no service or access grant is created.'
  printf '%s\n' 'full-machine runs as your user. elevated-machine runs as root. linux-sudo-machine creates a passwordless-sudo service account.'
}
tag=''
profile=''
socket=''
while (($#)); do
  case "$1" in
    --tag|--profile|--mesh-socket)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in --tag) tag="$2";; --profile) profile="$2";; --mesh-socket) socket="$2";; esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ $(uname -s) == Linux ]] || { echo 'This installer requires Linux.' >&2; exit 1; }
case "$profile" in ''|full-machine|elevated-machine|linux-sudo-machine) ;; *) usage >&2; exit 2;; esac
if [[ "$profile" == full-machine && $EUID == 0 ]]; then
  echo 'Run this installer as your ordinary user for full-machine. It asks for sudo only to install the package.' >&2; exit 2
fi
case $(uname -m) in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo 'No released package for this architecture.' >&2; exit 1;; esac
for tool in curl python3 sha256sum apt-get; do command -v "$tool" >/dev/null || { echo "Required installer tool missing: $tool" >&2; exit 1; }; done
elevate=()
if ((EUID != 0)); then command -v sudo >/dev/null; elevate=(sudo); fi
endpoint='https://api.github.com/repos/nathanfraske/AllMyAgents/releases/latest'
if [[ -n "$tag" ]]; then
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid release tag.' >&2; exit 2; }
  endpoint="https://api.github.com/repos/nathanfraske/AllMyAgents/releases/tags/$tag"
fi
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT # Exact mktemp-owned directory, never an install/data root.
curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --max-time 60 "$endpoint" -o "$work/release.json"
mapfile -t assets < <(python3 - "$work/release.json" "$arch" <<'PY'
import json, re, sys
r = json.load(open(sys.argv[1]))
matches = [a for a in r.get('assets', []) if re.fullmatch(r'allmyagents-testbed_[0-9.]+_' + re.escape(sys.argv[2]) + r'\.deb', a['name'])]
if len(matches) != 1:
    sys.exit('This release has no unique testbed package for your architecture. No installation was attempted.')
a = matches[0]
s = [v for v in r['assets'] if v['name'] == a['name'] + '.sha256']
if len(s) != 1: sys.exit('The release checksum is missing or ambiguous.')
for v in [a, s[0]]:
    if not v['browser_download_url'].startswith('https://github.com/nathanfraske/AllMyAgents/releases/download/'):
        sys.exit('Unexpected release asset origin.')
print(a['name']); print(a['browser_download_url']); print(s[0]['browser_download_url'])
PY
)
[[ ${#assets[@]} == 3 ]] || exit 1
curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --max-time 600 "${assets[1]}" -o "$work/${assets[0]}"
curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --max-time 60 "${assets[2]}" -o "$work/checksum"
# Validate the checksum filename as well as the digest; never interpret release text as a shell command.
expected=$(awk -v file="${assets[0]}" 'NF == 2 && $2 == file {print $1}' "$work/checksum")
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { echo 'Malformed release checksum.' >&2; exit 1; }
printf '%s  %s\n' "$expected" "$work/${assets[0]}" | sha256sum --check -
chmod 755 "$work"
chmod 644 "$work/${assets[0]}"
"${elevate[@]}" apt-get install -y "$work/${assets[0]}"
case "$profile" in
  full-machine)
    env ${socket:+"MYOWNMESH_CONTROL_SOCKET=$socket"} allmyagents-testbed install-user --profile full-machine ;;
  elevated-machine|linux-sudo-machine)
    "${elevate[@]}" env ${socket:+"MYOWNMESH_CONTROL_SOCKET=$socket"} allmyagents-testbed install-elevated --profile "$profile" ;;
  '') echo 'Package installed. Next select a profile with allmyagents-testbed --help.' ;;
esac
echo 'MyOwnMesh must be installed and joined to your network. Pair the node in AllMyAgents, then authorize it for your chat/project.'
echo 'An upgrade does not restart an already-running service. Drain runs first, then explicitly restart that testbed service; no OS reboot.'
