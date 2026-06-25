#!/usr/bin/env bash
#
# Uncensored AI Studio - Linux/macOS Setup Script
# Self-contained: no apt/yum/pacman, no global Node.js install.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
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

# Check if filesystem supports symlinks
USE_SYMLINKS=true
TEST_LINK="$ROOT_DIR/.test_symlink"
rm -f "$TEST_LINK"
if ln -s "test" "$TEST_LINK" 2>/dev/null; then
  rm -f "$TEST_LINK"
else
  USE_SYMLINKS=false
fi

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
  echo ""
  echo "  ============================================================"
  echo "   UNCENSORED AI STUDIO      -  $PLATFORM_LABEL First-Time Setup"
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
  if [ "$USE_SYMLINKS" = false ]; then
    # On filesystems that do not support symlinks, tar will fail when attempting to create symlinks
    # (e.g. for npm/npx/corepack in Node.js bin/). We allow it to continue but verify key files.
    local tar_exit=0
    tar -xf "$tar_path" -C "$dest" || tar_exit=$?
    if [[ $tar_exit -ne 0 ]]; then
      # Check if node binary was extracted successfully
      local check_file
      check_file="$(find "$dest" -type f -name "node" | head -n 1)"
      if [[ -n "$check_file" ]]; then
        print_warn "tar returned exit code $tar_exit due to symlink failures on this filesystem, but bin/node was successfully extracted."
      else
        print_fail "tar extraction failed with exit code $tar_exit (could not find bin/node)"
        exit $tar_exit
      fi
    fi
  else
    tar -xf "$tar_path" -C "$dest"
  fi
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

# Official Linux binaries are built on Ubuntu 24.04 and link against glibc 2.38+
# plus libstdc++ with GLIBCXX_3.4.32+. Stop early on older distributions so
# setup does not appear successful when the backend cannot start.
version_at_least() {
  local current="$1" required="$2"
  [[ "$(printf '%s\n' "$required" "$current" | sort -V | head -n1)" == "$required" ]]
}

detect_glibcxx_version() {
  local libstdcpp=""
  if command -v ldconfig >/dev/null 2>&1; then
    libstdcpp="$(ldconfig -p 2>/dev/null | awk '/libstdc\+\+\.so\.6/{print $NF; exit}')"
  fi
  if [[ -z "$libstdcpp" ]]; then
    for candidate in /usr/lib/x86_64-linux-gnu/libstdc++.so.6 /usr/lib64/libstdc++.so.6 /lib/x86_64-linux-gnu/libstdc++.so.6; do
      if [[ -f "$candidate" ]]; then
        libstdcpp="$candidate"
        break
      fi
    done
  fi
  if [[ -n "$libstdcpp" && -f "$libstdcpp" ]] && command -v strings >/dev/null 2>&1; then
    strings "$libstdcpp" 2>/dev/null | grep -oE 'GLIBCXX_[0-9]+\.[0-9]+\.[0-9]+' | sed 's/GLIBCXX_//' | sort -V | tail -n1
  fi
}

check_linux_runtime_abi() {
  local required_glibc="2.38"
  local required_glibcxx="3.4.32"
  local current_glibc=""
  local current_glibcxx=""
  local unsupported=0

  if command -v ldd >/dev/null 2>&1; then
    current_glibc="$(ldd --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+' | head -n1 || true)"
  fi
  current_glibcxx="$(detect_glibcxx_version || true)"

  if [[ -z "$current_glibc" ]]; then
    print_warn "Could not detect glibc version. Prebuilt Linux backends require glibc $required_glibc+ (Ubuntu 24.04)."
  elif ! version_at_least "$current_glibc" "$required_glibc"; then
    print_fail "Detected glibc $current_glibc. Prebuilt Linux backends require glibc $required_glibc+ (Ubuntu 24.04 or newer)."
    unsupported=1
  fi

  if [[ -z "$current_glibcxx" ]]; then
    print_warn "Could not detect GLIBCXX version. Prebuilt Linux backends require GLIBCXX_$required_glibcxx+."
  elif ! version_at_least "$current_glibcxx" "$required_glibcxx"; then
    print_fail "Detected GLIBCXX_$current_glibcxx. Prebuilt Linux backends require GLIBCXX_$required_glibcxx+."
    unsupported=1
  fi

  if [[ $unsupported -ne 0 ]]; then
    print_info "CyberRealistic and other valid models will fail before loading on this OS because the backend binary cannot start."
    print_info "Fix: use Ubuntu 24.04+, Fedora 40+, another glibc 2.38+ distro, or build stable-diffusion.cpp from source on this machine."
    if [[ "${UAIS_ALLOW_UNSUPPORTED_LINUX:-0}" == "1" ]]; then
      print_warn "Continuing anyway because UAIS_ALLOW_UNSUPPORTED_LINUX=1 is set."
      return 0
    fi
    return 1
  fi

  print_ok "Linux runtime ABI ready: glibc $current_glibc, GLIBCXX_$current_glibcxx"
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
  if ! check_linux_runtime_abi; then
    print_fail "Linux setup stopped before downloading incompatible backend binaries."
    exit 1
  fi
fi

TOTAL_STEPS=7

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

  if [ "$USE_SYMLINKS" = false ]; then
    print_info "Filesystem does not support symlinks. Creating shell wrappers for npm, npx, and corepack..."
    rm -f "$NODE_DIR/bin/npm" "$NODE_DIR/bin/npx" "$NODE_DIR/bin/corepack"
    
    cat << 'EOF' > "$NODE_DIR/bin/npm"
#!/bin/sh
basedir=$(dirname "$0")
exec "$basedir/node" "$basedir/../lib/node_modules/npm/bin/npm-cli.js" "$@"
EOF
    chmod +x "$NODE_DIR/bin/npm"

    cat << 'EOF' > "$NODE_DIR/bin/npx"
#!/bin/sh
basedir=$(dirname "$0")
exec "$basedir/node" "$basedir/../lib/node_modules/npm/bin/npx-cli.js" "$@"
EOF
    chmod +x "$NODE_DIR/bin/npx"

    cat << 'EOF' > "$NODE_DIR/bin/corepack"
#!/bin/sh
basedir=$(dirname "$0")
exec "$basedir/node" "$basedir/../lib/node_modules/corepack/dist/corepack.js" "$@"
EOF
    chmod +x "$NODE_DIR/bin/corepack"
    
    print_ok "Created shell wrappers."
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
    print_info "macOS Intel hardware is completely unsupported and has not been tested."
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

  # CoreML NPU Environment setup (macOS Apple Silicon only)
  print_info "Setting up CoreML Python virtual environment for Apple Silicon ANE (NPU)..."
  VENV_DIR="$BACKEND_DIR/coreml_venv"
  PYTHON_BIN="$VENV_DIR/bin/python"
  
  if [[ ! -x "$PYTHON_BIN" ]]; then
    print_info "Creating Python virtual environment at $VENV_DIR..."
    if ! python3 -m venv "$VENV_DIR"; then
      print_warn "Could not create the virtual environment for CoreML. CoreML NPU mode will be unavailable."
    fi
  fi
  
  if [[ -x "$PYTHON_BIN" ]]; then
    print_info "Installing CoreML dependencies (this may take a couple of minutes)..."
    if "$PYTHON_BIN" -m pip install --upgrade pip >/dev/null 2>&1 && \
       "$PYTHON_BIN" -m pip install numpy coremltools diffusers transformers huggingface-hub pillow >/dev/null 2>&1 && \
       "$PYTHON_BIN" -m pip install "git+https://github.com/apple/ml-stable-diffusion.git" >/dev/null 2>&1; then
      print_ok "CoreML ANE (NPU) environment ready."
    else
      print_warn "CoreML dependencies installation failed. CoreML NPU mode will be unavailable."
    fi
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

# CUDA backend on Linux: ask user, download prebuilt first, and compile from source as a fallback.
CUDA_BACKEND_DIR="$BACKEND_DIR/cuda"
if [[ "$VENDOR" == "nvidia" ]]; then
  if [[ ! -f "$CUDA_BACKEND_DIR/sd-cuda" || ! -f "$CUDA_BACKEND_DIR/sd-server-cuda" ]]; then
    echo ""
    echo "  ============================================================"
    echo "   NVIDIA GPU Detected"
    echo "  ============================================================"
    echo "   To get the best performance, you can use the CUDA backend."
    echo "   Setting this up can download a prebuilt binary or compile from"
    echo "   source (which takes 10-15 minutes)."
    echo ""
    echo "   Alternatively, you can use the Vulkan backend which is already"
    echo "   installed and runs immediately (recommended for GTX cards)."
    echo "  ============================================================"
    echo ""
    
    CHOOSE_CUDA="n"
    if [[ -t 0 ]]; then
      read -t 30 -rp "   Do you want to proceed with CUDA setup? [y/N]: " CHOOSE_CUDA || CHOOSE_CUDA="n"
    else
      print_info "Non-interactive environment detected; defaulting to Vulkan."
    fi
    
    if [[ "$CHOOSE_CUDA" =~ ^[Yy]$ ]]; then
      TRY_DOWNLOAD=1
      PREBUILT_URL="https://github.com/leaxer-ai/leaxer-stable-diffusion/releases/download/v0.1.0/sd-server-x86_64-unknown-linux-gnu-cuda"
      PREBUILT_CLI_URL="https://github.com/leaxer-ai/leaxer-stable-diffusion/releases/download/v0.1.0/sd-x86_64-unknown-linux-gnu-cuda"
      
      mkdir -p "$CUDA_BACKEND_DIR"
      
      print_info "Attempting to download prebuilt CUDA binary..."
      if download_file "$PREBUILT_URL" "$CUDA_BACKEND_DIR/sd-server-cuda" "Prebuilt Linux CUDA Server" && \
         download_file "$PREBUILT_CLI_URL" "$CUDA_BACKEND_DIR/sd-cuda" "Prebuilt Linux CUDA CLI"; then
        
        chmod +x "$CUDA_BACKEND_DIR/sd-server-cuda" "$CUDA_BACKEND_DIR/sd-cuda" 2>/dev/null || true
        
        print_info "Testing downloaded prebuilt CUDA binary..."
        if "$CUDA_BACKEND_DIR/sd-server-cuda" --help >/dev/null 2>&1; then
          print_ok "Prebuilt CUDA binary verified and works! Skipping compilation."
          TRY_DOWNLOAD=0
        else
          print_warn "Prebuilt CUDA binary failed verification test (missing libraries or library mismatch)."
          rm -f "$CUDA_BACKEND_DIR/sd-server-cuda" "$CUDA_BACKEND_DIR/sd-cuda"
        fi
      else
        print_warn "Failed to download prebuilt CUDA binary."
        rm -f "$CUDA_BACKEND_DIR/sd-server-cuda" "$CUDA_BACKEND_DIR/sd-cuda"
      fi
      
      if [[ $TRY_DOWNLOAD -eq 1 ]]; then
        if command -v nvcc >/dev/null 2>&1 && command -v cmake >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
          print_info "NVIDIA GPU and CUDA compilation tools (nvcc, cmake, git) detected."
          print_info "Building CUDA backend from source..."
          
          BUILD_DIR="$TOOLS_DIR/build-sd"
          JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
          
          if [[ ! -d "$BUILD_DIR" ]]; then
            print_info "Cloning stable-diffusion.cpp..."
            git clone https://github.com/leejet/stable-diffusion.cpp.git "$BUILD_DIR"
          fi
          
          PUSHED_DIR="$(pwd)"
          cd "$BUILD_DIR"
          
          print_info "Checking out pinned tag $SD_RELEASE..."
          git fetch origin
          git checkout -f "$SD_RELEASE"
          git submodule update --init --recursive
          
          rm -rf build-cuda && mkdir build-cuda && cd build-cuda
          
          print_info "Running cmake for CUDA backend..."
          if cmake .. -DSD_CUDA=ON -DSD_BUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA_FORCE_MMQ=ON && \
             cmake --build . --config Release -j"$JOBS"; then
            
            mkdir -p "$CUDA_BACKEND_DIR"
            if [[ -f bin/sd-server ]]; then
              cp bin/sd-server "$CUDA_BACKEND_DIR/sd-cuda"
              cp bin/sd-server "$CUDA_BACKEND_DIR/sd-server-cuda"
            else
              print_fail "CUDA build succeeded but bin/sd-server was not found."
              cd "$PUSHED_DIR"
              exit 1
            fi
            
            if [[ -f bin/sd ]]; then
              cp bin/sd "$CUDA_BACKEND_DIR/sd-cli-cuda"
            elif [[ -f bin/sd-cli ]]; then
              cp bin/sd-cli "$CUDA_BACKEND_DIR/sd-cli-cuda"
            fi
            
            SO_PATH_CUDA=$(find . -name "libstable-diffusion.so" | head -n 1)
            if [[ -n "$SO_PATH_CUDA" ]]; then
              cp "$SO_PATH_CUDA" "$CUDA_BACKEND_DIR/"
            fi
            
            chmod +x "$CUDA_BACKEND_DIR/sd-cuda" "$CUDA_BACKEND_DIR/sd-server-cuda" 2>/dev/null || true
            if [[ -f "$CUDA_BACKEND_DIR/sd-cli-cuda" ]]; then
              chmod +x "$CUDA_BACKEND_DIR/sd-cli-cuda" 2>/dev/null || true
            fi
            print_ok "CUDA backend compiled and installed successfully from source."
          else
            print_warn "CUDA backend build from source failed. Falling back to Vulkan."
          fi
          cd "$PUSHED_DIR"
        else
          print_warn "CUDA compilation tools (nvcc, cmake, and/or git) are missing."
          print_info "To compile the CUDA backend, install the NVIDIA CUDA Toolkit, cmake, and git."
          print_info "Falling back to Vulkan."
        fi
      fi
    else
      print_info "Declined CUDA setup. Using Vulkan GPU backend instead."
    fi
  else
    print_ok "CUDA backend already ready."
  fi
fi
fi

# ── Step 3: npm install ─────────────────────────────────────────────────────
print_step 3 $TOTAL_STEPS "Setting up llama.cpp text backend"
bash "$SCRIPT_DIR/setup-llama.sh"

print_step 4 $TOTAL_STEPS "Setting up whisper.cpp speech backend"
bash "$SCRIPT_DIR/setup-whisper.sh"

print_step 5 $TOTAL_STEPS "Setting up Kokoro ONNX text-to-speech runtime"
bash "$SCRIPT_DIR/setup-tts.sh"

print_step 6 $TOTAL_STEPS "Installing frontend dependencies (app/frontend/)"

if [[ ! -x "$NPM_BIN" ]]; then
  print_fail "Portable npm was not found at $NPM_BIN"
  exit 1
fi

# Ensure correct OS-specific node_modules folder is symlinked or swapped to avoid conflicts
FRONTEND_NODE_MODULES="$FRONTEND_DIR/node_modules"
ACTIVE_OS_FILE="$FRONTEND_DIR/.active_modules_os"

if [[ "$PLATFORM" == "Darwin" ]]; then
  OS_NODE_MODULES="$FRONTEND_DIR/node_modules_mac"
  OS_LABEL="node_modules_mac"
  CURRENT_OS="mac"
else
  OS_NODE_MODULES="$FRONTEND_DIR/node_modules_linux"
  OS_LABEL="node_modules_linux"
  CURRENT_OS="linux"
fi

# Attempt to create a test symlink to check if filesystem supports symlinks
USE_SYMLINKS=true
TEST_LINK="$FRONTEND_DIR/.test_symlink"
rm -f "$TEST_LINK"
if ln -s "$OS_LABEL" "$TEST_LINK" 2>/dev/null; then
  rm -f "$TEST_LINK"
else
  USE_SYMLINKS=false
fi

if [ "$USE_SYMLINKS" = true ]; then
  if [[ -d "$FRONTEND_NODE_MODULES" && ! -L "$FRONTEND_NODE_MODULES" ]]; then
    print_info "Migrating existing node_modules to $OS_LABEL..."
    if [[ -d "$OS_NODE_MODULES" ]]; then
      rm -rf "$FRONTEND_NODE_MODULES"
    else
      mv "$FRONTEND_NODE_MODULES" "$OS_NODE_MODULES"
    fi
  fi
  rm -rf "$FRONTEND_NODE_MODULES"
  mkdir -p "$OS_NODE_MODULES"
  ln -sf "$OS_LABEL" "$FRONTEND_NODE_MODULES"
else
  # Fallback: Filesystem does not support symlinks (e.g. FAT32/exFAT)
  print_info "Filesystem does not support symlinks. Using directory swapping fallback..."
  
  if [[ -L "$FRONTEND_NODE_MODULES" || -f "$FRONTEND_NODE_MODULES" ]]; then
    rm -rf "$FRONTEND_NODE_MODULES"
  fi
  
  PREV_OS=""
  if [[ -f "$ACTIVE_OS_FILE" ]]; then
    PREV_OS=$(cat "$ACTIVE_OS_FILE")
  fi
  
  if [[ -d "$FRONTEND_NODE_MODULES" && "$PREV_OS" != "$CURRENT_OS" ]]; then
    if [[ -n "$PREV_OS" ]]; then
      print_info "Swapping out node_modules to node_modules_$PREV_OS..."
      rm -rf "$FRONTEND_DIR/node_modules_$PREV_OS"
      mv "$FRONTEND_NODE_MODULES" "$FRONTEND_DIR/node_modules_$PREV_OS"
    else
      print_info "Saving node_modules as node_modules_windows..."
      rm -rf "$FRONTEND_DIR/node_modules_windows"
      mv "$FRONTEND_NODE_MODULES" "$FRONTEND_DIR/node_modules_windows"
    fi
  fi
  
  if [[ -d "$OS_NODE_MODULES" && ! -d "$FRONTEND_NODE_MODULES" ]]; then
    print_info "Swapping in $OS_LABEL..."
    mv "$OS_NODE_MODULES" "$FRONTEND_NODE_MODULES"
  elif [[ ! -d "$FRONTEND_NODE_MODULES" ]]; then
    mkdir -p "$FRONTEND_NODE_MODULES"
  fi
  
  echo "$CURRENT_OS" > "$ACTIVE_OS_FILE"
fi

cd "$FRONTEND_DIR"
export PATH="$NODE_DIR/bin:$PATH"

if [ "$USE_SYMLINKS" = false ]; then
  if "$NPM_BIN" install --prefer-offline --no-bin-links; then
    print_ok "Dependencies installed!"
  else
    print_fail "npm install failed."
    exit 1
  fi
else
  if "$NPM_BIN" install --prefer-offline; then
    print_ok "Dependencies installed!"
  else
    print_fail "npm install failed."
    exit 1
  fi
fi

# ── Step 4: Build frontend ──────────────────────────────────────────────────
print_step 7 $TOTAL_STEPS "Building frontend -> app/dist/"

if [ "$USE_SYMLINKS" = false ]; then
  # If symlinks are disabled, run vite directly using the local node executable.
  if "$NODE_BIN" node_modules/vite/bin/vite.js build; then
    print_ok "Frontend built!"
  else
    print_fail "Frontend build failed."
    exit 1
  fi
else
  if "$NPM_BIN" run build; then
    print_ok "Frontend built!"
  else
    print_fail "Frontend build failed."
    exit 1
  fi
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
  echo "       ./scripts/setup/setup.sh --max-perf"
  echo ""
fi
