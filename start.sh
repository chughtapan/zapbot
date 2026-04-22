#!/usr/bin/env bash
set -euo pipefail

# Start zapbot: webhook bridge + agent-orchestrator for one project checkout.
# Usage: start.sh [project-dir]
#
# Run from a project directory that has agent-orchestrator.yaml (created by
# zapbot-team-init), or pass the path as the first argument.
#
# `ZAPBOT_GATEWAY_URL` selects GitHub-backed demo mode. Without a gateway,
# the launcher stays local-only and never advertises public ingress.

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

# Load shared bootstrap defaults first, then let the project checkout override them.
# Fresh repos must keep their generated webhook secret even if ~/.zapbot/.env still exists.
[ -f "$HOME/.zapbot/.env" ] && set -a && source "$HOME/.zapbot/.env" && set +a
[ -f "$PROJECT_DIR/.env" ] && set -a && source "$PROJECT_DIR/.env" && set +a

BRIDGE_PORT="${ZAPBOT_PORT:-3000}"
AO_PORT="${ZAPBOT_AO_PORT:-3001}"
AO_LOG_FILE="/tmp/zapbot-ao.log"
AO_CONFIG_FILE="$(mktemp "${TMPDIR:-/tmp}/zapbot-ao-config.XXXXXX.yaml")"

validate_bridge_url() {
  local configured_url
  configured_url="$(trim_env_value "${ZAPBOT_BRIDGE_URL:-}")"
  local health_check_url=""

  if [ -z "$configured_url" ]; then
    echo "ERROR: ZAPBOT_GATEWAY_URL is set but ZAPBOT_BRIDGE_URL is missing."
    echo "FIX: Set ZAPBOT_BRIDGE_URL to the live public bridge URL before starting."
    return 1
  fi

  health_check_url="${configured_url%/}/healthz"
  if curl -fsS --max-time 2 "$health_check_url" >/dev/null 2>&1; then
    return 0
  fi

  echo "ERROR: ZAPBOT_BRIDGE_URL is unreachable: $configured_url"
  echo "FIX: Do not rely on host-derived fallback; set ZAPBOT_BRIDGE_URL to a live public URL."
  return 1
}

trim_env_value() {
  printf '%s' "${1:-}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

INGRESS_MODE="local-only"
if [ -n "$(trim_env_value "${ZAPBOT_GATEWAY_URL:-}")" ]; then
  INGRESS_MODE="github-demo"
fi

start_ao_once() {
  : > "$AO_LOG_FILE"
  (cd "$PROJECT_DIR" && AO_CONFIG_PATH="$AO_CONFIG_FILE" ao start > "$AO_LOG_FILE" 2>&1) &
  AO_PID=$!
}

resolve_managed_startup_retry() {
  bun "$ZAPBOT_DIR/bin/resolve-managed-startup-retry.ts" \
    "$PROJECT_DIR" \
    "$PROJECT_DIR/agent-orchestrator.yaml" \
    "$AO_LOG_FILE"
}

node - "$PROJECT_DIR/agent-orchestrator.yaml" "$AO_CONFIG_FILE" "$AO_PORT" <<'NODE'
const fs = require("node:fs");
const [sourcePath, targetPath, desiredPort] = process.argv.slice(2);
const portLine = `port: ${desiredPort}`;
const yaml = fs.readFileSync(sourcePath, "utf8");
const lines = yaml.split(/\r?\n/);
let replaced = false;

for (let i = 0; i < lines.length; i += 1) {
  if (/^port:[ \t]*.*$/.test(lines[i])) {
    lines[i] = portLine;
    replaced = true;
    break;
  }
}

if (!replaced) {
  if (lines[0] === "---") {
    lines.splice(1, 0, portLine);
  } else {
    lines.unshift(portLine);
  }
}

const output = lines.join("\n") + (yaml.endsWith("\n") ? "\n" : "");
fs.writeFileSync(targetPath, output);
NODE

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

if [ "$INGRESS_MODE" = "github-demo" ]; then
  ZAPBOT_GATEWAY_URL="$(trim_env_value "${ZAPBOT_GATEWAY_URL:-}")"
  ZAPBOT_BRIDGE_URL="$(trim_env_value "${ZAPBOT_BRIDGE_URL:-}")"
  validate_bridge_url || exit 1
  export ZAPBOT_BRIDGE_URL
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

AO_DASHBOARD_PORT=""
for attempt in 1 2; do
  echo "Starting agent-orchestrator with explicit port ${AO_PORT}..."
  AO_DASHBOARD_PORT=""
  RETRY_DUPLICATE_SESSION=""
  start_ao_once

  for i in $(seq 1 20); do
    AO_DASHBOARD_PORT="$(grep -Eo 'Dashboard starting on http://localhost:[0-9]+' "$AO_LOG_FILE" 2>/dev/null | tail -n 1 | sed -E 's/.*:([0-9]+)$/\1/' || true)"
    if [ -n "$AO_DASHBOARD_PORT" ]; then
      break
    fi
    if ! kill -0 "$AO_PID" 2>/dev/null; then
      RETRY_DUPLICATE_SESSION=""
      if [ "$attempt" -eq 1 ]; then
        RETRY_DUPLICATE_SESSION="$(resolve_managed_startup_retry 2>/dev/null || true)"
      fi
      if [ "$attempt" -eq 1 ] && [ -n "$RETRY_DUPLICATE_SESSION" ]; then
        echo "Detected duplicate managed orchestrator session ${RETRY_DUPLICATE_SESSION}; retrying startup..."
        wait "$AO_PID" 2>/dev/null || true
        break
      fi
      echo "ERROR: AO failed to start. Check $AO_LOG_FILE"
      kill "$AO_PID" 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done

  if [ -n "$AO_DASHBOARD_PORT" ]; then
    break
  fi

  if [ "$attempt" -eq 1 ] && [ -n "${RETRY_DUPLICATE_SESSION:-}" ]; then
    continue
  fi

  echo "ERROR: AO failed to start. Check $AO_LOG_FILE"
  kill "$AO_PID" 2>/dev/null || true
  exit 1
done

for i in $(seq 1 20); do
  if curl -fsS "http://localhost:${AO_DASHBOARD_PORT}/api/observability" 2>/dev/null | grep -q '"overallStatus"'; then
    break
  fi
  if ! kill -0 "$AO_PID" 2>/dev/null; then
    echo "ERROR: AO exited before the dashboard became ready. Check $AO_LOG_FILE"
    kill "$AO_PID" 2>/dev/null || true
    exit 1
  fi
  [ "$i" -eq 20 ] && { echo "ERROR: AO failed to become ready. Check $AO_LOG_FILE"; kill "$AO_PID" 2>/dev/null || true; exit 1; }
  sleep 1
done
echo "AO ready on port ${AO_DASHBOARD_PORT}"

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
  [ -n "${AO_CONFIG_FILE:-}" ] && rm -f "$AO_CONFIG_FILE"
  echo "All processes stopped."
}
trap cleanup EXIT INT TERM

echo ""
echo "================================================"
echo "  Zapbot is running!"
echo "================================================"
echo "  Project:   $PROJECT_DIR"
echo "  Mode:      $INGRESS_MODE"
for repo in "${ZAPBOT_REPOS[@]}"; do
echo "  Repo:      https://github.com/${repo}"
done
echo "  Bridge:    http://localhost:${BRIDGE_PORT}"
echo "  Dashboard: http://localhost:${AO_DASHBOARD_PORT}"
if [ "$INGRESS_MODE" = "github-demo" ]; then
  echo "  Gateway:   ${ZAPBOT_GATEWAY_URL}"
  echo "  Public:    ${ZAPBOT_BRIDGE_URL}"
else
  echo "  Gateway:   (local-only)"
  echo "  Public:    (local-only)"
fi
echo ""
echo "  Publish:   bash $ZAPBOT_DIR/bin/zapbot-publish.sh <plan-file>"
echo ""
echo "  Logs: /tmp/zapbot-{ao,bridge}.log"
echo "  Press Ctrl+C to stop everything."
echo "================================================"

wait
