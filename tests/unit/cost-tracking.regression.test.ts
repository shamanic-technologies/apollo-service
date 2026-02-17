import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Regression test: Apollo service cost tracking
 *
 * Cost tracking via runs-service is mandatory when a runId is provided.
 * If createRun, addCosts, or updateRun fail, the request must return 500.
 *
 * These tests verify:
 * - Correct cost names are used (apollo-enrichment-credit, apollo-search-credit)
 * - One enrichment cost is posted per person
 * - One search cost is posted per search
 * - Runs-service failures propagate as 500 errors (hard fail, not soft)
 */

// Mock runs-client before importing the route
const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

// Mock auth middleware to pass through
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "org-internal-123";
    req.clerkOrgId = req.headers["x-clerk-org-id"] || "org_test";
    next();
  },
}));

// Mock the DB — track db.update().set() calls to verify enrichmentRunId linking
const mockInsertReturning = vi.fn().mockResolvedValue([{ id: "record-1" }]);
const mockDbSetCalls: Array<Record<string, unknown>> = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        mockDbSetCalls.push(data);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    query: {
      apolloPeopleSearches: { findMany: vi.fn().mockResolvedValue([]) },
      apolloPeopleEnrichments: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleSearches: { id: { name: "id" } },
  apolloPeopleEnrichments: { id: { name: "id" } },
}));

vi.mock("../../src/lib/keys-client.js", () => ({
  getByokKey: vi.fn().mockResolvedValue("fake-apollo-key"),
}));

// Mock Apollo client to return N people
const MOCK_PEOPLE_COUNT = 3;
const mockPeople = Array.from({ length: MOCK_PEOPLE_COUNT }, (_, i) => ({
  id: `person-${i}`,
  first_name: `First${i}`,
  last_name: `Last${i}`,
  name: `First${i} Last${i}`,
  email: `person${i}@example.com`,
  email_status: "verified",
  title: "CEO",
  linkedin_url: null,
  photo_url: `https://img.apollo.io/person${i}.jpg`,
  headline: `CEO at Company${i}`,
  seniority: "c_suite",
  organization: {
    id: `org-${i}`,
    name: `Company${i}`,
    website_url: `https://company${i}.com`,
    primary_domain: `company${i}.com`,
    industry: "tech",
    estimated_num_employees: 50,
    annual_revenue: null,
    logo_url: `https://company${i}.com/logo.png`,
    short_description: `Company${i} is a tech company`,
    founded_year: 2020,
  },
}));

const mockSearchPeople = vi.fn().mockResolvedValue({
  people: mockPeople,
  total_entries: MOCK_PEOPLE_COUNT,
});

const mockEnrichPerson = vi.fn().mockResolvedValue({
  person: {
    id: "person-0",
    first_name: "First0",
    last_name: "Last0",
    email: "enriched@example.com",
    email_status: "verified",
    title: "CEO",
    linkedin_url: null,
    organization: {
      name: "Company0",
      primary_domain: "company0.com",
      industry: "tech",
      estimated_num_employees: 50,
      annual_revenue: null,
    },
  },
});

vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
  enrichPerson: (...args: unknown[]) => mockEnrichPerson(...args),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("Apollo service cost tracking", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbSetCalls.length = 0;
    mockUpdateRun.mockResolvedValue({});
    mockAddCosts.mockResolvedValue({ costs: [] });
    mockInsertReturning.mockResolvedValue([{ id: "record-1" }]);
    mockSearchPeople.mockResolvedValue({
      people: mockPeople,
      total_entries: MOCK_PEOPLE_COUNT,
    });
    mockEnrichPerson.mockResolvedValue({
      person: {
        id: "person-0",
        first_name: "First0",
        last_name: "Last0",
        name: "First0 Last0",
        email: "enriched@example.com",
        email_status: "verified",
        title: "CEO",
        linkedin_url: null,
        photo_url: "https://img.apollo.io/person0.jpg",
        headline: "CEO at Company0",
        seniority: "c_suite",
        organization: {
          id: "org-0",
          name: "Company0",
          website_url: "https://company0.com",
          primary_domain: "company0.com",
          industry: "tech",
          estimated_num_employees: 50,
          annual_revenue: null,
          logo_url: "https://company0.com/logo.png",
          short_description: "Company0 is a tech company",
          founded_year: 2020,
        },
      },
    });

    // First call = search run, subsequent calls = enrichment runs
    let callCount = 0;
    mockCreateRun.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ id: `run-${callCount}` });
    });

    app = createTestApp();
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  // ─── Happy path ──────────────────────────────────────────────────────────────

  it("should NOT post enrichment costs for search results (regression: search != enrichment)", async () => {
    await request(app)
      .post("/search")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        runId: "campaign-run-abc",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        personTitles: ["CEO"],
      })
      .expect(200);

    // Search should NOT create enrichment costs — only search credit
    const enrichmentCalls = mockAddCosts.mock.calls.filter(([, items]) =>
      items.some((i: { costName: string }) => i.costName === "apollo-enrichment-credit")
    );

    expect(enrichmentCalls).toHaveLength(0);
  });

  it("should post apollo-search-credit cost once per search", async () => {
    await request(app)
      .post("/search")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        runId: "campaign-run-abc",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        personTitles: ["CEO"],
      })
      .expect(200);

    const searchCalls = mockAddCosts.mock.calls.filter(([, items]) =>
      items.some((i: { costName: string }) => i.costName === "apollo-search-credit")
    );

    expect(searchCalls).toHaveLength(1);
    const [, items] = searchCalls[0];
    const searchItem = items.find((i: { costName: string }) => i.costName === "apollo-search-credit");
    expect(searchItem.quantity).toBe(1);
  });

  it("should only post search credit from POST /search (no enrichment credits)", async () => {
    await request(app)
      .post("/search")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        runId: "campaign-run-abc",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        personTitles: ["CEO"],
      })
      .expect(200);

    const allCostNames = mockAddCosts.mock.calls
      .flatMap(([, items]) => items.map((i: { costName: string }) => i.costName));

    // Search endpoint should only track search credits
    const uniqueNames = [...new Set(allCostNames)];
    expect(uniqueNames).toEqual(["apollo-search-credit"]);
  });

  // ─── Hard failure on runs-service errors (POST /search) ──────────────────────

  it("should return 500 when createRun fails", async () => {
    mockCreateRun.mockRejectedValue(new Error("runs-service POST /v1/runs failed: 401"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/search")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        runId: "campaign-run-abc",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        personTitles: ["CEO"],
      })
      .expect(500);

    expect(res.body.error).toContain("runs-service POST /v1/runs failed: 401");

    // Apollo API should never have been called
    expect(mockSearchPeople).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("should return 500 when addCosts fails for search credit", async () => {
    mockAddCosts.mockRejectedValue(new Error("Cost name not registered"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/search")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        runId: "campaign-run-abc",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        personTitles: ["CEO"],
      })
      .expect(500);

    expect(res.body.error).toContain("Cost name not registered");

    errorSpy.mockRestore();
  });

  it("should return 500 when updateRun fails", async () => {
    mockUpdateRun.mockRejectedValue(new Error("runs-service PATCH failed: 503"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/search")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        runId: "campaign-run-abc",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        personTitles: ["CEO"],
      })
      .expect(500);

    expect(res.body.error).toContain("runs-service PATCH failed: 503");

    errorSpy.mockRestore();
  });

  it("should NOT create enrichment runs in search (only 1 createRun for search itself)", async () => {
    await request(app)
      .post("/search")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        runId: "campaign-run-abc",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        personTitles: ["CEO"],
      })
      .expect(200);

    // Only 1 createRun call for the search run, NOT N+1 (search + one per person)
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: "people-search" })
    );
  });

  it("should return 200 when no runId provided (no cost tracking attempted)", async () => {
    // Even if runs-service is broken, no-runId requests succeed
    mockCreateRun.mockRejectedValue(new Error("should not be called"));

    await request(app)
      .post("/search")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        personTitles: ["CEO"],
      })
      .expect(200);

    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
    expect(mockUpdateRun).not.toHaveBeenCalled();
  });

  // ─── POST /enrich cost tracking ─────────────────────────────────────────────

  it("should post exactly 1 enrichment cost from POST /enrich", async () => {
    await request(app)
      .post("/enrich")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        apolloPersonId: "person-0",
        runId: "campaign-run-abc",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
      })
      .expect(200);

    const enrichmentCalls = mockAddCosts.mock.calls.filter(([, items]) =>
      items.some((i: { costName: string }) => i.costName === "apollo-enrichment-credit")
    );
    expect(enrichmentCalls).toHaveLength(1);
    expect(enrichmentCalls[0][1][0].quantity).toBe(1);
  });

  // ─── Hard failure on runs-service errors (POST /enrich) ──────────────────────

  it("should return 500 when addCosts fails for POST /enrich", async () => {
    mockAddCosts.mockRejectedValue(new Error("Cost name not registered"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/enrich")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        apolloPersonId: "person-0",
        runId: "campaign-run-abc",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
      })
      .expect(500);

    expect(res.body.error).toContain("Cost name not registered");

    errorSpy.mockRestore();
  });

  it("should return 200 for POST /enrich when no runId provided", async () => {
    mockCreateRun.mockRejectedValue(new Error("should not be called"));

    await request(app)
      .post("/enrich")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        apolloPersonId: "person-0",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
      })
      .expect(200);

    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });
});
