import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * POST /internal/company-firmographics: org-less, platform-billed company
 * firmographics for a domain (+ a person's role), cached so a repeat visit
 * spends nothing, and never leaving a paid lookup undeclared.
 */

// ─── In-memory tables behind the drizzle calls the module makes ─────────────
const tables = { company: new Map<string, any>(), person: new Map<string, any>() };
vi.mock("../../src/db/schema.js", () => ({
  companyDomainLookups: { __t: "company", domain: "domain" },
  personRoleLookups: { __t: "person", personKey: "personKey" },
}));
vi.mock("drizzle-orm", () => ({ eq: (_col: unknown, v: unknown) => ({ v }) }));
vi.mock("../../src/lib/advisory-lock.js", () => ({ advisoryXactLock: async () => undefined }));
function keyOf(t: string, v: any) {
  return t === "company" ? v.domain : v.personKey;
}
const fakeDb: any = {
  execute: async () => [],
  select: () => ({
    from: (tbl: any) => ({ where: (w: any) => ({ limit: async () => (tables as any)[tbl.__t].has(w.v) ? [{ ...(tables as any)[tbl.__t].get(w.v) }] : [] }) }),
  }),
  insert: (tbl: any) => ({
    values: (v: any) => ({
      onConflictDoUpdate: () => ({
        returning: async () => {
          (tables as any)[tbl.__t].set(keyOf(tbl.__t, v), { ...v });
          return [{ ...v }];
        },
      }),
    }),
  }),
  update: (tbl: any) => ({
    set: (patch: any) => ({
      where: (w: any) => ({
        returning: async () => {
          const row = { ...(tables as any)[tbl.__t].get(w.v), ...patch };
          (tables as any)[tbl.__t].set(w.v, row);
          return [{ ...row }];
        },
      }),
    }),
  }),
  transaction: async (cb: any) => cb(fakeDb),
};
vi.mock("../../src/db/index.js", () => ({ db: fakeDb }));

const mockCreatePlatformRun = vi.fn();
const mockAddPlatformRunCosts = vi.fn();
const mockUpdatePlatformRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createPlatformRun: (...a: unknown[]) => mockCreatePlatformRun(...a),
  addPlatformRunCosts: (...a: unknown[]) => mockAddPlatformRunCosts(...a),
  updatePlatformRun: (...a: unknown[]) => mockUpdatePlatformRun(...a),
}));
const mockDecryptPlatformKey = vi.fn();
vi.mock("../../src/lib/keys-client.js", () => ({ decryptPlatformKey: (...a: unknown[]) => mockDecryptPlatformKey(...a) }));
const mockJudgment = vi.fn();
vi.mock("../../src/lib/chat-client.js", () => ({ platformChoiceJudgment: (...a: unknown[]) => mockJudgment(...a) }));
const mockEnrichOrg = vi.fn();
const mockMatchPerson = vi.fn();
vi.mock("../../src/lib/apollo-client.js", () => ({
  enrichOrganizationByDomain: (...a: unknown[]) => mockEnrichOrg(...a),
  matchPersonForRole: (...a: unknown[]) => mockMatchPerson(...a),
}));

const STRIPE = {
  id: "5d0a0fbff6512580bf33a120",
  name: "Stripe",
  primary_domain: "stripe.com",
  industry: "information technology & services",
  estimated_num_employees: 9400,
  annual_revenue: 6935000000,
  country: "United States",
  short_description: "Stripe is a financial infrastructure platform for businesses.",
  keywords: ["payments", "developer tools", "enterprise software"],
};

process.env.APOLLO_SERVICE_API_KEY = "svc-key";

async function buildApp() {
  const { default: router } = await import("../../src/routes/company-firmographics.js");
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}
const post = async (body: unknown, key = "svc-key") =>
  request(await buildApp()).post("/internal/company-firmographics").set("x-api-key", key).send(body);

beforeEach(() => {
  vi.clearAllMocks();
  tables.company.clear();
  tables.person.clear();
  let n = 0;
  mockCreatePlatformRun.mockImplementation(async () => ({ id: `run-${++n}` }));
  mockAddPlatformRunCosts.mockResolvedValue({ costs: [] });
  mockUpdatePlatformRun.mockResolvedValue(undefined);
  mockDecryptPlatformKey.mockResolvedValue("apollo-platform-key");
  mockJudgment.mockResolvedValue({ type: "choice", choice: "B2B SaaS", confidence: 0.93, probabilities: {} });
  mockEnrichOrg.mockResolvedValue(STRIPE);
  mockMatchPerson.mockResolvedValue({ id: "p1", title: "Co-Founder & Chief Executive Officer", seniority: "founder" });
});

describe("POST /internal/company-firmographics", () => {
  it("answers a real company, declares 1 apollo-credit on a platform run, and serves the repeat from cache", async () => {
    const res = await post({ domain: "https://www.Stripe.com/pricing" });
    expect(res.status).toBe(200);
    expect(res.body.domain).toBe("stripe.com");
    expect(res.body.company).toMatchObject({
      name: "Stripe",
      countryCode: "US",
      countryName: "United States",
      industry: "Information Technology & Services",
      revenueRange: { label: "$1B+", min: 1_000_000_000, max: null },
      employeeRange: { label: "5,001-10,000", min: 5001, max: 10000 },
      category: "B2B SaaS",
    });
    expect(res.body.person).toBeNull();
    expect(res.body.personMatched).toBeNull();
    expect(res.body.cached).toEqual({ company: false, person: null });
    expect(mockEnrichOrg).toHaveBeenCalledWith("apollo-platform-key", "stripe.com");
    expect(mockCreatePlatformRun).toHaveBeenCalledTimes(1);
    expect(mockAddPlatformRunCosts).toHaveBeenCalledWith("run-1", [
      { costName: "apollo-credit", quantity: 1, idempotencyKey: "apollo-service:company-firmographics:run-1" },
    ]);
    expect(mockUpdatePlatformRun).toHaveBeenCalledWith("run-1", "completed");
    expect(mockJudgment).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const again = await post({ domain: "stripe.com" });
    expect(again.status).toBe(200);
    expect(again.body.cached.company).toBe(true);
    expect(again.body.company.category).toBe("B2B SaaS");
    expect(mockEnrichOrg).not.toHaveBeenCalled();
    expect(mockCreatePlatformRun).not.toHaveBeenCalled();
    expect(mockAddPlatformRunCosts).not.toHaveBeenCalled();
    expect(mockJudgment).not.toHaveBeenCalled();
    expect(mockDecryptPlatformKey).not.toHaveBeenCalled();
  });

  it("free-mail domain answers no company without any spend", async () => {
    const res = await post({ domain: "gmail.com", email: "someone@gmail.com", firstName: "A", lastName: "B" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company: null, noCompanyReason: "personal_email_domain", person: null });
    expect(mockDecryptPlatformKey).not.toHaveBeenCalled();
    expect(mockEnrichOrg).not.toHaveBeenCalled();
    expect(mockMatchPerson).not.toHaveBeenCalled();
    expect(mockCreatePlatformRun).not.toHaveBeenCalled();
  });

  it("unknown domain: company null / not_found, run closed with no cost", async () => {
    mockEnrichOrg.mockResolvedValue(null);
    const res = await post({ domain: "zzqx-nonexistent-firm.com" });
    expect(res.body).toMatchObject({ company: null, noCompanyReason: "not_found" });
    expect(mockAddPlatformRunCosts).not.toHaveBeenCalled();
    expect(mockUpdatePlatformRun).toHaveBeenCalledWith("run-1", "completed");
    expect(mockJudgment).not.toHaveBeenCalled();
  });

  it("matched person returns the role and bills 1 credit; repeat is cached", async () => {
    const res = await post({ domain: "stripe.com", email: "Patrick@stripe.com", firstName: "Patrick", lastName: "Collison" });
    expect(res.body.person).toEqual({ title: "Co-Founder & Chief Executive Officer", seniority: "founder" });
    expect(res.body.personMatched).toBe(true);
    expect(mockMatchPerson).toHaveBeenCalledWith("apollo-platform-key", { email: "Patrick@stripe.com", firstName: "Patrick", lastName: "Collison", domain: "stripe.com" });
    // one platform key fetch shared by both lookups
    expect(mockDecryptPlatformKey).toHaveBeenCalledTimes(1);
    const personCost = mockAddPlatformRunCosts.mock.calls.find((c) => String(c[1][0].idempotencyKey).includes("person-role"));
    expect(personCost?.[1][0]).toMatchObject({ costName: "apollo-credit", quantity: 1 });

    vi.clearAllMocks();
    const again = await post({ domain: "stripe.com", email: "patrick@stripe.com" });
    expect(again.body.person.title).toBe("Co-Founder & Chief Executive Officer");
    expect(again.body.cached).toEqual({ company: true, person: true });
    expect(mockMatchPerson).not.toHaveBeenCalled();
  });

  it("unmatched person (match_confidence none): role absent, no credit, company still answers", async () => {
    mockMatchPerson.mockResolvedValue({ id: "x", title: null, match_confidence: "none", headline: "role based email" });
    const res = await post({ domain: "stripe.com", email: "nobody@stripe.com" });
    expect(res.body.person).toBeNull();
    expect(res.body.personMatched).toBe(false);
    expect(res.body.company.name).toBe("Stripe");
    const personCost = mockAddPlatformRunCosts.mock.calls.find((c) => String(c[1][0].idempotencyKey).includes("person-role"));
    expect(personCost).toBeUndefined();
  });

  it("a failed cost declaration fails loud, and the retry declares it under the same key without paying Apollo again", async () => {
    mockAddPlatformRunCosts.mockRejectedValueOnce(new Error("runs-service down"));
    const first = await post({ domain: "stripe.com" });
    expect(first.status).toBe(502);
    expect(mockEnrichOrg).toHaveBeenCalledTimes(1);

    const second = await post({ domain: "stripe.com" });
    expect(second.status).toBe(200);
    expect(mockEnrichOrg).toHaveBeenCalledTimes(1);
    expect(mockAddPlatformRunCosts).toHaveBeenCalledTimes(2);
    expect(mockAddPlatformRunCosts.mock.calls[1][1][0].idempotencyKey).toBe(mockAddPlatformRunCosts.mock.calls[0][1][0].idempotencyKey);
  });

  it("a platform run that cannot be opened fails loud before any Apollo spend", async () => {
    mockCreatePlatformRun.mockRejectedValue(new Error("runs-service down"));
    const res = await post({ domain: "stripe.com" });
    expect(res.status).toBe(502);
    expect(mockEnrichOrg).not.toHaveBeenCalled();
  });

  it("low-confidence category is reported unknown, never guessed", async () => {
    mockJudgment.mockResolvedValue({ type: "choice", choice: "B2C", confidence: 0.31, probabilities: {} });
    const res = await post({ domain: "stripe.com" });
    expect(res.body.company.category).toBeNull();
    expect(res.body.company.categoryConfidence).toBeCloseTo(0.31);
  });

  it("rejects a bad key and a non-domain", async () => {
    expect((await post({ domain: "stripe.com" }, "nope")).status).toBe(401);
    expect((await post({ domain: "not a domain" })).status).toBe(400);
  });
});

describe("POST /internal/person-identity", () => {
  const postId = async (body: unknown, key = "svc-key") =>
    request(await buildApp()).post("/internal/person-identity").set("x-api-key", key).send(body);

  it("matches by email only, returns the LinkedIn URL, bills 1 credit once, and the repeat spends nothing", async () => {
    mockMatchPerson.mockResolvedValue({ id: "p1", name: "Patrick Collison", linkedin_url: "http://www.linkedin.com/in/patrickcollison", match_confidence: "high" });
    const res = await postId({ email: "Patrick@Stripe.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      email: "patrick@stripe.com",
      matched: true,
      matchConfidence: "high",
      linkedinUrl: "http://www.linkedin.com/in/patrickcollison",
      apolloPersonId: "p1",
      name: "Patrick Collison",
      cached: false,
    });
    expect(mockMatchPerson).toHaveBeenCalledWith("apollo-platform-key", { email: "patrick@stripe.com", firstName: undefined, lastName: undefined, domain: "stripe.com" });
    expect(mockAddPlatformRunCosts).toHaveBeenCalledWith("run-1", [
      { costName: "apollo-credit", quantity: 1, idempotencyKey: "apollo-service:person-role:run-1" },
    ]);
    expect(mockEnrichOrg).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const again = await postId({ email: "patrick@stripe.com" });
    expect(again.body.cached).toBe(true);
    expect(again.body.linkedinUrl).toBe("http://www.linkedin.com/in/patrickcollison");
    expect(mockMatchPerson).not.toHaveBeenCalled();
    expect(mockCreatePlatformRun).not.toHaveBeenCalled();
    expect(mockDecryptPlatformKey).not.toHaveBeenCalled();
  });

  it("free-mail address: matched by email with no domain sent", async () => {
    mockMatchPerson.mockResolvedValue({ id: "p2", linkedin_url: "https://linkedin.com/in/x", match_confidence: "high" });
    await postId({ email: "someone@gmail.com" });
    expect(mockMatchPerson).toHaveBeenCalledWith("apollo-platform-key", expect.objectContaining({ email: "someone@gmail.com", domain: undefined }));
  });

  it("unmatched: no URL, no person, no credit", async () => {
    mockMatchPerson.mockResolvedValue({ id: "x", linkedin_url: "http://www.linkedin.com/in/someone-else", match_confidence: "none" });
    const res = await postId({ email: "nobody@stripe.com" });
    expect(res.body).toMatchObject({ matched: false, matchConfidence: "none", linkedinUrl: null, apolloPersonId: null });
    expect(mockAddPlatformRunCosts).not.toHaveBeenCalled();
  });

  it("low confidence is passed through verbatim for the caller to judge", async () => {
    mockMatchPerson.mockResolvedValue({ id: "p3", linkedin_url: "http://www.linkedin.com/in/maybe", match_confidence: "low" });
    const res = await postId({ email: "info@gowhite.xyz" });
    expect(res.body).toMatchObject({ matched: true, matchConfidence: "low" });
  });

  it("rejects a bad key and a non-email", async () => {
    expect((await postId({ email: "a@b.co" }, "nope")).status).toBe(401);
    expect((await postId({ email: "not-an-email" })).status).toBe(400);
  });
});

describe("pure helpers", () => {
  it("maps Apollo country names to ISO-2", async () => {
    const { countryCode } = await import("../../src/lib/company-firmographics.js");
    expect(countryCode("United States")).toBe("US");
    expect(countryCode("United Kingdom")).toBe("GB");
    expect(countryCode("Germany")).toBe("DE");
    expect(countryCode("Switzerland")).toBe("CH");
    expect(countryCode("Hong Kong")).toBe("HK");
    expect(countryCode("Czech Republic")).toBe("CZ");
    expect(countryCode("Turkey")).toBe("TR");
    expect(countryCode("Atlantis")).toBeNull();
    expect(countryCode(null)).toBeNull();
  });

  it("buckets revenue and headcount", async () => {
    const { revenueRange, employeeRange } = await import("../../src/lib/company-firmographics.js");
    expect(revenueRange(500_000)?.label).toBe("<$1M");
    expect(revenueRange(12_000_000)?.label).toBe("$10M-$50M");
    expect(revenueRange(0)).toBeNull();
    expect(employeeRange(7)?.label).toBe("1-10");
    expect(employeeRange(200)?.label).toBe("51-200");
    expect(employeeRange(50_000)?.label).toBe("10,001+");
    expect(employeeRange(undefined)).toBeNull();
  });
});
