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

# Source project .env for non-secret operator env vars (gateway URLs, MoltZap
# settings, etc.). Shared secrets come from ~/.zapbot/config.json below; the
# bridge no longer parses .env on its own (zap#323), so start.sh must load it
# here to match the systemd path's `EnvironmentFile=-PROJECT_DIR/.env`.
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi

# Load secrets from ~/.zapbot/config.json
if [ ! -f "$HOME/.zapbot/config.json" ]; then
  echo "ERROR: $HOME/.zapbot/config.json not found."
  echo "FIX: Create $HOME/.zapbot/config.json with keys: webhookSecret, apiKey"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to read $HOME/.zapbot/config.json."
  echo "FIX: Install jq (e.g. brew install jq or apt install jq)"
  exit 1
fi
ZAPBOT_WEBHOOK_SECRET=$(jq -er '
  if (.webhookSecret | type) == "string" and (.webhookSecret | length) > 0
  then .webhookSecret else empty end
' "$HOME/.zapbot/config.json") || {
  echo "ERROR: webhookSecret missing or not a non-empty string in $HOME/.zapbot/config.json"
  exit 1
}
ZAPBOT_API_KEY=$(jq -er '
  if (.apiKey | type) == "string" and (.apiKey | length) > 0
  then .apiKey else empty end
' "$HOME/.zapbot/config.json") || {
  echo "ERROR: apiKey missing or not a non-empty string in $HOME/.zapbot/config.json"
  exit 1
}
export ZAPBOT_WEBHOOK_SECRET ZAPBOT_API_KEY

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

extract_duplicate_session() {
  grep -Eo 'duplicate session: [^[:space:]]+' "$AO_LOG_FILE" 2>/dev/null | tail -n 1 | sed -E 's/^duplicate session: //'
}

NODE_PATH="$ZAPBOT_DIR/node_modules${NODE_PATH:+:$NODE_PATH}" \
node - "$PROJECT_DIR/agent-orchestrator.yaml" "$AO_CONFIG_FILE" "$AO_PORT" "$ZAPBOT_DIR/worker/ao-plugin-agent-claude-moltzap" "$PROJECT_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const [sourcePath, targetPath, desiredPort, pluginPath, projectDir] = process.argv.slice(2);
const sourceText = fs.readFileSync(sourcePath, "utf8");
const parsed = YAML.parse(sourceText) ?? {};
const sourceDir = path.dirname(sourcePath);
const normalizedProjectDir = path.resolve(projectDir);

if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  throw new Error(`Invalid AO config at ${sourcePath}`);
}

parsed.port = Number.parseInt(desiredPort, 10);
parsed.defaults = typeof parsed.defaults === "object" && parsed.defaults !== null && !Array.isArray(parsed.defaults)
  ? parsed.defaults
  : {};
parsed.defaults.runtime = typeof parsed.defaults.runtime === "string" ? parsed.defaults.runtime : "tmux";
parsed.defaults.agent = typeof parsed.defaults.agent === "string" ? parsed.defaults.agent : "claude-code";
parsed.defaults.workspace = typeof parsed.defaults.workspace === "string" ? parsed.defaults.workspace : "worktree";

const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
const hasClaudeMoltzap = plugins.some((plugin) =>
  plugin !== null &&
  typeof plugin === "object" &&
  !Array.isArray(plugin) &&
  plugin.name === "claude-moltzap",
);
if (!hasClaudeMoltzap) {
  plugins.push({
    name: "claude-moltzap",
    source: "local",
    path: pluginPath,
  });
}
parsed.plugins = plugins;

const projects = parsed.projects;
if (projects !== null && typeof projects === "object" && !Array.isArray(projects)) {
  for (const project of Object.values(projects)) {
    if (
      project !== null &&
      typeof project === "object" &&
      !Array.isArray(project) &&
      typeof project.path === "string" &&
      path.resolve(sourceDir, project.path) === normalizedProjectDir
    ) {
      project.agent = "claude-moltzap";
    }
  }
}

fs.writeFileSync(targetPath, YAML.stringify(parsed), "utf8");
NODE

if [ -z "${ZAPBOT_API_KEY:-}" ]; then
  echo "ERROR: ZAPBOT_API_KEY is not set."
  echo "FIX: Set apiKey in $HOME/.zapbot/config.json"
  exit 1
fi
if [ -z "${ZAPBOT_WEBHOOK_SECRET:-}" ]; then
  echo "ERROR: ZAPBOT_WEBHOOK_SECRET is not set."
  echo "FIX: Set webhookSecret in $HOME/.zapbot/config.json"
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
export ZAPBOT_AO_CONFIG_PATH="$AO_CONFIG_FILE"
export AO_CONFIG_PATH="$AO_CONFIG_FILE"
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
