import { describe, it, expect } from "vitest";
import { apolloShareOf } from "../../src/lib/email-sources-daily.js";

describe("apolloShareOf", () => {
  it("Apollo reveals over every email served that day", () => {
    expect(apolloShareOf({ apolloReveals: 1, tregFinds: 1, stockReuses: 1, formatGuesses: 1 })).toBe(0.25);
  });
  it("null on a day with no email (never a fake 0 %)", () => {
    expect(apolloShareOf({ apolloReveals: 0, tregFinds: 0, stockReuses: 0, formatGuesses: 0 })).toBeNull();
  });
});
