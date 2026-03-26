import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getFeatureInputs, clearFeatureInputsCache } from "../../src/lib/campaign-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const identity = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
  brandId: "brand-1",
  campaignId: "campaign-1",
};

describe("campaign-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFeatureInputsCache();
  });

  it("fetches featureInputs from campaign-service", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        campaign: {
          id: "campaign-1",
          featureInputs: { angle: "sustainability", region: "EU" },
        },
      }),
    });

    const result = await getFeatureInputs("campaign-1", identity);

    expect(result).toEqual({ angle: "sustainability", region: "EU" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/campaigns/campaign-1"),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-org-id": "org-1" }),
      })
    );
  });

  it("caches featureInputs by campaignId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        campaign: { featureInputs: { angle: "tech" } },
      }),
    });

    const first = await getFeatureInputs("campaign-1", identity);
    const second = await getFeatureInputs("campaign-1", identity);

    expect(first).toEqual({ angle: "tech" });
    expect(second).toEqual({ angle: "tech" });
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only one fetch
  });

  it("returns null and caches on fetch failure", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const result = await getFeatureInputs("campaign-missing", identity);

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call should not re-fetch
    const result2 = await getFeatureInputs("campaign-missing", identity);
    expect(result2).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null when campaign has no featureInputs", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        campaign: { featureInputs: null },
      }),
    });

    const result = await getFeatureInputs("campaign-no-inputs", identity);
    expect(result).toBeNull();
  });
});
