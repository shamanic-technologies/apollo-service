import { describe, it, expect } from "vitest";
import { POSTS_PROVIDERS, postsVerdict, isToolUnavailable } from "../../src/lib/linkedin-company-posts.js";
import { parseCompetitorPage } from "../../src/lib/linkedin-engagement-spec.js";

/** Bodies captured live through treg on 2026-10-04 (trimmed). */
const [scrapecreators, tikhub, harvestapi] = POSTS_PROVIDERS;
const page = parseCompetitorPage("https://www.linkedin.com/company/docketwise-software/")!;

describe("posts providers", () => {
  it("are tried cheapest-reliable first: scrapecreators, tikhub, harvestapi; never the withdrawn routed id", () => {
    expect(POSTS_PROVIDERS.map((p) => p.endpoint)).toEqual([
      "scrapecreators.x.v1-linkedin-company-posts",
      "tikhub.x.linkedin-web-v2-get-company-posts",
      "harvestapi.linkedin.company.posts",
    ]);
    expect(scrapecreators.query(page)).toEqual({ url: "https://www.linkedin.com/company/docketwise-software/" });
    expect(harvestapi.query(page)).toEqual({ companyUniversalName: "docketwise-software", page: "1" });
  });

  it("all three read the same post id and date from their own shape", () => {
    const sc = postsVerdict(scrapecreators, 200, { success: true, posts: [{ url: "https://www.linkedin.com/posts/dw-activity-7509019123050373120-g", id: "7509019123050373120", text: "Immigration firms", datePublished: "2026-09-27T11:54:23.731Z" }] });
    const tk = postsVerdict(tikhub, 200, { code: 200, data: { data: [{ urn: "7509019123050373120", share_urn: "7509019121637003264", url: "https://www.linkedin.com/posts/dw-activity-7509019123050373120-g", text: "Immigration firms", posted: "2026-09-24 22:41:09" }], paging: { count: 50 } } });
    const hv = postsVerdict(harvestapi, 200, { elements: [{ id: "7509019123050373120", linkedinUrl: "https://www.linkedin.com/posts/dw-activity-7509019123050373120-g", content: "Immigration firms", postedAt: { date: "2026-09-24T22:41:09.764Z" } }] });
    for (const v of [sc, tk, hv]) {
      expect(v.kind).toBe("posts");
      expect((v as { posts: Array<{ id: string }> }).posts[0].id).toBe("7509019123050373120");
    }
    expect((tk as { posts: Array<{ datePublished: string }> }).posts[0].datePublished).toBe("2026-09-24T22:41:09.000Z");
  });

  it("a page the provider does not know is not_found, in each provider's own words", () => {
    expect(postsVerdict(scrapecreators, 404, { success: true, credits_charged: 0, error: "not_found", errorStatus: 404, message: "Company not found" }).kind).toBe("not_found");
    expect(postsVerdict(tikhub, 200, { code: 200, data: { data: null } }).kind).toBe("not_found");
    expect(postsVerdict(harvestapi, 200, { pagination: null, elements: null, error: "No valid target provided", status: 400 }).kind).toBe("not_found");
  });

  it("a withdrawn tool, a rate limit or an outage says nothing about the page: next provider", () => {
    const withdrawn = { detail: "no tool 'treg.linkedin.company.posts' in this org" };
    expect(isToolUnavailable(404, withdrawn)).toBe(true);
    expect(postsVerdict(scrapecreators, 404, withdrawn).kind).toBe("next");
    expect(postsVerdict(scrapecreators, 429, { error: "rate limited" }).kind).toBe("next");
    expect(postsVerdict(tikhub, 503, null).kind).toBe("next");
  });

  it("any other 4xx or an unreadable 200 fails loud (never retried elsewhere, never guessed)", () => {
    expect(postsVerdict(scrapecreators, 400, { error: "bad url" }).kind).toBe("fail");
    expect(postsVerdict(scrapecreators, 200, { success: true }).kind).toBe("fail");
    expect(postsVerdict(harvestapi, 200, { elements: null, error: "Something else" }).kind).toBe("fail");
  });
});
