import { isFaceEligible } from './time.js';

export interface SelectionCandidate {
  id: string;
  videoId: string;
  faceId: string;
  readyAt: Date;
}

export interface SelectionHistory {
  faceId: string;
  businessDate: string;
}

/** Pure policy for deterministic candidate ordering and face rotation. */
export function pickEligibleVideos(
  candidates: readonly SelectionCandidate[],
  history: readonly SelectionHistory[],
  targetDate: string,
  capacity: number,
  gapDays = 2,
): SelectionCandidate[] {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 2)
    throw new Error('capacity must be between 0 and 2');
  const usedFaces = new Set<string>();
  const selected: SelectionCandidate[] = [];
  const sorted = [...candidates].sort(
    (a, b) => a.readyAt.getTime() - b.readyAt.getTime() || a.videoId.localeCompare(b.videoId),
  );
  for (const candidate of sorted) {
    if (selected.length === capacity) break;
    if (usedFaces.has(candidate.faceId)) continue;
    if (
      history.some(
        (entry) =>
          entry.faceId === candidate.faceId &&
          !isFaceEligible(entry.businessDate, targetDate, gapDays),
      )
    )
      continue;
    usedFaces.add(candidate.faceId);
    selected.push(candidate);
  }
  return selected;
}
