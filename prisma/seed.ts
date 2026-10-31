import { PrismaClient } from '@prisma/client';
import { businessDateOf } from '../packages/core/src/time.js';
import { selectDailyReels } from '../packages/database/src/selection.js';
import { allocateVideoId } from '../packages/database/src/videos.js';

const db = new PrismaClient();

const fixtures = [
  {
    source: 'fixture-drive-video-001',
    face: 'Aarav',
    title: 'Jaipur site visit',
    thumbnail: true,
    approved: true,
  },
  {
    source: 'fixture-drive-video-002',
    face: 'Aarav',
    title: 'Site progress update',
    thumbnail: true,
    approved: true,
  },
  {
    source: 'fixture-drive-video-003',
    face: 'Meera',
    title: 'Location walkthrough',
    thumbnail: true,
    approved: true,
  },
  {
    source: 'fixture-drive-video-004',
    face: 'Kabir',
    title: null,
    thumbnail: false,
    approved: false,
  },
  {
    source: 'fixture-drive-video-005',
    face: 'Kabir',
    title: 'Buyer questions',
    thumbnail: false,
    approved: false,
  },
] as const;

async function main() {
  await db.automationSetting.createMany({
    data: [
      { key: 'automation.enabled', value: false, actorId: 'system-seed' },
      { key: 'face.rotationGapDays', value: 2, actorId: 'system-seed' },
    ],
    skipDuplicates: true,
  });
  const faces = new Map<string, string>();
  for (const name of ['Aarav', 'Meera', 'Kabir']) {
    const face = await db.face.upsert({ where: { name }, update: {}, create: { name } });
    faces.set(name, face.id);
  }
  for (const fixture of fixtures) {
    if (await db.video.findUnique({ where: { driveFileId: fixture.source } })) continue;
    await db.$transaction(async (tx) => {
      const videoId = await allocateVideoId(tx);
      const workflowStatus = fixture.approved
        ? 'READY'
        : fixture.title
          ? 'WAITING_THUMBNAIL'
          : 'WAITING_TITLE';
      const video = await tx.video.create({
        data: {
          videoId,
          driveFileId: fixture.source,
          sourceName: `${fixture.source}.mp4`,
          sourceMimeType: 'video/mp4',
          faceId: faces.get(fixture.face)!,
          title: fixture.title,
          workflowStatus,
          approvalStatus: fixture.approved ? 'APPROVED' : 'PENDING',
          readyAt: fixture.approved ? new Date() : null,
        },
      });
      if (fixture.thumbnail) {
        await tx.thumbnail.create({
          data: { videoId: video.id, driveFileId: `${fixture.source}-cover` },
        });
      }
      if (fixture.approved) {
        await tx.approvalEvent.create({
          data: { videoId: video.id, decision: 'APPROVED', actorId: 'fixture-approver' },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: 'system-seed',
          action: 'FIXTURE_VIDEO_CREATED',
          entity: 'Video',
          entityId: video.id,
          after: { videoId, workflowStatus },
        },
      });
    });
  }
  await selectDailyReels(db, {
    businessDate: businessDateOf(new Date()),
    actorId: 'system-seed',
    gapDays: 2,
  });
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => db.$disconnect());
