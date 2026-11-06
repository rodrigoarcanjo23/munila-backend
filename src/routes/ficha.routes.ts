import { Router } from 'express';
import { prisma, type Db } from '../lib/prisma';
import { badRequest, dataOuNull, notFound, num } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import { classesAbc } from '../lib/abc';
import { STATUS, STATUS_RESERVA, armazemPadrao, entradaEstoque, gerarCodigoRequisicao, linhaEstoque, registrarMovimentos, saidaFEFO, type ParteLote } from '../lib/estoque';
import { dadosProduto, validarUnicos } from './produtos.routes';

// ============================================================
// ✨ FASE 11
//  • Lançamentos de mercadoria (entrada, saída, ajustes, perda) com vários itens e um documento só
//  • Estoque por produto (visão de cadastro: fabricante, ABC, venda, trânsito, origem...)
//  • Ficha do item: saldos por situação, lotes por endereço (um item em vários endereços), picking,
//    EANs e dimensões. Mudar quantidade sempre gera ajuste no Kardex; mudar endereço/lote fica na auditoria.
// ============================================================
const router = Router();
const texto = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const hoje0 = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };

async function nomeDe(req: any, usuarioId: string) {
  return req.usuario?.nome ?? (await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { nome: true } }))?.nome ?? 'Desconhecido';
}
async function auditar(db: Db, acao: string, itemNome: string, usuarioNome: string, motivo: string) {
  await db.logAuditoria.create({ data: { acao, itemNome, usuarioNome, motivo } });
}

// ------------------------------------------------------------ lançamentos (página Entrada de mercadoria)
const TIPOS_LANCAMENTO: Record<string, { tipoAcao: string; sentido: 'entrada' | 'saida'; prefixo: 'RE' | 'RS' }> = {
  ENTRADA: { tipoAcao: 'Entrada de mercadoria', sentido: 'entrada', prefixo: 'RE' },
  DEVOLUCAO: { tipoAcao: 'Devolução VIAPRO', sentido: 'entrada', prefixo: 'RE' },
  AJUSTE_MAIS: { tipoAcao: 'Ajuste de Entrada de Inventário', sentido: 'entrada', prefixo: 'RE' },
  SAIDA: { tipoAcao: 'Saída de mercadoria', sentido: 'saida', prefixo: 'RS' },
  AJUSTE_MENOS: { tipoAcao: 'Ajuste de Saída de Inventário', sentido: 'saida', prefixo: 'RS' },
  PERDA: { tipoAcao: 'Perdas/Avarias', sentido: 'saida', prefixo: 'RS' },
};

/** Endereço do cadastro do produto como Localizacao (quando existir com esse código). */
async function enderecoDoCadastro(db: Db, produtoId: string, armazemId: string | null) {
  const p = await db.produto.findUnique({ where: { id: produtoId }, select: { enderecoLocalizacao: true } });
  if (!p?.enderecoLocalizacao) return null;
  const l = await db.localizacao.findFirst({ where: { codigo: p.enderecoLocalizacao, ...(armazemId ? { OR: [{ armazemId }, { armazemId: null }] } : {}) } });
  return l?.id ?? null;
}

router.post('/estoque/lancamento', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  const t = TIPOS_LANCAMENTO[String(req.body?.tipo || '')];
  if (!t) throw badRequest('Escolha o tipo de lançamento.');
  const documento = texto(req.body?.documento);
  const observacao = texto(req.body?.observacao);
  if ((req.body?.tipo === 'AJUSTE_MAIS' || req.body?.tipo === 'AJUSTE_MENOS' || req.body?.tipo === 'PERDA') && !observacao) throw badRequest('Escreva o motivo do ajuste ou da perda.');
  const itens = (Array.isArray(req.body?.itens) ? req.body.itens : []).map((i: any) => ({
    produtoId: String(i.produtoId || ''), quantidade: Math.round(num(i.quantidade)), lote: texto(i.lote)?.toUpperCase() ?? null,
    validade: dataOuNull(i.validade), localizacaoId: i.localizacaoId === undefined ? undefined : texto(i.localizacaoId), estoqueId: texto(i.estoqueId),
  }));
  if (!itens.length) throw badRequest('Adicione pelo menos um item.');
  if (itens.some((i: any) => !i.produtoId || i.quantidade <= 0)) throw badRequest('Cada item precisa de produto e quantidade maior que zero.');
  const nome = await nomeDe(req, usuarioId);

  const r = await prisma.$transaction(async tx => {
    const armazemId = texto(req.body?.armazemId) || (await armazemPadrao(tx));
    const codigo = await gerarCodigoRequisicao(tx, t.prefixo);
    const obs = [documento && `Documento ${documento}`, observacao].filter(Boolean).join(' · ') || `${t.tipoAcao} registrada.`;
    const resumo: string[] = [];
    for (const i of itens) {
      const produto = await tx.produto.findUnique({ where: { id: i.produtoId }, select: { sku: true, nome: true } });
      if (!produto) throw new Error('Produto não encontrado.');
      let partes: ParteLote[];
      if (t.sentido === 'entrada') {
        const localizacaoId = i.localizacaoId !== undefined ? i.localizacaoId : await enderecoDoCadastro(tx, i.produtoId, armazemId);
        partes = [await entradaEstoque(tx, { produtoId: i.produtoId, quantidade: i.quantidade, armazemId, lote: i.lote, validade: i.validade, localizacaoId })];
      } else if (i.estoqueId) {
        // saída de uma linha específica (endereço/lote escolhido)
        const linha = await tx.estoque.findUnique({ where: { id: i.estoqueId } });
        if (!linha || linha.produtoId !== i.produtoId || linha.status !== STATUS.DISPONIVEL) throw new Error(`[${produto.sku}]: a linha escolhida não é saldo disponível deste produto.`);
        if (linha.quantidade < i.quantidade) throw new Error(`[${produto.sku}] tem só ${linha.quantidade} nesse endereço/lote.`);
        await tx.estoque.update({ where: { id: linha.id }, data: { quantidade: { decrement: i.quantidade } } });
        partes = [{ estoqueId: linha.id, lote: linha.lote, validade: linha.validade, quantidade: i.quantidade, armazemId: linha.armazemId }];
      } else {
        partes = await saidaFEFO(tx, { produtoId: i.produtoId, quantidade: i.quantidade, armazemId, lote: i.lote, rotulo: `[${produto.sku}] ${produto.nome}` });
      }
      if (t.tipoAcao === 'Perdas/Avarias') {
        for (const p of partes) {
          const ruptura = await linhaEstoque(tx, i.produtoId, STATUS.RUPTURA, { armazemId: p.armazemId, lote: p.lote, validade: p.validade });
          await tx.estoque.update({ where: { id: ruptura.id }, data: { quantidade: { increment: p.quantidade } } });
        }
      }
      await registrarMovimentos(tx, { produtoId: i.produtoId, usuarioId, tipoAcao: t.tipoAcao, codigo, observacao: obs }, partes);
      resumo.push(`${i.quantidade} [${produto.sku}]`);
    }
    await auditar(tx, `LANÇAMENTO: ${t.tipoAcao.toUpperCase()}`, `${codigo} · ${itens.length} item(ns)`, nome, `${resumo.join(', ')}${documento ? ` · Documento ${documento}` : ''}${observacao ? ` · ${observacao}` : ''}`);
    return { codigo, itens: itens.length, unidades: itens.reduce((a: number, i: any) => a + i.quantidade, 0) };
  }, { timeout: 30000, maxWait: 15000 });
  return res.status(201).json(r);
});

// ------------------------------------------------------------ saldos agregados
interface Agregado { disponivel: number; consignado: number; avaria: number; sobra: number; vencido: number; pulmao: number; solicitado: number; reservado: number; transito: number }
async function agregados(db: Db, produtoIds?: string[]) {
  const filtro = produtoIds ? { produtoId: { in: produtoIds } } : {};
  const hoje = hoje0();
  const [linhas, ordens, pedidos] = await Promise.all([
    db.estoque.findMany({ where: { ...filtro, quantidade: { gt: 0 } }, select: { produtoId: true, status: true, quantidade: true, validade: true, localizacao: { select: { tipo: true } }, produto: { select: { validade: true } } } }),
    db.itemOrdemTransferencia.findMany({ where: { ...filtro, ordem: { tipo: 'SAIDA', status: { in: STATUS_RESERVA } } }, select: { produtoId: true, quantidade: true, ordem: { select: { status: true } } } }),
    db.pedidoCompra.findMany({ where: { ...filtro, status: 'Pendente' }, select: { produtoId: true, quantidade: true } }),
  ]);
  const m = new Map<string, Agregado>();
  const de = (id: string) => { let a = m.get(id); if (!a) { a = { disponivel: 0, consignado: 0, avaria: 0, sobra: 0, vencido: 0, pulmao: 0, solicitado: 0, reservado: 0, transito: 0 }; m.set(id, a); } return a; };
  for (const l of linhas) {
    const a = de(l.produtoId);
    if (l.status === STATUS.DISPONIVEL) {
      a.disponivel += l.quantidade;
      const val = l.validade ?? l.produto.validade;
      if (val && val < hoje) a.vencido += l.quantidade;
      if (l.localizacao?.tipo === 'Pulmão') a.pulmao += l.quantidade;
    } else if (l.status === STATUS.DEMONSTRACAO) a.consignado += l.quantidade;
    else if (l.status === STATUS.RUPTURA) a.avaria += l.quantidade;
    else if (l.status === STATUS.SOBRA) a.sobra += l.quantidade;
  }
  for (const o of ordens) { const a = de(o.produtoId); if (o.ordem.status === 'Pendente') a.solicitado += o.quantidade; else a.reservado += o.quantidade; }
  for (const p of pedidos) de(p.produtoId).transito += p.quantidade;
  return m;
}
/** Números da ficha a partir do agregado. Venda = o que ainda pode ser pedido (disponível − pedido em ordens − vencido). */
function saldosDe(a: Agregado) {
  const fisico = a.disponivel + a.avaria + a.sobra;
  const quarentena = a.sobra + a.vencido;
  const venda = Math.max(0, a.disponivel - a.vencido - a.solicitado - a.reservado);
  return { consignado: a.consignado, transito: a.transito, pulmao: a.pulmao, fisico, solicitado: a.solicitado, reservado: a.reservado, avaria: a.avaria, disponivel: a.disponivel, quarentena, venda };
}

/** Estoque por produto (visão do cadastro, como no sistema antigo). */
router.get('/estoque/produtos', async (_req, res) => {
  const [produtos, ag, abc] = await Promise.all([
    prisma.produto.findMany({ select: { id: true, sku: true, nome: true, unidade: true, fabricante: true, codigoBarras: true, origemFiscal: true, referenciaFabricante: true, linha: true, enderecoLocalizacao: true, estoqueMinimo: true, precoCusto: true, categoria: { select: { id: true, nome: true } } }, orderBy: { nome: 'asc' } }),
    agregados(prisma),
    classesAbc(prisma),
  ]);
  const vazio: Agregado = { disponivel: 0, consignado: 0, avaria: 0, sobra: 0, vencido: 0, pulmao: 0, solicitado: 0, reservado: 0, transito: 0 };
  return res.json(produtos.map(p => ({ ...p, classe: abc.get(p.id) ?? 'C', saldos: saldosDe(ag.get(p.id) ?? vazio) })));
});

// ------------------------------------------------------------ ficha do item
router.get('/estoque/ficha/:produtoId', async (req, res) => {
  const produtoId = String(req.params.produtoId);
  const produto = await prisma.produto.findUnique({
    where: { id: produtoId },
    include: {
      categoria: true, fornecedor: { select: { id: true, nomeEmpresa: true } },
      eans: { orderBy: [{ padrao: 'desc' }, { embalagem: 'asc' }] }, dimensoes: { orderBy: { tipo: 'asc' } },
      pickings: { include: { localizacao: { select: { id: true, codigo: true, tipo: true, zona: true } } } },
    },
  });
  if (!produto) throw notFound('Produto não encontrado.');
  const [ag, abc, linhas, ordens, pedidos] = await Promise.all([
    agregados(prisma, [produtoId]), classesAbc(prisma),
    prisma.estoque.findMany({ where: { produtoId, OR: [{ quantidade: { gt: 0 } }, { status: STATUS.DISPONIVEL, lote: null }] }, include: { armazem: { select: { id: true, nome: true } }, localizacao: { select: { id: true, codigo: true, tipo: true, zona: true } }, responsavel: { select: { nome: true } } } }),
    prisma.itemOrdemTransferencia.findMany({ where: { produtoId, ordem: { tipo: 'SAIDA', status: { in: STATUS_RESERVA } } }, select: { quantidade: true, ordem: { select: { id: true, codigo: true, status: true, prioridade: true, createdAt: true } } } }),
    prisma.pedidoCompra.findMany({ where: { produtoId, status: 'Pendente' }, select: { id: true, codigo: true, quantidade: true, dataPrevisao: true, fornecedor: { select: { nomeEmpresa: true } } } }),
  ]);
  const hoje = hoje0();
  const emb = produto.embalagem && produto.embalagem > 0 ? produto.embalagem : null;
  const ordem = { 'Disponível': 0, 'Sobra sem NF': 1, 'Ruptura': 2, 'Em Demonstração': 3 } as Record<string, number>;
  const out = linhas.map(l => {
    const validade = l.validade ?? produto.validade;
    return {
      id: l.id, status: l.status, armazem: l.armazem, localizacao: l.localizacao, enderecoCadastro: l.localizacao ? null : produto.enderecoLocalizacao,
      lote: l.lote, validade, vencido: !!validade && validade < hoje, quantidade: l.quantidade,
      caixas: emb ? Math.floor(l.quantidade / emb) : null, avulsas: emb ? l.quantidade % emb : null, responsavel: l.responsavel?.nome ?? null,
    };
  }).sort((a, b) => (ordem[a.status] ?? 9) - (ordem[b.status] ?? 9) || (a.localizacao?.codigo ?? a.enderecoCadastro ?? '~').localeCompare(b.localizacao?.codigo ?? b.enderecoCadastro ?? '~') || (a.validade?.getTime() ?? 9e15) - (b.validade?.getTime() ?? 9e15));
  const vazio: Agregado = { disponivel: 0, consignado: 0, avaria: 0, sobra: 0, vencido: 0, pulmao: 0, solicitado: 0, reservado: 0, transito: 0 };
  return res.json({ produto, classe: abc.get(produtoId) ?? 'C', saldos: saldosDe(ag.get(produtoId) ?? vazio), linhas: out, ordens, pedidos });
});

/** Salva o cadastro completo da ficha: campos do produto, EANs, dimensões e picking × armazenamento. */
router.put('/estoque/ficha/:produtoId', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  const produtoId = String(req.params.produtoId);
  const atual = await prisma.produto.findUnique({ where: { id: produtoId }, include: { eans: true, dimensoes: true, pickings: true } });
  if (!atual) throw notFound('Produto não encontrado.');
  const b = req.body || {};
  const p = b.produto || {};

  // EANs: um padrão, sem repetição, sem colidir com outro produto
  const eans = (Array.isArray(b.eans) ? b.eans : []).map((e: any) => ({ codigo: String(e.codigo || '').replace(/\s+/g, ''), embalagem: Math.max(1, Math.round(num(e.embalagem, 1))), padrao: !!e.padrao })).filter((e: any) => e.codigo);
  if (new Set(eans.map((e: any) => e.codigo)).size !== eans.length) throw badRequest('Há EAN repetido na lista.');
  if (eans.length && !eans.some((e: any) => e.padrao)) eans[0].padrao = true;
  if (eans.filter((e: any) => e.padrao).length > 1) throw badRequest('Marque só um EAN como padrão.');
  const padrao = eans.find((e: any) => e.padrao)?.codigo ?? null;
  for (const e of eans) {
    const outro = await prisma.produtoEan.findUnique({ where: { codigo: e.codigo }, select: { produtoId: true } });
    const outroCb = await prisma.produto.findFirst({ where: { codigoBarras: e.codigo, id: { not: produtoId } }, select: { sku: true } });
    if ((outro && outro.produtoId !== produtoId) || outroCb) throw badRequest(`O EAN ${e.codigo} já pertence a outro produto${outroCb ? ` (${outroCb.sku})` : ''}.`);
  }
  const dimensoes = (Array.isArray(b.dimensoes) ? b.dimensoes : []).map((d: any) => ({
    tipo: String(d.tipo || '').toUpperCase(), embalagem: texto(d.embalagem)?.toUpperCase() ?? 'UN', quantidade: Math.max(1, Math.round(num(d.quantidade, 1))),
    altura: d.altura === '' || d.altura == null ? null : num(d.altura), largura: d.largura === '' || d.largura == null ? null : num(d.largura),
    profundidade: d.profundidade === '' || d.profundidade == null ? null : num(d.profundidade), peso: d.peso === '' || d.peso == null ? null : num(d.peso),
  })).filter((d: any) => d.tipo);
  if (new Set(dimensoes.map((d: any) => d.tipo)).size !== dimensoes.length) throw badRequest('Cada tipo de dimensão (cadastro, compra) aparece uma vez só.');
  const pickings = (Array.isArray(b.pickings) ? b.pickings : []).map((x: any) => ({ localizacaoId: String(x.localizacaoId || ''), minimo: Math.max(0, Math.round(num(x.minimo))), maximo: Math.max(0, Math.round(num(x.maximo))) })).filter((x: any) => x.localizacaoId);
  if (new Set(pickings.map((x: any) => x.localizacaoId)).size !== pickings.length) throw badRequest('O mesmo endereço de picking aparece duas vezes.');
  if (pickings.some((x: any) => x.maximo && x.minimo > x.maximo)) throw badRequest('No picking, o mínimo não pode passar do máximo.');

  // campos do produto: só o que veio (o que não veio fica como está)
  const dados = dadosProduto({ ...p, sku: p.sku ?? atual.sku, nome: p.nome ?? atual.nome, codigoBarras: b.eans !== undefined ? padrao : p.codigoBarras });
  if (!dados.sku || !dados.nome) throw badRequest('Nome e SKU são obrigatórios.');
  await validarUnicos(dados.sku, dados.codigoBarras, produtoId);
  const nome = await nomeDe(req, usuarioId);

  const salvo = await prisma.$transaction(async tx => {
    const r = await tx.produto.update({ where: { id: produtoId }, data: { ...dados, categoriaId: dados.categoriaId || undefined, tipo: p.tipo ?? undefined } });
    if (b.eans !== undefined) { await tx.produtoEan.deleteMany({ where: { produtoId } }); if (eans.length) await tx.produtoEan.createMany({ data: eans.map((e: any) => ({ ...e, produtoId })) }); }
    if (b.dimensoes !== undefined) { await tx.produtoDimensao.deleteMany({ where: { produtoId } }); if (dimensoes.length) await tx.produtoDimensao.createMany({ data: dimensoes.map((d: any) => ({ ...d, produtoId })) }); }
    if (b.pickings !== undefined) { await tx.produtoPicking.deleteMany({ where: { produtoId } }); if (pickings.length) await tx.produtoPicking.createMany({ data: pickings.map((x: any) => ({ ...x, produtoId })) }); }
    // auditoria do que mudou no cadastro
    const campos: [string, unknown, unknown][] = Object.entries(dados).filter(([, v]) => v !== undefined).map(([k, v]) => [k, (atual as any)[k], v]);
    const mudou = campos.filter(([, a, d]) => String(a ?? '') !== String(d ?? '')).map(([k, a, d]) => `${k}: ${a ?? '-'} → ${d ?? '-'}`);
    if (b.eans !== undefined && JSON.stringify(atual.eans.map(e => e.codigo).sort()) !== JSON.stringify(eans.map((e: any) => e.codigo).sort())) mudou.push(`EANs: ${eans.map((e: any) => e.codigo).join(', ') || '-'}`);
    if (b.pickings !== undefined && atual.pickings.length !== pickings.length) mudou.push(`picking: ${pickings.length} endereço(s)`);
    if (b.dimensoes !== undefined) mudou.push('dimensões');
    if (mudou.length) await auditar(tx, 'FICHA DO ITEM: ALTERAÇÃO', `[${r.sku}] ${r.nome}`, nome, mudou.join(' · '));
    return r;
  });
  return res.json(salvo);
});

// ------------------------------------------------------------ linhas de estoque (endereço / lote / quantidade)
/**
 * Edita uma linha da ficha. Quantidade diferente = ajuste de inventário (+/−) no Kardex, com motivo.
 * Endereço, lote e validade mudam a identificação da linha (se já existir uma linha igual, as duas se juntam).
 */
router.put('/estoque/linhas/:id', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  const b = req.body || {};
  const motivo = texto(b.motivo);
  const nome = await nomeDe(req, usuarioId);
  const r = await prisma.$transaction(async tx => {
    const linha = await tx.estoque.findUnique({ where: { id: String(req.params.id) }, include: { produto: { select: { sku: true, nome: true } }, localizacao: { select: { codigo: true } } } });
    if (!linha) throw notFound('Linha de estoque não encontrada.');
    if (linha.status === STATUS.SOBRA) throw new Error('Sobra sem NF não se edita aqui: regularize em Sobras sem NF.');
    const rotulo = `[${linha.produto.sku}] ${linha.produto.nome}`;
    const mudancas: string[] = [];
    let alvoId = linha.id;

    // 1) quantidade → ajuste no Kardex
    if (b.quantidade !== undefined && b.quantidade !== '') {
      const nova = Math.round(num(b.quantidade));
      if (nova < 0) throw new Error('Quantidade não pode ser negativa.');
      const d = nova - linha.quantidade;
      if (d !== 0) {
        if (linha.status !== STATUS.DISPONIVEL) throw new Error(`Saldo "${linha.status}" muda pela operação própria (retorno de demonstração, perdas), não por ajuste.`);
        if (!motivo) throw new Error('Mudar a quantidade gera ajuste de inventário: escreva o motivo.');
        await tx.estoque.update({ where: { id: linha.id }, data: { quantidade: nova } });
        const codigo = await gerarCodigoRequisicao(tx, d > 0 ? 'RE' : 'RS');
        await registrarMovimentos(tx, { produtoId: linha.produtoId, usuarioId, tipoAcao: d > 0 ? 'Ajuste de Entrada de Inventário' : 'Ajuste de Saída de Inventário', codigo, observacao: `Ficha do item${linha.localizacao ? ` (${linha.localizacao.codigo})` : ''}: ${linha.quantidade} → ${nova}. ${motivo}` },
          [{ estoqueId: linha.id, lote: linha.lote, validade: linha.validade, quantidade: Math.abs(d), armazemId: linha.armazemId }]);
        mudancas.push(`quantidade ${linha.quantidade} → ${nova} (${codigo})`);
      }
    }
    // 2) endereço / lote / validade → reidentifica a linha (junta com outra igual, se houver)
    const atual = await tx.estoque.findUnique({ where: { id: linha.id } });
    const novoLoc = b.localizacaoId !== undefined ? texto(b.localizacaoId) : atual!.localizacaoId;
    const novoLote = b.lote !== undefined ? texto(b.lote)?.toUpperCase() ?? null : atual!.lote;
    const novaVal = b.validade !== undefined ? dataOuNull(b.validade) : atual!.validade;
    const mudouLugar = novoLoc !== atual!.localizacaoId || novoLote !== atual!.lote || (novaVal?.getTime() ?? null) !== (atual!.validade?.getTime() ?? null);
    if (mudouLugar) {
      if ((novoLote !== atual!.lote || novaVal?.getTime() !== atual!.validade?.getTime()) && !motivo) throw new Error('Mudar lote ou validade altera a rastreabilidade: escreva o motivo.');
      let destinoNome = '-';
      if (novoLoc) { const l = await tx.localizacao.findUnique({ where: { id: novoLoc } }); if (!l) throw new Error('Endereço não encontrado.'); destinoNome = l.codigo; }
      const igual = await tx.estoque.findFirst({ where: { id: { not: linha.id }, produtoId: linha.produtoId, status: linha.status, armazemId: linha.armazemId, lote: novoLote, localizacaoId: novoLoc, responsavelId: atual!.responsavelId } });
      if (igual && (igual.validade?.getTime() ?? null) === (novaVal?.getTime() ?? null)) {
        await tx.estoque.update({ where: { id: igual.id }, data: { quantidade: { increment: atual!.quantidade } } });
        await tx.estoque.update({ where: { id: linha.id }, data: { quantidade: 0 } });
        alvoId = igual.id;
      } else {
        await tx.estoque.update({ where: { id: linha.id }, data: { localizacaoId: novoLoc, lote: novoLote, validade: novaVal } });
      }
      if (novoLoc !== atual!.localizacaoId) mudancas.push(`endereço ${linha.localizacao?.codigo ?? '(cadastro)'} → ${destinoNome}`);
      if (novoLote !== atual!.lote) mudancas.push(`lote ${atual!.lote ?? 'sem lote'} → ${novoLote ?? 'sem lote'}`);
      if ((novaVal?.getTime() ?? null) !== (atual!.validade?.getTime() ?? null)) mudancas.push(`validade ${atual!.validade?.toISOString().slice(0, 10) ?? '-'} → ${novaVal?.toISOString().slice(0, 10) ?? '-'}`);
    }
    if (!mudancas.length) return { id: alvoId, mudancas };
    await auditar(tx, 'FICHA DO ITEM: LINHA DE ESTOQUE', rotulo, nome, `${mudancas.join(' · ')}${motivo ? ` · Motivo: ${motivo}` : ''}`);
    return { id: alvoId, mudancas };
  });
  return res.json(r);
});

/** Leva parte (ou tudo) de uma linha para outro endereço: o item passa a estar em vários endereços. Saldo total não muda. */
router.post('/estoque/linhas/:id/enderecar', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  const quantidade = Math.round(num(req.body?.quantidade));
  const localizacaoId = texto(req.body?.localizacaoId);
  if (quantidade <= 0 || !localizacaoId) throw badRequest('Informe a quantidade e o endereço de destino.');
  const nome = await nomeDe(req, usuarioId);
  const r = await prisma.$transaction(async tx => {
    const linha = await tx.estoque.findUnique({ where: { id: String(req.params.id) }, include: { produto: { select: { sku: true, nome: true } }, localizacao: { select: { codigo: true } } } });
    if (!linha) throw notFound('Linha de estoque não encontrada.');
    if (linha.status !== STATUS.DISPONIVEL) throw new Error('Só saldo disponível muda de endereço por aqui.');
    if (linha.quantidade < quantidade) throw new Error(`Esse endereço/lote tem só ${linha.quantidade}.`);
    if (linha.localizacaoId === localizacaoId) throw new Error('Escolha um endereço diferente do atual.');
    const destino = await tx.localizacao.findUnique({ where: { id: localizacaoId } });
    if (!destino) throw new Error('Endereço não encontrado.');
    if (destino.armazemId && linha.armazemId && destino.armazemId !== linha.armazemId) throw new Error(`O endereço ${destino.codigo} é de outro armazém. Para mudar de armazém, use a transferência.`);
    await tx.estoque.update({ where: { id: linha.id }, data: { quantidade: { decrement: quantidade } } });
    const alvo = await linhaEstoque(tx, linha.produtoId, STATUS.DISPONIVEL, { armazemId: linha.armazemId, lote: linha.lote, validade: linha.validade, localizacaoId });
    await tx.estoque.update({ where: { id: alvo.id }, data: { quantidade: { increment: quantidade } } });
    await auditar(tx, 'MUDANÇA DE ENDEREÇO', `[${linha.produto.sku}] ${linha.produto.nome}`, nome,
      `${quantidade} un${linha.lote ? ` do lote ${linha.lote}` : ''}: ${linha.localizacao?.codigo ?? '(endereço do cadastro)'} → ${destino.codigo}${texto(req.body?.motivo) ? ` · ${texto(req.body.motivo)}` : ''}`);
    return { origemId: linha.id, destinoId: alvo.id };
  });
  return res.status(201).json(r);
});

export default router;
