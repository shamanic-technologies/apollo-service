/**
 * Shared quota of Apollo's FREE organization name lookup (`organizations/search`
 * in fuzzy_select_mode), split between the PAID serve path and background fills.
 *
 * Apollo caps that endpoint at 400 calls/hour (and 200/minute) on the platform
 * key, for every caller of this service at once. Two kinds of caller use it:
 *
 *   serve      — the reveal domain gate in POST /enrich and the audience
 *                companies route: a customer is waiting on the answer.
 *   background — the teaser employer-domain cache fill on /search/next: additive
 *                information, a missing domain costs nothing.
 *
 * 2026-10-08 17:46-17:52 UTC: a campaign resumed after 17h, its /search/next
 * backlog fired ~45 teaser lookups a minute, the hour's 400 ran out, and two
 * POST /enrich serves for a paying customer died on the 429. So the background
 * fill only ever spends BACKGROUND_HOURLY_SHARE of the hour (the rest is kept
 * for serves), never retries a 429, and stops for a cooldown after any 429 —
 * whoever received it — so it cannot keep the window saturated.
 *
 * In-process state, on purpose: one container serves this key. A restart loses
 * the count, which costs at most one more background burst, and the 429
 * cooldown catches that.
 */

export const APOLLO_ORG_LOOKUP_HOURLY_CAP = 400;
/** Background fills stop at this many lookups in the last hour; the rest is reserved for serves. */
export const BACKGROUND_HOURLY_SHARE = 250;
/** Background pause after Apollo answered 429 on the hourly window. */
export const HOURLY_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
/** Background pause after a 429 on the per-minute window (or an unlabelled one). */
export const MINUTE_LIMIT_COOLDOWN_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type OrgLookupPriority = "serve" | "background";

export class OrgLookupBudget {
  private calls: number[] = [];
  private backgroundPausedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const since = this.now() - HOUR_MS;
    let i = 0;
    while (i < this.calls.length && this.calls[i] <= since) i++;
    if (i > 0) this.calls.splice(0, i);
  }

  /** Lookups sent to Apollo in the last hour (all priorities). */
  usedLastHour(): number {
    this.prune();
    return this.calls.length;
  }

  /** null = the background fill may call now; else why it must not. */
  backgroundRefusal(): string | null {
    if (this.now() < this.backgroundPausedUntil) {
      return `paused after an Apollo 429 for ${Math.ceil((this.backgroundPausedUntil - this.now()) / 1000)}s`;
    }
    const used = this.usedLastHour();
    if (used >= BACKGROUND_HOURLY_SHARE) {
      return `${used} lookups in the last hour, background share is ${BACKGROUND_HOURLY_SHARE} of ${APOLLO_ORG_LOOKUP_HOURLY_CAP}`;
    }
    return null;
  }

  /** One request sent to Apollo (a retry is another request). */
  recordCall(): void {
    this.calls.push(this.now());
  }

  /** Apollo answered 429: pause the background fill so serves get what is left. */
  recordRateLimited(body: string): void {
    const cooldown = /times per hour/i.test(body) ? HOURLY_LIMIT_COOLDOWN_MS : MINUTE_LIMIT_COOLDOWN_MS;
    this.backgroundPausedUntil = Math.max(this.backgroundPausedUntil, this.now() + cooldown);
  }
}

export const orgLookupBudget = new OrgLookupBudget();
