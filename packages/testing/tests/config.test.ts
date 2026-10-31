import { describe, expect, it } from 'vitest';
import { settingsSchema } from '../../config/src/index.js';

describe('safe automation defaults', () => {
  it('defaults production automation off', () => {
    expect(settingsSchema.parse({}).automationEnabled).toBe(false);
    expect(settingsSchema.parse({}).timezone).toBe('Asia/Kolkata');
    expect(settingsSchema.parse({}).dailyLimit).toBe(2);
    expect(settingsSchema.parse({}).faceGapDays).toBe(2);
    expect(settingsSchema.parse({}).publishSlots).toEqual(['19:00', '20:00']);
  });
});
