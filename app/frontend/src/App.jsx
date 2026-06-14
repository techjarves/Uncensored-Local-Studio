import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Sidebar from "./components/Sidebar";
import TopStatusBar from "./components/TopStatusBar";
import Generator from "./components/Generator";
import ModelManager from "./components/ModelManager";
import ImageConstraints from "./components/ImageConstraints";
import { cleanupCandidates, formatBytes, getCleanupCandidates, getDiagnostics, getHardwareSpecs, getHealth, getTelemetry, getBackendOptions, getBackendStatus, listGeneratedOutputs, stopServer } from "./services/api";
import "./App.css";

function App() {
  const dialogResolverRef = useRef(null);
  const [dialog, setDialog] = useState(null);

  const closeDialog = useCallback((value) => {
    const resolver = dialogResolverRef.current;
    dialogResolverRef.current = null;
    setDialog(null);
    if (resolver) resolver(value);
  }, []);

  const showConfirm = useCallback(({ title = "Confirm Action", message, confirmLabel = "OK", cancelLabel = "Cancel", danger = false }) => {
    return new Promise((resolve) => {
      dialogResolverRef.current = resolve;
      setDialog({ type: "confirm", title, message, confirmLabel, cancelLabel, danger });
    });
  }, []);

  const showAlert = useCallback(({ title = "Notice", message, confirmLabel = "OK", danger = false }) => {
    return new Promise((resolve) => {
      dialogResolverRef.current = resolve;
      setDialog({ type: "alert", title, message, confirmLabel, danger });
    });
  }, []);

  // Theme State
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Navigation
  const [activeTab, setActiveTab] = useState("generator");

  // Prompts
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");

  // Model & Server Status
  const [activeModel, setActiveModel] = useState(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [isStoppingServer, setIsStoppingServer] = useState(false);
  const [backendOptions, setBackendOptions] = useState({
    options: [{ id: "cpu", label: "CPU", available: true }],
    cudaAvailable: false,
    vulkanAvailable: false,
    defaultBackendType: "cpu",
  });
  const [health, setHealth] = useState(null);
  const [cleanupItems, setCleanupItems] = useState([]);
  const [isReadinessBusy, setIsReadinessBusy] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);

  // Gallery History
  const [generatedImages, setGeneratedImages] = useState([]);

  // Generation status
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);

  // System Specifications & Telemetry
  const [specs, setSpecs] = useState({
    os_name: "Loading Specs...",
    cpu_name: "Loading Specs...",
    cpu_cores_physical: 4,
    cpu_cores_logical: 8,
    ram_total_gb: 0,
    gpu_name: "Loading Specs...",
  });

  const [telemetry, setTelemetry] = useState({
    cpu_usage: 0,
    ram_used_gb: 0,
    ram_total_gb: 0,
    gpu_name: "Detecting...",
    vram_used_gb: 0,
    vram_total_gb: 0,
  });

  // Default Image Constraints
  const [constraints, setConstraints] = useState({
    width: 1024,
    height: 1024,
    steps: 4,          // Recommended default steps for Flux.1 Schnell/Lightning
    npuSteps: 4,
    standardSteps: 20,
    cfgScale: 1.0,     // Recommended default CFG for Flux.1 Schnell
    sampler: "euler_a",
    seed: -1,
    denoisingStrength: 0.7,
    useGpu: true,
    useTaesd: true,
    useFlashAttn: true,
    useTiling: false,
    vaeTiling: true,
    vaeOnCpu: false,
    threads: 4,
    backendType: "auto",
  });

  // Load hardware specifications on mount
  useEffect(() => {
    async function loadSpecs() {
      try {
        const hardware = await getHardwareSpecs();
        const backendInfo = await getBackendOptions();
        setBackendOptions(backendInfo);
        setSpecs(hardware);
        // Default CPU threads count to match physical cores
        setConstraints((prev) => ({
          ...prev,
          threads: hardware.cpu_cores_physical || 4,
          backendType: prev.backendType === "auto" ? backendInfo.defaultBackendType || "cpu" : prev.backendType,
          useGpu: (prev.backendType === "auto" ? backendInfo.defaultBackendType : prev.backendType) !== "cpu",
        }));
      } catch (err) {
        console.error("Error fetching hardware specs:", err);
      }
    }
    loadSpecs();
  }, []);

  const refreshReadiness = useCallback(async () => {
    setIsReadinessBusy(true);
    try {
      const [healthInfo, candidates] = await Promise.all([
        getHealth(),
        getCleanupCandidates().catch(() => []),
      ]);
      setHealth(healthInfo);
      setCleanupItems(candidates);
    } finally {
      setIsReadinessBusy(false);
    }
  }, []);

  useEffect(() => {
    refreshReadiness();
  }, [refreshReadiness]);

  const copyDiagnostics = useCallback(async () => {
    try {
      const diagnostics = await getDiagnostics();
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setDiagnosticsCopied(true);
      setTimeout(() => setDiagnosticsCopied(false), 1800);
    } catch (err) {
      showAlert({ title: "Diagnostics Failed", message: err.message || String(err), danger: true });
    }
  }, [showAlert]);

  const cleanupSafeItems = useCallback(async () => {
    if (cleanupItems.length === 0) return;
    const totalBytes = cleanupItems.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
    const ok = await showConfirm({
      title: "Clean Safe Files?",
      message: `Delete ${cleanupItems.length} temporary/cache item${cleanupItems.length === 1 ? "" : "s"} and free about ${formatBytes(totalBytes)}?\n\nModels and generated outputs are not included.`,
      confirmLabel: "Clean",
      danger: true,
    });
    if (!ok) return;

    setIsReadinessBusy(true);
    try {
      await cleanupCandidates(cleanupItems.map((item) => item.id));
      await refreshReadiness();
    } catch (err) {
      showAlert({ title: "Cleanup Failed", message: err.message || String(err), danger: true });
    } finally {
      setIsReadinessBusy(false);
    }
  }, [cleanupItems, refreshReadiness, showAlert, showConfirm]);

  useEffect(() => {
    async function loadSavedOutputs() {
      const outputs = await listGeneratedOutputs();
      setGeneratedImages(outputs);
    }
    loadSavedOutputs();
  }, []);

  // Save active model configuration to localStorage for persistence across reloads
  useEffect(() => {
    if (activeModel) {
      localStorage.setItem("active-model", activeModel);
    } else {
      localStorage.removeItem("active-model");
    }
  }, [activeModel]);

  // Check if server is already running on mount (handles page refresh and startup lag)
  useEffect(() => {
    let checkInterval = null;

    async function checkServerRunning() {
      const status = await getBackendStatus();
      const isRunning = Boolean(status.ready);
      if (isRunning) {
        if (checkInterval) clearInterval(checkInterval);

        const savedModel = localStorage.getItem("active-model");
        if (savedModel) {
          setActiveModel(savedModel);
          setServerRunning(true);
        } else {
          // Query the active model from status if possible, otherwise use fallback
          try {
            if (status && status.settings && status.settings.model) {
              const modelName = status.settings.model.split(/[\\/]/).pop();
              setActiveModel(modelName);
            }
          } catch (_) {}
          setServerRunning(true);
        }
      } else {
        // If server is not running, check if they had a simulated model active in browser mode
        const isTauriDesktop = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
        if (!isTauriDesktop) {
          const savedModel = localStorage.getItem("active-model");
          if (savedModel) {
            setActiveModel(savedModel);
            setServerRunning(false);
          }
        }
      }
    }

    checkServerRunning();
    // Poll every 2 seconds to auto-detect when the backend becomes ready
    checkInterval = setInterval(checkServerRunning, 2000);

    return () => {
      if (checkInterval) clearInterval(checkInterval);
    };
  }, []);

  // Poll system telemetry usage statistics on interval
  useEffect(() => {
    async function updateTelemetry() {
      try {
        const stats = await getTelemetry();
        setTelemetry((prev) => (
          prev.cpu_usage === stats.cpu_usage &&
          prev.ram_used_gb === stats.ram_used_gb &&
          prev.ram_total_gb === stats.ram_total_gb &&
          prev.gpu_name === stats.gpu_name &&
          prev.vram_used_gb === stats.vram_used_gb &&
          prev.vram_total_gb === stats.vram_total_gb
            ? prev
            : stats
        ));
      } catch (err) {
        // Telemetry errors ignored
      }
    }

    updateTelemetry();
    const interval = setInterval(updateTelemetry, 1500); // Poll every 1.5 seconds

    return () => clearInterval(interval);
  }, []);

  // Sync active model settings default parameters
  useEffect(() => {
    if (activeModel) {
      const name = activeModel.toLowerCase();
      if (name.includes("lcm-dreamshaper-v7-fp16")) {
        setConstraints((prev) => ({
          ...prev,
          steps: 4,
          npuSteps: 4,
          cfgScale: 1.0,
          width: 512,
          height: 512,
          backendType: "openvino-npu",
          useGpu: true,
        }));
      } else if (name.includes("flux") || name.includes("schnell")) {
        setConstraints((prev) => ({
          ...prev,
          steps: 4,
          standardSteps: 4,
          cfgScale: 1.0,
          width: 1024,
          height: 1024,
        }));
      } else if (name.includes("lightning") || name.includes("turbo")) {
        setConstraints((prev) => ({
          ...prev,
          steps: 4,
          standardSteps: 4,
          cfgScale: 1.5,
          width: 1024,
          height: 1024,
        }));
      } else if (name.includes("sd15")) {
        setConstraints((prev) => ({
          ...prev,
          steps: 25,
          standardSteps: 25,
          cfgScale: 7.0,
          width: 512,
          height: 512,
        }));
      } else if (name.includes("sd35")) {
        setConstraints((prev) => ({
          ...prev,
          steps: 20,
          standardSteps: 20,
          cfgScale: 4.5,
          width: 1024,
          height: 1024,
        }));
      } else {
        // Fallback for custom or SD 1.x models (like CyberRealistic or arbitrary safetensors)
        setConstraints((prev) => ({
          ...prev,
          steps: 20,
          standardSteps: 20,
          cfgScale: 7.0,
          width: 512,
          height: 512,
        }));
      }
    }
  }, [activeModel]);

  const activeTabContent = useMemo(() => {
    switch (activeTab) {
      case "generator":
        return (
          <Generator
            prompt={prompt}
            setPrompt={setPrompt}
            negativePrompt={negativePrompt}
            setNegativePrompt={setNegativePrompt}
            constraints={constraints}
            setConstraints={setConstraints}
            activeModel={activeModel}
            generatedImages={generatedImages}
            setGeneratedImages={setGeneratedImages}
            isGenerating={isGenerating}
            setIsGenerating={setIsGenerating}
            generationProgress={generationProgress}
            setGenerationProgress={setGenerationProgress}
            setActiveTab={setActiveTab}
            showAlert={showAlert}
            showConfirm={showConfirm}
          />
        );
      case "models":
        return (
          <ModelManager
            activeModel={activeModel}
            setActiveModel={setActiveModel}
            serverRunning={serverRunning}
            setServerRunning={setServerRunning}
            constraints={constraints}
            backendOptions={backendOptions}
            showAlert={showAlert}
            showConfirm={showConfirm}
          />
        );
      case "constraints":
        return (
          <ImageConstraints
            constraints={constraints}
            setConstraints={setConstraints}
            activeModel={activeModel}
            specs={specs}
            backendOptions={backendOptions}
            serverRunning={serverRunning}
            setServerRunning={setServerRunning}
            setActiveModel={setActiveModel}
            showAlert={showAlert}
            showConfirm={showConfirm}
          />
        );
      default:
        return null;
    }
  }, [
    activeTab,
    prompt,
    negativePrompt,
    constraints,
    activeModel,
    generatedImages,
    isGenerating,
    generationProgress,
    serverRunning,
    specs,
    backendOptions,
    showAlert,
    showConfirm,
  ]);

  const sidebarContent = useMemo(() => (
    <Sidebar
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      specs={specs}
    />
  ), [activeTab, specs]);

  const handleStopServer = useCallback(async () => {
    if (!serverRunning || isStoppingServer) return;
    setIsStoppingServer(true);
    try {
      await stopServer();
      setServerRunning(false);
      setActiveModel(null);
    } catch (err) {
      console.error("Failed to stop server:", err);
      showAlert({ title: "Stop Server Failed", message: err.message || String(err), danger: true });
    } finally {
      setIsStoppingServer(false);
    }
  }, [serverRunning, isStoppingServer, showAlert]);

  const readinessIssues = [
    ...(health?.stale ? ["Restart Local AI Image Generator so the local server loads the latest API."] : []),
    ...(health?.issues || []),
  ];
  const cleanupBytes = cleanupItems.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  const showReadinessPanel = Boolean(health && (readinessIssues.length > 0 || cleanupItems.length > 0));

  return (
    <div className="app-container">
      {/* Sidebar with Navigation Rail & Specs */}
      {sidebarContent}

      {/* Main Panel */}
      <div className="main-content">
        {/* Top telemetry specs chips bar */}
        <TopStatusBar
          telemetry={telemetry}
          serverRunning={serverRunning}
          activeModel={activeModel}
          onStopServer={handleStopServer}
          isStoppingServer={isStoppingServer}
          theme={theme}
          setTheme={setTheme}
        />

        {showReadinessPanel && (
          <div className={`m3-card readiness-card ${health?.stale || readinessIssues.length > 0 ? "readiness-card-warning" : ""}`}>
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
                      : `${cleanupItems.length} temporary item${cleanupItems.length === 1 ? "" : "s"} can be cleaned (${formatBytes(cleanupBytes)}).`}
                </p>
              </div>
              <div className="readiness-actions">
                <button className="m3-btn m3-btn-outlined" onClick={refreshReadiness} disabled={isReadinessBusy}>
                  {isReadinessBusy ? "Checking" : "Refresh"}
                </button>
                <button className="m3-btn m3-btn-tonal" onClick={copyDiagnostics}>
                  {diagnosticsCopied ? "Copied" : "Copy Diagnostics"}
                </button>
                {cleanupItems.length > 0 && (
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
            {cleanupItems.length > 0 && (
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

        {/* Dynamic Workspace Container */}
        {activeTabContent}
      </div>

      {dialog && (
        <div className="app-dialog-backdrop" role="presentation">
          <div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
            <h3 id="app-dialog-title" className="app-dialog-title">{dialog.title}</h3>
            <p className="app-dialog-message">{dialog.message}</p>
            <div className="app-dialog-actions">
              {dialog.type === "confirm" && (
                <button className="m3-btn m3-btn-outlined" onClick={() => closeDialog(false)}>
                  {dialog.cancelLabel}
                </button>
              )}
              <button
                className={`m3-btn ${dialog.danger ? "m3-btn-error" : "m3-btn-filled"}`}
                onClick={() => closeDialog(true)}
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
