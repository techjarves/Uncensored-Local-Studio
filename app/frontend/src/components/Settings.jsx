import React, { memo, useEffect } from "react";
import { Crop, Sliders, Cpu, Info, MessageSquare, SlidersHorizontal } from "lucide-react";
import { stopServer, formatBytes } from "../services/api";

const ASPECT_RATIOS = [
  { id: "1:1", label: "1:1 Square", width: 512, height: 512, sdxl_width: 1024, sdxl_height: 1024, desc: "Social posts & avatars" },
  { id: "4:3", label: "4:3 Photo", width: 640, height: 480, sdxl_width: 1152, sdxl_height: 864, desc: "Classic photo look" },
  { id: "16:9", label: "16:9 Landscape", width: 768, height: 432, sdxl_width: 1216, sdxl_height: 684, desc: "Widescreen landscape" },
  { id: "9:16", label: "9:16 Portrait", width: 432, height: 768, sdxl_width: 684, sdxl_height: 1216, desc: "Tall phone screen" }
];

const isSD15OrCustomModel = (modelName) => {
  if (!modelName) return true;
  const name = modelName.toLowerCase();
  if (name.includes("flux") || name.includes("schnell")) return false;
  if (name.includes("sdxl") || name.includes("lightning") || name.includes("turbo")) return false;
  if (name.includes("sd3")) return false;
  return true;
};

function Settings({
  constraints,
  setConstraints,
  activeModel,
  specs,
  backendOptions,
  serverRunning,
  setServerRunning,
  setActiveModel,
  textSettings,
  setTextSettings,
  showAlert = async ({ message }) => window.alert(message),
  showConfirm = async ({ message }) => window.confirm(message),
  health,
  cleanupItems,
  isReadinessBusy,
  refreshReadiness,
  copyDiagnostics,
  cleanupSafeItems,
  diagnosticsCopied,
}) {
  const isSD15OrCustom = activeModel ? isSD15OrCustomModel(activeModel) : false;
  const isOpenVinoNpu = constraints.backendType === "openvino-npu";
  const forceStandardMode = isSD15OrCustom && !isOpenVinoNpu;
  const availableBackends = backendOptions?.options?.length
    ? backendOptions.options
    : [{ id: "cpu", label: "CPU", available: true }];
  const isMac = availableBackends.some(b => b.id === "metal" || b.id === "apple-npu") || 
                (specs?.os_name && (specs.os_name.toLowerCase().includes("darwin") || specs.os_name.toLowerCase().includes("mac")));

  const readinessIssues = [
    ...(health?.stale ? ["Restart Local AI Image Generator so the local server loads the latest API."] : []),
    ...(health?.issues || []),
  ];
  const cleanupBytes = (cleanupItems || []).reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  const showReadinessPanel = Boolean(health && (readinessIssues.length > 0 || (cleanupItems && cleanupItems.length > 0)));

  useEffect(() => {
    if (isOpenVinoNpu && constraints.steps > 8) {
      setConstraints((prev) => ({ ...prev, steps: 8, npuSteps: 8 }));
    }
  }, [constraints.steps, isOpenVinoNpu, setConstraints]);

  const updateConstraint = (key, value) => {
    setConstraints((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "steps"
        ? isOpenVinoNpu
          ? { npuSteps: value }
          : { standardSteps: value }
        : {}),
    }));
  };

  const updateTextSetting = (key, value) => {
    setTextSettings((prev) => ({
      ...prev,
      [key]: value
    }));
  };

  const handleAspectRatioChange = (ratio, sizeType) => {
    if (isOpenVinoNpu && ratio !== "1:1") return;
    const isSDXL = sizeType === "sdxl" && !isSD15OrCustom;
    const selected = ASPECT_RATIOS.find((r) => r.id === ratio);
    if (selected) {
      let w = isSDXL ? selected.sdxl_width : selected.width;
      let h = isSDXL ? selected.sdxl_height : selected.height;
      if (isOpenVinoNpu) {
        const size = constraints.width >= 1024 ? 1024 : 512;
        w = size;
        h = size;
      } else if (isSD15OrCustom) {
        if (w > h) {
          h = Math.round((h * 512) / w);
          w = 512;
        } else {
          w = Math.round((w * 512) / h);
          h = 512;
        }
        w = Math.round(w / 64) * 64;
        h = Math.round(h / 64) * 64;
      }
      updateConstraint("width", w);
      updateConstraint("height", h);
    }
  };

  const handleBackendChange = async (backendType) => {
    const currentBackend = constraints.backendType || "cpu";
    if (backendType === currentBackend) return;

    const switchesAccelerator =
      (currentBackend === "openvino-npu" && backendType !== "openvino-npu") ||
      (currentBackend !== "openvino-npu" && backendType === "openvino-npu");

    if (serverRunning && switchesAccelerator) {
      const leavingNpu = currentBackend === "openvino-npu";
      const confirmed = await showConfirm({
        title: leavingNpu ? "Unload NPU Model?" : "Unload Model?",
        message: leavingNpu
          ? "The OpenVINO NPU model must be unloaded before switching to the standard backend."
          : "The active model must be unloaded before switching to the OpenVINO NPU backend.",
        confirmLabel: "Unload",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!confirmed) return;

      try {
        await stopServer();
        setServerRunning(false);
        setActiveModel(null);
      } catch (err) {
        await showAlert({
          title: "Unload Failed",
          message: err.message || String(err),
          danger: true,
        });
        return;
      }
    }

    setConstraints((prev) => ({
      ...prev,
      backendType,
      useGpu: backendType !== "cpu",
      steps: backendType === "openvino-npu"
        ? Math.max(1, Math.min(8, prev.npuSteps || 4))
        : Math.max(1, Math.min(60, prev.standardSteps || 20)),
      ...(backendType === "openvino-npu"
        ? {
            width: prev.width >= 1024 ? 1024 : 512,
            height: prev.width >= 1024 ? 1024 : 512,
          }
        : {}),
    }));
  };

  return (
    <div className="workspace-area">
      <div className="workspace-title-section">
        <h2 className="workspace-title">Settings & Parameters</h2>
        <p className="workspace-subtitle">
          Configure size, quality, and performance controls for local image and text models.
        </p>
      </div>

      {showReadinessPanel && (
        <div className={`m3-card readiness-card ${health?.stale || readinessIssues.length > 0 ? "readiness-card-warning" : ""}`} style={{ marginBottom: "20px" }}>
          <div className="readiness-header">
            <div>
              <h3 className="m3-card-title" style={{ marginBottom: "4px" }}>
                {health?.stale ? "Restart Required" : readinessIssues.length > 0 ? "System Readiness" : "Safe Cleanup Available"}
              </h3>
              <p className="m3-card-subtitle" style={{ margin: 0 }}>
                {health?.stale
                  ? `Running server build: ${health.build || "unknown"}`
                  : readinessIssues.length > 0
                    ? "Local AI Image Generator found setup items that may need attention."
                    : `${(cleanupItems || []).length} temporary item${(cleanupItems || []).length === 1 ? "" : "s"} can be cleaned (${formatBytes(cleanupBytes)}).`}
              </p>
            </div>
            <div className="readiness-actions">
              <button className="m3-btn m3-btn-outlined" onClick={refreshReadiness} disabled={isReadinessBusy}>
                {isReadinessBusy ? "Checking" : "Refresh"}
              </button>
              <button className="m3-btn m3-btn-tonal" onClick={copyDiagnostics}>
                {diagnosticsCopied ? "Copied" : "Copy Diagnostics"}
              </button>
              {(cleanupItems || []).length > 0 && (
                <button className="m3-btn m3-btn-error" onClick={cleanupSafeItems} disabled={isReadinessBusy}>
                  Clean {formatBytes(cleanupBytes)}
                </button>
              )}
            </div>
          </div>
          {readinessIssues.length > 0 && (
            <div className="readiness-issues">
              {readinessIssues.slice(0, 4).map((issue) => (
                <span key={issue}>{issue}</span>
              ))}
            </div>
          )}
          {(cleanupItems || []).length > 0 && (
            <div className="readiness-cleanup-list">
              {cleanupItems.slice(0, 3).map((item) => (
                <span key={item.id} title={item.path}>
                  {item.name} · {item.size} · {item.reason}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="generator-layout">
        {/* Left Column: Image Settings */}
        <div>
          {/* Card 1: Picture Size & Shape */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <Crop size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              1. Image Size & Shape
            </h3>
            
            {isOpenVinoNpu ? (
              <div style={{
                background: "rgba(99, 102, 241, 0.1)",
                border: "1px solid var(--md-sys-color-primary)",
                color: "var(--md-sys-color-on-surface)",
                padding: "12px",
                borderRadius: "8px",
                marginBottom: "16px",
                fontSize: "0.85rem",
                display: "flex",
                gap: "8px",
                alignItems: "flex-start"
              }}>
                <Info size={16} style={{ color: "var(--md-sys-color-primary)", flexShrink: 0, marginTop: "2px" }} />
                <div>
                  <strong>OpenVINO NPU Resolution:</strong> The NPU generates at its stable 512x512 resolution. HD mode produces a 1024x1024 output using high-quality Lanczos upscaling without recompiling the model.
                </div>
              </div>
            ) : isSD15OrCustom && (
              <div style={{
                background: "rgba(251, 191, 36, 0.1)",
                border: "1px solid rgb(251, 191, 36)",
                color: "var(--md-sys-color-on-surface)",
                padding: "12px",
                borderRadius: "8px",
                marginBottom: "16px",
                fontSize: "0.85rem",
                display: "flex",
                gap: "8px",
                alignItems: "flex-start"
              }}>
                <Info size={16} style={{ color: "rgb(251, 191, 36)", flexShrink: 0, marginTop: "2px" }} />
                <div>
                  <strong>Graphics Memory Protection Active:</strong> Locked at 512x512 size for this model (<code>{activeModel}</code>). Creating larger images (like 1024x1024) is disabled to prevent your {specs && specs.gpu_name && !specs.gpu_name.includes("Loading") ? specs.gpu_name : "graphics processor"} from running out of memory and crashing.
                </div>
              </div>
            )}

            <div className="m3-field-group">
              {/* Size switcher */}
              <div className="m3-text-field">
                <label className="m3-text-field-label">AI Generation Engine Optimization</label>
                <div className="m3-segmented-button">
                  {forceStandardMode ? (
                    <div
                      className="m3-segment-item disabled"
                      style={{
                        opacity: 0.5,
                        cursor: "not-allowed",
                        textDecoration: "line-through",
                        backgroundColor: "var(--md-sys-color-surface-variant)"
                      }}
                      title="High Quality Mode is disabled for SD 1.x models."
                    >
                      {isOpenVinoNpu ? "HD Upscale (1024px)" : "High Quality Mode (1024px)"}
                    </div>
                  ) : (
                    <div
                      className={`m3-segment-item ${constraints.width >= 1024 ? "active" : ""}`}
                      onClick={() => {
                        updateConstraint("width", 1024);
                        updateConstraint("height", 1024);
                      }}
                    >
                      {isOpenVinoNpu ? "HD Upscale (1024px)" : "High Quality Mode (1024px)"}
                    </div>
                  )}
                  <div
                    className={`m3-segment-item ${constraints.width < 1024 ? "active" : ""}`}
                    onClick={() => {
                      updateConstraint("width", 512);
                      updateConstraint("height", 512);
                    }}
                  >
                    Standard Speed Mode (512px)
                  </div>
                </div>
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "4px" }}>
                  {isOpenVinoNpu
                    ? "*HD mode generates at 512x512 on the NPU, then upscales to 1024x1024. It improves output size, but does not add native diffusion detail."
                    : isSD15OrCustom
                    ? "*Standard Speed Mode (512px) is forced for SD 1.5 / custom models to ensure stable local generations." 
                    : "*Use High Quality (1024px) for Flux or SDXL models. Use Standard (512px) for SD 1.5."}
                </span>
              </div>

              {/* Aspect Ratio Buttons */}
              <div className="m3-text-field">
                <label className="m3-text-field-label">Select Shape (Aspect Ratio)</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                  {ASPECT_RATIOS.map((ratio) => {
                    const isActive = Math.abs((constraints.width / constraints.height) - (ratio.width / ratio.height)) < 0.1;
                    const isUnsupportedOpenVinoShape = isOpenVinoNpu && ratio.id !== "1:1";
                    return (
                      <button
                        key={ratio.id}
                        className={`m3-btn m3-btn-outlined aspect-ratio-btn ${isActive ? "active" : ""}`}
                        disabled={isUnsupportedOpenVinoShape}
                        style={{
                          height: "86px",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: "8px",
                          borderRadius: "var(--md-shape-corner-medium)",
                          borderColor: "var(--md-sys-color-outline-variant)"
                        }}
                        onClick={() => handleAspectRatioChange(ratio.id, forceStandardMode ? "sd15" : (constraints.width >= 1024 ? "sdxl" : "sd15"))}
                      >
                        <div className={`aspect-ratio-preview ratio-${ratio.id.replace(":", "-")}`}></div>
                        <span style={{ fontWeight: 600, fontSize: "0.85rem", marginTop: "2px" }}>{ratio.label}</span>
                        <span style={{ fontSize: "0.68rem", opacity: 0.7 }}>
                          {isUnsupportedOpenVinoShape
                            ? "Not yet supported on NPU"
                            : forceStandardMode
                            ? `Max: ${ratio.id === "1:1" ? "512x512" : ratio.id === "4:3" ? "512x384" : ratio.id === "16:9" ? "512x288" : "288x512"}`
                            : ratio.desc}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: Quality & Logic */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <Sliders size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              2. Quality, Speed & Logic
            </h3>

            <div className="m3-field-group">
              {/* Quality Steps Slider */}
              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Detail Steps (Inference speed)</span>
                  <span className="m3-slider-value">{constraints.steps} steps</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={constraints.steps}
                  onChange={(e) => updateConstraint("steps", parseInt(e.target.value))}
                  min="1"
                  max={isOpenVinoNpu ? "8" : "60"}
                />
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", lineHeight: "1.3" }}>
                  {isOpenVinoNpu
                    ? "LCM OpenVINO uses 1-8 fast inference steps. Progress is reported after each completed NPU step."
                    : "The number of times the AI cleans up the image. More steps = sharper details, but takes longer."}
                </span>
              </div>

              {/* Random Seed DNA */}
              <div className="m3-text-field" style={{ marginTop: "8px" }}>
                <label className="m3-text-field-label">Image Blueprint (DNA Seed)</label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="number"
                    className="m3-input"
                    value={constraints.seed}
                    onChange={(e) => updateConstraint("seed", parseInt(e.target.value) || -1)}
                    placeholder="-1 for a brand new image..."
                    style={{ flex: 1, height: "40px" }}
                  />
                  <button
                    className="m3-btn m3-btn-tonal"
                    onClick={() => updateConstraint("seed", -1)}
                    style={{ height: "40px" }}
                  >
                    Random (-1)
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Card 3: Image Memory Optimizations */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <SlidersHorizontal size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              3. Image Optimizations
            </h3>
            
            <div className="m3-field-group">
              <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                  <input
                    type="checkbox"
                    checked={constraints.vaeTiling !== false}
                    onChange={(e) => updateConstraint("vaeTiling", e.target.checked)}
                    style={{
                      width: "16px",
                      height: "16px",
                      marginTop: "3px",
                      accentColor: "var(--md-sys-color-primary)",
                      cursor: "pointer"
                    }}
                  />
                  <div>
                    <strong style={{ color: "var(--md-sys-color-on-surface)" }}>Enable VAE Tiling</strong>
                    <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px", lineHeight: 1.35 }}>
                      Builds the image in smaller, bite-sized sections. This heavily reduces graphics memory usage with no loss in speed. Highly recommended for computers with standard graphics cards.
                    </div>
                  </div>
                </label>

                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                  <input
                    type="checkbox"
                    checked={constraints.vaeOnCpu === true}
                    onChange={(e) => updateConstraint("vaeOnCpu", e.target.checked)}
                    style={{
                      width: "16px",
                      height: "16px",
                      marginTop: "3px",
                      accentColor: "var(--md-sys-color-primary)",
                      cursor: "pointer"
                    }}
                  />
                  <div>
                    <strong style={{ color: "var(--md-sys-color-on-surface)" }}>Run VAE on CPU</strong>
                    <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px", lineHeight: 1.35 }}>
                      Performs the final image rendering step using your computer's main memory (RAM) instead of graphics memory. Saves graphics memory, but makes the final stage of creating the image slightly slower.
                    </div>
                  </div>
                </label>

                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "0.85rem" }}>
                  <input
                    type="checkbox"
                    checked={constraints.useFlashAttn !== false}
                    onChange={(e) => updateConstraint("useFlashAttn", e.target.checked)}
                    style={{
                      width: "16px",
                      height: "16px",
                      marginTop: "3px",
                      accentColor: "var(--md-sys-color-primary)",
                      cursor: "pointer"
                    }}
                  />
                  <div>
                    <strong style={{ color: "var(--md-sys-color-on-surface)" }}>Enable Flash Attention</strong>
                    <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "2px", lineHeight: 1.35 }}>
                      Accelerates generation using memory-efficient attention. On some specific Mac models or GPUs, this may cause a slight slowdown, so you can disable it if needed.
                    </div>
                  </div>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Text Settings & System */}
        <div>
          {/* Card 4: Text Generation Settings (llama.cpp) */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <MessageSquare size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              4. Text Generation Settings (GGUF)
            </h3>
            
            <div className="m3-field-group">
              {/* System Prompt instructions */}
              <div className="m3-text-field">
                <label className="m3-text-field-label">Default System Instructions</label>
                <textarea
                  value={textSettings.systemPrompt}
                  onChange={(e) => updateTextSetting("systemPrompt", e.target.value)}
                  placeholder="Set AI instructions (e.g. 'You are a helpful local assistant')..."
                  className="system-prompt"
                  style={{ marginTop: "6px", width: "100%", minHeight: "85px" }}
                />
              </div>

              {/* Context size selector */}
              <div className="m3-text-field" style={{ marginTop: "12px" }}>
                <label className="m3-text-field-label">Context Window Limit</label>
                <select
                  value={textSettings.contextSize}
                  onChange={(e) => updateTextSetting("contextSize", Number(e.target.value))}
                  className="m3-input"
                  style={{ marginTop: "6px", height: "40px", cursor: "pointer" }}
                >
                  <option value="2048">2,048 tokens (Fast/Low Memory)</option>
                  <option value="4096">4,096 tokens (Balanced / Recommended)</option>
                  <option value="8192">8,192 tokens (More history)</option>
                  <option value="16384">16,384 tokens (Deep context)</option>
                </select>
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "4px" }}>
                  Controls the maximum memory allocated for conversation history. Larger limits allow longer chats but use more RAM/VRAM.
                </span>
              </div>

              {/* Temperature slider */}
              <div className="m3-slider-group" style={{ marginTop: "16px" }}>
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Temperature (Creativity)</span>
                  <span className="m3-slider-value">{textSettings.temperature}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.temperature}
                  onChange={(e) => updateTextSetting("temperature", parseFloat(e.target.value))}
                  min="0.1"
                  max="2.0"
                  step="0.05"
                />
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", lineHeight: "1.3" }}>
                  Lower temperature produces focused and coherent replies; higher temperature allows more creative and diverse responses.
                </span>
              </div>

              {/* CPU Threads slider */}
              <div className="m3-slider-group" style={{ marginTop: "16px" }}>
                <div className="m3-slider-header">
                  <span className="m3-slider-label">CPU Threads</span>
                  <span className="m3-slider-value">{textSettings.threads} threads</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.threads}
                  onChange={(e) => updateTextSetting("threads", parseInt(e.target.value))}
                  min="1"
                  max={Math.max(16, specs?.cpu_cores_logical || 16)}
                  step="1"
                />
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", lineHeight: "1.3" }}>
                  Number of physical CPU threads allocated for computation. Typically should match or be slightly lower than your physical cores.
                </span>
              </div>
            </div>
          </div>

          {/* Card 5: System Settings (Generation Backend) */}
          <div className="m3-card">
            <h3 className="m3-card-title">
              <Cpu size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              5. Image Generation Backend
            </h3>
            
            <div className="m3-field-group">
              <div className="m3-text-field">
                <label className="m3-text-field-label">Active Image Accelerator</label>
                <div className="m3-segmented-button">
                  {availableBackends.map((backend) => (
                    <div
                      key={backend.id}
                      className={`m3-segment-item ${constraints.backendType === backend.id || (!constraints.backendType && backend.id === "cpu") ? "active" : ""}`}
                      onClick={() => handleBackendChange(backend.id)}
                      title={backend.id === "cuda" ? "CUDA appears only when an NVIDIA CUDA backend is available." : undefined}
                      style={{ cursor: "pointer" }}
                    >
                      {backend.label}
                    </div>
                  ))}
                </div>
                 <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "4px", lineHeight: 1.35 }}>
                  {isMac ? (
                    "CPU is slow but safest. Metal uses your Mac's graphics card. Apple Neural Engine (NPU) is highly power-efficient and fast."
                  ) : (
                    "CPU is slow but safest. Vulkan works on supported GPUs. CUDA is shown only when NVIDIA CUDA support is available."
                  )}
                 </span>
                
                {constraints.backendType === "cuda" && specs?.gpu_name && String(specs.gpu_name).toLowerCase().includes("gtx") && (
                  <div style={{
                    marginTop: "12px",
                    padding: "10px 14px",
                    background: "rgba(239, 68, 68, 0.08)",
                    border: "1px dashed rgb(239, 68, 68)",
                    borderRadius: "8px",
                    fontSize: "0.75rem",
                    color: "var(--md-sys-color-on-surface)",
                    lineHeight: "1.45"
                  }}>
                    <strong>Performance Alert:</strong> Your graphics card (<code>{specs.gpu_name}</code>) is a GTX-series GPU which lacks hardware <strong>Tensor Cores</strong>. Running in CUDA mode will be up to 3x slower. We strongly recommend switching to <strong>Vulkan GPU</strong> for optimal generation speed.
                  </div>
                )}
                
                {backendOptions?.unavailable?.length > 0 && (
                  <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "4px" }}>
                    {backendOptions.unavailable.map((backend) => (
                      <span key={backend.id} style={{ fontSize: "0.75rem", color: "var(--md-sys-color-error)", lineHeight: 1.35 }}>
                        {backend.label} unavailable: {backend.reason}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(Settings);
