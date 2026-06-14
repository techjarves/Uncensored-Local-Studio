import { afterEach, describe, expect, it, vi } from "vitest";
import { getVideoCapabilities, startVideoJob } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("video API client", () => {
  it("reads capability data from the local management server", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ supported: true, gpu: { totalVramGb: 16 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getVideoCapabilities()).resolves.toMatchObject({ supported: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/video/capabilities");
  });

  it("surfaces single-job conflicts from the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ ok: false, error: "A video generation job is already active." }),
    }));
    await expect(startVideoJob({ modelId: "animatediff-sd15" })).rejects.toThrow("already active");
  });
});
