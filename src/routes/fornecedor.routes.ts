import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, intOuNull } from '../lib/http';

const router = Router();

router.get('/', async (_req, res) => {
  const fornecedores = await prisma.fornecedor.findMany({
    orderBy: { nomeEmpresa: 'asc' },
    include: { _count: { select: { produtos: true, pedidosCompra: true } } },
  });
  return res.json(fornecedores);
});

router.post('/', async (req, res) => {
  const { nomeEmpresa, cnpj, contatoNome, telefone, email, prazoPagamentoDias } = req.body || {};
  if (!nomeEmpresa) throw badRequest('O Nome da Empresa é obrigatório.');
  const novo = await prisma.fornecedor.create({ data: { nomeEmpresa, cnpj, contatoNome, telefone, email, prazoPagamentoDias: intOuNull(prazoPagamentoDias) } });
  return res.status(201).json(novo);
});

router.put('/:id', async (req, res) => {
  const { nomeEmpresa, cnpj, contatoNome, telefone, email, prazoPagamentoDias } = req.body || {};
  const atualizado = await prisma.fornecedor.update({
    where: { id: req.params.id },
    data: { nomeEmpresa, cnpj, contatoNome, telefone, email, prazoPagamentoDias: prazoPagamentoDias === undefined ? undefined : intOuNull(prazoPagamentoDias) },
  });
  return res.json(atualizado);
});

router.delete('/:id', async (req, res) => {
  try {
    await prisma.fornecedor.delete({ where: { id: req.params.id } });
  } catch {
    throw badRequest('Não foi possível excluir o fornecedor. Ele possui produtos ou pedidos vinculados.');
  }
  return res.status(204).send();
});

export default router;
