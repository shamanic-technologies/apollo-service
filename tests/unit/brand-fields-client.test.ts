import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractBrandFields } from "../../src/lib/brand-fields-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const identity = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
  brandId: "brand-1,brand-2",
  campaignId: "campaign-1",
};

const fields = [
  { key: "industry", description: "The brand's primary industry vertical" },
  { key: "target_geography", description: "Priority geographic markets" },
];

describe("brand-fields-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls brand-service extract-fields with correct payload and headers (pathless endpoint)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        results: [
          { key: "industry", value: "SaaS", cached: true },
          { key: "target_geography", value: "US", cached: false },
        ],
      }),
    });

    const result = await extractBrandFields(fields, identity);

    expect(result).toEqual([
      { key: "industry", value: "SaaS", cached: true },
      { key: "target_geography", value: "US", cached: false },
    ]);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/brands/extract-fields"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-org-id": "org-1",
          "x-brand-id": "brand-1,brand-2",
          "x-campaign-id": "campaign-1",
        }),
        body: JSON.stringify({ fields }),
      })
    );

    // Should NOT have brandId in the URL path
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain("/brands/brand-1/");
  });

  it("returns empty array on fetch failure", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const result = await extractBrandFields(fields, identity);
    expect(result).toEqual([]);
  });

  it("propagates all identity headers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await extractBrandFields(fields, {
      ...identity,
      featureSlug: "lead-gen",
      workflowSlug: "fetch-lead",
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-feature-slug"]).toBe("lead-gen");
    expect(headers["x-workflow-slug"]).toBe("fetch-lead");
  });
});
