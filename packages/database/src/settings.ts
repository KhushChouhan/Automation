import { validateAutomationSetting } from '@gcs/core';
import { Prisma, type PrismaClient } from '@prisma/client';

export async function setAutomationSetting(
  db: PrismaClient,
  input: { key: string; value: unknown; expectedVersion?: number; actorId: string },
) {
  const actorId = input.actorId.trim();
  if (!actorId) throw new Error('actorId is required');
  const value = validateAutomationSetting(input.key, input.value) as Prisma.InputJsonValue;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.key}))`;
    const current = await tx.automationSetting.findUnique({ where: { key: input.key } });
    if (input.expectedVersion !== undefined && input.expectedVersion !== (current?.version ?? 0))
      throw new Error('Automation setting version conflict');
    if (current && JSON.stringify(current.value) === JSON.stringify(value)) return current;
    const after = current
      ? await tx.automationSetting.update({
          where: { key: input.key },
          data: { value, actorId, version: { increment: 1 } },
        })
      : await tx.automationSetting.create({ data: { key: input.key, value, actorId } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'AUTOMATION_SETTING_CHANGED',
        entity: 'AutomationSetting',
        entityId: input.key,
        before: current ? { value: current.value, version: current.version } : Prisma.JsonNull,
        after: { value: after.value, version: after.version },
      },
    });
    return after;
  });
}
