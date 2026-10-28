import { sql, type SQL } from "drizzle-orm";

/** Anything with a raw `.execute(SQL)` — both `db` and a drizzle tx satisfy this. */
type SqlExecutor = { execute: (query: SQL) => Promise<unknown> };

/**
 * Acquire a transaction-scoped Postgres advisory lock keyed on an arbitrary
 * string. Serializes concurrent work for the same key across replicas; the lock
 * auto-releases when the surrounding transaction commits or rolls back.
 *
 * MUST be called as the first statement inside a `db.transaction(...)` callback
 * (pass the `tx`). Used to collapse a cache stampede: concurrent requests for the
 * same enrichment key block here until the first one has committed its cache row,
 * so only one of them calls Apollo.
 */
export async function advisoryXactLock(tx: SqlExecutor, key: string): Promise<void> {
  // hashtext() maps the string to an int4; the cast widens it to the bigint
  // overload of pg_advisory_xact_lock.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`);
}

/** Lock key for POST /enrich (keyed on Apollo person id). */
export function enrichLockKey(apolloPersonId: string): string {
  return `apollo-enrich:${apolloPersonId}`;
}

/** Lock key for POST /match (keyed on the case-insensitive name + domain tuple). */
export function matchLockKey(firstName: string, lastName: string, organizationDomain: string): string {
  return `apollo-match:${firstName.toLowerCase()}|${lastName.toLowerCase()}|${organizationDomain.toLowerCase()}`;
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * In-process single flight (BOX-DB-LOAD-1028): concurrent callers for the same
 * key share the ONE running `work` instead of each queuing on the Postgres
 * advisory lock, where every waiter holds a pool connection and a backend for
 * the whole wait (a slow paid read under the lock made the queue the box's 2nd
 * biggest Postgres line). The advisory lock stays inside `work`: it still guards
 * against a second process. A follower whose leader THREW runs `work` itself, so
 * a failure that belongs to the leader (its org's credit, its run) never becomes
 * the follower's answer.
 */
export async function singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) {
    try {
      return await running;
    } catch {
      return work();
    }
  }
  const mine = work();
  inFlight.set(key, mine);
  try {
    return await mine;
  } finally {
    if (inFlight.get(key) === mine) inFlight.delete(key);
  }
}
