import { prisma, type Db } from './prisma';

// ============================================================
// Regras de negócio compartilhadas do estoque
// ============================================================

export const STATUS = {
  DISPONIVEL: 'Disponível',
  DEMONSTRACAO: 'Em Demonstração',
  RUPTURA: 'Ruptura',
} as const;

/** Tipos que somam ao saldo disponível. */
export const TIPOS_ENTRADA = [
  'Entrada de mercadoria',
  'Devolução VIAPRO',
  'Ajuste de Entrada de Inventário',
  'Entrada por produção',
  'Retorno de demonstração',
  'Transferência (entrada)',
  'Estorno de produção (entrada)',
];

/** Tipos que retiram do saldo disponível. */
export const TIPOS_SAIDA = [
  'Saída de mercadoria',
  'Ajuste de Saída de Inventário',
  'Saída para demonstração',
  'Perdas/Avarias',
  'Saída para produção',
  'Transferência (saída)',
  'Estorno de produção (saída)',
];

/** Saídas que representam consumo real (usadas em Curva ABC e sugestão de compras). */
export const TIPOS_TRANSFERENCIA = ['Transferência (entrada)', 'Transferência (saída)'];

export const TIPOS_CONSUMO = ['Saída de mercadoria', 'Saída para produção', 'Saída para demonstração'];

export const ehEntrada = (tipo: string) => TIPOS_ENTRADA.includes(tipo);

export const ESTOQUE_MINIMO_PADRAO = 10;

/** Estoque mínimo: campo novo `estoqueMinimo`, com fallback para a tag legada [MIN:x] da descrição. */
export function estoqueMinimoDe(p: { estoqueMinimo?: number | null; descricao?: string | null } | null | undefined) {
  if (!p) return ESTOQUE_MINIMO_PADRAO;
  if (p.estoqueMinimo !== null && p.estoqueMinimo !== undefined) return p.estoqueMinimo;
  const m = p.descricao?.match(/\[MIN:(\d+)\]/);
  return m ? parseInt(m[1], 10) : ESTOQUE_MINIMO_PADRAO;
}

/** Mantém a tag [MIN:x] na descrição (o app mobile ainda lê dessa forma). */
export function descricaoComTagMinimo(descricao: string | null | undefined, minimo: number | null) {
  const limpa = (descricao || '').replace(/\s*\[MIN:\d+\]/g, '').trim();
  if (minimo === null) return limpa || null;
  return `${limpa} [MIN:${minimo}]`.trim();
}

// ------------------------------------------------------------
// Códigos sequenciais por ano: RE000126, RS000126, PC000126, OS000126, INV000126
// ------------------------------------------------------------
function proximo(codigos: (string | null)[], prefixo: string, ano: string) {
  let maior = 0;
  for (const c of codigos) {
    if (!c) continue;
    const n = parseInt(c.slice(prefixo.length, -ano.length), 10);
    if (!isNaN(n) && n > maior) maior = n;
  }
  return `${prefixo}${String(maior + 1).padStart(4, '0')}${ano}`;
}

const anoAtual = () => new Date().getFullYear().toString().slice(-2);

export async function gerarCodigoRequisicao(db: Db, tipo: 'RE' | 'RS' | 'TR') {
  const ano = anoAtual();
  const regs = await db.movimentacao.findMany({ where: { codigo: { startsWith: tipo, endsWith: ano } }, select: { codigo: true } });
  return proximo(regs.map(r => r.codigo), tipo, ano);
}

export async function gerarCodigoPedidoCompra(db: Db) {
  const ano = anoAtual();
  const regs = await db.pedidoCompra.findMany({ where: { codigo: { startsWith: 'PC', endsWith: ano } }, select: { codigo: true } });
  return proximo(regs.map(r => r.codigo), 'PC', ano);
}

export async function gerarCodigoOS(db: Db) {
  const ano = anoAtual();
  const regs = await db.ordemTransferencia.findMany({ where: { codigo: { startsWith: 'OS', endsWith: ano } }, select: { codigo: true } });
  return proximo(regs.map(r => r.codigo), 'OS', ano);
}

export async function gerarCodigoOP(db: Db) {
  const ano = anoAtual();
  const regs = await db.ordemProducao.findMany({ where: { codigo: { startsWith: 'OP', endsWith: ano } }, select: { codigo: true } });
  return proximo(regs.map(r => r.codigo), 'OP', ano);
}

export async function gerarCodigoOnda(db: Db) {
  const ano = anoAtual();
  const regs = await db.ondaSeparacao.findMany({ where: { codigo: { startsWith: 'ON', endsWith: ano } }, select: { codigo: true } });
  return proximo(regs.map(r => r.codigo), 'ON', ano);
}

export async function gerarCodigoInventario(db: Db) {
  const ano = anoAtual();
  const regs = await db.inventario.findMany({ where: { codigo: { startsWith: 'INV', endsWith: ano } }, select: { codigo: true } });
  return proximo(regs.map(r => r.codigo), 'INV', ano);
}

// ------------------------------------------------------------
// Saldos
// ------------------------------------------------------------

// ------------------------------------------------------------
// Armazéns
// ------------------------------------------------------------
let cacheArmazemPadrao: string | null = null;

/**
 * Cria os armazéns iniciais (Munila e VIAPRO) se ainda não existirem e vincula ao armazém padrão
 * todo saldo antigo que ainda não tinha armazém. Idempotente: roda na subida da API.
 */
export async function garantirArmazens(db: Db = prisma) {
  if ((await db.armazem.count()) === 0) {
    await db.armazem.createMany({
      data: [
        { codigo: 'MUN', nome: 'Armazém Munila', padrao: true },
        { codigo: 'VIA', nome: 'Indústria VIAPRO', padrao: false },
      ],
    });
  }
  const padrao = await armazemPadrao(db);
  await db.estoque.updateMany({ where: { armazemId: null }, data: { armazemId: padrao } });
  return padrao;
}

export async function armazemPadrao(db: Db = prisma): Promise<string> {
  if (cacheArmazemPadrao) return cacheArmazemPadrao;
  const a = (await db.armazem.findFirst({ where: { padrao: true } })) ?? (await db.armazem.findFirst({ orderBy: { createdAt: 'asc' } }));
  if (!a) {
    const criado = await db.armazem.create({ data: { codigo: 'MUN', nome: 'Armazém Munila', padrao: true } });
    cacheArmazemPadrao = criado.id;
    return criado.id;
  }
  cacheArmazemPadrao = a.id;
  return a.id;
}
export const limparCacheArmazem = () => { cacheArmazemPadrao = null; };

/** Garante que todo produto tenha uma linha "Disponível" (antes isso era feito pelo navegador no Dashboard). */
export async function garantirEstoqueDisponivel(db: Db = prisma) {
  const produtos = await db.produto.findMany({
    where: { estoques: { none: { status: STATUS.DISPONIVEL } } },
    select: { id: true },
  });
  if (produtos.length > 0) {
    const armazemId = await armazemPadrao(db);
    await db.estoque.createMany({ data: produtos.map(p => ({ produtoId: p.id, quantidade: 0, status: STATUS.DISPONIVEL, armazemId })) });
  }
  return produtos.length;
}

const loteNorm = (l?: string | null) => (l && String(l).trim() ? String(l).trim().toUpperCase() : null);

/**
 * Retorna (criando se necessário) a linha de estoque de um produto em um status, armazém e lote.
 * Sem armazém informado = armazém padrão. Sem lote = linha "sem lote".
 */
export async function linhaEstoque(
  db: Db, produtoId: string, status: string = STATUS.DISPONIVEL,
  opts: { armazemId?: string | null; lote?: string | null; validade?: Date | null } = {},
) {
  const armazemId = opts.armazemId || (await armazemPadrao(db));
  const lote = loteNorm(opts.lote);
  const existente = await db.estoque.findFirst({ where: { produtoId, status, armazemId, lote }, orderBy: { quantidade: 'desc' } });
  if (existente) {
    if (opts.validade && !existente.validade) return db.estoque.update({ where: { id: existente.id }, data: { validade: opts.validade } });
    return existente;
  }
  return db.estoque.create({ data: { produtoId, quantidade: 0, status, armazemId, lote, validade: opts.validade ?? null } });
}

export interface ParteLote { estoqueId: string; lote: string | null; validade: Date | null; quantidade: number; armazemId: string | null }

/** Entrada de saldo disponível num armazém/lote. */
export async function entradaEstoque(db: Db, a: { produtoId: string; quantidade: number; armazemId?: string | null; lote?: string | null; validade?: Date | null; status?: string }) {
  const linha = await linhaEstoque(db, a.produtoId, a.status ?? STATUS.DISPONIVEL, a);
  const atualizada = await db.estoque.update({ where: { id: linha.id }, data: { quantidade: { increment: a.quantidade } } });
  return { estoqueId: atualizada.id, lote: atualizada.lote, validade: atualizada.validade, quantidade: a.quantidade, armazemId: atualizada.armazemId } as ParteLote;
}

/** Lotes disponíveis na ordem FEFO (vence primeiro, sai primeiro); lotes sem validade por último. */
export async function lotesFEFO(db: Db, produtoId: string, armazemId?: string | null, lote?: string | null) {
  const arm = armazemId || (await armazemPadrao(db));
  const linhas = await db.estoque.findMany({
    where: { produtoId, status: STATUS.DISPONIVEL, armazemId: arm, quantidade: { gt: 0 }, ...(lote ? { lote: loteNorm(lote) } : {}) },
    include: { produto: { select: { validade: true } } },
  });
  const val = (l: (typeof linhas)[number]) => (l.validade ?? l.produto.validade)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return linhas.sort((a, b) => val(a) - val(b) || (a.lote || '\uffff').localeCompare(b.lote || '\uffff'));
}

/** Simula a retirada FEFO sem gravar (sugestão de picking). */
export async function sugerirFEFO(db: Db, produtoId: string, quantidade: number, armazemId?: string | null) {
  const linhas = await lotesFEFO(db, produtoId, armazemId);
  let falta = quantidade;
  const partes: ParteLote[] = [];
  for (const l of linhas) {
    if (falta <= 0) break;
    const q = Math.min(l.quantidade, falta);
    partes.push({ estoqueId: l.id, lote: l.lote, validade: l.validade ?? l.produto.validade, quantidade: q, armazemId: l.armazemId });
    falta -= q;
  }
  return { partes, falta: Math.max(0, falta), disponivel: linhas.reduce((a, l) => a + l.quantidade, 0) };
}

/** Saída FEFO: consome primeiro os lotes que vencem antes. Lança erro se não houver saldo suficiente. */
export async function saidaFEFO(db: Db, a: { produtoId: string; quantidade: number; armazemId?: string | null; lote?: string | null; rotulo?: string }) {
  const linhas = await lotesFEFO(db, a.produtoId, a.armazemId, a.lote);
  const disponivel = linhas.reduce((s, l) => s + l.quantidade, 0);
  if (disponivel < a.quantidade) {
    throw new Error(`Estoque insuficiente${a.rotulo ? ` de ${a.rotulo}` : ''}${a.lote ? ` no lote ${a.lote}` : ''}: necessário ${a.quantidade}, disponível ${disponivel}.`);
  }
  let falta = a.quantidade;
  const partes: ParteLote[] = [];
  for (const l of linhas) {
    if (falta <= 0) break;
    const q = Math.min(l.quantidade, falta);
    await db.estoque.update({ where: { id: l.id }, data: { quantidade: { decrement: q } } });
    partes.push({ estoqueId: l.id, lote: l.lote, validade: l.validade ?? l.produto.validade, quantidade: q, armazemId: l.armazemId });
    falta -= q;
  }
  return partes;
}

/** Registra uma movimentação por parte de lote (mesmo código de documento). */
export async function registrarMovimentos(db: Db, base: { produtoId: string; usuarioId: string; tipoAcao: string; codigo?: string | null; observacao?: string | null }, partes: ParteLote[]) {
  for (const p of partes) {
    await db.movimentacao.create({
      data: { ...base, quantidade: p.quantidade, armazemId: p.armazemId, lote: p.lote, validade: p.validade },
    });
  }
}

/** Mapa produtoId -> saldo disponível (opcionalmente de um armazém). */
export async function saldosDisponiveis(db: Db = prisma, armazemId?: string | null) {
  const linhas = await db.estoque.groupBy({ by: ['produtoId'], where: { status: STATUS.DISPONIVEL, ...(armazemId ? { armazemId } : {}) }, _sum: { quantidade: true } });
  return new Map(linhas.map(l => [l.produtoId, l._sum.quantidade || 0]));
}

/** Soma de consumo por produto num período (em unidades). */
export async function consumoPorProduto(desde: Date, db: Db = prisma) {
  const linhas = await db.movimentacao.groupBy({
    by: ['produtoId'],
    where: { tipoAcao: { in: TIPOS_CONSUMO }, dataHora: { gte: desde } },
    _sum: { quantidade: true },
  });
  return new Map(linhas.map(l => [l.produtoId, l._sum.quantidade || 0]));
}

export function diasAtras(dias: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - dias);
  return d;
}
