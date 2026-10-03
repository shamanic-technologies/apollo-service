import { describe, it, expect } from "vitest";
import {
  parseCompetitorPage,
  engagementRows,
  toResolvedProfile,
  isPublicProfileUrl,
  prospectRejection,
  engagementEvidence,
  linkedinEngagerToPerson,
  parseLinkedinPersonId,
  domainOf,
  type ResolvedProfile,
} from "../../src/lib/linkedin-engagement-spec.js";
import { filtersBesideEngagement } from "../../src/lib/linkedin-engagement.js";
import { isTregRoutedMiss } from "../../src/lib/email-finders.js";
import { canonicalLinkedinUrl } from "../../src/lib/quickenrich.js";
import { SearchFiltersSchema } from "../../src/schemas.js";
import { toApolloSearchParams } from "../../src/lib/transform.js";

const LEMLIST = parseCompetitorPage("https://www.linkedin.com/company/lemlist/")!;

// Real Fetchin engagement shapes (lemlist post, 2026-10-03), trimmed.
const ENGAGEMENT = {
  comments: [
    {
      urn: "urn:li:comment:(activity:7511686976262041600,7512032771129659392)",
      text: "This is the most LinkedIn thing I have ever seen",
      createdAt: "2026-10-03T06:16:19.458Z",
      author: { id: "urn:li:fsd_profile:ACoAACyJnqkBaYexZ5xJAQK5o78ddmR0UC3N5DI", name: "Raphael Redmer", headline: "Founder & Builder", profileUrl: "https://www.linkedin.com/in/raphael-redmer", publicId: "raphael-redmer", profileId: "ACoAACyJnqkBaYexZ5xJAQK5o78ddmR0UC3N5DI" },
    },
    {
      urn: "urn:li:comment:(activity:7511686976262041600,1)",
      text: "Thanks all!",
      createdAt: "2026-10-03T07:00:00.000Z",
      author: { id: "urn:li:fsd_company:1234", name: "lemlist", profileUrl: "https://www.linkedin.com/company/lemlist/" },
    },
  ],
  reactions: [
    { reactionType: "LIKE", actor: { urn: "urn:li:fsd_profile:ACoAAAoz5ykBx1GESlSHfymkBv7bNDtv9b9Ewng", name: "Peter Cools", headline: "CEO @ Rodz | #1 Intent Data Provider for Lemlist", profileUrl: "https://www.linkedin.com/in/ACoAAAoz5ykBx1GESlSHfymkBv7bNDtv9b9Ewng", profileId: "ACoAAAoz5ykBx1GESlSHfymkBv7bNDtv9b9Ewng" } },
    { reactionType: "LIKE", actor: { urn: "urn:li:fsd_company:99", name: "Some Company", profileUrl: "https://www.linkedin.com/company/some/" } },
  ],
  reactionsHasMore: false,
  commentsHasMore: false,
};

// Real treg.linkedin.user.profile `raw` (Fetchin) for the reactor above, trimmed.
const PROFILE_RAW = {
  firstName: "Peter",
  lastName: "Cools",
  title: "CEO @ Rodz | #1 Intent Data Provider for Lemlist",
  publicIdentifier: "coolspeter",
  url: "https://www.linkedin.com/in/coolspeter/",
  geoCountryName: "France",
  location: "Greater Nantes Metropolitan Area, France",
  jobTitle: "Founder & CEO",
  companyName: "Rodz",
  companyPublicId: "rodzio",
  companyLinkedinUrl: "https://www.linkedin.com/company/rodzio/",
  currentPosition: { name: "Rodz", publicIdentifier: "rodzio", url: "https://www.linkedin.com/company/rodzio/", title: "Founder & CEO" },
  websites: [{ url: "https://www.rodz.io/", category: "COMPANY" }],
};

function profile(over: Partial<ResolvedProfile>): ResolvedProfile {
  return { ...toResolvedProfile("p1", null, PROFILE_RAW), ...over };
}

describe("competitor pages", () => {
  it("accepts company and showcase page URLs, any spelling, and keys them on the lower-cased slug", () => {
    expect(parseCompetitorPage("https://www.linkedin.com/company/Lemlist")).toEqual({ slug: "lemlist", url: "https://www.linkedin.com/company/lemlist/" });
    expect(parseCompetitorPage("linkedin.com/company/hubspot/?trk=x")?.slug).toBe("hubspot");
    expect(parseCompetitorPage("https://fr.linkedin.com/showcase/hubspot-for-startups/")?.slug).toBe("hubspot-for-startups");
  });
  it("refuses anything that is not a company page", () => {
    expect(parseCompetitorPage("https://www.linkedin.com/in/coolspeter/")).toBeNull();
    expect(parseCompetitorPage("https://lemlist.com")).toBeNull();
    expect(parseCompetitorPage("lemlist")).toBeNull();
  });
});

describe("engagement rows", () => {
  it("keeps people, drops company pages, keys reactions by type and comments by urn", () => {
    const rows = engagementRows("7511686976262041600", "lemlist", ENGAGEMENT);
    expect(rows.map((r) => [r.kind, r.profileId])).toEqual([
      ["reaction", "ACoAAAoz5ykBx1GESlSHfymkBv7bNDtv9b9Ewng"],
      ["comment", "ACoAACyJnqkBaYexZ5xJAQK5o78ddmR0UC3N5DI"],
    ]);
    expect(rows[0]).toMatchObject({ ref: "LIKE", reactionType: "LIKE", commentedAt: null });
    expect(rows[1].commentedAt?.toISOString()).toBe("2026-10-03T06:16:19.458Z");
  });
});

describe("profiles", () => {
  it("reads the public slug, current employer and company website from the profile raw", () => {
    expect(toResolvedProfile("ACo1", { full_name: "Peter Cools" }, PROFILE_RAW)).toMatchObject({
      linkedinUrl: "https://www.linkedin.com/in/coolspeter/",
      firstName: "Peter",
      jobTitle: "Founder & CEO",
      companyName: "Rodz",
      companySlug: "rodzio",
      companyWebsite: "https://www.rodz.io/",
    });
  });
  it("tells a public profile URL from the opaque id form no email finder resolves", () => {
    expect(isPublicProfileUrl("https://www.linkedin.com/in/coolspeter/")).toBe(true);
    expect(isPublicProfileUrl("https://www.linkedin.com/in/ACoAAAoz5ykBx1GESlSHfymkBv7bNDtv9b9Ewng")).toBe(false);
    expect(isPublicProfileUrl(null)).toBe(false);
  });
});

describe("who is a prospect", () => {
  it("a partner who MENTIONS the competitor is a prospect", () => {
    expect(prospectRejection(profile({}), [LEMLIST])).toBeNull();
  });
  it("a current employee by employer slug is not (the headline alone missed lemlist's HR Ops)", () => {
    expect(prospectRejection(profile({ companySlug: "lemlist", headline: "HR Ops Specialist" }), [LEMLIST])).toBe("competitor_employee");
  });
  it("employer name equal to the page, or a headline saying 'at' / '@' the competitor, is an employee", () => {
    expect(prospectRejection(profile({ companySlug: null, companyName: "Lemlist" }), [LEMLIST])).toBe("competitor_employee");
    expect(prospectRejection(profile({ companySlug: null, companyName: null, headline: "Customer Success Manager @ lemlist" }), [LEMLIST])).toBe("competitor_employee");
    expect(prospectRejection(profile({ companySlug: null, companyName: null, headline: "CMO @lemlist | B2B SaaS" }), [LEMLIST])).toBe("competitor_employee");
    expect(prospectRejection(profile({ companySlug: null, companyName: null, headline: "Workplace and Events Manager at lemlist" }), [LEMLIST])).toBe("competitor_employee");
  });
  it("a longer company name that merely starts with the slug is not an employee", () => {
    expect(prospectRejection(profile({ companySlug: null, companyName: null, headline: "Sales at lemlistfans" }), [LEMLIST])).toBeNull();
  });
});

describe("teaser + evidence", () => {
  it("the teaser carries name, title, headline, employer and Apollo-form LinkedIn URL; nothing invented", () => {
    const p = linkedinEngagerToPerson(toResolvedProfile("ACo1", null, PROFILE_RAW), canonicalLinkedinUrl);
    expect(p).toMatchObject({
      id: "li:ACo1",
      name: "Peter Cools",
      title: "Founder & CEO",
      headline: "CEO @ Rodz | #1 Intent Data Provider for Lemlist",
      organizationName: "Rodz",
      organizationDomain: "rodz.io",
      linkedinUrl: "http://www.linkedin.com/in/coolspeter",
      email: null,
      seniority: null,
      organizationIndustry: null,
    });
    expect(parseLinkedinPersonId(p.id)).toBe("ACo1");
    expect(parseLinkedinPersonId("qe:1")).toBeNull();
    expect(domainOf("https://www.rodz.io/")).toBe("rodz.io");
  });
  it("a reaction is dated by its post (approximate, said so); a comment by itself", () => {
    const base = { pageSlug: "lemlist", postUrl: "https://www.linkedin.com/posts/x", postPublishedAt: new Date("2026-09-26T08:25:11Z"), reactionType: "LIKE", commentText: null, commentedAt: null };
    const reaction = engagementEvidence({ ...base, kind: "reaction" });
    expect(reaction).toMatchObject({ type: "linkedin_engagement", occurredOn: "2026-09-26", source: "linkedin:company/lemlist", sourceUrl: "https://www.linkedin.com/posts/x" });
    expect(reaction.fact).toBe("Reacted (like) to a LinkedIn post by lemlist published around September 26, 2026");
    const comment = engagementEvidence({ ...base, kind: "comment", reactionType: null, commentText: "Nice", commentedAt: new Date("2026-10-03T06:16:19Z") });
    expect(comment.occurredOn).toBe("2026-10-03");
    expect(comment.engagement).toMatchObject({ kind: "comment", commentText: "Nice", postPublishedOn: "2026-09-26" });
  });
});

describe("criterion validation", () => {
  const signal = { type: "linkedin_engagement", window_days: 30, competitor_pages: ["https://www.linkedin.com/company/lemlist/"] };
  it("1-3 company pages validate", () => {
    expect(SearchFiltersSchema.safeParse({ buying_signal: signal }).success).toBe(true);
  });
  it("missing / too many / wrong pages fail", () => {
    expect(SearchFiltersSchema.safeParse({ buying_signal: { ...signal, competitor_pages: undefined } }).success).toBe(false);
    expect(SearchFiltersSchema.safeParse({ buying_signal: { ...signal, competitor_pages: [] } }).success).toBe(false);
    expect(SearchFiltersSchema.safeParse({ buying_signal: { ...signal, competitor_pages: Array(4).fill(signal.competitor_pages[0]) } }).success).toBe(false);
    expect(SearchFiltersSchema.safeParse({ buying_signal: { ...signal, competitor_pages: ["https://lemlist.com"] } }).success).toBe(false);
  });
  it("the three Apollo signals are unchanged", () => {
    expect(SearchFiltersSchema.safeParse({ buying_signal: { type: "funding", window_days: 90 } }).success).toBe(true);
    expect(toApolloSearchParams({ buying_signal: { type: "funding", window_days: 90, as_of: "2026-09-29" } })).toEqual({ latest_funding_date_range: { min: "2026-07-01", max: "2026-09-29" } });
  });
  it("is never turned into an Apollo query", () => {
    expect(() => toApolloSearchParams({ buying_signal: signal })).toThrow(/not an Apollo People Search filter/);
  });
  it("Apollo targeting filters beside it are named; verified-email and empty fields are not", () => {
    expect(filtersBesideEngagement({ buying_signal: signal, contact_email_status: ["verified"], person_titles: [], q_keywords: "" })).toEqual([]);
    expect(filtersBesideEngagement({ buying_signal: signal, person_titles: ["CEO"], person_locations: ["France"] })).toEqual(["person_titles", "person_locations"]);
  });
});

describe("treg routed miss", () => {
  const body = (tried: unknown[]) => ({ detail: { error: "route_failed", endpoint_id: "treg.people.email.find", tried } });
  it("every child missed or was skipped, nothing charged: a real not-found", () => {
    expect(isTregRoutedMiss(502, body([{ outcome: "miss", charged_micro: 0 }, { outcome: "error", status: 403, charged_micro: 0 }, { outcome: "skipped", charged_micro: 0 }]))).toBe(true);
  });
  it("no child answered (errors only) is still a failure; anything else is not a miss", () => {
    expect(isTregRoutedMiss(502, body([{ outcome: "error", charged_micro: 0 }]))).toBe(false);
    expect(isTregRoutedMiss(500, body([{ outcome: "miss" }]))).toBe(false);
    expect(isTregRoutedMiss(502, { error: "upstream" })).toBe(false);
  });
});

describe("treg email find: an all-miss route is not_found, not a failure", () => {
  it("returns not_found with zero charge (so the finding is settled, never re-asked under this policy)", async () => {
    const { findWithTreg } = await import("../../src/lib/email-finders.js");
    const body = { detail: { error: "route_failed", endpoint_id: "treg.people.email.find", tried: [{ outcome: "miss", status: 200, charged_micro: 0 }, { outcome: "error", status: 403, charged_micro: 0 }] } };
    const fetchMock = async () => new Response(JSON.stringify(body), { status: 502, headers: { "content-type": "application/json", "x-treg-cost-micro": "0" } });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const r = await findWithTreg("t", "o", { linkedinUrl: "https://www.linkedin.com/in/raphael-redmer" }, "k");
      expect(r).toMatchObject({ outcome: "not_found", email: null, chargedQuantity: 0 });
    } finally {
      globalThis.fetch = original;
    }
  });
});
