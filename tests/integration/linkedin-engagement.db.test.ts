import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * The linkedin_engagement serve loop on a REAL Postgres (the candidate query,
 * the never-twice claim, exhaustion), with treg answered by fixtures shaped
 * like the live responses of 2026-10-03.
 * Run: LINKEDIN_ENGAGEMENT_TEST_DATABASE_URL=postgres://… (a throwaway DB).
 */
const DB_URL = process.env.LINKEDIN_ENGAGEMENT_TEST_DATABASE_URL;

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(async () => ({ id: "run-li" })),
  addCosts: vi.fn(async () => ({ costs: [{ id: "hold-1" }] })),
  updateCostStatus: vi.fn(async () => ({})),
  updateRun: vi.fn(async () => ({})),
}));
vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: vi.fn(async () => ({ sufficient: true, balance_cents: 1, required_cents: 1 })) }));
vi.mock("../../src/lib/keys-client.js", () => ({ decryptKey: vi.fn(async () => ({ key: "k", keySource: "platform" })) }));

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const POSTS = {
  output: {
    posts: [
      { url: "https://www.linkedin.com/posts/lemlist_a-activity-111", id: "111", text: "recent", datePublished: daysAgo(3) },
      { url: "https://www.linkedin.com/posts/lemlist_b-activity-222", id: "222", text: "old", datePublished: daysAgo(60) },
    ],
  },
};
const actor = (id: string, name: string, headline: string, url?: string) => ({ urn: `urn:li:fsd_profile:${id}`, name, headline, profileUrl: url ?? `https://www.linkedin.com/in/${id}`, profileId: id });
const ENGAGEMENT_111 = {
  reactions: [
    { reactionType: "LIKE", actor: actor("ACoAAAprospect1xxxxxxxxxxxxxxxxxxxxx", "Peter C.", "CEO @ Rodz | Provider for Lemlist") },
    { reactionType: "LIKE", actor: actor("ACoAAAemployee1xxxxxxxxxxxxxxxxxxxx", "Dean B.", "Events Manager") },
    { reactionType: "LIKE", actor: actor("ACoAAAprivate1xxxxxxxxxxxxxxxxxxxxx", "Ghost", "Private") },
    { reactionType: "LIKE", actor: { urn: "urn:li:fsd_company:9", name: "lemlist", profileUrl: "https://www.linkedin.com/company/lemlist/" } },
  ],
  comments: [
    { urn: "urn:li:comment:(activity:111,1)", text: "Great", createdAt: daysAgo(2), author: actor("ACoAAAprospect2xxxxxxxxxxxxxxxxxxxxx", "Ana Lima", "Head of Sales at Acme", "https://www.linkedin.com/in/ana-lima") },
  ],
  reactionsHasMore: false,
  commentsHasMore: false,
};
const PROFILES: Record<string, unknown> = {
  "https://www.linkedin.com/in/ACoAAAprospect1xxxxxxxxxxxxxxxxxxxxx": { firstName: "Peter", lastName: "Cools", title: "CEO @ Rodz", publicIdentifier: "coolspeter", url: "https://www.linkedin.com/in/coolspeter/", jobTitle: "CEO", companyName: "Rodz", companyPublicId: "rodzio", websites: [{ url: "https://rodz.io", category: "COMPANY" }] },
  "https://www.linkedin.com/in/ACoAAAemployee1xxxxxxxxxxxxxxxxxxxx": { firstName: "Dean", lastName: "Brown", title: "Events Manager", publicIdentifier: "dean-b", url: "https://www.linkedin.com/in/dean-b/", jobTitle: "Events Manager", companyName: "lemlist", companyPublicId: "lemlist" },
  "https://www.linkedin.com/in/ana-lima": { firstName: "Ana", lastName: "Lima", title: "Head of Sales at Acme", publicIdentifier: "ana-lima", url: "https://www.linkedin.com/in/ana-lima/", jobTitle: "Head of Sales", companyName: "Acme", companyPublicId: "acme" },
};

const calls: string[] = [];
let failProfileUrl: string | null = null;
function reply(status: number, body: unknown, cost: string) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-treg-cost-micro": cost } });
}

describe.skipIf(!DB_URL)("linkedin_engagement serve loop on a real database", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  const spec = { type: "linkedin_engagement" as const, window_days: 30, competitor_pages: ["https://www.linkedin.com/company/lemlist/"] };
  const ctx = (audienceId: string) => ({
    identity: { orgId: "11111111-1111-4111-8111-111111111111", userId: "u", brandIds: ["b1"], campaignId: "c1", audienceId },
    userId: "u",
    runId: "run-parent",
    tracking: { brandIds: ["b1"], campaignId: "c1", audienceId },
    callerPath: "/search/next",
  });

  beforeAll(async () => {
    process.env.APOLLO_SERVICE_DATABASE_URL = DB_URL;
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    q = postgres(DB_URL!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(q), { migrationsFolder: "./drizzle" });
    for (const t of ["linkedin_engagement_serves", "linkedin_profiles", "linkedin_post_engagements", "linkedin_company_posts", "linkedin_company_pages", "linkedin_treg_calls"]) {
      await q`TRUNCATE ${q(t)}`;
    }
    mod = await import("../../src/lib/linkedin-engagement.js");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body?: string }) => {
      if (url.includes("treg.linkedin.company.posts")) { calls.push("posts"); return reply(200, POSTS, "1880"); }
      if (url.includes("fetchinio.linkedin.post.engagement")) {
        calls.push(`engagement:${new URL(url).searchParams.get("postUrlOrUrn")}`);
        return reply(200, ENGAGEMENT_111, "3000");
      }
      if (url.includes("treg.linkedin.user.profile")) {
        const u = JSON.parse(init.body!).linkedin_url as string;
        calls.push(`profile:${u}`);
        if (u === failProfileUrl) return reply(500, { detail: "upstream exploded" }, "0");
        const raw = PROFILES[u];
        return raw ? reply(200, { output: {}, raw }, "1500") : reply(502, { detail: { error: "route_failed", tried: [{ outcome: "miss", charged_micro: 0 }] } }, "0");
      }
      throw new Error(`unexpected ${url}`);
    }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await q?.end();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it("serves the prospects of in-window posts, drops the employee and the unreadable, pays each fact once", async () => {
    const first = await mod.serveLinkedinEngagers({ ctx: ctx("aud-1"), campaignId: "c1", spec, now: NOW });
    expect(first.people.map((p: { name: string }) => p.name).sort()).toEqual(["Ana Lima", "Peter Cools"]);
    expect(first).toMatchObject({ excluded: 1, unresolvable: 1, poolSize: 4, done: false });
    // Only the in-window post's engagement is read; the 60-day-old one is not.
    expect(calls.filter((c) => c.startsWith("engagement"))).toEqual(["engagement:urn:li:activity:111"]);
    // The commenter is resolved from the public slug, not the opaque id.
    expect(calls).toContain("profile:https://www.linkedin.com/in/ana-lima");
    expect(first.chargedMicro).toBe(1880 + 3000 + 1500 * 3);
    calls.length = 0;

    const second = await mod.serveLinkedinEngagers({ ctx: ctx("aud-1"), campaignId: "c1", spec, now: NOW });
    expect(second).toMatchObject({ people: [], done: true });
    expect(calls).toEqual([]); // posts, engagement and profiles are all fresh in silver: nothing paid again
  });

  it("another audience gets the same people again (never-twice is per audience), from silver, for free", async () => {
    const res = await mod.serveLinkedinEngagers({ ctx: ctx("aud-2"), campaignId: "c2", spec, now: NOW });
    expect(res.people).toHaveLength(2);
    expect(res.chargedMicro).toBe(0);
    const [{ n }] = await q`SELECT count(*)::int n FROM linkedin_engagement_serves WHERE audience_key = 'audience:aud-2' AND status = 'served'`;
    expect(n).toBe(2);
  });

  it("evidence names the competitor post and the engagement", async () => {
    const [serve] = await q`SELECT profile_id, served_at FROM linkedin_engagement_serves WHERE audience_key = 'audience:aud-1' AND status = 'served' AND profile_id LIKE '%prospect2%'`;
    const ev = await mod.evidenceFor(serve.profile_id, spec, new Date(serve.served_at));
    expect(ev).toMatchObject({ type: "linkedin_engagement", source: "linkedin:company/lemlist", sourceUrl: "https://www.linkedin.com/posts/lemlist_a-activity-111", engagement: { kind: "comment", commentText: "Great" } });
    expect(ev.fact).toMatch(/^Commented on .* on a LinkedIn post by lemlist published around /);
    const served = await mod.findServed("11111111-1111-4111-8111-111111111111", serve.profile_id);
    expect(served.status).toBe("served");
    expect(await mod.findServed("11111111-1111-4111-8111-111111111111", "ACoAAAemployee1xxxxxxxxxxxxxxxxxxxx")).toBeNull();
  });

  it("a failed lookup fails the call and releases every claim it cannot hand back; the retry re-buys nothing", async () => {
    await q`DELETE FROM linkedin_profiles`;
    failProfileUrl = "https://www.linkedin.com/in/ana-lima";
    await expect(mod.serveLinkedinEngagers({ ctx: ctx("aud-3"), campaignId: "c3", spec, now: NOW })).rejects.toThrow(/HTTP 500/);
    // Peter resolved fine but was never returned: his claim is released, so is Ana's.
    const rows = await q`SELECT profile_id, status FROM linkedin_engagement_serves WHERE audience_key = 'audience:aud-3' ORDER BY profile_id`;
    expect(rows.map((r: { status: string }) => r.status).sort()).toEqual(["excluded", "unresolvable"]);
    expect(calls.filter((c) => c.startsWith("profile")).length).toBe(4);

    failProfileUrl = null;
    calls.length = 0;
    const retry = await mod.serveLinkedinEngagers({ ctx: ctx("aud-3"), campaignId: "c3", spec, now: NOW });
    expect(retry.people.map((p: { name: string }) => p.name).sort()).toEqual(["Ana Lima", "Peter Cools"]);
    expect(calls).toEqual(["profile:https://www.linkedin.com/in/ana-lima"]); // Peter came from silver
  });
});
