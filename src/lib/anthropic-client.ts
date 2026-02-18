import Anthropic from "@anthropic-ai/sdk";

export interface LlmResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export async function callClaude(
  apiKey: string,
  system: string,
  userMessage: string
): Promise<LlmResponse> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");

  return {
    content: textBlock?.text ?? "",
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
