import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, notFound, num } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import { STATUS, gerarCodigoOS, linhaEstoque } from '../lib/estoque';
import { enviarPush } from '../lib/notificacoes';

const router = Router();

const INCLUDE_ORDEM = {
  solicitante: { select: { nome: true } },
  separador: { select: { nome: true } },
  itens: { include: { produto: true } },
} as const;

function itensValidos(itens: any): { produtoId: string; quantidade: number }[] {
  if (!Array.isArray(itens) || itens.length === 0) throw badRequest('Ordem vazia.');
  return itens.map((i: any) => {
    const quantidade = Math.round(num(i.quantidade));
    if (!i.produtoId || quantidade <= 0) throw badRequest('Item inválido na ordem.');
    return { produtoId: i.produtoId, quantidade };
  });
}

router.get('/wms/ordens', async (_req, res) => {
  return res.json(await prisma.ordemTransferencia.findMany({ include: INCLUDE_ORDEM, orderBy: { createdAt: 'desc' } }));
});

router.post('/wms/ordens', async (req, res) => {
  const { tipo, prioridade, observacao } = req.body || {};
  const solicitanteId = req.usuario?.id || req.body?.solicitanteId;
  if (!solicitanteId) throw badRequest('Solicitante não identificado.');
  const itens = itensValidos(req.body?.itens);

  const novaOrdem = await prisma.$transaction(async tx =>
    tx.ordemTransferencia.create({
      data: {
        codigo: await gerarCodigoOS(tx), solicitanteId, status: 'Pendente', tipo: tipo || 'SAIDA', prioridade: prioridade || 'Normal',
        observacao: observacao || null, itens: { create: itens },
      },
      include: { itens: true },
    }),
  );

  enviarPush('🚨 Nova OS no Armazém!', `A Ordem ${novaOrdem.codigo} (${novaOrdem.prioridade}) foi solicitada.`);
  return res.status(201).json(novaOrdem);
});

router.put('/wms/ordens/:id', async (req, res) => {
  const { tipo, prioridade, observacao } = req.body || {};
  const itens = itensValidos(req.body?.itens);
  const atual = await prisma.ordemTransferencia.findUnique({ where: { id: req.params.id } });
  if (!atual || atual.status !== 'Pendente') throw badRequest('Apenas ordens Pendentes podem ser editadas.');

  const atualizada = await prisma.$transaction(async tx => {
    await tx.itemOrdemTransferencia.deleteMany({ where: { ordemId: atual.id } });
    return tx.ordemTransferencia.update({
      where: { id: atual.id },
      data: { tipo: tipo || 'SAIDA', prioridade: prioridade || 'Normal', observacao: observacao ?? atual.observacao, itens: { create: itens } },
      include: { itens: true },
    });
  });
  return res.json(atualizada);
});

router.delete('/wms/ordens/:id', async (req, res) => {
  const ordem = await prisma.ordemTransferencia.findUnique({ where: { id: req.params.id } });
  if (!ordem) throw notFound('Ordem não encontrada.');
  if (ordem.status === 'Concluída') throw badRequest('Não é possível excluir OS concluída.');
  await prisma.ordemTransferencia.delete({ where: { id: ordem.id } });
  return res.status(204).send();
});

router.put('/wms/ordens/:id/status', async (req, res) => {
  const { status, separadorId } = req.body || {};
  const ordem = await prisma.ordemTransferencia.update({
    where: { id: req.params.id },
    data: {
      status,
      separadorId: separadorId || req.usuario?.id || undefined,
      iniciadaEm: status === 'Em Separação' ? new Date() : undefined,
    },
  });
  return res.json(ordem);
});

router.put('/wms/ordens/:id/pausar', async (req, res) => {
  const ordem = await prisma.ordemTransferencia.update({ where: { id: req.params.id }, data: { status: 'Pendente', separadorId: null } });
  return res.json(ordem);
});

/** ✨ NOVO: persiste o checklist de conferência item a item (permite retomar a conferência em outro aparelho). */
router.put('/wms/ordens/:id/itens/:itemId', async (req, res) => {
  const item = await prisma.itemOrdemTransferencia.update({ where: { id: req.params.itemId }, data: { marcado: Boolean(req.body?.marcado) } });
  return res.json(item);
});

router.post('/wms/ordens/:id/concluir', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');

  const resultado = await prisma.$transaction(async tx => {
    const ordem = await tx.ordemTransferencia.findUnique({ where: { id: req.params.id }, include: { itens: { include: { produto: true } } } });
    if (!ordem) throw new Error('Ordem não encontrada.');
    if (ordem.status === 'Concluída') throw new Error('Ordem já concluída.');
    const entrada = ordem.tipo === 'ENTRADA' || ordem.tipo === 'DEVOLUCAO';

    for (const item of ordem.itens) {
      const disponivel = await linhaEstoque(tx, item.produtoId, STATUS.DISPONIVEL);
      let tipoAcao = 'Saída de mercadoria';
      let observacao = `OS Retirada #${ordem.codigo}`;

      if (entrada) {
        tipoAcao = ordem.tipo === 'ENTRADA' ? 'Entrada de mercadoria' : 'Devolução VIAPRO';
        observacao = `OS ${ordem.tipo === 'ENTRADA' ? 'Entrada' : 'Devolução'} #${ordem.codigo}`;
        await tx.estoque.update({ where: { id: disponivel.id }, data: { quantidade: { increment: item.quantidade } } });
      } else {
        if (disponivel.quantidade < item.quantidade) {
          throw new Error(`Estoque insuficiente de [${item.produto.sku}] ${item.produto.nome}: solicitado ${item.quantidade}, disponível ${disponivel.quantidade}.`);
        }
        await tx.estoque.update({ where: { id: disponivel.id }, data: { quantidade: { decrement: item.quantidade } } });
      }
      await tx.movimentacao.create({ data: { produtoId: item.produtoId, usuarioId, quantidade: item.quantidade, tipoAcao, codigo: ordem.codigo, observacao } });
    }

    await tx.itemOrdemTransferencia.updateMany({ where: { ordemId: ordem.id }, data: { marcado: true } });
    return tx.ordemTransferencia.update({
      where: { id: ordem.id },
      data: { status: 'Concluída', separadorId: usuarioId, concluidaEm: new Date(), iniciadaEm: ordem.iniciadaEm ?? new Date() },
    });
  });
  return res.json(resultado);
});

export default router;
