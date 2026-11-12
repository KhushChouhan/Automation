import type { PrismaClient } from '@gcs/database';

/** PostgreSQL overrides the default-off environment flag for scheduling only. */
export async function schedulingAutomationEnabled(
  db: Pick<PrismaClient, 'automationSetting'>,
  defaultEnabled: boolean,
): Promise<boolean> {
  const setting = await db.automationSetting.findUnique({
    where: { key: 'automation.enabled' },
    select: { value: true },
  });
  return setting ? setting.value === true : defaultEnabled;
}
