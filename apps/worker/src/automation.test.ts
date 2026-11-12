import { describe, expect, it, vi } from 'vitest';
import { schedulingAutomationEnabled } from './automation.js';

describe('scheduling automation authority', () => {
  it('uses PostgreSQL when a setting exists and otherwise keeps the safe environment default', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce(null);
    const db = { automationSetting: { findUnique } } as never;
    await expect(schedulingAutomationEnabled(db, false)).resolves.toBe(true);
    await expect(schedulingAutomationEnabled(db, true)).resolves.toBe(false);
    await expect(schedulingAutomationEnabled(db, false)).resolves.toBe(false);
  });
});
