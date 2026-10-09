import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

import { decideHold, PHONE_GRACE_MS, type HoldEvidence } from "../../src/lib/hold-reconciler.js";
import type { RunCost } from "../../src/lib/runs-client.js";

const HOUR = 60 * 60 * 1000;

function cost(id: string, costName: string, status: RunCost["status"], quantity = "1"): RunCost {
  return { id, runId: "run-1", costName, costSource: "platform", quantity, status, unitCostInUsdCents: "1", totalCostInUsdCents: "1", createdAt: "" };
}

function ev(partial: Partial<HoldEvidence> & { runTaskName: string; hold: RunCost }): HoldEvidence {
  const { hold, ...rest } = partial;
  return { cost: hold, runCosts: [hold], ageMs: 2 * HOUR, ...rest };
}

describe("decideHold — one open hold, decided from what the call did", () => {
  it("records a hold already closed in runs-service without touching it", () => {
    const hold = cost("h", "apollo-credit", "cancelled", "20");
    expect(decideHold({ costId: "h", costName: "apollo-credit" }, ev({ runTaskName: "person-match", hold }))).toMatchObject({
      kind: "already_settled",
      status: "cancelled",
    });
  });

  it("cancels a waterfall-era person-match hold: no email delivered, no callback, no charge evidence", () => {
    const hold = cost("h", "apollo-credit", "provisioned", "20");
    expect(decideHold({ costId: "h", costName: "apollo-credit" }, ev({ runTaskName: "person-match", hold })).kind).toBe("cancel");
  });

  it("cancels a hold whose real charge is already declared on the run (it is a leftover reservation)", () => {
    const hold = cost("h", "apify-bounceverify-email", "provisioned");
    const actual = cost("a", "apify-bounceverify-email", "actual");
    const d = decideHold({ costId: "h", costName: "apify-bounceverify-email" }, { ...ev({ runTaskName: "verify-email", hold }), runCosts: [hold, actual], verificationBilled: true });
    expect(d).toMatchObject({ kind: "cancel", reason: "the real charge is already declared on the run" });
  });

  it("verify-email: a billed verdict in our bronze turns the hold into the charge", () => {
    const hold = cost("h", "apify-bounceverify-email", "provisioned");
    expect(decideHold({ costId: "h", costName: "apify-bounceverify-email" }, { ...ev({ runTaskName: "verify-email", hold }), verificationBilled: true }).kind).toBe("actualize");
  });

  it("verify-email: no billed verdict (the process died before the verifier answered) → cancel", () => {
    const hold = cost("h", "apify-bounceverify-email", "provisioned");
    expect(decideHold({ costId: "h", costName: "apify-bounceverify-email" }, { ...ev({ runTaskName: "verify-email", hold }), verificationBilled: false }).kind).toBe("cancel");
  });

  it("email-find: the vendor's reported charge is posted as actual, the hold released", () => {
    const hold = cost("h", "treg-micro-usd", "provisioned", "10000");
    expect(decideHold({ costId: "h", costName: "treg-micro-usd" }, { ...ev({ runTaskName: "email-find-treg", hold }), findCharged: 5000 })).toMatchObject({
      kind: "replace",
      quantity: 5000,
    });
  });

  it("email-find: a lost answer with no reported charge → cancel (benefit of the doubt to the customer)", () => {
    const hold = cost("h", "treg-micro-usd", "provisioned", "10000");
    expect(decideHold({ costId: "h", costName: "treg-micro-usd" }, { ...ev({ runTaskName: "email-find-treg", hold }), findCharged: null }).kind).toBe("cancel");
  });

  it("phone-reveal: waits for Apollo's webhook during the grace period", () => {
    const hold = cost("h", "apollo-credit", "provisioned", "8");
    expect(decideHold({ costId: "h", costName: "apollo-credit" }, { ...ev({ runTaskName: "phone-reveal", hold }), ageMs: PHONE_GRACE_MS - 1 }).kind).toBe("wait");
  });

  it("phone-reveal: the person-record actual on the same run does NOT count as the reveal's charge", () => {
    const hold = cost("h", "apollo-credit", "provisioned", "8");
    const record = cost("r", "apollo-credit", "actual", "1");
    const d = decideHold(
      { costId: "h", costName: "apollo-credit" },
      { cost: hold, runCosts: [hold, record], runTaskName: "phone-reveal", ageMs: PHONE_GRACE_MS + 1, phoneReveal: { status: "found", creditsConsumed: 8, costReconciledAt: null } }
    );
    expect(d.kind).toBe("actualize");
  });

  it("phone-reveal answered through treg: its charge is declared at the call, the 8-credit hold is cancelled", () => {
    const hold = cost("h", "apollo-credit", "provisioned", "8");
    const d = decideHold(
      { costId: "h", costName: "apollo-credit" },
      { cost: hold, runCosts: [hold], runTaskName: "phone-reveal", ageMs: PHONE_GRACE_MS + 1, phoneReveal: { status: "found", creditsConsumed: 8, costReconciledAt: null, revealRoute: "treg" } }
    );
    expect(d.kind).toBe("cancel");
  });

  it("phone-reveal: Apollo never delivered after the grace period → cancel", () => {
    const hold = cost("h", "apollo-credit", "provisioned", "8");
    const d = decideHold({ costId: "h", costName: "apollo-credit" }, { ...ev({ runTaskName: "phone-reveal", hold }), ageMs: PHONE_GRACE_MS + 1, phoneReveal: { status: "pending", creditsConsumed: null, costReconciledAt: null } });
    expect(d.kind).toBe("cancel");
  });

  it("phone-reveal: a partial charge is posted as the real quantity", () => {
    const hold = cost("h", "apollo-credit", "provisioned", "8");
    const d = decideHold({ costId: "h", costName: "apollo-credit" }, { ...ev({ runTaskName: "phone-reveal", hold }), ageMs: PHONE_GRACE_MS + 1, phoneReveal: { status: "found", creditsConsumed: 5, costReconciledAt: null } });
    expect(d).toMatchObject({ kind: "replace", quantity: 5 });
  });

  it("a hold missing from its run is released rather than left open", () => {
    expect(decideHold({ costId: "h", costName: "apollo-credit" }, { cost: undefined, runCosts: [], runTaskName: "enrichment", ageMs: 2 * HOUR }).kind).toBe("cancel");
  });
});
