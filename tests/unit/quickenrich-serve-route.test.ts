import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

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

  it("switch ON but the audience is not expressible: serves from Apollo, never QuickEnrich", async () => {
    const params = { ...QE_PARAMS, q_organization_keyword_tags: ["chiropractic"] };
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

  it("/enrich qe: an id /search/next never served is a 404, nothing spent", async () => {
    mockLoadQuickenrichPerson.mockResolvedValue(null);
    await post("/enrich", { apolloPersonId: "qe:999" }).expect(404);
    expect(mockExecuteEmailFind).not.toHaveBeenCalled();
  });
});
