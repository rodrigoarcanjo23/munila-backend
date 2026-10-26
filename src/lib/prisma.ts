import { PrismaClient, Prisma } from '@prisma/client';

// Uma única instância compartilhada por toda a API (antes cada arquivo criava a sua).
export const prisma = new PrismaClient();

/** Cliente usado dentro e fora de transações. */
export type Db = PrismaClient | Prisma.TransactionClient;
