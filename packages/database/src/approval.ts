import { acceptsWorkflowInput, approvalCommandSchema, deriveVideoReadiness } from '@gcs/core';
import type { Prisma, PrismaClient } from '@prisma/client';

export interface ApprovalCommand {
  decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUIRED';
  actorId: string;
  reason?: string | undefined;
  expectedInputVersion?: number | undefined;
}

/** A human decision and its audit trail commit together. */
export async function decideApproval(db: PrismaClient, videoId: string, command: ApprovalCommand) {
  const input = approvalCommandSchema.parse(command);
  return db.$transaction((tx) => decideApprovalInTransaction(tx, videoId, input));
}

export async function decideApprovalInTransaction(
  tx: Prisma.TransactionClient,
  videoId: string,
  command: ApprovalCommand,
) {
  const input = approvalCommandSchema.parse(command);
  await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "videoId" = ${videoId} FOR UPDATE`;
  const video = await tx.video.findUniqueOrThrow({
    where: { videoId },
    include: { face: true, thumbnail: true, schedule: true, postingHistory: true },
  });
  if (video.schedule || video.postingHistory || !acceptsWorkflowInput(video.workflowStatus)) {
    throw new Error('Approval cannot change after selection or posting');
  }
  if (input.decision === 'APPROVED') {
    const status = deriveVideoReadiness({ ...video, approvalStatus: 'APPROVED' });
    if (status !== 'READY') throw new Error(`Cannot approve incomplete video: ${status}`);
  }
  if (
    video.approvalStatus === input.decision &&
    (input.expectedInputVersion === undefined ||
      input.expectedInputVersion === video.inputVersion ||
      input.expectedInputVersion === video.inputVersion - 1)
  ) {
    const previous = await tx.approvalEvent.findFirst({
      where: { videoId: video.id },
      orderBy: { createdAt: 'desc' },
    });
    if (
      previous?.decision === input.decision &&
      previous.actorId === input.actorId &&
      previous.reason === (input.reason ?? null)
    )
      return { video, event: previous };
  }
  if (input.expectedInputVersion !== undefined && input.expectedInputVersion !== video.inputVersion)
    throw Object.assign(new Error('STALE_INPUT'), { code: 'STALE_INPUT' });
  const nextStatus = input.decision === 'APPROVED' ? 'READY' : 'WAITING_APPROVAL';
  const after = await tx.video.update({
    where: { id: video.id },
    data: {
      approvalStatus: input.decision,
      workflowStatus: nextStatus,
      readyAt: input.decision === 'APPROVED' ? (video.readyAt ?? new Date()) : null,
      inputVersion: { increment: 1 },
    },
  });
  const event = await tx.approvalEvent.create({
    data: {
      videoId: video.id,
      decision: input.decision,
      actorId: input.actorId,
      reason: input.reason ?? null,
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      action: `APPROVAL_${input.decision}`,
      entity: 'Video',
      entityId: video.id,
      before: { approvalStatus: video.approvalStatus, workflowStatus: video.workflowStatus },
      after: {
        approvalStatus: after.approvalStatus,
        workflowStatus: after.workflowStatus,
        approvalEventId: event.id,
      },
    },
  });
  return { video: after, event };
}
