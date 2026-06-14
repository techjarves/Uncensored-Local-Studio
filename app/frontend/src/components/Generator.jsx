import React, { memo, useState, useRef, useCallback } from "react";
import { Sparkles, Download, Copy, RefreshCw, Check, Sliders, Trash2, ImagePlus } from "lucide-react";
import { generateImage, startServer, stopServer, waitForServerReady, getBackendStatus, getGenerationProgress, saveGeneratedOutput, deleteGeneratedOutputs } from "../services/api";

const GalleryItem = memo(({ img, idx, isSelected, onClick }) => {
  const handleClick = (e) => {
    onClick(idx, e);
  };
  return (
    <div
      className={`gallery-item ${isSelected ? "selected" : ""}`}
      onClick={handleClick}
      title={`Prompt: ${img.prompt}\nSeed: ${img.seed}${img.duration_sec ? `\nTime: ${img.duration_sec.toFixed(1)}s` : ""}`}
    >
      <img src={img.url} className="gallery-thumb" alt="Thumbnail" loading="lazy" decoding="async" />
      {isSelected && (
        <div className="gallery-select-badge">
          <Check size={14} />
        </div>
      )}
    </div>
  );
});

function Generator({
  prompt,
  setPrompt,
  negativePrompt,
  setNegativePrompt,
  constraints,
  setConstraints,
  activeModel,
  generatedImages,
  setGeneratedImages,
  isGenerating,
  setIsGenerating,
  generationProgress,
  setGenerationProgress,
  setActiveTab,
  showAlert = async ({ message }) => window.alert(message),
  showConfirm = async ({ message }) => window.confirm(message),
}) {
  const [outputImage, setOutputImage] = useState(null);
  const [outputSeed, setOutputSeed] = useState(null);
  const [genDuration, setGenDuration] = useState(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [estimatedLeftTime, setEstimatedLeftTime] = useState(0);
  const [currentStep, setCurrentStep] = useState(0);
  const [generationSpeed, setGenerationSpeed] = useState("");
  const [isCpuFallback, setIsCpuFallback] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRestartingBackend, setIsRestartingBackend] = useState(false);
  const [restartLoadProgress, setRestartLoadProgress] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const [selectedGalleryIndexes, setSelectedGalleryIndexes] = useState([]);
  const [baseImage, setBaseImage] = useState(null);
  const timerRef = useRef(null);
  const abortControllerRef = useRef(null);
  const hasRealGenerationStepRef = useRef(false);

  const handleBaseImageSelect = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErrorMsg("Please choose an image file (PNG, JPG, or WEBP).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBaseImage(reader.result);
    reader.onerror = () => setErrorMsg("Could not read the selected image file.");
    reader.readAsDataURL(file);
  };

  const handleClearBaseImage = () => setBaseImage(null);

  // Trigger main image generation process
  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    setErrorMsg(null);
    setIsRestartingBackend(true);
    setRestartLoadProgress(null);

    let needsRestart = false;
    try {
      const status = await getBackendStatus();
      if (status && status.settings) {
        const settings = status.settings;
        const currentModelName = settings.model ? settings.model.split(/[\\/]/).pop() : null;
        const targetModelName = activeModel ? activeModel.split(/[\\/]/).pop() : null;

        if (currentModelName !== targetModelName ||
            parseInt(settings.steps) !== parseInt(constraints.steps) ||
            Math.abs(parseFloat(settings.cfgScale) - parseFloat(constraints.cfgScale)) > 0.05 ||
            settings.sampler !== constraints.sampler ||
            parseInt(settings.threads) !== parseInt(constraints.threads) ||
            Boolean(settings.useGpu) !== (constraints.useGpu !== false) ||
            parseInt(settings.width || 512) !== parseInt(constraints.width || 512) ||
            parseInt(settings.height || 512) !== parseInt(constraints.height || 512) ||
            (settings.backendType || (settings.useGpu === false ? "cpu" : "auto")) !== (constraints.backendType || (constraints.useGpu === false ? "cpu" : "auto"))) {
          needsRestart = true;
        }
      } else {
        needsRestart = true;
      }
    } catch (e) {
      needsRestart = true;
    }

    if (needsRestart) {
      try {
        console.log("Settings out of sync, restarting backend...");
        await startServer(activeModel, constraints);
        
        let isReady = false;
        let crashError = null;
        const maxStartupPolls = constraints.backendType === "openvino-npu" ? 1200 : 240;
        for (let i = 0; i < maxStartupPolls; i++) {
          const status = await getBackendStatus();
          if (status.loading) {
            setRestartLoadProgress({
              progress: status.loading.progress || 0,
              phase: status.loading.phase || "Loading model...",
              speed: status.loading.speed || "",
              current: status.loading.current || 0,
              total: status.loading.total || 0,
              backendMode: status.loading.backendMode || status.settings?.backendMode || "",
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

        if (!isReady) {
          throw new Error(crashError || "Backend server failed to start after applying configuration changes.");
        }
      } catch (err) {
        console.error("Failed to restart backend:", err);
        setErrorMsg(err.message || "Failed to sync settings with backend.");
        setIsRestartingBackend(false);
        return;
      }
    }
    setIsRestartingBackend(false);
    setRestartLoadProgress(null);

    if (timerRef.current) clearInterval(timerRef.current);
    setIsGenerating(true);
    setGenerationProgress(0);
    setElapsedTime(0);
    setCurrentStep(0);
    setGenerationSpeed("");
    hasRealGenerationStepRef.current = false;
    setIsCpuFallback(false);
    setIsDecoding(false);
    setGenDuration(null);
    setOutputImage(null);

    // Calculate dynamic step estimation times
    // CPU takes ~35s per step at 512px, ~140s at 1024px. GPU is ~0.04x of CPU time.
    const baseGpuStepTime = (constraints.width >= 1024 ? 140 : 35) * 0.04;
    const baseCpuStepTime = (constraints.width >= 1024 ? 140 : 35);
    
    const gpuSelected = (constraints.backendType || (constraints.useGpu === false ? "cpu" : "auto")) !== "cpu";
    let activeStepTime = gpuSelected ? baseGpuStepTime : baseCpuStepTime;
    let cpuFallbackDetected = false;
    let fallbackTime = 0;
    let fallbackProgress = 0;
    let elapsedSeconds = 0;

    setEstimatedLeftTime(Math.round(constraints.steps * activeStepTime));

    timerRef.current = setInterval(async () => {
      elapsedSeconds++;
      setElapsedTime(elapsedSeconds);

      try {
        const progress = await getGenerationProgress();
        if (progress && progress.active) {
          const decoding = progress.decoding || false;
          setIsDecoding(decoding);

          const step = decoding ? (progress.steps || constraints.steps || 20) : (progress.step || 0);
          const steps = progress.steps || constraints.steps || 20;
          const speed = decoding ? "" : (progress.speed || "");

          if (decoding || progress.steps > 0) {
            hasRealGenerationStepRef.current = true;
            setCurrentStep(step);
          }
          if (!decoding) {
            setGenerationSpeed(speed);
          } else {
            setGenerationSpeed("decoding");
          }

          // Calculate progress percentage
          let progressPercent = 0;
          if (decoding) {
            progressPercent = 99;
          } else if (steps > 0) {
            progressPercent = Math.round((step / steps) * 100);
          }
          progressPercent = Math.min(99, progressPercent);
          if (decoding || progress.steps > 0) {
            setGenerationProgress(progressPercent);
          } else {
            setGenerationProgress((prev) => Math.max(prev, progressPercent));
          }

          // Calculate remaining time
          let remaining = 0;
          if (decoding) {
            remaining = 3;
          } else {
            const numericSpeed = parseFloat(speed);
            if (!isNaN(numericSpeed) && numericSpeed > 0) {
              const remainingSteps = Math.max(0, steps - step);
              if (speed.includes("it/s")) {
                remaining = remainingSteps / numericSpeed;
              } else if (speed.includes("s/it")) {
                remaining = remainingSteps * numericSpeed;
              }
            } else {
              const activeStepTime = gpuSelected ? baseGpuStepTime : baseCpuStepTime;
              remaining = Math.max(0, (steps - step) * activeStepTime);
            }
          }

          // Detect CPU fallback / slow generation if GPU was requested but it runs slow
          if (gpuSelected && !cpuFallbackDetected) {
            const isSlowItS = speed.includes("it/s") && numericSpeed < 0.2;
            const isSlowSIt = speed.includes("s/it") && numericSpeed > 5.0;
            if (isSlowItS || isSlowSIt) {
              cpuFallbackDetected = true;
              setIsCpuFallback(true);
            }
          }

          setEstimatedLeftTime(Math.round(remaining));
        } else {
          // Creep up slowly while loading the model/preparing
          setGenerationProgress((prev) => Math.min(15, prev + 1));
          setEstimatedLeftTime((prev) => Math.max(1, prev - 1));
        }
      } catch (e) {
        console.warn("Failed to get generation progress, running simulation fallback:", e);

        // Fallback simulation logic
        if (gpuSelected && !cpuFallbackDetected && elapsedSeconds > constraints.steps * baseGpuStepTime * 1.3) {
          cpuFallbackDetected = true;
          setIsCpuFallback(true);
          activeStepTime = baseCpuStepTime;
          fallbackTime = elapsedSeconds;
          fallbackProgress = Math.min(95, Math.round((elapsedSeconds / (constraints.steps * baseGpuStepTime)) * 100));
        }

        let step = Math.min(constraints.steps - 1, Math.floor(elapsedSeconds / activeStepTime));
        let expectedTotal = constraints.steps * activeStepTime;
        if (elapsedSeconds >= expectedTotal) {
          const computedStepTime = Math.ceil(elapsedSeconds / Math.max(0.5, step));
          activeStepTime = Math.max(activeStepTime + 15, computedStepTime + 15);
          expectedTotal = constraints.steps * activeStepTime;
          step = Math.min(constraints.steps - 1, Math.floor(elapsedSeconds / activeStepTime));
        }
        const remaining = Math.max(1, expectedTotal - elapsedSeconds);
        setEstimatedLeftTime(Math.round(remaining));

        let progressPercent = 0;
        if (cpuFallbackDetected) {
          const remainingProgress = 99 - fallbackProgress;
          const remainingTime = expectedTotal - fallbackTime;
          if (remainingTime > 0) {
            const ratio = Math.min(1.0, (elapsedSeconds - fallbackTime) / remainingTime);
            if (ratio < 0.85) {
              progressPercent = Math.round(fallbackProgress + ratio * remainingProgress);
            } else {
              const x = (elapsedSeconds - (fallbackTime + remainingTime * 0.85)) / (activeStepTime * 2);
              const decay = 1 - Math.exp(-x);
              progressPercent = Math.min(99, Math.round(fallbackProgress + 0.85 * remainingProgress + (0.14 * remainingProgress) * decay));
            }
          } else {
            progressPercent = 99;
          }
        } else {
          if (elapsedSeconds < expectedTotal * 0.85) {
            progressPercent = Math.round((elapsedSeconds / expectedTotal) * 100);
          } else {
            const x = (elapsedSeconds - expectedTotal * 0.85) / (activeStepTime * 2);
            const decay = 1 - Math.exp(-x);
            progressPercent = Math.min(99, Math.round(85 + 14 * decay));
          }
        }
        if (!hasRealGenerationStepRef.current) {
          setGenerationProgress((p) => Math.max(p, progressPercent));
        }
      }
    }, 1000);

    try {
      abortControllerRef.current = new AbortController();
      const result = await generateImage(
        prompt,
        negativePrompt,
        constraints,
        activeModel,
        baseImage,
        (prog) => setGenerationProgress((prev) => Math.max(prev, prog)),
        abortControllerRef.current.signal
      );

      if (timerRef.current) clearInterval(timerRef.current);
      setGenerationProgress(100);
      setCurrentStep(constraints.steps);
      setEstimatedLeftTime(0);
      setGenerationSpeed("");

      const metadata = {
        prompt: prompt,
        negativePrompt: negativePrompt,
        seed: result.seed,
        steps: constraints.steps,
        cfgScale: constraints.cfgScale,
        width: constraints.width,
        height: constraints.height,
        sampler: constraints.sampler,
        model: activeModel,
        mode: baseImage ? "img2img" : "txt2img",
        denoisingStrength: baseImage ? constraints.denoisingStrength : null,
        duration_sec: result.duration_sec,
        timestamp: new Date().toLocaleTimeString(),
      };
      let savedOutput = null;
      let savedUrl = null;
      try {
        savedOutput = await saveGeneratedOutput(result.image, metadata);
        savedUrl = savedOutput.url;
        if (!savedUrl) {
          throw new Error("The local server saved the image but did not return a file URL.");
        }
      } catch (saveErr) {
        console.error("Generated image could not be saved:", saveErr);
        throw new Error(`Image generated but could not be saved to USB: ${saveErr.message || saveErr}`);
      }

      setOutputImage(savedUrl);
      setOutputSeed(result.seed);
      setGenDuration(result.duration_sec);

      const historyItem = {
        ...metadata,
        ...(savedOutput || {}),
        url: savedUrl,
      };

      setGeneratedImages((prev) => [historyItem, ...prev]);
    } catch (e) {
      if (e.name === "AbortError") {
        console.log("Generation request was aborted by the user");
      } else {
        console.error("Generation failed:", e);
        setErrorMsg(e.message || "Generation failed. Please try again.");
      }
      if (timerRef.current) clearInterval(timerRef.current);
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  // Stop/Cancel Generation Handler
  const handleCancelGeneration = async () => {
    if (await showConfirm({
      title: "Stop Generation?",
      message: "The current image generation will be cancelled and the local model server may restart.",
      confirmLabel: "Stop",
      danger: true,
    })) {
      if (timerRef.current) clearInterval(timerRef.current);
      
      // Set cancelling state first to keep the progress overlay active in cancelling mode
      setIsCancelling(true);
      
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      
      try {
        console.log("Cancelling: Stopping server to kill generation threads...");
        await stopServer();
        setCurrentStep(0);
        setGenerationSpeed("");
        setIsDecoding(false);
        hasRealGenerationStepRef.current = false;

        if (activeModel) {
          console.log("Cancelling: Restarting server for future generations...");
          await startServer(activeModel, constraints);
          const ready = await waitForServerReady();
          if (!ready) {
            console.warn("Server failed to restart properly.");
          }
        }
      } catch (err) {
        console.error("Failed to restart server on cancellation:", err);
      } finally {
        setIsCancelling(false);
        setIsGenerating(false);
        setGenerationProgress(0);
        setEstimatedLeftTime(0);
      }
    }
  };

  // Copy generated image to clipboard
  const handleCopyImage = async () => {
    if (!outputImage) return;
    try {
      if (outputImage.startsWith("data:image")) {
        // base64 conversion for clipboard
        const response = await fetch(outputImage);
        const blob = await response.blob();
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob })
        ]);
      } else {
        // Remote Unsplash images fallback (draw on canvas then copy)
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = outputImage;
        img.onload = async () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(async (blob) => {
            await navigator.clipboard.write([
              new ClipboardItem({ [blob.type]: blob })
            ]);
          }, "image/png");
        };
      }
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error("Failed to copy image:", err);
    }
  };

  // Download generated image
  const handleDownload = () => {
    if (!outputImage) return;
    const link = document.createElement("a");
    link.href = outputImage;
    link.download = `diffusion-${outputSeed || Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadImageUrl = (url, filename = `diffusion-${Date.now()}.png`) => {
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Reuse prompt settings from history
  const loadHistoryItem = useCallback((item) => {
    setPrompt(item.prompt);
    setNegativePrompt(item.negativePrompt);
    setConstraints((prev) => ({
      ...prev,
      steps: item.steps,
      cfgScale: item.cfgScale,
      width: item.width,
      height: item.height,
      sampler: item.sampler,
      seed: item.seed,
    }));
    setOutputImage(item.url);
    setOutputSeed(item.seed);
    setGenDuration(item.duration_sec ?? item.durationSec ?? null);
  }, [setPrompt, setNegativePrompt, setConstraints]);

  const toggleGallerySelection = useCallback((idx, event) => {
    const multi = event.ctrlKey || event.metaKey || event.shiftKey;
    setSelectedGalleryIndexes((prev) => {
      if (!multi) return [idx];
      return prev.includes(idx) ? prev.filter((item) => item !== idx) : [...prev, idx];
    });
    if (generatedImages[idx]) {
      loadHistoryItem(generatedImages[idx]);
    }
  }, [generatedImages, loadHistoryItem]);

  const selectedGalleryItems = selectedGalleryIndexes
    .map((idx) => generatedImages[idx])
    .filter(Boolean);

  const clearGallerySelection = () => {
    setSelectedGalleryIndexes([]);
  };

  const useSelectedGalleryItem = () => {
    if (selectedGalleryItems[0]) {
      loadHistoryItem(selectedGalleryItems[0]);
    }
  };

  const downloadSelectedGalleryItems = () => {
    selectedGalleryItems.forEach((item, index) => {
      const seed = item.seed ?? Date.now();
      downloadImageUrl(item.url, `diffusion-${seed}-${index + 1}.png`);
    });
  };

  const deleteSelectedGalleryItems = async () => {
    if (selectedGalleryItems.length === 0) return;
    const count = selectedGalleryItems.length;
    const confirmed = await showConfirm({
      title: "Delete Selected Outputs?",
      message: `Delete ${count} selected output${count === 1 ? "" : "s"} from USB? This removes the image and metadata files.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;

    try {
      await deleteGeneratedOutputs(selectedGalleryItems);
      const selectedSet = new Set(selectedGalleryIndexes);
      setGeneratedImages((prev) => prev.filter((_, idx) => !selectedSet.has(idx)));
      setSelectedGalleryIndexes([]);

      if (selectedGalleryItems.some((item) => item.url === outputImage)) {
        setOutputImage(null);
        setOutputSeed(null);
        setGenDuration(null);
      }
    } catch (err) {
      console.error("Failed to delete selected outputs:", err);
      showAlert({
        title: "Delete Failed",
        message: err.message || String(err),
        danger: true,
      });
    }
  };

  return (
    <div className="workspace-area">
      <div className="workspace-title-section">
        <h2 className="workspace-title">Generator Dashboard</h2>
        <p className="workspace-subtitle">
          Create high-fidelity images completely locally on your external drive.
        </p>
      </div>

      <div className="generator-layout">
        {/* Left Side: Parameters & Input */}
        <div>
          <div className="m3-card">
            <h3 className="m3-card-title">
              <Sparkles size={18} style={{ color: "var(--md-sys-color-primary)" }} />
              Generation Workspace
            </h3>

            <div className="m3-field-group">
              {/* Prompt Textarea */}
              <div className="m3-text-field">
                <label className="m3-text-field-label">Positive Prompt</label>
                <textarea
                  className="m3-textarea"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Enter a descriptive prompt (e.g. 'A futuristic city in cyberpunk aesthetic, high details, cinematic lighting')..."
                  disabled={isGenerating}
                />
              </div>

              {/* Negative Prompt Text Input */}
              <div className="m3-text-field">
                <label className="m3-text-field-label">Negative Prompt (Optional)</label>
                <input
                  type="text"
                  className="m3-input"
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="Items to avoid (e.g. 'blurry, low quality, deformed hands, texts')..."
                  disabled={isGenerating}
                />
              </div>

              <div className="m3-text-field">
                <label className="m3-text-field-label">Base Image (Optional)</label>
                {baseImage ? (
                  <div style={{ display: "flex", gap: "12px", alignItems: "center", padding: "12px", background: "var(--md-sys-color-surface-variant)", borderRadius: "var(--md-shape-corner-medium)", border: "1px solid var(--md-sys-color-outline-variant)" }}>
                    <img src={baseImage} alt="Base" style={{ width: "64px", height: "64px", objectFit: "cover", borderRadius: "8px", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Base image ready</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)" }}>
                        The AI will redraw this image guided by your prompt.
                      </div>
                    </div>
                    <button type="button" className="m3-btn m3-btn-error" style={{ height: "34px", flexShrink: 0 }} onClick={handleClearBaseImage} disabled={isGenerating}>
                      <Trash2 size={14} />
                      <span>Remove</span>
                    </button>
                  </div>
                ) : (
                  <label className="import-box" style={{ margin: 0, padding: "16px", cursor: isGenerating ? "not-allowed" : "pointer" }}>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      style={{ display: "none" }}
                      onChange={handleBaseImageSelect}
                      disabled={isGenerating}
                    />
                    <ImagePlus className="import-icon" />
                    <span style={{ fontWeight: 600 }}>Upload a base image</span>
                    <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", textAlign: "center" }}>
                      Optional. Generate a new image based on one of your own.
                    </span>
                  </label>
                )}

                {baseImage && (
                  <div style={{ marginTop: "12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "4px" }}>
                      <span>Transformation strength</span>
                      <span>{constraints.denoisingStrength.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.05"
                      value={constraints.denoisingStrength}
                      onChange={(e) => setConstraints((prev) => ({ ...prev, denoisingStrength: parseFloat(e.target.value) }))}
                      disabled={isGenerating}
                      style={{ width: "100%" }}
                    />
                    <div style={{ fontSize: "0.72rem", color: "var(--md-sys-color-outline)", marginTop: "2px" }}>
                      Lower = closer to your image; higher = more creative freedom. 0.7 is a good start.
                    </div>
                  </div>
                )}
              </div>

              {/* Configuration Status Chips (Material 3 style) */}
              <div className="m3-text-field">
                <label className="m3-text-field-label">Active Image Constraints</label>
                <div className="chips-container">
                  <div className="status-chip" onClick={() => setActiveTab("constraints")}>
                    <Sliders size={14} />
                    <span>Resolution: {constraints.width}x{constraints.height}</span>
                  </div>
                  <div className="status-chip" onClick={() => setActiveTab("constraints")}>
                    <RefreshCw size={14} />
                    <span>Steps: {constraints.steps}</span>
                  </div>
                  <div className="status-chip" onClick={() => setActiveTab("constraints")}>
                    <Sparkles size={14} />
                    <span>Sampler: {constraints.sampler}</span>
                  </div>
                  <div className="status-chip" onClick={() => setActiveTab("constraints")}>
                    <span>Seed: {constraints.seed === -1 ? "Random" : constraints.seed}</span>
                  </div>
                </div>
              </div>

              {/* Generate Trigger Button */}
              <button
                className="m3-btn m3-btn-filled"
                style={{ height: "48px", marginTop: "8px" }}
                onClick={handleGenerate}
                disabled={isGenerating || !prompt.trim() || !activeModel}
              >
                <Sparkles size={18} />
                <span>{!activeModel ? "Select Model to Generate" : baseImage ? "Generate from Base Image" : "Generate Local Image"}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right Side: Image Output Preview */}
        <div className="m3-card output-panel">
          <div className="output-image-container">
            {isGenerating || isCancelling || isRestartingBackend ? (
              <div className="progress-overlay">
                {isRestartingBackend ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", padding: "20px" }}>
                    <div className="progress-spinner"></div>
                    <div className="progress-text" style={{ fontSize: "1.1rem", fontWeight: 700, textAlign: "center" }}>
                      Syncing Settings & Initializing...
                    </div>
                    {restartLoadProgress ? (
                      <div style={{ width: "min(360px, 90%)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "0.82rem", fontWeight: 700, marginBottom: "6px" }}>
                          <span>
                            {restartLoadProgress.phase}
                            {restartLoadProgress.speed ? ` (${restartLoadProgress.speed})` : ""}
                          </span>
                          <span>
                            {restartLoadProgress.total > 0
                              ? `Loaded ${restartLoadProgress.current} / ${restartLoadProgress.total} tensors`
                              : `${Math.round(restartLoadProgress.progress)}%`}
                          </span>
                        </div>
                        <div className="progress-bar-container" style={{ margin: 0 }}>
                          <div
                            className="progress-bar-fill"
                            style={{ width: `${Math.min(100, Math.max(0, restartLoadProgress.progress))}%`, transition: "width 0.25s ease" }}
                          ></div>
                        </div>
                        {(restartLoadProgress.backendMode || restartLoadProgress.device) && (
                          <div style={{ fontSize: "0.78rem", opacity: 0.8, textAlign: "center", marginTop: "8px" }}>
                            Loading on {restartLoadProgress.backendMode || "backend"}{restartLoadProgress.device ? ` • ${restartLoadProgress.device}` : ""}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p style={{ fontSize: "0.85rem", opacity: 0.8, textAlign: "center", maxWidth: "280px", margin: 0 }}>
                        Adjusting inference settings and restarting the local model server.
                      </p>
                    )}
                  </div>
                ) : isCancelling ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", padding: "20px" }}>
                    <div className="progress-spinner"></div>
                    <div className="progress-text" style={{ fontSize: "1.1rem", fontWeight: 700, textAlign: "center" }}>
                      Cancelling Generation...
                    </div>
                    <p style={{ fontSize: "0.85rem", opacity: 0.8, textAlign: "center", maxWidth: "280px", margin: 0 }}>
                      Stopping CPU/GPU execution threads and reloading model weights. Please wait a moment.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="progress-spinner"></div>
                    <div className="progress-text" style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                      {isDecoding ? "Decoding Latents..." : "Generating Locally..."}
                    </div>
                    
                    {isCpuFallback && (
                      <div style={{ fontSize: "0.8rem", color: "var(--md-sys-color-primary)", fontWeight: 600, background: "var(--md-sys-color-primary-container)", padding: "4px 12px", borderRadius: "12px", margin: "4px 0 8px 0", animation: "pulse 2s infinite" }}>
                        ⚠️ CPU Fallback Detected (Running Slower)
                      </div>
                    )}

                    {/* Real-time stats display */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", width: "80%", margin: "8px 0 0 0", fontSize: "0.85rem", opacity: 0.9 }}>
                      <div style={{ textAlign: "left" }}>
                        <strong>Step:</strong> {currentStep} / {constraints.steps} ({Math.max(0, constraints.steps - currentStep)} left)
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <strong>Elapsed:</strong> {elapsedTime}s{generationSpeed && ` (${generationSpeed === "decoding" ? "decoding" : generationSpeed})`}
                      </div>
                    </div>

                    <div className="progress-bar-container" style={{ margin: "4px 0 10px 0" }}>
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${generationProgress}%`, transition: "width 1s linear" }}
                      ></div>
                    </div>
                    
                    <div style={{ fontSize: "0.85rem", opacity: 0.8, display: "flex", gap: "8px", alignItems: "center" }}>
                      <span>Progress: {generationProgress}%</span>
                      <span>•</span>
                      <span>Est. remaining: {estimatedLeftTime}s</span>
                    </div>

                    <button 
                      className="m3-btn m3-btn-error" 
                      style={{ marginTop: "16px", height: "36px", padding: "0 24px" }}
                      onClick={handleCancelGeneration}
                    >
                      Stop Generating
                    </button>
                  </>
                )}
              </div>
            ) : outputImage ? (
              <img src={outputImage} className="output-image" alt="Generated Output" />
            ) : errorMsg ? (
              <div style={{ textAlign: "center", padding: "24px", color: "var(--md-sys-color-error)", display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
                <div style={{ background: "rgba(239, 68, 68, 0.1)", padding: "16px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: "bold" }}>Generation Failed</h3>
                <p style={{ margin: 0, fontSize: "0.95rem", opacity: 0.9, maxWidth: "320px", lineHeight: "1.4" }}>
                  {errorMsg}
                </p>
                <div style={{ marginTop: "8px", fontSize: "0.85rem", opacity: 0.8, color: "var(--md-sys-color-on-surface-variant)" }}>
                  Hint: Try lowering the resolution in the <strong>Image Constraints</strong> settings (e.g., to 512x512).
                </div>
              </div>
            ) : (
              <div style={{ textAlign: "center" }}>
                <Sparkles className="output-placeholder-icon" />
                <p className="output-placeholder-text">
                  Your generated image will appear here.<br />
                  Enter a prompt on the left and click Generate.
                </p>
              </div>
            )}
          </div>

          {outputImage && !isGenerating && (
            <>
              {/* Telemetry info for previous generation */}
              <div style={{ width: "100%", display: "flex", justifyContent: "space-between", marginTop: "12px", fontSize: "0.8rem", color: "var(--md-sys-color-outline)" }}>
                <span>Seed: {outputSeed}</span>
                {genDuration && <span>Inference Time: {genDuration.toFixed(1)}s</span>}
              </div>
              {/* Actions for generated image */}
              <div className="image-actions">
                <button className="m3-btn m3-btn-tonal" onClick={handleCopyImage}>
                  {copySuccess ? <Check size={16} /> : <Copy size={16} />}
                  <span>{copySuccess ? "Copied" : "Copy"}</span>
                </button>
                <button className="m3-btn m3-btn-outlined" onClick={handleDownload}>
                  <Download size={16} />
                  <span>Save to USB</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* History / Gallery Grid */}
      <div className="gallery-section">
        <div className="gallery-header">
          <h3 className="m3-card-title" style={{ marginBottom: 0 }}>Recent Outputs Gallery</h3>
          {selectedGalleryItems.length > 0 && (
            <div className="gallery-selection-actions">
              <span className="gallery-selection-count">{selectedGalleryItems.length} selected</span>
              <button className="m3-btn m3-btn-tonal" onClick={useSelectedGalleryItem}>
                <Check size={14} />
                <span>Use</span>
              </button>
              <button className="m3-btn m3-btn-outlined" onClick={downloadSelectedGalleryItems}>
                <Download size={14} />
                <span>Download</span>
              </button>
              <button className="m3-btn m3-btn-error" onClick={deleteSelectedGalleryItems}>
                <Trash2 size={14} />
                <span>Delete</span>
              </button>
              <button className="m3-btn m3-btn-outlined" onClick={clearGallerySelection}>
                Clear
              </button>
            </div>
          )}
        </div>
        {generatedImages.length === 0 ? (
          <div className="m3-card gallery-empty">
            No images generated in this session yet. Everything will be saved directly on your external drive.
          </div>
        ) : (
          <>
            <div className="gallery-hint">Click to select one image. Ctrl-click or Shift-click to select multiple.</div>
            <div className="gallery-grid">
              {generatedImages.map((img, idx) => (
                <GalleryItem
                  key={img.image || idx}
                  img={img}
                  idx={idx}
                  isSelected={selectedGalleryIndexes.includes(idx)}
                  onClick={toggleGallerySelection}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default memo(Generator);
