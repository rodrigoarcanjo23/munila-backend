import { prisma, type Db } from './prisma';

// ============================================================
// ✨ FASE 12: padrão de endereço RUA · COL · NIV · APT (como a etiqueta do sistema antigo)
//   Código:  21.02.001.001   (rua 2 dígitos · coluna 2 · nível 3 · apartamento 3)
//   Barras:  01 21 02 001 001 2  → depósito(2) + rua + coluna + nível + apto + dígito EAN-13
//   A coluna fica no campo "modulo" (já usado pelo mapa e pela rota de separação).
// ============================================================
export interface PartesEndereco { rua?: string | null; coluna?: number | null; nivel?: number | null; apartamento?: number | null }

const pad = (n: number, t: number) => String(n).padStart(t, '0');
const ruaTexto = (rua: string) => (/^\d+$/.test(rua) ? pad(Number(rua), 2) : rua.toUpperCase());

/** Código no padrão RUA.COL.NIV.APT, ou null se faltar alguma parte. */
export function codigoPadrao(p: PartesEndereco) {
  const rua = p.rua?.trim();
  if (!rua || p.coluna == null || p.nivel == null || p.apartamento == null) return null;
  return `${ruaTexto(rua)}.${pad(p.coluna, 2)}.${pad(p.nivel, 3)}.${pad(p.apartamento, 3)}`;
}

/** Dígito verificador EAN-13 (pesos 1 e 3 a partir da esquerda, sobre 12 dígitos). */
export function digitoEAN(doze: string) {
  const s = [...doze].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return String((10 - (s % 10)) % 10);
}

/** 13 dígitos para a etiqueta; null quando a rua não é numérica ou alguma parte não cabe. */
export function codigoBarrasEndereco(deposito: number | null | undefined, p: PartesEndereco) {
  const rua = p.rua?.trim();
  if (deposito == null || !rua || !/^\d+$/.test(rua) || p.coluna == null || p.nivel == null || p.apartamento == null) return null;
  const partes: [number, number][] = [[deposito, 2], [Number(rua), 2], [p.coluna, 2], [p.nivel, 3], [p.apartamento, 3]];
  if (partes.some(([v, t]) => v < 0 || String(v).length > t)) return null;
  const doze = partes.map(([v, t]) => pad(v, t)).join('');
  return doze + digitoEAN(doze);
}

/** Lê "21.02.001.001", "21-02-001-001" ou "21 02 1 1" em partes (para o formulário e a importação). */
export function lerCodigo(codigo: string): PartesEndereco | null {
  const m = codigo.trim().toUpperCase().match(/^([A-Z0-9]+)[.\-\s]+(\d+)[.\-\s]+(\d+)[.\-\s]+(\d+)$/);
  return m ? { rua: m[1], coluna: Number(m[2]), nivel: Number(m[3]), apartamento: Number(m[4]) } : null;
}

/**
 * Na subida da API: numera os depósitos que ainda não têm número (o padrão vira 1) e gera o código de barras
 * dos endereços que já têm as quatro partes. Não muda nenhum código de endereço existente.
 */
export async function padronizarEnderecos(db: Db = prisma) {
  const armazens = await db.armazem.findMany({ orderBy: [{ padrao: 'desc' }, { createdAt: 'asc' }, { codigo: 'asc' }] });
  const usados = new Set(armazens.map(a => a.numero).filter((n): n is number => n != null));
  let prox = 1;
  for (const a of armazens) {
    if (a.numero != null) continue;
    while (usados.has(prox)) prox++;
    await db.armazem.update({ where: { id: a.id }, data: { numero: prox } });
    a.numero = prox; usados.add(prox);
  }
  const num = new Map(armazens.map(a => [a.id, a.numero]));
  const padrao = armazens.find(a => a.padrao)?.numero ?? armazens[0]?.numero ?? 1;
  const locais = await db.localizacao.findMany({ where: { codigoBarras: null, rua: { not: null }, modulo: { not: null }, nivel: { not: null }, apartamento: { not: null } } });
  let n = 0;
  for (const l of locais) {
    const cb = codigoBarrasEndereco(l.armazemId ? num.get(l.armazemId) : padrao, { rua: l.rua, coluna: l.modulo, nivel: l.nivel, apartamento: l.apartamento });
    if (!cb || (await db.localizacao.findFirst({ where: { codigoBarras: cb } }))) continue;
    await db.localizacao.update({ where: { id: l.id }, data: { codigoBarras: cb } });
    n++;
  }
  return n;
}

/** Recalcula o código de barras dos endereços de um depósito (quando o número do depósito muda). */
export async function recalcularBarrasDeposito(db: Db, armazemId: string, numero: number | null) {
  const locais = await db.localizacao.findMany({ where: { armazemId } });
  await db.localizacao.updateMany({ where: { armazemId }, data: { codigoBarras: null } });
  for (const l of locais) {
    const cb = codigoBarrasEndereco(numero, { rua: l.rua, coluna: l.modulo, nivel: l.nivel, apartamento: l.apartamento });
    if (cb) await db.localizacao.update({ where: { id: l.id }, data: { codigoBarras: cb } });
  }
}

/** Número do depósito de um endereço (o depósito padrão quando o endereço não tem armazém). */
export async function numeroDeposito(db: Db, armazemId: string | null | undefined) {
  if (armazemId) return (await db.armazem.findUnique({ where: { id: armazemId }, select: { numero: true } }))?.numero ?? null;
  return (await db.armazem.findFirst({ where: { padrao: true }, select: { numero: true } }))?.numero ?? 1;
}
