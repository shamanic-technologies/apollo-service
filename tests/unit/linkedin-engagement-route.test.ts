import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Reveal domain gate: covered in reveal-domain-gate.test.ts; here it lets every reveal through.
vi.mock("../../src/lib/reveal-domain-gate.js", () => ({
  gateReveal: vi.fn().mockResolvedValue({ action: "reveal", basis: "no_employer" }),
  recordRevealSkip: vi.fn(),
  rememberTeaserEmployers: vi.fn().mockResolvedValue(undefined),
}));


/**
 * The linkedin_engagement buying signal on POST /search/next and POST /enrich:
 * validation, the branch away from Apollo, and the `li:` reveal via treg.
 */

const mockServeLinkedinEngagers = vi.fn();
const mockFindServed = vi.fn();
const mockLoadProfile = vi.fn();
const mockEvidenceFor = vi.fn();
vi.mock("../../src/lib/linkedin-engagement.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    serveLinkedinEngagers: (...a: unknown[]) => mockServeLinkedinEngagers(...a),
    findServed: (...a: unknown[]) => mockFindServed(...a),
    loadProfile: (...a: unknown[]) => mockLoadProfile(...a),
    evidenceFor: (...a: unknown[]) => mockEvidenceFor(...a),
  };
});

// Mock runs-client
const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });


const mockFindQuickenrichAudience = vi.fn();
const mockServeQuickenrichPage = vi.fn();
const mockLoadQuickenrichPerson = vi.fn();
vi.mock("../../src/lib/quickenrich-serve.js", () => ({
  findQuickenrichAudience: (...a: unknown[]) => mockFindQuickenrichAudience(...a),
  serveQuickenrichPage: (...a: unknown[]) => mockServeQuickenrichPage(...a),
  loadQuickenrichPerson: (...a: unknown[]) => mockLoadQuickenrichPerson(...a),
}));

const mockExecuteEmailFind = vi.fn();
vi.mock("../../src/lib/email-find-run.js", () => ({
  executeEmailFind: (...a: unknown[]) => mockExecuteEmailFind(...a),
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
  failOpenRun: vi.fn().mockResolvedValue(undefined),
}));

// Mock auth
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

// Stateful DB mock — tracks cursors
let mockCursor: Record<string, unknown> | null = null;
const mockInsertReturning = vi.fn();
const mockUpdateSet = vi.fn();
// Every cursor lookup (findCursorForParams via .where().limit(), and the
// no-params resume via .where().orderBy().limit()) resolves through this fn so
// tests can queue per-call responses (e.g. the onConflict race).
const mockCursorLookup = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: (...args: unknown[]) => mockInsertReturning(...args),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    }),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: (...args: unknown[]) => mockCursorLookup(...args),
          orderBy: vi.fn().mockImplementation(() => ({
            limit: (...args: unknown[]) => mockCursorLookup(...args),
          })),
        })),
      })),
    })),
    query: {
      apolloPeopleSearches: { findMany: vi.fn().mockResolvedValue([]) },
      apolloPeopleEnrichments: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleSearches: { id: { name: "id" } },
  apolloPeopleEnrichments: {
    id: { name: "id" },
    apolloPersonId: { name: "apollo_person_id" },
    campaignId: { name: "campaign_id" },
    orgId: { name: "org_id" },
  },
  apolloSearchCursors: {
    id: { name: "id" },
    orgId: { name: "org_id" },
    campaignId: { name: "campaign_id" },
    searchParams: { name: "search_params" },
    paramsHash: { name: "params_hash" },
    exhausted: { name: "exhausted" },
    updatedAt: { name: "updated_at" },
  },
}));

vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" }),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
}));

// Mock Apollo client
const mockSearchPeople = vi.fn();

vi.mock("../../src/lib/apollo-client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
  enrichPerson: vi.fn().mockResolvedValue({ person: null }),
  buildWaterfallWebhookUrl: () => undefined,
}));

function makePeople(ids: string[]) {
  return ids.map((id) => ({
    id,
    first_name: `First-${id}`,
    last_name: `Last-${id}`,
    name: `First-${id} Last-${id}`,
    email: `${id}@example.com`,
    email_status: "verified",
    title: "CEO",
    linkedin_url: null,
    organization: {
      id: `org-${id}`,
      name: `Company-${id}`,
      website_url: `https://${id}.com`,
      primary_domain: `${id}.com`,
      industry: "tech",
      estimated_num_employees: 50,
      annual_revenue: null,
    },
  }));
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const SEARCH_PARAMS = { personTitles: ["CEO"] };
const BASE_HEADERS = {
  "X-Campaign-Id": "campaign-1",
  "X-Brand-Id": "brand-1",
  "X-Run-Id": "run-parent-1",
};

const LI_PARAMS = {
  buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: ["https://www.linkedin.com/company/lemlist/"] },
};

const PROFILE = {
  profileId: "ACoAAAoz5ykB",
  publicIdentifier: "coolspeter",
  linkedinUrl: "https://www.linkedin.com/in/coolspeter/",
  firstName: "Peter",
  lastName: "Cools",
  headline: "CEO @ Rodz | #1 Intent Data Provider for Lemlist",
  jobTitle: "Founder & CEO",
  companyName: "Rodz",
  companySlug: "rodzio",
  companyLinkedinUrl: "https://www.linkedin.com/company/rodzio/",
  companyWebsite: "https://www.rodz.io/",
  country: "France",
  location: "Greater Nantes Metropolitan Area, France",
};

describe("linkedin_engagement serve path", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCursor = { id: "cursor-1", orgId: "org_test", campaignId: "campaign-1", searchParams: LI_PARAMS, currentPage: 1, totalEntries: 0, exhausted: false };
    mockCursorLookup.mockImplementation(() => Promise.resolve(mockCursor ? [mockCursor] : []));
    mockInsertReturning.mockResolvedValue([{ id: "record-1" }]);
    let n = 0;
    mockCreateRun.mockImplementation(() => Promise.resolve({ id: `run-${++n}` }));
    mockFindQuickenrichAudience.mockResolvedValue(null);
    app = createTestApp();
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    request(app).post(path).set("X-API-Key", "k").set("X-Org-Id", "org_test").set("X-User-Id", "user_test").set(BASE_HEADERS).set(extra).send(body);

  it("serves engagers, never calls Apollo, and says source=linkedin_engagement", async () => {
    mockServeLinkedinEngagers.mockResolvedValue({
      people: [{ id: "li:ACoAAAoz5ykB", firstName: "Peter", lastName: "Cools", title: "Founder & CEO", organizationName: "Rodz" }],
      done: false, poolSize: 42, considered: 3, excluded: 2, unresolvable: 0, skippedPages: [], calls: 4, chargedMicro: 9000,
    });
    const res = await post("/search/next", { searchParams: LI_PARAMS }).expect(200);
    expect(res.body).toMatchObject({ source: "linkedin_engagement", done: false, hasMore: true, totalEntries: 42 });
    expect(res.body.people[0]).toMatchObject({ id: "li:ACoAAAoz5ykB", organizationName: "Rodz" });
    expect(mockSearchPeople).not.toHaveBeenCalled();
    expect(mockServeQuickenrichPage).not.toHaveBeenCalled();
    const call = mockServeLinkedinEngagers.mock.calls[0][0];
    expect(call.campaignId).toBe("campaign-1");
    expect(call.spec).toEqual(LI_PARAMS.buying_signal);
    expect(call.ctx).toMatchObject({ runId: "run-parent-1", callerPath: "/search/next", identity: { orgId: "org_test", brandIds: ["brand-1"] } });
    // The cohort pin of the Apollo signals is never applied to this kind.
    expect(JSON.stringify(mockUpdateSet.mock.calls)).not.toContain("as_of");
  });

  it("nobody left: done=true with an empty page (a truthful exhaustion, not an empty success)", async () => {
    mockServeLinkedinEngagers.mockResolvedValue({ people: [], done: true, poolSize: 42, considered: 0, excluded: 0, unresolvable: 0, skippedPages: [], calls: 0, chargedMicro: 0 });
    const res = await post("/search/next", { searchParams: LI_PARAMS }).expect(200);
    expect(res.body).toMatchObject({ people: [], done: true, hasMore: false });
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ exhausted: true }));
  });

  it("every competitor page dead: a named 422 listing each page (permanent); an outage on all of them: 502 retryable", async () => {
    const { LinkedinCompetitorPagesUnreadableError } = await import("../../src/lib/linkedin-engagement.js");
    const pages = [{ page: "https://www.linkedin.com/showcase/eimmigration/", reason: "Company not found" }];
    mockServeLinkedinEngagers.mockRejectedValueOnce(new LinkedinCompetitorPagesUnreadableError(pages, true));
    const dead = await post("/search/next", { searchParams: LI_PARAMS }).expect(422);
    expect(dead.body).toMatchObject({ type: "competitor_pages_unreadable", source: "linkedin-engagement", pages, retryable: false });
    mockServeLinkedinEngagers.mockRejectedValueOnce(new LinkedinCompetitorPagesUnreadableError(pages, false));
    const outage = await post("/search/next", { searchParams: LI_PARAMS }).expect(502);
    expect(outage.body).toMatchObject({ type: "competitor_pages_unreadable", retryable: true });
  });

  it("missing competitor_pages is a named 400", async () => {
    const res = await post("/search/next", { searchParams: { buying_signal: { type: "linkedin_engagement", window_days: 30 } } }).expect(400);
    expect(JSON.stringify(res.body)).toContain("competitor_pages");
    expect(mockServeLinkedinEngagers).not.toHaveBeenCalled();
  });

  it("more than 3 pages, or a URL that is not a company page, is a 400", async () => {
    const four = ["a", "b", "c", "d"].map((s) => `https://www.linkedin.com/company/${s}/`);
    await post("/search/next", { searchParams: { buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: four } } }).expect(400);
    const res = await post("/search/next", { searchParams: { buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: ["https://www.linkedin.com/in/someone/"] } } }).expect(400);
    expect(JSON.stringify(res.body)).toContain("LinkedIn company page URL");
    expect(mockServeLinkedinEngagers).not.toHaveBeenCalled();
  });

  it("competitor_pages on an Apollo signal is a 400", async () => {
    await post("/search/next", { searchParams: { buying_signal: { type: "hiring", window_days: 30, competitor_pages: ["https://www.linkedin.com/company/lemlist/"] } } }).expect(400);
  });

  it("Apollo targeting filters beside the signal are refused by name (they cannot be enforced)", async () => {
    const res = await post("/search/next", { searchParams: { ...LI_PARAMS, person_titles: ["CEO"] } }).expect(400);
    expect(res.body.fields).toEqual(["person_titles"]);
    expect(mockServeLinkedinEngagers).not.toHaveBeenCalled();
  });

  it("an org that cannot pay gets a 402", async () => {
    const { LinkedinEngagementInsufficientCreditError } = await import("../../src/lib/linkedin-engagement.js");
    mockServeLinkedinEngagers.mockRejectedValue(new LinkedinEngagementInsufficientCreditError(0, 1));
    const res = await post("/search/next", { searchParams: LI_PARAMS }).expect(402);
    expect(res.body).toMatchObject({ type: "credit_insufficient", source: "linkedin-engagement" });
  });

  it("/search/dry-run refuses the signal by name instead of counting the ICP without it", async () => {
    const res = await post("/search/dry-run", LI_PARAMS).expect(400);
    expect(res.body.validationErrors[0]).toContain("not an Apollo People Search filter");
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("/enrich li: finds the email from the public profile + company domain and attaches the evidence", async () => {
    mockFindServed.mockResolvedValue({ signal: LI_PARAMS.buying_signal, servedAt: new Date("2026-10-03T10:00:00Z") });
    mockLoadProfile.mockResolvedValue(PROFILE);
    const evidence = { type: "linkedin_engagement", occurredOn: "2026-09-26", fact: "Reacted (like) to a LinkedIn post by lemlist published around September 26, 2026", source: "linkedin:company/lemlist", sourceUrl: "https://www.linkedin.com/posts/x" };
    mockEvidenceFor.mockResolvedValue(evidence);
    const verdict = { email: "peter@rodz.io", verdict: "valid", deliverable: true };
    mockExecuteEmailFind.mockResolvedValue({ status: 200, body: { findingId: "f-1", status: "found", email: "peter@rodz.io", mailboxStatus: "valid", reused: false, emailVerification: verdict } });
    const res = await post("/enrich", { apolloPersonId: "li:ACoAAAoz5ykB" }).expect(200);
    const [, vendor, , person] = mockExecuteEmailFind.mock.calls[0];
    expect(vendor).toBe("treg");
    expect(person).toEqual({ linkedinUrl: "https://www.linkedin.com/in/coolspeter/", firstName: "Peter", lastName: "Cools", domain: "rodz.io" });
    expect(res.body).toMatchObject({ source: "linkedin_engagement", emailVerification: verdict, buyingSignal: evidence });
    expect(res.body.person).toMatchObject({ id: "li:ACoAAAoz5ykB", email: "peter@rodz.io", organizationName: "Rodz", organizationDomain: "rodz.io", linkedinUrl: "http://www.linkedin.com/in/coolspeter" });
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("/enrich li: not found → the person with no email and no verdict", async () => {
    mockFindServed.mockResolvedValue({ signal: LI_PARAMS.buying_signal, servedAt: new Date() });
    mockLoadProfile.mockResolvedValue(PROFILE);
    mockEvidenceFor.mockResolvedValue(null);
    mockExecuteEmailFind.mockResolvedValue({ status: 200, body: { findingId: "f-2", status: "not_found", email: null, mailboxStatus: null, reused: false, emailVerification: null } });
    const res = await post("/enrich", { apolloPersonId: "li:ACoAAAoz5ykB" }).expect(200);
    expect(res.body.person).toMatchObject({ email: null });
    expect(res.body.emailVerification).toBeNull();
  });

  it("/enrich li: a person never served to this org is a 404 and nothing is spent", async () => {
    mockFindServed.mockResolvedValue(null);
    await post("/enrich", { apolloPersonId: "li:nobody" }).expect(404);
    expect(mockExecuteEmailFind).not.toHaveBeenCalled();
  });
});
