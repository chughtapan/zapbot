#!/usr/bin/env bash
set -euo pipefail

# Start zapbot: webhook bridge + agent-orchestrator for one project checkout.
# Usage: start.sh [project-dir]
#
# Run from a project directory that has agent-orchestrator.yaml (created by
# zapbot-team-init), or pass the path as the first argument.
#
# The bridge registers with the gateway at ZAPBOT_GATEWAY_URL. If no gateway
# is configured, the bridge just listens on its local port.

ZAPBOT_DIR="$(cd "$(dirname "$0")" && pwd)"

PROJECT_DIR=""
for arg in "$@"; do
  case "$arg" in
    --help) echo "Usage: start.sh [project-dir]"; exit 0 ;;
    *) [ -z "$PROJECT_DIR" ] && PROJECT_DIR="$arg" ;;
  esac
done
PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"

if [ ! -f "$PROJECT_DIR/agent-orchestrator.yaml" ]; then
  echo "ERROR: No agent-orchestrator.yaml in $PROJECT_DIR"
  echo "FIX: Run '$ZAPBOT_DIR/bin/zapbot-team-init' in your project first."
  exit 1
fi

[ -f "$PROJECT_DIR/.env" ] && set -a && source "$PROJECT_DIR/.env" && set +a
[ -f "$HOME/.zapbot/.env" ] && set -a && source "$HOME/.zapbot/.env" && set +a

BRIDGE_PORT="${ZAPBOT_PORT:-3000}"
AO_PORT="${ZAPBOT_AO_PORT:-3001}"

if [ -z "${ZAPBOT_API_KEY:-}" ]; then
  echo "ERROR: ZAPBOT_API_KEY is not set."
  echo "FIX: Run '$ZAPBOT_DIR/bin/zapbot-team-init' to generate .env, or set it manually."
  exit 1
fi
if [ -z "${ZAPBOT_WEBHOOK_SECRET:-}" ]; then
  echo "ERROR: ZAPBOT_WEBHOOK_SECRET is not set."
  echo "FIX: Run '$ZAPBOT_DIR/bin/zapbot-team-init' to generate .env with both secrets."
  exit 1
fi
if [ "${ZAPBOT_WEBHOOK_SECRET}" = "${ZAPBOT_API_KEY}" ]; then
  echo "ERROR: ZAPBOT_WEBHOOK_SECRET must differ from ZAPBOT_API_KEY."
  exit 1
fi

ZAPBOT_REPOS=()
while IFS= read -r line; do
  repo=$(echo "$line" | awk '{print $2}')
  [ -n "$repo" ] && ZAPBOT_REPOS+=("$repo")
done < <(grep '^\s\+repo:' "$PROJECT_DIR/agent-orchestrator.yaml")

if [ ${#ZAPBOT_REPOS[@]} -eq 0 ]; then
  echo "ERROR: No repos found in agent-orchestrator.yaml"
  exit 1
fi

echo "=== Starting Zapbot ==="
echo "Project: $PROJECT_DIR"
echo "Repos:   ${ZAPBOT_REPOS[*]}"
echo ""

if systemctl is-active zapbot-bridge >/dev/null 2>&1; then
  echo "WARNING: Bridge is managed by systemd."
  echo "  Use 'sudo systemctl restart zapbot-bridge' to restart."
  echo "  Use 'sudo systemctl reload zapbot-bridge' to reload config."
  echo "  Running start.sh alongside systemd will cause port conflicts."
  exit 1
fi

pkill -f "bun.*webhook-bridge.ts" 2>/dev/null || true

echo "Starting agent-orchestrator on port ${AO_PORT}..."
(cd "$PROJECT_DIR" && PORT=$AO_PORT ao start > /tmp/zapbot-ao.log 2>&1) &
AO_PID=$!

for i in $(seq 1 20); do
  curl -s "http://localhost:${AO_PORT}" >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "ERROR: AO failed to start. Check /tmp/zapbot-ao.log"; kill $AO_PID 2>/dev/null; exit 1; }
  sleep 1
done
echo "AO ready on port ${AO_PORT}"

echo "Starting webhook bridge on port ${BRIDGE_PORT}..."
export ZAPBOT_API_KEY
export ZAPBOT_WEBHOOK_SECRET
export ZAPBOT_CONFIG="$PROJECT_DIR/agent-orchestrator.yaml"
export ZAPBOT_PORT=$BRIDGE_PORT
[ -n "${ZAPBOT_GATEWAY_URL:-}" ] && export ZAPBOT_GATEWAY_URL
[ -n "${ZAPBOT_GATEWAY_SECRET:-}" ] && export ZAPBOT_GATEWAY_SECRET
[ -n "${ZAPBOT_BRIDGE_URL:-}" ] && export ZAPBOT_BRIDGE_URL
bun "$ZAPBOT_DIR/bin/webhook-bridge.ts" > /tmp/zapbot-bridge.log 2>&1 &
BRIDGE_PID=$!

for i in $(seq 1 10); do
  curl -s "http://localhost:${BRIDGE_PORT}/healthz" >/dev/null 2>&1 && break
  [ "$i" -eq 10 ] && { echo "ERROR: Bridge failed to start. Check /tmp/zapbot-bridge.log"; kill $BRIDGE_PID $AO_PID 2>/dev/null; exit 1; }
  sleep 1
done
echo "Bridge ready on port ${BRIDGE_PORT}"

cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in ${BRIDGE_PID:-} ${AO_PID:-}; do
    [ -n "$pid" ] && pkill -P "$pid" 2>/dev/null || true
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  echo "All processes stopped."
}
trap cleanup EXIT INT TERM

echo ""
echo "================================================"
echo "  Zapbot is running!"
echo "================================================"
echo "  Project:   $PROJECT_DIR"
for repo in "${ZAPBOT_REPOS[@]}"; do
echo "  Repo:      https://github.com/${repo}"
done
echo "  Bridge:    http://localhost:${BRIDGE_PORT}"
echo "  Dashboard: http://localhost:${AO_PORT}"
if [ -n "${ZAPBOT_GATEWAY_URL:-}" ]; then
  echo "  Gateway:   ${ZAPBOT_GATEWAY_URL}"
  [ -n "${ZAPBOT_BRIDGE_URL:-}" ] && echo "  Public:    ${ZAPBOT_BRIDGE_URL}"
fi
echo ""
echo "  Publish:   bash $ZAPBOT_DIR/bin/zapbot-publish.sh <plan-file>"
echo ""
echo "  Logs: /tmp/zapbot-{ao,bridge}.log"
echo "  Press Ctrl+C to stop everything."
echo "================================================"

wait
