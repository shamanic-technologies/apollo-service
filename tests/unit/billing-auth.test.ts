import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for billing credit authorization.
 *
 * Verifies:
 * - Platform operations are blocked with 402 when credits are insufficient
 * - BYOK (org) operations skip authorization entirely
 * - Authorization sends items (costName + quantity), not raw cents
 * - All required headers are forwarded to billing-service
 * - Cache-hit enrichments skip authorization (no cost)
 */

// Mock billing-client
const mockAuthorizeCredit = vi.fn();
vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: (...args: unknown[]) => mockAuthorizeCredit(...args),
}));

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
    req.orgId = req.headers["x-org-id"] || "org-123";
    req.userId = req.headers["x-user-id"] || "user-456";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-brand-id"]) req.brandId = req.headers["x-brand-id"];
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    if (req.headers["x-feature-slug"]) req.featureSlug = req.headers["x-feature-slug"];
    if (req.headers["x-workflow-slug"]) req.workflowSlug = req.headers["x-workflow-slug"];
    next();
  },
}));

// Mock keys-client — default to platform
const mockDecryptKey = vi.fn();
vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...args: unknown[]) => mockDecryptKey(...args),
}));

// Mock DB
const mockInsertReturning = vi.fn().mockResolvedValue([{ id: "record-1" }]);
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
          limit: vi.fn().mockResolvedValue([]),
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
  apolloSearchCursors: { id: { name: "id" } },
}));

// Mock Apollo client
const mockSearchPeople = vi.fn();
const mockEnrichPerson = vi.fn();
vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
  enrichPerson: (...args: unknown[]) => mockEnrichPerson(...args),
}));

const HEADERS = {
  "X-Org-Id": "org-123",
  "X-User-Id": "user-456",
  "X-Run-Id": "run-abc",
  "X-Brand-Id": "brand-1",
  "X-Campaign-Id": "campaign-1",
  "X-Workflow-Slug": "fetch-lead",
};

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("Billing credit authorization", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockDecryptKey.mockResolvedValue({ key: "fake-key", keySource: "platform" });
    mockAuthorizeCredit.mockResolvedValue({ sufficient: true, balance_cents: 5000, required_cents: 100 });
    mockSearchPeople.mockResolvedValue({
      people: [{ id: "p-1", first_name: "A", last_name: "B", name: "A B", email: "a@b.com", email_status: "verified", title: "CEO", linkedin_url: null, photo_url: null, headline: null, seniority: null, organization: { id: "o-1", name: "Co", website_url: null, primary_domain: "co.com", industry: "tech", estimated_num_employees: 10, annual_revenue: null, logo_url: null, short_description: null, founded_year: 2020 } }],
      total_entries: 1,
    });
    mockEnrichPerson.mockResolvedValue({
      person: { id: "p-1", first_name: "A", last_name: "B", name: "A B", email: "a@b.com", email_status: "verified", title: "CEO", linkedin_url: null, photo_url: null, headline: null, seniority: null, organization: { id: "o-1", name: "Co", website_url: null, primary_domain: "co.com", industry: "tech", estimated_num_employees: 10, annual_revenue: null, logo_url: null, short_description: null, founded_year: 2020 } },
    });

    let runCounter = 0;
    mockCreateRun.mockImplementation(() => {
      runCounter++;
      return Promise.resolve({ id: `run-${runCounter}` });
    });

    app = createTestApp();
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  // ─── POST /search ───────────────────────────────────────────────────────

  it("should return 402 when billing authorization fails for POST /search (platform)", async () => {
    mockAuthorizeCredit.mockResolvedValueOnce({ sufficient: false, balance_cents: 0, required_cents: 100 });

    const res = await request(app)
      .post("/search")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(402);

    expect(res.body.error).toBe("Insufficient credits");
    expect(res.body.balance_cents).toBe(0);
    expect(res.body.required_cents).toBe(100);
    expect(mockSearchPeople).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("should proceed normally when billing authorization succeeds for POST /search", async () => {
    await request(app)
      .post("/search")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(mockAuthorizeCredit).toHaveBeenCalledTimes(1);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  it("should skip billing authorization for BYOK on POST /search", async () => {
    mockDecryptKey.mockResolvedValueOnce({ key: "byok-key", keySource: "org" });

    await request(app)
      .post("/search")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(mockAuthorizeCredit).not.toHaveBeenCalled();
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  it("should send items with costName and quantity to billing-service on POST /search", async () => {
    await request(app)
      .post("/search")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(mockAuthorizeCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ costName: "apollo-search-credit", quantity: 1 }],
        description: "apollo-search-credit",
        orgId: "org-123",
        userId: "user-456",
        runId: "run-abc",
        brandId: "brand-1",
        campaignId: "campaign-1",
        workflowSlug: "fetch-lead",
      })
    );
  });

  // ─── POST /enrich ──────────────────────────────────────────────────────

  it("should return 402 when billing authorization fails for POST /enrich (platform)", async () => {
    mockAuthorizeCredit.mockResolvedValueOnce({ sufficient: false, balance_cents: 0, required_cents: 50 });

    const res = await request(app)
      .post("/enrich")
      .set(HEADERS)
      .send({ apolloPersonId: "p-1" })
      .expect(402);

    expect(res.body.error).toBe("Insufficient credits");
    expect(res.body.required_cents).toBe(50);
    expect(mockEnrichPerson).not.toHaveBeenCalled();
  });

  it("should send items with costName for POST /enrich authorization", async () => {
    await request(app)
      .post("/enrich")
      .set(HEADERS)
      .send({ apolloPersonId: "p-1" })
      .expect(200);

    expect(mockAuthorizeCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ costName: "apollo-enrichment-credit", quantity: 1 }],
      })
    );
  });

  it("should skip billing authorization for BYOK on POST /enrich", async () => {
    mockDecryptKey.mockResolvedValueOnce({ key: "byok-key", keySource: "org" });

    await request(app)
      .post("/enrich")
      .set(HEADERS)
      .send({ apolloPersonId: "p-1" })
      .expect(200);

    expect(mockAuthorizeCredit).not.toHaveBeenCalled();
    expect(mockEnrichPerson).toHaveBeenCalledTimes(1);
  });

  it("should skip billing authorization for cache-hit enrichments", async () => {
    // Simulate cache hit
    const { db } = await import("../../src/db/index.js");
    const selectMock = vi.mocked(db.select);
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: "cached-1",
              apolloPersonId: "p-1",
              firstName: "A",
              lastName: "B",
              email: "a@b.com",
              emailStatus: "verified",
              title: "CEO",
              linkedinUrl: null,
              organizationName: "Co",
              organizationDomain: "co.com",
              organizationIndustry: "tech",
              organizationSize: 10,
              organizationRevenue: null,
              createdAt: new Date(),
            }]),
          }),
        }),
      }),
    } as any);

    await request(app)
      .post("/enrich")
      .set(HEADERS)
      .send({ apolloPersonId: "p-1" })
      .expect(200);

    expect(mockAuthorizeCredit).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
    expect(mockEnrichPerson).not.toHaveBeenCalled();
  });

  // ─── POST /search/next ─────────────────────────────────────────────────

  it("should return 402 when billing authorization fails for POST /search/next (platform)", async () => {
    mockAuthorizeCredit.mockResolvedValueOnce({ sufficient: false, balance_cents: 50, required_cents: 100 });

    const res = await request(app)
      .post("/search/next")
      .set(HEADERS)
      .send({ searchParams: { personTitles: ["CEO"] } })
      .expect(402);

    expect(res.body.error).toBe("Insufficient credits");
    expect(res.body.balance_cents).toBe(50);
    expect(res.body.required_cents).toBe(100);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("should skip billing authorization for BYOK on POST /search/next", async () => {
    mockDecryptKey.mockResolvedValueOnce({ key: "byok-key", keySource: "org" });

    mockInsertReturning.mockResolvedValueOnce([{ id: "cursor-1" }]);

    await request(app)
      .post("/search/next")
      .set(HEADERS)
      .send({ searchParams: { personTitles: ["CEO"] } })
      .expect(200);

    expect(mockAuthorizeCredit).not.toHaveBeenCalled();
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  // ─── Billing service failure ───────────────────────────────────────────

  it("should return 500 when billing-service is unreachable", async () => {
    mockAuthorizeCredit.mockRejectedValueOnce(new Error("billing-service POST /v1/credits/authorize failed: 503 - Service Unavailable"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/search")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(500);

    expect(res.body.error).toContain("billing-service");
    expect(mockSearchPeople).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
