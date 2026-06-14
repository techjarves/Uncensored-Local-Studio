import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VideoSettings from "./VideoSettings";

const model = {
  id: "animatediff-sd15",
  tier: "Starter",
  minVramGb: 8,
  minRamGb: 16,
  approxDownloadBytes: 550000000,
  notes: "Local starter model",
  resolutions: [{ width: 512, height: 512 }, { width: 512, height: 768 }],
  frames: { min: 8, max: 32, step: 8 },
  fps: { min: 4, max: 12 },
  steps: { min: 4, max: 40 },
  guidance: { min: 1, max: 12 },
};

const settings = {
  modelId: model.id,
  width: 512,
  height: 512,
  frames: 16,
  fps: 8,
  steps: 20,
  guidance: 7.5,
  seed: -1,
};

describe("VideoSettings", () => {
  it("renders model constraints and derived clip duration", () => {
    render(<VideoSettings settings={settings} setSettings={vi.fn()} models={[model]} />);
    expect(screen.getByText("Starter profile")).toBeInTheDocument();
    expect(screen.getByText("2.0 seconds")).toBeInTheDocument();
    expect(screen.getByText("8 GB")).toBeInTheDocument();
  });

  it("updates both dimensions when the resolution changes", () => {
    const setSettings = vi.fn();
    render(<VideoSettings settings={settings} setSettings={setSettings} models={[model]} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "512x768" } });
    const updater = setSettings.mock.calls.at(-1)[0];
    expect(updater(settings)).toMatchObject({ width: 512, height: 768 });
  });
});
