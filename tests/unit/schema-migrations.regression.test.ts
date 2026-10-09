import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/db/schema";

// Migrations are HAND-AUTHORED (see CLAUDE.md), so nothing ties a column added
// to src/db/schema.ts to the SQL that creates it. A schema column with no
// migration compiles, passes every mocked test, and 500s every query touching
// the table in prod: drizzle selects/inserts it by name (2026-10-09:
// `email_findings.reveal_route` broke POST /email-finder/find for ~16h).
//
// This check: every column of every pgTable must be named in a migration
// statement that targets that table (CREATE TABLE "t" (...) / ALTER TABLE "t" ...).

const DRIZZLE_DIR = join(__dirname, "../../drizzle");

function identifiersByTable(): Map<string, Set<string>> {
  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const byTable = new Map<string, Set<string>>();
  const tableRe =
    /(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?)\s+(?:"?public"?\.)?"?(\w+)"?/i;
  for (const { tag } of journal.entries) {
    const sql = readFileSync(join(DRIZZLE_DIR, `${tag}.sql`), "utf8").replace(/--[^\n]*/g, "");
    for (const stmt of sql.split(/;|statement-breakpoint/)) {
      const m = stmt.match(tableRe);
      if (!m) continue;
      const set = byTable.get(m[1]) ?? new Set<string>();
      for (const word of stmt.match(/\w+/g) ?? []) set.add(word);
      byTable.set(m[1], set);
    }
  }
  return byTable;
}

describe("schema.ts columns all have a migration", () => {
  it("journal lists exactly the .sql files on disk", () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    const onDisk = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));
    expect(journal.entries.map((e) => e.tag).sort()).toEqual(onDisk.sort());
  });

  it("every pgTable column is created by a migration on that table", () => {
    const byTable = identifiersByTable();
    const missing: string[] = [];
    const tables = Object.values(schema).filter((v): v is PgTable => v instanceof PgTable);
    expect(tables.length).toBeGreaterThan(10);
    for (const table of tables) {
      const { name, columns } = getTableConfig(table);
      const known = byTable.get(name);
      if (!known) {
        missing.push(`${name} (no migration creates this table)`);
        continue;
      }
      for (const col of columns) if (!known.has(col.name)) missing.push(`${name}.${col.name}`);
    }
    expect(missing).toEqual([]);
  });
});
