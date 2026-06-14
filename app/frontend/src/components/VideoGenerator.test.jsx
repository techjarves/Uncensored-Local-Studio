import { describe, expect, it } from "vitest";
import { isVideoGenerationReady } from "./VideoGenerator";

const capabilities = {
  supported: true,
  runtime: { installed: true },
};

const model = {
  installed: true,
  compatible: true,
  requiresBaseModel: false,
};

describe("isVideoGenerationReady", () => {
  it("requires a source image for image-to-video", () => {
    const settings = { mode: "image-to-video", baseModel: "" };
    expect(isVideoGenerationReady({ capabilities, model, settings, prompt: "", sourceImage: null })).toBe(false);
    expect(isVideoGenerationReady({ capabilities, model, settings, prompt: "", sourceImage: "data:image/png;base64,AA==" })).toBe(true);
  });

  it("requires the runtime, downloaded model, and text prompt", () => {
    const settings = { mode: "text-to-video", baseModel: "" };
    expect(isVideoGenerationReady({ capabilities, model, settings, prompt: "A sunrise", sourceImage: null })).toBe(true);
    expect(isVideoGenerationReady({
      capabilities: { ...capabilities, runtime: { installed: false } },
      model,
      settings,
      prompt: "A sunrise",
      sourceImage: null,
    })).toBe(false);
    expect(isVideoGenerationReady({ capabilities, model: { ...model, installed: false }, settings, prompt: "A sunrise", sourceImage: null })).toBe(false);
    expect(isVideoGenerationReady({ capabilities, model, settings, prompt: " ", sourceImage: null })).toBe(false);
  });

  it("requires a local SD 1.5 checkpoint when the profile reuses one", () => {
    const animatediff = { ...model, requiresBaseModel: true };
    const settings = { mode: "text-to-video", baseModel: "" };
    expect(isVideoGenerationReady({ capabilities, model: animatediff, settings, prompt: "Clouds", sourceImage: null })).toBe(false);
    expect(isVideoGenerationReady({
      capabilities,
      model: animatediff,
      settings: { ...settings, baseModel: "local.safetensors" },
      prompt: "Clouds",
      sourceImage: null,
    })).toBe(true);
  });
});
