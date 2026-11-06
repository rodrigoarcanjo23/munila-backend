import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { HttpError, badRequest, notFound, num } from '../lib/http';
import { perfilDe, usuarioDaRequisicao } from '../lib/auth';
import { STATUS, entradaEstoque, gerarCodigoRequisicao, registrarMovimentos, saidaFEFO, saldosDisponiveis } from '../lib/estoque';
import { registrarSobra } from '../lib/divergencias';

// ============================================================
// ✨ FASE 10: DIVERGÊNCIAS (sobra sem NF)
// Cada sobra fica aberta até ser resolvida, total ou parcialmente:
//   NOVA_NF    → nota do fornecedor recebida: a sobra vira saldo disponível (RE "Regularização de sobra (NF)")
//   DEVOLUCAO  → o excedente saiu (devolução/retirada): a linha de sobra é baixada
//   AJUSTE     → incorporada por ajuste de inventário: só gestor/admin, com justificativa
//   RECONTAGEM → a recontagem não confirmou a sobra: a linha de sobra é baixada
// ============================================================
const router = Router();

const TIPOS: Record<string, string> = { NOVA_NF: 'Nova NF recebida', DEVOLUCAO: 'Devolução / retirada', AJUSTE: 'Ajuste aprovado', RECONTAGEM: 'Recontagem não confirmou' };
const INCLUDE = {
  produto: { select: { id: true, sku: true, nome: true, precoCusto: true, enderecoLocalizacao: true } },
  armazem: { select: { id: true, nome: true } },
  fornecedor: { select: { id: true, nomeEmpresa: true, cnpj: true } },
  resolucoes: { orderBy: { createdAt: 'asc' as const } },
} as const;
const texto = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

router.get('/divergencias', async (req, res) => {
  const filtro = String(req.query.status || 'abertas');
  const where = filtro === 'abertas' ? { status: { in: ['Aberta', 'Parcial'] } } : filtro === 'resolvidas' ? { status: 'Resolvida' } : {};
  const lista = await prisma.divergencia.findMany({ where, include: INCLUDE, orderBy: { createdAt: 'desc' }, take: 1000 });
  return res.json(lista);
});

router.get('/divergencias/resumo', async (_req, res) => {
  const abertas = await prisma.divergencia.findMany({ where: { status: { in: ['Aberta', 'Parcial'] } }, include: { produto: { select: { precoCusto: true } } } });
  const unidades = abertas.reduce((a, d) => a + d.quantidade - d.quantidadeResolvida, 0);
  const valor = abertas.reduce((a, d) => a + (d.quantidade - d.quantidadeResolvida) * (d.produto.precoCusto || 0), 0);
  const maisAntiga = abertas.reduce<Date | null>((m, d) => (!m || d.createdAt < m ? d.createdAt : m), null);
  return res.json({ abertas: abertas.length, unidades, valor, maisAntiga });
});

router.post('/divergencias/:id/resolver', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  const tipo = String(req.body?.tipo || '');
  if (!TIPOS[tipo]) throw badRequest('Escolha como a sobra foi resolvida.');
  const quantidade = Math.round(num(req.body?.quantidade));
  const documento = texto(req.body?.documento);
  const justificativa = texto(req.body?.justificativa);
  if (quantidade <= 0) throw badRequest('Informe a quantidade.');
  if (tipo === 'NOVA_NF' && !documento) throw badRequest('Informe o número da NF que o fornecedor emitiu para a sobra.');
  if (tipo === 'DEVOLUCAO' && !documento) throw badRequest('Informe o documento da devolução (NF de devolução ou protocolo de retirada).');
  if ((tipo === 'AJUSTE' || tipo === 'RECONTAGEM') && !justificativa) throw badRequest('Escreva a justificativa.');
  if (tipo === 'AJUSTE' && perfilDe(req.usuario?.cargo) !== 'admin') throw new HttpError(403, 'Só gestor ou administrador pode incorporar uma sobra por ajuste.');

  const usuario = req.usuario ?? (await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { nome: true } }));
  const nome = usuario?.nome || 'Desconhecido';

  const r = await prisma.$transaction(async tx => {
    const dv = await tx.divergencia.findUnique({ where: { id: String(req.params.id) }, include: { produto: { select: { sku: true, nome: true } } } });
    if (!dv) throw notFound('Ocorrência não encontrada.');
    if (dv.status === 'Resolvida') throw new Error(`${dv.codigo} já está resolvida.`);
    const pendente = dv.quantidade - dv.quantidadeResolvida;
    if (quantidade > pendente) throw new Error(`${dv.codigo} tem só ${pendente} un pendente(s).`);

    // tira da linha "Sobra sem NF" (mesmo armazém e lote)
    const linha = await tx.estoque.findFirst({ where: { produtoId: dv.produtoId, status: STATUS.SOBRA, armazemId: dv.armazemId, lote: dv.lote }, orderBy: { quantidade: 'desc' } });
    if (!linha || linha.quantidade < quantidade) throw new Error(`A sobra de [${dv.produto.sku}] não está mais no estoque (saldo da sobra: ${linha?.quantidade ?? 0}). Confira a tela de Estoque.`);
    await tx.estoque.update({ where: { id: linha.id }, data: { quantidade: { decrement: quantidade } } });

    let codigoMovimento: string | null = null;
    if (tipo === 'NOVA_NF' || tipo === 'AJUSTE') {
      const parte = await entradaEstoque(tx, { produtoId: dv.produtoId, quantidade, armazemId: dv.armazemId, lote: dv.lote, validade: dv.validade });
      codigoMovimento = await gerarCodigoRequisicao(tx, 'RE');
      await registrarMovimentos(tx, {
        produtoId: dv.produtoId, usuarioId, codigo: codigoMovimento,
        tipoAcao: tipo === 'NOVA_NF' ? 'Regularização de sobra (NF)' : 'Ajuste de Entrada de Inventário',
        observacao: tipo === 'NOVA_NF' ? `Sobra ${dv.codigo} regularizada pela NF ${documento}.` : `Sobra ${dv.codigo} incorporada por ajuste aprovado por ${nome}: ${justificativa}`,
      }, [parte]);
    }

    await tx.divergenciaResolucao.create({ data: { divergenciaId: dv.id, tipo, quantidade, documento, justificativa, usuarioNome: nome, codigoMovimento } });
    const resolvida = dv.quantidadeResolvida + quantidade;
    const status = resolvida >= dv.quantidade ? 'Resolvida' : 'Parcial';
    await tx.divergencia.update({ where: { id: dv.id }, data: { quantidadeResolvida: resolvida, status, resolvidaEm: status === 'Resolvida' ? new Date() : null } });
    await tx.logAuditoria.create({ data: {
      acao: `SOBRA: ${TIPOS[tipo].toUpperCase()}`, itemNome: `${dv.codigo} · [${dv.produto.sku}] ${dv.produto.nome} · ${quantidade} un`, usuarioNome: nome,
      motivo: [documento && `Documento: ${documento}`, justificativa, codigoMovimento && `Movimento ${codigoMovimento}`, `Pendente após: ${dv.quantidade - resolvida} un`].filter(Boolean).join(' · '),
    } });
    return tx.divergencia.findUnique({ where: { id: dv.id }, include: INCLUDE });
  });
  return res.json(r);
});

// ------------------------------------------------------------ inventário já concluído (antes desta regra)
// Inventários fechados antes da FASE 10 colocaram a sobra direto no disponível. Aqui ela volta para
// "Sobra sem NF" com ocorrência: sai do disponível por movimento rastreável e fica aguardando NF/devolução/ajuste.

/** Inventários concluídos com itens contados acima do sistema e quanto de cada sobra ainda não virou ocorrência. */
router.get('/divergencias/inventarios', async (_req, res) => {
  const invs = await prisma.inventario.findMany({
    where: { status: 'Concluído', sobraSemNF: false }, orderBy: { concluidoEm: 'desc' }, take: 60,
    include: { armazem: { select: { id: true, nome: true } }, itens: { include: { produto: { select: { id: true, sku: true, nome: true, precoCusto: true } } } } },
  });
  const out = [];
  for (const inv of invs) {
    const itens = inv.itens.filter(i => i.quantidadeContada !== null && i.quantidadeContada > i.saldoSistema);
    if (!itens.length) continue;
    const jaRegistrado = await prisma.divergencia.groupBy({ by: ['produtoId'], where: { inventarioId: inv.id }, _sum: { quantidade: true } });
    const ja = new Map(jaRegistrado.map(j => [j.produtoId, j._sum.quantidade || 0]));
    const disp = await saldosDisponiveis(prisma, inv.armazemId);
    out.push({
      id: inv.id, codigo: inv.codigo, descricao: inv.descricao, concluidoEm: inv.concluidoEm, armazem: inv.armazem,
      itens: itens.map(i => {
        const sobra = i.quantidadeContada! - i.saldoSistema;
        const registrado = ja.get(i.produtoId) || 0;
        return { produtoId: i.produtoId, sku: i.produto.sku, nome: i.produto.nome, precoCusto: i.produto.precoCusto, sistema: i.saldoSistema, contado: i.quantidadeContada, sobra, registrado, pendente: Math.max(0, sobra - registrado), disponivelAgora: disp.get(i.produtoId) || 0 };
      }),
    });
  }
  return res.json(out);
});

/** Leva a sobra de um inventário já concluído para "Sobra sem NF" (só gestor/admin). */
router.post('/divergencias/inventarios/:id/trazer', async (req, res) => {
  const usuarioId = usuarioDaRequisicao(req);
  if (!usuarioId) throw badRequest('Usuário não identificado.');
  if (perfilDe(req.usuario?.cargo) !== 'admin') throw new HttpError(403, 'Só gestor ou administrador pode tirar saldo do disponível para sobra sem NF.');
  const pedidos = (Array.isArray(req.body?.itens) ? req.body.itens : [])
    .map((i: any) => ({ produtoId: String(i.produtoId), quantidade: Math.round(num(i.quantidade)) })).filter((i: any) => i.quantidade > 0);
  if (!pedidos.length) throw badRequest('Escolha pelo menos um item e a quantidade.');
  const nome = req.usuario?.nome ?? (await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { nome: true } }))?.nome ?? 'Desconhecido';

  const criadas = await prisma.$transaction(async tx => {
    const inv = await tx.inventario.findUnique({ where: { id: String(req.params.id) }, include: { itens: { include: { produto: { select: { sku: true, nome: true } } } } } });
    if (!inv) throw notFound('Inventário não encontrado.');
    if (inv.status !== 'Concluído') throw new Error('Use esta opção só para inventários já concluídos. Nos novos, a sobra já vai para "Sobra sem NF" ao concluir.');
    if (inv.sobraSemNF) throw new Error(`${inv.codigo} foi concluído já com a regra de sobra sem NF: a sobra dele não foi para o disponível.`);
    const codigoRS = await gerarCodigoRequisicao(tx, 'RS');
    const out: string[] = [];
    for (const p of pedidos) {
      const item = inv.itens.find(i => i.produtoId === p.produtoId);
      if (!item || item.quantidadeContada === null || item.quantidadeContada <= item.saldoSistema) throw new Error('Um dos produtos não teve sobra neste inventário.');
      const sobra = item.quantidadeContada - item.saldoSistema;
      const ja = (await tx.divergencia.aggregate({ where: { inventarioId: inv.id, produtoId: p.produtoId }, _sum: { quantidade: true } }))._sum.quantidade || 0;
      if (p.quantidade > sobra - ja) throw new Error(`[${item.produto.sku}] teve sobra de ${sobra} no ${inv.codigo}${ja ? ` e ${ja} já estão em ocorrência` : ''}: dá para trazer no máximo ${Math.max(0, sobra - ja)}.`);
      // sai do disponível (FEFO), com movimento no Kardex
      const partes = await saidaFEFO(tx, { produtoId: p.produtoId, quantidade: p.quantidade, armazemId: inv.armazemId, rotulo: `[${item.produto.sku}] ${item.produto.nome}` });
      await registrarMovimentos(tx, {
        produtoId: p.produtoId, usuarioId, codigo: codigoRS, tipoAcao: 'Transferência para sobra sem NF',
        observacao: `Sobra do inventário ${inv.codigo} (sistema ${item.saldoSistema}, contado ${item.quantidadeContada}) retirada do disponível até ter NF. Por ${nome}.`,
      }, partes);
      // e vira sobra sem NF com ocorrência, lote a lote
      for (const parte of partes) {
        const dv = await registrarSobra(tx, {
          produtoId: p.produtoId, quantidade: parte.quantidade, armazemId: parte.armazemId, lote: parte.lote, validade: parte.validade,
          origem: 'Inventário', documentoOrigem: inv.codigo, inventarioId: inv.id, quantidadeDocumento: item.saldoSistema, quantidadeContada: item.quantidadeContada, criadoPor: nome,
          observacao: `Inventário ${inv.codigo} concluído antes da regra de sobra sem NF: ${parte.quantidade} un tiradas do disponível (${codigoRS}).${req.body?.observacao ? ` ${String(req.body.observacao).trim()}` : ''}`,
        });
        if (dv) out.push(dv.codigo);
      }
    }
    return out;
  });
  return res.status(201).json({ ocorrencias: criadas });
});

export default router;
