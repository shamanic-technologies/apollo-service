/**
 * POST /internal/reveal-records/person-facts against a REAL Postgres. Runs only
 * when PERSON_FACTS_TEST_DATABASE_URL points at a throwaway database:
 *
 *   createdb apollo_person_facts_test
 *   PERSON_FACTS_TEST_DATABASE_URL="postgresql://$USER@localhost:5432/apollo_person_facts_test?sslmode=disable" \
 *   APOLLO_SERVICE_DATABASE_URL="$PERSON_FACTS_TEST_DATABASE_URL" pnpm vitest run tests/integration/person-facts.db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const DB_URL = process.env.PERSON_FACTS_TEST_DATABASE_URL;
const KEY = "person-facts-key";

describe.skipIf(!DB_URL)("person-facts on a real database", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any;
  let app: express.Express;

  beforeAll(async () => {
    process.env.APOLLO_SERVICE_DATABASE_URL = DB_URL;
    process.env.APOLLO_SERVICE_API_KEY = KEY;
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    q = postgres(DB_URL!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(q), { migrationsFolder: "./drizzle" });
    await q`TRUNCATE apollo_people_enrichments CASCADE`;
    const org = randomUUID();
    // Insert a bare reveal row, then set its fact columns (jsonb keywords cast from text).
    const ins = async (pid: string, at: string, f: Record<string, string>, keywords?: string[]) => {
      const [{ id }] = await q`INSERT INTO apollo_people_enrichments (org_id, run_id, brand_ids, apollo_person_id, created_at)
        VALUES (${org}, ${"run-" + randomUUID()}, ${q.array([randomUUID()])}, ${pid}, ${at}) RETURNING id`;
      if (Object.keys(f).length) await q`UPDATE apollo_people_enrichments SET ${q(f)} WHERE id = ${id}`;
      if (keywords) await q`UPDATE apollo_people_enrichments SET organization_keywords = ${JSON.stringify(keywords)}::jsonb WHERE id = ${id}`;
    };
    // Older reveal (previous job), then the latest one with the current job.
    await ins("P_KNOWN", "2026-07-01T00:00:00Z", { title: "Old Title", organization_name: "Old Co", email: "x@old.com" });
    await ins("P_KNOWN", "2026-08-01T00:00:00Z", {
      title: "Head of Operations",
      headline: "Ops at Elva",
      seniority: "head",
      city: "Tallinn",
      country: "Estonia",
      email: "m.kool@elvacenter.com",
      mobile_phone: "+3725550000",
      organization_name: "Elva Center",
      organization_domain: "elvacenter.com",
      organization_industry: "events services",
      organization_size: "26",
      organization_country: "Estonia",
    }, ["event management", "conference planning"]);
    // A later reveal that came back empty must not hide the facts above.
    await ins("P_KNOWN", "2026-09-01T00:00:00Z", {});
    const routes = (await import("../../src/routes/reveal-records.js")).default;
    app = express();
    app.use(express.json());
    app.use(routes);
  });

  afterAll(async () => {
    await q`TRUNCATE apollo_people_enrichments CASCADE`;
    await q.end();
    const { getSql } = await import("../../src/db/index.js");
    await getSql().end();
  });

  it("returns the stored title and employer for a revealed id and known:false for an unknown id, in one call", async () => {
    const r = await request(app)
      .post("/internal/reveal-records/person-facts")
      .set("x-api-key", KEY)
      .send({ apolloPersonIds: ["P_KNOWN", "P_UNKNOWN"] });
    expect(r.status).toBe(200);
    expect(r.body.people).toEqual([
      {
        apolloPersonId: "P_KNOWN",
        known: true,
        revealedAt: "2026-08-01T00:00:00.000Z",
        title: "Head of Operations",
        headline: "Ops at Elva",
        seniority: "head",
        city: "Tallinn",
        state: null,
        country: "Estonia",
        organization: {
          name: "Elva Center",
          domain: "elvacenter.com",
          industry: "events services",
          employees: 26,
          city: null,
          state: null,
          country: "Estonia",
          keywords: ["event management", "conference planning"],
        },
      },
      {
        apolloPersonId: "P_UNKNOWN",
        known: false,
        revealedAt: null,
        title: null,
        headline: null,
        seniority: null,
        city: null,
        state: null,
        country: null,
        organization: null,
      },
    ]);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain("@");
    expect(body).not.toContain("+372");
  });
});
