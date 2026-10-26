import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest } from '../lib/http';
import { somenteAdmin } from '../lib/auth';
import { STATUS, limparCacheArmazem } from '../lib/estoque';

/** ✨ FASE 2: cadastro de armazéns (Munila, VIAPRO...). */
const router = Router();

router.get('/armazens', async (_req, res) => {
  const [armazens, saldos] = await Promise.all([
    prisma.armazem.findMany({ orderBy: [{ padrao: 'desc' }, { nome: 'asc' }], include: { _count: { select: { locais: true } } } }),
    prisma.estoque.findMany({ where: { status: STATUS.DISPONIVEL, quantidade: { gt: 0 } }, select: { armazemId: true, quantidade: true, produtoId: true, produto: { select: { precoCusto: true } } } }),
  ]);
  return res.json(armazens.map(a => {
    const linhas = saldos.filter(s => s.armazemId === a.id);
    return {
      ...a,
      produtos: new Set(linhas.map(l => l.produtoId)).size,
      unidades: linhas.reduce((s, l) => s + l.quantidade, 0),
      valor: linhas.reduce((s, l) => s + l.quantidade * (l.produto.precoCusto || 0), 0),
    };
  }));
});

router.post('/armazens', somenteAdmin, async (req, res) => {
  const { codigo, nome, endereco, padrao } = req.body || {};
  if (!codigo || !nome) throw badRequest('Código e nome são obrigatórios.');
  const criado = await prisma.$transaction(async tx => {
    if (padrao) await tx.armazem.updateMany({ data: { padrao: false } });
    return tx.armazem.create({ data: { codigo: String(codigo).trim().toUpperCase(), nome, endereco: endereco || null, padrao: Boolean(padrao) } });
  });
  limparCacheArmazem();
  return res.status(201).json(criado);
});

router.put('/armazens/:id', somenteAdmin, async (req, res) => {
  const { codigo, nome, endereco, padrao, ativo } = req.body || {};
  const atualizado = await prisma.$transaction(async tx => {
    if (padrao) await tx.armazem.updateMany({ where: { id: { not: String(req.params.id) } }, data: { padrao: false } });
    return tx.armazem.update({
      where: { id: String(req.params.id) },
      data: { codigo: codigo ? String(codigo).trim().toUpperCase() : undefined, nome, endereco, padrao: padrao === undefined ? undefined : Boolean(padrao), ativo },
    });
  });
  limparCacheArmazem();
  return res.json(atualizado);
});

router.delete('/armazens/:id', somenteAdmin, async (req, res) => {
  const id = String(req.params.id);
  const a = await prisma.armazem.findUnique({ where: { id } });
  if (!a) throw badRequest('Armazém não encontrado.');
  if (a.padrao) throw badRequest('Defina outro armazém como padrão antes de excluir este.');
  const comSaldo = await prisma.estoque.count({ where: { armazemId: id, quantidade: { gt: 0 } } });
  if (comSaldo) throw badRequest('Existem produtos com saldo neste armazém. Transfira o saldo antes de excluir.');
  await prisma.$transaction([
    prisma.estoque.deleteMany({ where: { armazemId: id, quantidade: 0 } }),
    prisma.localizacao.updateMany({ where: { armazemId: id }, data: { armazemId: null } }),
    prisma.armazem.delete({ where: { id } }),
  ]);
  limparCacheArmazem();
  return res.status(204).send();
});

export default router;
