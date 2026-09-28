/**
 * A free, read-only SAMPLE of who is in a persisted Apollo audience: a handful of
 * real employers and real people, for showing a prospect real output before they
 * sign up (consumer: human-service, then the distribute.you onboarding).
 *
 * FREE BY CONSTRUCTION — one Apollo people-search teaser call (zero credits at
 * any page size, same instrument as the refine loop's `dryRunSample`). Nothing
 * else is called:
 *
 * - The teaser carries a person as `first_name`, `last_name_obfuscated`, `title`
 *   and an organization holding ONLY `name` (every location/industry/size field
 *   is redacted to a `has_*` boolean — verified live 2026-09-28). So companies
 *   are the distinct EMPLOYERS of the sampled people, and carry a name only.
 * - Company descriptors (domain, industry, headcount, location) are NOT free:
 *   Apollo Organization Search (`mixed_companies/search`) moved `lead_credit` by
 *   1 for one page of 10 (measured 2026-09-28 via `credit_usage_stats` before /
 *   after, zero drift in the baseline window). A signed-out visitor must not
 *   spend credits, and an organization search on the audience's org-level
 *   filters would also ignore its person-level filters (titles, seniorities),
 *   i.e. list companies where nobody in the audience works. So they are omitted,
 *   not nulled: do not add them back without a billed path.
 *
 * READ-ONLY — no cursor, no buffer, no row written, no count snapshot refreshed.
 * The serve path (`/search/next`) never sees this call.
 *
 * DETERMINISTIC ENOUGH — page 1 of Apollo's ranked results, not random pages.
 * The refine loop draws random pages because it JUDGES composition (page 1 hides
 * leaks); a showcase wants a stable answer across calls, and page 1 is Apollo's
 * best-ranked slice of the same set.
 */
import { toApolloSearchParams } from "./transform.js";
import type { CreditAlertIdentity } from "./credit-alert.js";
import { searchPeople, type ApolloPerson } from "./apollo-client.js";

/** One free teaser page. 100 is Apollo's max per_page and costs the same (zero). */
export const PREVIEW_PAGE_SIZE = 100;
export const PREVIEW_MAX_COMPANIES = 10;
export const PREVIEW_MAX_PEOPLE = 20;

export interface PreviewCompany {
  name: string;
  /** How many of the sampled page's people work there (a rank hint, not a headcount). */
  peopleInSample: number;
}

export interface PreviewPerson {
  firstName: string | null;
  /** As Apollo's free teaser serves it, e.g. "Ni***s". The full last name is a paid reveal. */
  lastNameObfuscated: string | null;
  title: string | null;
  company: string | null;
}

export interface AudiencePreview {
  count: number;
  companies: PreviewCompany[];
  people: PreviewPerson[];
}

type TeaserPerson = ApolloPerson & { last_name_obfuscated?: string | null };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function toPreviewPerson(p: TeaserPerson): PreviewPerson {
  return {
    firstName: str(p.first_name),
    lastNameObfuscated: str(p.last_name_obfuscated),
    title: str(p.title),
    company: str(p.organization?.name),
  };
}

/**
 * Pure: turn one ranked teaser page into the preview. Companies are the first
 * 10 distinct employers in rank order; people are picked round-robin across
 * THOSE employers only, so one large company cannot crowd the others out and
 * every person shown works at a listed company. A row with no employer name is
 * skipped. Exported for tests.
 */
export function buildPreview(count: number, raw: TeaserPerson[]): AudiencePreview {
  const people = raw.map(toPreviewPerson);

  const byCompany = new Map<string, PreviewPerson[]>();
  for (const p of people) {
    if (!p.company) continue;
    const key = p.company.toLowerCase();
    const list = byCompany.get(key);
    if (list) list.push(p);
    else byCompany.set(key, [p]);
  }

  const groups = [...byCompany.values()].slice(0, PREVIEW_MAX_COMPANIES);
  const companies: PreviewCompany[] = groups.map((list) => ({ name: list[0].company!, peopleInSample: list.length }));

  // People are drawn ONLY from the listed companies ("people at those
  // companies"), one per company per pass.
  const picked: PreviewPerson[] = [];
  for (let depth = 0; picked.length < PREVIEW_MAX_PEOPLE; depth++) {
    let any = false;
    for (const g of groups) {
      if (depth < g.length) {
        any = true;
        picked.push(g[depth]);
        if (picked.length >= PREVIEW_MAX_PEOPLE) break;
      }
    }
    if (!any) break;
  }

  return { count, companies, people: picked };
}

/** One free Apollo teaser call over the audience's stored filters. */
export async function previewAudience(
  apolloApiKey: string,
  filters: Record<string, unknown>,
  alertIdentity?: CreditAlertIdentity,
): Promise<AudiencePreview> {
  const res = await searchPeople(
    apolloApiKey,
    { ...toApolloSearchParams(filters), page: 1, per_page: PREVIEW_PAGE_SIZE },
    alertIdentity,
  );
  const count = res.total_entries ?? res.pagination?.total_entries ?? 0;
  return buildPreview(count, (res.people ?? []) as TeaserPerson[]);
}
