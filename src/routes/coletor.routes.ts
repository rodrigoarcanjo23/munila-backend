// ✨ FASE 8: rotas usadas pelo app do coletor (ViaPro Coletor, Android nativo).
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { badRequest, notFound } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import { STATUS, TIPOS_CONSUMO, armazemPadrao, diasAtras, lotesFEFO } from '../lib/estoque';
import { normalizarEndereco, zonaDourada } from '../lib/armazem';
import { SELECT_PRODUTO_COLETA, coletaRoteirizada, type OrdemOnda } from './layout.routes';

const router = Router();
const SELECT_PRODUTO = { id: true, sku: true, nome: true, codigoBarras: true, unidade: true, enderecoLocalizacao: true, estoqueMinimo: true, categoria: { select: { nome: true } } } as const;
type ProdutoSel = Prisma.ProdutoGetPayload<{ select: typeof SELECT_PRODUTO }>;

/** Números da tela inicial do coletor. */
router.get('/coletor/resumo', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const [ordens, ondas, inventarios, movimentos, separadasHoje] = await Promise.all([
    prisma.ordemTransferencia.findMany({ where: { status: { in: ['Pendente', 'Em Separação'] }, tipo: 'SAIDA' }, select: { prioridade: true, ondaId: true } }),
    prisma.ondaSeparacao.count({ where: { status: { in: ['Aberta', 'Em separação'] } } }),
    prisma.inventario.findMany({ where: { status: { in: ['Aberto', 'Em contagem'] } }, select: { itens: { select: { quantidadeContada: true } } } }),
    usuarioId ? prisma.movimentacao.count({ where: { usuarioId, dataHora: { gte: hoje } } }) : Promise.resolve(0),
    usuarioId ? prisma.ordemTransferencia.findMany({ where: { separadorId: usuarioId, status: 'Concluída', concluidaEm: { gte: hoje } }, select: { _count: { select: { itens: true } } } }) : Promise.resolve([]),
  ]);
  return res.json({
    ordensSoltas: ordens.filter(o => !o.ondaId).length,
    urgentes: ordens.filter(o => o.prioridade === 'Urgente').length,
    ondasAbertas: ondas,
    inventariosAbertos: inventarios.length,
    itensAContar: inventarios.reduce((a, i) => a + i.itens.filter(x => x.quantidadeContada === null).length, 0),
    meuDia: { movimentos, ordens: separadasHoje.length, linhas: separadasHoje.reduce((a, o) => a + o._count.itens, 0) },
  });
});

/**
 * Consulta por qualquer código bipado: EAN ou SKU do produto, código de endereço ou número de lote.
 * Devolve o produto com saldo por lote e endereço, ou o conteúdo do endereço.
 */
router.get('/coletor/consulta', async (req, res) => {
  const codigo = String(req.query.codigo || '').trim();
  if (!codigo) throw badRequest('Bipe ou digite um código.');
  const armazemId = await armazemPadrao();

  let produto = await prisma.produto.findFirst({ where: { OR: [{ codigoBarras: codigo }, { sku: { equals: codigo, mode: 'insensitive' } }] }, select: SELECT_PRODUTO });
  let loteBipado: string | null = null;
  if (!produto) {
    const linha = await prisma.estoque.findFirst({ where: { lote: { equals: codigo, mode: 'insensitive' }, quantidade: { gt: 0 } }, select: { produtoId: true, lote: true } });
    if (linha) { produto = await prisma.produto.findUnique({ where: { id: linha.produtoId }, select: SELECT_PRODUTO }); loteBipado = linha.lote; }
  }
  if (produto) return res.json(await consultaProduto(produto, loteBipado, armazemId));

  // Endereço: cadastrado ou só escrito no produto
  const norm = normalizarEndereco(codigo);
  const locais = await prisma.localizacao.findMany();
  const local = locais.find(l => normalizarEndereco(l.codigo) === norm) ?? null;
  const produtosNoTexto = await prisma.produto.findMany({ where: { enderecoLocalizacao: { not: null } }, select: SELECT_PRODUTO });
  const pelaEtiqueta = produtosNoTexto.filter(p => normalizarEndereco(p.enderecoLocalizacao) === norm);
  if (!local && !pelaEtiqueta.length) throw notFound('Nenhum produto, lote ou endereço com este código.');

  const linhas = local ? await prisma.estoque.findMany({ where: { localizacaoId: local.id, status: STATUS.DISPONIVEL, quantidade: { gt: 0 } }, include: { produto: { select: SELECT_PRODUTO } } }) : [];
  const itens = new Map<string, { produto: (typeof linhas)[number]['produto']; quantidade: number; lotes: { lote: string | null; validade: Date | null; quantidade: number }[]; picking: boolean }>();
  for (const l of linhas) {
    const it = itens.get(l.produtoId) ?? { produto: l.produto, quantidade: 0, lotes: [], picking: normalizarEndereco(l.produto.enderecoLocalizacao) === norm };
    it.quantidade += l.quantidade; it.lotes.push({ lote: l.lote, validade: l.validade, quantidade: l.quantidade });
    itens.set(l.produtoId, it);
  }
  for (const p of pelaEtiqueta) if (!itens.has(p.id)) {
    const saldo = await prisma.estoque.aggregate({ where: { produtoId: p.id, status: STATUS.DISPONIVEL, armazemId }, _sum: { quantidade: true } });
    itens.set(p.id, { produto: p, quantidade: saldo._sum.quantidade ?? 0, lotes: [], picking: true });
  }
  return res.json({
    tipo: 'endereco',
    endereco: { codigo: local?.codigo ?? codigo.toUpperCase(), rua: local?.rua ?? null, modulo: local?.modulo ?? null, nivel: local?.nivel ?? null, tipo: local?.tipo ?? null, dourada: zonaDourada(local?.nivel), cadastrado: Boolean(local) },
    itens: [...itens.values()].map(i => ({ ...i, produto: { ...i.produto, categoria: i.produto.categoria?.nome ?? null } })),
  });
});

async function consultaProduto(produto: ProdutoSel, loteBipado: string | null, armazemId: string) {
  const [linhas, fefo, pedidos, ultima] = await Promise.all([
    prisma.estoque.findMany({ where: { produtoId: produto.id, quantidade: { gt: 0 } }, include: { localizacao: { select: { codigo: true } }, armazem: { select: { nome: true } } } }),
    lotesFEFO(prisma, produto.id, armazemId),
    prisma.pedidoCompra.aggregate({ where: { produtoId: produto.id, status: 'Pendente' }, _sum: { quantidade: true } }),
    prisma.movimentacao.findFirst({ where: { produtoId: produto.id, tipoAcao: { in: TIPOS_CONSUMO }, dataHora: { gte: diasAtras(365) } }, orderBy: { dataHora: 'desc' }, select: { dataHora: true } }),
  ]);
  const primeiroFefo = fefo[0]?.id ?? null;
  const soma = (st: string) => linhas.filter(l => l.status === st).reduce((a, l) => a + l.quantidade, 0);
  return {
    tipo: 'produto',
    loteBipado,
    produto: { ...produto, categoria: produto.categoria?.nome ?? null },
    disponivel: soma(STATUS.DISPONIVEL), demonstracao: soma(STATUS.DEMONSTRACAO), avaria: soma(STATUS.RUPTURA),
    emTransito: pedidos._sum.quantidade ?? 0,
    ultimaSaida: ultima?.dataHora ?? null,
    lotes: linhas.filter(l => l.status === STATUS.DISPONIVEL)
      .sort((a, b) => (a.validade?.getTime() ?? Infinity) - (b.validade?.getTime() ?? Infinity))
      .map(l => ({ lote: l.lote, validade: l.validade, quantidade: l.quantidade, endereco: l.localizacao?.codigo ?? produto.enderecoLocalizacao ?? null, armazem: l.armazem?.nome ?? null, primeiroASair: l.id === primeiroFefo })),
  };
}

/** Coleta de uma ordem de separação avulsa, no mesmo formato da onda (paradas em ordem de rota). */
router.get('/coletor/ordens/:id/coleta', async (req, res) => {
  const ordem = await prisma.ordemTransferencia.findUnique({
    where: { id: String(req.params.id) },
    include: { itens: { include: { produto: { select: SELECT_PRODUTO_COLETA } } }, solicitante: { select: { nome: true } } },
  });
  if (!ordem) throw notFound('Ordem não encontrada.');
  if (ordem.tipo !== 'SAIDA') throw badRequest('O coletor separa ordens de saída. Entradas e devoluções são feitas pelo recebimento.');
  const { rota, coleta } = await coletaRoteirizada(prisma, [ordem as unknown as OrdemOnda], null, () => 'A', ordem.armazemId);
  return res.json({
    id: ordem.id, codigo: ordem.codigo, status: ordem.status, tipo: 'ordem',
    ordens: [{ id: ordem.id, codigo: ordem.codigo, status: ordem.status, prioridade: ordem.prioridade, solicitante: ordem.solicitante?.nome ?? '-', tote: 'A', linhas: ordem.itens.length, unidades: ordem.itens.reduce((a, i) => a + i.quantidade, 0) }],
    coleta,
    rota: { distancia: rota.distancia, semPosicao: rota.semPosicao },
  });
});

export default router;
