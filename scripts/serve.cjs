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

function readPort(value, fallback) {
  const port = parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

const PORT_FRONTEND = readPort(process.env.PORT || process.env.FRONTEND_PORT, 1420);
const PREFERRED_BACKEND_PORT = readPort(process.env.BACKEND_PORT || process.env.SD_BACKEND_PORT, 8080);
let PORT_BACKEND = PREFERRED_BACKEND_PORT;
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;
const SERVER_BUILD = "polish-setup-v1";
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
const OUTPUTS = path.join(ROOT, "app", "outputs");
if (!fs.existsSync(OUTPUTS)) {
  fs.mkdirSync(OUTPUTS, { recursive: true });
}

// ── Backend process state ─────────────────────────────────────────────────────
let backendProc  = null;
let backendReady = false;
let backendError = null;
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
      const output = execSync(
        "powershell -NoProfile -Command \"Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name\"",
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (output) {
        cachedGpuInfo = { name: output };
        return cachedGpuInfo;
      }
    } catch (_) {}
  }

  if (osPlatform === "linux") {
    const linuxGpu = detectLinuxGpuFromSysfs();
    if (linuxGpu) {
      cachedGpuInfo = linuxGpu;
      return cachedGpuInfo;
    }
  }

  if (osPlatform === "darwin") {
    try {
      const output = execSync(
        "system_profiler SPDisplaysDataType | awk -F': ' '/Chipset Model|Vendor/ {print $2; exit}'",
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (output) {
        cachedGpuInfo = { name: output };
        return cachedGpuInfo;
      }
    } catch (_) {}
    cachedGpuInfo = { name: "Apple Metal GPU" };
    return cachedGpuInfo;
  }

  cachedGpuInfo = { name: "Unavailable" };
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

function getHardwareSpecs() {
  const cpus = os.cpus();
  const gpu = getGpuInfo();
  return {
    os_name: `${os.type()} ${os.release()}`,
    cpu_name: cpus[0]?.model || "Unavailable",
    cpu_cores_physical: Math.max(1, Math.round(cpus.length / 2)),
    cpu_cores_logical: cpus.length || 1,
    ram_total_gb: roundGb(os.totalmem()),
    gpu_name: gpu.name,
  };
}

function getTelemetry() {
  const vram = getNvidiaVram();
  return {
    cpu_usage: getCpuUsagePercent(),
    ram_used_gb: roundGb(os.totalmem() - os.freemem()),
    ram_total_gb: roundGb(os.totalmem()),
    gpu_name: vram?.gpu_name || getGpuInfo().name,
    vram_used_gb: vram?.vram_used_gb || 0,
    vram_total_gb: vram?.vram_total_gb || 0,
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
    backend: { ...(await checkPort(PORT_BACKEND)), expectedInUse: backendProc !== null },
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
      ready: backendReady,
      running: backendProc !== null,
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
  // Darwin release binaries are Metal builds. Treat an installed macOS backend
  // as Metal-capable so the UI does not default to CPU if a probe flag changes
  // upstream.
  const metalAvailable = metalInstalled;

  const options = [{ id: "cpu", label: "CPU", available: true }];
  if (metalAvailable) options.push({ id: "metal", label: "Metal GPU", available: true });
  if (vulkanAvailable) options.push({ id: "vulkan", label: "Vulkan GPU", available: true });
  if (rocmAvailable) options.push({ id: "rocm", label: "ROCm GPU (AMD)", available: true });
  if (cudaAvailable) options.push({ id: "cuda", label: "CUDA GPU", available: true });

  const unavailable = [];
  if (vulkanInstalled && !vulkanAvailable) {
    unavailable.push({ id: "vulkan", label: "Vulkan GPU", reason: "Installed, but this binary did not register a Vulkan backend on this machine." });
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

  let defaultBackend = "cpu";
  if (metalAvailable) {
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
    defaultBackendType: defaultBackend,
  };
  return cachedBackendOptions;
}

function backendAccepts(binaryPath, backendName) {
  if (!binaryPath || !fs.existsSync(binaryPath)) return false;
  try {
    const cliBackendName = backendName === "metal" ? "metal0" : backendName;
    const probeArgs = [
      "--backend", cliBackendName,
      "--params-backend", cliBackendName,
      "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
      "--listen-port", "18082",
    ];
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
    let result = spawnSync(binaryPath, probeArgs, { encoding: "utf8", timeout: 5000, env: spawnEnv });
    let output = `${result.stdout || ""}\n${result.stderr || ""}`;

    // Some binaries do not support --backend. If we see "unknown argument",
    // retry without backend flags so we can still verify the binary launches.
    if (output.includes("unknown argument") && output.includes("--backend")) {
      const fallbackArgs = [
        "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
        "--listen-port", "18082",
      ];
      result = spawnSync(binaryPath, fallbackArgs, { encoding: "utf8", timeout: 5000, env: spawnEnv });
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
    return lower.includes("stable-diffusion.cpp") || lower.includes("loading model");
  } catch (_) {
    return false;
  }
}

function selectBackendPath(useGpu, backendType = "auto") {
  const resolvedType = resolveBackendType(useGpu, backendType);
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
    if (fs.existsSync(BACKEND_PATHS.mac)) return BACKEND_PATHS.mac;
    return BACKEND_PATH;
  }
  // generic fallback
  if (fs.existsSync(BACKEND_PATHS.mac)) return BACKEND_PATHS.mac;
  return BACKEND_PATH;
}

function resolveBackendType(useGpu, backendType = "auto") {
  const options = getBackendOptions();
  const requestedType = useGpu === false ? "cpu" : backendType === "auto" ? options.defaultBackendType : backendType;
  const available = new Set(options.options.map(option => option.id));
  return available.has(requestedType) ? requestedType : options.defaultBackendType;
}

function getBackendMode(backendPath, useGpu, backendType = "auto") {
  if (useGpu === false || backendType === "cpu") return "CPU";
  const name = path.basename(backendPath || "").toLowerCase();
  if (name.includes("cuda")) return "CUDA GPU";
  if (name.includes("rocm")) return "ROCm GPU";
  if (name.includes("vulkan")) return "Vulkan GPU";
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

function startBackendReadyPoll() {
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts += 1;
    if (!backendProc || backendReady || attempts > 240) {
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

async function startBackend(settings = {}) {
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

  const resolvedBackendType = resolveBackendType(currentSettings.useGpu, currentSettings.backendType);
  currentSettings.backendType = resolvedBackendType;
  currentSettings.useGpu = resolvedBackendType !== "cpu";
  const backendPath = selectBackendPath(currentSettings.useGpu, currentSettings.backendType);
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

  const args = [
    "--listen-port", String(PORT_BACKEND),
    "--model",       currentSettings.model,
    "--steps",       String(currentSettings.steps),
    "--cfg-scale",   String(currentSettings.cfgScale),
    "--sampling-method", currentSettings.sampler,
    "--threads",     String(runThreads),
  ];

  const requestedBackend = resolveBackendType(currentSettings.useGpu, currentSettings.backendType);
  if (requestedBackend === "cpu") {
    args.push(
      "--backend", "cpu",
      "--params-backend", "cpu",
      "--rng", "cpu",
      "--sampler-rng", "cpu",
    );
  } else if (requestedBackend === "vulkan") {
    args.push(
      "--backend", "vulkan0",
      "--params-backend", "vulkan0",
      "--rng", "cpu",
      "--sampler-rng", "cpu",
    );
  } else if (requestedBackend === "cuda") {
    // CUDA is only supported on Windows. Linux has no reliable prebuilt CUDA binary.
    args.push(
      "--backend", "cuda0",
      "--params-backend", "cuda0",
      "--rng", "cuda",
      "--sampler-rng", "cuda",
    );
  } else if (requestedBackend === "rocm") {
    args.push(
      "--backend", "rocm0",
      "--params-backend", "rocm0",
      "--rng", "cpu",
      "--sampler-rng", "cpu",
    );
  } else if (requestedBackend === "metal") {
    args.push(
      "--backend", "metal0",
      "--params-backend", "metal0",
      "--rng", "cpu",
      "--sampler-rng", "cpu",
    );
  }

  if (currentSettings.vaeTiling) {
    args.push("--vae-tiling");
  }
  if (currentSettings.vaeOnCpu) {
    args.push("--vae-on-cpu");
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
  } else if (osPlatform === "darwin") {
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
        backendLoadState = {
          ...backendLoadState,
          active: !backendReady,
          phase: "Loading model weights...",
          progress: Math.max(backendLoadState.progress, Math.min(99, progress)),
          current,
          total,
          speed: stripAnsi(loadMatch[3]).trim(),
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

function startModelDownload(url, overrideFilename = null) {
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

  const destPath = path.join(MODELS, filename);
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
    error: null
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
      console.log(`  [download] Redirected to ${redirectUrl}`);
      
      // Clean up redirected request to avoid triggering error handlers later
      request.removeAllListeners("error");
      request.destroy();
      
      fileStream.close();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      activeDownload = null;
      downloadState.active = false;
      startModelDownload(redirectUrl, filename);
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
    try { activeDownload.request.destroy(new Error("Download cancelled by user")); } catch (_) {}
    try { activeDownload.fileStream.destroy(); } catch (_) {}
    try { fs.unlinkSync(activeDownload.tempPath || activeDownload.destPath); } catch (_) {}
  } else if (filename) {
    try { fs.unlinkSync(`${path.join(MODELS, filename)}.part`); } catch (_) {}
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
  return lower.endsWith(".safetensors") || lower.endsWith(".gguf") || lower.endsWith(".ckpt");
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

  const stats = fs.statSync(modelPath);
  if (stats.size < 128 * 1024 * 1024) {
    return `${filename} is too small to be a complete image model (${formatBytes(stats.size)}). Delete it and download/import it again.`;
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
  const stats = fs.statSync(path.join(MODELS, safeFilename));
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
  const match = String(imageDataUrl || "").match(/^data:(image\/(?:png|jpeg|jpg|webp|svg\+xml));base64,(.+)$/);
  if (!match) {
    throw new Error("Expected a base64 image data URL");
  }

  const mime = match[1];
  const extByMime = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
  };
  const ext = extByMime[mime] || ".png";
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const seed = metadata.seed !== undefined && metadata.seed !== null ? `-${safeOutputName(metadata.seed)}` : "";
  const baseName = `output-${stamp}${seed}`;
  const imageFilename = `${baseName}${ext}`;
  const metadataFilename = `${baseName}.json`;
  const imagePath = path.join(OUTPUTS, imageFilename);
  const metadataPath = path.join(OUTPUTS, metadataFilename);

  fs.writeFileSync(imagePath, Buffer.from(match[2], "base64"));
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

function streamModelUpload(req, filename) {
  return new Promise((resolve, reject) => {
    const safeFilename = path.basename(filename || "");
    const lowerName = safeFilename.toLowerCase();
    if (!safeFilename || !isModelFile(lowerName)) {
      reject(new Error("Filename must end with .gguf, .safetensors, or .ckpt"));
      return;
    }

    const destPath = path.join(MODELS, safeFilename);
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
        resolve(getModelInfo(safeFilename));
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
      ready: backendReady, 
      running: backendProc !== null,
      port: PORT_BACKEND,
      preferredPort: PREFERRED_BACKEND_PORT,
      error: backendError,
      loading: backendLoadState,
      unloading: backendUnloadState,
      settings: currentSettings,
      build: SERVER_BUILD,
    });
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

  // POST /api/restart-backend — restart with new settings
  if (req.url === "/api/restart-backend" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    console.log("  [api] Restart backend request:", body);
    await killBackend();
    await new Promise(r => setTimeout(r, 500));
    const newSettings = {};
    if (body.model)    newSettings.model    = path.join(MODELS, body.model);
    if (body.steps)    newSettings.steps    = parseInt(body.steps);
    if (body.cfgScale) newSettings.cfgScale = parseFloat(body.cfgScale);
    if (body.sampler)  newSettings.sampler  = body.sampler;
    if (body.threads)  newSettings.threads  = parseInt(body.threads);
    if (typeof body.use_gpu === "boolean") newSettings.useGpu = body.use_gpu;
    if (body.backend_type) {
      newSettings.backendType = String(body.backend_type);
      newSettings.useGpu = body.backend_type !== "cpu";
    }
    if (typeof body.vae_tiling === "boolean") newSettings.vaeTiling = body.vae_tiling;
    if (typeof body.vae_on_cpu === "boolean") newSettings.vaeOnCpu = body.vae_on_cpu;
    try {
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

  // POST /api/delete-model
  if (req.url === "/api/delete-model" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { filename } = body;
    if (!filename) return json(res, 400, { error: "Filename is required" });
    
    const safeFilename = path.basename(filename);
    const modelPath = path.join(MODELS, safeFilename);
    
    try {
      if (fs.existsSync(modelPath)) {
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
  console.log("   Backend  : http://127.0.0.1:" + PORT_BACKEND);
  console.log("  ============================================================");
  console.log("");

  // Do not auto-start backend; wait for selection from the Web UI
  console.log("  [backend] Ready. Waiting for model load request from the webapp...");
});

// Graceful shutdown
process.on("SIGINT",  async () => { await killBackend(); process.exit(0); });
process.on("SIGTERM", async () => { await killBackend(); process.exit(0); });
