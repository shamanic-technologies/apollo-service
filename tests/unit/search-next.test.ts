import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for POST /search/next — server-managed pagination.
 *
 * Verifies: cursor creation, cursor reuse, param change reset,
 * exhaustion, page advance, cost tracking.
 */

// Mock runs-client
const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

// Mock auth
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-internal-123";
    next();
  },
}));

// Stateful DB mock — tracks cursors
let mockCursor: Record<string, unknown> | null = null;
const mockInsertReturning = vi.fn();
const mockUpdateSet = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    }),
    select: vi.fn().mockImplementation(() => {
      return {
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            // Cursor query — has .limit()
            return {
              limit: vi.fn().mockResolvedValue(mockCursor ? [mockCursor] : []),
            };
          }),
        })),
      };
    }),
    query: {
      apolloPeopleSearches: { findMany: vi.fn().mockResolvedValue([]) },
      apolloPeopleEnrichments: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleSearches: { id: { name: "id" } },
  apolloPeopleEnrichments: {
    id: { name: "id" },
    apolloPersonId: { name: "apollo_person_id" },
    campaignId: { name: "campaign_id" },
    orgId: { name: "org_id" },
  },
  apolloSearchCursors: {
    id: { name: "id" },
    orgId: { name: "org_id" },
    campaignId: { name: "campaign_id" },
  },
}));

vi.mock("../../src/lib/keys-client.js", () => ({
  getByokKey: vi.fn().mockResolvedValue("fake-apollo-key"),
}));

// Mock Apollo client
const mockSearchPeople = vi.fn();

vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
  enrichPerson: vi.fn().mockResolvedValue({ person: null }),
}));

function makePeople(ids: string[]) {
  return ids.map((id) => ({
    id,
    first_name: `First-${id}`,
    last_name: `Last-${id}`,
    name: `First-${id} Last-${id}`,
    email: `${id}@example.com`,
    email_status: "verified",
    title: "CEO",
    linkedin_url: null,
    organization: {
      id: `org-${id}`,
      name: `Company-${id}`,
      website_url: `https://${id}.com`,
      primary_domain: `${id}.com`,
      industry: "tech",
      estimated_num_employees: 50,
      annual_revenue: null,
    },
  }));
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const SEARCH_PARAMS = { personTitles: ["CEO"] };
const BASE_BODY = {
  campaignId: "campaign-1",
  brandId: "brand-1",
  appId: "app-1",
  runId: "run-parent-1",
};

describe("POST /search/next", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCursor = null;
    mockInsertReturning.mockResolvedValue([{ id: "record-1" }]);

    mockSearchPeople.mockResolvedValue({
      people: makePeople(["p1", "p2", "p3"]),
      total_entries: 75,
    });

    let callCount = 0;
    mockCreateRun.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ id: `run-${callCount}` });
    });

    app = createTestApp();
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  // ─── Cursor creation ────────────────────────────────────────────────────────

  it("creates cursor and returns first page when searchParams provided", async () => {
    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send({ ...BASE_BODY, searchParams: SEARCH_PARAMS })
      .expect(200);

    expect(res.body.people).toHaveLength(3);
    expect(res.body.done).toBe(false);
    expect(res.body.totalEntries).toBe(75);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    // Cursor insert should have been called
    expect(mockInsertReturning).toHaveBeenCalled();
  });

  // ─── Cursor reuse ──────────────────────────────────────────────────────────

  it("uses existing cursor when no searchParams provided", async () => {
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 3,
      totalEntries: 75,
      exhausted: false,
    };

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.people).toHaveLength(3);
    // Should call Apollo with page 3
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "fake-apollo-key",
      expect.objectContaining({ page: 3, per_page: 25 })
    );
  });

  // ─── No cursor, no params → 400 ───────────────────────────────────────────

  it("returns 400 when no cursor exists and no searchParams provided", async () => {
    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send(BASE_BODY)
      .expect(400);

    expect(res.body.error).toContain("No search cursor found");
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  // ─── Param change resets cursor ────────────────────────────────────────────

  it("resets cursor when searchParams differ from stored", async () => {
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: { personTitles: ["CTO"] }, // different from what we'll send
      currentPage: 5,
      totalEntries: 200,
      exhausted: false,
    };

    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send({ ...BASE_BODY, searchParams: SEARCH_PARAMS })
      .expect(200);

    // Should reset and call Apollo with page 1
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "fake-apollo-key",
      expect.objectContaining({ page: 1 })
    );
    // Should update cursor to reset
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: 1, exhausted: false })
    );
  });

  // ─── Same params reuses position ──────────────────────────────────────────

  it("reuses cursor position when searchParams match stored", async () => {
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS, // same as what we'll send
      currentPage: 4,
      totalEntries: 100,
      exhausted: false,
    };

    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send({ ...BASE_BODY, searchParams: SEARCH_PARAMS })
      .expect(200);

    // Should use existing page 4, not reset to 1
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "fake-apollo-key",
      expect.objectContaining({ page: 4 })
    );
  });

  // ─── Exhausted cursor ─────────────────────────────────────────────────────

  it("returns empty immediately when cursor is exhausted", async () => {
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 10,
      totalEntries: 200,
      exhausted: true,
    };

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.people).toHaveLength(0);
    expect(res.body.done).toBe(true);
    expect(res.body.totalEntries).toBe(200);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  // ─── Cursor advances after each call ────────────────────────────────────────

  it("advances cursor to next page after fetching", async () => {
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 2,
      totalEntries: 75,
      exhausted: false,
    };

    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send(BASE_BODY)
      .expect(200);

    // Should advance cursor from page 2 to page 3
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: 3 })
    );
  });

  // ─── Exhaustion when Apollo returns empty ─────────────────────────────────

  it("marks exhausted when Apollo returns 0 people", async () => {
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 4,
      totalEntries: 75,
      exhausted: false,
    };

    mockSearchPeople.mockResolvedValue({
      people: [],
      total_entries: 75,
    });

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.people).toHaveLength(0);
    expect(res.body.done).toBe(true);
    // Cursor should be updated with exhausted=true
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ exhausted: true })
    );
  });

  // ─── Returns all people (no dedup filtering) ──────────────────────────────

  it("returns all people from Apollo without filtering", async () => {
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 1,
      totalEntries: 75,
      exhausted: false,
    };

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send(BASE_BODY)
      .expect(200);

    // All 3 people returned — no dedup filtering
    expect(res.body.people).toHaveLength(3);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  // ─── Cost tracking ────────────────────────────────────────────────────────

  it("tracks costs when runId provided", async () => {
    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send({ ...BASE_BODY, searchParams: SEARCH_PARAMS, runId: "run-abc" })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: "people-search-next" })
    );
    expect(mockAddCosts).toHaveBeenCalledWith("run-1", [
      { costName: "apollo-search-credit", quantity: 1 },
    ]);
    expect(mockUpdateRun).toHaveBeenCalledWith("run-1", "completed");
  });

  it("returns 400 when no runId provided", async () => {
    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send({ campaignId: "campaign-1", brandId: "brand-1", appId: "app-1", searchParams: SEARCH_PARAMS })
      .expect(400);

    expect(res.body.error).toBe("Invalid request");
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  // ─── Single Apollo call per request ──────────────────────────────────────

  it("makes exactly one Apollo call per request", async () => {
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 1,
      totalEntries: 75,
      exhausted: false,
    };

    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send(BASE_BODY)
      .expect(200);

    // Exactly 1 Apollo call — no looping/retrying
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  // ─── workflowName propagation ──────────────────────────────────────────

  it("passes workflowName to createRun when provided", async () => {
    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .send({ ...BASE_BODY, searchParams: SEARCH_PARAMS, workflowName: "fetch-lead" })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowName: "fetch-lead" })
    );
  });
});
