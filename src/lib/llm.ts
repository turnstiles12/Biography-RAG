// Thin wrapper over the Anthropic SDK. API keys stay on the server: either the site owner's
// ANTHROPIC_API_KEY or a visitor's BYOK key held in memory for one request/job and never stored.

import Anthropic from "@anthropic-ai/sdk";
import { config, type Effort } from "./env";

export interface LlmResult {
  text: string;
  stopReason: string | null;
  model: string;
  usage: Record<string, unknown>;
  latencyMs: number;
  refused: boolean;
}

export class LlmConfigError extends Error {}

const clients = new Map<string, Anthropic>();

function clientFor(apiKey: string): Anthropic {
  // Cache only the server key's client; BYOK clients are created per call and dropped.
  if (apiKey === config.anthropicApiKey) {
    let c = clients.get("server");
    if (!c) {
      c = new Anthropic({ apiKey, maxRetries: 3 });
      clients.set("server", c);
    }
    return c;
  }
  return new Anthropic({ apiKey, maxRetries: 3 });
}

/** Resolves which key to use; throws if none is available. */
export function resolveApiKey(byokKey?: string | null): string {
  if (byokKey) return byokKey;
  if (config.anthropicApiKey) return config.anthropicApiKey;
  throw new LlmConfigError("This server has no LLM key configured. Supply your own Anthropic API key (BYOK).");
}

export function looksLikeAnthropicKey(k: string): boolean {
  return /^sk-ant-[A-Za-z0-9_\-]{20,250}$/.test(k);
}

/** Remove anything resembling a key from error text before it is logged or shown. */
export function scrubSecrets(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***").replace(/sk-[A-Za-z0-9_\-]{20,}/g, "sk-***");
}

function supportsFallbacks(model: string): boolean {
  return config.llmFallbacks && !model.startsWith("claude-haiku");
}

export async function complete(opts: {
  apiKey: string;
  system: string;
  user: string;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
}): Promise<LlmResult> {
  const model = opts.model ?? config.llmModel;
  const client = clientFor(opts.apiKey);
  const started = Date.now();
  const fallbacks = supportsFallbacks(model);

  try {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      thinking: { type: "adaptive" },
      output_config: {
        effort: opts.effort ?? "medium",
        ...(opts.jsonSchema ? { format: { type: "json_schema" as const, schema: opts.jsonSchema } } : {}),
      },
      ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const msg = await stream.finalMessage();
    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return {
      text,
      stopReason: msg.stop_reason,
      model: msg.model,
      usage: msg.usage as unknown as Record<string, unknown>,
      latencyMs: Date.now() - started,
      refused: msg.stop_reason === "refusal",
    };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      throw new LlmConfigError("The Anthropic API key was rejected (401). Check the key and try again.");
    }
    if (e instanceof Anthropic.PermissionDeniedError) {
      throw new LlmConfigError("The Anthropic API key lacks permission for this model (403).");
    }
    if (e instanceof Anthropic.RateLimitError) {
      throw new Error("The LLM provider rate-limited this request (429). Try again shortly.");
    }
    if (e instanceof Anthropic.APIError) {
      throw new Error(scrubSecrets(`LLM API error ${e.status ?? ""}: ${e.message}`));
    }
    throw new Error(scrubSecrets((e as Error).message));
  }
}

/** Minimal promise pool: run tasks with bounded concurrency, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
