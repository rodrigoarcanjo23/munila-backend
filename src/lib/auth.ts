import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SEGREDO_PADRAO = 'viapro-dev-secret-troque-em-producao';
const JWT_SECRET = process.env.JWT_SECRET || SEGREDO_PADRAO;
if (JWT_SECRET === SEGREDO_PADRAO) {
  console.warn('⚠️  JWT_SECRET não definido. Defina a variável de ambiente JWT_SECRET em produção.');
}

/**
 * Enquanto AUTH_OBRIGATORIA não for "true", o token é lido quando enviado mas não é exigido.
 * Isso permite publicar a API nova sem derrubar versões antigas do app mobile.
 * Depois que web e mobile estiverem atualizados, defina AUTH_OBRIGATORIA=true no Render.
 */
export const AUTH_OBRIGATORIA = process.env.AUTH_OBRIGATORIA === 'true';

export interface UsuarioToken {
  id: string;
  nome: string;
  cargo: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: UsuarioToken;
    }
  }
}

// ---------------- Senhas ----------------
export const ehHash = (senha: string) => /^\$2[aby]\$\d{2}\$/.test(senha);

export async function gerarHash(senha: string) {
  return bcrypt.hash(senha, 10);
}

/** Aceita senhas antigas em texto puro (legado) para permitir a migração transparente no login. */
export async function conferirSenha(digitada: string, armazenada: string) {
  if (ehHash(armazenada)) return bcrypt.compare(digitada, armazenada);
  return digitada === armazenada;
}

// ---------------- Token ----------------
export function gerarToken(u: UsuarioToken) {
  return jwt.sign({ id: u.id, nome: u.nome, cargo: u.cargo, email: u.email }, JWT_SECRET, { expiresIn: '12h' });
}

export function perfilDe(cargo?: string | null) {
  const c = (cargo || '').toLowerCase();
  if (c.includes('admin') || c.includes('gestor')) return 'admin';
  if (c.includes('estoq') || c.includes('operador') || c.includes('separador')) return 'estoque';
  if (c.includes('vend')) return 'vendas';
  return 'outro';
}

const ROTAS_PUBLICAS = ['/login', '/health'];

/** Lê o token Bearer (se houver) e preenche req.usuario. */
export function autenticar(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      req.usuario = jwt.verify(header.slice(7), JWT_SECRET) as UsuarioToken;
    } catch {
      if (AUTH_OBRIGATORIA) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
  }
  if (AUTH_OBRIGATORIA && !req.usuario && !ROTAS_PUBLICAS.includes(req.path)) {
    return res.status(401).json({ error: 'Autenticação necessária.' });
  }
  next();
}

/** Restringe a rota a administradores/gestores quando a autenticação estiver ativa. */
export function somenteAdmin(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_OBRIGATORIA) return next();
  if (perfilDe(req.usuario?.cargo) !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  next();
}

/** Usuário responsável pela operação: o do token tem prioridade sobre o informado no corpo. */
export function usuarioDaRequisicao(req: Request): string | undefined {
  return req.usuario?.id || req.body?.usuarioId || undefined;
}
