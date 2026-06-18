import React, { memo, useEffect, useState, useCallback } from "react";
import {
  Crop, Sliders, Cpu, Info, MessageSquare, SlidersHorizontal, Zap,
  ChevronDown, Image, Type, Settings2, Gauge, Brain, Sparkles,
  Monitor, HardDrive, MemoryStick, Thermometer, Hash, Layers,
  ChevronRight, Box, Wand2, Lightbulb, RotateCcw, Check, Palette
} from "lucide-react";
import { stopServer, formatBytes, getLlmStatus } from "../services/api";
import { THEMES } from "../themes";

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

// ─── Collapsible Card Component ───
function CollapsibleCard({ icon: Icon, title, subtitle, children, defaultExpanded = false, id, badge, badgeColor }) {
  const [isExpanded, setIsExpanded] = useState(() => {
    const saved = localStorage.getItem(`settings_card_${id}`);
    return saved !== null ? saved === "true" : defaultExpanded;
  });

  const toggle = useCallback(() => {
    const newState = !isExpanded;
    setIsExpanded(newState);
    localStorage.setItem(`settings_card_${id}`, String(newState));
  }, [isExpanded, id]);

  return (
    <div className="collapsible-card">
      <button
        className="collapsible-header"
        onClick={toggle}
        aria-expanded={isExpanded}
        type="button"
      >
        <div className="collapsible-header-left">
          <div className="collapsible-header-icon">
            <Icon size={18} />
          </div>
          <div>
            <div className="collapsible-header-title">
              {title}
              {badge && (
                <span 
                  className="collapsible-header-badge" 
                  style={{ 
                    background: badgeColor || "var(--md-sys-color-primary-container)",
                    color: badgeColor ? "#fff" : "var(--md-sys-color-on-primary-container)"
                  }}
                >
                  {badge}
                </span>
              )}
            </div>
            {subtitle && <div className="collapsible-header-subtitle">{subtitle}</div>}
          </div>
        </div>
        <div className="collapsible-header-right">
          <ChevronDown
            size={20}
            className={`collapsible-chevron ${isExpanded ? "expanded" : ""}`}
          />
        </div>
      </button>
      {isExpanded && (
        <div className="collapsible-content">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Hardware Tier Badge Component ───
function HardwareTierBadge({ specs }) {
  if (!specs?.tier) return null;

  const tierConfig = {
    high: { icon: "🚀", label: "High-End PC", color: "tier-high", accent: "#22c55e" },
    mid: { icon: "⚖️", label: "Balanced PC", color: "tier-mid", accent: "#3b82f6" },
    low: { icon: "🥔", label: "Potato PC", color: "tier-low", accent: "#f59e0b" },
  };

  const tier = tierConfig[specs.tier] || tierConfig.low;
  const rec = specs.recommended_text_settings;

  return (
    <div className={`hardware-tier-badge ${tier.color}`}>
      <div className="hardware-tier-header">
        <div className="hardware-tier-icon">{tier.icon}</div>
        <div className="hardware-tier-info">
          <div className="hardware-tier-name">{tier.label}</div>
          <div className="hardware-tier-specs">
            {specs.cpu_name} • {specs.cpu_cores_physical} cores • {specs.ram_total_gb}GB RAM
            {specs.gpu_name && specs.gpu_name !== "Loading..." && ` • ${specs.gpu_name}`}
            {specs.gpu_vram_gb > 0 && ` • ${specs.gpu_vram_gb}GB VRAM`}
          </div>
        </div>
      </div>
      {rec && (
        <>
          <div className="hardware-tier-divider" />
          <div className="hardware-tier-chips">
            <span className="hardware-tier-chip">Ctx: {rec.contextSize}</span>
            <span className="hardware-tier-chip">Threads: {rec.threads}</span>
            <span className="hardware-tier-chip">KV: {rec.cacheTypeK}</span>
            <span className="hardware-tier-chip">Batch: {rec.batchSize}</span>
            <span className="hardware-tier-chip">Profile: {rec.performanceProfile}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Premium Toggle Component ───
function PremiumToggle({ checked, onChange, label, description }) {
  return (
    <label className="premium-toggle" style={{ cursor: "pointer" }}>
      <div
        className={`premium-toggle-checkbox ${checked ? "checked" : ""}`}
        onClick={() => onChange(!checked)}
        role="checkbox"
        aria-checked={checked}
      >
        {checked && <Check size={14} />}
      </div>
      <div style={{ flex: 1 }}>
        <div className="premium-toggle-label">{label}</div>
        {description && <div className="premium-toggle-desc">{description}</div>}
      </div>
    </label>
  );
}

// ─── Section Header Component ───
function SectionHeader({ icon: Icon, title, count, color }) {
  return (
    <div className="settings-section-header" style={{ borderLeftColor: color }}>
      <div className="settings-section-icon" style={{ background: color + "15", color }}>
        <Icon size={22} />
      </div>
      <div>
        <div className="settings-section-title">{title}</div>
      </div>
      {count && (
        <span className="settings-section-count">{count} settings</span>
      )}
    </div>
  );
}

// ─── Main Settings Component ───
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
  theme,
  setTheme,
}) {
  const [llmStatus, setLlmStatus] = useState({ ready: false, settings: {} });

  useEffect(() => {
    let cancelled = false;
    const fetchLlmStatus = async () => {
      try {
        const status = await getLlmStatus();
        if (!cancelled) setLlmStatus(status);
      } catch (_) {}
    };
    fetchLlmStatus();
    const interval = setInterval(fetchLlmStatus, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const isSD15OrCustom = activeModel ? isSD15OrCustomModel(activeModel) : false;
  const isOpenVinoNpu = constraints.backendType === "openvino-npu";
  const supportsThinking = Boolean(llmStatus.ready && llmStatus.settings?.supportsThinking);
  const availableBackends = backendOptions?.options?.length
    ? backendOptions.options
    : [{ id: "cpu", label: "CPU", available: true }];

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

  // ─── Image Settings ───
  const ImageSettings = () => (
    <>
      <SectionHeader 
        icon={Image} 
        title="Image Generation" 
        count={4}
        color="#3b82f6"
      />
      
      <div className="settings-two-column">
        {/* Left Column */}
        <div className="settings-column">
          {/* Size & Shape */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">
              <Crop size={16} />
              Size & Shape
            </div>
            <div className="m3-field-group">
              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Resolution</span>
                  <span className="settings-value-badge">
                    {constraints.width >= 1024 ? "SDXL" : "SD 1.5"}
                  </span>
                </div>
                <div className="m3-segmented-button">
                  {["sd15", "sdxl"].map((mode) => (
                    <button
                      key={mode}
                      className={`m3-segment-item ${(constraints.width >= 1024 ? "sdxl" : "sd15") === mode ? "active" : ""}`}
                      onClick={() => {
                        const ratio = ASPECT_RATIOS.find(r => {
                          const rw = constraints.width >= 1024 ? r.sdxl_width : r.width;
                          const rh = constraints.height >= 1024 ? r.sdxl_height : r.height;
                          return Math.abs(rw - constraints.width) < 10 && Math.abs(rh - constraints.height) < 10;
                        })?.id || "1:1";
                        handleAspectRatioChange(ratio, mode);
                      }}
                      disabled={isSD15OrCustom && mode === "sdxl"}
                    >
                      {mode === "sd15" ? "512px" : "1024px"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Aspect Ratio</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px" }}>
                  {ASPECT_RATIOS.map((ratio) => {
                    const isSDXL = constraints.width >= 1024 && !isSD15OrCustom;
                    const rw = isSDXL ? ratio.sdxl_width : ratio.width;
                    const rh = isSDXL ? ratio.sdxl_height : ratio.height;
                    const isActive = Math.abs(constraints.width - rw) < 10 && Math.abs(constraints.height - rh) < 10;
                    return (
                      <button
                        key={ratio.id}
                        className={`m3-btn ${isActive ? "m3-btn-filled" : "m3-btn-outlined"}`}
                        onClick={() => handleAspectRatioChange(ratio.id, isSDXL ? "sdxl" : "sd15")}
                        disabled={isOpenVinoNpu && ratio.id !== "1:1"}
                        style={{ fontSize: "0.8rem", padding: "10px 4px", height: "auto" }}
                      >
                        <div style={{ fontWeight: 700 }}>{ratio.id}</div>
                        <div style={{ fontSize: "0.7rem", opacity: 0.8, marginTop: "2px" }}>
                          {rw}×{rh}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div className="m3-text-field">
                  <label className="m3-text-field-label">Width</label>
                  <input
                    type="number"
                    className="m3-input"
                    value={constraints.width}
                    onChange={(e) => updateConstraint("width", Math.round(parseInt(e.target.value) / 64) * 64)}
                    min="64"
                    max="2048"
                    step="64"
                  />
                </div>
                <div className="m3-text-field">
                  <label className="m3-text-field-label">Height</label>
                  <input
                    type="number"
                    className="m3-input"
                    value={constraints.height}
                    onChange={(e) => updateConstraint("height", Math.round(parseInt(e.target.value) / 64) * 64)}
                    min="64"
                    max="2048"
                    step="64"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Quality & Speed */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">
              <Sliders size={16} />
              Quality & Speed
            </div>
            <div className="m3-field-group">
              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Detail Steps</span>
                  <span className="settings-value-badge">{constraints.steps}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={constraints.steps}
                  onChange={(e) => updateConstraint("steps", parseInt(e.target.value))}
                  min="1"
                  max={isOpenVinoNpu ? "8" : "60"}
                />
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)" }}>
                  {isOpenVinoNpu
                    ? "LCM OpenVINO: 1-8 fast steps"
                    : "More steps = sharper details, longer time"}
                </span>
              </div>

              <div className="m3-text-field">
                <label className="m3-text-field-label">Random Seed</label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="number"
                    className="m3-input"
                    value={constraints.seed}
                    onChange={(e) => updateConstraint("seed", parseInt(e.target.value) || -1)}
                    placeholder="-1 for random"
                    style={{ flex: 1 }}
                  />
                  <button
                    className="m3-btn m3-btn-tonal"
                    onClick={() => updateConstraint("seed", -1)}
                  >
                    Random
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="settings-column">
          {/* Memory Optimizations */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">
              <SlidersHorizontal size={16} />
              Memory Optimizations
            </div>
            <div className="m3-field-group">
              <PremiumToggle
                checked={constraints.vaeTiling}
                onChange={(v) => updateConstraint("vaeTiling", v)}
                label="VAE Tiling"
                description="Process image in tiles to save VRAM"
              />
              <PremiumToggle
                checked={constraints.vaeOnCpu}
                onChange={(v) => updateConstraint("vaeOnCpu", v)}
                label="VAE on CPU"
                description="Run decoder on CPU if GPU OOM"
              />
              <PremiumToggle
                checked={constraints.useFlashAttn}
                onChange={(v) => updateConstraint("useFlashAttn", v)}
                label="Flash Attention"
                description="Faster attention with less memory"
              />
            </div>
          </div>

          {/* Backend & Acceleration */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">
              <Monitor size={16} />
              Backend & Acceleration
            </div>
            <div className="m3-field-group">
              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Accelerator</span>
                </div>
                <div className="m3-segmented-button" style={{ flexWrap: "wrap" }}>
                  {availableBackends.map((b) => (
                    <button
                      key={b.id}
                      className={`m3-segment-item ${constraints.backendType === b.id ? "active" : ""}`}
                      onClick={() => handleBackendChange(b.id)}
                      style={{ flex: "1 1 auto", minWidth: "80px" }}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );

  // ─── Text Settings ───
  const TextSettings = () => (
    <>
      <SectionHeader 
        icon={Type} 
        title="Text Generation" 
        count={5}
        color="#8b5cf6"
      />
      
      <div className="settings-two-column">
        {/* Left Column */}
        <div className="settings-column">
          {/* Model & Context */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">
              <MessageSquare size={16} />
              Model & Context
            </div>
            <div className="m3-field-group">
              <div className="m3-text-field">
                <label className="m3-text-field-label">System Prompt</label>
                <textarea
                  className="m3-input"
                  value={textSettings.systemPrompt || ""}
                  onChange={(e) => updateTextSetting("systemPrompt", e.target.value)}
                  placeholder="Enter system prompt..."
                  rows={3}
                  style={{ resize: "vertical", minHeight: "60px" }}
                />
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Context Size</span>
                  <span className="settings-value-badge">{textSettings.contextSize || 0}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.contextSize || 0}
                  onChange={(e) => updateTextSetting("contextSize", parseInt(e.target.value))}
                  min="0"
                  max="32768"
                  step="512"
                />
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)" }}>
                  0 = Auto (model default)
                </span>
              </div>
            </div>
          </div>

          {/* Generation Parameters */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">
              <Settings2 size={16} />
              Generation Parameters
            </div>
            <div className="m3-field-group">
              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Temperature</span>
                  <span className="settings-value-badge">{textSettings.temperature}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.temperature}
                  onChange={(e) => updateTextSetting("temperature", parseFloat(e.target.value))}
                  min="0"
                  max="2"
                  step="0.1"
                />
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Top P</span>
                  <span className="settings-value-badge">{textSettings.topP}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.topP}
                  onChange={(e) => updateTextSetting("topP", parseFloat(e.target.value))}
                  min="0"
                  max="1"
                  step="0.05"
                />
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Top K</span>
                  <span className="settings-value-badge">{textSettings.topK}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.topK}
                  onChange={(e) => updateTextSetting("topK", parseInt(e.target.value))}
                  min="1"
                  max="100"
                  step="1"
                />
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Min P</span>
                  <span className="settings-value-badge">{textSettings.minP}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.minP}
                  onChange={(e) => updateTextSetting("minP", parseFloat(e.target.value))}
                  min="0"
                  max="1"
                  step="0.01"
                />
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Repeat Penalty</span>
                  <span className="settings-value-badge">{textSettings.repeatPenalty}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.repeatPenalty}
                  onChange={(e) => updateTextSetting("repeatPenalty", parseFloat(e.target.value))}
                  min="1"
                  max="2"
                  step="0.05"
                />
              </div>

              <div className="m3-text-field">
                <label className="m3-text-field-label">Seed (-1 = Random)</label>
                <input
                  type="number"
                  className="m3-input"
                  value={textSettings.seed}
                  onChange={(e) => updateTextSetting("seed", parseInt(e.target.value) || -1)}
                  placeholder="-1"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="settings-column">
          {/* Performance Profile */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">
              <Gauge size={16} />
              Performance Profile
            </div>
            <div className="m3-field-group">
              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Profile</span>
                </div>
                <div className="m3-segmented-button">
                  {["potato", "balanced", "high", "custom"].map((profile) => (
                    <button
                      key={profile}
                      className={`m3-segment-item ${(textSettings.performanceProfile || "balanced") === profile ? "active" : ""}`}
                      onClick={() => updateTextSetting("performanceProfile", profile)}
                    >
                      {profile.charAt(0).toUpperCase() + profile.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">CPU Threads</span>
                  <span className="settings-value-badge">{textSettings.threads || 4}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.threads || 4}
                  onChange={(e) => updateTextSetting("threads", parseInt(e.target.value))}
                  min="1"
                  max={specs?.cpu_cores_logical || 16}
                />
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">GPU Layers</span>
                  <span className="settings-value-badge">{textSettings.gpuLayers === -1 ? "All" : textSettings.gpuLayers}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.gpuLayers === -1 ? 50 : textSettings.gpuLayers}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    updateTextSetting("gpuLayers", val >= 50 ? -1 : val);
                  }}
                  min="0"
                  max="50"
                />
                <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)" }}>
                  50 = All layers on GPU
                </span>
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">Batch Size</span>
                  <span className="settings-value-badge">{textSettings.batchSize || 512}</span>
                </div>
                <input
                  type="range"
                  className="m3-slider"
                  value={textSettings.batchSize || 512}
                  onChange={(e) => updateTextSetting("batchSize", parseInt(e.target.value))}
                  min="64"
                  max="2048"
                  step="64"
                />
              </div>

              <div className="m3-slider-group">
                <div className="m3-slider-header">
                  <span className="m3-slider-label">KV Cache</span>
                </div>
                <div className="m3-segmented-button">
                  {["q4_0", "q8_0", "f16"].map((type) => (
                    <button
                      key={type}
                      className={`m3-segment-item ${(textSettings.cacheTypeK || "q8_0") === type ? "active" : ""}`}
                      onClick={() => {
                        updateTextSetting("cacheTypeK", type);
                        updateTextSetting("cacheTypeV", type);
                      }}
                    >
                      {type.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Thinking & Reasoning */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">
              <Brain size={16} />
              Thinking & Reasoning
            </div>
            <div className="m3-field-group">
              <PremiumToggle
                checked={textSettings.enableThinking !== false}
                onChange={(v) => updateTextSetting("enableThinking", v)}
                label="DeepThink"
                description={supportsThinking
                  ? "Show model's reasoning process"
                  : "Model does not support thinking"
                }
              />
              {!supportsThinking && (
                <div style={{
                  padding: "10px 14px",
                  borderRadius: "10px",
                  background: "rgba(239, 68, 68, 0.08)",
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                  fontSize: "0.8rem",
                  color: "var(--md-sys-color-error)"
                }}>
                  <Info size={14} style={{ verticalAlign: "middle", marginRight: "6px" }} />
                  Current model does not support thinking. Load a reasoning model to enable.
                </div>
              )}
            </div>
          </div>

          {/* Text Backend */}
          <div className="settings-subsection">
            <div className="settings-subsection-title">
              <Cpu size={16} />
              Text Backend
            </div>
            <div className="m3-field-group">
              <div style={{
                padding: "12px 16px",
                borderRadius: "12px",
                background: "var(--md-sys-color-surface-variant)",
                fontSize: "0.85rem",
                color: "var(--md-sys-color-on-surface-variant)"
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                  <Monitor size={16} />
                  <strong style={{ color: "var(--md-sys-color-on-surface)" }}>
                    {llmStatus.ready ? "Running" : "Stopped"}
                  </strong>
                </div>
                {llmStatus.ready && (
                  <div style={{ fontSize: "0.8rem", lineHeight: "1.5" }}>
                    Model: {llmStatus.settings?.model || "Unknown"}<br />
                    Backend: {llmStatus.settings?.backendMode || "Unknown"}<br />
                    Threads: {llmStatus.settings?.threads || "-"}<br />
                    GPU Layers: {llmStatus.settings?.gpuLayers === -1 ? "All" : llmStatus.settings?.gpuLayers}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );

  // ─── Appearance Settings ───
  const AppearanceSettings = () => (
    <>
      <SectionHeader 
        icon={Palette} 
        title="Appearance & Themes" 
        count={THEMES.length}
        color="var(--md-sys-color-primary)"
      />
      
      <div className="settings-subsection" style={{ marginBottom: "28px" }}>
        <div className="settings-subsection-title">
          <Palette size={16} />
          Color Themes
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: "14px",
          marginTop: "14px"
        }}>
          {THEMES.map((t) => {
            const isActive = theme === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={`theme-card-btn ${isActive ? "active" : ""}`}
                style={{
                  background: t.bg,
                  color: t.type === "dark" ? "#f4f4f5" : "#0f172a",
                  border: isActive ? "2px solid var(--md-sys-color-primary)" : "1px solid var(--border-color)",
                  borderRadius: "14px",
                  padding: "18px",
                  textAlign: "left",
                  cursor: "pointer",
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  gap: "14px",
                  boxShadow: isActive ? "0 4px 16px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)" : "none",
                  transition: "all 0.25s ease",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                  <span style={{ fontWeight: 700, fontSize: "0.88rem", letterSpacing: "-0.01em" }}>{t.name}</span>
                  {isActive && (
                    <div style={{
                      background: "linear-gradient(135deg, var(--md-sys-color-primary), var(--md-sys-color-secondary))",
                      color: "var(--md-sys-color-on-primary)",
                      borderRadius: "50%",
                      width: "22px",
                      height: "22px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 2px 6px color-mix(in srgb, var(--md-sys-color-primary) 40%, transparent)"
                    }}>
                      <Check size={13} strokeWidth={3} />
                    </div>
                  )}
                </div>
                
                {/* Preview circles for primary and secondary colors */}
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <div style={{ width: "26px", height: "26px", borderRadius: "50%", background: t.primary, border: "2px solid rgba(255,255,255,0.25)", boxShadow: "0 2px 6px rgba(0,0,0,0.15)" }} title="Primary" />
                  <div style={{ width: "26px", height: "26px", borderRadius: "50%", background: t.secondary, border: "2px solid rgba(255,255,255,0.25)", boxShadow: "0 2px 6px rgba(0,0,0,0.15)" }} title="Secondary" />
                  <div style={{ width: "26px", height: "26px", borderRadius: "50%", background: t.bg, border: "1.5px solid rgba(0,0,0,0.12)", boxShadow: "inset 0 2px 4px rgba(0,0,0,0.06)" }} title="Background" />
                  <span style={{ marginLeft: "auto", fontSize: "0.7rem", opacity: 0.6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {t.type}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );

  return (
    <div className="workspace-area">
      {/* Page Header */}
      <div className="settings-page-header">
        <div>
          <div className="settings-page-title">
            <Settings2 size={24} style={{ color: "var(--md-sys-color-primary)" }} />
            Settings & Parameters
          </div>
          <div className="settings-page-subtitle">
            Configure your AI models for optimal performance
          </div>
        </div>
      </div>

      {/* Hardware Tier Badge */}
      <HardwareTierBadge specs={specs} />

      {/* Appearance & Themes Section */}
      <AppearanceSettings />

      {/* Image Settings Section */}
      <ImageSettings />

      {/* Text Settings Section */}
      <TextSettings />
    </div>
  );
}

export default memo(Settings);
