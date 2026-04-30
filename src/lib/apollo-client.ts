const APOLLO_API_BASE = "https://api.apollo.io/api/v1";

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
  revenue_range?: string[];
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
  email: string;
  email_status: string;
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

export interface BulkMatchInput {
  first_name: string;
  last_name: string;
  domain: string;
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
  const response = await fetch(`${APOLLO_API_BASE}/people/match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      id: personId,
      reveal_personal_emails: false,
      run_waterfall_email: true,
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
  const response = await fetch(`${APOLLO_API_BASE}/people/match`, {
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
      run_waterfall_email: true,
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
 * Bulk match people by name + domain using Apollo's bulk_match endpoint.
 * Max 10 items per call (Apollo limit).
 */
export async function bulkMatchPeopleByName(
  apiKey: string,
  items: BulkMatchInput[],
  webhookUrl?: string
): Promise<{ matches: (ApolloPerson | null)[]; waterfall?: ApolloWaterfallStatus; request_id?: string | number }> {
  const response = await fetch(`${APOLLO_API_BASE}/people/bulk_match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      details: items,
      reveal_personal_emails: false,
      run_waterfall_email: true,
      ...(webhookUrl && { webhook_url: webhookUrl }),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apollo bulk match failed: ${response.status} - ${error}`);
  }

  return parseWithSafeRequestId<{ matches: (ApolloPerson | null)[]; waterfall?: ApolloWaterfallStatus; request_id?: string | number }>(response);
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
      run_waterfall_email: true,
      ...(webhookUrl && { webhook_url: webhookUrl }),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apollo bulk enrich failed: ${response.status} - ${error}`);
  }

  return parseWithSafeRequestId<{ matches: ApolloPerson[]; waterfall?: ApolloWaterfallStatus; request_id?: string | number }>(response);
}
