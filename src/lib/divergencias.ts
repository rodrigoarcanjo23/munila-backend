import type { Db } from './prisma';
import { STATUS, entradaEstoque } from './estoque';

// ============================================================
// ✨ FASE 10: sobra sem NF (inventário / recebimento)
// A sobra entra numa linha de estoque própria ("Sobra sem NF"), fora do saldo disponível, e abre uma
// ocorrência (DV000126). Não gera movimentação de estoque: o Kardex só a vê quando for regularizada.
// ============================================================

const anoAtual = () => new Date().getFullYear().toString().slice(-2);

export async function gerarCodigoDivergencia(db: Db) {
  const ano = anoAtual();
  const regs = await db.divergencia.findMany({ where: { codigo: { startsWith: 'DV', endsWith: ano } }, select: { codigo: true } });
  let maior = 0;
  for (const r of regs) { const n = parseInt(r.codigo.slice(2, -ano.length), 10); if (!isNaN(n) && n > maior) maior = n; }
  return `DV${String(maior + 1).padStart(4, '0')}${ano}`;
}

export interface NovaSobra {
  produtoId: string; quantidade: number; armazemId?: string | null; lote?: string | null; validade?: Date | null;
  origem: 'Inventário' | 'Recebimento' | 'NF-e'; documentoOrigem?: string | null; inventarioId?: string | null; pedidoCompraId?: string | null;
  fornecedorId?: string | null; quantidadeDocumento?: number | null; quantidadeContada?: number | null; observacao?: string | null; criadoPor: string;
}

/** Guarda a sobra fora do disponível e abre a ocorrência. */
export async function registrarSobra(db: Db, s: NovaSobra) {
  if (s.quantidade <= 0) return null;
  const parte = await entradaEstoque(db, { produtoId: s.produtoId, quantidade: s.quantidade, armazemId: s.armazemId, lote: s.lote, validade: s.validade, status: STATUS.SOBRA });
  const codigo = await gerarCodigoDivergencia(db);
  const dv = await db.divergencia.create({
    data: {
      codigo, tipo: 'SOBRA', origem: s.origem, documentoOrigem: s.documentoOrigem ?? null, inventarioId: s.inventarioId ?? null, pedidoCompraId: s.pedidoCompraId ?? null,
      produtoId: s.produtoId, armazemId: parte.armazemId, lote: parte.lote, validade: parte.validade, fornecedorId: s.fornecedorId ?? null,
      quantidadeDocumento: s.quantidadeDocumento ?? null, quantidadeContada: s.quantidadeContada ?? null, quantidade: s.quantidade,
      observacao: s.observacao ?? null, criadoPor: s.criadoPor,
    },
    include: { produto: { select: { sku: true, nome: true } } },
  });
  await db.logAuditoria.create({ data: {
    acao: 'SOBRA SEM NF', itemNome: `${codigo} · [${dv.produto.sku}] ${dv.produto.nome} · ${s.quantidade} un`, usuarioNome: s.criadoPor,
    motivo: `${s.origem}${s.documentoOrigem ? ` ${s.documentoOrigem}` : ''}: ${s.quantidadeContada ?? '?'} contado(s) contra ${s.quantidadeDocumento ?? '?'} no documento. Guardado fora do saldo disponível até regularizar.`,
  } });
  return dv;
}

/** Quanto de sobra ainda está pendente por produto (num armazém). */
export async function sobraPendente(db: Db, produtoId: string, armazemId?: string | null, lote?: string | null) {
  const r = await db.estoque.aggregate({ where: { produtoId, status: STATUS.SOBRA, ...(armazemId ? { armazemId } : {}), ...(lote !== undefined ? { lote } : {}) }, _sum: { quantidade: true } });
  return r._sum.quantidade || 0;
}
