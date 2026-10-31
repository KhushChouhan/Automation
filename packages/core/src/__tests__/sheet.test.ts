import { describe, expect, it } from 'vitest';
import {
  sheetCommandValue,
  sheetHumanFields,
  sheetMirrorFields,
  sheetRowSchema,
  validateAutomationSetting,
} from '../index.js';

describe('Sheet/domain ownership', () => {
  it('keeps a small explicit human input allowlist', () => {
    expect(sheetHumanFields).toEqual(['title', 'faceId', 'approvalStatus']);
    expect(sheetMirrorFields).toContain('instagramMediaId');
    expect(sheetMirrorFields).toContain('workflowStatus');
    expect(sheetCommandValue('   ')).toBeUndefined();
    expect(sheetRowSchema.safeParse({ videoId: 'GCS-0001', title: '' }).success).toBe(true);
    expect(sheetRowSchema.safeParse({ videoId: 'GCS-0001', arbitrary: 'value' }).success).toBe(
      false,
    );
  });

  it('rejects unsafe runtime setting changes in Phase 2', () => {
    expect(validateAutomationSetting('business.timezone', 'Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(() => validateAutomationSetting('business.timezone', 'Mars/Olympus')).toThrow();
    expect(() => validateAutomationSetting('automation.enabled', true)).toThrow();
    expect(() => validateAutomationSetting('daily.limit', 3)).toThrow();
    expect(() => validateAutomationSetting('schedule.slots', ['18:00', '20:00'])).toThrow();
  });
});
