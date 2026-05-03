import { describe, it, expect } from "vitest";
import { transformApolloPerson } from "../../src/lib/transform.js";
import { PersonSchema } from "../../src/schemas.js";
import type { ApolloPerson } from "../../src/lib/apollo-client.js";

const apolloPerson: ApolloPerson = {
  id: "p-1",
  first_name: "Alice",
  last_name: "Wong",
  name: "Alice Wong",
  email: "alice@acme.com",
  email_status: "verified",
  title: "VP",
  linkedin_url: "https://linkedin.com/in/alice",
  personal_emails: ["alice@gmail.com"],
  mobile_phone: "+1-555-0123",
  phone_numbers: [
    { raw_number: "+1-555-0123", sanitized_number: "+15550123", type: "mobile" },
  ],
  organization: {
    id: "org-99",
    name: "Acme",
    website_url: "https://acme.com",
    primary_domain: "acme.com",
    industry: "Tech",
    estimated_num_employees: 100,
    annual_revenue: 1_000_000,
    raw_address: "1 Main St",
  },
};

describe("PersonSchema with full Apollo coverage", () => {
  it("transformApolloPerson output validates against PersonSchema and exposes raw + new typed fields", () => {
    const transformed = transformApolloPerson(apolloPerson);
    const parsed = PersonSchema.parse(transformed);
    expect(parsed.name).toBe("Alice Wong");
    expect(parsed.personalEmails).toEqual(["alice@gmail.com"]);
    expect(parsed.mobilePhone).toBe("+1-555-0123");
    expect(parsed.phoneNumbers).toHaveLength(1);
    expect(parsed.organizationId).toBe("org-99");
    expect(parsed.organizationRawAddress).toBe("1 Main St");
    expect(parsed.raw).toBeDefined();
  });
});
