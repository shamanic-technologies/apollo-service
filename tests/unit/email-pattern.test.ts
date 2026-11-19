import { describe, it, expect } from "vitest";
import { dominantFormat, formatOf, guessAddress, namePart } from "../../src/lib/email-pattern.js";
import { consumedByCheck, producedByCheck } from "../../src/lib/outcome-declarations.js";

describe("email formats", () => {
  it("reads the format an address follows", () => {
    expect(formatOf("Julie", "Angstadt", "julie.angstadt@x.com")).toBe("first.last");
    expect(formatOf("Julie", "Angstadt", "jangstadt@x.com")).toBe("flast");
    expect(formatOf("Julie", "Angstadt", "julie@x.com")).toBe("first");
    expect(formatOf("Julie", "Angstadt", "hello@x.com")).toBeNull();
  });

  it("strips accents and non-letters from names", () => {
    expect(namePart("Zoë-Anne")).toBe("zoeanne");
    expect(formatOf("José", "Núñez", "jose.nunez@x.com")).toBe("first.last");
  });

  it("the domain's dominant format, applied to a new person", () => {
    const fmt = dominantFormat([
      { firstName: "Ann", lastName: "Lee", email: "alee@acme.com" },
      { firstName: "Bob", lastName: "Ray", email: "bray@acme.com" },
      { firstName: "Cy", lastName: "Do", email: "cy@acme.com" },
    ]);
    expect(fmt).toBe("flast");
    expect(guessAddress("Julie", "Angstadt", fmt!, "ACME.com")).toBe("jangstadt@acme.com");
  });

  it("nothing readable = no guess (never blind)", () => {
    expect(dominantFormat([{ firstName: "Ann", lastName: "Lee", email: "info@acme.com" }])).toBeNull();
    expect(dominantFormat([])).toBeNull();
  });
});

describe("accounting of a check on a guessed address", () => {
  it("a valid guess is found AND checked by that check; it consumes nothing", () => {
    expect(producedByCheck("pattern-guess:leadsforge", "valid")).toEqual(["email_found", "email_checked"]);
    expect(consumedByCheck("pattern-guess:leadsforge", undefined)).toEqual([]);
  });
  it("any other source or verdict keeps the existing rule", () => {
    expect(producedByCheck("pattern-guess:leadsforge", "invalid")).toEqual(["email_checked"]);
    expect(producedByCheck("enrich", "valid")).toEqual(["email_checked"]);
    expect(consumedByCheck("enrich", undefined)).toEqual(["email_found"]);
  });
});
