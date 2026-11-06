import { prisma, type Db } from './prisma';
import { consumoPorProduto } from './estoque';

/**
 * Classe ABC por produto (consumo a custo nos últimos `dias`): A até 80% do valor acumulado, B até 95%, C o resto.
 * Mesma regra da tela Curva ABC; usada no inventário (escolha de itens) e na ficha do item.
 */
export async function classesAbc(db: Db = prisma, dias = 90): Promise<Map<string, 'A' | 'B' | 'C'>> {
  const desde = new Date(Date.now() - dias * 86400000);
  const [produtos, consumo] = await Promise.all([db.produto.findMany({ select: { id: true, precoCusto: true } }), consumoPorProduto(desde, db)]);
  const base = produtos.map(p => ({ id: p.id, v: (consumo.get(p.id) || 0) * (p.precoCusto || 0) })).sort((a, b) => b.v - a.v);
  const total = base.reduce((a, b) => a + b.v, 0);
  const out = new Map<string, 'A' | 'B' | 'C'>();
  let acumulado = 0;
  for (const b of base) {
    const anterior = acumulado;
    acumulado += total > 0 ? (b.v / total) * 100 : 0;
    out.set(b.id, b.v <= 0 ? 'C' : anterior < 80 ? 'A' : anterior < 95 ? 'B' : 'C');
  }
  return out;
}
