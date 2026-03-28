import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveFeatureDynastySlugs,
  resolveWorkflowDynastySlugs,
  fetchAllFeatureDynasties,
  fetchAllWorkflowDynasties,
  buildSlugToDynastyMap,
} from "../../src/lib/dynasty-client.js";

describe("dynasty-client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "https://features.test";
    process.env.FEATURES_SERVICE_API_KEY = "feat-key";
    process.env.WORKFLOW_SERVICE_URL = "https://workflows.test";
    process.env.WORKFLOW_SERVICE_API_KEY = "wf-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("resolveFeatureDynastySlugs", () => {
    it("resolves a dynasty slug to versioned slugs", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ slugs: ["feat-a", "feat-a-v2", "feat-a-v3"] }), { status: 200 })
      );

      const result = await resolveFeatureDynastySlugs("feat-a");
      expect(result).toEqual(["feat-a", "feat-a-v2", "feat-a-v3"]);
      expect(fetch).toHaveBeenCalledWith(
        "https://features.test/features/dynasty/slugs?dynastySlug=feat-a",
        { headers: { "X-API-Key": "feat-key" } }
      );
    });

    it("returns empty array when service URL is not configured", async () => {
      delete process.env.FEATURES_SERVICE_URL;
      const result = await resolveFeatureDynastySlugs("feat-a");
      expect(result).toEqual([]);
    });

    it("returns empty array on non-OK response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("not found", { status: 404 })
      );
      const result = await resolveFeatureDynastySlugs("feat-a");
      expect(result).toEqual([]);
    });
  });

  describe("resolveWorkflowDynastySlugs", () => {
    it("resolves a dynasty slug to versioned slugs", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ slugs: ["wf-cold", "wf-cold-v2"] }), { status: 200 })
      );

      const result = await resolveWorkflowDynastySlugs("wf-cold");
      expect(result).toEqual(["wf-cold", "wf-cold-v2"]);
      expect(fetch).toHaveBeenCalledWith(
        "https://workflows.test/workflows/dynasty/slugs?dynastySlug=wf-cold",
        { headers: { "X-API-Key": "wf-key" } }
      );
    });

    it("returns empty array when service URL is not configured", async () => {
      delete process.env.WORKFLOW_SERVICE_URL;
      const result = await resolveWorkflowDynastySlugs("wf-cold");
      expect(result).toEqual([]);
    });
  });

  describe("fetchAllFeatureDynasties", () => {
    it("fetches all feature dynasties", async () => {
      const dynasties = [
        { dynastySlug: "feat-a", slugs: ["feat-a", "feat-a-v2"] },
        { dynastySlug: "feat-b", slugs: ["feat-b"] },
      ];
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ dynasties }), { status: 200 })
      );

      const result = await fetchAllFeatureDynasties();
      expect(result).toEqual(dynasties);
    });

    it("returns empty array on failure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("error", { status: 500 })
      );
      const result = await fetchAllFeatureDynasties();
      expect(result).toEqual([]);
    });
  });

  describe("fetchAllWorkflowDynasties", () => {
    it("fetches all workflow dynasties", async () => {
      const dynasties = [{ dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] }];
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ dynasties }), { status: 200 })
      );

      const result = await fetchAllWorkflowDynasties();
      expect(result).toEqual(dynasties);
    });
  });

  describe("buildSlugToDynastyMap", () => {
    it("builds a reverse map from versioned slugs to dynasty slugs", () => {
      const dynasties = [
        { dynastySlug: "feat-a", slugs: ["feat-a", "feat-a-v2", "feat-a-v3"] },
        { dynastySlug: "feat-b", slugs: ["feat-b", "feat-b-v2"] },
      ];

      const map = buildSlugToDynastyMap(dynasties);
      expect(map.get("feat-a")).toBe("feat-a");
      expect(map.get("feat-a-v2")).toBe("feat-a");
      expect(map.get("feat-a-v3")).toBe("feat-a");
      expect(map.get("feat-b")).toBe("feat-b");
      expect(map.get("feat-b-v2")).toBe("feat-b");
      expect(map.get("unknown")).toBeUndefined();
    });

    it("handles empty dynasties", () => {
      const map = buildSlugToDynastyMap([]);
      expect(map.size).toBe(0);
    });
  });
});
