// ✨ Painel (central de operação): o que está acontecendo agora e o que precisa ser feito.
// A análise (tendência, saúde do estoque, ruptura, validade, fornecedores, capital e margem) fica no Painel BI.
import { prisma } from './prisma';
import { STATUS, TIPOS_TRANSFERENCIA, ehEntrada } from './estoque';

const DIA = 86400000;
const diaBR = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const horaBR = (d: Date) => Number(d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).slice(0, 2)) % 24;

// ------------------------------------------------------------------ pendências de cadastro
export const PENDENCIAS = [
  { chave: 'preco', rotulo: 'Sem preço de venda', impacto: 'Margem e receita potencial ficam distorcidas' },
  { chave: 'custo', rotulo: 'Com saldo e sem custo', impacto: 'Capital em estoque fica subavaliado' },
  { chave: 'minimo', rotulo: 'Sem estoque mínimo', impacto: 'Usam o mínimo padrão (10) nos alertas' },
  { chave: 'lead', rotulo: 'Sem prazo de reposição', impacto: 'Risco de ruptura calculado com 7 dias' },
  { chave: 'endereco', rotulo: 'Com saldo e sem endereço', impacto: 'Separação mais lenta' },
  { chave: 'fornecedor', rotulo: 'Sem fornecedor', impacto: 'Sugestão de compras não agrupa por fornecedor' },
  { chave: 'ncm', rotulo: 'Sem NCM', impacto: 'Bloqueia a emissão de NF-e' },
  { chave: 'ean', rotulo: 'Sem código de barras', impacto: 'Não dá para bipar no coletor' },
] as const;
export type ChavePendencia = (typeof PENDENCIAS)[number]['chave'];

/** Ids dos produtos com cada pendência de cadastro. Mesma regra no card do Painel e no filtro da tela de Produtos. */
export async function pendenciasCadastro() {
  const [produtos, saldos, comLocal] = await Promise.all([
    prisma.produto.findMany({ select: { id: true, precoCusto: true, precoVenda: true, estoqueMinimo: true, descricao: true, leadTimeDias: true, enderecoLocalizacao: true, fornecedorId: true, ncm: true, codigoBarras: true } }),
    prisma.estoque.groupBy({ by: ['produtoId'], where: { status: STATUS.DISPONIVEL }, _sum: { quantidade: true } }),
    prisma.estoque.findMany({ where: { localizacaoId: { not: null } }, select: { produtoId: true }, distinct: ['produtoId'] }),
  ]);
  const saldo = new Map(saldos.map(s => [s.produtoId, s._sum.quantidade || 0]));
  const local = new Set(comLocal.map(l => l.produtoId));
  const regra: Record<ChavePendencia, (p: (typeof produtos)[number]) => boolean> = {
    preco: p => !(p.precoVenda && p.precoVenda > 0),
    custo: p => !(p.precoCusto && p.precoCusto > 0) && (saldo.get(p.id) || 0) > 0,
    minimo: p => p.estoqueMinimo === null && !/\[MIN:\d+\]/.test(p.descricao || ''),
    lead: p => !p.leadTimeDias,
    endereco: p => (saldo.get(p.id) || 0) > 0 && !p.enderecoLocalizacao?.trim() && !local.has(p.id),
    fornecedor: p => !p.fornecedorId,
    ncm: p => !p.ncm?.trim(),
    ean: p => !p.codigoBarras?.trim(),
  };
  const itens = PENDENCIAS.map(d => ({ ...d, ids: produtos.filter(regra[d.chave]).map(p => p.id) }));
  const falhas = itens.reduce((a, i) => a + i.ids.length, 0);
  const indice = produtos.length ? Math.round((100 - (falhas / (produtos.length * PENDENCIAS.length)) * 100) * 10) / 10 : 100;
  return { total: produtos.length, indice, itens };
}

// ------------------------------------------------------------------ painel
type MovBase = { produtoId: string; quantidade: number; tipoAcao: string; dataHora: Date; usuarioId: string };

export async function painelOperacao(ctx: { movsPeriodo: MovBase[]; custoDe: (produtoId: string) => number }) {
  const hoje0 = new Date(); hoje0.setHours(0, 0, 0, 0);
  const hojeBR = diaBR(new Date());
  const em7 = new Date(hoje0.getTime() + 8 * DIA);

  const [ordens, concluidasHoje, pedidos, ops, foraDisponivel, titulos, tfAguardando, tfPlanejadas, inventarios, atividade, usuarios, pendencias, recebidosHoje] = await Promise.all([
    prisma.ordemTransferencia.findMany({
      where: { status: { in: ['Pendente', 'Em Separação'] } },
      include: { itens: { select: { quantidade: true, marcado: true } }, solicitante: { select: { nome: true } }, separador: { select: { nome: true } } },
    }),
    prisma.ordemTransferencia.findMany({ where: { status: 'Concluída', concluidaEm: { gte: hoje0 } }, select: { separadorId: true, iniciadaEm: true, concluidaEm: true, _count: { select: { itens: true } } } }),
    prisma.pedidoCompra.findMany({ where: { status: 'Pendente' }, include: { fornecedor: { select: { nomeEmpresa: true } }, produto: { select: { id: true, nome: true, sku: true } } } }),
    prisma.ordemProducao.findMany({ where: { status: { in: ['Planejada', 'Liberada', 'Em produção', 'Pausada'] } }, include: { produto: { select: { nome: true, sku: true } }, recurso: { select: { nome: true } } } }),
    prisma.estoque.findMany({ where: { status: { in: [STATUS.DEMONSTRACAO, STATUS.RUPTURA] }, quantidade: { gt: 0 } }, include: { produto: { select: { id: true, nome: true, sku: true, precoCusto: true } }, responsavel: { select: { nome: true } } } }),
    prisma.titulo.findMany({ where: { status: 'Aberto', vencimento: { lt: em7 } }, include: { fornecedor: { select: { nomeEmpresa: true } } }, orderBy: { vencimento: 'asc' } }),
    prisma.tfOrdem.count({ where: { status: 'Aguardando aprovação' } }).catch(() => 0),
    prisma.tfOrdem.count({ where: { status: 'Planejada' } }).catch(() => 0),
    prisma.inventario.findMany({ where: { status: { in: ['Aberto', 'Em contagem'] } }, include: { itens: { select: { quantidadeContada: true } } } }),
    prisma.movimentacao.findMany({ orderBy: { dataHora: 'desc' }, take: 14, include: { produto: { select: { id: true, nome: true, sku: true } }, usuario: { select: { nome: true } } } }),
    prisma.usuario.findMany({ select: { id: true, nome: true, cargo: true } }),
    pendenciasCadastro(),
    prisma.pedidoCompra.count({ where: { dataRecebimento: { gte: hoje0 } } }),
  ]);
  const nomeDe = new Map(usuarios.map(u => [u.id, u]));

  // ---------------- hoje
  const movsHoje = ctx.movsPeriodo.filter(m => diaBR(new Date(m.dataHora)) === hojeBR && !TIPOS_TRANSFERENCIA.includes(m.tipoAcao));
  const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, movimentos: 0 }));
  for (const m of movsHoje) porHora[horaBR(new Date(m.dataHora))].movimentos++;
  const hoje = {
    entradas: movsHoje.filter(m => ehEntrada(m.tipoAcao)).reduce((a, m) => a + m.quantidade, 0),
    saidas: movsHoje.filter(m => !ehEntrada(m.tipoAcao)).reduce((a, m) => a + m.quantidade, 0),
    movimentos: movsHoje.length, usuarios: new Set(movsHoje.map(m => m.usuarioId)).size,
    separacoesConcluidas: concluidasHoje.length, recebimentos: recebidosHoje, porHora,
  };

  // ---------------- equipe de hoje
  type Pessoa = { usuarioId: string; nome: string; cargo: string; movimentos: number; entradas: number; saidas: number; separacoes: number; linhas: number; minutosSeparando: number };
  const equipeMap = new Map<string, Pessoa>();
  const pessoa = (id: string) => {
    if (!equipeMap.has(id)) { const u = nomeDe.get(id); equipeMap.set(id, { usuarioId: id, nome: u?.nome ?? '-', cargo: u?.cargo ?? '', movimentos: 0, entradas: 0, saidas: 0, separacoes: 0, linhas: 0, minutosSeparando: 0 }); }
    return equipeMap.get(id)!;
  };
  for (const m of movsHoje) { const p = pessoa(m.usuarioId); p.movimentos++; if (ehEntrada(m.tipoAcao)) p.entradas += m.quantidade; else p.saidas += m.quantidade; }
  for (const o of concluidasHoje) {
    if (!o.separadorId) continue;
    const p = pessoa(o.separadorId); p.separacoes++; p.linhas += o._count.itens;
    if (o.iniciadaEm && o.concluidaEm) p.minutosSeparando += (o.concluidaEm.getTime() - o.iniciadaEm.getTime()) / 60000;
  }
  const equipe = [...equipeMap.values()].map(e => ({ ...e, minutosSeparando: Math.round(e.minutosSeparando) })).sort((a, b) => b.separacoes - a.separacoes || b.movimentos - a.movimentos);

  // ---------------- fila de separação
  const peso: Record<string, number> = { Urgente: 0, Alta: 1, Normal: 2, Baixa: 3 };
  const fila = ordens.map(o => ({
    id: o.id, codigo: o.codigo, status: o.status, prioridade: o.prioridade, tipo: o.tipo, solicitante: o.solicitante?.nome ?? '-', separador: o.separador?.nome ?? null,
    linhas: o.itens.length, marcadas: o.itens.filter(i => i.marcado).length, unidades: o.itens.reduce((a, i) => a + i.quantidade, 0),
    criadaEm: o.createdAt, iniciadaEm: o.iniciadaEm,
  })).sort((a, b) => (peso[a.prioridade] ?? 2) - (peso[b.prioridade] ?? 2) || a.criadaEm.getTime() - b.criadaEm.getTime());
  const idadeH = (d: Date) => (Date.now() - d.getTime()) / 3600000;
  const separacao = {
    pendentes: fila.filter(o => o.status === 'Pendente').length, emSeparacao: fila.filter(o => o.status === 'Em Separação').length,
    urgentes: fila.filter(o => o.prioridade === 'Urgente').length, linhas: fila.reduce((a, o) => a + o.linhas - o.marcadas, 0),
    maisAntigaH: fila.length ? Math.round(Math.max(...fila.map(o => idadeH(o.criadaEm))) * 10) / 10 : null,
    ordens: fila.slice(0, 10),
  };

  // ---------------- agenda de recebimentos
  const comData = pedidos.filter(p => p.dataPrevisao);
  const dia = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const recebimentos = {
    atrasados: comData.filter(p => dia(p.dataPrevisao!) < hoje0.getTime()).length,
    hoje: comData.filter(p => dia(p.dataPrevisao!) === hoje0.getTime()).length,
    semana: comData.filter(p => dia(p.dataPrevisao!) > hoje0.getTime() && p.dataPrevisao! < em7).length,
    semData: pedidos.length - comData.length,
    valorHojeEAtrasado: comData.filter(p => dia(p.dataPrevisao!) <= hoje0.getTime()).reduce((a, p) => a + p.custoTotal, 0),
    pedidos: [...pedidos].sort((a, b) => (a.dataPrevisao?.getTime() ?? Infinity) - (b.dataPrevisao?.getTime() ?? Infinity)).slice(0, 10).map(p => ({
      id: p.id, codigo: p.codigo, fornecedor: p.fornecedor?.nomeEmpresa ?? '-', produto: p.produto, quantidade: p.quantidade, valor: p.custoTotal, dataPrevisao: p.dataPrevisao,
    })),
  };

  // ---------------- produção em andamento
  const atrasada = (o: (typeof ops)[number]) => Boolean(o.entregaPrevista && o.entregaPrevista < hoje0);
  const ordemOP = (o: (typeof ops)[number]) => (atrasada(o) ? 0 : o.status === 'Em produção' ? 1 : 2);
  const producao = {
    abertas: ops.length, emProducao: ops.filter(o => o.status === 'Em produção').length, atrasadas: ops.filter(atrasada).length,
    entregaHoje: ops.filter(o => o.entregaPrevista && diaBR(o.entregaPrevista) === hojeBR).length,
    ordens: [...ops].sort((a, b) => ordemOP(a) - ordemOP(b) || (a.entregaPrevista?.getTime() ?? Infinity) - (b.entregaPrevista?.getTime() ?? Infinity))
      .slice(0, 8).map(o => ({ id: o.id, codigo: o.codigo, produto: o.produto, status: o.status, prioridade: o.prioridade, planejada: o.quantidadePlanejada, produzida: o.quantidadeProduzida, entregaPrevista: o.entregaPrevista, recurso: o.recurso?.nome ?? null, atrasada: atrasada(o) })),
  };

  // ---------------- fora do disponível (demonstração e avaria)
  const demo = foraDisponivel.filter(e => e.status === STATUS.DEMONSTRACAO);
  const avaria = foraDisponivel.filter(e => e.status === STATUS.RUPTURA);
  const porResp = new Map<string, { responsavel: string; unidades: number; valor: number; produtos: Set<string> }>();
  for (const e of demo) {
    const k = e.responsavel?.nome ?? 'Sem responsável';
    const r = porResp.get(k) ?? { responsavel: k, unidades: 0, valor: 0, produtos: new Set<string>() };
    r.unidades += e.quantidade; r.valor += e.quantidade * (e.produto.precoCusto || 0); r.produtos.add(e.produtoId); porResp.set(k, r);
  }
  const avariaProd = new Map<string, { produtoId: string; nome: string; sku: string; unidades: number; valor: number }>();
  for (const e of avaria) {
    const r = avariaProd.get(e.produtoId) ?? { produtoId: e.produtoId, nome: e.produto.nome, sku: e.produto.sku, unidades: 0, valor: 0 };
    r.unidades += e.quantidade; r.valor += e.quantidade * (e.produto.precoCusto || 0); avariaProd.set(e.produtoId, r);
  }
  const fora = {
    demonstracao: { unidades: demo.reduce((a, e) => a + e.quantidade, 0), valor: [...porResp.values()].reduce((a, r) => a + r.valor, 0), porResponsavel: [...porResp.values()].map(r => ({ ...r, produtos: r.produtos.size })).sort((a, b) => b.valor - a.valor).slice(0, 6) },
    avaria: { unidades: avaria.reduce((a, e) => a + e.quantidade, 0), valor: [...avariaProd.values()].reduce((a, r) => a + r.valor, 0), produtos: [...avariaProd.values()].sort((a, b) => b.valor - a.valor).slice(0, 5) },
  };

  // ---------------- agenda financeira (vencidos + próximos 7 dias)
  const financeiro = {
    pagar: titulos.filter(t => t.tipo === 'PAGAR').reduce((a, t) => a + t.valor, 0),
    receber: titulos.filter(t => t.tipo === 'RECEBER').reduce((a, t) => a + t.valor, 0),
    vencidos: titulos.filter(t => t.vencimento < hoje0).length,
    pagarVencido: titulos.filter(t => t.tipo === 'PAGAR' && t.vencimento < hoje0).reduce((a, t) => a + t.valor, 0),
    receberVencido: titulos.filter(t => t.tipo === 'RECEBER' && t.vencimento < hoje0).reduce((a, t) => a + t.valor, 0),
    titulos: titulos.slice(0, 10).map(t => ({ id: t.id, tipo: t.tipo, descricao: t.descricao, quem: t.fornecedor?.nomeEmpresa ?? t.pessoa ?? null, valor: t.valor, vencimento: t.vencimento, documento: t.documento, parcela: t.parcela })),
  };

  // ---------------- outras filas
  const filas = {
    transformacao: { aguardando: tfAguardando, planejadas: tfPlanejadas },
    inventario: { abertos: inventarios.length, itensAContar: inventarios.reduce((a, i) => a + i.itens.filter(x => x.quantidadeContada === null).length, 0) },
  };

  return {
    hoje, equipe, separacao, recebimentos, producao, fora, financeiro, filas,
    qualidade: { indice: pendencias.indice, total: pendencias.total, itens: pendencias.itens.map(({ ids, ...i }) => ({ ...i, quantidade: ids.length })) },
    atividade: atividade.map(m => ({ id: m.id, dataHora: m.dataHora, tipo: m.tipoAcao, quantidade: m.quantidade, entrada: ehEntrada(m.tipoAcao), produto: m.produto, usuario: m.usuario?.nome ?? '-', codigo: m.codigo, lote: m.lote, valor: m.quantidade * ctx.custoDe(m.produtoId) })),
  };
}
