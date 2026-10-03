import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * POST /audiences/signal-coverage and POST /audiences/signal: an audience =
 * ICP + one buying signal + a recency window, sized with free Apollo counts.
 */

const state: { baseRow: any; inserted: any[] } = { baseRow: undefined, inserted: [] };

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { id: "11111111-1111-4111-8111-111111111111", ...v };
          state.inserted.push(row);
          return [row];
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (state.baseRow ? [state.baseRow] : []) }) }) }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloAudiences: { id: { name: "id" }, orgId: { name: "org_id" } },
  apolloOrganizations: { id: { name: "id" } },
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"];
    req.userId = req.headers["x-user-id"];
    next();
  },
  orgAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: vi.fn(async () => ({ key: "k", keySource: "platform" })),
}));

// Counts by which signal field Apollo received: proves each signal reaches Apollo as its own filter.
const mockSearchPeople = vi.fn(async (_k: unknown, p: any) => {
  let total = 5000;
  if (p.organization_job_posted_at_range) total = p.q_organization_job_titles ? 12 : 800;
  if (p.person_days_in_current_title_range) total = 40;
  if (p.latest_funding_date_range) total = 3;
  // Page rows: the funded people all work at ONE firm; everyone else at their own.
  const rows = p.per_page === 100 && total <= 100
    ? Array.from({ length: total }, (_, i) => ({ organization: { name: p.latest_funding_date_range ? "Acme Capital" : `Firm ${i}` } }))
    : [];
  return { total_entries: total, people: rows };
});
vi.mock("../../src/lib/apollo-client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  searchPeople: (...a: [unknown, any]) => mockSearchPeople(...a),
}));

const H = { "x-org-id": "22222222-2222-4222-8222-222222222222", "x-user-id": "u1" };
const ICP = { person_titles: ["Owner"], person_locations: ["United States"], organization_num_employees_ranges: ["2,20"] };

async function app() {
  const a = express();
  a.use(express.json());
  a.use((await import("../../src/routes/audiences.js")).default);
  return a;
}

beforeEach(() => {
  state.baseRow = undefined;
  state.inserted = [];
  mockSearchPeople.mockClear();
});

describe("POST /audiences/signal-coverage", () => {
  it("counts every signal per window for an ICP, free, nothing stored", async () => {
    const res = await request(await app()).post("/audiences/signal-coverage").set(H).send({ filters: ICP, windowDays: [30] }).expect(200);
    expect(res.body.baseCount).toBe(5000);
    expect(res.body.signals.map((s: any) => [s.type, s.count])).toEqual([
      ["hiring", 800],
      ["job_change", 40],
      ["funding", 3],
    ]);
    // A people count hides concentration: 3 funded people, ONE firm.
    expect(res.body.signals[2]).toMatchObject({ companies: 1, companiesExact: true });
    expect(res.body.signals[1]).toMatchObject({ companies: 40, companiesExact: true });
    expect(state.inserted).toHaveLength(0);
    // Only the free teaser search is ever called (zero credits).
    for (const [, p] of mockSearchPeople.mock.calls) expect([1, 100]).toContain(p.per_page);
  });

  it("narrows hiring by job titles, and reads the ICP from a stored audience", async () => {
    state.baseRow = { id: "a", name: "Clinic owners", brandId: "b1", filters: ICP };
    const res = await request(await app())
      .post("/audiences/signal-coverage")
      .set(H)
      .send({ apolloAudienceId: "33333333-3333-4333-8333-333333333333", windowDays: [90], jobTitles: ["office manager"] })
      .expect(200);
    expect(res.body.signals[0]).toMatchObject({ type: "hiring", windowDays: 90, jobTitles: ["office manager"], count: 12, companies: 12 });
  });

  it("404 for an unknown base audience; 400 without exactly one base", async () => {
    const a = await app();
    await request(a).post("/audiences/signal-coverage").set(H).send({ apolloAudienceId: "33333333-3333-4333-8333-333333333333" }).expect(404);
    await request(a).post("/audiences/signal-coverage").set(H).send({}).expect(400);
  });
});

describe("POST /audiences/signal", () => {
  it("persists ICP + relative signal (never an absolute date) and returns the size estimate", async () => {
    state.baseRow = { id: "a", name: "Clinic owners", brandId: "b1", filters: ICP };
    const res = await request(await app())
      .post("/audiences/signal")
      .set(H)
      .send({ apolloAudienceId: "33333333-3333-4333-8333-333333333333", signal: { type: "funding", windowDays: 90 } })
      .expect(200);
    expect(res.body.count).toBe(3);
    expect(res.body.name).toBe("Clinic owners · Recently funded (last 90 days)");
    expect(res.body.filters).toEqual({ ...ICP, buying_signal: { type: "funding", window_days: 90 } });
    expect(state.inserted[0]).toMatchObject({ brandId: "b1", count: 3, filters: res.body.filters });
    expect(res.body.window.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses job titles on a non-hiring signal and an ICP that already sets the signal's field", async () => {
    const a = await app();
    await request(a).post("/audiences/signal").set(H).send({ filters: ICP, signal: { type: "funding", windowDays: 30, jobTitles: ["cfo"] } }).expect(400);
    const res = await request(a)
      .post("/audiences/signal")
      .set(H)
      .send({ filters: { ...ICP, latest_funding_date_range: { min: "2020-01-01" } }, signal: { type: "funding", windowDays: 30 } })
      .expect(400);
    expect(res.body.fields).toEqual(["latest_funding_date_range"]);
    expect(state.inserted).toHaveLength(0);
  });

  it("linkedin_engagement: persists the criterion with no Apollo call; size null until the first serve", async () => {
    const res = await request(await app())
      .post("/audiences/signal")
      .set(H)
      .send({ filters: {}, signal: { type: "linkedin_engagement", windowDays: 30, competitorPages: ["https://www.linkedin.com/company/Lemlist"] } })
      .expect(200);
    expect(res.body.filters).toEqual({ buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: ["https://www.linkedin.com/company/lemlist/"] } });
    expect(res.body.count).toBeNull();
    expect(res.body.name).toBe("Engaged with competitor posts (lemlist, last 30 days)");
    expect(mockSearchPeople).not.toHaveBeenCalled();
    expect(state.inserted[0]).toMatchObject({ filters: res.body.filters });
  });

  it("linkedin_engagement: no pages, a non-company URL, or Apollo filters beside it are named 400s", async () => {
    const a = await app();
    const none = await request(a).post("/audiences/signal").set(H).send({ filters: {}, signal: { type: "linkedin_engagement", windowDays: 30 } }).expect(400);
    expect(none.body.fields).toEqual(["signal.competitorPages"]);
    await request(a).post("/audiences/signal").set(H).send({ filters: {}, signal: { type: "linkedin_engagement", windowDays: 30, competitorPages: ["https://lemlist.com"] } }).expect(400);
    const beside = await request(a).post("/audiences/signal").set(H).send({ filters: ICP, signal: { type: "linkedin_engagement", windowDays: 30, competitorPages: ["https://www.linkedin.com/company/lemlist/"] } }).expect(400);
    expect(beside.body.fields).toEqual(["person_titles", "person_locations", "organization_num_employees_ranges"]);
    await request(a).post("/audiences/signal").set(H).send({ filters: ICP, signal: { type: "funding", windowDays: 30, competitorPages: ["https://www.linkedin.com/company/lemlist/"] } }).expect(400);
    expect(state.inserted).toHaveLength(0);
  });
});
