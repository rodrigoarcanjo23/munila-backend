import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, dataOuNull, notFound, num } from '../lib/http';
import { criarTitulos, parcelar } from '../lib/financeiro';

/**
 * ✨ FASE 2: FINANCEIRO
 * Títulos a pagar e a receber (com parcelamento), baixa/estorno, contas bancárias e fluxo de caixa.
 */
const router = Router();
const INCLUDE = { fornecedor: { select: { id: true, nomeEmpresa: true } }, conta: true, pedidoCompra: { select: { codigo: true } } } as const;
const hoje0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const diaBR = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

// ---------------- Contas bancárias / caixa ----------------
router.get('/financeiro/contas', async (_req, res) => {
  const [contas, pagos] = await Promise.all([
    prisma.contaBancaria.findMany({ orderBy: { nome: 'asc' } }),
    prisma.titulo.groupBy({ by: ['contaId', 'tipo'], where: { status: 'Pago', contaId: { not: null } }, _sum: { valorPago: true } }),
  ]);
  return res.json(contas.map(c => {
    const entradas = pagos.find(p => p.contaId === c.id && p.tipo === 'RECEBER')?._sum.valorPago ?? 0;
    const saidas = pagos.find(p => p.contaId === c.id && p.tipo === 'PAGAR')?._sum.valorPago ?? 0;
    return { ...c, saldoAtual: c.saldoInicial + entradas - saidas };
  }));
});

router.post('/financeiro/contas', async (req, res) => {
  const { nome, saldoInicial } = req.body || {};
  if (!nome) throw badRequest('Informe o nome da conta.');
  return res.status(201).json(await prisma.contaBancaria.create({ data: { nome, saldoInicial: num(saldoInicial) } }));
});

router.put('/financeiro/contas/:id', async (req, res) => {
  const { nome, saldoInicial, ativa } = req.body || {};
  return res.json(await prisma.contaBancaria.update({
    where: { id: String(req.params.id) },
    data: { nome, saldoInicial: saldoInicial === undefined ? undefined : num(saldoInicial), ativa },
  }));
});

// ---------------- Títulos ----------------
/** ?tipo=PAGAR|RECEBER&status=Aberto|Pago|Cancelado|Vencido&inicio=&fim= (por vencimento) */
router.get('/financeiro/titulos', async (req, res) => {
  const { tipo, status, inicio, fim } = req.query as Record<string, string | undefined>;
  const vencimento: Record<string, Date> = {};
  if (inicio) vencimento.gte = new Date(`${inicio}T00:00:00`);
  if (fim) vencimento.lte = new Date(`${fim}T23:59:59.999`);
  if (status === 'Vencido') vencimento.lt = hoje0();
  const titulos = await prisma.titulo.findMany({
    where: {
      ...(tipo ? { tipo } : {}),
      ...(status ? { status: status === 'Vencido' ? 'Aberto' : status } : {}),
      ...(Object.keys(vencimento).length ? { vencimento } : {}),
    },
    include: INCLUDE,
    orderBy: { vencimento: 'asc' },
  });
  return res.json(titulos);
});

/** Cria um título, ou várias parcelas com `parcelas` e `intervaloDias`. */
router.post('/financeiro/titulos', async (req, res) => {
  const b = req.body || {};
  if (b.tipo !== 'PAGAR' && b.tipo !== 'RECEBER') throw badRequest('Tipo deve ser PAGAR ou RECEBER.');
  if (!b.descricao || num(b.valor) <= 0) throw badRequest('Informe descrição e valor.');
  const venc = dataOuNull(b.vencimento);
  if (!venc) throw badRequest('Informe o vencimento.');
  const partes = parcelar(num(b.valor), num(b.parcelas, 1), venc, num(b.intervaloDias, 30));
  const criados = await prisma.$transaction(tx => criarTitulos(tx, partes.map(p => ({
    tipo: b.tipo, descricao: b.descricao, categoria: b.categoria || null, documento: b.documento || null, pessoa: b.pessoa || null,
    fornecedorId: b.fornecedorId || null, observacao: b.observacao || null, usuarioNome: req.usuario?.nome, ...p,
  }))));
  return res.status(201).json(criados);
});

router.put('/financeiro/titulos/:id', async (req, res) => {
  const t = await prisma.titulo.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw notFound('Título não encontrado.');
  if (t.status !== 'Aberto') throw badRequest('Só títulos em aberto podem ser editados.');
  const b = req.body || {};
  return res.json(await prisma.titulo.update({
    where: { id: t.id },
    data: {
      descricao: b.descricao, categoria: b.categoria, documento: b.documento, pessoa: b.pessoa, observacao: b.observacao,
      fornecedorId: b.fornecedorId === undefined ? undefined : b.fornecedorId || null,
      valor: b.valor === undefined ? undefined : num(b.valor), vencimento: dataOuNull(b.vencimento) ?? undefined,
    },
    include: INCLUDE,
  }));
});

/** Baixa (pagamento ou recebimento). Aceita valor diferente (juros/desconto). */
router.post('/financeiro/titulos/:id/baixar', async (req, res) => {
  const t = await prisma.titulo.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw notFound('Título não encontrado.');
  if (t.status !== 'Aberto') throw badRequest('Este título não está em aberto.');
  const b = req.body || {};
  return res.json(await prisma.titulo.update({
    where: { id: t.id },
    data: {
      status: 'Pago', valorPago: b.valorPago !== undefined && b.valorPago !== '' ? num(b.valorPago) : t.valor,
      dataPagamento: dataOuNull(b.dataPagamento) ?? new Date(), formaPagamento: b.formaPagamento || null, contaId: b.contaId || null,
      observacao: b.observacao ?? t.observacao,
    },
    include: INCLUDE,
  }));
});

router.post('/financeiro/titulos/:id/estornar', async (req, res) => {
  const t = await prisma.titulo.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw notFound('Título não encontrado.');
  if (t.status === 'Aberto') throw badRequest('Este título já está em aberto.');
  return res.json(await prisma.titulo.update({
    where: { id: t.id },
    data: { status: 'Aberto', valorPago: null, dataPagamento: null, formaPagamento: null, contaId: null },
    include: INCLUDE,
  }));
});

router.post('/financeiro/titulos/:id/cancelar', async (req, res) => {
  const t = await prisma.titulo.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw notFound('Título não encontrado.');
  if (t.status === 'Pago') throw badRequest('Estorne o pagamento antes de cancelar.');
  return res.json(await prisma.titulo.update({
    where: { id: t.id },
    data: { status: 'Cancelado', observacao: [t.observacao, req.body?.motivo && `Cancelado: ${req.body.motivo}`].filter(Boolean).join(' | ') || null },
  }));
});

// ---------------- Indicadores ----------------
router.get('/financeiro/resumo', async (_req, res) => {
  const abertos = await prisma.titulo.findMany({ where: { status: 'Aberto' }, select: { tipo: true, valor: true, vencimento: true } });
  const h = hoje0();
  const em7 = new Date(h); em7.setDate(em7.getDate() + 7);
  const soma = (tipo: string, f: (v: Date) => boolean) => abertos.filter(t => t.tipo === tipo && f(t.vencimento)).reduce((a, t) => a + t.valor, 0);
  const conta = (tipo: string, f: (v: Date) => boolean) => abertos.filter(t => t.tipo === tipo && f(t.vencimento)).length;
  return res.json({
    pagarAberto: soma('PAGAR', () => true), receberAberto: soma('RECEBER', () => true),
    pagarVencido: soma('PAGAR', v => v < h), receberVencido: soma('RECEBER', v => v < h),
    pagarVencidoQtd: conta('PAGAR', v => v < h), receberVencidoQtd: conta('RECEBER', v => v < h),
    pagar7dias: soma('PAGAR', v => v >= h && v < em7), receber7dias: soma('RECEBER', v => v >= h && v < em7),
  });
});

/**
 * Fluxo de caixa: realizado (pagamentos/recebimentos baixados) + previsto (títulos em aberto),
 * dia a dia, com saldo acumulado a partir do saldo atual das contas. ?dias=60
 */
router.get('/financeiro/fluxo', async (req, res) => {
  const dias = Math.min(365, Math.max(7, num(req.query.dias, 60)));
  const h = hoje0();
  const fim = new Date(h); fim.setDate(fim.getDate() + dias);
  const inicioRealizado = new Date(h); inicioRealizado.setDate(inicioRealizado.getDate() - 30);

  const [contas, pagos, abertos] = await Promise.all([
    prisma.contaBancaria.findMany({ where: { ativa: true } }),
    prisma.titulo.findMany({ where: { status: 'Pago' }, select: { tipo: true, valorPago: true, valor: true, dataPagamento: true, contaId: true } }),
    prisma.titulo.findMany({ where: { status: 'Aberto', vencimento: { lte: fim } }, select: { tipo: true, valor: true, vencimento: true } }),
  ]);
  const saldoContas = contas.reduce((a, c) => a + c.saldoInicial, 0) +
    pagos.filter(p => p.contaId).reduce((a, p) => a + (p.tipo === 'RECEBER' ? 1 : -1) * (p.valorPago ?? p.valor), 0);

  const vencidosPagar = abertos.filter(t => t.tipo === 'PAGAR' && t.vencimento < h).reduce((a, t) => a + t.valor, 0);
  const vencidosReceber = abertos.filter(t => t.tipo === 'RECEBER' && t.vencimento < h).reduce((a, t) => a + t.valor, 0);

  const serie: { data: string; entradas: number; saidas: number; saldo: number; realizado: boolean }[] = [];
  // Realizado (últimos 30 dias)
  for (let d = new Date(inicioRealizado); d < h; d.setDate(d.getDate() + 1)) {
    const k = diaBR(new Date(d.getTime() + 12 * 3600000));
    const doDia = pagos.filter(p => p.dataPagamento && diaBR(p.dataPagamento) === k);
    serie.push({
      data: k, realizado: true, saldo: 0,
      entradas: doDia.filter(p => p.tipo === 'RECEBER').reduce((a, p) => a + (p.valorPago ?? p.valor), 0),
      saidas: doDia.filter(p => p.tipo === 'PAGAR').reduce((a, p) => a + (p.valorPago ?? p.valor), 0),
    });
  }
  // Previsto (hoje em diante; vencidos entram no dia de hoje)
  let saldo = saldoContas;
  for (let d = new Date(h); d <= fim; d.setDate(d.getDate() + 1)) {
    const k = diaBR(new Date(d.getTime() + 12 * 3600000));
    const doDia = abertos.filter(t => (t.vencimento < h ? diaBR(new Date(h.getTime() + 12 * 3600000)) : diaBR(t.vencimento)) === k);
    const entradas = doDia.filter(t => t.tipo === 'RECEBER').reduce((a, t) => a + t.valor, 0);
    const saidas = doDia.filter(t => t.tipo === 'PAGAR').reduce((a, t) => a + t.valor, 0);
    saldo += entradas - saidas;
    serie.push({ data: k, entradas, saidas, saldo, realizado: false });
  }

  const previstos = serie.filter(s => !s.realizado);
  return res.json({
    dias, saldoContas, vencidosPagar, vencidosReceber,
    entradasPrevistas: previstos.reduce((a, s) => a + s.entradas, 0),
    saidasPrevistas: previstos.reduce((a, s) => a + s.saidas, 0),
    saldoFinal: saldo,
    menorSaldo: previstos.reduce((m, s) => Math.min(m, s.saldo), saldoContas),
    serie,
  });
});

router.get('/financeiro/categorias', async (_req, res) => {
  const usadas = await prisma.titulo.findMany({ where: { categoria: { not: null } }, distinct: ['categoria'], select: { categoria: true } });
  const padrao = ['Fornecedores', 'Frete', 'Impostos', 'Folha de pagamento', 'Aluguel', 'Energia e água', 'Serviços', 'Vendas', 'Outras receitas', 'Outras despesas'];
  return res.json([...new Set([...padrao, ...usadas.map(u => u.categoria!)])]);
});

export default router;
