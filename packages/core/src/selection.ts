import {
  DEFAULT_SLOT_HOURS,
  isFaceEligible,
  parseBusinessDate,
  slotInstant,
  type SlotHour,
} from './time.js';

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

interface CommittedAppearance extends SelectionHistory {
  videoId: string;
}

/** Compute reservations for one bounded horizon from authoritative DB snapshots. */
export function planReadySlots(
  candidates: readonly SelectionCandidate[],
  schedules: readonly (CommittedAppearance & { slotHour: number })[],
  posts: readonly CommittedAppearance[],
  startBusinessDate: string,
  horizonDays: number,
  now: Date,
  gapDays = 2,
) {
  const remaining = [...candidates];
  const committed = [...schedules, ...posts];
  const history: SelectionHistory[] = [...committed];
  const result: Array<{
    candidate: SelectionCandidate;
    businessDate: string;
    slotHour: SlotHour;
    scheduledAt: Date;
  }> = [];
  const start = parseBusinessDate(startBusinessDate);
  for (let offset = 0; offset < horizonDays && remaining.length; offset++) {
    const businessDate = start.plus({ days: offset }).toISODate()!;
    const dailyVideos = new Set(
      committed.filter((row) => row.businessDate === businessDate).map((row) => row.videoId),
    );
    const reserved = schedules.filter((row) => row.businessDate === businessDate);
    const hours = DEFAULT_SLOT_HOURS.filter(
      (hour) =>
        !reserved.some((row) => row.slotHour === hour) && slotInstant(businessDate, hour) > now,
    );
    const capacity = Math.min(
      hours.length,
      Math.max(0, DEFAULT_SLOT_HOURS.length - dailyVideos.size),
    );
    if (!capacity) continue;
    const chosen = pickEligibleVideos(remaining, history, businessDate, capacity, gapDays);
    for (const [index, candidate] of chosen.entries()) {
      const slotHour = hours[index]!;
      result.push({
        candidate,
        businessDate,
        slotHour,
        scheduledAt: slotInstant(businessDate, slotHour),
      });
      history.push({ faceId: candidate.faceId, businessDate });
      remaining.splice(
        remaining.findIndex((row) => row.id === candidate.id),
        1,
      );
    }
  }
  return result;
}
