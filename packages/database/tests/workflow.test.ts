import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { reconcileSheetRow } from '../src/sheet-sync.js';
import type { PrismaClient } from '@prisma/client';
import { decideApprovalInTransaction } from '../src/approval.js';

const video = {
  id: 'internal',
  videoId: 'GCS-0001',
  driveFileId: 'source',
  faceId: 'face',
  face: { active: true },
  title: 'Manual title',
  thumbnail: { driveFileId: 'cover' },
  workflowStatus: 'WAITING_APPROVAL',
  approvalStatus: 'PENDING',
  inputVersion: 4,
  postingHistory: null,
  schedule: null,
  readyAt: null,
};

function fixture(record: Record<string, unknown> = {}, previous: unknown = null) {
  const row = { ...video, ...record };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([row]),
    video: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(row),
      update: vi
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...row, ...data }),
        ),
    },
    approvalEvent: {
      create: vi.fn().mockResolvedValue({ id: 'event' }),
      findFirst: vi.fn().mockResolvedValue(previous),
    },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    decide: (overrides = {}) =>
      decideApprovalInTransaction(tx as unknown as Prisma.TransactionClient, video.videoId, {
        actorId: 'approver',
        decision: 'APPROVED',
        expectedInputVersion: 4,
        ...overrides,
      }),
  };
}

describe('approval command boundary', () => {
  it('locks the reviewed row and rejects stale review without recording a decision', async () => {
    const { tx, decide } = fixture({ inputVersion: 5 });
    await expect(decide()).rejects.toMatchObject({ code: 'STALE_INPUT' });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.approvalEvent.create).not.toHaveBeenCalled();
    expect(tx.video.update).not.toHaveBeenCalled();
  });
  it.each([null, { driveFileId: 'source' }])(
    'rejects a missing or counterfeit thumbnail',
    async (thumbnail) => {
      const { tx, decide } = fixture({ thumbnail });
      await expect(decide()).rejects.toThrow('WAITING_THUMBNAIL');
      expect(tx.approvalEvent.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    { workflowStatus: 'CONTENT_GENERATING' },
    { schedule: { id: 'schedule' } },
    { postingHistory: { id: 'post' } },
  ])('blocks a decision after a workflow handoff', async (held) => {
    const { decide } = fixture(held);
    await expect(decide()).rejects.toThrow('after selection or posting');
  });
  it('records a validated decision and audit exactly once on an identical replay', async () => {
    const { tx, decide } = fixture();
    const result = await decide();
    expect(result.video).toMatchObject({ approvalStatus: 'APPROVED', workflowStatus: 'READY' });
    expect(tx.approvalEvent.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    const replay = fixture(
      {
        approvalStatus: 'APPROVED',
        workflowStatus: 'READY',
        readyAt: new Date(0),
        inputVersion: 5,
      },
      { id: 'event', actorId: 'approver', decision: 'APPROVED', reason: null },
    );
    await replay.decide();
    expect(replay.tx.video.update).not.toHaveBeenCalled();
    expect(replay.tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('Sheet approval mirror', () => {
  it.each(['APPROVED', 'REJECTED', 'CHANGES_REQUIRED', 'invalid decision'])(
    'audits %s as a protected edit and repairs it without applying a decision',
    async (approvalStatus) => {
      const tx = {
        $queryRaw: vi.fn(),
        video: { findUnique: vi.fn().mockResolvedValue(video), update: vi.fn() },
        sheetRowSync: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
        thumbnail: { findUnique: vi.fn().mockResolvedValue(video.thumbnail) },
        postingHistory: { findUnique: vi.fn().mockResolvedValue(null) },
        syncConflict: { upsert: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
        approvalEvent: { create: vi.fn() },
        auditLog: { create: vi.fn() },
      };
      const db = {
        $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
      } as unknown as PrismaClient;
      const result = await reconcileSheetRow(db, {
        spreadsheetId: 'test',
        actorId: 'sheet-sync',
        row: { videoId: video.videoId, approvalStatus },
      });
      expect(result.applied).toEqual([]);
      expect(result.repairFields).toEqual(['approvalStatus']);
      expect(tx.syncConflict.upsert).toHaveBeenCalledOnce();
      expect(tx.auditLog.create).toHaveBeenCalledOnce();
      expect(tx.video.update).not.toHaveBeenCalled();
      expect(tx.approvalEvent.create).not.toHaveBeenCalled();
    },
  );
});
