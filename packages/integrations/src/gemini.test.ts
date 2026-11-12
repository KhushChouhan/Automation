import { describe, expect, it } from 'vitest';
import { GeminiContentGenerator, GeminiGenerationError } from './gemini.js';

const input = {
  videoId: 'GCS-0021',
  title: 'Phase 2 Google Integration Test',
  faceId: 'TEST-FACE-A',
  approvalStatus: 'APPROVED' as const,
  promptVersion: 'real-estate-reels-v1',
  systemPrompt: 'Do not invent facts.',
  model: 'gemini-3.6-flash',
};

describe('Gemini structured content generator', () => {
  it('sends a schema-constrained request and validates normalized content', async () => {
    const requests: Array<{ url: string; body: string | undefined }> = [];
    const request: typeof fetch = (url, options) => {
      requests.push({
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        body: typeof options?.body === 'string' ? options.body : undefined,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        caption: 'Caption',
                        hashtags: ['Jaipur'],
                        cta: 'DM us',
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 12, totalTokenCount: 22 },
          }),
          { status: 200 },
        ),
      );
    };
    const generator = new GeminiContentGenerator('test-key', { fetch: request, maxAttempts: 1 });

    await expect(generator.generate(input)).resolves.toEqual({
      caption: 'Caption',
      hashtags: ['#Jaipur'],
      cta: 'DM us',
      model: 'gemini-3.6-flash',
      usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
    });
    expect(requests[0]?.url).toContain('models/gemini-3.6-flash:generateContent');
    expect(JSON.parse(requests[0]?.body ?? '')).toMatchObject({
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: { required: ['caption', 'hashtags', 'cta'] },
      },
    });
  });

  it('uses only the configured model and never falls back on a 404', async () => {
    const requests: string[] = [];
    const generator = new GeminiContentGenerator('test-key', {
      fetch: (url) => {
        requests.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
        return Promise.resolve(new Response('{}', { status: 404 }));
      },
      maxAttempts: 3,
    });
    await expect(
      generator.generate({ ...input, model: 'models/configured-model' }),
    ).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      retryable: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('/models/configured-model:generateContent');
  });

  it('classifies quota and malformed responses without retrying them', async () => {
    const quota = new GeminiContentGenerator('test-key', {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exhausted' } }),
            {
              status: 429,
            },
          ),
        ),
      maxAttempts: 3,
    });
    await expect(quota.generate(input)).rejects.toMatchObject({ code: 'QUOTA', retryable: false });

    const malformed = new GeminiContentGenerator('test-key', {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: '{bad json' }] } }] }),
            {
              status: 200,
            },
          ),
        ),
      maxAttempts: 1,
    });
    await expect(malformed.generate(input)).rejects.toBeInstanceOf(GeminiGenerationError);
  });
});
