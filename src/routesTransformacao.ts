import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// ==========================================
// 1. ESTOQUE VIRTUAL (CRUD)
// ==========================================
router.get('/estoque', async (req, res) => {
  try {
    const estoque = await prisma.transformacaoItem.findMany({ orderBy: { nome: 'asc' } });
    res.json(estoque);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar estoque virtual' });
  }
});

router.post('/estoque', async (req, res) => {
  try {
    const { tipo, sku, nome, quantidade, lote } = req.body;
    const novoItem = await prisma.transformacaoItem.create({
      data: { tipo, sku, nome, quantidade: Number(quantidade), lote }
    });
    res.status(201).json(novoItem);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar insumo' });
  }
});

router.put('/estoque/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, sku, quantidade, lote } = req.body;
    const atualizado = await prisma.transformacaoItem.update({
      where: { id },
      data: { nome, sku, quantidade: Number(quantidade), lote }
    });
    res.json(atualizado);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar item' });
  }
});

router.delete('/estoque/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.transformacaoItem.delete({ where: { id } });
    res.json({ message: 'Item removido' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao remover item' });
  }
});

// ==========================================
// 2. LOTES DE PRODUÇÃO E MOTOR DE TRANSFORMAÇÃO
// ==========================================
router.get('/lotes', async (req, res) => {
  try {
    const lotes = await prisma.transformacaoLote.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(lotes);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar lotes' });
  }
});

router.post('/lotes', async (req, res) => {
  try {
    const { produtoNome, produtoSku, quantidade, codigoLote, receitaUsada, usuario } = req.body;
    const qtdNum = Number(quantidade);

    await prisma.$transaction(async (tx) => {
      // 1. Desconta os Insumos
      for (const ing of receitaUsada) {
        await tx.transformacaoItem.update({
          where: { id: ing.idInsumo },
          data: { quantidade: { decrement: ing.totalGasto } }
        });
      }

      // 2. Adiciona o Produto Acabado
      await tx.transformacaoItem.upsert({
        where: { sku: produtoSku },
        update: { quantidade: { increment: qtdNum }, lote: codigoLote },
        create: { tipo: 'ACABADO', sku: produtoSku, nome: produtoNome, quantidade: qtdNum, lote: codigoLote }
      });

      // 3. Registra Auditoria com Lote Info
      await tx.transformacaoAuditoria.create({
        data: {
          acao: 'Criação',
          detalhes: `Fabricou ${qtdNum} un. de [${produtoSku}] ${produtoNome}.`,
          usuario: usuario || 'Sistema',
          loteInfo: codigoLote,
          quantidadeInfo: qtdNum
        }
      });
    });

    res.status(201).json({ message: 'Transformação concluída com sucesso!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao processar transformação' });
  }
});

// ==========================================
// 3. AUDITORIA
// ==========================================
router.get('/auditoria', async (req, res) => {
  try {
    const logs = await prisma.transformacaoAuditoria.findMany({ orderBy: { dataHora: 'desc' } });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar auditoria' });
  }
});

export default router;