// Tauri API helper for desktop mode, falling back to HTTP/Mock in browser
import { invoke } from "@tauri-apps/api/core";

// Helper to check if running inside Tauri desktop container
export const isTauri = () => {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
};

// Cached hardware specs
let cachedSpecs = null;
export const EXPECTED_SERVER_BUILD = "polish-setup-v1";

const isLocalServerMode = () => {
  return typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
};

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
    sizeBytes: Number(model?.sizeBytes || 0),
    size: model?.size || (model?.sizeBytes ? formatBytes(model.sizeBytes) : "Unknown"),
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
  if (isTauri()) {
    const launchParams = {
      model_path: modelPath,
      port: 8080,
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
        vae_tiling: constraints.vaeTiling !== false,
        vae_on_cpu: constraints.vaeOnCpu === true,
      }),
    });
    const text = await res.text();
    const data = JSON.parse(text || "{}");
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Backend restart failed (HTTP ${res.status})`);
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
    const r = await fetch("/api/models");
    const data = await r.json();
    return (data.models || []).map(normalizeModel);
  } catch (_) {
    return [];
  }
}

// Generate image (T2I / I2I)
// Handles API calls to sd-server or mocks them if server is unreachable
export async function generateImage(prompt, negativePrompt, constraints, activeModelName, inputImageBase64, onProgress, signal) {
  console.log("Initiating image generation:", { prompt, negativePrompt, constraints, activeModelName });
  const startTime = Date.now();

  const port = 8080;
  const baseUrl = `http://127.0.0.1:${port}`;
  
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

  // Mock generation helper for offline/browser execution
  const runMockGeneration = async () => {
    // Simulate generation steps progress
    const stepsCount = payload.steps;
    for (let i = 1; i <= stepsCount; i++) {
      if (signal && signal.aborted) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      await new Promise(r => setTimeout(r, (3000 / stepsCount))); // 3 seconds total
      if (onProgress) {
        onProgress(Math.round((i / stepsCount) * 100));
      }
    }

    const pLower = prompt.toLowerCase();
    const seedVal = Math.abs(payload.seed) || Math.floor(Math.random() * 1000);

    // Generate a beautiful, local vector SVG representing the requested subject, completely offline-compatible
    const primaryBg = "#0F172A"; // dark premium background
    let gradientStart = "#3B82F6";
    let gradientEnd = "#8B5CF6";
    let sceneShapes = "";
    let keywordLabel = "Abstract Generation";

    if (pLower.includes("moon") || pLower.includes("space") || pLower.includes("astronomy") || pLower.includes("sky")) {
      gradientStart = "#1E293B";
      gradientEnd = "#0F172A";
      keywordLabel = "Luminous Moon in Starry Sky";
      sceneShapes = `
        <!-- Stars -->
        <circle cx="80" cy="100" r="1.5" fill="#ffffff" opacity="0.6"/>
        <circle cx="160" cy="60" r="1" fill="#ffffff" opacity="0.5"/>
        <circle cx="280" cy="120" r="2" fill="#ffffff" opacity="0.8"/>
        <circle cx="360" cy="80" r="1.5" fill="#ffffff" opacity="0.4"/>
        <circle cx="440" cy="150" r="1" fill="#ffffff" opacity="0.7"/>
        <circle cx="400" cy="280" r="2" fill="#ffffff" opacity="0.9"/>
        <circle cx="100" cy="300" r="1.5" fill="#ffffff" opacity="0.5"/>
        <!-- Moon -->
        <circle cx="256" cy="220" r="90" fill="url(#moonGrad)" />
        <circle cx="226" cy="190" r="80" fill="#0F172A" />
      `;
    } else if (pLower.includes("cat") || pLower.includes("kitten") || pLower.includes("feline")) {
      gradientStart = "#4F46E5";
      gradientEnd = "#7C3AED";
      keywordLabel = "Stylized Cat Portrait";
      sceneShapes = `
        <!-- Cat head & ears -->
        <polygon points="176,280 146,160 216,210" fill="#312E81" />
        <polygon points="336,280 366,160 296,210" fill="#312E81" />
        <circle cx="256" cy="270" r="80" fill="#4338CA" />
        <!-- Eyes -->
        <ellipse cx="226" cy="260" rx="14" ry="8" fill="#10B981" />
        <ellipse cx="286" cy="260" rx="14" ry="8" fill="#10B981" />
        <circle cx="226" cy="260" r="4" fill="#000" />
        <circle cx="286" cy="260" r="4" fill="#000" />
        <!-- Nose & Whiskers -->
        <polygon points="256,285 248,275 264,275" fill="#F43F5E" />
        <line x1="226" y1="290" x2="166" y2="280" stroke="#E2E8F0" stroke-width="2" />
        <line x1="226" y1="295" x2="156" y2="295" stroke="#E2E8F0" stroke-width="2" />
        <line x1="286" y1="290" x2="346" y2="280" stroke="#E2E8F0" stroke-width="2" />
        <line x1="286" y1="295" x2="356" y2="295" stroke="#E2E8F0" stroke-width="2" />
      `;
    } else if (pLower.includes("dog") || pLower.includes("puppy") || pLower.includes("canine")) {
      gradientStart = "#D97706";
      gradientEnd = "#B45309";
      keywordLabel = "Friendly Dog Portrait";
      sceneShapes = `
        <!-- Dog head & floppy ears -->
        <ellipse cx="166" cy="260" rx="20" ry="60" fill="#78350F" />
        <ellipse cx="346" cy="260" rx="20" ry="60" fill="#78350F" />
        <circle cx="256" cy="250" r="70" fill="#92400E" />
        <ellipse cx="256" cy="280" rx="40" ry="30" fill="#D97706" />
        <!-- Eyes -->
        <circle cx="226" cy="230" r="10" fill="#1E293B" />
        <circle cx="286" cy="230" r="10" fill="#1E293B" />
        <circle cx="222" cy="226" r="3" fill="#ffffff" />
        <circle cx="282" cy="226" r="3" fill="#ffffff" />
        <!-- Nose -->
        <ellipse cx="256" cy="275" rx="16" ry="10" fill="#1E293B" />
      `;
    } else if (pLower.includes("city") || pLower.includes("cyberpunk") || pLower.includes("tokyo") || pLower.includes("neon")) {
      gradientStart = "#111827";
      gradientEnd = "#311042";
      keywordLabel = "Neon Cyberpunk Skyline";
      sceneShapes = `
        <!-- Skyline -->
        <rect x="60" y="160" width="80" height="352" fill="#1F2937" opacity="0.9"/>
        <rect x="180" y="100" width="100" height="412" fill="#111827" />
        <rect x="320" y="200" width="120" height="312" fill="#1F2937" opacity="0.85"/>
        <rect x="100" y="240" width="110" height="272" fill="#374151" opacity="0.6"/>
        <!-- Neon details -->
        <line x1="230" y1="100" x2="230" y2="40" stroke="#EC4899" stroke-width="3" />
        <rect x="200" y="140" width="60" height="15" fill="#10B981" opacity="0.7"/>
        <rect x="200" y="170" width="60" height="15" fill="#10B981" opacity="0.7"/>
        <rect x="200" y="200" width="60" height="15" fill="#3B82F6" opacity="0.7"/>
        <rect x="70" y="200" width="15" height="100" fill="#F59E0B" opacity="0.5"/>
        <rect x="340" y="250" width="20" height="150" fill="#EF4444" opacity="0.6"/>
      `;
    } else if (pLower.includes("car") || pLower.includes("vehicle") || pLower.includes("supercar")) {
      gradientStart = "#DC2626";
      gradientEnd = "#991B1B";
      keywordLabel = "Futuristic Concept Car";
      sceneShapes = `
        <!-- Road / Perspective grid -->
        <line x1="256" y1="350" x2="0" y2="512" stroke="#4B5563" stroke-width="3" />
        <line x1="256" y1="350" x2="512" y2="512" stroke="#4B5563" stroke-width="3" />
        <!-- Car body -->
        <polygon points="126,380 256,330 386,380 346,440 166,440" fill="#EF4444" />
        <polygon points="176,370 256,340 336,370 326,390 186,390" fill="#1E293B" opacity="0.9" />
        <!-- Headlights -->
        <polygon points="136,410 176,415 166,425 136,420" fill="#FBBF24" />
        <polygon points="376,410 336,415 346,425 376,420" fill="#FBBF24" />
        <!-- Wheels -->
        <ellipse cx="156" cy="440" rx="30" ry="15" fill="#111" />
        <ellipse cx="356" cy="440" rx="30" ry="15" fill="#111" />
      `;
    } else {
      // General gradient waves
      gradientStart = "#06B6D4";
      gradientEnd = "#0891B2";
      keywordLabel = "Abstract Creative Concept";
      sceneShapes = `
        <path d="M0,256 C150,150 350,350 512,256 L512,512 L0,512 Z" fill="#0891B2" opacity="0.4" />
        <path d="M0,350 C200,200 300,450 512,350 L512,512 L0,512 Z" fill="#0E7490" opacity="0.6" />
        <circle cx="380" cy="180" r="50" fill="#F59E0B" opacity="0.8" />
      `;
    }

    const svgString = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
        <defs>
          <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${gradientStart}" />
            <stop offset="100%" stop-color="${gradientEnd}" />
          </linearGradient>
          <linearGradient id="moonGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#FEF08A" />
            <stop offset="100%" stop-color="#FDE047" />
          </linearGradient>
        </defs>
        
        <!-- Background -->
        <rect width="512" height="512" fill="url(#bgGrad)" />
        
        <!-- Shapes -->
        ${sceneShapes}
        
        <!-- Premium UI Overlay Frame -->
        <rect x="20" y="20" width="472" height="472" fill="none" stroke="#ffffff" stroke-width="1.5" opacity="0.15" rx="8"/>
        
        <!-- Prompt & Details text -->
        <rect x="40" y="410" width="432" height="62" fill="#0F172A" opacity="0.85" rx="6" />
        <text x="60" y="435" fill="#F1F5F9" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="bold">${keywordLabel}</text>
        <text x="60" y="455" fill="#94A3B8" font-family="system-ui, -apple-system, sans-serif" font-size="11">Seed: ${seedVal} • Steps: ${payload.steps} • Scale: ${payload.cfg_scale}</text>
      </svg>
    `;

    const base64Svg = btoa(unescape(encodeURIComponent(svgString)));
    const mockImageUrl = `data:image/svg+xml;base64,${base64Svg}`;
    const durationSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
    
    return {
      image: mockImageUrl,
      seed: payload.seed,
      duration_sec: durationSec,
    };
  };

  // stable-diffusion.cpp server only exposes /v1/images/generations (OpenAI-compat)
  // Steps, cfg_scale, seed, sample_method are passed in the body and read by the server
  const isImg2Img = !!payload.image;

  const genBody = {
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
    genBody.init_images        = [payload.image];
    genBody.denoising_strength = payload.denoising_strength || 0.7;
  }

  // Attempt real HTTP call
  try {
    const response = await fetch(`${baseUrl}/v1/images/generations`, {
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
        const durationSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
        return {
          image:        `data:image/png;base64,${imgB64}`,
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
    console.warn("Could not reach local server. Falling back to simulation mode.", err);
  }

  // Fallback to mock generation if server is offline/not reachable
  return await runMockGeneration();
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
  const port = 8080;
  const baseUrl = `http://127.0.0.1:${port}`;
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


