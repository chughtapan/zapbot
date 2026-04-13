#!/usr/bin/env bash
set -euo pipefail

# One-click zapbot startup: webhook-bridge + AO + ngrok
# Prerequisites: ./install.sh has been run once

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_PORT="${ZAPBOT_BRIDGE_PORT:-3000}"
AO_PORT="${ZAPBOT_AO_PORT:-3001}"
APPROVE_LABEL="${ZAPBOT_APPROVE_LABEL:-plan-approved}"

# Load .env if exists
[ -f "$REPO_DIR/.env" ] && set -a && source "$REPO_DIR/.env" && set +a

if [ -z "${GITHUB_WEBHOOK_SECRET:-}" ]; then
  echo "ERROR: GITHUB_WEBHOOK_SECRET is not set."
  echo "FIX: Run ./install.sh to generate one, or set it in .env"
  exit 1
fi

GITHUB_USER=$(gh api user --jq '.login' 2>/dev/null || echo "")
ZAPBOT_REPO="${ZAPBOT_REPO:-${GITHUB_USER}/zapbot-test}"

echo "=== Starting Zapbot ==="
echo ""

# Kill any existing processes
pkill -f "bun.*webhook-bridge.ts" 2>/dev/null || true
pkill -f "ngrok http" 2>/dev/null || true

# Start AO on port $AO_PORT (background)
echo "Starting agent-orchestrator on port ${AO_PORT}..."
(cd "$REPO_DIR" && ao start > /tmp/zapbot-ao.log 2>&1) &
AO_PID=$!

# Wait for AO to be ready
for i in $(seq 1 20); do
  if curl -s "http://localhost:${AO_PORT}" >/dev/null 2>&1; then
    echo "AO ready on port ${AO_PORT}"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: AO failed to start on port ${AO_PORT}"
    echo "FIX: Check /tmp/zapbot-ao.log and verify nothing is using port ${AO_PORT} (lsof -i :${AO_PORT})"
    kill $AO_PID 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Start webhook bridge on port $BRIDGE_PORT (background)
echo "Starting webhook bridge on port ${BRIDGE_PORT}..."
export GITHUB_WEBHOOK_SECRET ZAPBOT_REPO ZAPBOT_BRIDGE_PORT=$BRIDGE_PORT ZAPBOT_AO_PORT=$AO_PORT ZAPBOT_APPROVE_LABEL=$APPROVE_LABEL
bun "$REPO_DIR/bin/webhook-bridge.ts" > /tmp/zapbot-bridge.log 2>&1 &
BRIDGE_PID=$!

# Wait for bridge health
for i in $(seq 1 10); do
  if curl -s "http://localhost:${BRIDGE_PORT}/healthz" >/dev/null 2>&1; then
    echo "Bridge ready on port ${BRIDGE_PORT}"
    break
  fi
  if [ "$i" -eq 10 ]; then
    echo "ERROR: Webhook bridge failed to start on port ${BRIDGE_PORT}"
    echo "FIX: Check /tmp/zapbot-bridge.log"
    kill $BRIDGE_PID $AO_PID 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Start ngrok tunnel to bridge port
echo "Starting ngrok tunnel..."
ngrok http "$BRIDGE_PORT" --log=stdout > /tmp/zapbot-ngrok.log 2>&1 &
NGROK_PID=$!

for i in $(seq 1 15); do
  NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | jq -r '.tunnels[] | select(.proto=="https") | .public_url' 2>/dev/null || echo "")
  [ -n "$NGROK_URL" ] && break
  sleep 1
done

if [ -z "$NGROK_URL" ]; then
  echo "ERROR: ngrok failed to start."
  echo "FIX: Check /tmp/zapbot-ngrok.log. Verify ngrok auth: ngrok config check"
  kill $BRIDGE_PID $AO_PID 2>/dev/null || true
  exit 1
fi
echo "ngrok URL: $NGROK_URL"

# Update or create GitHub webhook (filter by URL pattern)
WEBHOOK_URL="${NGROK_URL}/api/webhooks/github"
EXISTING_HOOK=$(gh api "repos/${ZAPBOT_REPO}/hooks" --jq '[.[] | select(.config.url | test("ngrok|webhook-bridge|zapbot"))] | .[0].id // empty' 2>/dev/null || echo "")

if [ -n "$EXISTING_HOOK" ]; then
  echo "Updating webhook #${EXISTING_HOOK}..."
  gh api "repos/${ZAPBOT_REPO}/hooks/${EXISTING_HOOK}" --method PATCH \
    -f "config[url]=${WEBHOOK_URL}" \
    -f "config[content_type]=json" \
    -f "config[secret]=${GITHUB_WEBHOOK_SECRET}" >/dev/null
else
  echo "Creating webhook..."
  gh api "repos/${ZAPBOT_REPO}/hooks" --method POST \
    -f "config[url]=${WEBHOOK_URL}" \
    -f "config[content_type]=json" \
    -f "config[secret]=${GITHUB_WEBHOOK_SECRET}" \
    -F "events[]=issues" \
    -F "events[]=pull_request" \
    -F "events[]=pull_request_review" \
    -F "events[]=check_run" \
    -F "events[]=issue_comment" \
    -F "active=true" >/dev/null
fi

# Export bridge URL for publish script
export ZAPBOT_BRIDGE_URL="${NGROK_URL}"

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down..."
  kill $NGROK_PID $BRIDGE_PID $AO_PID 2>/dev/null || true
  echo "All processes stopped."
}
trap cleanup EXIT INT TERM

echo ""
echo "================================================"
echo "  Zapbot is running!"
echo "================================================"
echo "  Bridge:    http://localhost:${BRIDGE_PORT}"
echo "  AO:        http://localhost:${AO_PORT}"
echo "  ngrok:     ${NGROK_URL}"
echo "  Webhook:   ${WEBHOOK_URL}"
echo "  Repo:      https://github.com/${ZAPBOT_REPO}"
echo "  Dashboard: http://localhost:${AO_PORT}"
echo ""
echo "  Publish:   ZAPBOT_BRIDGE_URL=${NGROK_URL} bash bin/zapbot-publish.sh <plan-file> --key <name>"
echo "  Approve:   Add '${APPROVE_LABEL}' label on the GitHub issue"
echo ""
echo "  Logs: /tmp/zapbot-{ao,bridge,ngrok}.log"
echo "  Press Ctrl+C to stop everything."
echo "================================================"

# Block until interrupted
wait
