#!/usr/bin/env bash
set -euo pipefail

ZAPBOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${1:-$(pwd)}"

exec bun "$ZAPBOT_DIR/bin/zapbot-launch.ts" --checkout "$PROJECT_DIR"
