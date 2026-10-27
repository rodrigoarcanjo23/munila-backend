// ✨ FASE 7: mapa do armazém, slotting por giro e ondas de separação com rota.
import { Router } from 'express';
import { prisma, type Db } from '../lib/prisma';
import { badRequest, notFound, num } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import { STATUS, TIPOS_CONSUMO, armazemPadrao, diasAtras, gerarCodigoOnda, sugerirFEFO } from '../lib/estoque';
import {
  LARGURA_RUA, PASSO_MODULO, afinidade, classificarABC, distanciaEntre, montarPosicoes, normalizarEndereco, rotaS, sugerirSlotting, zonaDourada,
  type Layout, type Posicao, type ProdutoGiro,
} from '../lib/armazem';
import { concluirOrdem } from './wms.routes';

const router = Router();
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const TIPOS_POSICAO = ['Picking', 'Pulmão', 'Chão', 'Doca'];

async function nomeUsuario(req: Parameters<typeof usuarioDaRequisicao>[0]) {
  if (req.usuario?.nome) return req.usuario.nome;
  const id = usuarioDaRequisicao(req);
  if (!id) return 'Sistema';
  return (await prisma.usuario.findUnique({ where: { id }, select: { nome: true } }))?.nome ?? 'Sistema';
}

/** Endereços, produtos e giro de um armazém, com a posição de picking de cada produto resolvida. */
async function contexto(db: Db, armazemParam: unknown, dias = 90) {
  const armazemId = texto(armazemParam) ?? (await armazemPadrao(db));
  const padrao = await armazemPadrao(db);
  const doArmazem = (id: string | null) => id === armazemId || (!id && armazemId === padrao);
  const [locais, produtos, estoques, coletas] = await Promise.all([
    db.localizacao.findMany({ orderBy: { codigo: 'asc' } }),
    db.produto.findMany({ select: { id: true, nome: true, sku: true, enderecoLocalizacao: true } }),
    db.estoque.findMany({ where: { status: STATUS.DISPONIVEL, quantidade: { gt: 0 } }, select: { id: true, produtoId: true, quantidade: true, localizacaoId: true, armazemId: true, lote: true } }),
    db.movimentacao.groupBy({ by: ['produtoId'], where: { tipoAcao: { in: TIPOS_CONSUMO }, dataHora: { gte: diasAtras(dias) } }, _count: { _all: true } }),
  ]);
  const layout = montarPosicoes(locais.filter(l => doArmazem(l.armazemId)).map(l => ({ ...l, ativo: l.ativo ?? true })));
  const nColetas = new Map(coletas.map(c => [c.produtoId, c._count._all]));
  const estoqueArm = estoques.filter(e => doArmazem(e.armazemId));
  const saldo = new Map<string, number>();
  for (const e of estoqueArm) saldo.set(e.produtoId, (saldo.get(e.produtoId) ?? 0) + e.quantidade);

  const giro: ProdutoGiro[] = produtos.map(p => {
    let pos: Posicao | null = layout.porCodigo.get(normalizarEndereco(p.enderecoLocalizacao)) ?? null;
    if (!pos) {
      const linhas = estoqueArm.filter(e => e.produtoId === p.id && e.localizacaoId && layout.porId.has(e.localizacaoId)).sort((a, b) => b.quantidade - a.quantidade);
      if (linhas[0]) pos = layout.porId.get(linhas[0].localizacaoId!) ?? null;
    }
    return { id: p.id, nome: p.nome, sku: p.sku, coletas: nColetas.get(p.id) ?? 0, pos, enderecoTexto: p.enderecoLocalizacao };
  });
  return { armazemId, layout, giro, saldo, estoqueArm, locais, doArmazem };
}

const posResumo = (p: Posicao | null) => (p ? { id: p.id, codigo: p.codigo, rua: p.rua, modulo: p.modulo, nivel: p.nivel, custo: p.custo, dourada: zonaDourada(p.nivel) } : null);

// ================================================================== mapa
router.get('/wms/layout', async (req, res) => {
  const { armazemId, layout, giro, saldo, estoqueArm, locais } = await contexto(prisma, req.query.armazemId);
  const classe = classificarABC(giro);
  const armazens = await prisma.armazem.findMany({ where: { ativo: true }, orderBy: { nome: 'asc' }, select: { id: true, nome: true, codigo: true, padrao: true } });
  const porPos = new Map<string, ProdutoGiro[]>();
  for (const g of giro) if (g.pos) porPos.set(g.pos.id, [...(porPos.get(g.pos.id) ?? []), g]);
  const saldoNoLocal = (produtoId: string, posId: string) => estoqueArm.filter(e => e.produtoId === produtoId && e.localizacaoId === posId).reduce((a, e) => a + e.quantidade, 0);

  const posicoes = layout.posicoes.map(p => {
    const prods = (porPos.get(p.id) ?? []).sort((a, b) => b.coletas - a.coletas).map(g => ({
      id: g.id, nome: g.nome, sku: g.sku, coletas: g.coletas, classe: classe.get(g.id) ?? null, saldo: saldoNoLocal(g.id, p.id) || saldo.get(g.id) || 0,
    }));
    return { id: p.id, codigo: p.codigo, rua: p.rua, modulo: p.modulo, nivel: p.nivel, tipo: p.tipo ?? 'Picking', ativo: p.ativo, custo: p.custo, dourada: zonaDourada(p.nivel), produtos: prods, coletas: prods.reduce((a, x) => a + x.coletas, 0) };
  });

  // Endereços escritos no cadastro de produto que não existem como endereço cadastrado.
  const codigos = new Set(locais.map(l => normalizarEndereco(l.codigo)));
  const soltos = new Map<string, number>();
  for (const g of giro) if (g.enderecoTexto && !codigos.has(normalizarEndereco(g.enderecoTexto))) soltos.set(g.enderecoTexto.trim(), (soltos.get(g.enderecoTexto.trim()) ?? 0) + 1);

  const douradas = posicoes.filter(p => p.dourada && p.tipo === 'Picking');
  const itensA = giro.filter(g => classe.get(g.id) === 'A');
  return res.json({
    armazemId, armazens, ruas: layout.ruas, config: { larguraRua: LARGURA_RUA, passoModulo: PASSO_MODULO },
    posicoes,
    naoMapeados: layout.naoMapeados.map(l => ({ id: l.id, codigo: l.codigo, rua: l.rua, modulo: l.modulo, nivel: l.nivel, tipo: l.tipo })),
    enderecosSoltos: [...soltos.entries()].map(([texto, produtos]) => ({ texto, produtos })).sort((a, b) => b.produtos - a.produtos),
    semPosicao: giro.filter(g => !g.pos && g.coletas > 0).sort((a, b) => b.coletas - a.coletas).slice(0, 30).map(g => ({ id: g.id, nome: g.nome, sku: g.sku, coletas: g.coletas, classe: classe.get(g.id) ?? null, endereco: g.enderecoTexto })),
    resumo: {
      posicoes: posicoes.length, ocupadas: posicoes.filter(p => p.produtos.length).length, douradas: douradas.length,
      itensA: itensA.length, aNaDourada: itensA.filter(g => g.pos && zonaDourada(g.pos.nivel)).length, aSemPosicao: itensA.filter(g => !g.pos).length,
    },
  });
});

/** Gera endereços em lote: ruas × módulos × níveis, no formato RUA-MÓDULO-NÍVEL (ex.: A-03-2). */
router.post('/wms/layout/gerar', async (req, res) => {
  const b = req.body || {};
  const armazemId = texto(b.armazemId) ?? (await armazemPadrao(prisma));
  const ruas: string[] = (Array.isArray(b.ruas) ? b.ruas : String(b.ruas || '').split(/[,;\s]+/)).map((r: string) => String(r).trim().toUpperCase()).filter(Boolean);
  const modulos = Math.round(num(b.modulos)), niveis = Math.round(num(b.niveis));
  const tipo = TIPOS_POSICAO.includes(b.tipo) ? b.tipo : 'Picking';
  if (!ruas.length || modulos < 1 || niveis < 1) throw badRequest('Informe as ruas, a quantidade de módulos e de níveis.');
  if (ruas.length * modulos * niveis > 3000) throw badRequest('No máximo 3.000 endereços por vez.');
  const existentes = new Set((await prisma.localizacao.findMany({ select: { codigo: true } })).map(l => l.codigo));
  const novos = [];
  for (const rua of ruas) for (let m = 1; m <= modulos; m++) for (let n = 1; n <= niveis; n++) {
    const codigo = `${rua}-${String(m).padStart(2, '0')}-${n}`;
    if (existentes.has(codigo)) continue;
    novos.push({ codigo, zona: tipo, corredor: `Rua ${rua}`, prateleira: `Módulo ${m} · nível ${n}`, armazemId, rua, modulo: m, nivel: n, tipo });
  }
  if (novos.length) await prisma.localizacao.createMany({ data: novos });
  return res.status(201).json({ criados: novos.length, ignorados: ruas.length * modulos * niveis - novos.length });
});

/** Cria endereços a partir do texto livre usado no cadastro de produtos (para depois posicionar no mapa). */
router.post('/wms/layout/importar-enderecos', async (req, res) => {
  const { armazemId, giro, locais } = await contexto(prisma, req.body?.armazemId);
  const codigos = new Set(locais.map(l => normalizarEndereco(l.codigo)));
  const novos = new Map<string, string>();
  for (const g of giro) {
    const t = g.enderecoTexto?.trim();
    if (t && !codigos.has(normalizarEndereco(t))) novos.set(normalizarEndereco(t), t.toUpperCase());
  }
  if (novos.size) await prisma.localizacao.createMany({ data: [...novos.values()].map(codigo => ({ codigo, zona: 'Picking', corredor: '-', prateleira: '-', armazemId, tipo: 'Picking' })), skipDuplicates: true });
  return res.status(201).json({ criados: novos.size });
});

router.put('/wms/layout/posicoes/:id', async (req, res) => {
  const b = req.body || {};
  const rua = texto(b.rua)?.toUpperCase() ?? null;
  const modulo = b.modulo === '' || b.modulo === null || b.modulo === undefined ? null : Math.round(num(b.modulo));
  const nivel = b.nivel === '' || b.nivel === null || b.nivel === undefined ? null : Math.round(num(b.nivel));
  if ((modulo !== null && modulo < 1) || (nivel !== null && nivel < 1)) throw badRequest('Módulo e nível começam em 1.');
  const atual = await prisma.localizacao.update({
    where: { id: String(req.params.id) },
    data: { rua, modulo, nivel, tipo: TIPOS_POSICAO.includes(b.tipo) ? b.tipo : undefined, ativo: typeof b.ativo === 'boolean' ? b.ativo : undefined },
  });
  return res.json(atual);
});

/** Define a posição de picking de um produto (o endereço do cadastro e o endereço do saldo disponível). */
async function moverProduto(tx: Db, produtoId: string, para: { id: string; codigo: string }, deId: string | null, armazemId: string, doArmazem: (id: string | null) => boolean) {
  await tx.produto.update({ where: { id: produtoId }, data: { enderecoLocalizacao: para.codigo } });
  const linhas = await tx.estoque.findMany({ where: { produtoId, status: STATUS.DISPONIVEL }, select: { id: true, localizacaoId: true, armazemId: true } });
  const alvo = linhas.filter(l => doArmazem(l.armazemId) && (!l.localizacaoId || l.localizacaoId === deId)).map(l => l.id);
  if (alvo.length) await tx.estoque.updateMany({ where: { id: { in: alvo } }, data: { localizacaoId: para.id } });
  void armazemId;
}

router.post('/wms/layout/atribuir', async (req, res) => {
  const { produtoId, localizacaoId } = req.body || {};
  if (!produtoId || !localizacaoId) throw badRequest('Informe o produto e o endereço.');
  const { armazemId, giro, layout, doArmazem } = await contexto(prisma, req.body?.armazemId);
  const para = layout.porId.get(String(localizacaoId)) ?? (await prisma.localizacao.findUnique({ where: { id: String(localizacaoId) } }));
  if (!para) throw notFound('Endereço não encontrado.');
  const g = giro.find(x => x.id === produtoId);
  const usuario = await nomeUsuario(req);
  await prisma.$transaction(async tx => {
    await moverProduto(tx, String(produtoId), para, g?.pos?.id ?? null, armazemId, doArmazem);
    await tx.logAuditoria.create({ data: { acao: 'Endereço de picking', itemNome: g ? `[${g.sku}] ${g.nome}` : String(produtoId), usuarioNome: usuario, motivo: `${g?.pos?.codigo ?? g?.enderecoTexto ?? 'sem endereço'} → ${para.codigo}` } });
  });
  return res.json({ ok: true });
});

// ================================================================== slotting
router.get('/wms/slotting', async (req, res) => {
  const dias = Math.min(365, Math.max(30, num(req.query.dias, 90)));
  const { armazemId, layout, giro } = await contexto(prisma, req.query.armazemId, dias);
  const r = sugerirSlotting(giro, layout, { limite: 25 });

  const ordens = await prisma.ordemTransferencia.findMany({ where: { tipo: 'SAIDA', createdAt: { gte: diasAtras(180) } }, select: { itens: { select: { produtoId: true } } }, take: 3000, orderBy: { createdAt: 'desc' } });
  const nomeDe = new Map(giro.map(g => [g.id, g]));
  const pares = afinidade(ordens.map(o => o.itens.map(i => i.produtoId))).slice(0, 12).map(p => {
    const a = nomeDe.get(p.a), b = nomeDe.get(p.b);
    const dist = a?.pos && b?.pos ? Math.round(distanciaEntre(a.pos, b.pos) * 10) / 10 : null;
    return { ...p, produtoA: a && { id: a.id, nome: a.nome, sku: a.sku, pos: posResumo(a.pos) }, produtoB: b && { id: b.id, nome: b.nome, sku: b.sku, pos: posResumo(b.pos) }, distancia: dist, longe: dist !== null && dist > 8 };
  }).filter(p => p.produtoA && p.produtoB);

  const totalColetas = giro.reduce((a, g) => a + g.coletas, 0);
  const porClasse = (['A', 'B', 'C'] as const).map(c => {
    const itens = giro.filter(g => r.classe.get(g.id) === c);
    const comPos = itens.filter(g => g.pos);
    return {
      classe: c, itens: itens.length, coletas: itens.reduce((a, g) => a + g.coletas, 0),
      pctColetas: totalColetas ? Math.round((itens.reduce((a, g) => a + g.coletas, 0) / totalColetas) * 1000) / 10 : 0,
      custoMedio: comPos.length ? Math.round((comPos.reduce((a, g) => a + g.pos!.custo, 0) / comPos.length) * 10) / 10 : null,
      naDourada: comPos.filter(g => zonaDourada(g.pos!.nivel)).length, semPosicao: itens.length - comPos.length,
    };
  });

  return res.json({
    armazemId, dias, mapeado: layout.posicoes.length > 0, indice: r.indice, porClasse,
    ganhoMesMetros: Math.round(r.movimentos.reduce((a, m) => a + m.ganhoMetros, 0) * (30 / dias)),
    movimentos: r.movimentos.map(m => ({
      produto: { id: m.produto.id, nome: m.produto.nome, sku: m.produto.sku, coletas: m.produto.coletas, classe: r.classe.get(m.produto.id) ?? null },
      de: posResumo(m.de), para: posResumo(m.para),
      troca: m.troca ? { produto: { id: m.troca.produto.id, nome: m.troca.produto.nome, sku: m.troca.produto.sku, coletas: m.troca.produto.coletas, classe: r.classe.get(m.troca.produto.id) ?? null }, de: posResumo(m.troca.de), para: posResumo(m.troca.para) } : null,
      ganhoMesMetros: Math.round(m.ganhoMetros * (30 / dias)),
    })),
    afinidade: pares,
  });
});

/** Aplica uma sugestão de remanejamento (com troca, quando houver). Fica registrado na auditoria. */
router.post('/wms/slotting/aplicar', async (req, res) => {
  const { produtoId, paraId, trocaProdutoId } = req.body || {};
  if (!produtoId || !paraId) throw badRequest('Sugestão incompleta.');
  const { armazemId, giro, layout, doArmazem } = await contexto(prisma, req.body?.armazemId);
  const p = giro.find(g => g.id === produtoId);
  const para = layout.porId.get(String(paraId));
  if (!p || !para) throw notFound('Produto ou endereço não encontrado.');
  const outro = trocaProdutoId ? giro.find(g => g.id === trocaProdutoId) : null;
  if (trocaProdutoId && (!outro || outro.pos?.id !== para.id)) throw badRequest('O endereço mudou desde a sugestão. Atualize a tela.');
  if (outro && !p.pos) throw badRequest('Troca exige que o produto já tenha endereço.');
  const usuario = await nomeUsuario(req);
  await prisma.$transaction(async tx => {
    await moverProduto(tx, p.id, para, p.pos?.id ?? null, armazemId, doArmazem);
    if (outro && p.pos) {
      // o outro produto vai para o endereço que ficou livre (as linhas dele estavam em `para`)
      await tx.produto.update({ where: { id: outro.id }, data: { enderecoLocalizacao: p.pos.codigo } });
      await tx.estoque.updateMany({ where: { produtoId: outro.id, status: STATUS.DISPONIVEL, localizacaoId: para.id }, data: { localizacaoId: p.pos.id } });
    }
    await tx.logAuditoria.create({ data: {
      acao: 'Remanejamento (slotting)', itemNome: `[${p.sku}] ${p.nome}`, usuarioNome: usuario,
      motivo: `${p.pos?.codigo ?? 'sem endereço'} → ${para.codigo}${outro ? `; troca com [${outro.sku}] ${outro.nome} (${para.codigo} → ${p.pos?.codigo})` : ''}. Giro: ${p.coletas} coletas.`,
    } });
  });
  return res.json({ ok: true });
});

// ================================================================== ondas
type OrdemOnda = { id: string; codigo: string; prioridade: string; createdAt: Date; armazemId: string | null; itens: { id: string; produtoId: string; quantidade: number; marcado: boolean; produto: { id: string; nome: string; sku: string } }[] };

/** Monta as paradas da rota: uma por produto e lote (FEFO), no endereço do lote quando houver, senão no endereço do produto. */
async function montarColeta(db: Db, ordens: OrdemOnda[], layout: Layout, giro: ProdutoGiro[], armazemId: string) {
  const posProduto = new Map(giro.map(g => [g.id, g.pos]));
  const linhasEstoque = new Map((await db.estoque.findMany({ where: { produtoId: { in: [...new Set(ordens.flatMap(o => o.itens.map(i => i.produtoId)))] } }, select: { id: true, localizacaoId: true } })).map(e => [e.id, e.localizacaoId]));
  const porProduto = new Map<string, { produto: OrdemOnda['itens'][number]['produto']; total: number; marcado: boolean; destino: { ordemId: string; codigo: string; quantidade: number }[] }>();
  for (const o of ordens) for (const i of o.itens) {
    const l = porProduto.get(i.produtoId) ?? { produto: i.produto, total: 0, marcado: true, destino: [] };
    l.total += i.quantidade; l.marcado = l.marcado && i.marcado; l.destino.push({ ordemId: o.id, codigo: o.codigo, quantidade: i.quantidade });
    porProduto.set(i.produtoId, l);
  }
  const paradas = [];
  for (const [produtoId, l] of porProduto) {
    const f = await sugerirFEFO(db, produtoId, l.total, armazemId);
    const partes = f.partes.length ? f.partes : [{ estoqueId: '', lote: null, validade: null, quantidade: l.total, armazemId }];
    for (const parte of partes) {
      const locId = parte.estoqueId ? linhasEstoque.get(parte.estoqueId) : null;
      const pos = (locId && layout.porId.get(locId)) || posProduto.get(produtoId) || null;
      paradas.push({ pos, dados: { produtoId, produto: l.produto, lote: parte.lote, validade: parte.validade, quantidade: parte.quantidade, totalProduto: l.total, falta: f.falta, marcado: l.marcado, destino: l.destino } });
    }
  }
  return paradas;
}

function distanciaIndividual(ordens: OrdemOnda[], layout: Layout, giro: ProdutoGiro[]) {
  const pos = new Map(giro.map(g => [g.id, g.pos]));
  return Math.round(ordens.reduce((a, o) => a + rotaS(o.itens.map(i => ({ pos: pos.get(i.produtoId) ?? null, dados: null })), layout).distancia, 0) * 10) / 10;
}

const INCLUDE_ONDA = { ordens: { include: { itens: { include: { produto: { select: { id: true, nome: true, sku: true } } } }, solicitante: { select: { nome: true } } }, orderBy: { createdAt: 'asc' as const } } };

router.get('/wms/ondas', async (_req, res) => {
  const ondas = await prisma.ondaSeparacao.findMany({ include: { ordens: { select: { id: true, codigo: true, status: true, itens: { select: { quantidade: true, marcado: true } } } } }, orderBy: { createdAt: 'desc' }, take: 60 });
  return res.json(ondas.map(o => ({
    ...o, linhas: o.ordens.reduce((a, x) => a + x.itens.length, 0), marcadas: o.ordens.reduce((a, x) => a + x.itens.filter(i => i.marcado).length, 0),
    unidades: o.ordens.reduce((a, x) => a + x.itens.reduce((s, i) => s + i.quantidade, 0), 0),
  })));
});

/** Ordens pendentes que podem entrar numa onda, com uma sugestão de agrupamento (urgentes e mais antigas primeiro, priorizando ruas em comum). */
router.get('/wms/ondas/sugestao', async (req, res) => {
  const max = Math.min(20, Math.max(2, num(req.query.max, 8)));
  const { armazemId, layout, giro, doArmazem } = await contexto(prisma, req.query.armazemId);
  const pend = (await prisma.ordemTransferencia.findMany({
    where: { status: 'Pendente', tipo: 'SAIDA', ondaId: null }, include: { itens: { include: { produto: { select: { id: true, nome: true, sku: true } } } }, solicitante: { select: { nome: true } } }, orderBy: { createdAt: 'asc' },
  })).filter(o => doArmazem(o.armazemId));
  const pos = new Map(giro.map(g => [g.id, g.pos]));
  const ruasDe = (o: (typeof pend)[number]) => new Set(o.itens.map(i => pos.get(i.produtoId)?.rua ?? '?'));
  const peso: Record<string, number> = { Urgente: 0, Alta: 1, Normal: 2, Baixa: 3 };
  const fila = [...pend].sort((a, b) => (peso[a.prioridade] ?? 2) - (peso[b.prioridade] ?? 2) || a.createdAt.getTime() - b.createdAt.getTime());
  const escolhidas: typeof pend = [];
  if (fila.length) {
    escolhidas.push(fila[0]);
    const ruas = ruasDe(fila[0]);
    const resto = fila.slice(1).map(o => {
      const r = ruasDe(o); const comuns = [...r].filter(x => ruas.has(x)).length;
      return { o, score: (3 - (peso[o.prioridade] ?? 2)) + (comuns / Math.max(1, r.size)) * 3 };
    }).sort((a, b) => b.score - a.score);
    for (const { o } of resto) { if (escolhidas.length >= max) break; escolhidas.push(o); ruasDe(o).forEach(r => ruas.add(r)); }
  }
  const coleta = escolhidas.length ? rotaS(escolhidas.flatMap(o => o.itens.map(i => ({ pos: pos.get(i.produtoId) ?? null, dados: null }))), layout) : null;
  const individual = distanciaIndividual(escolhidas, layout, giro);
  return res.json({
    armazemId, mapeado: layout.posicoes.length > 0,
    pendentes: pend.map(o => ({
      id: o.id, codigo: o.codigo, prioridade: o.prioridade, createdAt: o.createdAt, solicitante: o.solicitante?.nome ?? '-', linhas: o.itens.length,
      unidades: o.itens.reduce((a, i) => a + i.quantidade, 0), ruas: [...ruasDe(o)].filter(r => r !== '?').sort(), semPosicao: o.itens.filter(i => !pos.get(i.produtoId)).length,
    })),
    sugestao: { ordemIds: escolhidas.map(o => o.id), distanciaOnda: coleta?.distancia ?? 0, distanciaIndividual: individual },
  });
});

/** Simula a rota para um conjunto de ordens escolhido na tela (antes de criar a onda). */
router.post('/wms/ondas/simular', async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ordemIds) ? req.body.ordemIds : [];
  const { layout, giro } = await contexto(prisma, req.body?.armazemId);
  const ordens = await prisma.ordemTransferencia.findMany({ where: { id: { in: ids } }, include: { itens: { include: { produto: { select: { id: true, nome: true, sku: true } } } } } });
  const pos = new Map(giro.map(g => [g.id, g.pos]));
  const r = rotaS(ordens.flatMap(o => o.itens.map(i => ({ pos: pos.get(i.produtoId) ?? null, dados: null }))), layout);
  return res.json({ distanciaOnda: r.distancia, distanciaIndividual: distanciaIndividual(ordens, layout, giro), semPosicao: r.semPosicao });
});

router.post('/wms/ondas', async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ordemIds) ? [...new Set(req.body.ordemIds as string[])] : [];
  if (ids.length < 2) throw badRequest('Escolha pelo menos duas ordens para formar uma onda.');
  const usuario = await nomeUsuario(req);
  const { armazemId, layout, giro, doArmazem } = await contexto(prisma, req.body?.armazemId);
  const onda = await prisma.$transaction(async tx => {
    const ordens = await tx.ordemTransferencia.findMany({ where: { id: { in: ids } }, include: { itens: { include: { produto: { select: { id: true, nome: true, sku: true } } } } } });
    if (ordens.length !== ids.length) throw new Error('Alguma ordem não foi encontrada.');
    const invalida = ordens.find(o => o.status !== 'Pendente' || o.tipo !== 'SAIDA' || o.ondaId || !doArmazem(o.armazemId));
    if (invalida) throw new Error(`A ordem ${invalida.codigo} não pode entrar na onda (precisa ser de saída, pendente, deste armazém e fora de outra onda).`);
    const pos = new Map(giro.map(g => [g.id, g.pos]));
    const rota = rotaS(ordens.flatMap(o => o.itens.map(i => ({ pos: pos.get(i.produtoId) ?? null, dados: null }))), layout);
    const nova = await tx.ondaSeparacao.create({ data: { codigo: await gerarCodigoOnda(tx), armazemId, criadoPor: usuario, distanciaOnda: rota.distancia, distanciaIndividual: distanciaIndividual(ordens, layout, giro) } });
    await tx.ordemTransferencia.updateMany({ where: { id: { in: ids } }, data: { ondaId: nova.id } });
    return nova;
  });
  return res.status(201).json(onda);
});

router.get('/wms/ondas/:id', async (req, res) => {
  const onda = await prisma.ondaSeparacao.findUnique({ where: { id: String(req.params.id) }, include: INCLUDE_ONDA });
  if (!onda) throw notFound('Onda não encontrada.');
  const { layout, giro, armazemId } = await contexto(prisma, onda.armazemId);
  const ordensAbertas = onda.ordens.filter(o => o.status !== 'Concluída');
  const paradas = await montarColeta(prisma, (onda.status === 'Concluída' ? onda.ordens : ordensAbertas) as OrdemOnda[], layout, giro, armazemId);
  const rota = rotaS(paradas, layout);
  // Cada ordem ganha uma letra de caixa/tote para a triagem durante a coleta.
  const tote = new Map(onda.ordens.map((o, i) => [o.id, String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '')]));
  return res.json({
    ...onda,
    ordens: onda.ordens.map(o => ({ id: o.id, codigo: o.codigo, status: o.status, prioridade: o.prioridade, solicitante: o.solicitante?.nome ?? '-', tote: tote.get(o.id), linhas: o.itens.length, unidades: o.itens.reduce((a, i) => a + i.quantidade, 0) })),
    coleta: rota.paradas.map((p, i) => ({
      seq: i + 1, endereco: posResumo(p.pos), produto: p.dados.produto, lote: p.dados.lote, validade: p.dados.validade, quantidade: p.dados.quantidade,
      totalProduto: p.dados.totalProduto, falta: p.dados.falta, marcado: p.dados.marcado,
      destino: p.dados.destino.map(d => ({ ...d, tote: tote.get(d.ordemId) })),
    })),
    rota: { pontos: rota.pontos, distancia: rota.distancia, semPosicao: rota.semPosicao },
    mapa: { ruas: layout.ruas, posicoes: layout.posicoes.map(p => ({ id: p.id, rua: p.rua, ruaIndice: p.ruaIndice, modulo: p.modulo, x: p.x, y: p.y })), larguraRua: LARGURA_RUA, passoModulo: PASSO_MODULO },
  });
});

router.post('/wms/ondas/:id/iniciar', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  const usuario = await nomeUsuario(req);
  const onda = await prisma.ondaSeparacao.findUnique({ where: { id: String(req.params.id) } });
  if (!onda || onda.status !== 'Aberta') throw badRequest('Só ondas abertas podem ser iniciadas.');
  await prisma.$transaction([
    prisma.ondaSeparacao.update({ where: { id: onda.id }, data: { status: 'Em separação', iniciadaEm: new Date(), separadorId: usuarioId, separadorNome: usuario } }),
    prisma.ordemTransferencia.updateMany({ where: { ondaId: onda.id, status: 'Pendente' }, data: { status: 'Em Separação', separadorId: usuarioId ?? undefined, iniciadaEm: new Date() } }),
  ]);
  return res.json({ ok: true });
});

/** Marca/desmarca um produto coletado: vale para os itens desse produto em todas as ordens da onda. */
router.put('/wms/ondas/:id/linhas', async (req, res) => {
  const { produtoId, marcado } = req.body || {};
  if (!produtoId) throw badRequest('Informe o produto.');
  const r = await prisma.itemOrdemTransferencia.updateMany({ where: { produtoId: String(produtoId), ordem: { ondaId: String(req.params.id), status: { not: 'Concluída' } } }, data: { marcado: Boolean(marcado) } });
  return res.json({ atualizados: r.count });
});

router.post('/wms/ondas/:id/concluir', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  const onda = await prisma.ondaSeparacao.findUnique({ where: { id: String(req.params.id) }, include: { ordens: { include: { itens: true } } } });
  if (!onda || (onda.status !== 'Aberta' && onda.status !== 'Em separação')) throw badRequest('Esta onda não pode ser concluída.');
  const faltando = onda.ordens.filter(o => o.status !== 'Concluída').flatMap(o => o.itens).filter(i => !i.marcado).length;
  if (faltando && !req.body?.forcar) throw badRequest(`Ainda há ${faltando} linha(s) sem coleta confirmada.`);
  await prisma.$transaction(async tx => {
    for (const o of onda.ordens.filter(x => x.status !== 'Concluída')) await concluirOrdem(tx, o.id, usuarioId);
    await tx.ondaSeparacao.update({ where: { id: onda.id }, data: { status: 'Concluída', concluidaEm: new Date(), iniciadaEm: onda.iniciadaEm ?? new Date() } });
  }, { timeout: 60000 });
  return res.json({ ok: true, ordens: onda.ordens.length });
});

router.post('/wms/ondas/:id/cancelar', async (req, res) => {
  const onda = await prisma.ondaSeparacao.findUnique({ where: { id: String(req.params.id) } });
  if (!onda || onda.status === 'Concluída' || onda.status === 'Cancelada') throw badRequest('Esta onda não pode ser desfeita.');
  await prisma.$transaction([
    prisma.ordemTransferencia.updateMany({ where: { ondaId: onda.id, status: 'Em Separação' }, data: { status: 'Pendente', separadorId: null } }),
    prisma.ordemTransferencia.updateMany({ where: { ondaId: onda.id, status: { not: 'Concluída' } }, data: { ondaId: null } }),
    prisma.ondaSeparacao.update({ where: { id: onda.id }, data: { status: 'Cancelada' } }),
  ]);
  return res.json({ ok: true });
});

export default router;
