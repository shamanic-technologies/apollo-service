import { describe, it, expect } from "vitest";
import { maskMatches, pickUnmasked } from "../../src/lib/apollo-unmask.js";

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
