#!/usr/bin/env bash
#
# Local AI Image Generator - Compile backends from source
# For Linux systems with GLIBC < 2.38 or macOS systems that need a local Metal build.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$ROOT_DIR/app"
PLATFORM="$(uname -s)"
if [ "$PLATFORM" = "Darwin" ]; then
    BACKEND_DIR="$APP_DIR/backend/mac"
else
    BACKEND_DIR="$APP_DIR/backend/linux"
fi
BUILD_DIR="$APP_DIR/tools/build-sd"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

# Pinned release tag
PINNED_TAG="master-685-19bdfe2"

echo "=== Local AI Image Generator - Build from Source ==="
echo "Target directories:"
echo "  CPU Backend   -> $BACKEND_DIR/cpu"
echo "  Vulkan Backend -> $BACKEND_DIR/vulkan"
echo ""

# 1. Clone stable-diffusion.cpp
if [ ! -d "$BUILD_DIR" ]; then
    echo "Cloning stable-diffusion.cpp..."
    git clone https://github.com/leejet/stable-diffusion.cpp.git "$BUILD_DIR"
else
    echo "Using existing stable-diffusion.cpp directory."
fi

cd "$BUILD_DIR"
echo "Checking out pinned tag $PINNED_TAG..."
git fetch origin
git checkout -f "$PINNED_TAG"
git submodule update --init --recursive

if [ "$PLATFORM" = "Darwin" ]; then
    echo ""
    echo "=== Building macOS Metal Backend ==="
    rm -rf build-metal && mkdir build-metal && cd build-metal
    cmake .. -DSD_METAL=ON -DSD_BUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release
    cmake --build . --config Release -j"$JOBS"

    echo "Copying macOS Metal backend..."
    mkdir -p "$BACKEND_DIR"
    if [ -f bin/sd-server ]; then
        cp bin/sd-server "$BACKEND_DIR/sd"
    elif [ -f bin/sd ]; then
        cp bin/sd "$BACKEND_DIR/sd"
    else
        echo "ERROR: bin/sd-server or bin/sd was not found!"
        exit 1
    fi
    find . -name "*.dylib" -exec cp {} "$BACKEND_DIR/" \; 2>/dev/null || true
    chmod +x "$BACKEND_DIR/sd"
    echo ""
    echo "=== macOS Metal build completed successfully! ==="
    exit 0
fi

# 2. Build CPU Backend
echo ""
echo "=== Building CPU Backend ==="
rm -rf build-cpu && mkdir build-cpu && cd build-cpu
cmake .. -DSD_BUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release
cmake --build . --config Release -j"$JOBS"

echo "Copying CPU binaries..."
mkdir -p "$BACKEND_DIR/cpu"
if [ -f bin/sd-server ]; then
    cp bin/sd-server "$BACKEND_DIR/cpu/sd-cpu"
    cp bin/sd-server "$BACKEND_DIR/cpu/sd-server-cpu"
else
    echo "ERROR: bin/sd-server was not found!"
    exit 1
fi
if [ -f bin/sd ]; then
    cp bin/sd "$BACKEND_DIR/cpu/sd-cli-cpu"
elif [ -f bin/sd-cli ]; then
    cp bin/sd-cli "$BACKEND_DIR/cpu/sd-cli-cpu"
fi
# Find and copy libstable-diffusion.so (might be in bin/ or in build root)
SO_PATH=$(find . -name "libstable-diffusion.so" | head -n 1)
if [ -n "$SO_PATH" ]; then
    cp "$SO_PATH" "$BACKEND_DIR/cpu/"
    echo "Copied libstable-diffusion.so to CPU directory."
    chmod +x "$BACKEND_DIR/cpu/sd-cpu" "$BACKEND_DIR/cpu/sd-server-cpu" 2>/dev/null || true
    if [ -f "$BACKEND_DIR/cpu/sd-cli-cpu" ]; then
        chmod +x "$BACKEND_DIR/cpu/sd-cli-cpu" 2>/dev/null || true
    fi
else
    echo "WARNING: libstable-diffusion.so not found for CPU build!"
fi

# 3. Build Vulkan Backend
cd "$BUILD_DIR"
echo ""
echo "=== Building Vulkan Backend ==="
if rm -rf build-vulkan && mkdir build-vulkan && cd build-vulkan && \
   cmake .. -DSD_VULKAN=ON -DSD_BUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release && \
   cmake --build . --config Release -j"$JOBS"; then

    echo "Copying Vulkan binaries..."
    mkdir -p "$BACKEND_DIR/vulkan"
    if [ -f bin/sd-server ]; then
        cp bin/sd-server "$BACKEND_DIR/vulkan/sd-vulkan"
        cp bin/sd-server "$BACKEND_DIR/vulkan/sd-server-vulkan"
    else
        echo "ERROR: bin/sd-server was not found!"
        exit 1
    fi
    if [ -f bin/sd ]; then
        cp bin/sd "$BACKEND_DIR/vulkan/sd-cli-vulkan"
    elif [ -f bin/sd-cli ]; then
        cp bin/sd-cli "$BACKEND_DIR/vulkan/sd-cli-vulkan"
    fi
    SO_PATH_VK=$(find . -name "libstable-diffusion.so" | head -n 1)
    if [ -n "$SO_PATH_VK" ]; then
        cp "$SO_PATH_VK" "$BACKEND_DIR/vulkan/"
        echo "Copied libstable-diffusion.so to Vulkan directory."
    else
        echo "WARNING: libstable-diffusion.so not found for Vulkan build!"
    fi
    chmod +x "$BACKEND_DIR/vulkan/sd-vulkan" "$BACKEND_DIR/vulkan/sd-server-vulkan" 2>/dev/null || true
    if [ -f "$BACKEND_DIR/vulkan/sd-cli-vulkan" ]; then
        chmod +x "$BACKEND_DIR/vulkan/sd-cli-vulkan" 2>/dev/null || true
    fi
else
    echo "WARNING: Vulkan backend build failed. Bypassing Vulkan backend compilation..."
fi
cd "$BUILD_DIR"
echo ""
echo "=== Building CUDA Backend ==="
rm -rf build-cuda && mkdir build-cuda && cd build-cuda
cmake .. -DSD_CUDA=ON -DSD_BUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release
cmake --build . --config Release -j"$JOBS"

echo "Copying CUDA binaries..."
mkdir -p "$BACKEND_DIR/cuda"
if [ -f bin/sd-server ]; then
    cp bin/sd-server "$BACKEND_DIR/cuda/sd-cuda"
    cp bin/sd-server "$BACKEND_DIR/cuda/sd-server-cuda"
else
    echo "ERROR: bin/sd-server was not found!"
    exit 1
fi
if [ -f bin/sd ]; then
    cp bin/sd "$BACKEND_DIR/cuda/sd-cli-cuda"
elif [ -f bin/sd-cli ]; then
    cp bin/sd-cli "$BACKEND_DIR/cuda/sd-cli-cuda"
fi
SO_PATH_CUDA=$(find . -name "libstable-diffusion.so" | head -n 1)
if [ -n "$SO_PATH_CUDA" ]; then
    cp "$SO_PATH_CUDA" "$BACKEND_DIR/cuda/"
    echo "Copied libstable-diffusion.so to CUDA directory."
    chmod +x "$BACKEND_DIR/cuda/sd-cuda" "$BACKEND_DIR/cuda/sd-server-cuda" 2>/dev/null || true
    if [ -f "$BACKEND_DIR/cuda/sd-cli-cuda" ]; then
        chmod +x "$BACKEND_DIR/cuda/sd-cli-cuda" 2>/dev/null || true
    fi
else
    echo "WARNING: libstable-diffusion.so not found for CUDA build!"
fi

echo ""
echo "=== Build from source completed successfully! ==="
