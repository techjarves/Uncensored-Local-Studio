#!/usr/bin/env bash
#
# Uncensored AI Studio - macOS Launcher
# Double-click or run: ./mac.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

if [[ "$PLATFORM" != "Darwin" ]]; then
  echo "[ERROR] This script is for macOS only. Please run ./linux.sh on Linux." >&2
  exit 1
fi

if [[ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" == "1" ]]; then
  ARCH="arm64"
fi

NODE_DIR="$APP_DIR/tools/node-mac"
NODE_BIN="$NODE_DIR/bin/node"
BACKEND_PATH="$APP_DIR/backend/mac/sd"
if [[ "$ARCH" == "arm64" ]]; then
  LLM_BACKEND_PATH="$APP_DIR/llm-backend/mac/arm64/llama-server"
else
  LLM_BACKEND_PATH="$APP_DIR/llm-backend/mac/x64/llama-server"
fi
TTS_RUNTIME_PATH="$APP_DIR/tts-runtime/node_modules/kokoro-js"
SPEECH_BACKEND_PATH="$APP_DIR/speech-backend/mac/cpu/whisper-cli"
PLATFORM_LABEL="macOS"

DIST_INDEX="$APP_DIR/dist/index.html"
SETUP_SCRIPT="$SCRIPT_DIR/scripts/setup/setup.sh"
SERVE_SCRIPT="$SCRIPT_DIR/scripts/server/serve.cjs"

FRONTEND_PORT="${FRONTEND_PORT:-1420}"
LLM_PORT="${LLM_PORT:-10086}"
SETUP_REASON=""
SETUP_MODE="Repair"

is_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
    return
  fi
  (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
}

resolve_frontend_port() {
  local preferred="$1"
  local port

  if ! is_port_in_use "$preferred"; then
    echo "$preferred"
    return 0
  fi

  for ((port = 1421; port <= 1499; port += 1)); do
    if [[ "$port" == "$preferred" ]]; then
      continue
    fi
    if ! is_port_in_use "$port"; then
      echo "$port"
      return 0
    fi
  done

  echo "[ERROR] No free frontend port found. Tried $preferred and 1421-1499." >&2
  return 1
}

# ── Setup node_modules to avoid OS conflicts ────────────────────────────────
FRONTEND_NODE_MODULES="$APP_DIR/frontend/node_modules"
MAC_NODE_MODULES="$APP_DIR/frontend/node_modules_mac"
ACTIVE_OS_FILE="$APP_DIR/frontend/.active_modules_os"

# Attempt to create a test symlink to check if filesystem supports symlinks
USE_SYMLINKS=true
TEST_LINK="$APP_DIR/frontend/.test_symlink"
rm -f "$TEST_LINK"
if ln -s "node_modules_mac" "$TEST_LINK" 2>/dev/null; then
  rm -f "$TEST_LINK"
else
  USE_SYMLINKS=false
fi

if [ "$USE_SYMLINKS" = true ]; then
  if [[ -d "$FRONTEND_NODE_MODULES" && ! -L "$FRONTEND_NODE_MODULES" ]]; then
    echo "  >> Migrating existing node_modules to node_modules_mac..."
    rm -rf "$MAC_NODE_MODULES"
    mv "$FRONTEND_NODE_MODULES" "$MAC_NODE_MODULES"
  fi
  rm -f "$FRONTEND_NODE_MODULES"
  mkdir -p "$MAC_NODE_MODULES"
  ln -sf "node_modules_mac" "$FRONTEND_NODE_MODULES"
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
  
  if [[ -d "$FRONTEND_NODE_MODULES" && "$PREV_OS" != "mac" ]]; then
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
  
  if [[ -d "$MAC_NODE_MODULES" && ! -d "$FRONTEND_NODE_MODULES" ]]; then
    echo "  >> Swapping in node_modules_mac..."
    mv "$MAC_NODE_MODULES" "$FRONTEND_NODE_MODULES"
  elif [[ ! -d "$FRONTEND_NODE_MODULES" ]]; then
    mkdir -p "$FRONTEND_NODE_MODULES"
  fi
  
  echo "mac" > "$ACTIVE_OS_FILE"
fi

# ── First-time setup check ─────────────────────────────────────────────────
if [[ ! -d "$NODE_DIR" ]]; then
  SETUP_MODE="First-Time Setup"
fi

if [[ ! -x "$NODE_BIN" ]]; then
  SETUP_REASON="Portable Node.js for macOS is missing."
fi

if [[ ! -f "$DIST_INDEX" ]]; then
  SETUP_REASON="Frontend build is missing."
fi

if [[ ! -x "$BACKEND_PATH" ]]; then
  SETUP_REASON="No macOS Metal backend binary is installed."
fi
if [[ ! -x "$LLM_BACKEND_PATH" ]]; then
  SETUP_REASON="No macOS llama.cpp text backend is installed."
fi
if [[ ! -d "$TTS_RUNTIME_PATH" ]]; then
  SETUP_REASON="Kokoro text-to-speech runtime is missing."
fi
if [[ ! -x "$SPEECH_BACKEND_PATH" ]]; then
  SETUP_REASON="macOS whisper.cpp speech backend is missing."
fi

if [[ -n "$SETUP_REASON" ]]; then
  echo ""
  echo "  ============================================================"
  echo "   UNCENSORED AI STUDIO      |  $PLATFORM_LABEL $SETUP_MODE"
  echo "  ============================================================"
  echo ""
  if [[ "$SETUP_MODE" == "First-Time Setup" ]]; then
    echo "  This looks like your first run on macOS. Setting up automatically..."
  else
    echo "  Uncensored AI Studio needs a quick repair before launch."
  fi
  echo "  Reason: $SETUP_REASON"
  echo "  Models are not downloaded during setup. Download or import them in the app."
  echo ""
  read -rp "  Press Enter to continue, or Ctrl+C to cancel."

  # Clear managed backend ports before setup. Do not kill the frontend port;
  # launch will select a free frontend port automatically.
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -i:8080 -i:"${LLM_PORT}" | xargs kill -9 >/dev/null 2>&1 || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "8080/tcp" >/dev/null 2>&1 || true
    fuser -k "${LLM_PORT}/tcp" >/dev/null 2>&1 || true
  fi

  if ! bash "$SETUP_SCRIPT"; then
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

REQUESTED_FRONTEND_PORT="$FRONTEND_PORT"
FRONTEND_PORT="$(resolve_frontend_port "$REQUESTED_FRONTEND_PORT")"
if [[ "$FRONTEND_PORT" != "$REQUESTED_FRONTEND_PORT" ]]; then
  echo "  Frontend port ${REQUESTED_FRONTEND_PORT} is busy; using ${FRONTEND_PORT} instead."
fi

# Clear managed backend ports
if command -v lsof >/dev/null 2>&1; then
  lsof -t -i:8080 -i:"${LLM_PORT}" | xargs kill -9 >/dev/null 2>&1 || true
elif command -v fuser >/dev/null 2>&1; then
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
if command -v open >/dev/null 2>&1; then
  echo "  Opening browser at http://localhost:${FRONTEND_PORT}"
  open "http://localhost:${FRONTEND_PORT}" >/dev/null 2>&1 &
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
