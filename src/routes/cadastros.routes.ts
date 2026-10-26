import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest } from '../lib/http';

const router = Router();

// ---------------- Categorias ----------------
router.get('/categorias', async (_req, res) => {
  return res.json(await prisma.categoria.findMany({ orderBy: { nome: 'asc' }, include: { _count: { select: { produtos: true } } } }));
});

router.post('/categorias', async (req, res) => {
  const { nome, descricao } = req.body || {};
  if (!nome) throw badRequest('Informe o nome da categoria.');
  return res.status(201).json(await prisma.categoria.create({ data: { nome, descricao: descricao || null } }));
});

router.put('/categorias/:id', async (req, res) => {
  const { nome, descricao } = req.body || {};
  return res.json(await prisma.categoria.update({ where: { id: req.params.id }, data: { nome, descricao } }));
});

router.delete('/categorias/:id', async (req, res) => {
  const emUso = await prisma.produto.count({ where: { categoriaId: req.params.id } });
  if (emUso > 0) throw badRequest(`Categoria em uso por ${emUso} produto(s).`);
  await prisma.categoria.delete({ where: { id: req.params.id } });
  return res.status(204).send();
});

// ---------------- Localizações (endereços do armazém) ----------------
// Correção: o front já chamava POST/PUT/DELETE, mas a API só tinha o GET.
router.get('/localizacoes', async (_req, res) => {
  return res.json(await prisma.localizacao.findMany({ orderBy: { codigo: 'asc' } }));
});

router.post('/localizacoes', async (req, res) => {
  const { codigo, zona, corredor, prateleira } = req.body || {};
  if (!codigo || !zona) throw badRequest('Código e zona são obrigatórios.');
  const novo = await prisma.localizacao.create({
    data: { codigo: String(codigo).trim().toUpperCase(), zona, corredor: corredor || '-', prateleira: prateleira || '-' },
  });
  return res.status(201).json(novo);
});

router.put('/localizacoes/:id', async (req, res) => {
  const { codigo, zona, corredor, prateleira } = req.body || {};
  const atualizado = await prisma.localizacao.update({
    where: { id: req.params.id },
    data: { codigo: codigo ? String(codigo).trim().toUpperCase() : undefined, zona, corredor, prateleira },
  });
  return res.json(atualizado);
});

router.delete('/localizacoes/:id', async (req, res) => {
  const emUso = await prisma.estoque.count({ where: { localizacaoId: req.params.id, quantidade: { gt: 0 } } });
  if (emUso > 0) throw badRequest('Existem produtos com saldo guardados neste endereço.');
  await prisma.estoque.updateMany({ where: { localizacaoId: req.params.id }, data: { localizacaoId: null } });
  await prisma.localizacao.delete({ where: { id: req.params.id } });
  return res.status(204).send();
});

export default router;
