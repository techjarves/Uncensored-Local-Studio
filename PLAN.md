# Linux Port Plan for Local AI Image Generator

> **Plan location**: This plan will be copied to the project root as `PLAN.md` upon approval, per user request.

> **Implementation Update (post-verification)**
>
> During end-to-end testing, the third-party Linux CUDA binary (`leaxer-ai/leaxer-stable-diffusion`) was found to **segfault during generation** after successfully loading the model. As a result, Linux CUDA support was **removed** from the implementation. Linux NVIDIA GPUs now use the **Vulkan** backend. The setup script also gained a glibc version check, because the official leejet Linux binaries require **glibc 2.38+** (Ubuntu 24.04). The frontend's misleading "mock SVG" fallback was replaced with a real error message when the backend crashes. See the updated README for build-from-source instructions.

## 1. What This Project Does

**Local AI Image Generator** is a zero-configuration, portable desktop environment for running Stable Diffusion (Safetensors / GGUF / CKPT) completely offline. The Windows flow is:

1. **Entry Point**: `start.bat` double-click launcher.
2. **Setup**: `scripts/setup.ps1` auto-downloads portable Node.js for Windows, detects the GPU vendor, downloads the matching stable-diffusion.cpp backend (CUDA for NVIDIA, Vulkan for AMD/Intel), installs npm dependencies, and builds the Vite+React frontend into `app/dist/`.
3. **Runtime**: `scripts/serve.cjs` (a Node.js HTTP server) serves the static frontend on `localhost:1420`, manages the backend process lifecycle, proxies generation requests, handles model downloads/imports, tracks telemetry, and manages the gallery.
4. **All sandboxed**: Everything lives under the project folder (`app/tools/`, `app/backend/`, `app/models/`, `app/outputs/`). No global PATH changes, no system installers.

## 2. Research Findings

### 2.1 stable-diffusion.cpp Linux Binaries

We researched the upstream project (`leejet/stable-diffusion.cpp`) and third-party builders. The following Linux x86_64 binaries are available:

| Backend | Source | Availability | Approx. Size | Notes |
|---|---|---|---|---|
| **CPU** | leejet official releases | ✅ Available | ~20–30 MB | Generic x86_64 CPU binary |
| **Vulkan** | leejet official releases | ✅ Available | ~100 MB | Cross-vendor GPU (AMD, Intel, NVIDIA) |
| **ROCm** | leejet official releases | ✅ Available | ~1.2 GB | AMD GPU; requires host ROCm kernel driver |
| **CUDA** | leejet official releases | ❌ **Not published** | N/A | See section 2.2 |
| **CUDA** | leaxer-ai/leaxer-stable-diffusion (third-party) | ❌ **Rejected** | ~115 MB | Loads models but **segfaults during generation**; removed from setup. |

**Critical Finding**: Upstream does **not** publish Linux CUDA binaries. There is an open feature request ([leejet/stable-diffusion.cpp#1291](https://github.com/leejet/stable-diffusion.cpp/issues/1291)) but no official support yet.

### 2.2 Linux CUDA Feasibility Analysis

We evaluated the third-party `leaxer-ai/leaxer-stable-diffusion` Linux CUDA binary:
- The binary downloads successfully and is a valid ELF executable.
- It loads models and initializes CUDA without errors.
- **However, it segfaults as soon as image generation starts** (reproduced on NVIDIA L4 with `TXT2IMG`).
- Because the binary is non-functional for its intended purpose, the project does **not** download or use it.

**Decision**: Linux CUDA support is **disabled** until a reliable prebuilt binary becomes available (either from upstream leejet or a verified third-party builder). Linux NVIDIA systems fall back to the **Vulkan** backend, which uses the same GPU via the NVIDIA Vulkan driver.

Users who need native CUDA performance on Linux can build `stable-diffusion.cpp` from source with `-DSD_CUDA=ON` and copy the resulting binary into `app/backend/linux/cuda/`; see README for instructions.

### 2.3 Portable Node.js for Linux
- Node.js distributes `node-v22.12.0-linux-x64.tar.xz` (matching the Windows LTS version already used).
- Fully portable: extract with `tar` and run `bin/node` / `bin/npm` directly.

### 2.4 Zero-Dependency GPU Detection on Linux
To avoid requiring `lspci`, `lshw`, or other host packages, we can parse PCI vendor IDs directly from sysfs:
- Read `/sys/bus/pci/devices/*/vendor`
- **NVIDIA**: `0x10de`
- **AMD**: `0x1002`
- **Intel**: `0x8086`
This is pure file I/O and works in any Linux environment with sysfs.

### 2.5 Extraction Strategy (No Host `unzip` Required)
- Node.js `.tar.xz` → extracted with `tar` (universally available on Linux).
- Backend `.zip` files → extracted using Node.js after bootstrapping (e.g., via `adm-zip` or a small inline script), or fall back to `python3 -m zipfile` if needed.
- NVIDIA CUDA redist `.tar.xz` → extracted with `tar`.

## 3. Implementation Approach: Maximum Performance (All Four Backends)

Based on your feedback, the recommended approach is to support **CPU + Vulkan + ROCm + CUDA** on Linux.

### 3.1 Backend Selection Matrix

| Vendor | Primary Backend | Fallback Backend | Source |
|---|---|---|---|
| NVIDIA | CUDA (best perf) | Vulkan | CUDA = leaxer third-party; Vulkan = leejet official |
| AMD | ROCm (best perf) | Vulkan | ROCm = leejet official; Vulkan = leejet official |
| Intel | Vulkan | CPU | Vulkan = leejet official |
| No GPU / Unknown | CPU | — | CPU = leejet official |

### 3.2 Backend Directory Layout (Linux)

```
app/backend/
├── win/
│   ├── cuda/sd-cuda.exe
│   └── vulkan/sd-vulkan.exe
└── linux/
    ├── cpu/sd-cpu
    ├── vulkan/sd-vulkan
    ├── rocm/sd-rocm + libstable-diffusion.so
    └── cuda/sd-cuda + libstable-diffusion.so + libcudart.so.12 + libcublas.so.12 + libcublasLt.so.12
```

## 4. Files to Create / Modify

### New Files
1. **`start.sh`** — Bash entry point equivalent to `start.bat`.
   - Checks for portable Node.js and frontend build.
   - Runs `scripts/setup.sh` if anything is missing.
   - Starts `scripts/serve.cjs` with the portable Node.js binary.
   - Opens browser (`xdg-open`) or prints URL.
   - Handles graceful shutdown (traps SIGINT/SIGTERM to kill backend).

2. **`scripts/setup.sh`** — Bash setup equivalent to `setup.ps1`.
   - Downloads portable Node.js Linux tarball with `curl` + progress bar.
   - Extracts with `tar`.
   - Detects GPU via sysfs PCI vendor IDs.
   - Downloads appropriate backends:
     - **CPU + Vulkan** for everyone (baseline).
     - **ROCm** if AMD GPU detected.
     - **CUDA** if NVIDIA GPU detected (optional, due to large download).
   - Downloads NVIDIA CUDA redist libraries if CUDA is selected.
   - Extracts all archives using `tar` / Node.js / Python fallback.
   - Renames binaries to predictable names.
   - Runs `npm install` and `npm run build` using portable npm.

3. **`scripts/reset.sh`** — Bash reset equivalent to `reset.ps1`.
   - Deletes `app/tools/`, `app/backend/`, `app/dist/`, `app/frontend/node_modules/` while preserving `app/models/` and `app/outputs/`.

### Modified Files
4. **`scripts/serve.cjs`** — Enhance Linux support.
   - **Add Linux backend paths**:
     ```js
     linuxCpu:    path.join(ROOT, "app", "backend", "linux", "cpu",    "sd-cpu"),
     linuxVulkan: path.join(ROOT, "app", "backend", "linux", "vulkan", "sd-vulkan"),
     linuxRocm:   path.join(ROOT, "app", "backend", "linux", "rocm",   "sd-rocm"),
     linuxCuda:   path.join(ROOT, "app", "backend", "linux", "cuda",   "sd-cuda"),
     ```
   - **Add Linux GPU detection** via sysfs (`/sys/bus/pci/devices/*/vendor`).
   - **Update `getBackendOptions()`**: For Linux, return `cpu`, `vulkan`, `rocm` (if binary exists), and `cuda` (if binary + libraries exist).
   - **Update `selectBackendPath()`**: Choose Linux backend based on resolved type; set `LD_LIBRARY_PATH` for CUDA/ROCm subprocesses so they find bundled `.so` files.
   - **Update `getHealth()` / `getSetupPaths()`**: Include Linux backend checks.
   - **Update `getGpuInfo()` / `hasNvidiaGpu()`**: Add Linux sysfs parsing.
   - **CUDA VRAM polling**: Keep existing `nvidia-smi` approach; on Linux it works if drivers are installed.

5. **`README.md`** — Add Linux section with compatibility matrix, `./start.sh` usage, and known limitations.

## 5. Download Sources

| Component | URL Pattern |
|---|---|
| Portable Node.js | `https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz` |
| CPU Backend | `https://github.com/leejet/stable-diffusion.cpp/releases/download/master-XXX/sd-master-XXX-bin-Linux-Ubuntu-24.04-x86_64.zip` |
| Vulkan Backend | `https://github.com/leejet/stable-diffusion.cpp/releases/download/master-XXX/sd-master-XXX-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip` |
| ROCm Backend | `https://github.com/leejet/stable-diffusion.cpp/releases/download/master-XXX/sd-master-XXX-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.13.0.zip` |
| CUDA Binary (third-party) | `https://github.com/leaxer-ai/leaxer-stable-diffusion/releases/download/v0.1.0/sd-x86_64-unknown-linux-gnu-cuda` |
| CUDA Server (third-party) | `https://github.com/leaxer-ai/leaxer-stable-diffusion/releases/download/v0.1.0/sd-server-x86_64-unknown-linux-gnu-cuda` |
| CUDA Runtime (NVIDIA redist) | `https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/linux-x86_64/cuda_cudart-linux-x86_64-12.X.YZ-archive.tar.xz` |
| cuBLAS (NVIDIA redist) | `https://developer.download.nvidia.com/compute/cuda/redist/libcublas/linux-x86_64/libcublas-linux-x86_64-12.X.YZ-archive.tar.xz` |

## 6. Setup Modes

To respect users with limited bandwidth or no NVIDIA hardware, `setup.sh` should support two modes:

1. **Quick Setup (default)** — Downloads CPU + Vulkan only.
   - Works on all Linux systems.
   - NVIDIA users get Vulkan acceleration (good, but not best).
   - ~120–150 MB total download.

2. **Maximum Performance Setup** — Downloads CPU + Vulkan + ROCm + CUDA.
   - Best performance for each vendor.
   - ~1.5 GB total download (mostly ROCm + cuBLAS).
   - User can opt-in via `./start.sh --max-perf` or `./scripts/setup.sh --max-perf`.

## 7. Self-Contained Checklist

| Host Dependency | How We Eliminate It |
|---|---|
| Node.js installed globally | Download portable `node-v22.12.0-linux-x64.tar.xz` into `app/tools/node-linux/` |
| npm installed globally | Use portable npm from the tarball |
| `unzip` command | Extract ZIPs using Node.js or Python `zipfile` |
| `lspci` / `lshw` | Parse `/sys/bus/pci/devices/*/vendor` directly |
| C++ compiler / CUDA toolkit | Use pre-built binaries only |
| System package manager (apt/yum) | Never used |
| CUDA runtime libs | Bundle NVIDIA redistributable `.so` files |

**One unavoidable host dependency remains**: the NVIDIA kernel driver (`libcuda.so.1`) for CUDA mode. Without it, CUDA cannot run. The app will detect this and automatically fall back to Vulkan for NVIDIA.

## 8. Known Limitations

1. **Third-party CUDA binary**: The Linux CUDA build comes from `leaxer-ai/leaxer-stable-diffusion`, which has only one release (v0.1.0) and may become stale. We should pin to a specific version and periodically evaluate alternatives.
2. **Large ROCm download**: The official ROCm backend ZIP is ~1.2 GB, which is a significant one-time download.
3. **Large cuBLAS download**: NVIDIA's redistributable cuBLAS package is ~400–500 MB.
4. **NVIDIA driver requirement for CUDA**: `libcuda.so.1` must be present on the host (provided by the NVIDIA proprietary driver). If missing, CUDA mode falls back to Vulkan.
5. **ROCm host driver requirement**: ROCm requires a compatible AMD GPU and ROCm kernel driver. If unavailable, ROCm falls back to Vulkan.
6. **glibc compatibility**: Official Linux binaries are built on Ubuntu 24.04. They may fail on very old distributions (e.g., CentOS 7, Ubuntu 18.04) due to glibc version mismatches.

## 9. Recommended Implementation Order

1. Create `start.sh`, `scripts/setup.sh`, and `scripts/reset.sh` with CPU + Vulkan support first.
2. Update `scripts/serve.cjs` with Linux paths, sysfs GPU detection, and backend selection.
3. Add ROCm download path (behind `--max-perf` flag).
4. Add CUDA download path using leaxer binary + NVIDIA redist libraries (behind `--max-perf` flag).
5. Add fallback logic so that if ROCm/CUDA fails to initialize, the app automatically switches to Vulkan.
6. Update `README.md` with Linux instructions and performance notes.
7. Test on Linux machines with NVIDIA (CUDA/Vulkan), AMD (ROCm/Vulkan), Intel (Vulkan), and CPU-only configurations.
