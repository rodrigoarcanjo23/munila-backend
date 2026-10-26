import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { num } from '../lib/http';
import { media, desvio, previsaoHolt } from '../lib/previsao';
import { STATUS, TIPOS_CONSUMO, TIPOS_TRANSFERENCIA, ehEntrada, estoqueMinimoDe, garantirEstoqueDisponivel } from '../lib/estoque';

// ============================================================
// ✨ PAINEL BI — análises de logística e PCP calculadas no servidor.
// GET /bi/painel?dias=90&armazemId=&categoriaId=
// Nada aqui grava no banco: é só leitura dos dados que o sistema já registra.
// ============================================================

const router = Router();
const DIA = 86400000;
const Z_95 = 1.65; // nível de serviço de 95% para o estoque de segurança
const LEAD_PADRAO = 7;

const fmtBRL = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const r1 = (v: number) => Math.round(v * 10) / 10;
const pctBR = (v: number) => `${r1(v).toLocaleString('pt-BR')}%`;
const r2 = (v: number) => Math.round(v * 100) / 100;
const mediana = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Dia da semana (0 = domingo) e hora no fuso de Brasília. */
const partesBR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
const DIAS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function diaHoraBR(d: Date) {
  const p = partesBR.formatToParts(d);
  return { dia: DIAS_EN.indexOf(p.find(x => x.type === 'weekday')!.value), hora: Number(p.find(x => x.type === 'hour')!.value) % 24 };
}

router.get('/bi/painel', async (req, res) => {
  const semanasPedidas = Math.ceil(Math.min(364, Math.max(28, num(req.query.dias, 90))) / 7);
  // Se o histórico for mais curto que o período pedido, usa só as semanas que existem (senão a média diária fica diluída).
  const primeiro = (await prisma.movimentacao.aggregate({ _min: { dataHora: true } }))._min.dataHora;
  const semanasHistorico = primeiro ? Math.max(4, Math.ceil((Date.now() - primeiro.getTime()) / (7 * DIA))) : semanasPedidas;
  const semanas = Math.min(semanasPedidas, semanasHistorico);
  const dias = semanas * 7;
  const armazemId = req.query.armazemId ? String(req.query.armazemId) : null;
  const categoriaId = req.query.categoriaId ? String(req.query.categoriaId) : null;

  await garantirEstoqueDisponivel();
  const agora = new Date();
  const hoje0 = new Date(); hoje0.setHours(0, 0, 0, 0);
  const inicio = new Date(hoje0.getTime() - (dias - 1) * DIA);
  const fimSemana0 = hoje0.getTime() + DIA; // a semana 0 termina no fim de hoje

  const filtroArm = armazemId ? { armazemId } : {};
  const filtroProd = categoriaId ? { categoriaId } : {};

  const [produtos, armazens, estoques, movs, ultimasSaidas, pedidos, ordens, inventarios] = await Promise.all([
    prisma.produto.findMany({
      where: filtroProd,
      include: { categoria: true, fornecedor: { select: { id: true, nomeEmpresa: true } }, ingredientes: { include: { produtoFilho: { select: { id: true, nome: true, sku: true, precoCusto: true } } } } },
    }),
    prisma.armazem.findMany({ where: { ativo: true }, orderBy: { codigo: 'asc' } }),
    prisma.estoque.findMany({ where: { quantidade: { gt: 0 } } }),
    prisma.movimentacao.findMany({
      where: { dataHora: { gte: inicio }, ...filtroArm },
      select: { produtoId: true, quantidade: true, tipoAcao: true, dataHora: true, armazemId: true },
    }),
    prisma.movimentacao.groupBy({ by: ['produtoId'], where: { tipoAcao: { in: TIPOS_CONSUMO }, ...filtroArm }, _max: { dataHora: true } }),
    prisma.pedidoCompra.findMany({ include: { fornecedor: { select: { id: true, nomeEmpresa: true } } } }),
    prisma.ordemTransferencia.findMany({
      where: { status: 'Concluída', concluidaEm: { gte: inicio }, ...filtroArm },
      include: { separador: { select: { nome: true } }, _count: { select: { itens: true } } },
    }),
    prisma.inventario.findMany({
      where: { status: 'Concluído', concluidoEm: { gte: inicio }, ...filtroArm },
      include: { itens: { include: { produto: { select: { precoCusto: true } } } } },
      orderBy: { concluidoEm: 'desc' },
    }),
  ]);

  const prodIds = new Set(produtos.map(p => p.id));
  const custoDe = new Map<string, number>();
  // Custos de todos os produtos (componentes de receita podem estar fora do filtro de categoria).
  for (const p of await prisma.produto.findMany({ select: { id: true, precoCusto: true } })) custoDe.set(p.id, p.precoCusto || 0);
  const validadeCadastro = new Map(produtos.map(p => [p.id, p.validade]));

  // ---------------- Saldos (disponível, opcionalmente por armazém)
  const saldo = new Map<string, number>();
  const saldoArm = new Map<string, Map<string, number>>(); // produto -> armazém -> saldo
  let valorDemonstracao = 0, valorRuptura = 0;
  const hojeT = hoje0.getTime();
  const validade = { vencido: 0, ate30: 0, ate60: 0, ate90: 0, acima90: 0, semValidade: 0 };
  for (const e of estoques) {
    const c = custoDe.get(e.produtoId) || 0;
    if (e.status === STATUS.DISPONIVEL) {
      const porArm = saldoArm.get(e.produtoId) ?? new Map<string, number>();
      porArm.set(e.armazemId || '-', (porArm.get(e.armazemId || '-') || 0) + e.quantidade);
      saldoArm.set(e.produtoId, porArm);
    }
    if (armazemId && e.armazemId !== armazemId) continue;
    if (!prodIds.has(e.produtoId)) continue;
    if (e.status === STATUS.DEMONSTRACAO) { valorDemonstracao += e.quantidade * c; continue; }
    if (e.status === STATUS.RUPTURA) { valorRuptura += e.quantidade * c; continue; }
    saldo.set(e.produtoId, (saldo.get(e.produtoId) || 0) + e.quantidade);
    const val = e.validade ?? validadeCadastro.get(e.produtoId) ?? null;
    const v = e.quantidade * c;
    if (!val) validade.semValidade += v;
    else {
      const d = Math.floor((val.getTime() - hojeT) / DIA);
      if (d < 0) validade.vencido += v; else if (d <= 30) validade.ate30 += v; else if (d <= 60) validade.ate60 += v; else if (d <= 90) validade.ate90 += v; else validade.acima90 += v;
    }
  }

  // ---------------- Demanda semanal por produto, perdas, produção e mapa de calor
  const semanal = new Map<string, number[]>();
  const consumoArm = new Map<string, Map<string, number>>();
  const serieUn = Array(semanas).fill(0), serieValor = Array(semanas).fill(0), serieEntradas = Array(semanas).fill(0), serieProducao = Array(semanas).fill(0);
  const calor = Array.from({ length: 7 }, () => Array(24).fill(0));
  let perdasValor = 0, perdasUn = 0, produzidoUn = 0;
  const perdasPorProduto = new Map<string, number>();
  for (const m of movs) {
    if (!prodIds.has(m.produtoId)) continue;
    const idx = semanas - 1 - Math.floor((fimSemana0 - m.dataHora.getTime()) / (7 * DIA));
    if (idx < 0 || idx >= semanas) continue;
    const c = custoDe.get(m.produtoId) || 0;
    if (!TIPOS_TRANSFERENCIA.includes(m.tipoAcao)) {
      const { dia, hora } = diaHoraBR(m.dataHora);
      calor[dia][hora] += 1;
    }
    if (TIPOS_CONSUMO.includes(m.tipoAcao)) {
      const s = semanal.get(m.produtoId) ?? Array(semanas).fill(0);
      s[idx] += m.quantidade;
      semanal.set(m.produtoId, s);
      serieUn[idx] += m.quantidade;
      serieValor[idx] += m.quantidade * c;
      const ca = consumoArm.get(m.produtoId) ?? new Map<string, number>();
      ca.set(m.armazemId || '-', (ca.get(m.armazemId || '-') || 0) + m.quantidade);
      consumoArm.set(m.produtoId, ca);
    } else if (m.tipoAcao === 'Perdas/Avarias') {
      perdasValor += m.quantidade * c; perdasUn += m.quantidade;
      perdasPorProduto.set(m.produtoId, (perdasPorProduto.get(m.produtoId) || 0) + m.quantidade * c);
    } else if (m.tipoAcao === 'Entrada por produção') {
      serieProducao[idx] += m.quantidade; produzidoUn += m.quantidade;
    } else if (ehEntrada(m.tipoAcao) && !TIPOS_TRANSFERENCIA.includes(m.tipoAcao)) {
      serieEntradas[idx] += m.quantidade;
    }
  }

  // ---------------- Fornecedores: OTIF e lead time real
  const recebidos = pedidos.filter(p => p.status.startsWith('Recebido') && p.dataRecebimento);
  const leadReal = (p: typeof pedidos[number]) => Math.max(0, (p.dataRecebimento!.getTime() - p.createdAt.getTime()) / DIA);
  const noPrazo = (p: typeof pedidos[number]) => {
    if (!p.dataPrevisao) return null;
    const limite = new Date(p.dataPrevisao); limite.setHours(23, 59, 59, 999);
    return p.dataRecebimento! <= limite;
  };
  const completo = (p: typeof pedidos[number]) => (p.quantidadeRecebida ?? p.quantidade) >= p.quantidade;
  const leadPorFornecedor = new Map<string, number>();
  const fornAgg = new Map<string, { id: string; nome: string; pedidos: number; noPrazo: number; comPrazo: number; completos: number; otif: number; leads: number[]; valor: number; pendentes: number; atrasados: number }>();
  const aggDe = (id: string, nome: string) => {
    let a = fornAgg.get(id);
    if (!a) { a = { id, nome, pedidos: 0, noPrazo: 0, comPrazo: 0, completos: 0, otif: 0, leads: [], valor: 0, pendentes: 0, atrasados: 0 }; fornAgg.set(id, a); }
    return a;
  };
  for (const p of recebidos) {
    const a = aggDe(p.fornecedorId, p.fornecedor?.nomeEmpresa || '-');
    a.leads.push(leadReal(p)); // lead time usa todo o histórico
    if (p.dataRecebimento! < inicio) continue;
    a.pedidos++; a.valor += p.custoTotal;
    const np = noPrazo(p), cp = completo(p);
    if (np !== null) { a.comPrazo++; if (np) a.noPrazo++; }
    if (cp) a.completos++;
    if ((np ?? true) && cp) a.otif++;
  }
  const emTransito = new Map<string, number>();
  for (const p of pedidos.filter(x => x.status === 'Pendente')) {
    const a = aggDe(p.fornecedorId, p.fornecedor?.nomeEmpresa || '-');
    a.pendentes++;
    if (p.dataPrevisao && p.dataPrevisao < hoje0) a.atrasados++;
    emTransito.set(p.produtoId, (emTransito.get(p.produtoId) || 0) + p.quantidade);
  }
  for (const a of fornAgg.values()) { const m = mediana(a.leads); if (m !== null) leadPorFornecedor.set(a.id, m); }
  const fornecedores = [...fornAgg.values()]
    .filter(a => a.pedidos || a.pendentes)
    .map(a => ({
      id: a.id, nome: a.nome, pedidos: a.pedidos, valor: a.valor, pendentes: a.pendentes, atrasados: a.atrasados,
      noPrazoPct: a.comPrazo ? r1((a.noPrazo / a.comPrazo) * 100) : null,
      completoPct: a.pedidos ? r1((a.completos / a.pedidos) * 100) : null,
      otifPct: a.pedidos ? r1((a.otif / a.pedidos) * 100) : null,
      leadMedianoDias: mediana(a.leads) !== null ? r1(mediana(a.leads)!) : null,
      leadVariacaoDias: a.leads.length > 1 ? r1(desvio(a.leads)) : null,
    }))
    .sort((a, b) => b.valor - a.valor);
  const recPeriodo = recebidos.filter(p => p.dataRecebimento! >= inicio);
  const otifGeral = recPeriodo.length ? r1((recPeriodo.filter(p => (noPrazo(p) ?? true) && completo(p)).length / recPeriodo.length) * 100) : null;

  // ---------------- Métricas por produto
  const ultimaSaida = new Map(ultimasSaidas.map(u => [u.produtoId, u._max.dataHora]));
  const itens = produtos.map(p => {
    const custo = p.precoCusto || 0;
    const s = saldo.get(p.id) || 0;
    const sem = semanal.get(p.id) ?? Array(semanas).fill(0);
    const consumo = sem.reduce((a, b) => a + b, 0);
    const diario = consumo / dias;
    const mediaSem = consumo / semanas;
    const cv = mediaSem > 0 ? desvio(sem) / mediaSem : null;
    const xyz = cv === null ? null : cv <= 0.5 ? 'X' : cv <= 1 ? 'Y' : 'Z';
    const lead = p.leadTimeDias ?? (p.fornecedorId ? leadPorFornecedor.get(p.fornecedorId) : undefined) ?? LEAD_PADRAO;
    const sigmaDia = desvio(sem) / Math.sqrt(7);
    const seguranca = Math.ceil(Z_95 * sigmaDia * Math.sqrt(lead));
    const pontoPedido = Math.ceil(diario * lead + seguranca);
    const cobertura = diario > 0 ? s / diario : null;
    const transito = emTransito.get(p.id) || 0;
    const coberturaComPedidos = diario > 0 ? (s + transito) / diario : null;
    const ult = ultimaSaida.get(p.id) ?? null;
    const diasSemSaida = Math.floor((agora.getTime() - (ult ?? p.dataCadastro).getTime()) / DIA);
    const giro = s > 0 ? r2((diario * 365) / s) : null;
    // risco de ruptura: acaba antes de a reposição (já pedida ou não) conseguir chegar
    let risco: 'Rompido' | 'Crítico' | 'Atenção' | 'OK' | 'Sem demanda' = 'Sem demanda';
    if (diario > 0) {
      if (s <= 0) risco = 'Rompido';
      else if ((coberturaComPedidos ?? 0) < lead) risco = 'Crítico';
      else if ((cobertura ?? 0) < lead + 7 || s <= pontoPedido) risco = 'Atenção';
      else risco = 'OK';
    }
    const saude = s <= 0 ? 'Sem saldo' : diasSemSaida > 180 ? 'Obsoleto' : diasSemSaida > 60 ? 'Lento' : (cobertura ?? 0) > 90 ? 'Excesso' : 'Saudável';
    const excessoUn = cobertura !== null && cobertura > 90 ? Math.floor(s - diario * 90) : 0;
    return {
      produtoId: p.id, sku: p.sku, nome: p.nome, categoria: p.categoria?.nome || 'Sem categoria', fornecedor: p.fornecedor?.nomeEmpresa ?? null, unidade: p.unidade || 'UN',
      custo, saldo: s, valorEstoque: s * custo, consumo, consumoValor: consumo * custo, consumoDiario: r2(diario),
      semanal: sem, cv: cv === null ? null : r2(cv), xyz, abc: 'C' as 'A' | 'B' | 'C',
      leadTimeDias: r1(lead), estoqueSeguranca: seguranca, pontoPedido, estoqueMinimo: estoqueMinimoDe(p),
      coberturaDias: cobertura === null ? null : Math.floor(cobertura), coberturaComPedidosDias: coberturaComPedidos === null ? null : Math.floor(coberturaComPedidos),
      emTransito: transito, dataRuptura: cobertura !== null && s > 0 ? new Date(hojeT + Math.floor(cobertura) * DIA) : null,
      risco, giro, diasSemSaida, ultimaSaida: ult, saude, excessoUn, excessoValor: excessoUn * custo,
      perdasValor: perdasPorProduto.get(p.id) || 0,
    };
  });

  // Curva ABC pelo valor consumido (80 / 95)
  const totalConsumoValor = itens.reduce((a, i) => a + i.consumoValor, 0);
  let acum = 0;
  for (const i of [...itens].sort((a, b) => b.consumoValor - a.consumoValor)) {
    const antes = acum;
    acum += totalConsumoValor > 0 ? (i.consumoValor / totalConsumoValor) * 100 : 0;
    i.abc = i.consumoValor <= 0 ? 'C' : antes < 80 ? 'A' : antes < 95 ? 'B' : 'C';
  }
  const matriz = ['A', 'B', 'C'].flatMap(abc => ['X', 'Y', 'Z'].map(xyz => {
    const g = itens.filter(i => i.abc === abc && i.xyz === xyz);
    return { abc, xyz, itens: g.length, valorEstoque: g.reduce((a, i) => a + i.valorEstoque, 0), consumoValor: g.reduce((a, i) => a + i.consumoValor, 0) };
  }));
  const semDemanda = itens.filter(i => i.xyz === null);

  // ---------------- KPIs gerais
  const valorEstoque = itens.reduce((a, i) => a + i.valorEstoque, 0);
  const cmvDiario = totalConsumoValor / dias;
  const comDemanda = itens.filter(i => i.consumo > 0);
  const disponibilidade = comDemanda.length ? r1((comDemanda.filter(i => i.saldo > 0).length / comDemanda.length) * 100) : null;
  const porSaude = (s: string) => itens.filter(i => i.saude === s);
  const capitalParado = [...porSaude('Lento'), ...porSaude('Obsoleto')].reduce((a, i) => a + i.valorEstoque, 0);
  const excessoValor = itens.reduce((a, i) => a + i.excessoValor, 0);

  // Tendência: últimas 4 semanas x 4 anteriores
  const ult4 = serieValor.slice(-4).reduce((a, b) => a + b, 0), ant4 = serieValor.slice(-8, -4).reduce((a, b) => a + b, 0);
  const tendenciaPct = semanas >= 8 && ant4 > 0 ? r1(((ult4 - ant4) / ant4) * 100) : null;
  const prevUn = previsaoHolt(serieUn, 4), prevValor = previsaoHolt(serieValor, 4);
  const rotuloSemana = (i: number) => new Date(fimSemana0 - (semanas - i) * 7 * DIA).toISOString().slice(0, 10);
  const demanda = [
    ...serieUn.map((u, i) => ({ semana: rotuloSemana(i), unidades: u, valor: r2(serieValor[i]), entradas: serieEntradas[i], producao: serieProducao[i], previsto: false })),
    ...prevUn.previsao.map((u, h) => ({
      semana: rotuloSemana(semanas + h), unidades: Math.round(u), valor: r2(prevValor.previsao[h]), previsto: true,
      faixaUn: [Math.max(0, Math.round(u - 1.28 * prevUn.erro * Math.sqrt(h + 1))), Math.round(u + 1.28 * prevUn.erro * Math.sqrt(h + 1))],
      faixaValor: [Math.max(0, r2(prevValor.previsao[h] - 1.28 * prevValor.erro * Math.sqrt(h + 1))), r2(prevValor.previsao[h] + 1.28 * prevValor.erro * Math.sqrt(h + 1))],
    })),
  ];

  // ---------------- PCP: capacidade de produção pelas receitas
  const saldoTotalDe = (id: string) => {
    if (saldo.has(id)) return saldo.get(id)!;
    const porArm = saldoArm.get(id);
    if (!porArm) return 0;
    return armazemId ? porArm.get(armazemId) || 0 : [...porArm.values()].reduce((a, b) => a + b, 0);
  };
  const itemPorId = new Map(itens.map(i => [i.produtoId, i]));
  const gargalos = new Map<string, { produtoId: string; nome: string; sku: string; receitas: number; saldo: number }>();
  const producao = produtos.filter(p => p.ingredientes.length).map(p => {
    const comps = p.ingredientes.map(c => {
      const s = saldoTotalDe(c.produtoFilhoId);
      return { produtoId: c.produtoFilhoId, nome: c.produtoFilho.nome, sku: c.produtoFilho.sku, porUnidade: c.quantidade, saldo: s, rende: c.quantidade > 0 ? Math.floor(s / c.quantidade) : Infinity };
    });
    const possivel = Math.min(...comps.map(c => c.rende));
    const gargalo = comps.reduce((m, c) => (c.rende < m.rende ? c : m), comps[0]);
    const g = gargalos.get(gargalo.produtoId) ?? { produtoId: gargalo.produtoId, nome: gargalo.nome, sku: gargalo.sku, receitas: 0, saldo: gargalo.saldo };
    g.receitas++; gargalos.set(gargalo.produtoId, g);
    const it = itemPorId.get(p.id)!;
    const custoReceita = comps.reduce((a, c) => a + c.porUnidade * (custoDe.get(c.produtoId) || 0), 0);
    return {
      produtoId: p.id, nome: p.nome, sku: p.sku, saldoAcabado: it.saldo, consumoDiario: it.consumoDiario,
      podeProduzir: Number.isFinite(possivel) ? possivel : 0,
      diasAtendidos: it.consumoDiario > 0 ? Math.floor((it.saldo + (Number.isFinite(possivel) ? possivel : 0)) / it.consumoDiario) : null,
      gargalo: { nome: gargalo.nome, sku: gargalo.sku, saldo: gargalo.saldo, porUnidade: gargalo.porUnidade },
      // quanto falta do gargalo para cobrir 30 dias de demanda do acabado
      faltaGargalo30d: Math.max(0, Math.ceil(it.consumoDiario * 30 - it.saldo) * gargalo.porUnidade - gargalo.saldo),
      custoReceita, componentes: comps.map(c => ({ ...c, rende: Number.isFinite(c.rende) ? c.rende : null })),
    };
  }).sort((a, b) => (a.diasAtendidos ?? 1e9) - (b.diasAtendidos ?? 1e9));

  // ---------------- Separação (WMS)
  const ciclo = ordens.map(o => {
    const espera = o.iniciadaEm ? (o.iniciadaEm.getTime() - o.createdAt.getTime()) / 3600000 : null;
    const execucao = o.iniciadaEm && o.concluidaEm ? (o.concluidaEm.getTime() - o.iniciadaEm.getTime()) / 3600000 : null;
    const total = o.concluidaEm ? (o.concluidaEm.getTime() - o.createdAt.getTime()) / 3600000 : null;
    const sla = o.prioridade === 'Urgente' ? 4 : 24;
    return { espera, execucao, total, linhas: o._count.itens, separador: o.separador?.nome || 'Sem separador', dentroSLA: total !== null && total <= sla };
  });
  const separadores = new Map<string, { nome: string; ordens: number; linhas: number; horas: number }>();
  for (const c of ciclo) {
    const s = separadores.get(c.separador) ?? { nome: c.separador, ordens: 0, linhas: 0, horas: 0 };
    s.ordens++; s.linhas += c.linhas; s.horas += c.execucao ?? 0;
    separadores.set(c.separador, s);
  }
  const separacao = {
    ordens: ciclo.length,
    linhas: ciclo.reduce((a, c) => a + c.linhas, 0),
    esperaMediaH: ciclo.length ? r1(media(ciclo.filter(c => c.espera !== null).map(c => c.espera!))) : null,
    execucaoMediaH: ciclo.length ? r2(media(ciclo.filter(c => c.execucao !== null).map(c => c.execucao!))) : null,
    cicloMedioH: ciclo.length ? r1(media(ciclo.filter(c => c.total !== null).map(c => c.total!))) : null,
    slaPct: ciclo.length ? r1((ciclo.filter(c => c.dentroSLA).length / ciclo.length) * 100) : null,
    porSeparador: [...separadores.values()].map(s => ({ ...s, horas: r2(s.horas), linhasHora: s.horas > 0 ? r1(s.linhas / s.horas) : null })).sort((a, b) => b.linhas - a.linhas),
  };

  // ---------------- Acurácia de inventário
  let itensContados = 0, itensCorretos = 0, valorSistema = 0, valorDivergente = 0;
  const historicoInv = inventarios.map(inv => {
    const contados = inv.itens.filter(i => i.quantidadeContada !== null);
    const corretos = contados.filter(i => i.quantidadeContada === i.saldoSistema).length;
    const vs = contados.reduce((a, i) => a + i.saldoSistema * (i.produto?.precoCusto || 0), 0);
    const vd = contados.reduce((a, i) => a + Math.abs(i.quantidadeContada! - i.saldoSistema) * (i.produto?.precoCusto || 0), 0);
    itensContados += contados.length; itensCorretos += corretos; valorSistema += vs; valorDivergente += vd;
    return { codigo: inv.codigo, data: inv.concluidoEm, itens: contados.length, acuracia: contados.length ? r1((corretos / contados.length) * 100) : null, divergenciaValor: vd };
  });
  const acuracia = {
    inventarios: inventarios.length, itens: itensContados,
    porItem: itensContados ? r1((itensCorretos / itensContados) * 100) : null,
    porValor: valorSistema > 0 ? r1(Math.max(0, 1 - valorDivergente / valorSistema) * 100) : null,
    divergenciaValor: valorDivergente, historico: historicoInv,
  };

  // ---------------- Rebalanceamento entre armazéns (só faz sentido sem filtro de armazém)
  const rebalanceamento: { produtoId: string; sku: string; nome: string; de: string; para: string; quantidade: number; coberturaDestino: number | null }[] = [];
  if (!armazemId && armazens.length > 1) {
    for (const it of itens) {
      const porArm = saldoArm.get(it.produtoId); const cons = consumoArm.get(it.produtoId);
      if (!porArm || !cons) continue;
      for (const destino of armazens) {
        const dDia = (cons.get(destino.id) || 0) / dias;
        if (dDia <= 0) continue;
        const sDest = porArm.get(destino.id) || 0;
        const cobDest = sDest / dDia;
        if (cobDest >= Math.max(7, it.leadTimeDias)) continue;
        for (const origem of armazens) {
          if (origem.id === destino.id) continue;
          const sOrig = porArm.get(origem.id) || 0;
          const oDia = (cons.get(origem.id) || 0) / dias;
          const sobra = Math.floor(sOrig - oDia * 45); // mantém 45 dias na origem
          if (sobra <= 0) continue;
          const qtd = Math.min(sobra, Math.ceil(dDia * 30 - sDest));
          if (qtd > 0) rebalanceamento.push({ produtoId: it.produtoId, sku: it.sku, nome: it.nome, de: origem.nome, para: destino.nome, quantidade: qtd, coberturaDestino: Math.floor(cobDest) });
        }
      }
    }
  }

  // ---------------- Mapa de calor: pico operacional
  let pico = { dia: 0, hora: 0, movimentos: 0 };
  calor.forEach((linha, d) => linha.forEach((v, h) => { if (v > pico.movimentos) pico = { dia: d, hora: h, movimentos: v }; }));

  // ---------------- Recomendações automáticas (ordenadas pelo impacto em R$)
  type Nivel = 'critico' | 'atencao' | 'oportunidade' | 'info';
  const insights: { nivel: Nivel; titulo: string; texto: string; acao: string; rota: string; impacto: number }[] = [];
  const nomes = (xs: { nome: string }[], n = 3) => xs.slice(0, n).map(x => x.nome).join(', ') + (xs.length > n ? ` e mais ${xs.length - n}` : '');

  const criticos = itens.filter(i => i.risco === 'Crítico' || i.risco === 'Rompido').sort((a, b) => b.consumoValor - a.consumoValor);
  if (criticos.length) {
    const semPedido = criticos.filter(i => i.emTransito === 0);
    insights.push({
      nivel: 'critico', impacto: criticos.reduce((a, i) => a + i.consumoDiario * i.leadTimeDias * i.custo, 0) + 1e9,
      titulo: `${criticos.length} ${criticos.length === 1 ? 'item acaba' : 'itens acabam'} antes da reposição chegar`,
      texto: `${nomes(criticos)}. A cobertura, já somando o que está pedido, é menor que o lead time do fornecedor.${semPedido.length ? ` ${semPedido.length} ainda sem pedido de compra.` : ''}`,
      acao: 'Gerar pedidos', rota: '/compras/sugestao',
    });
  }
  const abaixoPP = itens.filter(i => i.risco === 'Atenção').sort((a, b) => b.consumoValor - a.consumoValor);
  if (abaixoPP.length) insights.push({
    nivel: 'atencao', impacto: abaixoPP.reduce((a, i) => a + i.consumoValor, 0),
    titulo: `${abaixoPP.length} ${abaixoPP.length === 1 ? 'item chegou' : 'itens chegaram'} ao ponto de pedido`,
    texto: `${nomes(abaixoPP)}. Pedir agora mantém o nível de serviço de 95% sem precisar de compra urgente.`, acao: 'Ver sugestão', rota: '/compras/sugestao',
  });
  const parados = [...porSaude('Obsoleto'), ...porSaude('Lento')].sort((a, b) => b.valorEstoque - a.valorEstoque);
  if (capitalParado > 0) insights.push({
    nivel: 'oportunidade', impacto: capitalParado,
    titulo: `${fmtBRL(capitalParado)} parados em ${parados.length} ${parados.length === 1 ? 'item' : 'itens'} sem saída há mais de 60 dias`,
    texto: `Maiores valores: ${nomes(parados)}. Avalie ação comercial, devolução ao fornecedor ou transferência para onde há demanda.`, acao: 'Ver itens', rota: '#saude',
  });
  if (excessoValor > 0) insights.push({
    nivel: 'oportunidade', impacto: excessoValor,
    titulo: `${fmtBRL(excessoValor)} acima de 90 dias de cobertura`,
    texto: `Segure novas compras de ${nomes(itens.filter(i => i.excessoValor > 0).sort((a, b) => b.excessoValor - a.excessoValor))} até a cobertura voltar ao normal.`, acao: 'Ver itens', rota: '#saude',
  });
  const riscoValidade = validade.vencido + validade.ate30;
  if (riscoValidade > 0) insights.push({
    nivel: validade.vencido > 0 ? 'critico' : 'atencao', impacto: riscoValidade,
    titulo: `${fmtBRL(riscoValidade)} vencidos ou vencendo em 30 dias`,
    texto: `${validade.vencido > 0 ? `${fmtBRL(validade.vencido)} já venceram. ` : ''}Priorize esses lotes na separação (FEFO) e negocie troca com o fornecedor.`, acao: 'Abrir validade', rota: '/validade',
  });
  const fornRuins = fornecedores.filter(f => f.otifPct !== null && f.pedidos >= 2 && f.otifPct < 80);
  if (fornRuins.length) insights.push({
    nivel: 'atencao', impacto: fornRuins.reduce((a, f) => a + f.valor, 0) * 0.1,
    titulo: `${fornRuins.length === 1 ? 'Fornecedor' : `${fornRuins.length} fornecedores`} com OTIF abaixo de 80%`,
    texto: `${fornRuins.map(f => `${f.nome} (${pctBR(f.otifPct!)})`).join(', ')}. Aumente o estoque de segurança desses itens ou negocie prazo.`, acao: 'Ver fornecedores', rota: '#fornecedores',
  });
  const gargaloTop = [...gargalos.values()].sort((a, b) => b.receitas - a.receitas)[0];
  const travados = producao.filter(p => p.podeProduzir === 0 && p.consumoDiario > 0);
  if (travados.length) insights.push({
    nivel: 'critico', impacto: travados.reduce((a, p) => a + p.consumoDiario * 30 * p.custoReceita, 0),
    titulo: `${travados.length} ${travados.length === 1 ? 'receita não pode' : 'receitas não podem'} ser produzidas hoje`,
    texto: `${nomes(travados)}. Falta componente: ${[...new Set(travados.map(t => t.gargalo.nome))].slice(0, 3).join(', ')}.`, acao: 'Ver PCP', rota: '#pcp',
  });
  else if (gargaloTop && gargaloTop.receitas > 1) insights.push({
    nivel: 'info', impacto: 0,
    titulo: `${gargaloTop.nome} limita ${gargaloTop.receitas} receitas`,
    texto: 'É o componente que mais restringe a produção. Mantenha estoque de segurança maior para ele.', acao: 'Ver PCP', rota: '#pcp',
  });
  if (rebalanceamento.length) insights.push({
    nivel: 'oportunidade', impacto: rebalanceamento.reduce((a, r) => a + r.quantidade * (custoDe.get(r.produtoId) || 0), 0),
    titulo: `${rebalanceamento.length} ${rebalanceamento.length === 1 ? 'transferência evita' : 'transferências evitam'} compra`,
    texto: `Há saldo sobrando em um armazém e faltando em outro: ${rebalanceamento.slice(0, 2).map(r => `${r.quantidade} ${r.nome} de ${r.de} para ${r.para}`).join('; ')}.`, acao: 'Transferir', rota: '/armazens',
  });
  if (acuracia.porItem !== null && acuracia.porItem < 95) insights.push({
    nivel: 'atencao', impacto: valorDivergente,
    titulo: `Acurácia de inventário em ${pctBR(acuracia.porItem)}`,
    texto: `A referência para operação WMS é 95% ou mais. Faça contagens cíclicas semanais começando pelos itens classe A.`, acao: 'Novo inventário', rota: '/inventario',
  });
  if (tendenciaPct !== null && Math.abs(tendenciaPct) >= 15) insights.push({
    nivel: tendenciaPct > 0 ? 'atencao' : 'info', impacto: Math.abs(ult4 - ant4),
    titulo: `Demanda ${tendenciaPct > 0 ? 'subiu' : 'caiu'} ${pctBR(Math.abs(tendenciaPct))} nas últimas 4 semanas`,
    texto: tendenciaPct > 0 ? 'Revise os pontos de pedido dos itens A: o consumo médio usado nas compras pode estar subestimado.' : 'Reduza os lotes de compra para não formar excesso.', acao: 'Ver demanda', rota: '#demanda',
  });
  if (perdasValor > 0 && totalConsumoValor > 0 && perdasValor / totalConsumoValor > 0.01) insights.push({
    nivel: 'atencao', impacto: perdasValor,
    titulo: `Perdas e avarias somam ${fmtBRL(perdasValor)} (${pctBR((perdasValor / totalConsumoValor) * 100)} do consumo)`,
    texto: `Maior perda: ${nomes([...perdasPorProduto.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => ({ nome: itemPorId.get(id)?.nome || '-' })), 2)}. Verifique armazenagem e manuseio.`, acao: 'Ver histórico', rota: '/historico',
  });
  const zConsumo = itens.filter(i => i.abc === 'A' && i.xyz === 'Z');
  if (zConsumo.length) insights.push({
    nivel: 'info', impacto: 0,
    titulo: `${zConsumo.length} ${zConsumo.length === 1 ? 'item A tem' : 'itens A têm'} demanda muito irregular (AZ)`,
    texto: `${nomes(zConsumo)}. Para esses, prefira comprar sob pedido ou com previsão do comercial em vez de estoque mínimo fixo.`, acao: 'Ver matriz', rota: '#matriz',
  });
  if (pico.movimentos > 0) {
    const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    insights.push({ nivel: 'info', impacto: -1, titulo: `Pico de operação: ${DIAS[pico.dia]} às ${pico.hora}h`, texto: 'Concentre a equipe de separação nesse horário e agende recebimentos fora dele.', acao: 'Ver mapa', rota: '#operacao' });
  }
  insights.sort((a, b) => b.impacto - a.impacto);

  // Itens para as tabelas (o gráfico semanal por item fica só nos 60 mais relevantes, para manter a resposta leve)
  const relevantes = new Set([...itens].sort((a, b) => b.consumoValor - a.consumoValor).slice(0, 60).map(i => i.produtoId));
  const itensResp = itens.map(i => ({ ...i, semanal: relevantes.has(i.produtoId) ? i.semanal : undefined }));

  return res.json({
    parametros: { dias, semanas, semanasPedidas, armazemId, categoriaId, geradoEm: agora },
    kpis: {
      valorEstoque, valorDemonstracao, valorRuptura,
      giroAnual: valorEstoque > 0 ? r2((cmvDiario * 365) / valorEstoque) : null,
      coberturaDias: cmvDiario > 0 ? Math.round(valorEstoque / cmvDiario) : null,
      disponibilidade, otif: otifGeral, acuracia: acuracia.porItem, cicloSeparacaoH: separacao.cicloMedioH,
      capitalParado, excessoValor, perdasValor, perdasUn, consumoValor: totalConsumoValor, produzidoUn,
      riscoValidade, tendenciaPct, itensCriticos: criticos.length, itensAtencao: abaixoPP.length,
      itensAtivos: comDemanda.length, itensSemDemanda: semDemanda.filter(i => i.saldo > 0).length,
      previsao4SemValor: prevValor.previsao.reduce((a, b) => a + b, 0),
    },
    insights,
    demanda,
    matriz,
    saude: ['Saudável', 'Excesso', 'Lento', 'Obsoleto', 'Sem saldo'].map(s => ({ saude: s, itens: porSaude(s).length, valor: porSaude(s).reduce((a, i) => a + i.valorEstoque, 0) })),
    validade,
    calor,
    pico,
    fornecedores,
    producao,
    gargalos: [...gargalos.values()].sort((a, b) => b.receitas - a.receitas),
    separacao,
    acuracia,
    rebalanceamento: rebalanceamento.slice(0, 30),
    armazens: armazens.map(a => ({ id: a.id, nome: a.nome, codigo: a.codigo })),
    itens: itensResp,
  });
});

export default router;
