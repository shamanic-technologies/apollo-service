import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * GET /audiences/:id/companies — up to 100 companies of an audience with
 * firmographics + one person each. Apollo, key-service, runs-service and
 * billing-service are mocked; the db mock serves the audience row and the
 * firmographics cache and records cache writes.
 */

const state: { selectRow: any; cached: any[]; upserts: any[] } = { selectRow: undefined, cached: [], upserts: [] };

vi.mock("../../src/db/index.js", () => {
  const select = () => ({
    from: (table: any) => {
      const where = () => {
        const rows = table?.__name === "orgs" ? state.cached : state.selectRow ? [state.selectRow] : [];
        const p: any = Promise.resolve(rows);
        p.limit = async () => rows;
        return p;
      };
      return { where };
    },
  });
  const insert = () => ({
    values: (v: any) => ({
      onConflictDoUpdate: async () => {
        state.upserts.push(v);
      },
      returning: async () => [],
    }),
  });
  const tx = { select, insert, execute: async () => undefined };
  return { db: { select, insert, transaction: async (fn: any) => fn(tx) } };
});

vi.mock("../../src/db/schema.js", () => ({
  apolloAudiences: { id: { name: "id" }, orgId: { name: "org_id" } },
  apolloOrganizations: { __name: "orgs", id: { name: "id" }, fetchedAt: { name: "fetched_at" } },
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, res: any, next: any) => {
    if (!req.headers["x-org-id"]) return res.status(400).json({ type: "validation", error: "x-org-id header required" });
    if (!req.headers["x-user-id"]) return res.status(400).json({ type: "validation", error: "x-user-id header required" });
    req.orgId = req.headers["x-org-id"];
    req.userId = req.headers["x-user-id"];
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-audience-id"]) req.audienceId = req.headers["x-audience-id"];
    next();
  },
  orgAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"];
    next();
  },
}));

const mockDecryptKey = vi.fn();
vi.mock("../../src/lib/keys-client.js", () => ({ decryptKey: (...a: unknown[]) => mockDecryptKey(...a) }));

const mockSearchPeople = vi.fn();
const mockLookup = vi.fn();
const mockGetOrg = vi.fn();
vi.mock("../../src/lib/apollo-client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  searchPeople: (...a: unknown[]) => mockSearchPeople(...a),
  lookupOrganizationsByName: (...a: unknown[]) => mockLookup(...a),
  getOrganizationById: (...a: unknown[]) => mockGetOrg(...a),
}));

const mockCreateRun = vi.fn();
const mockAddCosts = vi.fn();
const mockUpdateCostStatus = vi.fn();
const mockUpdateRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  addCosts: (...a: unknown[]) => mockAddCosts(...a),
  updateCostStatus: (...a: unknown[]) => mockUpdateCostStatus(...a),
  updateRun: (...a: unknown[]) => mockUpdateRun(...a),
}));

const mockAuthorize = vi.fn();
vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: (...a: unknown[]) => mockAuthorize(...a) }));

const { default: audienceRoutes } = await import("../../src/routes/audiences.js");
const { groupEmployers, toFirmographics } = await import("../../src/lib/audience-companies.js");

const app = express();
app.use(express.json());
app.use(audienceRoutes);

const HEADERS = { "X-Org-Id": "org-1", "X-User-Id": "user-1", "X-Run-Id": "run-parent", "X-Audience-Id": "hs-aud-1" };
const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: "org-1",
  brandId: "brand-1",
  filters: { person_titles: ["Owner"], organization_locations: ["Switzerland"] },
  count: 900,
};

const teaser = (first: string, company: string | null, title = "Owner") => ({
  id: `p-${first}`,
  first_name: first,
  last_name_obfuscated: `${first[0]}***x`,
  title,
  has_email: true,
  organization: company ? { name: company, has_industry: true } : undefined,
});

const FULL_ORG = (id: string, name: string) => ({
  id,
  name,
  primary_domain: `${name.toLowerCase()}.ch`,
  website_url: `http://www.${name.toLowerCase()}.ch`,
  logo_url: `https://logo/${id}`,
  linkedin_url: `http://linkedin.com/company/${id}`,
  short_description: `${name} sells things.`,
  industry: "retail",
  estimated_num_employees: 12,
  city: "Zurich",
  state: "Zurich",
  country: "Switzerland",
  founded_year: 1990,
  annual_revenue_printed: "2M",
  keywords: ["drogerie", "health"],
  phone: "+41 44 000 00 00",
  primary_phone: { number: "+41 44 000 00 00" },
});

beforeEach(() => {
  state.selectRow = { ...ROW };
  state.cached = [];
  state.upserts = [];
  mockDecryptKey.mockReset().mockResolvedValue({ key: "apollo-key", keySource: "platform" });
  mockSearchPeople.mockReset().mockResolvedValue({
    total_entries: 3,
    people: [teaser("Anna", "Alpha"), teaser("Beat", "Alpha"), teaser("Cora", "Beta")],
  });
  mockLookup.mockReset().mockImplementation(async (_k: string, name: string) =>
    name === "Alpha" ? [{ id: "org-a", name: "Alpha", domain: "alpha.ch" }, { id: "org-z", name: "Alpha Beta" }] : [{ id: "org-b", name: "Beta", domain: "beta.ch" }],
  );
  mockGetOrg.mockReset().mockImplementation(async (_k: string, id: string) => FULL_ORG(id, id === "org-a" ? "Alpha" : "Beta"));
  mockCreateRun.mockReset().mockResolvedValue({ id: "run-child" });
  mockAddCosts.mockReset().mockImplementation(async (_r: string, items: any[]) => ({ costs: items.map((_, i) => ({ id: `cost-${i}` })) }));
  mockUpdateCostStatus.mockReset().mockResolvedValue({});
  mockUpdateRun.mockReset().mockResolvedValue({});
  mockAuthorize.mockReset().mockResolvedValue({ sufficient: true, balance_cents: 1000, required_cents: 24 });
});

describe("GET /audiences/:id/companies", () => {
  it("returns companies in rank order with firmographics and the first-ranked person, metered 1 credit per company", async () => {
    const res = await request(app).get(`/audiences/${ROW.id}/companies`).set(HEADERS).expect(200);

    expect(res.body).toMatchObject({ apolloAudienceId: ROW.id, count: 3, offset: 0, limit: 25, hasMore: false, creditsCharged: 2 });
    expect(res.body.companies).toHaveLength(2);
    expect(res.body.companies[0]).toEqual({
      rank: 1,
      name: "Alpha",
      apolloOrganizationId: "org-a",
      domain: "alpha.ch",
      websiteUrl: "http://www.alpha.ch",
      logoUrl: "https://logo/org-a",
      linkedinUrl: "http://linkedin.com/company/org-a",
      shortDescription: "Alpha sells things.",
      industry: "retail",
      estimatedNumEmployees: 12,
      city: "Zurich",
      state: "Zurich",
      country: "Switzerland",
      foundedYear: 1990,
      annualRevenuePrinted: "2M",
      totalFundingPrinted: null,
      latestFundingStage: null,
      keywords: ["drogerie", "health"],
      peopleInSample: 2,
      person: { apolloPersonId: "p-Anna", firstName: "Anna", lastNameObfuscated: "A***x", title: "Owner" },
    });
    expect(res.body.companies[1].rank).toBe(2);

    // Never an email, a phone or the audience's filters.
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/email|phone|\+41|person_titles|organization_locations/i);

    // Teaser on the audience's own filters (person-level filters included).
    expect(mockSearchPeople.mock.calls[0][1]).toMatchObject({ page: 1, per_page: 100, person_titles: ["Owner"] });

    // provision → authorize → execute → actualize, hold released.
    expect(mockCreateRun).toHaveBeenCalledWith(expect.objectContaining({ taskName: "audience-companies", parentRunId: "run-parent", orgId: "org-1", audienceId: "hs-aud-1", brandIds: ["brand-1"] }));
    expect(mockAddCosts.mock.calls[0][1]).toEqual([{ costName: "apollo-credit", costSource: "platform", quantity: 2, status: "provisioned" }]);
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ items: [{ costName: "apollo-credit", quantity: 2 }], orgId: "org-1" }));
    expect(mockAddCosts.mock.calls[1][1]).toEqual([{ costName: "apollo-credit", costSource: "platform", quantity: 2 }]);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("run-child", "cost-0", "cancelled", expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("run-child", "completed", expect.anything());
    expect(mockAuthorize.mock.invocationCallOrder[0]).toBeGreaterThan(mockAddCosts.mock.invocationCallOrder[0]);
    expect(mockGetOrg.mock.invocationCallOrder[0]).toBeGreaterThan(mockAuthorize.mock.invocationCallOrder[0]);

    // Fetched records land in the global cache.
    expect(state.upserts.map((u) => u.id).sort()).toEqual(["org-a", "org-b"]);
  });

  it("serves cached firmographics for free: no run, no authorize, no Apollo org fetch", async () => {
    state.cached = [
      { id: "org-a", raw: FULL_ORG("org-a", "Alpha") },
      { id: "org-b", raw: FULL_ORG("org-b", "Beta") },
    ];
    const res = await request(app).get(`/audiences/${ROW.id}/companies`).set(HEADERS).expect(200);
    expect(res.body.creditsCharged).toBe(0);
    expect(res.body.companies[0].industry).toBe("retail");
    expect(mockGetOrg).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("402 when the org cannot afford the chunk: hold cancelled, nothing bought", async () => {
    mockAuthorize.mockResolvedValue({ sufficient: false, balance_cents: 5, required_cents: 24 });
    const res = await request(app).get(`/audiences/${ROW.id}/companies`).set(HEADERS).expect(402);
    expect(res.body).toMatchObject({ type: "credit_insufficient", balance_cents: 5, required_cents: 24 });
    expect(mockGetOrg).not.toHaveBeenCalled();
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("run-child", "cost-0", "cancelled", expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("run-child", "failed", expect.anything());
  });

  it("BYOK org: no affordability gate, cost declared with costSource org", async () => {
    mockDecryptKey.mockResolvedValue({ key: "own-key", keySource: "org" });
    await request(app).get(`/audiences/${ROW.id}/companies`).set(HEADERS).expect(200);
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockAddCosts.mock.calls[1][1]).toEqual([{ costName: "apollo-credit", costSource: "org", quantity: 2 }]);
  });

  it("an employer with no exactly-named Apollo organization keeps its name and person, every firmographic null", async () => {
    mockLookup.mockImplementation(async (_k: string, name: string) => (name === "Alpha" ? [{ id: "org-z", name: "Alpha Beta" }] : [{ id: "org-b", name: "Beta" }]));
    const res = await request(app).get(`/audiences/${ROW.id}/companies`).set(HEADERS).expect(200);
    const alpha = res.body.companies[0];
    expect(alpha).toMatchObject({ name: "Alpha", apolloOrganizationId: null, domain: null, industry: null, keywords: [] });
    expect(alpha.person.firstName).toBe("Anna");
    expect(res.body.creditsCharged).toBe(1);
    expect(mockGetOrg).toHaveBeenCalledTimes(1);
  });

  it("several exactly-named organizations: the first holding a person of the audience wins (free people search)", async () => {
    mockLookup.mockImplementation(async (_k: string, name: string) =>
      name === "Alpha" ? [{ id: "org-a1", name: "Alpha" }, { id: "org-a2", name: "alpha" }] : [{ id: "org-b", name: "Beta" }],
    );
    mockSearchPeople.mockImplementation(async (_k: string, p: any) => {
      if (p.organization_ids) return { total_entries: p.organization_ids[0] === "org-a2" ? 4 : 0, people: [] };
      return { total_entries: 3, people: [teaser("Anna", "Alpha"), teaser("Cora", "Beta")] };
    });
    const res = await request(app).get(`/audiences/${ROW.id}/companies`).set(HEADERS).expect(200);
    expect(res.body.companies[0].apolloOrganizationId).toBe("org-a2");
    const scoped = mockSearchPeople.mock.calls.filter((c) => c[1].organization_ids);
    expect(scoped.map((c) => c[1].organization_ids)).toEqual([["org-a1"], ["org-a2"]]);
    expect(scoped[0][1]).toMatchObject({ person_titles: ["Owner"], per_page: 1 });
  });

  it("chunks by offset/limit with stable ranks and walks more teaser pages only when needed", async () => {
    const page = (n: number) => ({
      total_entries: 250,
      people: Array.from({ length: n === 3 ? 50 : 100 }, (_, i) => teaser(`P${n}-${i}`, `Co ${Math.floor(((n - 1) * 100 + i) / 10)}`)),
    });
    mockSearchPeople.mockImplementation(async (_k: string, p: any) => page(p.page));
    mockLookup.mockImplementation(async (_k: string, name: string) => [{ id: `id-${name}`, name }]);
    mockGetOrg.mockImplementation(async (_k: string, id: string) => FULL_ORG(id, id));

    const first = await request(app).get(`/audiences/${ROW.id}/companies?limit=5`).set(HEADERS).expect(200);
    expect(first.body.companies.map((c: any) => c.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(first.body.hasMore).toBe(true);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1); // page 1 held 10 employers

    mockSearchPeople.mockClear();
    const second = await request(app).get(`/audiences/${ROW.id}/companies?offset=10&limit=20`).set(HEADERS).expect(200);
    expect(second.body.companies[0]).toMatchObject({ rank: 11, name: "Co 10" });
    expect(second.body.companies).toHaveLength(15); // 250 people, 10 per company → 25 companies
    expect(second.body.hasMore).toBe(false);
    expect(mockSearchPeople.mock.calls.map((c) => c[1].page).sort()).toEqual([1, 2, 3]);
  });

  it("400 without x-run-id (the cost needs a parent run), before any Apollo call", async () => {
    await request(app).get(`/audiences/${ROW.id}/companies`).set({ "X-Org-Id": "org-1", "X-User-Id": "user-1" }).expect(400);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("400 on a limit above 100", async () => {
    await request(app).get(`/audiences/${ROW.id}/companies?limit=101`).set(HEADERS).expect(400);
  });

  it("404 for another org's audience, before any Apollo call", async () => {
    state.selectRow = null;
    await request(app).get(`/audiences/${ROW.id}/companies`).set(HEADERS).expect(404);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("an Apollo org fetch failure: successes billed + cached, hold released, 500", async () => {
    mockGetOrg.mockImplementation(async (_k: string, id: string) => {
      if (id === "org-b") throw new Error("Apollo organization fetch failed: 500 - boom");
      return FULL_ORG(id, "Alpha");
    });
    const res = await request(app).get(`/audiences/${ROW.id}/companies`).set(HEADERS).expect(500);
    expect(res.body.error).toContain("Apollo organization fetch failed");
    expect(mockAddCosts.mock.calls[1][1]).toEqual([{ costName: "apollo-credit", costSource: "platform", quantity: 1 }]);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("run-child", "cost-0", "cancelled", expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("run-child", "failed", expect.anything());
    expect(state.upserts.map((u) => u.id)).toEqual(["org-a"]);
  });
});

describe("groupEmployers / toFirmographics", () => {
  it("distinct employers in rank order, case-insensitive, first person kept, no-employer rows skipped", () => {
    const e = groupEmployers([teaser("A", "Acme"), teaser("B", "ACME "), teaser("C", null), teaser("D", "Zeta")] as any);
    expect(e.map((x) => [x.name, x.peopleInSample, x.person.firstName])).toEqual([
      ["Acme", 2, "A"],
      ["Zeta", 1, "D"],
    ]);
  });

  it("falls back to the free lookup's domain/website/logo and never invents the rest", () => {
    const f = toFirmographics({ id: "o1", name: "X", domain: "x.io", website_url: "http://x.io", logo_url: "l" }, null);
    expect(f).toMatchObject({ apolloOrganizationId: "o1", domain: "x.io", websiteUrl: "http://x.io", logoUrl: "l", industry: null, city: null, estimatedNumEmployees: null, keywords: [] });
    expect(Object.keys(f).join(",")).not.toMatch(/phone|email/i);
  });
});
