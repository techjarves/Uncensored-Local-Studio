const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const readline = require("readline");
const crypto = require("crypto");

const VIDEO_MODELS = [
  {
    id: "animatediff-sd15",
    name: "AnimateDiff SD 1.5",
    family: "AnimateDiff",
    tier: "Starter",
    repo: "guoyww/animatediff-motion-adapter-v1-5-2",
    revision: "main",
    modes: ["text-to-video"],
    approxDownloadBytes: 550000000,
    minVramGb: 8,
    minRamGb: 16,
    license: "apache-2.0",
    resolutions: [{ width: 512, height: 512 }],
    frames: { min: 8, max: 32, step: 8, default: 16 },
    fps: { min: 4, max: 12, default: 8 },
    steps: { min: 4, max: 40, default: 20 },
    guidance: { min: 1, max: 12, default: 7.5 },
    requiresBaseModel: true,
    notes: "Fast text-to-video using a compatible local SD 1.5 checkpoint.",
    allowPatterns: [
      "*.json",
      "*.txt",
      "*.model",
      "*fp16.safetensors",
    ],
  },
  {
    id: "svd-xt",
    name: "Stable Video Diffusion XT",
    family: "Stable Video Diffusion",
    tier: "Starter",
    repo: "stabilityai/stable-video-diffusion-img2vid-xt",
    revision: "main",
    modes: ["image-to-video"],
    approxDownloadBytes: 4600000000,
    minVramGb: 8,
    minRamGb: 16,
    license: "stability-ai-community",
    resolutions: [
      { width: 1024, height: 576 },
      { width: 576, height: 1024 },
    ],
    frames: { min: 14, max: 25, step: 11, default: 14 },
    fps: { min: 4, max: 12, default: 6 },
    steps: { min: 10, max: 40, default: 25 },
    guidance: { min: 1, max: 5, default: 3 },
    requiresBaseModel: false,
    notes: "Creates a short motion clip from a source image. The 14-frame default is recommended for 16 GB GPUs and 32 GB RAM.",
    allowPatterns: [
      "*.json",
      "*.txt",
      "*.model",
      "feature_extractor/*",
      "image_encoder/model.fp16.safetensors",
      "unet/diffusion_pytorch_model.fp16.safetensors",
      "vae/diffusion_pytorch_model.fp16.safetensors",
    ],
  },
  {
    id: "wan2.2-ti2v-5b",
    name: "Wan 2.2 TI2V 5B",
    family: "Wan 2.2",
    tier: "Quality",
    repo: "Wan-AI/Wan2.2-TI2V-5B-Diffusers",
    revision: "main",
    modes: ["text-to-video", "image-to-video"],
    approxDownloadBytes: 34200000000,
    minVramGb: 24,
    minRamGb: 32,
    license: "apache-2.0",
    resolutions: [
      { width: 1280, height: 704 },
      { width: 704, height: 1280 },
    ],
    frames: { min: 49, max: 121, step: 24, default: 121 },
    fps: { min: 12, max: 24, default: 24 },
    steps: { min: 20, max: 50, default: 40 },
    guidance: { min: 1, max: 8, default: 5 },
    requiresBaseModel: false,
    notes: "High-quality 720p text-to-video and image-to-video. Requires at least 24 GB VRAM.",
    allowPatterns: null,
  },
];

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function getPathSize(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return stat.size;
    return fs.readdirSync(targetPath).reduce((sum, name) => sum + getPathSize(path.join(targetPath, name)), 0);
  } catch (_) {
    return 0;
  }
}

function safeId(value) {
  return String(value || "").replace(/[^a-z0-9._-]/gi, "").slice(0, 120);
}

function detectImage(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") return ".png";
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

class VideoManager {
  constructor({ root, imageModelsDir, stopImageBackends }) {
    this.root = root;
    this.imageModelsDir = imageModelsDir;
    this.stopImageBackends = stopImageBackends;
    this.modelsDir = path.join(root, "app", "video-models");
    this.inputsDir = path.join(root, "app", "video-inputs");
    this.outputsDir = path.join(root, "app", "video-outputs");
    this.runtimeDir = path.join(root, "app", "tools", "video-runtime");
    this.workerScript = path.join(root, "scripts", "video_worker.py");
    this.runtimeProc = null;
    this.downloadProc = null;
    this.workerProc = null;
    this.workerReady = false;
    this.workerStarting = null;
    this.activeJob = null;
    this.jobs = new Map();
    this.jobInputs = new Map();
    this.unloadWaiters = [];
    this.runtimeState = { active: false, phase: "", progress: 0, error: null };
    this.nvidiaCache = { value: null, checkedAt: 0 };
    this.downloadState = {
      active: false, modelId: "", phase: "", progress: 0, downloadedBytes: 0,
      totalBytes: 0, error: null,
    };
    for (const dir of [this.modelsDir, this.inputsDir, this.outputsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  getPythonPath() {
    return process.platform === "win32"
      ? path.join(this.runtimeDir, "venv", "Scripts", "python.exe")
      : path.join(this.runtimeDir, "venv", "bin", "python");
  }

  getRuntimeMarker() {
    return path.join(this.runtimeDir, "runtime.json");
  }

  isRuntimeInstalled() {
    return fs.existsSync(this.getPythonPath()) && fs.existsSync(this.getRuntimeMarker());
  }

  verifyRuntime() {
    if (!this.isRuntimeInstalled()) return false;
    const probe = spawnSync(this.getPythonPath(), [
      "-c",
      "import torch,diffusers,transformers,imageio_ffmpeg; assert torch.cuda.is_available()",
    ], { encoding: "utf8", timeout: 20000, windowsHide: true });
    return probe.status === 0;
  }

  getNvidiaInfo(force = false) {
    const now = Date.now();
    if (!force && now - this.nvidiaCache.checkedAt < 5000) return this.nvidiaCache.value;
    const command = process.platform === "win32" &&
      fs.existsSync("C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe")
      ? "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"
      : "nvidia-smi";
    const result = spawnSync(command, [
      "--query-gpu=name,memory.total,memory.free,compute_cap,driver_version",
      "--format=csv,noheader,nounits",
    ], { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (result.status !== 0) {
      this.nvidiaCache = { value: null, checkedAt: now };
      return null;
    }
    const line = String(result.stdout || "").trim().split(/\r?\n/)[0];
    if (!line) {
      this.nvidiaCache = { value: null, checkedAt: now };
      return null;
    }
    const [name, totalMb, freeMb, computeCapability, driverVersion] = line.split(",").map(part => part.trim());
    const value = {
      name,
      totalVramGb: round(Number(totalMb) / 1024),
      freeVramGb: round(Number(freeMb) / 1024),
      computeCapability,
      driverVersion,
    };
    this.nvidiaCache = { value, checkedAt: now };
    return value;
  }

  getWindowsVirtualMemoryInfo() {
    if (process.platform !== "win32") return null;
    const script = [
      "$os=Get-CimInstance Win32_OperatingSystem",
      "$pf=Get-CimInstance Win32_PageFileUsage | Measure-Object AllocatedBaseSize -Sum",
      "[pscustomobject]@{FreeVirtualKB=$os.FreeVirtualMemory;PageFileMB=$pf.Sum}|ConvertTo-Json -Compress",
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    try {
      const data = JSON.parse(String(result.stdout || "").trim());
      return {
        freeVirtualGb: round(Number(data.FreeVirtualKB) / (1024 ** 2)),
        pageFileGb: round(Number(data.PageFileMB) / 1024),
      };
    } catch (_) {
      return null;
    }
  }

  listBaseModels() {
    try {
      return fs.readdirSync(this.imageModelsDir)
        .filter(name => /\.(safetensors|ckpt)$/i.test(name))
        .map(name => {
          const lower = name.toLowerCase();
          const likelyCompatible = !/(sdxl|flux|sd3|juggernaut.xl|dreamshaperxl|lightning)/i.test(lower);
          return { filename: name, likelyCompatible };
        });
    } catch (_) {
      return [];
    }
  }

  modelPath(modelId) {
    return path.join(this.modelsDir, safeId(modelId));
  }

  isModelInstalled(model) {
    const target = this.modelPath(model.id);
    if (!fs.existsSync(target)) return false;
    const marker = path.join(target, ".complete.json");
    return fs.existsSync(marker) && getPathSize(target) > Math.min(model.approxDownloadBytes * 0.4, 1000000000);
  }

  listModels() {
    const hardware = this.getNvidiaInfo();
    const ramGb = os.totalmem() / (1024 ** 3);
    return VIDEO_MODELS.map(model => {
      const installed = this.isModelInstalled(model);
      const installedBytes = installed ? getPathSize(this.modelPath(model.id)) : 0;
      const blockers = [];
      if (!hardware) blockers.push("NVIDIA CUDA GPU and driver not detected.");
      else if (hardware.totalVramGb < model.minVramGb) blockers.push(`Requires ${model.minVramGb} GB VRAM.`);
      if (ramGb < model.minRamGb) blockers.push(`Requires ${model.minRamGb} GB system RAM.`);
      if (model.requiresBaseModel && !this.listBaseModels().some(item => item.likelyCompatible)) {
        blockers.push("Requires a compatible local SD 1.5 checkpoint in app/models.");
      }
      return {
        ...model,
        installed,
        installedBytes,
        installedSize: formatBytes(installedBytes),
        compatible: blockers.length === 0,
        blockers,
      };
    });
  }

  getCapabilities() {
    const supportedPlatform = ["win32", "linux"].includes(process.platform) && process.arch === "x64";
    const gpu = this.getNvidiaInfo();
    return {
      supported: supportedPlatform && Boolean(gpu),
      platform: process.platform,
      arch: process.arch,
      reason: !supportedPlatform
        ? "Video generation v1 supports 64-bit Windows and Linux."
        : !gpu ? "An NVIDIA CUDA GPU and current NVIDIA driver are required." : "",
      gpu,
      ramTotalGb: round(os.totalmem() / (1024 ** 3)),
      runtime: {
        installed: this.isRuntimeInstalled(),
        ...this.runtimeState,
      },
      download: this.downloadState,
      activeJobId: this.activeJob?.id || null,
      workerReady: this.workerReady,
      baseModels: this.listBaseModels(),
    };
  }

  startRuntimeInstall() {
    if (this.runtimeState.active) return this.runtimeState;
    if (!["win32", "linux"].includes(process.platform) || process.arch !== "x64") {
      throw new Error("The portable video runtime supports 64-bit Windows and Linux only.");
    }
    if (!this.getNvidiaInfo()) throw new Error("NVIDIA CUDA GPU and driver were not detected.");
    this.stopWorker();
    const script = process.platform === "win32"
      ? path.join(this.root, "scripts", "setup-video-runtime.ps1")
      : path.join(this.root, "scripts", "setup-video-runtime.sh");
    const command = process.platform === "win32" ? "powershell.exe" : "bash";
    const args = process.platform === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
      : [script];
    this.runtimeState = { active: true, phase: "Starting runtime installation", progress: 1, error: null };
    this.runtimeProc = spawn(command, args, {
      cwd: this.root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parse = chunk => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (item.type === "runtime-progress") {
            this.runtimeState = {
              active: item.progress < 100,
              phase: item.phase,
              progress: Number(item.progress) || 0,
              error: null,
            };
          }
        } catch (_) {
          console.log("  [video-runtime]", line);
        }
      }
    };
    this.runtimeProc.stdout.on("data", parse);
    this.runtimeProc.stderr.on("data", data => process.stderr.write(`  [video-runtime] ${data}`));
    this.runtimeProc.on("exit", code => {
      this.runtimeProc = null;
      const installed = this.verifyRuntime();
      this.runtimeState = {
        active: false,
        phase: installed ? "Video runtime ready" : "Video runtime installation failed",
        progress: installed ? 100 : this.runtimeState.progress,
        error: installed ? null : `Runtime installer exited with code ${code}.`,
      };
    });
    return this.runtimeState;
  }

  startModelDownload(modelId) {
    if (this.downloadState.active) throw new Error("A video model download is already active.");
    if (!this.isRuntimeInstalled()) throw new Error("Install the portable video runtime first.");
    const model = VIDEO_MODELS.find(item => item.id === modelId);
    if (!model) throw new Error("Unknown video model.");
    const modelStatus = this.listModels().find(item => item.id === modelId);
    if (!modelStatus?.compatible) {
      throw new Error(modelStatus?.blockers?.join(" ") || `${model.name} is not compatible with this system.`);
    }
    const target = this.modelPath(model.id);
    fs.mkdirSync(target, { recursive: true });
    const allowPatterns = model.allowPatterns
      ? JSON.stringify(model.allowPatterns)
      : "None";
    const code = [
      "from huggingface_hub import snapshot_download",
      "import json",
      `snapshot_download(repo_id=${JSON.stringify(model.repo)}, revision=${JSON.stringify(model.revision)}, local_dir=${JSON.stringify(target)}, allow_patterns=${allowPatterns})`,
      "print(json.dumps({'complete': True}))",
    ].join("; ");
    this.downloadState = {
      active: true,
      modelId: model.id,
      phase: "Downloading model snapshot",
      progress: 0,
      downloadedBytes: getPathSize(target),
      totalBytes: model.approxDownloadBytes,
      error: null,
    };
    this.downloadProc = spawn(this.getPythonPath(), ["-c", code], {
      cwd: this.root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1" },
    });
    const timer = setInterval(() => {
      if (!this.downloadState.active) return clearInterval(timer);
      const downloadedBytes = getPathSize(target);
      this.downloadState.downloadedBytes = downloadedBytes;
      this.downloadState.progress = Math.min(99, Math.round((downloadedBytes / model.approxDownloadBytes) * 100));
    }, 1000);
    this.downloadProc.stdout.on("data", data => process.stdout.write(`  [video-download] ${data}`));
    this.downloadProc.stderr.on("data", data => process.stderr.write(`  [video-download] ${data}`));
    this.downloadProc.on("exit", codeValue => {
      clearInterval(timer);
      this.downloadProc = null;
      if (codeValue === 0) {
        fs.writeFileSync(path.join(target, ".complete.json"), JSON.stringify({
          repo: model.repo,
          revision: model.revision,
          completedAt: new Date().toISOString(),
        }, null, 2));
        this.downloadState = {
          active: false,
          modelId: model.id,
          phase: "Download complete",
          progress: 100,
          downloadedBytes: getPathSize(target),
          totalBytes: model.approxDownloadBytes,
          error: null,
        };
      } else {
        this.downloadState = {
          ...this.downloadState,
          active: false,
          phase: "Download failed",
          error: `Video model download exited with code ${codeValue}. Retry to resume the snapshot.`,
        };
      }
    });
    return this.downloadState;
  }

  cancelDownload() {
    if (!this.downloadProc) return false;
    this.downloadProc.kill("SIGTERM");
    setTimeout(() => {
      try { this.downloadProc?.kill("SIGKILL"); } catch (_) {}
    }, 1500);
    this.downloadState = {
      ...this.downloadState,
      active: false,
      phase: "Download cancelled",
      error: "Download cancelled. Retry later to resume.",
    };
    return true;
  }

  deleteModel(modelId) {
    if (this.activeJob?.modelId === modelId) throw new Error("Cannot delete the model used by the active job.");
    const model = VIDEO_MODELS.find(item => item.id === modelId);
    if (!model) throw new Error("Unknown video model.");
    const target = this.modelPath(model.id);
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  }

  async ensureWorker() {
    if (this.workerReady && this.workerProc) return;
    if (this.workerStarting) return this.workerStarting;
    if (!this.isRuntimeInstalled()) throw new Error("Install the portable video runtime first.");
    this.workerStarting = new Promise((resolve, reject) => {
      let settled = false;
      this.workerReady = false;
      this.workerProc = spawn(this.getPythonPath(), [
        this.workerScript,
        "--models-dir", this.modelsDir,
        "--outputs-dir", this.outputsDir,
      ], {
        cwd: this.root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const rl = readline.createInterface({ input: this.workerProc.stdout });
      rl.on("line", line => {
        try {
          const message = JSON.parse(line);
          this.handleWorkerMessage(message);
          if (message.type === "worker-ready" && !settled) {
            settled = true;
            this.workerReady = true;
            resolve();
          } else if (message.type === "worker-error" && !settled) {
            settled = true;
            reject(new Error(message.error));
          }
        } catch (_) {
          console.log("  [video-worker]", line);
        }
      });
      this.workerProc.stderr.on("data", data => process.stderr.write(`  ${data}`));
      this.workerProc.on("exit", code => {
        this.workerReady = false;
        this.workerProc = null;
        this.workerStarting = null;
        if (this.activeJob) {
          this.finishJob(this.activeJob.id, {
            status: "error",
            phase: "Failed",
            error: code === 3221225477
              ? "The video worker crashed because Windows virtual memory was exhausted. Enable a system-managed pagefile or close memory-heavy applications, then retry."
              : `Video worker exited with code ${code}.`,
          });
        }
        if (!settled) {
          settled = true;
          reject(new Error(`Video worker exited with code ${code}.`));
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          this.stopWorker();
          reject(new Error("Video worker did not become ready within 30 seconds."));
        }
      }, 30000);
    }).finally(() => {
      this.workerStarting = null;
    });
    return this.workerStarting;
  }

  sendWorker(command) {
    if (!this.workerProc?.stdin?.writable) throw new Error("Video worker is not available.");
    this.workerProc.stdin.write(`${JSON.stringify(command)}\n`);
  }

  handleWorkerMessage(message) {
    const jobId = message.jobId;
    if (message.type === "job-progress" && jobId && this.jobs.has(jobId)) {
      const job = this.jobs.get(jobId);
      Object.assign(job, {
        status: "running",
        phase: message.phase || job.phase,
        progress: Number(message.progress) || 0,
        current: Number(message.current) || job.current || 0,
        total: Number(message.total) || job.total || 0,
        elapsedSec: Number(message.elapsedSec) || job.elapsedSec || 0,
        updatedAt: new Date().toISOString(),
      });
    } else if (message.type === "job-complete") {
      this.finishJob(jobId, { status: "complete", phase: "Complete", progress: 100, output: message.output });
    } else if (message.type === "job-cancelled") {
      this.finishJob(jobId, { status: "cancelled", phase: "Cancelled", error: message.error || null });
    } else if (message.type === "job-error") {
      this.finishJob(jobId, { status: "error", phase: "Failed", error: message.error || "Video generation failed." });
    } else if (message.type === "worker-unloaded") {
      for (const resolve of this.unloadWaiters.splice(0)) resolve();
    }
  }

  finishJob(jobId, changes) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, changes, {
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const inputPath = this.jobInputs.get(jobId);
    if (changes.status !== "complete" && inputPath && fs.existsSync(inputPath)) {
      try { fs.unlinkSync(inputPath); } catch (_) {}
    }
    if (changes.status !== "complete") this.jobInputs.delete(jobId);
    if (this.activeJob?.id === jobId) this.activeJob = null;
  }

  validateJob(body) {
    const model = VIDEO_MODELS.find(item => item.id === body.modelId);
    if (!model) throw new Error("Unknown video model.");
    if (!this.isModelInstalled(model)) throw new Error("Download the selected video model first.");
    const mode = String(body.mode || "");
    if (!model.modes.includes(mode)) throw new Error(`${model.name} does not support ${mode}.`);
    const gpu = this.getNvidiaInfo();
    if (!gpu || gpu.totalVramGb < model.minVramGb) throw new Error(`${model.name} requires at least ${model.minVramGb} GB VRAM.`);
    if (os.totalmem() / (1024 ** 3) < model.minRamGb) throw new Error(`${model.name} requires at least ${model.minRamGb} GB system RAM.`);
    const prompt = String(body.prompt || "").trim();
    if (!prompt && mode === "text-to-video") throw new Error("A prompt is required.");
    if (prompt.length > 4000) throw new Error("Prompt must be 4000 characters or fewer.");
    const width = Number(body.width);
    const height = Number(body.height);
    if (!model.resolutions.some(item => item.width === width && item.height === height)) throw new Error("Unsupported resolution for the selected video model.");
    const frames = Number(body.frames);
    if (!Number.isInteger(frames) || frames < model.frames.min || frames > model.frames.max ||
        (frames !== model.frames.max && (frames - model.frames.min) % model.frames.step !== 0)) {
      throw new Error("Unsupported frame count for the selected video model.");
    }
    const fps = Number(body.fps);
    if (!Number.isInteger(fps) || fps < model.fps.min || fps > model.fps.max) throw new Error("Unsupported frame rate.");
    const steps = Number(body.steps);
    if (!Number.isInteger(steps) || steps < model.steps.min || steps > model.steps.max) throw new Error("Unsupported inference step count.");
    const guidance = Number(body.guidance);
    if (!Number.isFinite(guidance) || guidance < model.guidance.min || guidance > model.guidance.max) throw new Error("Unsupported guidance value.");
    let baseModelPath = null;
    if (model.requiresBaseModel) {
      const baseName = path.basename(String(body.baseModel || ""));
      const candidate = path.join(this.imageModelsDir, baseName);
      if (!baseName || !fs.existsSync(candidate) || !/\.(safetensors|ckpt)$/i.test(baseName)) {
        throw new Error("Select a compatible local SD 1.5 checkpoint.");
      }
      baseModelPath = candidate;
    }
    let inputImagePath = null;
    if (mode === "image-to-video") {
      const match = String(body.inputImage || "").match(/^data:image\/(?:png|jpeg|jpg|webp);base64,(.+)$/);
      if (!match) throw new Error("A PNG, JPEG, or WebP source image is required.");
      const buffer = Buffer.from(match[1], "base64");
      if (buffer.length > 25 * 1024 * 1024) throw new Error("Source image must be 25 MB or smaller.");
      const extension = detectImage(buffer);
      if (!extension) throw new Error("The source image data is invalid.");
      const name = `input-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`;
      inputImagePath = path.join(this.inputsDir, name);
      fs.writeFileSync(inputImagePath, buffer);
    }
    const seedValue = Number(body.seed);
    const seed = Number.isInteger(seedValue) && seedValue >= 0
      ? seedValue
      : crypto.randomInt(0, 2147483647);
    return {
      model,
      request: {
        modelId: model.id,
        mode,
        prompt,
        negativePrompt: String(body.negativePrompt || "").slice(0, 4000),
        width,
        height,
        frames,
        fps,
        steps,
        guidance,
        seed,
        baseModelPath,
        inputImagePath,
      },
    };
  }

  startJob(body) {
    if (this.activeJob) {
      const error = new Error("A video generation job is already active.");
      error.statusCode = 409;
      error.activeJob = this.activeJob;
      throw error;
    }
    const { model, request } = this.validateJob(body);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      modelId: model.id,
      mode: request.mode,
      status: "queued",
      phase: "Preparing GPU",
      progress: 1,
      current: 0,
      total: request.steps,
      elapsedSec: 0,
      error: null,
      output: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    if (request.inputImagePath) this.jobInputs.set(id, request.inputImagePath);
    if (this.jobs.size > 100) {
      const oldestFinished = [...this.jobs.values()].find(item => !["queued", "running"].includes(item.status));
      if (oldestFinished) this.jobs.delete(oldestFinished.id);
    }
    this.activeJob = job;
    void this.prepareJob(job, request, model);
    return job;
  }

  async prepareJob(job, request, model) {
    try {
      job.phase = "Unloading image backend";
      job.progress = 2;
      job.updatedAt = new Date().toISOString();
      await this.stopImageBackends();
      if (job.cancelRequested) {
        this.finishJob(job.id, { status: "cancelled", phase: "Cancelled", error: "Video generation cancelled." });
        return;
      }

      job.phase = "Checking available resources";
      job.progress = 3;
      job.updatedAt = new Date().toISOString();
      const gpu = this.getNvidiaInfo(true);
      const minimumFreeVramGb = model.tier === "Quality" ? 18 : 4;
      if (!gpu || gpu.freeVramGb < minimumFreeVramGb) {
        throw new Error(
          `${model.name} needs at least ${minimumFreeVramGb} GB of free VRAM to start. ` +
          `Only ${gpu?.freeVramGb ?? 0} GB is free. Close other GPU applications and retry.`,
        );
      }
      const virtualMemory = this.getWindowsVirtualMemoryInfo();
      const minimumFreeVirtualGb = model.tier === "Quality" ? 16 : 6;
      if (virtualMemory && virtualMemory.freeVirtualGb < minimumFreeVirtualGb) {
        throw new Error(
          `${model.name} needs at least ${minimumFreeVirtualGb} GB of available Windows virtual memory while loading. ` +
          `Only ${virtualMemory.freeVirtualGb} GB is available and the pagefile is ${virtualMemory.pageFileGb} GB. ` +
          "Enable a system-managed pagefile or close memory-heavy applications, then retry.",
        );
      }
      if (
        model.id === "svd-xt" &&
        request.frames > 14 &&
        virtualMemory &&
        virtualMemory.pageFileGb < 8
      ) {
        throw new Error(
          `Stable Video Diffusion XT at ${request.frames} frames requires at least an 8 GB Windows pagefile. ` +
          `The current pagefile is ${virtualMemory.pageFileGb} GB. Use 14 frames or enable a system-managed pagefile, then retry.`,
        );
      }

      job.phase = "Starting video worker";
      job.progress = 4;
      job.updatedAt = new Date().toISOString();
      await this.ensureWorker();
      if (job.cancelRequested) {
        this.finishJob(job.id, { status: "cancelled", phase: "Cancelled", error: "Video generation cancelled." });
        return;
      }

      job.phase = "Loading video model";
      job.progress = 5;
      job.updatedAt = new Date().toISOString();
      this.sendWorker({ command: "generate", jobId: job.id, ...request });
    } catch (err) {
      this.finishJob(job.id, {
        status: "error",
        phase: "Failed",
        error: err.message || String(err),
      });
    }
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (!["queued", "running"].includes(job.status)) return false;
    job.phase = "Cancelling";
    job.cancelRequested = true;
    job.updatedAt = new Date().toISOString();
    if (this.workerProc?.stdin?.writable) {
      this.sendWorker({ command: "cancel", jobId });
    }
    return true;
  }

  async unloadForImageBackend() {
    if (this.activeJob) throw new Error("Cancel the active video generation before loading an image model.");
    if (this.workerProc && this.workerReady) {
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          this.unloadWaiters = this.unloadWaiters.filter(item => item !== done);
          resolve();
        }, 10000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        this.unloadWaiters.push(done);
        this.sendWorker({ command: "unload" });
      });
    }
  }

  stopWorker() {
    if (!this.workerProc) return;
    try { this.sendWorker({ command: "shutdown" }); } catch (_) {}
    const proc = this.workerProc;
    if (process.platform === "win32" && proc.pid) {
      spawnSync("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      });
    } else {
      try { proc.kill("SIGKILL"); } catch (_) {}
    }
    this.workerProc = null;
    this.workerReady = false;
  }

  listOutputs() {
    try {
      return fs.readdirSync(this.outputsDir)
        .filter(name => name.endsWith(".mp4.json"))
        .map(name => {
          try {
            const metadata = JSON.parse(fs.readFileSync(path.join(this.outputsDir, name), "utf8"));
            if (!metadata.video || !fs.existsSync(path.join(this.outputsDir, path.basename(metadata.video)))) return null;
            return {
              ...metadata,
              metadata: name,
              url: `/api/video/output-file?filename=${encodeURIComponent(metadata.video)}`,
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

  deleteOutputs(outputs) {
    const deleted = [];
    for (const item of Array.isArray(outputs) ? outputs : []) {
      const video = path.basename(item?.video || item?.filename || "");
      const metadata = path.basename(item?.metadata || (video ? `${video}.json` : ""));
      for (const name of new Set([video, metadata].filter(Boolean))) {
        const target = path.join(this.outputsDir, name);
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
          deleted.push(name);
        }
      }
      if (item?.sourceImage) {
        const input = path.join(this.inputsDir, path.basename(item.sourceImage));
        if (fs.existsSync(input)) fs.unlinkSync(input);
      }
      if (item?.id) this.jobInputs.delete(item.id);
    }
    return deleted;
  }

  getOutputPath(filename) {
    const safeName = path.basename(filename || "");
    if (!safeName.toLowerCase().endsWith(".mp4")) return null;
    const target = path.join(this.outputsDir, safeName);
    return fs.existsSync(target) ? target : null;
  }

  getDiagnostics() {
    return {
      capabilities: this.getCapabilities(),
      models: this.listModels(),
      activeJob: this.activeJob,
      recentJobs: [...this.jobs.values()].slice(-10),
      outputCount: this.listOutputs().length,
    };
  }

  shutdown() {
    this.cancelDownload();
    if (this.runtimeProc) this.runtimeProc.kill("SIGTERM");
    this.stopWorker();
  }
}

module.exports = { VideoManager, VIDEO_MODELS };
