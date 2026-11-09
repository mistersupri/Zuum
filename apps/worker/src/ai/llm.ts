import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config } from "../config";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Returns schema-validated output; throws LlmError when the model output cannot be used. */
  structured<S extends z.ZodType>(opts: { system: string; user: string; schema: S }): Promise<{ data: z.infer<S>; usage: LlmUsage }>;
}

export class LlmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/**
 * Claude via the Anthropic SDK with structured outputs (JSON schema from Zod).
 * Server-side fallback is enabled so a policy decline is retried on another model
 * inside the same call instead of failing the job.
 */
class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model = config.ANTHROPIC_MODEL;
  private client = new Anthropic({ maxRetries: 3, timeout: 5 * 60_000 });

  async structured<S extends z.ZodType>(opts: { system: string; user: string; schema: S }) {
    try {
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: config.ANTHROPIC_EFFORT, format: betaZodOutputFormat(opts.schema) },
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      });
      if (res.stop_reason === "refusal") throw new LlmError("LLM_REFUSED", "Model menolak memproses transkrip ini.");
      if (res.stop_reason === "max_tokens") throw new LlmError("LLM_TRUNCATED", "Keluaran model terpotong.", true);
      if (!res.parsed_output) throw new LlmError("LLM_SCHEMA_INVALID", "Keluaran model tidak sesuai schema.", true);
      return {
        data: res.parsed_output as z.infer<S>,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, model: res.model },
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Anthropic.AuthenticationError)
        throw new LlmError("LLM_AUTH_FAILED", "Kunci API LLM tidak valid.");
      if (err instanceof Anthropic.RateLimitError) throw new LlmError("LLM_RATE_LIMITED", "Batas permintaan LLM tercapai.", true);
      if (err instanceof Anthropic.BadRequestError) throw new LlmError("LLM_BAD_REQUEST", err.message.slice(0, 300));
      if (err instanceof Anthropic.APIError) throw new LlmError("LLM_UPSTREAM", err.message.slice(0, 300), true);
      if (err instanceof Anthropic.APIConnectionError) throw new LlmError("LLM_UNREACHABLE", "Layanan LLM tidak dapat dihubungi.", true);
      throw err;
    }
  }
}

/**
 * Test-only provider (LLM_PROVIDER=mock). Returns empty, schema-valid results so the
 * pipeline can run end to end without an API key. It never invents decisions or tasks.
 */
class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock";
  async structured<S extends z.ZodType>(opts: { system: string; user: string; schema: S }) {
    const shape = (opts.schema as unknown as z.ZodObject).shape as Record<string, unknown>;
    const empty: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      if (["topics", "decisions", "actionItems", "conflicts", "keyPoints", "agenda", "sections"].includes(key)) empty[key] = [];
      else if (key === "overview") empty[key] = "[MOCK] Ringkasan uji. Konfigurasikan LLM_PROVIDER=anthropic untuk hasil nyata.";
      else empty[key] = null;
    }
    return { data: opts.schema.parse(empty) as z.infer<S>, usage: { inputTokens: 0, outputTokens: 0, model: "mock" } };
  }
}

export function llmProvider(): LlmProvider {
  if (config.LLM_PROVIDER === "mock") return new MockProvider();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new LlmError(
      "LLM_NOT_CONFIGURED",
      "Penyedia AI belum dikonfigurasi. Isi ANTHROPIC_API_KEY pada server worker, lalu jalankan ulang pembuatan hasil AI.",
    );
  }
  return new AnthropicProvider();
}
