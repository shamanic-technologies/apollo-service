/**
 * Dynasty resolution client for features-service and workflow-service.
 * Resolves dynasty slugs → versioned slugs, and fetches all dynasties for groupBy.
 */

interface DynastyEntry {
  dynastySlug: string;
  slugs: string[];
}

/**
 * Resolve a feature dynasty slug to its list of versioned slugs.
 */
export async function resolveFeatureDynastySlugs(dynastySlug: string): Promise<string[]> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("[Apollo Service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
    return [];
  }

  const url = `${baseUrl}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) {
    console.error(`[Apollo Service] Failed to resolve feature dynasty slug: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as { slugs: string[] };
  return data.slugs ?? [];
}

/**
 * Resolve a workflow dynasty slug to its list of versioned slugs.
 */
export async function resolveWorkflowDynastySlugs(dynastySlug: string): Promise<string[]> {
  const baseUrl = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("[Apollo Service] WORKFLOW_SERVICE_URL or WORKFLOW_SERVICE_API_KEY not configured");
    return [];
  }

  const url = `${baseUrl}/workflows/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) {
    console.error(`[Apollo Service] Failed to resolve workflow dynasty slug: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as { slugs: string[] };
  return data.slugs ?? [];
}

/**
 * Fetch all feature dynasties for groupBy resolution.
 */
export async function fetchAllFeatureDynasties(): Promise<DynastyEntry[]> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("[Apollo Service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
    return [];
  }

  const res = await fetch(`${baseUrl}/features/dynasties`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) {
    console.error(`[Apollo Service] Failed to fetch feature dynasties: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as { dynasties: DynastyEntry[] };
  return data.dynasties ?? [];
}

/**
 * Fetch all workflow dynasties for groupBy resolution.
 */
export async function fetchAllWorkflowDynasties(): Promise<DynastyEntry[]> {
  const baseUrl = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("[Apollo Service] WORKFLOW_SERVICE_URL or WORKFLOW_SERVICE_API_KEY not configured");
    return [];
  }

  const res = await fetch(`${baseUrl}/workflows/dynasties`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) {
    console.error(`[Apollo Service] Failed to fetch workflow dynasties: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as { dynasties: DynastyEntry[] };
  return data.dynasties ?? [];
}

/**
 * Build a reverse map: versioned slug → dynastySlug.
 * Slugs not in any dynasty fall back to themselves.
 */
export function buildSlugToDynastyMap(
  dynasties: DynastyEntry[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.slugs) {
      map.set(slug, d.dynastySlug);
    }
  }
  return map;
}
