import type { Db } from './prisma';

export interface NovoTitulo {
  tipo: 'PAGAR' | 'RECEBER';
  descricao: string;
  valor: number;
  vencimento: Date;
  categoria?: string | null;
  documento?: string | null;
  parcela?: string | null;
  pessoa?: string | null;
  fornecedorId?: string | null;
  pedidoCompraId?: string | null;
  observacao?: string | null;
  usuarioNome?: string | null;
}

const arred = (v: number) => Math.round(v * 100) / 100;

/** Divide um valor em N parcelas mensais (ou a cada `intervaloDias`), ajustando os centavos na última. */
export function parcelar(valor: number, parcelas: number, primeiroVencimento: Date, intervaloDias = 30) {
  const n = Math.max(1, Math.min(60, Math.round(parcelas)));
  const base = arred(valor / n);
  return Array.from({ length: n }, (_, i) => {
    const venc = new Date(primeiroVencimento);
    venc.setDate(venc.getDate() + i * intervaloDias);
    const v = i === n - 1 ? arred(valor - base * (n - 1)) : base;
    return { valor: v, vencimento: venc, parcela: n > 1 ? `${i + 1}/${n}` : null };
  });
}

export async function criarTitulos(db: Db, titulos: NovoTitulo[]) {
  const criados = [];
  for (const t of titulos) criados.push(await db.titulo.create({ data: { ...t, valor: arred(t.valor) } }));
  return criados;
}

/** Vencimento padrão: hoje + prazo do fornecedor (ou 30 dias). */
export function vencimentoPadrao(prazoDias?: number | null) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + (prazoDias ?? 30));
  return d;
}

export const somenteDigitos = (s?: string | null) => (s || '').replace(/\D/g, '');
