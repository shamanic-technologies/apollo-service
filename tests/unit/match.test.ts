import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for POST /match endpoint.
 *
 * Covers: validation, cache hits/misses, cost tracking, error handling,
 * waterfall polling, keySource guard, /match/bulk removal.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });
const mockUpdateCostStatus = vi.fn().mockResolvedValue({});

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
  updateCostStatus: (...args: unknown[]) => mockUpdateCostStatus(...args),
}));

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

const mockInsertReturning = vi.fn().mockResolvedValue([{ id: "record-1" }]);
const mockInsertValues = vi.fn().mockReturnValue({ returning: (...args: unknown[]) => mockInsertReturning(...args) });
const mockSelectLimit = vi.fn().mockResolvedValue([]);

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: (...args: unknown[]) => mockInsertValues(...args),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: (...args: unknown[]) => mockSelectLimit(...args),
          }),
          limit: (...args: unknown[]) => mockSelectLimit(...args),
        }),
      }),
    }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleEnrichments: {
    id: { name: "id" },
    firstName: { name: "first_name" },
    lastName: { name: "last_name" },
    organizationDomain: { name: "organization_domain" },
    email: { name: "email" },
    emailStatus: { name: "email_status" },
    waterfallStatus: { name: "waterfall_status" },
    waterfallRequestId: { name: "waterfall_request_id" },
    createdAt: { name: "created_at" },
    apolloPersonId: { name: "apollo_person_id" },
  },
}));

const mockDecryptKey = vi.fn().mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" });
vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...args: unknown[]) => mockDecryptKey(...args),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
}));

const MOCK_PERSON = {
  id: "person-match-1",
  first_name: "John",
  last_name: "Doe",
  name: "John Doe",
  email: "john@acme.com",
  email_status: "verified",
  title: "CTO",
  linkedin_url: "https://linkedin.com/in/johndoe",
  photo_url: "https://img.apollo.io/johndoe.jpg",
  headline: "CTO at Acme",
  seniority: "c_suite",
  organization: {
    id: "org-acme",
    name: "Acme Inc",
    website_url: "https://acme.com",
    primary_domain: "acme.com",
    industry: "tech",
    estimated_num_employees: 200,
    annual_revenue: null,
  },
};

const mockMatchPersonByName = vi.fn().mockResolvedValue({ person: MOCK_PERSON });

vi.mock("../../src/lib/apollo-client.js", () => ({
  matchPersonByName: (...args: unknown[]) => mockMatchPersonByName(...args),
  buildWaterfallWebhookUrl: () => undefined,
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

function setBaseHeaders(req: request.Test): request.Test {
  return req
    .set("X-Org-Id", "org_test")
    .set("X-User-Id", "user_test")
    .set("X-Run-Id", "run-abc")
    .set("X-Brand-Id", "brand-1")
    .set("X-Campaign-Id", "campaign-1");
}

const POSITIVE_CACHE_RECORD = {
  id: "pos-1",
  apolloPersonId: "person-match-1",
  firstName: "John",
  lastName: "Doe",
  email: "john@acme.com",
  emailStatus: "verified",
  title: "CTO",
  linkedinUrl: "https://linkedin.com/in/johndoe",
  organizationName: "Acme Inc",
  organizationDomain: "acme.com",
  waterfallStatus: null,
  waterfallRequestId: null,
  createdAt: new Date(),
};

const NEGATIVE_CACHE_RECORD = {
  id: "neg-1",
  apolloPersonId: null,
  firstName: "John",
  lastName: "Doe",
  email: null,
  emailStatus: null,
  title: null,
  linkedinUrl: null,
  organizationName: null,
  organizationDomain: "acme.com",
  waterfallStatus: null,
  waterfallRequestId: null,
  createdAt: new Date(),
};

// ─── POST /match ────────────────────────────────────────────────────────────

describe("POST /match", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUpdateRun.mockResolvedValue({});
    mockAddCosts.mockResolvedValue({ costs: [{ id: "prov-cost-1" }] });
    mockUpdateCostStatus.mockResolvedValue({});
    mockInsertReturning.mockResolvedValue([{ id: "record-1" }]);
    mockMatchPersonByName.mockResolvedValue({ person: MOCK_PERSON });
    mockDecryptKey.mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" });
    mockSelectLimit.mockResolvedValue([]);

    let callCount = 0;
    mockCreateRun.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ id: `run-${callCount}` });
    });

    app = createTestApp();
    const { default: matchRoutes } = await import("../../src/routes/match.js");
    app.use(matchRoutes);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  it("should return 400 when firstName is missing", async () => {
    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ lastName: "Doe", organizationDomain: "acme.com" })
      .expect(400);

    expect(res.body.error).toBe("Invalid request");
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("should return 400 when x-run-id header is missing", async () => {
    const res = await request(app)
      .post("/match")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set("X-Brand-Id", "brand-1")
      .set("X-Campaign-Id", "campaign-1")
      .send({
        firstName: "John",
        lastName: "Doe",
        organizationDomain: "acme.com",
      })
      .expect(400);

    expect(res.body.error).toContain("x-run-id");
  });

  // ─── Cache miss happy path ────────────────────────────────────────────────

  it("should call Apollo and return person on cache miss", async () => {
    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    expect(mockMatchPersonByName).toHaveBeenCalledWith("fake-apollo-key", "John", "Doe", "acme.com", undefined);
    expect(res.body.person).toBeDefined();
    expect(res.body.person.firstName).toBe("John");
    expect(res.body.person.email).toBe("john@acme.com");
    expect(res.body.cached).toBe(false);
    expect(res.body.enrichmentId).toBe("record-1");
  });

  // ─── Cost tracking ───────────────────────────────────────────────────────

  it("should charge apollo-credit with costSource when email is found", async () => {
    await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    const matchCalls = mockAddCosts.mock.calls.filter(([, items]) =>
      items.some((i: { costName: string }) => i.costName === "apollo-credit")
    );
    expect(matchCalls).toHaveLength(1);
    expect(matchCalls[0][1][0]).toEqual({
      costName: "apollo-credit",
      costSource: "platform",
      quantity: 1,
    });
  });

  it("should NOT charge when person has no email", async () => {
    mockMatchPersonByName.mockResolvedValueOnce({
      person: { ...MOCK_PERSON, email: null, email_status: null },
    });

    await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("should NOT charge when Apollo returns no match", async () => {
    mockMatchPersonByName.mockResolvedValueOnce({ person: null });

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "Nobody", lastName: "Exists", organizationDomain: "none.com" })
      .expect(200);

    expect(res.body.person).toBeNull();
    expect(res.body.enrichmentId).toBeNull();
    expect(res.body.cached).toBe(false);
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  // ─── Positive cache hit ────────────────────────────────────────────────────

  it("should return cached result and skip Apollo on positive cache hit", async () => {
    // Query 1 (positive): hit
    mockSelectLimit.mockResolvedValueOnce([POSITIVE_CACHE_RECORD]);

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    expect(res.body.cached).toBe(true);
    expect(res.body.enrichmentId).toBeNull();
    expect(res.body.person.email).toBe("john@acme.com");
    expect(mockMatchPersonByName).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  // ─── Negative cache hit ────────────────────────────────────────────────────

  it("should return person:null and skip Apollo on negative cache hit", async () => {
    // Query 1 (positive): miss
    mockSelectLimit.mockResolvedValueOnce([]);
    // Query 2 (negative): hit
    mockSelectLimit.mockResolvedValueOnce([NEGATIVE_CACHE_RECORD]);

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    expect(res.body.cached).toBe(true);
    expect(res.body.person).toBeNull();
    expect(mockMatchPersonByName).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
  });

  // ─── Waterfall polling ────────────────────────────────────────────────────

  it("should poll and return email when waterfall completes within timeout", async () => {
    // Speed up polling for tests
    process.env.WATERFALL_POLL_INTERVAL_MS = "10";
    process.env.WATERFALL_POLL_TIMEOUT_MS = "200";
    // Apollo returns person without email, waterfall accepted
    mockMatchPersonByName.mockResolvedValueOnce({
      person: { ...MOCK_PERSON, email: null, email_status: null },
      waterfall: { status: "accepted" },
      request_id: "12345",
    });

    // After INSERT, simulate polling: first poll returns no email, second poll returns email
    let pollCount = 0;
    mockSelectLimit.mockImplementation(() => {
      pollCount++;
      // Calls 1-2: findCachedMatch positive + negative (cache miss)
      if (pollCount <= 2) return Promise.resolve([]);
      // Call 3: first poll — still pending
      if (pollCount === 3) return Promise.resolve([{ ...NEGATIVE_CACHE_RECORD, waterfallStatus: "pending", waterfallRequestId: "12345" }]);
      // Call 4: second poll — email arrived
      return Promise.resolve([{ ...POSITIVE_CACHE_RECORD, waterfallStatus: "completed", waterfallRequestId: "12345" }]);
    });

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    expect(res.body.person.email).toBe("john@acme.com");
    expect(res.body.cached).toBe(false);
    expect(pollCount).toBeGreaterThanOrEqual(4);
  });

  it("should return 504 when waterfall polling times out", async () => {
    // Speed up polling for tests
    process.env.WATERFALL_POLL_INTERVAL_MS = "10";
    process.env.WATERFALL_POLL_TIMEOUT_MS = "50";
    // Apollo returns person without email, waterfall accepted
    mockMatchPersonByName.mockResolvedValueOnce({
      person: { ...MOCK_PERSON, email: null, email_status: null },
      waterfall: { status: "accepted" },
      request_id: "12345",
    });

    // Polling always returns pending (webhook never arrives)
    let pollCount = 0;
    mockSelectLimit.mockImplementation(() => {
      pollCount++;
      // Calls 1-2: findCachedMatch
      if (pollCount <= 2) return Promise.resolve([]);
      // All polls: still pending
      return Promise.resolve([{ ...NEGATIVE_CACHE_RECORD, waterfallStatus: "pending", waterfallRequestId: "12345" }]);
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(504);

    expect(res.body.error).toContain("timeout");
    // Run should be marked as failed on timeout
    expect(mockUpdateRun).toHaveBeenCalledWith(expect.any(String), "failed", expect.any(Object));
    errorSpy.mockRestore();
  });

  // ─── keySource guard ──────────────────────────────────────────────────────

  it("should throw when keySource is null/undefined on INSERT", async () => {
    mockDecryptKey.mockResolvedValueOnce({ key: "fake-key", keySource: undefined });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(500);

    errorSpy.mockRestore();
  });

  // ─── workflowSlug propagation ─────────────────────────────────────────────

  it("should pass workflowSlug to createRun", async () => {
    await setBaseHeaders(request(app).post("/match"))
      .set("X-Workflow-Slug", "fetch-lead")
      .send({
        firstName: "John",
        lastName: "Doe",
        organizationDomain: "acme.com",
      })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowSlug: "fetch-lead", taskName: "person-match" })
    );
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it("should return 500 when Apollo API fails", async () => {
    mockMatchPersonByName.mockRejectedValueOnce(new Error("Apollo match failed: 429"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(500);

    expect(res.body.error).toContain("Apollo match failed: 429");
    errorSpy.mockRestore();
  });

  it("should return 500 when createRun fails", async () => {
    mockCreateRun.mockRejectedValue(new Error("runs-service down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(500);

    errorSpy.mockRestore();
  });
});

// ─── POST /match/bulk — Removed ─────────────────────────────────────────────

describe("POST /match/bulk — removed", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    let callCount = 0;
    mockCreateRun.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ id: `run-${callCount}` });
    });
    app = createTestApp();
    const { default: matchRoutes } = await import("../../src/routes/match.js");
    app.use(matchRoutes);
  });

  it("should return 404 for /match/bulk", async () => {
    await setBaseHeaders(request(app).post("/match/bulk"))
      .send({
        items: [{ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" }],
      })
      .expect(404);
  });
});
