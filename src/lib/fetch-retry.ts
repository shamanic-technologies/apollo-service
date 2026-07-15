/**
 * fetchWithRetry — connect-phase retry for outbound HTTP calls to Neon-backed
 * sibling services.
 *
 * When a sibling's compute is suspended (Neon scale-to-zero) or a keep-alive
 * socket is reused right after the remote closed it, the first request lands
 * mid-wake and the socket is reset/dropped. `fetch` then rejects (it never gets
 * an HTTP response) with a `TypeError: fetch failed` whose `cause` is
 * `UND_ERR_SOCKET` ("other side closed") / `ECONNRESET` / `ETIMEDOUT` /
 * `ECONNREFUSED`. A chat completion is idempotent, so retrying a *thrown*
 * connect/socket error is write-safe.
 *
 * Retry ONLY on a thrown rejection. A completed HTTP response (even a 5xx) is a
 * real answer that may have side-effected — it is returned as-is and the caller
 * decides. Bounded backoff: 250 / 500 / 1000 ms.
 *
 * Reference impl: billing-service v0.29.2 `src/lib/fetch-retry.ts`.
 */

const TRANSIENT_CODES = new Set([
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const TRANSIENT_MESSAGE_RE = /other side closed|socket hang up|fetch failed|network|timeout/i;

const RETRY_BACKOFF_MS = [250, 500, 1000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk an error's `cause` chain + any `AggregateError.errors` looking for a
 * transient connect/socket failure. Node wraps the real socket error as the
 * `cause` of a `TypeError: fetch failed`, and happy-eyeballs surfaces multiple
 * per-address failures inside an `AggregateError`.
 */
export function isTransientConnectError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 5) return false;

  const anyErr = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };

  if (typeof anyErr.code === "string" && TRANSIENT_CODES.has(anyErr.code)) return true;
  if (typeof anyErr.message === "string" && TRANSIENT_MESSAGE_RE.test(anyErr.message)) return true;

  if (Array.isArray(anyErr.errors)) {
    for (const sub of anyErr.errors) {
      if (isTransientConnectError(sub, depth + 1)) return true;
    }
  }

  if (anyErr.cause) return isTransientConnectError(anyErr.cause, depth + 1);

  return false;
}

/**
 * Drop-in `fetch` replacement that retries only when the call THROWS a transient
 * connect/socket error. A returned Response (any status) is never retried.
 */
export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_BACKOFF_MS.length && isTransientConnectError(err)) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
  // Unreachable: the loop either returns a Response or throws above.
  throw lastErr;
}
