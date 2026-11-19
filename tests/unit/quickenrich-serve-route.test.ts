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
 * The QuickEnrich serve path on POST /search/next and POST /enrich: the
 * switch, the fall-through to Apollo, and the `qe:` reveal via treg.
 */

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
  QuickenrichSearchError: class QuickenrichSearchError extends Error {
    constructor(message: string) {
      super(`quickenrich search failed: ${message}`);
      this.name = "QuickenrichSearchError";
    }
  },
}));

const mockServeFreePeoplePage = vi.fn();
const mockLoadFreeSourcePerson = vi.fn();
vi.mock("../../src/lib/free-people-serve.js", () => ({
  serveFreePeoplePage: (...a: unknown[]) => mockServeFreePeoplePage(...a),
  loadFreeSourcePerson: (...a: unknown[]) => mockLoadFreeSourcePerson(...a),
  planFreeSources: () => [],
}));

const mockFindStockEmail = vi.fn();
const mockFindStockEmailFor = vi.fn();
const mockFindGuessedEmail = vi.fn();
const mockVerifyStockEmail = vi.fn();
vi.mock("../../src/lib/company-stock.js", () => ({
  loadCompanyStock: vi.fn().mockResolvedValue(new Map()),
  applyCompanyStock: (p: unknown) => p,
}));
vi.mock("../../src/lib/email-stock.js", () => ({
  findStockEmail: (...a: unknown[]) => mockFindStockEmail(...a),
  findStockEmailFor: (...a: unknown[]) => mockFindStockEmailFor(...a),
  findGuessedEmail: (...a: unknown[]) => mockFindGuessedEmail(...a),
  verifyStockEmail: (...a: unknown[]) => mockVerifyStockEmail(...a),
}));

const mockExecuteEmailFind = vi.fn();
vi.mock("../../src/lib/email-find-run.js", () => ({
  executeEmailFind: (...a: unknown[]) => mockExecuteEmailFind(...a),
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
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

// A real, active prod audience (human-service "South Employed Chiropractors").
const QE_PARAMS = {
  person_titles: ["Chiropractor", "Doctor of Chiropractic", "Chiropractic Physician"],
  person_locations: ["Texas, US", "Florida, US"],
  person_not_titles: ["Owner", "Student"],
  include_similar_titles: true,
};

const QE_ROW = {
  emp_id: 777,
  first_name: "Dana",
  last_name: "Reyes",
  title: "Chiropractor",
  employee_linkedin: "https://www.linkedin.com/in/dana-reyes",
  has_email: true,
  company_url: "backinline.com",
  company_name: "Back In Line",
  locality: "Austin, Texas, United States",
};

function qePerson() {
  return { id: "qe:777", firstName: "Dana", lastName: "Reyes", linkedinUrl: "http://www.linkedin.com/in/dana-reyes", organizationDomain: "backinline.com" };
}

describe("QuickEnrich serve path", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCursor = { id: "cursor-1", orgId: "org_test", campaignId: "campaign-1", searchParams: QE_PARAMS, currentPage: 1, totalEntries: 0, exhausted: false };
    mockCursorLookup.mockImplementation(() => Promise.resolve(mockCursor ? [mockCursor] : []));
    mockInsertReturning.mockResolvedValue([{ id: "record-1" }]);
    mockSearchPeople.mockResolvedValue({ people: makePeople(["p1"]), total_entries: 1 });
    let n = 0;
    mockCreateRun.mockImplementation(() => Promise.resolve({ id: `run-${++n}` }));
    mockFindQuickenrichAudience.mockResolvedValue(null);
    mockFindStockEmail.mockResolvedValue(null);
    mockFindStockEmailFor.mockResolvedValue(null);
    mockFindGuessedEmail.mockResolvedValue(null);
    app = createTestApp();
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  const post = (path: string, body: unknown) =>
    request(app).post(path).set("X-API-Key", "k").set("X-Org-Id", "org_test").set("X-User-Id", "user_test").set(BASE_HEADERS).send(body);

  it("switch OFF: serves from Apollo and never touches QuickEnrich", async () => {
    const res = await post("/search/next", { searchParams: QE_PARAMS }).expect(200);
    expect(mockServeQuickenrichPage).not.toHaveBeenCalled();
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(res.body.source).toBeUndefined();
  });

  it("switch ON: serves QuickEnrich people (full identity, free) and makes NO Apollo call", async () => {
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1" });
    mockServeQuickenrichPage.mockResolvedValue({ people: [qePerson()], exhausted: false, pagesRead: 1, rowsSeen: 100, rejected: {} });
    const res = await post("/search/next", { searchParams: QE_PARAMS }).expect(200);
    expect(res.body).toMatchObject({ source: "quickenrich", done: false, hasMore: true });
    expect(res.body.people[0]).toMatchObject({ id: "qe:777", linkedinUrl: "http://www.linkedin.com/in/dana-reyes" });
    expect(mockSearchPeople).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
    const call = mockServeQuickenrichPage.mock.calls[0][0];
    expect(call.cursorId).toBe("cursor-1");
    expect(call.apolloAudienceId).toBe("aud-1");
    expect(call.plan.body.title.exclude).toEqual(["Owner", "Student"]);
  });

  it("switch ON, QuickEnrich page filtered empty but not dry: done=false so the caller keeps paging", async () => {
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1" });
    mockServeQuickenrichPage.mockResolvedValue({ people: [], exhausted: false, pagesRead: 5, rowsSeen: 500, rejected: { location: 500 } });
    const res = await post("/search/next", { searchParams: QE_PARAMS }).expect(200);
    expect(res.body).toMatchObject({ people: [], done: false, source: "quickenrich" });
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("switch ON, QuickEnrich has nobody left: falls through to the Apollo walk", async () => {
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1" });
    mockServeQuickenrichPage.mockResolvedValue({ people: [], exhausted: true, pagesRead: 1, rowsSeen: 3, rejected: {} });
    const res = await post("/search/next", { searchParams: QE_PARAMS }).expect(200);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(res.body.source).toBeUndefined();
    expect(res.body.people[0].id).toBe("p1");
  });

  it("switch ON, QuickEnrich search fails (treg 429/5xx): this call is served by Apollo, never a 500", async () => {
    const { QuickenrichSearchError } = await import("../../src/lib/quickenrich-serve.js");
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1" });
    mockServeQuickenrichPage.mockRejectedValue(new QuickenrichSearchError("HTTP 429 - rate limited"));
    const res = await post("/search/next", { searchParams: QE_PARAMS }).expect(200);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(res.body.source).toBeUndefined();
  });

  it("switch ON, an audience with a constraint QuickEnrich cannot enforce: served from QuickEnrich, the rest left to the judge", async () => {
    const params = { ...QE_PARAMS, q_organization_keyword_tags: ["chiropractic clinic"] };
    mockCursor = { ...mockCursor!, searchParams: params };
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1" });
    mockServeQuickenrichPage.mockResolvedValue({ people: [qePerson()], exhausted: false, pagesRead: 1, rowsSeen: 100, rejected: {} });
    const res = await post("/search/next", { searchParams: params }).expect(200);
    expect(res.body.source).toBe("quickenrich");
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("switch ON but the audience is not expressible (a location it cannot parse): serves from Apollo, never QuickEnrich", async () => {
    const params = { ...QE_PARAMS, person_locations: ["Bay Area, Nowhereland"] };
    mockCursor = { ...mockCursor!, searchParams: params };
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1" });
    await post("/search/next", { searchParams: params }).expect(200);
    expect(mockServeQuickenrichPage).not.toHaveBeenCalled();
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  it("/enrich qe: finds the email with treg from the stored identity and returns the verdict", async () => {
    mockLoadQuickenrichPerson.mockResolvedValue(QE_ROW);
    const verdict = { email: "dana@backinline.com", verdict: "valid", deliverable: true };
    mockExecuteEmailFind.mockResolvedValue({
      status: 200,
      body: { findingId: "f-1", status: "found", email: "dana@backinline.com", mailboxStatus: "valid", reused: false, emailVerification: verdict },
    });
    const res = await post("/enrich", { apolloPersonId: "qe:777" }).expect(200);
    const [ctx, vendor, preset, person] = mockExecuteEmailFind.mock.calls[0];
    expect(vendor).toBe("treg");
    expect(preset).toBeUndefined();
    expect(person).toEqual({ linkedinUrl: QE_ROW.employee_linkedin, firstName: "Dana", lastName: "Reyes", domain: "backinline.com" });
    expect(ctx).toMatchObject({ orgId: "org_test", runId: "run-parent-1", callerPath: "/enrich" });
    expect(res.body).toMatchObject({ source: "quickenrich", findingId: "f-1", cached: false, emailVerification: verdict });
    expect(res.body.person).toMatchObject({ id: "qe:777", email: "dana@backinline.com", emailStatus: "valid", seniority: null, employmentHistory: null });
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("/enrich qe: not found → the person with no email (the consumer records the serve and moves on)", async () => {
    mockLoadQuickenrichPerson.mockResolvedValue(QE_ROW);
    mockExecuteEmailFind.mockResolvedValue({ status: 200, body: { findingId: "f-2", status: "not_found", email: null, mailboxStatus: null, reused: true, emailVerification: null } });
    const res = await post("/enrich", { apolloPersonId: "qe:777" }).expect(200);
    expect(res.body.person).toMatchObject({ id: "qe:777", email: null });
    expect(res.body.emailVerification).toBeNull();
    expect(res.body.cached).toBe(true);
  });

  it("/enrich qe: a find failure is passed through, loud", async () => {
    mockLoadQuickenrichPerson.mockResolvedValue(QE_ROW);
    mockExecuteEmailFind.mockResolvedValue({ status: 402, body: { type: "credit_insufficient", error: "Insufficient credits" } });
    const res = await post("/enrich", { apolloPersonId: "qe:777" }).expect(402);
    expect(res.body.type).toBe("credit_insufficient");
  });

  // APOLLO-ZERO-COST-1119: our stock first (an address a reveal or a find of
  // ours already returned for this person, any org), treg only on a miss.
  it("/enrich qe: an address already in our stock is served free, treg never called", async () => {
    mockLoadQuickenrichPerson.mockResolvedValue(QE_ROW);
    mockFindStockEmail.mockResolvedValue({ email: "dana@backinline.com", source: "apollo-reveal" });
    const verdict = { email: "dana@backinline.com", verdict: "valid", deliverable: true, verifier: "bounceban", verificationId: "v-9", verifiedAt: "2026-11-01T00:00:00.000Z", reused: true };
    mockVerifyStockEmail.mockResolvedValue(verdict);
    const res = await post("/enrich", { apolloPersonId: "qe:777" }).expect(200);
    expect(mockExecuteEmailFind).not.toHaveBeenCalled();
    expect(mockFindStockEmail).toHaveBeenCalledWith(expect.objectContaining({ employee_linkedin: QE_ROW.employee_linkedin }));
    expect(res.body).toMatchObject({ source: "quickenrich", cached: true, stock: "apollo-reveal", emailVerification: verdict });
    expect(res.body.person).toMatchObject({ id: "qe:777", email: "dana@backinline.com" });
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("/enrich qe: a stock miss goes to treg as before", async () => {
    mockLoadQuickenrichPerson.mockResolvedValue(QE_ROW);
    mockFindStockEmail.mockResolvedValue(null);
    mockExecuteEmailFind.mockResolvedValue({ status: 200, body: { findingId: "f-3", status: "not_found", email: null, mailboxStatus: null, reused: false, emailVerification: null } });
    await post("/enrich", { apolloPersonId: "qe:777" }).expect(200);
    expect(mockExecuteEmailFind).toHaveBeenCalledTimes(1);
  });

  // APOLLO-ZERO-COST-1119: serveSource "free" = Leadsforge → Dropleads → QuickEnrich → Apollo.
  const LF_PERSON = { source: "leadsforge", externalId: "abc", firstName: "Julie", lastName: "Angstadt", title: "Owner", linkedinUrl: null, companyName: "Hummingbird ABA", companyDomain: "hummingbirdaba.com", industry: "mental health care", employees: 29, city: null, state: null, country: "United States" };

  it("free: Leadsforge people are served, QuickEnrich and Apollo untouched", async () => {
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1", serveSource: "free" });
    mockServeFreePeoplePage.mockResolvedValue({ people: [{ id: "lf:abc", name: "Julie Angstadt" }], source: "leadsforge", exhausted: false, pagesRead: 1, skipped: [], leftToJudge: [], failed: [] });
    const res = await post("/search/next", { searchParams: QE_PARAMS }).expect(200);
    expect(res.body).toMatchObject({ source: "leadsforge", done: false, people: [{ id: "lf:abc" }] });
    expect(mockServeQuickenrichPage).not.toHaveBeenCalled();
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("free: every free source walked out → QuickEnrich next", async () => {
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1", serveSource: "free" });
    mockServeFreePeoplePage.mockResolvedValue({ people: [], source: null, exhausted: true, pagesRead: 0, skipped: [], leftToJudge: [], failed: [] });
    mockServeQuickenrichPage.mockResolvedValue({ people: [qePerson()], exhausted: false, pagesRead: 1, rowsSeen: 100, rejected: {} });
    const res = await post("/search/next", { searchParams: QE_PARAMS }).expect(200);
    expect(res.body.source).toBe("quickenrich");
  });

  it("free: a source failing for this call never stalls the serve (the next layer answers)", async () => {
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1", serveSource: "free" });
    mockServeFreePeoplePage.mockResolvedValue({ people: [], source: null, exhausted: false, pagesRead: 0, skipped: [], leftToJudge: [], failed: [{ source: "leadsforge", error: "HTTP 429" }] });
    mockServeQuickenrichPage.mockResolvedValue({ people: [], exhausted: true, pagesRead: 1, rowsSeen: 0, rejected: {} });
    await post("/search/next", { searchParams: QE_PARAMS }).expect(200);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  it("free: free sources out + a sector QuickEnrich cannot enforce → Apollo, never sector-less QuickEnrich", async () => {
    const params = { ...QE_PARAMS, q_organization_keyword_tags: ["chiropractic clinic"] };
    mockCursor = { ...mockCursor!, searchParams: params };
    mockFindQuickenrichAudience.mockResolvedValue({ id: "aud-1", serveSource: "free" });
    mockServeFreePeoplePage.mockResolvedValue({ people: [], source: null, exhausted: true, pagesRead: 0, skipped: [], leftToJudge: [], failed: [] });
    await post("/search/next", { searchParams: params }).expect(200);
    expect(mockServeQuickenrichPage).not.toHaveBeenCalled();
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  it("/enrich lf: stock hit is free, treg and Apollo never called", async () => {
    mockLoadFreeSourcePerson.mockResolvedValue(LF_PERSON);
    mockFindStockEmailFor.mockResolvedValue({ email: "julie@hummingbirdaba.com", source: "email-finding" });
    mockVerifyStockEmail.mockResolvedValue({ email: "julie@hummingbirdaba.com", verdict: "valid", deliverable: true, verifier: "trykitt", verificationId: "v1", verifiedAt: "2026-11-19T00:00:00.000Z", reused: false });
    const res = await post("/enrich", { apolloPersonId: "lf:abc" }).expect(200);
    expect(mockFindStockEmailFor).toHaveBeenCalledWith({ linkedinUrl: null, firstName: "Julie", lastName: "Angstadt", domain: "hummingbirdaba.com" });
    expect(mockExecuteEmailFind).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ source: "leadsforge", stock: "email-finding", cached: true, person: { id: "lf:abc", email: "julie@hummingbirdaba.com" } });
  });

  it("/enrich lf: stock miss, a guessed address checked valid → served, treg never called", async () => {
    mockLoadFreeSourcePerson.mockResolvedValue(LF_PERSON);
    const verification = { email: "jangstadt@hummingbirdaba.com", verdict: "valid", deliverable: true, verifier: "trykitt", verificationId: "v2", verifiedAt: "2026-11-19T00:00:00.000Z", reused: false };
    mockFindGuessedEmail.mockResolvedValue({ email: "jangstadt@hummingbirdaba.com", verification });
    const res = await post("/enrich", { apolloPersonId: "lf:abc" }).expect(200);
    expect(mockFindGuessedEmail.mock.calls[0][0]).toEqual({ firstName: "Julie", lastName: "Angstadt", domain: "hummingbirdaba.com" });
    expect(mockExecuteEmailFind).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ stock: "pattern-guess", cached: false, emailVerification: verification, person: { email: "jangstadt@hummingbirdaba.com" } });
  });

  it("/enrich lf: stock miss → treg find by name + domain", async () => {
    mockLoadFreeSourcePerson.mockResolvedValue(LF_PERSON);
    mockExecuteEmailFind.mockResolvedValue({ status: 200, body: { findingId: "f-9", status: "found", email: "julie@hummingbirdaba.com", mailboxStatus: "valid", reused: false, emailVerification: { verdict: "valid" } } });
    const res = await post("/enrich", { apolloPersonId: "lf:abc" }).expect(200);
    expect(mockExecuteEmailFind.mock.calls[0][3]).toEqual({ linkedinUrl: undefined, firstName: "Julie", lastName: "Angstadt", domain: "hummingbirdaba.com" });
    expect(res.body).toMatchObject({ source: "leadsforge", findingId: "f-9", person: { email: "julie@hummingbirdaba.com" } });
  });

  it("/enrich dl: an id never served is a 404, nothing spent", async () => {
    mockLoadFreeSourcePerson.mockResolvedValue(null);
    await post("/enrich", { apolloPersonId: "dl:1" }).expect(404);
    expect(mockExecuteEmailFind).not.toHaveBeenCalled();
  });

  it("/enrich qe: an id /search/next never served is a 404, nothing spent", async () => {
    mockLoadQuickenrichPerson.mockResolvedValue(null);
    await post("/enrich", { apolloPersonId: "qe:999" }).expect(404);
    expect(mockExecuteEmailFind).not.toHaveBeenCalled();
  });
});
