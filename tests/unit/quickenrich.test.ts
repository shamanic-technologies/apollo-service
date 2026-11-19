import { describe, it, expect } from "vitest";
import {
  canonicalLinkedinUrl,
  employeeBandsFor,
  locationMatches,
  parseApolloLocation,
  parseLocality,
  parseQuickenrichPersonId,
  planQuickenrich,
  leavesSectorToJudge,
  quickenrichToPerson,
  revenueBandsFor,
  rowMatchesPlan,
  titleContains,
  type QuickenrichPlan,
  type QuickenrichRow,
} from "../../src/lib/quickenrich.js";

// Real active prod audiences (human-service, 2026-09-26).
const US_CHIRO_EXACT = {
  person_titles: ["Chiropractor", "Doctor of Chiropractic", "Chiropractic Physician"],
  person_locations: ["United States"],
  include_similar_titles: false,
};
const SOUTH_CHIRO = {
  person_titles: ["Chiropractor", "Doctor of Chiropractic", "Chiropractic Physician"],
  person_locations: ["Texas, US", "Florida, US", "Georgia, US", "Virginia, US"],
  person_not_titles: ["Owner", "Founder", "Partner", "Student", "Assistant"],
  include_similar_titles: true,
};
const SG_OFFICE = {
  person_titles: ["Office Manager"],
  revenue_range: { max: 100000000, min: 10000000 },
  person_locations: ["Singapore"],
  include_similar_titles: true,
  organization_num_employees_ranges: ["100,1000"],
};
const KEYWORD_AUDIENCE = {
  person_titles: ["Pharmacist"],
  person_locations: ["Switzerland"],
  q_organization_keyword_tags: ["drogerie"],
  person_seniorities: ["owner"],
};

function row(over: Partial<QuickenrichRow>): QuickenrichRow {
  return {
    emp_id: 1,
    first_name: "Dana",
    last_name: "Reyes",
    title: "Chiropractor",
    employee_linkedin: "https://www.linkedin.com/in/dana-reyes",
    has_email: true,
    company_url: "backinline.com",
    company_name: "Back In Line",
    locality: "Austin, Texas, United States",
    ...over,
  };
}

function plan(filters: Record<string, unknown>): QuickenrichPlan {
  const p = planQuickenrich(filters);
  if (!p.ok) throw new Error(p.reasons.join("; "));
  return p.plan;
}

describe("planQuickenrich — faithfulness", () => {
  it("expresses the real title + location audiences", () => {
    const p = plan(SOUTH_CHIRO);
    expect(p.body).toEqual({
      title: { include: SOUTH_CHIRO.person_titles, exclude: SOUTH_CHIRO.person_not_titles },
      has_email: true,
      locality: { include: ["Texas", "Florida", "Georgia", "Virginia"], exclude: [] },
    });
    expect(p.exactTitles).toBe(false);
    expect(plan(US_CHIRO_EXACT).exactTitles).toBe(true);
  });

  it("maps aligned headcount + revenue spans onto QuickEnrich bands", () => {
    const p = plan(SG_OFFICE);
    expect(p.body.number_of_employees).toEqual({ include: ["100 - 249", "250 - 499", "500 - 999"], exclude: [] });
    expect(p.body.revenue).toEqual({ include: ["10 - 20 Million", "20 - 50 Million", "50 - 100 Million"], exclude: [] });
  });

  // APOLLO-ZERO-COST-1119 (owner 2026-11-19: Apollo paid reveal last): a
  // constraint QuickEnrich cannot enforce no longer keeps the audience on
  // Apollo. It is served looser and LEFT TO THE JUDGE (the consumer's pre-pay
  // screen judges every candidate against the audience's own text), and named.
  it("serves an audience with constraints it cannot enforce, and names each one left to the judge", () => {
    const p = planQuickenrich(KEYWORD_AUDIENCE);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.leftToJudge.some((r) => r.startsWith("q_organization_keyword_tags"))).toBe(true);
      expect(p.leftToJudge.some((r) => r.startsWith("person_seniorities"))).toBe(true);
      expect(p.plan.body.title).toEqual({ include: ["Pharmacist"], exclude: [] });
      expect(p.plan.body.locality).toEqual({ include: ["Switzerland"], exclude: [] });
    }
  });

  it("leaves organization locations to the judge (QuickEnrich's company address is unreliable)", () => {
    const p = planQuickenrich({ person_titles: ["CEO"], organization_locations: ["United States"] });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.leftToJudge.some((r) => r.startsWith("organization_locations"))).toBe(true);
  });

  it("an enforceable audience leaves nothing to the judge", () => {
    const p = planQuickenrich(SOUTH_CHIRO);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.leftToJudge).toEqual([]);
  });

  it("refuses a buying signal (a dated window QuickEnrich cannot see would be silently dropped)", () => {
    const p = planQuickenrich({ person_titles: ["CEO"], buying_signal: { type: "funding", window_days: 90 } });
    expect(p.ok).toBe(false);
  });

  it("widens a headcount / revenue span that does not line up to the covering bands, and leaves the exact span to the judge", () => {
    const p = planQuickenrich({ person_titles: ["CEO"], organization_num_employees_ranges: ["1,10"], revenue_range: { min: 3_000_000, max: 10_000_000 } });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.plan.body.number_of_employees).toEqual({ include: ["< 5", "5 - 19"], exclude: [] });
      expect(p.plan.body.revenue).toEqual({ include: ["2.5 - 5 Million", "5 - 10 Million"], exclude: [] });
      expect(p.leftToJudge.some((r) => r.startsWith("organization_num_employees_ranges"))).toBe(true);
      expect(p.leftToJudge.some((r) => r.startsWith("revenue_range"))).toBe(true);
    }
  });

  it("refuses an audience without titles", () => {
    expect(planQuickenrich({ person_locations: ["United States"] }).ok).toBe(false);
  });

  it("exact band mapping still refuses spans that do not line up (Apollo 1-10 vs QuickEnrich <5 / 5-19)", () => {
    expect(employeeBandsFor(["1,10"])).toBeNull();
    expect(employeeBandsFor(["1,100"])).toEqual(["< 5", "5 - 19", "20 - 99"]);
    expect(employeeBandsFor(["10001,"])).toEqual([">10000"]);
    expect(revenueBandsFor({ min: 3_000_000, max: 10_000_000 })).toBeNull();
  });

  it("ignores contact_email_status (every served address is verified anyway)", () => {
    expect(planQuickenrich({ ...US_CHIRO_EXACT, contact_email_status: ["verified"] }).ok).toBe(true);
  });

  it("refuses a location it cannot match exactly", () => {
    expect(parseApolloLocation("Somewhere Unknown")).toBeNull();
    expect(planQuickenrich({ person_titles: ["CEO"], person_locations: ["Bay Area, Nowhereland"] }).ok).toBe(false);
  });
});

describe("leavesSectorToJudge", () => {
  it("flags a sector or level left to the judge, not a headcount envelope", () => {
    const p = planQuickenrich(KEYWORD_AUDIENCE);
    expect(p.ok && leavesSectorToJudge(p.leftToJudge)).toBe(true);
    const q = planQuickenrich({ person_titles: ["CEO"], organization_num_employees_ranges: ["1,10"] });
    expect(q.ok && leavesSectorToJudge(q.leftToJudge)).toBe(false);
  });
});

describe("row post-filter", () => {
  it("keeps a row that satisfies every constraint", () => {
    expect(rowMatchesPlan(row({}), plan(SOUTH_CHIRO))).toEqual({ keep: true });
  });

  it("a US state matches the region only: 'Washington, US' is not Washington DC", () => {
    const wa = parseApolloLocation("Washington, US")!;
    expect(locationMatches(wa, parseLocality("Seattle, Washington, United States"))).toBe(true);
    expect(locationMatches(wa, parseLocality("Washington, District of Columbia, United States"))).toBe(false);
  });

  it("'Georgia, US' is the state, never the country", () => {
    const ga = parseApolloLocation("Georgia, US")!;
    expect(locationMatches(ga, parseLocality("Atlanta, Georgia, United States"))).toBe(true);
    expect(locationMatches(ga, parseLocality("Tbilisi, Georgia"))).toBe(false);
  });

  it("a metro area locality still resolves its state; a bare area name does not (stricter, never looser)", () => {
    const tx = parseApolloLocation("Texas, US")!;
    expect(locationMatches(tx, parseLocality("Austin, Texas Metropolitan Area, United States"))).toBe(true);
    const wa = parseApolloLocation("Washington, US")!;
    expect(locationMatches(wa, parseLocality("Greater Seattle Area, United States"))).toBe(false);
  });

  it("drops a person with no stated location when the audience states one", () => {
    expect(rowMatchesPlan(row({ locality: "N/A" }), plan(SOUTH_CHIRO))).toEqual({ keep: false, reason: "location" });
  });

  it("not-titles are whole words, case-insensitive", () => {
    const p = plan(SOUTH_CHIRO);
    expect(rowMatchesPlan(row({ title: "Owner/Chiropractor" }), p)).toEqual({ keep: false, reason: "not_title" });
    expect(rowMatchesPlan(row({ title: "Chiropractic Physician" }), p)).toEqual({ keep: true });
  });

  it("include_similar_titles=false keeps only the exact title", () => {
    const p = plan(US_CHIRO_EXACT);
    expect(rowMatchesPlan(row({ title: "chiropractor " }), p)).toEqual({ keep: true });
    expect(rowMatchesPlan(row({ title: "Owner, Chiropractor" }), p)).toEqual({ keep: false, reason: "title" });
  });

  it("titles match whole words: 'DDS' is not 'Odds'", () => {
    expect(titleContains("Dentist, DDS", "DDS")).toBe(true);
    expect(titleContains("Odds Analyst", "DDS")).toBe(false);
  });

  it("never serves a row without the identity dedup needs (LinkedIn, full name, domain)", () => {
    const p = plan(SOUTH_CHIRO);
    expect(rowMatchesPlan(row({ employee_linkedin: null }), p)).toEqual({ keep: false, reason: "no_linkedin" });
    expect(rowMatchesPlan(row({ last_name: "" }), p)).toEqual({ keep: false, reason: "no_full_name" });
    expect(rowMatchesPlan(row({ company_url: null }), p)).toEqual({ keep: false, reason: "no_company_domain" });
    expect(rowMatchesPlan(row({ has_email: false }), p)).toEqual({ keep: false, reason: "no_email" });
  });

  it("bands are enforced on the row too", () => {
    const p = plan(SG_OFFICE);
    const base = row({ title: "Office Manager", locality: "Singapore, Singapore", revenue: "20 - 50 Million", employee_count: "100 - 249" });
    expect(rowMatchesPlan(base, p)).toEqual({ keep: true });
    expect(rowMatchesPlan({ ...base, employee_count: "20 - 99" }, p)).toEqual({ keep: false, reason: "employees" });
  });
});

describe("identity + wire shape", () => {
  it("writes the LinkedIn URL in Apollo's form so human-service's suppression sees one person", () => {
    expect(canonicalLinkedinUrl("https://www.linkedin.com/in/dana-reyes/")).toBe("http://www.linkedin.com/in/dana-reyes");
    // Apollo served `joselyn-ponce-hern%c3%a1ndez-998934191`
    expect(canonicalLinkedinUrl("https://linkedin.com/in/joselyn-ponce-hernández-998934191")).toBe(
      "http://www.linkedin.com/in/joselyn-ponce-hern%c3%a1ndez-998934191"
    );
  });

  it("qe: ids round-trip; an Apollo id is not one", () => {
    expect(parseQuickenrichPersonId("qe:245348746")).toBe("245348746");
    expect(parseQuickenrichPersonId("5f2b0c1e9d8a7b6c5d4e3f21")).toBeNull();
  });

  it("carries only what QuickEnrich provides; everything else null", () => {
    const p = quickenrichToPerson(row({ emp_id: 9, revenue: "1 - 2.5 Million", employee_count: "5 - 19", country_code: "US", region_code: "TX", city: "Austin", industry: "Health, Wellness & Fitness" }));
    expect(p).toMatchObject({
      id: "qe:9",
      firstName: "Dana",
      lastName: "Reyes",
      name: "Dana Reyes",
      email: null,
      linkedinUrl: "http://www.linkedin.com/in/dana-reyes",
      city: "Austin",
      state: "Texas",
      country: "United States",
      organizationName: "Back In Line",
      organizationDomain: "backinline.com",
      organizationIndustry: "Health, Wellness & Fitness",
      organizationAnnualRevenuePrinted: "1 - 2.5 Million",
      organizationSize: null,
      seniority: null,
      headline: null,
      photoUrl: null,
      timeZone: null,
      employmentHistory: null,
    });
  });
});
