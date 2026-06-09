#!/usr/bin/env bash
#
# Local AI Image Generator - Linux/macOS Launcher
# Double-click or run: ./start.sh
# Use --max-perf to enable ROCm backend downloads on Linux first setup.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
PLATFORM="$(uname -s)"
if [[ "$PLATFORM" == "Darwin" ]]; then
  NODE_DIR="$APP_DIR/tools/node-mac"
  BACKEND_PATH="$APP_DIR/backend/mac/sd"
  PLATFORM_LABEL="macOS"
else
  NODE_DIR="$APP_DIR/tools/node-linux"
  BACKEND_PATH="$APP_DIR/backend/linux/vulkan/sd-vulkan"
  CPU_BACKEND_PATH="$APP_DIR/backend/linux/cpu/sd-cpu"
  PLATFORM_LABEL="Linux"
fi
NODE_BIN="$NODE_DIR/bin/node"
DIST_INDEX="$APP_DIR/dist/index.html"
SETUP_SCRIPT="$SCRIPT_DIR/scripts/setup.sh"
SERVE_SCRIPT="$SCRIPT_DIR/scripts/serve.cjs"

FRONTEND_PORT="${FRONTEND_PORT:-1420}"
SETUP_REASON=""
SETUP_MODE="Repair"
MAX_PERF_FLAG=""

# Parse args
if [[ "${1:-}" == "--max-perf" ]]; then
  MAX_PERF_FLAG="--max-perf"
fi

# ── First-time setup check ─────────────────────────────────────────────────
if [[ ! -d "$NODE_DIR" ]]; then
  SETUP_MODE="First-Time Setup"
fi

if [[ ! -x "$NODE_BIN" ]]; then
  SETUP_REASON="Portable Node.js is missing."
fi

if [[ ! -f "$DIST_INDEX" ]]; then
  SETUP_REASON="Frontend build is missing."
fi

if [[ "$PLATFORM" == "Darwin" ]]; then
  if [[ ! -x "$BACKEND_PATH" ]]; then
    SETUP_REASON="No macOS Metal backend binary is installed."
  fi
else
  # At minimum we need CPU or Vulkan backend on Linux, and both CLI and server binaries must be executable
  CPU_SERVER_PATH="$APP_DIR/backend/linux/cpu/sd-server-cpu"
  VULKAN_SERVER_PATH="$APP_DIR/backend/linux/vulkan/sd-server-vulkan"
  if [[ ! -x "$CPU_BACKEND_PATH" || ! -x "$CPU_SERVER_PATH" ]] && [[ ! -x "$BACKEND_PATH" || ! -x "$VULKAN_SERVER_PATH" ]]; then
    SETUP_REASON="Linux backend binaries are missing or not executable."
  fi
fi

if [[ -n "$SETUP_REASON" ]]; then
  echo ""
  echo "  ============================================================"
  echo "   LOCAL AI IMAGE GENERATOR  |  $PLATFORM_LABEL $SETUP_MODE"
  echo "  ============================================================"
  echo ""
  if [[ "$SETUP_MODE" == "First-Time Setup" ]]; then
    echo "  This looks like your first run. Setting up automatically..."
  else
    echo "  Local AI Image Generator needs a quick repair before launch."
  fi
  echo "  Reason: $SETUP_REASON"
  echo "  Models are not downloaded during setup. Download or import them in the app."
  echo ""
  read -rp "  Press Enter to continue, or Ctrl+C to cancel."

  # Clear any existing frontend server process
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${FRONTEND_PORT}/tcp" >/dev/null 2>&1 || true
  fi

  if ! bash "$SETUP_SCRIPT" $MAX_PERF_FLAG; then
    echo ""
    echo "  [ERROR] Setup failed. Please check the output above."
    read -rp "  Press Enter to close..."
    exit 1
  fi
fi

# ── Launch ─────────────────────────────────────────────────────────────────
clear 2>/dev/null || true
echo ""
echo "  ============================================================"
echo "   LOCAL AI IMAGE GENERATOR  |  Launching..."
echo "  ============================================================"
echo ""

# Clear frontend port
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${FRONTEND_PORT}/tcp" >/dev/null 2>&1 || true
fi

# Start the server
echo "  Starting Local AI Image Generator..."
export PATH="$NODE_DIR/bin:$PATH"
export FRONTEND_PORT="$FRONTEND_PORT"

# Run server in background and capture PID
"$NODE_BIN" "$SERVE_SCRIPT" &
SERVER_PID=$!

# Wait for server to be ready
sleep 2

# Open browser
if [[ "$PLATFORM" == "Darwin" ]] && command -v open >/dev/null 2>&1; then
  echo "  Opening browser at http://localhost:${FRONTEND_PORT}"
  open "http://localhost:${FRONTEND_PORT}" >/dev/null 2>&1 &
elif command -v xdg-open >/dev/null 2>&1; then
  echo "  Opening browser at http://localhost:${FRONTEND_PORT}"
  xdg-open "http://localhost:${FRONTEND_PORT}" >/dev/null 2>&1 &
else
  echo "  Open your browser to: http://localhost:${FRONTEND_PORT}"
fi

echo ""
echo "  ============================================================"
echo "   Running!"
echo "   Web UI:     http://localhost:${FRONTEND_PORT}"
echo "   GPU API:    Auto-selected by the app (starts at 8080)"
echo ""
echo "   Press Ctrl+C in this window to stop all services."
echo "  ============================================================"
echo ""

# Cleanup on exit
cleanup() {
  echo ""
  echo "  Shutting down..."
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill -TERM "$SERVER_PID" >/dev/null 2>&1 || true
    sleep 1
    kill -KILL "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  echo "  Done. Goodbye!"
  exit 0
}
trap cleanup SIGINT SIGTERM

# Keep script alive
wait "$SERVER_PID" || true
cleanup
