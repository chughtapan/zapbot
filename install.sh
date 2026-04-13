#!/usr/bin/env bash
set -euo pipefail

# Zapbot install script — installs external tools and sets up the GitHub repo.
# Config files (.agent-rules.md, CLAUDE.md, etc.) are tracked in git, not generated here.
# Idempotent — safe to run multiple times.

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_USER=$(gh api user --jq '.login' 2>/dev/null || echo "")
ZAPBOT_REPO="zapbot-test"

echo "=== Zapbot Setup ==="
echo "Repo dir: $REPO_DIR"
echo "GitHub user: $GITHUB_USER"
echo ""

# ------------------------------------------------------------------
# 1. Check prerequisites
# ------------------------------------------------------------------
echo "--- Checking prerequisites ---"
MISSING=""
command -v node >/dev/null 2>&1 || MISSING="$MISSING node"
command -v git >/dev/null 2>&1 || MISSING="$MISSING git"
command -v gh >/dev/null 2>&1 || MISSING="$MISSING gh"
command -v tmux >/dev/null 2>&1 || MISSING="$MISSING tmux"
command -v claude >/dev/null 2>&1 || MISSING="$MISSING claude"

if [ -n "$MISSING" ]; then
  echo "ERROR: Missing required tools:$MISSING"
  echo "Install them first, then re-run this script."
  exit 1
fi

if [ -z "$GITHUB_USER" ]; then
  echo "ERROR: Not authenticated with GitHub."
  echo "FIX: Run 'gh auth login'"
  exit 1
fi

echo "Prerequisites OK"

# ------------------------------------------------------------------
# 2. Install external tools (in parallel)
# ------------------------------------------------------------------
TOOL_PIDS=""
TOOL_LOGS="$REPO_DIR/.install-logs"
mkdir -p "$TOOL_LOGS"

install_tool() {
  local name="$1" check="$2" install_cmd="$3"
  if eval "$check" >/dev/null 2>&1; then
    echo "$name: already installed"
    return 0
  fi
  echo "$name: installing..."
  eval "$install_cmd" > "$TOOL_LOGS/$name.log" 2>&1
  echo "$name: installed"
}

install_tool "ngrok" "command -v ngrok" \
  'if [[ "$(uname)" == "Darwin" ]]; then brew install ngrok; else curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz -o /tmp/ngrok.tgz && sudo tar -xzf /tmp/ngrok.tgz -C /usr/local/bin && rm /tmp/ngrok.tgz; fi' &
TOOL_PIDS="$TOOL_PIDS $!"

install_tool "bun" "command -v bun" \
  'curl -fsSL https://bun.sh/install | bash' &
TOOL_PIDS="$TOOL_PIDS $!"

install_tool "plannotator" "command -v plannotator" \
  'curl -fsSL https://plannotator.ai/install.sh | bash' &
TOOL_PIDS="$TOOL_PIDS $!"

install_tool "agent-orchestrator" "command -v ao" \
  'npm install -g @aoagents/ao' &
TOOL_PIDS="$TOOL_PIDS $!"

# Wait for all installs
INSTALL_FAILED=0
for pid in $TOOL_PIDS; do
  if ! wait "$pid"; then
    INSTALL_FAILED=1
  fi
done

if [ "$INSTALL_FAILED" -ne 0 ]; then
  echo ""
  echo "WARNING: Some tools failed to install. Check logs in $TOOL_LOGS/"
  ls "$TOOL_LOGS"/*.log 2>/dev/null | while read f; do
    echo "--- $(basename "$f") ---"
    tail -5 "$f"
  done
fi

rm -rf "$TOOL_LOGS"

# ------------------------------------------------------------------
# 3. Generate .env (if missing)
# ------------------------------------------------------------------
if [ ! -f "$REPO_DIR/.env" ]; then
  echo ""
  echo "--- Generating .env ---"
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  cat > "$REPO_DIR/.env" << ENV_EOF
GITHUB_WEBHOOK_SECRET=${WEBHOOK_SECRET}
ZAPBOT_REPO=${GITHUB_USER}/${ZAPBOT_REPO}
ZAPBOT_BRIDGE_PORT=3000
ZAPBOT_AO_PORT=3001
ZAPBOT_APPROVE_LABEL=plan-approved
ENV_EOF
  chmod 600 "$REPO_DIR/.env"
  echo "Created .env with random webhook secret (mode 600)"
else
  echo ".env: already exists (keeping existing secrets)"
fi

# Ensure .gitignore has .env
grep -q "^\.env$" "$REPO_DIR/.gitignore" 2>/dev/null || echo ".env" >> "$REPO_DIR/.gitignore"

# ------------------------------------------------------------------
# 4. Patch agent-orchestrator.yaml with local values
# ------------------------------------------------------------------
echo ""
echo "--- Configuring agent-orchestrator.yaml ---"
if [ -f "$REPO_DIR/agent-orchestrator.yaml" ]; then
  # Patch repo and path to match this machine
  sed -i.bak \
    -e "s|repo:.*|repo: ${GITHUB_USER}/${ZAPBOT_REPO}|" \
    -e "s|path:.*|path: ${REPO_DIR}|" \
    "$REPO_DIR/agent-orchestrator.yaml"
  rm -f "$REPO_DIR/agent-orchestrator.yaml.bak"
  echo "Patched repo and path in agent-orchestrator.yaml"
else
  echo "WARNING: agent-orchestrator.yaml not found. Clone the repo first."
fi

# ------------------------------------------------------------------
# 5. Create test GitHub repo (if it doesn't exist)
# ------------------------------------------------------------------
echo ""
echo "--- Setting up GitHub repo ---"
if gh repo view "${GITHUB_USER}/${ZAPBOT_REPO}" >/dev/null 2>&1; then
  echo "Repo ${GITHUB_USER}/${ZAPBOT_REPO} already exists"
else
  echo "Creating repo ${GITHUB_USER}/${ZAPBOT_REPO}..."
  gh repo create "${ZAPBOT_REPO}" --private --clone=false --description "Zapbot E2E test repo"
  echo "Repo created"
fi

# Set remote on local repo
ZAPBOT_REMOTE="https://github.com/${GITHUB_USER}/${ZAPBOT_REPO}.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$ZAPBOT_REMOTE"
else
  git remote add origin "$ZAPBOT_REMOTE"
fi
echo "Remote set to $ZAPBOT_REMOTE"

# Push if needed
git push -u origin main 2>/dev/null || echo "Already up to date"

# ------------------------------------------------------------------
# 6. Ensure GitHub labels exist
# ------------------------------------------------------------------
echo ""
echo "--- Ensuring labels exist ---"
gh label create "zapbot-plan" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" --color "0E8A16" --description "Plan published via /zapbot-publish" --force 2>/dev/null || true
gh label create "plan-approved" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" --color "1D76DB" --description "Plan approved for agent implementation" --force 2>/dev/null || true
echo "Labels ready"

# ------------------------------------------------------------------
# Done
# ------------------------------------------------------------------
echo ""
echo "================================================"
echo "  Zapbot setup complete!"
echo "================================================"
echo ""
echo "Next: run ./start.sh"
echo ""
echo "That starts everything (ngrok + webhook bridge + agent-orchestrator)."
echo "Then use /zapbot-publish in Claude Code to publish plans."
