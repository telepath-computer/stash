#!/usr/bin/env bash
set -euo pipefail

DOCKER="${DOCKER:-$(command -v docker 2>/dev/null || command -v podman 2>/dev/null)}"
if [ -z "$DOCKER" ]; then
  echo "Neither docker nor podman found on PATH" >&2
  exit 1
fi

IMAGE_NAME="stash-test-linux"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Using $DOCKER"
echo "Building test image..."
$DOCKER build -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE_NAME" "$PROJECT_ROOT"

MODE="${1:-unit}"

case "$MODE" in
  unit)
    echo "Running unit + integration tests..."
    $DOCKER run --rm "$IMAGE_NAME" npm test
    ;;
  e2e)
    if [ -z "${GITHUB_TOKEN:-}" ]; then
      echo "GITHUB_TOKEN is required for e2e tests" >&2
      exit 1
    fi
    echo "Running e2e tests..."
    $DOCKER run --rm -e "GITHUB_TOKEN=$GITHUB_TOKEN" "$IMAGE_NAME" npm run test:e2e
    ;;
  all)
    if [ -z "${GITHUB_TOKEN:-}" ]; then
      echo "GITHUB_TOKEN is required for the full suite" >&2
      exit 1
    fi
    echo "Running full test suite..."
    $DOCKER run --rm -e "GITHUB_TOKEN=$GITHUB_TOKEN" "$IMAGE_NAME" npm run test:all
    ;;
  *)
    echo "Usage: $0 [unit|e2e|all]" >&2
    exit 1
    ;;
esac
