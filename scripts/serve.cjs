// serve.cjs — portable static file server + backend process manager
// Serves app/dist/, manages sd-vulkan.exe lifecycle with correct CLI flags
// serve.cjs — portable static file server + backend process manager
// Serves app/dist/, manages sd-vulkan.exe lifecycle with correct CLI flags

const http     = require("http");
const https    = require("https");
const fs       = require("fs");
const net      = require("net");
const os       = require("os");
const path     = require("path");
const { spawn, spawnSync, execSync, exec } = require("child_process");

const HF_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const hfModelCache = new Map();

function readPort(value, fallback) {
  const port = parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

const PORT_FRONTEND = readPort(process.env.PORT || process.env.FRONTEND_PORT, 1420);
const PREFERRED_BACKEND_PORT = readPort(process.env.BACKEND_PORT || process.env.SD_BACKEND_PORT, 8080);
const PREFERRED_LLM_PORT = readPort(process.env.LLM_PORT, 10086);
let PORT_BACKEND = PREFERRED_BACKEND_PORT;
let PORT_LLM = PREFERRED_LLM_PORT;
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;
const SERVER_BUILD = "text-image-v1";
const ROOT    = path.join(__dirname, "..");
const DIST    = path.join(ROOT, "app", "dist");
const osPlatform = process.platform;
const BACKEND_PATHS = {
  cuda: path.join(ROOT, "app", "backend", "win", "cuda", "sd-cuda.exe"),
  vulkan: path.join(ROOT, "app", "backend", "win", "vulkan", "sd-vulkan.exe"),
  mac: path.join(ROOT, "app", "backend", "mac", "sd"),
  linuxCpu: path.join(ROOT, "app", "backend", "linux", "cpu", "sd-server-cpu"),
  linuxVulkan: path.join(ROOT, "app", "backend", "linux", "vulkan", "sd-server-vulkan"),
  linuxRocm: path.join(ROOT, "app", "backend", "linux", "rocm", "sd-server-rocm"),
  linuxCuda: path.join(ROOT, "app", "backend", "linux", "cuda", "sd-server-cuda"),
};
let BACKEND_PATH = "";
const backendSupportsFlags = {};
if (osPlatform === "win32") {
  let hasNvidia = false;
  try {
    execSync("nvidia-smi", { stdio: "ignore" });
    hasNvidia = true;
  } catch (_) {
    const commonPath = "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe";
    if (fs.existsSync(commonPath)) {
      hasNvidia = true;
    }
  }

  if (hasNvidia && fs.existsSync(BACKEND_PATHS.cuda)) {
    BACKEND_PATH = BACKEND_PATHS.cuda;
  } else {
    BACKEND_PATH = BACKEND_PATHS.vulkan;
  }
} else if (osPlatform === "darwin") {
  BACKEND_PATH = BACKEND_PATHS.mac;
} else {
  // Linux: default to Vulkan if available, otherwise CPU
  if (fs.existsSync(BACKEND_PATHS.linuxVulkan)) {
    BACKEND_PATH = BACKEND_PATHS.linuxVulkan;
  } else if (fs.existsSync(BACKEND_PATHS.linuxCpu)) {
    BACKEND_PATH = BACKEND_PATHS.linuxCpu;
  } else {
    BACKEND_PATH = BACKEND_PATHS.linuxVulkan;
  }
}
const MODELS  = path.join(ROOT, "app", "models");
if (!fs.existsSync(MODELS)) {
  fs.mkdirSync(MODELS, { recursive: true });
}
const LLM_MODELS = path.join(ROOT, "app", "llm-models");
if (!fs.existsSync(LLM_MODELS)) {
  fs.mkdirSync(LLM_MODELS, { recursive: true });
}
const LLM_BACKEND_PATHS = {
  winVulkan: path.join(ROOT, "app", "llm-backend", "win", "vulkan", "llama-server.exe"),
  winCpu: path.join(ROOT, "app", "llm-backend", "win", "cpu", "llama-server.exe"),
  linuxVulkan: path.join(ROOT, "app", "llm-backend", "linux", "vulkan", "llama-server"),
  linuxCpu: path.join(ROOT, "app", "llm-backend", "linux", "cpu", "llama-server"),
  macArm64: path.join(ROOT, "app", "llm-backend", "mac", "arm64", "llama-server"),
  macX64: path.join(ROOT, "app", "llm-backend", "mac", "x64", "llama-server"),
};
const OPENVINO_MODELS = path.join(ROOT, "app", "openvino-models");
if (!fs.existsSync(OPENVINO_MODELS)) {
  fs.mkdirSync(OPENVINO_MODELS, { recursive: true });
}
const OUTPUTS = path.join(ROOT, "app", "outputs");
if (!fs.existsSync(OUTPUTS)) {
  fs.mkdirSync(OUTPUTS, { recursive: true });
}

const OPENVINO_NPU_MODELS = [
  {
    id: "lcm-dreamshaper-v7-fp16",
    name: "LCM DreamShaper v7 FP16",
    repo: "OpenVINO/LCM_Dreamshaper_v7-fp16-ov",
    folder: "LCM_Dreamshaper_v7-fp16-ov",
    approxSize: "2.0 GB",
    resolution: "512x512",
    notes: "OpenVINO LCM image model. Uses CPU text encoder, NPU UNet, and GPU or CPU VAE decoder.",
  },
];

// ── Backend process state ─────────────────────────────────────────────────────
let backendProc  = null;
let backendReady = false;
let backendError = null;
let openvinoProc = null;
let openvinoReady = false;
let openvinoError = null;
let openvinoPort = null;
let openvinoModel = null;
let openvinoWidth = null;
let openvinoHeight = null;
let llmProc = null;
let llmReady = false;
let llmError = null;
let llmSettings = {
  model: null,
  threads: Math.max(1, Math.min(16, os.cpus().length || 4)),
  contextSize: 4096,
  gpuLayers: -1,
  backendMode: "",
  backendBinary: "",
};
let backendLoadState = {
  active: false,
  phase: "",
  progress: 0,
  current: 0,
  total: 0,
  speed: "",
  model: "",
  backendMode: "",
  backendBinary: "",
  device: "",
};
let backendUnloadState = {
  active: false,
  phase: "",
  progress: 0,
};
let currentSettings = {
  model:    null,
  steps:    20,
  cfgScale: 7.0,
  sampler:  "euler_a",
  threads:  8,
  useGpu:   true,
  backendType: "auto",
  vaeTiling: true,
  vaeOnCpu:  false,
  flashAttn: true,
  width: 512,
  height: 512,
};

let lastCpuSample = null;
let cachedGpuInfo = null;
let cachedBackendOptions = null;
let cachedVramInfo = null;

function roundGb(bytes) {
  return Math.round((bytes / (1024 ** 3)) * 100) / 100;
}

function getCpuSample() {
  return os.cpus().reduce((acc, cpu) => {
    const times = cpu.times;
    acc.idle += times.idle;
    acc.total += times.user + times.nice + times.sys + times.idle + times.irq;
    return acc;
  }, { idle: 0, total: 0 });
}

function getCpuUsagePercent() {
  const current = getCpuSample();
  if (!lastCpuSample) {
    lastCpuSample = current;
    return 0;
  }

  const idleDelta = current.idle - lastCpuSample.idle;
  const totalDelta = current.total - lastCpuSample.total;
  lastCpuSample = current;

  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
}

function detectLinuxGpuFromSysfs() {
  try {
    const pciDir = "/sys/bus/pci/devices";
    if (!fs.existsSync(pciDir)) return null;
    const entries = fs.readdirSync(pciDir);
    for (const entry of entries) {
      const vendorFile = path.join(pciDir, entry, "vendor");
      const deviceFile = path.join(pciDir, entry, "device");
      if (!fs.existsSync(vendorFile)) continue;
      const vendor = fs.readFileSync(vendorFile, "utf8").trim();
      let device = "";
      try { device = fs.readFileSync(deviceFile, "utf8").trim(); } catch (_) {}
      if (vendor === "0x10de") {
        return { name: `NVIDIA GPU (${device || entry})` };
      }
      if (vendor === "0x1002") {
        return { name: `AMD GPU (${device || entry})` };
      }
      if (vendor === "0x8086") {
        return { name: `Intel GPU (${device || entry})` };
      }
    }
  } catch (_) {}
  return null;
}

function getGpuInfo() {
  if (cachedGpuInfo) return cachedGpuInfo;

  if (osPlatform === "win32") {
    try {
      const stdout = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | ForEach-Object { [PSCustomObject]@{ Name = $_.Name; VRAM = [math]::Round($_.AdapterRAM / 1GB, 2) } } | ConvertTo-Json"',
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (stdout) {
        let gpus = [];
        try {
          const parsed = JSON.parse(stdout);
          if (Array.isArray(parsed)) {
            gpus = parsed;
          } else if (parsed && typeof parsed === "object") {
            gpus = [parsed];
          }
        } catch (_) {}

        if (gpus.length > 0) {
          const discreteKeywords = ["nvidia", "amd", "arc", "geforce", "radeon", "rtx", "gtx"];
          let selectedGpu = gpus.find(gpu => {
            const name = String(gpu.Name || "").toLowerCase();
            return discreteKeywords.some(kw => name.includes(kw));
          });
          if (!selectedGpu) {
            selectedGpu = gpus[0];
          }
          cachedGpuInfo = {
            name: selectedGpu.Name || "Unknown GPU",
            vram_gb: typeof selectedGpu.VRAM === "number" ? selectedGpu.VRAM : 0
          };
          return cachedGpuInfo;
        }
      }
    } catch (_) {}
    // Fallback if Powershell fails or returns empty
    try {
      const output = execSync(
        "powershell -NoProfile -Command \"Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name\"",
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (output) {
        cachedGpuInfo = { name: output, vram_gb: 0 };
        return cachedGpuInfo;
      }
    } catch (_) {}
  }

  if (osPlatform === "darwin") {
    try {
      const output = execSync("system_profiler SPDisplaysDataType", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = output.split("\n");
      let currentGpu = null;
      const gpus = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("Chipset Model:")) {
          if (currentGpu) {
            gpus.push(currentGpu);
          }
          currentGpu = {
            name: trimmed.substring("Chipset Model:".length).trim(),
            vram_gb: 0,
          };
        } else if (currentGpu && (trimmed.startsWith("VRAM (Total):") || trimmed.startsWith("VRAM (Dynamic, Max):"))) {
          const valStr = trimmed.split(":")[1].trim(); // e.g. "2 GB" or "1536 MB"
          let bytesVal = 0;
          const numMatch = valStr.match(/^([\d\.]+)\s*(GB|MB)/i);
          if (numMatch) {
            const val = parseFloat(numMatch[1]);
            const unit = numMatch[2].toUpperCase();
            if (unit === "GB") {
              bytesVal = val;
            } else if (unit === "MB") {
              bytesVal = val / 1024;
            }
          }
          currentGpu.vram_gb = Math.round(bytesVal * 100) / 100;
        }
      }
      if (currentGpu) {
        gpus.push(currentGpu);
      }

      if (gpus.length > 0) {
        const isAppleSilicon = gpus.some(g => {
          const name = g.name.toLowerCase();
          return name.includes("apple") || name.includes("m1") || name.includes("m2") || name.includes("m3") || name.includes("m4");
        }) || (os.arch() === "arm64");

        if (isAppleSilicon) {
          const totalRamGb = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100;
          let selected = gpus.find(g => g.name.toLowerCase().includes("apple")) || gpus[0];
          cachedGpuInfo = {
            name: selected.name,
            vram_gb: totalRamGb
          };
          return cachedGpuInfo;
        } else {
          const discreteKeywords = ["nvidia", "amd", "radeon", "geforce"];
          let selected = gpus.find(gpu => {
            const name = gpu.name.toLowerCase();
            return discreteKeywords.some(kw => name.includes(kw));
          });
          if (!selected) {
            selected = gpus[0];
          }
          cachedGpuInfo = {
            name: selected.name,
            vram_gb: selected.vram_gb
          };
          return cachedGpuInfo;
        }
      }
    } catch (_) {}
    // Fallback if system_profiler command fails
    const totalRamGb = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100;
    cachedGpuInfo = { name: "Apple Metal GPU", vram_gb: totalRamGb };
    return cachedGpuInfo;
  }

  if (osPlatform === "linux") {
    // AMD cards: Scan /sys/class/drm/card*/device/vendor and mem_info_vram_total
    try {
      if (fs.existsSync("/sys/class/drm")) {
        const cards = fs.readdirSync("/sys/class/drm").filter(name => name.startsWith("card"));
        for (const card of cards) {
          const vendorPath = `/sys/class/drm/${card}/device/vendor`;
          const vramPath = `/sys/class/drm/${card}/device/mem_info_vram_total`;
          if (fs.existsSync(vendorPath) && fs.existsSync(vramPath)) {
            const vendor = fs.readFileSync(vendorPath, "utf8").trim();
            if (vendor === "0x1002") {
              const vramBytesStr = fs.readFileSync(vramPath, "utf8").trim();
              const vramBytes = parseFloat(vramBytesStr);
              if (!isNaN(vramBytes)) {
                cachedGpuInfo = {
                  name: "AMD Radeon GPU",
                  vram_gb: Math.round((vramBytes / (1024 ** 3)) * 100) / 100
                };
                return cachedGpuInfo;
              }
            }
          }
        }
      }
    } catch (_) {}

    // NVIDIA cards: read /proc/driver/nvidia/gpus/*/information or run nvidia-smi
    try {
      if (fs.existsSync("/proc/driver/nvidia/gpus")) {
        const gpuDirs = fs.readdirSync("/proc/driver/nvidia/gpus");
        for (const gpuDir of gpuDirs) {
          const infoPath = `/proc/driver/nvidia/gpus/${gpuDir}/information`;
          if (fs.existsSync(infoPath)) {
            const info = fs.readFileSync(infoPath, "utf8");
            const modelMatch = info.match(/Model:\s+(.*)/);
            if (modelMatch) {
              const modelName = modelMatch[1].trim();
              let vram_gb = 0;
              try {
                const smiOut = execSync("nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", {
                  encoding: "utf8",
                  stdio: ["ignore", "pipe", "ignore"]
                }).trim();
                const parsedVal = parseFloat(smiOut);
                if (!isNaN(parsedVal)) {
                  vram_gb = Math.round((parsedVal / 1024) * 100) / 100;
                }
              } catch (_) {}
              cachedGpuInfo = {
                name: modelName,
                vram_gb: vram_gb || 8.0
              };
              return cachedGpuInfo;
            }
          }
        }
      }
    } catch (_) {}

    try {
      const smiOut = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      if (smiOut) {
        const lines = smiOut.split("\n");
        if (lines[0]) {
          const [name, totalMb] = lines[0].split(",").map(p => p.trim());
          const parsedVal = parseFloat(totalMb);
          cachedGpuInfo = {
            name: name || "NVIDIA GPU",
            vram_gb: !isNaN(parsedVal) ? Math.round((parsedVal / 1024) * 100) / 100 : 8.0
          };
          return cachedGpuInfo;
        }
      }
    } catch (_) {}

    const linuxGpu = detectLinuxGpuFromSysfs();
    if (linuxGpu) {
      cachedGpuInfo = {
        name: linuxGpu.name,
        vram_gb: 0
      };
      return cachedGpuInfo;
    }
  }

  cachedGpuInfo = { name: "Unavailable", vram_gb: 0 };
  return cachedGpuInfo;
}

let nvidiaSmiCmd = "nvidia-smi";
let hasNvidiaSmi = null;

if (osPlatform === "win32") {
  const commonPath = "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe";
  if (fs.existsSync(commonPath)) {
    nvidiaSmiCmd = `"${commonPath}"`;
  }
}

let isPollingVram = false;
let lastVramPollTime = 0;

function pollNvidiaVram(force = false) {
  if (isPollingVram) return;
  if (hasNvidiaSmi === false) return;

  const now = Date.now();
  // If not forced, skip if backend is running (driver queries conflict & cause display lag),
  // or if it has been polled too recently
  if (!force) {
    if (backendProc !== null) {
      return;
    }
    if (now - lastVramPollTime < 4500) {
      return;
    }
  }

  isPollingVram = true;
  lastVramPollTime = now;
  const cmd = `${nvidiaSmiCmd} --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits`;
  exec(
    cmd,
    { stdio: ["ignore", "pipe", "ignore"] },
    (error, stdout) => {
      isPollingVram = false;
      if (error) {
        // Only permanently disable if we are not currently running a backend workload
        if (backendProc === null) {
          hasNvidiaSmi = false;
        }
        cachedVramInfo = null;
        return;
      }
      hasNvidiaSmi = true;
      const output = (stdout || "").trim();
      const firstLine = output.split(/\r?\n/)[0];
      if (!firstLine) {
        cachedVramInfo = null;
        return;
      }

      const [name, usedMb, totalMb] = firstLine.split(",").map(part => part.trim());
      cachedVramInfo = {
        gpu_name: name || getGpuInfo().name,
        vram_used_gb: Math.round((parseFloat(usedMb) / 1024) * 100) / 100,
        vram_total_gb: Math.round((parseFloat(totalMb) / 1024) * 100) / 100,
      };
    }
  );
}

// Start background VRAM polling (runs every 5 seconds, only active when backend is idle)
setInterval(() => pollNvidiaVram(false), 5000);
pollNvidiaVram(true);

function getNvidiaVram() {
  return cachedVramInfo;
}

let cachedMacRamUsedGb = null;
function pollMacRam() {
  if (osPlatform !== "darwin") return;
  exec("vm_stat", (err, stdout) => {
    if (err) return;
    try {
      const vmStat = stdout.toString();
      const pageSizeMatch = vmStat.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;

      const getVal = (key) => {
        const match = vmStat.match(new RegExp(key + ":\\s+(\\d+)\\."));
        return match ? parseInt(match[1], 10) : 0;
      };

      const freePages = getVal("Pages free");
      const inactivePages = getVal("Pages inactive");
      const speculativePages = getVal("Pages speculative");
      
      const totalFreeBytes = (freePages + inactivePages + speculativePages) * pageSize;
      cachedMacRamUsedGb = roundGb(os.totalmem() - totalFreeBytes);
    } catch (e) {
      // Ignore parsing errors
    }
  });
}

if (osPlatform === "darwin") {
  pollMacRam();
  setInterval(pollMacRam, 5000);
}

function getHardwareSpecs() {
  const cpus = os.cpus();
  const gpu = getGpuInfo();
  const ramTotalGb = roundGb(os.totalmem());
  const gpuVramGb = gpu.vram_gb || 0;

  // Tiering logic
  let tier = "low";
  let tierReason = "";

  const isAppleSilicon = osPlatform === "darwin" && (os.arch() === "arm64" || String(cpus[0]?.model || "").toLowerCase().includes("apple"));

  if (isAppleSilicon) {
    if (ramTotalGb >= 16) {
      tier = "high";
      tierReason = `Apple Silicon Mac with ${ramTotalGb} GB unified memory.`;
    } else if (ramTotalGb >= 8) {
      tier = "mid";
      tierReason = `Apple Silicon Mac with ${ramTotalGb} GB unified memory.`;
    } else {
      tier = "low";
      tierReason = `Apple Silicon Mac with ${ramTotalGb} GB unified memory.`;
    }
  } else {
    if (gpuVramGb >= 12) {
      tier = "high";
      tierReason = `Discrete GPU with ${gpuVramGb} GB VRAM.`;
    } else if (gpuVramGb >= 6) {
      tier = "mid";
      tierReason = `GPU with ${gpuVramGb} GB VRAM.`;
    } else {
      tier = "low";
      tierReason = `GPU with ${gpuVramGb} GB VRAM and ${ramTotalGb} GB RAM.`;
    }
  }

  // Recommended models catalog matching contract exactly
  let recommended_models = [];
  if (tier === "high") {
    recommended_models = [
      {
        name: "Llama 3 8B Instruct (Q8_0)",
        filename: "Meta-Llama-3-8B-Instruct-Q8_0.gguf",
        approxSize: "8.5 GB",
        url: "https://huggingface.co/QuantFactory/Meta-Llama-3-8B-Instruct-GGUF/resolve/main/Meta-Llama-3-8B-Instruct-Q8_0.gguf",
        notes: "Near-lossless precision for high quality responses.",
        reason: tierReason
      },
      {
        name: "Mistral 7B Instruct v0.3 (Q8_0)",
        filename: "Mistral-7B-Instruct-v0.3.Q8_0.gguf",
        approxSize: "7.7 GB",
        url: "https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3.Q8_0.gguf",
        notes: "Superb instruction-following and context window size.",
        reason: tierReason
      }
    ];
  } else if (tier === "mid") {
    recommended_models = [
      {
        name: "Llama 3 8B Instruct (Q4_K_M)",
        filename: "Meta-Llama-3-8B-Instruct-Q4_K_M.gguf",
        approxSize: "4.8 GB",
        url: "https://huggingface.co/QuantFactory/Meta-Llama-3-8B-Instruct-GGUF/resolve/main/Meta-Llama-3-8B-Instruct-Q4_K_M.gguf",
        notes: "Great balance of speed and performance.",
        reason: tierReason
      },
      {
        name: "Phi-3 Mini Instruct (Q4_K_M)",
        filename: "Phi-3-mini-4k-instruct-q4.gguf",
        approxSize: "2.2 GB",
        url: "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf",
        notes: "Lightweight and fast, optimized by Microsoft.",
        reason: tierReason
      }
    ];
  } else {
    recommended_models = [
      {
        name: "Qwen 2.5 Coder 0.5B Instruct (Q4_K_M)",
        filename: "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        approxSize: "491 MB",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        notes: "Extremely fast, lightweight assistant, perfect for low RAM/VRAM machines.",
        reason: tierReason
      },
      {
        name: "SmolLM2 1.7B Instruct (Q4_K_M)",
        filename: "smollm2-1.7b-instruct-q4_k_m.gguf",
        approxSize: "1.1 GB",
        url: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf",
        notes: "Excellent lightweight assistant with strong logic, reasoning, and prompt expansion capabilities.",
        reason: tierReason
      }
    ];
  }

  return {
    os_name: `${os.type()} ${os.release()}`,
    cpu_name: cpus[0]?.model || "Unavailable",
    cpu_cores_physical: Math.max(1, Math.round(cpus.length / 2)),
    cpu_cores_logical: cpus.length || 1,
    ram_total_gb: ramTotalGb,
    gpu_name: gpu.name,
    gpu_vram_gb: gpuVramGb,
    recommended_models
  };
}

function getTelemetry() {
  const vram = getNvidiaVram();
  let ram_used_gb = roundGb(os.totalmem() - os.freemem());
  if (osPlatform === "darwin" && cachedMacRamUsedGb !== null) {
    ram_used_gb = cachedMacRamUsedGb;
  }
  const gpu = getGpuInfo();
  return {
    cpu_usage: getCpuUsagePercent(),
    ram_used_gb,
    ram_total_gb: roundGb(os.totalmem()),
    gpu_name: vram?.gpu_name || gpu.name,
    vram_used_gb: vram?.vram_used_gb || 0,
    vram_total_gb: vram?.vram_total_gb || gpu.vram_gb || 0,
  };
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function getPathInfo(label, targetPath, type = "file") {
  const exists = fs.existsSync(targetPath);
  return {
    label,
    path: targetPath,
    type,
    exists,
    ok: exists,
  };
}

function isDirWritable(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const testFile = path.join(dirPath, `.local-ai-image-generator-write-test-${Date.now()}.tmp`);
    fs.writeFileSync(testFile, "ok", "utf8");
    fs.unlinkSync(testFile);
    return true;
  } catch (_) {
    return false;
  }
}

function getDirInfo(label, targetPath) {
  const exists = fs.existsSync(targetPath);
  const writable = exists ? isDirWritable(targetPath) : false;
  return {
    label,
    path: targetPath,
    type: "directory",
    exists,
    writable,
    ok: exists && writable,
  };
}

function getPathSize(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return fs.readdirSync(targetPath).reduce((sum, name) => sum + getPathSize(path.join(targetPath, name)), 0);
  } catch (_) {
    return 0;
  }
}

function getOpenVinoPythonCandidates() {
  const candidates = [];
  if (process.env.OPENVINO_PYTHON) candidates.push(process.env.OPENVINO_PYTHON);
  if (osPlatform === "win32") {
    candidates.push(path.join(ROOT, "app", "tools", "openvino-venv-win", "Scripts", "python.exe"));
    candidates.push(path.join(ROOT, "app", "tools", "openvino-venv", "Scripts", "python.exe")); // legacy fallback
    candidates.push("C:\\tmp\\npu-test-venv\\Scripts\\python.exe");
    candidates.push("python");
  } else {
    candidates.push(path.join(ROOT, "app", "tools", "openvino-venv-linux", "bin", "python"));
    candidates.push(path.join(ROOT, "app", "tools", "openvino-venv", "bin", "python")); // legacy fallback
    candidates.push("python3");
    candidates.push("python");
  }
  return [...new Set(candidates)];
}

function getOpenVinoPython() {
  for (const candidate of getOpenVinoPythonCandidates()) {
    try {
      const result = spawnSync(candidate, [
        "-c",
        "import openvino, openvino_genai, PIL; print(openvino.__version__)",
      ], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
      if (result.status === 0) return candidate;
    } catch (_) {}
  }
  return null;
}

let cachedOpenVinoNpuInfo = null;

function getOpenVinoNpuInfo() {
  if (cachedOpenVinoNpuInfo) return cachedOpenVinoNpuInfo;

  if (osPlatform !== "win32" && osPlatform !== "linux") {
    cachedOpenVinoNpuInfo = { supported: false, reason: "OpenVINO NPU backend is supported on Windows and Linux Intel Core Ultra systems." };
    return cachedOpenVinoNpuInfo;
  }
  const python = getOpenVinoPython();
  if (!python) {
    const setupScript = osPlatform === "win32"
      ? "scripts/setup-openvino-npu.ps1"
      : "bash scripts/setup-openvino-npu.sh";
    cachedOpenVinoNpuInfo = {
      supported: false,
      reason: `OpenVINO GenAI runtime is not installed. Run ${setupScript} first.`,
    };
    return cachedOpenVinoNpuInfo;
  }
  try {
    const script = [
      "import json, openvino as ov",
      "core=ov.Core()",
      "devices=core.available_devices",
      "info={'devices':devices,'npu':None}",
      "if 'NPU' in devices:",
      "    info['npu']={'name':core.get_property('NPU','FULL_DEVICE_NAME'),'capabilities':core.get_property('NPU','OPTIMIZATION_CAPABILITIES')}",
      "print(json.dumps(info))",
    ].join("\n");
    const result = spawnSync(python, ["-c", script], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) {
      cachedOpenVinoNpuInfo = { supported: false, python, reason: result.stderr.trim() || "OpenVINO NPU probe failed." };
      return cachedOpenVinoNpuInfo;
    }
    const info = JSON.parse(result.stdout.trim());
    if (!info.devices.includes("NPU")) {
      cachedOpenVinoNpuInfo = { supported: false, python, reason: `OpenVINO is installed, but NPU is not available. Devices: ${info.devices.join(", ")}` };
      return cachedOpenVinoNpuInfo;
    }
    cachedOpenVinoNpuInfo = { supported: true, platform: osPlatform, python, devices: info.devices, npu: info.npu };
    return cachedOpenVinoNpuInfo;
  } catch (err) {
    cachedOpenVinoNpuInfo = { supported: false, python, reason: err.message || String(err) };
    return cachedOpenVinoNpuInfo;
  }
}

function getOpenVinoModelInfo() {
  return OPENVINO_NPU_MODELS.map((model) => {
    const modelPath = path.join(OPENVINO_MODELS, model.folder);
    const requiredFiles = [
      path.join(modelPath, "model_index.json"),
      path.join(modelPath, "text_encoder", "openvino_model.xml"),
      path.join(modelPath, "unet", "openvino_model.xml"),
      path.join(modelPath, "vae_decoder", "openvino_model.xml"),
    ];
    const installed = requiredFiles.every((file) => fs.existsSync(file));
    return {
      ...model,
      filename: model.id,
      path: modelPath,
      installed,
      sizeBytes: getPathSize(modelPath),
      size: formatBytes(getPathSize(modelPath)),
      format: "OpenVINO",
    };
  });
}

function findOpenVinoModel(modelId) {
  return getOpenVinoModelInfo().find((model) => model.id === modelId || model.folder === modelId || model.name === modelId);
}

function pathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function checkPort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve({ port, available: false, inUse: true }))
      .once("listening", () => {
        tester.close(() => resolve({ port, available: true, inUse: false }));
      })
      .listen(port, "127.0.0.1");
  });
}

async function findAvailableBackendPort() {
  const preferred = await checkPort(PREFERRED_BACKEND_PORT);
  if (preferred.available) return PREFERRED_BACKEND_PORT;

  for (let port = 28088; port <= 28120; port += 1) {
    const candidate = await checkPort(port);
    if (candidate.available) {
      console.log(`  [backend] Preferred port ${PREFERRED_BACKEND_PORT} is busy; using ${port} instead.`);
      return port;
    }
  }

  throw new Error(`No free backend port found. Tried ${PREFERRED_BACKEND_PORT} and 28088-28120.`);
}

async function findAvailableLlmPort() {
  const preferred = await checkPort(PREFERRED_LLM_PORT);
  if (preferred.available) return PREFERRED_LLM_PORT;

  for (let port = 28121; port <= 28160; port += 1) {
    const candidate = await checkPort(port);
    if (candidate.available) {
      console.log(`  [llm] Preferred port ${PREFERRED_LLM_PORT} is busy; using ${port} instead.`);
      return port;
    }
  }

  throw new Error(`No free LLM port found. Tried ${PREFERRED_LLM_PORT} and 28121-28160.`);
}

function getLlmBackend() {
  const candidates = osPlatform === "win32"
    ? [
        { path: LLM_BACKEND_PATHS.winVulkan, mode: "Auto (Vulkan/CPU)" },
        { path: LLM_BACKEND_PATHS.winCpu, mode: "CPU" },
      ]
    : osPlatform === "darwin"
      ? [{
          path: process.arch === "arm64" ? LLM_BACKEND_PATHS.macArm64 : LLM_BACKEND_PATHS.macX64,
          mode: process.arch === "arm64" ? "Metal GPU" : "CPU",
        }]
      : [
          { path: LLM_BACKEND_PATHS.linuxVulkan, mode: "Auto (Vulkan/CPU)" },
          { path: LLM_BACKEND_PATHS.linuxCpu, mode: "CPU" },
        ];

  return candidates.find((candidate) => fs.existsSync(candidate.path)) || null;
}

function getLlmModels() {
  try {
    return fs.readdirSync(LLM_MODELS)
      .filter((filename) => filename.toLowerCase().endsWith(".gguf"))
      .map((filename) => {
        const stats = fs.statSync(path.join(LLM_MODELS, filename));
        return {
          filename,
          name: filename,
          sizeBytes: stats.size,
          size: formatBytes(stats.size),
          format: "GGUF",
        };
      });
  } catch (_) {
    return [];
  }
}

function pingLlmReady() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT_LLM}/v1/models`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForLlmReady(maxAttempts = 240) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!llmProc) throw new Error(llmError || "llama.cpp exited during startup.");
    if (await pingLlmReady()) {
      llmReady = true;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("llama.cpp did not become ready within 2 minutes.");
}

function killLlm() {
  return new Promise((resolve) => {
    llmReady = false;
    if (!llmProc) {
      resolve();
      return;
    }
    const proc = llmProc;
    llmProc = null;
    try { proc.kill("SIGTERM"); } catch (_) {}
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_) {}
      resolve();
    }, 1200);
  });
}

function getSetupPaths() {
  const appDir = path.join(ROOT, "app");
  if (osPlatform === "win32") {
    return {
      node: path.join(appDir, "tools", "node-win", "node.exe"),
      npm: path.join(appDir, "tools", "node-win", "npm.cmd"),
      distIndex: path.join(DIST, "index.html"),
      cudaBackend: BACKEND_PATHS.cuda,
      vulkanBackend: BACKEND_PATHS.vulkan,
      models: MODELS,
      outputs: OUTPUTS,
    };
  } else if (osPlatform === "darwin") {
    return {
      node: path.join(appDir, "tools", "node-mac", "bin", "node"),
      npm: path.join(appDir, "tools", "node-mac", "bin", "npm"),
      distIndex: path.join(DIST, "index.html"),
      macBackend: BACKEND_PATHS.mac,
      models: MODELS,
      outputs: OUTPUTS,
    };
  } else {
    // Linux / WSL
    return {
      node: path.join(appDir, "tools", "node-linux", "bin", "node"),
      npm: path.join(appDir, "tools", "node-linux", "bin", "npm"),
      distIndex: path.join(DIST, "index.html"),
      linuxCpuBackend: BACKEND_PATHS.linuxCpu,
      linuxVulkanBackend: BACKEND_PATHS.linuxVulkan,
      linuxRocmBackend: BACKEND_PATHS.linuxRocm,
      models: MODELS,
      outputs: OUTPUTS,
    };
  }
}

async function getHealth() {
  const paths = getSetupPaths();
  const checks = [
    getPathInfo("Portable Node.js", paths.node),
    getPathInfo("Portable npm", paths.npm),
    getPathInfo("Frontend build", paths.distIndex),
    getDirInfo("Models folder", paths.models),
    getDirInfo("Outputs folder", paths.outputs),
  ];

  if (osPlatform === "win32") {
    checks.push(getPathInfo("CUDA backend", paths.cudaBackend));
    checks.push(getPathInfo("Vulkan backend", paths.vulkanBackend));
  } else if (osPlatform === "darwin") {
    checks.push(getPathInfo("Mac backend", paths.macBackend));
  } else {
    checks.push(getPathInfo("Linux CPU backend", paths.linuxCpuBackend));
    checks.push(getPathInfo("Linux Vulkan backend", paths.linuxVulkanBackend));
    checks.push(getPathInfo("Linux ROCm backend", paths.linuxRocmBackend));
  }

  let backendInstalled = false;
  if (osPlatform === "win32") {
    backendInstalled = checks.find((check) => check.label === "CUDA backend")?.exists ||
      checks.find((check) => check.label === "Vulkan backend")?.exists;
  } else if (osPlatform === "darwin") {
    backendInstalled = checks.find((check) => check.label === "Mac backend")?.exists;
  } else {
    backendInstalled =
      checks.find((check) => check.label === "Linux CPU backend")?.exists ||
      checks.find((check) => check.label === "Linux CPU backend")?.exists ||
      checks.find((check) => check.label === "Linux Vulkan backend")?.exists ||
      checks.find((check) => check.label === "Linux ROCm backend")?.exists;
  }

  const criticalOk = checks
    .filter((check) => !["CUDA backend", "Vulkan backend", "Linux CPU backend", "Linux Vulkan backend", "Linux ROCm backend", "Mac backend"].includes(check.label))
    .every((check) => check.ok) && backendInstalled;

  const ports = {
    frontend: { ...(await checkPort(PORT_FRONTEND)), expectedInUse: true },
    backend: { ...(await checkPort(PORT_BACKEND)), expectedInUse: backendProc !== null || openvinoProc !== null },
  };
  ports.frontend.ok = !ports.frontend.available;
  ports.backend.preferred = PREFERRED_BACKEND_PORT;
  ports.backend.selected = PORT_BACKEND;
  ports.backend.ok = true;

  const issues = checks
    .filter((check) => !check.ok && !["CUDA backend", "Vulkan backend", "Linux CPU backend", "Linux Vulkan backend", "Linux ROCm backend", "Mac backend"].includes(check.label))
    .map((check) => `${check.label} is missing or not writable.`);
  if (!backendInstalled) {
    issues.push(`No ${osPlatform === "win32" ? "Windows" : osPlatform === "darwin" ? "macOS" : "Linux"} backend binary is installed.`);
  }
  return {
    ok: criticalOk && ports.backend.ok,
    build: SERVER_BUILD,
    root: ROOT,
    platform: osPlatform,
    checks,
    ports,
    backend: {
      ready: backendReady || openvinoReady,
      running: backendProc !== null || openvinoProc !== null,
      error: backendError,
      settings: currentSettings,
      options: getBackendOptions(),
    },
    models: {
      count: fs.existsSync(MODELS) ? fs.readdirSync(MODELS).filter(isModelFile).length : 0,
      totalBytes: getPathSize(MODELS),
      totalSize: formatBytes(getPathSize(MODELS)),
    },
    outputs: {
      count: fs.existsSync(OUTPUTS) ? fs.readdirSync(OUTPUTS).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      totalBytes: getPathSize(OUTPUTS),
      totalSize: formatBytes(getPathSize(OUTPUTS)),
    },
    issues,
  };
}

function addCleanupCandidate(candidates, id, targetPath, reason, options = {}) {
  if (!fs.existsSync(targetPath)) return;
  if (!options.allowUserData && (pathInside(targetPath, MODELS) || pathInside(targetPath, OUTPUTS))) return;
  const sizeBytes = getPathSize(targetPath);
  candidates.push({
    id,
    path: targetPath,
    name: path.basename(targetPath),
    reason,
    sizeBytes,
    size: formatBytes(sizeBytes),
  });
}

function getCleanupCandidates() {
  const candidates = [];
  const toolsDir = path.join(ROOT, "app", "tools");
  const frontendDir = path.join(ROOT, "app", "frontend");
  addCleanupCandidate(candidates, "scratch-invalid", path.join(ROOT, "scratch_invalid.txt"), "Scratch/debug file.");
  addCleanupCandidate(candidates, "vite-cache", path.join(frontendDir, "node_modules", ".vite"), "Vite dependency cache; it can be regenerated.");

  if (fs.existsSync(toolsDir)) {
    for (const item of fs.readdirSync(toolsDir)) {
      const itemPath = path.join(toolsDir, item);
      if (item.toLowerCase().endsWith(".zip")) {
        addCleanupCandidate(candidates, `setup-zip-${item}`, itemPath, "Setup download archive.");
      } else if (/^sd-.+-temp$/i.test(item)) {
        addCleanupCandidate(candidates, `setup-temp-${item}`, itemPath, "Temporary backend extraction folder.");
      }
    }
  }

  if (fs.existsSync(MODELS)) {
    for (const item of fs.readdirSync(MODELS)) {
      if (item.toLowerCase().endsWith(".part") || item.toLowerCase().endsWith(".tmp")) {
        addCleanupCandidate(candidates, `partial-model-${item}`, path.join(MODELS, item), "Incomplete model download/import file.", { allowUserData: true });
      }
    }
  }

  return candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function cleanupSelected(ids = []) {
  const allowed = new Map(getCleanupCandidates().map((candidate) => [candidate.id, candidate]));
  const deleted = [];
  for (const id of ids) {
    const candidate = allowed.get(id);
    if (!candidate) continue;
    if (!fs.existsSync(candidate.path)) continue;
    const stat = fs.statSync(candidate.path);
    if (stat.isDirectory()) {
      fs.rmSync(candidate.path, { recursive: true, force: true });
    } else {
      fs.unlinkSync(candidate.path);
    }
    deleted.push(candidate);
  }
  return deleted;
}

function hasNvidiaGpu() {
  const info = getGpuInfo().name.toLowerCase();
  if (info.includes("nvidia")) return true;
  try {
    execSync("nvidia-smi", { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function hasAmdGpu() {
  const info = getGpuInfo().name.toLowerCase();
  return info.includes("amd") || info.includes("advanced micro devices") || info.includes("radeon");
}

// Detect whether we are running inside WSL2 (Windows Subsystem for Linux).
// WSL2's GPU paravirtualization (GPU-PV) only exposes a D3D12/DirectX interface
// to Linux. Vulkan hardware passthrough is only supported for NVIDIA (via CUDA).
// Intel Arc and AMD GPUs in WSL2 fall back to llvmpipe (CPU software rendering).
function isRunningInWSL() {
  if (osPlatform !== "linux") return false;
  try {
    const procVersion = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return procVersion.includes("microsoft") || procVersion.includes("wsl");
  } catch (_) {
    return false;
  }
}

function getVulkanUnavailableReason() {
  if (osPlatform === "linux" && isRunningInWSL()) {
    const gpuName = getGpuInfo().name;
    const lowerGpu = gpuName.toLowerCase();
    if (lowerGpu.includes("intel") || lowerGpu.includes("arc")) {
      return `Vulkan GPU is not available in WSL2 for Intel ${gpuName}. WSL2's GPU paravirtualization only exposes a DirectX interface — Intel Arc Vulkan requires running natively on Windows.`;
    }
    return "Vulkan GPU is not available in WSL2. WSL2's GPU paravirtualization does not support hardware Vulkan for this GPU. Run natively on Windows or Linux for GPU acceleration.";
  }
  return "Installed, but this binary did not register a Vulkan backend on this machine.";
}

let cachedCoreMLPythonPath = null;
let cachedCoreMLAvailable = null;

function getCoreMLPythonPath() {
  if (cachedCoreMLAvailable !== null) {
    return cachedCoreMLPythonPath;
  }

  if (osPlatform !== "darwin") {
    cachedCoreMLAvailable = false;
    cachedCoreMLPythonPath = null;
    return null;
  }

  // 1. Check environment variable COREML_PYTHON
  if (process.env.COREML_PYTHON && fs.existsSync(process.env.COREML_PYTHON)) {
    cachedCoreMLPythonPath = process.env.COREML_PYTHON;
    cachedCoreMLAvailable = true;
    return cachedCoreMLPythonPath;
  }

  // 2. Check local/in-project venvs
  const localPaths = [
    path.join(ROOT, "app", "backend", "mac", "coreml_venv", "bin", "python"),
    path.join(ROOT, "app", "backend", "mac", "venv", "bin", "python"),
    path.join(ROOT, "venv", "bin", "python"),
  ];

  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      cachedCoreMLPythonPath = p;
      cachedCoreMLAvailable = true;
      return p;
    }
  }

  // 3. Check dynamically in home directory (as fallback to user's setup)
  const homeDir = os.homedir();
  const homePaths = [
    path.join(homeDir, "workspace", "coreml_conversion", "venv", "bin", "python"),
    path.join(homeDir, "ml-stable-diffusion", "venv", "bin", "python"),
  ];

  for (const p of homePaths) {
    if (fs.existsSync(p)) {
      cachedCoreMLPythonPath = p;
      cachedCoreMLAvailable = true;
      return p;
    }
  }

  // 4. Fallback: Probe system python3 if it has required imports
  try {
    const probeResult = spawnSync("python3", [
      "-c",
      "import python_coreml_stable_diffusion, diffusers, transformers"
    ], { timeout: 2000 });
    
    if (probeResult.status === 0) {
      // Find absolute path of python3
      const whichResult = spawnSync("which", ["python3"], { encoding: "utf8" });
      const python3Path = whichResult.stdout ? whichResult.stdout.trim() : "python3";
      cachedCoreMLPythonPath = python3Path;
      cachedCoreMLAvailable = true;
      return python3Path;
    }
  } catch (err) {
    // python3 not in path or crashed
  }

  cachedCoreMLAvailable = false;
  cachedCoreMLPythonPath = null;
  return null;
}

function getCoreMLNpuInfo() {
  const isAppleSilicon = osPlatform === "darwin" && os.arch() === "arm64";
  if (!isAppleSilicon) {
    return { supported: false, reason: "Apple Silicon ANE (NPU) is only available on Apple Silicon macOS devices." };
  }

  const pythonPath = getCoreMLPythonPath();
  if (!pythonPath) {
    return {
      supported: true,
      ready: false,
      reason: "CoreML Python environment is not set up. Run scripts/setup-coreml-npu.sh first.",
    };
  }

  return {
    supported: true,
    ready: true,
    python: pythonPath,
  };
}

function getBackendOptions() {
  if (cachedBackendOptions) return cachedBackendOptions;

  const cudaInstalled = (osPlatform === "win32" && fs.existsSync(BACKEND_PATHS.cuda)) ||
                        (osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxCuda));
  const cudaAvailable = cudaInstalled && hasNvidiaGpu() && backendAccepts(
    osPlatform === "win32" ? BACKEND_PATHS.cuda : BACKEND_PATHS.linuxCuda,
    "cuda"
  );
  const vulkanInstalled = (osPlatform === "win32" && fs.existsSync(BACKEND_PATHS.vulkan)) ||
                          (osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxVulkan));
  const vulkanAvailable = vulkanInstalled && backendAccepts(
    osPlatform === "win32" ? BACKEND_PATHS.vulkan : BACKEND_PATHS.linuxVulkan,
    "vulkan"
  );
  const rocmInstalled = osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxRocm);
  const rocmAvailable = rocmInstalled && hasAmdGpu() && backendAccepts(BACKEND_PATHS.linuxRocm, "rocm");
  const cpuInstalled = osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxCpu);
  const metalInstalled = osPlatform === "darwin" && fs.existsSync(BACKEND_PATHS.mac);
  const metalAvailable = metalInstalled;
  const coremlNpu = getCoreMLNpuInfo();
  const openvinoNpu = getOpenVinoNpuInfo();
  const openvinoModels = getOpenVinoModelInfo();
  const openvinoNpuAvailable = openvinoNpu.supported && openvinoModels.some((model) => model.installed);

  const options = [{ id: "cpu", label: "CPU", available: true }];
  if (metalAvailable) options.push({ id: "metal", label: "Metal GPU", available: true });
  if (coremlNpu.supported && coremlNpu.ready) options.push({ id: "apple-npu", label: "Apple Neural Engine (NPU)", available: true });
  if (vulkanAvailable) options.push({ id: "vulkan", label: "Vulkan GPU", available: true });
  if (rocmAvailable) options.push({ id: "rocm", label: "ROCm GPU (AMD)", available: true });
  if (cudaAvailable) options.push({ id: "cuda", label: "CUDA GPU", available: true });
  if (openvinoNpuAvailable) options.push({ id: "openvino-npu", label: "NPU (OpenVINO)", available: true });

  const unavailable = [];
  if (vulkanInstalled && !vulkanAvailable) {
    unavailable.push({ id: "vulkan", label: "Vulkan GPU", reason: getVulkanUnavailableReason() });
  }
  if (cudaInstalled && !cudaAvailable) {
    unavailable.push({ id: "cuda", label: "CUDA GPU", reason: "Installed, but CUDA backend validation failed." });
  }
  if (rocmInstalled && !rocmAvailable) {
    unavailable.push({ id: "rocm", label: "ROCm GPU (AMD)", reason: "Installed, but ROCm backend validation failed." });
  }
  if (metalInstalled && !metalAvailable) {
    unavailable.push({ id: "metal", label: "Metal GPU", reason: "Installed, but Metal backend validation failed." });
  }
  if (coremlNpu.supported && !coremlNpu.ready) {
    unavailable.push({ id: "apple-npu", label: "Apple Neural Engine (NPU)", reason: coremlNpu.reason });
  }
  if (openvinoNpu.supported && !openvinoNpuAvailable) {
    unavailable.push({ id: "openvino-npu", label: "NPU (OpenVINO)", reason: "Runtime is ready, but no OpenVINO NPU model is downloaded." });
  } else if (!openvinoNpu.supported && (osPlatform === "win32" || osPlatform === "linux")) {
    unavailable.push({ id: "openvino-npu", label: "NPU (OpenVINO)", reason: openvinoNpu.reason });
  }

  let defaultBackend = "cpu";
  if (coremlNpu.supported && coremlNpu.ready) {
    defaultBackend = "apple-npu";
  } else if (metalAvailable) {
    defaultBackend = "metal";
  } else if (cudaAvailable) {
    const gpuName = String(getGpuInfo().name).toLowerCase();
    const isGtxCard = gpuName.includes("gtx");
    if (isGtxCard && vulkanAvailable) {
      defaultBackend = "vulkan"; // Default to Vulkan for GTX cards because of lack of Tensor Cores
    } else {
      defaultBackend = "cuda";
    }
  } else if (rocmAvailable) {
    defaultBackend = "rocm";
  } else if (vulkanAvailable) {
    defaultBackend = "vulkan";
  }

  cachedBackendOptions = {
    options,
    unavailable,
    cudaAvailable,
    vulkanAvailable,
    rocmAvailable,
    metalAvailable,
    openvinoNpuAvailable,
    openvinoNpu,
    openvinoModels,
    coremlNpu,
    defaultBackendType: defaultBackend,
  };
  return cachedBackendOptions;
}

function backendAccepts(binaryPath, backendName) {
  if (!binaryPath || !fs.existsSync(binaryPath)) return false;
  try {
    const cliBackendName = backendName;
    let probeArgs = [
      "--backend", cliBackendName,
      "--params-backend", cliBackendName,
      "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
      "--listen-port", "18082",
    ];
    if (cliBackendName === "metal") {
      probeArgs = [
        "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
        "--listen-port", "18082",
      ];
    }
    const spawnEnv = { ...process.env };
    if (osPlatform === "linux") {
      const dir = path.dirname(binaryPath);
      const existing = spawnEnv.LD_LIBRARY_PATH || "";
      spawnEnv.LD_LIBRARY_PATH = dir + (existing ? ":" + existing : "");
    } else if (osPlatform === "darwin") {
      const dir = path.dirname(binaryPath);
      const existing = spawnEnv.DYLD_LIBRARY_PATH || "";
      spawnEnv.DYLD_LIBRARY_PATH = dir + (existing ? ":" + existing : "");
    }
    let result = spawnSync(binaryPath, probeArgs, { env: spawnEnv, encoding: "utf8", timeout: 5000 });
    let output = `${result.stdout || ""}\n${result.stderr || ""}`;

    let supportsFlags = true;
    // Some binaries do not support --backend. If we see "unknown argument",
    // retry without backend flags so we can still verify the binary launches.
    if (output.includes("unknown argument") && output.includes("--backend")) {
      supportsFlags = false;
      const fallbackArgs = [
        "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
        "--listen-port", "18082",
      ];
      result = spawnSync(binaryPath, fallbackArgs, { env: spawnEnv, encoding: "utf8", timeout: 5000 });
      output = `${result.stdout || ""}\n${result.stderr || ""}`;
    }

    const lower = output.toLowerCase();
    if (lower.includes("backend config failed") || output.includes(`backend '${backendName}' was not found`) || output.includes(`backend '${cliBackendName}' was not found`)) {
      return false;
    }
    // Reject binaries that fail at the dynamic linker / glibc level.
    if (lower.includes("glibc") || lower.includes("libc.so") || lower.includes("libstdc++") || lower.includes("cannot open shared object")) {
      return false;
    }
    // A healthy binary prints project-specific log lines when it tries to load the model.
    const isOk = lower.includes("stable-diffusion.cpp") || lower.includes("loading model");
    if (isOk) {
      backendSupportsFlags[binaryPath] = supportsFlags;
    }
    return isOk;
  } catch (_) {
    return false;
  }
}

function selectBackendPath(useGpu, backendType = "auto", modelPath = "") {
  const resolvedType = resolveBackendType(useGpu, backendType, modelPath);
  if (osPlatform === "win32") {
    if (resolvedType === "cuda" && fs.existsSync(BACKEND_PATHS.cuda)) return BACKEND_PATHS.cuda;
    if (fs.existsSync(BACKEND_PATHS.vulkan)) return BACKEND_PATHS.vulkan;
    return BACKEND_PATH;
  }
  if (osPlatform === "linux") {
    let finalType = resolvedType;
    if (finalType === "cuda") {
      if (fs.existsSync(BACKEND_PATHS.linuxCuda)) {
        return BACKEND_PATHS.linuxCuda;
      }
      finalType = "vulkan";
    }
    if (finalType === "rocm" && fs.existsSync(BACKEND_PATHS.linuxRocm)) return BACKEND_PATHS.linuxRocm;
    if (resolvedType === "vulkan" && fs.existsSync(BACKEND_PATHS.linuxVulkan)) return BACKEND_PATHS.linuxVulkan;
    if (resolvedType === "cpu" && fs.existsSync(BACKEND_PATHS.linuxCpu)) return BACKEND_PATHS.linuxCpu;
    if (fs.existsSync(BACKEND_PATHS.linuxVulkan)) return BACKEND_PATHS.linuxVulkan;
    if (fs.existsSync(BACKEND_PATHS.linuxCpu)) return BACKEND_PATHS.linuxCpu;
    return BACKEND_PATH;
  }
  if (osPlatform === "darwin") {
    if (resolvedType === "apple-npu") return getCoreMLPythonPath();
    if (fs.existsSync(BACKEND_PATHS.mac)) return BACKEND_PATHS.mac;
    return BACKEND_PATH;
  }
  // generic fallback
  if (fs.existsSync(BACKEND_PATHS.mac)) return BACKEND_PATHS.mac;
  return BACKEND_PATH;
}

function resolveBackendType(useGpu, backendType = "auto", modelPath = "") {
  const options = getBackendOptions();
  let requestedType = useGpu === false ? "cpu" : backendType === "auto" ? options.defaultBackendType : backendType;

  if (modelPath && osPlatform === "darwin") {
    const lower = modelPath.toLowerCase();
    const isDir = fs.existsSync(modelPath) && fs.statSync(modelPath).isDirectory();
    if (lower.endsWith(".safetensors") || lower.endsWith(".gguf")) {
      if (requestedType === "apple-npu") requestedType = "metal";
    } else if (lower.endsWith(".coreml") || lower.endsWith(".mlpackage") || lower.endsWith(".mlmodelc") || isDir) {
      if (requestedType === "metal") requestedType = "apple-npu";
    }
  }

  const available = new Set(options.options.map(option => option.id));
  return available.has(requestedType) ? requestedType : options.defaultBackendType;
}

function getBackendMode(backendPath, useGpu, backendType = "auto") {
  if (useGpu === false || backendType === "cpu") return "CPU";
  const name = path.basename(backendPath || "").toLowerCase();
  if (name.includes("cuda")) return "CUDA GPU";
  if (name.includes("rocm")) return "ROCm GPU";
  if (name.includes("vulkan")) return "Vulkan GPU";
  if (backendType === "apple-npu") return "Apple NPU";
  if (osPlatform === "darwin" || backendType === "metal") return "Metal GPU";
  return "GPU";
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\[[A-Z]/g, "");
}

function markBackendReady() {
  if (backendReady) return;
  backendReady = true;
  backendLoadState = {
    ...backendLoadState,
    active: false,
    phase: "Model ready",
    progress: 100,
  };
  console.log("  [backend] READY on port", PORT_BACKEND);

  // Force a single VRAM poll after the model settles in memory
  setTimeout(() => pollNvidiaVram(true), 1500);
}

function pingBackendReady() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${PORT_BACKEND}/v1/models`, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function requestJson(url, payload = null, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = payload ? Buffer.from(JSON.stringify(payload), "utf8") : null;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: data ? "POST" : "GET",
      headers: data ? {
        "Content-Type": "application/json",
        "Content-Length": data.length,
      } : {},
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const jsonBody = JSON.parse(body || "{}");
          if (res.statusCode < 200 || res.statusCode >= 300 || jsonBody.ok === false) {
            reject(new Error(jsonBody.error || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(jsonBody);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    if (data) req.write(data);
    req.end();
  });
}

function requestHttpsJson(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Local-AI-Image-Generator/1.0",
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body || "null");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(parsed?.error || `Hugging Face returned HTTP ${res.statusCode}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Hugging Face returned invalid JSON: ${err.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Hugging Face request timed out")));
  });
}

function getModelParameterBillions(value) {
  const text = String(value || "");
  const matches = [...text.matchAll(/(?:^|[-_/ ])(\d+(?:\.\d+)?)\s*b(?:[-_/ ]|$)/gi)];
  if (matches.length === 0) return null;
  return Math.min(...matches.map((match) => Number(match[1])).filter(Number.isFinite));
}

function selectGgufFile(siblings = [], tier = "low") {
  const files = siblings
    .map((item) => typeof item === "string" ? item : item?.rfilename)
    .filter((name) => name && /\.gguf$/i.test(name))
    .filter((name) => !/(?:^|\/)(?:mmproj|mtp)(?:[-_/]|$)|-\d{5}-of-\d{5}\.gguf$/i.test(name));
  const preferences = tier === "high"
    ? [/q6_k\.gguf$/i, /q5_k_m\.gguf$/i, /q4_k_m\.gguf$/i, /q8_0\.gguf$/i]
    : [/q4_k_m\.gguf$/i, /q4_k_s\.gguf$/i, /q4_0\.gguf$/i, /q3_k_m\.gguf$/i, /iq4_xs\.gguf$/i];
  for (const pattern of preferences) {
    const match = files.find((name) => pattern.test(name));
    if (match) return match;
  }
  return files[0] || "";
}

function classifyHuggingFaceModel(model, filename) {
  const searchable = `${model.id || ""} ${filename || ""} ${(model.tags || []).join(" ")}`.toLowerCase();
  const parameters = getModelParameterBillions(searchable);
  return {
    potato: parameters !== null && parameters <= 3,
    vision: /(?:vision|llava|multimodal|(?:^|[-_/ ])vl(?:[-_/ ]|$)|moondream)/i.test(searchable),
    uncensored: /uncensored|abliterated|heretic/i.test(searchable),
    parameters,
  };
}

function getTextModelFit(sizeBytes, specs = getHardwareSpecs()) {
  if (!sizeBytes) {
    return { recommended: false, mode: "unknown", label: "", reason: "File size is unavailable, so compatibility cannot be estimated." };
  }

  const ramBytes = Math.max(0, Number(specs.ram_total_gb) || 0) * (1024 ** 3);
  const vramBytes = Math.max(0, Number(specs.gpu_vram_gb) || 0) * (1024 ** 3);
  const isAppleSilicon = osPlatform === "darwin" && /apple/i.test(String(specs.cpu_name || ""));
  const systemReserve = Math.max(4 * (1024 ** 3), ramBytes * 0.3);
  const usableRam = Math.max(0, ramBytes - systemReserve);
  const runtimeNeed = (sizeBytes * 1.25) + (1.5 * (1024 ** 3));
  const fastGpuFit = vramBytes >= runtimeNeed;
  const cpuOrOffloadFit = usableRam >= runtimeNeed;
  const unifiedMemoryFit = isAppleSilicon && usableRam >= runtimeNeed;
  const recommended = fastGpuFit || cpuOrOffloadFit || unifiedMemoryFit;

  if (recommended) {
    const mode = fastGpuFit ? "GPU memory" : isAppleSilicon ? "unified memory" : "system RAM with CPU/GPU offload";
    return {
      recommended: true,
      mode: fastGpuFit ? "gpu" : isAppleSilicon ? "unified" : "ram",
      label: fastGpuFit ? "GPU Fit" : isAppleSilicon ? "Fits Unified Memory" : "Fits in RAM",
      reason: `${formatBytes(sizeBytes)} weights fit the estimated ${mode} budget with runtime headroom.`,
    };
  }

  return {
    recommended: false,
    mode: "too-large",
    label: "",
    reason: `${formatBytes(sizeBytes)} weights need about ${formatBytes(runtimeNeed)} including runtime headroom; this computer has about ${formatBytes(usableRam)} usable RAM and ${formatBytes(vramBytes)} VRAM.`,
  };
}

async function addHuggingFaceFileSize(model) {
  try {
    const detail = await requestHttpsJson(`https://huggingface.co/api/models/${model.id}?blobs=true`);
    const file = (detail.siblings || []).find((item) => item?.rfilename === model.repositoryFilename);
    const sizeBytes = Number(file?.size || file?.lfs?.size || 0);
    const fit = getTextModelFit(sizeBytes);
    return {
      ...model,
      sizeBytes,
      size: sizeBytes > 0 ? formatBytes(sizeBytes) : "Unknown",
      approxSize: sizeBytes > 0 ? formatBytes(sizeBytes) : model.approxSize,
      recommendedFit: fit.recommended,
      fitMode: fit.mode,
      fitLabel: fit.label,
      fitReason: fit.reason,
    };
  } catch (_) {
    return {
      ...model,
      sizeBytes: 0,
      size: "Unknown",
      recommendedFit: false,
      fitMode: "unknown",
      fitLabel: "",
      fitReason: "File size is unavailable, so compatibility cannot be estimated.",
    };
  }
}

async function searchHuggingFaceModels(query, filters) {
  const specs = getHardwareSpecs();
  const tier = specs.gpu_vram_gb >= 10 || specs.ram_total_gb >= 32
    ? "high"
    : specs.gpu_vram_gb >= 5 || specs.ram_total_gb >= 16 ? "mid" : "low";
  const defaultSearch = tier === "low" ? "1B instruct" : tier === "mid" ? "7B instruct" : "8B instruct";
  const searchTerms = [
    query.trim() || defaultSearch,
    filters.includes("vision") ? "vision" : "",
    filters.includes("uncensored") ? "uncensored" : "",
  ].filter(Boolean).join(" ");
  const cacheKey = `${tier}|${searchTerms}|${filters.sort().join(",")}`;
  const cached = hfModelCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < HF_MODEL_CACHE_TTL_MS) return cached.models;

  const params = new URLSearchParams({
    filter: "gguf",
    search: searchTerms,
    sort: "downloads",
    direction: "-1",
    limit: "50",
    full: "true",
  });
  const results = await requestHttpsJson(`https://huggingface.co/api/models?${params.toString()}`);
  const models = [];

  for (const model of Array.isArray(results) ? results : []) {
    if (model.private || model.gated || model.disabled) continue;
    const filename = selectGgufFile(model.siblings, tier);
    if (!filename) continue;
    const traits = classifyHuggingFaceModel(model, filename);
    if (filters.includes("potato") && !traits.potato) continue;
    if (filters.includes("vision") && !traits.vision) continue;
    if (filters.includes("uncensored") && !traits.uncensored) continue;

    const isLikelyChatModel = /instruct|chat|assistant|coder|uncensored|abliterated|vision|llava|\bvl\b/i.test(`${model.id} ${filename}`);
    if (!query.trim() && !isLikelyChatModel) continue;
    const normalizedQuery = query.trim().toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ");
    const normalizedModelName = `${model.id} ${filename}`.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ");
    const queryWords = normalizedQuery.split(" ").filter(Boolean);
    const exactPhraseMatch = normalizedQuery && normalizedModelName.includes(normalizedQuery);
    const matchedQueryWords = queryWords.filter((word) => normalizedModelName.includes(word)).length;
    const score = Number(model.downloads || 0)
      + (traits.potato && tier === "low" ? 10000000 : 0)
      + (traits.parameters && tier === "mid" && traits.parameters >= 4 && traits.parameters <= 9 ? 10000000 : 0)
      + (traits.parameters && tier === "high" && traits.parameters >= 7 && traits.parameters <= 14 ? 10000000 : 0)
      + (exactPhraseMatch ? 100000000 : 0)
      + (matchedQueryWords * 5000000);
    models.push({
      id: model.id,
      name: String(model.id || "").split("/").pop().replace(/[-_]+/g, " "),
      filename: path.basename(filename),
      repositoryFilename: filename,
      format: "GGUF",
      approxSize: traits.parameters ? `~${traits.parameters}B parameters` : "Size shown before download",
      resolution: "N/A",
      notes: `Community GGUF from ${String(model.id || "").split("/")[0]}. ${Number(model.downloads || 0).toLocaleString()} Hugging Face downloads.`,
      url: `https://huggingface.co/${model.id}/resolve/main/${filename.split("/").map(encodeURIComponent).join("/")}`,
      pageUrl: `https://huggingface.co/${model.id}`,
      downloads: Number(model.downloads || 0),
      likes: Number(model.likes || 0),
      tags: Object.entries(traits).filter(([key, value]) => key !== "parameters" && value).map(([key]) => key),
      score,
    });
  }

  const ranked = models.sort((a, b) => b.score - a.score);
  hfModelCache.set(cacheKey, { createdAt: Date.now(), models: ranked });
  return ranked;
}

async function killOpenVinoWorker() {
  if (!openvinoProc) {
    openvinoReady = false;
    return;
  }
  console.log("  [openvino-npu] Stopping worker...");
  try { openvinoProc.kill("SIGTERM"); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 800));
  try { openvinoProc.kill("SIGKILL"); } catch (_) {}
  openvinoProc = null;
  openvinoReady = false;
}

function getOpenVinoResolution(settings = {}) {
  const width = Number(settings.width) || 512;
  const height = Number(settings.height) || 512;
  const supported = (width === 512 && height === 512) || (width === 1024 && height === 1024);
  if (!supported) {
    throw new Error("OpenVINO NPU supports 512x512 generation or 1024x1024 HD upscale.");
  }
  return { width, height };
}

async function startOpenVinoWorker(settings = {}) {
  const npuInfo = getOpenVinoNpuInfo();
  if (!npuInfo.supported) throw new Error(npuInfo.reason || "OpenVINO NPU is not available.");
  const model = findOpenVinoModel(settings.model) || getOpenVinoModelInfo().find((item) => item.installed);
  if (!model || !model.installed) {
    throw new Error("OpenVINO NPU model is not downloaded. Download an OpenVINO NPU model from Model Manager first.");
  }
  const { width, height } = getOpenVinoResolution(settings);
  if (openvinoProc &&
      openvinoReady &&
      openvinoModel === model.id) {
    currentSettings = { ...currentSettings, ...settings, model: model.id, width, height };
    return;
  }

  await killBackend();
  await killOpenVinoWorker();
  openvinoError = null;
  openvinoReady = false;
  openvinoModel = model.id;
  openvinoWidth = 512;
  openvinoHeight = 512;
  openvinoPort = await findAvailableBackendPort();
  PORT_BACKEND = openvinoPort;

  currentSettings = { ...currentSettings, ...settings };
  currentSettings.backendType = "openvino-npu";
  currentSettings.useGpu = true;
  currentSettings.backendMode = "NPU (OpenVINO)";
  currentSettings.backendBinary = "openvino_npu_worker.py";
  currentSettings.backendDevice = npuInfo.npu?.name || "Intel AI Boost";
  currentSettings.model = model.id;
  currentSettings.width = width;
  currentSettings.height = height;

  backendError = null;
  backendLoadState = {
    active: true,
    phase: "Compiling OpenVINO NPU pipeline (512x512)...",
    progress: 5,
    current: 0,
    total: 0,
    speed: "",
    model: model.name,
    backendMode: "NPU (OpenVINO)",
    backendBinary: "openvino_npu_worker.py",
    device: currentSettings.backendDevice,
  };

  const workerPath = path.join(ROOT, "scripts", "openvino_npu_worker.py");
  const cacheDir = path.join(ROOT, "app", "tools", "openvino-cache", "512x512");
  console.log(`  [openvino-npu] Starting 512x512 worker on port ${openvinoPort}`);
  openvinoProc = spawn(npuInfo.python, [
    workerPath,
    "--model-dir", model.path,
    "--port", String(openvinoPort),
    "--width", "512",
    "--height", "512",
    "--cache-dir", cacheDir,
  ], { stdio: "pipe" });

  let openvinoStdoutBuffer = "";
  openvinoProc.stdout.on("data", (data) => {
    const text = data.toString();
    process.stdout.write("  " + text);
    openvinoStdoutBuffer += text;
    const lines = openvinoStdoutBuffer.split(/\r?\n/);
    openvinoStdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line.includes("READY")) {
        openvinoReady = true;
        backendReady = true;
        backendLoadState = { ...backendLoadState, active: false, phase: "OpenVINO NPU model ready", progress: 100 };
      }
      const progressMatch = line.match(/PROGRESS\s+(\d+)\/(\d+)\s+(.+)$/);
      if (progressMatch) {
        generationState.active = true;
        generationState.step = Number(progressMatch[1]);
        generationState.steps = Number(progressMatch[2]);
        generationState.speed = progressMatch[3].trim();
        generationState.decoding = false;
      } else if (line.includes("DECODING") && generationState.active) {
        generationState.step = generationState.steps;
        generationState.decoding = true;
        generationState.speed = "";
      }
    }
  });
  openvinoProc.stderr.on("data", (data) => {
    const text = data.toString();
    process.stderr.write("  " + text);
    const cleanText = stripAnsi(text).trim();
    if (cleanText && (cleanText.includes("ERROR") || cleanText.includes("Traceback") || cleanText.includes("Exception"))) {
      openvinoError = cleanText;
      backendError = openvinoError;
    }
  });
  openvinoProc.on("exit", (code) => {
    console.log("  [openvino-npu] worker exited with code", code);
    openvinoProc = null;
    openvinoReady = false;
    backendReady = false;
    if (code !== 0 && code !== null && !backendError) backendError = `OpenVINO NPU worker exited with code ${code}`;
    backendLoadState.active = false;
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 360000) {
    if (openvinoReady) return;
    if (backendError) throw new Error(backendError);
    if (!openvinoProc) throw new Error("OpenVINO NPU worker exited during startup.");
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    backendLoadState.progress = Math.min(95, 5 + Math.round(elapsed / 2));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await killOpenVinoWorker();
  throw new Error("OpenVINO NPU 512x512 compile timed out after 6 minutes.");
}

async function generateWithOpenVino(body) {
  if (!openvinoReady || !openvinoPort) throw new Error("OpenVINO NPU worker is not ready. Load an OpenVINO NPU model first.");
  const steps = Math.max(1, Math.min(8, Number(body.steps) || 4));
  generationState = { active: true, step: 0, steps, speed: "", decoding: false };
  try {
    const result = await requestJson(`http://127.0.0.1:${openvinoPort}/generate`, {
      prompt: body.prompt,
      negative_prompt: body.negative_prompt || "",
      width: Number(body.width) || currentSettings.width || 512,
      height: Number(body.height) || currentSettings.height || 512,
      steps,
      cfg_scale: Number(body.cfg_scale) || 1.0,
      seed: body.seed,
    }, 300000);
    resetGenerationState();
    return result;
  } catch (err) {
    resetGenerationState();
    throw err;
  }
}

function startBackendReadyPoll() {
  let attempts = 0;
  const isNpu = currentSettings.backendType === "apple-npu" || currentSettings.backendType === "openvino-npu";
  const maxAttempts = isNpu ? 1200 : 240;
  const interval = setInterval(async () => {
    attempts += 1;
    if (!backendProc || backendReady || attempts > maxAttempts) {
      clearInterval(interval);
      return;
    }
    if (await pingBackendReady()) {
      markBackendReady();
      clearInterval(interval);
    }
  }, 500);
}

function getDefaultModel() {
  try {
    const files = fs.readdirSync(MODELS).filter(isModelFile);
    return files.length ? path.join(MODELS, files[0]) : null;
  } catch (_) { return null; }
}

function killBackend() {
  return new Promise(resolve => {
    resetGenerationState();
    if (!backendProc) {
      backendUnloadState = { active: false, phase: "", progress: 0 };
      resolve();
      return;
    }
    backendUnloadState = { active: true, phase: "Stopping backend process...", progress: 10 };
    backendReady = false;
    backendProc.kill("SIGTERM");
    backendUnloadState = { active: true, phase: "Waiting for process exit...", progress: 50 };
    setTimeout(() => {
      try { backendProc.kill("SIGKILL"); } catch (_) {}
      backendProc = null;
      backendUnloadState = { active: false, phase: "Backend unloaded", progress: 100 };
      resolve();
    }, 2000);
  });
}

async function startLlm(settings = {}) {
  const filename = path.basename(String(settings.model || ""));
  const modelPath = path.join(LLM_MODELS, filename);
  if (!filename || !pathInside(modelPath, LLM_MODELS) || !fs.existsSync(modelPath)) {
    throw new Error("Select a downloaded GGUF text model first.");
  }
  if (!filename.toLowerCase().endsWith(".gguf")) {
    throw new Error("Text generation requires a .gguf model.");
  }

  const backend = getLlmBackend();
  if (!backend) {
    throw new Error("llama.cpp is not installed. Run the platform setup script to install the text backend.");
  }

  await killBackend();
  await killOpenVinoWorker();
  await killLlm();
  PORT_LLM = await findAvailableLlmPort();
  llmError = null;
  llmSettings = {
    ...llmSettings,
    model: filename,
    threads: Math.max(1, Math.min(64, Number(settings.threads) || llmSettings.threads)),
    contextSize: Math.max(512, Math.min(32768, Number(settings.contextSize) || 4096)),
    gpuLayers: Number.isFinite(Number(settings.gpuLayers)) ? Number(settings.gpuLayers) : -1,
    backendMode: backend.mode,
    backendBinary: path.basename(backend.path),
  };

  let mmprojPath = null;
  const lowerFilename = filename.toLowerCase();
  const isMultimodal = lowerFilename.includes("llava") ||
                       lowerFilename.includes("vision") ||
                       lowerFilename.includes("qwen2vl") ||
                       lowerFilename === "ggml-model-q4_k.gguf";

  if (isMultimodal) {
    if (settings.mmproj) {
      const customProjPath = path.join(LLM_MODELS, path.basename(settings.mmproj));
      if (fs.existsSync(customProjPath)) {
        mmprojPath = customProjPath;
      }
    }
    if (!mmprojPath) {
      try {
        const files = fs.readdirSync(LLM_MODELS);
        const mmprojFile = files.find(file => {
          const lower = file.toLowerCase();
          return lower.endsWith(".gguf") && (lower === "mmproj-model-f16.gguf" || lower.includes("mmproj"));
        });
        if (mmprojFile) {
          mmprojPath = path.join(LLM_MODELS, mmprojFile);
        }
      } catch (_) {}
    }
  }

  const args = [
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(PORT_LLM),
    "--ctx-size", String(llmSettings.contextSize),
    "--threads", String(llmSettings.threads),
    "--n-gpu-layers", String(llmSettings.gpuLayers),
  ];
  if (mmprojPath) {
    args.push("--mmproj", mmprojPath);
  }
  const spawnEnv = { ...process.env };
  const backendDir = path.dirname(backend.path);
  if (osPlatform === "linux") {
    spawnEnv.LD_LIBRARY_PATH = backendDir + (spawnEnv.LD_LIBRARY_PATH ? `:${spawnEnv.LD_LIBRARY_PATH}` : "");
  } else if (osPlatform === "darwin") {
    spawnEnv.DYLD_LIBRARY_PATH = backendDir + (spawnEnv.DYLD_LIBRARY_PATH ? `:${spawnEnv.DYLD_LIBRARY_PATH}` : "");
  }

  console.log("  [llm] Starting:", backend.path, args.join(" "));
  llmProc = spawn(backend.path, args, { stdio: "pipe", env: spawnEnv });
  llmProc.stdout.on("data", (data) => process.stdout.write("  [llm] " + data.toString()));
  llmProc.stderr.on("data", (data) => {
    const output = data.toString();
    process.stderr.write("  [llm-err] " + output);
    if (/Vulkan\d+\s*:/i.test(output)) llmSettings.backendMode = "Vulkan GPU";
    else if (/Metal/i.test(output) && /GPU|device/i.test(output)) llmSettings.backendMode = "Metal GPU";
    else if (/\-\s+CPU\s+:/i.test(output) && llmSettings.backendMode.startsWith("Auto")) llmSettings.backendMode = "CPU";
    if (/error|failed/i.test(output) && !/no error/i.test(output)) {
      llmError = output.trim().slice(-1200);
    }
  });
  llmProc.on("exit", (code) => {
    llmReady = false;
    llmProc = null;
    if (code !== 0 && code !== null && !llmError) llmError = `llama.cpp exited with code ${code}`;
    console.log("  [llm] exited with code", code);
  });

  await waitForLlmReady();
}

async function startBackend(settings = {}) {
  await killLlm();
  if (settings.backendType === "openvino-npu") {
    await startOpenVinoWorker(settings);
    return;
  }
  await killOpenVinoWorker();
  backendError = null;
  currentSettings = { ...currentSettings, ...settings };
  if (!currentSettings.model) currentSettings.model = getDefaultModel();
  if (!currentSettings.model) {
    console.log("  [backend] No model found in app/models/ — backend not started");
    return;
  }

  const modelLoadIssue = getModelLoadIssue(currentSettings.model);
  if (modelLoadIssue) {
    backendError = modelLoadIssue;
    backendLoadState = {
      active: false,
      phase: "Model load blocked",
      progress: 0,
      current: 0,
      total: 0,
      speed: "",
      model: path.basename(currentSettings.model),
      backendMode: "",
      backendBinary: "",
      device: "",
    };
    throw new Error(modelLoadIssue);
  }

  PORT_BACKEND = await findAvailableBackendPort();

  const resolvedBackendType = resolveBackendType(currentSettings.useGpu, currentSettings.backendType, currentSettings.model);
  currentSettings.backendType = resolvedBackendType;
  currentSettings.useGpu = resolvedBackendType !== "cpu";
  const backendPath = selectBackendPath(currentSettings.useGpu, currentSettings.backendType, currentSettings.model);
  const backendMode = getBackendMode(backendPath, currentSettings.useGpu, currentSettings.backendType);
  currentSettings.backendMode = backendMode;
  currentSettings.backendBinary = path.basename(backendPath);

  backendLoadState = {
    active: true,
    phase: "Starting backend...",
    progress: 0,
    current: 0,
    total: 0,
    speed: "",
    model: path.basename(currentSettings.model),
    backendMode,
    backendBinary: path.basename(backendPath),
    device: "",
  };

  let runThreads = parseInt(currentSettings.threads) || 4;
  if (currentSettings.useGpu) {
    runThreads = Math.min(4, runThreads);
  }

  let args = [];
  const requestedBackend = resolveBackendType(currentSettings.useGpu, currentSettings.backendType, currentSettings.model);

  const supportsFlags = backendSupportsFlags[backendPath] !== false;

  if (requestedBackend === "apple-npu") {
    args = [
      path.join(ROOT, "app", "backend", "mac", "coreml_server.py"),
      "--listen-port", String(PORT_BACKEND),
      "--model",       currentSettings.model,
      "--steps",       String(currentSettings.steps),
      "--cfg-scale",   String(currentSettings.cfgScale),
    ];
  } else {
    args = [
      "--listen-port", String(PORT_BACKEND),
      "--model",       currentSettings.model,
      "--steps",       String(currentSettings.steps),
      "--cfg-scale",   String(currentSettings.cfgScale),
      "--sampling-method", currentSettings.sampler,
      "--threads",     String(runThreads),
    ];

    if (requestedBackend === "cpu") {
      if (supportsFlags) {
        args.push("--backend", "cpu", "--params-backend", "cpu");
      }
      args.push("--rng", "cpu", "--sampler-rng", "cpu");
  } else if (requestedBackend === "vulkan") {
    if (supportsFlags) {
      args.push("--backend", "vulkan0", "--params-backend", "vulkan0");
    }
    args.push("--rng", "cpu", "--sampler-rng", "cpu");
  } else if (requestedBackend === "cuda") {
    if (supportsFlags) {
      args.push("--backend", "cuda0", "--params-backend", "cuda0");
    }
    args.push("--rng", "cuda", "--sampler-rng", "cuda");
  } else if (requestedBackend === "rocm") {
    if (supportsFlags) {
      args.push("--backend", "rocm0", "--params-backend", "rocm0");
    }
    args.push("--rng", "cpu", "--sampler-rng", "cpu");
  } else if (requestedBackend === "metal") {
    args.push("--rng", "cpu", "--sampler-rng", "cpu");
  }

  }

  if (requestedBackend !== "apple-npu") {
    if (currentSettings.vaeTiling) {
      args.push("--vae-tiling");
    }
    if (currentSettings.vaeOnCpu) {
      args.push("--vae-on-cpu");
    }
    if (currentSettings.flashAttn) {
      if (requestedBackend === "cuda") {
        args.push("--diffusion-fa");
      } else {
        args.push("--fa");
      }
    }
  }

  // Build environment for Linux backends so bundled .so libraries are found.
  // Official Linux releases ship libstable-diffusion.so next to the executable.
  const spawnEnv = { ...process.env };
  if (osPlatform === "linux") {
    const extraLibs = [];
    if (requestedBackend === "rocm") {
      extraLibs.push(path.dirname(BACKEND_PATHS.linuxRocm));
    } else if (requestedBackend === "vulkan") {
      extraLibs.push(path.dirname(BACKEND_PATHS.linuxVulkan));
    } else if (requestedBackend === "cpu") {
      extraLibs.push(path.dirname(BACKEND_PATHS.linuxCpu));
    } else if (requestedBackend === "cuda") {
      extraLibs.push(path.dirname(BACKEND_PATHS.linuxCuda));
    }
    if (extraLibs.length > 0) {
      const existing = spawnEnv.LD_LIBRARY_PATH || "";
      spawnEnv.LD_LIBRARY_PATH = extraLibs.join(":") + (existing ? ":" + existing : "");
    }
  } else if (osPlatform === "darwin" && requestedBackend !== "apple-npu") {
    const existing = spawnEnv.DYLD_LIBRARY_PATH || "";
    const backendDir = path.dirname(BACKEND_PATHS.mac);
    spawnEnv.DYLD_LIBRARY_PATH = backendDir + (existing ? ":" + existing : "");
  }

  console.log("  [backend] Starting:", path.basename(backendPath), args.join(" "));
  backendReady = false;

  backendProc = spawn(backendPath, args, { stdio: "pipe", env: spawnEnv });
  startBackendReadyPoll();

  backendProc.stdout.on("data", d => {
    const output = d.toString();
    process.stdout.write("  [sd] " + output);
    const cleanOutput = stripAnsi(output);
    if (cleanOutput.includes("listening on")) {
      markBackendReady();
    }
    
    const lines = output.split(/[\r\n]+/);
    for (const line of lines) {
      const cleanLine = stripAnsi(line);
      if (!cleanLine.trim()) continue;
      
      if (cleanLine.includes("listening on")) {
        markBackendReady();
      }

      if (cleanLine.includes("loading model from")) {
        backendLoadState.active = true;
        backendLoadState.phase = "Loading model weights...";
        backendLoadState.progress = Math.max(backendLoadState.progress, 1);
      }

      if (cleanLine.includes("model files processing completed")) {
        backendLoadState.active = true;
        backendLoadState.phase = "Initializing model...";
        backendLoadState.progress = Math.max(backendLoadState.progress, 95);
      }

      const loadMatch = cleanLine.match(/\|\s*(\d+)\/(\d+)\s*-\s*([^|]+)$/);
      if (loadMatch && !cleanLine.includes("it/s") && !cleanLine.includes("s/it")) {
        const current = parseInt(loadMatch[1], 10);
        const total = parseInt(loadMatch[2], 10);
        const progress = total > 0 ? Math.round((current / total) * 100) : 0;
        const isCoreML = currentSettings.backendType === "apple-npu" || total <= 10;
        const phaseDesc = isCoreML ? stripAnsi(loadMatch[3]).trim() : "Loading model weights...";
        const speedDesc = isCoreML ? "" : stripAnsi(loadMatch[3]).trim();
        backendLoadState = {
          ...backendLoadState,
          active: !backendReady,
          phase: phaseDesc,
          progress: Math.max(backendLoadState.progress, Math.min(99, progress)),
          current,
          total,
          speed: speedDesc,
        };
      }
      
      if (cleanLine.includes("generate_image") || cleanLine.includes("generating image")) {
        generationState.active = true;
        generationState.step = 0;
        generationState.steps = 0;
        generationState.speed = "";
        generationState.decoding = false;
      }
      
      if (cleanLine.includes("decoding") && generationState.active) {
        generationState.decoding = true;
      }
      
      const match = cleanLine.match(/\|\s*[^|]*\s*\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+\s*(?:it\/s|s\/it))/);
      if (match) {
        generationState.active = true;
        if (!generationState.decoding) {
          generationState.step = parseInt(match[1], 10);
          generationState.steps = parseInt(match[2], 10);
          generationState.speed = match[3].trim();
        }
      }
      
      if (cleanLine.includes("generate_image completed")) {
        generationState.active = false;
        generationState.step = 0;
        generationState.steps = 0;
        generationState.speed = "";
        generationState.decoding = false;
      }
    }
  });

  backendProc.stderr.on("data", d => {
    const output = d.toString();
    process.stderr.write("  [sd-err] " + output);
    const cleanOutput = stripAnsi(output);
    const deviceMatch = cleanOutput.match(/Device\s+\d+:\s*([^,\r\n]+)/);
    if (deviceMatch) {
      backendLoadState.device = deviceMatch[1].trim();
      currentSettings.backendDevice = backendLoadState.device;
    }
    const metalDeviceMatch = cleanOutput.match(/GPU name:\s*([^\r\n]+)/);
    if (metalDeviceMatch) {
      backendLoadState.device = metalDeviceMatch[1].trim();
      currentSettings.backendDevice = backendLoadState.device;
    }
    if (cleanOutput.includes("ggml_cuda_init")) {
      backendLoadState.backendMode = "CUDA GPU";
      currentSettings.backendMode = "CUDA GPU";
    }
    if (cleanOutput.includes("ggml_vulkan")) {
      backendLoadState.backendMode = "Vulkan GPU";
      currentSettings.backendMode = "Vulkan GPU";
    }
    if (cleanOutput.includes("ggml_hip") || cleanOutput.includes("ggml_rocm")) {
      backendLoadState.backendMode = "ROCm GPU";
      currentSettings.backendMode = "ROCm GPU";
    }
    if (cleanOutput.includes("ggml_metal")) {
      backendLoadState.backendMode = "Metal GPU";
      currentSettings.backendMode = "Metal GPU";
    }
    if (cleanOutput.includes("[ERROR]")) {
      const nextError = describeBackendError(cleanOutput.trim(), currentSettings.model);
      const hasSpecificFileError = String(backendError || "").includes("incomplete or corrupted");
      const isGenericContextError = cleanOutput.includes("new_sd_ctx_t failed");
      if (!(hasSpecificFileError && isGenericContextError)) {
        backendError = nextError;
      }
    }
  });
  backendProc.on("exit", code => {
    backendReady = false;
    backendProc  = null;
    console.log("  [backend] exited with code", code);
    if (code !== null && code !== 0) {
      if (!backendError) {
        backendError = describeBackendExitCode(code, currentSettings.backendBinary || BACKEND_PATH);
      }
    }
    backendLoadState.active = false;
    generationState.active = false;
    generationState.step = 0;
    generationState.steps = 0;
    generationState.speed = "";
    generationState.decoding = false;

    // Force a VRAM poll to update free memory space
    setTimeout(() => pollNvidiaVram(true), 1000);
  });
}

// ── Model Downloader ─────────────────────────────────────────────────────────
let downloadState = {
  active: false,
  filename: "",
  progress: 0,
  speed: "0 MB/s",
  eta: 0,
  totalBytes: 0,
  downloadedBytes: 0,
  error: null
};
let activeDownload = null;

function startOpenVinoModelDownload(modelId) {
  if (downloadState.active) return;
  const npuInfo = getOpenVinoNpuInfo();
  if (!npuInfo.supported) throw new Error(npuInfo.reason || "OpenVINO NPU runtime is not available.");
  const model = OPENVINO_NPU_MODELS.find((item) => item.id === modelId);
  if (!model) throw new Error("Unknown OpenVINO model.");

  const destDir = path.join(OPENVINO_MODELS, model.folder);
  fs.mkdirSync(destDir, { recursive: true });
  downloadState = {
    active: true,
    filename: model.name,
    progress: -1,
    speed: "Downloading snapshot",
    eta: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    error: null,
  };

  const script = [
    "from huggingface_hub import snapshot_download",
    `snapshot_download(repo_id=${JSON.stringify(model.repo)}, local_dir=${JSON.stringify(destDir)}, ignore_patterns=['safety_checker/*','feature_extractor/*','*.safetensors'])`,
    "print('DONE')",
  ].join("\n");
  console.log(`  [openvino-download] Downloading ${model.repo} -> ${destDir}`);
  const proc = spawn(npuInfo.python, ["-c", script], { stdio: "pipe" });
  activeDownload = { process: proc, destPath: destDir, openvino: true };
  proc.stdout.on("data", (data) => process.stdout.write("  [openvino-download] " + data.toString()));
  proc.stderr.on("data", (data) => process.stderr.write("  [openvino-download] " + data.toString()));
  proc.on("exit", (code) => {
    activeDownload = null;
    if (String(downloadState.error || "").toLowerCase().includes("cancelled")) {
      return;
    }
    downloadState.active = false;
    if (code === 0) {
      downloadState.progress = 100;
      downloadState.downloadedBytes = getPathSize(destDir);
      downloadState.totalBytes = downloadState.downloadedBytes;
      downloadState.speed = "Complete";
      cachedBackendOptions = null;
    } else {
      downloadState.error = `OpenVINO model download failed with code ${code}`;
    }
  });
}

// ── Generation State (Real-time progress parser) ─────────────────────────────
let generationState = {
  active: false,
  step: 0,
  steps: 0,
  speed: "",
  decoding: false,
};

function resetGenerationState() {
  generationState = {
    active: false,
    step: 0,
    steps: 0,
    speed: "",
    decoding: false,
  };
}

function describeDownloadHttpError(statusCode, url, headers = {}) {
  const host = (() => {
    try { return new URL(url).hostname; } catch (_) { return ""; }
  })();
  const isHuggingFace = host.includes("huggingface.co") || host.includes("hf.co");
  const hfErrorCode = headers["x-error-code"];
  const hfErrorMessage = headers["x-error-message"];

  if (isHuggingFace && hfErrorCode === "GatedRepo") {
    return `HTTP ${statusCode}: Hugging Face says this model is gated. Open the model page in your browser, accept access/login, then use a Hugging Face token or download the file manually.`;
  }
  if (isHuggingFace && hfErrorMessage) {
    return `HTTP ${statusCode}: Hugging Face rejected the download request: ${hfErrorMessage}`;
  }

  if (statusCode === 401 || statusCode === 403) {
    return isHuggingFace
      ? `HTTP ${statusCode}: Hugging Face rejected the download request. If this model is public, retry after restarting the app; otherwise open the model page in your browser and accept any license/login requirement.`
      : `HTTP ${statusCode}: This download URL requires authorization or permission. Use a public direct download URL.`;
  }
  if (statusCode === 404) {
    return `HTTP 404: Model file not found. Check that the URL points directly to a .safetensors, .gguf, or .ckpt file.`;
  }
  return `HTTP ${statusCode}`;
}

function startModelDownload(url, overrideFilename = null, targetDir = MODELS, kind = "image", redirectCount = 0) {
  if (downloadState.active && !overrideFilename) {
    console.log("  [download] Already downloading a model");
    return;
  }

  // Convert HuggingFace viewer URL (/blob/) to direct download URL (/resolve/)
  if (url.includes("huggingface.co") && url.includes("/blob/")) {
    url = url.replace("/blob/", "/resolve/");
  }

  let filename = overrideFilename;
  if (!filename) {
    filename = "model.gguf";
    try {
      const parsed = new URL(url);
      filename = path.basename(parsed.pathname);
    } catch (e) {
      console.error("Failed to parse URL filename:", e);
    }
  }

  const destPath = path.join(targetDir, filename);
  const tempPath = `${destPath}.part`;
  try { fs.unlinkSync(tempPath); } catch (_) {}
  downloadState = {
    active: true,
    filename: filename,
    progress: 0,
    speed: "0 MB/s",
    eta: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    error: null,
    kind,
  };

  console.log(`  [download] Starting download of ${filename} from ${url}`);

  let downloadFinalized = false;
  const failDownload = (message, err = null) => {
    if (downloadFinalized) return;
    downloadFinalized = true;
    downloadState.active = false;
    downloadState.error = message;
    if (err) {
      console.error("  [download]", message, err);
    } else {
      console.error("  [download] Failed:", message);
    }
    try { fileStream.close(); } catch (_) {}
    try { fs.unlinkSync(tempPath); } catch (_) {}
    activeDownload = null;
  };

  const fileStream = fs.createWriteStream(tempPath);
  fileStream.on("error", (err) => {
    failDownload(`Could not write ${filename}: ${err.message}`, err);
  });
  
  const client = url.startsWith("https") ? https : http;
  const request = client.get(url, {
    headers: {
      "User-Agent": "Local-AI-Image-Generator/1.0 (+https://github.com/techjarves/Local-AI-Image-Generator)",
      "Accept": "application/octet-stream, application/x-safetensors, */*",
      "Referer": "https://huggingface.co/",
    },
  }, (response) => {
    activeDownload = { request, fileStream, destPath, tempPath };
    // Handle redirects (HuggingFace resolve URLs redirect to Cloudfront/S3)
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const redirectUrl = response.headers.location ? new URL(response.headers.location, url).toString() : "";
      if (!redirectUrl) {
        failDownload("Redirect response did not include a Location header");
        return;
      }
      if (redirectCount > 10) {
        failDownload("Too many redirects");
        return;
      }
      console.log(`  [download] Redirected to ${redirectUrl}`);
      
      // Clean up redirected request to avoid triggering error handlers later
      request.removeAllListeners("error");
      request.destroy();
      
      fileStream.close();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      activeDownload = null;
      downloadState.active = false;
      startModelDownload(redirectUrl, filename, targetDir, kind, redirectCount + 1);
      return;
    }

    if (response.statusCode !== 200) {
      failDownload(describeDownloadHttpError(response.statusCode, url, response.headers));
      return;
    }

    const totalBytes = parseInt(response.headers["content-length"], 10) || 0;
    downloadState.totalBytes = totalBytes;
    let downloadedBytes = 0;
    let startTime = Date.now();
    let lastTime = startTime;
    let lastDownloaded = 0;

    response.on("data", (chunk) => {
      downloadedBytes += chunk.length;
      downloadState.downloadedBytes = downloadedBytes;
      fileStream.write(chunk);

      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed >= 0.5) {
        const chunkSpeed = (downloadedBytes - lastDownloaded) / elapsed; // bytes/sec
        lastDownloaded = downloadedBytes;
        lastTime = now;

        const speedMb = (chunkSpeed / (1024 * 1024)).toFixed(1);
        downloadState.speed = `${speedMb} MB/s`;

        if (totalBytes > 0) {
          downloadState.progress = Math.round((downloadedBytes / totalBytes) * 100);
          const remainingBytes = totalBytes - downloadedBytes;
          downloadState.eta = Math.round(remainingBytes / chunkSpeed);
        } else {
          downloadState.progress = -1; // Indeterminate
          downloadState.eta = -1;
        }
      }
    });

    response.on("aborted", () => {
      failDownload(`Download interrupted before ${filename} finished. Delete and retry the model download.`);
    });

    response.on("error", (err) => {
      failDownload(`Download stream failed before ${filename} finished. Delete and retry the model download.`, err);
    });

    response.on("end", () => {
      if (downloadFinalized) return;
      if (totalBytes > 0 && downloadedBytes !== totalBytes) {
        failDownload(`Download incomplete for ${filename}: received ${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}. Delete and retry the model download.`);
        return;
      }

      fileStream.end(() => {
        try {
          if (totalBytes > 0) {
            const writtenBytes = fs.statSync(tempPath).size;
            if (writtenBytes !== totalBytes) {
              failDownload(`Download incomplete for ${filename}: wrote ${formatBytes(writtenBytes)} of ${formatBytes(totalBytes)}. Delete and retry the model download.`);
              return;
            }
          }
          try { fs.unlinkSync(destPath); } catch (_) {}
          fs.renameSync(tempPath, destPath);

          if (destPath.toLowerCase().endsWith(".zip")) {
            try {
              const { execSync } = require("child_process");
              execSync(`unzip -o "${destPath}" -d "${path.dirname(destPath)}"`, { stdio: "ignore" });
              fs.unlinkSync(destPath);
            } catch(err) {
              console.error("Failed to unzip", err);
            }
          }

          downloadState.active = false;
          downloadFinalized = true;
          downloadState.progress = 100;
          downloadState.downloadedBytes = downloadedBytes;
          downloadState.error = null;
          activeDownload = null;
          console.log(`  [download] Completed download of ${filename}`);
        } catch (err) {
          failDownload(`Could not finalize ${filename}: ${err.message}`);
        }
      });
    });
  });

  request.on("error", (err) => {
    failDownload(err.message, err);
  });
  activeDownload = { request, fileStream, destPath, tempPath };
}

function cancelModelDownload() {
  if (!downloadState.active) {
    return false;
  }
  const filename = downloadState.filename;
  if (activeDownload) {
    if (activeDownload.process) {
      try { activeDownload.process.kill("SIGTERM"); } catch (_) {}
      setTimeout(() => { try { activeDownload?.process?.kill("SIGKILL"); } catch (_) {} }, 1000);
    } else {
      try { activeDownload.request.destroy(new Error("Download cancelled by user")); } catch (_) {}
      try { activeDownload.fileStream.destroy(); } catch (_) {}
      try { fs.unlinkSync(activeDownload.tempPath || activeDownload.destPath); } catch (_) {}
    }
  } else if (filename) {
    const targetDir = downloadState.kind === "text" ? LLM_MODELS : MODELS;
    try { fs.unlinkSync(`${path.join(targetDir, filename)}.part`); } catch (_) {}
  }
  activeDownload = null;
  downloadState = {
    active: false,
    filename,
    progress: 0,
    speed: "0 MB/s",
    eta: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    error: "Download cancelled",
    kind: downloadState.kind || "image",
  };
  console.log(`  [download] Cancelled download of ${filename}`);
  return true;
}

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html", ".js": "application/javascript",
  ".css":  "text/css",  ".png": "image/png",
  ".jpg":  "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico":  "image/x-icon", ".json": "application/json",
  ".woff2":"font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};

function isModelFile(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".safetensors") || lower.endsWith(".gguf") || lower.endsWith(".ckpt") || lower.endsWith(".coreml") || lower.endsWith(".coreml.zip")) {
    return true;
  }
  const fullPath = path.join(MODELS, filename);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(fullPath).map(f => f.toLowerCase());
      const hasTextEncoder = files.includes("text_encoder.mlpackage") || 
                             files.includes("text_encoder.mlmodelc") ||
                             files.includes("textencoder.mlpackage") || 
                             files.includes("textencoder.mlmodelc");
      
      const hasUnet = files.includes("unet.mlpackage") || 
                      files.includes("unet.mlmodelc");
                      
      if (hasTextEncoder && hasUnet) return true;
      
      const checkSubdirs = ["split_einsum/packages", "split_einsum/compiled", "original/packages", "original/compiled", "split_einsum", "original"];
      for (const subdir of checkSubdirs) {
        const subPath = path.join(fullPath, subdir);
        if (fs.existsSync(subPath)) {
          const subFiles = fs.readdirSync(subPath).map(f => f.toLowerCase());
          const subTextEncoder = subFiles.includes("text_encoder.mlpackage") || 
                                 subFiles.includes("text_encoder.mlmodelc") ||
                                 subFiles.includes("textencoder.mlpackage") || 
                                 subFiles.includes("textencoder.mlmodelc");
          const subUnet = subFiles.includes("unet.mlpackage") || 
                          subFiles.includes("unet.mlmodelc");
          if (subTextEncoder && subUnet) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function getModelLoadIssue(modelPath) {
  const filename = path.basename(modelPath || "");
  const lower = filename.toLowerCase();
  const ext = path.extname(lower);
  if (!modelPath || !fs.existsSync(modelPath)) {
    return `Model file not found: ${filename || "unknown model"}`;
  }

  const size = getPathSize(modelPath);
  if (size < 128 * 1024 * 1024) {
    return `${filename} is too small to be a complete image model (${formatBytes(size)}). Delete it and download/import it again.`;
  }

  if (ext === ".gguf") {
    const knownDiffusionOnlyGguf =
      lower === "stable-diffusion-xl-base-1.0-q4_0.gguf" ||
      lower.includes("stable-diffusion-xl-base-1.0");
    const requiresSeparateComponents =
      knownDiffusionOnlyGguf ||
      lower.includes("z_image") ||
      lower.includes("z-image") ||
      lower.includes("zimage") ||
      lower.includes("qwen") ||
      lower.includes("hidream") ||
      lower.includes("hunyuan") ||
      lower.includes("wan") ||
      lower.includes("flux");

    if (requiresSeparateComponents) {
      if (knownDiffusionOnlyGguf) {
        return `${filename} is not supported as a one-click model in this app. This SDXL GGUF is a diffusion-only component and needs matching VAE/text encoder files instead of being loaded with --model. Use one of the recommended Safetensors SDXL/SD 1.5 checkpoints, or import a complete single-file GGUF checkpoint.`;
      }
      return `${filename} looks like a multi-file diffusion GGUF. This app currently loads single-file SD 1.5/SDXL checkpoints directly. Models like Z-Image, Qwen, Flux, HiDream, Hunyuan, and Wan usually need extra files such as VAE/text encoders and must be launched with --diffusion-model instead of --model.`;
    }
  }

  return null;
}

function describeBackendError(rawError, modelPath) {
  const raw = String(rawError || "").trim();
  const filename = path.basename(modelPath || "");
  const lower = filename.toLowerCase();

  if (raw.includes("read tensor data failed") || raw.includes("load tensors from file failed")) {
    return `${raw}\n\n${filename || "The selected model"} is present but appears incomplete or corrupted. Delete it from Local Models and download/import it again.`;
  }

  if (!raw.includes("new_sd_ctx_t failed")) return raw;

  if (lower.endsWith(".gguf")) {
    if (lower === "stable-diffusion-xl-base-1.0-q4_0.gguf" || lower.includes("stable-diffusion-xl-base-1.0")) {
      return `${raw}\n\n${filename} is not supported as a one-click model in this app. This SDXL GGUF is a diffusion-only component and needs matching VAE/text encoder files instead of being loaded with --model. Use one of the recommended Safetensors SDXL/SD 1.5 checkpoints, or import a complete single-file GGUF checkpoint.`;
    }
    return `${raw}\n\n${filename} could not be loaded as a single checkpoint. Some GGUF files are only the diffusion part of a larger workflow and need separate VAE/text encoder files. Try a recommended SD 1.5/SDXL model, or re-download/import the file if this is meant to be a single-file SD/SDXL GGUF.`;
  }

  return `${raw}\n\nThe backend could not create the model context. Common causes are a corrupt/incomplete model file, unsupported checkpoint type, or not enough free RAM/VRAM. Delete and re-download the model, then try CPU or Vulkan mode at 512x512.`;
}

function describeBackendExitCode(code, backendPath) {
  const numericCode = Number(code);
  if (osPlatform === "win32" && numericCode === 3221225781) {
    const backendName = path.basename(backendPath || BACKEND_PATH || "backend");
    const lowerBackend = backendName.toLowerCase();
    const isVulkan = lowerBackend.includes("vulkan");
    const isCuda = lowerBackend.includes("cuda");
    const likelyMissing = isVulkan
      ? "the Vulkan runtime/driver DLL, such as vulkan-1.dll"
      : isCuda
        ? "a CUDA runtime DLL or NVIDIA driver component"
        : "a required backend DLL";
    const driverHint = isVulkan
      ? "Install or update the GPU vendor driver with Vulkan support, then run setup again so the Vulkan backend folder is repaired."
      : isCuda
        ? "Install or update the NVIDIA driver, then run setup again so the CUDA backend folder is repaired."
        : "Update the GPU driver, then run setup again so the backend folder is repaired.";

    return `exited with code ${code} (0xC0000135: required DLL not found).\n\nWindows could not start ${backendName} because ${likelyMissing} is missing or not loadable. ${driverHint}\n\nIf you are using an AMD/Intel GPU, update the AMD/Intel graphics driver first. If the GPU is too old for the current Vulkan backend, switch the backend to CPU.`;
  }

  return `exited with code ${code}`;
}

function getModelInfo(filename) {
  const safeFilename = path.basename(filename || "");
  const fullPath = path.join(MODELS, safeFilename);
  const stats = fs.statSync(fullPath);
  
  if (stats.isDirectory()) {
    const dirSize = getPathSize(fullPath);
    return {
      filename: safeFilename,
      sizeBytes: dirSize,
      size: formatBytes(dirSize),
      format: "CoreML",
    };
  }

  return {
    filename: safeFilename,
    sizeBytes: stats.size,
    size: formatBytes(stats.size),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        reject(new Error(`Request body is too large. Limit is ${Math.round(MAX_JSON_BODY_BYTES / (1024 * 1024))} MB.`));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end",  () => { try { resolve(JSON.parse(data || "{}")); } catch(e) { reject(new Error("Invalid JSON request body")); } });
    req.on("error", reject);
  });
}

async function readJsonBody(req, res) {
  try {
    return await readBody(req);
  } catch (err) {
    json(res, err.message.includes("too large") ? 413 : 400, { ok: false, error: err.message });
    return null;
  }
}

function safeOutputName(value) {
  return String(value || "")
    .replace(/[^a-z0-9._-]/gi, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

function saveGeneratedOutput(imageDataUrl, metadata = {}) {
  const match = String(imageDataUrl || "").match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (!match) {
    throw new Error("Expected a real base64 PNG, JPEG, or WebP image data URL");
  }

  const mime = match[1];
  const extByMime = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
  };
  const ext = extByMime[mime] || ".png";
  const imageBuffer = Buffer.from(match[2], "base64");
  const isPng = imageBuffer.length > 8 &&
    imageBuffer[0] === 0x89 &&
    imageBuffer[1] === 0x50 &&
    imageBuffer[2] === 0x4e &&
    imageBuffer[3] === 0x47;
  const isJpeg = imageBuffer.length > 3 &&
    imageBuffer[0] === 0xff &&
    imageBuffer[1] === 0xd8 &&
    imageBuffer[2] === 0xff;
  const isWebp = imageBuffer.length > 12 &&
    imageBuffer.toString("ascii", 0, 4) === "RIFF" &&
    imageBuffer.toString("ascii", 8, 12) === "WEBP";
  if ((mime === "image/png" && !isPng) ||
      ((mime === "image/jpeg" || mime === "image/jpg") && !isJpeg) ||
      (mime === "image/webp" && !isWebp)) {
    throw new Error("Generated image payload did not match its declared image format.");
  }
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const seed = metadata.seed !== undefined && metadata.seed !== null ? `-${safeOutputName(metadata.seed)}` : "";
  const baseName = `output-${stamp}${seed}`;
  const imageFilename = `${baseName}${ext}`;
  const metadataFilename = `${baseName}.json`;
  const imagePath = path.join(OUTPUTS, imageFilename);
  const metadataPath = path.join(OUTPUTS, metadataFilename);

  fs.writeFileSync(imagePath, imageBuffer);
  const savedMetadata = {
    ...metadata,
    createdAt,
    image: imageFilename,
    metadata: metadataFilename,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(savedMetadata, null, 2), "utf8");
  console.log(`  [api] Saved generated output: ${imageFilename}`);
  return savedMetadata;
}

function listGeneratedOutputs() {
  try {
    return fs.readdirSync(OUTPUTS)
      .filter(file => file.toLowerCase().endsWith(".json"))
      .map(file => {
        try {
          const metadata = JSON.parse(fs.readFileSync(path.join(OUTPUTS, file), "utf8"));
          return {
            ...metadata,
            url: `/api/output-file?filename=${encodeURIComponent(metadata.image)}`,
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  } catch (_) {
    return [];
  }
}

function deleteGeneratedOutputs(outputs = []) {
  const deleted = [];
  for (const output of outputs) {
    const imageFilename = path.basename(output?.image || output?.filename || "");
    const metadataFilename = path.basename(output?.metadata || "");
    if (!imageFilename && !metadataFilename) continue;

    const targets = new Set();
    if (imageFilename) targets.add(imageFilename);
    if (metadataFilename) targets.add(metadataFilename);

    if (!metadataFilename && imageFilename) {
      const stem = imageFilename.replace(/\.[^.]+$/, "");
      targets.add(`${stem}.json`);
    }

    for (const filename of targets) {
      const filePath = path.join(OUTPUTS, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted.push(filename);
      }
    }
  }
  return deleted;
}

function streamModelUpload(req, filename, targetDir = MODELS, textOnly = false) {
  return new Promise((resolve, reject) => {
    const safeFilename = path.basename(filename || "");
    const lowerName = safeFilename.toLowerCase();
    if (!safeFilename || (textOnly ? !lowerName.endsWith(".gguf") : !isModelFile(lowerName))) {
      reject(new Error(textOnly ? "Filename must end with .gguf" : "Filename must end with .gguf, .safetensors, or .ckpt"));
      return;
    }

    const destPath = path.join(targetDir, safeFilename);
    const tempPath = `${destPath}.part`;
    const out = fs.createWriteStream(tempPath);
    let finished = false;

    const cleanupPartial = () => {
      if (finished) return;
      out.destroy();
      try { fs.unlinkSync(tempPath); } catch (_) {}
    };

    req.pipe(out);
    req.on("error", err => {
      cleanupPartial();
      reject(err);
    });
    req.on("aborted", () => {
      cleanupPartial();
      reject(new Error("Import cancelled by user"));
    });
    req.on("close", () => {
      if (!finished && req.aborted) {
        cleanupPartial();
      }
    });
    out.on("error", err => {
      cleanupPartial();
      reject(err);
    });
    out.on("finish", () => {
      try {
        finished = true;
        fs.renameSync(tempPath, destPath);
        console.log(`  [api] Imported model file: ${safeFilename}`);
        if (textOnly) {
          const stats = fs.statSync(destPath);
          resolve({ filename: safeFilename, name: safeFilename, sizeBytes: stats.size, size: formatBytes(stats.size), format: "GGUF" });
        } else {
          resolve(getModelInfo(safeFilename));
        }
      } catch (err) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        reject(err);
      }
    });
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST" });
    res.end(); return;
  }

  // ── Management API ────────────────────────────────────────────────────────
  // GET /api/health
  if (req.url === "/api/health" && req.method === "GET") {
    return json(res, 200, await getHealth());
  }

  // GET /api/diagnostics
  if (req.url === "/api/diagnostics" && req.method === "GET") {
    return json(res, 200, {
      generatedAt: new Date().toISOString(),
      health: await getHealth(),
      cleanupCandidates: getCleanupCandidates(),
      download: downloadState,
      generation: generationState,
      llm: {
        ready: llmReady,
        running: llmProc !== null,
        error: llmError,
        settings: llmSettings,
        port: PORT_LLM,
      },
      hardware: getHardwareSpecs(),
      telemetry: getTelemetry(),
    });
  }

  // GET /api/cleanup-candidates
  if (req.url === "/api/cleanup-candidates" && req.method === "GET") {
    return json(res, 200, { candidates: getCleanupCandidates() });
  }

  // POST /api/cleanup
  if (req.url === "/api/cleanup" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const deleted = cleanupSelected(Array.isArray(body.ids) ? body.ids : []);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Cleanup failed:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // GET /api/backend-status
  if (req.url === "/api/backend-status" && req.method === "GET") {
    return json(res, 200, {
      ready: backendReady || openvinoReady,
      running: backendProc !== null || openvinoProc !== null,
      port: PORT_BACKEND,
      preferredPort: PREFERRED_BACKEND_PORT,
      error: backendError,
      loading: backendLoadState,
      unloading: backendUnloadState,
      settings: currentSettings,
      build: SERVER_BUILD,
    });
  }

  if (req.url === "/api/llm/status" && req.method === "GET") {
    const backend = getLlmBackend();
    return json(res, 200, {
      ready: llmReady,
      running: llmProc !== null,
      port: PORT_LLM,
      preferredPort: PREFERRED_LLM_PORT,
      error: llmError,
      settings: llmSettings,
      backendInstalled: Boolean(backend),
      backendMode: backend?.mode || "",
      backendPath: backend?.path || "",
    });
  }

  if (req.url === "/api/llm/models" && req.method === "GET") {
    return json(res, 200, { models: getLlmModels() });
  }

  if (req.url.startsWith("/api/huggingface/models") && req.method === "GET") {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const query = String(parsed.searchParams.get("query") || "").slice(0, 120);
    const filters = String(parsed.searchParams.get("filters") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ["potato", "vision", "uncensored"].includes(value));
    const page = Math.max(1, Math.min(20, Number(parsed.searchParams.get("page")) || 1));
    const pageSize = 9;
    try {
      const rankedModels = await searchHuggingFaceModels(query, [...new Set(filters)]);
      const start = (page - 1) * pageSize;
      const pageModels = rankedModels.slice(start, start + pageSize);
      const models = await Promise.all(pageModels.map(addHuggingFaceFileSize));
      return json(res, 200, {
        ok: true,
        source: "huggingface",
        models,
        page,
        hasMore: start + models.length < rankedModels.length,
      });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message || "Hugging Face search failed." });
    }
  }

  if (req.url === "/api/llm/start" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await startLlm(body);
      return json(res, 200, { ok: true, ready: llmReady, port: PORT_LLM, settings: llmSettings });
    } catch (err) {
      llmError = err.message || String(err);
      await killLlm();
      return json(res, 500, { ok: false, error: llmError });
    }
  }

  if (req.url === "/api/llm/stop" && req.method === "POST") {
    await killLlm();
    return json(res, 200, { ok: true });
  }

  if (req.url === "/api/llm/chat" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!llmReady) return json(res, 409, { ok: false, error: "Load a text model before sending a message." });
    try {
      const isStream = body.stream === true;
      const requestData = JSON.stringify({
        model: llmSettings.model || "local-model",
        messages: Array.isArray(body.messages) ? body.messages : [],
        temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.7,
        max_tokens: Math.max(1, Math.min(4096, Number(body.max_tokens) || 512)),
        stream: isStream,
      });

      if (isStream) {
        const clientReq = http.request({
          hostname: "127.0.0.1",
          port: PORT_LLM,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestData),
          }
        }, (clientRes) => {
          if (clientRes.statusCode < 200 || clientRes.statusCode >= 300) {
            let errorBody = "";
            clientRes.setEncoding("utf8");
            clientRes.on("data", (chunk) => { errorBody += chunk; });
            clientRes.on("end", () => {
              let message = `Text backend returned HTTP ${clientRes.statusCode}`;
              try {
                message = JSON.parse(errorBody || "{}").error?.message || message;
              } catch (_) {}
              json(res, clientRes.statusCode || 500, { ok: false, error: message });
            });
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders?.();
          clientRes.on("data", (chunk) => res.write(chunk));
          clientRes.on("end", () => res.end());
          clientRes.on("error", (err) => res.destroy(err));
        });

        clientReq.on("error", (err) => {
          console.error("LLM stream request error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          } else {
            res.end();
          }
        });

        clientReq.write(requestData);
        clientReq.end();
        res.on("close", () => {
          if (!res.writableEnded && !clientReq.destroyed) clientReq.destroy();
        });
        return;
      } else {
        const result = await requestJson(`http://127.0.0.1:${PORT_LLM}/v1/chat/completions`, JSON.parse(requestData), 300000);
        return json(res, 200, result);
      }
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  // GET /api/hardware-specs
  if (req.url === "/api/hardware-specs" && req.method === "GET") {
    return json(res, 200, getHardwareSpecs());
  }

  // GET /api/backend-options
  if (req.url === "/api/backend-options" && req.method === "GET") {
    return json(res, 200, getBackendOptions());
  }

  // GET /api/telemetry
  if (req.url === "/api/telemetry" && req.method === "GET") {
    return json(res, 200, getTelemetry());
  }

  // GET /api/models — list available model files
  if (req.url === "/api/models" && req.method === "GET") {
    try {
      let files = fs.readdirSync(MODELS).filter(isModelFile).map(getModelInfo);
      if (downloadState.active && downloadState.filename) {
        files = files.filter(model => model.filename !== downloadState.filename);
      }
      return json(res, 200, { models: files });
    } catch (_) { return json(res, 200, { models: [] }); }
  }

  if (req.url === "/api/openvino-models" && req.method === "GET") {
    const npuInfo = getOpenVinoNpuInfo();
    return json(res, 200, {
      supported: npuInfo.supported,
      reason: npuInfo.reason || "",
      npu: npuInfo.npu || null,
      python: npuInfo.python || "",
      models: npuInfo.supported ? getOpenVinoModelInfo() : [],
    });
  }

  // POST /api/restart-backend — restart with new settings
  if (req.url === "/api/restart-backend" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    console.log("  [api] Restart backend request:", body);
    await killBackend();
    await new Promise(r => setTimeout(r, 500));
    const newSettings = {};
    if (body.model)    newSettings.model    = body.backend_type === "openvino-npu" ? String(body.model) : path.join(MODELS, body.model);
    if (body.steps)    newSettings.steps    = parseInt(body.steps);
    if (body.cfgScale) newSettings.cfgScale = parseFloat(body.cfgScale);
    if (body.sampler)  newSettings.sampler  = body.sampler;
    if (body.threads)  newSettings.threads  = parseInt(body.threads);
    if (body.width)    newSettings.width    = parseInt(body.width);
    if (body.height)   newSettings.height   = parseInt(body.height);
    if (typeof body.use_gpu === "boolean") newSettings.useGpu = body.use_gpu;
    if (body.backend_type) {
      newSettings.backendType = String(body.backend_type);
      newSettings.useGpu = body.backend_type !== "cpu";
    }
    if (typeof body.vae_tiling === "boolean") newSettings.vaeTiling = body.vae_tiling;
    if (typeof body.vae_on_cpu === "boolean") newSettings.vaeOnCpu = body.vae_on_cpu;
    if (typeof body.flash_attn === "boolean") newSettings.flashAttn = body.flash_attn;
    try {
      if (newSettings.backendType === "openvino-npu") {
        startBackend(newSettings).catch((err) => {
          backendError = err.message || String(err);
          backendLoadState = {
            ...backendLoadState,
            active: false,
            phase: "OpenVINO NPU model load failed",
          };
          console.error("  [openvino-npu] Startup failed:", backendError);
        });
        return json(res, 200, { ok: true, message: "OpenVINO NPU backend starting...", settings: currentSettings, port: PORT_BACKEND });
      }
      await startBackend(newSettings);
      return json(res, 200, { ok: true, message: "Backend restarting...", settings: currentSettings, port: PORT_BACKEND });
    } catch (err) {
      backendError = err.message || String(err);
      return json(res, 500, { ok: false, error: backendError, port: PORT_BACKEND });
    }
  }

  // POST /api/stop-backend
  if (req.url === "/api/stop-backend" && req.method === "POST") {
    await killBackend();
    await killOpenVinoWorker();
    return json(res, 200, { ok: true });
  }

  // POST /api/download-model
  if (req.url === "/api/download-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { url } = body;
    if (!url) return json(res, 400, { error: "URL is required" });
    
    startModelDownload(url);
    return json(res, 200, { ok: true, message: "Download started" });
  }

  if (req.url === "/api/llm/download-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const url = String(body.url || "");
    if (!url) return json(res, 400, { ok: false, error: "URL is required" });
    if (downloadState.active) return json(res, 409, { ok: false, error: "Another model download is already active." });
    try {
      const directUrl = url.includes("huggingface.co") ? url.replace("/blob/", "/resolve/") : url;
      const filename = path.basename(new URL(directUrl).pathname);
      if (!filename.toLowerCase().endsWith(".gguf")) {
        return json(res, 400, { ok: false, error: "Text model URL must point to a .gguf file." });
      }
      startModelDownload(directUrl, filename, LLM_MODELS, "text");
      return json(res, 200, { ok: true, message: "Text model download started", filename });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || String(err) });
    }
  }

  if (req.url === "/api/download-openvino-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const modelId = String(body.model_id || body.modelId || "");
    if (!modelId) return json(res, 400, { ok: false, error: "model_id is required" });
    try {
      startOpenVinoModelDownload(modelId);
      return json(res, 200, { ok: true, message: "OpenVINO model download started" });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  // GET /api/download-progress
  if (req.url === "/api/download-progress" && req.method === "GET") {
    return json(res, 200, downloadState);
  }

  // POST /api/cancel-download
  if (req.url === "/api/cancel-download" && req.method === "POST") {
    const cancelled = cancelModelDownload();
    return json(res, 200, { ok: true, cancelled });
  }

  // GET /api/generation-progress
  if (req.url === "/api/generation-progress" && req.method === "GET") {
    return json(res, 200, generationState);
  }

  if (req.url === "/api/openvino-generate" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      return json(res, 200, await generateWithOpenVino(body));
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  // GET /api/outputs
  if (req.url === "/api/outputs" && req.method === "GET") {
    return json(res, 200, { outputs: listGeneratedOutputs() });
  }

  // GET /api/output-file?filename=...
  if (req.url.startsWith("/api/output-file") && req.method === "GET") {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const filename = path.basename(parsed.searchParams.get("filename") || "");
    const filePath = path.join(OUTPUTS, filename);
    if (!filename || !fs.existsSync(filePath)) {
      return json(res, 404, { error: "Output file not found" });
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
      if (err) return json(res, 500, { error: err.message });
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
      res.end(data);
    });
    return;
  }

  // POST /api/save-output
  if (req.url === "/api/save-output" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const saved = saveGeneratedOutput(body.image, body.metadata || {});
      return json(res, 200, { ok: true, output: { ...saved, url: `/api/output-file?filename=${encodeURIComponent(saved.image)}` } });
    } catch (err) {
      console.error("  [api] Failed to save output:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // POST /api/delete-outputs
  if (req.url === "/api/delete-outputs" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const deleted = deleteGeneratedOutputs(body.outputs || []);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Failed to delete outputs:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // POST /api/import-model?filename=...
  if (req.url.startsWith("/api/import-model") && req.method === "POST") {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"));
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result, filename: result.filename });
    } catch (err) {
      console.error("  [api] Failed to import model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.url.startsWith("/api/llm/import-model") && req.method === "POST") {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), LLM_MODELS, true);
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import text model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.url === "/api/llm/delete-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(LLM_MODELS, filename);
    if (!filename || !pathInside(modelPath, LLM_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (llmSettings.model === filename && llmProc) await killLlm();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, {
        ok: false,
        error: err.code === "ENOENT" ? "Text model not found" : err.message,
      });
    }
  }

  // POST /api/delete-model
  if (req.url === "/api/delete-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { filename } = body;
    if (!filename) return json(res, 400, { error: "Filename is required" });
    
    const openvinoModel = findOpenVinoModel(filename);
    const safeFilename = path.basename(filename);
    const modelPath = path.join(MODELS, safeFilename);
    
    try {
      if (openvinoModel?.installed && openvinoModel.path && pathInside(openvinoModel.path, OPENVINO_MODELS)) {
        fs.rmSync(openvinoModel.path, { recursive: true, force: true });
        cachedBackendOptions = null;
        console.log(`  [api] Deleted OpenVINO model: ${openvinoModel.id}`);
        return json(res, 200, { ok: true, message: `Deleted ${openvinoModel.name}` });
      } else if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
        console.log(`  [api] Deleted model file: ${safeFilename}`);
        return json(res, 200, { ok: true, message: `Deleted ${safeFilename}` });
      } else {
        return json(res, 404, { error: "Model file not found" });
      }
    } catch (err) {
      console.error(`  [api] Failed to delete model ${safeFilename}:`, err);
      return json(res, 500, { error: err.message });
    }
  }

  if (req.url.startsWith("/api/")) {
    return json(res, 404, { ok: false, error: "Unknown API endpoint" });
  }

  // ── Static frontend files ─────────────────────────────────────────────────
  let filePath = path.join(DIST, req.url === "/" ? "index.html" : req.url);
  filePath = filePath.split("?")[0];
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, "index.html");
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": mime, "Access-Control-Allow-Origin": "*" });
    res.end(data);
  });
});

server.listen(PORT_FRONTEND, "0.0.0.0", () => {
  console.log("");
  console.log("  ============================================================");
  console.log("   LOCAL AI IMAGE GENERATOR  |  Running");
  console.log("   Server Build: " + SERVER_BUILD);
  console.log("   Frontend : http://localhost:" + PORT_FRONTEND);
  console.log("   Image API: http://127.0.0.1:" + PORT_BACKEND);
  console.log("   Text API : starts on http://127.0.0.1:" + PREFERRED_LLM_PORT);
  console.log("  ============================================================");
  console.log("");

  // Do not auto-start backend; wait for selection from the Web UI
  console.log("  [backend] Ready. Waiting for model load request from the webapp...");
});

// Graceful shutdown
process.on("SIGINT",  async () => { await killBackend(); await killOpenVinoWorker(); await killLlm(); process.exit(0); });
process.on("SIGTERM", async () => { await killBackend(); await killOpenVinoWorker(); await killLlm(); process.exit(0); });
