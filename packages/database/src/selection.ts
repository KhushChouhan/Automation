import {
  businessDateOf,
  parseBusinessDate,
  planReadySlots,
  type SelectionCandidate,
} from '@gcs/core';
import type { PrismaClient } from '@prisma/client';

export interface SelectDailyOptions {
  businessDate: string;
  actorId: string;
  gapDays?: number;
  now?: Date;
}

export interface SelectReadyBacklogOptions {
  /** First business day to consider. Defaults to the current Asia/Kolkata day. */
  startBusinessDate?: string;
  /**
   * Number of business days to plan. This is deliberately bounded so a large
   * backlog is continued by subsequent cycles instead of creating an
   * unbounded number of delayed jobs in one transaction.
   */
  horizonDays: number;
  actorId: string;
  gapDays?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

function validatePlanningOptions(options: SelectReadyBacklogOptions) {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('now must be a valid instant');
  if (
    !Number.isInteger(options.horizonDays) ||
    options.horizonDays < 1 ||
    options.horizonDays > 366
  )
    throw new Error('horizonDays must be an integer from 1 to 366');
  const gapDays = options.gapDays ?? 2;
  if (gapDays !== 2)
    throw new Error('gapDays must match the two-calendar-day face rotation policy');
  if (!options.actorId.trim()) throw new Error('actorId is required');
  const startBusinessDate = options.startBusinessDate ?? businessDateOf(now);
  parseBusinessDate(startBusinessDate);
  return { now, gapDays, startBusinessDate };
}

/**
 * Plans every currently eligible READY video into the earliest available
 * future 19:00/20:00 Asia/Kolkata slot within a configurable horizon.
 *
 * PostgreSQL remains the authority: one transaction and an advisory lock
 * serialize planners, while the unique Schedule constraints/outbox keys make
 * repeated or concurrent cycles idempotent.
 */
export async function selectReadyBacklog(db: PrismaClient, options: SelectReadyBacklogOptions) {
  return planSchedules(db, options, false);
}

async function planSchedules(
  db: PrismaClient,
  options: SelectReadyBacklogOptions,
  includeExisting: boolean,
) {
  const { now, gapDays, startBusinessDate } = validatePlanningOptions(options);
  const endBusinessDate = parseBusinessDate(startBusinessDate)
    .plus({ days: options.horizonDays - 1 })
    .toISODate()!;
  const historyStart = parseBusinessDate(startBusinessDate)
    .minus({ days: gapDays - 1 })
    .toISODate()!;
  const historyEnd = parseBusinessDate(endBusinessDate)
    .plus({ days: gapDays - 1 })
    .toISODate()!;

  return db.$transaction(
    async (tx) => {
      // Shared with selectDailyReels: adjacent-date plans must not race.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(5271, 1)`;

      const [schedules, postingHistory, candidates] = await Promise.all([
        tx.schedule.findMany({
          where: { businessDate: { gte: historyStart, lte: historyEnd } },
          orderBy: [{ businessDate: 'asc' }, { slotHour: 'asc' }],
          select: { id: true, videoId: true, faceId: true, businessDate: true, slotHour: true },
        }),
        tx.postingHistory.findMany({
          where: { businessDate: { gte: historyStart, lte: historyEnd } },
          select: { videoId: true, faceId: true, businessDate: true },
        }),
        tx.$queryRaw<SelectionCandidate[]>`
          SELECT v."id", v."videoId", v."faceId", v."readyAt"
          FROM "Video" AS v
          JOIN "Face" AS f ON f."id" = v."faceId"
          WHERE v."workflowStatus" IN ('READY'::"WorkflowStatus", 'CONTENT_READY'::"WorkflowStatus")
            AND v."approvalStatus" = 'APPROVED'::"ApprovalStatus"
            AND v."readyAt" IS NOT NULL
            AND NULLIF(btrim(v."driveFileId"), '') IS NOT NULL
            AND NULLIF(btrim(v."title"), '') IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM "Thumbnail" t WHERE t."videoId" = v."id"
                AND NULLIF(btrim(t."driveFileId"), '') IS NOT NULL
                AND t."driveFileId" <> v."driveFileId"
            )
            AND f."active" = true
            AND NOT EXISTS (SELECT 1 FROM "Schedule" s WHERE s."videoId" = v."id")
            AND NOT EXISTS (SELECT 1 FROM "PostingHistory" p WHERE p."videoId" = v."id")
            AND NOT EXISTS (
              SELECT 1 FROM "PublishAttempt" p
              WHERE p."videoId" = v."id"
                AND p."status" IN ('CLAIMED'::"PublishAttemptStatus", 'CONTAINER_CREATED'::"PublishAttemptStatus", 'PROCESSING'::"PublishAttemptStatus", 'PUBLISH_REQUESTED'::"PublishAttemptStatus", 'RECONCILE_REQUIRED'::"PublishAttemptStatus", 'SUCCEEDED'::"PublishAttemptStatus")
            )
          ORDER BY v."readyAt" ASC, v."videoId" ASC
          FOR UPDATE OF v SKIP LOCKED
        `,
      ]);

      const plan = planReadySlots(
        candidates,
        schedules,
        postingHistory,
        startBusinessDate,
        options.horizonDays,
        now,
        gapDays,
      );
      const createdScheduleIds: string[] = [];
      for (const { candidate, businessDate, slotHour, scheduledAt } of plan) {
        const jobId = `publish:${candidate.videoId}:${scheduledAt.toISOString()}`;
        const schedule = await tx.schedule.create({
          data: {
            videoId: candidate.id,
            faceId: candidate.faceId,
            businessDate,
            slotHour,
            scheduledAt,
            jobId,
          },
        });
        const updated = await tx.video.updateMany({
          where: {
            id: candidate.id,
            workflowStatus: { in: ['READY', 'CONTENT_READY'] },
            approvalStatus: 'APPROVED',
          },
          data: { workflowStatus: 'SELECTED' },
        });
        if (updated.count !== 1)
          throw new Error(`Video ${candidate.videoId} changed during selection`);
        await tx.outboxEvent.create({
          data: {
            eventKey: jobId,
            eventType: 'selection.created',
            payload: {
              scheduleId: schedule.id,
              videoId: candidate.videoId,
              businessDate,
              slotHour,
              scheduledAtUtc: scheduledAt.toISOString(),
              jobId,
            },
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: options.actorId,
            action: 'VIDEO_SELECTED',
            entity: 'Schedule',
            entityId: schedule.id,
            after: {
              videoId: candidate.videoId,
              businessDate,
              slotHour,
              scheduledAtUtc: scheduledAt.toISOString(),
            },
          },
        });
        createdScheduleIds.push(schedule.id);
      }
      return tx.schedule.findMany({
        where: includeExisting
          ? { businessDate: startBusinessDate }
          : { id: { in: createdScheduleIds } },
        orderBy: [{ businessDate: 'asc' }, { slotHour: 'asc' }],
      });
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/** Returns all reservations for the day, including those from previous runs. */
export async function selectDailyReels(db: PrismaClient, options: SelectDailyOptions) {
  return planSchedules(
    db,
    {
      startBusinessDate: options.businessDate,
      actorId: options.actorId,
      horizonDays: 1,
      gapDays: options.gapDays ?? 2,
      ...(options.now ? { now: options.now } : {}),
    },
    true,
  );
}
