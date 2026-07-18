#!/usr/bin/env bash
#
# Optional CoreML NPU setup for Apple Silicon macOS systems.
# Sets up a virtual environment and installs Apple's ml-stable-diffusion.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
VENV_DIR="$ROOT_DIR/app/backend/mac/coreml_venv"
PYTHON_BIN="$VENV_DIR/bin/python"
ARCH="$(uname -m)"

if [[ "$(uname -s)" == "Darwin" ]] && [[ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" == "1" ]]; then
  ARCH="arm64"
fi

is_coreml_python_supported() {
  "$1" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if (3, 9) <= sys.version_info[:2] < (3, 12) else 1)
PY
}

find_coreml_python() {
  local candidate
  if [[ -n "${COREML_SETUP_PYTHON:-}" ]]; then
    if is_coreml_python_supported "$COREML_SETUP_PYTHON"; then
      echo "$COREML_SETUP_PYTHON"
      return 0
    fi
    return 1
  fi

  for candidate in python3.11 python3.10 python3.9 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && is_coreml_python_supported "$candidate"; then
      command -v "$candidate"
      return 0
    fi
  done

  return 1
}

coreml_venv_ready() {
  [[ -x "$PYTHON_BIN" ]] && "$PYTHON_BIN" -c "import sys; assert (3, 9) <= sys.version_info[:2] < (3, 12); import python_coreml_stable_diffusion, diffusers, transformers" >/dev/null 2>&1
}

echo ""
echo "  ============================================================"
echo "   Uncensored AI Studio - Apple Silicon CoreML NPU Setup"
echo "  ============================================================"
echo ""

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "  [ERROR] This setup script is for macOS only." >&2
  exit 1
fi

if [[ "$ARCH" != "arm64" ]]; then
  echo "  [ERROR] CoreML NPU support requires Apple Silicon (M1/M2/M3/M4/etc. arm64)." >&2
  exit 1
fi

SETUP_PYTHON="$(find_coreml_python || true)"
if [[ -z "$SETUP_PYTHON" ]]; then
  echo "  [ERROR] CoreML setup requires Python 3.9, 3.10, or 3.11." >&2
  echo "          Apple's ml-stable-diffusion dependency stack is not compatible with Python 3.12+." >&2
  echo "          Install python@3.11 with Homebrew, or set COREML_SETUP_PYTHON to a supported Python." >&2
  exit 1
fi

if [[ -x "$PYTHON_BIN" ]] && ! coreml_venv_ready; then
  echo "  Existing CoreML environment is incomplete or uses Python 3.12+. Recreating it..."
  rm -rf "$VENV_DIR"
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "  Creating Python environment: $VENV_DIR"
  if ! "$SETUP_PYTHON" -m venv "$VENV_DIR"; then
    echo "  [ERROR] Could not create the virtual environment."
    exit 1
  fi
fi

echo "  Installing CoreML Stable Diffusion dependencies (numpy, coremltools, diffusers)..."
"$PYTHON_BIN" -m pip install --upgrade pip
"$PYTHON_BIN" -m pip install "numpy<1.24" coremltools diffusers transformers huggingface-hub pillow

echo "  Installing Apple's python-coreml-stable-diffusion package..."
if ! "$PYTHON_BIN" -m pip install "git+https://github.com/apple/ml-stable-diffusion.git"; then
  echo "  [ERROR] Failed to install Apple's ml-stable-diffusion repository."
  echo "          Make sure 'git' is installed on your system."
  exit 1
fi

echo ""
echo "  Verifying CoreML environment..."
if ! "$PYTHON_BIN" -c "from python_coreml_stable_diffusion.pipeline import CoreMLStableDiffusionPipeline; print('  ANE (CoreML) Pipeline verified successfully!')"; then
  echo "  [ERROR] Verification failed. Please check the error details above."
  exit 1
fi

echo ""
echo "  ============================================================"
echo "   CoreML NPU setup complete."
echo "   Restart the launcher (./mac.sh) and download a CoreML model!"
echo "  ============================================================"
echo ""
