import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Film, ImagePlus, LoaderCircle, Play, Sparkles, Trash2, X } from "lucide-react";
import {
  cancelVideoJob,
  deleteVideoOutputs,
  getVideoCapabilities,
  getVideoJob,
  listVideoModels,
  listVideoOutputs,
  startVideoJob,
} from "../services/api";

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

export function isVideoGenerationReady({
  capabilities,
  model,
  settings,
  prompt,
  sourceImage,
}) {
  if (!capabilities?.supported || !capabilities?.runtime?.installed) return false;
  if (!model?.installed || !model.compatible) return false;
  if (model.requiresBaseModel && !settings.baseModel) return false;
  if (settings.mode === "text-to-video" && !prompt.trim()) return false;
  if (settings.mode === "image-to-video" && !sourceImage) return false;
  return true;
}

export default function VideoGenerator({
  settings,
  setSettings,
  models,
  setModels,
  capabilities,
  setCapabilities,
  setActiveTab,
  setServerRunning,
  setActiveModel,
  showAlert,
  showConfirm,
}) {
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [sourceImage, setSourceImage] = useState(null);
  const [sourceName, setSourceName] = useState("");
  const [job, setJob] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [outputs, setOutputs] = useState([]);
  const [selected, setSelected] = useState([]);
  const pollRef = useRef(null);
  const submitLockRef = useRef(false);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === settings.modelId) || null,
    [models, settings.modelId],
  );

  const pollJob = useCallback((jobId) => {
    if (!jobId) return;
    if (pollRef.current) clearInterval(pollRef.current);
    const update = async () => {
      try {
        const data = await getVideoJob(jobId);
        setJob(data.job);
        if (["complete", "error", "cancelled"].includes(data.job.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (data.job.status === "complete") setOutputs(await listVideoOutputs());
        }
      } catch (_) {}
    };
    void update();
    pollRef.current = setInterval(update, 750);
  }, []);

  const refresh = useCallback(async () => {
    const [caps, modelData, savedOutputs] = await Promise.all([
      getVideoCapabilities(),
      listVideoModels(),
      listVideoOutputs(),
    ]);
    setCapabilities(caps);
    setModels(modelData.models || []);
    setOutputs(savedOutputs);
    if (caps.activeJobId) {
      try {
        const data = await getVideoJob(caps.activeJobId);
        setJob(data.job);
        if (["queued", "running"].includes(data.job.status)) pollJob(data.job.id);
      } catch (_) {}
    }
  }, [pollJob, setCapabilities, setModels]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  useEffect(() => {
    if (!submitting && !["queued", "running"].includes(job?.status)) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job?.status, submitting]);

  const applyModelDefaults = (model, mode = null) => {
    const nextMode = mode && model.modes.includes(mode) ? mode : model.modes[0];
    const resolution = model.resolutions[0];
    setSettings((prev) => ({
      ...prev,
      modelId: model.id,
      mode: nextMode,
      width: resolution.width,
      height: resolution.height,
      frames: model.frames.default,
      fps: model.fps.default,
      steps: model.steps.default,
      guidance: model.guidance.default,
      baseModel: model.requiresBaseModel ? (capabilities?.baseModels?.find((item) => item.likelyCompatible)?.filename || "") : "",
    }));
    if (nextMode !== "image-to-video") {
      setSourceImage(null);
      setSourceName("");
    }
  };

  const selectSource = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      showAlert({ title: "Unsupported Image", message: "Choose a PNG, JPEG, or WebP image.", danger: true });
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      showAlert({ title: "Image Too Large", message: "Source images must be 25 MB or smaller.", danger: true });
      return;
    }
    try {
      setSourceImage(await fileToDataUrl(file));
      setSourceName(file.name);
    } catch (err) {
      showAlert({ title: "Image Read Failed", message: err.message, danger: true });
    }
  };

  const generate = async () => {
    if (submitLockRef.current) return;
    if (!selectedModel) return;
    if (!capabilities?.runtime?.installed) {
      setActiveTab("video-models");
      return;
    }
    if (!selectedModel.installed) {
      setActiveTab("video-models");
      return;
    }
    if (settings.mode === "text-to-video" && !prompt.trim()) return;
    if (settings.mode === "image-to-video" && !sourceImage) {
      showAlert({ title: "Source Image Required", message: "Choose a source image before generating.", danger: true });
      return;
    }
    submitLockRef.current = true;
    setSubmitting(true);
    setClock(Date.now());
    setJob({
      id: null,
      modelId: selectedModel.id,
      mode: settings.mode,
      status: "queued",
      phase: "Submitting video job",
      progress: 1,
      current: 0,
      total: settings.steps,
      elapsedSec: 0,
      error: null,
      output: null,
      createdAt: new Date().toISOString(),
    });
    try {
      const result = await startVideoJob({
        ...settings,
        prompt,
        negativePrompt,
        inputImage: sourceImage,
      });
      setServerRunning(false);
      setActiveModel(null);
      setJob(result.job);
      pollJob(result.job.id);
    } catch (err) {
      const activeJob = err.data?.job;
      if (err.status === 409 && activeJob?.id) {
        setJob(activeJob);
        pollJob(activeJob.id);
      } else {
        setJob((prev) => ({
          ...prev,
          status: "error",
          phase: "Failed",
          error: err.message,
        }));
        showAlert({ title: "Video Generation Failed", message: err.message, danger: true });
      }
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!job?.id) return;
    try {
      await cancelVideoJob(job.id);
      setJob((prev) => ({ ...prev, phase: "Cancelling" }));
    } catch (err) {
      showAlert({ title: "Cancellation Failed", message: err.message, danger: true });
    }
  };

  const deleteSelected = async () => {
    const targets = selected.map((index) => outputs[index]).filter(Boolean);
    if (!targets.length) return;
    const ok = await showConfirm({
      title: `Delete ${targets.length} video${targets.length === 1 ? "" : "s"}?`,
      message: "The MP4 files and their metadata will be permanently removed.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await deleteVideoOutputs(targets);
    setSelected([]);
    setOutputs(await listVideoOutputs());
  };

  const isActive = submitting || (job && ["queued", "running"].includes(job.status));
  const elapsedSec = Math.max(
    Number(job?.elapsedSec || 0),
    job?.createdAt && isActive ? Math.floor((clock - new Date(job.createdAt).getTime()) / 1000) : 0,
  );
  const canGenerate = isVideoGenerationReady({
    capabilities,
    model: selectedModel,
    settings,
    prompt,
    sourceImage,
  });

  if (!models.length) {
    return (
      <div className="workspace-scroll">
        <div className="m3-card video-empty-card">
          <Film size={34} />
          <h3>Video profiles are loading</h3>
          <p>Open Video Models if the local CUDA runtime still needs to be installed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-scroll video-generator-page">
      <div className="workspace-heading">
        <div>
          <h2>Video Generator</h2>
          <p>Create local MP4 clips from text or a source image. Models and prompts never leave this machine.</p>
        </div>
        <div className={`video-status-pill ${capabilities?.supported ? "ready" : "blocked"}`}>
          {capabilities?.gpu ? `${capabilities.gpu.name} · ${capabilities.gpu.totalVramGb} GB` : capabilities?.reason || "Checking CUDA"}
        </div>
      </div>

      <div className="video-generator-grid">
        <section className="m3-card video-compose-panel">
          <div className="video-mode-tabs">
            {["text-to-video", "image-to-video"].map((mode) => {
              const available = models.some((model) => model.modes.includes(mode));
              return (
                <button
                  key={mode}
                  className={settings.mode === mode ? "active" : ""}
                  disabled={!available || isActive}
                  onClick={() => {
                    const candidate = models.find((model) => model.id === settings.modelId && model.modes.includes(mode)) ||
                      models.find((model) => model.modes.includes(mode));
                    if (candidate) applyModelDefaults(candidate, mode);
                  }}
                >
                  {mode === "text-to-video" ? "Text to Video" : "Image to Video"}
                </button>
              );
            })}
          </div>

          <label className="video-setting-field">
            <span>Video model</span>
            <select
              className="m3-input"
              value={settings.modelId}
              disabled={isActive}
              onChange={(e) => {
                const model = models.find((item) => item.id === e.target.value);
                if (model) applyModelDefaults(model, settings.mode);
              }}
            >
              {models.filter((model) => model.modes.includes(settings.mode)).map((model) => (
                <option key={model.id} value={model.id}>{model.name}{model.installed ? "" : " (not downloaded)"}</option>
              ))}
            </select>
          </label>

          {selectedModel?.requiresBaseModel && (
            <label className="video-setting-field">
              <span>SD 1.5 base model</span>
              <select className="m3-input" value={settings.baseModel} disabled={isActive} onChange={(e) => setSettings((prev) => ({ ...prev, baseModel: e.target.value }))}>
                <option value="">Select a checkpoint</option>
                {(capabilities?.baseModels || []).map((model) => (
                  <option key={model.filename} value={model.filename}>{model.filename}{model.likelyCompatible ? "" : " (compatibility uncertain)"}</option>
                ))}
              </select>
            </label>
          )}

          {settings.mode === "image-to-video" && (
            <div className="video-source-section">
              {sourceImage ? (
                <div className="video-source-preview">
                  <img src={sourceImage} alt="Video source" />
                  <div><strong>{sourceName}</strong><span>Source image</span></div>
                  <button className="icon-btn" onClick={() => { setSourceImage(null); setSourceName(""); }} disabled={isActive}><X size={17} /></button>
                </div>
              ) : (
                <label className="video-source-picker">
                  <ImagePlus size={28} />
                  <strong>Choose a source image</strong>
                  <span>PNG, JPEG, or WebP up to 25 MB</span>
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={selectSource} hidden />
                </label>
              )}
            </div>
          )}

          <label className="video-setting-field">
            <span>Prompt</span>
            <textarea className="m3-input video-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={isActive} placeholder="Describe the subject, action, camera movement, lighting, and scene chronologically..." maxLength={4000} />
          </label>
          <label className="video-setting-field">
            <span>Negative prompt <small>(optional)</small></span>
            <textarea className="m3-input video-negative-prompt" value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} disabled={isActive} placeholder="Artifacts, flicker, blur, distorted anatomy..." maxLength={4000} />
          </label>

          <div className="video-summary-row">
            <span>{settings.width}×{settings.height}</span>
            <span>{settings.frames} frames</span>
            <span>{settings.fps} FPS</span>
            <span>{(settings.frames / settings.fps).toFixed(1)} sec</span>
            <button className="video-settings-link" onClick={() => setActiveTab("video-settings")}>Edit settings</button>
          </div>

          {job && (
            <div className={`video-job-card ${job.status}`}>
              <div className="video-job-heading">
                <span>{isActive && <LoaderCircle className="spin" size={17} />}{job.phase}</span>
                <strong>{Math.round(job.progress || 0)}%</strong>
              </div>
              <div className="model-progress-bar"><div className="model-progress-fill" style={{ width: `${Math.max(isActive ? 2 : 0, job.progress || 0)}%` }} /></div>
              {job.current > 0 && <small>Step {job.current} of {job.total}</small>}
              {isActive && <small>Elapsed {elapsedSec}s · Keep this window open while the local GPU works.</small>}
              {job.error && <p className="video-error-text">{job.error}</p>}
            </div>
          )}

          <div className="video-generate-actions">
            {submitting ? (
              <button className="m3-btn m3-btn-tonal" disabled><LoaderCircle className="spin" size={17} /> Starting Video Job</button>
            ) : isActive ? (
              <button className="m3-btn m3-btn-error" onClick={cancel}><X size={17} /> Cancel Generation</button>
            ) : (
              <button className="m3-btn m3-btn-filled video-generate-btn" onClick={generate} disabled={!canGenerate}>
                <Sparkles size={18} /> Generate Video
              </button>
            )}
            {!capabilities?.runtime?.installed && <button className="m3-btn m3-btn-tonal" onClick={() => setActiveTab("video-models")}>Install Runtime</button>}
            {capabilities?.runtime?.installed && !selectedModel?.installed && <button className="m3-btn m3-btn-tonal" onClick={() => setActiveTab("video-models")}>Download Model</button>}
          </div>
        </section>

        <section className="m3-card video-preview-panel">
          {job?.output?.video ? (
            <video key={job.output.video} controls autoPlay loop src={`/api/video/output-file?filename=${encodeURIComponent(job.output.video)}`} />
          ) : isActive ? (
            <div className="video-preview-progress">
              <LoaderCircle className="spin video-preview-spinner" size={52} />
              <h3>{job?.phase || "Starting video generation"}</h3>
              <p>The model is running locally on {capabilities?.gpu?.name || "your NVIDIA GPU"}.</p>
              <div className="video-preview-progress-stats">
                <strong>{Math.round(job?.progress || 0)}%</strong>
                <span>{elapsedSec}s elapsed</span>
              </div>
              <div className="model-progress-bar"><div className="model-progress-fill" style={{ width: `${Math.max(2, job?.progress || 0)}%` }} /></div>
              {job?.current > 0 && <small>Inference step {job.current} of {job.total}</small>}
            </div>
          ) : job?.status === "error" ? (
            <div className="video-preview-empty video-preview-failed"><X size={42} /><h3>Video generation failed</h3><p>{job.error}</p></div>
          ) : outputs[0] ? (
            <video key={outputs[0].video} controls loop src={outputs[0].url} />
          ) : (
            <div className="video-preview-empty"><Play size={42} /><h3>Your generated video appears here</h3><p>Starter clips can still take several minutes depending on the GPU.</p></div>
          )}
          {job?.output && (
            <div className="video-output-meta">
              <span>Seed {job.output.seed}</span>
              <span>{job.output.generationTimeSec}s generation</span>
              <a className="m3-btn m3-btn-tonal" href={`/api/video/output-file?filename=${encodeURIComponent(job.output.video)}`} download><Download size={16} /> Download MP4</a>
            </div>
          )}
        </section>
      </div>

      <section className="video-gallery-section">
        <div className="gallery-header">
          <div><h3>Video Gallery</h3><p className="gallery-hint">Generated MP4 files remain in app/video-outputs.</p></div>
          {selected.length > 0 && (
            <div className="gallery-selection-actions">
              <span className="gallery-selection-count">{selected.length} selected</span>
              <button className="m3-btn m3-btn-error" onClick={deleteSelected}><Trash2 size={15} /> Delete</button>
            </div>
          )}
        </div>
        {outputs.length ? (
          <div className="video-gallery-grid">
            {outputs.map((output, index) => (
              <article
                className={`video-gallery-card ${selected.includes(index) ? "selected" : ""}`}
                key={output.video}
                onClick={(event) => {
                  if (event.target.closest("video") || event.target.closest("a")) return;
                  setSelected((prev) => prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index]);
                }}
              >
                <video src={output.url} preload="metadata" muted />
                <div className="video-gallery-copy">
                  <strong>{output.prompt || "Image animation"}</strong>
                  <span>{output.width}×{output.height} · {output.duration}s · Seed {output.seed}</span>
                </div>
                {selected.includes(index) && <div className="gallery-select-badge"><Check size={14} /></div>}
                <a href={output.url} download className="icon-btn video-gallery-download" title="Download MP4"><Download size={16} /></a>
              </article>
            ))}
          </div>
        ) : <div className="gallery-empty">No generated videos yet.</div>}
      </section>
    </div>
  );
}
