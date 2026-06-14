#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$ROOT_DIR/app/tools/video-runtime"
UV_DIR="$RUNTIME_DIR/uv"
UV_BIN="$UV_DIR/uv"
VENV_DIR="$RUNTIME_DIR/venv"
PYTHON_BIN="$VENV_DIR/bin/python"
UV_VERSION="0.11.21"
ARCHIVE="$RUNTIME_DIR/uv.tar.gz"
EXTRACT_DIR="$RUNTIME_DIR/uv-extract"

mkdir -p "$RUNTIME_DIR" "$UV_DIR"
export UV_PYTHON_INSTALL_DIR="$RUNTIME_DIR/python"
export UV_CACHE_DIR="$RUNTIME_DIR/cache"

echo '{"type":"runtime-progress","phase":"Preparing portable video runtime","progress":5}'

if [[ ! -x "$UV_BIN" ]]; then
  curl -fL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" -o "$ARCHIVE"
  rm -rf "$EXTRACT_DIR"
  mkdir -p "$EXTRACT_DIR"
  tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"
  FOUND="$(find "$EXTRACT_DIR" -type f -name uv -print -quit)"
  [[ -n "$FOUND" ]] || { echo "uv binary was not found in the downloaded archive." >&2; exit 1; }
  cp "$FOUND" "$UV_BIN"
  chmod +x "$UV_BIN"
  rm -rf "$ARCHIVE" "$EXTRACT_DIR"
fi

echo '{"type":"runtime-progress","phase":"Installing managed Python 3.11","progress":20}'
"$UV_BIN" python install 3.11 --no-bin

echo '{"type":"runtime-progress","phase":"Creating isolated environment","progress":35}'
if [[ -x "$PYTHON_BIN" ]]; then
  "$UV_BIN" venv --python 3.11 --allow-existing "$VENV_DIR"
else
  "$UV_BIN" venv --python 3.11 "$VENV_DIR"
fi

echo '{"type":"runtime-progress","phase":"Installing CUDA PyTorch","progress":50}'
"$UV_BIN" pip install --python "$PYTHON_BIN" --index-url "https://download.pytorch.org/whl/cu126" "torch==2.7.1+cu126" "torchvision==0.22.1+cu126"

echo '{"type":"runtime-progress","phase":"Installing video generation libraries","progress":72}'
"$UV_BIN" pip install --python "$PYTHON_BIN" --requirement "$SCRIPT_DIR/video-requirements.txt"

echo '{"type":"runtime-progress","phase":"Validating CUDA runtime","progress":92}'
"$PYTHON_BIN" -c "import torch, diffusers, transformers, imageio_ffmpeg; assert torch.cuda.is_available(), 'CUDA is not available to PyTorch'; print(torch.__version__)"

cat > "$RUNTIME_DIR/runtime.json" <<EOF
{"installedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","python":"3.11","torch":"2.7.1+cu126","diffusers":"0.38.0","uv":"$UV_VERSION"}
EOF
echo '{"type":"runtime-progress","phase":"Video runtime ready","progress":100}'
