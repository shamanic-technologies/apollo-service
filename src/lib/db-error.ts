import { DrizzleQueryError } from "drizzle-orm/errors";

/**
 * Error text that is safe to store in a column or return in a response.
 *
 * Since drizzle-orm 0.44 a failed query throws a `DrizzleQueryError` whose
 * message is `Failed query: <SQL> params: <values>`: the SQL text and the bound
 * values (ids, emails, payloads), while the database's own reason sits on
 * `.cause`. Every caught error that may come from a query goes through these
 * helpers so we keep the real reason and never echo SQL or params.
 */
function unwrapQueryError(err: unknown): unknown {
  let cur = err;
  for (let depth = 0; depth < 5 && cur instanceof DrizzleQueryError; depth++) {
    if (cur.cause === undefined || cur.cause === null) return new Error("database query failed");
    cur = cur.cause;
  }
  return cur instanceof DrizzleQueryError ? new Error("database query failed") : cur;
}

/** `err instanceof Error ? err.message : String(err)`, with a query error's driver cause. */
export function errorMessage(err: unknown): string {
  const e = unwrapQueryError(err);
  return e instanceof Error ? e.message : String(e);
}

/** `err.message`, with a query error's driver cause. */
export function messageOf(err: unknown): string {
  return (unwrapQueryError(err) as { message?: string } | null | undefined)?.message as string;
}

/** `String(err)`, with a query error's driver cause. */
export function errorString(err: unknown): string {
  return String(unwrapQueryError(err));
}

/**
 * Last Express error handler: a failed query that reaches it answers 500 with the
 * driver's reason only. Express's default handler would otherwise print the
 * error's stack (the SQL and its params) into the response body whenever
 * NODE_ENV is not "production". Every other error goes on to Express unchanged.
 */
export function queryErrorHandler(
  err: unknown,
  _req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  if (!(err instanceof DrizzleQueryError) || res.headersSent) {
    next(err);
    return;
  }
  console.error(`[db] query failed: ${errorMessage(err)}`);
  res.status(500).json({ error: errorMessage(err) });
}
