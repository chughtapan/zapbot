#!/usr/bin/env bash
set -euo pipefail

# One-click zapbot startup: ngrok + webhook + agent-orchestrator
# Prerequisites: ./install.sh has been run once

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
export GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-zapbot-webhook-secret}"
GITHUB_USER=$(gh api user --jq '.login')
ZAPBOT_REPO="zapbot-test"

echo "=== Starting Zapbot ==="
echo ""

# Kill any existing ngrok
pkill -f "ngrok http" 2>/dev/null || true
sleep 1

# Start ngrok in background
echo "Starting ngrok tunnel on port 3000..."
ngrok http 3000 --log=stdout > /tmp/zapbot-ngrok.log 2>&1 &
NGROK_PID=$!

# Wait for ngrok to be ready
for i in 1 2 3 4 5 6 7 8 9 10; do
  NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | jq -r '.tunnels[] | select(.proto=="https") | .public_url' 2>/dev/null || echo "")
  [ -n "$NGROK_URL" ] && break
  sleep 1
done

if [ -z "$NGROK_URL" ]; then
  echo "ERROR: ngrok failed to start. Check /tmp/zapbot-ngrok.log"
  kill $NGROK_PID 2>/dev/null || true
  exit 1
fi
echo "ngrok URL: $NGROK_URL"

# Update or create GitHub webhook
WEBHOOK_URL="${NGROK_URL}/api/webhooks/github"
EXISTING_HOOK=$(gh api "repos/${GITHUB_USER}/${ZAPBOT_REPO}/hooks" --jq '.[0].id' 2>/dev/null || echo "")

if [ -n "$EXISTING_HOOK" ] && [ "$EXISTING_HOOK" != "null" ]; then
  echo "Updating existing webhook #${EXISTING_HOOK}..."
  gh api "repos/${GITHUB_USER}/${ZAPBOT_REPO}/hooks/${EXISTING_HOOK}" --method PATCH \
    -f "config[url]=${WEBHOOK_URL}" \
    -f "config[content_type]=json" \
    -f "config[secret]=${GITHUB_WEBHOOK_SECRET}" >/dev/null
else
  echo "Creating webhook..."
  gh api "repos/${GITHUB_USER}/${ZAPBOT_REPO}/hooks" --method POST \
    -f "config[url]=${WEBHOOK_URL}" \
    -f "config[content_type]=json" \
    -f "config[secret]=${GITHUB_WEBHOOK_SECRET}" \
    -F "events[]=issues" \
    -F "active=true" >/dev/null
fi
echo "Webhook: ${WEBHOOK_URL}"

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down..."
  kill $NGROK_PID 2>/dev/null || true
  echo "ngrok stopped"
}
trap cleanup EXIT INT TERM

# Start agent-orchestrator (foreground — blocks until ctrl-c)
echo ""
echo "================================================"
echo "  Zapbot is running!"
echo "================================================"
echo "  ngrok:     $NGROK_URL"
echo "  webhook:   $WEBHOOK_URL"
echo "  dashboard: http://localhost:3000"
echo "  repo:      https://github.com/${GITHUB_USER}/${ZAPBOT_REPO}"
echo ""
echo "  Press Ctrl+C to stop everything."
echo "================================================"
echo ""

cd "$REPO_DIR" && ao start
