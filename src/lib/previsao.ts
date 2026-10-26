// Funções estatísticas compartilhadas pelo Painel BI e pelo PCP.

export const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export const desvio = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = media(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Suavização exponencial de Holt (nível + tendência). Devolve a previsão dos próximos passos e o erro padrão. */
export function previsaoHolt(serie: number[], passos: number, alfa = 0.5, beta = 0.3) {
  if (serie.length < 3) return { previsao: Array(passos).fill(media(serie)) as number[], erro: 0, tendencia: 0 };
  let nivel = serie[0], tend = serie[1] - serie[0];
  const residuos: number[] = [];
  for (let i = 1; i < serie.length; i++) {
    const prev = nivel + tend;
    residuos.push(serie[i] - prev);
    const novoNivel = alfa * serie[i] + (1 - alfa) * prev;
    tend = beta * (novoNivel - nivel) + (1 - beta) * tend;
    nivel = novoNivel;
  }
  const previsao = Array.from({ length: passos }, (_, h) => Math.max(0, nivel + (h + 1) * tend));
  return { previsao, erro: desvio(residuos), tendencia: tend };
}

// ------------------------------------------------------------ semanas (segunda-feira, no fuso de Brasília)
const DIA = 86400000;

/** Data AAAA-MM-DD de hoje em Brasília. */
export const hojeBR = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

/** Segunda-feira (00:00 UTC) da semana que contém a data AAAA-MM-DD. */
export function segundaDe(iso: string) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = segunda
  return new Date(d.getTime() - dow * DIA);
}

/** Lista de N segundas-feiras a partir da semana atual. */
export function proximasSemanas(n: number) {
  const s0 = segundaDe(hojeBR());
  return Array.from({ length: n }, (_, i) => new Date(s0.getTime() + i * 7 * DIA));
}

/** Índice da semana (0..n-1) de uma data dentro da grade; antes da semana atual (ou sem data) = 0; depois do fim = -1. */
export function indiceSemana(data: Date | null | undefined, semanas: Date[]) {
  if (!data) return 0;
  const s = segundaDe(data.toISOString()).getTime();
  if (s <= semanas[0].getTime()) return 0;
  const i = Math.round((s - semanas[0].getTime()) / (7 * DIA));
  return i < semanas.length ? i : -1;
}
