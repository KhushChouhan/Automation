import {
  normalizeGeneratedContent,
  type ContentGenerationInput,
  type ContentGenerationResult,
  type ContentGenerator,
} from '@gcs/core';

export type GeminiFailureCode =
  | 'AUTH'
  | 'PERMISSION'
  | 'RATE_LIMIT'
  | 'QUOTA'
  | 'MODEL_UNAVAILABLE'
  | 'SAFETY_BLOCK'
  | 'INVALID_RESPONSE'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'TRANSIENT_SERVER'
  | 'VALIDATION';

export class GeminiGenerationError extends Error {
  constructor(
    readonly code: GeminiFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly details: {
      status?: number;
      providerType?: string;
      providerCode?: string;
      requestId?: string;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = 'GeminiGenerationError';
  }
}

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

const responseSchema = {
  type: 'object',
  properties: {
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    cta: { type: 'string' },
  },
  required: ['caption', 'hashtags', 'cta'],
  additionalProperties: false,
} as const;

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function classifyResponse(response: Response, body: unknown): GeminiGenerationError {
  const error = body as { error?: { status?: unknown; message?: unknown; details?: unknown[] } };
  const providerType = typeof error.error?.status === 'string' ? error.error.status : undefined;
  const message =
    typeof error.error?.message === 'string' ? error.error.message : 'Gemini request failed';
  const providerCode =
    Array.isArray(error.error?.details) &&
    typeof error.error.details[0] === 'object' &&
    error.error.details[0] !== null &&
    typeof (error.error.details[0] as { reason?: unknown }).reason === 'string'
      ? ((error.error.details[0] as { reason: string }).reason ?? undefined)
      : undefined;
  const details: ConstructorParameters<typeof GeminiGenerationError>[3] = {
    status: response.status,
  };
  if (providerType) details.providerType = providerType;
  if (providerCode) details.providerCode = providerCode;
  const requestId = response.headers.get('x-request-id');
  if (requestId) details.requestId = requestId;
  const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
  if (retryAfter !== undefined) details.retryAfterSeconds = retryAfter;
  if (response.status === 401)
    return new GeminiGenerationError('AUTH', 'Gemini authentication failed', false, details);
  if (response.status === 403)
    return new GeminiGenerationError('PERMISSION', 'Gemini permission denied', false, details);
  if (response.status === 404)
    return new GeminiGenerationError(
      'MODEL_UNAVAILABLE',
      'Gemini model is unavailable',
      false,
      details,
    );
  if (response.status === 429) {
    const quota = /quota|billing|credit|spend/i.test(
      `${providerType ?? ''} ${message} ${providerCode ?? ''}`,
    );
    return new GeminiGenerationError(
      quota ? 'QUOTA' : 'RATE_LIMIT',
      quota ? 'Gemini quota is exhausted' : 'Gemini rate limit reached',
      !quota,
      details,
    );
  }
  if (response.status === 408 || response.status === 504)
    return new GeminiGenerationError('TIMEOUT', 'Gemini request timed out', true, details);
  if (response.status >= 500)
    return new GeminiGenerationError(
      'TRANSIENT_SERVER',
      'Gemini service is unavailable',
      true,
      details,
    );
  return new GeminiGenerationError(
    'VALIDATION',
    'Gemini rejected the generation request',
    false,
    details,
  );
}

export class GeminiContentGenerator implements ContentGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly options: {
      timeoutMs?: number;
      maxAttempts?: number;
      fetch?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
      random?: () => number;
    } = {},
  ) {
    if (!apiKey.trim()) throw new Error('GEMINI_API_KEY is required');
  }

  async generate(input: ContentGenerationInput): Promise<ContentGenerationResult> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    let lastError: GeminiGenerationError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await (this.options.fetch ?? fetch)(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: input.systemPrompt }] },
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      text: [
                        `Video ID: ${input.videoId}`,
                        `Approved manual title: ${input.title}`,
                        input.faceId ? `Face ID: ${input.faceId}` : '',
                        `Approval: ${input.approvalStatus}`,
                        'Return only the required structured caption, hashtags, and CTA. Do not alter the title.',
                      ]
                        .filter(Boolean)
                        .join('\n'),
                    },
                  ],
                },
              ],
              generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: responseSchema,
                temperature: 0.4,
              },
            }),
          },
        );
        const body = (await response.json()) as GeminiResponse;
        if (!response.ok) throw classifyResponse(response, body);
        if (body.promptFeedback?.blockReason || body.candidates?.[0]?.finishReason === 'SAFETY')
          throw new GeminiGenerationError(
            'SAFETY_BLOCK',
            'Gemini safety policy blocked generation',
            false,
          );
        const text =
          body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
        if (!text)
          throw new GeminiGenerationError(
            'INVALID_RESPONSE',
            'Gemini returned no structured content',
            false,
          );
        let normalized;
        try {
          normalized = normalizeGeneratedContent(JSON.parse(text));
        } catch {
          throw new GeminiGenerationError(
            'INVALID_RESPONSE',
            'Gemini returned invalid structured content',
            false,
          );
        }
        const usage = {
          ...(body.usageMetadata?.promptTokenCount !== undefined
            ? { inputTokens: body.usageMetadata.promptTokenCount }
            : {}),
          ...(body.usageMetadata?.candidatesTokenCount !== undefined
            ? { outputTokens: body.usageMetadata.candidatesTokenCount }
            : {}),
          ...(body.usageMetadata?.totalTokenCount !== undefined
            ? { totalTokens: body.usageMetadata.totalTokenCount }
            : {}),
        };
        return {
          ...normalized,
          model: input.model,
          ...(Object.keys(usage).length ? { usage } : {}),
        };
      } catch (error) {
        lastError =
          error instanceof GeminiGenerationError
            ? error
            : error instanceof DOMException && error.name === 'TimeoutError'
              ? new GeminiGenerationError('TIMEOUT', 'Gemini request timed out', true)
              : new GeminiGenerationError('NETWORK', 'Gemini network request failed', true);
        if (!lastError.retryable || attempt === maxAttempts) throw lastError;
        const base = Math.max(500, (lastError.details.retryAfterSeconds ?? 0) * 1_000);
        const jitter = 0.75 + (this.options.random ?? Math.random)() * 0.5;
        await (
          this.options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
        )(Math.round(base * 2 ** (attempt - 1) * jitter));
      }
    }
    throw (
      lastError ?? new GeminiGenerationError('TRANSIENT_SERVER', 'Gemini generation failed', true)
    );
  }
}
