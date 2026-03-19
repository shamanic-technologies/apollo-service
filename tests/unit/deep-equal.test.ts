import { describe, it, expect } from "vitest";
import { deepEqual } from "../../src/lib/deep-equal.js";

describe("deepEqual", () => {
  it("returns true for identical objects", () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  it("returns true for objects with different key order", () => {
    expect(deepEqual({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it("returns false for objects with different values", () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
  });

  it("returns false for objects with different keys", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("handles nested objects with different key order", () => {
    const a = { outer: { z: 3, a: 1 }, list: [1, 2] };
    const b = { list: [1, 2], outer: { a: 1, z: 3 } };
    expect(deepEqual(a, b)).toBe(true);
  });

  it("handles arrays (order-sensitive)", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
  });

  it("handles nulls", () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
  });

  it("handles primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
  });

  it("simulates JSONB round-trip key reordering", () => {
    // This is the exact bug: Postgres JSONB sorts keys alphabetically
    const fromClient = {
      personTitles: ["CEO"],
      qOrganizationIndustryTagIds: ["Construction"],
      organizationNumEmployeesRanges: ["1,10"],
    };
    const fromPostgres = {
      organizationNumEmployeesRanges: ["1,10"],
      personTitles: ["CEO"],
      qOrganizationIndustryTagIds: ["Construction"],
    };

    // JSON.stringify would fail here (the old bug)
    expect(JSON.stringify(fromClient)).not.toBe(JSON.stringify(fromPostgres));
    // deepEqual handles it correctly
    expect(deepEqual(fromClient, fromPostgres)).toBe(true);
  });
});
