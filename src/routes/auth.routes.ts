import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { conferirSenha, ehHash, gerarHash, gerarToken, somenteAdmin } from '../lib/auth';
import { badRequest, HttpError } from '../lib/http';

const router = Router();

// Campos seguros de usuário (nunca devolver a senha).
const SELECT_USUARIO = { id: true, nome: true, cargo: true, email: true, pushToken: true } as const;

router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const senha = String(req.body?.senha || '');
  if (!email || !senha) throw badRequest('Informe e-mail e senha.');

  const usuario =
    (await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } })) ??
    (await prisma.usuario.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } }));

  if (!usuario || !(await conferirSenha(senha, usuario.senha))) {
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  }

  // Migração transparente: senhas antigas em texto puro passam a ser armazenadas com hash.
  if (!ehHash(usuario.senha)) {
    await prisma.usuario.update({ where: { id: usuario.id }, data: { senha: await gerarHash(senha) } });
  }

  const dados = { id: usuario.id, nome: usuario.nome, cargo: usuario.cargo, email: usuario.email };
  return res.json({ ...dados, token: gerarToken(dados) });
});

router.get('/me', async (req, res) => {
  if (!req.usuario) throw new HttpError(401, 'Não autenticado.');
  const u = await prisma.usuario.findUnique({ where: { id: req.usuario.id }, select: SELECT_USUARIO });
  return res.json(u);
});

// ---------------- Usuários ----------------
router.get('/usuarios', async (_req, res) => {
  return res.json(await prisma.usuario.findMany({ select: SELECT_USUARIO, orderBy: { nome: 'asc' } }));
});

// Cadastro aberto apenas enquanto a autenticação não é obrigatória (o app mobile tem tela de cadastro).
router.post('/usuarios', somenteAdmin, async (req, res) => {
  const { nome, cargo, email, senha } = req.body || {};
  if (!nome || !email || !senha) throw badRequest('Nome, e-mail e senha são obrigatórios.');
  const novo = await prisma.usuario.create({
    data: { nome, cargo: cargo || 'Estoquista', email: String(email).trim().toLowerCase(), senha: await gerarHash(String(senha)) },
    select: SELECT_USUARIO,
  });
  return res.status(201).json(novo);
});

router.put('/usuarios/:id', somenteAdmin, async (req, res) => {
  const { nome, cargo, email, senha } = req.body || {};
  const data: Record<string, unknown> = {};
  if (nome !== undefined) data.nome = nome;
  if (cargo !== undefined) data.cargo = cargo;
  if (email !== undefined) data.email = String(email).trim().toLowerCase();
  if (senha) data.senha = await gerarHash(String(senha)); // redefinição de senha pelo gestor
  const atualizado = await prisma.usuario.update({ where: { id: String(req.params.id) }, data, select: SELECT_USUARIO });
  return res.json(atualizado);
});

router.delete('/usuarios/:id', somenteAdmin, async (req, res) => {
  try {
    await prisma.usuario.delete({ where: { id: String(req.params.id) } });
  } catch {
    throw badRequest('Usuário possui histórico vinculado.');
  }
  return res.status(204).send();
});

router.put('/usuarios/:id/push-token', async (req, res) => {
  const token = req.body?.token ? String(req.body.token) : null;
  // Um aparelho = um usuário: se outro login usou este celular antes, ele para de receber os alertas aqui.
  if (token) await prisma.usuario.updateMany({ where: { pushToken: token, id: { not: String(req.params.id) } }, data: { pushToken: null } });
  await prisma.usuario.update({ where: { id: String(req.params.id) }, data: { pushToken: token } });
  return res.send();
});

export default router;
