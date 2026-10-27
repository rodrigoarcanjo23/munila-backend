// ✨ FASE 7: geometria do armazém, rota de separação (S-shape), slotting por giro e afinidade entre produtos.
// Tudo puro (sem banco) para poder ser testado e reutilizado pelo mapa, pelo slotting e pelas ondas.

/** Distância entre o centro de duas ruas vizinhas (corredor + duas faces de prateleira), em metros. */
export const LARGURA_RUA = 3;
/** Comprimento de um módulo de prateleira ao longo da rua, em metros. */
export const PASSO_MODULO = 1.2;

/**
 * Esforço extra para pegar no nível, em "metros equivalentes".
 * Nível 2 (cintura) e 3 (peito) formam a zona dourada; o nível 1 obriga a agachar e do 4 em diante precisa de escada.
 */
export function penalidadeNivel(nivel: number | null | undefined) {
  if (!nivel || nivel === 2) return 0;
  if (nivel === 3) return 0.5;
  if (nivel === 1) return 2;
  if (nivel === 4) return 3;
  return 5;
}
export const zonaDourada = (nivel: number | null | undefined) => nivel === 2 || nivel === 3;

export const normalizarEndereco = (s?: string | null) => (s || '').toUpperCase().replace(/\s+/g, '').trim();

export interface LocalBase { id: string; codigo: string; rua: string | null; modulo: number | null; nivel: number | null; tipo: string | null; ativo: boolean; armazemId: string | null }
export interface Posicao extends LocalBase { rua: string; modulo: number; nivel: number; ruaIndice: number; x: number; y: number; custo: number }

const ordemNatural = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });

/** Converte os endereços com rua/módulo/nível em posições com coordenadas. A expedição fica na frente da primeira rua. */
export function montarPosicoes(locais: LocalBase[]) {
  const mapeados = locais.filter(l => l.rua && l.modulo !== null && l.modulo !== undefined);
  const ruas = [...new Set(mapeados.map(l => l.rua!.trim().toUpperCase()))].sort(ordemNatural);
  const indice = new Map(ruas.map((r, i) => [r, i]));
  const posicoes: Posicao[] = mapeados.map(l => {
    const rua = l.rua!.trim().toUpperCase();
    const ruaIndice = indice.get(rua)!;
    const x = ruaIndice * LARGURA_RUA;
    const y = (l.modulo! - 0.5) * PASSO_MODULO;
    return { ...l, rua, modulo: l.modulo!, nivel: l.nivel ?? 1, ruaIndice, x, y, custo: Math.round((x + y + penalidadeNivel(l.nivel)) * 10) / 10 };
  });
  const comprimentoRua = new Map<number, number>();
  for (const p of posicoes) comprimentoRua.set(p.ruaIndice, Math.max(comprimentoRua.get(p.ruaIndice) ?? 0, p.modulo * PASSO_MODULO));
  return {
    ruas, posicoes, comprimentoRua,
    porId: new Map(posicoes.map(p => [p.id, p])),
    porCodigo: new Map(posicoes.map(p => [normalizarEndereco(p.codigo), p])),
    naoMapeados: locais.filter(l => !(l.rua && l.modulo !== null && l.modulo !== undefined)),
  };
}
export type Layout = ReturnType<typeof montarPosicoes>;

// ------------------------------------------------------------------ rota
export interface Parada<T> { pos: Posicao | null; dados: T }

/**
 * Rota em S (serpentina): percorre cada rua com coleta inteira, alternando o sentido; se o número de ruas for ímpar,
 * na última entra só até a coleta mais funda e volta. Paradas sem posição no mapa vão para o fim (sem distância).
 * Referência: heurísticas clássicas de roteamento de picking (S-shape / largest gap).
 */
export function rotaS<T>(paradas: Parada<T>[], layout: Layout) {
  const mapeadas = paradas.filter(p => p.pos) as (Parada<T> & { pos: Posicao })[];
  const semPos = paradas.filter(p => !p.pos);
  const porRua = new Map<number, (Parada<T> & { pos: Posicao })[]>();
  for (const p of mapeadas) porRua.set(p.pos.ruaIndice, [...(porRua.get(p.pos.ruaIndice) ?? []), p]);
  const ruas = [...porRua.keys()].sort((a, b) => a - b);
  const ordenadas: (Parada<T> & { pos: Posicao })[] = [];
  const pontos: { x: number; y: number }[] = [{ x: 0, y: -1 }];
  let distancia = 0;
  ruas.forEach((r, k) => {
    const lista = porRua.get(r)!;
    const x = r * LARGURA_RUA;
    const fundo = layout.comprimentoRua.get(r) ?? Math.max(...lista.map(p => p.pos.y)) + PASSO_MODULO;
    const ultimaImpar = k === ruas.length - 1 && ruas.length % 2 === 1;
    const subindo = k % 2 === 0;
    const seq = [...lista].sort((a, b) => (subindo || ultimaImpar ? a.pos.y - b.pos.y : b.pos.y - a.pos.y) || a.pos.nivel - b.pos.nivel);
    ordenadas.push(...seq);
    if (ultimaImpar) {
      const maxY = Math.max(...lista.map(p => p.pos.y));
      distancia += 2 * (maxY + 0.5);
      pontos.push({ x, y: -0.5 }, { x, y: maxY }, { x, y: -0.5 });
    } else {
      distancia += fundo + 1;
      pontos.push(subindo ? { x, y: -0.5 } : { x, y: fundo + 0.5 }, subindo ? { x, y: fundo + 0.5 } : { x, y: -0.5 });
    }
  });
  if (ruas.length) {
    const xUltima = ruas[ruas.length - 1] * LARGURA_RUA;
    distancia += 2 * xUltima + 2; // ida e volta pela frente/fundo + saída e chegada na expedição
    pontos.push({ x: 0, y: -1 });
  }
  return { paradas: [...ordenadas, ...semPos], distancia: Math.round(distancia * 10) / 10, pontos, semPosicao: semPos.length };
}

// ------------------------------------------------------------------ slotting
export interface ProdutoGiro { id: string; nome: string; sku: string; coletas: number; pos: Posicao | null; enderecoTexto: string | null }

/** ABC por coletas (linhas separadas): A = 20% dos itens que mais saem, B = 30% seguintes, C = o restante. */
export function classificarABC(produtos: { id: string; coletas: number }[]) {
  const ativos = [...produtos].filter(p => p.coletas > 0).sort((a, b) => b.coletas - a.coletas);
  const classe = new Map<string, 'A' | 'B' | 'C'>();
  ativos.forEach((p, i) => {
    const pct = (i + 1) / ativos.length;
    classe.set(p.id, pct <= 0.2 ? 'A' : pct <= 0.5 ? 'B' : 'C');
  });
  return classe;
}

export interface Movimento { produto: ProdutoGiro; de: Posicao | null; para: Posicao; troca: { produto: ProdutoGiro; de: Posicao; para: Posicao | null } | null; ganhoMetros: number }

/**
 * Slotting por giro (COI simplificado): quem sai mais fica onde custa menos pegar.
 * Para cada item A/B mal posicionado, procura a melhor posição de picking livre ou ocupada por um item de giro muito menor (troca).
 * Só sugere quando o ganho líquido em metros caminhados é positivo.
 */
export function sugerirSlotting(produtos: ProdutoGiro[], layout: Layout, opcoes: { limite?: number } = {}) {
  const picking = layout.posicoes.filter(p => p.ativo && (!p.tipo || p.tipo === 'Picking')).sort((a, b) => a.custo - b.custo);
  const classe = classificarABC(produtos);
  const ocupante = new Map<string, ProdutoGiro>();
  for (const p of [...produtos].sort((a, b) => b.coletas - a.coletas)) if (p.pos && !ocupante.has(p.pos.id)) ocupante.set(p.pos.id, p);
  const travados = new Set<string>();
  const posTravadas = new Set<string>();
  const movimentos: Movimento[] = [];
  const candidatos = produtos.filter(p => p.coletas > 0 && (classe.get(p.id) === 'A' || classe.get(p.id) === 'B')).sort((a, b) => b.coletas - a.coletas);

  for (const p of candidatos) {
    if (movimentos.length >= (opcoes.limite ?? 20)) break;
    if (travados.has(p.id)) continue;
    const custoAtual = p.pos ? p.pos.custo : Infinity;
    for (const q of picking) {
      if (q.custo + 1.5 >= custoAtual) break; // nada melhor daqui para frente
      if (posTravadas.has(q.id) || (p.pos && q.id === p.pos.id)) continue;
      const occ = ocupante.get(q.id);
      if (occ && (travados.has(occ.id) || !p.pos || occ.coletas >= p.coletas * 0.5)) continue;
      const ganhoP = p.pos ? p.coletas * (custoAtual - q.custo) * 2 : 0;
      const perdaOcc = occ && p.pos ? occ.coletas * (p.pos.custo - q.custo) * 2 : 0;
      const ganho = ganhoP - perdaOcc;
      if (p.pos && ganho <= 0) continue;
      movimentos.push({ produto: p, de: p.pos, para: q, troca: occ ? { produto: occ, de: q, para: p.pos } : null, ganhoMetros: Math.round(ganho) });
      travados.add(p.id); posTravadas.add(q.id);
      if (occ) travados.add(occ.id);
      if (p.pos) posTravadas.add(p.pos.id);
      break;
    }
  }

  // Índice de esforço: metros caminhados por coleta, antes e depois das sugestões.
  const novaPos = new Map<string, Posicao | null>(produtos.map(p => [p.id, p.pos]));
  for (const m of movimentos) { novaPos.set(m.produto.id, m.para); if (m.troca) novaPos.set(m.troca.produto.id, m.troca.para); }
  const medir = (pos: (p: ProdutoGiro) => Posicao | null | undefined) => {
    let metros = 0, coletas = 0;
    for (const p of produtos) { const x = pos(p); if (!x || p.coletas <= 0) continue; metros += p.coletas * x.custo * 2; coletas += p.coletas; }
    return coletas ? metros / coletas : null;
  };
  const antes = medir(p => p.pos);
  const depois = medir(p => novaPos.get(p.id));
  return {
    classe, movimentos,
    indice: { antes: antes && Math.round(antes * 10) / 10, depois: depois && Math.round(depois * 10) / 10, reducaoPct: antes && depois ? Math.round(((antes - depois) / antes) * 1000) / 10 : 0 },
  };
}

// ------------------------------------------------------------------ afinidade
/** Pares de produtos que saem juntos nas mesmas ordens (índice de Jaccard). Bons candidatos a ficar lado a lado. */
export function afinidade(ordens: string[][], minimoJuntos = 2) {
  const sozinho = new Map<string, number>();
  const pares = new Map<string, number>();
  for (const itens of ordens) {
    const u = [...new Set(itens)].sort();
    for (const a of u) sozinho.set(a, (sozinho.get(a) ?? 0) + 1);
    if (u.length > 30) continue;
    for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) { const k = `${u[i]}|${u[j]}`; pares.set(k, (pares.get(k) ?? 0) + 1); }
  }
  return [...pares.entries()].filter(([, n]) => n >= minimoJuntos).map(([k, juntos]) => {
    const [a, b] = k.split('|');
    const jaccard = juntos / ((sozinho.get(a) ?? 0) + (sozinho.get(b) ?? 0) - juntos);
    return { a, b, juntos, jaccard: Math.round(jaccard * 100) / 100 };
  }).sort((x, y) => y.jaccard - x.jaccard || y.juntos - x.juntos);
}

/** Caminho entre duas posições passando pela frente das ruas (aproximação usada para comparar vizinhança). */
export function distanciaEntre(a: Posicao, b: Posicao) {
  if (a.ruaIndice === b.ruaIndice) return Math.abs(a.y - b.y);
  return Math.abs(a.x - b.x) + a.y + b.y;
}
