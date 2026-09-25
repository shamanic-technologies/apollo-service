import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * treg.to + Explee email finders: bronze on every call, one silver finding per
 * (vendor, preset, person), exact vendor-reported cost, and never paying twice.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn();
const mockAddCosts = vi.fn();
const mockUpdateCostStatus = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  updateRun: (...a: unknown[]) => mockUpdateRun(...a),
  addCosts: (...a: unknown[]) => mockAddCosts(...a),
  updateCostStatus: (...a: unknown[]) => mockUpdateCostStatus(...a),
}));

const mockAuthorizeCredit = vi.fn();
vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: (...a: unknown[]) => mockAuthorizeCredit(...a) }));

const mockDecryptKey = vi.fn();
vi.mock("../../src/lib/keys-client.js", () => ({ decryptKey: (...a: unknown[]) => mockDecryptKey(...a) }));

const mockVerificationFor = vi.fn();
vi.mock("../../src/lib/email-verification.js", () => ({
  EmailVerificationError: class EmailVerificationError extends Error {},
  verificationFor: (...a: unknown[]) => mockVerificationFor(...a),
}));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    next();
  },
  orgAuth: (req: any, _res: any, next: any) => {
    req.orgId = "org-1";
    next();
  },
}));

// A tiny in-memory stand-in for the two tables.
let findings: any[] = [];
let calls: any[] = [];

vi.mock("../../src/db/schema.js", () => ({
  emailFindings: { __t: "findings", id: "id", vendor: "vendor", preset: "preset", personKey: "personKey", status: "status", apolloPersonId: "apolloPersonId" },
  emailFinderCalls: { __t: "calls", id: "id" },
}));

// eq/and build predicates the fake db evaluates.
vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => (row: any) => row[col] === val,
  and: (...preds: Array<(r: any) => boolean>) => (row: any) => preds.every((p) => p(row)),
}));

vi.mock("../../src/db/index.js", () => {
  const tableOf = (t: any) => (t.__t === "findings" ? findings : calls);
  return {
    db: {
      select: () => ({
        from: (t: any) => ({
          where: (pred: (r: any) => boolean) =>
            Object.assign(Promise.resolve(tableOf(t).filter(pred)), {
              limit: async (n: number) => tableOf(t).filter(pred).slice(0, n),
            }),
        }),
      }),
      insert: (t: any) => ({
        values: (v: any) => {
          const doInsert = () => {
            const row = { id: `${t.__t}-${tableOf(t).length + 1}`, requestedAt: new Date(), completedAt: null, ...v };
            tableOf(t).push(row);
            return row;
          };
          return {
            returning: async () => [doInsert()],
            onConflictDoNothing: () => ({
              returning: async () => {
                const clash = findings.find((r) => r.vendor === v.vendor && r.preset === v.preset && r.personKey === v.personKey);
                return clash ? [] : [doInsert()];
              },
            }),
          };
        },
      }),
      update: (t: any) => ({
        set: (v: any) => ({
          where: (pred: (r: any) => boolean) => {
            const apply = () => {
              const hit = tableOf(t).filter(pred);
              hit.forEach((r) => Object.assign(r, v));
              return hit.map((r) => ({ ...r }));
            };
            return Object.assign(Promise.resolve().then(apply), { returning: async () => apply() });
          },
        }),
      }),
    },
  };
});

const fetchMock = vi.fn();

async function buildApp() {
  const routes = await import("../../src/routes/email-finder.js");
  const app = express();
  app.use(express.json());
  app.use(routes.default);
  return app;
}

const HEADERS = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const PERSON = { apolloPersonId: "ap-1", firstName: "Ada", lastName: "Lovelace", domain: "https://www.example.com/about" };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  vi.clearAllMocks();
  findings = [];
  calls = [];
  mockCreateRun.mockResolvedValue({ id: "find-run-1" });
  mockUpdateRun.mockResolvedValue({});
  mockAddCosts.mockImplementation(async (_run: string, items: any[]) => ({
    costs: [{ id: items[0].status === "provisioned" ? "hold-1" : "actual-1" }],
  }));
  mockUpdateCostStatus.mockResolvedValue({});
  mockAuthorizeCredit.mockResolvedValue({ sufficient: true, balance_cents: 10_000, required_cents: 10 });
  mockDecryptKey.mockResolvedValue({ key: "vendor-key", keySource: "platform" });
  mockVerificationFor.mockImplementation(async (email: string | null) =>
    email ? { email, verdict: "valid", deliverable: true, verifier: "bounceverify", verificationId: "ver-1", verifiedAt: "2026-09-25T00:00:00.000Z", reused: false } : null
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── treg ───────────────────────────────────────────────────────────────────

describe("POST /email-finder/find — treg", () => {
  it("finds, stores bronze + silver, and declares exactly the micro-USD treg reported", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        { output: { email: "ada@example.com", verified: true }, raw: { x: 1 }, _treg: { served_by: "trykitt.people.email.find", charged_micro: 5000 } },
        { "x-treg-cost-micro": "5000", "x-treg-served-by": "trykitt.people.email.find" }
      )
    );
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      vendor: "treg",
      preset: "routed",
      status: "found",
      email: "ada@example.com",
      vendorMailboxStatus: "verified",
      mailboxStatus: "valid",
      underlyingProvider: "trykitt.people.email.find",
      costName: "treg-micro-usd",
      chargedQuantity: 5000,
      reused: false,
    });

    // The vendor call: token header, ceiling, idempotency key, normalised domain.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://treg.to/call/treg.people.email.find");
    expect(init.headers["X-Treg-Token"]).toBe("vendor-key");
    expect(init.headers["X-Treg-Org"]).toBe("vendor-key");
    expect(mockDecryptKey).toHaveBeenCalledWith("org-1", "user-1", "treg-org", expect.anything(), expect.anything());
    expect(init.headers["X-Treg-Route-Max-Cost"]).toBe("0.150000");
    expect(init.headers["Idempotency-Key"]).toMatch(/^apollo-email-find:/);
    expect(JSON.parse(init.body)).toMatchObject({ first_name: "Ada", last_name: "Lovelace", domain: "example.com" });

    // Provision worst case → actual = reported → hold cancelled.
    expect(mockAuthorizeCredit).toHaveBeenCalledWith(expect.objectContaining({ items: [{ costName: "treg-micro-usd", quantity: 150_000 }] }));
    expect(mockAddCosts).toHaveBeenNthCalledWith(
      1,
      "find-run-1",
      [{ costName: "treg-micro-usd", costSource: "platform", quantity: 150_000, status: "provisioned" }],
      expect.anything()
    );
    expect(mockAddCosts).toHaveBeenNthCalledWith(
      2,
      "find-run-1",
      [{ costName: "treg-micro-usd", costSource: "platform", quantity: 5000, status: "actual" }],
      expect.anything()
    );
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("find-run-1", "hold-1", "cancelled", expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("find-run-1", "completed", expect.anything());

    // Bronze: verbatim, with the cost header.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ vendor: "treg", httpStatus: 200, chargedQuantity: "5000", underlyingProvider: "trykitt.people.email.find" });
    expect(calls[0].responseHeaders["x-treg-cost-micro"]).toBe("5000");
    expect(calls[0].responseBody.raw).toEqual({ x: 1 });

    // Silver: one row, keyed on the Apollo person.
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ personKey: "apollo:ap-1", actualCostId: "actual-1", lastCallId: calls[0].id });
  });

  it("reads the child's mailbox word from raw (live shape: verified=false + raw.status=catch_all)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        {
          output: { email: "ada@example.com", verified: false },
          raw: { status: "catch_all", credits_charged: 1 },
          _treg: { served_by: "tomba.people.email.find", provider: "tomba", outcome: "hit", tried: [] },
        },
        { "x-treg-cost-micro": "0" }
      )
    );
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });
    expect(res.body).toMatchObject({ status: "found", vendorMailboxStatus: "catch_all", mailboxStatus: "catch_all", chargedQuantity: 0, underlyingProvider: "tomba.people.email.find" });
    // A hit treg did not charge for declares nothing actual.
    expect(mockAddCosts).toHaveBeenCalledTimes(1);
  });

  it("a child that sends no verified flag reads as unverified (live: quickenrich)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { output: { email: "ada@example.com" }, raw: { code: 200, success: true } }, { "x-treg-cost-micro": "4834", "x-treg-served-by": "quickenrich.people.email.find" })
    );
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });
    expect(res.body).toMatchObject({ vendorMailboxStatus: "unverified", mailboxStatus: "unverified", chargedQuantity: 4834 });
  });

  it("a miss is not billed: no actual cost, the hold is released", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { output: { email: null }, _treg: { tried: ["a", "b"] } }, { "x-treg-cost-micro": "0" }));
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "not_found", found: false, email: null, chargedQuantity: 0 });
    expect(mockAddCosts).toHaveBeenCalledTimes(1); // the hold only
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("find-run-1", "hold-1", "cancelled", expect.anything());
    expect(calls).toHaveLength(1);
  });

  it("a vendor error fails loud (502), releases the hold, marks the finding failed, and keeps the call in bronze", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { detail: "upstream down" }));
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ type: "vendor_error", vendor: "treg", holdKept: false });
    expect(res.body.error).toContain("upstream down");
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("find-run-1", "hold-1", "cancelled", expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("find-run-1", "failed", expect.anything());
    expect(findings[0]).toMatchObject({ status: "failed" });
    expect(calls[0]).toMatchObject({ httpStatus: 500 });
    expect(calls[0].error).toContain("upstream down");
  });

  it("a lost answer (network error) KEEPS the hold — treg may have billed", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });

    expect(res.status).toBe(502);
    expect(res.body.holdKept).toBe(true);
    expect(mockUpdateCostStatus).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ httpStatus: null });
  });

  it("a retry after a lost answer releases the hold the failure kept", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const app = await buildApp();
    await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });
    expect(findings[0]).toMatchObject({ status: "failed", provisionedCostId: "hold-1", findRunId: "find-run-1" });

    mockCreateRun.mockResolvedValue({ id: "find-run-2" });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { output: { email: "ada@example.com", verified: true } }, { "x-treg-cost-micro": "5000", "x-treg-idempotent-replay": "true" }));
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });
    expect(res.body).toMatchObject({ status: "found", chargedQuantity: 5000 });
    // The new run's hold AND the old kept hold are both released; one actual posted.
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("find-run-2", "hold-1", "cancelled", expect.anything());
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("find-run-1", "hold-1", "cancelled", expect.anything());
    // Same Idempotency-Key on the retry → treg replays instead of re-billing.
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]);
  });

  it("a released hold is not remembered: a vendor error leaves no provisionedCostId", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { detail: "down" }));
    const app = await buildApp();
    await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });
    expect(findings[0]).toMatchObject({ status: "failed", provisionedCostId: null });
  });

  it("a 202 (async child still running) stays pending with its hold, and is never re-sent", async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { _treg: { outcome: "pending", reserved_micro: 9000, charged_micro: null } }));
    const app = await buildApp();
    const first = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("pending");
    expect(mockUpdateCostStatus).not.toHaveBeenCalled();

    const again = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });
    expect(again.status).toBe(202);
    expect(again.body.reused).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Explee ─────────────────────────────────────────────────────────────────

describe("POST /email-finder/find — explee", () => {
  it("finds with the premium preset and declares the credits Explee charged", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { email: "ada@example.com", email_status: "catch_all_valid", meta: { credits_charged: 5, remaining_balance: 95 } })
    );
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "premium", person: PERSON });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      vendor: "explee",
      preset: "premium",
      status: "found",
      vendorMailboxStatus: "catch_all_valid",
      mailboxStatus: "catch_all",
      underlyingProvider: "explee",
      costName: "explee-credit",
      chargedQuantity: 5,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.explee.com/public/api/v1/enrich/email");
    expect(init.headers["X-API-Key"]).toBe("vendor-key");
    expect(JSON.parse(init.body)).toEqual({ first_name: "Ada", last_name: "Lovelace", company_domain: "example.com", preset: "premium" });

    expect(mockAddCosts).toHaveBeenNthCalledWith(
      1,
      "find-run-1",
      [{ costName: "explee-credit", costSource: "platform", quantity: 5, status: "provisioned" }],
      expect.anything()
    );
    expect(mockAddCosts).toHaveBeenNthCalledWith(
      2,
      "find-run-1",
      [{ costName: "explee-credit", costSource: "platform", quantity: 5, status: "actual" }],
      expect.anything()
    );
    expect(mockDecryptKey).toHaveBeenCalledWith("org-1", "user-1", "explee", expect.anything(), expect.anything());
  });

  it("basic and premium are separate findings for the same person", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { email: null, email_status: null, meta: { credits_charged: 0, remaining_balance: 1 } }));
    const app = await buildApp();
    await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });
    await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "premium", person: PERSON });
    expect(findings.map((f) => f.preset).sort()).toEqual(["basic", "premium"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a miss (0 credits) is not billed", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { email: null, email_status: null, meta: { credits_charged: 0, remaining_balance: 100 } }));
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });

    expect(res.body).toMatchObject({ status: "not_found", chargedQuantity: 0 });
    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("find-run-1", "hold-1", "cancelled", expect.anything());
  });

  it("a vendor error (402 out of credits) fails loud and releases the hold", async () => {
    fetchMock.mockResolvedValue(jsonResponse(402, { detail: "Insufficient credit balance" }));
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Insufficient credit balance");
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("find-run-1", "hold-1", "cancelled", expect.anything());
  });

  it("a failed finding is retried (a vendor error bills nothing)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { detail: "boom" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { email: "ada@example.com", email_status: "valid", meta: { credits_charged: 1.5, remaining_balance: 9 } }));
    const app = await buildApp();
    await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "found", mailboxStatus: "valid", chargedQuantity: 1.5, reused: false });
    // billing authorizes integers only: the 1.5-credit worst case is rounded up; runs gets the exact 1.5.
    expect(mockAuthorizeCredit).toHaveBeenLastCalledWith(expect.objectContaining({ items: [{ costName: "explee-credit", quantity: 2 }] }));
    expect(mockAddCosts).toHaveBeenLastCalledWith("find-run-1", [{ costName: "explee-credit", costSource: "platform", quantity: 1.5, status: "actual" }], expect.anything());
    expect(findings).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

// ─── Idempotency, keys, validation ──────────────────────────────────────────

describe("POST /email-finder/find — never pays twice", () => {
  it("a re-request for the same (vendor, preset, person) calls nobody and bills nothing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { email: "ada@example.com", email_status: "valid", meta: { credits_charged: 1.5, remaining_balance: 9 } }));
    const app = await buildApp();
    await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });
    vi.clearAllMocks();

    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reused: true, email: "ada@example.com" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
    expect(mockAuthorizeCredit).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });
});

describe("POST /email-finder/find — verdict", () => {
  it("a found address carries the verifier's verdict; a miss carries none", async () => {
    mockVerificationFor.mockImplementation(async (email: string | null) =>
      email ? { email, verdict: "catch_all", deliverable: false, verifier: "bounceverify", verificationId: "ver-9", verifiedAt: "x", reused: false } : null
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { email: "ada@example.com", email_status: "valid", meta: { credits_charged: 1.5, remaining_balance: 9 } }));
    const app = await buildApp();
    const found = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });
    expect(found.body.emailVerification).toMatchObject({ verdict: "catch_all", deliverable: false });
    expect(mockVerificationFor).toHaveBeenCalledWith("ada@example.com", expect.objectContaining({ source: "email-finder:explee", runId: "run-1" }));

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { email: null, email_status: null, meta: { credits_charged: 0, remaining_balance: 9 } }));
    const miss = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "premium", person: PERSON });
    expect(miss.body.emailVerification).toBeNull();
  });

  it("a verifier failure is a loud 502, but the paid finding stays found (re-request retries only the verify)", async () => {
    const { EmailVerificationError } = await import("../../src/lib/email-verification.js");
    mockVerificationFor.mockRejectedValueOnce(new EmailVerificationError("apify down"));
    fetchMock.mockResolvedValue(jsonResponse(200, { email: "ada@example.com", email_status: "valid", meta: { credits_charged: 1.5, remaining_balance: 9 } }));
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ type: "email_verification", source: "email-verification" });
    expect(findings[0].status).toBe("found");

    const again = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", preset: "basic", person: PERSON });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, emailVerification: { verdict: "valid" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /email-finder/find — missing platform key", () => {
  it("answers 503 provider_key_missing naming the provider, calls no vendor, bills nothing", async () => {
    mockDecryptKey.mockRejectedValue(new Error("treg key not configured for this organization"));
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: PERSON });

    expect(res.status).toBe(503);
    expect(res.body.type).toBe("provider_key_missing");
    expect(res.body.error).toContain('"treg"');
    expect(res.body.error).toContain("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
    expect(findings).toHaveLength(0);
  });
});

describe("POST /email-finder/find — validation", () => {
  it("explee requires a preset", async () => {
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "explee", person: PERSON });
    expect(res.status).toBe(400);
  });

  it("treg accepts a LinkedIn URL alone", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { output: { email: null } }, { "x-treg-cost-micro": "0" }));
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set(HEADERS).send({ vendor: "treg", person: { linkedinUrl: "https://www.linkedin.com/in/ada/" } });
    expect(res.status).toBe(200);
    expect(findings[0].personKey).toBe("linkedin:linkedin.com/in/ada");
  });

  it("requires x-run-id", async () => {
    const app = await buildApp();
    const res = await request(app).post("/email-finder/find").set({ "x-org-id": "org-1", "x-user-id": "user-1" }).send({ vendor: "treg", person: PERSON });
    expect(res.status).toBe(400);
  });
});

describe("normalizeMailboxStatus", () => {
  it("folds each vendor's word onto one vocabulary", async () => {
    const { normalizeMailboxStatus } = await import("../../src/lib/email-finders.js");
    expect(normalizeMailboxStatus("verified")).toBe("valid");
    expect(normalizeMailboxStatus("valid")).toBe("valid");
    expect(normalizeMailboxStatus("accept_all")).toBe("catch_all");
    expect(normalizeMailboxStatus("catch_all_valid")).toBe("catch_all");
    expect(normalizeMailboxStatus("invalid")).toBe("invalid");
    expect(normalizeMailboxStatus("unverified")).toBe("unverified");
    expect(normalizeMailboxStatus("weird")).toBe("unknown");
    expect(normalizeMailboxStatus(null)).toBeNull();
  });
});
