#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
APP_DIR="$ROOT_DIR/app"
TOOLS_DIR="$APP_DIR/tools"
RELEASE="${LLAMA_RELEASE:-b9668}"
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

if [[ "$PLATFORM" == "Darwin" ]] && [[ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" == "1" ]]; then
  ARCH="arm64"
fi

download_and_extract() {
  local asset="$1"
  local dest="$2"
  local archive="$TOOLS_DIR/$asset"
  local url="https://github.com/ggml-org/llama.cpp/releases/download/$RELEASE/$asset"

  if [[ -x "$dest/llama-server" ]]; then
    echo "   OK   llama.cpp backend already ready: $dest"
    return
  fi

  mkdir -p "$TOOLS_DIR" "$dest"
  rm -f "$archive" "$archive.part"
  echo "   >>   Downloading $asset"
  curl -fSL --progress-bar "$url" -o "$archive.part"
  mv "$archive.part" "$archive"
  if command -v python3 >/dev/null 2>&1; then
    python3 "$SCRIPT_DIR/extract_tar.py" --archive "$archive" --dest "$dest" --strip-components=1
  else
    tar -xzf "$archive" -C "$dest" --strip-components=1
  fi
  rm -f "$archive"
  chmod +x "$dest"/llama-* 2>/dev/null || true

  if [[ ! -x "$dest/llama-server" ]]; then
    echo "   XX   llama-server was not found after extracting $asset" >&2
    return 1
  fi
}

download_and_extract_optional() {
  local asset="$1"
  local dest="$2"
  local reason="$3"

  if [[ -x "$dest/llama-server" ]]; then
    echo "   OK   optional llama.cpp backend already ready: $dest"
    return 0
  fi

  if download_and_extract "$asset" "$dest"; then
    return 0
  fi

  echo "   !!   Skipping optional llama.cpp backend for $reason ($asset)" >&2
  rm -rf "$dest"
  return 0
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

has_linux_gpu_vendor() {
  local vendor="$1"
  [[ -d /sys/bus/pci/devices ]] || return 1
  grep -Ril "$vendor" /sys/bus/pci/devices/*/vendor >/dev/null 2>&1
}

if [[ "$PLATFORM" == "Darwin" ]]; then
  if [[ "$ARCH" == "arm64" ]]; then
    download_and_extract "llama-$RELEASE-bin-macos-arm64.tar.gz" "$APP_DIR/llm-backend/mac/arm64"
  else
    download_and_extract "llama-$RELEASE-bin-macos-x64.tar.gz" "$APP_DIR/llm-backend/mac/x64"
  fi
elif [[ "$PLATFORM" == "Linux" ]]; then
  if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
    download_and_extract "llama-$RELEASE-bin-ubuntu-vulkan-arm64.tar.gz" "$APP_DIR/llm-backend/linux/vulkan"
    download_and_extract "llama-$RELEASE-bin-ubuntu-arm64.tar.gz" "$APP_DIR/llm-backend/linux/cpu"
  else
    if has_command nvidia-smi || has_linux_gpu_vendor "0x10de"; then
      download_and_extract_optional "llama-$RELEASE-bin-ubuntu-cuda-12.4-x64.tar.gz" "$APP_DIR/llm-backend/linux/cuda" "NVIDIA CUDA acceleration"
    fi
    if has_command rocminfo || has_linux_gpu_vendor "0x1002"; then
      download_and_extract_optional "llama-$RELEASE-bin-ubuntu-rocm-x64.tar.gz" "$APP_DIR/llm-backend/linux/rocm" "AMD ROCm acceleration"
    fi
    if has_linux_gpu_vendor "0x8086"; then
      download_and_extract_optional "llama-$RELEASE-bin-ubuntu-sycl-fp32-x64.tar.gz" "$APP_DIR/llm-backend/linux/sycl" "Intel SYCL acceleration"
    fi
    download_and_extract "llama-$RELEASE-bin-ubuntu-vulkan-x64.tar.gz" "$APP_DIR/llm-backend/linux/vulkan"
    download_and_extract "llama-$RELEASE-bin-ubuntu-x64.tar.gz" "$APP_DIR/llm-backend/linux/cpu"
  fi
else
  echo "Unsupported platform: $PLATFORM" >&2
  exit 1
fi
