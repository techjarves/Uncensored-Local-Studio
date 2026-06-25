#!/usr/bin/env bash
#
# Optional OpenVINO NPU setup for Linux Intel Core Ultra systems.
# The Intel NPU kernel/user-mode driver must already be installed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
VENV_DIR="$ROOT_DIR/app/tools/openvino-venv-linux"
PYTHON_BIN="$VENV_DIR/bin/python"

echo ""
echo "  ============================================================"
echo "   Uncensored AI Studio - Linux OpenVINO NPU Setup"
echo "  ============================================================"
echo ""

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "  [ERROR] This setup script is for Linux only." >&2
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "  [ERROR] OpenVINO NPU support requires x86_64 Linux." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "  [ERROR] python3 is required. Install Python 3 and the venv module." >&2
  exit 1
fi

KERNEL_VERSION="$(uname -r)"
KERNEL_MAJOR="${KERNEL_VERSION%%.*}"
KERNEL_REST="${KERNEL_VERSION#*.}"
KERNEL_MINOR="${KERNEL_REST%%.*}"
if (( KERNEL_MAJOR < 6 || (KERNEL_MAJOR == 6 && KERNEL_MINOR < 6) )); then
  echo "  [ERROR] Intel NPU support requires Linux kernel 6.6 or newer."
  echo "          Current kernel: $KERNEL_VERSION"
  exit 1
fi

if [[ ! -e /dev/accel/accel0 ]]; then
  echo "  [ERROR] Intel NPU device /dev/accel/accel0 was not found."
  echo "          Install the Intel Linux NPU driver and reboot first."
  echo "          Driver: https://github.com/intel/linux-npu-driver"
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "  Creating Python environment: $VENV_DIR"
  if ! python3 -m venv "$VENV_DIR"; then
    echo "  [ERROR] Could not create the virtual environment."
    echo "          On Ubuntu, install python3-venv and retry."
    exit 1
  fi
fi

echo "  Installing OpenVINO GenAI runtime..."
"$PYTHON_BIN" -m pip install --upgrade pip
"$PYTHON_BIN" -m pip install openvino openvino-genai pillow huggingface-hub

echo ""
echo "  Verifying OpenVINO NPU device..."
"$PYTHON_BIN" - <<'PY'
import openvino as ov

core = ov.Core()
devices = core.available_devices
print("  Available devices:", ", ".join(devices))
if "NPU" not in devices:
    raise SystemExit(
        "  [ERROR] OpenVINO is installed, but NPU is unavailable. "
        "Verify the Intel NPU driver and device permissions."
    )
print("  NPU:", core.get_property("NPU", "FULL_DEVICE_NAME"))
PY

echo ""
echo "  ============================================================"
echo "   OpenVINO NPU setup complete."
echo "   Run ./linux.sh, then download an OpenVINO NPU model."
echo "  ============================================================"
echo ""
