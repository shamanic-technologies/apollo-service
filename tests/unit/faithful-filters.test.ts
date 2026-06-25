import { describe, it, expect } from "vitest";
import { SearchFiltersSchema } from "../../src/schemas.js";
import { toApolloSearchParams } from "../../src/lib/transform.js";

/**
 * The filter schema must be 1:1 FAITHFUL to Apollo's People Search API:
 * full seniority enum (incl `head` + `intern`), arbitrary employee ranges,
 * native revenue {min,max}, include_similar_titles, and the other documented
 * Apollo people-search filters — all previously dropped/narrowed.
 */
describe("SearchFiltersSchema — faithful Apollo vocabulary", () => {
  it("accepts the previously-dropped seniorities `head` and `intern`", () => {
    const r = SearchFiltersSchema.safeParse({ personSeniorities: ["head", "intern", "c_suite"] });
    expect(r.success).toBe(true);
  });

  it("accepts an arbitrary employee range like 250,500 (not just fixed buckets)", () => {
    const r = SearchFiltersSchema.safeParse({ organizationNumEmployeesRanges: ["250,500", "10001,"] });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed employee range", () => {
    const r = SearchFiltersSchema.safeParse({ organizationNumEmployeesRanges: ["big"] });
    expect(r.success).toBe(false);
  });

  it("accepts native revenue as a {min,max} integer object", () => {
    const r = SearchFiltersSchema.safeParse({ revenueRangeNative: { min: 500000, max: 1500000 } });
    expect(r.success).toBe(true);
  });

  it("accepts include_similar_titles (includeSimilarTitles boolean)", () => {
    const r = SearchFiltersSchema.safeParse({ includeSimilarTitles: false, personTitles: ["Head of Growth"] });
    expect(r.success).toBe(true);
  });

  it("accepts the newly-exposed faithful filters", () => {
    const r = SearchFiltersSchema.safeParse({
      qOrganizationJobTitles: ["sales manager"],
      personLinkedinUrls: ["https://www.linkedin.com/in/tim-zheng"],
      currentlyUsingAllOfTechnologyUids: ["salesforce"],
      currentlyNotUsingAnyOfTechnologyUids: ["hubspot"],
      qOrganizationDomainsList: ["apollo.io"],
      marketSegments: ["B2B"],
      organizationNaicsCodes: ["5415"],
      organizationSicCodes: ["7372"],
      organizationJobLocations: ["atlanta"],
      organizationFoundedYearRange: { min: 2015, max: 2020 },
      organizationIncludeUnknownFoundedYear: true,
      organizationHeadcountGrowthPastNMonths: 6,
      organizationHeadcountGrowthRange: { min: 10, max: 100 },
      organizationNumJobsRange: { min: 50, max: 500 },
      organizationJobPostedAtRange: { min: "2025-07-25", max: "2025-09-25" },
      personTotalYoeRange: { min: 5, max: 15 },
      personDaysInCurrentTitleRange: { min: 90, max: 730 },
    });
    expect(r.success).toBe(true);
  });

  it("still accepts the legacy bucket employee values (backward-compatible)", () => {
    const r = SearchFiltersSchema.safeParse({ organizationNumEmployeesRanges: ["11,20", "21,50"] });
    expect(r.success).toBe(true);
  });
});

describe("toApolloSearchParams — faithful mapping", () => {
  it("maps native revenue + employee + range filters to Apollo snake_case", () => {
    const out = toApolloSearchParams({
      personSeniorities: ["head"],
      organizationNumEmployeesRanges: ["250,500"],
      revenueRangeNative: { min: 500000, max: 1500000 },
      includeSimilarTitles: false,
      organizationFoundedYearRange: { min: 2015 },
      organizationJobPostedAtRange: { max: "2025-09-25" },
      qOrganizationDomainsList: ["apollo.io"],
      personTotalYoeRange: { min: 5, max: 15 },
    });
    expect(out.person_seniorities).toEqual(["head"]);
    expect(out.organization_num_employees_ranges).toEqual(["250,500"]);
    expect(out.revenue_range).toEqual({ min: 500000, max: 1500000 });
    expect(out.include_similar_titles).toBe(false);
    expect(out.organization_founded_year_range).toEqual({ min: 2015 });
    expect(out.organization_job_posted_at_range).toEqual({ max: "2025-09-25" });
    expect(out.q_organization_domains_list).toEqual(["apollo.io"]);
    expect(out.person_total_yoe_range).toEqual({ min: 5, max: 15 });
  });

  it("native revenue object wins over the legacy revenueRange string array", () => {
    const out = toApolloSearchParams({
      revenueRange: ["1000000,2000000"],
      revenueRangeNative: { min: 7, max: 8 },
    });
    expect(out.revenue_range).toEqual({ min: 7, max: 8 });
  });

  it("falls back to legacy revenueRange when native is absent", () => {
    const out = toApolloSearchParams({ revenueRange: ["1000000,10000000"] });
    expect(out.revenue_range).toEqual({ min: 1000000, max: 10000000 });
  });
});
