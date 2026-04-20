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

# Load shared bootstrap defaults first, then let the project checkout override them.
# Fresh repos must keep their generated webhook secret even if ~/.zapbot/.env still exists.
[ -f "$HOME/.zapbot/.env" ] && set -a && source "$HOME/.zapbot/.env" && set +a
[ -f "$PROJECT_DIR/.env" ] && set -a && source "$PROJECT_DIR/.env" && set +a

BRIDGE_PORT="${ZAPBOT_PORT:-3000}"
AO_PORT="${ZAPBOT_AO_PORT:-3001}"
AO_LOG_FILE="/tmp/zapbot-ao.log"
AO_CONFIG_FILE="$(mktemp "${TMPDIR:-/tmp}/zapbot-ao-config.XXXXXX.yaml")"

resolve_bridge_url() {
  local configured_url="${ZAPBOT_BRIDGE_URL:-}"
  local health_check_url=""
  local metadata_ip=""
  local host_ip=""

  if [ -n "$configured_url" ]; then
    health_check_url="${configured_url%/}/healthz"
    if curl -fsS --max-time 2 "$health_check_url" >/dev/null 2>&1; then
      echo "$configured_url"
      return 0
    fi
  fi

  metadata_ip="$(curl -fsS --max-time 2 -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip" 2>/dev/null || true)"
  if [ -n "$metadata_ip" ]; then
    echo "http://${metadata_ip}:${BRIDGE_PORT}"
    return 0
  fi

  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "$host_ip" ]; then
    echo "http://${host_ip}:${BRIDGE_PORT}"
    return 0
  fi

  if [ -n "$configured_url" ]; then
    echo "ERROR: ZAPBOT_BRIDGE_URL is set but unreachable: $configured_url" >&2
    return 1
  fi

  return 0
}

start_ao_once() {
  : > "$AO_LOG_FILE"
  (cd "$PROJECT_DIR" && AO_CONFIG_PATH="$AO_CONFIG_FILE" ao start > "$AO_LOG_FILE" 2>&1) &
  AO_PID=$!
}

extract_duplicate_session() {
  grep -Eo 'duplicate session: [^[:space:]]+' "$AO_LOG_FILE" 2>/dev/null | tail -n 1 | sed -E 's/^duplicate session: //'
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

if [ -n "${ZAPBOT_GATEWAY_URL:-}" ]; then
  RESOLVED_BRIDGE_URL="$(resolve_bridge_url)" || exit 1
  if [ -z "$RESOLVED_BRIDGE_URL" ]; then
    echo "ERROR: ZAPBOT_GATEWAY_URL is set but a live bridge URL could not be derived."
    echo "FIX: Set ZAPBOT_BRIDGE_URL to the current public URL or run on a host that exposes one."
    exit 1
  fi
  ZAPBOT_BRIDGE_URL="$RESOLVED_BRIDGE_URL"
  export ZAPBOT_BRIDGE_URL
fi

AO_DASHBOARD_PORT=""
for attempt in 1 2; do
  echo "Starting agent-orchestrator with explicit port ${AO_PORT}..."
  AO_DASHBOARD_PORT=""
  DUPLICATE_SESSION=""
  start_ao_once

  for i in $(seq 1 20); do
    AO_DASHBOARD_PORT="$(grep -Eo 'Dashboard starting on http://localhost:[0-9]+' "$AO_LOG_FILE" 2>/dev/null | tail -n 1 | sed -E 's/.*:([0-9]+)$/\1/' || true)"
    if [ -n "$AO_DASHBOARD_PORT" ]; then
      break
    fi
    if ! kill -0 "$AO_PID" 2>/dev/null; then
      DUPLICATE_SESSION="$(extract_duplicate_session)"
      if [ "$attempt" -eq 1 ] && [ -n "$DUPLICATE_SESSION" ]; then
        echo "Detected stale AO tmux session ${DUPLICATE_SESSION}; removing and retrying startup..."
        tmux kill-session -t "$DUPLICATE_SESSION" 2>/dev/null || true
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

  if [ "$attempt" -eq 1 ] && [ -n "${DUPLICATE_SESSION:-}" ]; then
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
for repo in "${ZAPBOT_REPOS[@]}"; do
echo "  Repo:      https://github.com/${repo}"
done
echo "  Bridge:    http://localhost:${BRIDGE_PORT}"
echo "  Dashboard: http://localhost:${AO_DASHBOARD_PORT}"
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
