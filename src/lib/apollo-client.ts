const APOLLO_API_BASE = "https://api.apollo.io/api/v1";

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

export interface ApolloEnrichResponse {
  person: ApolloPerson;
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
  personId: string
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
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apollo enrich failed: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Bulk enrich people using Apollo API
 */
export async function bulkEnrichPeople(
  apiKey: string,
  personIds: string[]
): Promise<{ matches: ApolloPerson[] }> {
  const response = await fetch(`${APOLLO_API_BASE}/people/bulk_match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      details: personIds.map((id) => ({ id })),
      reveal_personal_emails: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apollo bulk enrich failed: ${response.status} - ${error}`);
  }

  return response.json();
}
