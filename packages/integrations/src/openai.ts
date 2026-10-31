import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import {
  normalizeGeneratedContent,
  type ContentGenerationInput,
  type ContentGenerationResult,
  type ContentGenerator,
} from '@gcs/core';

const outputSchema = z.object({
  caption: z.string().min(1).max(2_200),
  hashtags: z.array(z.string().min(1).max(100)).min(1).max(30),
  cta: z.string().min(1).max(300),
});

export type ContentGenerationFailure =
  | 'AUTH'
  | 'PERMISSION_OR_MODEL'
  | 'RATE_LIMIT'
  | 'TRANSIENT'
  | 'TIMEOUT'
  | 'INVALID_OUTPUT'
  | 'REFUSAL'
  | 'VALIDATION';

export class ContentGenerationError extends Error {
  constructor(
    readonly code: ContentGenerationFailure,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ContentGenerationError';
  }
}

export interface OpenAIResponsePort {
  create(input: ContentGenerationInput): Promise<{
    parsed: unknown;
    status?: string;
    refusal?: boolean;
    model?: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  }>;
}

export class OpenAIResponsesPort implements OpenAIResponsePort {
  private readonly client: OpenAI;
  constructor(apiKey: string, timeoutMs = 30_000) {
    if (!apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });
  }

  async create(input: ContentGenerationInput) {
    const response = await this.client.responses.parse({
      model: input.model,
      instructions: input.systemPrompt,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Video ID: ${input.videoId}`,
                `Approved manual title: ${input.title}`,
                input.faceId ? `Face ID: ${input.faceId}` : '',
                `Approval: ${input.approvalStatus}`,
                'Return only the requested structured caption, hashtags and CTA. Do not alter the title.',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        },
      ],
      text: { format: zodTextFormat(outputSchema, 'instagram_reel_content') },
    });
    const refusal = response.output.some(
      (item) =>
        item.type === 'message' && item.content.some((content) => content.type === 'refusal'),
    );
    return {
      parsed: response.output_parsed,
      refusal,
      model: response.model,
      ...(response.status ? { status: response.status } : {}),
      ...(response.usage
        ? {
            usage: {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.total_tokens,
            },
          }
        : {}),
    };
  }
}

function classify(error: unknown): ContentGenerationError {
  if (error instanceof ContentGenerationError) return error;
  if (error instanceof OpenAI.APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    if (status === 401)
      return new ContentGenerationError('AUTH', 'OpenAI authentication failed', false, status);
    if (status === 403 || status === 404)
      return new ContentGenerationError(
        'PERMISSION_OR_MODEL',
        'OpenAI model or project access was denied',
        false,
        status,
      );
    if (status === 429)
      return new ContentGenerationError('RATE_LIMIT', 'OpenAI rate limit exceeded', true, status);
    if (status !== undefined && status >= 500)
      return new ContentGenerationError(
        'TRANSIENT',
        'OpenAI service is temporarily unavailable',
        true,
        status,
      );
    return new ContentGenerationError(
      'VALIDATION',
      'OpenAI rejected the generation request',
      false,
      status,
    );
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new ContentGenerationError('TIMEOUT', 'OpenAI request timed out', true);
  if (error instanceof OpenAI.APIConnectionError)
    return new ContentGenerationError('TRANSIENT', 'OpenAI network request failed', true);
  if (error instanceof z.ZodError)
    return new ContentGenerationError(
      'INVALID_OUTPUT',
      'OpenAI returned invalid structured content',
      false,
    );
  return new ContentGenerationError('TRANSIENT', 'OpenAI generation failed', true);
}

export class OpenAIContentGenerator implements ContentGenerator {
  constructor(
    private readonly port: OpenAIResponsePort,
    private readonly options: {
      maxAttempts?: number;
      baseDelayMs?: number;
      sleep?: (ms: number) => Promise<void>;
      random?: () => number;
    } = {},
  ) {}

  async generate(input: ContentGenerationInput): Promise<ContentGenerationResult> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    let lastError: ContentGenerationError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.port.create(input);
        if (response.refusal)
          throw new ContentGenerationError('REFUSAL', 'OpenAI refused the content request', false);
        if (!response.parsed)
          throw new ContentGenerationError(
            'INVALID_OUTPUT',
            'OpenAI returned no structured content',
            false,
          );
        let normalized;
        try {
          normalized = normalizeGeneratedContent(response.parsed);
        } catch {
          throw new ContentGenerationError(
            'INVALID_OUTPUT',
            'OpenAI returned invalid structured content',
            false,
          );
        }
        return {
          ...normalized,
          model: response.model ?? input.model,
          ...(response.usage ? { usage: response.usage } : {}),
        };
      } catch (error) {
        lastError = classify(error);
        if (!lastError.retryable || attempt === maxAttempts) throw lastError;
        const base = this.options.baseDelayMs ?? 500;
        const jitter = 0.75 + (this.options.random ?? Math.random)() * 0.5;
        await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          Math.round(base * 2 ** (attempt - 1) * jitter),
        );
      }
    }
    throw lastError ?? new ContentGenerationError('TRANSIENT', 'OpenAI generation failed', true);
  }
}
