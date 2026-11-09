import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Largest prompt (in characters) worth sending; drives transcript chunking. */
  readonly maxInputChars: number;
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

// Server-side refusal fallback exists only for these models; Haiku has none.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

/**
 * Claude via the Anthropic SDK with structured outputs (JSON schema from Zod).
 * Defaults to Claude Haiku 5.5, the low-cost tier; set ANTHROPIC_MODEL for a larger model.
 */
class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model = config.ANTHROPIC_MODEL;
  readonly maxInputChars = 120_000;
  private client = new Anthropic({ maxRetries: 3, timeout: 5 * 60_000 });

  async structured<S extends z.ZodType>(opts: { system: string; user: string; schema: S }) {
    try {
      const fallback = FALLBACK_MODELS.has(this.model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {};
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        ...fallback,
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
      if (err instanceof Anthropic.AuthenticationError) throw new LlmError("LLM_AUTH_FAILED", "Kunci API LLM tidak valid.");
      if (err instanceof Anthropic.RateLimitError) throw new LlmError("LLM_RATE_LIMITED", "Batas permintaan LLM tercapai.", true);
      if (err instanceof Anthropic.BadRequestError) throw new LlmError("LLM_BAD_REQUEST", err.message.slice(0, 300));
      if (err instanceof Anthropic.APIError) throw new LlmError("LLM_UPSTREAM", err.message.slice(0, 300), true);
      if (err instanceof Anthropic.APIConnectionError) throw new LlmError("LLM_UNREACHABLE", "Layanan LLM tidak dapat dihubungi.", true);
      throw err;
    }
  }
}

/**
 * Free, self-hosted open model through Ollama. Ollama constrains decoding to the JSON
 * schema (`format`), and the result is still validated with Zod; one repair attempt
 * is made with the validation errors before the job fails.
 */
export class OllamaProvider implements LlmProvider {
  readonly name = "ollama";
  // Small local models have short context windows; keep chunks modest.
  readonly maxInputChars = 20_000;
  constructor(
    readonly model = config.OLLAMA_MODEL,
    private readonly baseUrl = config.OLLAMA_BASE_URL,
    private readonly timeoutMs = config.OLLAMA_TIMEOUT_MS,
  ) {}

  private async chat(messages: { role: string; content: string }[], schema: unknown) {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          format: schema,
          stream: false,
          options: { temperature: 0, num_ctx: 16384 },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new LlmError("LLM_UNREACHABLE", `Ollama tidak dapat dihubungi di ${this.baseUrl}.`, true);
    }
    if (res.status === 404) throw new LlmError("LLM_MODEL_MISSING", `Model ${this.model} belum diunduh. Jalankan: ollama pull ${this.model}`);
    if (!res.ok) throw new LlmError("LLM_UPSTREAM", `Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, true);
    return (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  }

  async structured<S extends z.ZodType>(opts: { system: string; user: string; schema: S }) {
    const jsonSchema = z.toJSONSchema(opts.schema);
    const messages = [
      { role: "system", content: `${opts.system}\n\nJawab hanya dengan JSON yang sesuai schema.` },
      { role: "user", content: opts.user },
    ];
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = await this.chat(messages, jsonSchema);
      inputTokens += body.prompt_eval_count ?? 0;
      outputTokens += body.eval_count ?? 0;
      const content = body.message?.content ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = undefined;
      }
      const result = opts.schema.safeParse(parsed);
      if (result.success) return { data: result.data as z.infer<S>, usage: { inputTokens, outputTokens, model: this.model } };
      const problems = result.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      messages.push({ role: "assistant", content }, { role: "user", content: `JSON tidak valid terhadap schema: ${problems}. Kirim ulang JSON lengkap yang sudah diperbaiki.` });
    }
    throw new LlmError("LLM_SCHEMA_INVALID", "Keluaran model lokal tidak sesuai schema setelah diperbaiki.", true);
  }
}

/**
 * Test-only provider (LLM_PROVIDER=mock). Returns empty, schema-valid results so the
 * pipeline can run end to end without an API key. It never invents decisions or tasks.
 */
class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock";
  readonly maxInputChars = 24_000;
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
  if (config.LLM_PROVIDER === "ollama") return new OllamaProvider();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new LlmError(
      "LLM_NOT_CONFIGURED",
      "Penyedia AI belum dikonfigurasi. Isi ANTHROPIC_API_KEY pada server worker, lalu jalankan ulang pembuatan hasil AI.",
    );
  }
  return new AnthropicProvider();
}
