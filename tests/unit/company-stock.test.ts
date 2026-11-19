import { describe, it, expect } from "vitest";
import { applyCompanyStock, type CompanyStockFacts } from "../../src/lib/company-stock.js";
import { quickenrichToPerson } from "../../src/lib/quickenrich.js";

const ROW = {
  emp_id: 1,
  first_name: "Dana",
  last_name: "Reyes",
  title: "Head of QA",
  employee_linkedin: "https://www.linkedin.com/in/dana-reyes",
  has_email: true,
  company_url: "trustpair.com",
  company_name: "Trustpair",
  industry: "Software Development",
  employee_count: "100 - 249",
  locality: "Paris, Ile-de-France, France",
};

const FACTS: CompanyStockFacts = {
  domain: "trustpair.com",
  size: "120",
  revenueUsd: 10_900_000,
  foundedYear: 2017,
  keywords: ["fintech", "regtech"],
  industries: ["computer software"],
  secondaryIndustries: null,
  technologyNames: ["Aircall", "HubSpot"],
  shortDescription: "Vendor fraud prevention.",
  latestFundingStage: "Series B",
  latestFundingRoundDate: "2023-01-10",
  totalFundingPrinted: "$50M",
  publiclyTradedSymbol: null,
};

describe("applyCompanyStock — the firmographics our paid reveals already hold for this employer", () => {
  it("fills what the judge reads (keywords, headcount) and the rest, keeping QuickEnrich's own fields", () => {
    const p = applyCompanyStock(quickenrichToPerson(ROW), FACTS);
    expect(p.organizationKeywords).toEqual(["fintech", "regtech"]);
    expect(p.organizationSize).toBe("120");
    expect(p.organizationIndustries).toEqual(["computer software"]);
    expect(p.organizationTechnologyNames).toEqual(["Aircall", "HubSpot"]);
    expect(p.organizationFoundedYear).toBe(2017);
    expect(p.organizationLatestFundingStage).toBe("Series B");
    expect(p.organizationIndustry).toBe("Software Development");
    expect(p.organizationDomain).toBe("trustpair.com");
  });

  it("no stock for the employer = the person unchanged, nothing invented", () => {
    const base = quickenrichToPerson(ROW);
    expect(applyCompanyStock(base, null)).toEqual(base);
  });
});
