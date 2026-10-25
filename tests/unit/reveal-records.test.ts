import { describe, it, expect, vi, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { groupRevealRecords, normalizeAskedIds, type RevealRow } from "../../src/lib/reveal-records.js";

const findRevealRecords = vi.fn();
vi.mock("../../src/lib/reveal-records.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/reveal-records.js")>()),
  findRevealRecords: (ids: string[]) => findRevealRecords(ids),
}));

const row = (pid: string, email: string, n = 1): RevealRow => ({
  apollo_person_id: pid,
  email,
  first_at: "2026-02-25T03:34:36.597Z",
  last_at: new Date("2026-03-01T00:00:00.000Z"),
  reveals: String(n),
});

describe("groupRevealRecords", () => {
  it("one id, one email: unambiguous both ways", () => {
    const a = groupRevealRecords(["P1"], [row("P1", "m.kool@elvacenter.com", 2)]);
    expect(a.people).toEqual([
      {
        apolloPersonId: "P1",
        emails: [{ email: "m.kool@elvacenter.com", firstRevealedAt: "2026-02-25T03:34:36.597Z", lastRevealedAt: "2026-03-01T00:00:00.000Z", reveals: 2 }],
        unambiguousEmail: "m.kool@elvacenter.com",
      },
    ]);
    expect(a.emails).toEqual([{ email: "m.kool@elvacenter.com", apolloPersonIds: ["P1"] }]);
  });

  it("an id whose reveals returned two emails is not unambiguous", () => {
    const a = groupRevealRecords(["P1"], [row("P1", "b@x.com"), row("P1", "a@x.com")]);
    expect(a.people[0].emails.map((e) => e.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(a.people[0].unambiguousEmail).toBeNull();
    expect(a.emails).toEqual([
      { email: "a@x.com", apolloPersonIds: ["P1"] },
      { email: "b@x.com", apolloPersonIds: ["P1"] },
    ]);
  });

  it("an email shared by two ids (one not asked) maps back to both", () => {
    const a = groupRevealRecords(["P1"], [row("P1", "s@x.com"), row("P9", "s@x.com")]);
    expect(a.people).toHaveLength(1);
    expect(a.people[0].unambiguousEmail).toBeNull();
    expect(a.emails).toEqual([{ email: "s@x.com", apolloPersonIds: ["P1", "P9"] }]);
  });

  it("an id with no emailed reveal carries no email; request order kept", () => {
    const a = groupRevealRecords(["P2", "P1"], [row("P1", "a@x.com")]);
    expect(a.people.map((p) => p.apolloPersonId)).toEqual(["P2", "P1"]);
    expect(a.people[0]).toEqual({ apolloPersonId: "P2", emails: [], unambiguousEmail: null });
  });

  it("normalizeAskedIds trims, drops blanks, dedupes", () => {
    expect(normalizeAskedIds([" a ", "a", "", "b"])).toEqual(["a", "b"]);
  });
});

describe("POST /internal/reveal-records/by-person-ids", () => {
  let app: express.Express;
  beforeAll(async () => {
    process.env.APOLLO_SERVICE_API_KEY = "rr-key";
    const routes = (await import("../../src/routes/reveal-records.js")).default;
    app = express();
    app.use(express.json());
    app.use(routes);
  });

  it("401 without the service key", async () => {
    const r = await request(app).post("/internal/reveal-records/by-person-ids").send({ apolloPersonIds: ["P1"] });
    expect(r.status).toBe(401);
  });

  it("400 on empty list and on more than 1000 ids", async () => {
    const empty = await request(app).post("/internal/reveal-records/by-person-ids").set("x-api-key", "rr-key").send({ apolloPersonIds: [] });
    expect(empty.status).toBe(400);
    const big = await request(app)
      .post("/internal/reveal-records/by-person-ids")
      .set("x-api-key", "rr-key")
      .send({ apolloPersonIds: Array.from({ length: 1001 }, (_, i) => `P${i}`) });
    expect(big.status).toBe(400);
  });

  it("200 serves the lookup answer", async () => {
    findRevealRecords.mockResolvedValueOnce({ people: [], emails: [] });
    const r = await request(app).post("/internal/reveal-records/by-person-ids").set("x-api-key", "rr-key").send({ apolloPersonIds: ["P1"] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ people: [], emails: [] });
    expect(findRevealRecords).toHaveBeenCalledWith(["P1"]);
  });
});
