export type FixtureVideo = {
  id: string;
  videoId: string;
  driveFileId: string;
  faceId: string | null;
  title: string | null;
  thumbnailId: string | null;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  workflowStatus: string;
  readyAt: Date | null;
  createdAt: Date;
};

export function videoFixture(overrides: Partial<FixtureVideo> = {}): FixtureVideo {
  const id = overrides.id ?? 'video-1';
  return {
    id,
    videoId: 'GCS-0001',
    driveFileId: 'drive-file-1',
    faceId: 'face-1',
    title: 'A fixture reel',
    thumbnailId: 'thumbnail-1',
    approvalStatus: 'APPROVED',
    workflowStatus: 'READY',
    readyAt: new Date('2026-10-20T12:00:00.000Z'),
    createdAt: new Date('2026-10-19T12:00:00.000Z'),
    ...overrides,
  };
}

export function videosFixture(
  count: number,
  overrides: Partial<FixtureVideo> = {},
): FixtureVideo[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return videoFixture({
      id: `video-${number}`,
      videoId: `GCS-${String(number).padStart(4, '0')}`,
      driveFileId: `drive-file-${number}`,
      faceId: `face-${number}`,
      readyAt: new Date(Date.UTC(2026, 9, 20 + index, 12)),
      createdAt: new Date(Date.UTC(2026, 9, 19 + index, 12)),
      ...overrides,
    });
  });
}

export function dateInIndia(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  // Date.UTC months are zero-based. IST is UTC+05:30.
  return new Date(Date.UTC(year, month - 1, day, hour - 5, minute - 30));
}
