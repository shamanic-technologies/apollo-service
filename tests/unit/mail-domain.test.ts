import { describe, it, expect, vi, beforeEach } from "vitest";

// A plain function, not a vi.fn: a vi.fn whose implementation rejects is
// reported by vitest as a failure even when the caller handles it.
let resolveMx: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolveMx(domain: string) {
      return resolveMx(domain);
    }
  },
}));

function failWith(code: string) {
  return async () => {
    throw Object.assign(new Error(`queryMx ${code}`), { code });
  };
}

beforeEach(() => {
  resolveMx = async () => [];
});

describe("domainHasMx", () => {
  it("MX records → true", async () => {
    resolveMx = async () => [{ exchange: "smtp.secureserver.net", priority: 0 }];
    const { domainHasMx } = await import("../../src/lib/mail-domain.js");
    expect(await domainHasMx("definitejobsgroup.co.uk")).toBe(true);
  });

  it("a null MX (RFC 7505) → false", async () => {
    resolveMx = async () => [{ exchange: "", priority: 0 }];
    const { domainHasMx } = await import("../../src/lib/mail-domain.js");
    expect(await domainHasMx("nomail.example")).toBe(false);
  });

  it("NXDOMAIN / no MX record → false", async () => {
    const { domainHasMx } = await import("../../src/lib/mail-domain.js");
    resolveMx = failWith("ENOTFOUND");
    expect(await domainHasMx("gmail.con")).toBe(false);
    resolveMx = failWith("ENODATA");
    expect(await domainHasMx("web-only.example")).toBe(false);
  });

  it("a lookup that cannot answer throws, never reads as 'no MX'", async () => {
    resolveMx = failWith("ETIMEOUT");
    const { domainHasMx, MailDomainLookupError } = await import("../../src/lib/mail-domain.js");
    await expect(domainHasMx("slow.example")).rejects.toBeInstanceOf(MailDomainLookupError);
  });
});
