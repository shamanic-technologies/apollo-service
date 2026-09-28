import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Reveal domain gate: covered in reveal-domain-gate.test.ts; here it lets every reveal through.
vi.mock("../../src/lib/reveal-domain-gate.js", () => ({
  gateReveal: vi.fn().mockResolvedValue({ action: "reveal", basis: "no_employer" }),
  recordRevealSkip: vi.fn(),
  rememberTeaserEmployers: vi.fn().mockResolvedValue(undefined),
}));


// Pre-serve verification is covered in email-verification.test.ts; here it is a
// stub that answers "valid" for any address.

// The QuickEnrich switch is off for every audience in these tests.
vi.mock("../../src/lib/quickenrich-serve.js", () => ({
  findQuickenrichAudience: vi.fn().mockResolvedValue(null),
  serveQuickenrichPage: vi.fn(),
  loadQuickenrichPerson: vi.fn(),
}));

vi.mock("../../src/lib/email-verification.js", () => ({
  EmailVerificationError: class EmailVerificationError extends Error {},
  verificationFor: async (email: string | null | undefined) =>
    email ? { email, verdict: "valid", deliverable: true, verifier: "bounceverify", verificationId: "ver-1", verifiedAt: "2026-09-25T00:00:00.000Z", reused: false } : null,
}));


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
    if (req.headers["x-brand-id"]) { req.brandId = req.headers["x-brand-id"] as string; req.brandIds = String(req.headers["x-brand-id"]).split(",").map((s: string) => s.trim()).filter(Boolean); }
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
    transaction: async (cb: (tx: unknown) => unknown) =>
      cb({
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: (...args: unknown[]) => mockInsertReturning(...args) }) }),
        execute: vi.fn().mockResolvedValue([]),
      }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: (...args: unknown[]) => mockInsertReturning(...args),
        }),
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
vi.mock("../../src/lib/apollo-client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
  enrichPerson: (...args: unknown[]) => mockEnrichPerson(...args),
  buildWaterfallWebhookUrl: () => undefined,
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

  // ─── POST /search/next ──────────────────────────────────────────────────

  it("should NOT call authorizeCredit on POST /search/next (search is free)", async () => {
    await request(app)
      .post("/search/next")
      .set(HEADERS)
      .send({ searchParams: { personTitles: ["CEO"] } })
      .expect(200);

    // Search is free — no billing authorization
    expect(mockAuthorizeCredit).not.toHaveBeenCalled();
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
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

  it("should authorize the direct Apollo cost (1 credit) on POST /enrich", async () => {
    await request(app)
      .post("/enrich")
      .set(HEADERS)
      .send({ apolloPersonId: "p-1" })
      .expect(200);

    // Waterfall disabled 2026-05-28 — direct Apollo /people/match only.
    // Authorize the actual cost (1 credit per email), not the legacy
    // worst-case waterfall ceiling (20 credits).
    expect(mockAuthorizeCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ costName: "apollo-credit", quantity: 1 }],
      })
    );
  });

  it("a person whose employer's mail domain is catch-all costs ZERO reveal credits: no authorize, no Apollo call, skip recorded", async () => {
    const gate = await import("../../src/lib/reveal-domain-gate.js");
    const evidence = [{ domain: "dugasdental.com", verdict: "catch_all", verificationId: "ver-1", verifiedAt: "2026-09-28T00:00:00.000Z", probed: false }];
    vi.mocked(gate.gateReveal).mockResolvedValueOnce({
      action: "skip",
      reason: "catch_all_domain",
      organizationName: "Dugas Dental",
      organizationId: "org-1",
      evidence: evidence as never,
    });
    vi.mocked(gate.recordRevealSkip).mockResolvedValueOnce("skip-1");

    const res = await request(app).post("/enrich").set(HEADERS).send({ apolloPersonId: "p-1" }).expect(200);

    expect(res.body).toMatchObject({
      enrichmentId: null,
      person: null,
      emailVerification: null,
      revealSkipped: { skipId: "skip-1", reason: "catch_all_domain", organizationName: "Dugas Dental", evidence },
    });
    expect(mockAuthorizeCredit).not.toHaveBeenCalled();
    expect(mockEnrichPerson).not.toHaveBeenCalled();
    expect(gate.recordRevealSkip).toHaveBeenCalledWith("p-1", expect.objectContaining({ reason: "catch_all_domain" }), expect.objectContaining({ runId: expect.any(String) }));
  });

  it("the gate runs BEFORE the Apollo spend and a passing gate reveals as before", async () => {
    const gate = await import("../../src/lib/reveal-domain-gate.js");
    await request(app).post("/enrich").set(HEADERS).send({ apolloPersonId: "p-1" }).expect(200);
    expect(gate.gateReveal).toHaveBeenCalledWith("p-1", expect.objectContaining({ apolloApiKey: expect.any(String) }));
    expect(vi.mocked(gate.gateReveal).mock.invocationCallOrder.at(-1)!).toBeLessThan(mockEnrichPerson.mock.invocationCallOrder.at(-1)!);
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

  // ─── POST /enrich outside any campaign ─────────────────────────────────

  it("POST /enrich without x-campaign-id is the SAME billed reveal: authorized, costed, verified, no campaign invented", async () => {
    const { "X-Campaign-Id": _omit, ...noCampaign } = HEADERS;
    const res = await request(app)
      .post("/enrich")
      .set({ ...noCampaign, "X-Audience-Id": "aud-1" })
      .send({ apolloPersonId: "p-1" })
      .expect(200);

    expect(res.body.person.email).toBe("a@b.com");
    expect(res.body.emailVerification).toMatchObject({ verdict: "valid", deliverable: true });
    expect(mockEnrichPerson).toHaveBeenCalledTimes(1);
    // Metered against the caller's org exactly as a campaign reveal.
    expect(mockAuthorizeCredit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-123", items: [{ costName: "apollo-credit", quantity: 1 }], campaignId: undefined }),
    );
    expect(mockAddCosts).toHaveBeenCalledWith(
      expect.any(String),
      [{ costName: "apollo-credit", costSource: "platform", quantity: 1 }],
      expect.objectContaining({ orgId: "org-123", campaignId: undefined }),
    );
    // Every run it opens carries no campaign id at all.
    for (const [arg] of mockCreateRun.mock.calls) expect((arg as { campaignId?: string }).campaignId).toBeUndefined();
  });

  it("POST /enrich still requires x-run-id and x-brand-id", async () => {
    const { "X-Campaign-Id": _c, "X-Brand-Id": _b, ...h } = HEADERS;
    const res = await request(app).post("/enrich").set(h).send({ apolloPersonId: "p-1" }).expect(400);
    expect(res.body.error).toBe("x-run-id and x-brand-id headers required");
    expect(mockEnrichPerson).not.toHaveBeenCalled();
  });

  it("POST /search/next still requires x-campaign-id (the cursor is campaign-keyed)", async () => {
    const { "X-Campaign-Id": _c, ...h } = HEADERS;
    await request(app).post("/search/next").set(h).send({ searchParams: { personTitles: ["CEO"] } }).expect(400);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  // ─── POST /search/next ─────────────────────────────────────────────────

  it("should NOT call authorizeCredit on POST /search/next (search is free)", async () => {
    mockInsertReturning.mockResolvedValueOnce([{ id: "cursor-1" }]);

    await request(app)
      .post("/search/next")
      .set(HEADERS)
      .send({ searchParams: { personTitles: ["CEO"] } })
      .expect(200);

    expect(mockAuthorizeCredit).not.toHaveBeenCalled();
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });
});
