import React, { memo, useState, useEffect } from "react";
import { FolderOpen, DownloadCloud, RefreshCw, Database, Trash2, Square, HardDrive, Library, AlertTriangle } from "lucide-react";
import { listLocalModels, startServer, stopServer, importModelFile, deleteModel, downloadModel, downloadOpenVinoModel, cancelModelDownload, getDownloadProgress, getBackendStatus, pingServer, formatBytes, normalizeModel } from "../services/api";

const MODEL_LIBRARY = [
  {
    group: "SDXL - Best Quality",
    items: [
      {
        name: "Juggernaut XL v9 Lightning",
        filename: "Juggernaut_RunDiffusionPhoto2_Lightning_4Steps.safetensors",
        format: "Safetensors",
        approxSize: "6.6 GB",
        resolution: "1024x1024",
        notes: "Photorealistic SDXL model tuned for 4-8 step Lightning generation.",
        url: "https://huggingface.co/RunDiffusion/Juggernaut-XL-Lightning/resolve/main/Juggernaut_RunDiffusionPhoto2_Lightning_4Steps.safetensors",
      },
      {
        name: "DreamShaper XL Lightning",
        filename: "DreamShaperXL_Lightning.safetensors",
        format: "Safetensors",
        approxSize: "6.6 GB",
        resolution: "1024x1024",
        notes: "All-around SDXL model for fantasy art, renders, illustration, and stylized images.",
        url: "https://huggingface.co/Lykon/dreamshaper-xl-lightning/resolve/main/DreamShaperXL_Lightning.safetensors",
      },
    ],
  },
  {
    group: "SD 1.5 - Ultra Fast / Low VRAM",
    items: [
      {
        name: "DreamShaper 8",
        filename: "DreamShaper_8_pruned.safetensors",
        format: "Safetensors",
        approxSize: "2.1 GB",
        resolution: "512x512",
        notes: "General-purpose SD 1.5 model for illustration, anime, and semi-realistic portraits.",
        url: "https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors",
      },
      {
        name: "CyberRealistic V8",
        filename: "CyberRealistic_V8_FP16.safetensors",
        format: "Safetensors",
        approxSize: "2.1 GB",
        resolution: "512x512",
        notes: "High-fidelity realism and photorealism in the SD 1.5 ecosystem.",
        url: "https://huggingface.co/cyberdelia/CyberRealistic/resolve/main/CyberRealistic_V8_FP16.safetensors",
      },
      {
        name: "ReV Animated v1.2.2",
        filename: "rev-animated-v1-2-2.safetensors",
        format: "Safetensors",
        approxSize: "2.1 GB",
        resolution: "512x512",
        notes: "Semi-realistic, 2.5D, anime, fantasy, and stylized digital art.",
        url: "https://huggingface.co/danbrown/RevAnimated-v1-2-2/resolve/main/rev-animated-v1-2-2.safetensors",
      },
    ],
  },
];

const OPENVINO_MODEL_LIBRARY = [
  {
    group: "Intel NPU - OpenVINO Test",
    items: [
      {
        id: "lcm-dreamshaper-v7-fp16",
        name: "LCM DreamShaper v7 FP16",
        filename: "lcm-dreamshaper-v7-fp16",
        format: "OpenVINO",
        backendType: "openvino-npu",
        approxSize: "2.0 GB",
        resolution: "512x512",
        notes: "NPU test model for Windows and Linux. Runs the text encoder on CPU, UNet on Intel NPU, and VAE decoder on Intel GPU or CPU fallback.",
        url: "https://huggingface.co/OpenVINO/LCM_Dreamshaper_v7-fp16-ov",
      },
    ],
  },
];

function ModelManager({ activeModel, setActiveModel, serverRunning, setServerRunning, constraints, backendOptions, showAlert = async ({ message }) => window.alert(message), showConfirm = async ({ message }) => window.confirm(message) }) {
  const [localModels, setLocalModels] = useState([]);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [downloadingModelId, setDownloadingModelId] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState("");
  const [loadingModelId, setLoadingModelId] = useState(null);
  const [modelLoadProgress, setModelLoadProgress] = useState(null);
  const [importProgress, setImportProgress] = useState(null); // null when not importing
  const [importInfo, setImportInfo] = useState({ filename: "", speed: "0.0", eta: 0, status: "" });
  const [downloadUrl, setDownloadUrl] = useState("");
  const [importAbortController, setImportAbortController] = useState(null);
  const [isUnloading, setIsUnloading] = useState(false);
  const [unloadProgress, setUnloadProgress] = useState({ progress: 0, phase: "" });
  const [pendingLoadModel, setPendingLoadModel] = useState(null);
  const [backendInfo, setBackendInfo] = useState({ backendMode: "", backendBinary: "", backendDevice: "" });

  const modelNames = localModels.map((model) => normalizeModel(model).filename);
  const isBusy = loadingModelId !== null || isUnloading;
  const openvinoSupported = Boolean(backendOptions?.openvinoNpu?.supported);
  const visibleModelLibrary = openvinoSupported ? [...MODEL_LIBRARY, ...OPENVINO_MODEL_LIBRARY] : MODEL_LIBRARY;
  const getLocalModelInfo = (modelId) => localModels.map(normalizeModel).find((model) => model.filename === modelId);

  useEffect(() => {
    fetchModels();
    checkActiveDownload();
  }, []);

  useEffect(() => {
    if (!serverRunning && !loadingModelId) {
      setBackendInfo({ backendMode: "", backendBinary: "", backendDevice: "" });
      return;
    }

    let cancelled = false;
    const updateBackendInfo = async () => {
      try {
        const status = await getBackendStatus();
        if (cancelled) return;
        setBackendInfo({
          backendMode: status.settings?.backendMode || status.loading?.backendMode || "",
          backendBinary: status.settings?.backendBinary || status.loading?.backendBinary || "",
          backendDevice: status.settings?.backendDevice || status.loading?.device || "",
        });
      } catch (_) {}
    };

    updateBackendInfo();
    const interval = setInterval(updateBackendInfo, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [serverRunning, loadingModelId]);

  const checkActiveDownload = async () => {
    try {
      const status = await getDownloadProgress();
      if (status.active && status.filename) {
        startProgressPolling(status.filename);
      }
    } catch (e) {
      console.error("Check active download failed:", e);
    }
  };

  const startProgressPolling = (modelId) => {
    setDownloadingModelId(modelId);
    
    const interval = setInterval(async () => {
      try {
        const status = await getDownloadProgress();
        if (status.active) {
          setDownloadProgress(status.progress === -1 ? 0 : status.progress);
          setDownloadSpeed(`${status.speed} • ETA ${status.eta}s`);
        } else {
          clearInterval(interval);
          setDownloadingModelId(null);
          if (status.error) {
            if (!String(status.error).toLowerCase().includes("cancelled")) {
              showAlert({ title: "Download Failed", message: status.error, danger: true });
            }
          } else {
            fetchModels();
          }
        }
      } catch (e) {
        console.error("Polling error:", e);
      }
    }, 1000);
  };

  const fetchModels = async () => {
    setIsLoadingModels(true);
    try {
      const list = await listLocalModels();
      setLocalModels(list.map(normalizeModel).filter((model) => model.filename));
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const downloadByUrl = async (url, expectedFilename) => {
    if (downloadingModelId) return;

    if (modelNames.includes(expectedFilename)) {
      if (!(await showConfirm({
        title: "Overwrite Model?",
        message: `"${expectedFilename}" is already downloaded. Do you want to download and overwrite it?`,
        confirmLabel: "Overwrite",
      }))) {
        return;
      }
    }

    const isTauriDesktop = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
    const isLocalServerMode = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

    if (!isTauriDesktop && !isLocalServerMode) {
      showAlert({ title: "Server Required", message: "Model download requires the local image generator server.", danger: true });
      return;
    }

    try {
      const res = await downloadModel(url);
      if (res.ok) {
        startProgressPolling(expectedFilename);
      } else {
        showAlert({ title: "Download Failed", message: res.error || "Unknown error", danger: true });
      }
    } catch (err) {
      showAlert({ title: "Download Error", message: err.message, danger: true });
    }
  };

  // Download custom model from URL
  const handleUrlDownloadSubmit = async (e) => {
    e.preventDefault();
    if (!downloadUrl.trim()) return;

    let modelName = "model.gguf";
    try {
      const parsed = new URL(downloadUrl.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("URL protocol must be http or https");
      }
      modelName = parsed.pathname.split("/").pop() || "";
      if (!modelName) throw new Error("Could not extract filename from URL");
      
      const lowerName = modelName.toLowerCase();
      if (!lowerName.endsWith(".gguf") && !lowerName.endsWith(".safetensors") && !lowerName.endsWith(".ckpt")) {
        throw new Error("URL must point to a .gguf, .safetensors, or .ckpt weights file");
      }
    } catch (err) {
      showAlert({ title: "Invalid URL", message: err.message, danger: true });
      return;
    }

    await downloadByUrl(downloadUrl.trim(), modelName);
    setDownloadUrl("");
  };

  const handleLibraryDownload = async (model) => {
    if (model.backendType === "openvino-npu") {
      if (downloadingModelId) return;
      try {
        const res = await downloadOpenVinoModel(model.id);
        if (res.ok) {
          startProgressPolling(model.filename);
        } else {
          showAlert({ title: "Download Failed", message: res.error || "Unknown error", danger: true });
        }
      } catch (err) {
        showAlert({ title: "Download Error", message: err.message, danger: true });
      }
      return;
    }
    downloadByUrl(model.url, model.filename);
  };

  const handleCancelDownload = async () => {
    await cancelModelDownload();
    setDownloadingModelId(null);
    setDownloadProgress(0);
    setDownloadSpeed("");
    await fetchModels();
  };

  // Start the model server backend
  const handleLoadModel = async (modelId) => {
    if (activeModel && activeModel !== modelId && serverRunning) {
      setPendingLoadModel(modelId);
      return;
    }
    await performLoadModel(modelId);
  };

  const performLoadModel = async (modelId) => {
    const isTauriDesktop = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
    const isLocalServerMode = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
    const backendStatus = await getBackendStatus();
    const backendPort = backendStatus?.port || 8080;
    
    if (!isTauriDesktop && !isLocalServerMode) {
      const isAlreadyRunning = await pingServer();
      const modelInfo = getLocalModelInfo(modelId);
      const isOpenVinoModel = modelInfo?.backendType === "openvino-npu";
      const cmd = isOpenVinoModel
        ? `Run the platform launcher and load "${modelId}" from Model Manager on a configured Intel NPU machine.`
        : `.\\backend\\win\\vulkan\\sd-vulkan.exe --listen-port ${backendPort} --model .\\models\\${modelId} --threads 8`;
      
      if (isAlreadyRunning) {
        if (await showConfirm({ title: "Web Browser Mode", message: `To load "${modelId}" on the active GPU server, restart your terminal backend with:\n\n${cmd}\n\nUpdate the UI status anyway?`, confirmLabel: "Update UI" })) {
          setActiveModel(modelId);
          setServerRunning(true);
        }
      } else {
        if (await showConfirm({ title: "Backend Not Running", message: `C++ backend server is not running on port ${backendPort}.\n\nTo run locally, start:\n\n${cmd}\n\nProceed in Simulation Mode instead?`, confirmLabel: "Proceed" })) {
          setActiveModel(modelId);
          setServerRunning(false);
        }
      }
      return;
    }

    setLoadingModelId(modelId);
    setModelLoadProgress({
      progress: 0,
      phase: "Starting backend...",
      speed: "",
      current: 0,
      total: 0,
      model: modelId,
      backendMode: "",
      backendBinary: "",
      device: "",
    });
    try {
      const modelInfo = getLocalModelInfo(modelId);
      const loadConstraints = modelInfo?.backendType === "openvino-npu"
        ? {
            ...constraints,
            backendType: "openvino-npu",
            useGpu: true,
            width: constraints.width >= 1024 ? 1024 : 512,
            height: constraints.height >= 1024 ? 1024 : 512,
            steps: Math.max(1, Math.min(8, constraints.steps || 4)),
            cfgScale: constraints.cfgScale || 1,
          }
        : constraints;
      const response = await startServer(modelId, loadConstraints);
      console.log(response);
      
      let isReady = false;
      let crashError = null;
      const isOpenVinoModel = modelInfo?.backendType === "openvino-npu";
      const maxStartupPolls = isOpenVinoModel ? 1200 : 240;
      for (let i = 0; i < maxStartupPolls; i++) {
        const status = await getBackendStatus();
        if (status.loading) {
          setModelLoadProgress({
            progress: status.loading.progress || 0,
            phase: status.loading.phase || "Loading model...",
            speed: status.loading.speed || "",
            current: status.loading.current || 0,
            total: status.loading.total || 0,
            model: status.loading.model || modelId,
            backendMode: status.loading.backendMode || status.settings?.backendMode || "",
            backendBinary: status.loading.backendBinary || status.settings?.backendBinary || "",
            device: status.loading.device || status.settings?.backendDevice || "",
          });
        }
        if (status.ready) {
          isReady = true;
          break;
        }
        if (status.error) {
          crashError = status.error;
          break;
        }
        if (!status.running && !status.loading?.active && i > 3) {
          crashError = "The backend process terminated immediately on startup.";
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (isReady) {
        setModelLoadProgress((prev) => ({
          ...(prev || {}),
          progress: 100,
          phase: "Model ready",
          speed: "",
          current: prev?.current || 0,
          total: prev?.total || 0,
          model: modelId,
        }));
        setActiveModel(modelId);
        setServerRunning(true);
      } else {
        throw new Error(crashError || `Model server failed to respond on port ${backendPort}.`);
      }
    } catch (e) {
      console.error("Failed to load model:", e);
      showAlert({ title: "Model Load Failed", message: e.message || String(e), danger: true });
    } finally {
      setTimeout(() => setModelLoadProgress(null), 800);
      setLoadingModelId(null);
    }
  };

  const handleUnloadThenLoad = async () => {
    const nextModel = pendingLoadModel;
    setPendingLoadModel(null);
    await handleUnloadModel();
    if (nextModel) {
      await performLoadModel(nextModel);
    }
  };

  // Kill/Unload model server
  const handleUnloadModel = async () => {
    if (isUnloading) return;
    setIsUnloading(true);
    setUnloadProgress({ progress: 10, phase: "Stopping backend process..." });

    const poll = setInterval(async () => {
      try {
        const status = await getBackendStatus();
        if (status.unloading?.active) {
          setUnloadProgress({
            progress: status.unloading.progress || 50,
            phase: status.unloading.phase || "Unloading model...",
          });
        } else {
          setUnloadProgress((prev) => ({
            progress: Math.min(95, prev.progress + 10),
            phase: prev.phase || "Unloading model...",
          }));
        }
      } catch (_) {}
    }, 300);

    try {
      await stopServer();
      setUnloadProgress({ progress: 100, phase: "Model unloaded" });
      setActiveModel(null);
      setPendingLoadModel(null);
      setServerRunning(false);
    } catch (e) {
      console.error(e);
      showAlert({ title: "Unload Failed", message: e.message || String(e), danger: true });
    } finally {
      clearInterval(poll);
      setTimeout(() => {
        setIsUnloading(false);
        setUnloadProgress({ progress: 0, phase: "" });
      }, 500);
    }
  };

  // Delete/Remove model file
  const handleDeleteModel = async (filename) => {
    if (await showConfirm({
      title: "Delete Model?",
      message: `Delete "${filename}" from your drive?`,
      confirmLabel: "Delete",
      danger: true,
    })) {
      try {
        await deleteModel(filename);
        // Refresh local models list
        await fetchModels();
        // If it was the active model, unload the server
        if (activeModel === filename) {
          await handleUnloadModel();
        }
      } catch (err) {
        console.error("Failed to delete model:", err);
        showAlert({ title: "Delete Failed", message: err.message || String(err), danger: true });
      }
    }
  };

  const executeImport = async (sourcePath, displayName) => {
    const controller = new AbortController();
    setImportAbortController(controller);
    setImportProgress(0);
    setImportInfo({
      filename: displayName,
      speed: "0.0",
      eta: 0,
      status: "Initiating file copy..."
    });

    try {
      await importModelFile(sourcePath, (progressData) => {
        setImportProgress(Math.round(progressData.progress));
        setImportInfo({
          filename: progressData.filename,
          speed: progressData.speed_mb_s.toFixed(1),
          eta: Math.round(progressData.eta_secs),
          status: progressData.status
        });
      }, controller.signal);

      // Refresh list
      await fetchModels();
    } catch (err) {
      console.error("Import failed:", err);
      if (err.name !== "AbortError") {
        showAlert({ title: "Import Failed", message: err.message || String(err), danger: true });
      }
    } finally {
      setImportProgress(null);
      setImportAbortController(null);
    }
  };

  const handleCancelImport = () => {
    if (importAbortController) {
      importAbortController.abort();
    }
  };

  const handleImportFile = (e) => {
    const file = e.target.files[0];
    if (file) {
      executeImport(file, file.name);
    }
    e.target.value = "";
  };

  const isUrlDownloading = Boolean(downloadingModelId);

  return (
    <div className="workspace-area">
      <div className="workspace-title-section">
        <h2 className="workspace-title">Model Manager</h2>
        <p className="workspace-subtitle">
          Manage local files and download recommended weights directly to your local models folder.
        </p>
      </div>

      {/* Active Model Status Tonal Box */}
      {activeModel && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-primary)", background: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h4 style={{ fontWeight: 700 }}>Active Model: {activeModel}</h4>
              <p style={{ fontSize: "0.85rem", marginTop: "2px", opacity: 0.9 }}>
                The local C++ stable-diffusion server is running. Real-time telemetry is displaying performance status in the top bar.
              </p>
              {(backendInfo.backendMode || backendInfo.backendDevice || backendInfo.backendBinary) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" }}>
                  {backendInfo.backendMode && (
                    <span className="status-chip" style={{ cursor: "default" }}>
                      <HardDrive size={14} />
                      <span>Loaded on {backendInfo.backendMode}</span>
                    </span>
                  )}
                  {backendInfo.backendDevice && (
                    <span className="status-chip" style={{ cursor: "default" }}>
                      <span>{backendInfo.backendDevice}</span>
                    </span>
                  )}
                  {backendInfo.backendBinary && (
                    <span className="status-chip" style={{ cursor: "default" }}>
                      <span>{backendInfo.backendBinary}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
            <button className="m3-btn m3-btn-error" onClick={handleUnloadModel} disabled={isUnloading || loadingModelId !== null}>
              {isUnloading ? <RefreshCw className="progress-spinner" size={16} /> : <Trash2 size={16} />}
              <span>{isUnloading ? "Unloading" : "Unload Server"}</span>
            </button>
          </div>
        </div>
      )}

      {isUnloading && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-error)", marginTop: "16px" }}>
          <h4 style={{ fontWeight: 700, marginBottom: "8px" }}>Unloading Model</h4>
          <div className="model-progress-section" style={{ margin: "8px 0 0 0" }}>
            <div className="model-progress-label">
              <span>{unloadProgress.phase || "Unloading model..."}</span>
              <span>{Math.round(unloadProgress.progress)}%</span>
            </div>
            <div className="model-progress-bar">
              <div className="model-progress-fill" style={{ width: `${Math.min(100, Math.max(0, unloadProgress.progress))}%`, transition: "width 0.25s ease" }}></div>
            </div>
          </div>
        </div>
      )}

      {modelLoadProgress && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-secondary)", marginTop: "16px" }}>
          <h4 style={{ fontWeight: 700, marginBottom: "8px" }}>
            Loading Model: {modelLoadProgress.model || loadingModelId}
          </h4>
          {(modelLoadProgress.backendMode || modelLoadProgress.backendBinary || modelLoadProgress.device) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "10px" }}>
              {modelLoadProgress.backendMode && (
                <span className="status-chip" style={{ cursor: "default" }}>
                  <HardDrive size={14} />
                  <span>Loading on {modelLoadProgress.backendMode}</span>
                </span>
              )}
              {modelLoadProgress.device && (
                <span className="status-chip" style={{ cursor: "default" }}>
                  <span>{modelLoadProgress.device}</span>
                </span>
              )}
              {modelLoadProgress.backendBinary && (
                <span className="status-chip" style={{ cursor: "default" }}>
                  <span>{modelLoadProgress.backendBinary}</span>
                </span>
              )}
            </div>
          )}
          <div className="model-progress-section" style={{ margin: "8px 0 0 0" }}>
            <div className="model-progress-label">
              <span>
                {modelLoadProgress.phase}
                {modelLoadProgress.speed ? ` (${modelLoadProgress.speed})` : ""}
              </span>
              <span>
                {modelLoadProgress.total > 0
                  ? `Loaded ${modelLoadProgress.current} / ${modelLoadProgress.total} tensors`
                  : `${Math.round(modelLoadProgress.progress)}%`}
              </span>
            </div>
            <div className="model-progress-bar">
              <div
                className="model-progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, modelLoadProgress.progress))}%`, transition: "width 0.25s ease" }}
              ></div>
            </div>
          </div>
        </div>
      )}

      {/* Detected Local Models Section */}
      <div className="m3-card" style={{ marginTop: "24px" }}>
        <h3 className="m3-card-title">
          <Database size={18} style={{ color: "var(--md-sys-color-primary)" }} />
          Local Models ({localModels.length})
        </h3>
        
        {isLoadingModels ? (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "10px", padding: "24px 0", color: "var(--md-sys-color-outline)" }}>
            <RefreshCw className="progress-spinner" size={16} />
            <span style={{ fontSize: "0.9rem" }}>Scanning models folder...</span>
          </div>
        ) : localModels.length === 0 ? (
          <p style={{ fontSize: "0.9rem", color: "var(--md-sys-color-outline)", textAlign: "center", padding: "16px 0" }}>
            No models detected in app/models/. Download from the library below or import a file.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {localModels.map((model) => {
              const filename = model.filename;
              const isActive = activeModel === filename;
              
              return (
                <div 
                  key={filename} 
                  style={{ 
                    display: "flex", 
                    justifyContent: "space-between", 
                    alignItems: "center", 
                    padding: "12px 16px", 
                    background: isActive ? "var(--md-sys-color-primary-container)" : "var(--md-sys-color-surface-variant)",
                    color: isActive ? "var(--md-sys-color-on-primary-container)" : "var(--md-sys-color-on-surface-variant)",
                    borderRadius: "var(--md-shape-corner-medium)",
                    border: "1px solid var(--md-sys-color-outline-variant)"
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{filename}</span>
                    <span style={{ fontSize: "0.75rem", opacity: 0.8 }}>
                      {model.backendType === "openvino-npu" ? "OpenVINO NPU Model" : model.format || "Local Weights File"} • {model.size || formatBytes(model.sizeBytes)}
                    </span>
                  </div>
                  
                  <div style={{ display: "flex", gap: "8px" }}>
                    {isActive ? (
                      <button className="m3-btn m3-btn-error" style={{ height: "36px", padding: "0 16px" }} onClick={handleUnloadModel} disabled={isUnloading}>
                        {isUnloading ? <RefreshCw className="progress-spinner" size={14} /> : <Trash2 size={14} />}
                        <span>{isUnloading ? "Unloading" : "Unload"}</span>
                      </button>
                    ) : (
                      <>
                        <button 
                          className="m3-btn m3-btn-filled" 
                          style={{ height: "36px", padding: "0 16px" }} 
                          onClick={() => handleLoadModel(filename)}
                          disabled={isBusy}
                        >
                          {loadingModelId === filename ? (
                            <RefreshCw className="progress-spinner" size={14} />
                          ) : (
                            <Database size={14} />
                          )}
                          <span>{loadingModelId === filename ? "Loading" : "Load"}</span>
                        </button>
                        <button
                          className="m3-btn m3-btn-error"
                          style={{ height: "36px", width: "36px", padding: 0, minWidth: "36px" }}
                          onClick={() => handleDeleteModel(filename)}
                          disabled={isBusy}
                          title="Delete from models folder"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>


      <div className="workspace-title-section" style={{ marginTop: "32px", marginBottom: "16px" }}>
        <h3 className="m3-card-title">
          <Library size={20} style={{ color: "var(--md-sys-color-primary)" }} />
          Model Library
        </h3>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {visibleModelLibrary.map((section) => (
          <div key={section.group} className="m3-card" style={{ margin: 0 }}>
            <h4 style={{ fontWeight: 700, marginBottom: "12px" }}>{section.group}</h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }}>
              {section.items.map((model) => {
                const installed = modelNames.includes(model.filename);
                const downloading = downloadingModelId === model.filename;
                return (
                  <div key={model.filename} style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", background: "var(--md-sys-color-surface-variant)", border: "1px solid var(--md-sys-color-outline-variant)", borderRadius: "var(--md-shape-corner-medium)" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      <span style={{ fontWeight: 700 }}>{model.name}</span>
                      <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)" }}>
                        {model.format} • approx. {model.approxSize} • {model.resolution}
                      </span>
                    </div>
                    <p style={{ fontSize: "0.78rem", color: "var(--md-sys-color-on-surface-variant)", lineHeight: 1.35, margin: 0 }}>
                      {model.notes}
                    </p>
                    {downloading && (
                      <div className="model-progress-section" style={{ marginTop: "2px" }}>
                        <div className="model-progress-label">
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                            <span className="loading-dot"></span>
                            Downloading
                          </span>
                          <span>{downloadProgress > 0 ? `${downloadProgress}%` : "Preparing"}</span>
                        </div>
                        <div className="model-progress-bar">
                          <div className="model-progress-fill" style={{ width: `${Math.min(100, Math.max(0, downloadProgress))}%`, transition: "width 0.2s ease" }}></div>
                        </div>
                        {downloadSpeed && (
                          <div style={{ fontSize: "0.7rem", color: "var(--md-sys-color-outline)", marginTop: "4px" }}>
                            {downloadSpeed}
                          </div>
                        )}
                      </div>
                    )}
                    <button
                      className={installed ? "m3-btn m3-btn-tonal" : "m3-btn m3-btn-filled"}
                      style={{ height: "36px", marginTop: "auto" }}
                      onClick={() => handleLibraryDownload(model)}
                      disabled={installed || downloadingModelId !== null}
                    >
                      {installed ? <HardDrive size={14} /> : downloading ? <RefreshCw className="progress-spinner" size={14} /> : <DownloadCloud size={14} />}
                      <span>{installed ? "Downloaded" : downloading ? "Downloading" : "Download"}</span>
                    </button>
                    <a
                      href={model.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        alignSelf: "center",
                        color: "var(--md-sys-color-primary)",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        lineHeight: 1.2,
                        textDecoration: "none",
                      }}
                    >
                      Save to Downloads folder
                    </a>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>


      {/* Local Drag and Drop Importer */}
      <div className="workspace-title-section" style={{ marginTop: "32px", marginBottom: "16px" }}>
        <h3 className="m3-card-title">
          <FolderOpen size={20} style={{ color: "var(--md-sys-color-primary)" }} />
          Local Model Import
        </h3>
      </div>
      {/* Importing Progress Bar */}
      {importProgress !== null && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-primary)", marginTop: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
            <h4 style={{ fontWeight: 600 }}>Copying Model to local folder: {importInfo.filename}</h4>
            <button className="m3-btn m3-btn-error" style={{ height: "34px", padding: "0 14px" }} onClick={handleCancelImport}>
              <Square size={14} />
              <span>Stop Import</span>
            </button>
          </div>
          <div className="model-progress-section" style={{ margin: "12px 0 6px 0" }}>
            <div className="model-progress-label">
              <span>{importInfo.status} ({importInfo.speed} MB/s)</span>
              <span>{importProgress}% ({importInfo.eta}s remaining)</span>
            </div>
            <div className="model-progress-bar">
              <div className="model-progress-fill" style={{ width: `${importProgress}%`, transition: "width 0.15s ease" }}></div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px", marginTop: "16px" }}>
        <label className="import-box" style={{ margin: 0, height: "100%", justifyContent: "center" }}>
          <input
            type="file"
            style={{ display: "none" }}
            accept=".gguf,.safetensors,.ckpt"
            onChange={handleImportFile}
            disabled={importProgress !== null}
          />
          <FolderOpen className="import-icon" />
          <span style={{ fontWeight: 600 }}>Choose weights file</span>
          <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", textAlign: "center" }}>
            Select `.gguf`, `.safetensors` or `.ckpt` weights.
          </span>
        </label>

        <div className="m3-card" style={{ display: "flex", flexDirection: "column", justifyContent: "center", margin: 0, padding: "20px" }}>
          <h4 style={{ fontWeight: 600, marginBottom: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
            <DownloadCloud size={16} />
            Download Model from URL
          </h4>
          <p style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginBottom: "12px" }}>
            Download any GGUF or Safetensors model from Hugging Face or other sites directly to your models folder.
          </p>
          {isUrlDownloading ? (
            <div className="model-progress-section" style={{ marginTop: "0px" }}>
              <div className="model-progress-label">
                <span style={{ fontSize: "0.75rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "200px" }} title={downloadingModelId}>
                  {downloadingModelId}
                </span>
                <span>{downloadProgress}%</span>
              </div>
              <div className="model-progress-bar" style={{ margin: "4px 0" }}>
                <div className="model-progress-fill" style={{ width: `${downloadProgress}%`, transition: "width 0.15s ease" }}></div>
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--md-sys-color-outline)", marginTop: "2px" }}>
                {downloadSpeed}
              </div>
              <button className="m3-btn m3-btn-error" style={{ height: "34px", padding: "0 14px", marginTop: "10px" }} onClick={handleCancelDownload}>
                <Square size={14} />
                <span>Stop Download</span>
              </button>
            </div>
          ) : (
            <form onSubmit={handleUrlDownloadSubmit} style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                className="m3-input"
                style={{ flex: 1, height: "40px" }}
                placeholder="e.g. https://huggingface.co/..."
                value={downloadUrl}
                onChange={(e) => setDownloadUrl(e.target.value)}
                disabled={downloadingModelId !== null}
              />
              <button 
                type="submit" 
                className="m3-btn m3-btn-filled" 
                style={{ height: "40px" }}
                disabled={downloadingModelId !== null}
              >
                Download
              </button>
            </form>
          )}
        </div>
      </div>

      {pendingLoadModel && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div className="m3-card" style={{ maxWidth: "460px", width: "100%", margin: 0, border: "1px solid var(--md-sys-color-outline-variant)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <AlertTriangle size={22} style={{ color: "var(--md-sys-color-error)" }} />
              <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>Unload Current Model?</h3>
            </div>
            <p style={{ fontSize: "0.9rem", color: "var(--md-sys-color-on-surface-variant)", lineHeight: 1.45, marginBottom: "16px" }}>
              "{activeModel}" is already loaded. Unload it before loading "{pendingLoadModel}".
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button className="m3-btn m3-btn-outlined" onClick={() => setPendingLoadModel(null)} disabled={isUnloading}>
                Cancel
              </button>
              <button className="m3-btn m3-btn-error" onClick={handleUnloadModel} disabled={isUnloading}>
                <Trash2 size={14} />
                <span>Unload Only</span>
              </button>
              <button className="m3-btn m3-btn-filled" onClick={handleUnloadThenLoad} disabled={isUnloading}>
                {isUnloading ? <RefreshCw className="progress-spinner" size={14} /> : <RefreshCw size={14} />}
                <span>Unload and Load</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ModelManager);
