#!/usr/bin/env bash
#
# Uncensored AI Studio - Linux Launcher
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
SETUP_SCRIPT="$SCRIPT_DIR/scripts/setup/setup.sh"
SERVE_SCRIPT="$SCRIPT_DIR/scripts/server/serve.cjs"

FRONTEND_PORT="${FRONTEND_PORT:-1420}"
LLM_PORT="${LLM_PORT:-10086}"
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
  bash "$SCRIPT_DIR/scripts/setup/setup-openvino-npu.sh"
fi

# ── Setup node_modules to avoid OS conflicts ────────────────────────────────
FRONTEND_NODE_MODULES="$APP_DIR/frontend/node_modules"
LINUX_NODE_MODULES="$APP_DIR/frontend/node_modules_linux"
ACTIVE_OS_FILE="$APP_DIR/frontend/.active_modules_os"

# Attempt to create a test symlink to check if filesystem supports symlinks
USE_SYMLINKS=true
TEST_LINK="$APP_DIR/frontend/.test_symlink"
rm -f "$TEST_LINK"
if ln -s "node_modules_linux" "$TEST_LINK" 2>/dev/null; then
  rm -f "$TEST_LINK"
else
  USE_SYMLINKS=false
fi

if [ "$USE_SYMLINKS" = true ]; then
  if [[ -d "$FRONTEND_NODE_MODULES" && ! -L "$FRONTEND_NODE_MODULES" ]]; then
    echo "  >> Migrating existing node_modules to node_modules_linux..."
    rm -rf "$LINUX_NODE_MODULES"
    mv "$FRONTEND_NODE_MODULES" "$LINUX_NODE_MODULES"
  fi
  rm -f "$FRONTEND_NODE_MODULES"
  mkdir -p "$LINUX_NODE_MODULES"
  ln -sf "node_modules_linux" "$FRONTEND_NODE_MODULES"
else
  # Fallback: Filesystem does not support symlinks (e.g. FAT32/exFAT)
  echo "  >> Filesystem does not support symlinks. Using directory swapping fallback..."
  
  if [[ -L "$FRONTEND_NODE_MODULES" || -f "$FRONTEND_NODE_MODULES" ]]; then
    rm -f "$FRONTEND_NODE_MODULES"
  fi
  
  PREV_OS=""
  if [[ -f "$ACTIVE_OS_FILE" ]]; then
    PREV_OS=$(cat "$ACTIVE_OS_FILE")
  fi
  
  if [[ -d "$FRONTEND_NODE_MODULES" && "$PREV_OS" != "linux" ]]; then
    if [[ -n "$PREV_OS" ]]; then
      echo "  >> Swapping out node_modules to node_modules_$PREV_OS..."
      rm -rf "$APP_DIR/frontend/node_modules_$PREV_OS"
      mv "$FRONTEND_NODE_MODULES" "$APP_DIR/frontend/node_modules_$PREV_OS"
    else
      echo "  >> Saving node_modules as node_modules_windows..."
      rm -rf "$APP_DIR/frontend/node_modules_windows"
      mv "$FRONTEND_NODE_MODULES" "$APP_DIR/frontend/node_modules_windows"
    fi
  fi
  
  if [[ -d "$LINUX_NODE_MODULES" && ! -d "$FRONTEND_NODE_MODULES" ]]; then
    echo "  >> Swapping in node_modules_linux..."
    mv "$LINUX_NODE_MODULES" "$FRONTEND_NODE_MODULES"
  elif [[ ! -d "$FRONTEND_NODE_MODULES" ]]; then
    mkdir -p "$FRONTEND_NODE_MODULES"
  fi
  
  echo "linux" > "$ACTIVE_OS_FILE"
fi

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
LLM_CUDA_PATH="$APP_DIR/llm-backend/linux/cuda/llama-server"
LLM_ROCM_PATH="$APP_DIR/llm-backend/linux/rocm/llama-server"
LLM_SYCL_PATH="$APP_DIR/llm-backend/linux/sycl/llama-server"
LLM_VULKAN_PATH="$APP_DIR/llm-backend/linux/vulkan/llama-server"
LLM_CPU_PATH="$APP_DIR/llm-backend/linux/cpu/llama-server"
SPEECH_BACKEND_PATH="$APP_DIR/speech-backend/linux/cpu/whisper-cli"
TTS_RUNTIME_PATH="$APP_DIR/tts-runtime/node_modules/kokoro-js"
if [[ ! -x "$CPU_BACKEND_PATH" || ! -x "$CPU_SERVER_PATH" ]] && [[ ! -x "$BACKEND_PATH" || ! -x "$VULKAN_SERVER_PATH" ]]; then
  SETUP_REASON="Linux backend binaries are missing or not executable."
fi
if [[ ! -x "$LLM_CUDA_PATH" && ! -x "$LLM_ROCM_PATH" && ! -x "$LLM_SYCL_PATH" && ! -x "$LLM_VULKAN_PATH" && ! -x "$LLM_CPU_PATH" ]]; then
  SETUP_REASON="Linux llama.cpp text backend is missing or not executable."
fi
if [[ ! -x "$SPEECH_BACKEND_PATH" ]]; then
  SETUP_REASON="Linux whisper.cpp speech backend is missing or not executable."
fi
if [[ ! -d "$TTS_RUNTIME_PATH" ]]; then
  SETUP_REASON="Kokoro text-to-speech runtime is missing."
fi

if [[ -n "$SETUP_REASON" ]]; then
  echo ""
  echo "  ============================================================"
  echo "   UNCENSORED AI STUDIO      |  $PLATFORM_LABEL $SETUP_MODE"
  echo "  ============================================================"
  echo ""
  if [[ "$SETUP_MODE" == "First-Time Setup" ]]; then
    echo "  This looks like your first run on Linux. Setting up automatically..."
  else
    echo "  Uncensored AI Studio needs a quick repair before launch."
  fi
  echo "  Reason: $SETUP_REASON"
  echo "  Models are not downloaded during setup. Download or import them in the app."
  echo ""
  read -rp "  Press Enter to continue, or Ctrl+C to cancel."

  # Clear any existing frontend and backend server processes
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -i:"${FRONTEND_PORT}" -i:8080 -i:"${LLM_PORT}" | xargs kill -9 >/dev/null 2>&1 || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "${FRONTEND_PORT}/tcp" >/dev/null 2>&1 || true
    fuser -k "8080/tcp" >/dev/null 2>&1 || true
    fuser -k "${LLM_PORT}/tcp" >/dev/null 2>&1 || true
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
echo "   UNCENSORED AI STUDIO      |  Launching..."
echo "  ============================================================"
echo ""

# Clear frontend and backend ports
if command -v lsof >/dev/null 2>&1; then
  lsof -t -i:"${FRONTEND_PORT}" -i:8080 -i:"${LLM_PORT}" | xargs kill -9 >/dev/null 2>&1 || true
elif command -v fuser >/dev/null 2>&1; then
  fuser -k "${FRONTEND_PORT}/tcp" >/dev/null 2>&1 || true
  fuser -k "8080/tcp" >/dev/null 2>&1 || true
  fuser -k "${LLM_PORT}/tcp" >/dev/null 2>&1 || true
fi

# Start the server
echo "  Starting Uncensored AI Studio..."
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
echo "   Text API:   Starts when a GGUF model is loaded (port ${LLM_PORT})"
echo "   Speech:     Managed locally by the app"
echo "   TTS:        Managed locally by the app"
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
