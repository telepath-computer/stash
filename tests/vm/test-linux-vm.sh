#!/usr/bin/env bash
#
# Run the full Stash test suite on a real Linux VM (DigitalOcean).
#
# Env vars:
#   DO_TOKEN       - DigitalOcean API token (required)
#   GITHUB_TOKEN   - GitHub token for e2e tests (optional, e2e skipped without it)
#   VM_KEEP=1      - keep the droplet after tests (default: destroy)
#
# Usage:
#   ./tests/vm/test-linux-vm.sh [unit|e2e|service|all]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -z "${DO_TOKEN:-}" ]; then
  echo "DO_TOKEN is required" >&2
  exit 1
fi

MODE="${1:-all}"
DROPLET_NAME="stash-test-$(date +%s)"
REGION="nyc1"
SIZE="s-1vcpu-1gb"
IMAGE="ubuntu-24-04-x64"
SSH_KEY_FILE="$HOME/.ssh/id_ed25519"
API="https://api.digitalocean.com/v2"
DROPLET_ID=""
DROPLET_IP=""

do_api() {
  local method="$1" path="$2"; shift 2
  curl -sf -X "$method" "$API$path" \
    -H "Authorization: Bearer $DO_TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

cleanup() {
  if [ -n "$DROPLET_ID" ] && [ "${VM_KEEP:-}" != "1" ]; then
    echo "Destroying droplet $DROPLET_ID..."
    do_api DELETE "/droplets/$DROPLET_ID" || true
  elif [ -n "$DROPLET_ID" ]; then
    echo "Keeping droplet $DROPLET_ID at $DROPLET_IP (VM_KEEP=1)"
  fi
}
trap cleanup EXIT

# Upload SSH key to DO if not already present
SSH_PUB="$(cat "${SSH_KEY_FILE}.pub")"
SSH_FINGERPRINT="$(ssh-keygen -lf "${SSH_KEY_FILE}.pub" -E md5 | awk '{print $2}' | sed 's/MD5://')"
EXISTING_KEY=$(do_api GET "/account/keys" | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const k=d.ssh_keys.find(k=>k.fingerprint==='$SSH_FINGERPRINT');
  console.log(k?k.id:'');
" 2>/dev/null || echo "")

if [ -n "$EXISTING_KEY" ]; then
  SSH_KEY_ID="$EXISTING_KEY"
  echo "Using existing SSH key ($SSH_KEY_ID)"
else
  SSH_KEY_ID=$(do_api POST "/account/keys" -d "{\"name\":\"stash-test\",\"public_key\":\"$SSH_PUB\"}" | node -e "
    console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).ssh_key.id);
  ")
  echo "Uploaded SSH key ($SSH_KEY_ID)"
fi

# Create droplet
echo "Creating droplet $DROPLET_NAME ($SIZE in $REGION)..."
DROPLET_ID=$(do_api POST "/droplets" -d "{
  \"name\": \"$DROPLET_NAME\",
  \"region\": \"$REGION\",
  \"size\": \"$SIZE\",
  \"image\": \"$IMAGE\",
  \"ssh_keys\": [$SSH_KEY_ID]
}" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).droplet.id)")

echo "Waiting for droplet $DROPLET_ID to boot..."
for i in $(seq 1 60); do
  DROPLET_IP=$(do_api GET "/droplets/$DROPLET_ID" | node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).droplet;
    const net=d.networks.v4.find(n=>n.type==='public');
    console.log(net?net.ip_address:'');
  " 2>/dev/null || echo "")
  if [ -n "$DROPLET_IP" ]; then
    break
  fi
  sleep 3
done

if [ -z "$DROPLET_IP" ]; then
  echo "Droplet never got an IP" >&2
  exit 1
fi

echo "Droplet ready at $DROPLET_IP"

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR -i $SSH_KEY_FILE"
SSH="ssh $SSH_OPTS root@$DROPLET_IP"

# Wait for SSH
echo "Waiting for SSH..."
for i in $(seq 1 30); do
  if $SSH true 2>/dev/null; then
    break
  fi
  sleep 3
done

# Helper: run a command on the VM with nvm loaded
NVM_PREFIX='export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'

remote() {
  $SSH "bash -c '$NVM_PREFIX && $1'"
}

# Install Node.js via nvm (mirrors real user setup)
echo "Installing Node.js 22 via nvm..."
$SSH "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash" 2>&1 | tail -3
remote 'nvm install 22 && node --version && npm --version' 2>&1

# Sync project to VM
echo "Syncing project..."
rsync -az --delete \
  -e "ssh $SSH_OPTS" \
  --exclude node_modules --exclude dist --exclude .git --exclude .stash \
  "$PROJECT_ROOT/" "root@$DROPLET_IP:/root/stash/"

# Install dependencies on VM
echo "Installing dependencies..."
remote 'cd /root/stash && npm ci' 2>&1 | tail -3

run_remote() {
  local desc="$1" cmd="$2"
  echo ""
  echo "=== $desc ==="
  remote "cd /root/stash && $cmd"
}

EXIT_CODE=0

case "$MODE" in
  unit)
    run_remote "Unit + integration tests" "npm test" || EXIT_CODE=$?
    ;;
  e2e)
    run_remote "E2E tests" "npm run test:e2e" || EXIT_CODE=$?
    ;;
  service)
    run_remote "Systemd service test" "bash tests/vm/test-service.sh" || EXIT_CODE=$?
    ;;
  all)
    run_remote "Unit + integration tests" "npm test" || EXIT_CODE=$?
    run_remote "E2E tests" "npm run test:e2e" || EXIT_CODE=$?
    run_remote "Systemd service test" "bash tests/vm/test-service.sh" || EXIT_CODE=$?
    ;;
  *)
    echo "Usage: $0 [unit|e2e|service|all]" >&2
    exit 1
    ;;
esac

exit $EXIT_CODE
