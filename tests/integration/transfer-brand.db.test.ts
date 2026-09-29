/**
 * POST /internal/transfer-brand against a REAL Postgres, one assertion per
 * table. Runs only when TRANSFER_BRAND_TEST_DATABASE_URL points at a throwaway
 * database (the suite migrates it from ./drizzle, then truncates every table):
 *
 *   createdb apollo_transfer_test
 *   TRANSFER_BRAND_TEST_DATABASE_URL="postgresql://$USER@localhost:5432/apollo_transfer_test?sslmode=disable" \
 *   APOLLO_SERVICE_DATABASE_URL="$TRANSFER_BRAND_TEST_DATABASE_URL" pnpm vitest run tests/integration/transfer-brand.db.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const DB_URL = process.env.TRANSFER_BRAND_TEST_DATABASE_URL;
const API_KEY = "transfer-test-key";

const S = randomUUID(); // source org (the agency)
const T = randomUUID(); // target org (the client)
const O = randomUUID(); // unrelated org
const A = randomUUID(); // brand being transferred
const B = randomUUID(); // other brand of the agency
const NEW_A = randomUUID(); // brand id in the target org, when rewritten

const TABLES = [
  "email_verifications",
  "email_finder_calls",
  "quickenrich_searches",
  "apollo_phone_reveals",
  "email_findings",
  "reveal_skips",
  "cost_holds",
  "apollo_people_searches",
  "apollo_people_enrichments",
  "apollo_search_cursors",
  "apollo_audiences",
] as const;

describe.skipIf(!DB_URL)("transfer-brand on a real database", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any;
  let app: express.Express;

  beforeAll(async () => {
    process.env.APOLLO_SERVICE_DATABASE_URL = DB_URL;
    process.env.APOLLO_SERVICE_API_KEY = API_KEY;
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    q = postgres(DB_URL!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(q), { migrationsFolder: "./drizzle" });
    const routes = (await import("../../src/routes/transfer-brand.js")).default;
    app = express();
    app.use(express.json());
    app.use(routes);
  });

  afterAll(async () => {
    await q?.end();
    const { getSql } = await import("../../src/db/index.js");
    await getSql().end();
  });

  /** Ids of every seeded row, keyed "<table>:<label>". */
  const ids: Record<string, string> = {};

  async function ins(table: string, label: string, row: Record<string, unknown>) {
    const values = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v])
    );
    let r;
    try {
      [r] = await q`INSERT INTO ${q(table)} ${q(values)} RETURNING id`;
    } catch (e) {
      throw new Error(`seed ${table}:${label}: ${(e as Error).message} ${JSON.stringify(row)}`);
    }
    ids[`${table}:${label}`] = String(r.id);
  }

  beforeEach(async () => {
    await q.unsafe(`TRUNCATE ${TABLES.join(", ")}`);

    // Rows carrying the brand directly (A), another brand (B), co-branded (A+B),
    // and the brand under an unrelated org (must never move: wrong source org).
    for (const [label, org, brands, camp] of [
      ["A", S, [A], "camp-a"],
      ["B", S, [B], "camp-b"],
      ["AB", S, [A, B], "camp-ab"],
      ["A_other_org", O, [A], "camp-o"],
    ] as const) {
      await ins("apollo_people_searches", label, { org_id: org, run_id: `run-s-${label}`, brand_ids: brands, campaign_id: camp });
      await ins("apollo_people_enrichments", label, {
        org_id: org, run_id: `run-e-${label}`, brand_ids: brands, campaign_id: camp, email: `${label}@lead.com`,
      });
      await ins("apollo_search_cursors", label, {
        org_id: org, campaign_id: camp, brand_ids: brands, search_params: { label },
      });
    }
    // Enrichment of brand A on a SECOND campaign: its campaign ties brandless rows too.
    await ins("apollo_people_enrichments", "A2", {
      org_id: S, run_id: "run-e-A2", brand_ids: [A], campaign_id: "camp-a2", email: "a2@lead.com",
    });

    await ins("apollo_audiences", "A", { org_id: S, brand_id: A, name: "a", description: "a", filters: {} });
    await ins("apollo_audiences", "B", { org_id: S, brand_id: B, name: "b", description: "b", filters: {} });
    await ins("apollo_audiences", "none", { org_id: S, brand_id: null, name: "n", description: "n", filters: {} });

    await ins("apollo_phone_reveals", "A", { org_id: S, apollo_person_id: "p1", brand_ids: [A], campaign_id: "camp-a" });
    await ins("apollo_phone_reveals", "A_by_campaign", { org_id: S, apollo_person_id: "p2", brand_ids: null, campaign_id: "camp-a2" });
    await ins("apollo_phone_reveals", "B_by_campaign", { org_id: S, apollo_person_id: "p3", brand_ids: [], campaign_id: "camp-b" });
    await ins("apollo_phone_reveals", "unattributed", { org_id: S, apollo_person_id: "p4", brand_ids: null, campaign_id: null });

    for (const [label, brands, camp] of [
      ["A", [A], "camp-a"],
      ["A_by_campaign", null, "camp-a"],
      ["B", [B], "camp-b"],
      ["unattributed", null, null],
    ] as const) {
      await ins("email_findings", label, {
        vendor: "treg", preset: "routed-max-6000", person_key: `k-${label}`, org_id: S, run_id: `run-f-${label}`,
        brand_ids: brands, campaign_id: camp, cost_name: "treg-micro-usd", status: "found", email: `f-${label}@lead.com`,
      });
      await ins("email_finder_calls", label, {
        finding_id: ids[`email_findings:${label}`], vendor: "treg", preset: "routed-max-6000", org_id: S,
        request_url: "https://treg", request_body: {},
      });
    }

    for (const [label, email, run] of [
      ["A_enrich", "a@lead.com", "run-e-A"],
      ["A_find", "f-a@lead.com", "run-f-A"],
      ["A_find_by_campaign", "f-a_by_campaign@lead.com", "run-f-A_by_campaign"],
      ["B_enrich", "b@lead.com", "run-e-B"],
      ["A_email_other_run", "a@lead.com", "run-unrelated"],
    ] as const) {
      await ins("email_verifications", label, { email, verifier: "bounceverify", org_id: S, run_id: run });
    }

    for (const [label, brands, camp] of [
      ["A", [A], "camp-a"],
      ["A_by_campaign", null, "camp-a2"],
      ["B", [B], "camp-b"],
      ["unattributed", null, null],
    ] as const) {
      await ins("reveal_skips", label, {
        org_id: S, run_id: `run-s-${label}`, brand_ids: brands, campaign_id: camp, apollo_person_id: `ps-${label}`,
        reason: "catch_all_domain", evidence: JSON.stringify([]),
      });
    }

    for (const [label, brands, camp] of [
      ["A", [A], "camp-a"],
      ["A_by_campaign", null, "camp-a2"],
      ["B", [B], "camp-b"],
      ["unattributed", null, null],
    ] as const) {
      await ins("cost_holds", label, {
        cost_id: `cost-${label}`, run_id: `run-h-${label}`, cost_name: "treg-micro-usd", cost_source: "platform",
        quantity: "10000", org_id: S, brand_ids: brands, campaign_id: camp,
      });
    }

    const aud = (l: string) => ids[`apollo_audiences:${l}`];
    const cur = (l: string) => ids[`apollo_search_cursors:${l}`];
    await ins("quickenrich_searches", "A_by_cursor", { org_id: S, cursor_id: cur("A"), campaign_id: "x1", request_body: {} });
    await ins("quickenrich_searches", "A_by_audience", { org_id: S, apollo_audience_id: aud("A"), campaign_id: "x2", request_body: {} });
    await ins("quickenrich_searches", "A_by_campaign", { org_id: S, campaign_id: "camp-a2", request_body: {} });
    await ins("quickenrich_searches", "B", { org_id: S, cursor_id: cur("B"), apollo_audience_id: aud("B"), campaign_id: "camp-b", request_body: {} });
  });

  /** Rows expected to MOVE, per table. Everything else must stay where it was. */
  const MOVES: Record<(typeof TABLES)[number], string[]> = {
    email_verifications: ["A_enrich", "A_find", "A_find_by_campaign"],
    email_finder_calls: ["A", "A_by_campaign"],
    quickenrich_searches: ["A_by_cursor", "A_by_audience", "A_by_campaign"],
    apollo_phone_reveals: ["A", "A_by_campaign"],
    email_findings: ["A", "A_by_campaign"],
    reveal_skips: ["A", "A_by_campaign"],
    cost_holds: ["A", "A_by_campaign"],
    apollo_people_searches: ["A"],
    apollo_people_enrichments: ["A", "A2"],
    apollo_search_cursors: ["A"],
    apollo_audiences: ["A"],
  };

  async function orgOf(table: string, label: string): Promise<string> {
    const [r] = await q`SELECT org_id FROM ${q(table)} WHERE id = ${ids[`${table}:${label}`]}`;
    return String(r.org_id);
  }

  const post = (body: Record<string, string>, key = API_KEY) =>
    request(app).post("/internal/transfer-brand").set("x-api-key", key).send(body);

  it("refuses a call without the service api key", async () => {
    const res = await post({ sourceBrandId: A, sourceOrgId: S, targetOrgId: T }, "wrong");
    expect(res.status).toBe(401);
    expect(await orgOf("apollo_people_enrichments", "A")).toBe(S);
  });

  it.each(TABLES)("%s: moves exactly the brand's rows, then re-running is a no-op", async (table) => {
    const res = await post({ sourceBrandId: A, sourceOrgId: S, targetOrgId: T });
    expect(res.status).toBe(200);
    const reported = res.body.updatedTables.find((t: { tableName: string }) => t.tableName === table);
    expect(reported.count).toBe(MOVES[table].length);

    const labels = Object.keys(ids).filter((k) => k.startsWith(`${table}:`)).map((k) => k.slice(table.length + 1));
    for (const label of labels) {
      const expected = MOVES[table].includes(label) ? T : label.endsWith("other_org") ? O : S;
      expect({ label, org: await orgOf(table, label) }).toEqual({ label, org: expected });
    }

    const again = await post({ sourceBrandId: A, sourceOrgId: S, targetOrgId: T });
    expect(again.status).toBe(200);
    expect(again.body.updatedTables.every((t: { count: number }) => t.count === 0)).toBe(true);
  });

  it("leaves nothing of the brand under the source org except co-branded rows", async () => {
    await post({ sourceBrandId: A, sourceOrgId: S, targetOrgId: T });
    for (const table of ["apollo_people_searches", "apollo_people_enrichments", "apollo_search_cursors", "apollo_phone_reveals", "email_findings", "reveal_skips"]) {
      const [r] = await q`SELECT count(*)::int n FROM ${q(table)} WHERE org_id = ${S} AND brand_ids = ARRAY[${A}]::text[]`;
      expect({ table, n: r.n }).toEqual({ table, n: 0 });
    }
    const [aud] = await q`SELECT count(*)::int n FROM apollo_audiences WHERE org_id = ${S} AND brand_id = ${A}`;
    expect(aud.n).toBe(0);
    expect(await orgOf("apollo_people_enrichments", "AB")).toBe(S);
  });

  it("rewrites the brand id to targetBrandId, idempotently", async () => {
    const res = await post({ sourceBrandId: A, sourceOrgId: S, targetOrgId: T, targetBrandId: NEW_A });
    expect(res.status).toBe(200);
    for (const table of ["apollo_people_searches", "apollo_people_enrichments", "apollo_search_cursors", "apollo_phone_reveals", "email_findings", "reveal_skips"]) {
      const rows = await q`SELECT brand_ids FROM ${q(table)} WHERE org_id = ${T} AND cardinality(brand_ids) > 0`;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect({ table, b: r.brand_ids }).toEqual({ table, b: [NEW_A] });
    }
    const [aud] = await q`SELECT brand_id FROM apollo_audiences WHERE id = ${ids["apollo_audiences:A"]}`;
    expect(aud.brand_id).toBe(NEW_A);
    // brandless campaign-tied rows keep no brand
    const [rev] = await q`SELECT brand_ids FROM apollo_phone_reveals WHERE id = ${ids["apollo_phone_reveals:A_by_campaign"]}`;
    expect(rev.brand_ids).toBeNull();
    // the unrelated org's copy of brand A is untouched
    const [other] = await q`SELECT org_id, brand_ids FROM apollo_people_enrichments WHERE id = ${ids["apollo_people_enrichments:A_other_org"]}`;
    expect(other).toEqual({ org_id: O, brand_ids: [A] });

    const again = await post({ sourceBrandId: A, sourceOrgId: S, targetOrgId: T, targetBrandId: NEW_A });
    expect(again.body.updatedTables.every((t: { count: number }) => t.count === 0)).toBe(true);
  });

  it("a run without targetBrandId followed by one with it finishes the rewrite", async () => {
    await post({ sourceBrandId: A, sourceOrgId: S, targetOrgId: T });
    const res = await post({ sourceBrandId: A, sourceOrgId: S, targetOrgId: T, targetBrandId: NEW_A });
    const enr = res.body.updatedTables.find((t: { tableName: string }) => t.tableName === "apollo_people_enrichments");
    expect(enr.count).toBe(2);
    const [r] = await q`SELECT count(*)::int n FROM apollo_people_enrichments WHERE brand_ids = ARRAY[${A}]::text[] AND org_id = ${T}`;
    expect(r.n).toBe(0);
  });
});
