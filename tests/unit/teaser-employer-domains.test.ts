import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

import {
  resolveEmployer,
  resolveEmployerDomains,
  employerDomainFor,
  type EmployerDomainDeps,
  type EmployerResolution,
} from "../../src/lib/teaser-employer-domains.js";
import type { ApolloOrganizationCandidate } from "../../src/lib/apollo-client.js";

const teaser = (name: string | null, primary_domain?: string) => ({ organization: name === null ? null : { name, ...(primary_domain ? { primary_domain } : {}) } });

function deps(
  catalogue: Record<string, ApolloOrganizationCandidate[]>,
  over: Partial<EmployerDomainDeps> & { cache?: Record<string, string | null> } = {},
) {
  const written: Array<[string, EmployerResolution]> = [];
  const lookup = vi.fn(async (name: string) => catalogue[name] ?? []);
  const d: EmployerDomainDeps = {
    readCache: async (keys) => keys.filter((k) => over.cache && k in over.cache).map((k) => ({ key: k, domain: over.cache![k] })),
    writeCache: async (name, r) => {
      written.push([name, r]);
    },
    lookup,
    ...over,
  };
  return { d, lookup, written };
}

describe("resolveEmployer — exact single match ⟹ domain, anything else ⟹ null", () => {
  it("one exact (case/space-insensitive) match with a domain resolves", () => {
    const r = resolveEmployer("Abderhalden  Drogerie AG", [
      { id: "o1", name: "abderhalden drogerie ag", domain: "abderhalden.ch" },
      { id: "o2", name: "Abderhalden Holding", domain: "abderhalden-holding.ch" },
    ]);
    expect(r).toEqual({ outcome: "resolved", organizationId: "o1", domain: "abderhalden.ch" });
  });

  it("falls back to the website url's host when the match has no domain field", () => {
    expect(resolveEmployer("Acme", [{ id: "o1", name: "Acme", website_url: "https://www.acme.io/about" }]).domain).toBe("acme.io");
  });

  it("several distinct exact matches are ambiguous ⟹ null", () => {
    const r = resolveEmployer("Acme", [
      { id: "o1", name: "Acme", domain: "acme.com" },
      { id: "o2", name: "ACME", domain: "acme.de" },
    ]);
    expect(r).toEqual({ outcome: "ambiguous", organizationId: null, domain: null });
  });

  it("the same id listed twice is still ONE organization", () => {
    expect(resolveEmployer("Acme", [{ id: "o1", name: "Acme", domain: "acme.com" }, { id: "o1", name: "Acme", domain: "acme.com" }]).outcome).toBe("resolved");
  });

  it("only fuzzy (non-exact) candidates ⟹ null, never a guess", () => {
    expect(resolveEmployer("Acme", [{ id: "o1", name: "Acme Corp", domain: "acmecorp.com" }])).toEqual({ outcome: "no_exact_match", organizationId: null, domain: null });
    expect(resolveEmployer("Acme", []).outcome).toBe("no_exact_match");
  });

  it("an exact match without any usable domain ⟹ null", () => {
    expect(resolveEmployer("Acme", [{ id: "o1", name: "Acme", domain: null, website_url: null }])).toEqual({ outcome: "no_domain", organizationId: "o1", domain: null });
  });
});

describe("resolveEmployerDomains", () => {
  const catalogue: Record<string, ApolloOrganizationCandidate[]> = {
    Exact: [{ id: "o1", name: "Exact", domain: "exact.com" }],
    Twins: [{ id: "a", name: "Twins", domain: "a.com" }, { id: "b", name: "Twins", domain: "b.com" }],
  };

  it("resolves each distinct employer once, caches every outcome, and maps exact ⟹ domain, other ⟹ null", async () => {
    const { d, lookup, written } = deps(catalogue);
    const people = [teaser("Exact"), teaser("exact"), teaser("Twins"), teaser("Nobody"), teaser(null)];
    const domains = await resolveEmployerDomains(people, d);

    expect(lookup).toHaveBeenCalledTimes(3);
    expect(people.map((p) => employerDomainFor(p, domains))).toEqual(["exact.com", "exact.com", null, null, null]);
    expect(Object.fromEntries(written.map(([n, r]) => [n, r.outcome]))).toEqual({ Exact: "resolved", Twins: "ambiguous", Nobody: "no_exact_match" });
  });

  it("a cached name (hit or negative) is never looked up again", async () => {
    const { d, lookup } = deps(catalogue, { cache: { exact: "exact.com", twins: null } });
    const domains = await resolveEmployerDomains([teaser("Exact"), teaser("Twins")], d);
    expect(lookup).not.toHaveBeenCalled();
    expect(domains.get("exact")).toBe("exact.com");
    expect(domains.get("twins")).toBeNull();
  });

  it("a teaser already carrying Apollo's domain is not looked up", async () => {
    const { d, lookup } = deps(catalogue);
    await resolveEmployerDomains([teaser("Exact", "exact.com")], d);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a failed lookup leaves the domain absent and is NOT cached", async () => {
    const { d, written } = deps(catalogue, { lookup: async () => { throw new Error("Apollo 500"); } });
    const domains = await resolveEmployerDomains([teaser("Exact")], d);
    expect(domains.get("exact") ?? null).toBeNull();
    expect(written).toEqual([]);
  });

  it("a failed cache read still looks the employers up", async () => {
    const { d } = deps(catalogue, { readCache: async () => { throw new Error("db down"); } });
    const domains = await resolveEmployerDomains([teaser("Exact")], d);
    expect(domains.get("exact")).toBe("exact.com");
  });

  it("answers within the budget; a slow lookup still fills the cache afterwards", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { d, written } = deps(catalogue, {
      budgetMs: 20,
      lookup: async (name) => {
        if (name === "Exact") await slow;
        return catalogue[name] ?? [];
      },
    });
    const domains = await resolveEmployerDomains([teaser("Exact"), teaser("Twins")], d);
    expect(domains.has("exact")).toBe(false);
    expect(domains.get("twins")).toBeNull();

    release();
    await vi.waitFor(() => expect(written.map(([n]) => n)).toContain("Exact"));
  });
});
