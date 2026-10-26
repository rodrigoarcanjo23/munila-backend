import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, notFound, num, intOuNull, dataOuNull } from '../lib/http';
import { usuarioDaRequisicao } from '../lib/auth';
import { STATUS, descricaoComTagMinimo, ehEntrada, estoqueMinimoDe } from '../lib/estoque';

const router = Router();

const INCLUDE_PRODUTO = {
  categoria: true,
  fornecedor: true,
  ingredientes: { include: { produtoFilho: true } },
} as const;

/** Monta os campos gravados de um produto a partir do corpo da requisição (POST e PUT). */
function dadosProduto(body: any) {
  const minimoInformado = body.estoqueMinimo !== undefined && body.estoqueMinimo !== '' ? intOuNull(body.estoqueMinimo) : undefined;
  // Se o mínimo não veio no campo novo, tenta ler da tag [MIN:x] enviada pelo app mobile.
  const minimo = minimoInformado !== undefined ? minimoInformado : body.descricao?.match(/\[MIN:(\d+)\]/) ? estoqueMinimoDe({ descricao: body.descricao }) : undefined;

  // Campo ausente no corpo = não altera (evita apagar dados quando um cliente antigo não envia o campo).
  const opt = (v: unknown) => (v === undefined ? undefined : v ? String(v).trim() : null);

  return {
    sku: String(body.sku || '').trim(),
    nome: String(body.nome || '').trim(),
    tipo: body.tipo || 'ACABADO',
    categoriaId: body.categoriaId,
    descricao: minimo !== undefined ? descricaoComTagMinimo(body.descricao, minimo) : opt(body.descricao),
    codigoBarras: opt(body.codigoBarras),
    precoCusto: body.precoCusto !== undefined ? num(body.precoCusto) : undefined,
    precoVenda: body.precoVenda !== undefined ? num(body.precoVenda) : undefined,
    lote: opt(body.lote),
    enderecoLocalizacao: opt(body.enderecoLocalizacao),
    fornecedorId: opt(body.fornecedorId),
    unidade: body.unidade || undefined,
    estoqueMinimo: minimo,
    estoqueMaximo: body.estoqueMaximo !== undefined ? intOuNull(body.estoqueMaximo) : undefined,
    leadTimeDias: body.leadTimeDias !== undefined ? intOuNull(body.leadTimeDias) : undefined,
    validade: body.validade !== undefined ? dataOuNull(body.validade) : undefined,
    imagemUrl: body.imagemUrl !== undefined ? body.imagemUrl || null : undefined,
  };
}

async function validarUnicos(sku: string, codigoBarras: string | null | undefined, idAtual?: string) {
  const skuExistente = await prisma.produto.findUnique({ where: { sku } });
  if (skuExistente && skuExistente.id !== idAtual) throw badRequest(idAtual ? 'SKU pertence a outro produto.' : 'SKU já cadastrado.');
  if (codigoBarras) {
    const cb = await prisma.produto.findUnique({ where: { codigoBarras } });
    if (cb && cb.id !== idAtual) throw badRequest(idAtual ? 'Código de Barras pertence a outro produto.' : 'Código de Barras já cadastrado.');
  }
}

router.get('/produtos', async (_req, res) => {
  const produtos = await prisma.produto.findMany({ include: INCLUDE_PRODUTO, orderBy: { nome: 'asc' } });
  return res.json(produtos);
});

/** Busca por leitura de código de barras ou SKU (leitor/coletor). */
router.get('/produtos/busca', async (req, res) => {
  const codigo = String(req.query.codigo || '').trim();
  if (!codigo) throw badRequest('Informe o código.');
  const produto = await prisma.produto.findFirst({
    where: { OR: [{ codigoBarras: codigo }, { sku: { equals: codigo, mode: 'insensitive' } }] },
    include: { ...INCLUDE_PRODUTO, estoques: { include: { localizacao: true } } },
  });
  if (!produto) throw notFound('Nenhum produto com este código.');
  return res.json(produto);
});

router.post('/produtos', async (req, res) => {
  const dados = dadosProduto(req.body || {});
  if (!dados.sku || !dados.nome) throw badRequest('Nome e SKU são obrigatórios.');
  if (!dados.categoriaId) throw badRequest('Selecione uma categoria.');
  await validarUnicos(dados.sku, dados.codigoBarras);

  const ingredientes: any[] = Array.isArray(req.body.ingredientes) ? req.body.ingredientes : [];
  const novo = await prisma.$transaction(async tx => {
    const produto = await tx.produto.create({
      data: {
        ...dados,
        dataCadastro: dataOuNull(req.body.dataCadastro) ?? new Date(),
        ingredientes: ingredientes.length
          ? { create: ingredientes.map(i => ({ produtoFilhoId: i.produtoFilhoId, quantidade: Math.max(1, Math.round(num(i.quantidade, 1))) })) }
          : undefined,
      },
    });
    // Campo novo e opcional: o web novo envia o saldo inicial junto (o mobile continua usando POST /estoque).
    if (req.body.estoqueInicial !== undefined) {
      await tx.estoque.create({
        data: { produtoId: produto.id, quantidade: Math.max(0, Math.round(num(req.body.estoqueInicial))), status: STATUS.DISPONIVEL, localizacaoId: req.body.localizacaoId || null },
      });
    }
    return produto;
  });
  return res.status(201).json(novo);
});

router.put('/produtos/:id', async (req, res) => {
  const dados = dadosProduto(req.body || {});
  if (!dados.sku || !dados.nome) throw badRequest('Nome e SKU são obrigatórios.');
  await validarUnicos(dados.sku, dados.codigoBarras, req.params.id);

  const atualizado = await prisma.$transaction(async tx => {
    // Receita: só é substituída quando o front envia o campo (compatível com o mobile, que não envia).
    if (Array.isArray(req.body.ingredientes)) {
      await tx.composicao.deleteMany({ where: { produtoPaiId: req.params.id } });
      if (req.body.ingredientes.length) {
        await tx.composicao.createMany({
          data: req.body.ingredientes.map((i: any) => ({ produtoPaiId: req.params.id, produtoFilhoId: i.produtoFilhoId, quantidade: Math.max(1, Math.round(num(i.quantidade, 1))) })),
        });
      }
    }
    return tx.produto.update({
      where: { id: req.params.id },
      data: { ...dados, categoriaId: dados.categoriaId || undefined, dataCadastro: dataOuNull(req.body.dataCadastro) ?? undefined },
      include: INCLUDE_PRODUTO,
    });
  });
  return res.json(atualizado);
});

router.delete('/produtos/:id', async (req, res) => {
  const produtoId = req.params.id;
  const motivo = req.body?.motivo;
  const usuarioId = usuarioDaRequisicao(req);
  if (!motivo || !usuarioId) throw badRequest('Motivo e usuário obrigatórios.');

  const produto = await prisma.produto.findUnique({ where: { id: produtoId } });
  if (!produto) throw notFound('Produto não encontrado.');
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });

  await prisma.$transaction([
    prisma.logAuditoria.create({ data: { acao: 'EXCLUSÃO DE PRODUTO', itemNome: `[${produto.sku}] ${produto.nome}`, usuarioNome: usuario?.nome || 'Sistema / Desconhecido', motivo } }),
    prisma.composicao.deleteMany({ where: { produtoPaiId: produtoId } }),
    prisma.composicao.deleteMany({ where: { produtoFilhoId: produtoId } }),
    prisma.pedidoCompra.deleteMany({ where: { produtoId } }),
    prisma.movimentacao.deleteMany({ where: { produtoId } }),
    prisma.itemOrdemTransferencia.deleteMany({ where: { produtoId } }),
    prisma.inventarioItem.deleteMany({ where: { produtoId } }),
    prisma.estoque.deleteMany({ where: { produtoId } }),
    prisma.produto.delete({ where: { id: produtoId } }),
  ]);
  return res.status(204).send();
});

/**
 * ✨ KARDEX: extrato de movimentação do produto com saldo após cada lançamento.
 * O saldo é reconstruído de trás para frente a partir do saldo disponível atual.
 */
router.get('/produtos/:id/kardex', async (req, res) => {
  const produto = await prisma.produto.findUnique({ where: { id: req.params.id }, include: { categoria: true } });
  if (!produto) throw notFound('Produto não encontrado.');

  const [estoques, movs] = await Promise.all([
    prisma.estoque.findMany({ where: { produtoId: produto.id } }),
    prisma.movimentacao.findMany({ where: { produtoId: produto.id }, include: { usuario: { select: { nome: true } } }, orderBy: { dataHora: 'desc' } }),
  ]);
  const saldoAtual = estoques.filter(e => e.status === STATUS.DISPONIVEL).reduce((a, e) => a + e.quantidade, 0);

  let saldo = saldoAtual;
  const linhas = movs.map(m => {
    const entrada = ehEntrada(m.tipoAcao);
    const linha = {
      id: m.id, dataHora: m.dataHora, tipoAcao: m.tipoAcao, codigo: m.codigo, observacao: m.observacao,
      usuario: m.usuario?.nome, entrada: entrada ? m.quantidade : 0, saida: entrada ? 0 : m.quantidade, saldo,
    };
    saldo -= entrada ? m.quantidade : -m.quantidade;
    return linha;
  });

  return res.json({
    produto,
    saldoAtual,
    saldoInicial: saldo, // saldo de implantação (antes do primeiro lançamento registrado)
    saldosPorStatus: estoques.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.status]: (acc[e.status] || 0) + e.quantidade }), {}),
    linhas: linhas.reverse(),
  });
});

export default router;
