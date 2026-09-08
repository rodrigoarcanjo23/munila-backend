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
    const { tipo, sku, nome, quantidade } = req.body;
    const novoItem = await prisma.transformacaoItem.create({
      data: { tipo, sku, nome, quantidade }
    });
    res.status(201).json(novoItem);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar insumo' });
  }
});

router.put('/estoque/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, sku, quantidade } = req.body;
    const atualizado = await prisma.transformacaoItem.update({
      where: { id },
      data: { nome, sku, quantidade }
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
    const { produtoNome, produtoSku, quantidade, receitaUsada, usuario } = req.body;
    // Cria um código de lote automático
    const codigoLote = `LT-${Date.now().toString().slice(-6)}`;

    // O $transaction garante que ou tudo dá certo, ou ele desfaz tudo se houver erro
    await prisma.$transaction(async (tx) => {
      // 1. Cria o Lote
      await tx.transformacaoLote.create({
        data: { codigoLote, produtoNome, produtoSku, quantidade, receitaUsada }
      });

      // 2. Desconta os Insumos
      for (const ing of receitaUsada) {
        await tx.transformacaoItem.update({
          where: { id: ing.idInsumo },
          data: { quantidade: { decrement: ing.totalGasto } }
        });
      }

      // 3. Adiciona o Produto Acabado (Atualiza se existir, Cria se não existir)
      await tx.transformacaoItem.upsert({
        where: { sku: produtoSku },
        update: { quantidade: { increment: quantidade } },
        create: { tipo: 'ACABADO', sku: produtoSku, nome: produtoNome, quantidade }
      });

      // 4. Registra Auditoria
      await tx.transformacaoAuditoria.create({
        data: {
          acao: 'Criação',
          detalhes: `Fabricou ${quantidade} un. de [${produtoSku}] ${produtoNome} (Lote: ${codigoLote}).`,
          usuario: usuario || 'Sistema'
        }
      });
    });

    res.status(201).json({ message: 'Transformação concluída com sucesso!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao processar transformação' });
  }
});

router.delete('/lotes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario } = req.body;

    await prisma.$transaction(async (tx) => {
      const lote = await tx.transformacaoLote.findUnique({ where: { id } });
      if (!lote) throw new Error("Lote não encontrado");

      const receita = lote.receitaUsada as any[];

      // Devolve os insumos
      for (const ing of receita) {
        await tx.transformacaoItem.update({
          where: { id: ing.idInsumo },
          data: { quantidade: { increment: ing.totalGasto } }
        });
      }

      // Desconta o Produto Acabado
      await tx.transformacaoItem.update({
        where: { sku: lote.produtoSku },
        data: { quantidade: { decrement: lote.quantidade } }
      });

      // Apaga o Lote e Registra Auditoria
      await tx.transformacaoLote.delete({ where: { id } });
      await tx.transformacaoAuditoria.create({
        data: {
          acao: 'Exclusão',
          detalhes: `Desfez o Lote ${lote.codigoLote}, gerando estorno de ${lote.quantidade} un. de [${lote.produtoSku}] ${lote.produtoNome}.`,
          usuario: usuario || 'Sistema'
        }
      });
    });

    res.json({ message: 'Lote desfeito e estoque restaurado!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao desfazer lote' });
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