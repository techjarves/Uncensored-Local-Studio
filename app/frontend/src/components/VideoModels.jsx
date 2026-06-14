import React, { useCallback, useEffect, useState } from "react";
import { Box, CheckCircle2, Download, HardDrive, LoaderCircle, Trash2, Wrench } from "lucide-react";
import {
  cancelVideoModelDownload,
  deleteVideoModel,
  downloadVideoModel,
  getVideoCapabilities,
  installVideoRuntime,
  listVideoModels,
} from "../services/api";

export default function VideoModels({ models, setModels, capabilities, setCapabilities, showAlert, showConfirm }) {
  const [download, setDownload] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!capabilities || models.length === 0);
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [caps, data] = await Promise.all([getVideoCapabilities(), listVideoModels()]);
      setCapabilities(caps);
      setModels(data.models || []);
      setDownload(data.download || null);
      setLoadError("");
    } catch (err) {
      setLoadError(err.message || "Could not load local video model information.");
      throw err;
    } finally {
      setLoading(false);
    }
  }, [setCapabilities, setModels]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (!capabilities?.runtime?.active && !download?.active) return undefined;
    const timer = setInterval(() => refresh().catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [capabilities?.runtime?.active, download?.active, refresh]);

  const installRuntime = async () => {
    setBusy(true);
    try {
      await installVideoRuntime();
      await refresh();
    } catch (err) {
      showAlert({ title: "Runtime Installation Failed", message: err.message, danger: true });
    } finally {
      setBusy(false);
    }
  };

  const startDownload = async (model) => {
    const size = (model.approxDownloadBytes / (1024 ** 3)).toFixed(1);
    const ok = await showConfirm({
      title: `Download ${model.name}?`,
      message: `This downloads about ${size} GB into app/video-models and may take a while. Generation is fully offline afterward.`,
      confirmLabel: "Download",
    });
    if (!ok) return;
    try {
      await downloadVideoModel(model.id);
      await refresh();
    } catch (err) {
      showAlert({ title: "Download Failed", message: err.message, danger: true });
    }
  };

  const removeModel = async (model) => {
    const ok = await showConfirm({
      title: `Delete ${model.name}?`,
      message: "The downloaded video model files will be removed. Generated videos are preserved.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteVideoModel(model.id);
      await refresh();
    } catch (err) {
      showAlert({ title: "Delete Failed", message: err.message, danger: true });
    }
  };

  return (
    <div className="workspace-scroll">
      <div className="workspace-heading">
        <div>
          <h2>Video Models</h2>
          <p>Install the isolated CUDA runtime once, then download only the profiles your hardware can run.</p>
        </div>
      </div>

      <section className="m3-card video-runtime-card">
        <div className="video-runtime-icon"><Wrench size={24} /></div>
        <div className="video-runtime-copy">
          <h3>Portable Video Runtime</h3>
          <p>Python 3.11, PyTorch CUDA 12.6, Diffusers, and local MP4 encoding under <code>app/tools/video-runtime</code>.</p>
          {capabilities?.runtime?.active && (
            <div className="model-progress-section">
              <div className="model-progress-label"><span>{capabilities.runtime.phase}</span><span>{Math.round(capabilities.runtime.progress || 0)}%</span></div>
              <div className="model-progress-bar"><div className="model-progress-fill" style={{ width: `${capabilities.runtime.progress || 0}%` }} /></div>
              {capabilities.runtime.phase === "Installing CUDA PyTorch" && (
                <p className="video-progress-note">PyTorch is approximately 2.5 GB. This stage stays at 50% until that package is downloaded and installed.</p>
              )}
            </div>
          )}
          {capabilities?.runtime?.error && <p className="video-error-text">{capabilities.runtime.error}</p>}
        </div>
        <button className={`m3-btn ${capabilities?.runtime?.installed ? "m3-btn-tonal" : "m3-btn-filled"}`} onClick={installRuntime} disabled={loading || busy || capabilities?.runtime?.active || !capabilities?.supported}>
          {loading || capabilities?.runtime?.active ? <LoaderCircle className="spin" size={17} /> : capabilities?.runtime?.installed ? <CheckCircle2 size={17} /> : <Download size={17} />}
          {loading ? "Checking Runtime" : capabilities?.runtime?.installed ? "Repair Runtime" : "Install Runtime"}
        </button>
      </section>

      {loadError && <div className="m3-card video-warning-card">{loadError}</div>}

      {!loading && capabilities && !capabilities.supported && (
        <div className="m3-card video-warning-card">{capabilities?.reason || "NVIDIA CUDA video generation is not available on this system."}</div>
      )}

      <div className="video-model-grid">
        {loading && models.length === 0 ? [0, 1, 2].map((index) => (
          <article className="m3-card video-model-card video-model-skeleton" key={index} aria-label="Loading video model">
            <div className="video-skeleton-line video-skeleton-title" />
            <div className="video-skeleton-line" />
            <div className="video-skeleton-line video-skeleton-short" />
            <div className="video-skeleton-button" />
          </article>
        )) : models.map((model) => {
          const activeDownload = download?.active && download.modelId === model.id;
          return (
            <article className="m3-card video-model-card" key={model.id}>
              <div className="video-model-heading">
                <div className="video-runtime-icon"><Box size={22} /></div>
                <div><h3>{model.name}</h3><span>{model.family} · {model.tier}</span></div>
                {model.installed && <CheckCircle2 className="video-installed-icon" size={21} />}
              </div>
              <p>{model.notes}</p>
              <div className="video-model-tags">
                {model.modes.map((mode) => <span key={mode}>{mode === "text-to-video" ? "Text to video" : "Image to video"}</span>)}
                <span>{model.minVramGb} GB VRAM</span>
                <span>{(model.approxDownloadBytes / (1024 ** 3)).toFixed(1)} GB</span>
              </div>
              {model.blockers?.length > 0 && <div className="video-blockers">{model.blockers.join(" ")}</div>}
              {activeDownload && (
                <div className="model-progress-section">
                  <div className="model-progress-label"><span>{download.phase}</span><span>{Math.max(0, download.progress)}%</span></div>
                  <div className="model-progress-bar"><div className="model-progress-fill" style={{ width: `${Math.max(2, download.progress)}%` }} /></div>
                  <button className="m3-btn m3-btn-outlined video-small-btn" onClick={() => cancelVideoModelDownload().then(refresh)}>Cancel</button>
                </div>
              )}
              {download?.error && download.modelId === model.id && <p className="video-error-text">{download.error}</p>}
              <div className="video-model-actions">
                {model.installed ? (
                  <>
                    <span><HardDrive size={15} /> {model.installedSize}</span>
                    <button className="m3-btn m3-btn-error" onClick={() => removeModel(model)}><Trash2 size={16} /> Delete</button>
                  </>
                ) : (
                  <button className="m3-btn m3-btn-filled" onClick={() => startDownload(model)} disabled={!capabilities?.runtime?.installed || !model.compatible || activeDownload || download?.active}>
                    <Download size={16} /> Download
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
