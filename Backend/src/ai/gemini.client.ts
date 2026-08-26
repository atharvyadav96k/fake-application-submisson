import type { AppConfig } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { serviceUnavailable } from '../utils/errors.js';

const log = createLogger('gemini');

/**
 * Minimal Google Gemini (Generative Language API) client.
 *
 * Written directly against the REST endpoint rather than pulling in an SDK: the surface
 * used here is one POST, and keeping it explicit means the exact request body — including
 * what is and is not sent — is readable in one file.
 */

export interface GenerateOptions {
  systemInstruction: string;
  prompt: string;
  /** OpenAPI-subset schema; forces the model to return parseable JSON. */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  usage: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null };
  latency_ms: number;
  finish_reason: string | null;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiClient {
  // Explicit fields rather than constructor parameter properties: Node's type-stripping
  // (`--experimental-strip-types`, used by `npm run dev`) cannot compile those.
  private readonly config: AppConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AppConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get enabled(): boolean {
    return this.config.ai.enabled;
  }

  get model(): string {
    return this.config.ai.model;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    if (!this.enabled) {
      throw serviceUnavailable('AI analysis is disabled: set AI_ENABLED=true and provide AI_API_KEY.');
    }

    const url = `${this.config.ai.baseUrl}/models/${encodeURIComponent(this.config.ai.model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: options.systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.1,
        maxOutputTokens: options.maxOutputTokens ?? 2_048,
        ...(options.responseSchema
          ? { responseMimeType: 'application/json', responseSchema: options.responseSchema }
          : {}),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.ai.timeoutMs);
    const started = Date.now();

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header form, not a query parameter: keeps the key out of proxy and access logs.
          'x-goog-api-key': this.config.ai.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const latency = Date.now() - started;
      const json = (await response.json().catch(() => null)) as GeminiResponse | null;

      if (!response.ok) {
        const message = json?.error?.message ?? `HTTP ${response.status}`;
        log.error('generate failed', { status: response.status, message });
        // 429/5xx are transient; a 4xx from a bad key or quota is not worth retrying.
        const retryable = response.status === 429 || response.status >= 500;
        throw retryable
          ? serviceUnavailable(`AI provider unavailable: ${message}`)
          : serviceUnavailable(`AI request rejected: ${message}`);
      }

      const candidate = json?.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw serviceUnavailable('AI provider returned an empty response.');

      return {
        text,
        model: this.config.ai.model,
        usage: {
          prompt_tokens: json?.usageMetadata?.promptTokenCount ?? null,
          completion_tokens: json?.usageMetadata?.candidatesTokenCount ?? null,
          total_tokens: json?.usageMetadata?.totalTokenCount ?? null,
        },
        latency_ms: latency,
        finish_reason: candidate?.finishReason ?? null,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw serviceUnavailable(`AI request timed out after ${this.config.ai.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
