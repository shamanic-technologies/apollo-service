import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * The history of every BounceVerify verification this service ever made
 * (bronze `email_verifications`, every org, every source), as a resumable feed
 * a consumer mirrors and keeps current by polling "what came after my cursor".
 *
 * Cursor = `email_verifications.seq` (bigserial, insertion order). A page never
 * goes past the SETTLE FRONTIER: the first row (in seq order) inserted less than
 * SETTLE_SECONDS ago. Rows are inserted by single autocommit statements, so a row
 * still invisible to this read (not committed yet) was given its seq a few ms ago
 * and every visible row after it is fresh too; stopping before the first fresh
 * row means a consumer that passed a cursor never has a row appear behind it.
 */
export const HISTORY_DEFAULT_LIMIT = 1000;
export const HISTORY_MAX_LIMIT = 5000;
export const SETTLE_SECONDS = 60;

export interface VerificationHistoryRow {
  id: string;
  email: string;
  verifier: string;
  verdict: string | null;
  verifiedAt: string;
  cursor: string;
}

export interface VerificationHistoryPage {
  verifications: VerificationHistoryRow[];
  nextCursor: string;
  hasMore: boolean;
}

interface RawRow {
  seq: string | number;
  id: string;
  email: string;
  verifier: string;
  verdict: string | null;
  verified_at: Date | string;
}

export async function readVerificationHistory(after: string, limit: number): Promise<VerificationHistoryPage> {
  const rows = (await db.execute(sql`
    SELECT seq, id, email, verifier, verdict, verified_at
    FROM email_verifications
    WHERE seq > ${after}::bigint
      AND seq < COALESCE(
        (SELECT min(f.seq) FROM email_verifications f
          WHERE f.seq > ${after}::bigint
            AND f.verified_at >= now() - make_interval(secs => ${SETTLE_SECONDS})),
        9223372036854775807
      )
    ORDER BY seq ASC
    LIMIT ${limit + 1}
  `)) as unknown as RawRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((r) => ({
    id: r.id,
    email: r.email,
    verifier: r.verifier,
    verdict: r.verdict ?? null,
    verifiedAt: (r.verified_at instanceof Date ? r.verified_at : new Date(r.verified_at)).toISOString(),
    cursor: String(r.seq),
  }));
  return {
    verifications: page,
    nextCursor: page.length > 0 ? page[page.length - 1].cursor : after,
    hasMore,
  };
}
