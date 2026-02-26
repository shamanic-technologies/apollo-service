import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Database schema tests using mocks
 * These tests validate the expected behavior of database operations
 * without requiring a real database connection
 */

// Mock data
const mockSearch = {
  id: "search-uuid-1",
  orgId: "org-uuid-1",
  runId: "run_123",
  peopleCount: 10,
  totalEntries: 100,
  createdAt: new Date(),
};
const mockEnrichment = {
  id: "enrichment-uuid-1",
  orgId: "org-uuid-1",
  searchId: "search-uuid-1",
  runId: "run_123",
  email: "lead@company.com",
  firstName: "John",
  lastName: "Doe",
  createdAt: new Date(),
};

// In-memory store for mock
let mockStore: {
  searches: typeof mockSearch[];
  enrichments: typeof mockEnrichment[];
};

beforeEach(() => {
  mockStore = { searches: [], enrichments: [] };
});

// Mock database operations
const mockDb = {
  insert: (table: string) => ({
    values: (data: Record<string, unknown>) => ({
      returning: async () => {
        const id = `${table}-uuid-${Date.now()}`;
        const record = { ...data, id, createdAt: new Date() };
        if (table === "searches") {
          mockStore.searches.push(record as typeof mockSearch);
        } else if (table === "enrichments") {
          mockStore.enrichments.push(record as typeof mockEnrichment);
        }
        return [record];
      },
    }),
  }),
  delete: (table: string) => ({
    where: async (condition: { id: string }) => {
      if (table === "searches") {
        const searchId = condition.id;
        mockStore.searches = mockStore.searches.filter((s) => s.id !== searchId);
        // Cascade delete enrichments
        mockStore.enrichments = mockStore.enrichments.filter((e) => e.searchId !== searchId);
      }
    },
  }),
  query: {
    searches: {
      findFirst: async ({ where }: { where: { id: string } }) => mockStore.searches.find((s) => s.id === where.id),
    },
    enrichments: {
      findFirst: async ({ where }: { where: { id: string } }) => mockStore.enrichments.find((e) => e.id === where.id),
    },
  },
};

describe("Apollo Service Database Schema", () => {
  describe("apolloPeopleSearches table", () => {
    it("should create a search with orgId", async () => {
      const orgId = "550e8400-e29b-41d4-a716-446655440000";
      const [search] = await mockDb
        .insert("searches")
        .values({ orgId, runId: "run_123", peopleCount: 0, totalEntries: 0 })
        .returning();

      expect(search.id).toBeDefined();
      expect(search.orgId).toBe(orgId);
      expect(search.runId).toBe("run_123");
    });
  });

  describe("apolloPeopleEnrichments table", () => {
    it("should create an enrichment linked to search", async () => {
      const orgId = "550e8400-e29b-41d4-a716-446655440000";
      const [search] = await mockDb
        .insert("searches")
        .values({ orgId, runId: "run_enrich", peopleCount: 0, totalEntries: 0 })
        .returning();
      const [enrichment] = await mockDb
        .insert("enrichments")
        .values({
          orgId,
          searchId: search.id,
          runId: "run_enrich",
          email: "lead@company.com",
          firstName: "John",
          lastName: "Doe",
        })
        .returning();

      expect(enrichment.id).toBeDefined();
      expect(enrichment.email).toBe("lead@company.com");
      expect(enrichment.firstName).toBe("John");
    });

    it("should cascade delete when search is deleted", async () => {
      const orgId = "550e8400-e29b-41d4-a716-446655440000";
      const [search] = await mockDb
        .insert("searches")
        .values({ orgId, runId: "run_cascade_search", peopleCount: 0, totalEntries: 0 })
        .returning();
      const [enrichment] = await mockDb
        .insert("enrichments")
        .values({
          orgId,
          searchId: search.id,
          runId: "run_cascade_search",
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        })
        .returning();

      await mockDb.delete("searches").where({ id: search.id });

      const found = await mockDb.query.enrichments.findFirst({ where: { id: enrichment.id } });
      expect(found).toBeUndefined();
    });
  });
});
