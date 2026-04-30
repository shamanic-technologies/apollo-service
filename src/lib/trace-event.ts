export async function traceEvent(
  runId: string,
  payload: {
    service: string;
    event: string;
    detail?: string;
    level?: "info" | "warn" | "error";
    data?: Record<string, unknown>;
  },
  headers: Record<string, string | string[] | undefined>,
): Promise<void> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.error("[apollo-service] RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set, skipping trace event");
    return;
  }
  try {
    await fetch(`${url}/v1/runs/${runId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        ...(headers["x-org-id"] ? { "x-org-id": headers["x-org-id"] as string } : {}),
        ...(headers["x-user-id"] ? { "x-user-id": headers["x-user-id"] as string } : {}),
        ...(headers["x-brand-id"] ? { "x-brand-id": headers["x-brand-id"] as string } : {}),
        ...(headers["x-campaign-id"] ? { "x-campaign-id": headers["x-campaign-id"] as string } : {}),
        ...(headers["x-workflow-slug"] ? { "x-workflow-slug": headers["x-workflow-slug"] as string } : {}),
        ...(headers["x-feature-slug"] ? { "x-feature-slug": headers["x-feature-slug"] as string } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[apollo-service] Failed to trace event:", err);
  }
}
