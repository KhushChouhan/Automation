import { describe, expect, it } from 'vitest';
import {
  approvalCommandSchema,
  assertTransition,
  businessDateOf,
  calendarDayDistance,
  canTransition,
  deriveWorkflowStatus,
  formatVideoId,
  isFaceEligible,
  pickEligibleVideos,
  slotInstant,
  titleSchema,
} from '../index.js';

function videoFixture(overrides: {
  id?: string;
  videoId?: string;
  faceId?: string;
  readyAt?: Date;
}) {
  const id = overrides.id ?? 'video-1';
  return {
    id,
    videoId: overrides.videoId ?? 'GCS-0001',
    faceId: overrides.faceId ?? 'face-1',
    readyAt: overrides.readyAt ?? new Date('2026-10-20T12:00:00.000Z'),
  };
}

describe('permanent Video ID', () => {
  it.each([
    [1, 'GCS-0001'],
    [12, 'GCS-0012'],
    [12345, 'GCS-12345'],
  ] as const)('formats sequence %s as %s', (sequence, expected) =>
    expect(formatVideoId(sequence)).toBe(expected),
  );

  it('rejects a nonpositive sequence', () => {
    expect(() => formatVideoId(0)).toThrow(/positive/);
    expect(() => formatVideoId(-2)).toThrow(/positive/);
  });
});

describe('workflow validation and approval', () => {
  const complete = {
    hasVideo: true,
    faceId: 'face-1',
    title: '  A useful title  ',
    hasThumbnail: true,
    approvalStatus: 'APPROVED' as const,
  };

  it.each([
    [{ ...complete, hasVideo: false }, 'WAITING_VIDEO'],
    [{ ...complete, faceId: null }, 'WAITING_FACE'],
    [{ ...complete, title: '  ' }, 'WAITING_TITLE'],
    [{ ...complete, hasThumbnail: false }, 'WAITING_THUMBNAIL'],
    [{ ...complete, approvalStatus: 'PENDING' as const }, 'WAITING_APPROVAL'],
    [{ ...complete, approvalStatus: 'REJECTED' as const }, 'WAITING_APPROVAL'],
  ] as const)('reports the first missing prerequisite as %s', (input, expected) => {
    expect(deriveWorkflowStatus(input)).toBe(expected);
  });

  it('becomes READY only after every required field and approval exists', () => {
    expect(deriveWorkflowStatus(complete)).toBe('READY');
    expect(titleSchema.safeParse('  ').success).toBe(false);
    expect(titleSchema.safeParse('valid title').success).toBe(true);
  });

  it('requires a human actor and requires a reason for nonapproval decisions', () => {
    expect(
      approvalCommandSchema.safeParse({ decision: 'APPROVED', actorId: 'approver-1' }).success,
    ).toBe(true);
    expect(approvalCommandSchema.safeParse({ decision: 'APPROVED' }).success).toBe(false);
    expect(
      approvalCommandSchema.safeParse({ decision: 'PENDING', actorId: 'approver-1' }).success,
    ).toBe(false);
    expect(
      approvalCommandSchema.safeParse({ decision: 'REJECTED', actorId: 'approver-1' }).success,
    ).toBe(false);
    expect(
      approvalCommandSchema.safeParse({
        decision: 'CHANGES_REQUIRED',
        actorId: 'approver-1',
        reason: 'Update title',
      }).success,
    ).toBe(true);
  });

  it('rejects invalid transitions and keeps POSTED terminal', () => {
    expect(canTransition('READY', 'PUBLISHING')).toBe(false);
    expect(() => assertTransition('READY', 'PUBLISHING')).toThrow(/Invalid workflow transition/);
    expect(canTransition('POSTED', 'READY')).toBe(false);
    expect(canTransition('POSTED', 'POSTED')).toBe(true);
  });
});

describe('face rotation and selection policy', () => {
  it.each([1, 4, 10, 50])(
    'selects at most two different faces from a READY backlog of %i videos',
    (backlogSize) => {
      const candidates = Array.from({ length: backlogSize }, (_, index) =>
        videoFixture({
          id: `backlog-${index}`,
          videoId: `GCS-${String(index + 1).padStart(4, '0')}`,
          faceId: `face-${index % 10}`,
          readyAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        }),
      );

      const selected = pickEligibleVideos(candidates, [], '2026-01-15', 2);

      expect(selected).toHaveLength(Math.min(backlogSize, 2));
      expect(new Set(selected.map((video) => video.faceId)).size).toBe(selected.length);
      expect(selected.map((video) => video.id)).toEqual(
        backlogSize === 1 ? ['backlog-0'] : ['backlog-0', 'backlog-1'],
      );
    },
  );

  it('blocks the posting date and one following local calendar date', () => {
    expect(isFaceEligible('2026-10-27', '2026-10-27', 2)).toBe(false);
    expect(isFaceEligible('2026-10-27', '2026-10-28', 2)).toBe(false);
    expect(isFaceEligible('2026-10-27', '2026-10-29', 2)).toBe(true);
    expect(calendarDayDistance('2026-10-27', '2026-10-29')).toBe(2);
  });

  it('selects no more than two distinct faces and respects capacity', () => {
    const candidates = [
      videoFixture({ id: 'v1', videoId: 'GCS-0001', faceId: 'a' }),
      videoFixture({
        id: 'v2',
        videoId: 'GCS-0002',
        faceId: 'a',
        readyAt: new Date('2026-10-21T12:00:00Z'),
      }),
      videoFixture({
        id: 'v3',
        videoId: 'GCS-0003',
        faceId: 'b',
        readyAt: new Date('2026-10-22T12:00:00Z'),
      }),
      videoFixture({
        id: 'v4',
        videoId: 'GCS-0004',
        faceId: 'c',
        readyAt: new Date('2026-10-23T12:00:00Z'),
      }),
    ];
    expect(pickEligibleVideos(candidates, [], '2026-10-27', 2).map((v) => v.id)).toEqual([
      'v1',
      'v3',
    ]);
    expect(pickEligibleVideos(candidates, [], '2026-10-27', 0)).toEqual([]);
  });

  it('returns only one item when only one distinct face is eligible', () => {
    const candidates = [
      videoFixture({ id: 'blocked', faceId: 'blocked-face' }),
      videoFixture({
        id: 'allowed',
        videoId: 'GCS-0002',
        faceId: 'allowed-face',
        readyAt: new Date('2026-10-21T12:00:00Z'),
      }),
    ];
    const history = [{ faceId: 'blocked-face', businessDate: '2026-10-26' }];
    expect(pickEligibleVideos(candidates, history, '2026-10-27', 2).map((v) => v.id)).toEqual([
      'allowed',
    ]);
  });

  it('chooses the oldest READY candidate first with permanent ID tie breaking', () => {
    const candidates = [
      videoFixture({
        id: 'later',
        videoId: 'GCS-0001',
        faceId: 'b',
        readyAt: new Date('2026-10-22T12:00:00Z'),
      }),
      videoFixture({
        id: 'tie-b',
        videoId: 'GCS-0002',
        faceId: 'c',
        readyAt: new Date('2026-10-21T12:00:00Z'),
      }),
      videoFixture({
        id: 'tie-a',
        videoId: 'GCS-0001',
        faceId: 'a',
        readyAt: new Date('2026-10-21T12:00:00Z'),
      }),
    ];
    expect(pickEligibleVideos(candidates, [], '2026-10-27', 2).map((v) => v.id)).toEqual([
      'tie-a',
      'tie-b',
    ]);
  });

  it('rejects capacity above the daily maximum', () => {
    expect(() => pickEligibleVideos([], [], '2026-10-27', 3)).toThrow(/capacity/);
  });
});

describe('business timezone and safe defaults', () => {
  it('maps UTC instants to the correct Asia/Kolkata calendar day', () => {
    expect(businessDateOf(new Date('2026-10-26T18:29:59.999Z'))).toBe('2026-10-26');
    expect(businessDateOf(new Date('2026-10-26T18:30:00.000Z'))).toBe('2026-10-27');
  });

  it('maps the 19:00 and 20:00 slots to the correct UTC instants', () => {
    expect(slotInstant('2026-10-27', 19).toISOString()).toBe('2026-10-27T13:30:00.000Z');
    expect(slotInstant('2026-10-27', 20).toISOString()).toBe('2026-10-27T14:30:00.000Z');
  });
});
