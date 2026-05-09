import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for the audit-driven fixes:
 *  T1 — runs-client AbortController + RunsServiceError typed
 *  T2 — drop swallow patterns (match TTL cleanup, webhook reconciliation)
 *  T3 — /match poll timeout marks waterfallStatus='timeout' before 504; webhook reconciles timeout rows
 *  T4 — /enrich returns `cached` flag (true on cache hit, false on miss)
 *  T5 — discriminated error responses (type field on every 4xx/5xx)
 */

// ─── T1: runs-client typed error ──────────────────────────────────────────────

describe("T1 — RunsServiceError", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws RunsServiceError with kind=timeout when fetch is aborted", async () => {
    process.env.RUNS_SERVICE_TIMEOUT_MS = "10";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as Error).name = "AbortError";
          reject(err);
        });
      });
    }));

    const { createRun, RunsServiceError } = await import("../../src/lib/runs-client.js");

    await expect(
      createRun({ orgId: "o", serviceName: "apollo-service", taskName: "t" })
    ).rejects.toMatchObject({
      name: "RunsServiceError",
      kind: "timeout",
    });

    // Also verify it is the typed class, not just a generic Error
    await expect(
      createRun({ orgId: "o", serviceName: "apollo-service", taskName: "t" })
    ).rejects.toBeInstanceOf(RunsServiceError);
  });

  it("throws RunsServiceError with kind=http on 500", async () => {
    process.env.RUNS_SERVICE_TIMEOUT_MS = "5000";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    const { createRun, RunsServiceError } = await import("../../src/lib/runs-client.js");

    const err = await createRun({ orgId: "o", serviceName: "apollo-service", taskName: "t" }).catch(e => e);
    expect(err).toBeInstanceOf(RunsServiceError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(500);
  });

  it("joins brandIds to a CSV x-brand-id header at the runs-service boundary", async () => {
    process.env.RUNS_SERVICE_TIMEOUT_MS = "5000";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "r-1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { addCosts } = await import("../../src/lib/runs-client.js");
    await addCosts("run-1", [], { orgId: "o", brandIds: ["b1", "b2", "b3"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-brand-id"]).toBe("b1,b2,b3");
  });
});

// ─── T2 + T3: webhook 5xx on reconciliation fail + timeout rows reconciled ────

describe("T2/T3 — webhook reconciliation + timeout handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns 5xx when cost reconciliation throws (so Apollo retries)", async () => {
    process.env.APOLLO_WATERFALL_WEBHOOK_SECRET = "secret-1";

    const mockUpdateCostStatus = vi.fn().mockRejectedValue(new Error("runs-service down"));
    const mockAddCosts = vi.fn();

    vi.doMock("../../src/lib/runs-client.js", () => ({
      addCosts: (...args: unknown[]) => mockAddCosts(...args),
      updateCostStatus: (...args: unknown[]) => mockUpdateCostStatus(...args),
    }));

    const enrichmentRow = {
      id: "enr-1",
      orgId: "org-1",
      apolloPersonId: "p-1",
      brandIds: ["b1"],
      campaignId: "c1",
      enrichmentRunId: "match-run-1",
      provisionedCostId: "prov-cost-1",
      keySource: "platform",
      waterfallStatus: "pending",
    };

    vi.doMock("../../src/db/index.js", () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([enrichmentRow]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      },
    }));

    vi.doMock("../../src/db/schema.js", () => ({
      apolloPeopleEnrichments: {
        id: { name: "id" },
        waterfallRequestId: { name: "waterfall_request_id" },
        waterfallStatus: { name: "waterfall_status" },
      },
    }));

    const { default: webhookRouter } = await import("../../src/routes/webhook.js");
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf.toString(); } }));
    app.use(webhookRouter);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await request(app)
      .post("/webhook/waterfall?secret=secret-1")
      .send({
        status: "ok",
        request_id: 12345,
        people: [{ id: "p-1", emails: [{ email: "x@y.com", email_status: "verified" }] }],
        credits_consumed: 5,
      })
      .expect(500);

    errorSpy.mockRestore();
  });

  it("webhook reconciles timeout rows (not just pending)", async () => {
    process.env.APOLLO_WATERFALL_WEBHOOK_SECRET = "secret-1";

    const mockUpdateCostStatus = vi.fn().mockResolvedValue({});
    const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

    vi.doMock("../../src/lib/runs-client.js", () => ({
      addCosts: (...args: unknown[]) => mockAddCosts(...args),
      updateCostStatus: (...args: unknown[]) => mockUpdateCostStatus(...args),
    }));

    const timeoutRow = {
      id: "enr-1",
      orgId: "org-1",
      apolloPersonId: "p-1",
      brandIds: ["b1"],
      campaignId: "c1",
      enrichmentRunId: "match-run-1",
      provisionedCostId: "prov-cost-1",
      keySource: "platform",
      waterfallStatus: "timeout",
    };

    vi.doMock("../../src/db/index.js", () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([timeoutRow]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      },
    }));

    vi.doMock("../../src/db/schema.js", () => ({
      apolloPeopleEnrichments: {
        id: { name: "id" },
        waterfallRequestId: { name: "waterfall_request_id" },
        waterfallStatus: { name: "waterfall_status" },
      },
    }));

    const { default: webhookRouter } = await import("../../src/routes/webhook.js");
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf.toString(); } }));
    app.use(webhookRouter);

    const res = await request(app)
      .post("/webhook/waterfall?secret=secret-1")
      .send({
        status: "ok",
        request_id: 12345,
        people: [{ id: "p-1", emails: [{ email: "late@y.com", email_status: "verified" }] }],
        credits_consumed: 7,
      })
      .expect(200);

    expect(res.body.updated).toBe(1);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("match-run-1", "prov-cost-1", "cancelled", expect.any(Object));
    expect(mockAddCosts).toHaveBeenCalledWith(
      "match-run-1",
      [{ costName: "apollo-credit", costSource: "platform", quantity: 7, status: "actual" }],
      expect.any(Object),
    );
  });
});

// ─── T3: /match polling timeout sets waterfallStatus='timeout' ────────────────

describe("T3 — /match poll timeout marks waterfallStatus='timeout'", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("sets waterfallStatus='timeout' on the enrichment row before returning 504", async () => {
    process.env.WATERFALL_POLL_INTERVAL_MS = "10";
    process.env.WATERFALL_POLL_TIMEOUT_MS = "30";

    let updateSetSpy: ReturnType<typeof vi.fn> | null = null;

    vi.doMock("../../src/lib/runs-client.js", () => ({
      createRun: vi.fn().mockResolvedValue({ id: "match-run-1" }),
      updateRun: vi.fn().mockResolvedValue({}),
      addCosts: vi.fn().mockResolvedValue({ costs: [{ id: "prov-1" }] }),
      updateCostStatus: vi.fn().mockResolvedValue({}),
    }));

    vi.doMock("../../src/lib/keys-client.js", () => ({
      decryptKey: vi.fn().mockResolvedValue({ key: "fake", keySource: "platform" }),
    }));

    vi.doMock("../../src/lib/billing-client.js", () => ({
      authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
    }));

    vi.doMock("../../src/lib/apollo-client.js", () => ({
      matchPersonByName: vi.fn().mockResolvedValue({
        person: { id: "p-1", first_name: "John", last_name: "Doe", email: null, email_status: null, organization: { id: "o", primary_domain: "acme.com" } },
        waterfall: { status: "accepted" },
        request_id: "req-1",
      }),
      buildWaterfallWebhookUrl: () => undefined,
    }));

    vi.doMock("../../src/middleware/auth.js", () => ({
      serviceAuth: (req: any, _res: any, next: any) => {
        req.orgId = "org-1";
        req.userId = "user-1";
        req.runId = "run-1";
        req.brandIds = ["b1"];
        req.campaignId = "c1";
        next();
      },
    }));

    vi.doMock("../../src/db/schema.js", () => ({
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

    updateSetSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

    vi.doMock("../../src/db/index.js", () => ({
      db: {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "enr-1" }]),
          }),
        }),
        update: vi.fn().mockReturnValue({ set: updateSetSpy }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
              limit: vi.fn().mockResolvedValue([{ id: "enr-1", email: null, waterfallStatus: "pending" }]),
            }),
          }),
        }),
      },
    }));

    const { default: matchRouter } = await import("../../src/routes/match.js");
    const app = express();
    app.use(express.json());
    app.use(matchRouter);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/match")
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(504);

    expect(res.body.type).toBe("waterfall_timeout");
    expect(res.body.enrichmentId).toBe("enr-1");

    // The route must call db.update().set({ waterfallStatus: "timeout" }) BEFORE responding 504
    expect(updateSetSpy).toHaveBeenCalledWith({ waterfallStatus: "timeout" });
    errorSpy.mockRestore();
  });
});

// ─── T4: /enrich `cached` flag ────────────────────────────────────────────────

describe("T4 — /enrich cached flag", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns cached:true on a 12-month cache hit", async () => {
    vi.doMock("../../src/lib/runs-client.js", () => ({
      createRun: vi.fn().mockResolvedValue({ id: "child-run" }),
      updateRun: vi.fn().mockResolvedValue({}),
      addCosts: vi.fn().mockResolvedValue({ costs: [] }),
    }));
    vi.doMock("../../src/lib/keys-client.js", () => ({
      decryptKey: vi.fn().mockResolvedValue({ key: "fake", keySource: "platform" }),
    }));
    vi.doMock("../../src/lib/billing-client.js", () => ({
      authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
    }));
    vi.doMock("../../src/lib/apollo-client.js", () => ({
      enrichPerson: vi.fn(),
      searchPeople: vi.fn(),
      buildWaterfallWebhookUrl: () => undefined,
    }));
    vi.doMock("../../src/middleware/auth.js", () => ({
      serviceAuth: (req: any, _res: any, next: any) => {
        req.orgId = "org-1"; req.userId = "user-1"; req.runId = "run-1";
        req.brandIds = ["b1"]; req.campaignId = "c1";
        next();
      },
    }));
    vi.doMock("../../src/lib/transform.js", () => ({
      transformApolloPerson: (p: any) => ({ id: p.id }),
      toEnrichmentDbValues: (p: any) => ({ apolloPersonId: p.id }),
      transformCachedEnrichment: (id: string) => ({ id, email: "cached@x.com" }),
      toApolloSearchParams: (p: any) => p,
    }));
    vi.doMock("../../src/db/schema.js", () => ({
      apolloPeopleEnrichments: {
        id: { name: "id" }, apolloPersonId: { name: "apollo_person_id" }, email: { name: "email" }, createdAt: { name: "created_at" },
      },
      apolloPeopleSearches: { id: { name: "id" } },
      apolloSearchCursors: { id: { name: "id" }, orgId: { name: "org_id" }, campaignId: { name: "campaign_id" } },
    }));
    vi.doMock("../../src/db/index.js", () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: "cached-1", apolloPersonId: "ap-1", email: "cached@x.com", createdAt: new Date() }]),
              }),
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        query: { apolloPeopleSearches: { findMany: vi.fn() }, apolloPeopleEnrichments: { findMany: vi.fn() } },
      },
    }));

    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = express();
    app.use(express.json());
    app.use(searchRouter);

    const res = await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(200);

    expect(res.body.cached).toBe(true);
    expect(res.body.enrichmentId).toBeNull();
  });

  it("returns cached:false on cache miss", async () => {
    vi.doMock("../../src/lib/runs-client.js", () => ({
      createRun: vi.fn().mockResolvedValue({ id: "child-run" }),
      updateRun: vi.fn().mockResolvedValue({}),
      addCosts: vi.fn().mockResolvedValue({ costs: [] }),
    }));
    vi.doMock("../../src/lib/keys-client.js", () => ({
      decryptKey: vi.fn().mockResolvedValue({ key: "fake", keySource: "platform" }),
    }));
    vi.doMock("../../src/lib/billing-client.js", () => ({
      authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
    }));
    vi.doMock("../../src/lib/apollo-client.js", () => ({
      enrichPerson: vi.fn().mockResolvedValue({
        person: { id: "ap-1", first_name: "Jane", last_name: "Doe", email: "jane@x.com", email_status: "verified" },
      }),
      searchPeople: vi.fn(),
      buildWaterfallWebhookUrl: () => undefined,
    }));
    vi.doMock("../../src/middleware/auth.js", () => ({
      serviceAuth: (req: any, _res: any, next: any) => {
        req.orgId = "org-1"; req.userId = "user-1"; req.runId = "run-1";
        req.brandIds = ["b1"]; req.campaignId = "c1";
        next();
      },
    }));
    vi.doMock("../../src/lib/transform.js", () => ({
      transformApolloPerson: (p: any) => ({ id: p.id, email: p.email }),
      toEnrichmentDbValues: (p: any) => ({ apolloPersonId: p.id, email: p.email }),
      transformCachedEnrichment: vi.fn(),
      toApolloSearchParams: (p: any) => p,
    }));
    vi.doMock("../../src/lib/validators.js", () => ({
      assertKeySource: vi.fn(),
    }));
    vi.doMock("../../src/db/schema.js", () => ({
      apolloPeopleEnrichments: {
        id: { name: "id" }, apolloPersonId: { name: "apollo_person_id" }, email: { name: "email" }, createdAt: { name: "created_at" },
      },
      apolloPeopleSearches: { id: { name: "id" } },
      apolloSearchCursors: { id: { name: "id" }, orgId: { name: "org_id" }, campaignId: { name: "campaign_id" } },
    }));
    vi.doMock("../../src/db/index.js", () => ({
      db: {
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
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "enr-1" }]),
          }),
        }),
        update: vi.fn(),
        query: { apolloPeopleSearches: { findMany: vi.fn() }, apolloPeopleEnrichments: { findMany: vi.fn() } },
      },
    }));

    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = express();
    app.use(express.json());
    app.use(searchRouter);

    const res = await request(app)
      .post("/enrich")
      .send({ apolloPersonId: "ap-1" })
      .expect(200);

    expect(res.body.cached).toBe(false);
    expect(res.body.enrichmentId).toBe("enr-1");
  });
});

// ─── T5: discriminated error responses ────────────────────────────────────────

describe("T5 — error responses include `type` discriminator", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("400 validation error has type=validation", async () => {
    vi.doMock("../../src/lib/runs-client.js", () => ({
      createRun: vi.fn(), updateRun: vi.fn(), addCosts: vi.fn(), updateCostStatus: vi.fn(),
    }));
    vi.doMock("../../src/lib/keys-client.js", () => ({ decryptKey: vi.fn() }));
    vi.doMock("../../src/lib/billing-client.js", () => ({ authorizeCredit: vi.fn() }));
    vi.doMock("../../src/lib/apollo-client.js", () => ({
      matchPersonByName: vi.fn(), buildWaterfallWebhookUrl: () => undefined,
    }));
    vi.doMock("../../src/middleware/auth.js", () => ({
      serviceAuth: (req: any, _res: any, next: any) => {
        req.orgId = "o"; req.userId = "u"; req.runId = "r"; req.brandIds = ["b"]; req.campaignId = "c";
        next();
      },
    }));
    vi.doMock("../../src/db/schema.js", () => ({ apolloPeopleEnrichments: {} }));
    vi.doMock("../../src/db/index.js", () => ({ db: {} }));

    const { default: matchRouter } = await import("../../src/routes/match.js");
    const app = express();
    app.use(express.json());
    app.use(matchRouter);

    const res = await request(app)
      .post("/match")
      .send({ lastName: "Doe", organizationDomain: "x.com" }) // missing firstName
      .expect(400);

    expect(res.body.type).toBe("validation");
    expect(res.body.error).toBe("Invalid request");
  });

  it("402 insufficient credit has type=credit_insufficient with balance_cents", async () => {
    vi.doMock("../../src/lib/runs-client.js", () => ({
      createRun: vi.fn(), updateRun: vi.fn(), addCosts: vi.fn(), updateCostStatus: vi.fn(),
    }));
    vi.doMock("../../src/lib/keys-client.js", () => ({
      decryptKey: vi.fn().mockResolvedValue({ key: "fake", keySource: "platform" }),
    }));
    vi.doMock("../../src/lib/billing-client.js", () => ({
      authorizeCredit: vi.fn().mockResolvedValue({ sufficient: false, balance_cents: 5, required_cents: 100 }),
    }));
    vi.doMock("../../src/lib/apollo-client.js", () => ({
      matchPersonByName: vi.fn(), buildWaterfallWebhookUrl: () => undefined,
    }));
    vi.doMock("../../src/middleware/auth.js", () => ({
      serviceAuth: (req: any, _res: any, next: any) => {
        req.orgId = "o"; req.userId = "u"; req.runId = "r"; req.brandIds = ["b"]; req.campaignId = "c";
        next();
      },
    }));
    vi.doMock("../../src/db/schema.js", () => ({
      apolloPeopleEnrichments: {
        id: {}, firstName: {}, lastName: {}, organizationDomain: {}, email: {}, createdAt: {},
      },
    }));
    vi.doMock("../../src/db/index.js", () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      },
    }));
    vi.doMock("../../src/lib/validators.js", () => ({ assertKeySource: vi.fn() }));

    const { default: matchRouter } = await import("../../src/routes/match.js");
    const app = express();
    app.use(express.json());
    app.use(matchRouter);

    const res = await request(app)
      .post("/match")
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "x.com" })
      .expect(402);

    expect(res.body.type).toBe("credit_insufficient");
    expect(res.body.balance_cents).toBe(5);
    expect(res.body.required_cents).toBe(100);
  });
});
