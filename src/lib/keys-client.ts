const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "http://localhost:3001";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "";

/**
 * Fetch a decrypted app-level key from key-service.
 * App keys are platform-owned (not user BYOK).
 */
export async function getAppKey(
  appId: string,
  provider: string
): Promise<string> {
  const response = await fetch(
    `${KEY_SERVICE_URL}/internal/app-keys/${provider}/decrypt?appId=${appId}`,
    { headers: { "X-API-Key": KEY_SERVICE_API_KEY } }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${provider} app key not configured for app ${appId}`);
    }
    const error = await response.text();
    throw new Error(`Failed to fetch ${provider} app key: ${error}`);
  }

  const data = await response.json();
  return data.key;
}

/**
 * Client for fetching BYOK keys from key-service
 */
export async function getByokKey(
  clerkOrgId: string,
  provider: string
): Promise<string> {
  const response = await fetch(
    `${KEY_SERVICE_URL}/internal/keys/${provider}/decrypt?clerkOrgId=${clerkOrgId}`,
    { headers: { "X-API-Key": KEY_SERVICE_API_KEY } }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${provider} key not configured for this organization`);
    }
    const error = await response.text();
    throw new Error(`Failed to fetch ${provider} key: ${error}`);
  }

  const data = await response.json();
  return data.key;
}
