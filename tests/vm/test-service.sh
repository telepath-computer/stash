#!/usr/bin/env bash
#
# Test the stash background service lifecycle on a real Linux system.
# Meant to be run ON the VM (not locally).
#
set -euo pipefail

# Load nvm if present (needed when node is installed via nvm)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

WORKDIR="$(mktemp -d /tmp/stash-service-test-XXXX)"
XDG_DIR="$(mktemp -d /tmp/stash-xdg-XXXX)"
EXIT_CODE=0

cleanup() {
  XDG_CONFIG_HOME="$XDG_DIR" stash background uninstall 2>/dev/null || true
  rm -rf "$WORKDIR" "$XDG_DIR"
}
trap cleanup EXIT

# Enable lingering for root so systemctl --user works
if [ "$(id -u)" = "0" ]; then
  echo "Running as root — enabling linger..."
  loginctl enable-linger root 2>/dev/null || true
  export XDG_RUNTIME_DIR="/run/user/0"
  mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
fi

# Install stash globally (from local build)
echo "Installing stash globally from local source..."
cd /root/stash
npm run build 2>&1 || { echo "FAIL: build failed"; exit 1; }
npm install -g . 2>&1

STASH="$(which stash)"
echo "=== stash binary: $STASH ==="
echo "=== node: $(which node) ==="
echo "=== node path: $(readlink -f "$(which node)")  ==="
echo "=== workdir: $WORKDIR ==="

# Init a stash
export XDG_CONFIG_HOME="$XDG_DIR"
cd "$WORKDIR"
mkdir -p .stash
echo '{}' > .stash/state.json
echo "Stash dir initialized."

# Set up global config with a background stash
mkdir -p "$XDG_DIR/stash"
cat > "$XDG_DIR/stash/config.json" <<CONF
{
  "providers": {},
  "background": {
    "stashes": ["$WORKDIR"]
  }
}
CONF

echo "--- Installing service ---"
stash background install 2>&1 || { echo "FAIL: install failed"; EXIT_CODE=1; }

echo "--- Waiting for service to start ---"
sleep 3

echo "--- Checking service status ---"
stash background status 2>&1 || true

# Check systemd directly
if command -v systemctl &>/dev/null; then
  echo "--- systemctl status ---"
  systemctl --user status stash-background --no-pager 2>&1 || true

  echo "--- journalctl (last 20 lines) ---"
  journalctl --user -u stash-background --no-pager -n 20 2>&1 || true

  echo "--- Generated unit file ---"
  cat ~/.config/systemd/user/stash-background.service 2>&1 || true
fi

echo "--- Uninstalling service ---"
stash background uninstall 2>&1

echo "--- Service lifecycle test complete (exit=$EXIT_CODE) ---"
exit $EXIT_CODE
