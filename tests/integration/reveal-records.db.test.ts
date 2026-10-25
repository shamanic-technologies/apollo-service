/**
 * POST /internal/reveal-records/by-person-ids against a REAL Postgres. Runs only
 * when REVEAL_RECORDS_TEST_DATABASE_URL points at a throwaway database:
 *
 *   createdb apollo_reveal_records_test
 *   REVEAL_RECORDS_TEST_DATABASE_URL="postgresql://$USER@localhost:5432/apollo_reveal_records_test?sslmode=disable" \
 *   APOLLO_SERVICE_DATABASE_URL="$REVEAL_RECORDS_TEST_DATABASE_URL" pnpm vitest run tests/integration/reveal-records.db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const DB_URL = process.env.REVEAL_RECORDS_TEST_DATABASE_URL;
const KEY = "reveal-records-key";

describe.skipIf(!DB_URL)("reveal-records on a real database", () => {
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
    const ins = (pid: string | null, email: string | null, at: string) =>
      q`INSERT INTO apollo_people_enrichments (org_id, run_id, brand_ids, apollo_person_id, email, created_at)
        VALUES (${org}, ${"run-" + randomUUID()}, ${q.array([randomUUID()])}, ${pid}, ${email}, ${at})`;
    await ins("5e75c13314e7fc0001f50753", "m.kool@elvacenter.com", "2026-02-25T03:34:36Z");
    await ins("5e75c13314e7fc0001f50753", " M.Kool@ElvaCenter.com ", "2026-03-01T00:00:00Z");
    await ins("TWO", "one@x.com", "2026-02-01T00:00:00Z");
    await ins("TWO", "two@x.com", "2026-02-02T00:00:00Z");
    await ins("SHARED_A", "shared@x.com", "2026-02-01T00:00:00Z");
    await ins("SHARED_B", "shared@x.com", "2026-02-03T00:00:00Z");
    await ins("NOMAIL", null, "2026-02-01T00:00:00Z");
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

  it("answers the four shapes from stored reveals", async () => {
    const r = await request(app)
      .post("/internal/reveal-records/by-person-ids")
      .set("x-api-key", KEY)
      .send({ apolloPersonIds: ["5e75c13314e7fc0001f50753", "TWO", "SHARED_A", "NOMAIL", "UNKNOWN"] });
    expect(r.status).toBe(200);
    const [kool, two, shared, nomail, unknown] = r.body.people;
    expect(kool).toEqual({
      apolloPersonId: "5e75c13314e7fc0001f50753",
      emails: [{ email: "m.kool@elvacenter.com", firstRevealedAt: "2026-02-25T03:34:36.000Z", lastRevealedAt: "2026-03-01T00:00:00.000Z", reveals: 2 }],
      unambiguousEmail: "m.kool@elvacenter.com",
    });
    expect(two.emails.map((e: { email: string }) => e.email)).toEqual(["one@x.com", "two@x.com"]);
    expect(two.unambiguousEmail).toBeNull();
    expect(shared.unambiguousEmail).toBeNull();
    expect(nomail).toEqual({ apolloPersonId: "NOMAIL", emails: [], unambiguousEmail: null });
    expect(unknown).toEqual({ apolloPersonId: "UNKNOWN", emails: [], unambiguousEmail: null });
    expect(r.body.emails).toEqual([
      { email: "m.kool@elvacenter.com", apolloPersonIds: ["5e75c13314e7fc0001f50753"] },
      { email: "one@x.com", apolloPersonIds: ["TWO"] },
      { email: "shared@x.com", apolloPersonIds: ["SHARED_A", "SHARED_B"] },
      { email: "two@x.com", apolloPersonIds: ["TWO"] },
    ]);
  });
});
