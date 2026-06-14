import React, { useMemo } from "react";
import { Gauge, Film, SlidersHorizontal } from "lucide-react";

function RangeField({ label, value, min, max, step = 1, onChange, suffix = "" }) {
  return (
    <label className="video-setting-field">
      <span>{label}</span>
      <div className="video-range-row">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <strong>{value}{suffix}</strong>
      </div>
    </label>
  );
}

export default function VideoSettings({ settings, setSettings, models }) {
  const selectedModel = useMemo(
    () => models.find((model) => model.id === settings.modelId) || models[0],
    [models, settings.modelId],
  );

  const update = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));
  if (!selectedModel) {
    return <div className="workspace-scroll"><div className="m3-card video-empty-card">Open Video Models to discover available profiles.</div></div>;
  }

  return (
    <div className="workspace-scroll video-settings-page">
      <div className="workspace-heading">
        <div>
          <h2>Video Settings</h2>
          <p>Model-safe generation controls. The server validates every value again before inference.</p>
        </div>
        <span className="video-tier-chip">{selectedModel.tier} profile</span>
      </div>

      <div className="video-settings-grid">
        <section className="m3-card video-panel">
          <div className="video-panel-title"><Film size={19} /><h3>Format</h3></div>
          <label className="video-setting-field">
            <span>Resolution</span>
            <select
              className="m3-input"
              value={`${settings.width}x${settings.height}`}
              onChange={(e) => {
                const [width, height] = e.target.value.split("x").map(Number);
                setSettings((prev) => ({ ...prev, width, height }));
              }}
            >
              {selectedModel.resolutions.map((item) => (
                <option key={`${item.width}x${item.height}`} value={`${item.width}x${item.height}`}>
                  {item.width} × {item.height}
                </option>
              ))}
            </select>
          </label>
          <RangeField label="Frames" value={settings.frames} min={selectedModel.frames.min} max={selectedModel.frames.max} step={selectedModel.frames.step} onChange={(value) => update("frames", value)} />
          <RangeField label="Frame rate" value={settings.fps} min={selectedModel.fps.min} max={selectedModel.fps.max} onChange={(value) => update("fps", value)} suffix=" FPS" />
          <div className="video-estimate">
            <span>Clip duration</span>
            <strong>{(settings.frames / settings.fps).toFixed(1)} seconds</strong>
          </div>
        </section>

        <section className="m3-card video-panel">
          <div className="video-panel-title"><Gauge size={19} /><h3>Inference</h3></div>
          <RangeField label="Steps" value={settings.steps} min={selectedModel.steps.min} max={selectedModel.steps.max} onChange={(value) => update("steps", value)} />
          <RangeField label="Guidance" value={settings.guidance} min={selectedModel.guidance.min} max={selectedModel.guidance.max} step={0.5} onChange={(value) => update("guidance", value)} />
          <label className="video-setting-field">
            <span>Seed</span>
            <input className="m3-input" type="number" min="-1" max="2147483647" value={settings.seed} onChange={(e) => update("seed", Number(e.target.value))} />
            <small>Use -1 for a random seed.</small>
          </label>
        </section>

        <section className="m3-card video-panel">
          <div className="video-panel-title"><SlidersHorizontal size={19} /><h3>Resource Profile</h3></div>
          <div className="video-resource-line"><span>Minimum VRAM</span><strong>{selectedModel.minVramGb} GB</strong></div>
          <div className="video-resource-line"><span>Minimum RAM</span><strong>{selectedModel.minRamGb} GB</strong></div>
          <div className="video-resource-line"><span>Model storage</span><strong>{(selectedModel.approxDownloadBytes / (1024 ** 3)).toFixed(1)} GB</strong></div>
          <p className="video-note">{selectedModel.notes}</p>
          <p className="video-note">Low-memory model offloading and model-specific decoding optimizations are enabled automatically. CPU-only generation is intentionally unsupported.</p>
        </section>
      </div>
    </div>
  );
}
