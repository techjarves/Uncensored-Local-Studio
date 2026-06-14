import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VideoGenerator from "./VideoGenerator";
import { getVideoJob, startVideoJob } from "../services/api";

vi.mock("../services/api", () => ({
  cancelVideoJob: vi.fn(),
  deleteVideoOutputs: vi.fn(),
  getVideoCapabilities: vi.fn().mockResolvedValue({
    supported: true,
    runtime: { installed: true },
    gpu: { name: "Test GPU", totalVramGb: 16 },
    baseModels: [{ filename: "base.safetensors", likelyCompatible: true }],
    activeJobId: null,
  }),
  getVideoJob: vi.fn(),
  listVideoModels: vi.fn().mockResolvedValue({ models: [] }),
  listVideoOutputs: vi.fn().mockResolvedValue([]),
  startVideoJob: vi.fn(),
}));

const model = {
  id: "animatediff-sd15",
  name: "AnimateDiff SD 1.5",
  installed: true,
  compatible: true,
  requiresBaseModel: true,
  modes: ["text-to-video"],
  resolutions: [{ width: 512, height: 512 }],
  frames: { default: 16 },
  fps: { default: 8 },
  steps: { default: 20 },
  guidance: { default: 7.5 },
};

const settings = {
  modelId: model.id,
  mode: "text-to-video",
  width: 512,
  height: 512,
  frames: 16,
  fps: 8,
  steps: 20,
  guidance: 7.5,
  seed: 42,
  baseModel: "base.safetensors",
};

describe("VideoGenerator job startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows progress immediately and suppresses duplicate clicks", async () => {
    let resolveStart;
    startVideoJob.mockReturnValue(new Promise(resolve => { resolveStart = resolve; }));
    render(
      <VideoGenerator
        settings={settings}
        setSettings={vi.fn()}
        models={[model]}
        setModels={vi.fn()}
        capabilities={{
          supported: true,
          runtime: { installed: true },
          gpu: { name: "Test GPU", totalVramGb: 16 },
          baseModels: [{ filename: "base.safetensors", likelyCompatible: true }],
        }}
        setCapabilities={vi.fn()}
        setActiveTab={vi.fn()}
        setServerRunning={vi.fn()}
        setActiveModel={vi.fn()}
        showAlert={vi.fn()}
        showConfirm={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "A football match" } });
    const generate = screen.getByRole("button", { name: "Generate Video" });
    fireEvent.click(generate);
    fireEvent.click(generate);

    expect(startVideoJob).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Starting Video Job" })).toBeDisabled();
    expect(screen.getAllByText("Submitting video job").length).toBeGreaterThan(0);

    await act(async () => {
      resolveStart({
        job: {
          id: "job-1",
          status: "queued",
          phase: "Preparing GPU",
          progress: 1,
          createdAt: new Date().toISOString(),
        },
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel Generation" })).toBeInTheDocument());
  });

  it("recovers the server's active job from a duplicate-request response", async () => {
    const activeJob = {
      id: "active-job",
      status: "running",
      phase: "Loading SD 1.5 checkpoint",
      progress: 12,
      total: 20,
      createdAt: new Date().toISOString(),
    };
    const conflict = Object.assign(new Error("A video generation job is already active."), {
      status: 409,
      data: { job: activeJob },
    });
    startVideoJob.mockRejectedValue(conflict);
    getVideoJob.mockResolvedValue({ job: activeJob });
    const showAlert = vi.fn();

    render(
      <VideoGenerator
        settings={settings}
        setSettings={vi.fn()}
        models={[model]}
        setModels={vi.fn()}
        capabilities={{
          supported: true,
          runtime: { installed: true },
          gpu: { name: "Test GPU", totalVramGb: 16 },
          baseModels: [{ filename: "base.safetensors", likelyCompatible: true }],
        }}
        setCapabilities={vi.fn()}
        setActiveTab={vi.fn()}
        setServerRunning={vi.fn()}
        setActiveModel={vi.fn()}
        showAlert={showAlert}
        showConfirm={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "A football match" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate Video" }));

    await waitFor(() => expect(screen.getAllByText("Loading SD 1.5 checkpoint")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Cancel Generation" })).toBeInTheDocument();
    expect(showAlert).not.toHaveBeenCalled();
  });
});
