import { approvalCommandSchema, deriveWorkflowStatus } from '@gcs/core';
import type { Prisma, PrismaClient } from '@prisma/client';

export interface ApprovalCommand {
  decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUIRED';
  actorId: string;
  reason?: string | undefined;
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
  if (
    video.schedule ||
    video.postingHistory ||
    (!video.workflowStatus.startsWith('WAITING_') && video.workflowStatus !== 'READY')
  ) {
    throw new Error('Approval cannot change after selection or posting');
  }
  if (input.decision === 'APPROVED') {
    const status = deriveWorkflowStatus({
      hasVideo: Boolean(video.driveFileId),
      faceId: video.face?.active ? video.faceId : null,
      title: video.title,
      hasThumbnail: Boolean(video.thumbnail),
      approvalStatus: 'APPROVED',
    });
    if (status !== 'READY') throw new Error(`Cannot approve incomplete video: ${status}`);
  }
  const nextStatus = input.decision === 'APPROVED' ? 'READY' : 'WAITING_APPROVAL';
  const after = await tx.video.update({
    where: { id: video.id },
    data: {
      approvalStatus: input.decision,
      workflowStatus: nextStatus,
      readyAt: input.decision === 'APPROVED' ? new Date() : null,
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
