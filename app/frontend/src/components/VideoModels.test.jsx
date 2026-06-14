import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VideoModels from "./VideoModels";

vi.mock("../services/api", () => ({
  cancelVideoModelDownload: vi.fn(),
  deleteVideoModel: vi.fn(),
  downloadVideoModel: vi.fn(),
  getVideoCapabilities: vi.fn(() => new Promise(() => {})),
  installVideoRuntime: vi.fn(),
  listVideoModels: vi.fn(() => new Promise(() => {})),
}));

describe("VideoModels", () => {
  it("shows a neutral loading state instead of a false CUDA warning", () => {
    render(
      <VideoModels
        models={[]}
        setModels={vi.fn()}
        capabilities={null}
        setCapabilities={vi.fn()}
        showAlert={vi.fn()}
        showConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Checking Runtime" })).toBeDisabled();
    expect(screen.getAllByLabelText("Loading video model")).toHaveLength(3);
    expect(screen.queryByText("NVIDIA CUDA video generation is not available on this system.")).not.toBeInTheDocument();
  });
});
