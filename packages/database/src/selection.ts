import {
  businessDateOf,
  DEFAULT_SLOT_HOURS,
  parseBusinessDate,
  pickEligibleVideos,
  slotInstant,
  type SelectionCandidate,
  type SelectionHistory,
} from '@gcs/core';
import type { PrismaClient } from '@prisma/client';

export interface SelectDailyOptions {
  businessDate: string;
  actorId: string;
  gapDays?: number;
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
  if (!Number.isInteger(gapDays) || gapDays < 1 || gapDays > 365)
    throw new Error('gapDays must be an integer from 1 to 365');
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
          select: { faceId: true, businessDate: true },
        }),
        tx.$queryRaw<SelectionCandidate[]>`
          SELECT v."id", v."videoId", v."faceId", v."readyAt"
          FROM "Video" AS v
          JOIN "Face" AS f ON f."id" = v."faceId"
          WHERE v."workflowStatus" = 'READY'::"WorkflowStatus"
            AND v."approvalStatus" = 'APPROVED'::"ApprovalStatus"
            AND v."readyAt" IS NOT NULL
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

      const unscheduled = [...candidates];
      const history: SelectionHistory[] = [
        ...schedules.map((row) => ({ faceId: row.faceId, businessDate: row.businessDate })),
        ...postingHistory,
      ];
      const createdScheduleIds: string[] = [];

      for (let offset = 0; offset < options.horizonDays && unscheduled.length; offset += 1) {
        const businessDate = parseBusinessDate(startBusinessDate)
          .plus({ days: offset })
          .toISODate()!;
        const occupied = new Set(
          schedules.filter((row) => row.businessDate === businessDate).map((row) => row.slotHour),
        );
        const openHours = DEFAULT_SLOT_HOURS.filter(
          (hour) =>
            !occupied.has(hour) && slotInstant(businessDate, hour).getTime() > now.getTime(),
        );
        if (!openHours.length) continue;

        const selected = pickEligibleVideos(
          unscheduled,
          history,
          businessDate,
          openHours.length,
          gapDays,
        );
        for (let index = 0; index < selected.length; index += 1) {
          const candidate = selected[index]!;
          const slotHour = openHours[index]!;
          const scheduledAt = slotInstant(businessDate, slotHour);
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
            where: { id: candidate.id, workflowStatus: 'READY', approvalStatus: 'APPROVED' },
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
          history.push({ faceId: candidate.faceId, businessDate });
          unscheduled.splice(
            unscheduled.findIndex((row) => row.id === candidate.id),
            1,
          );
        }
      }
      return tx.schedule.findMany({
        where: { id: { in: createdScheduleIds } },
        orderBy: [{ businessDate: 'asc' }, { slotHour: 'asc' }],
      });
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/** All schedule and outbox writes are one PostgreSQL transaction. */
export async function selectDailyReels(db: PrismaClient, options: SelectDailyOptions) {
  const { businessDate, actorId, gapDays = 2 } = options;
  const target = parseBusinessDate(businessDate);
  if (!Number.isInteger(gapDays) || gapDays < 1 || gapDays > 365)
    throw new Error('gapDays must be an integer from 1 to 365');
  if (!actorId.trim()) throw new Error('actorId is required');
  const earliestRelevantDate = target.minus({ days: gapDays - 1 }).toISODate()!;
  const latestRelevantDate = target.plus({ days: gapDays - 1 }).toISODate()!;

  return db.$transaction(
    async (tx) => {
      // Global planning lock also serializes concurrent selections of adjacent dates.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(5271, 1)`;
      const existing = await tx.schedule.findMany({
        where: { businessDate },
        orderBy: { slotHour: 'asc' },
      });
      const occupiedHours = new Set(existing.map((row) => row.slotHour));
      const openHours = DEFAULT_SLOT_HOURS.filter((hour) => !occupiedHours.has(hour));
      if (openHours.length === 0) return existing;

      const scheduleHistory = await tx.schedule.findMany({
        where: {
          businessDate: { gte: earliestRelevantDate, lte: latestRelevantDate },
          status: { in: ['SELECTED', 'SCHEDULED', 'PUBLISHING', 'POSTED'] },
        },
        select: { faceId: true, businessDate: true },
      });
      const postingHistory = await tx.postingHistory.findMany({
        where: { businessDate: { gte: earliestRelevantDate, lte: latestRelevantDate } },
        select: { faceId: true, businessDate: true },
      });
      const history: SelectionHistory[] = [...scheduleHistory, ...postingHistory];

      const candidates = await tx.$queryRaw<SelectionCandidate[]>`
      SELECT v."id", v."videoId", v."faceId", v."readyAt"
      FROM "Video" AS v
      JOIN "Face" AS f ON f."id" = v."faceId"
      WHERE v."workflowStatus" = 'READY'::"WorkflowStatus"
        AND v."approvalStatus" = 'APPROVED'::"ApprovalStatus"
        AND v."readyAt" IS NOT NULL
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
    `;
      const selected = pickEligibleVideos(
        candidates,
        history,
        businessDate,
        openHours.length,
        gapDays,
      );
      for (let index = 0; index < selected.length; index += 1) {
        const candidate = selected[index]!;
        const slotHour = openHours[index]!;
        const scheduledAt = slotInstant(businessDate, slotHour);
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
          where: { id: candidate.id, workflowStatus: 'READY', approvalStatus: 'APPROVED' },
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
            actorId,
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
      }
      return tx.schedule.findMany({ where: { businessDate }, orderBy: { slotHour: 'asc' } });
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}
