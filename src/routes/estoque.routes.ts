import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, dataOuNull, num } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import {
  STATUS, TIPOS_ENTRADA, TIPOS_SAIDA, armazemPadrao, entradaEstoque, garantirEstoqueDisponivel, gerarCodigoRequisicao,
  linhaEstoque, lotesFEFO, registrarMovimentos, saidaFEFO,
} from '../lib/estoque';

const router = Router();
const USUARIO_PUBLICO = { select: { id: true, nome: true, cargo: true } } as const;

router.get('/estoque', async (_req, res) => {
  await garantirEstoqueDisponivel();
  const inventario = await prisma.estoque.findMany({
    include: { produto: { include: { categoria: true } }, localizacao: true, responsavel: USUARIO_PUBLICO, armazem: true },
  });
  return res.json(inventario);
});

/** Cria saldo inicial. Se já existir a linha "Disponível" zerada (criada automaticamente), reaproveita. */
router.post('/estoque', async (req, res) => {
  const { produtoId, quantidade, status, localizacaoId, responsavelId, armazemId, lote, validade } = req.body || {};
  if (!produtoId) throw badRequest('Produto obrigatório.');
  const st = status || STATUS.DISPONIVEL;
  const arm = armazemId || (await armazemPadrao());
  const existente = await prisma.estoque.findFirst({ where: { produtoId, status: st, armazemId: arm, lote: lote || null } });
  if (existente && st === STATUS.DISPONIVEL && existente.quantidade === 0) {
    const atualizado = await prisma.estoque.update({
      where: { id: existente.id },
      data: { quantidade: Math.round(num(quantidade)), localizacaoId: localizacaoId || existente.localizacaoId, validade: dataOuNull(validade) ?? existente.validade },
    });
    return res.status(201).json(atualizado);
  }
  const novo = await prisma.estoque.create({
    data: {
      produtoId, quantidade: Math.round(num(quantidade)), status: st, localizacaoId: localizacaoId || null, responsavelId: responsavelId || null,
      armazemId: arm, lote: lote ? String(lote).trim().toUpperCase() : null, validade: dataOuNull(validade),
    },
  });
  return res.status(201).json(novo);
});

/** ✨ FASE 2: lotes disponíveis de um produto na ordem FEFO. ?produtoId=&armazemId= */
router.get('/estoque/lotes', async (req, res) => {
  const produtoId = String(req.query.produtoId || '');
  if (!produtoId) throw badRequest('Informe o produto.');
  const linhas = await lotesFEFO(prisma, produtoId, (req.query.armazemId as string) || null);
  return res.json(linhas.map(l => ({ estoqueId: l.id, lote: l.lote, validade: l.validade ?? l.produto.validade, quantidade: l.quantidade, armazemId: l.armazemId })));
});

/** ✨ FASE 2: entrada avulsa com armazém, lote e validade. */
router.post('/estoque/entrada', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  const { produtoId, armazemId, lote, observacao, tipoAcao } = req.body || {};
  const quantidade = Math.round(num(req.body?.quantidade));
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  if (!produtoId || quantidade <= 0) throw badRequest('Informe produto e quantidade.');
  const tipo = ['Entrada de mercadoria', 'Devolução VIAPRO', 'Ajuste de Entrada de Inventário'].includes(tipoAcao) ? tipoAcao : 'Entrada de mercadoria';

  const mov = await prisma.$transaction(async tx => {
    const parte = await entradaEstoque(tx, { produtoId, quantidade, armazemId, lote, validade: dataOuNull(req.body?.validade) });
    const codigo = await gerarCodigoRequisicao(tx, 'RE');
    await registrarMovimentos(tx, { produtoId, usuarioId, tipoAcao: tipo, codigo, observacao: observacao || `${tipo} registrada.` }, [parte]);
    return { codigo, ...parte };
  });
  return res.status(201).json(mov);
});

/** ✨ FASE 2: transferência entre armazéns, preservando lote e validade (FEFO na origem). */
router.post('/estoque/transferencia', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  const { produtoId, origemId, destinoId, lote, observacao } = req.body || {};
  const quantidade = Math.round(num(req.body?.quantidade));
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  if (!produtoId || !origemId || !destinoId || quantidade <= 0) throw badRequest('Informe produto, origem, destino e quantidade.');
  if (origemId === destinoId) throw badRequest('Origem e destino devem ser diferentes.');

  const resultado = await prisma.$transaction(async tx => {
    const [origem, destino, produto] = await Promise.all([
      tx.armazem.findUnique({ where: { id: origemId } }), tx.armazem.findUnique({ where: { id: destinoId } }), tx.produto.findUnique({ where: { id: produtoId } }),
    ]);
    if (!origem || !destino || !produto) throw new Error('Armazém ou produto não encontrado.');
    const codigo = await gerarCodigoRequisicao(tx, 'TR');
    const partes = await saidaFEFO(tx, { produtoId, quantidade, armazemId: origemId, lote, rotulo: `[${produto.sku}] em ${origem.nome}` });
    await registrarMovimentos(tx, { produtoId, usuarioId, tipoAcao: 'Transferência (saída)', codigo, observacao: `Para ${destino.nome}${observacao ? ` — ${observacao}` : ''}` }, partes);
    const entradas = [];
    for (const p of partes) entradas.push(await entradaEstoque(tx, { produtoId, quantidade: p.quantidade, armazemId: destinoId, lote: p.lote, validade: p.validade }));
    await registrarMovimentos(tx, { produtoId, usuarioId, tipoAcao: 'Transferência (entrada)', codigo, observacao: `De ${origem.nome}${observacao ? ` — ${observacao}` : ''}` }, entradas);
    return { codigo, partes };
  });
  return res.status(201).json(resultado);
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
  const { estoqueId, tipoAcao, observacao } = req.body || {};
  const usuarioId = usuarioDaRequisicao(req);
  const qtd = Math.round(num(req.body?.quantidade));
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  if (qtd <= 0) throw badRequest('Informe uma quantidade válida.');

  const resultado = await prisma.$transaction(async tx => {
    const estoque = await tx.estoque.findUnique({ where: { id: estoqueId } });
    if (!estoque) throw new Error('Estoque não encontrado.');
    const lugar = { armazemId: estoque.armazemId, lote: estoque.lote, validade: estoque.validade };
    let novoSaldo = estoque.quantidade;
    let codigo: string;

    if (tipoAcao === 'Retorno de demonstração') {
      if (estoque.status !== STATUS.DEMONSTRACAO) throw new Error('Selecione um item que esteja em demonstração.');
      if (estoque.quantidade < qtd) throw new Error('Quantidade maior que a registrada em demonstração.');
      novoSaldo -= qtd;
      await entradaEstoque(tx, { produtoId: estoque.produtoId, quantidade: qtd, ...lugar });
      codigo = await gerarCodigoRequisicao(tx, 'RE');
    } else if (['Entrada de mercadoria', 'Devolução VIAPRO', 'Ajuste de Entrada de Inventário'].includes(tipoAcao)) {
      novoSaldo += qtd;
      codigo = await gerarCodigoRequisicao(tx, 'RE');
    } else if (['Saída de mercadoria', 'Ajuste de Saída de Inventário', 'Saída para demonstração', 'Perdas/Avarias'].includes(tipoAcao)) {
      if (estoque.quantidade < qtd) throw new Error('Saldo insuficiente no armazém.');
      novoSaldo -= qtd;
      codigo = await gerarCodigoRequisicao(tx, 'RS');
      if (tipoAcao === 'Saída para demonstração') {
        await tx.estoque.create({ data: { produtoId: estoque.produtoId, quantidade: qtd, status: STATUS.DEMONSTRACAO, responsavelId: usuarioId, ...lugar } });
      }
      if (tipoAcao === 'Perdas/Avarias') {
        const ruptura = await linhaEstoque(tx, estoque.produtoId, STATUS.RUPTURA, lugar);
        await tx.estoque.update({ where: { id: ruptura.id }, data: { quantidade: { increment: qtd } } });
      }
    } else {
      throw new Error('Tipo de ação não reconhecido.');
    }

    await tx.estoque.update({ where: { id: estoque.id }, data: { quantidade: novoSaldo } });
    return tx.movimentacao.create({
      data: { produtoId: estoque.produtoId, usuarioId, quantidade: qtd, tipoAcao, codigo, observacao: observacao || `${tipoAcao} registrada.`, ...lugar },
    });
  });
  return res.status(201).json(resultado);
});

/** Produção pela receita (composição): consome matéria-prima por FEFO e dá entrada no acabado (com lote opcional). */
router.post('/producao/executar', async (req, res) => {
  const { produtoFinalId, armazemId, lote } = req.body || {};
  const usuarioId = usuarioDaRequisicao(req);
  const quantidadeProduzir = Math.round(num(req.body?.quantidadeProduzir));
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  if (quantidadeProduzir <= 0) throw badRequest('A quantidade a produzir deve ser maior que zero.');

  const resultado = await prisma.$transaction(async tx => {
    const composicao = await tx.composicao.findMany({ where: { produtoPaiId: produtoFinalId }, include: { produtoFilho: true } });
    if (composicao.length === 0) throw new Error('Produto sem receita configurada.');
    const codigoSaida = await gerarCodigoRequisicao(tx, 'RS');

    for (const item of composicao) {
      const partes = await saidaFEFO(tx, {
        produtoId: item.produtoFilhoId, quantidade: item.quantidade * quantidadeProduzir, armazemId, rotulo: `[${item.produtoFilho.sku}] ${item.produtoFilho.nome}`,
      });
      await registrarMovimentos(tx, { produtoId: item.produtoFilhoId, usuarioId, tipoAcao: 'Saída para produção', codigo: codigoSaida, observacao: 'Matéria-prima consumida' }, partes);
    }

    const parte = await entradaEstoque(tx, { produtoId: produtoFinalId, quantidade: quantidadeProduzir, armazemId, lote, validade: dataOuNull(req.body?.validade) });
    const codigo = await gerarCodigoRequisicao(tx, 'RE');
    await registrarMovimentos(tx, { produtoId: produtoFinalId, usuarioId, tipoAcao: 'Entrada por produção', codigo, observacao: `Lote de produção finalizado (consumo ${codigoSaida}).` }, [parte]);
    return { success: true, mensagem: `Produção finalizada com sucesso (${codigo}).` };
  });
  return res.json(resultado);
});

export default router;
