import { z } from 'zod';

const settingSchemas = {
  'automation.enabled': z.literal(false),
  'face.rotationGapDays': z.literal(2),
  'daily.limit': z.literal(2),
  'business.timezone': z.literal('Asia/Kolkata'),
  'schedule.slots': z.tuple([z.literal('19:00'), z.literal('20:00')]),
} as const;

export type AutomationSettingKey = keyof typeof settingSchemas;

/** Phase 2 accepts the fixed, disabled production policy from the blueprint. */
export function validateAutomationSetting(key: string, value: unknown): unknown {
  const schema = settingSchemas[key as AutomationSettingKey];
  if (!schema) throw new Error(`Unknown automation setting: ${key}`);
  return schema.parse(value);
}
