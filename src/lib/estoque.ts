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
];

/** Tipos que retiram do saldo disponível. */
export const TIPOS_SAIDA = [
  'Saída de mercadoria',
  'Ajuste de Saída de Inventário',
  'Saída para demonstração',
  'Perdas/Avarias',
  'Saída para produção',
];

/** Saídas que representam consumo real (usadas em Curva ABC e sugestão de compras). */
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

export async function gerarCodigoRequisicao(db: Db, tipo: 'RE' | 'RS') {
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

export async function gerarCodigoInventario(db: Db) {
  const ano = anoAtual();
  const regs = await db.inventario.findMany({ where: { codigo: { startsWith: 'INV', endsWith: ano } }, select: { codigo: true } });
  return proximo(regs.map(r => r.codigo), 'INV', ano);
}

// ------------------------------------------------------------
// Saldos
// ------------------------------------------------------------

/** Garante que todo produto tenha uma linha "Disponível" (antes isso era feito pelo navegador no Dashboard). */
export async function garantirEstoqueDisponivel(db: Db = prisma) {
  const produtos = await db.produto.findMany({
    where: { estoques: { none: { status: STATUS.DISPONIVEL } } },
    select: { id: true },
  });
  if (produtos.length > 0) {
    await db.estoque.createMany({ data: produtos.map(p => ({ produtoId: p.id, quantidade: 0, status: STATUS.DISPONIVEL })) });
  }
  return produtos.length;
}

/** Retorna (criando se necessário) a linha de estoque de um produto em determinado status. */
export async function linhaEstoque(db: Db, produtoId: string, status: string = STATUS.DISPONIVEL) {
  const existente = await db.estoque.findFirst({ where: { produtoId, status } });
  if (existente) return existente;
  return db.estoque.create({ data: { produtoId, quantidade: 0, status } });
}

/** Mapa produtoId -> saldo disponível. */
export async function saldosDisponiveis(db: Db = prisma) {
  const linhas = await db.estoque.groupBy({ by: ['produtoId'], where: { status: STATUS.DISPONIVEL }, _sum: { quantidade: true } });
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
