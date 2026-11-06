import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest } from '../lib/http';
import { somenteAdmin } from '../lib/auth';
import { STATUS, limparCacheArmazem } from '../lib/estoque';
import { recalcularBarrasDeposito } from '../lib/enderecos';

// ✨ FASE 12: número do depósito (DEP. 001) usado na etiqueta e no código de barras dos endereços
async function numeroValido(v: unknown, id?: string) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 99) throw badRequest('O número do depósito vai de 1 a 99.');
  const outro = await prisma.armazem.findFirst({ where: { numero: n, ...(id ? { id: { not: id } } : {}) } });
  if (outro) throw badRequest(`O número ${n} já é do depósito ${outro.nome}.`);
  return n;
}

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
  let numero = await numeroValido(req.body?.numero);
  if (numero == null) { const max = await prisma.armazem.aggregate({ _max: { numero: true } }); numero = (max._max.numero ?? 0) + 1; }
  const criado = await prisma.$transaction(async tx => {
    if (padrao) await tx.armazem.updateMany({ data: { padrao: false } });
    return tx.armazem.create({ data: { codigo: String(codigo).trim().toUpperCase(), nome, endereco: endereco || null, padrao: Boolean(padrao), numero } });
  });
  limparCacheArmazem();
  return res.status(201).json(criado);
});

router.put('/armazens/:id', somenteAdmin, async (req, res) => {
  const { codigo, nome, endereco, padrao, ativo } = req.body || {};
  const numero = await numeroValido(req.body?.numero, String(req.params.id));
  const antes = await prisma.armazem.findUnique({ where: { id: String(req.params.id) }, select: { numero: true } });
  const atualizado = await prisma.$transaction(async tx => {
    if (padrao) await tx.armazem.updateMany({ where: { id: { not: String(req.params.id) } }, data: { padrao: false } });
    const a = await tx.armazem.update({
      where: { id: String(req.params.id) },
      data: { codigo: codigo ? String(codigo).trim().toUpperCase() : undefined, nome, endereco, padrao: padrao === undefined ? undefined : Boolean(padrao), ativo, numero },
    });
    if (numero !== undefined && numero !== antes?.numero) await recalcularBarrasDeposito(tx, a.id, a.numero);
    return a;
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
