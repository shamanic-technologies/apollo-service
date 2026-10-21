import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * POST /email-verifications: verdicts for addresses a caller already holds,
 * through the exact reveal-path protocol, all or nothing.
 */

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

let heldRows: any[] = [];
const inserted: any[] = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => heldRows }) }) }) }),
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { id: `00000000-0000-4000-8000-00000000000${inserted.length + 1}`, verifiedAt: new Date("2026-09-28T10:00:00Z"), ...v };
          inserted.push(row);
          return [row];
        },
      }),
    }),
  },
}));
vi.mock("../../src/db/schema.js", () => ({
  emailVerifications: { email: "email", verdict: "verdict", verifiedAt: "verified_at" },
}));

// The real mail-domain module runs; only the resolver underneath is scripted.
// A plain function, not a vi.fn: a rejecting vi.fn is reported as a failure.
let resolveMx: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolveMx(domain: string) {
      return resolveMx(domain);
    }
  },
}));
function dnsFail(code: string) {
  return Object.assign(new Error(`queryMx ${code}`), { code });
}

const fetchMock = vi.fn();
const VERDICTS: Record<string, Record<string, unknown>> = {
  "good@example.com": { status: "valid", is_catch_all: false },
  "bad@example.com": { status: "invalid", is_catch_all: false },
  "all@example.com": { status: "valid", is_catch_all: true },
  // Prod 2026-10-21: the actor's "no mail domain" invalid on a domain whose DNS SERVFAILs.
  "cohen.n@teamquickenlends.com": { status: "invalid", is_catch_all: false, domain_exists: false, mx_found: false, reason: "Domain does not exist" },
};

function actorFor(init: any) {
  const email = JSON.parse(init.body).emails[0];
  const v = VERDICTS[email];
  if (!v) return new Response("boom", { status: 500 });
  return new Response(JSON.stringify([{ email, ...v }]), { status: 200, headers: { "content-type": "application/json" } });
}

async function buildApp() {
  const { default: router } = await import("../../src/routes/email-verifications.js");
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const HEADERS = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1", "x-brand-id": "b-1" };

beforeEach(() => {
  vi.clearAllMocks();
  heldRows = [];
  inserted.length = 0;
  resolveMx = async (d) => {
    if (d === "teamquickenlends.com") throw dnsFail("ESERVFAIL");
    return [{ exchange: `mx.${d}`, priority: 10 }];
  };
  let n = 0;
  mockCreateRun.mockImplementation(async () => ({ id: `verify-run-${++n}` }));
  mockUpdateRun.mockResolvedValue({});
  mockAddCosts.mockImplementation(async (_r: string, items: any[]) => ({ costs: [{ id: items[0].status === "provisioned" ? "hold" : "actual" }] }));
  mockUpdateCostStatus.mockResolvedValue({});
  mockAuthorizeCredit.mockResolvedValue({ sufficient: true, balance_cents: 100, required_cents: 1 });
  mockDecryptKey.mockResolvedValue({ key: "apify-token", keySource: "platform" });
  fetchMock.mockImplementation(async (url: string, init: any) =>
    String(url).includes("contactout")
      ? new Response("<html>Too Many Requests</html>", { status: 429, headers: { "x-treg-cost-micro": "0" } })
      : String(url).includes("bounceban")
      ? // BounceBan's second opinion on the catch_all: still accept-all, can't confirm.
        new Response(JSON.stringify({ id: "bb-1", status: "success", result: "risky", is_accept_all: true }), { status: 200, headers: { "x-treg-cost-micro": "4000" } })
      : actorFor(init)
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /email-verifications", () => {
  it("returns one verdict per distinct address; only valid is deliverable; billed to the caller's org as children of x-run-id", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/email-verifications")
      .set(HEADERS)
      .send({ emails: ["Good@Example.com", "bad@example.com", "all@example.com", "good@example.com"], source: "transactional-email-service" });

    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => [r.email, r.verdict, r.deliverable])).toEqual([
      ["good@example.com", "valid", true],
      ["bad@example.com", "invalid", false],
      ["all@example.com", "catch_all", false],
    ]);
    // duplicate verified once (ContactOut 429 → BounceVerify); the catch_all got BounceBan's opinion
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("api.apify.com"))).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("bounceban"))).toHaveLength(1);
    expect(inserted).toHaveLength(7);
    expect(inserted.every((r) => r.source === "verify:transactional-email-service")).toBe(true);
    expect(inserted.every((r) => r.orgId === "org-1" && r.runId === "run-1")).toBe(true);
    expect(mockCreateRun).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", userId: "user-1", parentRunId: "run-1", taskName: "verify-email", brandIds: ["b-1"] }));
    expect(mockAuthorizeCredit).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", items: [{ costName: "apify-bounceverify-email", quantity: 1 }] }));
  });

  it("reuses a held decisive verdict without calling the verifier", async () => {
    heldRows = [{ id: "00000000-0000-4000-8000-0000000000aa", email: "good@example.com", verdict: "valid", verifiedAt: new Date("2026-09-20T00:00:00Z") }];
    const app = await buildApp();
    const res = await request(app).post("/email-verifications").set(HEADERS).send({ emails: ["good@example.com"] });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ verdict: "valid", deliverable: true, reused: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("is all or nothing: one address the verifier cannot answer fails the whole call with 502 and no verdicts", async () => {
    const app = await buildApp();
    const res = await request(app).post("/email-verifications").set(HEADERS).send({ emails: ["good@example.com", "down@example.com"] });
    expect(res.status).toBe(502);
    expect(res.body.type).toBe("email_verification");
    expect(res.body.error).toContain("down@example.com");
    expect(res.body.results).toBeUndefined();
  });

  it("an address on a domain whose own DNS is broken (SERVFAIL, resolver healthy) gets invalid; the rest of the batch is served (APOLLO-SERVFAIL-POISON-1021)", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/email-verifications")
      .set(HEADERS)
      .send({ emails: ["cohen.n@teamquickenlends.com", "good@example.com", "bad@example.com"] });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => [r.email, r.verdict, r.deliverable])).toEqual([
      ["cohen.n@teamquickenlends.com", "invalid", false],
      ["good@example.com", "valid", true],
      ["bad@example.com", "invalid", false],
    ]);
  });

  it("a DNS failure that is not the domain's (resolver SERVFAILs everything / times out) still fails the batch loud", async () => {
    for (const code of ["ESERVFAIL", "ETIMEOUT"]) {
      resolveMx = async () => {
        throw dnsFail(code);
      };
      const app = await buildApp();
      const res = await request(app)
        .post("/email-verifications")
        .set(HEADERS)
        .send({ emails: ["cohen.n@teamquickenlends.com", "good@example.com"] });
      expect(res.status).toBe(502);
      expect(res.body.type).toBe("email_verification");
      expect(res.body.error).toContain("teamquickenlends.com");
      expect(res.body.results).toBeUndefined();
    }
  });

  it("fails loud when the org cannot afford it", async () => {
    mockAuthorizeCredit.mockResolvedValue({ sufficient: false, balance_cents: 0, required_cents: 1 });
    const app = await buildApp();
    const res = await request(app).post("/email-verifications").set(HEADERS).send({ emails: ["good@example.com"] });
    expect(res.status).toBe(502);
    // Only the free ContactOut was asked; nothing paid was called.
    expect(fetchMock.mock.calls.filter(([u]) => !String(u).includes("contactout"))).toHaveLength(0);
  });

  it("400s without x-run-id, on an empty list, and above the batch ceiling", async () => {
    const app = await buildApp();
    const { "x-run-id": _omit, ...noRun } = HEADERS;
    expect((await request(app).post("/email-verifications").set(noRun).send({ emails: ["good@example.com"] })).status).toBe(400);
    expect((await request(app).post("/email-verifications").set(HEADERS).send({ emails: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 51 }, (_, i) => `a${i}@example.com`);
    expect((await request(app).post("/email-verifications").set(HEADERS).send({ emails: tooMany })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies at most 10 addresses at once", async () => {
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const email = JSON.parse(init.body).emails[0];
      return new Response(JSON.stringify([{ email, status: "valid", is_catch_all: false }]), { status: 200 });
    });
    const app = await buildApp();
    const emails = Array.from({ length: 30 }, (_, i) => `p${i}@example.com`);
    const res = await request(app).post("/email-verifications").set(HEADERS).send({ emails });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(30);
    expect(res.body.results.map((r: any) => r.email)).toEqual(emails);
    expect(peak).toBe(10);
  });
});
