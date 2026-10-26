import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, notFound, num } from '../lib/http';
import { perfilDe, usuarioDaRequisicao } from '../lib/auth';
import { STATUS, garantirEstoqueDisponivel, gerarCodigoInventario, gerarCodigoRequisicao, linhaEstoque, saldosDisponiveis } from '../lib/estoque';

/**
 * ✨ NOVO MÓDULO: INVENTÁRIO (geral ou cíclico)
 * 1. Abre o inventário e "congela" o saldo do sistema de cada item (snapshot).
 * 2. Operadores informam a quantidade contada (contagem cega: o saldo do sistema fica oculto).
 * 3. Ao concluir, as diferenças viram movimentações de ajuste (RE/RS) com rastreabilidade.
 */
const router = Router();

router.get('/inventarios', async (_req, res) => {
  const lista = await prisma.inventario.findMany({
    include: { responsavel: { select: { nome: true } }, itens: { select: { quantidadeContada: true, saldoSistema: true } } },
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
  const saldos = await saldosDisponiveis();

  const inventario = await prisma.$transaction(async tx =>
    tx.inventario.create({
      data: {
        codigo: await gerarCodigoInventario(tx), descricao: descricao || null, tipo: tipo || 'Cíclico', cego: cego !== false, responsavelId,
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
      itens: { include: { produto: { select: { id: true, sku: true, nome: true, codigoBarras: true, enderecoLocalizacao: true, precoCusto: true, unidade: true } }, contadoPor: { select: { nome: true } } } },
    },
  });
  if (!inv) throw notFound('Inventário não encontrado.');

  // Contagem cega: o saldo do sistema só aparece para gestores (ou após a conclusão).
  const revelar = inv.status === 'Concluído' || !inv.cego || (req.query.revelar === '1' && (!req.usuario || perfilDe(req.usuario.cargo) === 'admin'));
  const itens = inv.itens
    .map(i => ({ ...i, saldoSistema: revelar ? i.saldoSistema : null }))
    .sort((a, b) => (a.produto.enderecoLocalizacao || 'ZZZ').localeCompare(b.produto.enderecoLocalizacao || 'ZZZ') || a.produto.nome.localeCompare(b.produto.nome));
  return res.json({ ...inv, itens, saldoRevelado: revelar });
});

router.put('/inventarios/:id/itens/:itemId', async (req, res) => {
  const inv = await prisma.inventario.findUnique({ where: { id: req.params.id } });
  if (!inv) throw notFound('Inventário não encontrado.');
  if (inv.status === 'Concluído' || inv.status === 'Cancelado') throw badRequest('Inventário encerrado.');

  const valor = req.body?.quantidadeContada;
  const quantidadeContada = valor === null || valor === '' || valor === undefined ? null : Math.max(0, Math.round(num(valor)));
  const item = await prisma.inventarioItem.update({
    where: { id: req.params.itemId },
    data: { quantidadeContada, contadoPorId: quantidadeContada === null ? null : usuarioDaRequisicao(req) || null, contadoEm: quantidadeContada === null ? null : new Date() },
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
      if (diferenca === 0) continue;

      const disponivel = await linhaEstoque(tx, item.produtoId, STATUS.DISPONIVEL);
      if (diferenca > 0) {
        codigoRE ??= await gerarCodigoRequisicao(tx, 'RE');
        await tx.estoque.update({ where: { id: disponivel.id }, data: { quantidade: { increment: diferenca } } });
        unidadesMais += diferenca;
      } else {
        codigoRS ??= await gerarCodigoRequisicao(tx, 'RS');
        const baixa = Math.min(-diferenca, disponivel.quantidade);
        await tx.estoque.update({ where: { id: disponivel.id }, data: { quantidade: { decrement: baixa } } });
        unidadesMenos += -diferenca;
      }
      await tx.movimentacao.create({
        data: {
          produtoId: item.produtoId, usuarioId, quantidade: Math.abs(diferenca),
          tipoAcao: diferenca > 0 ? 'Ajuste de Entrada de Inventário' : 'Ajuste de Saída de Inventário',
          codigo: diferenca > 0 ? codigoRE : codigoRS,
          observacao: `Inventário ${inv.codigo}: sistema ${item.saldoSistema}, contado ${contada}.`,
        },
      });
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
