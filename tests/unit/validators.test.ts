import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock reference-cache before importing validators
vi.mock("../../src/lib/reference-cache.js", () => ({
  getIndustries: vi.fn().mockResolvedValue([
    { id: "1", name: "Technology", tag_id: "tag_tech" },
    { id: "2", name: "Healthcare", tag_id: "tag_health" },
    { id: "3", name: "Finance", tag_id: "tag_finance" },
  ]),
  getEmployeeRanges: vi.fn(),
}));

import { validateBatch } from "../../src/lib/validators.js";

describe("validateBatch", () => {
  const apiKey = "test-key";
  const orgId = "test-org";

  describe("search endpoint", () => {
    it("accepts valid search params", async () => {
      const results = await validateBatch("search", [
        {
          personTitles: ["CEO", "CTO"],
          organizationLocations: ["United States"],
          organizationNumEmployeesRanges: ["1,10", "51,100"],
          qOrganizationIndustryTagIds: ["tag_tech"],
          page: 1,
          perPage: 25,
        },
      ], apiKey, orgId);

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(results[0].errors).toHaveLength(0);
    });

    it("accepts empty/minimal search params", async () => {
      const results = await validateBatch("search", [{}], apiKey, orgId);
      expect(results[0].valid).toBe(true);
    });

    it("rejects invalid employee range", async () => {
      const results = await validateBatch("search", [
        { organizationNumEmployeesRanges: ["1-10", "bad-range"] },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors.length).toBeGreaterThanOrEqual(1);
      expect(results[0].errors[0].field).toContain("organizationNumEmployeesRanges");
    });

    it("rejects page > 500", async () => {
      const results = await validateBatch("search", [
        { page: 501 },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].field).toBe("page");
    });

    it("rejects perPage > 100", async () => {
      const results = await validateBatch("search", [
        { perPage: 200 },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].field).toBe("perPage");
    });

    it("rejects empty strings in arrays", async () => {
      const results = await validateBatch("search", [
        { personTitles: ["CEO", ""] },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].field).toContain("personTitles");
    });

    it("rejects invalid industry tag IDs", async () => {
      const results = await validateBatch("search", [
        { qOrganizationIndustryTagIds: ["tag_tech", "invalid_tag"] },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors).toHaveLength(1);
      expect(results[0].errors[0].message).toContain("invalid_tag");
    });

    it("accepts valid industry tag IDs", async () => {
      const results = await validateBatch("search", [
        { qOrganizationIndustryTagIds: ["tag_tech", "tag_health"] },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(true);
    });

    it("validates a batch of multiple items", async () => {
      const results = await validateBatch("search", [
        { personTitles: ["CEO"], page: 1 },
        { organizationNumEmployeesRanges: ["bad"] },
        { qOrganizationIndustryTagIds: ["tag_finance"] },
      ], apiKey, orgId);

      expect(results).toHaveLength(3);
      expect(results[0].valid).toBe(true);
      expect(results[0].index).toBe(0);
      expect(results[1].valid).toBe(false);
      expect(results[1].index).toBe(1);
      expect(results[2].valid).toBe(true);
      expect(results[2].index).toBe(2);
    });
  });

  describe("enrich endpoint", () => {
    it("accepts valid person ID", async () => {
      const results = await validateBatch("enrich", [
        { id: "apollo-person-123" },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(true);
    });

    it("rejects missing ID", async () => {
      const results = await validateBatch("enrich", [{}], apiKey, orgId);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].field).toBe("id");
    });

    it("rejects empty string ID", async () => {
      const results = await validateBatch("enrich", [
        { id: "" },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(false);
    });
  });

  describe("bulk-enrich endpoint", () => {
    it("accepts valid person IDs", async () => {
      const results = await validateBatch("bulk-enrich", [
        { personIds: ["id1", "id2", "id3"] },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(true);
    });

    it("rejects empty array", async () => {
      const results = await validateBatch("bulk-enrich", [
        { personIds: [] },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(false);
    });

    it("rejects more than 10 IDs", async () => {
      const ids = Array.from({ length: 11 }, (_, i) => `id${i}`);
      const results = await validateBatch("bulk-enrich", [
        { personIds: ids },
      ], apiKey, orgId);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].message).toContain("10");
    });

    it("rejects missing personIds", async () => {
      const results = await validateBatch("bulk-enrich", [{}], apiKey, orgId);

      expect(results[0].valid).toBe(false);
    });
  });
});
