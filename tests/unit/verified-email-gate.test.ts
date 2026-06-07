import { describe, it, expect } from "vitest";
import {
  hasVerifiedEmail,
  withVerifiedEmailOnly,
  APOLLO_PLACEHOLDER_EMAIL,
  type ApolloPerson,
} from "../../src/lib/apollo-client.js";

/**
 * Unit tests for the verified-email gate.
 *
 * Apollo bills 1 credit ONLY for verified emails. Everything else it returns
 * (extrapolated/guessed, unverified, catch_all, update_required, user_managed,
 * unknown, or the email_not_unlocked placeholder) must be treated as "no email":
 * not billed, not positive-cached, not returned to callers.
 */

function person(overrides: Partial<ApolloPerson>): ApolloPerson {
  return {
    id: "p-1",
    first_name: "Jane",
    last_name: "Doe",
    name: "Jane Doe",
    email: "jane@acme.com",
    email_status: "verified",
    title: "CEO",
    linkedin_url: "",
    ...overrides,
  } as ApolloPerson;
}

describe("hasVerifiedEmail", () => {
  it("is true for a real verified email", () => {
    expect(hasVerifiedEmail(person({ email: "jane@acme.com", email_status: "verified" }))).toBe(true);
  });

  it.each([
    "extrapolated",
    "unverified",
    "catch_all",
    "update_required",
    "user_managed",
    "unknown",
    "unavailable",
  ] as const)("is false for non-verified status %s (even with an email present)", (status) => {
    expect(hasVerifiedEmail(person({ email: "jane@acme.com", email_status: status }))).toBe(false);
  });

  it("is false when there is no email", () => {
    expect(hasVerifiedEmail(person({ email: null, email_status: null }))).toBe(false);
  });

  it("is false for the email_not_unlocked placeholder even when status says verified", () => {
    expect(hasVerifiedEmail(person({ email: APOLLO_PLACEHOLDER_EMAIL, email_status: "verified" }))).toBe(false);
  });
});

describe("withVerifiedEmailOnly", () => {
  it("returns the person unchanged when the email is verified", () => {
    const p = person({ email: "jane@acme.com", email_status: "verified" });
    expect(withVerifiedEmailOnly(p)).toBe(p);
  });

  it("nulls a non-verified email but keeps email_status for audit", () => {
    const out = withVerifiedEmailOnly(person({ email: "guess@acme.com", email_status: "extrapolated" }));
    expect(out.email).toBeNull();
    expect(out.email_status).toBe("extrapolated");
  });

  it("nulls the placeholder address", () => {
    const out = withVerifiedEmailOnly(person({ email: APOLLO_PLACEHOLDER_EMAIL, email_status: "verified" }));
    expect(out.email).toBeNull();
  });
});
