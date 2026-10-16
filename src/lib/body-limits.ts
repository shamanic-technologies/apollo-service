import express from "express";

/**
 * JSON body limits.
 *
 * Every route keeps Express's default (100kb) except POST
 * /internal/acquisition-costs, which takes up to 5000 served leads per call.
 * A realistic lead (ref + campaign UUIDs, ISO date, Apollo id, email, keys) is
 * ~250 bytes, so 5000 leads ≈ 1.25 MB; 5mb leaves 4x margin. Prod 2026-10-17:
 * lead-service batches of ~536 / ~770 / ~5,100 leads hit the 100kb default and
 * came back as a generic 500.
 */
export const ACQUISITION_COSTS_PATH = "/internal/acquisition-costs";
export const ACQUISITION_COSTS_BODY_LIMIT = "5mb";

// Preserve raw body for webhook request_id precision handling
const verify = (req: express.Request, _res: express.Response, buf: Buffer) => {
  (req as any).rawBody = buf.toString();
};

/** Mounted BEFORE the default parser: body-parser skips a body already parsed. */
export const acquisitionCostsJsonParser = express.json({ limit: ACQUISITION_COSTS_BODY_LIMIT, verify });
export const defaultJsonParser = express.json({ verify });

/** A body over the limit is a named 413, never the fallback 500. */
export function bodyTooLargeHandler(
  err: any,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      type: "validation",
      error: `Request body too large (limit ${err.limit} bytes, received ${err.length ?? "unknown"} bytes)`,
    });
  }
  next(err);
}
