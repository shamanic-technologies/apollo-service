import { describe, expect, it } from "vitest";
import {
  APOLLO_INDUSTRY_VALUES,
  LEGACY_INDUSTRY_ALIASES,
  canonicalApolloIndustry,
} from "../../src/lib/reference-cache.js";
import { toApolloSearchParams } from "../../src/lib/transform.js";
import { ApolloNativeSearchFiltersSchema, SearchFiltersSchema } from "../../src/schemas.js";
import { buildFiltersPrompt } from "../../src/lib/filters-prompt.js";

/**
 * APOLLO-INDUSTRIES-ZERO-1126. Apollo's organization_industries filter matches
 * the industry NAME verbatim, in Apollo's spelling. The LinkedIn spellings we
 * published ("marketing and advertising") counted 0 people on Apollo (measured
 * live 2026-11-26, free teaser, staff test org); Apollo's "marketing &
 * advertising" counts 2,463,094.
 */
describe("organization_industries values Apollo can match", () => {
  const PINNED: Array<[string, string]> = [
    ["marketing and advertising", "marketing & advertising"],
    ["logistics and supply chain", "logistics & supply chain"],
    ["staffing and recruiting", "staffing & recruiting"],
    ["public relations and communications", "public relations & communications"],
    ["writing and editing", "writing & editing"],
    ["non-profit organization management", "nonprofit organization management"],
  ];

  it.each(PINNED)("%s is sent to Apollo as %s", (legacy, apollo) => {
    expect(canonicalApolloIndustry(legacy)).toBe(apollo);
    expect(APOLLO_INDUSTRY_VALUES).toContain(apollo);
    expect(APOLLO_INDUSTRY_VALUES).not.toContain(legacy);
    const params = toApolloSearchParams({ organization_industries: [legacy] });
    expect(params.organization_industries).toEqual([apollo]);
  });

  it("publishes no value Apollo matched 0 people for", () => {
    for (const value of APOLLO_INDUSTRY_VALUES) {
      expect(value).not.toMatch(/ and /);
      expect(value).not.toBe("non-profit organization management");
    }
    expect(Object.keys(LEGACY_INDUSTRY_ALIASES)).toHaveLength(19);
    for (const target of Object.values(LEGACY_INDUSTRY_ALIASES)) {
      expect(APOLLO_INDUSTRY_VALUES).toContain(target);
    }
  });

  it("still accepts a stored legacy spelling and validates it as Apollo's", () => {
    const parsed = SearchFiltersSchema.parse({
      organization_industries: ["Marketing and Advertising", "retail"],
    });
    expect(parsed.organization_industries).toEqual(["marketing & advertising", "retail"]);
  });

  it("filters-prompt lists Apollo's spellings only", () => {
    const prompt = buildFiltersPrompt(ApolloNativeSearchFiltersSchema);
    expect(prompt).toContain("marketing & advertising");
    expect(prompt).not.toContain("marketing and advertising");
  });

  it("leaves a canonical value untouched", () => {
    expect(canonicalApolloIndustry("Computer Software")).toBe("computer software");
    expect(toApolloSearchParams({ organization_industries: ["Retail"] }).organization_industries).toEqual(["retail"]);
  });
});
