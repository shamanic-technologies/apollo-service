import { describe, it, expect } from "vitest";
import { creditRefusalBody, describeCreditRefusal } from "../../src/lib/credit-refusal.js";

const cap = { salesFunnelId: "sf-1", salesFunnelCampaignId: "c-1", amountCents: "500", period: "total", consumedCents: null, reservedCents: "10" };

describe("creditRefusalBody (FUNNEL-CAP-REACHED-AT-2PCT-1015)", () => {
  it("balance shortfall: byte-identical legacy body", () => {
    expect(creditRefusalBody({ sufficient: false, balance_cents: 0, required_cents: 5 })).toEqual({
      type: "credit_insufficient", error: "Insufficient credits", balance_cents: 0, required_cents: 5,
    });
  });

  it("unreadable max budget: named, reason + cap verbatim, type kept so callers still stop", () => {
    const body = creditRefusalBody({ sufficient: false, balance_cents: 100, required_cents: 5, reason: "sales_funnel_max_budget_unreadable", sales_funnel_cap: cap });
    expect(body).toMatchObject({ type: "credit_insufficient", error: "Sales funnel max budget unreadable", reason: "sales_funnel_max_budget_unreadable", sales_funnel_cap: cap });
  });

  it("an unknown future reason is still passed through, never read as a shortfall", () => {
    const body = creditRefusalBody({ sufficient: false, balance_cents: 100, required_cents: 5, reason: "something_new" });
    expect(body.reason).toBe("something_new");
    expect(body.error).not.toBe("Insufficient credits");
  });

  it("describeCreditRefusal names the cause", () => {
    expect(describeCreditRefusal({ sufficient: false, balance_cents: 100, required_cents: 5, reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap }))
      .toBe("Sales funnel max budget reached (balance=100¢, required=5¢, reason=sales_funnel_max_budget_reached)");
  });
});
