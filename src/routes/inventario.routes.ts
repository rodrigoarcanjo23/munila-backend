import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, notFound, num } from '../lib/http';
import { perfilDe, usuarioDaRequisicao } from '../lib/auth';
import { dataOuNull } from '../lib/http';
import { STATUS, armazemPadrao, entradaEstoque, garantirEstoqueDisponivel, gerarCodigoInventario, gerarCodigoRequisicao, linhaEstoque, registrarMovimentos, saidaFEFO, saldosDisponiveis } from '../lib/estoque';

/**
 * ✨ NOVO MÓDULO: INVENTÁRIO (geral ou cíclico)
 * 1. Abre o inventário e "congela" o saldo do sistema de cada item (snapshot).
 * 2. Operadores informam a quantidade contada (contagem cega: o saldo do sistema fica oculto).
 * 3. Ao concluir, as diferenças viram movimentações de ajuste (RE/RS) com rastreabilidade.
 */
const router = Router();

router.get('/inventarios', async (_req, res) => {
  const lista = await prisma.inventario.findMany({
    include: { responsavel: { select: { nome: true } }, armazem: true, itens: { select: { quantidadeContada: true, saldoSistema: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(lista.map(({ itens, ...inv }) => ({
    ...inv,
    totalItens: itens.length,
    contados: itens.filter(i => i.quantidadeContada !== null).length,
    divergentes: itens.filter(i => i.quantidadeContada !== null && i.quantidadeContada !== i.saldoSistema).length,
  })));
});

router.post('/inventarios', async (req, res) => {
  const { descricao, tipo, cego, categoriaId, produtoIds, enderecoPrefixo } = req.body || {};
  const armazemId = req.body?.armazemId || (await armazemPadrao());
  const responsavelId = usuarioDaRequisicao(req) || null;
  await garantirEstoqueDisponivel();

  const produtos = await prisma.produto.findMany({
    where: {
      ...(Array.isArray(produtoIds) && produtoIds.length ? { id: { in: produtoIds } } : {}),
      ...(categoriaId ? { categoriaId } : {}),
      ...(enderecoPrefixo ? { enderecoLocalizacao: { startsWith: String(enderecoPrefixo), mode: 'insensitive' as const } } : {}),
    },
    select: { id: true },
  });
  if (produtos.length === 0) throw badRequest('Nenhum produto atende aos filtros escolhidos.');
  const saldos = await saldosDisponiveis(prisma, armazemId);

  const inventario = await prisma.$transaction(async tx =>
    tx.inventario.create({
      data: {
        codigo: await gerarCodigoInventario(tx), descricao: descricao || null, tipo: tipo || 'Cíclico', cego: cego !== false, responsavelId, armazemId,
        itens: { create: produtos.map(p => ({ produtoId: p.id, saldoSistema: saldos.get(p.id) ?? 0 })) },
      },
    }),
  );
  return res.status(201).json(inventario);
});

router.get('/inventarios/:id', async (req, res) => {
  const inv = await prisma.inventario.findUnique({
    where: { id: req.params.id },
    include: {
      responsavel: { select: { nome: true } },
      armazem: true,
      itens: { include: { produto: { select: { id: true, sku: true, nome: true, codigoBarras: true, enderecoLocalizacao: true, precoCusto: true, unidade: true } }, contadoPor: { select: { nome: true } } } },
    },
  });
  if (!inv) throw notFound('Inventário não encontrado.');

  // Contagem cega: o saldo do sistema só aparece para gestores (ou após a conclusão).
  const revelar = inv.status === 'Concluído' || !inv.cego || (req.query.revelar === '1' && (!req.usuario || perfilDe(req.usuario.cargo) === 'admin'));
  // ✨ FASE 2: lotes existentes no armazém (para contagem por lote). Quantidades só aparecem se o saldo estiver revelado.
  const linhasLote = await prisma.estoque.findMany({
    where: { produtoId: { in: inv.itens.map(i => i.produtoId) }, status: STATUS.DISPONIVEL, armazemId: inv.armazemId ?? undefined, quantidade: { gt: 0 } },
    select: { produtoId: true, lote: true, validade: true, quantidade: true },
  });
  const itens = inv.itens
    .map(i => ({
      ...i, saldoSistema: revelar ? i.saldoSistema : null,
      lotes: linhasLote.filter(l => l.produtoId === i.produtoId).map(l => ({ lote: l.lote, validade: l.validade, quantidade: revelar ? l.quantidade : null })),
    }))
    .sort((a, b) => (a.produto.enderecoLocalizacao || 'ZZZ').localeCompare(b.produto.enderecoLocalizacao || 'ZZZ') || a.produto.nome.localeCompare(b.produto.nome));
  return res.json({ ...inv, itens, saldoRevelado: revelar });
});

router.put('/inventarios/:id/itens/:itemId', async (req, res) => {
  const inv = await prisma.inventario.findUnique({ where: { id: req.params.id } });
  if (!inv) throw notFound('Inventário não encontrado.');
  if (inv.status === 'Concluído' || inv.status === 'Cancelado') throw badRequest('Inventário encerrado.');

  // ✨ FASE 2: contagem por lote — a quantidade do item é a soma dos lotes
  const lotes: { lote: string; validade?: string | null; quantidade: number }[] | null = Array.isArray(req.body?.lotesContados)
    ? req.body.lotesContados.filter((l: any) => l && l.quantidade !== undefined && l.quantidade !== '')
        .map((l: any) => ({ lote: l.lote ? String(l.lote).trim().toUpperCase() : '', validade: l.validade || null, quantidade: Math.max(0, Math.round(num(l.quantidade))) }))
    : null;
  const valor = lotes ? lotes.reduce((a, l) => a + l.quantidade, 0) : req.body?.quantidadeContada;
  const quantidadeContada = valor === null || valor === '' || valor === undefined ? null : Math.max(0, Math.round(num(valor)));
  const item = await prisma.inventarioItem.update({
    where: { id: req.params.itemId },
    data: { quantidadeContada, lotesContados: lotes ?? undefined, contadoPorId: quantidadeContada === null ? null : usuarioDaRequisicao(req) || null, contadoEm: quantidadeContada === null ? null : new Date() },
  });
  if (inv.status === 'Aberto') await prisma.inventario.update({ where: { id: inv.id }, data: { status: 'Em contagem' } });
  return res.json({ ...item, saldoSistema: inv.cego ? null : item.saldoSistema });
});

router.post('/inventarios/:id/concluir', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  const considerarNaoContadosComoZero = Boolean(req.body?.zerarNaoContados);

  const resumo = await prisma.$transaction(async tx => {
    const inv = await tx.inventario.findUnique({ where: { id: req.params.id }, include: { itens: true } });
    if (!inv) throw new Error('Inventário não encontrado.');
    if (inv.status === 'Concluído' || inv.status === 'Cancelado') throw new Error('Inventário já encerrado.');

    let codigoRE: string | null = null;
    let codigoRS: string | null = null;
    let ajustes = 0, unidadesMais = 0, unidadesMenos = 0;

    for (const item of inv.itens) {
      const contada = item.quantidadeContada ?? (considerarNaoContadosComoZero ? 0 : null);
      if (contada === null) continue;
      const diferenca = contada - item.saldoSistema;
      const lotes = Array.isArray(item.lotesContados) ? (item.lotesContados as { lote: string; validade?: string | null; quantidade: number }[]) : null;
      if (diferenca === 0 && !lotes?.length) continue;
      const base = { produtoId: item.produtoId, usuarioId, observacao: `Inventário ${inv.codigo}: sistema ${item.saldoSistema}, contado ${contada}.` };

      if (lotes && lotes.length) {
        // Contagem por lote: cada lote passa a ter exatamente o contado; lotes não contados no armazém ficam zerados.
        const atuais = await tx.estoque.findMany({ where: { produtoId: item.produtoId, status: STATUS.DISPONIVEL, armazemId: inv.armazemId ?? undefined } });
        const alvo = new Map(lotes.map(l => [l.lote, l]));
        for (const linha of atuais) if (!alvo.has(linha.lote || '') && linha.quantidade > 0) alvo.set(linha.lote || '', { lote: linha.lote || '', quantidade: 0 });
        for (const l of alvo.values()) {
          const linha = await linhaEstoque(tx, item.produtoId, STATUS.DISPONIVEL, { armazemId: inv.armazemId, lote: l.lote || null, validade: dataOuNull(l.validade) });
          const d = l.quantidade - linha.quantidade;
          if (d === 0) continue;
          await tx.estoque.update({ where: { id: linha.id }, data: { quantidade: l.quantidade } });
          if (d > 0) { codigoRE ??= await gerarCodigoRequisicao(tx, 'RE'); unidadesMais += d; } else { codigoRS ??= await gerarCodigoRequisicao(tx, 'RS'); unidadesMenos += -d; }
          await registrarMovimentos(tx, { ...base, tipoAcao: d > 0 ? 'Ajuste de Entrada de Inventário' : 'Ajuste de Saída de Inventário', codigo: d > 0 ? codigoRE : codigoRS },
            [{ estoqueId: linha.id, lote: linha.lote, validade: linha.validade, quantidade: Math.abs(d), armazemId: linha.armazemId }]);
        }
      } else if (diferenca > 0) {
        codigoRE ??= await gerarCodigoRequisicao(tx, 'RE');
        const parte = await entradaEstoque(tx, { produtoId: item.produtoId, quantidade: diferenca, armazemId: inv.armazemId });
        await registrarMovimentos(tx, { ...base, tipoAcao: 'Ajuste de Entrada de Inventário', codigo: codigoRE }, [parte]);
        unidadesMais += diferenca;
      } else {
        codigoRS ??= await gerarCodigoRequisicao(tx, 'RS');
        const disponivel = (await saldosDisponiveis(tx, inv.armazemId)).get(item.produtoId) ?? 0;
        const baixa = Math.min(-diferenca, disponivel);
        const partes = baixa > 0 ? await saidaFEFO(tx, { produtoId: item.produtoId, quantidade: baixa, armazemId: inv.armazemId }) : [];
        await registrarMovimentos(tx, { ...base, tipoAcao: 'Ajuste de Saída de Inventário', codigo: codigoRS }, partes);
        unidadesMenos += -diferenca;
      }
      await tx.inventarioItem.update({ where: { id: item.id }, data: { ajustado: true, quantidadeContada: contada } });
      ajustes++;
    }

    await tx.inventario.update({ where: { id: inv.id }, data: { status: 'Concluído', concluidoEm: new Date() } });
    return { codigo: inv.codigo, ajustes, unidadesMais, unidadesMenos, codigoRE, codigoRS };
  });
  return res.json(resumo);
});

router.delete('/inventarios/:id', async (req, res) => {
  const inv = await prisma.inventario.findUnique({ where: { id: req.params.id } });
  if (!inv) throw notFound('Inventário não encontrado.');
  if (inv.status === 'Concluído') throw badRequest('Inventário concluído não pode ser cancelado.');
  await prisma.inventario.update({ where: { id: inv.id }, data: { status: 'Cancelado' } });
  return res.status(204).send();
});

export default router;
