import { describe, it, expect, vi, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { shapePersonFacts, type PersonFactsRow } from "../../src/lib/person-facts.js";

const findPersonFacts = vi.fn();
vi.mock("../../src/lib/person-facts.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/person-facts.js")>()),
  findPersonFacts: (ids: string[]) => findPersonFacts(ids),
}));

const row = (pid: string, f: Partial<PersonFactsRow> = {}): PersonFactsRow => ({
  apollo_person_id: pid,
  created_at: "2026-08-01T00:00:00.000Z",
  title: null,
  headline: null,
  seniority: null,
  city: null,
  state: null,
  country: null,
  organization_name: null,
  organization_domain: null,
  organization_industry: null,
  organization_size: null,
  organization_city: null,
  organization_state: null,
  organization_country: null,
  organization_keywords: null,
  ...f,
});

describe("shapePersonFacts", () => {
  it("one answer per asked id in request order; an id with no reveal is known:false", () => {
    const out = shapePersonFacts(["P2", "P1"], [row("P1", { title: " CEO ", organization_name: "Acme", organization_size: "120", organization_keywords: ["saas", "", 3] })]);
    expect(out.map((p) => [p.apolloPersonId, p.known])).toEqual([["P2", false], ["P1", true]]);
    expect(out[0].organization).toBeNull();
    expect(out[1].title).toBe("CEO");
    expect(out[1].organization).toMatchObject({ name: "Acme", employees: 120, keywords: ["saas"] });
  });

  it("a reveal with nothing about the employer has organization null; a non-numeric size is null", () => {
    const [a, b] = shapePersonFacts(["A", "B"], [row("A", { title: "VP" }), row("B", { organization_name: "X", organization_size: "11-50" })]);
    expect(a.organization).toBeNull();
    expect(b.organization?.employees).toBeNull();
  });
});

describe("POST /internal/reveal-records/person-facts", () => {
  let app: express.Express;
  beforeAll(async () => {
    process.env.APOLLO_SERVICE_API_KEY = "pf-key";
    const routes = (await import("../../src/routes/reveal-records.js")).default;
    app = express();
    app.use(express.json());
    app.use(routes);
  });

  it("401 without the service key", async () => {
    const r = await request(app).post("/internal/reveal-records/person-facts").send({ apolloPersonIds: ["P1"] });
    expect(r.status).toBe(401);
  });

  it("400 on empty list and on more than 1000 ids", async () => {
    const empty = await request(app).post("/internal/reveal-records/person-facts").set("x-api-key", "pf-key").send({ apolloPersonIds: [] });
    expect(empty.status).toBe(400);
    const big = await request(app)
      .post("/internal/reveal-records/person-facts")
      .set("x-api-key", "pf-key")
      .send({ apolloPersonIds: Array.from({ length: 1001 }, (_, i) => `P${i}`) });
    expect(big.status).toBe(400);
  });

  it("200 wraps the lookup in people", async () => {
    findPersonFacts.mockResolvedValueOnce([]);
    const r = await request(app).post("/internal/reveal-records/person-facts").set("x-api-key", "pf-key").send({ apolloPersonIds: ["P1"] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ people: [] });
    expect(findPersonFacts).toHaveBeenCalledWith(["P1"]);
  });
});
