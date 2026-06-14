#!/usr/bin/env bash
#
# Local AI Image Generator - Linux Launcher
# Double-click or run: ./linux.sh
# Use --max-perf to enable ROCm backend downloads on Linux first setup.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
PLATFORM="$(uname -s)"

if [[ "$PLATFORM" != "Linux" ]]; then
  echo "[ERROR] This script is for Linux only. Please run ./mac.sh on macOS." >&2
  exit 1
fi

NODE_DIR="$APP_DIR/tools/node-linux"
NODE_BIN="$NODE_DIR/bin/node"
BACKEND_PATH="$APP_DIR/backend/linux/vulkan/sd-vulkan"
CPU_BACKEND_PATH="$APP_DIR/backend/linux/cpu/sd-cpu"
PLATFORM_LABEL="Linux"

DIST_INDEX="$APP_DIR/dist/index.html"
SETUP_SCRIPT="$SCRIPT_DIR/scripts/setup.sh"
SERVE_SCRIPT="$SCRIPT_DIR/scripts/serve.cjs"

FRONTEND_PORT="${FRONTEND_PORT:-1420}"
SETUP_REASON=""
SETUP_MODE="Repair"
MAX_PERF_FLAG=""
SETUP_OPENVINO=0

# Parse args
for arg in "$@"; do
  case "$arg" in
    --max-perf)
      MAX_PERF_FLAG="--max-perf"
      ;;
    --setup-openvino)
      SETUP_OPENVINO=1
      ;;
    *)
      echo "[ERROR] Unknown option: $arg" >&2
      echo "Usage: ./linux.sh [--max-perf] [--setup-openvino]" >&2
      exit 1
      ;;
  esac
done

if [[ $SETUP_OPENVINO -eq 1 ]]; then
  bash "$SCRIPT_DIR/scripts/setup-openvino-npu.sh"
fi

# ── Symlink node_modules to avoid OS conflicts ──────────────────────────────
FRONTEND_NODE_MODULES="$APP_DIR/frontend/node_modules"
LINUX_NODE_MODULES="$APP_DIR/frontend/node_modules_linux"

if [[ -d "$FRONTEND_NODE_MODULES" && ! -L "$FRONTEND_NODE_MODULES" ]]; then
  echo "  >> Migrating existing node_modules to node_modules_linux..."
  mv "$FRONTEND_NODE_MODULES" "$LINUX_NODE_MODULES"
fi

rm -f "$FRONTEND_NODE_MODULES"
mkdir -p "$LINUX_NODE_MODULES"
ln -sf "node_modules_linux" "$FRONTEND_NODE_MODULES"

# ── First-time setup check ─────────────────────────────────────────────────
if [[ ! -d "$NODE_DIR" ]]; then
  SETUP_MODE="First-Time Setup"
fi

if [[ ! -x "$NODE_BIN" ]]; then
  SETUP_REASON="Portable Node.js for Linux is missing."
fi

if [[ ! -f "$DIST_INDEX" ]]; then
  SETUP_REASON="Frontend build is missing."
fi

# At minimum we need CPU or Vulkan backend on Linux, and both CLI and server binaries must be executable
CPU_SERVER_PATH="$APP_DIR/backend/linux/cpu/sd-server-cpu"
VULKAN_SERVER_PATH="$APP_DIR/backend/linux/vulkan/sd-server-vulkan"
if [[ ! -x "$CPU_BACKEND_PATH" || ! -x "$CPU_SERVER_PATH" ]] && [[ ! -x "$BACKEND_PATH" || ! -x "$VULKAN_SERVER_PATH" ]]; then
  SETUP_REASON="Linux backend binaries are missing or not executable."
fi

if [[ -n "$SETUP_REASON" ]]; then
  echo ""
  echo "  ============================================================"
  echo "   LOCAL AI IMAGE GENERATOR  |  $PLATFORM_LABEL $SETUP_MODE"
  echo "  ============================================================"
  echo ""
  if [[ "$SETUP_MODE" == "First-Time Setup" ]]; then
    echo "  This looks like your first run on Linux. Setting up automatically..."
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
if command -v xdg-open >/dev/null 2>&1; then
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
