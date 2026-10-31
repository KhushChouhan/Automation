import { DateTime } from 'luxon';

export const BUSINESS_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_SLOT_HOURS = [19, 20] as const;
export type SlotHour = (typeof DEFAULT_SLOT_HOURS)[number];

export function parseBusinessDate(date: string): DateTime {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid business date: ${date}`);
  const parsed = DateTime.fromISO(date, { zone: BUSINESS_TIMEZONE });
  if (!parsed.isValid || parsed.toISODate() !== date)
    throw new Error(`Invalid business date: ${date}`);
  return parsed;
}

export function businessDateOf(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new Error('Invalid instant');
  return DateTime.fromJSDate(instant, { zone: BUSINESS_TIMEZONE }).toISODate()!;
}

export function slotInstant(date: string, hour: SlotHour): Date {
  if (!DEFAULT_SLOT_HOURS.includes(hour)) throw new Error(`Invalid slot hour: ${hour}`);
  return parseBusinessDate(date)
    .set({ hour, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

export function calendarDayDistance(earlierDate: string, laterDate: string): number {
  return Math.round(parseBusinessDate(laterDate).diff(parseBusinessDate(earlierDate), 'days').days);
}

/** gapDays is the minimum local calendar-day distance between appearances. */
export function isFaceEligible(
  lastDate: string | null,
  targetDate: string,
  gapDays: number,
): boolean {
  if (!Number.isInteger(gapDays) || gapDays < 1)
    throw new Error('gapDays must be a positive integer');
  if (!lastDate) return true;
  return calendarDayDistance(lastDate, targetDate) >= gapDays;
}
