import { PrismaClient } from '@prisma/client';

/** Processes own their client lifecycle; never instantiate a client in core. */
export function createDatabaseClient(): PrismaClient {
  return new PrismaClient();
}

export { PrismaClient, Prisma } from '@prisma/client';
