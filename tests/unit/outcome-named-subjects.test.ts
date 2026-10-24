import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

import { dedupeSubjects } from "../../src/lib/outcome-named-subjects.js";
import { NamedSubjectsBackfillRequestSchema } from "../../src/schemas.js";

describe("named-subjects backfill (LEDGER-HISTORY-1024)", () => {
  it("normalizes addresses and keeps one subject per address", () => {
    const r = dedupeSubjects([
      { email: " Ada@Example.com ", subjectService: "transactional-email-service", subjectId: "s-1" },
      { email: "ada@example.com", subjectService: "transactional-email-service", subjectId: "s-1" },
    ]);
    expect(r).toEqual({ conflict: null, subjects: [{ email: "ada@example.com", subjectService: "transactional-email-service", subjectId: "s-1" }] });
  });

  it("refuses two subjects for one address", () => {
    const r = dedupeSubjects([
      { email: "ada@example.com", subjectService: "transactional-email-service", subjectId: "s-1" },
      { email: "ADA@example.com", subjectService: "transactional-email-service", subjectId: "s-2" },
    ]);
    expect(r.conflict).toBe("ada@example.com");
  });

  it("caps a call at 500 subjects (under the default body limit)", () => {
    const subjects = Array.from({ length: 501 }, (_, i) => ({ email: `a${i}@x.com`, subjectService: "t", subjectId: `s-${i}` }));
    expect(NamedSubjectsBackfillRequestSchema.safeParse({ dryRun: true, callerLabel: "t:x", subjects }).success).toBe(false);
    expect(NamedSubjectsBackfillRequestSchema.safeParse({ dryRun: true, callerLabel: "t:x", subjects: subjects.slice(0, 500) }).success).toBe(true);
  });
});
