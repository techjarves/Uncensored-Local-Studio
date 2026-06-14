// Tauri API helper for desktop mode, falling back to HTTP/Mock in browser
import { invoke } from "@tauri-apps/api/core";

// Helper to check if running inside Tauri desktop container
export const isTauri = () => {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
};

// Cached hardware specs
let cachedSpecs = null;
let cachedBackendPort = null;
export const EXPECTED_SERVER_BUILD = "polish-setup-v1";

const isLocalServerMode = () => {
  return typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
};

async function getBackendPort() {
  if (isLocalServerMode()) {
    try {
      const status = await getBackendStatus();
      const port = Number(status?.port);
      if (Number.isInteger(port) && port > 0) {
        cachedBackendPort = port;
        return port;
      }
    } catch (_) {}
  }
  if (cachedBackendPort) return cachedBackendPort;
  return 8080;
}

async function getBackendBaseUrl() {
  return `http://127.0.0.1:${await getBackendPort()}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function normalizeModel(model) {
  if (typeof model === "string") {
    return { filename: model, sizeBytes: 0, size: "Unknown" };
  }
  return {
    filename: model?.filename || model?.name || "",
    name: model?.name || model?.filename || "",
    sizeBytes: Number(model?.sizeBytes || 0),
    size: model?.size || (model?.sizeBytes ? formatBytes(model.sizeBytes) : "Unknown"),
    format: model?.format || "Local Weights File",
    backendType: model?.backendType || "",
    resolution: model?.resolution || "",
  };
}

async function readJsonResponse(res, fallbackMessage = "The local server returned an invalid response.") {
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text || "{}");
  } catch (_) {
    const looksLikeHtml = text.trim().startsWith("<!doctype") || text.trim().startsWith("<html");
    throw new Error(looksLikeHtml ? "The local server is serving an older frontend/API. Restart the image generator." : fallbackMessage);
  }

  if (!res.ok || data.ok === false) {
    if (data.error === "Unknown API endpoint") {
      throw new Error("Restart the image generator so the local server loads the latest API.");
    }
    throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  }
  return data;
}

export async function getHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await readJsonResponse(res, "The local server returned an invalid health response.");
    return {
      ...data,
      stale: data.build !== EXPECTED_SERVER_BUILD,
    };
  } catch (err) {
    return {
      ok: false,
      stale: true,
      build: "unknown",
      issues: [err.message || "Could not reach the local server."],
      checks: [],
      ports: {},
    };
  }
}

export async function getDiagnostics() {
  const res = await fetch("/api/diagnostics");
  return await readJsonResponse(res, "The local server returned invalid diagnostics.");
}

export async function getCleanupCandidates() {
  const res = await fetch("/api/cleanup-candidates");
  const data = await readJsonResponse(res, "The local server returned invalid cleanup data.");
  return data.candidates || [];
}

export async function cleanupCandidates(ids) {
  const res = await fetch("/api/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return await readJsonResponse(res, "The local server returned invalid cleanup data.");
}

// Get CPU and GPU specifications
export async function getHardwareSpecs() {
  if (cachedSpecs) return cachedSpecs;

  if (isTauri()) {
    try {
      cachedSpecs = await invoke("get_hardware_specs");
      return cachedSpecs;
    } catch (e) {
      console.warn("Failed to get hardware specs via Tauri, using fallback:", e);
    }
  }

  if (isLocalServerMode()) {
    try {
      const res = await fetch("/api/hardware-specs");
      if (res.ok) {
        cachedSpecs = await res.json();
        return cachedSpecs;
      }
    } catch (e) {
      console.warn("Failed to get hardware specs from local server:", e);
    }
  }

  // Static preview fallback. Do not invent host hardware.
  cachedSpecs = {
    os_name: "Unavailable",
    cpu_name: "Unavailable",
    cpu_cores_physical: 4,
    cpu_cores_logical: 4,
    ram_total_gb: 0,
    gpu_name: "Unavailable",
  };
  return cachedSpecs;
}

// Get CPU/RAM/VRAM real-time utilization
export async function getTelemetry() {
  if (isTauri()) {
    try {
      const stats = await invoke("get_telemetry");
      return stats;
    } catch (e) {
      // Ignore and use fallback
    }
  }

  if (isLocalServerMode()) {
    try {
      const res = await fetch("/api/telemetry");
      if (res.ok) {
        return await res.json();
      }
    } catch (_) {}
  }

  return {
    cpu_usage: 0,
    ram_used_gb: 0,
    ram_total_gb: 0,
    gpu_name: "Unavailable",
    vram_used_gb: 0,
    vram_total_gb: 0,
  };
}

export async function getBackendOptions() {
  if (isLocalServerMode()) {
    try {
      const res = await fetch("/api/backend-options");
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn("Failed to get backend options from local server:", e);
    }
  }

  return {
    options: [{ id: "cpu", label: "CPU", available: true }],
    cudaAvailable: false,
    vulkanAvailable: false,
    defaultBackendType: "cpu",
  };
}

// Get list of model files on the USB
export async function listLocalModels() {
  if (isTauri()) {
    try {
      return await invoke("list_local_models");
    } catch (e) {
      console.warn("Failed to list local models via Tauri:", e);
    }
  }

  const isLocalServerMode = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  if (isLocalServerMode) {
    return await listModelsFromDisk();
  }

  // Static preview fallback: show only models the user imported in this browser.
  let saved = localStorage.getItem("imported-models");
  if (saved === null) {
    localStorage.setItem("imported-models", JSON.stringify([]));
    saved = "[]";
  }
  const imported = JSON.parse(saved);
  return imported.map(normalizeModel);
}

// Start (or restart) backend stable-diffusion.cpp server with correct CLI flags
// In web/portable mode this calls serve.cjs management API which restarts the
// sd-vulkan.exe process with --steps, --cfg-scale, --sampling-method flags.
export async function startServer(modelPath, constraints) {
  const backendPort = await getBackendPort();
  if (isTauri()) {
    const launchParams = {
      model_path: modelPath,
      port: backendPort,
      use_gpu: constraints.useGpu !== false,
      backend_type: constraints.backendType || (constraints.useGpu === false ? "cpu" : "auto"),
      threads: constraints.threads || 8,
    };
    return await invoke("start_server", { params: launchParams });
  }

  // Web/portable mode — call serve.cjs management API
  const modelName = modelPath ? modelPath.split(/[\\/]/).pop() : null;
  try {
    const res = await fetch("/api/restart-backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model:    modelName,
        steps:    constraints.steps    || 20,
        cfgScale: constraints.cfgScale || 7.0,
        sampler:  constraints.sampler  || "euler_a",
        threads:  constraints.threads  || 8,
        use_gpu:  constraints.useGpu !== false,
        backend_type: constraints.backendType || (constraints.useGpu === false ? "cpu" : "auto"),
        width: constraints.width || 512,
        height: constraints.height || 512,
        vae_tiling: constraints.vaeTiling !== false,
        vae_on_cpu: constraints.vaeOnCpu === true,
        flash_attn: constraints.useFlashAttn !== false,
      }),
    });
    const text = await res.text();
    const data = JSON.parse(text || "{}");
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Backend restart failed (HTTP ${res.status})`);
    }
    if (Number.isInteger(Number(data.port)) && Number(data.port) > 0) {
      cachedBackendPort = Number(data.port);
    }
    console.log("Backend restart:", data.message);
    return data.message;
  } catch (e) {
    console.warn("Could not reach management API:", e.message);
    if (isLocalServerMode()) {
      throw e;
    }
    return "Backend management unavailable";
  }
}

// Stop backend server
export async function stopServer() {
  if (isTauri()) {
    return await invoke("stop_server");
  }
  try {
    await fetch("/api/stop-backend", { method: "POST" });
  } catch (_) {}
  return "Backend stopped";
}

// Get current backend status and active settings
export async function getBackendStatus() {
  try {
    const r = await fetch("/api/backend-status");
    return await r.json();
  } catch (_) {
    return { ready: false, settings: {} };
  }
}

export async function listGeneratedOutputs() {
  try {
    const res = await fetch("/api/outputs");
    const data = await res.json();
    return data.outputs || [];
  } catch (_) {
    return [];
  }
}

export async function saveGeneratedOutput(image, metadata) {
  const res = await fetch("/api/save-output", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, metadata }),
  });
  const data = await readJsonResponse(res, "The local server returned an invalid save response.");
  return data.output;
}

export async function deleteGeneratedOutputs(outputs) {
  const res = await fetch("/api/delete-outputs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputs }),
  });
  return await readJsonResponse(res, "The local server returned an invalid delete response.");
}

// List model files from the models folder (via management API in web mode)
export async function listModelsFromDisk() {
  try {
    const [modelRes, openvino] = await Promise.all([
      fetch("/api/models"),
      listOpenVinoModels().catch(() => ({ supported: false, models: [] })),
    ]);
    const data = await modelRes.json();
    const normalModels = (data.models || []).map(normalizeModel);
    const openvinoModels = openvino.supported
      ? (openvino.models || []).filter((model) => model.installed).map((model) => normalizeModel({
          filename: model.id,
          name: model.name,
          sizeBytes: model.sizeBytes,
          size: model.size,
          format: "OpenVINO",
          backendType: "openvino-npu",
          resolution: model.resolution,
        }))
      : [];
    return [...normalModels, ...openvinoModels];
  } catch (_) {
    return [];
  }
}

export async function listOpenVinoModels() {
  const res = await fetch("/api/openvino-models");
  return await readJsonResponse(res, "The local server returned invalid OpenVINO model data.");
}

// Generate image (T2I / I2I)
// Handles API calls to sd-server. If the server is unreachable or returns an error,
// we surface that error to the UI instead of silently returning a fake placeholder.
export async function generateImage(prompt, negativePrompt, constraints, activeModelName, inputImageBase64, onProgress, signal) {
  console.log("Initiating image generation:", { prompt, negativePrompt, constraints, activeModelName });
  const startTime = Date.now();

  // Prepare payload based on standard stable-diffusion.cpp REST endpoint schemas
  const payload = {
    prompt: prompt,
    negative_prompt: negativePrompt || "",
    width: constraints.width || 512,
    height: constraints.height || 512,
    steps: constraints.steps || 20,
    cfg_scale: constraints.cfgScale || 7.0,
    seed: constraints.seed === -1 ? Math.floor(Math.random() * 1000000) : constraints.seed,
    sampler: constraints.sampler || "euler_a",
    image: inputImageBase64 || null, // Image to image source (base64)
    denoising_strength: constraints.denoisingStrength || 0.7,
  };

  if (constraints.backendType === "openvino-npu") {
    if (inputImageBase64) {
      throw new Error("OpenVINO NPU test mode currently supports text-to-image only.");
    }
    const response = await fetch("/api/openvino-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        prompt: payload.prompt,
        negative_prompt: payload.negative_prompt,
        steps: payload.steps,
        cfg_scale: payload.cfg_scale,
        seed: payload.seed,
        width: payload.width,
        height: payload.height,
      }),
    });
    const data = await readJsonResponse(response, "The local server returned an invalid OpenVINO generation response.");
    const imgB64 = data?.data?.[0]?.b64_json;
    if (!imgB64) throw new Error("OpenVINO generation did not return an image.");
    const normalizedB64 = String(imgB64).replace(/^data:[^;]+;base64,/, "");
    const header = atob(normalizedB64.slice(0, 24));
    const isPng = header.charCodeAt(0) === 0x89 && header.slice(1, 4) === "PNG";
    const isJpeg = header.charCodeAt(0) === 0xff && header.charCodeAt(1) === 0xd8 && header.charCodeAt(2) === 0xff;
    const isWebp = header.slice(0, 4) === "RIFF" && header.slice(8, 12) === "WEBP";
    if (!isPng && !isJpeg && !isWebp) {
      throw new Error("OpenVINO generation returned an invalid image payload instead of a real PNG/JPEG/WebP.");
    }
    const durationSec = Number(data.duration_sec) || parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
    return {
      image: `data:image/png;base64,${normalizedB64}`,
      seed: data.data?.[0]?.seed ?? payload.seed,
      duration_sec: durationSec,
    };
  }

  const baseUrl = await getBackendBaseUrl();


  // txt2img uses /v1/images/generations; img2img uses /sdapi/v1/img2img.
  const isImg2Img = !!payload.image;
  let endpoint = `${baseUrl}/v1/images/generations`;

  let genBody = {
    prompt:           payload.prompt,
    negative_prompt:  payload.negative_prompt || "",
    n:                1,
    size:             `${payload.width}x${payload.height}`,
    response_format:  "b64_json",
    // Generation parameters — read by stable-diffusion.cpp from the request body
    steps:            payload.steps,
    cfg_scale:        payload.cfg_scale,
    seed:             payload.seed,
    sample_method:    payload.sampler || "euler_a",
  };

  // img2img extra fields
  if (isImg2Img) {
    const initBase64 = String(payload.image).replace(/^data:[^;]+;base64,/, "");
    endpoint = `${baseUrl}/sdapi/v1/img2img`;
    genBody = {
      init_images:        [initBase64],
      prompt:             payload.prompt,
      negative_prompt:    payload.negative_prompt || "",
      denoising_strength: payload.denoising_strength || 0.7,
      steps:              payload.steps,
      cfg_scale:          payload.cfg_scale,
      seed:               payload.seed,
      width:              payload.width,
      height:             payload.height,
      sampler_name:       payload.sampler || "euler_a",
      sample_method:      payload.sampler || "euler_a",
      batch_size:         1,
      n_iter:             1,
      send_images:        true,
      save_images:        false,
    };
  }

  // Attempt real HTTP call
  try {
    const response = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  signal,
      body:    JSON.stringify(genBody),
    });

    if (response.ok) {
      const data = await response.json();
      // Response: { data: [{ b64_json: "..." }] }
      const imgB64 = data?.data?.[0]?.b64_json ?? data?.images?.[0];
      if (imgB64) {
        const normalizedB64 = String(imgB64).replace(/^data:[^;]+;base64,/, "");
        const header = atob(normalizedB64.slice(0, 24));
        const isPng = header.charCodeAt(0) === 0x89 && header.slice(1, 4) === "PNG";
        const isJpeg = header.charCodeAt(0) === 0xff && header.charCodeAt(1) === 0xd8 && header.charCodeAt(2) === 0xff;
        const isWebp = header.slice(0, 4) === "RIFF" && header.slice(8, 12) === "WEBP";
        if (!isPng && !isJpeg && !isWebp) {
          throw new Error("Generation returned an invalid image payload instead of a real PNG/JPEG/WebP.");
        }
        const durationSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
        return {
          image:        `data:image/png;base64,${normalizedB64}`,
          seed:         data.data?.[0]?.seed ?? payload.seed,
          duration_sec: durationSec,
        };
      }
    } else {
      let errMsg = `Generation failed (HTTP ${response.status})`;
      try {
        const errJson = await response.json();
        if (errJson?.detail || errJson?.error?.message) {
          errMsg = errJson.detail || errJson.error.message;
        }
      } catch (_) {}
      throw new Error(errMsg);
    }
  } catch (err) {
    if (err.name === "AbortError" || err.message.startsWith("Generation failed")) throw err;
    console.warn("Could not reach local server.", err);
    throw new Error(
      "The image generation server is not responding or crashed. " +
      "Try restarting the backend from Model Manager, or check the terminal for a backend error."
    );
  }
}

// Perform model file import (copy to USB in Tauri, simulated in Web mode)
export async function importModelFile(sourcePath, onProgress, signal) {
  if (sourcePath instanceof File) {
    const file = sourcePath;
    const isLocalMode = isLocalServerMode();
    if (!isLocalMode) {
      throw new Error("File import requires the local image generator server.");
    }

    await uploadModelFile(file, onProgress, signal);
    return { response: "Model imported successfully" };
  }

  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    
    let unlisten = null;
    if (onProgress) {
      unlisten = await listen("import-progress", (event) => {
        onProgress(event.payload);
      });
    }

    try {
      const response = await invoke("import_model_file", { sourcePath });
      return { response, unlisten };
    } catch (e) {
      if (unlisten) unlisten();
      throw e;
    }
  }

  // Fallback simulation in browser
  const filename = sourcePath.split(/[\\/]/).pop() || "imported_model.gguf";
  console.log(`Web Mode: Simulating copying ${filename} to USB models folder`);
  
  const totalSteps = 40;
  const start = Date.now();

  for (let i = 1; i <= totalSteps; i++) {
    if (signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }
    await new Promise((r) => setTimeout(r, 150)); // ~6 seconds copy total
    const progress = (i / totalSteps) * 100;
    const elapsedSecs = (Date.now() - start) / 1000;
    const speed = 40 + Math.sin(i) * 5 + Math.random() * 2; // ~42 MB/s
    const eta = (totalSteps - i) * 0.15;

    if (onProgress) {
      onProgress({
        filename,
        progress,
        speed_mb_s: speed,
        eta_secs: eta,
        status: "Copying to USB..."
      });
    }
  }

  // Save to localStorage
  const saved = localStorage.getItem("imported-models");
  const imported = saved ? JSON.parse(saved) : [];
  if (!imported.includes(filename)) {
    imported.push({ filename, sizeBytes: 0, size: "Unknown" });
    localStorage.setItem("imported-models", JSON.stringify(imported));
  }

  return { response: "Model imported successfully" };
}

function uploadModelFile(file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const startedAt = Date.now();
    let abortedByUser = false;

    xhr.open("POST", `/api/import-model?filename=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    const abortUpload = () => {
      abortedByUser = true;
      xhr.abort();
    };
    if (signal) {
      if (signal.aborted) {
        abortUpload();
      } else {
        signal.addEventListener("abort", abortUpload, { once: true });
      }
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) return;

      const elapsedSecs = Math.max(0.1, (Date.now() - startedAt) / 1000);
      const speedBytes = event.loaded / elapsedSecs;
      const remainingBytes = Math.max(0, event.total - event.loaded);
      onProgress({
        filename: file.name,
        progress: (event.loaded / event.total) * 100,
        speed_mb_s: speedBytes / (1024 * 1024),
        eta_secs: remainingBytes / Math.max(1, speedBytes),
        status: "Copying to models folder..."
      });
    };

    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch (_) {}

      if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) {
        if (onProgress) {
          onProgress({
            filename: file.name,
            progress: 100,
            speed_mb_s: 0,
            eta_secs: 0,
            status: "Import complete"
          });
        }
        resolve(data);
      } else {
        reject(new Error(data.error || `Import failed (HTTP ${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error("Import failed while uploading the file."));
    xhr.onabort = () => reject(new DOMException(abortedByUser ? "Import cancelled by user." : "Import aborted.", "AbortError"));
    xhr.send(file);
  });
}

// Delete model file (Tauri disk deletion or localStorage cleanup)
export async function deleteModel(filename) {
  if (isTauri()) {
    return await invoke("delete_model_file", { filename });
  }

  const isLocalServerMode = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  if (isLocalServerMode) {
    try {
      const res = await fetch("/api/delete-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete model file");
      }
      return data;
    } catch (err) {
      console.error("Failed to delete model via local API:", err);
      throw err;
    }
  }

  // Browser Mode
  const saved = localStorage.getItem("imported-models");
  let imported = saved ? JSON.parse(saved) : [];
  imported = imported.filter((model) => normalizeModel(model).filename !== filename);
  localStorage.setItem("imported-models", JSON.stringify(imported));
  return `Simulated deletion of ${filename} from browser session`;
}

// Ping the server to check if it is active and responding
export async function pingServer() {
  const baseUrl = await getBackendBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { method: "GET" });
    return response.ok;
  } catch (e) {
    return false;
  }
}

// Wait for the server to be ready by polling
export async function waitForServerReady(maxAttempts = 30) {
  const attempts = isTauri() || isLocalServerMode() ? maxAttempts : 3;
  for (let i = 0; i < attempts; i++) {
    let ok = false;
    if (isLocalServerMode()) {
      const status = await getBackendStatus();
      ok = Boolean(status.ready);
    } else {
      ok = await pingServer();
    }
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500)); // check every 500ms
  }
  return false;
}

// Start model file download from a URL on the server
export async function downloadModel(url) {
  try {
    const res = await fetch("/api/download-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    return await res.json();
  } catch (e) {
    console.error("Failed to start model download:", e);
    return { ok: false, error: e.message };
  }
}

export async function downloadOpenVinoModel(modelId) {
  try {
    const res = await fetch("/api/download-openvino-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId })
    });
    return await readJsonResponse(res, "The local server returned an invalid OpenVINO download response.");
  } catch (e) {
    console.error("Failed to start OpenVINO model download:", e);
    return { ok: false, error: e.message };
  }
}

export async function cancelModelDownload() {
  try {
    const res = await fetch("/api/cancel-download", { method: "POST" });
    return await res.json();
  } catch (e) {
    console.error("Failed to cancel model download:", e);
    return { ok: false, error: e.message };
  }
}

// Get the server-side model download progress
export async function getDownloadProgress() {
  try {
    const res = await fetch("/api/download-progress");
    return await res.json();
  } catch (e) {
    console.error("Failed to get download progress:", e);
    return { active: false, error: e.message };
  }
}

// Get the server-side image generation progress
export async function getGenerationProgress() {
  try {
    const res = await fetch("/api/generation-progress");
    return await res.json();
  } catch (e) {
    console.error("Failed to get generation progress:", e);
    return { active: false, error: e.message };
  }
}


