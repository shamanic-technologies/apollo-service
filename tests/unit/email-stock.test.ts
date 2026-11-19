import { describe, it, expect } from "vitest";
import { stockLinkedinKeys } from "../../src/lib/email-stock.js";

describe("stockLinkedinKeys — one LinkedIn person, every spelling our tables store", () => {
  it("gives Apollo's canonical form and the email-finder silver key", () => {
    const k = stockLinkedinKeys("https://www.linkedin.com/in/Dana-Reyes/");
    expect(k.apolloUrl).toBe("http://www.linkedin.com/in/dana-reyes");
    expect(k.findingKey).toBe("linkedin:linkedin.com/in/dana-reyes");
  });

  it("null without a LinkedIn profile URL", () => {
    expect(stockLinkedinKeys(null)).toBeNull();
    expect(stockLinkedinKeys("https://www.linkedin.com/company/acme")).toBeNull();
  });
});
