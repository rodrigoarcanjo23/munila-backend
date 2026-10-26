import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, num } from '../lib/http';

const router = Router();

const nomeUsuario = (req: any) => req.usuario?.nome || req.body?.usuario || 'Sistema';

// ==========================================
// 1. ESTOQUE VIRTUAL (CRUD) — agora com auditoria de edição e exclusão
// ==========================================
router.get('/estoque', async (_req, res) => {
  res.json(await prisma.transformacaoItem.findMany({ orderBy: { nome: 'asc' } }));
});

router.post('/estoque', async (req, res) => {
  const { tipo, sku, nome, quantidade, lote } = req.body || {};
  if (!sku || !nome) throw badRequest('Nome e SKU são obrigatórios.');
  const novo = await prisma.transformacaoItem.create({ data: { tipo: tipo || 'INSUMO', sku: String(sku).trim(), nome: String(nome).trim(), quantidade: num(quantidade), lote: lote || null } });
  await prisma.transformacaoAuditoria.create({
    data: { acao: 'Criação', detalhes: `Cadastrou ${novo.tipo === 'INSUMO' ? 'o insumo' : 'o item'} [${novo.sku}] ${novo.nome} com saldo ${novo.quantidade}.`, usuario: nomeUsuario(req), loteInfo: novo.lote, quantidadeInfo: novo.quantidade },
  });
  res.status(201).json(novo);
});

router.put('/estoque/:id', async (req, res) => {
  const anterior = await prisma.transformacaoItem.findUnique({ where: { id: req.params.id } });
  if (!anterior) throw badRequest('Item não encontrado.');
  const { nome, sku, quantidade, lote } = req.body || {};
  const atualizado = await prisma.transformacaoItem.update({ where: { id: anterior.id }, data: { nome, sku, quantidade: num(quantidade), lote: lote || null } });
  await prisma.transformacaoAuditoria.create({
    data: { acao: 'Edição', detalhes: `Editou [${atualizado.sku}] ${atualizado.nome}: saldo ${anterior.quantidade} → ${atualizado.quantidade}.`, usuario: nomeUsuario(req), loteInfo: atualizado.lote, quantidadeInfo: atualizado.quantidade },
  });
  res.json(atualizado);
});

router.delete('/estoque/:id', async (req, res) => {
  const item = await prisma.transformacaoItem.delete({ where: { id: req.params.id } });
  await prisma.transformacaoAuditoria.create({
    data: { acao: 'Exclusão', detalhes: `Excluiu [${item.sku}] ${item.nome} (saldo ${item.quantidade}).`, usuario: nomeUsuario(req), loteInfo: item.lote },
  });
  res.json({ message: 'Item removido' });
});

// ==========================================
// 2. LOTES DE PRODUÇÃO E MOTOR DE TRANSFORMAÇÃO
// ==========================================
router.get('/lotes', async (_req, res) => {
  res.json(await prisma.transformacaoLote.findMany({ orderBy: { createdAt: 'desc' } }));
});

router.post('/lotes', async (req, res) => {
  const { produtoNome, produtoSku, codigoLote } = req.body || {};
  const receitaUsada: { idInsumo: string; nomeInsumo?: string; totalGasto: number }[] = Array.isArray(req.body?.receitaUsada) ? req.body.receitaUsada : [];
  const qtd = num(req.body?.quantidade);
  if (!produtoNome || !produtoSku || qtd <= 0) throw badRequest('Informe nome, SKU e quantidade gerada.');
  if (!codigoLote) throw badRequest('O número do lote é obrigatório.');
  if (receitaUsada.length === 0) throw badRequest('Informe ao menos um insumo consumido.');

  await prisma.$transaction(async tx => {
    // 1. Desconta os insumos — agora validando o saldo no servidor (antes podia ficar negativo).
    for (const ing of receitaUsada) {
      const gasto = num(ing.totalGasto);
      const insumo = await tx.transformacaoItem.findUnique({ where: { id: ing.idInsumo } });
      if (!insumo) throw new Error(`Insumo não encontrado: ${ing.nomeInsumo || ing.idInsumo}.`);
      if (insumo.quantidade < gasto) throw new Error(`Saldo insuficiente de ${insumo.nome}: necessário ${gasto}, disponível ${insumo.quantidade}.`);
      await tx.transformacaoItem.update({ where: { id: insumo.id }, data: { quantidade: { decrement: gasto } } });
    }

    // 2. Adiciona o produto acabado
    const existente = await tx.transformacaoItem.findUnique({ where: { sku: produtoSku } });
    if (existente && existente.tipo === 'INSUMO') throw new Error('Este SKU já pertence a um insumo.');
    await tx.transformacaoItem.upsert({
      where: { sku: produtoSku },
      update: { quantidade: { increment: qtd }, lote: codigoLote },
      create: { tipo: 'ACABADO', sku: produtoSku, nome: produtoNome, quantidade: qtd, lote: codigoLote },
    });

    // 3. Registra o lote (antes a tabela de lotes nunca era preenchida) e a auditoria
    await tx.transformacaoLote.create({ data: { codigoLote, produtoNome, produtoSku, quantidade: qtd, receitaUsada } });
    const consumo = receitaUsada.map(r => `${r.nomeInsumo || 'insumo'} (-${num(r.totalGasto)})`).join(', ');
    await tx.transformacaoAuditoria.create({
      data: { acao: 'Criação', detalhes: `Fabricou ${qtd} un. de [${produtoSku}] ${produtoNome}. Consumo: ${consumo}.`, usuario: nomeUsuario(req), loteInfo: codigoLote, quantidadeInfo: qtd },
    });
  });

  res.status(201).json({ message: 'Transformação concluída com sucesso!' });
});

// ==========================================
// 3. AUDITORIA
// ==========================================
router.get('/auditoria', async (_req, res) => {
  res.json(await prisma.transformacaoAuditoria.findMany({ orderBy: { dataHora: 'desc' } }));
});

export default router;
