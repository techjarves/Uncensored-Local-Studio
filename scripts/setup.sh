#!/usr/bin/env bash
#
# Local AI Image Generator - Linux/macOS Setup Script
# Self-contained: no apt/yum/pacman, no global Node.js install.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$ROOT_DIR/app"
FRONTEND_DIR="$APP_DIR/frontend"
TOOLS_DIR="$APP_DIR/tools"
DIST_DIR="$APP_DIR/dist"
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

if [[ "$PLATFORM" == "Darwin" ]]; then
  PLATFORM_LABEL="macOS"
  NODE_DIR="$TOOLS_DIR/node-mac"
  BACKEND_DIR="$APP_DIR/backend/mac"
else
  PLATFORM_LABEL="Linux"
  NODE_DIR="$TOOLS_DIR/node-linux"
  BACKEND_DIR="$APP_DIR/backend/linux"
fi

NODE_BIN="$NODE_DIR/bin/node"
NPM_BIN="$NODE_DIR/bin/npm"

# Release pins
SD_RELEASE="master-685-19bdfe2"
SD_SHORT_HASH="${SD_RELEASE##*-}"
SD_BASE_URL="https://github.com/leejet/stable-diffusion.cpp/releases/download/$SD_RELEASE"
NODE_VERSION="22.12.0"

if [[ "$PLATFORM" == "Darwin" ]]; then
  if [[ "$ARCH" == "arm64" ]]; then
    NODE_PLATFORM_ARCH="darwin-arm64"
  else
    NODE_PLATFORM_ARCH="darwin-x64"
  fi
  NODE_TARBALL="node-v${NODE_VERSION}-${NODE_PLATFORM_ARCH}.tar.gz"
else
  NODE_PLATFORM_ARCH="linux-x64"
  NODE_TARBALL="node-v${NODE_VERSION}-${NODE_PLATFORM_ARCH}.tar.xz"
fi
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/$NODE_TARBALL"

# Flags
MAX_PERF=0
if [[ "${1:-}" == "--max-perf" ]]; then
  MAX_PERF=1
fi

# ── Helpers ─────────────────────────────────────────────────────────────────
print_header() {
  clear 2>/dev/null || true
  echo ""
  echo "  ============================================================"
  echo "   LOCAL AI IMAGE GENERATOR  -  $PLATFORM_LABEL First-Time Setup"
  echo "   100% Self-Contained  |  No System Install Required"
  echo "  ============================================================"
  echo ""
}

print_step() {
  local n="$1" total="$2" title="$3"
  echo ""
  echo "  [$n/$total] $title"
  echo "  ------------------------------------------------------------"
}

print_ok()   { echo "   OK   $1"; }
print_info() { echo "   >>   $1"; }
print_warn() { echo "   !!   $1"; }
print_fail() { echo "   XX   $1"; }

format_bytes() {
  local b="${1:-0}"
  if command -v bc >/dev/null 2>&1; then
    if (( b > 1073741824 )); then printf "%.2f GB" "$(echo "scale=4; $b / 1073741824" | bc)"; return; fi
    if (( b > 1048576 )); then printf "%.1f MB" "$(echo "scale=4; $b / 1048576" | bc)"; return; fi
    if (( b > 1024 )); then printf "%.0f KB" "$(echo "scale=4; $b / 1024" | bc)"; return; fi
  else
    if (( b > 1073741824 )); then printf "%.2f GB" "$(awk "BEGIN {printf \"%.2f\", $b/1073741824}")"; return; fi
    if (( b > 1048576 )); then printf "%.1f MB" "$(awk "BEGIN {printf \"%.1f\", $b/1048576}")"; return; fi
    if (( b > 1024 )); then printf "%.0f KB" "$(awk "BEGIN {printf \"%.0f\", $b/1024}")"; return; fi
  fi
  printf "%s B" "$b"
}

# Rich download with progress bar
download_file() {
  local url="$1" dest="$2" label="$3"
  print_info "Downloading: $label"
  echo ""

  local tmp_dest="${dest}.part"
  rm -f "$tmp_dest"

  curl -fSL --progress-bar "$url" -o "$tmp_dest" || {
    print_fail "Download failed: $url"
    rm -f "$tmp_dest"
    return 1
  }

  mv "$tmp_dest" "$dest"
  echo ""
  local fsize
  fsize="$(stat -c%s "$dest" 2>/dev/null || stat -f%z "$dest" 2>/dev/null || echo 0)"
  print_ok "Downloaded $(format_bytes "$fsize")"
}

# Extract ZIP using Python zipfile (preferred), unzip, or Node.js adm-zip
extract_zip() {
  local zip_path="$1" dest="$2" label="$3"
  print_info "Extracting: $label"
  mkdir -p "$dest"

  # Prefer Python zipfile (most reliable, no host deps beyond python3)
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import zipfile, sys, os
with zipfile.ZipFile(sys.argv[1], 'r') as z:
    for member in z.namelist():
        z.extract(member, sys.argv[2])
" "$zip_path" "$dest" && return 0
  fi

  if command -v unzip >/dev/null 2>&1; then
    unzip -o -q "$zip_path" -d "$dest" && return 0
  fi

  if command -v python >/dev/null 2>&1; then
    python -c "import zipfile, sys; zipfile.ZipFile(sys.argv[1], 'r').extractall(sys.argv[2])" "$zip_path" "$dest" && return 0
  fi

  print_fail "No ZIP extractor available (tried python3, unzip, python)."
  return 1
}

# Extract tar.xz
extract_tarxz() {
  local tar_path="$1" dest="$2" label="$3"
  print_info "Extracting: $label"
  mkdir -p "$dest"
  tar -xf "$tar_path" -C "$dest"
  print_ok "Extracted $label"
}

detect_gpu_vendor() {
  local vendor=""
  if [[ -d /sys/bus/pci/devices ]]; then
    for vfile in /sys/bus/pci/devices/*/vendor; do
      if [[ -f "$vfile" ]]; then
        local vid
        vid="$(cat "$vfile" 2>/dev/null || true)"
        case "$vid" in
          "0x10de") vendor="nvidia" ;;
          "0x1002") vendor="amd" ;;
          "0x8086") [[ -z "$vendor" ]] && vendor="intel" ;;
        esac
      fi
    done
  fi
  echo "$vendor"
}

# Official Linux binaries are built on Ubuntu 24.04 and link against glibc 2.38+.
# This routine prints a warning on older distributions so users know upfront.
check_glibc() {
  local required="2.38"
  local current=""
  if command -v ldd >/dev/null 2>&1; then
    current="$(ldd --version 2>/dev/null | head -n1 | grep -oP '[0-9]+\.[0-9]+' | head -n1 || true)"
  fi
  if [[ -z "$current" ]]; then
    print_warn "Could not detect glibc version. Prebuilt Linux backends require glibc $required+ (Ubuntu 24.04)."
    return
  fi
  if [[ "$(printf '%s\n' "$required" "$current" | sort -V | head -n1)" != "$required" ]]; then
    print_warn "Detected glibc $current. Prebuilt Linux backends require glibc $required+ (Ubuntu 24.04)."
    print_info "You can still use the app, but the downloaded backends will not start on this system."
    print_info "To fix: upgrade to Ubuntu 24.04+ or build stable-diffusion.cpp from source (see README)."
  fi
}

copy_binaries_from_extracted() {
  local extracted_dir="$1" dest_dir="$2" main_name="$3" server_name="$4"

  while IFS= read -r -d '' f; do
    local base
    base="$(basename "$f")"
    case "$base" in
      sd|sd-cli) cp "$f" "$dest_dir/$main_name" ;;
      sd-server) cp "$f" "$dest_dir/$server_name" ;;
    esac
  done < <(find "$extracted_dir" -type f \( -name "sd" -o -name "sd-cli" -o -name "sd-server" \) -print0 2>/dev/null)

  # Copy any .so files
  find "$extracted_dir" -type f -name "*.so" -exec cp {} "$dest_dir/" \; 2>/dev/null || true
}

copy_macos_backend_from_extracted() {
  local extracted_dir="$1" dest_dir="$2"
  local target="$dest_dir/sd"
  local server_bin=""
  local cli_bin=""

  server_bin="$(find "$extracted_dir" -type f -name "sd-server" | head -n 1)"
  cli_bin="$(find "$extracted_dir" -type f \( -name "sd" -o -name "sd-cli" \) | head -n 1)"

  if [[ -n "$server_bin" ]]; then
    cp "$server_bin" "$target"
  elif [[ -n "$cli_bin" ]]; then
    cp "$cli_bin" "$target"
  else
    print_fail "No sd-server, sd, or sd-cli binary was found in the macOS backend archive."
    return 1
  fi

  find "$extracted_dir" -type f \( -name "*.dylib" -o -name "*.metallib" \) -exec cp {} "$dest_dir/" \; 2>/dev/null || true
  chmod +x "$target" 2>/dev/null || true
}

# ════════════════════════════════════════════════════════════════════════════
print_header

if [[ "$PLATFORM" == "Linux" ]]; then
  check_glibc
fi

TOTAL_STEPS=4

# ── Step 1: Portable Node.js ────────────────────────────────────────────────
print_step 1 $TOTAL_STEPS "Setting up portable Node.js ($NODE_DIR/)"

if [[ -x "$NODE_BIN" && -x "$NPM_BIN" ]]; then
  VERSION=$("$NODE_BIN" --version)
  print_ok "Portable Node.js already ready: $VERSION"
else
  mkdir -p "$TOOLS_DIR"
  NODE_TAR_PATH="$TOOLS_DIR/$NODE_TARBALL"

  download_file "$NODE_URL" "$NODE_TAR_PATH" "Node.js v${NODE_VERSION} LTS (Portable tarball)"
  extract_tarxz "$NODE_TAR_PATH" "$TOOLS_DIR" "Node.js"
  rm -f "$NODE_TAR_PATH"

  EXTRACTED_DIR="$(find "$TOOLS_DIR" -maxdepth 1 -type d -name "node-v*-${NODE_PLATFORM_ARCH}" | head -n 1)"
  if [[ -d "$EXTRACTED_DIR" ]]; then
    rm -rf "$NODE_DIR"
    mv "$EXTRACTED_DIR" "$NODE_DIR"
  fi

  if [[ ! -x "$NODE_BIN" || ! -x "$NPM_BIN" ]]; then
    print_fail "Portable Node.js install is incomplete."
    exit 1
  fi

  VERSION=$("$NODE_BIN" --version)
  print_ok "Portable Node.js ready: $VERSION"
fi

# ── Step 2: stable-diffusion.cpp Backends ───────────────────────────────────
mkdir -p "$BACKEND_DIR"

if [[ "$PLATFORM" == "Darwin" ]]; then
  print_step 2 $TOTAL_STEPS "Setting up stable-diffusion.cpp Metal backend (app/backend/mac/)"
  if [[ "$ARCH" != "arm64" ]]; then
    print_fail "The official macOS backend binary is Apple Silicon only (arm64)."
    print_info "Intel Macs need a local source build with Metal/OpenBLAS and a matching app/backend/mac/sd binary."
    exit 1
  fi

  MAC_BACKEND="$BACKEND_DIR/sd"
  if [[ -x "$MAC_BACKEND" ]]; then
    print_ok "macOS Metal backend already ready."
  else
    MAC_ZIP="$TOOLS_DIR/sd-mac-metal.zip"
    download_file "$SD_BASE_URL/sd-master-${SD_SHORT_HASH}-bin-Darwin-macOS-15.7.7-arm64.zip" "$MAC_ZIP" "stable-diffusion.cpp Metal Backend (macOS arm64)"
    extract_zip "$MAC_ZIP" "$BACKEND_DIR/extracted" "macOS Metal Backend"
    rm -f "$MAC_ZIP"
    copy_macos_backend_from_extracted "$BACKEND_DIR/extracted" "$BACKEND_DIR"
    rm -rf "$BACKEND_DIR/extracted"
    print_ok "macOS Metal backend installed."
  fi
else
  VENDOR="$(detect_gpu_vendor)"
  print_step 2 $TOTAL_STEPS "Detecting GPU vendor: ${VENDOR:-none}"

# CPU backend (always)
CPU_BACKEND_DIR="$BACKEND_DIR/cpu"
if [[ ! -f "$CPU_BACKEND_DIR/sd-cpu" || ! -f "$CPU_BACKEND_DIR/sd-server-cpu" ]]; then
  mkdir -p "$CPU_BACKEND_DIR"
  CPU_ZIP="$TOOLS_DIR/sd-cpu.zip"
  download_file "$SD_BASE_URL/sd-master-${SD_SHORT_HASH}-bin-Linux-Ubuntu-24.04-x86_64.zip" "$CPU_ZIP" "stable-diffusion.cpp CPU Backend (Linux x86_64)"
  extract_zip "$CPU_ZIP" "$CPU_BACKEND_DIR/extracted" "CPU Backend"
  rm -f "$CPU_ZIP"
  copy_binaries_from_extracted "$CPU_BACKEND_DIR/extracted" "$CPU_BACKEND_DIR" "sd-cpu" "sd-server-cpu"
  rm -rf "$CPU_BACKEND_DIR/extracted"
  print_ok "CPU backend installed."
else
  print_ok "CPU backend already ready."
fi
chmod +x "$CPU_BACKEND_DIR/sd-cpu" "$CPU_BACKEND_DIR/sd-server-cpu" 2>/dev/null || true

# Vulkan backend (always - cross-vendor GPU fallback)
VULKAN_BACKEND_DIR="$BACKEND_DIR/vulkan"
if [[ ! -f "$VULKAN_BACKEND_DIR/sd-vulkan" || ! -f "$VULKAN_BACKEND_DIR/sd-server-vulkan" ]]; then
  mkdir -p "$VULKAN_BACKEND_DIR"
  VULKAN_ZIP="$TOOLS_DIR/sd-vulkan.zip"
  download_file "$SD_BASE_URL/sd-master-${SD_SHORT_HASH}-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip" "$VULKAN_ZIP" "stable-diffusion.cpp Vulkan Backend (Linux x86_64)"
  extract_zip "$VULKAN_ZIP" "$VULKAN_BACKEND_DIR/extracted" "Vulkan Backend"
  rm -f "$VULKAN_ZIP"
  copy_binaries_from_extracted "$VULKAN_BACKEND_DIR/extracted" "$VULKAN_BACKEND_DIR" "sd-vulkan" "sd-server-vulkan"
  rm -rf "$VULKAN_BACKEND_DIR/extracted"
  print_ok "Vulkan backend installed."
else
  print_ok "Vulkan backend already ready."
fi
chmod +x "$VULKAN_BACKEND_DIR/sd-vulkan" "$VULKAN_BACKEND_DIR/sd-server-vulkan" 2>/dev/null || true

# ROCm backend (optional --max-perf, or auto-detected AMD)
ROCM_BACKEND_DIR="$BACKEND_DIR/rocm"
if [[ $MAX_PERF -eq 1 ]] && [[ "$VENDOR" == "amd" || "$VENDOR" == "" ]]; then
  if [[ ! -f "$ROCM_BACKEND_DIR/sd-rocm" || ! -f "$ROCM_BACKEND_DIR/sd-server-rocm" ]]; then
    mkdir -p "$ROCM_BACKEND_DIR"
    ROCM_ZIP="$TOOLS_DIR/sd-rocm.zip"
    print_warn "ROCm backend is ~1.2 GB. This may take a while..."
    download_file "$SD_BASE_URL/sd-master-${SD_SHORT_HASH}-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.13.0.zip" "$ROCM_ZIP" "stable-diffusion.cpp ROCm Backend (Linux x86_64)"
    extract_zip "$ROCM_ZIP" "$ROCM_BACKEND_DIR/extracted" "ROCm Backend"
    rm -f "$ROCM_ZIP"
    copy_binaries_from_extracted "$ROCM_BACKEND_DIR/extracted" "$ROCM_BACKEND_DIR" "sd-rocm" "sd-server-rocm"
    rm -rf "$ROCM_BACKEND_DIR/extracted"
    print_ok "ROCm backend installed."
  else
    print_ok "ROCm backend already ready."
  fi
  chmod +x "$ROCM_BACKEND_DIR/sd-rocm" "$ROCM_BACKEND_DIR/sd-server-rocm" 2>/dev/null || true
fi

# CUDA backend on Linux is intentionally disabled.
# upstream leejet/stable-diffusion.cpp does not publish official Linux CUDA binaries
# (see https://github.com/leejet/stable-diffusion.cpp/issues/1291), and the only
# third-party build we evaluated (leaxer-ai/leaxer-stable-diffusion v0.1.0) loads
# models but segfaults during generation. Until a reliable Linux CUDA binary is
# available, Linux NVIDIA systems fall back to the Vulkan backend, which uses the
# same GPU via the vendor's Vulkan driver.
if [[ $MAX_PERF -eq 1 ]] && [[ "$VENDOR" == "nvidia" ]]; then
  print_info "Linux CUDA backend is disabled pending a reliable upstream binary."
  print_info "NVIDIA GPUs on Linux will use the Vulkan backend instead."
fi
fi

# ── Step 3: npm install ─────────────────────────────────────────────────────
print_step 3 $TOTAL_STEPS "Installing frontend dependencies (app/frontend/)"

if [[ ! -x "$NPM_BIN" ]]; then
  print_fail "Portable npm was not found at $NPM_BIN"
  exit 1
fi

# Ensure correct OS-specific node_modules folder is symlinked to avoid conflicts
FRONTEND_NODE_MODULES="$FRONTEND_DIR/node_modules"
if [[ "$PLATFORM" == "Darwin" ]]; then
  OS_NODE_MODULES="$FRONTEND_DIR/node_modules_mac"
  OS_LABEL="node_modules_mac"
else
  OS_NODE_MODULES="$FRONTEND_DIR/node_modules_linux"
  OS_LABEL="node_modules_linux"
fi

if [[ -d "$FRONTEND_NODE_MODULES" && ! -L "$FRONTEND_NODE_MODULES" ]]; then
  print_info "Migrating existing node_modules to $OS_LABEL..."
  mv "$FRONTEND_NODE_MODULES" "$OS_NODE_MODULES"
fi

rm -f "$FRONTEND_NODE_MODULES"
mkdir -p "$OS_NODE_MODULES"
ln -sf "$OS_LABEL" "$FRONTEND_NODE_MODULES"

cd "$FRONTEND_DIR"
export PATH="$NODE_DIR/bin:$PATH"

if "$NPM_BIN" install --prefer-offline; then
  print_ok "Dependencies installed!"
else
  print_fail "npm install failed."
  exit 1
fi

# ── Step 4: Build frontend ──────────────────────────────────────────────────
print_step 4 $TOTAL_STEPS "Building frontend -> app/dist/"

if "$NPM_BIN" run build; then
  print_ok "Frontend built!"
else
  print_fail "Frontend build failed."
  exit 1
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "  ============================================================"
if [[ "$PLATFORM" == "Darwin" ]]; then
  echo "   Setup complete! Run ./mac.sh to launch."
else
  echo "   Setup complete! Run ./linux.sh to launch."
fi
echo "  ============================================================"
echo ""

if [[ "$PLATFORM" == "Linux" && $MAX_PERF -eq 0 ]] && [[ "$VENDOR" == "nvidia" || "$VENDOR" == "amd" ]]; then
  echo "  Tip: For maximum GPU performance, re-run with:"
  echo "       ./scripts/setup.sh --max-perf"
  echo ""
fi
