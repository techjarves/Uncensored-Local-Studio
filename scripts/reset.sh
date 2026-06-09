#!/usr/bin/env bash
#
# Local AI Image Generator - Linux Reset Script
# Resets portable app dependencies/builds while preserving user models and outputs.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$ROOT_DIR/app"

echo ""
echo "  ============================================================"
echo "   Resetting Local-AI-Image-Generator..."
echo "  ============================================================"
echo ""

# Delete tools/node
if [[ -d "$APP_DIR/tools" ]]; then
  echo "   >> Removing portable tools/ node folder..."
  rm -rf "$APP_DIR/tools"
fi

# Delete backend
if [[ -d "$APP_DIR/backend" ]]; then
  echo "   >> Removing backend binaries..."
  rm -rf "$APP_DIR/backend"
fi

# Delete dist
if [[ -d "$APP_DIR/dist" ]]; then
  echo "   >> Removing dist/ build folder..."
  rm -rf "$APP_DIR/dist"
fi

# Preserve models
if [[ -d "$APP_DIR/models" ]]; then
  echo "   >> Preserving downloaded models in app/models."
fi

# Delete node_modules in frontend
if [[ -d "$APP_DIR/frontend/node_modules" ]]; then
  echo "   >> Removing frontend node_modules..."
  rm -rf "$APP_DIR/frontend/node_modules"
fi

# Delete package-lock.json in frontend
if [[ -f "$APP_DIR/frontend/package-lock.json" ]]; then
  echo "   >> Removing frontend package-lock.json..."
  rm -f "$APP_DIR/frontend/package-lock.json"
fi

echo ""
echo "  ============================================================"
echo "   Reset complete. Models and generated outputs were preserved."
echo "  ============================================================"
echo ""
read -rp "  Press Enter to close..."
