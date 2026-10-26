import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, notFound, num, dataOuNull } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import {
  consumoPorProduto, diasAtras, estoqueMinimoDe, gerarCodigoPedidoCompra, gerarCodigoRequisicao, linhaEstoque, saldosDisponiveis,
} from '../lib/estoque';
import { enviarEmail, htmlPedidoCompra } from '../lib/notificacoes';

const router = Router();
const INCLUDE_PEDIDO = { fornecedor: true, produto: true } as const;

router.get('/pedidos-compra', async (_req, res) => {
  return res.json(await prisma.pedidoCompra.findMany({ include: INCLUDE_PEDIDO, orderBy: { createdAt: 'desc' } }));
});

async function criarPedido(dados: { fornecedorId: string; produtoId: string; quantidade: unknown; custoTotal: unknown; dataPrevisao?: unknown; observacao?: string }) {
  if (!dados.fornecedorId || !dados.produtoId) throw badRequest('Fornecedor e produto são obrigatórios.');
  const quantidade = Math.round(num(dados.quantidade));
  if (quantidade <= 0) throw badRequest('Quantidade inválida.');
  const pedido = await prisma.$transaction(async tx =>
    tx.pedidoCompra.create({
      data: {
        codigo: await gerarCodigoPedidoCompra(tx), fornecedorId: dados.fornecedorId, produtoId: dados.produtoId, quantidade,
        custoTotal: num(dados.custoTotal), dataPrevisao: dataOuNull(dados.dataPrevisao), observacao: dados.observacao || null, status: 'Pendente',
      },
      include: INCLUDE_PEDIDO,
    }),
  );
  // E-mail automático para o fornecedor (quando EMAIL_USER/EMAIL_PASS estiverem configurados).
  enviarEmail(pedido.fornecedor.email, `Pedido de Compra ${pedido.codigo}`, htmlPedidoCompra(pedido));
  return pedido;
}

router.post('/pedidos-compra', async (req, res) => {
  return res.status(201).json(await criarPedido(req.body || {}));
});

/** ✨ NOVO: gera vários pedidos de uma vez (usado pela Sugestão de Compras). */
router.post('/pedidos-compra/lote', async (req, res) => {
  const itens: any[] = Array.isArray(req.body?.itens) ? req.body.itens : [];
  if (itens.length === 0) throw badRequest('Nenhum item selecionado.');
  const criados = [];
  for (const item of itens) criados.push(await criarPedido(item)); // sequencial para manter os códigos PC em ordem
  return res.status(201).json(criados);
});

router.put('/pedidos-compra/:id', async (req, res) => {
  const pedido = await prisma.pedidoCompra.findUnique({ where: { id: req.params.id } });
  if (!pedido) throw notFound('Pedido não encontrado.');
  if (pedido.status !== 'Pendente') throw badRequest('Pedido já recebido.');
  const { fornecedorId, produtoId, quantidade, custoTotal, dataPrevisao, observacao } = req.body || {};
  const atualizado = await prisma.pedidoCompra.update({
    where: { id: req.params.id },
    data: { fornecedorId, produtoId, quantidade: Math.round(num(quantidade)), custoTotal: num(custoTotal), dataPrevisao: dataOuNull(dataPrevisao), observacao },
  });
  return res.json(atualizado);
});

router.delete('/pedidos-compra/:id', async (req, res) => {
  const pedido = await prisma.pedidoCompra.findUnique({ where: { id: req.params.id } });
  if (!pedido) throw notFound('Pedido não encontrado.');
  if (pedido.status !== 'Pendente') throw badRequest('Pedido já recebido.');
  await prisma.pedidoCompra.delete({ where: { id: req.params.id } });
  return res.status(204).send();
});

/**
 * Recebimento do pedido.
 * ✨ NOVO: aceita `quantidadeRecebida` (conferência cega). Divergências ficam registradas no pedido
 * e somente o que foi realmente contado entra no estoque. Também bloqueia recebimento em duplicidade.
 */
router.put('/pedidos-compra/:id/receber', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');

  const resultado = await prisma.$transaction(async tx => {
    const pedido = await tx.pedidoCompra.findUnique({ where: { id: req.params.id } });
    if (!pedido) throw new Error('Pedido não encontrado.');
    if (pedido.status !== 'Pendente') throw new Error('Este pedido já foi recebido.');

    const recebida = req.body?.quantidadeRecebida !== undefined && req.body.quantidadeRecebida !== ''
      ? Math.max(0, Math.round(num(req.body.quantidadeRecebida)))
      : pedido.quantidade;
    const diferenca = recebida - pedido.quantidade;
    const divergencia = diferenca === 0 ? null : `${diferenca > 0 ? 'Sobra' : 'Falta'} de ${Math.abs(diferenca)} un (pedido ${pedido.quantidade}, recebido ${recebida})`;

    const atualizado = await tx.pedidoCompra.update({
      where: { id: pedido.id },
      data: {
        status: divergencia ? 'Recebido c/ divergência' : 'Recebido', quantidadeRecebida: recebida, divergencia,
        dataRecebimento: new Date(), observacao: req.body?.observacao || pedido.observacao,
      },
    });

    if (recebida > 0) {
      const disponivel = await linhaEstoque(tx, pedido.produtoId);
      await tx.estoque.update({ where: { id: disponivel.id }, data: { quantidade: { increment: recebida } } });
      await tx.movimentacao.create({
        data: {
          produtoId: pedido.produtoId, usuarioId, quantidade: recebida, tipoAcao: 'Entrada de mercadoria', codigo: await gerarCodigoRequisicao(tx, 'RE'),
          observacao: `Recebimento via Pedido ${pedido.codigo || ''}${divergencia ? ` — ${divergencia}` : ''}`,
        },
      });
    }
    // Atualiza o custo unitário do produto com o custo do pedido (custo da última entrada).
    if (req.body?.atualizarCusto && pedido.quantidade > 0) {
      await tx.produto.update({ where: { id: pedido.produtoId }, data: { precoCusto: Number((pedido.custoTotal / pedido.quantidade).toFixed(4)) } });
    }
    return atualizado;
  });
  return res.json(resultado);
});

/**
 * ✨ NOVO: SUGESTÃO DE COMPRAS (ponto de pedido + cobertura).
 *   consumo diário  = consumo do período / dias
 *   ponto de pedido = consumo diário × (lead time + dias de segurança), nunca abaixo do estoque mínimo
 *   sugerido        = (ponto de pedido + consumo diário × dias de cobertura) − saldo − pedidos pendentes
 * Parâmetros: ?dias=90&cobertura=30&seguranca=7&leadPadrao=7
 */
router.get('/compras/sugestao', async (req, res) => {
  const dias = Math.max(7, num(req.query.dias, 90));
  const cobertura = Math.max(0, num(req.query.cobertura, 30));
  const seguranca = Math.max(0, num(req.query.seguranca, 7));
  const leadPadrao = Math.max(0, num(req.query.leadPadrao, 7));

  const [produtos, saldos, consumo, pendentes] = await Promise.all([
    prisma.produto.findMany({ include: { fornecedor: true, categoria: true }, orderBy: { nome: 'asc' } }),
    saldosDisponiveis(),
    consumoPorProduto(diasAtras(dias)),
    prisma.pedidoCompra.groupBy({ by: ['produtoId'], where: { status: 'Pendente' }, _sum: { quantidade: true } }),
  ]);
  const pendenteMap = new Map(pendentes.map(p => [p.produtoId, p._sum.quantidade || 0]));

  const linhas = produtos.map(p => {
    const saldo = saldos.get(p.id) ?? 0;
    const consumoPeriodo = consumo.get(p.id) ?? 0;
    const consumoDiario = consumoPeriodo / dias;
    const lead = p.leadTimeDias ?? leadPadrao;
    const minimo = estoqueMinimoDe(p);
    const pontoPedido = Math.max(minimo, Math.ceil(consumoDiario * (lead + seguranca)));
    const pendente = pendenteMap.get(p.id) ?? 0;
    const alvo = p.estoqueMaximo ?? Math.ceil(pontoPedido + consumoDiario * cobertura);
    const precisa = saldo + pendente <= pontoPedido;
    const sugerido = precisa ? Math.max(0, Math.ceil(Math.max(alvo, pontoPedido + 1) - saldo - pendente)) : 0;
    const coberturaDias = consumoDiario > 0 ? Math.floor(saldo / consumoDiario) : null;
    return {
      produtoId: p.id, sku: p.sku, nome: p.nome, tipo: p.tipo, categoria: p.categoria?.nome ?? '-',
      fornecedorId: p.fornecedorId, fornecedor: p.fornecedor?.nomeEmpresa ?? null,
      saldo, pendente, minimo, consumoPeriodo, consumoDiario: Number(consumoDiario.toFixed(3)), leadTimeDias: lead,
      pontoPedido, coberturaDias, sugerido, custoUnitario: p.precoCusto ?? 0, valorSugerido: sugerido * (p.precoCusto ?? 0),
      urgencia: saldo <= 0 ? 'Ruptura' : coberturaDias !== null && coberturaDias <= lead ? 'Crítica' : precisa ? 'Repor' : 'OK',
    };
  });

  return res.json({ parametros: { dias, cobertura, seguranca, leadPadrao }, itens: linhas });
});

/**
 * ✨ NOVO: ENTRADA POR XML DE NF-e.
 * O navegador lê o XML, o usuário vincula os itens aos produtos, e aqui registramos a entrada.
 */
router.post('/recebimentos/nfe', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  const { numero, emitente, chave, atualizarCusto } = req.body || {};
  const itens: any[] = Array.isArray(req.body?.itens) ? req.body.itens : [];
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  if (itens.length === 0) throw badRequest('Nenhum item vinculado a produtos.');

  const resultado = await prisma.$transaction(async tx => {
    const codigo = await gerarCodigoRequisicao(tx, 'RE');
    let unidades = 0;
    for (const item of itens) {
      const qtd = Math.round(num(item.quantidade));
      if (!item.produtoId || qtd <= 0) continue;
      const disponivel = await linhaEstoque(tx, item.produtoId);
      await tx.estoque.update({ where: { id: disponivel.id }, data: { quantidade: { increment: qtd } } });
      await tx.movimentacao.create({
        data: {
          produtoId: item.produtoId, usuarioId, quantidade: qtd, tipoAcao: 'Entrada de mercadoria', codigo,
          observacao: `NF-e ${numero || 's/n'}${emitente ? ` — ${emitente}` : ''}${chave ? ` (chave ${chave})` : ''}`,
        },
      });
      if (atualizarCusto && num(item.custoUnitario) > 0) {
        await tx.produto.update({ where: { id: item.produtoId }, data: { precoCusto: num(item.custoUnitario) } });
      }
      unidades += qtd;
    }
    return { codigo, unidades, itens: itens.length };
  });
  return res.status(201).json(resultado);
});

export default router;
