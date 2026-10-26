import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { num } from '../lib/http';
import {
  STATUS, TIPOS_CONSUMO, consumoPorProduto, diasAtras, ehEntrada, estoqueMinimoDe, garantirEstoqueDisponivel, saldosDisponiveis,
} from '../lib/estoque';

const router = Router();

/** Data AAAA-MM-DD no fuso de Brasília (o servidor do Render roda em UTC). */
const diaBR = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

/** Mantido para o app mobile. */
router.get('/dashboard/resumo', async (_req, res) => {
  const [totalProdutos, estoques, ruptura] = await Promise.all([
    prisma.produto.count(),
    prisma.estoque.findMany({ include: { produto: { select: { precoCusto: true } } } }),
    prisma.estoque.aggregate({ where: { status: STATUS.RUPTURA }, _sum: { quantidade: true } }),
  ]);
  const custoTotal = estoques.reduce((acc, e) => acc + e.quantidade * (e.produto?.precoCusto || 0), 0);
  return res.json({ totalItensCadastrados: totalProdutos, custoTotal, totalRupturas: ruptura._sum.quantidade || 0 });
});

/** ✨ NOVO: painel executivo (KPIs, séries e alertas calculados no servidor). */
router.get('/dashboard/painel', async (req, res) => {
  const dias = Math.min(180, Math.max(7, num(req.query.dias, 30)));
  await garantirEstoqueDisponivel();
  const inicioPeriodo = diasAtras(dias - 1);
  const inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const hoje = new Date();
  const em30 = new Date(Date.now() + 30 * 86400000);

  const [produtos, estoques, movsPeriodo, pedidos, ordens, inventariosAbertos, perdasMes] = await Promise.all([
    prisma.produto.findMany({ include: { categoria: true } }),
    prisma.estoque.findMany(),
    prisma.movimentacao.findMany({ where: { dataHora: { gte: inicioPeriodo } }, select: { produtoId: true, quantidade: true, tipoAcao: true, dataHora: true } }),
    prisma.pedidoCompra.findMany({ where: { status: 'Pendente' }, select: { custoTotal: true, dataPrevisao: true } }),
    prisma.ordemTransferencia.findMany({ select: { status: true, prioridade: true, iniciadaEm: true, concluidaEm: true, createdAt: true } }),
    prisma.inventario.count({ where: { status: { in: ['Aberto', 'Em contagem'] } } }),
    prisma.movimentacao.findMany({ where: { tipoAcao: 'Perdas/Avarias', dataHora: { gte: inicioMes } }, include: { produto: { select: { precoCusto: true } } } }),
  ]);
  const prodMap = new Map(produtos.map(p => [p.id, p]));

  // ---- Estoque
  let unidades = 0, valorCusto = 0, valorVenda = 0, criticos = 0, zerados = 0, rupturaQtd = 0, rupturaValor = 0, demonstracao = 0;
  const saldoPorProduto = new Map<string, number>();
  for (const e of estoques) {
    const p = prodMap.get(e.produtoId);
    if (!p) continue;
    if (e.status === STATUS.DISPONIVEL) saldoPorProduto.set(p.id, (saldoPorProduto.get(p.id) || 0) + e.quantidade);
    if (e.status === STATUS.RUPTURA) { rupturaQtd += e.quantidade; rupturaValor += e.quantidade * (p.precoCusto || 0); continue; }
    if (e.status === STATUS.DEMONSTRACAO) demonstracao += e.quantidade;
    unidades += e.status === STATUS.DISPONIVEL ? e.quantidade : 0;
    valorCusto += e.quantidade * (p.precoCusto || 0);
    valorVenda += e.quantidade * (p.precoVenda || 0);
  }
  for (const p of produtos) {
    const saldo = saldoPorProduto.get(p.id) || 0;
    if (saldo <= 0) zerados++;
    if (saldo <= estoqueMinimoDe(p)) criticos++;
  }

  // ---- Valor por categoria
  const porCategoria = new Map<string, number>();
  for (const p of produtos) {
    const v = (saldoPorProduto.get(p.id) || 0) * (p.precoCusto || 0);
    const nome = p.categoria?.nome || 'Sem categoria';
    porCategoria.set(nome, (porCategoria.get(nome) || 0) + v);
  }

  // ---- Série diária de entradas/saídas
  const serie: Record<string, { data: string; entradas: number; saidas: number }> = {};
  for (let i = 0; i < dias; i++) {
    const d = new Date(inicioPeriodo); d.setDate(d.getDate() + i); d.setHours(12);
    const k = diaBR(d);
    serie[k] = { data: k, entradas: 0, saidas: 0 };
  }
  const consumo = new Map<string, number>();
  for (const m of movsPeriodo) {
    const k = diaBR(new Date(m.dataHora));
    if (!serie[k]) continue;
    if (ehEntrada(m.tipoAcao)) serie[k].entradas += m.quantidade; else serie[k].saidas += m.quantidade;
    if (TIPOS_CONSUMO.includes(m.tipoAcao)) consumo.set(m.produtoId, (consumo.get(m.produtoId) || 0) + m.quantidade);
  }
  const topSaidas = [...consumo.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([id, qtd]) => ({ produtoId: id, nome: prodMap.get(id)?.nome || '-', sku: prodMap.get(id)?.sku || '-', quantidade: qtd }));

  // ---- Validade
  let vencidos = 0, vencendo30 = 0;
  for (const p of produtos) {
    if (!p.validade || (saldoPorProduto.get(p.id) || 0) <= 0) continue;
    if (p.validade < hoje) vencidos++; else if (p.validade <= em30) vencendo30++;
  }

  // ---- Compras e WMS
  const caixaComprometido = pedidos.reduce((a, p) => a + p.custoTotal, 0);
  const hoje0 = new Date(); hoje0.setHours(0, 0, 0, 0);
  const pedidosAtrasados = pedidos.filter(p => p.dataPrevisao && p.dataPrevisao < hoje0).length;
  const concluidas = ordens.filter(o => o.status === 'Concluída' && o.concluidaEm && o.iniciadaEm);
  const tempoMedioSeparacaoMin = concluidas.length
    ? Math.round(concluidas.reduce((a, o) => a + (o.concluidaEm!.getTime() - o.iniciadaEm!.getTime()), 0) / concluidas.length / 60000)
    : null;

  const kpis = {
    totalProdutos: produtos.length, unidades, valorCusto, valorVenda, margemPotencial: valorVenda - valorCusto,
    criticos, zerados, rupturaQtd, rupturaValor, demonstracao,
    perdasMes: perdasMes.reduce((a, m) => a + m.quantidade * (m.produto?.precoCusto || 0), 0),
    caixaComprometido, pedidosPendentes: pedidos.length, pedidosAtrasados,
    osPendentes: ordens.filter(o => o.status === 'Pendente').length,
    osEmSeparacao: ordens.filter(o => o.status === 'Em Separação').length,
    osUrgentes: ordens.filter(o => o.status !== 'Concluída' && o.prioridade === 'Urgente').length,
    osConcluidasPeriodo: ordens.filter(o => o.status === 'Concluída' && o.concluidaEm && o.concluidaEm >= inicioPeriodo).length,
    tempoMedioSeparacaoMin, inventariosAbertos, vencidos, vencendo30,
  };

  const alertas: { nivel: 'critico' | 'atencao' | 'info'; titulo: string; rota: string }[] = [];
  if (zerados) alertas.push({ nivel: 'critico', titulo: `${zerados} produto(s) com saldo zerado`, rota: '/estoque?filtro=zerado' });
  if (criticos) alertas.push({ nivel: 'atencao', titulo: `${criticos} produto(s) abaixo do estoque mínimo`, rota: '/compras/sugestao' });
  if (vencidos) alertas.push({ nivel: 'critico', titulo: `${vencidos} produto(s) vencido(s) com saldo`, rota: '/validade' });
  if (vencendo30) alertas.push({ nivel: 'atencao', titulo: `${vencendo30} produto(s) vencem em até 30 dias`, rota: '/validade' });
  if (kpis.osUrgentes) alertas.push({ nivel: 'critico', titulo: `${kpis.osUrgentes} ordem(ns) urgente(s) em aberto`, rota: '/separacao' });
  if (pedidosAtrasados) alertas.push({ nivel: 'atencao', titulo: `${pedidosAtrasados} pedido(s) de compra atrasado(s)`, rota: '/compras' });
  if (inventariosAbertos) alertas.push({ nivel: 'info', titulo: `${inventariosAbertos} inventário(s) em andamento`, rota: '/inventario' });

  return res.json({
    dias, kpis, alertas, topSaidas,
    serie: Object.values(serie),
    valorPorCategoria: [...porCategoria.entries()].map(([categoria, valor]) => ({ categoria, valor })).filter(c => c.valor > 0).sort((a, b) => b.valor - a.valor),
  });
});

/**
 * ✨ NOVO: CURVA ABC + giro + cobertura.
 * ?dias=90&criterio=valor|quantidade&corteA=80&corteB=95
 */
router.get('/gerencial/curva-abc', async (req, res) => {
  const dias = Math.max(7, num(req.query.dias, 90));
  const criterio = req.query.criterio === 'quantidade' ? 'quantidade' : 'valor';
  const corteA = num(req.query.corteA, 80);
  const corteB = num(req.query.corteB, 95);

  const [produtos, consumo, saldos] = await Promise.all([
    prisma.produto.findMany({ include: { categoria: true } }),
    consumoPorProduto(diasAtras(dias)),
    saldosDisponiveis(),
  ]);

  const base = produtos.map(p => {
    const qtd = consumo.get(p.id) || 0;
    const custo = p.precoCusto || 0;
    const saldo = saldos.get(p.id) || 0;
    const consumoDiario = qtd / dias;
    return {
      produtoId: p.id, sku: p.sku, nome: p.nome, categoria: p.categoria?.nome || '-',
      quantidade: qtd, valor: qtd * custo, custoUnitario: custo, saldo,
      giro: saldo > 0 ? Number((qtd / saldo).toFixed(2)) : null,
      coberturaDias: consumoDiario > 0 ? Math.floor(saldo / consumoDiario) : null,
    };
  });
  const total = base.reduce((a, b) => a + (criterio === 'valor' ? b.valor : b.quantidade), 0);
  base.sort((a, b) => (criterio === 'valor' ? b.valor - a.valor : b.quantidade - a.quantidade));

  let acumulado = 0;
  const itens = base.map(b => {
    const v = criterio === 'valor' ? b.valor : b.quantidade;
    const participacao = total > 0 ? (v / total) * 100 : 0;
    const anterior = acumulado;
    acumulado += participacao;
    const classe = v <= 0 ? 'C' : anterior < corteA ? 'A' : anterior < corteB ? 'B' : 'C';
    return { ...b, participacao: Number(participacao.toFixed(2)), acumulado: Number(acumulado.toFixed(2)), classe };
  });

  const resumo = ['A', 'B', 'C'].map(c => {
    const grupo = itens.filter(i => i.classe === c);
    return { classe: c, itens: grupo.length, valor: grupo.reduce((a, i) => a + i.valor, 0), quantidade: grupo.reduce((a, i) => a + i.quantidade, 0) };
  });
  return res.json({ parametros: { dias, criterio, corteA, corteB }, total, resumo, itens });
});

/** ✨ NOVO: controle de validade (produtos com data de validade e saldo). */
router.get('/gerencial/validade', async (_req, res) => {
  const [produtos, saldos] = await Promise.all([
    prisma.produto.findMany({ where: { validade: { not: null } }, include: { categoria: true } }),
    saldosDisponiveis(),
  ]);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const itens = produtos
    .map(p => {
      const dias = Math.floor((p.validade!.getTime() - hoje.getTime()) / 86400000);
      const saldo = saldos.get(p.id) || 0;
      return {
        produtoId: p.id, sku: p.sku, nome: p.nome, lote: p.lote, categoria: p.categoria?.nome || '-', endereco: p.enderecoLocalizacao,
        validade: p.validade, diasParaVencer: dias, saldo, valor: saldo * (p.precoCusto || 0),
        faixa: dias < 0 ? 'Vencido' : dias <= 30 ? 'Até 30 dias' : dias <= 60 ? '31 a 60 dias' : dias <= 90 ? '61 a 90 dias' : 'Acima de 90 dias',
      };
    })
    .sort((a, b) => a.diasParaVencer - b.diasParaVencer);
  return res.json(itens);
});

export default router;
