import { describe, it, expect } from "vitest";
import { evidencePersonFrom, freePathCarriesSignal, maskMatches, pickUnmasked } from "../../src/lib/apollo-unmask.js";

// Real teaser masks (prod 2026-11-19): two first letters + *** + last letter.
describe("maskMatches", () => {
  it("fits the last names behind real masks", () => {
    expect(maskMatches("Ri***n", "Richardson")).toBe(true);
    expect(maskMatches("Re***n", "Regan")).toBe(true);
    expect(maskMatches("Ch***r", "Chatelier")).toBe(true);
  });
  it("refuses a name that breaks the prefix, the suffix or is too short", () => {
    expect(maskMatches("Ri***n", "Roberts")).toBe(false);
    expect(maskMatches("Ri***n", "Richards")).toBe(false);
    expect(maskMatches("Ri***n", "Rn")).toBe(false);
    expect(maskMatches("Richardson", "Richardson")).toBe(false);
  });
  it("ignores accents and case", () => {
    expect(maskMatches("Nú***z", "Nunez")).toBe(true);
  });
});

describe("pickUnmasked — exactly one person, never a guess between two", () => {
  const rows = [
    { firstName: "Michele", lastName: "Richardson", linkedinUrl: null },
    { firstName: "Michele", lastName: "Richardson", linkedinUrl: "http://www.linkedin.com/in/mrichardson" },
    { firstName: "Mike", lastName: "Robinson", linkedinUrl: null },
  ];
  it("one last name fits → that person, the row with a LinkedIn preferred", () => {
    expect(pickUnmasked(rows, "Michele", "Ri***n")).toEqual(rows[1]);
  });
  it("two different last names fit → null", () => {
    expect(pickUnmasked([...rows, { firstName: "Michele", lastName: "Rivlin", linkedinUrl: null }], "Michele", "Ri***n")).toBeNull();
  });
  it("nobody fits → null", () => {
    expect(pickUnmasked(rows, "Anna", "Ri***n")).toBeNull();
  });
});

// APOLLO-ETHAN-1123: which buying-signal people the free unmask may serve, and the
// employer facts their evidence reads without Apollo's person record.
describe("freePathCarriesSignal", () => {
  it("no signal, hiring and funding → free path; job change and unknown → Apollo", () => {
    expect(freePathCarriesSignal(null)).toBe(true);
    expect(freePathCarriesSignal("hiring")).toBe(true);
    expect(freePathCarriesSignal("funding")).toBe(true);
    expect(freePathCarriesSignal("job_change")).toBe(false);
    expect(freePathCarriesSignal("linkedin_engagement")).toBe(false);
  });
});

describe("evidencePersonFrom", () => {
  const teaser = { organizationName: "Acme", title: "Owner", apolloOrganizationId: "org-acme" };
  const stock = { organization_id: "org-acme", organization_funding_events: [{ date: "2026-10-01", type: "Series A" }], organization_latest_funding_round_date: "2026-10-01", organization_latest_funding_stage: "Series A" };
  it("org id from the teaser's free lookup, funding from stock of the SAME org", () => {
    expect(evidencePersonFrom("p-1", teaser, stock)).toMatchObject({ id: "p-1", organizationId: "org-acme", organizationLatestFundingRoundDate: "2026-10-01", employmentHistory: null });
  });
  it("stock of ANOTHER org at that domain lends its org id only when the teaser has none, never its funding to a different org", () => {
    const other = { ...stock, organization_id: "org-homonym" };
    expect(evidencePersonFrom("p-1", teaser, other)).toMatchObject({ organizationId: "org-acme", organizationFundingEvents: null, organizationLatestFundingRoundDate: null });
    expect(evidencePersonFrom("p-1", { ...teaser, apolloOrganizationId: null }, other)).toMatchObject({ organizationId: "org-homonym", organizationLatestFundingRoundDate: "2026-10-01" });
  });
  it("no org id anywhere → null (no evidence can be dated)", () => {
    expect(evidencePersonFrom("p-1", { ...teaser, apolloOrganizationId: null }, null)).toBeNull();
  });
});
