import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';

/** Erro de regra de negócio com status HTTP. Lançado nas rotas e tratado no handler global. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg: string) => new HttpError(404, msg);

/** Handler global de erros (Express 5 já encaminha erros de funções async para cá). */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'Registro duplicado: já existe um cadastro com este valor único.' });
    if (err.code === 'P2003') return res.status(400).json({ error: 'Operação bloqueada: existem registros vinculados a este item.' });
    if (err.code === 'P2025') return res.status(404).json({ error: 'Registro não encontrado.' });
  }

  // Erros lançados com `throw new Error('...')` dentro de transações viram 400 (regra de negócio).
  if (err instanceof Error && !(err as any).status) {
    console.error('[API]', err.message);
    return res.status(400).json({ error: err.message || 'Erro ao processar a requisição.' });
  }

  console.error('[API] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

/** Converte valores numéricos vindos do front ("12,50", "10", 10) com segurança. */
export function num(valor: unknown, padrao = 0): number {
  if (valor === null || valor === undefined || valor === '') return padrao;
  const n = Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) ? n : padrao;
}

export function intOuNull(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = parseInt(String(valor), 10);
  return Number.isFinite(n) ? n : null;
}

export function dataOuNull(valor: unknown): Date | null {
  if (!valor) return null;
  const d = new Date(String(valor));
  return isNaN(d.getTime()) ? null : d;
}
