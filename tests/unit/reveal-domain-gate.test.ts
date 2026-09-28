import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

import {
  decideReveal,
  judgeDomain,
  normalizeDomain,
  probeAddress,
  CHECKER_BLOCKED_TTL_DAYS,
  type DomainVerdictRow,
  type GateDeps,
} from "../../src/lib/reveal-domain-gate.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const row = (verdict: DomainVerdictRow["verdict"], ageDays: number, id = `v-${verdict}-${ageDays}`): DomainVerdictRow => ({
  verdict,
  verificationId: id,
  verifiedAt: daysAgo(ageDays),
});

function deps(over: Partial<GateDeps> & { verdicts?: Record<string, DomainVerdictRow[]>; probeVerdicts?: Record<string, DomainVerdictRow["verdict"]> } = {}) {
  const probe = vi.fn(async (domain: string) => row(over.probeVerdicts?.[domain] ?? "invalid", 0, `probe-${domain}`));
  const d: GateDeps = {
    employerOf: async () => "Dugas Dental",
    lookupOrganizations: async () => [{ id: "org-1", name: "Dugas Dental", domain: "dugasdental.com" }],
    revealedEmailDomains: async () => [],
    domainVerdicts: async (domain) => over.verdicts?.[domain] ?? [],
    probe,
    now: () => NOW,
    ...over,
  };
  return { d, probe };
}

describe("judgeDomain", () => {
  it("a recent catch_all condemns the domain", () => {
    expect(judgeDomain([row("catch_all", 3)], NOW)).toMatchObject({ state: "bad", reason: "catch_all_domain" });
  });

  it("the latest decisive verdict wins, and beats any unknown", () => {
    expect(judgeDomain([row("catch_all", 10), row("valid", 2), row("unknown", 1)], NOW)).toMatchObject({ state: "ok" });
    expect(judgeDomain([row("valid", 10), row("catch_all", 2)], NOW)).toMatchObject({ state: "bad", reason: "catch_all_domain" });
  });

  it("an invalid address proves the domain confirms mailboxes (not catch-all)", () => {
    expect(judgeDomain([row("invalid", 1)], NOW)).toMatchObject({ state: "ok" });
  });

  it("a checker block is TRANSIENT: bad for 7 days, then unknown again", () => {
    expect(judgeDomain([row("unknown", 2)], NOW)).toMatchObject({ state: "bad", reason: "checker_blocked_domain" });
    expect(judgeDomain([row("unknown", CHECKER_BLOCKED_TTL_DAYS + 1)], NOW)).toEqual({ state: "unknown" });
  });

  it("verdicts older than the reuse window say nothing", () => {
    expect(judgeDomain([row("catch_all", 31)], NOW)).toEqual({ state: "unknown" });
    expect(judgeDomain([], NOW)).toEqual({ state: "unknown" });
  });
});

describe("decideReveal", () => {
  it("SKIPS a person at a domain already known catch-all — no probe, no reveal", async () => {
    const { d, probe } = deps({ verdicts: { "dugasdental.com": [row("catch_all", 1, "ver-known")] } });
    const out = await decideReveal("p1", d);
    expect(out).toMatchObject({ action: "skip", reason: "catch_all_domain", organizationId: "org-1" });
    expect(out.action === "skip" && out.evidence).toEqual([
      { domain: "dugasdental.com", verdict: "catch_all", verificationId: "ver-known", verifiedAt: daysAgo(1).toISOString(), probed: false },
    ]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("probes an unseen domain, and skips when the probe says catch-all", async () => {
    const { d, probe } = deps({ probeVerdicts: { "dugasdental.com": "catch_all" } });
    const out = await decideReveal("p1", d);
    expect(probe).toHaveBeenCalledWith("dugasdental.com");
    expect(out).toMatchObject({ action: "skip", reason: "catch_all_domain", evidence: [{ domain: "dugasdental.com", probed: true }] });
  });

  it("reveals when the domain is valid (a probe answering invalid means real mailboxes are checked)", async () => {
    const { d } = deps({ probeVerdicts: { "dugasdental.com": "invalid" } });
    expect(await decideReveal("p1", d)).toMatchObject({ action: "reveal", basis: "domain_ok" });
    const known = deps({ verdicts: { "dugasdental.com": [row("valid", 4)] } });
    expect(await decideReveal("p1", known.d)).toMatchObject({ action: "reveal", basis: "domain_ok" });
    expect(known.probe).not.toHaveBeenCalled();
  });

  it("a checker block skips now but the domain is re-probed once the block is 7 days old", async () => {
    const fresh = deps({ verdicts: { "dugasdental.com": [row("unknown", 1)] } });
    expect(await decideReveal("p1", fresh.d)).toMatchObject({ action: "skip", reason: "checker_blocked_domain" });
    expect(fresh.probe).not.toHaveBeenCalled();

    const stale = deps({ verdicts: { "dugasdental.com": [row("unknown", 8)] }, probeVerdicts: { "dugasdental.com": "invalid" } });
    expect(await decideReveal("p1", stale.d)).toMatchObject({ action: "reveal", basis: "domain_ok" });
    expect(stale.probe).toHaveBeenCalledOnce();
  });

  it("reveals when ANY candidate mail domain is good (the org's website is catch-all, its mail domain is not)", async () => {
    const { d, probe } = deps({
      revealedEmailDomains: async () => ["dugasmail.com"],
      verdicts: { "dugasdental.com": [row("catch_all", 1)], "dugasmail.com": [row("valid", 1)] },
    });
    expect(await decideReveal("p1", d)).toMatchObject({ action: "reveal", basis: "domain_ok" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("skips only when EVERY candidate domain is bad", async () => {
    const { d } = deps({
      revealedEmailDomains: async () => ["dugasmail.com"],
      verdicts: { "dugasdental.com": [row("catch_all", 1)] },
      probeVerdicts: { "dugasmail.com": "unknown" },
    });
    const out = await decideReveal("p1", d);
    expect(out).toMatchObject({ action: "skip", reason: "catch_all_domain" });
    expect(out.action === "skip" && out.evidence.map((e) => [e.domain, e.verdict, e.probed])).toEqual([
      ["dugasdental.com", "catch_all", false],
      ["dugasmail.com", "unknown", true],
    ]);
  });

  it("gives the benefit of the doubt without positive evidence: no employer, no exact org, ambiguous name, no domain", async () => {
    expect(await decideReveal("p1", deps({ employerOf: async () => null }).d)).toMatchObject({ action: "reveal", basis: "no_employer" });
    expect(await decideReveal("p1", deps({ lookupOrganizations: async () => [{ id: "x", name: "Dugas Dental Group", domain: "x.com" }] }).d)).toMatchObject({
      action: "reveal",
      basis: "no_exact_org_match",
    });
    expect(
      await decideReveal(
        "p1",
        deps({
          lookupOrganizations: async () => [
            { id: "a", name: "Dugas Dental", domain: "a.com" },
            { id: "b", name: "dugas  dental", domain: "b.com" },
          ],
        }).d
      )
    ).toMatchObject({ action: "reveal", basis: "ambiguous_org_name" });
    expect(await decideReveal("p1", deps({ lookupOrganizations: async () => [{ id: "org-1", name: "Dugas Dental", domain: null }] }).d)).toMatchObject({
      action: "reveal",
      basis: "no_domain",
    });
  });

  it("a probe failure is NOT swallowed", async () => {
    const { d } = deps({ probe: async () => { throw new Error("apify down"); } });
    await expect(decideReveal("p1", d)).rejects.toThrow("apify down");
  });
});

describe("helpers", () => {
  it("normalizes domains and website urls", () => {
    expect(normalizeDomain("https://www.DugasDental.com/about")).toBe("dugasdental.com");
    expect(normalizeDomain("dugasdental.com")).toBe("dugasdental.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
  });

  it("a probe address is random and on the domain", () => {
    const a = probeAddress("x.com");
    expect(a).toMatch(/^zz-probe-[0-9a-f]{12}@x\.com$/);
    expect(probeAddress("x.com")).not.toBe(a);
  });
});
