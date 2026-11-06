import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { badRequest, notFound } from '../lib/http';
import { STATUS } from '../lib/estoque';
import { normalizarEndereco } from '../lib/armazem';
import { codigoBarrasEndereco, codigoPadrao, lerCodigo, numeroDeposito } from '../lib/enderecos';

const router = Router();

// ---------------- Categorias ----------------
router.get('/categorias', async (_req, res) => {
  return res.json(await prisma.categoria.findMany({ orderBy: { nome: 'asc' }, include: { _count: { select: { produtos: true } } } }));
});

router.post('/categorias', async (req, res) => {
  const { nome, descricao } = req.body || {};
  if (!nome) throw badRequest('Informe o nome da categoria.');
  return res.status(201).json(await prisma.categoria.create({ data: { nome, descricao: descricao || null } }));
});

router.put('/categorias/:id', async (req, res) => {
  const { nome, descricao } = req.body || {};
  return res.json(await prisma.categoria.update({ where: { id: req.params.id }, data: { nome, descricao } }));
});

router.delete('/categorias/:id', async (req, res) => {
  const emUso = await prisma.produto.count({ where: { categoriaId: req.params.id } });
  if (emUso > 0) throw badRequest(`Categoria em uso por ${emUso} produto(s).`);
  await prisma.categoria.delete({ where: { id: req.params.id } });
  return res.status(204).send();
});

// ---------------- Localizações (endereços do armazém) ----------------
// ✨ FASE 12: padrão RUA · COL · NIV · APT com código de barras; conteúdo do endereço (itens e onde mais estão).
const TIPOS_LOCAL = ['Picking', 'Pulmão', 'Chão', 'Doca'];
const inteiro = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null);
const SEL_PROD = { id: true, sku: true, nome: true, unidade: true, embalagem: true, enderecoLocalizacao: true } as const;

router.get('/localizacoes', async (_req, res) => {
  return res.json(await prisma.localizacao.findMany({ orderBy: { codigo: 'asc' }, include: { armazem: true } }));
});

/** Itens e unidades guardados em cada endereço (saldo sem endereço conta no endereço do cadastro do produto). */
router.get('/localizacoes/ocupacao', async (_req, res) => {
  const [locais, linhas] = await Promise.all([
    prisma.localizacao.findMany({ select: { id: true, codigo: true, armazemId: true } }),
    prisma.estoque.findMany({ where: { quantidade: { gt: 0 }, status: { not: STATUS.DEMONSTRACAO } }, select: { localizacaoId: true, produtoId: true, quantidade: true, armazemId: true, produto: { select: { enderecoLocalizacao: true } } } }),
  ]);
  const porCodigo = new Map<string, typeof locais>();
  for (const l of locais) { const k = normalizarEndereco(l.codigo); porCodigo.set(k, [...(porCodigo.get(k) ?? []), l]); }
  const out: Record<string, { produtos: Set<string>; unidades: number }> = {};
  for (const r of linhas) {
    let id = r.localizacaoId;
    if (!id && r.produto.enderecoLocalizacao) {
      const cands = porCodigo.get(normalizarEndereco(r.produto.enderecoLocalizacao)) ?? [];
      id = (cands.find(c => c.armazemId === r.armazemId) ?? cands.find(c => !c.armazemId) ?? cands[0])?.id ?? null;
    }
    if (!id) continue;
    out[id] ??= { produtos: new Set(), unidades: 0 };
    out[id].produtos.add(r.produtoId); out[id].unidades += r.quantidade;
  }
  return res.json(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { produtos: v.produtos.size, unidades: v.unidades }])));
});

/** O que está no endereço: cada item com a quantidade aqui, os lotes, o picking e os demais endereços onde ele está. */
router.get('/localizacoes/:id/conteudo', async (req, res) => {
  const local = await prisma.localizacao.findUnique({ where: { id: String(req.params.id) }, include: { armazem: true } });
  if (!local) throw notFound('Endereço não encontrado.');
  const [aqui, doCadastro, pickings] = await Promise.all([
    prisma.estoque.findMany({ where: { localizacaoId: local.id, quantidade: { gt: 0 }, status: { not: STATUS.DEMONSTRACAO } }, select: { produtoId: true } }),
    prisma.produto.findMany({ where: { enderecoLocalizacao: { equals: local.codigo, mode: 'insensitive' } }, select: { id: true } }),
    prisma.produtoPicking.findMany({ where: { localizacaoId: local.id } }),
  ]);
  const ids = [...new Set([...aqui.map(a => a.produtoId), ...doCadastro.map(p => p.id), ...pickings.map(p => p.produtoId)])];
  const [produtos, linhas] = await Promise.all([
    prisma.produto.findMany({ where: { id: { in: ids } }, select: SEL_PROD }),
    prisma.estoque.findMany({ where: { produtoId: { in: ids }, quantidade: { gt: 0 }, status: { not: STATUS.DEMONSTRACAO } }, include: { localizacao: { select: { id: true, codigo: true } }, armazem: { select: { id: true, nome: true } } } }),
  ]);
  const cod = normalizarEndereco(local.codigo);
  const itens = produtos.map(p => {
    const cadastroAqui = normalizarEndereco(p.enderecoLocalizacao) === cod;
    // linha sem endereço fica no endereço do cadastro do produto (no mesmo armazém)
    const ehAqui = (l: (typeof linhas)[number]) => l.localizacaoId === local.id || (!l.localizacaoId && cadastroAqui && (!local.armazemId || !l.armazemId || l.armazemId === local.armazemId));
    const minhas = linhas.filter(l => l.produtoId === p.id);
    const daqui = minhas.filter(ehAqui);
    const outros = new Map<string, { localizacaoId: string | null; codigo: string; armazem: string | null; quantidade: number }>();
    for (const l of minhas.filter(l => !ehAqui(l))) {
      const codigo = l.localizacao?.codigo ?? p.enderecoLocalizacao ?? 'Sem endereço';
      const k = `${codigo}|${l.armazem?.id ?? ''}`;
      const o = outros.get(k) ?? { localizacaoId: l.localizacao?.id ?? null, codigo, armazem: l.armazem?.nome ?? null, quantidade: 0 };
      o.quantidade += l.quantidade; outros.set(k, o);
    }
    const pk = pickings.find(x => x.produtoId === p.id);
    const quantidade = daqui.reduce((a, l) => a + l.quantidade, 0);
    return {
      produto: p, quantidade, cadastroAqui, picking: pk ? { minimo: pk.minimo, maximo: pk.maximo } : null,
      caixas: p.embalagem ? Math.floor(quantidade / p.embalagem) : null,
      lotes: daqui.map(l => ({ id: l.id, lote: l.lote, validade: l.validade, quantidade: l.quantidade, status: l.status })).sort((a, b) => (a.validade?.getTime() ?? 9e15) - (b.validade?.getTime() ?? 9e15)),
      outros: [...outros.values()].sort((a, b) => b.quantidade - a.quantidade),
      total: minhas.reduce((a, l) => a + l.quantidade, 0),
    };
  }).sort((a, b) => b.quantidade - a.quantidade || a.produto.nome.localeCompare(b.produto.nome));
  return res.json({ local, itens });
});

/** Monta os campos do endereço a partir de Rua/Col/Niv/Apt (o código segue o padrão, a menos que se peça para manter). */
async function dadosLocal(body: any, atual?: { codigo: string; rua: string | null; modulo: number | null; nivel: number | null; apartamento: number | null; armazemId: string | null; tipo: string | null; zona: string }) {
  const b = body || {};
  const armazemId = b.armazemId === undefined ? atual?.armazemId ?? null : b.armazemId || null;
  const lidos = !b.rua && b.codigo ? lerCodigo(String(b.codigo)) : null; // código digitado no padrão vira partes
  const rua = b.rua !== undefined ? (String(b.rua || '').trim().toUpperCase() || null) : lidos?.rua ?? atual?.rua ?? null;
  const coluna = b.coluna !== undefined ? inteiro(b.coluna) : lidos?.coluna ?? atual?.modulo ?? null;
  const nivel = b.nivel !== undefined ? inteiro(b.nivel) : lidos?.nivel ?? atual?.nivel ?? null;
  const apartamento = b.apartamento !== undefined ? inteiro(b.apartamento) : lidos?.apartamento ?? atual?.apartamento ?? null;
  const partes = { rua, coluna, nivel, apartamento };
  const padrao = codigoPadrao(partes);
  const livre = b.codigo ? String(b.codigo).trim().toUpperCase() : null;
  const codigo = padrao && !b.manterCodigo ? padrao : livre ?? atual?.codigo ?? null;
  if (!codigo) throw badRequest('Preencha Rua, Col, Niv e Apt (ou um código).');
  const tipo = TIPOS_LOCAL.includes(b.tipo) ? b.tipo : atual?.tipo ?? 'Picking';
  const zona = String(b.zona ?? '').trim() || (atual && b.zona === undefined ? atual.zona : `${tipo} normal`.toUpperCase());
  const deposito = await numeroDeposito(prisma, armazemId);
  return {
    codigo, armazemId, tipo, zona, rua, modulo: coluna, nivel, apartamento,
    corredor: rua ? `Rua ${rua}` : '-',
    prateleira: [coluna != null && `Col ${String(coluna).padStart(2, '0')}`, nivel != null && `Niv ${String(nivel).padStart(3, '0')}`, apartamento != null && `Apt ${String(apartamento).padStart(3, '0')}`].filter(Boolean).join(' · ') || '-',
    codigoBarras: codigo === padrao ? codigoBarrasEndereco(deposito, partes) : null, // código antigo mantido: a etiqueta usa o próprio código
    ativo: b.ativo === undefined ? undefined : Boolean(b.ativo),
  };
}
async function validarLocal(d: { codigo: string; codigoBarras: string | null }, id?: string) {
  const mesmo = await prisma.localizacao.findFirst({ where: { codigo: { equals: d.codigo, mode: 'insensitive' }, ...(id ? { id: { not: id } } : {}) }, include: { armazem: { select: { nome: true } } } });
  if (mesmo) throw badRequest(`O endereço ${d.codigo} já existe${mesmo.armazem ? ` (${mesmo.armazem.nome})` : ''}.`);
  if (d.codigoBarras) {
    const cb = await prisma.localizacao.findFirst({ where: { codigoBarras: d.codigoBarras, ...(id ? { id: { not: id } } : {}) } });
    if (cb) throw badRequest(`O código de barras ${d.codigoBarras} já é do endereço ${cb.codigo}.`);
  }
}

router.post('/localizacoes', async (req, res) => {
  const d = await dadosLocal(req.body);
  await validarLocal(d);
  return res.status(201).json(await prisma.localizacao.create({ data: { ...d, ativo: d.ativo ?? true } }));
});

router.put('/localizacoes/:id', async (req, res) => {
  const id = String(req.params.id);
  const atual = await prisma.localizacao.findUnique({ where: { id } });
  if (!atual) throw notFound('Endereço não encontrado.');
  const d = await dadosLocal(req.body, atual);
  await validarLocal(d, id);
  const r = await prisma.$transaction(async tx => {
    const salvo = await tx.localizacao.update({ where: { id }, data: d });
    // o código mudou: produtos que apontavam para o código antigo passam a apontar para o novo
    let produtos = 0;
    if (normalizarEndereco(atual.codigo) !== normalizarEndereco(d.codigo)) {
      produtos = (await tx.produto.updateMany({ where: { enderecoLocalizacao: { equals: atual.codigo, mode: 'insensitive' } }, data: { enderecoLocalizacao: d.codigo } })).count;
      await tx.logAuditoria.create({ data: { acao: 'ENDEREÇO RENOMEADO', itemNome: `${atual.codigo} → ${d.codigo}`, usuarioNome: (req as any).usuario?.nome ?? 'Sistema', motivo: `${produtos} produto(s) atualizados para o novo código.` } });
    }
    return { ...salvo, produtosAtualizados: produtos };
  });
  return res.json(r);
});

router.delete('/localizacoes/:id', async (req, res) => {
  const emUso = await prisma.estoque.count({ where: { localizacaoId: req.params.id, quantidade: { gt: 0 } } });
  if (emUso > 0) throw badRequest('Existem produtos com saldo guardados neste endereço.');
  await prisma.estoque.updateMany({ where: { localizacaoId: req.params.id }, data: { localizacaoId: null } });
  await prisma.localizacao.delete({ where: { id: req.params.id } });
  return res.status(204).send();
});

export default router;
