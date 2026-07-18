const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("text-to-image sends seed and sampling settings to sdapi", async () => {
  const api = read("app/frontend/src/services/api.js");
  assert.match(api, /\/sdapi\/v1\/txt2img/);
  assert.doesNotMatch(api, /\/v1\/images\/generations/);

  const calls = [];
  const originalFetch = global.fetch;
  const originalWindow = global.window;
  global.window = { location: { protocol: "http:" } };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        images: ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII="],
      }),
    };
  };

  try {
    const moduleUrl = `${pathToFileURL(path.join(root, "app/frontend/src/services/api.js")).href}?regression-test`;
    const { generateImage } = await import(moduleUrl);
    const result = await generateImage("a rocket", "", {
      width: 640,
      height: 384,
      steps: 17,
      cfgScale: 6.5,
      seed: 123456,
      sampler: "euler_a",
    }, "model.safetensors", null);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/sdapi/v1/txt2img");
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual({
      width: body.width,
      height: body.height,
      steps: body.steps,
      cfg_scale: body.cfg_scale,
      seed: body.seed,
      sampler_name: body.sampler_name,
    }, {
      width: 640,
      height: 384,
      steps: 17,
      cfg_scale: 6.5,
      seed: 123456,
      sampler_name: "euler_a",
    });
    assert.equal(result.seed, 123456);
  } finally {
    global.fetch = originalFetch;
    global.window = originalWindow;
  }
});

test("slow image generation has no fixed proxy timeout and blocks destructive restarts", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /function proxyImageBackendRequest[\s\S]*?timeout:\s*0/);
  assert.match(server, /if \(generationState\.active\)[\s\S]*?Image generation is in progress/);
});

test("Windows OpenVINO setup only accepts Intel NPUs and remains optional", () => {
  const setup = read("scripts/setup/setup.ps1");
  const openvino = read("scripts/setup/setup-openvino-npu.ps1");
  assert.match(setup, /function Get-IntelOpenVinoNpu/);
  assert.match(setup, /Intel.*AI Boost\|NPU/);
  assert.match(setup, /Continuing with the available GPU\/CPU backends/);
  assert.match(openvino, /Intel.*AI Boost\|NPU/);
  assert.doesNotMatch(setup, /\$_.Name -match "NPU"/);
  assert.doesNotMatch(openvino, /\$_.Name -match "NPU"/);
});

test("macOS launch and setup detect Apple Silicon even under Rosetta", () => {
  for (const relativePath of [
    "mac.sh",
    "scripts/setup/setup.sh",
    "scripts/setup/setup-llama.sh",
    "scripts/setup/setup-whisper.sh",
    "scripts/setup/setup-coreml-npu.sh",
  ]) {
    assert.match(read(relativePath), /hw\.optional\.arm64/, relativePath);
  }
  assert.match(read("scripts/setup/setup.sh"), /INSTALLED_NODE_ARCH/);
});

test("Linux setup detects required libraries and rejects mixed ROCm Vulkan files", () => {
  const setup = read("scripts/setup/setup.sh");
  assert.match(setup, /libgomp\.so\.1/);
  assert.match(setup, /libvulkan\.so\.1/);
  assert.match(setup, /hipblas\|rocblas\|amdhip/);
  assert.match(setup, /rm -f "\$VULKAN_BACKEND_DIR"\/sd-vulkan/);
});

test("Windows launcher remains ASCII-safe for cmd.exe", () => {
  const launcher = fs.readFileSync(path.join(root, "windows.bat"));
  assert.equal([...launcher].some((byte) => byte > 0x7f), false);
});
