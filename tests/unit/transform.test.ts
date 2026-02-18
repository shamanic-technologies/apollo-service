import { describe, it, expect } from "vitest";
import { transformApolloPerson, toEnrichmentDbValues, transformCachedEnrichment } from "../../src/lib/transform.js";
import type { ApolloPerson } from "../../src/lib/apollo-client.js";

const fullPerson: ApolloPerson = {
  id: "abc123",
  first_name: "John",
  last_name: "Doe",
  name: "John Doe",
  email: "john@example.com",
  email_status: "verified",
  title: "CEO",
  linkedin_url: "https://linkedin.com/in/johndoe",
  photo_url: "https://img.apollo.io/johndoe.jpg",
  headline: "Serial Entrepreneur | CEO at Acme Corp",
  city: "San Francisco",
  state: "California",
  country: "United States",
  seniority: "c_suite",
  departments: ["executive"],
  subdepartments: ["c_suite"],
  functions: ["leadership"],
  twitter_url: "https://twitter.com/johndoe",
  github_url: "https://github.com/johndoe",
  facebook_url: "https://facebook.com/johndoe",
  employment_history: [
    {
      title: "CEO",
      organization_name: "Acme Corp",
      start_date: "2020-01-01",
      current: true,
      description: "Leading the company",
    },
    {
      title: "CTO",
      organization_name: "Previous Inc",
      start_date: "2015-06-01",
      end_date: "2019-12-31",
    },
  ],
  organization: {
    id: "org-1",
    name: "Acme Corp",
    website_url: "https://acme.com",
    primary_domain: "acme.com",
    industry: "Technology",
    estimated_num_employees: 250,
    annual_revenue: 50000000,
    logo_url: "https://acme.com/logo.png",
    short_description: "Enterprise SaaS platform",
    seo_description: "Acme Corp is a leading enterprise SaaS platform providing innovative solutions.",
    linkedin_url: "https://linkedin.com/company/acme",
    twitter_url: "https://twitter.com/acme",
    facebook_url: "https://facebook.com/acme",
    blog_url: "https://acme.com/blog",
    crunchbase_url: "https://crunchbase.com/organization/acme",
    angellist_url: "https://angel.co/acme",
    founded_year: 2015,
    primary_phone: { number: "+1-555-0100", source: "Apollo" },
    publicly_traded_symbol: "ACME",
    publicly_traded_exchange: "NASDAQ",
    annual_revenue_printed: "$50M",
    total_funding: 75000000,
    total_funding_printed: "$75M",
    latest_funding_round_date: "2023-06-15",
    latest_funding_stage: "Series C",
    funding_events: [
      { id: "fe-1", date: "2023-06-15", type: "Series C", amount: 50000000, currency: "USD" },
      { id: "fe-2", date: "2020-01-10", type: "Series A", amount: 10000000, currency: "USD" },
    ],
    city: "San Francisco",
    state: "California",
    country: "United States",
    street_address: "123 Market St",
    postal_code: "94105",
    raw_address: "123 Market St, San Francisco, CA 94105",
    technology_names: ["React", "Node.js", "PostgreSQL"],
    current_technologies: [
      { uid: "react", name: "React", category: "Frontend" },
      { uid: "nodejs", name: "Node.js", category: "Backend" },
    ],
    keywords: ["SaaS", "Enterprise", "Cloud"],
    industries: ["Technology", "Software"],
    secondary_industries: ["Cloud Computing"],
    num_suborganizations: 3,
    retail_location_count: 0,
    alexa_ranking: 50000,
  },
};

describe("transformApolloPerson", () => {
  it("should transform all person and org fields to camelCase", () => {
    const result = transformApolloPerson(fullPerson);

    // Person basics
    expect(result.id).toBe("abc123");
    expect(result.firstName).toBe("John");
    expect(result.lastName).toBe("Doe");
    expect(result.email).toBe("john@example.com");
    expect(result.emailStatus).toBe("verified");
    expect(result.title).toBe("CEO");
    expect(result.linkedinUrl).toBe("https://linkedin.com/in/johndoe");

    // Person profile
    expect(result.photoUrl).toBe("https://img.apollo.io/johndoe.jpg");
    expect(result.headline).toBe("Serial Entrepreneur | CEO at Acme Corp");
    expect(result.city).toBe("San Francisco");
    expect(result.state).toBe("California");
    expect(result.country).toBe("United States");
    expect(result.seniority).toBe("c_suite");
    expect(result.departments).toEqual(["executive"]);
    expect(result.subdepartments).toEqual(["c_suite"]);
    expect(result.functions).toEqual(["leadership"]);
    expect(result.twitterUrl).toBe("https://twitter.com/johndoe");
    expect(result.githubUrl).toBe("https://github.com/johndoe");
    expect(result.facebookUrl).toBe("https://facebook.com/johndoe");

    // Employment history
    expect(result.employmentHistory).toHaveLength(2);
    expect(result.employmentHistory![0]).toEqual({
      title: "CEO",
      organizationName: "Acme Corp",
      startDate: "2020-01-01",
      endDate: undefined,
      description: "Leading the company",
      current: true,
    });
    expect(result.employmentHistory![1]).toEqual({
      title: "CTO",
      organizationName: "Previous Inc",
      startDate: "2015-06-01",
      endDate: "2019-12-31",
      description: undefined,
      current: undefined,
    });

    // Organization basics
    expect(result.organizationName).toBe("Acme Corp");
    expect(result.organizationDomain).toBe("acme.com");
    expect(result.organizationIndustry).toBe("Technology");
    expect(result.organizationSize).toBe("250");
    expect(result.organizationRevenueUsd).toBe("50000000");

    // Organization branding & descriptions
    expect(result.organizationWebsiteUrl).toBe("https://acme.com");
    expect(result.organizationLogoUrl).toBe("https://acme.com/logo.png");
    expect(result.organizationShortDescription).toBe("Enterprise SaaS platform");
    expect(result.organizationSeoDescription).toContain("leading enterprise SaaS");

    // Organization social links
    expect(result.organizationLinkedinUrl).toBe("https://linkedin.com/company/acme");
    expect(result.organizationTwitterUrl).toBe("https://twitter.com/acme");
    expect(result.organizationFacebookUrl).toBe("https://facebook.com/acme");
    expect(result.organizationBlogUrl).toBe("https://acme.com/blog");
    expect(result.organizationCrunchbaseUrl).toBe("https://crunchbase.com/organization/acme");
    expect(result.organizationAngellistUrl).toBe("https://angel.co/acme");

    // Organization details
    expect(result.organizationFoundedYear).toBe(2015);
    expect(result.organizationPrimaryPhone).toBe("+1-555-0100");
    expect(result.organizationPubliclyTradedSymbol).toBe("ACME");
    expect(result.organizationPubliclyTradedExchange).toBe("NASDAQ");

    // Organization financial
    expect(result.organizationAnnualRevenuePrinted).toBe("$50M");
    expect(result.organizationTotalFunding).toBe("75000000");
    expect(result.organizationTotalFundingPrinted).toBe("$75M");
    expect(result.organizationLatestFundingRoundDate).toBe("2023-06-15");
    expect(result.organizationLatestFundingStage).toBe("Series C");
    expect(result.organizationFundingEvents).toHaveLength(2);
    expect(result.organizationFundingEvents![0].amount).toBe(50000000);

    // Organization location
    expect(result.organizationCity).toBe("San Francisco");
    expect(result.organizationState).toBe("California");
    expect(result.organizationCountry).toBe("United States");
    expect(result.organizationStreetAddress).toBe("123 Market St");
    expect(result.organizationPostalCode).toBe("94105");

    // Organization tech & classification
    expect(result.organizationTechnologyNames).toEqual(["React", "Node.js", "PostgreSQL"]);
    expect(result.organizationCurrentTechnologies).toHaveLength(2);
    expect(result.organizationCurrentTechnologies![0].name).toBe("React");
    expect(result.organizationKeywords).toEqual(["SaaS", "Enterprise", "Cloud"]);
    expect(result.organizationIndustries).toEqual(["Technology", "Software"]);
    expect(result.organizationSecondaryIndustries).toEqual(["Cloud Computing"]);
    expect(result.organizationNumSuborganizations).toBe(3);
    expect(result.organizationRetailLocationCount).toBe(0);
    expect(result.organizationAlexaRanking).toBe(50000);
  });

  it("should handle missing organization", () => {
    const person: ApolloPerson = {
      id: "abc123",
      first_name: "Jane",
      last_name: "Smith",
      name: "Jane Smith",
      email: "jane@example.com",
      email_status: "guessed",
      title: "Engineer",
      linkedin_url: "",
    };

    const result = transformApolloPerson(person);

    expect(result.firstName).toBe("Jane");
    expect(result.organizationName).toBeUndefined();
    expect(result.organizationLogoUrl).toBeUndefined();
    expect(result.organizationFundingEvents).toBeUndefined();
    expect(result.photoUrl).toBeUndefined();
    expect(result.seniority).toBeUndefined();
  });

  it("should handle null email gracefully", () => {
    const person: ApolloPerson = {
      id: "abc123",
      first_name: "No",
      last_name: "Email",
      name: "No Email",
      email: null as unknown as string,
      email_status: null as unknown as string,
      title: "VP",
      linkedin_url: "",
    };

    const result = transformApolloPerson(person);
    expect(result.email).toBeNull();
    expect(result.emailStatus).toBeNull();
  });
});

describe("toEnrichmentDbValues", () => {
  it("should map all fields to DB column names", () => {
    const result = toEnrichmentDbValues(fullPerson);

    expect(result.apolloPersonId).toBe("abc123");
    expect(result.firstName).toBe("John");
    expect(result.organizationSize).toBe("250");
    expect(result.organizationRevenueUsd).toBe("50000000");
    expect(result.photoUrl).toBe("https://img.apollo.io/johndoe.jpg");
    expect(result.seniority).toBe("c_suite");
    expect(result.organizationLogoUrl).toBe("https://acme.com/logo.png");
    expect(result.organizationFoundedYear).toBe(2015);
    expect(result.organizationTotalFunding).toBe("75000000");
    expect(result.organizationPrimaryPhone).toBe("+1-555-0100");
    expect(result.employmentHistory).toHaveLength(2);
    expect(result.organizationFundingEvents).toHaveLength(2);
    expect(result.organizationCurrentTechnologies).toHaveLength(2);
    expect(result.responseRaw).toStrictEqual({ ...fullPerson, organization: fullPerson.organization });
  });

  it("should handle missing organization", () => {
    const person: ApolloPerson = {
      id: "abc123",
      first_name: "Jane",
      last_name: "Smith",
      name: "Jane Smith",
      email: "jane@example.com",
      email_status: "verified",
      title: "Engineer",
      linkedin_url: "",
    };

    const result = toEnrichmentDbValues(person);

    expect(result.organizationName).toBeUndefined();
    expect(result.organizationLogoUrl).toBeUndefined();
    expect(result.organizationFundingEvents).toBeUndefined();
  });

  it("should default responseRaw.organization to empty object when missing", () => {
    const person: ApolloPerson = {
      id: "abc123",
      first_name: "Jane",
      last_name: "Smith",
      name: "Jane Smith",
      email: "jane@example.com",
      email_status: "verified",
      title: "Engineer",
      linkedin_url: "",
    };

    const result = toEnrichmentDbValues(person);
    const raw = result.responseRaw as Record<string, unknown>;

    // organization must be an object so downstream consumers can safely access .primary_domain etc.
    expect(raw.organization).toEqual({});
    expect((raw.organization as Record<string, unknown>).primary_domain).toBeUndefined();
  });
});

describe("transformCachedEnrichment", () => {
  it("should map DB row back to API format", () => {
    const row = {
      id: "uuid-1",
      orgId: "org-1",
      runId: "run-1",
      searchId: null,
      appId: "app-1",
      brandId: "brand-1",
      campaignId: "campaign-1",
      apolloPersonId: "abc123",
      firstName: "John",
      lastName: "Doe",
      email: "john@example.com",
      emailStatus: "verified",
      title: "CEO",
      linkedinUrl: "https://linkedin.com/in/johndoe",
      photoUrl: "https://img.apollo.io/johndoe.jpg",
      headline: "Serial Entrepreneur",
      city: "San Francisco",
      state: "California",
      country: "United States",
      seniority: "c_suite",
      departments: ["executive"],
      subdepartments: ["c_suite"],
      functions: ["leadership"],
      twitterUrl: "https://twitter.com/johndoe",
      githubUrl: null,
      facebookUrl: null,
      employmentHistory: [{ title: "CEO", organization_name: "Acme" }],
      organizationName: "Acme Corp",
      organizationDomain: "acme.com",
      organizationIndustry: "Technology",
      organizationSize: "250",
      organizationRevenueUsd: "50000000",
      organizationWebsiteUrl: "https://acme.com",
      organizationLogoUrl: "https://acme.com/logo.png",
      organizationShortDescription: "Enterprise SaaS",
      organizationSeoDescription: "Acme Corp is a leading...",
      organizationLinkedinUrl: "https://linkedin.com/company/acme",
      organizationTwitterUrl: "https://twitter.com/acme",
      organizationFacebookUrl: null,
      organizationBlogUrl: null,
      organizationCrunchbaseUrl: null,
      organizationAngellistUrl: null,
      organizationFoundedYear: 2015,
      organizationPrimaryPhone: "+1-555-0100",
      organizationPubliclyTradedSymbol: null,
      organizationPubliclyTradedExchange: null,
      organizationAnnualRevenuePrinted: "$50M",
      organizationTotalFunding: "75000000",
      organizationTotalFundingPrinted: "$75M",
      organizationLatestFundingRoundDate: "2023-06-15",
      organizationLatestFundingStage: "Series C",
      organizationFundingEvents: [{ id: "fe-1", amount: 50000000 }],
      organizationCity: "San Francisco",
      organizationState: "California",
      organizationCountry: "United States",
      organizationStreetAddress: "123 Market St",
      organizationPostalCode: "94105",
      organizationTechnologyNames: ["React", "Node.js"],
      organizationCurrentTechnologies: [{ uid: "react", name: "React", category: "Frontend" }],
      organizationKeywords: ["SaaS"],
      organizationIndustries: ["Technology"],
      organizationSecondaryIndustries: ["Cloud"],
      organizationNumSuborganizations: 3,
      organizationRetailLocationCount: 0,
      organizationAlexaRanking: 50000,
      responseRaw: {},
      enrichmentRunId: null,
      createdAt: new Date(),
    };

    const result = transformCachedEnrichment("abc123", row);

    expect(result.id).toBe("abc123");
    expect(result.firstName).toBe("John");
    expect(result.organizationLogoUrl).toBe("https://acme.com/logo.png");
    expect(result.seniority).toBe("c_suite");
    expect(result.organizationFundingEvents).toHaveLength(1);
    expect(result.organizationCurrentTechnologies).toHaveLength(1);
  });
});
