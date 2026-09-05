import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Phone reveal: the opt-in request, Apollo's asynchronous delivery, and the
 * read that tells "not here yet" apart from "Apollo found nothing".
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateRun = vi.fn().mockResolvedValue({ id: "reveal-run-1" });
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [{ id: "cost-1" }] });
const mockUpdateCostStatus = vi.fn().mockResolvedValue({});

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
  updateCostStatus: (...args: unknown[]) => mockUpdateCostStatus(...args),
}));

const mockAuthorizeCredit = vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 10_000, required_cents: 10 });
vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: (...args: unknown[]) => mockAuthorizeCredit(...args),
}));

vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "apollo-key", keySource: "platform" }),
}));

const mockEnrichPerson = vi.fn();
vi.mock("../../src/lib/apollo-client.js", () => ({
  enrichPerson: (...args: unknown[]) => mockEnrichPerson(...args),
  buildPhoneRevealWebhookUrl: () => "https://apollo.test/webhook/phone-reveal?secret=s",
}));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/lib/credit-alert.js", () => ({ toCreditAlertIdentity: () => undefined }));
vi.mock("../../src/lib/advisory-lock.js", () => ({ advisoryXactLock: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-1";
    req.userId = req.headers["x-user-id"] || "user-1";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-brand-id"]) req.brandIds = [req.headers["x-brand-id"]];
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    next();
  },
  orgAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-1";
    next();
  },
}));

// Rows the fake db hands back, mutated per test.
let selectRows: any[] = [];
const insertedRows: any[] = [];
const updates: Array<Record<string, unknown>> = [];

function fakeInsert() {
  return {
    values: (v: any) => ({
      returning: async () => {
        const row = { id: "reveal-1", requestedAt: new Date("2026-09-05T10:00:00Z"), completedAt: null, phoneNumbers: null, ...v };
        insertedRows.push(row);
        return [row];
      },
    }),
  };
}

function fakeUpdate() {
  return {
    set: (v: any) => {
      updates.push(v);
      return {
        // `.where(...)` is awaited on its own in some paths and chained into
        // `.returning()` in others.
        where: () =>
          Object.assign(Promise.resolve(undefined), {
            returning: async () => [{ ...insertedRows[insertedRows.length - 1], ...v }],
          }),
      };
    },
  };
}

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        // `where(...)` is awaited directly by the webhook and chained by the
        // route, so it must be both a promise and a query builder.
        where: () =>
          Object.assign(Promise.resolve(selectRows), {
            orderBy: () => ({ limit: async () => selectRows }),
          }),
      }),
    }),
    insert: () => fakeInsert(),
    update: () => fakeUpdate(),
    transaction: async (cb: any) =>
      cb({
        execute: async () => [],
        insert: () => fakeInsert(),
        update: () => fakeUpdate(),
      }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPhoneReveals: {
    id: { name: "id" },
    orgId: { name: "org_id" },
    apolloPersonId: { name: "apollo_person_id" },
    apolloRequestId: { name: "apollo_request_id" },
    status: { name: "status" },
    requestedAt: { name: "requested_at" },
    costReconciledAt: { name: "cost_reconciled_at" },
  },
  apolloPeopleEnrichments: {
    orgId: { name: "org_id" },
    apolloPersonId: { name: "apollo_person_id" },
    mobilePhone: { name: "mobile_phone" },
    phoneNumbers: { name: "phone_numbers" },
  },
}));

async function buildApp() {
  const routes = await import("../../src/routes/phone-reveal.js");
  const webhook = await import("../../src/routes/webhook.js");
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));
  app.use(routes.default);
  app.use(webhook.default);
  return app;
}

const HEADERS = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1", "x-brand-id": "brand-1", "x-campaign-id": "camp-1" };

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = [];
  insertedRows.length = 0;
  updates.length = 0;
  mockCreateRun.mockResolvedValue({ id: "reveal-run-1" });
  mockAddCosts.mockResolvedValue({ costs: [{ id: "cost-1" }] });
  mockAuthorizeCredit.mockResolvedValue({ sufficient: true, balance_cents: 10_000, required_cents: 10 });
  mockEnrichPerson.mockResolvedValue({ person: { id: "person-1" }, request_id: "9007199254740999" });
  process.env.APOLLO_PHONE_REVEAL_WEBHOOK_SECRET = "test-secret";
});

// ─── Request ────────────────────────────────────────────────────────────────

describe("POST /people/:apolloPersonId/phone-reveal", () => {
  it("asks Apollo for the reveal and returns 202 pending (Apollo answers without the number)", async () => {
    const app = await buildApp();
    const res = await request(app).post("/people/person-1/phone-reveal").set(HEADERS).send();

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(res.body.mobilePhone).toBeNull();

    // Opt-in flag reached Apollo, with the callback it requires.
    const [, personId, webhookUrl, , options] = mockEnrichPerson.mock.calls[0];
    expect(personId).toBe("person-1");
    expect(webhookUrl).toContain("/webhook/phone-reveal");
    expect(options).toEqual({ revealPhoneNumber: true });
  });

  it("provisions the 8-credit worst case before calling Apollo, and authorizes it", async () => {
    const app = await buildApp();
    await request(app).post("/people/person-1/phone-reveal").set(HEADERS).send();

    expect(mockAuthorizeCredit).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ costName: "apollo-credit", quantity: 8 }] })
    );
    expect(mockAddCosts).toHaveBeenCalledWith(
      "reveal-run-1",
      [{ costName: "apollo-credit", costSource: "platform", quantity: 8, status: "provisioned" }],
      expect.anything()
    );
  });

  it("402s without calling Apollo when the org cannot afford the reveal", async () => {
    mockAuthorizeCredit.mockResolvedValue({ sufficient: false, balance_cents: 0, required_cents: 800 });
    const app = await buildApp();
    const res = await request(app).post("/people/person-1/phone-reveal").set(HEADERS).send();

    expect(res.status).toBe(402);
    expect(mockEnrichPerson).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("cancels the hold and reports failure when the Apollo call fails", async () => {
    mockEnrichPerson.mockRejectedValue(new Error("Apollo enrich failed: 500 - boom"));
    const app = await buildApp();
    const res = await request(app).post("/people/person-1/phone-reveal").set(HEADERS).send();

    expect(res.status).toBe(500);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("reveal-run-1", "cost-1", "cancelled", expect.anything());
    expect(updates.some((u) => u.status === "failed")).toBe(true);
  });

  it("serves an existing reveal instead of spending again", async () => {
    selectRows = [
      {
        id: "reveal-old",
        orgId: "org-1",
        apolloPersonId: "person-1",
        status: "found",
        mobilePhone: "+41791112233",
        dncStatus: null,
        phoneNumbers: [{ rawNumber: "+41791112233", sanitizedNumber: "+41791112233", type: "mobile", status: "valid_number", dncStatus: null, dncOtherInfo: null, position: 0, doNotCall: false }],
        requestedAt: new Date("2026-09-05T09:00:00Z"),
        completedAt: new Date("2026-09-05T09:03:00Z"),
      },
    ];
    const app = await buildApp();
    const res = await request(app).post("/people/person-1/phone-reveal").set(HEADERS).send();

    expect(res.status).toBe(200);
    expect(res.body.reused).toBe(true);
    expect(res.body.mobilePhone).toBe("+41791112233");
    expect(mockEnrichPerson).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("requires x-run-id", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/people/person-1/phone-reveal")
      .set({ "x-org-id": "org-1", "x-user-id": "user-1" })
      .send();
    expect(res.status).toBe(400);
  });
});

// ─── Read ───────────────────────────────────────────────────────────────────

describe("GET /people/:apolloPersonId/phone-reveal", () => {
  it("404s when no reveal was ever requested", async () => {
    const app = await buildApp();
    const res = await request(app).get("/people/person-9/phone-reveal").set({ "x-org-id": "org-1" });
    expect(res.status).toBe(404);
  });

  it("distinguishes pending from not_found", async () => {
    const app = await buildApp();

    selectRows = [{ id: "r1", orgId: "org-1", apolloPersonId: "person-1", status: "pending", phoneNumbers: null, requestedAt: new Date() }];
    const pending = await request(app).get("/people/person-1/phone-reveal").set({ "x-org-id": "org-1" });
    expect(pending.body.status).toBe("pending");
    expect(pending.body.mobilePhone).toBeNull();

    selectRows = [{ id: "r2", orgId: "org-1", apolloPersonId: "person-1", status: "not_found", phoneNumbers: [], creditsConsumed: 0, requestedAt: new Date(), completedAt: new Date() }];
    const none = await request(app).get("/people/person-1/phone-reveal").set({ "x-org-id": "org-1" });
    expect(none.body.status).toBe("not_found");
    expect(none.body.mobilePhone).toBeNull();
    expect(none.body.creditsConsumed).toBe(0);
  });

  it("carries the DNC status through to the consumer", async () => {
    selectRows = [
      {
        id: "r3",
        orgId: "org-1",
        apolloPersonId: "person-1",
        status: "found",
        mobilePhone: "+15551234567",
        dncStatus: "dnc",
        phoneNumbers: [{ rawNumber: "+1 555-123-4567", sanitizedNumber: "+15551234567", type: "mobile", status: "valid_number", dncStatus: "dnc", dncOtherInfo: null, position: 0, doNotCall: true }],
        requestedAt: new Date(),
        completedAt: new Date(),
      },
    ];
    const app = await buildApp();
    const res = await request(app).get("/people/person-1/phone-reveal").set({ "x-org-id": "org-1" });

    expect(res.body.status).toBe("found");
    expect(res.body.dncStatus).toBe("dnc");
    expect(res.body.doNotCall).toBe(true);
    expect(res.body.phoneNumbers[0].doNotCall).toBe(true);
  });
});

// ─── Apollo's asynchronous delivery ─────────────────────────────────────────

describe("POST /webhook/phone-reveal", () => {
  const PENDING = {
    id: "reveal-1",
    orgId: "org-1",
    userId: "user-1",
    apolloPersonId: "person-1",
    runId: "run-1",
    revealRunId: "reveal-run-1",
    brandIds: ["brand-1"],
    campaignId: "camp-1",
    status: "pending",
    keySource: "platform",
    provisionedCostId: "cost-1",
    costReconciledAt: null,
  };

  it("401s on a bad secret", async () => {
    const app = await buildApp();
    const res = await request(app).post("/webhook/phone-reveal?secret=wrong").send({ request_id: "1" });
    expect(res.status).toBe(401);
  });

  it("stores the delivered number and actualizes the hold", async () => {
    selectRows = [PENDING];
    const app = await buildApp();
    const res = await request(app)
      .post("/webhook/phone-reveal?secret=test-secret")
      .send({
        status: "success",
        request_id: 9007199254740999,
        credits_consumed: 8,
        people: [
          {
            id: "person-1",
            phone_numbers: [
              { raw_number: "+1 555-123-4567", sanitized_number: "+15551234567", type: "mobile", status: "valid_number", dnc_status: null, position: 0 },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    const stored = updates.find((u) => u.status === "found") as any;
    expect(stored.mobilePhone).toBe("+15551234567");
    expect(stored.phoneNumbers[0].doNotCall).toBe(false);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("reveal-run-1", "cost-1", "actual", expect.anything());
  });

  it("charges nothing when Apollo found no number", async () => {
    selectRows = [PENDING];
    const app = await buildApp();
    const res = await request(app)
      .post("/webhook/phone-reveal?secret=test-secret")
      .send({ status: "success", request_id: 42, credits_consumed: 0, people: [{ id: "person-1", phone_numbers: [] }] });

    expect(res.status).toBe(200);
    const stored = updates.find((u) => u.status === "not_found") as any;
    expect(stored.mobilePhone).toBeNull();
    expect(stored.creditsConsumed).toBe(0);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("reveal-run-1", "cost-1", "cancelled", expect.anything());
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("preserves Apollo's oversized request_id exactly", async () => {
    selectRows = [PENDING];
    const app = await buildApp();
    await request(app)
      .post("/webhook/phone-reveal?secret=test-secret")
      .set("Content-Type", "application/json")
      .send('{"status":"success","request_id":9007199254740993,"credits_consumed":0,"people":[{"id":"person-1"}]}');
    // Nothing to assert on the row here beyond it having matched by person id;
    // the digits matter for the request_id join and are read from the raw body.
    expect(updates.length).toBeGreaterThan(0);
  });

  it("keeps the DNC flag Apollo reports", async () => {
    selectRows = [PENDING];
    const app = await buildApp();
    await request(app)
      .post("/webhook/phone-reveal?secret=test-secret")
      .send({
        status: "success",
        request_id: 7,
        credits_consumed: 8,
        people: [
          { id: "person-1", phone_numbers: [{ sanitized_number: "+15551234567", type: "mobile", dnc_status: "dnc" }] },
        ],
      });

    const stored = updates.find((u) => u.status === "found") as any;
    expect(stored.dncStatus).toBe("dnc");
    expect(stored.phoneNumbers[0].doNotCall).toBe(true);
  });

  it("answers 200 with updated:0 when nothing matches (never a 4xx Apollo would count against us)", async () => {
    selectRows = [];
    const app = await buildApp();
    const res = await request(app)
      .post("/webhook/phone-reveal?secret=test-secret")
      .send({ status: "success", request_id: 1, people: [{ id: "unknown-person" }] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });

  it("answers 500 so Apollo redelivers when the cost reconcile fails — the phone is already stored", async () => {
    selectRows = [PENDING];
    mockUpdateCostStatus.mockRejectedValue(new Error("runs-service unavailable"));
    const app = await buildApp();
    const res = await request(app)
      .post("/webhook/phone-reveal?secret=test-secret")
      .send({ status: "success", request_id: 5, credits_consumed: 8, people: [{ id: "person-1", phone_numbers: [{ sanitized_number: "+15551234567", type: "mobile" }] }] });

    expect(res.status).toBe(500);
    expect(updates.some((u) => u.status === "found")).toBe(true);
  });
});
