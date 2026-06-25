import { describe, it, expect } from "vitest";
import { SearchFiltersSchema } from "../../src/schemas.js";
import { toApolloSearchParams } from "../../src/lib/transform.js";

/**
 * The LLM-facing filter schema must use Apollo's People Search vocabulary:
 * snake_case field names, full seniority enum, arbitrary employee ranges,
 * native revenue {min,max}, and documented People Search filters.
 */
describe("SearchFiltersSchema — faithful Apollo vocabulary", () => {
  it("accepts the previously-dropped seniorities `head` and `intern`", () => {
    const r = SearchFiltersSchema.safeParse({ person_seniorities: ["head", "intern", "c_suite"] });
    expect(r.success).toBe(true);
  });

  it("accepts an arbitrary employee range like 250,500 (not just fixed buckets)", () => {
    const r = SearchFiltersSchema.safeParse({ organization_num_employees_ranges: ["250,500", "10001,"] });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed employee range", () => {
    const r = SearchFiltersSchema.safeParse({ organization_num_employees_ranges: ["big"] });
    expect(r.success).toBe(false);
  });

  it("accepts native revenue as a {min,max} integer object", () => {
    const r = SearchFiltersSchema.safeParse({ revenue_range: { min: 500000, max: 1500000 } });
    expect(r.success).toBe(true);
  });

  it("accepts include_similar_titles (includeSimilarTitles boolean)", () => {
    const r = SearchFiltersSchema.safeParse({ include_similar_titles: false, person_titles: ["Head of Growth"] });
    expect(r.success).toBe(true);
  });

  it("accepts the documented Apollo People Search filters", () => {
    const r = SearchFiltersSchema.safeParse({
      q_organization_job_titles: ["sales manager"],
      currently_using_all_of_technology_uids: ["salesforce"],
      currently_using_any_of_technology_uids: ["hubspot"],
      currently_not_using_any_of_technology_uids: ["hubspot"],
      q_organization_domains_list: ["apollo.io"],
      organization_job_locations: ["atlanta"],
      organization_num_jobs_range: { min: 50, max: 500 },
      organization_job_posted_at_range: { min: "2025-07-25", max: "2025-09-25" },
    });
    expect(r.success).toBe(true);
  });

  it("still accepts the legacy bucket employee values (backward-compatible)", () => {
    const r = SearchFiltersSchema.safeParse({ organization_num_employees_ranges: ["11,20", "21,50"] });
    expect(r.success).toBe(true);
  });
});

describe("toApolloSearchParams — faithful mapping", () => {
  it("maps native revenue + employee + range filters to Apollo snake_case", () => {
    const out = toApolloSearchParams({
      person_seniorities: ["head"],
      organization_num_employees_ranges: ["250,500"],
      revenue_range: { min: 500000, max: 1500000 },
      include_similar_titles: false,
      organization_job_posted_at_range: { max: "2025-09-25" },
      q_organization_domains_list: ["apollo.io"],
    });
    expect(out.person_seniorities).toEqual(["head"]);
    expect(out.organization_num_employees_ranges).toEqual(["250,500"]);
    expect(out.revenue_range).toEqual({ min: 500000, max: 1500000 });
    expect(out.include_similar_titles).toBe(false);
    expect(out.organization_job_posted_at_range).toEqual({ max: "2025-09-25" });
    expect(out.q_organization_domains_list).toEqual(["apollo.io"]);
  });

  it("native revenue_range object wins over legacy revenue aliases", () => {
    const out = toApolloSearchParams({
      revenueRange: ["1000000,2000000"],
      revenueRangeNative: { min: 7, max: 8 },
      revenue_range: { min: 9, max: 10 },
    });
    expect(out.revenue_range).toEqual({ min: 9, max: 10 });
  });

  it("falls back to legacy revenueRange when native is absent", () => {
    const out = toApolloSearchParams({ revenueRange: ["1000000,10000000"] });
    expect(out.revenue_range).toEqual({ min: 1000000, max: 10000000 });
  });

  it("keeps legacy camelCase aliases working without making them canonical", () => {
    const out = toApolloSearchParams({
      personTitles: ["Founder"],
      qOrganizationDomainsList: ["apollo.io"],
      includeSimilarTitles: false,
    });
    expect(out.person_titles).toEqual(["Founder"]);
    expect(out.q_organization_domains_list).toEqual(["apollo.io"]);
    expect(out.include_similar_titles).toBe(false);
  });
});
