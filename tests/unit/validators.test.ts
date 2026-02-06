import { describe, it, expect } from "vitest";
import { validateBatch } from "../../src/lib/validators.js";

describe("validateBatch", () => {
  describe("search endpoint", () => {
    it("accepts valid search params", () => {
      const results = validateBatch("search", [
        {
          personTitles: ["CEO", "CTO"],
          organizationLocations: ["United States"],
          organizationNumEmployeesRanges: ["1,10", "51,100"],
          qOrganizationIndustryTagIds: ["tag_tech"],
          page: 1,
          perPage: 25,
        },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(results[0].errors).toHaveLength(0);
    });

    it("accepts empty/minimal search params", () => {
      const results = validateBatch("search", [{}]);
      expect(results[0].valid).toBe(true);
    });

    it("rejects invalid employee range", () => {
      const results = validateBatch("search", [
        { organizationNumEmployeesRanges: ["1-10", "bad-range"] },
      ]);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors.length).toBeGreaterThanOrEqual(1);
      expect(results[0].errors[0].field).toContain("organizationNumEmployeesRanges");
    });

    it("rejects page > 500", () => {
      const results = validateBatch("search", [
        { page: 501 },
      ]);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].field).toBe("page");
    });

    it("rejects perPage > 100", () => {
      const results = validateBatch("search", [
        { perPage: 200 },
      ]);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].field).toBe("perPage");
    });

    it("rejects empty strings in arrays", () => {
      const results = validateBatch("search", [
        { personTitles: ["CEO", ""] },
      ]);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].field).toContain("personTitles");
    });

    it("accepts any industry tag IDs (validated by Apollo API)", () => {
      const results = validateBatch("search", [
        { qOrganizationIndustryTagIds: ["tag_tech", "any_tag"] },
      ]);

      expect(results[0].valid).toBe(true);
    });

    it("validates a batch of multiple items", () => {
      const results = validateBatch("search", [
        { personTitles: ["CEO"], page: 1 },
        { organizationNumEmployeesRanges: ["bad"] },
        { qOrganizationIndustryTagIds: ["tag_finance"] },
      ]);

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
    it("accepts valid person ID", () => {
      const results = validateBatch("enrich", [
        { id: "apollo-person-123" },
      ]);

      expect(results[0].valid).toBe(true);
    });

    it("rejects missing ID", () => {
      const results = validateBatch("enrich", [{}]);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].field).toBe("id");
    });

    it("rejects empty string ID", () => {
      const results = validateBatch("enrich", [
        { id: "" },
      ]);

      expect(results[0].valid).toBe(false);
    });
  });

  describe("bulk-enrich endpoint", () => {
    it("accepts valid person IDs", () => {
      const results = validateBatch("bulk-enrich", [
        { personIds: ["id1", "id2", "id3"] },
      ]);

      expect(results[0].valid).toBe(true);
    });

    it("rejects empty array", () => {
      const results = validateBatch("bulk-enrich", [
        { personIds: [] },
      ]);

      expect(results[0].valid).toBe(false);
    });

    it("rejects more than 10 IDs", () => {
      const ids = Array.from({ length: 11 }, (_, i) => `id${i}`);
      const results = validateBatch("bulk-enrich", [
        { personIds: ids },
      ]);

      expect(results[0].valid).toBe(false);
      expect(results[0].errors[0].message).toContain("10");
    });

    it("rejects missing personIds", () => {
      const results = validateBatch("bulk-enrich", [{}]);

      expect(results[0].valid).toBe(false);
    });
  });
});
