#!/usr/bin/env bash
set -euo pipefail

# Start zapbot: webhook-bridge + agent-orchestrator + optional ngrok
# Usage: start.sh [project-dir] [--no-ngrok]
#
# Run from a project directory that has agent-orchestrator.yaml (created by zapbot-team-init).
# Or pass the project path as the first argument.
#
# Supports multiple repos defined in agent-orchestrator.yaml. The bridge
# routes webhooks by the `repository.full_name` in each payload, so a
# single bridge instance handles all configured repos.

ZAPBOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Parse args
PROJECT_DIR=""
USE_NGROK=true
for arg in "$@"; do
  case "$arg" in
    --no-ngrok) USE_NGROK=false ;;
    --help) echo "Usage: start.sh [project-dir] [--no-ngrok]"; exit 0 ;;
    *) [ -z "$PROJECT_DIR" ] && PROJECT_DIR="$arg" ;;
  esac
done
PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"

# Validate project dir
if [ ! -f "$PROJECT_DIR/agent-orchestrator.yaml" ]; then
  echo "ERROR: No agent-orchestrator.yaml in $PROJECT_DIR"
  echo "FIX: Run '$ZAPBOT_DIR/bin/zapbot-team-init' in your project first."
  exit 1
fi

# Load .env FIRST (from project dir), then zapbot-specific env
[ -f "$PROJECT_DIR/.env" ] && set -a && source "$PROJECT_DIR/.env" && set +a
[ -f "$HOME/.zapbot/.env" ] && set -a && source "$HOME/.zapbot/.env" && set +a

# THEN set defaults (env vars from .env take precedence)
BRIDGE_PORT="${ZAPBOT_BRIDGE_PORT:-3000}"
AO_PORT="${ZAPBOT_AO_PORT:-3001}"
APPROVE_LABEL="${ZAPBOT_APPROVE_LABEL:-plan-approved}"

if [ -z "${ZAPBOT_API_KEY:-}" ]; then
  echo "ERROR: ZAPBOT_API_KEY is not set."
  echo "FIX: Run '$ZAPBOT_DIR/bin/zapbot-team-init' to generate .env, or set it manually."
  exit 1
fi

# Build repo list from agent-orchestrator.yaml projects section.
# Each `repo:` line under `projects:` is an owner/name pair.
ZAPBOT_REPOS=()
while IFS= read -r line; do
  repo=$(echo "$line" | awk '{print $2}')
  [ -n "$repo" ] && ZAPBOT_REPOS+=("$repo")
done < <(grep '^\s\+repo:' "$PROJECT_DIR/agent-orchestrator.yaml")

# Backward compat: if ZAPBOT_REPO env var is set and not in the list, add it
if [ -n "${ZAPBOT_REPO:-}" ]; then
  found=false
  for r in "${ZAPBOT_REPOS[@]}"; do
    [ "$r" = "$ZAPBOT_REPO" ] && found=true && break
  done
  if [ "$found" = false ]; then
    ZAPBOT_REPOS+=("$ZAPBOT_REPO")
  fi
fi

if [ ${#ZAPBOT_REPOS[@]} -eq 0 ]; then
  echo "ERROR: No repos found in agent-orchestrator.yaml"
  exit 1
fi

# For backward compat, export ZAPBOT_REPO as the first repo
ZAPBOT_REPO="${ZAPBOT_REPOS[0]}"

echo "=== Starting Zapbot ==="
echo "Project: $PROJECT_DIR"
echo "Repos:   ${ZAPBOT_REPOS[*]}"
echo ""

# Check if bridge is managed by systemd
if systemctl is-active zapbot-bridge >/dev/null 2>&1; then
  echo "WARNING: Bridge is managed by systemd."
  echo "  Use 'sudo systemctl restart zapbot-bridge' to restart."
  echo "  Use 'sudo systemctl reload zapbot-bridge' to reload config."
  echo "  Running start.sh alongside systemd will cause port conflicts."
  echo ""
  echo "  To stop the service and use start.sh instead:"
  echo "    sudo systemctl stop zapbot-bridge"
  echo ""
  exit 1
fi

# Kill any existing zapbot processes
pkill -f "bun.*webhook-bridge.ts" 2>/dev/null || true
pkill -f "ngrok http" 2>/dev/null || true

# Start AO from the project directory
echo "Starting agent-orchestrator on port ${AO_PORT}..."
(cd "$PROJECT_DIR" && ao start > /tmp/zapbot-ao.log 2>&1) &
AO_PID=$!

for i in $(seq 1 20); do
  curl -s "http://localhost:${AO_PORT}" >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "ERROR: AO failed to start. Check /tmp/zapbot-ao.log"; kill $AO_PID 2>/dev/null; exit 1; }
  sleep 1
done
echo "AO ready on port ${AO_PORT}"

# Start webhook bridge
echo "Starting webhook bridge on port ${BRIDGE_PORT}..."
export ZAPBOT_API_KEY ZAPBOT_REPO ZAPBOT_CONFIG="$PROJECT_DIR/agent-orchestrator.yaml" ZAPBOT_BRIDGE_PORT=$BRIDGE_PORT ZAPBOT_AO_PORT=$AO_PORT ZAPBOT_APPROVE_LABEL=$APPROVE_LABEL
bun "$ZAPBOT_DIR/bin/webhook-bridge.ts" > /tmp/zapbot-bridge.log 2>&1 &
BRIDGE_PID=$!

for i in $(seq 1 10); do
  curl -s "http://localhost:${BRIDGE_PORT}/healthz" >/dev/null 2>&1 && break
  [ "$i" -eq 10 ] && { echo "ERROR: Bridge failed to start. Check /tmp/zapbot-bridge.log"; kill $BRIDGE_PID $AO_PID 2>/dev/null; exit 1; }
  sleep 1
done
echo "Bridge ready on port ${BRIDGE_PORT}"

# Track webhook IDs for cleanup
WEBHOOK_IDS=()

# Ngrok (optional)
if [ "$USE_NGROK" = true ]; then
  echo "Starting ngrok tunnel..."
  ngrok http "$BRIDGE_PORT" --log=stdout > /tmp/zapbot-ngrok.log 2>&1 &
  NGROK_PID=$!

  NGROK_URL=""
  for i in $(seq 1 15); do
    NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | jq -r '.tunnels[] | select(.proto=="https") | .public_url' 2>/dev/null || echo "")
    [ -n "$NGROK_URL" ] && break
    sleep 1
  done

  if [ -z "$NGROK_URL" ]; then
    echo "ERROR: ngrok failed to start. Check /tmp/zapbot-ngrok.log"
    kill $BRIDGE_PID $AO_PID 2>/dev/null || true
    exit 1
  fi

  # Update webhooks for ALL repos
  WEBHOOK_URL="${NGROK_URL}/api/webhooks/github"
  for repo in "${ZAPBOT_REPOS[@]}"; do
    echo "Configuring webhook for ${repo}..."

    # Resolve per-repo webhook secret: look up secretEnvVar from YAML, fall back to shared
    REPO_SECRET="$ZAPBOT_API_KEY"
    SECRET_ENV_VAR=$(awk -v target="$repo" '
      /repo:/ && $2 == target { found=1; next }
      found && /secretEnvVar:/ { print $2; exit }
    ' "$PROJECT_DIR/agent-orchestrator.yaml")
    if [ -n "$SECRET_ENV_VAR" ] && [ "$SECRET_ENV_VAR" != "ZAPBOT_API_KEY" ]; then
      RESOLVED="${!SECRET_ENV_VAR:-}"
      if [ -n "$RESOLVED" ]; then
        REPO_SECRET="$RESOLVED"
      fi
    fi

    if [ -n "${ZAPBOT_GITHUB_TOKEN:-}" ]; then
      EXISTING_HOOK=$(curl -s -H "Authorization: Bearer $ZAPBOT_GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/${repo}/hooks" \
        | jq -r '[.[] | select(.config.url | test("ngrok|zapbot"))] | .[0].id // empty' 2>/dev/null || echo "")
    else
      EXISTING_HOOK=$(gh api "repos/${repo}/hooks" --jq '[.[] | select(.config.url | test("ngrok|zapbot"))] | .[0].id // empty' 2>/dev/null || echo "")
    fi

    if [ -n "$EXISTING_HOOK" ]; then
      if [ -n "${ZAPBOT_GITHUB_TOKEN:-}" ]; then
        curl -s -X PATCH \
          -H "Authorization: Bearer $ZAPBOT_GITHUB_TOKEN" \
          -H "Accept: application/vnd.github+json" \
          "https://api.github.com/repos/${repo}/hooks/${EXISTING_HOOK}" \
          -d "$(jq -n --arg url "$WEBHOOK_URL" --arg secret "$REPO_SECRET" \
            '{config:{url:$url,content_type:"json",secret:$secret}}')" \
          >/dev/null
      else
        gh api "repos/${repo}/hooks/${EXISTING_HOOK}" --method PATCH \
          -f "config[url]=${WEBHOOK_URL}" -f "config[content_type]=json" \
          -f "config[secret]=${REPO_SECRET}" >/dev/null
      fi
      WEBHOOK_IDS+=("${repo}:${EXISTING_HOOK}")
      echo "  Updated existing webhook for ${repo}"
    else
      if [ -n "${ZAPBOT_GITHUB_TOKEN:-}" ]; then
        HOOK_ID=$(curl -s -X POST \
          -H "Authorization: Bearer $ZAPBOT_GITHUB_TOKEN" \
          -H "Accept: application/vnd.github+json" \
          "https://api.github.com/repos/${repo}/hooks" \
          -d "$(jq -n --arg url "$WEBHOOK_URL" --arg secret "$REPO_SECRET" \
            '{config:{url:$url,content_type:"json",secret:$secret},events:["issues","pull_request","pull_request_review","check_run","issue_comment"],active:true}')" \
          | jq -r '.id')
      else
        HOOK_ID=$(gh api "repos/${repo}/hooks" --method POST \
          -f "config[url]=${WEBHOOK_URL}" -f "config[content_type]=json" \
          -f "config[secret]=${REPO_SECRET}" \
          -F "events[]=issues" -F "events[]=pull_request" -F "events[]=pull_request_review" \
          -F "events[]=check_run" -F "events[]=issue_comment" -F "active=true" --jq '.id')
      fi
      WEBHOOK_IDS+=("${repo}:${HOOK_ID}")
      echo "  Created webhook for ${repo}"
    fi
  done

  # Persist bridge URL in project .env (atomic via mktemp)
  if [ -f "$PROJECT_DIR/.env" ]; then
    TMPENV=$(mktemp "$PROJECT_DIR/.env.XXXXXX")
    trap "rm -f '$TMPENV'" EXIT
    grep -v '^ZAPBOT_BRIDGE_URL=' "$PROJECT_DIR/.env" > "$TMPENV"
    echo "ZAPBOT_BRIDGE_URL=${NGROK_URL}" >> "$TMPENV"
    mv "$TMPENV" "$PROJECT_DIR/.env"
  fi
  export ZAPBOT_BRIDGE_URL="${NGROK_URL}"
else
  NGROK_URL="${ZAPBOT_BRIDGE_URL:-http://localhost:${BRIDGE_PORT}}"
  NGROK_PID=""
  echo "ngrok disabled. Bridge URL: $NGROK_URL"
fi

# Cleanup on exit: deactivate webhooks and stop processes
cleanup() {
  echo ""
  echo "Shutting down..."
  for entry in "${WEBHOOK_IDS[@]}"; do
    repo="${entry%%:*}"
    hook_id="${entry##*:}"
    echo "  Deactivating webhook #${hook_id} on ${repo}..."
    if [ -n "${ZAPBOT_GITHUB_TOKEN:-}" ]; then
      curl -s -X PATCH \
        -H "Authorization: Bearer $ZAPBOT_GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/${repo}/hooks/${hook_id}" \
        -d '{"active":false}' >/dev/null 2>&1 || true
    else
      gh api "repos/${repo}/hooks/${hook_id}" --method PATCH -F "active=false" >/dev/null 2>&1 || true
    fi
  done
  [ -n "${NGROK_PID:-}" ] && kill $NGROK_PID 2>/dev/null || true
  kill $BRIDGE_PID $AO_PID 2>/dev/null || true
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
[ "$USE_NGROK" = true ] && echo "  ngrok:     ${NGROK_URL}"
echo ""
echo "  Publish:   bash $ZAPBOT_DIR/bin/zapbot-publish.sh <plan-file> --key <name>"
echo "  Approve:   Add '${APPROVE_LABEL}' label on the GitHub issue"
echo ""
echo "  Logs: /tmp/zapbot-{ao,bridge,ngrok}.log"
echo "  Press Ctrl+C to stop everything."
echo "================================================"

wait
