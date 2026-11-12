import { z } from 'zod';
import { permanentVideoIdSchema } from './validation.js';

/** Only these columns can provide human input. Every other known column is a DB mirror. */
export const sheetHumanFields = ['title', 'faceId'] as const;
export const sheetMirrorFields = [
  'approvalStatus',
  'workflowStatus',
  'inputVersion',
  'driveFileId',
  'thumbnailDriveFileId',
  'instagramMediaId',
  'permalink',
  'postedAt',
] as const;

export const sheetRowSchema = z
  .object({
    videoId: permanentVideoIdSchema,
    title: z.string().max(180).optional(),
    faceId: z.string().max(120).optional(),
    approvalStatus: z.string().max(120).optional(),
    approvalReason: z.string().max(1000).optional(),
    rowVersion: z.string().max(200).optional(),
    // System-owned Sheet cells may contain arbitrary human edits. Accept the text so
    // reconciliation can record and repair it instead of rejecting the whole row.
    workflowStatus: z.string().max(120).optional(),
    inputVersion: z.number().int().positive().optional(),
    driveFileId: z.string().optional(),
    thumbnailDriveFileId: z.string().optional(),
    instagramMediaId: z.string().optional(),
    permalink: z.string().optional(),
    postedAt: z.string().optional(),
  })
  .strict();

export type SheetRow = z.infer<typeof sheetRowSchema>;
export type SheetHumanField = (typeof sheetHumanFields)[number];
export type SheetMirrorField = (typeof sheetMirrorFields)[number];

/** A blank cell means no command; it does not delete an authoritative DB value. */
export function sheetCommandValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
