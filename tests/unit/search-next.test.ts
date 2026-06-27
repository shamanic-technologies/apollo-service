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
    req.userId = req.headers["x-user-id"] || "user-internal-456";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-brand-id"]) { req.brandId = req.headers["x-brand-id"] as string; req.brandIds = String(req.headers["x-brand-id"]).split(",").map((s: string) => s.trim()).filter(Boolean); }
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    if (req.headers["x-feature-slug"]) req.featureSlug = req.headers["x-feature-slug"];
    if (req.headers["x-workflow-slug"]) req.workflowSlug = req.headers["x-workflow-slug"];
    next();
  },
}));

// Stateful DB mock — tracks cursors
let mockCursor: Record<string, unknown> | null = null;
const mockInsertReturning = vi.fn();
const mockUpdateSet = vi.fn();
// Every cursor lookup (findCursorForParams via .where().limit(), and the
// no-params resume via .where().orderBy().limit()) resolves through this fn so
// tests can queue per-call responses (e.g. the onConflict race).
const mockCursorLookup = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: (...args: unknown[]) => mockInsertReturning(...args),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    }),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: (...args: unknown[]) => mockCursorLookup(...args),
          orderBy: vi.fn().mockImplementation(() => ({
            limit: (...args: unknown[]) => mockCursorLookup(...args),
          })),
        })),
      })),
    })),
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
    searchParams: { name: "search_params" },
    paramsHash: { name: "params_hash" },
    exhausted: { name: "exhausted" },
    updatedAt: { name: "updated_at" },
  },
}));

vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" }),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
}));

// Mock Apollo client
const mockSearchPeople = vi.fn();

vi.mock("../../src/lib/apollo-client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
  enrichPerson: vi.fn().mockResolvedValue({ person: null }),
  buildWaterfallWebhookUrl: () => undefined,
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
const BASE_HEADERS = {
  "X-Campaign-Id": "campaign-1",
  "X-Brand-Id": "brand-1",
  "X-Run-Id": "run-parent-1",
};

describe("POST /search/next", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCursor = null;
    mockCursorLookup.mockImplementation(() => Promise.resolve(mockCursor ? [mockCursor] : []));
    mockInsertReturning.mockResolvedValue([{ id: "record-1" }]);

    mockSearchPeople.mockResolvedValue({
      people: makePeople(["p1", "p2", "p3"]),
      total_entries: 250,
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
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({ searchParams: SEARCH_PARAMS })
      .expect(200);

    expect(res.body.people).toHaveLength(3);
    expect(res.body.done).toBe(false);
    expect(res.body.totalEntries).toBe(250);
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
      totalEntries: 250,
      exhausted: false,
    };

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    expect(res.body.people).toHaveLength(3);
    // Should call Apollo with page 3
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "fake-apollo-key",
      expect.objectContaining({ page: 3, per_page: 100 })
    );
  });

  // ─── No cursor, no params → 400 ───────────────────────────────────────────

  it("returns 400 when no cursor exists and no searchParams provided", async () => {
    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(400);

    expect(res.body.error).toContain("No search cursor found");
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  // ─── New filter set → own cursor at page 1, NEVER resets/evicts ────────────

  it("creates a NEW cursor at page 1 for an unseen filter set (no match) — never resets an existing one", async () => {
    // The bug this fixes: a campaign that sends multiple distinct filter sets
    // used to thrash ONE cursor (campaign-keyed) back to page 1 on every param
    // change. Now an unseen filter set just gets its own fresh cursor; nothing
    // is reset. mockCursor=null → findCursorForParams returns no match → insert.
    mockCursor = null;

    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({ searchParams: SEARCH_PARAMS })
      .expect(200);

    // Inserts a fresh cursor and fetches page 1 for the new filter set
    expect(mockInsertReturning).toHaveBeenCalled();
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "fake-apollo-key",
      expect.objectContaining({ page: 1 })
    );
    // No reset-to-page-1 update is ever issued (the reset branch is gone)
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
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
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({ searchParams: SEARCH_PARAMS })
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
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
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
      totalEntries: 250,
      exhausted: false,
    };

    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    // Should advance cursor from page 2 to page 3
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: 3 })
    );
  });

  // ─── Mid-stream empty page (regression: must NOT mark exhausted) ───────────

  it("does NOT mark exhausted on a mid-stream empty page (Apollo returns 0 but more pages remain)", async () => {
    // Regression: Apollo occasionally returns an empty page even though more
    // matches exist. Marking the cursor exhausted on the first empty response
    // permanently broke pagination for the campaign. The cursor must be driven
    // strictly by Apollo's totalPages.
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 1,
      totalEntries: 250,
      exhausted: false,
    };

    mockSearchPeople.mockResolvedValue({
      people: [],
      total_entries: 250,
    });

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    expect(res.body.people).toHaveLength(0);
    expect(res.body.done).toBe(false);
    expect(res.body.totalEntries).toBe(250);
    // Cursor should advance to the next page but stay non-exhausted
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: 2, exhausted: false })
    );
  });

  // ─── Exhaustion when nextPage > totalPages ────────────────────────────────

  it("marks exhausted when nextPage > totalPages (Apollo's totalPages is the source of truth)", async () => {
    // 250 entries / per_page=100 → 3 totalPages. Reading page 3 → nextPage=4 > 3 → exhausted.
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 3,
      totalEntries: 250,
      exhausted: false,
    };

    mockSearchPeople.mockResolvedValue({
      people: [{ id: "p-tail" }],
      total_entries: 250,
    });

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    expect(res.body.done).toBe(true);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: 4, exhausted: true })
    );
  });

  // ─── Apollo reachable-window cap (50k records = 500 pages × 100) ──────────

  it("exhausts at Apollo's reachable window when totalEntries exceeds 50k", async () => {
    // Apollo serves at most 50,000 records (page 500 × per_page 100). A 100k
    // result set has more pages than Apollo will return; reading page 500 →
    // nextPage 501 > reachable cap → exhausted (NOT non-exhausted). The prior
    // "no artificial cap" assumption produced HTTP 422 "Page * per page number
    // is over threshold." in prod once the cursor advanced past page 500.
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 500,
      totalEntries: 100_000,
      exhausted: false,
    };

    mockSearchPeople.mockResolvedValue({
      people: [{ id: "p-last-reachable" }],
      total_entries: 100_000,
    });

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    expect(res.body.done).toBe(true);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: 501, exhausted: true })
    );
  });

  it("returns done WITHOUT calling Apollo when cursor already advanced past the reachable cap", async () => {
    // Self-heal: a cursor stranded at page 501 (from before this fix) must not
    // re-fetch a doomed page. It returns done and persists exhausted.
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 501,
      totalEntries: 100_000,
      exhausted: false,
    };

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    expect(res.body.done).toBe(true);
    expect(mockSearchPeople).not.toHaveBeenCalled();
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
      totalEntries: 250,
      exhausted: false,
    };

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    // All 3 people returned — no dedup filtering
    expect(res.body.people).toHaveLength(3);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  // ─── Cost tracking ────────────────────────────────────────────────────────

  it("tracks costs with costSource when runId provided", async () => {
    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .set("X-Run-Id", "run-abc")
      .send({ searchParams: SEARCH_PARAMS })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: "people-search-next" })
    );
    // Search is free — no addCosts call
    expect(mockAddCosts).not.toHaveBeenCalled();
    expect(mockUpdateRun).toHaveBeenCalledWith("run-1", "completed", expect.objectContaining({ orgId: "org_test" }));
  });

  it("returns 400 when no runId header provided", async () => {
    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set("X-Campaign-Id", "campaign-1")
      .set("X-Brand-Id", "brand-1")
      .send({ searchParams: SEARCH_PARAMS })
      .expect(400);

    expect(res.body.error).toContain("x-run-id");
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
      totalEntries: 250,
      exhausted: false,
    };

    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    // Exactly 1 Apollo call — no looping/retrying
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  // ─── JSONB key reorder regression ─────────────────────────────────────

  it("does NOT reset cursor when same params arrive with different key order (JSONB regression)", async () => {
    // Simulate Postgres JSONB alphabetical key reordering
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: {
        organizationNumEmployeesRanges: ["1,10"],  // alphabetical order (from Postgres)
        personTitles: ["CEO"],
        qOrganizationIndustryTagIds: ["Construction"],
      },
      currentPage: 5,
      totalEntries: 8000000,
      exhausted: false,
    };

    // Send params with different key order (as lead-service would)
    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({
        searchParams: {
          personTitles: ["CEO"],                        // different order
          qOrganizationIndustryTagIds: ["Construction"],
          organizationNumEmployeesRanges: ["1,10"],
        },
      })
      .expect(200);

    // Should use existing page 5, NOT reset to page 1
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "fake-apollo-key",
      expect.objectContaining({ page: 5 })
    );
    // Should NOT call updateSet to reset cursor
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: 1, exhausted: false })
    );
  });

  // ─── workflowSlug propagation ──────────────────────────────────────────

  it("passes workflowSlug to createRun when provided", async () => {
    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .set("X-Workflow-Slug", "fetch-lead")
      .send({ searchParams: SEARCH_PARAMS })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowSlug: "fetch-lead" })
    );
  });

  // ─── Hard failure on runs-service errors ─────────────────────────────────

  it("returns 500 and skips Apollo when createRun fails (createRun runs first)", async () => {
    mockCreateRun.mockRejectedValueOnce(new Error("runs-service POST /v1/runs failed: 401"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({ searchParams: SEARCH_PARAMS })
      .expect(500);

    expect(res.body.error).toContain("runs-service POST /v1/runs failed: 401");
    // Apollo should never be called when createRun fails — we run createRun first.
    expect(mockSearchPeople).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("returns 500 when updateRun fails", async () => {
    mockUpdateRun.mockRejectedValueOnce(new Error("runs-service PATCH failed: 503"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({ searchParams: SEARCH_PARAMS })
      .expect(500);

    expect(res.body.error).toContain("runs-service PATCH failed: 503");

    errorSpy.mockRestore();
  });

  // ─── Exhaustion-vs-low-yield signal (page / totalPages / hasMore) ─────────

  it("exposes page/totalPages/hasMore=true when more pages remain (done=false)", async () => {
    // 250 entries / 100 → 3 totalPages. Reading page 2 → nextPage 3, not > 3 → not done.
    mockCursor = {
      id: "cursor-1",
      orgId: "org-internal-123",
      campaignId: "campaign-1",
      searchParams: SEARCH_PARAMS,
      currentPage: 2,
      totalEntries: 250,
      exhausted: false,
    };

    const res = await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    expect(res.body.done).toBe(false);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.page).toBe(2);
    expect(res.body.totalPages).toBe(3);
  });

  it("exposes page/totalPages/hasMore=false on the exhausted early-return", async () => {
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
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({})
      .expect(200);

    expect(res.body.done).toBe(true);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.page).toBe(10);
    expect(res.body.totalPages).toBe(2); // ceil(200/100)
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  // ─── Concurrent insert race (onConflictDoNothing → re-select winner) ───────

  it("re-selects the winner's cursor when a concurrent insert wins the race", async () => {
    // findCursorForParams (1st) → no match; insert loses the unique race
    // (onConflictDoNothing returns []); re-select (2nd) → winner at page 7.
    mockCursor = null;
    mockCursorLookup
      .mockResolvedValueOnce([]) // 1st lookup: no existing cursor
      .mockResolvedValueOnce([
        {
          id: "winner-cursor",
          orgId: "org-internal-123",
          campaignId: "campaign-1",
          searchParams: SEARCH_PARAMS,
          currentPage: 7,
          totalEntries: 5000,
          exhausted: false,
        },
      ]); // 2nd lookup: the winner the concurrent request inserted
    mockInsertReturning.mockResolvedValueOnce([]); // our insert lost the race

    await request(app)
      .post("/search/next")
      .set("X-API-Key", "test-key")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({ searchParams: SEARCH_PARAMS })
      .expect(200);

    // Resumes the winner's page 7, not a fresh page 1
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "fake-apollo-key",
      expect.objectContaining({ page: 7 })
    );
  });
});
