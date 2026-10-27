// ✨ Painel 2.0: blocos extras do painel executivo (saúde do estoque, risco de ruptura, validade em R$,
// qualidade do cadastro, pulso do dia, módulos e atividade recente). Tudo calculado no servidor.
import { prisma } from './prisma';
import { STATUS, TIPOS_CONSUMO, TIPOS_TRANSFERENCIA, diasAtras, ehEntrada, estoqueMinimoDe } from './estoque';

const DIA = 86400000;
const diaBR = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const r1 = (n: number) => Math.round(n * 10) / 10;

type ProdutoBase = {
  id: string; nome: string; sku: string; precoCusto: number | null; precoVenda: number | null; estoqueMinimo: number | null; estoqueMaximo: number | null;
  leadTimeDias: number | null; descricao: string | null; enderecoLocalizacao: string | null; ncm: string | null; fornecedorId: string | null; codigoBarras: string | null; dataCadastro: Date; validade: Date | null;
};
type EstoqueBase = { produtoId: string; quantidade: number; status: string; validade: Date | null; localizacaoId: string | null };
type MovBase = { produtoId: string; quantidade: number; tipoAcao: string; dataHora: Date; usuarioId: string };

export async function painelExtra(ctx: {
  dias: number; inicioPeriodo: Date; produtos: ProdutoBase[]; estoques: EstoqueBase[]; movsPeriodo: MovBase[]; saldoPorProduto: Map<string, number>;
  pedidos: { produtoId: string; quantidade: number }[]; ordensConcluidasHoje: number;
}) {
  const { dias, inicioPeriodo, produtos, estoques, movsPeriodo, saldoPorProduto } = ctx;
  const prod = new Map(produtos.map(p => [p.id, p]));
  const custo = (id: string) => prod.get(id)?.precoCusto || 0;
  const agora = Date.now();
  const hoje0 = new Date(); hoje0.setHours(0, 0, 0, 0);
  const hojeBR = diaBR(new Date());

  const [movsAnterior, consumo90, consumo30, ultimaSaida, recebidosHoje, ops, tfAguardando, tfPlanejadas, ultimoInv, atividade] = await Promise.all([
    prisma.movimentacao.findMany({ where: { dataHora: { gte: new Date(inicioPeriodo.getTime() - dias * DIA), lt: inicioPeriodo } }, select: { produtoId: true, quantidade: true, tipoAcao: true } }),
    prisma.movimentacao.groupBy({ by: ['produtoId'], where: { tipoAcao: { in: TIPOS_CONSUMO }, dataHora: { gte: diasAtras(90) } }, _sum: { quantidade: true } }),
    prisma.movimentacao.groupBy({ by: ['produtoId'], where: { tipoAcao: { in: TIPOS_CONSUMO }, dataHora: { gte: diasAtras(30) } }, _sum: { quantidade: true } }),
    prisma.movimentacao.groupBy({ by: ['produtoId'], where: { tipoAcao: { in: TIPOS_CONSUMO } }, _max: { dataHora: true } }),
    prisma.pedidoCompra.count({ where: { dataRecebimento: { gte: hoje0 } } }),
    prisma.ordemProducao.findMany({ where: { status: { in: ['Planejada', 'Liberada', 'Em produção', 'Pausada'] } }, select: { status: true, entregaPrevista: true } }),
    prisma.tfOrdem.count({ where: { status: 'Aguardando aprovação' } }).catch(() => 0),
    prisma.tfOrdem.count({ where: { status: 'Planejada' } }).catch(() => 0),
    prisma.inventario.findFirst({ where: { status: 'Concluído' }, orderBy: { concluidoEm: 'desc' }, include: { itens: { select: { saldoSistema: true, quantidadeContada: true } } } }),
    prisma.movimentacao.findMany({ orderBy: { dataHora: 'desc' }, take: 14, include: { produto: { select: { id: true, nome: true, sku: true } }, usuario: { select: { nome: true } } } }),
  ]);
  const c90 = new Map(consumo90.map(c => [c.produtoId, c._sum.quantidade || 0]));
  const c30 = new Map(consumo30.map(c => [c.produtoId, c._sum.quantidade || 0]));
  const ult = new Map(ultimaSaida.map(u => [u.produtoId, u._max.dataHora]));
  const pedidoAberto = new Map<string, number>();
  for (const p of ctx.pedidos) pedidoAberto.set(p.produtoId, (pedidoAberto.get(p.produtoId) || 0) + p.quantidade);

  // ---------------------------------------------------------------- comparativo com o período anterior
  const resumir = (movs: { produtoId: string; quantidade: number; tipoAcao: string }[]) => {
    const r = { entradas: 0, saidas: 0, valorEntradas: 0, valorSaidas: 0, consumo: 0, valorConsumo: 0, perdas: 0, valorPerdas: 0 };
    for (const m of movs) {
      if (TIPOS_TRANSFERENCIA.includes(m.tipoAcao)) continue;
      const v = m.quantidade * custo(m.produtoId);
      if (ehEntrada(m.tipoAcao)) { r.entradas += m.quantidade; r.valorEntradas += v; } else { r.saidas += m.quantidade; r.valorSaidas += v; }
      if (TIPOS_CONSUMO.includes(m.tipoAcao)) { r.consumo += m.quantidade; r.valorConsumo += v; }
      if (m.tipoAcao === 'Perdas/Avarias') { r.perdas += m.quantidade; r.valorPerdas += v; }
    }
    return r;
  };
  const periodo = { atual: resumir(movsPeriodo), anterior: resumir(movsAnterior) };

  // ---------------------------------------------------------------- pulso do dia
  const movsHoje = movsPeriodo.filter(m => diaBR(new Date(m.dataHora)) === hojeBR && !TIPOS_TRANSFERENCIA.includes(m.tipoAcao));
  const horas = Array.from({ length: 24 }, (_, h) => ({ hora: h, movimentos: 0 }));
  for (const m of movsHoje) {
    const h = Number(new Date(m.dataHora).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).slice(0, 2)) % 24;
    horas[h].movimentos++;
  }
  const hoje = {
    entradas: movsHoje.filter(m => ehEntrada(m.tipoAcao)).reduce((a, m) => a + m.quantidade, 0),
    saidas: movsHoje.filter(m => !ehEntrada(m.tipoAcao)).reduce((a, m) => a + m.quantidade, 0),
    movimentos: movsHoje.length,
    usuarios: new Set(movsHoje.map(m => m.usuarioId)).size,
    separacoesConcluidas: ctx.ordensConcluidasHoje,
    recebimentos: recebidosHoje,
    porHora: horas,
  };

  // ---------------------------------------------------------------- saúde do estoque (capital por situação)
  type Faixa = 'saudavel' | 'risco' | 'excesso' | 'parado' | 'novo';
  const faixas: Record<Faixa, { chave: Faixa; rotulo: string; descricao: string; produtos: number; valor: number }> = {
    saudavel: { chave: 'saudavel', rotulo: 'Saudável', descricao: 'Gira e tem cobertura adequada', produtos: 0, valor: 0 },
    risco: { chave: 'risco', rotulo: 'Risco de ruptura', descricao: 'Acaba antes do próximo reabastecimento', produtos: 0, valor: 0 },
    excesso: { chave: 'excesso', rotulo: 'Excesso', descricao: 'Mais de 180 dias de cobertura ou acima do máximo', produtos: 0, valor: 0 },
    parado: { chave: 'parado', rotulo: 'Parado', descricao: 'Sem saída nos últimos 90 dias', produtos: 0, valor: 0 },
    novo: { chave: 'novo', rotulo: 'Sem histórico', descricao: 'Cadastrado há menos de 90 dias, ainda sem saída', produtos: 0, valor: 0 },
  };
  const parados: { produtoId: string; nome: string; sku: string; saldo: number; valor: number; ultimaSaida: Date | null }[] = [];
  const excessos: { produtoId: string; nome: string; sku: string; saldo: number; valor: number; coberturaDias: number | null }[] = [];
  const risco: { produtoId: string; nome: string; sku: string; saldo: number; consumoDia: number; coberturaDias: number; leadTimeDias: number; pedidoAberto: number; minimo: number }[] = [];
  const capitalProduto: number[] = [];
  const faixaProduto: Record<string, Faixa> = {};
  let somaCobertura = 0, pesoCobertura = 0;

  for (const p of produtos) {
    const saldo = saldoPorProduto.get(p.id) || 0;
    const valor = saldo * (p.precoCusto || 0);
    if (valor > 0) capitalProduto.push(valor);
    const taxa = Math.max((c90.get(p.id) || 0) / 90, (c30.get(p.id) || 0) / 30);
    const lead = p.leadTimeDias || 7;
    const cobertura = taxa > 0 ? saldo / taxa : null;
    if (taxa > 0 && cobertura !== null && cobertura <= lead + 7) {
      risco.push({ produtoId: p.id, nome: p.nome, sku: p.sku, saldo, consumoDia: r1(taxa), coberturaDias: Math.floor(cobertura), leadTimeDias: lead, pedidoAberto: pedidoAberto.get(p.id) || 0, minimo: estoqueMinimoDe(p) });
    }
    if (saldo <= 0) continue;
    if (cobertura !== null && cobertura < 3650) { somaCobertura += cobertura * valor; pesoCobertura += valor; }
    let f: Faixa;
    if (taxa <= 0) f = agora - p.dataCadastro.getTime() < 90 * DIA ? 'novo' : 'parado';
    else if (cobertura! <= lead + 7) f = 'risco';
    else if (cobertura! > 180 || (p.estoqueMaximo && saldo > p.estoqueMaximo)) f = 'excesso';
    else f = 'saudavel';
    faixas[f].produtos++; faixas[f].valor += valor; faixaProduto[p.id] = f;
    if (f === 'parado') parados.push({ produtoId: p.id, nome: p.nome, sku: p.sku, saldo, valor, ultimaSaida: ult.get(p.id) ?? null });
    if (f === 'excesso') excessos.push({ produtoId: p.id, nome: p.nome, sku: p.sku, saldo, valor, coberturaDias: cobertura === null ? null : Math.floor(cobertura) });
  }
  capitalProduto.sort((a, b) => b - a);
  const capitalTotal = capitalProduto.reduce((a, v) => a + v, 0);
  let acum = 0, itens80 = 0;
  for (const v of capitalProduto) { if (acum >= capitalTotal * 0.8) break; acum += v; itens80++; }
  const concentracao = {
    top10Pct: capitalTotal ? r1((capitalProduto.slice(0, 10).reduce((a, v) => a + v, 0) / capitalTotal) * 100) : 0,
    itens80, itensComValor: capitalProduto.length,
  };

  // ---------------------------------------------------------------- validade em R$
  const validade = [
    { chave: 'vencido', rotulo: 'Vencido', lotes: 0, unidades: 0, valor: 0 },
    { chave: '30', rotulo: 'Até 30 dias', lotes: 0, unidades: 0, valor: 0 },
    { chave: '60', rotulo: '31 a 60 dias', lotes: 0, unidades: 0, valor: 0 },
    { chave: '90', rotulo: '61 a 90 dias', lotes: 0, unidades: 0, valor: 0 },
  ];
  for (const e of estoques) {
    if (e.status !== STATUS.DISPONIVEL || e.quantidade <= 0) continue;
    const v = e.validade ?? prod.get(e.produtoId)?.validade;
    if (!v) continue;
    const d = (v.getTime() - hoje0.getTime()) / DIA;
    const i = d < 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : -1;
    if (i < 0) continue;
    validade[i].lotes++; validade[i].unidades += e.quantidade; validade[i].valor += e.quantidade * custo(e.produtoId);
  }

  // ---------------------------------------------------------------- qualidade do cadastro
  const comLocal = new Set(estoques.filter(e => e.localizacaoId).map(e => e.produtoId));
  const comSaldo = (p: ProdutoBase) => (saldoPorProduto.get(p.id) || 0) > 0;
  const semPreco = produtos.filter(p => !(p.precoVenda && p.precoVenda > 0));
  const qualidade = [
    { chave: 'preco', rotulo: 'Sem preço de venda', quantidade: semPreco.length, impacto: 'Margem e receita potencial ficam distorcidas', rota: '/produtos' },
    { chave: 'custo', rotulo: 'Sem custo', quantidade: produtos.filter(p => !(p.precoCusto && p.precoCusto > 0) && comSaldo(p)).length, impacto: 'Capital em estoque fica subavaliado', rota: '/produtos' },
    { chave: 'minimo', rotulo: 'Sem estoque mínimo', quantidade: produtos.filter(p => p.estoqueMinimo === null && !/\[MIN:\d+\]/.test(p.descricao || '')).length, impacto: 'Usam o mínimo padrão (10) nos alertas', rota: '/produtos' },
    { chave: 'lead', rotulo: 'Sem prazo de reposição', quantidade: produtos.filter(p => !p.leadTimeDias).length, impacto: 'Risco de ruptura calculado com 7 dias', rota: '/produtos' },
    { chave: 'endereco', rotulo: 'Com saldo e sem endereço', quantidade: produtos.filter(p => comSaldo(p) && !p.enderecoLocalizacao && !comLocal.has(p.id)).length, impacto: 'Separação mais lenta', rota: '/locais' },
    { chave: 'fornecedor', rotulo: 'Sem fornecedor', quantidade: produtos.filter(p => !p.fornecedorId).length, impacto: 'Sugestão de compras não agrupa por fornecedor', rota: '/produtos' },
    { chave: 'ncm', rotulo: 'Sem NCM', quantidade: produtos.filter(p => !p.ncm).length, impacto: 'Bloqueia a emissão de NF-e', rota: '/produtos' },
    { chave: 'ean', rotulo: 'Sem código de barras', quantidade: produtos.filter(p => !p.codigoBarras).length, impacto: 'Não dá para bipar no coletor', rota: '/produtos' },
  ];
  const totalChecagens = produtos.length * qualidade.length;
  const falhas = qualidade.reduce((a, q) => a + q.quantidade, 0);
  const capitalSemPreco = semPreco.reduce((a, p) => a + (saldoPorProduto.get(p.id) || 0) * (p.precoCusto || 0), 0);

  // ---------------------------------------------------------------- módulos
  const contados = ultimoInv?.itens.filter(i => i.quantidadeContada !== null) ?? [];
  const modulos = {
    pcp: { abertas: ops.length, emProducao: ops.filter(o => o.status === 'Em produção').length, atrasadas: ops.filter(o => o.entregaPrevista && o.entregaPrevista < hoje0).length },
    transformacao: { aguardando: tfAguardando, planejadas: tfPlanejadas },
    inventario: ultimoInv ? { codigo: ultimoInv.codigo, concluidoEm: ultimoInv.concluidoEm, itens: contados.length, acuracia: contados.length ? r1((contados.filter(i => i.quantidadeContada === i.saldoSistema).length / contados.length) * 100) : null } : null,
  };

  return {
    periodo, hoje, faixaProduto,
    saude: { faixas: Object.values(faixas), coberturaMediaDias: pesoCobertura ? Math.round(somaCobertura / pesoCobertura) : null, concentracao },
    parados: parados.sort((a, b) => b.valor - a.valor).slice(0, 8),
    excessos: excessos.sort((a, b) => b.valor - a.valor).slice(0, 8),
    riscoRuptura: risco.sort((a, b) => a.coberturaDias - b.coberturaDias).slice(0, 10),
    riscoRupturaTotal: risco.length,
    validade,
    qualidade: { itens: qualidade, indice: totalChecagens ? r1(100 - (falhas / totalChecagens) * 100) : 100, capitalSemPreco },
    modulos,
    atividade: atividade.map(m => ({ id: m.id, dataHora: m.dataHora, tipo: m.tipoAcao, quantidade: m.quantidade, entrada: ehEntrada(m.tipoAcao), produto: m.produto, usuario: m.usuario?.nome ?? '-', codigo: m.codigo, lote: m.lote })),
  };
}
