import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for /enrich waterfall cash management.
 *
 * /enrich must follow the same pattern as /match for waterfall billing:
 *  1. authorize WATERFALL_MAX_CREDITS upfront (platform key)
 *  2. provision WATERFALL_MAX_CREDITS cost when waterfall accepted, store provisionedCostId
 *  3. poll synchronously for webhook resolution
 *  4. cancel provisioned on resolution (email or no email), or leave on timeout
 *  5. negative cache (24h) for failed waterfalls; cleanup on stale pending (>24h)
 *  6. webhook reconciliation works on /enrich rows the same as /match rows
 */

const TEST_INTERVAL_MS = "5";
const TEST_TIMEOUT_MS = "30";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.WATERFALL_POLL_INTERVAL_MS = TEST_INTERVAL_MS;
  process.env.WATERFALL_POLL_TIMEOUT_MS = TEST_TIMEOUT_MS;
});

// ─── Shared mock factory ─────────────────────────────────────────────────────

interface MockState {
  cachedRows: any[];
  insertReturning: any[];
  pollEmailRow: any | null;
  enrichResponse: any;
  decryptKey: { key: string; keySource: "platform" | "org" };
  authorize: { sufficient: boolean; balance_cents: number; required_cents?: number };
  addCostsResult: { costs: Array<{ id: string }> };
  insertCalls: Array<Record<string, unknown>>;
  updateSetCalls: Array<Record<string, unknown>>;
  addCostsCalls: any[][];
  authorizeCalls: any[][];
  updateCostStatusCalls: any[][];
  enrichApolloCalls: any[][];
}

function setupMocks(s: MockState) {
  vi.doMock("../../src/lib/runs-client.js", () => ({
    createRun: vi.fn().mockResolvedValue({ id: "child-run-1" }),
    updateRun: vi.fn().mockResolvedValue({}),
    addCosts: vi.fn().mockImplementation(async (...args: any[]) => {
      s.addCostsCalls.push(args);
      return s.addCostsResult;
    }),
    updateCostStatus: vi.fn().mockImplementation(async (...args: any[]) => {
      s.updateCostStatusCalls.push(args);
      return {};
    }),
  }));

  vi.doMock("../../src/lib/billing-client.js", () => ({
    authorizeCredit: vi.fn().mockImplementation(async (...args: any[]) => {
      s.authorizeCalls.push(args);
      return s.authorize;
    }),
  }));

  vi.doMock("../../src/lib/keys-client.js", () => ({
    decryptKey: vi.fn().mockResolvedValue(s.decryptKey),
  }));

  vi.doMock("../../src/lib/apollo-client.js", () => ({
    enrichPerson: vi.fn().mockImplementation(async (...args: any[]) => {
      s.enrichApolloCalls.push(args);
      return s.enrichResponse;
    }),
    searchPeople: vi.fn(),
    buildWaterfallWebhookUrl: () => "https://apollo.example.com/webhook/waterfall?secret=x",
  }));

  vi.doMock("../../src/lib/transform.js", () => ({
    transformApolloPerson: (p: any) => ({ id: p.id, email: p.email ?? null }),
    toEnrichmentDbValues: (p: any) => ({ apolloPersonId: p.id, email: p.email ?? null }),
    transformCachedEnrichment: (id: string, r: any) => ({ id, email: r.email }),
    toApolloSearchParams: (p: any) => p,
  }));

  vi.doMock("../../src/lib/validators.js", () => ({
    assertKeySource: vi.fn(),
  }));

  vi.doMock("../../src/lib/trace-event.js", () => ({
    traceEvent: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("../../src/lib/dynasty-client.js", () => ({
    resolveWorkflowDynastySlugs: vi.fn(),
    resolveFeatureDynastySlugs: vi.fn(),
    fetchAllWorkflowDynasties: vi.fn(),
    fetchAllFeatureDynasties: vi.fn(),
    buildSlugToDynastyMap: vi.fn(),
  }));

  vi.doMock("../../src/lib/filters-prompt.js", () => ({
    buildFiltersPrompt: () => "",
    computeFiltersPromptVersion: () => "v0",
  }));

  vi.doMock("../../src/lib/deep-equal.js", () => ({
    deepEqual: () => true,
  }));

  vi.doMock("../../src/middleware/auth.js", () => ({
    serviceAuth: (req: any, _res: any, next: any) => {
      req.orgId = "org-1";
      req.userId = "user-1";
      req.runId = "parent-run-1";
      req.brandIds = ["b1"];
      req.campaignId = "c1";
      next();
    },
  }));

  vi.doMock("../../src/db/schema.js", () => ({
    apolloPeopleEnrichments: {
      id: { name: "id" },
      apolloPersonId: { name: "apollo_person_id" },
      email: { name: "email" },
      createdAt: { name: "created_at" },
      waterfallStatus: { name: "waterfall_status" },
      orgId: { name: "org_id" },
      provisionedCostId: { name: "provisioned_cost_id" },
      enrichmentRunId: { name: "enrichment_run_id" },
    },
    apolloPeopleSearches: { id: { name: "id" } },
    apolloSearchCursors: { id: { name: "id" }, orgId: { name: "org_id" }, campaignId: { name: "campaign_id" } },
  }));

  let cachedSelectCallCount = 0;
  vi.doMock("../../src/db/index.js", () => ({
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(async () => {
                const idx = cachedSelectCallCount++;
                return s.cachedRows[idx] ? [s.cachedRows[idx]] : [];
              }),
            }),
            // For the polling helper which does .where(eq(id, id)).limit(1)
            limit: vi.fn().mockImplementation(async () => {
              return s.pollEmailRow ? [s.pollEmailRow] : [];
            }),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((data: Record<string, unknown>) => {
          s.insertCalls.push(data);
          return {
            returning: vi.fn().mockResolvedValue(s.insertReturning),
          };
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
          s.updateSetCalls.push(data);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
      query: {
        apolloPeopleSearches: { findMany: vi.fn().mockResolvedValue([]) },
        apolloPeopleEnrichments: { findMany: vi.fn().mockResolvedValue([]) },
      },
    },
  }));
}

function defaultState(overrides: Partial<MockState> = {}): MockState {
  return {
    cachedRows: [],
    insertReturning: [{ id: "enr-1" }],
    pollEmailRow: null,
    enrichResponse: {
      person: { id: "ap-1", first_name: "Jane", last_name: "Doe", email: null, email_status: null },
      waterfall: { status: "accepted" },
      request_id: "wf-req-1",
    },
    decryptKey: { key: "fake-key", keySource: "platform" },
    authorize: { sufficient: true, balance_cents: 99999 },
    addCostsResult: { costs: [{ id: "prov-cost-1" }] },
    insertCalls: [],
    updateSetCalls: [],
    addCostsCalls: [],
    authorizeCalls: [],
    updateCostStatusCalls: [],
    enrichApolloCalls: [],
    ...overrides,
  };
}

async function bootEnrich(s: MockState) {
  setupMocks(s);
  const { default: searchRouter } = await import("../../src/routes/search.js");
  const app = express();
  app.use(express.json());
  app.use(searchRouter);
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("/enrich — waterfall provisioning", () => {
  it("AC2: provisions WATERFALL_MAX_CREDITS when no email + waterfall accepted; insert row carries provisionedCostId", async () => {
    const s = defaultState({
      // Pre-populate the polling row so 'email' eventually appears (simulate webhook fired during poll)
      pollEmailRow: { id: "enr-1", email: "found@x.com", waterfallStatus: "completed", apolloPersonId: "ap-1" },
    });
    const app = await bootEnrich(s);

    const res = await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(200);

    // Provisioned cost added with qty=20
    const provisionedCall = s.addCostsCalls.find(
      (c) => Array.isArray(c[1]) && c[1][0]?.status === "provisioned",
    );
    expect(provisionedCall).toBeTruthy();
    expect(provisionedCall![1][0]).toMatchObject({
      costName: "apollo-credit",
      costSource: "platform",
      quantity: 20,
      status: "provisioned",
    });

    // Insert row carries provisionedCostId
    const enrichInsert = s.insertCalls.find((c) => c.apolloPersonId === "ap-1");
    expect(enrichInsert?.provisionedCostId).toBe("prov-cost-1");
    expect(enrichInsert?.waterfallStatus).toBe("pending");
    expect(enrichInsert?.waterfallRequestId).toBe("wf-req-1");

    // Provisioned cost was cancelled when poll resolved with email
    expect(s.updateCostStatusCalls.some((c) => c[2] === "cancelled")).toBe(true);

    // Final response carries the polled email
    expect(res.body.person.email).toBe("found@x.com");
    expect(res.body.cached).toBe(false);
  });
});

describe("/enrich — polling resolution paths", () => {
  it("AC3a: poll resolves with email → cancel provisioned, return person with email", async () => {
    const s = defaultState({
      pollEmailRow: { id: "enr-1", email: "found@x.com", waterfallStatus: "completed", apolloPersonId: "ap-1" },
    });
    const app = await bootEnrich(s);

    const res = await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(200);

    expect(s.updateCostStatusCalls).toContainEqual([
      "child-run-1",
      "prov-cost-1",
      "cancelled",
      expect.any(Object),
    ]);
    expect(res.body.person.email).toBe("found@x.com");
  });

  it("AC3b: poll resolves no email (waterfallStatus=failed) → cancel provisioned, person:null", async () => {
    const s = defaultState({
      pollEmailRow: { id: "enr-1", email: null, waterfallStatus: "failed", apolloPersonId: "ap-1" },
    });
    const app = await bootEnrich(s);

    const res = await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(200);

    expect(s.updateCostStatusCalls).toContainEqual([
      "child-run-1",
      "prov-cost-1",
      "cancelled",
      expect.any(Object),
    ]);
    expect(res.body.person).toBeNull();
    // No "actual" cost added directly (webhook would add 0)
    const actualCalls = s.addCostsCalls.filter(
      (c) => Array.isArray(c[1]) && c[1][0]?.status === "actual",
    );
    expect(actualCalls).toHaveLength(0);
  });

  it("AC3c: poll timeout → 504, row marked timeout, run failed, cost stays provisioned", async () => {
    const s = defaultState({ pollEmailRow: null });
    const app = await bootEnrich(s);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(504);

    expect(res.body.type).toBe("waterfall_timeout");
    expect(res.body.enrichmentId).toBe("enr-1");

    // Row marked "timeout"
    const timeoutSet = s.updateSetCalls.find((c) => c.waterfallStatus === "timeout");
    expect(timeoutSet).toBeTruthy();

    // Provisioned cost NOT cancelled (webhook will reconcile)
    expect(s.updateCostStatusCalls).toHaveLength(0);

    errorSpy.mockRestore();
  });
});

describe("/enrich — credit authorization", () => {
  it("AC1: authorize uses WATERFALL_MAX_CREDITS quantity (not 1)", async () => {
    const s = defaultState({
      pollEmailRow: { id: "enr-1", email: "x@y.com", waterfallStatus: "completed", apolloPersonId: "ap-1" },
    });
    const app = await bootEnrich(s);

    await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(200);

    expect(s.authorizeCalls).toHaveLength(1);
    expect(s.authorizeCalls[0][0]).toMatchObject({
      items: [{ costName: "apollo-credit", quantity: 20 }],
    });
  });

  it("AC1: insufficient credit (<20) → 402, no Apollo call, no provisioned cost", async () => {
    const s = defaultState({
      authorize: { sufficient: false, balance_cents: 50, required_cents: 2000 },
    });
    const app = await bootEnrich(s);

    const res = await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(402);

    expect(res.body.type).toBe("credit_insufficient");
    expect(s.enrichApolloCalls).toHaveLength(0);
    expect(s.addCostsCalls).toHaveLength(0);
  });

  it("AC8: BYOK key skips authorize but still provisions cost with costSource=org", async () => {
    const s = defaultState({
      decryptKey: { key: "byok-key", keySource: "org" },
      pollEmailRow: { id: "enr-1", email: "x@y.com", waterfallStatus: "completed", apolloPersonId: "ap-1" },
    });
    const app = await bootEnrich(s);

    await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(200);

    expect(s.authorizeCalls).toHaveLength(0);
    const provisionedCall = s.addCostsCalls.find(
      (c) => Array.isArray(c[1]) && c[1][0]?.status === "provisioned",
    );
    expect(provisionedCall![1][0]).toMatchObject({
      costSource: "org",
      quantity: 20,
      status: "provisioned",
    });
  });
});

describe("/enrich — negative cache + lazy cleanup", () => {
  it("AC4: cache hit on negative recent (email null, status=failed, <24h) → no Apollo call, returns null person", async () => {
    const recentDate = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const s = defaultState({
      cachedRows: [
        // First lookup (positive) returns nothing
        // Second lookup (negative) returns a recent failed row
        null as any,
        {
          id: "enr-old",
          apolloPersonId: "ap-1",
          email: null,
          waterfallStatus: "failed",
          createdAt: recentDate,
          orgId: "org-1",
        },
      ],
    });
    const app = await bootEnrich(s);

    const res = await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(200);

    expect(s.enrichApolloCalls).toHaveLength(0);
    expect(res.body.cached).toBe(true);
    expect(res.body.person).toBeNull();
  });

  it("AC5: cache hit on stale pending (>24h) → cleanup reconciles costs + marks row expired, response is cached null", async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    const s = defaultState({
      cachedRows: [
        null as any,
        {
          id: "enr-stale",
          apolloPersonId: "ap-1",
          email: null,
          waterfallStatus: "pending",
          waterfallRequestId: "wf-stale",
          provisionedCostId: "prov-stale",
          enrichmentRunId: "stale-run",
          keySource: "platform",
          createdAt: oldDate,
          orgId: "org-1",
          brandIds: ["b1"],
          campaignId: "c1",
        },
      ],
    });
    const app = await bootEnrich(s);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(200);

    // Cleanup: cancel old provisioned cost
    expect(s.updateCostStatusCalls).toContainEqual([
      "stale-run",
      "prov-stale",
      "cancelled",
      expect.any(Object),
    ]);
    // Cleanup: add WATERFALL_MAX_CREDITS actual
    const actualCleanup = s.addCostsCalls.find(
      (c) => Array.isArray(c[1]) && c[1][0]?.status === "actual" && c[1][0]?.quantity === 20,
    );
    expect(actualCleanup).toBeTruthy();
    expect(actualCleanup![0]).toBe("stale-run");
    // Cleanup: mark expired
    const expiredSet = s.updateSetCalls.find((c) => c.waterfallStatus === "expired");
    expect(expiredSet).toBeTruthy();

    // Response: treat the post-cleanup row as a negative cache hit, no fresh Apollo call.
    expect(s.enrichApolloCalls).toHaveLength(0);
    expect(res.body.cached).toBe(true);
    expect(res.body.person).toBeNull();

    errorSpy.mockRestore();
  });
});
