import { z } from 'zod';

export const contentGenerationOutputSchema = z.object({
  caption: z.string().trim().min(1).max(2_200),
  hashtags: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
  cta: z.string().trim().min(1).max(300),
});

export type GeneratedContent = z.infer<typeof contentGenerationOutputSchema>;

export interface ContentGenerationInput {
  videoId: string;
  title: string;
  faceId?: string;
  approvalStatus: 'APPROVED';
  promptVersion: string;
  systemPrompt: string;
  model: string;
}

export interface ContentGenerationResult extends GeneratedContent {
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/** Infrastructure implements this port; core never imports an AI SDK. */
export interface ContentGenerator {
  generate(input: ContentGenerationInput): Promise<ContentGenerationResult>;
}

export function normalizeGeneratedContent(value: unknown): GeneratedContent {
  const parsed = contentGenerationOutputSchema.parse(value);
  const seen = new Set<string>();
  const hashtags = parsed.hashtags.flatMap((raw) => {
    const normalized = `#${raw.trim().replace(/^#+/, '').replace(/\s+/g, '')}`;
    if (normalized === '#' || seen.has(normalized.toLowerCase())) return [];
    seen.add(normalized.toLowerCase());
    return [normalized];
  });
  if (!hashtags.length) throw new Error('At least one non-empty hashtag is required');
  return { caption: parsed.caption, hashtags, cta: parsed.cta };
}
