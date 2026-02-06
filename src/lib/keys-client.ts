/**
 * Client for fetching BYOK keys from key-service
 */
export async function getByokKey(
  clerkOrgId: string,
  provider: string
): Promise<string> {
  const keyServiceUrl = process.env.KEY_SERVICE_URL || "http://localhost:3001";
  const keyServiceApiKey = process.env.KEY_SERVICE_API_KEY || "";

  const response = await fetch(
    `${keyServiceUrl}/internal/keys/${provider}/decrypt?clerkOrgId=${clerkOrgId}`,
    {
      headers: {
        "X-API-Key": keyServiceApiKey,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${provider} key not configured for this organization`);
    }
    const error = await response.text();
    console.error(`[Apollo Service] getByokKey failed: status=${response.status} url=${keyServiceUrl} apiKeySet=${!!process.env.KEY_SERVICE_API_KEY} apiKeyLen=${keyServiceApiKey.length}`);
    throw new Error(`Failed to fetch ${provider} key: ${error}`);
  }

  const data = await response.json();
  return data.key;
}
