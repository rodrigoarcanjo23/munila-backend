import { Router } from 'express';
import { prisma, type Db } from '../lib/prisma';
import { badRequest, notFound, num, dataOuNull } from '../lib/http';
import { codigoLote, codigoOT, codigoRQ, conferirNF, evento, movimentar, normalizarNF, planejarConsumo, quem, r3, travar, type Quem } from '../lib/tf';
import { FICHAS_PADRAO, MATERIAIS_PADRAO, RECEITAS_PADRAO } from '../lib/tfFichasPadrao';

// ============================================================
// ✨ FASE 9: REGISTRO DE TRANSFORMAÇÃO DE PRODUTO (importado / inacabado → acabado)
// Segue as três seções da ficha em papel:
//   1. Requisição do produto importado (VIAPRO pede; a Logística Munila entrega: lote, entregue por, data)
//   2. Conversão em produto acabado (divide o que foi entregue entre as saídas da ficha + quantidade avariada)
//   3. Lançamento de estoque do produto acabado (lote, quantidade real, lançado por, data)
// Tudo no estoque segregado da transformação (/tf), nunca no estoque oficial.
// ============================================================
const router = Router();
const TX = { timeout: 30000, maxWait: 15000 };
const texto = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

const ROTULO_UN: Record<string, string> = { PACK: 'Packs', SACHE: 'Sachês', UN: 'Und', CX: 'Caixas', DISPLAY: 'Displays', PACOTE: 'Pacotes', CARTUCHO: 'Cartuchos' };
const rotuloUn = (u: string) => ROTULO_UN[u] ?? u;
const fmt = (n: number) => String(r3(n)).replace('.', ',');

type ReceitaCompleta = NonNullable<Awaited<ReturnType<typeof receitaAtiva>>>;
const INCLUDE_RECEITA = { produto: { select: { id: true, codigo: true, nome: true, unidade: true } }, itens: { include: { material: { select: { id: true, codigo: true, nome: true, unidade: true } } } } } as const;
const receitaAtiva = (db: Db, codigo: string) => db.tfReceita.findFirst({ where: { codigo, ativa: true }, include: INCLUDE_RECEITA, orderBy: { versao: 'desc' } });

/** Texto da coluna "CÁLCULO" da ficha, a partir da proporção da receita. */
function calculo(r: ReceitaCompleta) {
  const cons = r.itens.filter(i => i.papel === 'CONSUMO');
  const B = r.quantidadeBase;
  if (cons.length === 1) {
    const Q = cons[0].quantidade, un = rotuloUn(cons[0].material.unidade);
    if (B === 1) return Q === 1 ? `Qtd ${un}` : `Qtd ${un} ÷ ${fmt(Q)}`;
    if (Q === 1) return `Qtd ${un} × ${fmt(B)}`;
    return `(Qtd ${un} × ${fmt(B)}) ÷ ${fmt(Q)}`;
  }
  const iguais = cons.every(i => i.quantidade === cons[0].quantidade);
  if (iguais && B === 1) return `Total ÷ ${fmt(cons[0].quantidade * cons.length)} (${fmt(cons[0].quantidade)} de cada)`;
  return cons.map(i => `${fmt(i.quantidade)} ${i.material.codigo}`).join(' + ') + (B === 1 ? ' por unidade' : ` por ${fmt(B)}`);
}

/** Ficha com as saídas (receita ativa de cada uma) e a lista de materiais de entrada. */
async function montarFicha(db: Db, ficha: { id: string; codigo: string; nome: string; observacao: string | null; ativa: boolean; saidas: { receitaCodigo: string; ordem: number }[] }) {
  const saidas = [];
  const entradas = new Map<string, { id: string; codigo: string; nome: string; unidade: string }>();
  for (const s of [...ficha.saidas].sort((a, b) => a.ordem - b.ordem)) {
    const receita = await receitaAtiva(db, s.receitaCodigo);
    if (!receita) { saidas.push({ receitaCodigo: s.receitaCodigo, receita: null, calculo: null }); continue; }
    for (const i of receita.itens.filter(x => x.papel === 'CONSUMO')) entradas.set(i.materialId, i.material);
    saidas.push({ receitaCodigo: s.receitaCodigo, receita, calculo: calculo(receita) });
  }
  return { id: ficha.id, codigo: ficha.codigo, nome: ficha.nome, observacao: ficha.observacao, ativa: ficha.ativa, saidas, entradas: [...entradas.values()] };
}

// ------------------------------------------------------------ fichas
router.get('/tf/fichas', async (req, res) => {
  const fichas = await prisma.tfFicha.findMany({ where: req.query.todas === '1' ? {} : { ativa: true }, include: { saidas: true, _count: { select: { requisicoes: true } } }, orderBy: { nome: 'asc' } });
  const out = [];
  for (const f of fichas) out.push({ ...(await montarFicha(prisma, f)), requisicoes: f._count.requisicoes });
  return res.json(out);
});

router.post('/tf/fichas', async (req, res) => {
  const q = await quem(req);
  const b = req.body || {};
  const nome = texto(b.nome);
  const saidas: string[] = (Array.isArray(b.saidas) ? b.saidas : []).map((s: unknown) => String(s).trim().toUpperCase()).filter(Boolean);
  if (!nome) throw badRequest('Informe o nome da ficha (o produto do registro).');
  if (!saidas.length) throw badRequest('Escolha pelo menos uma receita de saída.');
  if (new Set(saidas).size !== saidas.length) throw badRequest('A mesma receita aparece duas vezes.');
  const ficha = await prisma.$transaction(async tx => {
    await travar(tx);
    for (const c of saidas) if (!(await receitaAtiva(tx, c))) throw new Error(`A receita ${c} não existe ou está arquivada.`);
    const codigo = (texto(b.codigo) || nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')).toUpperCase();
    const existente = b.id ? await tx.tfFicha.findUnique({ where: { id: String(b.id) }, include: { saidas: true } }) : null;
    if (b.id && !existente) throw new Error('Ficha não encontrada.');
    const dados = { codigo, nome, observacao: texto(b.observacao) };
    let f;
    if (existente) {
      f = await tx.tfFicha.update({ where: { id: existente.id }, data: { ...dados, saidas: { deleteMany: {}, create: saidas.map((c, i) => ({ receitaCodigo: c, ordem: i })) } } });
      await evento(tx, { entidade: 'Ficha', entidadeId: f.id, acao: 'Alteração', resumo: `Alterou a ficha ${codigo} (${nome}): saídas ${saidas.join(', ')}.`, antes: { nome: existente.nome, saidas: existente.saidas.sort((a, b) => a.ordem - b.ordem).map(s => s.receitaCodigo) }, depois: { nome, saidas } }, q);
    } else {
      f = await tx.tfFicha.create({ data: { ...dados, criadoPor: q.nome, saidas: { create: saidas.map((c, i) => ({ receitaCodigo: c, ordem: i })) } } });
      await evento(tx, { entidade: 'Ficha', entidadeId: f.id, acao: 'Cadastro', resumo: `Cadastrou a ficha ${codigo} (${nome}) com as saídas ${saidas.join(', ')}.` }, q);
    }
    return f;
  }, TX);
  return res.status(201).json(ficha);
});

router.post('/tf/fichas/:id/ativa', async (req, res) => {
  const q = await quem(req);
  const ativa = Boolean(req.body?.ativa);
  const f = await prisma.$transaction(async tx => {
    await travar(tx);
    const r = await tx.tfFicha.update({ where: { id: String(req.params.id) }, data: { ativa } });
    await evento(tx, { entidade: 'Ficha', entidadeId: r.id, acao: ativa ? 'Reativação' : 'Arquivamento', resumo: `${ativa ? 'Reativou' : 'Arquivou'} a ficha ${r.codigo}.` }, q);
    return r;
  }, TX);
  return res.json(f);
});

/** Cadastra os materiais, receitas e fichas do registro em papel. Idempotente: o que já existe (pelo código) fica como está. */
router.post('/tf/fichas/padrao', async (req, res) => {
  const q = await quem(req);
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const criados = { materiais: [] as string[], receitas: [] as string[], fichas: [] as string[] };
    const ids = new Map<string, string>();
    for (const m of MATERIAIS_PADRAO) {
      let mat = await tx.tfMaterial.findUnique({ where: { codigo: m.codigo } });
      if (!mat) {
        mat = await tx.tfMaterial.create({ data: { codigo: m.codigo, nome: m.nome, tipo: m.tipo, unidade: m.unidade, observacao: 'Registro de transformação (importado / inacabado)' } });
        await evento(tx, { entidade: 'Material', entidadeId: mat.id, acao: 'Cadastro', resumo: `Cadastrou [${mat.codigo}] ${mat.nome} (${mat.unidade}) a partir do registro de transformação.` }, q);
        criados.materiais.push(m.codigo);
      }
      ids.set(m.codigo, mat.id);
    }
    for (const rc of RECEITAS_PADRAO) {
      if (await tx.tfReceita.findFirst({ where: { codigo: rc.codigo } })) continue;
      const nova = await tx.tfReceita.create({
        data: {
          codigo: rc.codigo, versao: 1, nome: rc.nome, produtoId: ids.get(rc.produto)!, quantidadeBase: rc.base, criadoPor: q.nome,
          observacao: 'Registro de transformação (importado / inacabado)',
          itens: { create: rc.itens.map(([codigo, quantidade]) => ({ materialId: ids.get(codigo)!, quantidade, papel: 'CONSUMO' })) },
        },
      });
      await evento(tx, { entidade: 'Receita', entidadeId: nova.id, acao: 'Cadastro', resumo: `Cadastrou a receita ${rc.codigo} (${rc.nome}): rende ${rc.base} de ${rc.produto}.`, depois: { itens: rc.itens } }, q);
      criados.receitas.push(rc.codigo);
    }
    for (const f of FICHAS_PADRAO) {
      if (await tx.tfFicha.findUnique({ where: { codigo: f.codigo } })) continue;
      const nova = await tx.tfFicha.create({ data: { codigo: f.codigo, nome: f.nome, observacao: f.observacao, criadoPor: q.nome, saidas: { create: f.saidas.map((c, i) => ({ receitaCodigo: c, ordem: i })) } } });
      await evento(tx, { entidade: 'Ficha', entidadeId: nova.id, acao: 'Cadastro', resumo: `Cadastrou a ficha ${f.codigo} (${f.nome}) a partir do registro de transformação.` }, q);
      criados.fichas.push(f.codigo);
    }
    return criados;
  }, { timeout: 60000, maxWait: 15000 });
  return res.status(201).json(r);
});

// ------------------------------------------------------------ requisições
const INCLUDE_RQ = {
  ficha: { include: { saidas: true } },
  itens: { include: { material: { select: { id: true, codigo: true, nome: true, unidade: true } } } },
  ordens: {
    include: {
      produto: { select: { id: true, codigo: true, nome: true, unidade: true } },
      receita: { select: { id: true, codigo: true, versao: true, quantidadeBase: true, toleranciaAviso: true, toleranciaBloqueio: true } },
      itens: { include: { material: { select: { id: true, codigo: true, nome: true, unidade: true } }, lote: { select: { id: true, codigo: true } } } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

async function carregarRq(db: Db, id: string) {
  const rq = await db.tfRequisicao.findUnique({ where: { id }, include: INCLUDE_RQ });
  if (!rq) throw notFound('Requisição não encontrada.');
  return rq;
}

router.get('/tf/requisicoes', async (req, res) => {
  const where: any = {};
  if (req.query.status) where.status = { in: String(req.query.status).split(',') };
  const lista = await prisma.tfRequisicao.findMany({ where, include: INCLUDE_RQ, orderBy: { createdAt: 'desc' }, take: Math.min(1000, num(req.query.limite, 300)) });
  return res.json(lista);
});

router.get('/tf/requisicoes/:id', async (req, res) => {
  const rq = await carregarRq(prisma, String(req.params.id));
  const ficha = await montarFicha(prisma, rq.ficha);
  // saldo de cada material de entrada (para a entrega e a conversão)
  const disponibilidade = [];
  for (const m of ficha.entradas) {
    const lotes = await prisma.tfLote.findMany({ where: { materialId: m.id, saldo: { gt: 0 } }, orderBy: [{ validade: 'asc' }, { createdAt: 'asc' }] });
    disponibilidade.push({
      materialId: m.id, saldoLiberado: r3(lotes.filter(l => l.status === 'Liberado').reduce((a, l) => a + l.saldo, 0)),
      lotes: lotes.map(l => ({ id: l.id, codigo: l.codigo, saldo: l.saldo, status: l.status, validade: l.validade })),
    });
  }
  const movimentos = await prisma.tfMovimento.findMany({
    where: { OR: [{ documento: rq.codigo }, { ordemId: { in: rq.ordens.map(o => o.id) } }] }, orderBy: { seq: 'asc' },
    include: { material: { select: { codigo: true, nome: true, unidade: true } }, lote: { select: { codigo: true } } },
  });
  const eventos = await prisma.tfEvento.findMany({ where: { entidade: 'Requisição', entidadeId: rq.id }, orderBy: { seq: 'asc' } });
  return res.json({ ...rq, fichaMontada: ficha, disponibilidade, movimentos, eventos });
});

// 1. Requisição (VIAPRO)
router.post('/tf/requisicoes', async (req, res) => {
  const q = await quem(req);
  const b = req.body || {};
  if (!b.fichaId) throw badRequest('Escolha a ficha (o produto do registro).');
  const itens = (Array.isArray(b.itens) ? b.itens : []).map((i: any) => ({ materialId: String(i.materialId), quantidade: r3(num(i.quantidade)) })).filter((i: any) => i.quantidade > 0);
  if (!itens.length) throw badRequest('Informe a quantidade de pelo menos um produto importado.');
  const rq = await prisma.$transaction(async tx => {
    await travar(tx);
    const f = await tx.tfFicha.findUnique({ where: { id: String(b.fichaId) }, include: { saidas: true } });
    if (!f || !f.ativa) throw new Error('Ficha não encontrada ou arquivada.');
    const ficha = await montarFicha(tx, f);
    const permitidos = new Set(ficha.entradas.map(e => e.id));
    for (const i of itens) if (!permitidos.has(i.materialId)) throw new Error('Um dos materiais não é entrada desta ficha.');
    const codigo = await codigoRQ(tx);
    const nova = await tx.tfRequisicao.create({
      data: {
        codigo, fichaId: f.id, numeroViapro: texto(b.numeroViapro), observacao: texto(b.observacao), solicitadoPor: q.nome,
        solicitadoEm: dataOuNull(b.solicitadoEm) ?? new Date(), itens: { create: itens },
      },
    });
    const desc = itens.map((i: any) => `${i.quantidade} ${ficha.entradas.find(e => e.id === i.materialId)!.codigo}`).join(', ');
    await evento(tx, { entidade: 'Requisição', entidadeId: nova.id, acao: 'Requisição', resumo: `Abriu ${codigo} (${f.nome})${nova.numeroViapro ? `, requisição VIAPRO ${nova.numeroViapro}` : ''}: ${desc}.` }, q);
    return nova;
  }, TX);
  return res.status(201).json(await carregarRq(prisma, rq.id));
});

// 1b. Entrega pela Logística Munila (lote, entregue por, data)
router.post('/tf/requisicoes/:id/entrega', async (req, res) => {
  const q = await quem(req);
  const b = req.body || {};
  const entreguePor = texto(b.entreguePor);
  if (!entreguePor) throw badRequest('Informe quem entregou.');
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const rq = await carregarRq(tx, String(req.params.id));
    if (!['Solicitada', 'Entregue'].includes(rq.status)) throw new Error(`A requisição está ${rq.status.toLowerCase()}; a entrega não pode mais ser alterada.`);
    const enviados = new Map<string, any>((Array.isArray(b.itens) ? b.itens : []).map((i: any) => [String(i.id), i]));
    const resumo: string[] = [];
    for (const item of rq.itens) {
      const e = enviados.get(item.id);
      const qtd = r3(num(e?.quantidadeEntregue, item.quantidade));
      if (qtd < 0) throw new Error('Quantidade entregue inválida.');
      let lotes: { loteId: string; codigo: string; quantidade: number }[] = [];
      if (qtd > 0) {
        const pedidos = (Array.isArray(e?.lotes) ? e.lotes : []).map((l: any) => ({ loteId: String(l.loteId), quantidade: r3(num(l.quantidade)) })).filter((l: any) => l.quantidade > 0);
        if (pedidos.length) {
          for (const l of pedidos) {
            const lote = await tx.tfLote.findUnique({ where: { id: l.loteId } });
            if (!lote || lote.materialId !== item.materialId) throw new Error(`Lote inválido para ${item.material.nome}.`);
            if (lote.status !== 'Liberado') throw new Error(`O lote ${lote.codigo} de ${item.material.nome} está ${lote.status.toLowerCase()}.`);
            if (lote.saldo < l.quantidade) throw new Error(`O lote ${lote.codigo} de ${item.material.nome} tem só ${r3(lote.saldo)}.`);
            lotes.push({ loteId: lote.id, codigo: lote.codigo, quantidade: l.quantidade });
          }
          if (r3(lotes.reduce((a, l) => a + l.quantidade, 0)) !== qtd) throw new Error(`A soma dos lotes de ${item.material.nome} precisa dar ${qtd}.`);
        } else {
          const p = await planejarConsumo(tx, item.materialId, qtd);
          if (p.falta > 0) throw new Error(`Não há saldo de ${item.material.nome} no estoque da transformação: precisa ${qtd}, tem ${p.disponivel} ${item.material.unidade}. Registre a entrada do material antes.`);
          lotes = p.partes;
        }
      }
      await tx.tfRequisicaoItem.update({ where: { id: item.id }, data: { quantidadeEntregue: qtd, lotes } });
      resumo.push(`${qtd} ${item.material.codigo}${lotes.length ? ` (lote ${lotes.map(l => l.codigo).join(', ')})` : ''}`);
    }
    if (!(await tx.tfRequisicaoItem.findMany({ where: { requisicaoId: rq.id } })).some(i => (i.quantidadeEntregue ?? 0) > 0)) throw new Error('Nada foi entregue.');
    await tx.tfRequisicao.update({ where: { id: rq.id }, data: { status: 'Entregue', entreguePor, entregueEm: dataOuNull(b.entregueEm) ?? new Date(), registradoEntregaPor: q.nome } });
    await evento(tx, { entidade: 'Requisição', entidadeId: rq.id, acao: 'Entrega', resumo: `${rq.status === 'Entregue' ? 'Corrigiu a entrega de' : 'Registrou a entrega de'} ${rq.codigo} por ${entreguePor}: ${resumo.join(', ')}.` }, q);
    return rq.id;
  }, TX);
  return res.json(await carregarRq(prisma, r));
});

async function cancelarOrdens(tx: Db, ordens: { id: string; codigo: string; status: string }[], motivo: string, q: Quem) {
  for (const o of ordens.filter(x => x.status === 'Planejada' || x.status === 'Aguardando aprovação')) {
    await tx.tfOrdem.update({ where: { id: o.id }, data: { status: 'Cancelada', canceladaEm: new Date(), motivoCancelamento: motivo } });
    await evento(tx, { entidade: 'Ordem', entidadeId: o.id, acao: 'Cancelamento', resumo: `Cancelou ${o.codigo}. Motivo: ${motivo}` }, q);
  }
}

// 2. Conversão (VIAPRO): quanto de cada saída e quanto avariou
router.post('/tf/requisicoes/:id/conversao', async (req, res) => {
  const q = await quem(req);
  const b = req.body || {};
  const responsavel = texto(b.responsavel) ?? q.nome;
  const saidas = (Array.isArray(b.saidas) ? b.saidas : []).map((s: any) => ({ receitaCodigo: String(s.receitaCodigo), quantidade: r3(num(s.quantidade)) })).filter((s: any) => s.quantidade > 0);
  const avarias = new Map<string, number>((Array.isArray(b.avarias) ? b.avarias : []).map((a: any) => [String(a.itemId), r3(num(a.quantidade))]));
  if (!saidas.length) throw badRequest('Informe a quantidade de pelo menos um produto acabado.');
  if ([...avarias.values()].some(v => v < 0)) throw badRequest('Quantidade avariada inválida.');
  const temAvaria = [...avarias.values()].some(v => v > 0);
  if (temAvaria && !texto(b.avariaMotivo)) throw badRequest('Descreva o que aconteceu com a quantidade avariada.');
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const rq = await carregarRq(tx, String(req.params.id));
    if (!['Entregue', 'Convertida'].includes(rq.status)) throw new Error(rq.status === 'Solicitada' ? 'Registre a entrega da logística antes da conversão.' : `A requisição está ${rq.status.toLowerCase()}.`);
    const ficha = await montarFicha(tx, rq.ficha);
    const consumoPor = new Map<string, number>();
    const planos: { receita: ReceitaCompleta; quantidade: number }[] = [];
    for (const s of saidas) {
      const sf = ficha.saidas.find(x => x.receitaCodigo === s.receitaCodigo);
      if (!sf?.receita) throw new Error(`A receita ${s.receitaCodigo} não faz parte desta ficha.`);
      planos.push({ receita: sf.receita, quantidade: s.quantidade });
      const fator = s.quantidade / sf.receita.quantidadeBase;
      for (const i of sf.receita.itens.filter(x => x.papel === 'CONSUMO')) consumoPor.set(i.materialId, r3((consumoPor.get(i.materialId) || 0) + i.quantidade * fator));
    }
    for (const [mid, qtd] of consumoPor) {
      const item = rq.itens.find(i => i.materialId === mid);
      const entregue = item?.quantidadeEntregue ?? 0;
      const avaria = item ? avarias.get(item.id) ?? 0 : 0;
      const nome = item?.material.nome ?? ficha.entradas.find(e => e.id === mid)?.nome ?? 'material';
      if (r3(qtd + avaria) > r3(entregue) + 0.0005) throw new Error(`${nome}: a conversão usa ${r3(qtd)}${avaria ? ` + ${avaria} avariado(s)` : ''}, mas só foram entregues ${r3(entregue)}.`);
    }
    for (const item of rq.itens) {
      const avaria = avarias.get(item.id) ?? 0;
      const usado = consumoPor.get(item.materialId) ?? 0;
      if (r3(usado + avaria) > r3(item.quantidadeEntregue ?? 0) + 0.0005) throw new Error(`${item.material.nome}: avaria maior que o entregue.`);
    }
    if (rq.status === 'Convertida') await cancelarOrdens(tx, rq.ordens, `Conversão de ${rq.codigo} refeita`, q);
    const criadas: string[] = [];
    for (const p of planos) {
      const fator = p.quantidade / p.receita.quantidadeBase;
      const o = await tx.tfOrdem.create({
        data: {
          codigo: await codigoOT(tx), receitaId: p.receita.id, produtoId: p.receita.produtoId, quantidadePlanejada: p.quantidade, criadoPor: q.nome, requisicaoId: rq.id,
          observacao: `Registro de transformação ${rq.codigo}${rq.numeroViapro ? ` · requisição VIAPRO ${rq.numeroViapro}` : ''}`,
          itens: { create: p.receita.itens.filter(i => i.papel === 'CONSUMO').map(i => ({ papel: 'CONSUMO', materialId: i.materialId, quantidade: r3(i.quantidade * fator), quantidadePadrao: r3(i.quantidade * fator) })) },
        },
      });
      await evento(tx, { entidade: 'Ordem', entidadeId: o.id, acao: 'Abertura', resumo: `Abriu ${o.codigo} pela requisição ${rq.codigo}: ${p.quantidade} ${p.receita.produto.unidade} de ${p.receita.produto.nome} (receita ${p.receita.codigo} v${p.receita.versao}).` }, q);
      criadas.push(`${p.quantidade} ${p.receita.produto.codigo}`);
    }
    for (const item of rq.itens) await tx.tfRequisicaoItem.update({ where: { id: item.id }, data: { avariada: avarias.get(item.id) ?? 0 } });
    await tx.tfRequisicao.update({ where: { id: rq.id }, data: { status: 'Convertida', responsavelConversao: responsavel, convertidaEm: dataOuNull(b.data) ?? new Date(), avariaMotivo: temAvaria ? texto(b.avariaMotivo) : null } });
    const avTxt = rq.itens.filter(i => (avarias.get(i.id) ?? 0) > 0).map(i => `${avarias.get(i.id)} ${i.material.codigo}`).join(', ');
    await evento(tx, { entidade: 'Requisição', entidadeId: rq.id, acao: 'Conversão', resumo: `${rq.status === 'Convertida' ? 'Refez' : 'Registrou'} a conversão de ${rq.codigo} (responsável ${responsavel}): ${criadas.join(', ')}${avTxt ? `. Avariado: ${avTxt}` : ''}.` }, q);
    return rq.id;
  }, TX);
  return res.json(await carregarRq(prisma, r));
});

/** Tira a quantidade dos lotes entregues para a requisição (e, se faltar, dos demais em FEFO), lançando o movimento. */
async function tirar(tx: Db, fila: Map<string, { loteId: string; restante: number }[]>, m: { tipo: string; materialId: string; quantidade: number; documento: string; ordemId?: string | null; motivo?: string | null }, q: Quem) {
  let falta = r3(m.quantidade);
  const partes: { loteId: string; quantidade: number }[] = [];
  for (const f of fila.get(m.materialId) || []) {
    if (falta <= 0) break;
    const lote = await tx.tfLote.findUnique({ where: { id: f.loteId } });
    if (!lote || lote.status !== 'Liberado') continue;
    const qtd = r3(Math.min(f.restante, lote.saldo, falta));
    if (qtd <= 0) continue;
    await movimentar(tx, { tipo: m.tipo, materialId: m.materialId, loteId: lote.id, quantidade: -qtd, documento: m.documento, ordemId: m.ordemId, motivo: m.motivo }, q);
    f.restante = r3(f.restante - qtd); falta = r3(falta - qtd);
    partes.push({ loteId: lote.id, quantidade: qtd });
  }
  if (falta > 0) {
    const p = await planejarConsumo(tx, m.materialId, falta);
    if (p.falta > 0) throw new Error(`Saldo liberado insuficiente de ${p.material.nome}: faltam ${p.falta} ${p.material.unidade}. Algum lote entregue foi usado em outro lugar.`);
    for (const parte of p.partes) {
      await movimentar(tx, { tipo: m.tipo, materialId: m.materialId, loteId: parte.loteId, quantidade: -parte.quantidade, documento: m.documento, ordemId: m.ordemId, motivo: m.motivo }, q);
      partes.push({ loteId: parte.loteId, quantidade: parte.quantidade });
    }
  }
  return partes;
}

// 3. Lançamento de estoque do produto acabado (Logística Munila)
router.post('/tf/requisicoes/:id/lancamento', async (req, res) => {
  const q = await quem(req);
  const b = req.body || {};
  const justificativa = texto(b.justificativa);
  const enviados = new Map<string, any>((Array.isArray(b.saidas) ? b.saidas : []).map((s: any) => [String(s.ordemId), s]));
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const rq = await carregarRq(tx, String(req.params.id));
    if (rq.status !== 'Convertida') throw new Error(rq.status === 'Concluída' ? 'Esta requisição já foi lançada.' : 'Registre a conversão antes do lançamento.');
    const ordens = rq.ordens.filter(o => o.status === 'Planejada');
    if (!ordens.length) throw new Error('Não há produto acabado para lançar.');
    // avalia rendimento de cada saída antes de mexer no estoque
    const planos = ordens.map(o => {
      const e = enviados.get(o.id);
      const produzido = r3(num(e?.produzido, o.quantidadePlanejada));
      if (produzido < 0) throw new Error('Quantidade lançada inválida.');
      const rendimento = o.quantidadePlanejada > 0 ? r3((produzido / o.quantidadePlanejada) * 100) : 0;
      const desvio = r3(rendimento - 100);
      const aviso = o.receita?.toleranciaAviso ?? 3, bloqueio = o.receita?.toleranciaBloqueio ?? 10;
      const faixa = Math.abs(desvio) <= aviso ? 'OK' : Math.abs(desvio) <= bloqueio ? 'Justificar' : 'Aprovar';
      return { o, produzido, rendimento, desvio, faixa, loteCodigo: texto(e?.loteCodigo)?.toUpperCase() ?? null, validade: dataOuNull(e?.validade), notaFiscal: normalizarNF(e?.notaFiscal) };
    });
    // cada fórmula (produto acabado) pertence a uma NF nova
    const semNF = planos.filter(p => !p.notaFiscal);
    if (semNF.length) throw new Error(`Informe a NF de ${semNF.map(p => p.o.produto.codigo).join(', ')}. Cada produto acabado pertence a uma NF própria.`);
    const nfs = planos.map(p => p.notaFiscal!);
    const repetida = nfs.find((nf, i) => nfs.indexOf(nf) !== i);
    if (repetida) throw new Error(`A NF ${repetida} foi informada para mais de um produto. Cada fórmula precisa de uma NF nova.`);
    for (const p of planos) await conferirNF(tx, p.notaFiscal, p.o.id);
    const fora = planos.filter(p => p.faixa !== 'OK');
    if (fora.length && !justificativa) throw new Error(`${fora.map(p => `${p.o.produto.codigo}: ${p.produzido} de ${p.o.quantidadePlanejada} calculados`).join('; ')}. Escreva a justificativa da diferença.`);
    if (fora.some(p => p.faixa === 'Aprovar') && !q.admin) throw new Error('A diferença passa da tolerância da receita: o lançamento precisa ser feito por um gestor ou administrador.');
    const codigos = planos.filter(p => p.loteCodigo).map(p => `${p.o.produtoId}|${p.loteCodigo}`);
    if (new Set(codigos).size !== codigos.length) throw new Error('O mesmo lote foi informado duas vezes para o mesmo produto.');

    const fila = new Map<string, { loteId: string; restante: number }[]>();
    for (const item of rq.itens) fila.set(item.materialId, ((item.lotes as any[]) || []).map(l => ({ loteId: String(l.loteId), restante: r3(num(l.quantidade)) })));

    const resumo: string[] = [];
    for (const p of planos) {
      const { o } = p;
      let menorValidade: Date | null = null;
      const consumos: { materialId: string; loteId: string; quantidade: number; padrao: number }[] = [];
      for (const c of o.itens.filter(i => i.papel === 'CONSUMO' && i.materialId)) {
        const partes = await tirar(tx, fila, { tipo: 'CONSUMO', materialId: c.materialId!, quantidade: c.quantidade, documento: o.codigo, ordemId: o.id }, q);
        for (const parte of partes) {
          consumos.push({ materialId: c.materialId!, loteId: parte.loteId, quantidade: parte.quantidade, padrao: parte.quantidade });
          const l = await tx.tfLote.findUnique({ where: { id: parte.loteId }, select: { validade: true } });
          if (l?.validade && (!menorValidade || l.validade < menorValidade)) menorValidade = l.validade;
        }
      }
      await tx.tfOrdemItem.deleteMany({ where: { ordemId: o.id, papel: 'CONSUMO' } });
      await tx.tfOrdemItem.createMany({ data: consumos.map(c => ({ ordemId: o.id, papel: 'CONSUMO', materialId: c.materialId, loteId: c.loteId, quantidade: c.quantidade, quantidadePadrao: c.padrao })) });
      const validade = p.validade ?? menorValidade;
      let codigoProd: string | null = null;
      if (p.produzido > 0) {
        codigoProd = p.loteCodigo || await codigoLote(tx, 'TF');
        if (await tx.tfLote.findUnique({ where: { materialId_codigo: { materialId: o.produtoId, codigo: codigoProd } } })) throw new Error(`Já existe o lote ${codigoProd} de ${o.produto.nome}. Use outro código.`);
        const lote = await tx.tfLote.create({ data: { materialId: o.produtoId, codigo: codigoProd, validade, origem: 'Transformação', ordemId: o.id, documento: `NF ${p.notaFiscal}` } });
        await movimentar(tx, { tipo: 'PRODUCAO', materialId: o.produtoId, loteId: lote.id, quantidade: p.produzido, documento: o.codigo, ordemId: o.id }, q);
        await tx.tfOrdemItem.create({ data: { ordemId: o.id, papel: 'PRODUTO', materialId: o.produtoId, loteId: lote.id, quantidade: p.produzido } });
      }
      await tx.tfOrdem.update({
        where: { id: o.id },
        data: {
          status: 'Concluída', quantidadeProduzida: p.produzido, rendimento: p.rendimento, desvio: p.desvio, faixa: p.faixa, justificativa: p.faixa === 'OK' ? null : justificativa,
          loteCodigo: codigoProd, validade, notaFiscal: p.notaFiscal, executadoPor: q.nome, executadaEm: new Date(), concluidaEm: new Date(),
          aprovadoPor: p.faixa === 'Aprovar' ? q.nome : null, aprovadoEm: p.faixa === 'Aprovar' ? new Date() : null,
        },
      });
      await evento(tx, { entidade: 'Ordem', entidadeId: o.id, acao: 'Execução', resumo: `Lançou ${o.codigo} (requisição ${rq.codigo}): ${p.produzido} ${o.produto.unidade} de ${o.produto.nome}${codigoProd ? `, lote ${codigoProd}` : ''}, NF ${p.notaFiscal}, rendimento ${p.rendimento}%.` }, q);
      resumo.push(`${p.produzido} ${o.produto.codigo}${codigoProd ? ` (lote ${codigoProd})` : ''} · NF ${p.notaFiscal}`);
    }
    // avaria: sai do estoque como perda, com o motivo informado na conversão
    for (const item of rq.itens.filter(i => i.avariada > 0)) {
      await tirar(tx, fila, { tipo: 'PERDA', materialId: item.materialId, quantidade: item.avariada, documento: rq.codigo, motivo: `Avaria na transformação: ${rq.avariaMotivo ?? 'sem descrição'}` }, q);
    }
    await tx.tfRequisicao.update({ where: { id: rq.id }, data: { status: 'Concluída', lancadoPor: q.nome, lancadoEm: new Date(), justificativa: fora.length ? justificativa : null } });
    await evento(tx, { entidade: 'Requisição', entidadeId: rq.id, acao: 'Lançamento', resumo: `Lançou ${rq.codigo} no estoque da transformação: ${resumo.join(', ')}.${fora.length ? ` Justificativa: ${justificativa}` : ''}` }, q);
    return rq.id;
  }, { timeout: 60000, maxWait: 15000 });
  return res.json(await carregarRq(prisma, r));
});

router.post('/tf/requisicoes/:id/cancelar', async (req, res) => {
  const q = await quem(req);
  const motivo = texto(req.body?.motivo);
  if (!motivo) throw badRequest('Informe o motivo.');
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const rq = await carregarRq(tx, String(req.params.id));
    if (!['Solicitada', 'Entregue', 'Convertida'].includes(rq.status)) throw new Error(rq.status === 'Concluída' ? 'Requisição já lançada no estoque: use o estorno.' : `A requisição já está ${rq.status.toLowerCase()}.`);
    await cancelarOrdens(tx, rq.ordens, `Requisição ${rq.codigo} cancelada: ${motivo}`, q);
    await tx.tfRequisicao.update({ where: { id: rq.id }, data: { status: 'Cancelada', canceladaEm: new Date(), motivoCancelamento: motivo } });
    await evento(tx, { entidade: 'Requisição', entidadeId: rq.id, acao: 'Cancelamento', resumo: `Cancelou ${rq.codigo}. Motivo: ${motivo}` }, q);
    return rq.id;
  }, TX);
  return res.json(await carregarRq(prisma, r));
});

router.post('/tf/requisicoes/:id/estornar', async (req, res) => {
  const q = await quem(req);
  const motivo = texto(req.body?.motivo);
  if (!motivo) throw badRequest('Informe o motivo do estorno.');
  const r = await prisma.$transaction(async tx => {
    await travar(tx);
    const rq = await carregarRq(tx, String(req.params.id));
    if (rq.status !== 'Concluída') throw new Error('Só requisições lançadas podem ser estornadas.');
    const concluidas = rq.ordens.filter(o => o.status === 'Concluída');
    const movs = await tx.tfMovimento.findMany({ where: { ordemId: { in: concluidas.map(o => o.id) } }, orderBy: { seq: 'asc' }, include: { lote: true } });
    for (const m of movs.filter(x => x.tipo === 'PRODUCAO')) {
      if (!m.lote || r3(m.lote.saldo) < r3(m.quantidade)) throw new Error(`O lote ${m.lote?.codigo} gerado por esta requisição já foi usado ou saiu. Estorne antes o que usou esse lote.`);
    }
    for (const o of concluidas) {
      const doOT = movs.filter(m => m.ordemId === o.id);
      for (const m of doOT.filter(x => x.tipo === 'PRODUCAO')) await movimentar(tx, { tipo: 'ESTORNO', materialId: m.materialId, loteId: m.loteId!, quantidade: -m.quantidade, documento: o.codigo, ordemId: o.id, motivo }, q);
      for (const m of doOT.filter(x => x.tipo === 'CONSUMO')) await movimentar(tx, { tipo: 'ESTORNO', materialId: m.materialId, loteId: m.loteId!, quantidade: -m.quantidade, documento: o.codigo, ordemId: o.id, motivo }, q);
      await tx.tfOrdem.update({ where: { id: o.id }, data: { status: 'Estornada', estornadaEm: new Date(), motivoCancelamento: motivo } });
      await evento(tx, { entidade: 'Ordem', entidadeId: o.id, acao: 'Estorno', resumo: `Estornou ${o.codigo} (requisição ${rq.codigo}). Motivo: ${motivo}` }, q);
    }
    const perdas = await tx.tfMovimento.findMany({ where: { documento: rq.codigo, tipo: 'PERDA', ordemId: null } });
    for (const m of perdas) await movimentar(tx, { tipo: 'ESTORNO', materialId: m.materialId, loteId: m.loteId!, quantidade: -m.quantidade, documento: rq.codigo, motivo }, q);
    await tx.tfRequisicao.update({ where: { id: rq.id }, data: { status: 'Estornada', canceladaEm: new Date(), motivoCancelamento: motivo } });
    await evento(tx, { entidade: 'Requisição', entidadeId: rq.id, acao: 'Estorno', resumo: `Estornou ${rq.codigo}: o produto acabado saiu e o importado voltou ao estoque. Motivo: ${motivo}` }, q);
    return rq.id;
  }, { timeout: 60000, maxWait: 15000 });
  return res.json(await carregarRq(prisma, r));
});

export default router;
