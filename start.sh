#!/usr/bin/env bash
set -euo pipefail

# Start zapbot: moltzap-server + zapbot-orchestrator + webhook bridge.
# Usage: start.sh [project-dir]
#
# Reads secrets from ~/.zapbot/config.json (webhookSecret, apiKey,
# orchestratorSecret) and project entries from ~/.zapbot/projects.json.
# `ZAPBOT_GATEWAY_URL` selects GitHub-backed demo mode; without it the
# launcher stays local-only and never advertises public ingress.

ZAPBOT_DIR="$(cd "$(dirname "$0")" && pwd)"

PROJECT_DIR=""
for arg in "$@"; do
  case "$arg" in
    --help) echo "Usage: start.sh [project-dir]"; exit 0 ;;
    *) [ -z "$PROJECT_DIR" ] && PROJECT_DIR="$arg" ;;
  esac
done
PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"

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
  echo "FIX: Run '$ZAPBOT_DIR/bin/zapbot-team-init <owner/repo>' first."
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
if [ "${ZAPBOT_WEBHOOK_SECRET}" = "${ZAPBOT_API_KEY}" ]; then
  echo "ERROR: ZAPBOT_WEBHOOK_SECRET must differ from ZAPBOT_API_KEY."
  exit 1
fi
export ZAPBOT_WEBHOOK_SECRET ZAPBOT_API_KEY

BRIDGE_PORT="${ZAPBOT_PORT:-3000}"
ORCHESTRATOR_PORT="${ZAPBOT_ORCHESTRATOR_PORT:-3002}"
MOLTZAP_PORT="${MOLTZAP_PORT:-3100}"
MOLTZAP_SERVER_URL="${MOLTZAP_SERVER_URL:-http://127.0.0.1:${MOLTZAP_PORT}}"
MOLTZAP_YAML="$HOME/.zapbot/moltzap.yaml"
ORCHESTRATOR_LOG_FILE="/tmp/zapbot-orchestrator.log"
MOLTZAP_LOG_FILE="/tmp/zapbot-moltzap.log"
BRIDGE_LOG_FILE="/tmp/zapbot-bridge.log"

# MoltZap local-server config: auto-mint secrets + write yaml on first run
# so the operator never hand-stages config. Stored alongside the bridge's
# webhookSecret/apiKey under ~/.zapbot/. The yaml is regenerated when missing
# so MOLTZAP_PORT changes propagate cleanly; existing yamls are left alone.
ZAPBOT_MOLTZAP_REGISTRATION_SECRET="$(jq -r '.moltzap.registrationSecret // empty' "$HOME/.zapbot/config.json" 2>/dev/null)"
MOLTZAP_ENCRYPTION_SECRET="$(jq -r '.moltzap.encryptionSecret // empty' "$HOME/.zapbot/config.json" 2>/dev/null)"
if [ -z "$ZAPBOT_MOLTZAP_REGISTRATION_SECRET" ] || [ -z "$MOLTZAP_ENCRYPTION_SECRET" ]; then
  echo "Initialising MoltZap local-dev secrets in $HOME/.zapbot/config.json..."
  ZAPBOT_MOLTZAP_REGISTRATION_SECRET="$(openssl rand -hex 32)"
  MOLTZAP_ENCRYPTION_SECRET="$(openssl rand -hex 32)"
  jq --arg reg "$ZAPBOT_MOLTZAP_REGISTRATION_SECRET" \
     --arg enc "$MOLTZAP_ENCRYPTION_SECRET" \
     --arg url "$MOLTZAP_SERVER_URL" \
     '.moltzap = (.moltzap // {}) | .moltzap.registrationSecret = $reg | .moltzap.encryptionSecret = $enc | .moltzap.serverUrl = $url' \
     "$HOME/.zapbot/config.json" > "$HOME/.zapbot/config.json.tmp"
  mv "$HOME/.zapbot/config.json.tmp" "$HOME/.zapbot/config.json"
fi
if [ ! -f "$MOLTZAP_YAML" ]; then
  echo "Writing $MOLTZAP_YAML..."
  cat > "$MOLTZAP_YAML" <<MZ_YAML
# Local-dev MoltZap server config managed by zapbot's start.sh.
# - Embedded PGlite (no external Postgres needed).
# - dev_mode bypasses external auth handshake — localhost only.
# - registration.secret + encryption.master_secret pull from ~/.zapbot/config.json.
server:
  port: ${MOLTZAP_PORT}
  cors_origins:
    - "*"
encryption:
  master_secret: ${MOLTZAP_ENCRYPTION_SECRET}
registration:
  secret: ${ZAPBOT_MOLTZAP_REGISTRATION_SECRET}
dev_mode:
  enabled: true
log_level: info
MZ_YAML
fi
# The bridge consumes ZAPBOT_MOLTZAP_SERVER_URL (zapbot-namespaced); the
# orchestrator + moltzap-server adapters consume MOLTZAP_SERVER_URL (upstream
# convention). Export both so neither side has to translate.
ZAPBOT_MOLTZAP_SERVER_URL="$MOLTZAP_SERVER_URL"
export ZAPBOT_MOLTZAP_REGISTRATION_SECRET MOLTZAP_ENCRYPTION_SECRET
export MOLTZAP_SERVER_URL ZAPBOT_MOLTZAP_SERVER_URL

trim_env_value() {
  printf '%s' "${1:-}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

validate_bridge_url() {
  local configured_url
  configured_url="$(trim_env_value "${ZAPBOT_BRIDGE_URL:-}")"
  if [ -z "$configured_url" ]; then
    echo "ERROR: ZAPBOT_GATEWAY_URL is set but ZAPBOT_BRIDGE_URL is missing."
    echo "FIX: Set ZAPBOT_BRIDGE_URL to the live public bridge URL before starting."
    return 1
  fi
  if curl -fsS --max-time 2 "${configured_url%/}/healthz" >/dev/null 2>&1; then
    return 0
  fi
  echo "ERROR: ZAPBOT_BRIDGE_URL is unreachable: $configured_url"
  echo "FIX: Do not rely on host-derived fallback; set ZAPBOT_BRIDGE_URL to a live public URL."
  return 1
}

INGRESS_MODE="local-only"
if [ -n "$(trim_env_value "${ZAPBOT_GATEWAY_URL:-}")" ]; then
  INGRESS_MODE="github-demo"
fi

if [ "$INGRESS_MODE" = "github-demo" ]; then
  ZAPBOT_GATEWAY_URL="$(trim_env_value "${ZAPBOT_GATEWAY_URL:-}")"
  ZAPBOT_BRIDGE_URL="$(trim_env_value "${ZAPBOT_BRIDGE_URL:-}")"
  validate_bridge_url || exit 1
  export ZAPBOT_BRIDGE_URL
fi

echo "=== Starting Zapbot ==="
echo "Project: $PROJECT_DIR"
echo "Mode:    $INGRESS_MODE"
echo ""

# Refuse to race with a systemd-managed bridge on the same host.
if systemctl is-active zapbot-bridge >/dev/null 2>&1; then
  echo "WARNING: Bridge is managed by systemd."
  echo "  Use 'sudo systemctl restart zapbot-bridge' to restart."
  echo "  Use 'sudo systemctl reload zapbot-bridge' to reload config."
  echo "  Running start.sh alongside systemd will cause port conflicts."
  exit 1
fi

pkill -f "bun.*webhook-bridge.ts" 2>/dev/null || true

# Boot moltzap-server unless skipped. Workers spawn through it; the
# orchestrator stub-handle still boots without it but cannot run real
# fleet ops. Set ZAPBOT_SKIP_MOLTZAP_SERVER=1 in CI/tests that don't
# need worker spawn.
MOLTZAP_PID=""
if [ "${ZAPBOT_SKIP_MOLTZAP_SERVER:-0}" != "1" ]; then
  MOLTZAP_BIN="$ZAPBOT_DIR/vendor/moltzap/packages/server/bin/moltzap-server"
  if [ ! -x "$MOLTZAP_BIN" ]; then
    echo "ERROR: moltzap-server binary not found at $MOLTZAP_BIN"
    echo "FIX: Run 'bash $ZAPBOT_DIR/scripts/bootstrap-moltzap.sh' to build vendor/moltzap."
    exit 1
  fi
  echo "Starting moltzap-server on port ${MOLTZAP_PORT}..."
  : > "$MOLTZAP_LOG_FILE"
  # cd to ~/.zapbot/ so moltzap-server finds moltzap.yaml in cwd. Embedded
  # PGlite writes data into cwd too, so this also keeps state out of the
  # zapbot source tree. Use a subshell so the parent's cwd stays put.
  ( cd "$HOME/.zapbot" && MOLTZAP_PORT="$MOLTZAP_PORT" \
    "$MOLTZAP_BIN" > "$MOLTZAP_LOG_FILE" 2>&1 ) &
  MOLTZAP_PID=$!

  for i in $(seq 1 20); do
    if curl -fsS "${MOLTZAP_SERVER_URL%/}/health" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$MOLTZAP_PID" 2>/dev/null; then
      echo "ERROR: moltzap-server exited before /health responded. Check $MOLTZAP_LOG_FILE"
      exit 1
    fi
    [ "$i" -eq 20 ] && {
      echo "ERROR: moltzap-server did not become ready within 20s. Check $MOLTZAP_LOG_FILE"
      kill "$MOLTZAP_PID" 2>/dev/null || true
      exit 1
    }
    sleep 1
  done
  echo "moltzap-server ready on port ${MOLTZAP_PORT}"
fi

# Boot zapbot-orchestrator. Set ZAPBOT_SKIP_ORCHESTRATOR=1 in tests that
# mock `bun` and don't simulate orchestrator startup. Production
# deployments leave it unset.
ORCHESTRATOR_PID=""
if [ "${ZAPBOT_SKIP_ORCHESTRATOR:-0}" != "1" ]; then
  echo "Starting zapbot-orchestrator on port ${ORCHESTRATOR_PORT}..."
  : > "$ORCHESTRATOR_LOG_FILE"
  ZAPBOT_ORCHESTRATOR_PORT="$ORCHESTRATOR_PORT" \
    ZAPBOT_ORCHESTRATOR_URL="http://127.0.0.1:${ORCHESTRATOR_PORT}" \
    MOLTZAP_SERVER_URL="$MOLTZAP_SERVER_URL" \
    bun "$ZAPBOT_DIR/bin/zapbot-orchestrator.ts" \
    > "$ORCHESTRATOR_LOG_FILE" 2>&1 &
  ORCHESTRATOR_PID=$!

  for i in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${ORCHESTRATOR_PORT}/healthz" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$ORCHESTRATOR_PID" 2>/dev/null; then
      echo "ERROR: orchestrator exited before /healthz responded. Check $ORCHESTRATOR_LOG_FILE"
      [ -n "$MOLTZAP_PID" ] && kill "$MOLTZAP_PID" 2>/dev/null || true
      exit 1
    fi
    [ "$i" -eq 20 ] && {
      echo "ERROR: orchestrator did not become ready within 20s. Check $ORCHESTRATOR_LOG_FILE"
      kill "$ORCHESTRATOR_PID" 2>/dev/null || true
      [ -n "$MOLTZAP_PID" ] && kill "$MOLTZAP_PID" 2>/dev/null || true
      exit 1
    }
    sleep 1
  done
  echo "Orchestrator ready on port ${ORCHESTRATOR_PORT}"
fi

# Boot the webhook bridge.
echo "Starting webhook bridge on port ${BRIDGE_PORT}..."
export ZAPBOT_API_KEY
export ZAPBOT_WEBHOOK_SECRET
export ZAPBOT_ORCHESTRATOR_URL="http://127.0.0.1:${ORCHESTRATOR_PORT}"
export ZAPBOT_PORT=$BRIDGE_PORT
[ -n "${ZAPBOT_GATEWAY_URL:-}" ] && export ZAPBOT_GATEWAY_URL
[ -n "${ZAPBOT_GATEWAY_SECRET:-}" ] && export ZAPBOT_GATEWAY_SECRET
[ -n "${ZAPBOT_BRIDGE_URL:-}" ] && export ZAPBOT_BRIDGE_URL
bun "$ZAPBOT_DIR/bin/webhook-bridge.ts" > "$BRIDGE_LOG_FILE" 2>&1 &
BRIDGE_PID=$!

for i in $(seq 1 10); do
  curl -s "http://localhost:${BRIDGE_PORT}/healthz" >/dev/null 2>&1 && break
  [ "$i" -eq 10 ] && {
    echo "ERROR: Bridge failed to start. Check $BRIDGE_LOG_FILE"
    kill "$BRIDGE_PID" 2>/dev/null || true
    [ -n "$ORCHESTRATOR_PID" ] && kill "$ORCHESTRATOR_PID" 2>/dev/null || true
    [ -n "$MOLTZAP_PID" ] && kill "$MOLTZAP_PID" 2>/dev/null || true
    exit 1
  }
  sleep 1
done
echo "Bridge ready on port ${BRIDGE_PORT}"

cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in ${BRIDGE_PID:-} ${ORCHESTRATOR_PID:-} ${MOLTZAP_PID:-}; do
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
echo "  Project:       $PROJECT_DIR"
echo "  Mode:          $INGRESS_MODE"
echo "  Bridge:        http://localhost:${BRIDGE_PORT}"
echo "  Orchestrator:  http://localhost:${ORCHESTRATOR_PORT}"
[ -n "$MOLTZAP_PID" ] && echo "  MoltZap:       ${MOLTZAP_SERVER_URL}"
if [ "$INGRESS_MODE" = "github-demo" ]; then
  echo "  Gateway:       ${ZAPBOT_GATEWAY_URL}"
  echo "  Public:        ${ZAPBOT_BRIDGE_URL}"
else
  echo "  Gateway:       (local-only)"
  echo "  Public:        (local-only)"
fi
echo ""
echo "  Publish:   bash $ZAPBOT_DIR/bin/zapbot-publish.sh <plan-file>"
echo ""
echo "  Logs: /tmp/zapbot-{moltzap,orchestrator,bridge}.log"
echo "  Press Ctrl+C to stop everything."
echo "================================================"

wait
