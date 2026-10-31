import { z } from 'zod';
import { approvalStatuses } from './status.js';

export const permanentVideoIdSchema = z
  .string()
  .regex(/^GCS-[0-9]{4,}$/, 'Expected GCS-0001 style ID');
export const titleSchema = z.string().trim().min(1).max(180);
export const faceNameSchema = z.string().trim().min(1).max(120);
export const approvalCommandSchema = z
  .object({
    decision: z.enum(approvalStatuses).refine((value) => value !== 'PENDING'),
    actorId: z.string().trim().min(1).max(120),
    reason: z.string().trim().max(1000).optional(),
  })
  .superRefine((value, context) => {
    if (value.decision !== 'APPROVED' && !value.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Reason required for rejection or requested changes',
      });
    }
  });

export const generatedContentSchema = z
  .object({
    caption: z.string().trim().min(1).max(2200),
    hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u)).max(30),
    cta: z.string().trim().min(1).max(240),
  })
  .strict();

export function validateGeneratedContent(
  value: unknown,
  forbiddenClaims: readonly string[] = [],
): z.infer<typeof generatedContentSchema> {
  const content = generatedContentSchema.parse(value);
  const normalizedText = `${content.caption} ${content.cta}`
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ');
  for (const claim of forbiddenClaims) {
    const normalizedClaim = claim.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    if (normalizedClaim && normalizedText.includes(normalizedClaim)) {
      throw new Error(`Generated content contains forbidden claim: ${claim}`);
    }
  }
  return content;
}

export function formatVideoId(sequence: bigint | number): string {
  const value = BigInt(sequence);
  if (value < 1n) throw new Error('Video ID sequence must be positive');
  return `GCS-${value.toString().padStart(4, '0')}`;
}
