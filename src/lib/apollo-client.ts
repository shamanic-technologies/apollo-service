import type { EmailStatus } from "../schemas.js";

const APOLLO_API_BASE = "https://api.apollo.io/api/v1";

/**
 * Hard cap on how long a single Apollo people/match request may run. /match and
 * /enrich run inside a DB transaction holding an advisory lock, so a hung Apollo
 * call would pin a connection + lock; aborting bounds that hold time.
 */
const APOLLO_FETCH_TIMEOUT_MS = 30_000;

/** `fetch` with an AbortController timeout. Throws on timeout so callers fail loud. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APOLLO_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a JSON response body while preserving large integer request_id values.
 * Apollo returns request_id as a JSON number that exceeds Number.MAX_SAFE_INTEGER,
 * causing precision loss with standard JSON.parse. This converts the numeric
 * request_id to a string before parsing.
 */
async function parseWithSafeRequestId<T>(response: Response): Promise<T> {
  const text = await response.text();
  const safe = text.replace(/"request_id"\s*:\s*(-?\d+)/, '"request_id":"$1"');
  return JSON.parse(safe) as T;
}

/**
 * Build the webhook URL for Apollo waterfall enrichment callbacks.
 * Returns undefined if the required env vars are not set.
 */
export function buildWaterfallWebhookUrl(): string | undefined {
  const publicUrl = process.env.APOLLO_SERVICE_PUBLIC_URL;
  const secret = process.env.APOLLO_WATERFALL_WEBHOOK_SECRET;
  if (!publicUrl || !secret) return undefined;
  return `${publicUrl}/webhook/waterfall?secret=${encodeURIComponent(secret)}`;
}

export interface ApolloSearchParams {
  person_titles?: string[];
  q_organization_keyword_tags?: string[];
  organization_locations?: string[];
  organization_num_employees_ranges?: string[];
  q_organization_industry_tag_ids?: string[];
  q_keywords?: string;
  person_locations?: string[];
  person_seniorities?: string[];
  contact_email_status?: string[];
  q_organization_domains?: string[];
  currently_using_any_of_technology_uids?: string[];
  // Apollo expects a single {min, max} integer object — NOT an array of
  // "min,max" strings. Sending the array form makes Apollo's Ruby do
  // array["min"] → 422 "no implicit conversion of String into Integer".
  revenue_range?: { min?: number; max?: number };
  organization_ids?: string[];
  page?: number;
  per_page?: number;
}

export interface ApolloEmploymentHistory {
  title?: string;
  organization_name?: string;
  start_date?: string;
  end_date?: string;
  description?: string;
  current?: boolean;
}

export interface ApolloFundingEvent {
  id?: string;
  date?: string;
  type?: string;
  investors?: string;
  amount?: number;
  currency?: string;
}

export interface ApolloTechnology {
  uid?: string;
  name?: string;
  category?: string;
}

export interface ApolloPhoneNumber {
  raw_number?: string;
  sanitized_number?: string;
  type?: string;
  position?: number;
  status?: string;
  dnc_status?: string;
  dnc_other_info?: string;
  dialer_flags?: Record<string, unknown>;
}

export interface ApolloOrganization {
  id: string;
  name: string;
  website_url: string;
  primary_domain: string;
  industry: string;
  estimated_num_employees: number;
  annual_revenue: number;
  // Description & branding
  logo_url?: string;
  short_description?: string;
  seo_description?: string;
  // Social & web links
  linkedin_url?: string;
  twitter_url?: string;
  facebook_url?: string;
  blog_url?: string;
  crunchbase_url?: string;
  angellist_url?: string;
  // Company details
  founded_year?: number;
  primary_phone?: { number?: string; source?: string };
  publicly_traded_symbol?: string;
  publicly_traded_exchange?: string;
  // Financial
  annual_revenue_printed?: string;
  total_funding?: number;
  total_funding_printed?: string;
  latest_funding_round_date?: string;
  latest_funding_stage?: string;
  funding_events?: ApolloFundingEvent[];
  // Location
  city?: string;
  state?: string;
  country?: string;
  street_address?: string;
  postal_code?: string;
  raw_address?: string;
  // Tech & classification
  technology_names?: string[];
  current_technologies?: ApolloTechnology[];
  keywords?: string[];
  industries?: string[];
  secondary_industries?: string[];
  // Misc
  num_suborganizations?: number;
  retail_location_count?: number;
  alexa_ranking?: number;
}

export interface ApolloPerson {
  id: string;
  first_name: string;
  last_name: string;
  name: string;
  email: string | null;
  email_status: EmailStatus | null;
  title: string;
  linkedin_url: string;
  // Profile
  photo_url?: string;
  headline?: string;
  // Location
  city?: string;
  state?: string;
  country?: string;
  // Role info
  seniority?: string;
  departments?: string[];
  subdepartments?: string[];
  functions?: string[];
  // Social links
  twitter_url?: string;
  github_url?: string;
  facebook_url?: string;
  // Contact details
  personal_emails?: string[];
  mobile_phone?: string;
  phone_numbers?: ApolloPhoneNumber[];
  // History
  employment_history?: ApolloEmploymentHistory[];
  // Organization
  organization?: ApolloOrganization;
}

export interface ApolloSearchResponse {
  people: ApolloPerson[];
  total_entries: number;
  // Legacy format (deprecated endpoint)
  pagination?: {
    page: number;
    per_page: number;
    total_entries: number;
    total_pages: number;
  };
}

export interface ApolloWaterfallStatus {
  status: string;
  message?: string;
}

export interface ApolloEnrichResponse {
  person: ApolloPerson;
  waterfall?: ApolloWaterfallStatus;
  request_id?: string | number;
}

export interface ApolloMatchResponse {
  person: ApolloPerson | null;
  waterfall?: ApolloWaterfallStatus;
  request_id?: string | number;
}

/**
 * Sentinel Apollo returns in `email` when an email exists but the plan/credits
 * cannot reveal it. It is NOT a real address — never charge, cache, or return it.
 */
export const APOLLO_PLACEHOLDER_EMAIL = "email_not_unlocked@domain.com";

/**
 * True only when Apollo SMTP-confirmed the email (`email_status === "verified"`).
 * Apollo bills 1 credit ONLY for verified emails; every other status it returns —
 * extrapolated (UI "Guessed"), unverified, catch_all, update_required, user_managed,
 * unknown — is NOT billed and NOT deliverable-guaranteed, and the placeholder above
 * is not an address at all. We treat all of those as "no email": not billed, not
 * positive-cached, not returned to callers.
 */
export function hasVerifiedEmail(
  person: Pick<ApolloPerson, "email" | "email_status">
): boolean {
  return (
    !!person.email &&
    person.email !== APOLLO_PLACEHOLDER_EMAIL &&
    person.email_status === "verified"
  );
}

/**
 * Normalize an Apollo person so a non-verified email is treated as absent: nulls
 * `email` while keeping `email_status` for audit. Downstream code (charge gate,
 * DB row, response transform, cache key) then uniformly sees `email === null` for
 * anything Apollo did not verify. Returns the person unchanged when verified.
 */
export function withVerifiedEmailOnly(person: ApolloPerson): ApolloPerson {
  if (hasVerifiedEmail(person)) return person;
  return { ...person, email: null };
}


/**
 * Search for people using Apollo API
 * Uses the new api_search endpoint (mixed_people/search is deprecated)
 */
export async function searchPeople(
  apiKey: string,
  params: ApolloSearchParams
): Promise<ApolloSearchResponse> {
  const response = await fetch(`${APOLLO_API_BASE}/mixed_people/api_search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      ...params,
      page: params.page || 1,
      per_page: params.per_page || 25,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[Apollo Service][searchPeople] Apollo API error", {
      status: response.status,
      error,
    });
    throw new Error(`Apollo search failed: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Enrich a single person using Apollo API
 */
export async function enrichPerson(
  apiKey: string,
  personId: string,
  webhookUrl?: string
): Promise<ApolloEnrichResponse> {
  const response = await fetchWithTimeout(`${APOLLO_API_BASE}/people/match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      id: personId,
      reveal_personal_emails: false,
      // Waterfall disabled 2026-05-28 — vendor email quality unreliable.
      // Revive by flipping to `true` + uncommenting surfaces in
      // waterfall.ts, search.ts, match.ts, webhook.ts, schemas.ts.
      run_waterfall_email: false,
      ...(webhookUrl && { webhook_url: webhookUrl }),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apollo enrich failed: ${response.status} - ${error}`);
  }

  return parseWithSafeRequestId<ApolloEnrichResponse>(response);
}

/**
 * Match a person by name and domain using Apollo API.
 * Same endpoint as enrichPerson, but with first_name + last_name + domain instead of id.
 */
export async function matchPersonByName(
  apiKey: string,
  firstName: string,
  lastName: string,
  domain: string,
  webhookUrl?: string
): Promise<ApolloMatchResponse> {
  const response = await fetchWithTimeout(`${APOLLO_API_BASE}/people/match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName,
      domain,
      reveal_personal_emails: false,
      // Waterfall disabled 2026-05-28 — see enrichPerson note.
      run_waterfall_email: false,
      ...(webhookUrl && { webhook_url: webhookUrl }),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apollo match failed: ${response.status} - ${error}`);
  }

  return parseWithSafeRequestId<ApolloMatchResponse>(response);
}


/**
 * Bulk enrich people using Apollo API
 */
export async function bulkEnrichPeople(
  apiKey: string,
  personIds: string[],
  webhookUrl?: string
): Promise<{ matches: ApolloPerson[]; waterfall?: ApolloWaterfallStatus; request_id?: string | number }> {
  const response = await fetch(`${APOLLO_API_BASE}/people/bulk_match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      details: personIds.map((id) => ({ id })),
      reveal_personal_emails: false,
      // Waterfall disabled 2026-05-28 — see enrichPerson note.
      run_waterfall_email: false,
      ...(webhookUrl && { webhook_url: webhookUrl }),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apollo bulk enrich failed: ${response.status} - ${error}`);
  }

  return parseWithSafeRequestId<{ matches: ApolloPerson[]; waterfall?: ApolloWaterfallStatus; request_id?: string | number }>(response);
}
