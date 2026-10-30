import { Router } from 'express';
import { prisma, type Db } from '../lib/prisma';
import { badRequest, notFound, num, dataOuNull } from '../lib/http';
import {
  STATUS_LOTE, TIPOS_MATERIAL, codigoLote, codigoOT, evento, lotesDisponiveis, movimentar, planejarConsumo, quem, r3, travar, verificarIntegridade, type Quem,
} from '../lib/tf';

// ============================================================
// ✨ FASE 6: TRANSFORMAÇÃO — estoque segregado e auditável (rotas /tf/*).
// Não lê nem grava nas tabelas do estoque oficial (Estoque, Movimentacao, Produto).
// ============================================================
const router = Router();
const TX = { timeout: 30000, maxWait: 15000 };
const DIA = 86400000;

const texto = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

// ------------------------------------------------------------ painel
router.get('/tf/painel', async (_req, res) => {
  const desde = new Date(Date.now() - 30 * DIA);
  const [materiais, lotes, ordens30, aguardando, integridade] = await Promise.all([
    prisma.tfMaterial.findMany({ where: { ativo: true }, include: { lotes: { select: { saldo: true, status: true, validade: true } } } }),
    prisma.tfLote.findMany({ where: { saldo: { gt: 0 } }, include: { material: { select: { nome: true, codigo: true, unidade: true } } } }),
    prisma.tfOrdem.findMany({ where: { status: 'Concluída', concluidaEm: { gte: desde } }, include: { itens: true, produto: { select: { nome: true, unidade: true } }, receita: { select: { codigo: true, nome: true } } }, orderBy: { concluidaEm: 'asc' } }),
    prisma.tfOrdem.count({ where: { status: 'Aguardando aprovação' } }),
    verificarIntegridade(),
  ]);
  const hoje = Date.now();
  const valor = materiais.reduce((a, m) => a + m.lotes.reduce((x, l) => x + l.saldo, 0) * (m.custoUnitario || 0), 0);
  const abaixoMinimo = materiais.filter(m => m.estoqueMinimo !== null && m.lotes.filter(l => l.status === 'Liberado').reduce((a, l) => a + l.saldo, 0) < (m.estoqueMinimo ?? 0))
    .map(m => ({ id: m.id, codigo: m.codigo, nome: m.nome, unidade: m.unidade, saldo: r3(m.lotes.filter(l => l.status === 'Liberado').reduce((a, l) => a + l.saldo, 0)), minimo: m.estoqueMinimo }));
  const comReceita = ordens30.filter(o => o.rendimento !== null);
  const perdasPorMotivo = new Map<string, number>();
  for (const o of ordens30) for (const i of o.itens.filter(x => x.papel === 'PERDA')) perdasPorMotivo.set(i.motivo || 'Sem motivo', (perdasPorMotivo.get(i.motivo || 'Sem motivo') || 0) + 1);
  return res.json({
    kpis: {
      materiais: materiais.length, lotesComSaldo: lotes.length, valor,
      ordens30: ordens30.length, rendimentoMedio: comReceita.length ? r3(comReceita.reduce((a, o) => a + (o.rendimento ?? 0), 0) / comReceita.length) : null,
      foraDaTolerancia: ordens30.filter(o => o.faixa === 'Justificar' || o.faixa === 'Aprovar').length, aguardando,
      quarentena: lotes.filter(l => l.status === 'Quarentena').length, bloqueados: lotes.filter(l => l.status === 'Bloqueado').length,
      vencidos: lotes.filter(l => l.validade && l.validade.getTime() < hoje).length,
      vencendo: lotes.filter(l => l.validade && l.validade.getTime() >= hoje && l.validade.getTime() < hoje + 30 * DIA).length,
    },
    rendimentos: comReceita.slice(-20).map(o => ({ codigo: o.codigo, data: o.concluidaEm, produto: o.produto.nome, rendimento: o.rendimento, faixa: o.faixa })),
    perdasPorMotivo: [...perdasPorMotivo.entries()].map(([motivo, vezes]) => ({ motivo, vezes })).sort((a, b) => b.vezes - a.vezes),
    abaixoMinimo,
    integridade: { integro: integridade.integro, movimentos: integridade.movimentos.total, eventos: integridade.eventos.total },
  });
});

// ------------------------------------------------------------ materiais
router.get('/tf/materiais', async (_req, res) => {
  const materiais = await prisma.tfMaterial.findMany({ orderBy: { nome: 'asc' }, include: { lotes: { select: { saldo: true, status: true, validade: true } }, _count: { select: { movimentos: true } } } });
  return res.json(materiais.map(({ lotes, _count, ...m }) => ({
    ...m,
    saldo: r3(lotes.reduce((a, l) => a + l.saldo, 0)),
    saldoLiberado: r3(lotes.filter(l => l.status === 'Liberado').reduce((a, l) => a + l.saldo, 0)),
    lotesComSaldo: lotes.filter(l => l.saldo > 0).length,
    proximaValidade: lotes.filter(l => l.saldo > 0 && l.validade).map(l => l.validade!).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
    movimentos: _count.movimentos,
  })));
});

function dadosMaterial(b: any) {
  const tipo = String(b.tipo || 'MATERIA_PRIMA');
  if (!(TIPOS_MATERIAL as readonly string[]).includes(tipo)) throw badRequest('Tipo de material inválido.');
  const proprietario = b.proprietario === 'Terceiro' ? 'Terceiro' : 'Próprio';
  return {
    codigo: String(b.codigo || '').trim().toUpperCase(), nome: String(b.nome || '').trim(), tipo, unidade: String(b.unidade || 'UN').trim().toUpperCase(),
    custoUnitario: b.custoUnitario === '' || b.custoUnitario === undefined || b.custoUnitario === null ? null : num(b.custoUnitario),
    estoqueMinimo: b.estoqueMinimo === '' || b.estoqueMinimo === undefined || b.estoqueMinimo === null ? null : num(b.estoqueMinimo),
    controlaValidade: Boolean(b.controlaValidade), proprietario,
    terceiroNome: proprietario === 'Terceiro' ? texto(b.terceiroNome) : null, terceiroDoc: proprietario === 'Terceiro' ? texto(b.terceiroDoc) : null,
    observacao: texto(b.observacao),
  };
}

router.post('/tf/materiais', async (req, res) => {
  const q = await quem(req);
  const d = dadosMaterial(req.body || {});
  if (!d.codigo || !d.nome) throw badRequest('Informe código e nome.');
  if (d.proprietario === 'Terceiro' && !d.terceiroNome) throw badRequest('Informe o dono do material (terceiro).');
  const criado = await prisma.$transaction(async tx => {
    await travar(tx);
    const m = await tx.tfMaterial.create({ data: d });
    await evento(tx, { entidade: 'Material', entidadeId: m.id, acao: 'Cadastro', resumo: `Cadastrou [${m.codigo}] ${m.nome} (${m.unidade}).`, depois: d }, q);
    return m;
  }, TX);
  return res.status(201).json(criado);
});

router.put('/tf/materiais/:id', async (req, res) => {
  const q = await quem(req);
  const id = String(req.params.id);
  const d = dadosMaterial(req.body || {});
  const atualizado = await prisma.$transaction(async tx => {
    await travar(tx);
    const antes = await tx.tfMaterial.findUnique({ where: { id }, include: { _count: { select: { movimentos: true } } } });
    if (!antes) throw notFound('Material não encontrado.');
    if (antes._count.movimentos > 0 && antes.unidade !== d.unidade) throw new Error('A unidade não pode mudar depois que o material teve movimentos (os saldos perderiam o sentido). Cadastre um novo material.');
    const { _count, createdAt, updatedAt, id: _i, legadoId, ativo, ...anterior } = antes;
    const mudou = Object.fromEntries(Object.entries(d).filter(([k, v]) => (anterior as any)[k] !== v));
    if (!Object.keys(mudou).length) return antes;
    const m = await tx.tfMaterial.update({ where: { id }, data: d });
    await evento(tx, { entidade: 'Material', entidadeId: id, acao: 'Alteração', resumo: `Alterou [${m.codigo}] ${m.nome}: ${Object.keys(mudou).join(', ')}.`, antes: Object.fromEntries(Object.keys(mudou).map(k => [k, (anterior as any)[k]])), depois: mudou }, q);
    return m;
  }, TX);
  return res.json(atualizado);
});

router.post('/tf/materiais/:id/ativo', async (req, res) => {
  const q = await quem(req);
  const ativo = Boolean(req.body?.ativo);
  const m = await prisma.$transaction(async tx => {
    await travar(tx);
    const r = await tx.tfMaterial.update({ where: { id: String(req.params.id) }, data: { ativo } });
    await evento(tx, { entidade: 'Material', entidadeId: r.id, acao: ativo ? 'Reativação' : 'Desativação', resumo: `${ativo ? 'Reativou' : 'Desativou'} [${r.codigo}] ${r.nome}.` }, q);
    return r;
  }, TX);
  return res.json(m);
});

// ------------------------------------------------------------ lotes e movimentos
router.get('/tf/lotes', async (req, res) => {
  const where: any = {};
  if (req.query.materialId) where.materialId = String(req.query.materialId);
  if (req.query.comSaldo === '1') where.saldo = { gt: 0 };
  const lotes = await prisma.tfLote.findMany({ where, include: { material: { select: { id: true, codigo: true, nome: true, unidade: true, tipo: true, proprietario: true, terceiroNome: true } } }, orderBy: [{ createdAt: 'desc' }] });
  return res.json(lotes);
});

router.put('/tf/lotes/:id/status', async (req, res) => {
  const q = await quem(req);
  const status = String(req.body?.status || '');
  const motivo = texto(req.body?.motivo);
  if (!(STATUS_LOTE as readonly string[]).includes(status)) throw badRequest('Situação inválida.');
  if (!motivo) throw badRequest('Informe o motivo da mudança de situação.');
  const lote = await prisma.$transaction(async tx => {
    await travar(tx);
    const antes = await tx.tfLote.findUnique({ where: { id: String(req.params.id) }, include: { material: true } });
    if (!antes) throw notFound('Lote não encontrado.');
    const l = await tx.tfLote.update({ where: { id: antes.id }, data: { status } });
    await evento(tx, { entidade: 'Lote', entidadeId: l.id, acao: 'Situação', resumo: `Lote ${l.codigo} de ${antes.material.nome}: ${antes.status} → ${status}. Motivo: ${motivo}`, antes: { status: antes.status }, depois: { status, motivo } }, q);
    return l;
  }, TX);
  return res.json(lote);
});

router.get('/tf/movimentos', async (req, res) => {
  const where: any = {};
  if (req.query.materialId) where.materialId = String(req.query.materialId);
  if (req.query.loteId) where.loteId = String(req.query.loteId);
  if (req.query.ordemId) where.ordemId = String(req.query.ordemId);
  const movs = await prisma.tfMovimento.findMany({
    where, orderBy: { seq: 'desc' }, take: Math.min(5000, num(req.query.limite, 500)),
    include: { material: { select: { codigo: true, nome: true, unidade: true } }, lote: { select: { codigo: true } } },
  });
  return res.json(movs);
});

// Entrada de material (compra, recebimento de terceiro, saldo inicial…)
router.post('/tf/entradas', async (req, res) => {
  const q = await quem(req);
  const b = req.body || {};
  const quantidade = r3(num(b.quantidade));
  if (!b.materialId || quantidade <= 0) throw badRequest('Informe o material e uma quantidade maior que zero.');
  const status = (STATUS_LOTE as readonly string[]).includes(b.status) ? b.status : 'Liberado';
  const resultado = await prisma.$transaction(async tx => {
    await travar(tx);
    const material = await tx.tfMaterial.findUnique({ where: { id: String(b.materialId) } });
    if (!material || !material.ativo) throw new Error('Material não encontrado ou inativo.');
    const validade = dataOuNull(b.validade);
    if (material.controlaValidade && !validade) throw new Error(`${material.nome} controla validade: informe a data.`);
    const codigo = (texto(b.lote) || await codigoLote(tx, 'EN')).toUpperCase();
    let lote = await tx.tfLote.findUnique({ where: { materialId_codigo: { materialId: material.id, codigo } } });
    if (lote && validade && lote.validade && lote.validade.getTime() !== validade.getTime()) throw new Error(`O lote ${codigo} já existe com outra validade. Use outro código de lote.`);
    if (!lote) {
      lote = await tx.tfLote.create({ data: { materialId: material.id, codigo, validade, status, origem: 'Entrada', documento: texto(b.documento), fornecedor: texto(b.fornecedor) ?? material.terceiroNome } });
      if (status !== 'Liberado') await evento(tx, { entidade: 'Lote', entidadeId: lote.id, acao: 'Situação', resumo: `Lote ${codigo} de ${material.nome} recebido em ${status}.` }, q);
    }
    const mov = await movimentar(tx, { tipo: 'ENTRADA', materialId: material.id, loteId: lote.id, quantidade, documento: texto(b.documento), motivo: texto(b.motivo) ?? 'Entrada de material' }, q);
    return { lote, movimento: mov };
  }, TX);
  return res.status(201).json(resultado);
});

// Ajuste de inventário: informa o saldo contado; a diferença vira movimento com motivo obrigatório
router.post('/tf/ajustes', async (req, res) => {
  const q = await quem(req);
  const motivo = texto(req.body?.motivo);
  if (!req.body?.loteId) throw badRequest('Informe o lote.');
  if (!motivo) throw badRequest('O motivo do ajuste é obrigatório.');
  const contado = r3(num(req.body?.saldoContado, -1));
  if (contado < 0) throw badRequest('Informe o saldo contado.');
  const mov = await prisma.$transaction(async tx => {
    await travar(tx);
    const lote = await tx.tfLote.findUnique({ where: { id: String(req.body.loteId) } });
    if (!lote) throw new Error('Lote não encontrado.');
    const dif = r3(contado - lote.saldo);
    if (dif === 0) throw new Error('O saldo contado é igual ao do sistema. Nada a ajustar.');
    return movimentar(tx, { tipo: 'AJUSTE', materialId: lote.materialId, loteId: lote.id, quantidade: dif, motivo, documento: texto(req.body?.documento) }, q);
  }, TX);
  return res.status(201).json(mov);
});

// Saída: entrega do produto, devolução ao dono (terceiro), descarte…
router.post('/tf/saidas', async (req, res) => {
  const q = await quem(req);
  const b = req.body || {};
  const quantidade = r3(num(b.quantidade));
  const destino = texto(b.destino);
  if (!b.materialId || quantidade <= 0) throw badRequest('Informe o material e a quantidade.');
  if (!destino) throw badRequest('Informe o destino ou motivo da saída.');
  const movs = await prisma.$transaction(async tx => {
    await travar(tx);
    let partes: { loteId: string; quantidade: number }[];
    if (b.loteId) partes = [{ loteId: String(b.loteId), quantidade }];
    else {
      const p = await planejarConsumo(tx, String(b.materialId), quantidade);
      if (p.falta > 0) throw new Error(`Saldo liberado insuficiente de ${p.material.nome}: disponível ${p.disponivel}, saída ${quantidade}.`);
      partes = p.partes;
    }
    const out = [];
    for (const p of partes) out.push(await movimentar(tx, { tipo: 'SAIDA', materialId: String(b.materialId), loteId: p.loteId, quantidade: -p.quantidade, documento: texto(b.documento), motivo: destino }, q));
    return out;
  }, TX);
  return res.status(201).json(movs);
});

// ------------------------------------------------------------ receitas (versionadas)
const INCLUDE_RECEITA = { produto: { select: { id: true, codigo: true, nome: true, unidade: true } }, itens: { include: { material: { select: { id: true, codigo: true, nome: true, unidade: true } } } } } as const;

router.get('/tf/receitas', async (req, res) => {
  const receitas = await prisma.tfReceita.findMany({ where: req.query.todas === '1' ? {} : { ativa: true }, include: { ...INCLUDE_RECEITA, _count: { select: { ordens: true } } }, orderBy: [{ codigo: 'asc' }, { versao: 'desc' }] });
  return res.json(receitas);
});

router.get('/tf/receitas/:codigo/versoes', async (req, res) => {
  return res.json(await prisma.tfReceita.findMany({ where: { codigo: String(req.params.codigo) }, include: INCLUDE_RECEITA, orderBy: { versao: 'desc' } }));
});

/** Salvar sempre cria uma versão nova; as anteriores ficam guardadas (e as OTs antigas apontam para a versão que usaram). */
router.post('/tf/receitas', async (req, res) => {
  const q = await quem(req);
  const b = req.body || {};
  const itens: { materialId: string; quantidade: unknown; papel?: string }[] = Array.isArray(b.itens) ? b.itens : [];
  const base = r3(num(b.quantidadeBase, 1));
  if (!b.produtoId || !texto(b.nome)) throw badRequest('Informe o produto e o nome da receita.');
  if (base <= 0) throw badRequest('A quantidade base deve ser maior que zero.');
  const consumos = itens.filter(i => (i.papel || 'CONSUMO') === 'CONSUMO');
  if (!consumos.length) throw badRequest('A receita precisa de pelo menos um material consumido.');
  if (itens.some(i => !i.materialId || num(i.quantidade) <= 0)) throw badRequest('Todas as quantidades da receita devem ser maiores que zero.');
  if (itens.some(i => i.materialId === b.produtoId)) throw badRequest('O produto não pode ser consumido na própria receita.');
  const aviso = num(b.toleranciaAviso, 3), bloqueio = num(b.toleranciaBloqueio, 10);
  if (aviso < 0 || bloqueio < aviso) throw badRequest('A tolerância de aprovação deve ser maior ou igual à de justificativa.');

  const receita = await prisma.$transaction(async tx => {
    await travar(tx);
    const produto = await tx.tfMaterial.findUnique({ where: { id: String(b.produtoId) } });
    if (!produto) throw new Error('Produto não encontrado.');
    const codigo = (texto(b.codigo) || `RC-${produto.codigo}`).toUpperCase();
    const ultima = await tx.tfReceita.findFirst({ where: { codigo }, orderBy: { versao: 'desc' }, include: { itens: true } });
    if (ultima && ultima.produtoId !== produto.id) throw new Error(`O código ${codigo} já é usado por outra receita.`);
    await tx.tfReceita.updateMany({ where: { codigo }, data: { ativa: false } });
    const nova = await tx.tfReceita.create({
      data: {
        codigo, versao: (ultima?.versao ?? 0) + 1, nome: String(b.nome).trim(), produtoId: produto.id, quantidadeBase: base, toleranciaAviso: aviso, toleranciaBloqueio: bloqueio,
        observacao: texto(b.observacao), criadoPor: q.nome,
        itens: { create: itens.map(i => ({ materialId: i.materialId, quantidade: r3(num(i.quantidade)), papel: i.papel === 'SUBPRODUTO' ? 'SUBPRODUTO' : 'CONSUMO' })) },
      },
      include: INCLUDE_RECEITA,
    });
    const resumoItens = (its: { materialId: string; quantidade: number; papel: string }[]) => its.map(i => ({ materialId: i.materialId, quantidade: i.quantidade, papel: i.papel }));
    await evento(tx, {
      entidade: 'Receita', entidadeId: nova.id, acao: ultima ? 'Nova versão' : 'Cadastro',
      resumo: `${ultima ? `Criou a versão ${nova.versao} da` : 'Cadastrou a'} receita ${codigo} (${nova.nome}): rende ${base} ${produto.unidade} de ${produto.nome}.`,
      antes: ultima ? { versao: ultima.versao, quantidadeBase: ultima.quantidadeBase, toleranciaAviso: ultima.toleranciaAviso, toleranciaBloqueio: ultima.toleranciaBloqueio, itens: resumoItens(ultima.itens) } : null,
      depois: { versao: nova.versao, quantidadeBase: base, toleranciaAviso: aviso, toleranciaBloqueio: bloqueio, itens: resumoItens(nova.itens) },
    }, q);
    return nova;
  }, TX);
  return res.status(201).json(receita);
});

router.post('/tf/receitas/:id/arquivar', async (req, res) => {
  const q = await quem(req);
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const rec = await tx.tfReceita.update({ where: { id: String(req.params.id) }, data: { ativa: false } });
    await evento(tx, { entidade: 'Receita', entidadeId: rec.id, acao: 'Arquivamento', resumo: `Arquivou a receita ${rec.codigo} v${rec.versao}.` }, q);
    return rec;
  }, TX);
  return res.json(r);
});

// ------------------------------------------------------------ simulação (antes de executar)
async function simular(db: Db, receitaId: string, quantidade: number) {
  const receita = await db.tfReceita.findUnique({ where: { id: receitaId }, include: INCLUDE_RECEITA });
  if (!receita) throw notFound('Receita não encontrada.');
  const fator = quantidade / receita.quantidadeBase;
  const consumos: { materialId: string; material: { id: string; codigo: string; nome: string; unidade: string }; padrao: number; disponivel: number; falta: number; lotes: { loteId: string; codigo: string; quantidade: number }[] }[] = [];
  for (const i of receita.itens.filter(x => x.papel === 'CONSUMO')) {
    const padrao = r3(i.quantidade * fator);
    const p = await planejarConsumo(db, i.materialId, padrao);
    consumos.push({ materialId: i.materialId, material: i.material, padrao, disponivel: p.disponivel, falta: p.falta, lotes: p.partes });
  }
  const subprodutos = receita.itens.filter(x => x.papel === 'SUBPRODUTO').map(i => ({ materialId: i.materialId, material: i.material, esperado: r3(i.quantidade * fator) }));
  const maximo = Math.floor(Math.min(...receita.itens.filter(x => x.papel === 'CONSUMO').map(i => consumos.find(c => c.materialId === i.materialId)!.disponivel / i.quantidade)) * receita.quantidadeBase * 1000) / 1000;
  return { receita, quantidade, consumos, subprodutos, podeProduzir: Number.isFinite(maximo) ? maximo : 0, temMaterial: consumos.every(c => c.falta <= 0) };
}

router.get('/tf/simular', async (req, res) => {
  const qtd = r3(num(req.query.quantidade));
  if (!req.query.receitaId || qtd <= 0) throw badRequest('Informe a receita e a quantidade.');
  return res.json(await simular(prisma, String(req.query.receitaId), qtd));
});

// ------------------------------------------------------------ ordens de transformação
const INCLUDE_OT = {
  produto: { select: { id: true, codigo: true, nome: true, unidade: true } },
  receita: { select: { id: true, codigo: true, versao: true, nome: true, quantidadeBase: true, toleranciaAviso: true, toleranciaBloqueio: true } },
  itens: { include: { material: { select: { id: true, codigo: true, nome: true, unidade: true } }, lote: { select: { id: true, codigo: true } } } },
  requisicao: { select: { id: true, codigo: true } },
} as const;

const DA_REQUISICAO = 'Esta ordem pertence a um registro de transformação. Use a aba Requisições.';

router.get('/tf/ordens', async (req, res) => {
  const where: any = {};
  if (req.query.status) where.status = { in: String(req.query.status).split(',') };
  return res.json(await prisma.tfOrdem.findMany({ where, include: INCLUDE_OT, orderBy: { createdAt: 'desc' }, take: Math.min(2000, num(req.query.limite, 300)) }));
});

router.get('/tf/ordens/:id', async (req, res) => {
  const ordem = await prisma.tfOrdem.findUnique({ where: { id: String(req.params.id) }, include: INCLUDE_OT });
  if (!ordem) throw notFound('Ordem não encontrada.');
  const [movimentos, eventos] = await Promise.all([
    prisma.tfMovimento.findMany({ where: { ordemId: ordem.id }, orderBy: { seq: 'asc' }, include: { material: { select: { codigo: true, nome: true, unidade: true } }, lote: { select: { id: true, codigo: true } } } }),
    prisma.tfEvento.findMany({ where: { entidade: 'Ordem', entidadeId: ordem.id }, orderBy: { seq: 'asc' } }),
  ]);
  return res.json({ ...ordem, movimentos, eventos, balanco: balanco(ordem) });
});

/** Balanço de massa: só faz sentido em peso ou volume, com tudo na mesma unidade (somar peças diferentes não diz nada). */
const UNIDADES_MASSA = ['KG', 'G', 'MG', 'T', 'TON', 'L', 'ML', 'M3'];
function balanco(o: { itens: { papel: string; quantidade: number; material: { unidade: string } | null }[]; quantidadeProduzida: number | null; produto: { unidade: string } }) {
  const unidades = new Set([o.produto.unidade, ...o.itens.filter(i => i.material).map(i => i.material!.unidade)]);
  if (unidades.size !== 1 || o.quantidadeProduzida === null || !UNIDADES_MASSA.includes([...unidades][0])) return null;
  const entrada = r3(o.itens.filter(i => i.papel === 'CONSUMO').reduce((a, i) => a + i.quantidade, 0));
  const produto = r3(o.quantidadeProduzida);
  const sub = r3(o.itens.filter(i => i.papel === 'SUBPRODUTO').reduce((a, i) => a + i.quantidade, 0));
  const perdas = r3(o.itens.filter(i => i.papel === 'PERDA').reduce((a, i) => a + i.quantidade, 0));
  return { unidade: [...unidades][0], entrada, produto, subprodutos: sub, perdas, naoExplicado: r3(entrada - produto - sub - perdas) };
}

interface Execucao {
  consumos: { materialId: string; quantidade: number; loteId?: string | null }[];
  produzido: number;
  subprodutos: { materialId: string; quantidade: number }[];
  perdas: { materialId?: string | null; quantidade: number; motivo: string }[];
  loteCodigo?: string | null; validade?: Date | null; justificativa?: string | null; observacao?: string | null;
}

function lerExecucao(b: any): Execucao {
  const consumos = (Array.isArray(b.consumos) ? b.consumos : []).map((c: any) => ({ materialId: String(c.materialId), quantidade: r3(num(c.quantidade)), loteId: c.loteId || null })).filter((c: any) => c.quantidade > 0);
  const subprodutos = (Array.isArray(b.subprodutos) ? b.subprodutos : []).map((c: any) => ({ materialId: String(c.materialId), quantidade: r3(num(c.quantidade)) })).filter((c: any) => c.quantidade > 0);
  const perdas = (Array.isArray(b.perdas) ? b.perdas : []).map((c: any) => ({ materialId: c.materialId || null, quantidade: r3(num(c.quantidade)), motivo: texto(c.motivo) || '' })).filter((c: any) => c.quantidade > 0);
  if (!consumos.length) throw badRequest('Informe o que foi consumido.');
  if (perdas.some((p: any) => !p.motivo)) throw badRequest('Toda perda precisa de motivo.');
  const produzido = r3(num(b.produzido));
  if (produzido <= 0) throw badRequest('Informe a quantidade produzida.');
  return { consumos, produzido, subprodutos, perdas, loteCodigo: texto(b.loteCodigo), validade: dataOuNull(b.validade), justificativa: texto(b.justificativa), observacao: texto(b.observacao) };
}

/** Rendimento real × padrão e variação de consumo por material, com a faixa de tolerância. */
function avaliar(receita: { quantidadeBase: number; toleranciaAviso: number; toleranciaBloqueio: number; itens: { materialId: string; quantidade: number; papel: string }[] } | null, e: Execucao) {
  if (!receita) return { rendimento: null, desvio: null, faixa: 'Sem receita', variacoes: [] as { materialId: string; padrao: number; real: number; variacao: number }[] };
  const realPor = new Map<string, number>();
  for (const c of e.consumos) realPor.set(c.materialId, r3((realPor.get(c.materialId) || 0) + c.quantidade));
  const itensConsumo = receita.itens.filter(i => i.papel === 'CONSUMO');
  const esperado = Math.min(...itensConsumo.map(i => ((realPor.get(i.materialId) || 0) / i.quantidade) * receita.quantidadeBase));
  const rendimento = esperado > 0 ? r3((e.produzido / esperado) * 100) : 0;
  const desvio = r3(rendimento - 100);
  const variacoes = itensConsumo.map(i => {
    const padrao = r3(i.quantidade * (e.produzido / receita.quantidadeBase));
    const real = realPor.get(i.materialId) || 0;
    return { materialId: i.materialId, padrao, real, variacao: padrao > 0 ? r3(((real - padrao) / padrao) * 100) : 0 };
  });
  const pior = Math.max(Math.abs(desvio), ...variacoes.map(v => Math.abs(v.variacao)));
  const faixa = pior <= receita.toleranciaAviso ? 'OK' : pior <= receita.toleranciaBloqueio ? 'Justificar' : 'Aprovar';
  return { rendimento, desvio, faixa, variacoes };
}

/** Lança no razão uma OT já registrada (consumos FEFO, produto, subprodutos). */
async function postar(tx: Db, ordemId: string, q: Quem) {
  const ordem = await tx.tfOrdem.findUnique({ where: { id: ordemId }, include: { itens: true, produto: true } });
  if (!ordem || ordem.quantidadeProduzida === null) throw new Error('Ordem sem execução registrada.');
  const doc = ordem.codigo;
  let menorValidade: Date | null = null;
  for (const c of ordem.itens.filter(i => i.papel === 'CONSUMO')) {
    const p = await planejarConsumo(tx, c.materialId!, c.quantidade, c.loteId);
    if (p.falta > 0) throw new Error(`Saldo liberado insuficiente de ${p.material.nome}: precisa ${c.quantidade}, disponível ${p.disponivel} ${p.material.unidade}.`);
    for (const parte of p.partes) {
      await movimentar(tx, { tipo: 'CONSUMO', materialId: c.materialId!, loteId: parte.loteId, quantidade: -parte.quantidade, documento: doc, ordemId }, q);
      const l = await tx.tfLote.findUnique({ where: { id: parte.loteId }, select: { validade: true } });
      if (l?.validade && (!menorValidade || l.validade < menorValidade)) menorValidade = l.validade;
    }
  }
  const codigo = (ordem.loteCodigo || await codigoLote(tx, 'TF')).toUpperCase();
  const validade = ordem.validade ?? menorValidade; // por padrão herda a menor validade dos insumos
  const existente = await tx.tfLote.findUnique({ where: { materialId_codigo: { materialId: ordem.produtoId, codigo } } });
  if (existente) throw new Error(`Já existe o lote ${codigo} de ${ordem.produto.nome}. Use outro código.`);
  const lote = await tx.tfLote.create({ data: { materialId: ordem.produtoId, codigo, validade, origem: 'Transformação', ordemId, documento: doc } });
  await movimentar(tx, { tipo: 'PRODUCAO', materialId: ordem.produtoId, loteId: lote.id, quantidade: ordem.quantidadeProduzida, documento: doc, ordemId }, q);
  await tx.tfOrdemItem.create({ data: { ordemId, papel: 'PRODUTO', materialId: ordem.produtoId, loteId: lote.id, quantidade: ordem.quantidadeProduzida } });
  for (const s of ordem.itens.filter(i => i.papel === 'SUBPRODUTO')) {
    const ls = await tx.tfLote.upsert({
      where: { materialId_codigo: { materialId: s.materialId!, codigo } }, update: {},
      create: { materialId: s.materialId!, codigo, validade, origem: 'Subproduto', ordemId, documento: doc },
    });
    await movimentar(tx, { tipo: 'SUBPRODUTO', materialId: s.materialId!, loteId: ls.id, quantidade: s.quantidade, documento: doc, ordemId }, q);
    await tx.tfOrdemItem.update({ where: { id: s.id }, data: { loteId: ls.id } });
  }
  return tx.tfOrdem.update({ where: { id: ordemId }, data: { status: 'Concluída', concluidaEm: new Date(), loteCodigo: codigo, validade } });
}

async function registrarExecucao(tx: Db, ordemId: string, e: Execucao, q: Quem) {
  const ordem = await tx.tfOrdem.findUnique({ where: { id: ordemId }, include: { receita: { include: { itens: true } }, produto: true } });
  if (!ordem) throw new Error('Ordem não encontrada.');
  if (ordem.requisicaoId) throw new Error(DA_REQUISICAO);
  if (ordem.status !== 'Planejada') throw new Error(`A ordem está ${ordem.status.toLowerCase()} e não pode ser executada.`);
  // confere material antes de registrar (com aprovação pendente o estoque ainda não é mexido)
  const porMaterial = new Map<string, number>();
  for (const c of e.consumos) porMaterial.set(c.materialId, r3((porMaterial.get(c.materialId) || 0) + c.quantidade));
  for (const [mid, qtd] of porMaterial) {
    const p = await planejarConsumo(tx, mid, qtd, e.consumos.find(c => c.materialId === mid && c.loteId)?.loteId);
    if (p.falta > 0) throw new Error(`Saldo liberado insuficiente de ${p.material.nome}: precisa ${qtd}, disponível ${p.disponivel} ${p.material.unidade}.`);
  }
  if (e.loteCodigo && await tx.tfLote.findUnique({ where: { materialId_codigo: { materialId: ordem.produtoId, codigo: e.loteCodigo.toUpperCase() } } })) throw new Error(`Já existe o lote ${e.loteCodigo.toUpperCase()} deste produto.`);
  if (ordem.produto.controlaValidade && !e.validade) {
    // herda dos insumos; se nenhum insumo tiver validade, exige a data
    const algum = await tx.tfLote.findFirst({ where: { materialId: { in: [...porMaterial.keys()] }, validade: { not: null }, saldo: { gt: 0 } } });
    if (!algum) throw new Error(`${ordem.produto.nome} controla validade: informe a data do lote.`);
  }
  const av = avaliar(ordem.receita, e);
  if ((av.faixa === 'Justificar' || av.faixa === 'Aprovar') && !e.justificativa) {
    throw new Error(`Rendimento ou consumo fora da tolerância (${av.desvio !== null ? `rendimento ${r3(100 + av.desvio)}%` : ''}). Escreva a justificativa.`);
  }
  const padraoPor = new Map(av.variacoes.map(v => [v.materialId, v.padrao]));
  await tx.tfOrdemItem.deleteMany({ where: { ordemId } }); // itens planejados viram os itens reais
  await tx.tfOrdemItem.createMany({
    data: [
      ...[...porMaterial.entries()].map(([materialId, quantidade]) => ({ ordemId, papel: 'CONSUMO', materialId, quantidade, quantidadePadrao: padraoPor.get(materialId) ?? null, loteId: e.consumos.find(c => c.materialId === materialId && c.loteId)?.loteId ?? null })),
      ...e.subprodutos.map(s => ({ ordemId, papel: 'SUBPRODUTO', materialId: s.materialId, quantidade: s.quantidade })),
      ...e.perdas.map(p => ({ ordemId, papel: 'PERDA', materialId: p.materialId ?? null, quantidade: p.quantidade, motivo: p.motivo })),
    ],
  });
  const precisaAprovar = av.faixa === 'Aprovar';
  await tx.tfOrdem.update({
    where: { id: ordemId },
    data: {
      quantidadeProduzida: e.produzido, rendimento: av.rendimento, desvio: av.desvio, faixa: av.faixa, justificativa: e.justificativa,
      loteCodigo: e.loteCodigo?.toUpperCase() ?? null, validade: e.validade, observacao: e.observacao ?? ordem.observacao,
      executadoPor: q.nome, executadaEm: new Date(), status: precisaAprovar ? 'Aguardando aprovação' : 'Planejada',
    },
  });
  await evento(tx, {
    entidade: 'Ordem', entidadeId: ordemId, acao: 'Execução',
    resumo: `Apontou ${ordem.codigo}: ${e.produzido} ${ordem.produto.unidade} de ${ordem.produto.nome}${av.rendimento !== null ? `, rendimento ${av.rendimento}%` : ''}${precisaAprovar ? ' — aguardando aprovação de outro usuário' : ''}.`,
    depois: { consumos: e.consumos, produzido: e.produzido, subprodutos: e.subprodutos, perdas: e.perdas, rendimento: av.rendimento, faixa: av.faixa, justificativa: e.justificativa },
  }, q);
  if (!precisaAprovar) await postar(tx, ordemId, q);
  return { ...av, precisaAprovar };
}

// Cria uma OT (planejada) e, se vier "execucao", já executa na mesma transação.
router.post('/tf/ordens', async (req, res) => {
  const q = await quem(req);
  const b = req.body || {};
  const quantidade = r3(num(b.quantidadePlanejada ?? b.execucao?.produzido));
  if (quantidade <= 0) throw badRequest('Informe a quantidade a produzir.');
  const execucao = b.execucao ? lerExecucao(b.execucao) : null;
  const resultado = await prisma.$transaction(async tx => {
    await travar(tx);
    let produtoId = b.produtoId ? String(b.produtoId) : null;
    let receita = null;
    if (b.receitaId) {
      receita = await tx.tfReceita.findUnique({ where: { id: String(b.receitaId) }, include: { itens: true } });
      if (!receita) throw new Error('Receita não encontrada.');
      if (!receita.ativa) throw new Error(`A receita ${receita.codigo} v${receita.versao} foi substituída por uma versão mais nova.`);
      produtoId = receita.produtoId;
    }
    if (!produtoId) throw new Error('Informe o produto (ou a receita).');
    const produto = await tx.tfMaterial.findUnique({ where: { id: produtoId } });
    if (!produto) throw new Error('Produto não encontrado.');
    const fator = receita ? quantidade / receita.quantidadeBase : 0;
    const ordem = await tx.tfOrdem.create({
      data: {
        codigo: await codigoOT(tx), receitaId: receita?.id ?? null, produtoId, quantidadePlanejada: quantidade, observacao: texto(b.observacao), criadoPor: q.nome,
        itens: receita ? { create: receita.itens.filter(i => i.papel === 'CONSUMO').map(i => ({ papel: 'CONSUMO', materialId: i.materialId, quantidade: r3(i.quantidade * fator), quantidadePadrao: r3(i.quantidade * fator) })) } : undefined,
      },
    });
    await evento(tx, { entidade: 'Ordem', entidadeId: ordem.id, acao: 'Abertura', resumo: `Abriu ${ordem.codigo}: ${quantidade} ${produto.unidade} de ${produto.nome}${receita ? ` pela receita ${receita.codigo} v${receita.versao}` : ' sem receita'}.` }, q);
    const av = execucao ? await registrarExecucao(tx, ordem.id, execucao, q) : null;
    return { ordem: await tx.tfOrdem.findUnique({ where: { id: ordem.id }, include: INCLUDE_OT }), avaliacao: av };
  }, TX);
  return res.status(201).json(resultado);
});

router.post('/tf/ordens/:id/executar', async (req, res) => {
  const q = await quem(req);
  const e = lerExecucao(req.body || {});
  const r = await prisma.$transaction(async tx => { await travar(tx); return registrarExecucao(tx, String(req.params.id), e, q); }, TX);
  return res.json(r);
});

router.post('/tf/ordens/:id/aprovar', async (req, res) => {
  const q = await quem(req);
  const parecer = texto(req.body?.parecer);
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const o = await tx.tfOrdem.findUnique({ where: { id: String(req.params.id) } });
    if (!o) throw new Error('Ordem não encontrada.');
    if (o.status !== 'Aguardando aprovação') throw new Error('Esta ordem não está aguardando aprovação.');
    if (!q.id) throw new Error('Entre com o seu usuário para aprovar.');
    if (!q.admin) throw new Error('Somente administradores ou gestores aprovam desvios de rendimento.');
    if (q.nome === o.executadoPor) throw new Error('A aprovação precisa ser feita por outra pessoa (dupla checagem).');
    await tx.tfOrdem.update({ where: { id: o.id }, data: { aprovadoPor: q.nome, aprovadoEm: new Date() } });
    await evento(tx, { entidade: 'Ordem', entidadeId: o.id, acao: 'Aprovação', resumo: `Aprovou ${o.codigo} (rendimento ${o.rendimento}%).${parecer ? ` Parecer: ${parecer}` : ''}` }, q);
    return postar(tx, o.id, q);
  }, TX);
  return res.json(r);
});

router.post('/tf/ordens/:id/cancelar', async (req, res) => {
  const q = await quem(req);
  const motivo = texto(req.body?.motivo);
  if (!motivo) throw badRequest('Informe o motivo.');
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const o = await tx.tfOrdem.findUnique({ where: { id: String(req.params.id) } });
    if (!o) throw new Error('Ordem não encontrada.');
    if (o.requisicaoId) throw new Error(DA_REQUISICAO);
    if (!['Planejada', 'Aguardando aprovação'].includes(o.status)) throw new Error('Só ordens planejadas ou aguardando aprovação podem ser canceladas. Ordens concluídas são estornadas.');
    const acao = o.status === 'Aguardando aprovação' ? 'Reprovação' : 'Cancelamento';
    await evento(tx, { entidade: 'Ordem', entidadeId: o.id, acao, resumo: `${acao === 'Reprovação' ? 'Reprovou' : 'Cancelou'} ${o.codigo}. Motivo: ${motivo}` }, q);
    return tx.tfOrdem.update({ where: { id: o.id }, data: { status: 'Cancelada', canceladaEm: new Date(), motivoCancelamento: motivo } });
  }, TX);
  return res.json(r);
});

/** Estorno: devolve os insumos e retira o produto, com movimentos novos (nada é apagado). */
router.post('/tf/ordens/:id/estornar', async (req, res) => {
  const q = await quem(req);
  const motivo = texto(req.body?.motivo);
  if (!motivo) throw badRequest('Informe o motivo do estorno.');
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const o = await tx.tfOrdem.findUnique({ where: { id: String(req.params.id) } });
    if (!o) throw new Error('Ordem não encontrada.');
    if (o.requisicaoId) throw new Error(DA_REQUISICAO);
    if (o.status !== 'Concluída') throw new Error('Só ordens concluídas podem ser estornadas.');
    const movs = await tx.tfMovimento.findMany({ where: { ordemId: o.id }, orderBy: { seq: 'asc' }, include: { lote: true } });
    // o que foi gerado precisa estar intacto no estoque
    for (const m of movs.filter(x => x.tipo === 'PRODUCAO' || x.tipo === 'SUBPRODUTO')) {
      if (!m.lote || r3(m.lote.saldo) < r3(m.quantidade)) throw new Error(`O lote ${m.lote?.codigo} gerado por esta ordem já foi usado ou saiu. Estorne antes o que usou esse lote.`);
    }
    for (const m of movs.filter(x => x.tipo === 'PRODUCAO' || x.tipo === 'SUBPRODUTO')) await movimentar(tx, { tipo: 'ESTORNO', materialId: m.materialId, loteId: m.loteId!, quantidade: -m.quantidade, documento: o.codigo, ordemId: o.id, motivo }, q);
    for (const m of movs.filter(x => x.tipo === 'CONSUMO')) await movimentar(tx, { tipo: 'ESTORNO', materialId: m.materialId, loteId: m.loteId!, quantidade: -m.quantidade, documento: o.codigo, ordemId: o.id, motivo }, q);
    await evento(tx, { entidade: 'Ordem', entidadeId: o.id, acao: 'Estorno', resumo: `Estornou ${o.codigo}. Motivo: ${motivo}` }, q);
    return tx.tfOrdem.update({ where: { id: o.id }, data: { status: 'Estornada', estornadaEm: new Date(), motivoCancelamento: motivo } });
  }, TX);
  return res.json(r);
});

// ------------------------------------------------------------ rastreabilidade (genealogia de lote)
interface No { loteId: string; lote: string; material: string; codigoMaterial: string; unidade: string; quantidade: number; validade: Date | null; status: string; origem: string; documento: string | null; fornecedor: string | null; proprietario: string; ordem?: { id: string; codigo: string; data: Date | null; receita: string | null; rendimento: number | null } | null; filhos: No[]; saidas?: { data: Date; quantidade: number; destino: string | null; documento: string | null }[] }

async function noDoLote(loteId: string, qtd: number) {
  const l = await prisma.tfLote.findUnique({ where: { id: loteId }, include: { material: true } });
  if (!l) return null;
  return { l, no: { loteId: l.id, lote: l.codigo, material: l.material.nome, codigoMaterial: l.material.codigo, unidade: l.material.unidade, quantidade: qtd, validade: l.validade, status: l.status, origem: l.origem, documento: l.documento, fornecedor: l.fornecedor, proprietario: l.material.proprietario === 'Terceiro' ? `Terceiro: ${l.material.terceiroNome ?? ''}` : 'Próprio', filhos: [] as No[] } as No };
}

/** Para trás: de onde veio o lote (insumos consumidos pela OT que o gerou). */
async function origem(loteId: string, qtd: number, nivel = 0, vistos = new Set<string>()): Promise<No | null> {
  const r = await noDoLote(loteId, qtd);
  if (!r) return null;
  if (r.l.ordemId && nivel < 8 && !vistos.has(r.l.ordemId)) {
    vistos.add(r.l.ordemId);
    const ot = await prisma.tfOrdem.findUnique({ where: { id: r.l.ordemId }, include: { receita: { select: { codigo: true, versao: true } } } });
    if (ot) {
      r.no.ordem = { id: ot.id, codigo: ot.codigo, data: ot.concluidaEm, receita: ot.receita ? `${ot.receita.codigo} v${ot.receita.versao}` : null, rendimento: ot.rendimento };
      const consumos = await prisma.tfMovimento.findMany({ where: { ordemId: ot.id, tipo: 'CONSUMO' } });
      for (const c of consumos) { const f = await origem(c.loteId!, -c.quantidade, nivel + 1, vistos); if (f) r.no.filhos.push(f); }
    }
  }
  return r.no;
}

/** Para frente: onde o lote foi usado (OTs que o consumiram e os lotes que elas geraram) e para quem saiu. */
async function destino(loteId: string, qtd: number, nivel = 0, vistos = new Set<string>()): Promise<No | null> {
  const r = await noDoLote(loteId, qtd);
  if (!r) return null;
  const movs = await prisma.tfMovimento.findMany({ where: { loteId, tipo: { in: ['CONSUMO', 'SAIDA'] } }, orderBy: { seq: 'asc' } });
  r.no.saidas = movs.filter(m => m.tipo === 'SAIDA').map(m => ({ data: m.dataHora, quantidade: -m.quantidade, destino: m.motivo, documento: m.documento }));
  if (nivel < 8) {
    for (const c of movs.filter(m => m.tipo === 'CONSUMO' && m.ordemId && !vistos.has(m.ordemId!))) {
      vistos.add(c.ordemId!);
      const gerados = await prisma.tfMovimento.findMany({ where: { ordemId: c.ordemId!, tipo: { in: ['PRODUCAO', 'SUBPRODUTO'] } } });
      for (const g of gerados) {
        const f = await destino(g.loteId!, g.quantidade, nivel + 1, vistos);
        if (f) {
          const ot = await prisma.tfOrdem.findUnique({ where: { id: c.ordemId! }, select: { id: true, codigo: true, concluidaEm: true, rendimento: true } });
          f.ordem = ot ? { id: ot.id, codigo: ot.codigo, data: ot.concluidaEm, receita: null, rendimento: ot.rendimento } : null;
          f.quantidade = g.quantidade;
          r.no.filhos.push(f);
        }
      }
    }
  }
  return r.no;
}

router.get('/tf/rastreio', async (req, res) => {
  const termo = String(req.query.lote || '').trim().toUpperCase();
  if (!termo) throw badRequest('Informe o código do lote.');
  const lotes = await prisma.tfLote.findMany({ where: { codigo: { contains: termo, mode: 'insensitive' } }, include: { material: { select: { nome: true } } }, take: 20, orderBy: { createdAt: 'desc' } });
  if (req.query.loteId) {
    const loteId = String(req.query.loteId);
    const entradas = await prisma.tfMovimento.findMany({ where: { loteId, tipo: { in: ['ENTRADA', 'PRODUCAO', 'SUBPRODUTO'] } } });
    const qtdOrigem = r3(entradas.reduce((a, m) => a + m.quantidade, 0));
    const [para_tras, para_frente] = await Promise.all([origem(loteId, qtdOrigem), destino(loteId, qtdOrigem)]);
    const lote = await prisma.tfLote.findUnique({ where: { id: loteId }, include: { material: true } });
    return res.json({ lote, origem: para_tras, destino: para_frente, entradas });
  }
  return res.json({ lotes });
});

// ------------------------------------------------------------ auditoria
router.get('/tf/auditoria', async (req, res) => {
  const limite = Math.min(3000, num(req.query.limite, 800));
  const inicio = dataOuNull(req.query.inicio), fim = dataOuNull(req.query.fim);
  const periodo = inicio || fim ? { dataHora: { ...(inicio ? { gte: inicio } : {}), ...(fim ? { lte: new Date(fim.getTime() + DIA - 1) } : {}) } } : {};
  const [eventos, movimentos, legado] = await Promise.all([
    prisma.tfEvento.findMany({ where: periodo, orderBy: { seq: 'desc' }, take: limite }),
    prisma.tfMovimento.findMany({ where: periodo, orderBy: { seq: 'desc' }, take: limite, include: { material: { select: { codigo: true, nome: true, unidade: true } }, lote: { select: { codigo: true } } } }),
    prisma.transformacaoAuditoria.findMany({ where: periodo, orderBy: { dataHora: 'desc' }, take: limite }),
  ]);
  return res.json({ eventos, movimentos, legado });
});

router.get('/tf/integridade', async (_req, res) => res.json(await verificarIntegridade()));

export default router;
