import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { errorMessage, errorString, messageOf } from "../../src/lib/db-error.js";

const SQL = 'insert into "people" ("email") values ($1)';
const PARAMS = ["secret@example.com"];

function queryError(): DrizzleQueryError {
  const driver = Object.assign(new Error('duplicate key value violates unique constraint "people_email"'), {
    code: "23505",
  });
  return new DrizzleQueryError(SQL, PARAMS, driver);
}

describe("db-error helpers", () => {
  it("returns the driver's reason for a failed query, never the SQL or its params", () => {
    for (const text of [errorMessage(queryError()), errorString(queryError()), messageOf(queryError())]) {
      expect(text).toContain('duplicate key value violates unique constraint "people_email"');
      expect(text).not.toContain("Failed query");
      expect(text).not.toContain("insert into");
      expect(text).not.toContain("secret@example.com");
    }
  });

  it("names no SQL when the query error carries no cause", () => {
    const bare = new DrizzleQueryError(SQL, PARAMS, undefined as unknown as Error);
    expect(errorMessage(bare)).toBe("database query failed");
    expect(errorString(bare)).not.toContain("secret@example.com");
  });

  it("behaves exactly like the expressions it replaces for every other error", () => {
    const plain = new TypeError("boom");
    expect(errorMessage(plain)).toBe("boom");
    expect(errorString(plain)).toBe(String(plain));
    expect(errorMessage("text")).toBe("text");
    expect(errorString(42)).toBe("42");
    expect(messageOf(plain)).toBe("boom");
    expect(messageOf({ message: "plain object" })).toBe("plain object");
  });
});

describe("queryErrorHandler", () => {
  it("answers a failed query with the driver's reason, no SQL, no params", async () => {
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const { queryErrorHandler } = await import("../../src/lib/db-error.js");
    const app = express();
    app.get("/boom", (_req, _res, next) => next(queryError()));
    app.get("/other", (_req, _res, next) => next(new Error("not a query")));
    app.use(queryErrorHandler);

    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'duplicate key value violates unique constraint "people_email"' });
    expect(res.text).not.toContain("secret@example.com");
    expect(res.text).not.toContain("insert into");

    // Any other error is left to Express, exactly as before.
    const other = await request(app).get("/other");
    expect(other.status).toBe(500);
    expect(other.headers["content-type"]).toContain("text/html");
  });
});
