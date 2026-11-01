import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { Sql } from "postgres";
import * as schema from "./schema.js";
import { installNulStripping } from "../lib/nul-strip.js";

let sqlClient: Sql | null = null;
let dbInstance: PostgresJsDatabase<typeof schema> | null = null;

function getConnectionString(): string {
  const connectionString = process.env.APOLLO_SERVICE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APOLLO_SERVICE_DATABASE_URL is not set");
  }
  return connectionString;
}

export function getSql(): Sql {
  if (!sqlClient) {
    // PG-CONN-1101: 5 is this service's share of the box Postgres (300 slots, ~30 pools); measured
    // peak concurrent use 0-2. postgres.js queues beyond max, it does not fail. postgres.js reuses
    // its open connections in turn, so a pool that once grew to max stays at max: max_lifetime
    // recycles them so the pool shrinks back to real need (a running query is never cut).
    sqlClient = postgres(getConnectionString(), {
      idle_timeout: 20,
      max_lifetime: 300,
      connect_timeout: 10,
      max: 5,
    });
    installNulStripping(sqlClient);
  }
  return sqlClient;
}

export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_, prop) {
    if (!dbInstance) {
      dbInstance = drizzle(getSql(), { schema });
    }
    return (dbInstance as any)[prop];
  },
});
