import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * COST-ACCOUNTING-1023: which paid task produces which outcome. Every one of
 * them parks through recordOutcomeDetached (subject = the person's lead in
 * lead-service, see outcome-declarations.test.ts). A production point that
 * loses its declaration puts its spend back under "produced nothing".
 */
const PRODUCTION_POINTS: Array<{ file: string; task: string; produced: string; consumed?: string }> = [
  { file: "src/routes/search.ts", task: "enrichment", produced: "email_found" },
  { file: "src/routes/match.ts", task: "person-match", produced: "email_found" },
  { file: "src/lib/email-find-run.ts", task: "email-find-*", produced: "email_found" },
  { file: "src/lib/email-verification.ts", task: "verify-email*", produced: "email_checked", consumed: "email_found" },
  { file: "src/routes/phone-reveal.ts", task: "phone-reveal (sync number)", produced: "phone_found" },
  { file: "src/routes/webhook.ts", task: "phone-reveal (callback)", produced: "phone_found" },
  { file: "src/lib/buying-signals.ts", task: "buying-signal-evidence", produced: "lead_identified" },
  { file: "src/lib/linkedin-engagement.ts", task: "linkedin-engagement", produced: "lead_identified" },
];

describe("every paid task declares its outcome", () => {
  for (const p of PRODUCTION_POINTS) {
    it(`${p.task} → produced ${p.produced}${p.consumed ? `, consumed ${p.consumed}` : ""}`, () => {
      const src = readFileSync(join(__dirname, "../..", p.file), "utf8");
      expect(src).toContain("recordOutcomeDetached({");
      expect(src).toContain(`produced: ["${p.produced}"]`);
      if (p.consumed) expect(src).toMatch(new RegExp(`\\["${p.consumed}"\\]|consumedByCheck\\(`));
    });
  }
});
