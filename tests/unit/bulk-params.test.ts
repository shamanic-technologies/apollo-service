import { describe, it, expect } from "vitest";
import { chunkRows, pgTextArray, PG_MAX_PARAMETERS, rowsPerStatement } from "../../src/lib/bulk-params.js";

describe("bulk-params", () => {
  it("chunks rows so no statement binds more than the postgres cap", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => i);
    const chunks = chunkRows(rows, 10);
    expect(chunks.flat()).toEqual(rows);
    for (const c of chunks) expect(c.length * 10).toBeLessThanOrEqual(PG_MAX_PARAMETERS);
    expect(rowsPerStatement(10)).toBe(3276);
  });

  it("encodes a text[] literal as one parameter, escaping quotes and backslashes", () => {
    expect(pgTextArray(["a", 'b"c', "d\\e"])).toBe('{"a","b\\"c","d\\\\e"}');
    expect(pgTextArray([])).toBe("{}");
  });
});
