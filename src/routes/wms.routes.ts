import { Router } from 'express';
import { prisma, type Db } from '../lib/prisma';
import { badRequest, notFound, num } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import { armazemPadrao, conferirSaldoDaOrdem, disponibilidadeParaOrdem, entradaEstoque, gerarCodigoOS, mensagemFaltas, registrarMovimentos, saidaFEFO, sugerirFEFO, type FaltaOrdem } from '../lib/estoque';
import { CANAL_ORDENS, enviarPush } from '../lib/notificacoes';

const router = Router();

const INCLUDE_ORDEM = {
  solicitante: { select: { nome: true } },
  separador: { select: { nome: true } },
  itens: { include: { produto: true } },
  armazem: true,
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

/** Leve, para o app checar a cada poucos segundos: ordens pendentes criadas depois de `desde`. */
router.get('/wms/ordens/novas', async (req, res) => {
  const desde = req.query.desde ? new Date(String(req.query.desde)) : new Date(Date.now() - 10 * 60000);
  const ordens = await prisma.ordemTransferencia.findMany({
    where: { status: 'Pendente', createdAt: { gt: isNaN(desde.getTime()) ? new Date(Date.now() - 10 * 60000) : desde } },
    select: { id: true, codigo: true, tipo: true, prioridade: true, createdAt: true, solicitanteId: true, solicitante: { select: { nome: true } }, _count: { select: { itens: true } } },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  const pendentes = await prisma.ordemTransferencia.count({ where: { status: 'Pendente' } });
  return res.json({ agora: new Date(), ordens, pendentes });
});

/** ✨ Saldo livre para pedir (saldo disponível − o que ordens de saída abertas já reservaram), por produto. */
router.get('/wms/disponibilidade', async (req, res) => {
  const armazemId = req.query.armazemId ? String(req.query.armazemId) : await armazemPadrao(prisma);
  const disp = await disponibilidadeParaOrdem(prisma, armazemId, req.query.ignorarOrdemId ? String(req.query.ignorarOrdemId) : null);
  return res.json({ armazemId, produtos: Object.fromEntries(disp) });
});

/** Lock da emissão de ordens de saída: duas pessoas pedindo o último item ao mesmo tempo não passam juntas. */
const LOCK_ORDENS = 7340099;
class SemSaldo extends Error { constructor(public faltas: FaltaOrdem[]) { super(mensagemFaltas(faltas)); } }
const responderSemSaldo = (res: any, e: unknown) => {
  if (e instanceof SemSaldo) { res.status(409).json({ error: e.message, faltas: e.faltas }); return true; }
  return false;
};

router.post('/wms/ordens', async (req, res) => {
  const { tipo, prioridade, observacao, armazemId } = req.body || {};
  const solicitanteId = req.usuario?.id || req.body?.solicitanteId;
  if (!solicitanteId) throw badRequest('Solicitante não identificado.');
  const itens = itensValidos(req.body?.itens);

  let novaOrdem;
  try {
    novaOrdem = await prisma.$transaction(async tx => {
      const arm = armazemId || (await armazemPadrao(tx));
      const tipoOrdem = tipo || 'SAIDA';
      if (tipoOrdem === 'SAIDA') {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${LOCK_ORDENS})`);
        const faltas = await conferirSaldoDaOrdem(tx, itens, arm);
        if (faltas.length) throw new SemSaldo(faltas);
      }
      return tx.ordemTransferencia.create({
        data: {
          codigo: await gerarCodigoOS(tx), solicitanteId, status: 'Pendente', tipo: tipoOrdem, prioridade: prioridade || 'Normal',
          observacao: observacao || null, armazemId: arm, itens: { create: itens },
        },
        include: { itens: true, solicitante: { select: { nome: true } } },
      });
    });
  } catch (e) { if (responderSemSaldo(res, e)) return; throw e; }

  // Alerta no app: pop-up com som em todos os aparelhos, menos no de quem pediu.
  const tituloPush = novaOrdem.tipo === 'ENTRADA' ? 'Nova ordem de entrada' : novaOrdem.tipo === 'DEVOLUCAO' ? 'Nova ordem de devolução' : 'Nova ordem de separação';
  const qtdItens = novaOrdem.itens.length;
  enviarPush(
    `${novaOrdem.prioridade === 'Urgente' ? '🚨 URGENTE · ' : ''}${tituloPush}`,
    `${novaOrdem.codigo} · ${qtdItens} ${qtdItens === 1 ? 'item' : 'itens'} · prioridade ${novaOrdem.prioridade.toLowerCase()} · pedida por ${novaOrdem.solicitante?.nome ?? 'alguém'}`,
    { data: { tipo: 'nova-os', ordemId: novaOrdem.id, codigo: novaOrdem.codigo, prioridade: novaOrdem.prioridade }, excluirUsuarioId: solicitanteId, canal: CANAL_ORDENS },
  );
  return res.status(201).json(novaOrdem);
});

router.put('/wms/ordens/:id', async (req, res) => {
  const { tipo, prioridade, observacao, armazemId } = req.body || {};
  const itens = itensValidos(req.body?.itens);
  const atual = await prisma.ordemTransferencia.findUnique({ where: { id: req.params.id } });
  if (!atual || atual.status !== 'Pendente') throw badRequest('Apenas ordens Pendentes podem ser editadas.');

  let atualizada;
  try {
    atualizada = await prisma.$transaction(async tx => {
      const tipoOrdem = tipo || 'SAIDA';
      const arm = armazemId || atual.armazemId || (await armazemPadrao(tx));
      if (tipoOrdem === 'SAIDA') {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${LOCK_ORDENS})`);
        const faltas = await conferirSaldoDaOrdem(tx, itens, arm, atual.id); // a própria ordem não conta como reserva
        if (faltas.length) throw new SemSaldo(faltas);
      }
      await tx.itemOrdemTransferencia.deleteMany({ where: { ordemId: atual.id } });
      return tx.ordemTransferencia.update({
        where: { id: atual.id },
        data: { tipo: tipoOrdem, prioridade: prioridade || 'Normal', observacao: observacao ?? atual.observacao, armazemId: arm, itens: { create: itens } },
        include: { itens: true },
      });
    });
  } catch (e) { if (responderSemSaldo(res, e)) return; throw e; }
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

/** ✨ FASE 2: sugestão de picking por lote (FEFO) para cada item da ordem. */
router.get('/wms/ordens/:id/picking', async (req, res) => {
  const ordem = await prisma.ordemTransferencia.findUnique({ where: { id: String(req.params.id) }, include: { itens: { include: { produto: true } } } });
  if (!ordem) throw notFound('Ordem não encontrada.');
  const itens = [];
  for (const i of ordem.itens) {
    const s = ordem.tipo === 'SAIDA' ? await sugerirFEFO(prisma, i.produtoId, i.quantidade, ordem.armazemId) : { partes: [], falta: 0, disponivel: 0 };
    itens.push({ itemId: i.id, produtoId: i.produtoId, ...s });
  }
  return res.json(itens);
});

/** ✨ NOVO: persiste o checklist de conferência item a item (permite retomar a conferência em outro aparelho). */
router.put('/wms/ordens/:id/itens/:itemId', async (req, res) => {
  const item = await prisma.itemOrdemTransferencia.update({ where: { id: req.params.itemId }, data: { marcado: Boolean(req.body?.marcado) } });
  return res.json(item);
});

router.post('/wms/ordens/:id/concluir', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');

  const resultado = await prisma.$transaction(tx => concluirOrdem(tx, String(req.params.id), usuarioId));
  return res.json(resultado);
});

export default router;

/** Conclui uma ordem dentro de uma transação: movimenta o estoque (FEFO na saída) e marca os itens. Usada também pela onda. */
export async function concluirOrdem(tx: Db, ordemId: string, usuarioId: string) {
  const ordem = await tx.ordemTransferencia.findUnique({ where: { id: ordemId }, include: { itens: { include: { produto: true } } } });
  if (!ordem) throw new Error('Ordem não encontrada.');
  if (ordem.status === 'Concluída') throw new Error(`Ordem ${ordem.codigo} já concluída.`);
  const entrada = ordem.tipo === 'ENTRADA' || ordem.tipo === 'DEVOLUCAO';

  for (const item of ordem.itens) {
    const rotulo = `[${item.produto.sku}] ${item.produto.nome}`;
    if (entrada) {
      const tipoAcao = ordem.tipo === 'ENTRADA' ? 'Entrada de mercadoria' : 'Devolução VIAPRO';
      const observacao = `OS ${ordem.tipo === 'ENTRADA' ? 'Entrada' : 'Devolução'} #${ordem.codigo}`;
      const parte = await entradaEstoque(tx, { produtoId: item.produtoId, quantidade: item.quantidade, armazemId: ordem.armazemId });
      await registrarMovimentos(tx, { produtoId: item.produtoId, usuarioId, tipoAcao, codigo: ordem.codigo, observacao }, [parte]);
    } else {
      // ✨ FASE 2: saída FEFO — consome primeiro os lotes que vencem antes
      const partes = await saidaFEFO(tx, { produtoId: item.produtoId, quantidade: item.quantidade, armazemId: ordem.armazemId, rotulo });
      await registrarMovimentos(tx, { produtoId: item.produtoId, usuarioId, tipoAcao: 'Saída de mercadoria', codigo: ordem.codigo, observacao: `OS Retirada #${ordem.codigo}` }, partes);
    }
  }

  await tx.itemOrdemTransferencia.updateMany({ where: { ordemId: ordem.id }, data: { marcado: true } });
  return tx.ordemTransferencia.update({
    where: { id: ordem.id },
    data: { status: 'Concluída', separadorId: usuarioId, concluidaEm: new Date(), iniciadaEm: ordem.iniciadaEm ?? new Date() },
  });
}
