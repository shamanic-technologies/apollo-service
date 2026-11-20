import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * SEC-APOLLO-KEY-1120. Every caller of apollo-service must present OUR service
 * key: `x-api-key` COMPARED (timing-safe) to `APOLLO_SERVICE_API_KEY`, never
 * merely present. The service is publicly routed (apollo.distribute.you via
 * Caddy), so identity headers (x-org-id / x-user-id) prove nothing on their own:
 * before this gate anyone on the internet could spend any org's Apollo credits
 * and read its data by sending a made-up org id.
 *
 * Fails closed: key unset = every non-public request refused (and the server
 * refuses to boot, see src/index.ts). No default, no test-mode bypass.
 */
export const SERVICE_KEY_ENV = "APOLLO_SERVICE_API_KEY";

/**
 * The ONLY routes reachable without our key. Each one is either harmless or
 * carries its own vendor proof:
 * - GET /health: liveness, no data.
 * - GET /openapi.json: the public contract.
 * - POST /webhook/phone-reveal: Apollo's delivery, checked against
 *   APOLLO_PHONE_REVEAL_WEBHOOK_SECRET (Apollo cannot send our key).
 * - POST /webhook/waterfall: disabled no-op, discards the payload.
 */
const PUBLIC_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/health"],
  ["HEAD", "/health"],
  ["GET", "/openapi.json"],
  ["POST", "/webhook/phone-reveal"],
  ["POST", "/webhook/waterfall"],
];

export function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some(([m, p]) => m === method && p === path);
}

/** Timing-safe equality of the presented key with ours. False when ours is unset. */
export function serviceKeyMatches(presented: unknown): boolean {
  const expected = process.env[SERVICE_KEY_ENV];
  if (!expected) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Express gate: 401 unless x-api-key equals our key (500 if our key is unset). */
export function requireServiceKey(req: Request, res: Response, next: NextFunction) {
  if (!process.env[SERVICE_KEY_ENV]) {
    console.error(`[apollo-service] ${SERVICE_KEY_ENV} is not set: refusing every authenticated request`);
    return res.status(500).json({ type: "internal", error: "Service api key not configured" });
  }
  if (!serviceKeyMatches(req.headers["x-api-key"])) {
    return res.status(401).json({ type: "auth", error: "Invalid or missing x-api-key" });
  }
  next();
}

/** App-wide gate mounted before every router and body parser: public routes pass, the rest need our key. */
export function serviceKeyGate(req: Request, res: Response, next: NextFunction) {
  if (isPublicRoute(req.method, req.path)) return next();
  return requireServiceKey(req, res, next);
}
