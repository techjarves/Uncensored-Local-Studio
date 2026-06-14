const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { VideoManager } = require("./video_manager.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-ai-video-test-"));
  const imageModelsDir = path.join(root, "app", "models");
  fs.mkdirSync(imageModelsDir, { recursive: true });
  fs.writeFileSync(path.join(imageModelsDir, "dreamshaper_sd15.safetensors"), "test");
  const manager = new VideoManager({
    root,
    imageModelsDir,
    stopImageBackends: async () => {},
  });
  manager.getNvidiaInfo = () => ({
    name: "Test GPU",
    totalVramGb: 16,
    freeVramGb: 15,
    computeCapability: "8.6",
    driverVersion: "test",
  });
  manager.isRuntimeInstalled = () => true;
  manager.isModelInstalled = () => true;
  return { root, imageModelsDir, manager };
}

test("hardware gates quality models while preserving starter compatibility", () => {
  const { root, manager } = fixture();
  try {
    const models = manager.listModels();
    assert.equal(models.find(model => model.id === "animatediff-sd15").compatible, true);
    const wan = models.find(model => model.id === "wan2.2-ti2v-5b");
    assert.equal(wan.compatible, false);
    assert.match(wan.blockers.join(" "), /24 GB VRAM/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime status uses the validated marker without importing PyTorch", () => {
  const { root, manager } = fixture();
  try {
    manager.isRuntimeInstalled = VideoManager.prototype.isRuntimeInstalled.bind(manager);
    const pythonPath = manager.getPythonPath();
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
    fs.writeFileSync(pythonPath, "");
    fs.mkdirSync(path.dirname(manager.getRuntimeMarker()), { recursive: true });
    fs.writeFileSync(manager.getRuntimeMarker(), JSON.stringify({ torch: "2.7.1+cu126" }));
    assert.equal(manager.isRuntimeInstalled(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model downloads reject hardware-incompatible profiles", () => {
  const { root, manager } = fixture();
  try {
    assert.throws(
      () => manager.startModelDownload("wan2.2-ti2v-5b"),
      /Requires 24 GB VRAM/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("job reservation is immediate and rejects duplicate startup requests", async () => {
  const { root, manager } = fixture();
  try {
    let sentCommand = null;
    manager.stopImageBackends = () => new Promise(resolve => setTimeout(resolve, 60));
    manager.ensureWorker = async () => {};
    manager.getWindowsVirtualMemoryInfo = () => ({ freeVirtualGb: 20, pageFileGb: 16 });
    manager.sendWorker = command => { sentCommand = command; };
    const request = {
      modelId: "animatediff-sd15",
      mode: "text-to-video",
      prompt: "A football rolls across a field.",
      width: 512,
      height: 512,
      frames: 16,
      fps: 8,
      steps: 20,
      guidance: 7.5,
      seed: 42,
      baseModel: "dreamshaper_sd15.safetensors",
    };

    const started = Date.now();
    const job = manager.startJob(request);
    assert.ok(Date.now() - started < 40);
    assert.equal(job.status, "queued");
    assert.equal(manager.activeJob.id, job.id);
    assert.throws(
      () => manager.startJob(request),
      error => error.statusCode === 409 && error.activeJob.id === job.id,
    );

    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(sentCommand.command, "generate");
    assert.equal(sentCommand.jobId, job.id);
  } finally {
    manager.activeJob = null;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("job preparation reports free VRAM blockers without starting the worker", async () => {
  const { root, manager } = fixture();
  try {
    manager.stopImageBackends = async () => {};
    manager.getNvidiaInfo = () => ({
      name: "Busy GPU",
      totalVramGb: 16,
      freeVramGb: 0.5,
      computeCapability: "8.6",
      driverVersion: "test",
    });
    let workerStarted = false;
    manager.ensureWorker = async () => { workerStarted = true; };
    const job = manager.startJob({
      modelId: "animatediff-sd15",
      mode: "text-to-video",
      prompt: "A football rolls across a field.",
      width: 512,
      height: 512,
      frames: 16,
      fps: 8,
      steps: 20,
      guidance: 7.5,
      seed: 42,
      baseModel: "dreamshaper_sd15.safetensors",
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(workerStarted, false);
    assert.equal(job.status, "error");
    assert.match(job.error, /Only 0.5 GB is free/);
  } finally {
    manager.activeJob = null;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("25-frame SVD fails before worker startup when the Windows pagefile is too small", async () => {
  const { root, manager } = fixture();
  try {
    manager.stopImageBackends = async () => {};
    manager.getWindowsVirtualMemoryInfo = () => ({ freeVirtualGb: 20, pageFileGb: 1 });
    let workerStarted = false;
    manager.ensureWorker = async () => { workerStarted = true; };
    const model = manager.listModels().find(item => item.id === "svd-xt");
    const job = {
      id: "svd-pagefile-test",
      status: "queued",
      phase: "Preparing GPU",
      progress: 1,
      current: 0,
      total: 10,
      elapsedSec: 0,
      error: null,
    };
    manager.jobs.set(job.id, job);
    manager.activeJob = job;

    await manager.prepareJob(job, { frames: 25 }, model);

    assert.equal(workerStarted, false);
    assert.equal(job.status, "error");
    assert.match(job.error, /requires at least an 8 GB Windows pagefile/);
  } finally {
    manager.activeJob = null;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loading heartbeats preserve the configured inference total", () => {
  const { root, manager } = fixture();
  try {
    const job = {
      id: "job-1",
      status: "queued",
      phase: "Loading video model",
      progress: 5,
      current: 0,
      total: 20,
      elapsedSec: 0,
    };
    manager.jobs.set(job.id, job);
    manager.handleWorkerMessage({
      type: "job-progress",
      jobId: job.id,
      phase: "Loading SD 1.5 checkpoint",
      progress: 12,
      current: 0,
      total: 0,
      elapsedSec: 8.5,
    });
    assert.equal(job.status, "running");
    assert.equal(job.total, 20);
    assert.equal(job.elapsedSec, 8.5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worker shutdown clears process state immediately", () => {
  const { root, manager } = fixture();
  try {
    let shutdownMessage = "";
    manager.workerProc = {
      pid: 999999,
      stdin: {
        writable: true,
        write: value => { shutdownMessage = value; },
      },
      kill: () => {},
    };
    manager.workerReady = true;
    manager.stopWorker();
    assert.match(shutdownMessage, /"command":"shutdown"/);
    assert.equal(manager.workerProc, null);
    assert.equal(manager.workerReady, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("job validation accepts supported values and rejects arbitrary resolutions", () => {
  const { root, manager } = fixture();
  try {
    const valid = manager.validateJob({
      modelId: "animatediff-sd15",
      mode: "text-to-video",
      prompt: "A slow camera pan across a city skyline.",
      width: 512,
      height: 512,
      frames: 16,
      fps: 8,
      steps: 20,
      guidance: 7.5,
      seed: 42,
      baseModel: "dreamshaper_sd15.safetensors",
    });
    assert.equal(valid.request.seed, 42);
    assert.equal(valid.request.baseModelPath.endsWith("dreamshaper_sd15.safetensors"), true);

    assert.throws(() => manager.validateJob({
      ...valid.request,
      baseModel: "dreamshaper_sd15.safetensors",
      width: 999,
    }), /Unsupported resolution/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("output listing ignores orphan metadata and protects paths", () => {
  const { root, manager } = fixture();
  try {
    const video = "video-1.mp4";
    fs.writeFileSync(path.join(manager.outputsDir, video), "mp4");
    fs.writeFileSync(path.join(manager.outputsDir, `${video}.json`), JSON.stringify({
      video,
      prompt: "test",
      createdAt: "2026-01-01T00:00:00Z",
    }));
    fs.writeFileSync(path.join(manager.outputsDir, "orphan.mp4.json"), JSON.stringify({ video: "missing.mp4" }));
    assert.equal(manager.listOutputs().length, 1);
    assert.equal(manager.getOutputPath("../video-1.mp4"), path.join(manager.outputsDir, video));
    assert.equal(manager.getOutputPath("../secret.txt"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
