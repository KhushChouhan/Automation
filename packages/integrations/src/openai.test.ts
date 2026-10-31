import { describe, expect, it, vi } from 'vitest';
import {
  ContentGenerationError,
  OpenAIContentGenerator,
  type OpenAIResponsePort,
} from './openai.js';

const input = {
  videoId: 'GCS-0021',
  title: 'Phase 2 Google Integration Test',
  faceId: 'TEST-FACE-A',
  approvalStatus: 'APPROVED' as const,
  promptVersion: 'v1',
  systemPrompt: 'No unsupported claims.',
  model: 'test-model',
};

describe('OpenAI structured content generator', () => {
  it('returns validated structured output and usage', async () => {
    const port: OpenAIResponsePort = {
      create: vi.fn().mockResolvedValue({
        parsed: { caption: 'Caption', hashtags: ['Jaipur', '#Property'], cta: 'Learn more.' },
        model: 'test-model',
        usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
      }),
    };
    await expect(new OpenAIContentGenerator(port).generate(input)).resolves.toEqual({
      caption: 'Caption',
      hashtags: ['#Jaipur', '#Property'],
      cta: 'Learn more.',
      model: 'test-model',
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });
  });

  it.each([
    ['RATE_LIMIT', 2],
    ['TRANSIENT', 2],
    ['TIMEOUT', 2],
  ] as const)('retries bounded transient %s failures', async (code, expectedCalls) => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ContentGenerationError(code, code, true))
      .mockResolvedValue({ parsed: { caption: 'ok', hashtags: ['#ok'], cta: 'go' } });
    const generator = new OpenAIContentGenerator(
      { create },
      { maxAttempts: 3, sleep: () => Promise.resolve(), random: () => 0 },
    );
    await expect(generator.generate(input)).resolves.toMatchObject({ caption: 'ok' });
    expect(create).toHaveBeenCalledTimes(expectedCalls);
  });

  it('does not retry authentication failures', async () => {
    const create = vi.fn().mockRejectedValue(new ContentGenerationError('AUTH', 'auth', false));
    await expect(new OpenAIContentGenerator({ create }).generate(input)).rejects.toMatchObject({
      code: 'AUTH',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('classifies refusal and incomplete structured output', async () => {
    await expect(
      new OpenAIContentGenerator({
        create: () => Promise.resolve({ parsed: null, refusal: true }),
      }).generate(input),
    ).rejects.toMatchObject({ code: 'REFUSAL' });
    await expect(
      new OpenAIContentGenerator({
        create: () => Promise.resolve({ parsed: { caption: '', hashtags: [], cta: '' } }),
      }).generate(input),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});
