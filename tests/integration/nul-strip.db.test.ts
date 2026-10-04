import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * A person carrying U+0000 (Apollo, 2026-10-04: an employment_history
 * description "Stajyerl\u0000...") must write to jsonb AND text columns through
 * the real client, and serve back without the NUL.
 * Run: NUL_STRIP_TEST_DATABASE_URL=postgres://… (a throwaway DB).
 */
const DB_URL = process.env.NUL_STRIP_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("NUL in provider data on a real database", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbMod: any, schema: any, transform: any, orm: any;

  const person = {
    id: "nul-person-1",
    first_name: "Ay\u0000se",
    last_name: "Yilmaz",
    name: "Ayse Yilmaz",
    title: "Biomedical Engineer",
    employment_history: [
      { title: "Biomedical Engineer", organization_name: "Acme", description: "Stajyerl\u0000ik programi", current: true },
    ],
  };

  beforeAll(async () => {
    process.env.APOLLO_SERVICE_DATABASE_URL = DB_URL;
    dbMod = await import("../../src/db/index.js");
    schema = await import("../../src/db/schema.js");
    transform = await import("../../src/lib/transform.js");
    orm = await import("drizzle-orm");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    // Same order as src/index.ts: a second drizzle() over the shared client
    // re-assigns the json serializers; the strip must survive it.
    await migrate(drizzle(dbMod.getSql()), { migrationsFolder: "./drizzle" });
  });

  afterAll(async () => {
    await dbMod?.getSql().end();
  });

  it("writes the search (jsonb response_raw) and the enrichment (jsonb + text)", async () => {
    const orgId = crypto.randomUUID();
    const [search] = await dbMod.db.insert(schema.apolloPeopleSearches).values({
      orgId, runId: "run-nul", brandIds: ["b1"], campaignId: "c-nul",
      requestParams: { q: "x" }, peopleCount: 1, totalEntries: 1,
      responseRaw: { people: [person] },
    }).returning();

    const [enrichment] = await dbMod.db.insert(schema.apolloPeopleEnrichments).values({
      orgId, runId: "run-nul", searchId: search.id, brandIds: ["b1"], campaignId: "c-nul",
      ...transform.toEnrichmentDbValues(person),
    }).returning();

    expect(search.responseRaw.people[0].employment_history[0].description).toBe("Stajyerlik programi");
    expect(enrichment.firstName).toBe("Ayse");
    expect(enrichment.employmentHistory[0].description).toBe("Stajyerlik programi");
  });

  it("raw sql parameters are stripped too", async () => {
    const sql = dbMod.getSql();
    const [row] = await sql`SELECT ${"a\u0000b"}::text AS t, ${JSON.stringify({ d: "x\u0000y" })}::jsonb AS j`;
    expect(row.t).toBe("ab");
    expect(row.j).toEqual({ d: "xy" });
  });

  it("serves the transformed person (what /search/next returns) with no NUL", async () => {
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const { stripNulReplacer } = await import("../../src/lib/nul-strip.js");
    const app = express();
    app.set("json replacer", stripNulReplacer); // as src/index.ts
    app.get("/search/next", async (_req, res) => {
      const stored = await dbMod.db.select().from(schema.apolloPeopleEnrichments).where(orm.eq(schema.apolloPeopleEnrichments.runId, "run-nul"));
      res.json({ people: [transform.transformApolloPerson(person)], cachedCount: stored.length, done: false });
    });
    const res = await request(app).get("/search/next");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("\\u0000");
    expect(res.body.cachedCount).toBeGreaterThan(0);
    expect(res.body.people[0].employmentHistory[0].description).toBe("Stajyerlik programi");
  });
});
