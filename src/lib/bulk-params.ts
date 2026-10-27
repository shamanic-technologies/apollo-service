/**
 * Postgres caps ONE statement at 65,534 bound parameters (postgres.js throws
 * MAX_PARAMETERS_EXCEEDED). A multi-row INSERT binds rows × columns, so any
 * insert whose row count comes from a provider (an employer's job postings:
 * ~9,000 at Amazon) must go in chunks. BIG-COMPANY-SIGNALS-1027: one Lloyds
 * Banking lead's /enrich bound ~81,600 parameters and 502'd.
 */
export const PG_MAX_PARAMETERS = 65_534;

/** Rows per statement so rows × paramsPerRow stays under half the cap (headroom for ON CONFLICT / defaults). */
export function rowsPerStatement(paramsPerRow: number): number {
  return Math.max(1, Math.floor(PG_MAX_PARAMETERS / 2 / Math.max(1, paramsPerRow)));
}

export function chunkRows<T>(rows: T[], paramsPerRow: number): T[][] {
  const size = rowsPerStatement(paramsPerRow);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * A text[] literal bound as ONE parameter (`col = ANY(${pgTextArray(xs)}::text[])`),
 * for IN-lists whose length a caller controls: an `inArray` binds one parameter
 * per value and breaks past the cap.
 */
export function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}
