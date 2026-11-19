import { describe, it, expect } from "vitest";
import {
  employeeEnvelope,
  freeSourceToPerson,
  isServable,
  normalizeDropleadsRow,
  normalizeLeadsforgeRow,
  parseFreeSourcePersonId,
  planDropleads,
  planLeadsforge,
} from "../../src/lib/free-people-sources.js";

// Real active prod audiences (2026-11-19).
const ABA = {
  person_titles: ["Owner", "Founder", "CEO", "Clinical Director"],
  person_locations: ["New Jersey, US", "Texas, US"],
  q_organization_keyword_tags: ["aba therapy", "applied behavior analysis"],
  organization_num_employees_ranges: ["1,50"],
  contact_email_status: ["verified"],
};
const SAAS_VPS = {
  person_titles: ["VP of Sales"],
  organization_industries: ["computer software"],
  revenue_range: { min: 1_000_000, max: 10_000_000 },
};

describe("planLeadsforge — every targeting constraint enforced, or the source is skipped", () => {
  it("translates titles, person states, tags and headcount", () => {
    const p = planLeadsforge(ABA);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.filters).toEqual({
      leadJobTitles: { include: ABA.person_titles, exclude: [] },
      leadLocations: { include: ["New Jersey", "Texas"], exclude: [] },
      companyKeywords: { include: ABA.q_organization_keyword_tags, exclude: [] },
      companyEmployeeNumberRange: { min: 1, max: 50 },
    });
    expect(p.leftToJudge).toEqual([]);
  });

  it("skips an industry audience (Leadsforge industries are another taxonomy)", () => {
    const p = planLeadsforge(SAAS_VPS);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reasons.some((r) => r.startsWith("organization_industries"))).toBe(true);
  });

  it("refuses a buying signal and an audience with nothing to search on", () => {
    expect(planLeadsforge({ person_titles: ["CEO"], buying_signal: { type: "funding", window_days: 90 } }).ok).toBe(false);
    expect(planLeadsforge({ person_locations: ["United States"] }).ok).toBe(false);
  });
});

describe("planDropleads", () => {
  it("translates industries (Apollo taxonomy), csuite, and leaves revenue to the judge", () => {
    const p = planDropleads({ ...SAAS_VPS, person_seniorities: ["c_suite", "vp"], person_locations: ["United States"] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.filters).toMatchObject({
      requireEmail: true,
      jobTitles: ["VP of Sales"],
      industries: ["computer software"],
      seniority: ["csuite", "vp"],
      countries: ["United States"],
    });
    expect(p.leftToJudge).toEqual(["revenue_range: left to the judge"]);
  });

  it("person states go to `states`, the country to `countries` (the plain lists Dropleads honors)", () => {
    const p = planDropleads(ABA);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.filters).toMatchObject({ countries: ["United States"], states: ["New Jersey", "Texas"], keywords: ABA.q_organization_keyword_tags, customEmployeeRange: { min: 1, max: 50 } });
  });
});

describe("employeeEnvelope", () => {
  it("merges spans and says when the merge loosened them", () => {
    expect(employeeEnvelope(["11,50", "51,200"])).toEqual({ min: 11, max: 200, exact: true });
    expect(employeeEnvelope(["1,10", "201,500"])).toEqual({ min: 1, max: 500, exact: false });
    expect(employeeEnvelope(["10001,"])).toEqual({ min: 10001, max: null, exact: true });
  });
});

describe("rows → Person", () => {
  it("Leadsforge: name + domain, servable without a LinkedIn", () => {
    const p = normalizeLeadsforgeRow({ id: "abc", firstName: "Julie", lastName: "Angstadt", jobTitle: "Owner", company: { domain: "hummingbirdaba.com", industry: "mental health care", employeeCount: 29 }, location: { country: "United States" } });
    expect(p && isServable(p)).toBe(true);
    expect(freeSourceToPerson(p!)).toMatchObject({ id: "lf:abc", name: "Julie Angstadt", organizationDomain: "hummingbirdaba.com", organizationSize: "29" });
  });

  it("Dropleads: name + LinkedIn, servable without a domain", () => {
    const p = normalizeDropleadsRow({ id: 52503857, firstName: "Amanda", lastName: "Ralston", title: "CEO", companyName: "KidsChoice", linkedinUrl: "http://www.linkedin.com/in/amandaralston", companySize: 51 });
    expect(p && isServable(p)).toBe(true);
    expect(freeSourceToPerson(p!).id).toBe("dl:52503857");
  });

  it("a row with neither LinkedIn nor domain is never served", () => {
    const p = normalizeDropleadsRow({ id: 1, firstName: "A", lastName: "B", companyName: "X" });
    expect(isServable(p!)).toBe(false);
  });

  it("parses our ids back", () => {
    expect(parseFreeSourcePersonId("lf:abc")).toEqual({ source: "leadsforge", externalId: "abc" });
    expect(parseFreeSourcePersonId("dl:1")).toEqual({ source: "dropleads", externalId: "1" });
    expect(parseFreeSourcePersonId("qe:1")).toBeNull();
  });
});
