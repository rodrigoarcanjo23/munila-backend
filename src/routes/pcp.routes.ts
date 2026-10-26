import { Router, type Request } from 'express';
import { prisma, type Db } from '../lib/prisma';
import { badRequest, notFound, num, dataOuNull } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import {
  STATUS, armazemPadrao, entradaEstoque, gerarCodigoOP, gerarCodigoRequisicao, registrarMovimentos, saidaFEFO, saldosDisponiveis, sugerirFEFO,
} from '../lib/estoque';
import { hojeBR, indiceSemana, previsaoHolt, proximasSemanas, segundaDe } from '../lib/previsao';

// ============================================================
// ✨ FASE 4: PCP — ordens de produção, apontamentos, plano mestre (MPS), MRP, recursos e fichas técnicas.
// ============================================================

const router = Router();
const DIA = 86400000;

export const OP_ABERTAS = ['Planejada', 'Liberada', 'Em produção', 'Pausada'];
const ORDEM_STATUS: Record<string, number> = { 'Em produção': 0, Pausada: 1, Liberada: 2, Planejada: 3 };
const PESO_PRIORIDADE: Record<string, number> = { Urgente: 0, Alta: 1, Normal: 2, Baixa: 3 };
const DEMANDA_INDEPENDENTE = ['Saída de mercadoria', 'Saída para demonstração'];

const isoDia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const r1 = (v: number) => Math.round(v * 10) / 10;

function exigirUsuario(req: Request) {
  const id = usuarioDaRequisicao(req);
  if (!id) throw badRequest('Usuário não identificado. Entre novamente no sistema.');
  return id;
}

/** Estoque de segurança só quando foi informado (campo ou tag [MIN:x]); no MRP não usa o padrão de 10. */
function segurancaDe(p: { estoqueMinimo: number | null; descricao: string | null }) {
  if (p.estoqueMinimo !== null && p.estoqueMinimo !== undefined) return p.estoqueMinimo;
  const m = p.descricao?.match(/\[MIN:(\d+)\]/);
  return m ? Number(m[1]) : 0;
}

/** Quanto de cada componente a OP ainda precisa (pelo que falta produzir de peças boas). */
const restanteComponente = (op: { quantidadePlanejada: number; quantidadeProduzida: number }, c: { porUnidade: number; quantidadePrevista: number; quantidadeConsumida: number }) =>
  Math.max(0, c.porUnidade * Math.max(0, op.quantidadePlanejada - op.quantidadeProduzida));

const INCLUDE_OP = {
  produto: { select: { id: true, nome: true, sku: true, unidade: true, precoCusto: true } },
  recurso: { select: { id: true, codigo: true, nome: true } },
  armazem: { select: { id: true, nome: true, codigo: true } },
  responsavel: { select: { id: true, nome: true } },
  componentes: { include: { produto: { select: { id: true, nome: true, sku: true, unidade: true, precoCusto: true } } } },
} as const;

type OPCompleta = NonNullable<Awaited<ReturnType<typeof carregarOP>>>;
const carregarOP = (db: Db, id: string) => db.ordemProducao.findUnique({ where: { id }, include: INCLUDE_OP });

/**
 * Verificação de materiais com prioridade: distribui o saldo de cada componente entre as OPs abertas
 * na ordem em produção → pausada → liberada → planejada, depois prioridade e data de início.
 */
async function analisarMateriais(db: Db) {
  const [ordens, estoques, padrao] = await Promise.all([
    db.ordemProducao.findMany({ where: { status: { in: OP_ABERTAS } }, include: { componentes: { include: { produto: { select: { nome: true, sku: true } } } } } }),
    db.estoque.findMany({ where: { status: STATUS.DISPONIVEL, quantidade: { gt: 0 } }, select: { produtoId: true, armazemId: true, quantidade: true } }),
    armazemPadrao(db),
  ]);
  const saldo = new Map<string, number>(); // produto|armazém
  for (const e of estoques) {
    const k = `${e.produtoId}|${e.armazemId || padrao}`;
    saldo.set(k, (saldo.get(k) || 0) + e.quantidade);
  }
  ordens.sort((a, b) =>
    (ORDEM_STATUS[a.status] ?? 9) - (ORDEM_STATUS[b.status] ?? 9)
    || (PESO_PRIORIDADE[a.prioridade] ?? 2) - (PESO_PRIORIDADE[b.prioridade] ?? 2)
    || (a.inicioPrevisto?.getTime() ?? Infinity) - (b.inicioPrevisto?.getTime() ?? Infinity)
    || a.createdAt.getTime() - b.createdAt.getTime());

  const resultado = new Map<string, { status: 'OK' | 'Parcial' | 'Falta' | 'Sem receita'; podeProduzir: number; faltas: { produtoId: string; nome: string; sku: string; necessario: number; disponivel: number; falta: number }[] }>();
  for (const op of ordens) {
    const restanteOP = Math.max(0, op.quantidadePlanejada - op.quantidadeProduzida);
    if (!op.componentes.length) { resultado.set(op.id, { status: 'Sem receita', podeProduzir: restanteOP, faltas: [] }); continue; }
    const arm = op.armazemId || padrao;
    let pode = restanteOP;
    const faltas = [];
    for (const c of op.componentes) {
      const k = `${c.produtoId}|${arm}`;
      const disp = saldo.get(k) || 0;
      const nec = restanteComponente(op, c);
      pode = Math.min(pode, c.porUnidade > 0 ? Math.floor(disp / c.porUnidade) : pode);
      if (disp < nec) faltas.push({ produtoId: c.produtoId, nome: c.produto.nome, sku: c.produto.sku, necessario: nec, disponivel: disp, falta: nec - disp });
      saldo.set(k, Math.max(0, disp - nec)); // reserva para esta OP (empenho)
    }
    resultado.set(op.id, { status: faltas.length === 0 ? 'OK' : pode > 0 ? 'Parcial' : 'Falta', podeProduzir: Math.max(0, pode), faltas });
  }
  return resultado;
}

function enriquecer(op: OPCompleta, materiais?: Awaited<ReturnType<typeof analisarMateriais>>) {
  const hoje = hojeBR();
  const aberta = OP_ABERTAS.includes(op.status);
  return {
    ...op,
    restante: Math.max(0, op.quantidadePlanejada - op.quantidadeProduzida),
    progresso: op.quantidadePlanejada > 0 ? Math.min(100, Math.round((op.quantidadeProduzida / op.quantidadePlanejada) * 100)) : 0,
    atrasada: aberta && !!op.entregaPrevista && isoDia(op.entregaPrevista)! < hoje,
    noPrazo: op.status === 'Concluída' && op.entregaPrevista && op.concluidaEm ? op.concluidaEm.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) <= isoDia(op.entregaPrevista)! : null,
    material: aberta ? materiais?.get(op.id) ?? null : null,
    custoPrevisto: op.componentes.reduce((a, c) => a + c.porUnidade * (c.produto.precoCusto || 0), 0) * op.quantidadePlanejada,
  };
}

// ------------------------------------------------------------ RECURSOS (linhas, células, bancadas)

/** Capacidade efetiva por semana = capacidade/dia × dias × eficiência. */
const capacidadeSemana = (r: { capacidadeDia: number; diasSemana: number; eficiencia: number }) => r.capacidadeDia * r.diasSemana * (r.eficiencia / 100);

async function cargaRecursos(db: Db, semanas: Date[], incluirPlano = false) {
  const [recursos, ordens] = await Promise.all([
    db.recursoProducao.findMany({ where: { ativo: true }, orderBy: { codigo: 'asc' } }),
    db.ordemProducao.findMany({ where: { status: { in: OP_ABERTAS } }, select: { recursoId: true, quantidadePlanejada: true, quantidadeProduzida: true, inicioPrevisto: true, produtoId: true, entregaPrevista: true } }),
  ]);
  const carga = new Map(recursos.map(r => [r.id, Array(semanas.length).fill(0) as number[]]));
  const semRecurso = Array(semanas.length).fill(0) as number[];
  for (const o of ordens) {
    const i = indiceSemana(o.inicioPrevisto, semanas);
    if (i < 0) continue;
    const alvo = (o.recursoId && carga.get(o.recursoId)) || semRecurso;
    alvo[i] += Math.max(0, o.quantidadePlanejada - o.quantidadeProduzida);
  }
  if (incluirPlano) {
    // a parte do plano mestre que ainda não virou OP também ocupa capacidade (no recurso mais usado pelo produto)
    const [planos, padrao] = await Promise.all([db.planoProducao.findMany({ where: { semana: { gte: semanas[0] } } }), recursoPadraoPorProduto(db)]);
    for (const p of planos) {
      const i = indiceSemana(p.semana, semanas);
      if (i < 0) continue;
      const firme = ordens.filter(o => o.produtoId === p.produtoId && indiceSemana(o.entregaPrevista ?? o.inicioPrevisto, semanas) === i).reduce((a, o) => a + o.quantidadePlanejada, 0);
      const extra = Math.max(0, p.quantidade - firme);
      const rid = padrao.get(p.produtoId);
      const alvo = (rid && carga.get(rid)) || semRecurso;
      alvo[i] += extra;
    }
  }
  return {
    recursos: recursos.map(r => {
      const cap = capacidadeSemana(r);
      return { id: r.id, codigo: r.codigo, nome: r.nome, tipo: r.tipo, capacidadeSemana: Math.round(cap), semanas: carga.get(r.id)!.map(c => ({ carga: c, pct: cap > 0 ? Math.round((c / cap) * 100) : null })) };
    }),
    semRecurso,
  };
}

/** Recurso mais usado nas OPs de cada produto (sugestão para novas OPs e para a carga do plano). */
async function recursoPadraoPorProduto(db: Db) {
  const linhas = await db.ordemProducao.groupBy({ by: ['produtoId', 'recursoId'], where: { recursoId: { not: null } }, _count: { _all: true } });
  const melhor = new Map<string, { recursoId: string; n: number }>();
  for (const l of linhas) {
    const atual = melhor.get(l.produtoId);
    if (!atual || l._count._all > atual.n) melhor.set(l.produtoId, { recursoId: l.recursoId!, n: l._count._all });
  }
  return new Map([...melhor.entries()].map(([k, v]) => [k, v.recursoId]));
}

router.get('/pcp/recursos', async (_req, res) => {
  const semanas = proximasSemanas(4);
  const [todos, carga, contagem] = await Promise.all([
    prisma.recursoProducao.findMany({ orderBy: [{ ativo: 'desc' }, { codigo: 'asc' }] }),
    cargaRecursos(prisma, semanas),
    prisma.ordemProducao.groupBy({ by: ['recursoId'], where: { status: { in: OP_ABERTAS } }, _count: { _all: true } }),
  ]);
  const porId = new Map(carga.recursos.map(r => [r.id, r]));
  const abertas = new Map(contagem.map(c => [c.recursoId, c._count._all]));
  return res.json({
    semanas: semanas.map(isoDia),
    recursos: todos.map(r => ({ ...r, capacidadeSemana: Math.round(capacidadeSemana(r)), ordensAbertas: abertas.get(r.id) || 0, carga: porId.get(r.id)?.semanas ?? [] })),
    semRecurso: carga.semRecurso,
  });
});

function dadosRecurso(b: any) {
  return {
    codigo: String(b.codigo || '').trim().toUpperCase(), nome: String(b.nome || '').trim(), tipo: b.tipo || 'Linha',
    capacidadeDia: Math.max(0, num(b.capacidadeDia)), diasSemana: Math.min(7, Math.max(1, Math.round(num(b.diasSemana, 5)))),
    eficiencia: Math.min(100, Math.max(1, num(b.eficiencia, 85))), ativo: b.ativo !== false, observacao: b.observacao || null,
  };
}
router.post('/pcp/recursos', async (req, res) => {
  const d = dadosRecurso(req.body || {});
  if (!d.codigo || !d.nome) throw badRequest('Informe código e nome do recurso.');
  return res.status(201).json(await prisma.recursoProducao.create({ data: d }));
});
router.put('/pcp/recursos/:id', async (req, res) => {
  const d = dadosRecurso(req.body || {});
  if (!d.codigo || !d.nome) throw badRequest('Informe código e nome do recurso.');
  return res.json(await prisma.recursoProducao.update({ where: { id: String(req.params.id) }, data: d }));
});
router.delete('/pcp/recursos/:id', async (req, res) => {
  const id = String(req.params.id);
  const usado = await prisma.ordemProducao.count({ where: { recursoId: id } });
  if (usado) {
    await prisma.recursoProducao.update({ where: { id }, data: { ativo: false } });
    return res.json({ inativado: true, mensagem: 'O recurso tem ordens no histórico e foi inativado em vez de excluído.' });
  }
  await prisma.recursoProducao.delete({ where: { id } });
  return res.status(204).send();
});

// ------------------------------------------------------------ ORDENS DE PRODUÇÃO

router.get('/pcp/ordens', async (req, res) => {
  const filtro = String(req.query.status || '');
  const where: any = {};
  if (filtro === 'abertas') where.status = { in: OP_ABERTAS };
  else if (filtro) where.status = { in: filtro.split(',') };
  if (req.query.recursoId) where.recursoId = String(req.query.recursoId);
  if (req.query.produtoId) where.produtoId = String(req.query.produtoId);
  const desde = dataOuNull(req.query.desde);
  if (desde) where.OR = [{ status: { in: OP_ABERTAS } }, { updatedAt: { gte: desde } }];
  const [ordens, materiais] = await Promise.all([
    prisma.ordemProducao.findMany({ where, include: INCLUDE_OP, orderBy: { createdAt: 'desc' }, take: Math.min(2000, num(req.query.limite, 500)) }),
    analisarMateriais(prisma),
  ]);
  return res.json(ordens.map(o => enriquecer(o, materiais)));
});

router.get('/pcp/ordens/:id', async (req, res) => {
  const op = await carregarOP(prisma, String(req.params.id));
  if (!op) throw notFound('Ordem de produção não encontrada.');
  const [materiais, apontamentos, saldos] = await Promise.all([
    analisarMateriais(prisma),
    prisma.apontamentoProducao.findMany({ where: { ordemId: op.id }, include: { usuario: { select: { nome: true } } }, orderBy: { dataHora: 'desc' } }),
    saldosDisponiveis(prisma, op.armazemId || (await armazemPadrao())),
  ]);
  const componentes = await Promise.all(op.componentes.map(async c => {
    const restante = restanteComponente(op, c);
    const sugestao = OP_ABERTAS.includes(op.status) && restante > 0 ? await sugerirFEFO(prisma, c.produtoId, restante, op.armazemId) : null;
    return { ...c, restante, saldoArmazem: saldos.get(c.produtoId) || 0, lotesSugeridos: sugestao?.partes ?? [] };
  }));
  const minutos = apontamentos.reduce((a, x) => a + (x.minutos || 0), 0);
  return res.json({
    ...enriquecer(op, materiais), componentes, apontamentos,
    produtividade: minutos > 0 ? r1((op.quantidadeProduzida / minutos) * 60) : null, minutos,
  });
});

interface NovaOP {
  produtoId: string; quantidade: unknown; inicioPrevisto?: unknown; entregaPrevista?: unknown; recursoId?: string | null; prioridade?: string;
  armazemId?: string | null; loteProducao?: string | null; validade?: unknown; observacao?: string | null; origem?: string; liberar?: boolean; responsavelId?: string | null;
}

async function criarOP(db: Db, d: NovaOP, usuarioId?: string) {
  const quantidade = Math.round(num(d.quantidade));
  if (!d.produtoId) throw badRequest('Escolha o produto a produzir.');
  if (quantidade <= 0) throw badRequest('A quantidade deve ser maior que zero.');
  const receita = await db.composicao.findMany({ where: { produtoPaiId: d.produtoId } });
  if (!receita.length) throw badRequest('Este produto não tem ficha técnica (receita). Cadastre os componentes em PCP → Fichas técnicas.');
  const inicio = dataOuNull(d.inicioPrevisto), entrega = dataOuNull(d.entregaPrevista);
  if (inicio && entrega && entrega < inicio) throw badRequest('A entrega prevista não pode ser antes do início.');
  return db.ordemProducao.create({
    data: {
      codigo: await gerarCodigoOP(db), produtoId: d.produtoId, quantidadePlanejada: quantidade,
      status: d.liberar ? 'Liberada' : 'Planejada', prioridade: d.prioridade || 'Normal', origem: d.origem || 'Manual',
      inicioPrevisto: inicio, entregaPrevista: entrega, recursoId: d.recursoId || null, armazemId: d.armazemId || null,
      loteProducao: d.loteProducao?.trim() || null, validade: dataOuNull(d.validade), observacao: d.observacao || null,
      responsavelId: d.responsavelId || usuarioId || null,
      componentes: { create: receita.map(c => ({ produtoId: c.produtoFilhoId, porUnidade: c.quantidade, quantidadePrevista: c.quantidade * quantidade })) },
    },
    include: INCLUDE_OP,
  });
}

router.post('/pcp/ordens', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  const op = await prisma.$transaction(tx => criarOP(tx, req.body || {}, usuarioId));
  return res.status(201).json(op);
});

router.post('/pcp/ordens/lote', async (req, res) => {
  const itens: NovaOP[] = Array.isArray(req.body?.itens) ? req.body.itens : [];
  if (!itens.length) throw badRequest('Nenhuma ordem para criar.');
  const usuarioId = usuarioDaRequisicao(req);
  const criadas = await prisma.$transaction(async tx => {
    const r = [];
    for (const i of itens) r.push(await criarOP(tx, i, usuarioId)); // sequencial para os códigos OP saírem em ordem
    return r;
  });
  return res.status(201).json(criadas);
});

router.put('/pcp/ordens/:id', async (req, res) => {
  const id = String(req.params.id);
  const b = req.body || {};
  const op = await prisma.ordemProducao.findUnique({ where: { id }, include: { componentes: true } });
  if (!op) throw notFound('Ordem de produção não encontrada.');
  if (!OP_ABERTAS.includes(op.status)) throw badRequest('Só é possível editar ordens abertas.');
  const quantidade = b.quantidade !== undefined ? Math.round(num(b.quantidade)) : op.quantidadePlanejada;
  if (quantidade <= 0) throw badRequest('A quantidade deve ser maior que zero.');
  if (quantidade < op.quantidadeProduzida) throw badRequest(`Já foram produzidas ${op.quantidadeProduzida} unidades; a quantidade não pode ser menor.`);
  const inicio = b.inicioPrevisto !== undefined ? dataOuNull(b.inicioPrevisto) : op.inicioPrevisto;
  const entrega = b.entregaPrevista !== undefined ? dataOuNull(b.entregaPrevista) : op.entregaPrevista;
  if (inicio && entrega && entrega < inicio) throw badRequest('A entrega prevista não pode ser antes do início.');
  const atualizada = await prisma.$transaction(async tx => {
    if (quantidade !== op.quantidadePlanejada) {
      for (const c of op.componentes) await tx.ordemProducaoComponente.update({ where: { id: c.id }, data: { quantidadePrevista: c.porUnidade * quantidade } });
    }
    return tx.ordemProducao.update({
      where: { id },
      data: {
        quantidadePlanejada: quantidade, inicioPrevisto: inicio, entregaPrevista: entrega,
        recursoId: b.recursoId !== undefined ? b.recursoId || null : undefined,
        prioridade: b.prioridade || undefined,
        armazemId: b.armazemId !== undefined && op.quantidadeProduzida === 0 ? b.armazemId || null : undefined,
        loteProducao: b.loteProducao !== undefined ? b.loteProducao?.trim() || null : undefined,
        validade: b.validade !== undefined ? dataOuNull(b.validade) : undefined,
        observacao: b.observacao !== undefined ? b.observacao || null : undefined,
        responsavelId: b.responsavelId !== undefined ? b.responsavelId || null : undefined,
      },
      include: INCLUDE_OP,
    });
  });
  return res.json(atualizada);
});

/** Programação rápida (arrastar no quadro): muda só recurso e datas. */
router.put('/pcp/ordens/:id/programar', async (req, res) => {
  const id = String(req.params.id);
  const op = await prisma.ordemProducao.findUnique({ where: { id } });
  if (!op || !OP_ABERTAS.includes(op.status)) throw badRequest('Só é possível programar ordens abertas.');
  const b = req.body || {};
  const inicio = b.inicioPrevisto !== undefined ? dataOuNull(b.inicioPrevisto) : op.inicioPrevisto;
  let entrega = b.entregaPrevista !== undefined ? dataOuNull(b.entregaPrevista) : op.entregaPrevista;
  if (inicio && entrega && entrega < inicio) entrega = inicio;
  return res.json(await prisma.ordemProducao.update({
    where: { id }, data: { inicioPrevisto: inicio, entregaPrevista: entrega, recursoId: b.recursoId !== undefined ? b.recursoId || null : undefined },
  }));
});

router.post('/pcp/ordens/:id/acao', async (req, res) => {
  const id = String(req.params.id);
  const { acao, motivo } = req.body || {};
  const op = await prisma.ordemProducao.findUnique({ where: { id }, include: { _count: { select: { apontamentos: true } } } });
  if (!op) throw notFound('Ordem de produção não encontrada.');
  const exige = (estados: string[], msg: string) => { if (!estados.includes(op.status)) throw badRequest(msg); };
  let data: any;
  switch (acao) {
    case 'liberar': exige(['Planejada'], 'Só ordens planejadas podem ser liberadas.'); data = { status: 'Liberada' }; break;
    case 'voltar': exige(['Liberada'], 'Só ordens liberadas voltam para planejada.'); data = { status: 'Planejada' }; break;
    case 'iniciar': exige(['Liberada', 'Pausada'], 'A ordem precisa estar liberada ou pausada para iniciar.'); data = { status: 'Em produção', iniciadaEm: op.iniciadaEm ?? new Date() }; break;
    case 'pausar': exige(['Em produção'], 'Só ordens em produção podem ser pausadas.'); data = { status: 'Pausada', observacao: motivo ? `${op.observacao ? `${op.observacao}\n` : ''}Pausa: ${motivo}` : undefined }; break;
    case 'encerrar':
      exige(OP_ABERTAS, 'A ordem não está aberta.');
      if (op.quantidadeProduzida <= 0) throw badRequest('Nada foi apontado nesta ordem. Para desistir dela, use Cancelar.');
      data = { status: 'Concluída', concluidaEm: new Date() }; break;
    case 'reabrir': exige(['Concluída'], 'Só ordens concluídas podem ser reabertas.'); data = { status: 'Em produção', concluidaEm: null }; break;
    case 'cancelar':
      exige(OP_ABERTAS, 'A ordem não está aberta.');
      if (op._count.apontamentos > 0) throw badRequest('A ordem já tem produção apontada. Use Encerrar para fechá-la com o que foi produzido.');
      if (!motivo || String(motivo).trim().length < 3) throw badRequest('Informe o motivo do cancelamento.');
      data = { status: 'Cancelada', motivoCancelamento: String(motivo).trim(), concluidaEm: new Date() }; break;
    default: throw badRequest('Ação inválida.');
  }
  await prisma.ordemProducao.update({ where: { id }, data });
  const atual = await carregarOP(prisma, id);
  return res.json(enriquecer(atual!));
});

router.delete('/pcp/ordens/:id', async (req, res) => {
  const id = String(req.params.id);
  const op = await prisma.ordemProducao.findUnique({ where: { id }, include: { _count: { select: { apontamentos: true } } } });
  if (!op) throw notFound('Ordem de produção não encontrada.');
  if (op.status !== 'Planejada' || op._count.apontamentos) throw badRequest('Só é possível excluir ordens planejadas e sem apontamentos. Para as demais, use Cancelar.');
  await prisma.ordemProducao.delete({ where: { id } });
  return res.status(204).send();
});

// ------------------------------------------------------------ APONTAMENTO DE PRODUÇÃO
// Consome os componentes por FEFO (peças boas + refugo) e dá entrada do produto acabado no lote da OP.

router.post('/pcp/ordens/:id/apontamentos', async (req, res) => {
  const id = String(req.params.id);
  const usuarioId = exigirUsuario(req);
  const b = req.body || {};
  const quantidade = Math.max(0, Math.round(num(b.quantidade)));
  const refugo = Math.max(0, Math.round(num(b.refugo)));
  if (quantidade + refugo <= 0) throw badRequest('Informe a quantidade produzida ou o refugo.');

  const resultado = await prisma.$transaction(async tx => {
    const op = await carregarOP(tx, id);
    if (!op) throw notFound('Ordem de produção não encontrada.');
    if (!OP_ABERTAS.includes(op.status)) throw new Error('A ordem não está aberta.');
    if (op.status === 'Planejada') throw new Error('Libere a ordem antes de apontar produção.');
    const ref = `OP ${op.codigo}`;

    let codigoConsumo: string | null = null;
    if (op.componentes.length) {
      codigoConsumo = await gerarCodigoRequisicao(tx, 'RS');
      for (const c of op.componentes) {
        const consumo = c.porUnidade * (quantidade + refugo);
        const partes = await saidaFEFO(tx, { produtoId: c.produtoId, quantidade: consumo, armazemId: op.armazemId, rotulo: `[${c.produto.sku}] ${c.produto.nome}` });
        await registrarMovimentos(tx, { produtoId: c.produtoId, usuarioId, tipoAcao: 'Saída para produção', codigo: codigoConsumo, observacao: `Consumo da ${ref}` }, partes);
        await tx.ordemProducaoComponente.update({ where: { id: c.id }, data: { quantidadeConsumida: { increment: consumo } } });
      }
    }

    let codigoEntrada: string | null = null;
    const lote = String(b.lote || op.loteProducao || op.codigo).trim();
    if (quantidade > 0) {
      const parte = await entradaEstoque(tx, { produtoId: op.produtoId, quantidade, armazemId: op.armazemId, lote, validade: dataOuNull(b.validade) ?? op.validade });
      codigoEntrada = await gerarCodigoRequisicao(tx, 'RE');
      await registrarMovimentos(tx, {
        produtoId: op.produtoId, usuarioId, tipoAcao: 'Entrada por produção', codigo: codigoEntrada,
        observacao: `${ref}${refugo ? ` · refugo ${refugo}` : ''}${b.observacao ? ` · ${b.observacao}` : ''}`,
      }, [parte]);
    }

    const produzida = op.quantidadeProduzida + quantidade;
    const encerrar = b.encerrar === true || (b.encerrar !== false && produzida >= op.quantidadePlanejada);
    await tx.ordemProducao.update({
      where: { id },
      data: {
        quantidadeProduzida: produzida, quantidadeRefugo: { increment: refugo },
        status: encerrar ? 'Concluída' : 'Em produção', iniciadaEm: op.iniciadaEm ?? new Date(), concluidaEm: encerrar ? new Date() : null,
      },
    });
    const apontamento = await tx.apontamentoProducao.create({
      data: { ordemId: id, quantidade, refugo, minutos: b.minutos ? Math.max(0, Math.round(num(b.minutos))) : null, lote: quantidade > 0 ? lote : null, observacao: b.observacao || null, codigoEntrada, codigoConsumo, usuarioId },
    });
    return { apontamento, encerrada: encerrar };
  }, { timeout: 30000 });
  return res.status(201).json(resultado);
});

/** Estorno de apontamento: devolve os componentes aos mesmos lotes e retira o acabado. Fica registrado na auditoria. */
router.delete('/pcp/apontamentos/:id', async (req, res) => {
  const usuarioId = exigirUsuario(req);
  const motivo = String(req.body?.motivo || '').trim();
  if (motivo.length < 3) throw badRequest('Informe o motivo do estorno.');
  await prisma.$transaction(async tx => {
    const a = await tx.apontamentoProducao.findUnique({ where: { id: String(req.params.id) }, include: { ordem: { include: { produto: true, componentes: true } } } });
    if (!a) throw notFound('Apontamento não encontrado.');
    const op = a.ordem;
    if (op.status === 'Cancelada') throw new Error('A ordem está cancelada.');
    const ref = `Estorno ${op.codigo}`;
    if (a.quantidade > 0) {
      const partes = await saidaFEFO(tx, { produtoId: op.produtoId, quantidade: a.quantidade, armazemId: op.armazemId, lote: a.lote, rotulo: `[${op.produto.sku}] ${op.produto.nome}` });
      await registrarMovimentos(tx, { produtoId: op.produtoId, usuarioId, tipoAcao: 'Estorno de produção (saída)', codigo: a.codigoEntrada, observacao: `${ref}: ${motivo}` }, partes);
    }
    if (a.codigoConsumo) {
      const consumos = await tx.movimentacao.findMany({ where: { codigo: a.codigoConsumo, tipoAcao: 'Saída para produção' } });
      for (const m of consumos) {
        const parte = await entradaEstoque(tx, { produtoId: m.produtoId, quantidade: m.quantidade, armazemId: m.armazemId, lote: m.lote, validade: m.validade });
        await registrarMovimentos(tx, { produtoId: m.produtoId, usuarioId, tipoAcao: 'Estorno de produção (entrada)', codigo: a.codigoConsumo, observacao: `${ref}: ${motivo}` }, [parte]);
        const c = op.componentes.find(x => x.produtoId === m.produtoId);
        if (c) await tx.ordemProducaoComponente.update({ where: { id: c.id }, data: { quantidadeConsumida: { decrement: m.quantidade } } });
      }
    }
    await tx.ordemProducao.update({
      where: { id: op.id },
      data: {
        quantidadeProduzida: { decrement: a.quantidade }, quantidadeRefugo: { decrement: a.refugo },
        status: op.status === 'Concluída' ? 'Em produção' : undefined, concluidaEm: op.status === 'Concluída' ? null : undefined,
      },
    });
    await tx.apontamentoProducao.delete({ where: { id: a.id } });
    const usuario = await tx.usuario.findUnique({ where: { id: usuarioId }, select: { nome: true } });
    await tx.logAuditoria.create({ data: { acao: 'ESTORNO DE APONTAMENTO', itemNome: `${op.codigo} · [${op.produto.sku}] ${op.produto.nome} · ${a.quantidade} un`, usuarioNome: usuario?.nome || 'Desconhecido', motivo } });
  }, { timeout: 30000 });
  return res.status(204).send();
});

// ------------------------------------------------------------ PLANO MESTRE DE PRODUÇÃO (MPS)

/** Demanda independente (vendas + demonstração) por produto nas últimas N semanas fechadas. */
async function demandaSemanal(db: Db, produtoIds: string[], semanasHist: number) {
  const s0 = segundaDe(hojeBR());
  const inicio = new Date(s0.getTime() - semanasHist * 7 * DIA);
  const movs = await db.movimentacao.findMany({
    where: { produtoId: { in: produtoIds }, tipoAcao: { in: DEMANDA_INDEPENDENTE }, dataHora: { gte: inicio, lt: s0 } },
    select: { produtoId: true, quantidade: true, dataHora: true },
  });
  const mapa = new Map(produtoIds.map(id => [id, Array(semanasHist).fill(0) as number[]]));
  for (const m of movs) {
    const i = Math.floor((m.dataHora.getTime() - inicio.getTime()) / (7 * DIA));
    if (i >= 0 && i < semanasHist) mapa.get(m.produtoId)![i] += m.quantidade;
  }
  return mapa;
}

router.get('/pcp/plano', async (req, res) => {
  const n = Math.min(16, Math.max(4, Math.round(num(req.query.semanas, 8))));
  const semanas = proximasSemanas(n);
  const fabricados = await prisma.produto.findMany({
    where: { ingredientes: { some: {} } }, orderBy: { nome: 'asc' },
    select: { id: true, nome: true, sku: true, unidade: true, estoqueMinimo: true, descricao: true, precoCusto: true, categoria: { select: { nome: true } } },
  });
  const ids = fabricados.map(p => p.id);
  const [saldos, planos, ordens, historico, carga, padrao] = await Promise.all([
    saldosDisponiveis(),
    prisma.planoProducao.findMany({ where: { produtoId: { in: ids }, semana: { gte: semanas[0] } } }),
    prisma.ordemProducao.findMany({ where: { produtoId: { in: ids }, status: { in: OP_ABERTAS } }, select: { produtoId: true, quantidadePlanejada: true, quantidadeProduzida: true, entregaPrevista: true, inicioPrevisto: true } }),
    demandaSemanal(prisma, ids, 12),
    cargaRecursos(prisma, semanas, true),
    recursoPadraoPorProduto(prisma),
  ]);

  const produtos = fabricados.map(p => {
    const hist = historico.get(p.id)!;
    const prev = previsaoHolt(hist, n);
    const seguranca = segurancaDe(p);
    let projetado = saldos.get(p.id) || 0, projetadoSugestao = projetado;
    const linhas = semanas.map((s, i) => {
      const demanda = Math.round(prev.previsao[i]);
      const plano = planos.find(x => x.produtoId === p.id && indiceSemana(x.semana, semanas) === i)?.quantidade ?? 0;
      const ops = ordens.filter(o => o.produtoId === p.id && indiceSemana(o.entregaPrevista ?? o.inicioPrevisto, semanas) === i).reduce((a, o) => a + Math.max(0, o.quantidadePlanejada - o.quantidadeProduzida), 0);
      const oferta = Math.max(plano, ops); // o plano inclui as OPs firmes da semana
      projetado = projetado + oferta - demanda;
      // sugestão: o mínimo a produzir na semana para o projetado não ficar abaixo do estoque de segurança
      const semNovo = projetadoSugestao + ops - demanda;
      const sugestao = semNovo < seguranca ? Math.ceil(seguranca - semNovo) + ops : ops;
      projetadoSugestao = semNovo + Math.max(0, sugestao - ops);
      return { semana: isoDia(s), demanda, plano, ops, projetado, sugestao, abaixo: projetado < seguranca };
    });
    return {
      produtoId: p.id, nome: p.nome, sku: p.sku, unidade: p.unidade || 'UN', categoria: p.categoria?.nome ?? '-', saldo: saldos.get(p.id) || 0, seguranca,
      demandaMediaSemana: r1(hist.reduce((a, b) => a + b, 0) / hist.length), historico: hist, recursoPadraoId: padrao.get(p.id) ?? null, linhas,
    };
  });
  return res.json({ semanas: semanas.map(isoDia), produtos, carga });
});

router.put('/pcp/plano', async (req, res) => {
  const itens: { produtoId: string; semana: string; quantidade: unknown }[] = Array.isArray(req.body?.itens) ? req.body.itens : [req.body];
  await prisma.$transaction(async tx => {
    for (const i of itens) {
      if (!i?.produtoId || !i.semana) continue;
      const semana = segundaDe(String(i.semana));
      const quantidade = Math.max(0, Math.round(num(i.quantidade)));
      if (quantidade === 0) await tx.planoProducao.deleteMany({ where: { produtoId: i.produtoId, semana } });
      else await tx.planoProducao.upsert({ where: { produtoId_semana: { produtoId: i.produtoId, semana } }, create: { produtoId: i.produtoId, semana, quantidade }, update: { quantidade } });
    }
  });
  return res.json({ ok: true, itens: itens.length });
});

/** Firma o plano de uma semana: cria OPs para o que ainda não tem ordem. */
router.post('/pcp/plano/gerar-ops', async (req, res) => {
  const semana = segundaDe(String(req.body?.semana || hojeBR()));
  const sexta = new Date(semana.getTime() + 4 * DIA);
  const filtro: string[] | null = Array.isArray(req.body?.produtoIds) && req.body.produtoIds.length ? req.body.produtoIds : null;
  const usuarioId = usuarioDaRequisicao(req);
  const [planos, padrao] = await Promise.all([
    prisma.planoProducao.findMany({ where: { semana, ...(filtro ? { produtoId: { in: filtro } } : {}) } }),
    recursoPadraoPorProduto(prisma),
  ]);
  const criadas = await prisma.$transaction(async tx => {
    const r = [];
    for (const p of planos) {
      const existentes = await tx.ordemProducao.findMany({ where: { produtoId: p.produtoId, status: { not: 'Cancelada' } }, select: { quantidadePlanejada: true, entregaPrevista: true, inicioPrevisto: true } });
      const firme = existentes.filter(o => { const d = o.entregaPrevista ?? o.inicioPrevisto; return d && segundaDe(d.toISOString()).getTime() === semana.getTime(); })
        .reduce((a, o) => a + o.quantidadePlanejada, 0);
      const falta = p.quantidade - firme;
      if (falta <= 0) continue;
      r.push(await criarOP(tx, {
        produtoId: p.produtoId, quantidade: falta, inicioPrevisto: semana.toISOString(), entregaPrevista: sexta.toISOString(),
        recursoId: padrao.get(p.produtoId) ?? null, origem: 'Plano mestre', liberar: req.body?.liberar === true,
      }, usuarioId));
    }
    return r;
  });
  return res.status(201).json({ criadas: criadas.length, ordens: criadas });
});

// ------------------------------------------------------------ MRP (necessidade de materiais)

router.get('/pcp/mrp', async (req, res) => {
  const n = Math.min(16, Math.max(4, Math.round(num(req.query.semanas, 8))));
  const semanas = proximasSemanas(n);
  const [produtos, composicoes, saldos, pedidos, ordens, planos] = await Promise.all([
    prisma.produto.findMany({ select: { id: true, nome: true, sku: true, unidade: true, precoCusto: true, leadTimeDias: true, estoqueMinimo: true, descricao: true, fornecedor: { select: { id: true, nomeEmpresa: true } } } }),
    prisma.composicao.findMany(),
    saldosDisponiveis(),
    prisma.pedidoCompra.findMany({ where: { status: 'Pendente' }, select: { produtoId: true, quantidade: true, dataPrevisao: true, codigo: true } }),
    prisma.ordemProducao.findMany({ where: { status: { in: OP_ABERTAS } }, include: { componentes: true } }),
    prisma.planoProducao.findMany({ where: { semana: { gte: semanas[0] } } }),
  ]);
  const prod = new Map(produtos.map(p => [p.id, p]));
  const filhos = new Map<string, { produtoId: string; quantidade: number }[]>();
  for (const c of composicoes) {
    const l = filhos.get(c.produtoPaiId) ?? [];
    l.push({ produtoId: c.produtoFilhoId, quantidade: c.quantidade });
    filhos.set(c.produtoPaiId, l);
  }
  // nível mais baixo de cada item na estrutura (processa pais antes dos filhos)
  const nivel = new Map<string, number>();
  const visitar = (id: string, n: number, pilha: Set<string>) => {
    if (pilha.has(id)) return; // proteção contra receita circular
    if ((nivel.get(id) ?? -1) >= n) return;
    nivel.set(id, n);
    pilha.add(id);
    for (const f of filhos.get(id) ?? []) visitar(f.produtoId, n + 1, pilha);
    pilha.delete(id);
  };
  for (const id of filhos.keys()) visitar(id, 0, new Set());

  const vazio = () => Array(n).fill(0) as number[];
  const bruta = new Map<string, number[]>();
  const receb = new Map<string, number[]>();
  const add = (m: Map<string, number[]>, id: string, i: number, q: number) => { if (i < 0 || q <= 0) return; const a = m.get(id) ?? vazio(); a[i] += q; m.set(id, a); };

  // necessidades vindas das OPs abertas (componentes que ainda faltam consumir)
  for (const o of ordens) {
    const i = indiceSemana(o.inicioPrevisto, semanas);
    for (const c of o.componentes) add(bruta, c.produtoId, i, restanteComponente(o, c));
    add(receb, o.produtoId, indiceSemana(o.entregaPrevista ?? o.inicioPrevisto, semanas), Math.max(0, o.quantidadePlanejada - o.quantidadeProduzida));
  }
  // a parte do plano mestre que ainda não virou OP explode direto para os componentes, na semana do plano
  for (const p of planos) {
    const i = indiceSemana(p.semana, semanas);
    if (i < 0) continue;
    const firme = ordens.filter(o => o.produtoId === p.produtoId && indiceSemana(o.entregaPrevista ?? o.inicioPrevisto, semanas) === i).reduce((a, o) => a + o.quantidadePlanejada, 0);
    const extra = Math.max(0, p.quantidade - firme);
    for (const f of filhos.get(p.produtoId) ?? []) add(bruta, f.produtoId, i, extra * f.quantidade);
  }
  for (const pc of pedidos) add(receb, pc.produtoId, indiceSemana(pc.dataPrevisao, semanas), pc.quantidade);

  const ids = [...new Set([...bruta.keys()])].sort((a, b) => (nivel.get(a) ?? 0) - (nivel.get(b) ?? 0));
  const processados = new Set<string>();
  const itens: any[] = [];
  const fila = [...ids];
  while (fila.length) {
    fila.sort((a, b) => (nivel.get(a) ?? 0) - (nivel.get(b) ?? 0));
    const id = fila.shift()!;
    if (processados.has(id)) continue;
    processados.add(id);
    const p = prod.get(id);
    if (!p) continue;
    const fabricado = (filhos.get(id) ?? []).length > 0;
    const lt = p.leadTimeDias ?? (fabricado ? 0 : 7);
    const ltSem = Math.ceil(lt / 7);
    const seg = segurancaDe(p);
    const b = bruta.get(id) ?? vazio(), r = receb.get(id) ?? vazio();
    const recebimentos = r;
    let projetado = saldos.get(id) || 0;
    const semanasOut = [];
    let total = 0, primeira: number | null = null, atrasado = false;
    const liberacoes = vazio();
    for (let i = 0; i < n; i++) {
      projetado += recebimentos[i] - b[i];
      let liquida = 0;
      if (projetado < seg) { liquida = Math.ceil(seg - projetado); projetado += liquida; }
      let liberar: number | null = null;
      if (liquida > 0) {
        total += liquida;
        liberar = i - ltSem;
        if (liberar < 0) { atrasado = true; liberar = 0; }
        liberacoes[liberar] += liquida;
        if (primeira === null) primeira = liberar;
      }
      semanasOut.push({ bruta: b[i], recebimentos: recebimentos[i], projetado, liquida, liberar });
    }
    // ordem planejada de um item fabricado explode para os componentes (MRP multinível)
    if (fabricado && total > 0) {
      for (const f of filhos.get(id)!) {
        for (let i = 0; i < n; i++) if (liberacoes[i] > 0) add(bruta, f.produtoId, i, liberacoes[i] * f.quantidade);
        if (!processados.has(f.produtoId)) fila.push(f.produtoId);
      }
    }
    if (b.every(x => x === 0) && total === 0) continue;
    itens.push({
      produtoId: id, nome: p.nome, sku: p.sku, unidade: p.unidade || 'UN', acao: fabricado ? 'Produzir' : 'Comprar', nivel: nivel.get(id) ?? 0,
      fornecedor: p.fornecedor ? { id: p.fornecedor.id, nome: p.fornecedor.nomeEmpresa } : null, custo: p.precoCusto || 0, leadTimeDias: lt,
      saldo: saldos.get(id) || 0, seguranca: seg, emPedido: r.reduce((a, x) => a + x, 0),
      semanas: semanasOut, totalLiquido: total, valor: total * (p.precoCusto || 0), atrasado,
      liberarEm: primeira === null ? null : isoDia(semanas[primeira]),
      precisaEm: (() => { const i = semanasOut.findIndex(s => s.liquida > 0); return i < 0 ? null : isoDia(semanas[i]); })(),
    });
  }
  itens.sort((a, b) => Number(b.atrasado) - Number(a.atrasado) || (a.liberarEm ?? '9').localeCompare(b.liberarEm ?? '9') || b.valor - a.valor);
  const comprar = itens.filter(i => i.acao === 'Comprar' && i.totalLiquido > 0);
  return res.json({
    semanas: semanas.map(isoDia), itens,
    resumo: {
      itens: itens.length, comNecessidade: itens.filter(i => i.totalLiquido > 0).length, atrasados: itens.filter(i => i.atrasado).length,
      valorComprar: comprar.reduce((a, i) => a + i.valor, 0), itensComprar: comprar.length, itensProduzir: itens.filter(i => i.acao === 'Produzir' && i.totalLiquido > 0).length,
    },
  });
});

// ------------------------------------------------------------ FICHAS TÉCNICAS (estrutura de produto)

router.get('/pcp/estruturas', async (_req, res) => {
  const [produtos, composicoes, saldos] = await Promise.all([
    prisma.produto.findMany({ select: { id: true, nome: true, sku: true, unidade: true, precoCusto: true, precoVenda: true, tipo: true, categoria: { select: { nome: true } } } }),
    prisma.composicao.findMany(),
    saldosDisponiveis(),
  ]);
  const prod = new Map(produtos.map(p => [p.id, p]));
  const filhos = new Map<string, { produtoId: string; quantidade: number }[]>();
  for (const c of composicoes) { const l = filhos.get(c.produtoPaiId) ?? []; l.push({ produtoId: c.produtoFilhoId, quantidade: c.quantidade }); filhos.set(c.produtoPaiId, l); }
  const memo = new Map<string, number>();
  const custoEstrutura = (id: string, pilha = new Set<string>()): number => {
    if (memo.has(id)) return memo.get(id)!;
    const f = filhos.get(id);
    if (!f?.length || pilha.has(id)) return prod.get(id)?.precoCusto || 0;
    pilha.add(id);
    const v = f.reduce((a, c) => a + c.quantidade * custoEstrutura(c.produtoId, pilha), 0);
    pilha.delete(id);
    memo.set(id, v);
    return v;
  };
  const ondeUsado = new Map<string, string[]>();
  for (const c of composicoes) { const l = ondeUsado.get(c.produtoFilhoId) ?? []; l.push(prod.get(c.produtoPaiId)?.nome || '-'); ondeUsado.set(c.produtoFilhoId, l); }
  const estruturas = [...filhos.entries()].map(([id, f]) => {
    const p = prod.get(id)!;
    const custo = custoEstrutura(id);
    const componentes = f.map(c => {
      const cp = prod.get(c.produtoId);
      const cu = custoEstrutura(c.produtoId);
      return { produtoId: c.produtoId, nome: cp?.nome || '-', sku: cp?.sku || '-', unidade: cp?.unidade || 'UN', quantidade: c.quantidade, custoUnitario: cu, subtotal: cu * c.quantidade, saldo: saldos.get(c.produtoId) || 0, temEstrutura: (filhos.get(c.produtoId) ?? []).length > 0, rende: c.quantidade > 0 ? Math.floor((saldos.get(c.produtoId) || 0) / c.quantidade) : 0 };
    });
    return {
      produtoId: id, nome: p?.nome, sku: p?.sku, unidade: p?.unidade || 'UN', categoria: p?.categoria?.nome ?? '-', precoVenda: p?.precoVenda || 0, custoCadastro: p?.precoCusto || 0,
      custoEstrutura: custo, margem: p?.precoVenda ? ((p.precoVenda - custo) / p.precoVenda) * 100 : null,
      divergenciaCusto: p?.precoCusto ? ((custo - p.precoCusto) / p.precoCusto) * 100 : null,
      podeProduzir: componentes.length ? Math.min(...componentes.map(c => c.rende)) : 0, saldo: saldos.get(id) || 0, componentes,
      usadoEm: ondeUsado.get(id) ?? [],
    };
  }).sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
  return res.json({ estruturas, ondeUsado: Object.fromEntries(ondeUsado) });
});

/** Grava a ficha técnica (substitui a lista de componentes). Impede receita circular. */
router.put('/pcp/estruturas/:id', async (req, res) => {
  const id = String(req.params.id);
  const itens: { produtoId: string; quantidade: unknown }[] = Array.isArray(req.body?.componentes) ? req.body.componentes : [];
  const limpos = new Map<string, number>();
  for (const i of itens) {
    if (!i?.produtoId) continue;
    const q = Math.round(num(i.quantidade));
    if (q <= 0) throw badRequest('As quantidades dos componentes devem ser inteiras e maiores que zero.');
    limpos.set(i.produtoId, (limpos.get(i.produtoId) || 0) + q);
  }
  if (limpos.has(id)) throw badRequest('Um produto não pode ser componente dele mesmo.');
  // o produto não pode aparecer abaixo de nenhum dos seus componentes
  const composicoes = await prisma.composicao.findMany({ select: { produtoPaiId: true, produtoFilhoId: true } });
  const filhos = new Map<string, string[]>();
  for (const c of composicoes) { if (c.produtoPaiId === id) continue; const l = filhos.get(c.produtoPaiId) ?? []; l.push(c.produtoFilhoId); filhos.set(c.produtoPaiId, l); }
  const alcanca = (de: string, vistos = new Set<string>()): boolean => {
    if (de === id) return true;
    if (vistos.has(de)) return false;
    vistos.add(de);
    return (filhos.get(de) ?? []).some(f => alcanca(f, vistos));
  };
  for (const comp of limpos.keys()) if (alcanca(comp)) throw badRequest('Receita circular: um dos componentes já usa este produto na própria ficha técnica.');
  await prisma.$transaction([
    prisma.composicao.deleteMany({ where: { produtoPaiId: id } }),
    prisma.composicao.createMany({ data: [...limpos.entries()].map(([produtoFilhoId, quantidade]) => ({ produtoPaiId: id, produtoFilhoId, quantidade })) }),
  ]);
  return res.json({ ok: true, componentes: limpos.size });
});

/** Atualiza o custo do cadastro do produto com o custo calculado pela ficha técnica. */
router.put('/pcp/estruturas/:id/custo', async (req, res) => {
  const id = String(req.params.id);
  const valor = num(req.body?.custo);
  if (valor <= 0) throw badRequest('Custo inválido.');
  return res.json(await prisma.produto.update({ where: { id }, data: { precoCusto: Math.round(valor * 10000) / 10000 }, select: { id: true, precoCusto: true } }));
});

// ------------------------------------------------------------ CENTRAL DO PCP (indicadores)

router.get('/pcp/painel', async (_req, res) => {
  const hoje = hojeBR();
  const inicio30 = new Date(Date.now() - 30 * DIA);
  const semanas = proximasSemanas(4);
  const semanaPassada = new Date(semanas[0].getTime() - 7 * DIA);
  const [abertas, concluidas, apont, carga, planoPassado, apontPassado, materiais] = await Promise.all([
    prisma.ordemProducao.findMany({ where: { status: { in: OP_ABERTAS } }, include: INCLUDE_OP }),
    prisma.ordemProducao.findMany({ where: { status: 'Concluída', concluidaEm: { gte: inicio30 } }, select: { createdAt: true, iniciadaEm: true, concluidaEm: true, entregaPrevista: true, quantidadePlanejada: true, quantidadeProduzida: true } }),
    prisma.apontamentoProducao.findMany({ where: { dataHora: { gte: inicio30 } }, include: { ordem: { select: { produtoId: true, produto: { select: { nome: true, sku: true, precoCusto: true } } } } } }),
    cargaRecursos(prisma, semanas, true),
    prisma.planoProducao.findMany({ where: { semana: semanaPassada } }),
    prisma.apontamentoProducao.findMany({ where: { dataHora: { gte: semanaPassada, lt: semanas[0] } }, include: { ordem: { select: { produtoId: true } } } }),
    analisarMateriais(prisma),
  ]);
  const ops = abertas.map(o => enriquecer(o, materiais));
  const atrasadas = ops.filter(o => o.atrasada);
  const semMaterial = ops.filter(o => o.material && o.material.status !== 'OK' && o.material.status !== 'Sem receita');
  const produzido = apont.reduce((a, x) => a + x.quantidade, 0);
  const refugo = apont.reduce((a, x) => a + x.refugo, 0);
  const minutos = apont.reduce((a, x) => a + (x.minutos || 0), 0);
  const minutosQtd = apont.filter(x => x.minutos).reduce((a, x) => a + x.quantidade, 0);
  const comPrazo = concluidas.filter(o => o.entregaPrevista && o.concluidaEm);
  const noPrazo = comPrazo.filter(o => o.concluidaEm!.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) <= isoDia(o.entregaPrevista)!).length;
  const ciclos = concluidas.filter(o => o.concluidaEm).map(o => (o.concluidaEm!.getTime() - o.createdAt.getTime()) / DIA);

  // aderência ao plano da semana passada: quanto do planejado foi produzido (limitado ao plano de cada produto)
  const prodPassado = new Map<string, number>();
  for (const a of apontPassado) prodPassado.set(a.ordem.produtoId, (prodPassado.get(a.ordem.produtoId) || 0) + a.quantidade);
  const totalPlano = planoPassado.reduce((a, p) => a + p.quantidade, 0);
  const aderencia = totalPlano > 0 ? r1((planoPassado.reduce((a, p) => a + Math.min(p.quantidade, prodPassado.get(p.produtoId) || 0), 0) / totalPlano) * 100) : null;

  // série diária (30 dias) de produção e refugo
  const serie = new Map<string, { dia: string; produzido: number; refugo: number }>();
  for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * DIA).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); serie.set(d, { dia: d, produzido: 0, refugo: 0 }); }
  for (const a of apont) { const s = serie.get(a.dataHora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })); if (s) { s.produzido += a.quantidade; s.refugo += a.refugo; } }

  const refugoPorProduto = new Map<string, { nome: string; sku: string; produzido: number; refugo: number; valor: number }>();
  for (const a of apont) {
    const k = a.ordem.produtoId;
    const r = refugoPorProduto.get(k) ?? { nome: a.ordem.produto.nome, sku: a.ordem.produto.sku, produzido: 0, refugo: 0, valor: 0 };
    r.produzido += a.quantidade; r.refugo += a.refugo; r.valor += a.refugo * (a.ordem.produto.precoCusto || 0);
    refugoPorProduto.set(k, r);
  }
  const sobrecarga = carga.recursos.filter(r => r.semanas.some(s => (s.pct ?? 0) > 100));

  const alertas: { nivel: 'critico' | 'atencao' | 'info'; titulo: string; rota: string }[] = [];
  if (atrasadas.length) alertas.push({ nivel: 'critico', titulo: `${atrasadas.length} OP(s) com entrega atrasada`, rota: '/pcp/ordens?filtro=atrasadas' });
  const falta = semMaterial.filter(o => o.material!.status === 'Falta');
  if (falta.length) alertas.push({ nivel: 'critico', titulo: `${falta.length} OP(s) paradas por falta de material`, rota: '/pcp/mrp' });
  const parcial = semMaterial.filter(o => o.material!.status === 'Parcial');
  if (parcial.length) alertas.push({ nivel: 'atencao', titulo: `${parcial.length} OP(s) com material só para parte da quantidade`, rota: '/pcp/mrp' });
  for (const r of sobrecarga) { const pior = r.semanas.reduce((m, s, i) => ((s.pct ?? 0) > (r.semanas[m].pct ?? 0) ? i : m), 0); alertas.push({ nivel: 'atencao', titulo: `${r.nome} com ${r.semanas[pior].pct}% de carga na semana de ${isoDia(semanas[pior])!.split('-').reverse().slice(0, 2).join('/')}`, rota: '/pcp/programacao' }); }
  const semRec = ops.filter(o => !o.recursoId).length;
  if (semRec) alertas.push({ nivel: 'info', titulo: `${semRec} OP(s) sem recurso definido`, rota: '/pcp/programacao' });
  const semData = ops.filter(o => !o.inicioPrevisto).length;
  if (semData) alertas.push({ nivel: 'info', titulo: `${semData} OP(s) sem data de início`, rota: '/pcp/programacao' });
  const planejadasOk = ops.filter(o => o.status === 'Planejada' && o.material?.status === 'OK').length;
  if (planejadasOk) alertas.push({ nivel: 'info', titulo: `${planejadasOk} OP(s) planejadas com material disponível, prontas para liberar`, rota: '/pcp' });

  return res.json({
    hoje,
    kpis: {
      abertas: ops.length, planejadas: ops.filter(o => o.status === 'Planejada').length, liberadas: ops.filter(o => o.status === 'Liberada').length,
      emProducao: ops.filter(o => o.status === 'Em produção').length, pausadas: ops.filter(o => o.status === 'Pausada').length,
      atrasadas: atrasadas.length, semMaterial: semMaterial.length, unidadesEmAberto: ops.reduce((a, o) => a + o.restante, 0),
      produzido30d: produzido, refugo30d: refugo, refugoPct: produzido + refugo > 0 ? r1((refugo / (produzido + refugo)) * 100) : null,
      concluidas30d: concluidas.length, noPrazoPct: comPrazo.length ? r1((noPrazo / comPrazo.length) * 100) : null,
      cicloMedioDias: ciclos.length ? r1(ciclos.reduce((a, b) => a + b, 0) / ciclos.length) : null,
      produtividadeHora: minutos > 0 ? r1((minutosQtd / minutos) * 60) : null, aderenciaPlano: aderencia,
      valorEmAberto: ops.reduce((a, o) => a + o.custoPrevisto * (o.restante / Math.max(1, o.quantidadePlanejada)), 0),
    },
    alertas,
    serie: [...serie.values()],
    carga: { semanas: semanas.map(isoDia), ...carga },
    refugo: [...refugoPorProduto.values()].filter(r => r.refugo > 0).sort((a, b) => b.valor - a.valor).slice(0, 6),
  });
});

export default router;
