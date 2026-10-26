import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, num } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import { STATUS, TIPOS_ENTRADA, TIPOS_SAIDA, garantirEstoqueDisponivel, gerarCodigoRequisicao, linhaEstoque } from '../lib/estoque';

const router = Router();
const USUARIO_PUBLICO = { select: { id: true, nome: true, cargo: true } } as const;

router.get('/estoque', async (_req, res) => {
  await garantirEstoqueDisponivel();
  const inventario = await prisma.estoque.findMany({
    include: { produto: { include: { categoria: true } }, localizacao: true, responsavel: USUARIO_PUBLICO },
  });
  return res.json(inventario);
});

/** Cria saldo inicial. Se já existir a linha "Disponível" zerada (criada automaticamente), reaproveita. */
router.post('/estoque', async (req, res) => {
  const { produtoId, quantidade, status, localizacaoId, responsavelId } = req.body || {};
  if (!produtoId) throw badRequest('Produto obrigatório.');
  const st = status || STATUS.DISPONIVEL;
  const existente = await prisma.estoque.findFirst({ where: { produtoId, status: st } });
  if (existente && st === STATUS.DISPONIVEL && existente.quantidade === 0) {
    const atualizado = await prisma.estoque.update({
      where: { id: existente.id },
      data: { quantidade: Math.round(num(quantidade)), localizacaoId: localizacaoId || existente.localizacaoId },
    });
    return res.status(201).json(atualizado);
  }
  const novo = await prisma.estoque.create({
    data: { produtoId, quantidade: Math.round(num(quantidade)), status: st, localizacaoId: localizacaoId || null, responsavelId: responsavelId || null },
  });
  return res.status(201).json(novo);
});

/** Histórico de movimentações. Aceita filtros opcionais ?inicio=AAAA-MM-DD&fim=AAAA-MM-DD&produtoId=&limite= */
router.get('/movimentacoes', async (req, res) => {
  const { inicio, fim, produtoId, limite } = req.query as Record<string, string | undefined>;
  const dataHora: Record<string, Date> = {};
  if (inicio) dataHora.gte = new Date(`${inicio}T00:00:00`);
  if (fim) dataHora.lte = new Date(`${fim}T23:59:59.999`);
  const historico = await prisma.movimentacao.findMany({
    where: { ...(produtoId ? { produtoId } : {}), ...(inicio || fim ? { dataHora } : {}) },
    include: { produto: true, usuario: USUARIO_PUBLICO },
    orderBy: { dataHora: 'desc' },
    take: limite ? Math.min(parseInt(limite, 10) || 500, 5000) : undefined,
  });
  return res.json(historico);
});

router.get('/movimentacoes/tipos', (_req, res) => res.json({ entradas: TIPOS_ENTRADA, saidas: TIPOS_SAIDA }));

router.get('/logs-auditoria', async (_req, res) => {
  return res.json(await prisma.logAuditoria.findMany({ orderBy: { dataHora: 'desc' } }));
});

/** Movimentação manual sobre uma linha de estoque (mesmo contrato usado pelo web e pelo mobile). */
router.post('/movimentacoes/operacao', async (req, res) => {
  const { produtoId, estoqueId, tipoAcao, observacao } = req.body || {};
  const usuarioId = usuarioDaRequisicao(req);
  const qtd = Math.round(num(req.body?.quantidade));
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  if (qtd <= 0) throw badRequest('Informe uma quantidade válida.');

  const resultado = await prisma.$transaction(async tx => {
    const estoque = await tx.estoque.findUnique({ where: { id: estoqueId } });
    if (!estoque) throw new Error('Estoque não encontrado.');
    let novoSaldo = estoque.quantidade;
    let codigo: string;

    if (tipoAcao === 'Retorno de demonstração') {
      // ✨ NOVO: devolve ao saldo disponível um item que estava em demonstração.
      if (estoque.status !== STATUS.DEMONSTRACAO) throw new Error('Selecione um item que esteja em demonstração.');
      if (estoque.quantidade < qtd) throw new Error('Quantidade maior que a registrada em demonstração.');
      novoSaldo -= qtd;
      const disponivel = await linhaEstoque(tx, estoque.produtoId);
      await tx.estoque.update({ where: { id: disponivel.id }, data: { quantidade: { increment: qtd } } });
      codigo = await gerarCodigoRequisicao(tx, 'RE');
    } else if (['Entrada de mercadoria', 'Devolução VIAPRO', 'Ajuste de Entrada de Inventário'].includes(tipoAcao)) {
      novoSaldo += qtd;
      codigo = await gerarCodigoRequisicao(tx, 'RE');
    } else if (['Saída de mercadoria', 'Ajuste de Saída de Inventário', 'Saída para demonstração', 'Perdas/Avarias'].includes(tipoAcao)) {
      if (estoque.quantidade < qtd) throw new Error('Saldo insuficiente no armazém.');
      novoSaldo -= qtd;
      codigo = await gerarCodigoRequisicao(tx, 'RS');
      if (tipoAcao === 'Saída para demonstração') {
        await tx.estoque.create({ data: { produtoId: estoque.produtoId, quantidade: qtd, status: STATUS.DEMONSTRACAO, responsavelId: usuarioId } });
      }
      if (tipoAcao === 'Perdas/Avarias') {
        const ruptura = await linhaEstoque(tx, estoque.produtoId, STATUS.RUPTURA);
        await tx.estoque.update({ where: { id: ruptura.id }, data: { quantidade: { increment: qtd } } });
      }
    } else {
      throw new Error('Tipo de ação não reconhecido.');
    }

    await tx.estoque.update({ where: { id: estoque.id }, data: { quantidade: novoSaldo } });
    return tx.movimentacao.create({
      data: { produtoId: produtoId || estoque.produtoId, usuarioId, quantidade: qtd, tipoAcao, codigo, observacao: observacao || `${tipoAcao} registrada.` },
    });
  });
  return res.status(201).json(resultado);
});

/** Produção pela receita (composição) cadastrada no catálogo. */
router.post('/producao/executar', async (req, res) => {
  const { produtoFinalId } = req.body || {};
  const usuarioId = usuarioDaRequisicao(req);
  const quantidadeProduzir = Math.round(num(req.body?.quantidadeProduzir));
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  if (quantidadeProduzir <= 0) throw badRequest('A quantidade a produzir deve ser maior que zero.');

  const resultado = await prisma.$transaction(async tx => {
    const composicao = await tx.composicao.findMany({ where: { produtoPaiId: produtoFinalId }, include: { produtoFilho: true } });
    if (composicao.length === 0) throw new Error('Produto sem receita configurada.');
    const codigoSaida = await gerarCodigoRequisicao(tx, 'RS');

    for (const item of composicao) {
      const necessario = item.quantidade * quantidadeProduzir;
      const estoqueItem = await tx.estoque.findFirst({ where: { produtoId: item.produtoFilhoId, status: STATUS.DISPONIVEL } });
      if (!estoqueItem || estoqueItem.quantidade < necessario) {
        throw new Error(`Estoque insuficiente de [${item.produtoFilho.sku}] ${item.produtoFilho.nome}: necessário ${necessario}, disponível ${estoqueItem?.quantidade ?? 0}.`);
      }
      await tx.estoque.update({ where: { id: estoqueItem.id }, data: { quantidade: { decrement: necessario } } });
      await tx.movimentacao.create({
        data: { produtoId: item.produtoFilhoId, usuarioId, quantidade: necessario, tipoAcao: 'Saída para produção', codigo: codigoSaida, observacao: 'Matéria-prima consumida' },
      });
    }

    const final = await linhaEstoque(tx, produtoFinalId);
    await tx.estoque.update({ where: { id: final.id }, data: { quantidade: { increment: quantidadeProduzir } } });
    const codigo = await gerarCodigoRequisicao(tx, 'RE');
    await tx.movimentacao.create({
      data: { produtoId: produtoFinalId, usuarioId, quantidade: quantidadeProduzir, tipoAcao: 'Entrada por produção', codigo, observacao: `Lote de produção finalizado (consumo ${codigoSaida}).` },
    });
    return { success: true, mensagem: `Produção finalizada com sucesso (${codigo}).` };
  });
  return res.json(resultado);
});

export default router;
