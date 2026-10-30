// ============================================================
// Transformação: motor do estoque segregado (não toca nas tabelas do estoque oficial).
// Regras de auditoria:
//  - saldo só muda por movimento (razão); nada é editado ou apagado;
//  - cada movimento e cada evento guarda o hash do anterior (cadeia SHA-256), então
//    qualquer alteração feita direto no banco quebra a cadeia e aparece na verificação;
//  - escritas são serializadas por um lock transacional para a cadeia não bifurcar.
// ============================================================
import crypto from 'crypto';
import type { Request } from 'express';
import { prisma, type Db } from './prisma';

export const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const LOCK_TF = 7340021;

export const TIPOS_MATERIAL = ['MATERIA_PRIMA', 'INTERMEDIARIO', 'PRODUTO', 'SUBPRODUTO'] as const;
export const STATUS_LOTE = ['Liberado', 'Quarentena', 'Bloqueado'] as const;

/** Serializa as escritas do módulo dentro da transação (evita duas cadeias de hash paralelas). */
export async function travar(tx: Db) {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${LOCK_TF})`);
}

/** JSON com as chaves em ordem alfabética (o JSONB do Postgres reordena as chaves ao gravar). */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as any)[k])]));
  return v;
}
function sha(anterior: string | null, dados: unknown) {
  return crypto.createHash('sha256').update(`${anterior ?? ''}|${JSON.stringify(canon(dados))}`).digest('hex');
}

const camposMov = (m: { dataHora: Date; tipo: string; materialId: string; loteId: string | null; quantidade: number; saldoLoteApos: number | null; documento: string | null; ordemId: string | null; usuario: string; motivo: string | null }) => ({
  d: m.dataHora.toISOString(), t: m.tipo, m: m.materialId, l: m.loteId, q: r3(m.quantidade), s: m.saldoLoteApos === null ? null : r3(m.saldoLoteApos), doc: m.documento, o: m.ordemId, u: m.usuario, mo: m.motivo,
});
const camposEvt = (e: { dataHora: Date; entidade: string; entidadeId: string | null; acao: string; resumo: string; antes: unknown; depois: unknown; usuario: string }) => ({
  d: e.dataHora.toISOString(), e: e.entidade, id: e.entidadeId, a: e.acao, r: e.resumo, an: e.antes ?? null, de: e.depois ?? null, u: e.usuario,
});

export interface Quem { id: string | null; nome: string; admin: boolean }

/** Quem está fazendo a operação (token; sem token, o usuarioId enviado pelo front). */
export async function quem(req: Request): Promise<Quem> {
  if (req.usuario) {
    const c = (req.usuario.cargo || '').toLowerCase();
    return { id: req.usuario.id, nome: req.usuario.nome, admin: c.includes('admin') || c.includes('gestor') };
  }
  const id = req.body?.usuarioId;
  if (id) {
    const u = await prisma.usuario.findUnique({ where: { id: String(id) }, select: { id: true, nome: true, cargo: true } });
    if (u) { const c = u.cargo.toLowerCase(); return { id: u.id, nome: u.nome, admin: c.includes('admin') || c.includes('gestor') }; }
  }
  return { id: null, nome: 'Sistema', admin: false };
}

/** Registra um evento de auditoria (cadastro, status, aprovação…) na cadeia de eventos. */
export async function evento(tx: Db, e: { entidade: string; entidadeId?: string | null; acao: string; resumo: string; antes?: unknown; depois?: unknown }, q: Quem) {
  const ultimo = await tx.tfEvento.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
  const dataHora = new Date();
  const puro = (v: unknown) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
  const base = { dataHora, entidade: e.entidade, entidadeId: e.entidadeId ?? null, acao: e.acao, resumo: e.resumo, antes: puro(e.antes), depois: puro(e.depois), usuario: q.nome };
  const hashAnterior = ultimo?.hash ?? null;
  return tx.tfEvento.create({ data: { ...base, antes: base.antes ?? undefined, depois: base.depois ?? undefined, usuarioId: q.id, hashAnterior, hash: sha(hashAnterior, camposEvt(base)) } });
}

/** Lança um movimento no razão e atualiza o saldo do lote. Nunca deixa o lote negativo. */
export async function movimentar(tx: Db, m: {
  tipo: string; materialId: string; loteId: string; quantidade: number; documento?: string | null; ordemId?: string | null; motivo?: string | null;
}, q: Quem) {
  const qtd = r3(m.quantidade);
  if (qtd === 0) return null;
  const lote = await tx.tfLote.findUnique({ where: { id: m.loteId }, include: { material: { select: { nome: true, unidade: true } } } });
  if (!lote) throw new Error('Lote não encontrado.');
  const novoSaldo = r3(lote.saldo + qtd);
  if (novoSaldo < -0.0005) throw new Error(`Saldo insuficiente no lote ${lote.codigo} de ${lote.material.nome}: tem ${r3(lote.saldo)} ${lote.material.unidade}, precisa ${r3(-qtd)}.`);
  await tx.tfLote.update({ where: { id: lote.id }, data: { saldo: Math.max(0, novoSaldo) } });
  const ultimo = await tx.tfMovimento.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
  const base = {
    dataHora: new Date(), tipo: m.tipo, materialId: m.materialId, loteId: lote.id, quantidade: qtd, saldoLoteApos: Math.max(0, novoSaldo),
    documento: m.documento ?? null, ordemId: m.ordemId ?? null, usuario: q.nome, motivo: m.motivo ?? null,
  };
  const hashAnterior = ultimo?.hash ?? null;
  return tx.tfMovimento.create({ data: { ...base, usuarioId: q.id, hashAnterior, hash: sha(hashAnterior, camposMov(base)) } });
}

/** Lotes que podem ser consumidos, na ordem FEFO (vence primeiro; sem validade por último; mais antigo primeiro). */
export async function lotesDisponiveis(db: Db, materialId: string) {
  const lotes = await db.tfLote.findMany({ where: { materialId, status: 'Liberado', saldo: { gt: 0 } } });
  return lotes.sort((a, b) => (a.validade?.getTime() ?? 9e15) - (b.validade?.getTime() ?? 9e15) || a.createdAt.getTime() - b.createdAt.getTime());
}

/** Divide uma quantidade pelos lotes em FEFO (ou usa o lote escolhido). Lança erro se faltar. */
export async function planejarConsumo(db: Db, materialId: string, quantidade: number, loteId?: string | null) {
  const material = await db.tfMaterial.findUnique({ where: { id: materialId } });
  if (!material) throw new Error('Material não encontrado.');
  let lotes = await lotesDisponiveis(db, materialId);
  if (loteId) {
    const escolhido = lotes.find(l => l.id === loteId);
    if (!escolhido) throw new Error(`O lote escolhido de ${material.nome} não está liberado ou não tem saldo.`);
    lotes = [escolhido, ...lotes.filter(l => l.id !== loteId)];
  }
  let falta = r3(quantidade);
  const partes: { loteId: string; codigo: string; quantidade: number }[] = [];
  for (const l of lotes) {
    if (falta <= 0) break;
    const q = r3(Math.min(l.saldo, falta));
    if (q <= 0) continue;
    partes.push({ loteId: l.id, codigo: l.codigo, quantidade: q });
    falta = r3(falta - q);
  }
  const disponivel = r3(lotes.reduce((a, l) => a + l.saldo, 0));
  return { material, partes, falta: Math.max(0, falta), disponivel };
}

// ------------------------------------------------------------ códigos
const ano = () => new Date().getFullYear().toString().slice(-2);
function proximo(codigos: (string | null)[], prefixo: string, a: string) {
  let maior = 0;
  for (const c of codigos) {
    if (!c || !c.startsWith(prefixo) || !c.endsWith(a)) continue;
    const n = parseInt(c.slice(prefixo.length, c.length - a.length), 10);
    if (!isNaN(n) && n > maior) maior = n;
  }
  return `${prefixo}${String(maior + 1).padStart(4, '0')}${a}`;
}
export async function codigoOT(db: Db) {
  const a = ano();
  const r = await db.tfOrdem.findMany({ where: { codigo: { startsWith: 'OT', endsWith: a } }, select: { codigo: true } });
  return proximo(r.map(x => x.codigo), 'OT', a);
}
/** Requisição do registro de transformação (RQ000126), sequencial por ano. */
export async function codigoRQ(db: Db) {
  const a = ano();
  const r = await db.tfRequisicao.findMany({ where: { codigo: { startsWith: 'RQ', endsWith: a } }, select: { codigo: true } });
  return proximo(r.map(x => x.codigo), 'RQ', a);
}
/** Lote gerado pela transformação (TF000126) ou de entrada (EN000126), sequencial por ano. */
export async function codigoLote(db: Db, prefixo: 'TF' | 'EN') {
  const a = ano();
  const r = await db.tfLote.findMany({ where: { codigo: { startsWith: prefixo, endsWith: a } }, select: { codigo: true } });
  return proximo(r.map(x => x.codigo), prefixo, a);
}

// ------------------------------------------------------------ verificação da cadeia
export async function verificarIntegridade(db: Db = prisma) {
  const resultado = { movimentos: { total: 0, ok: true, quebraEm: null as number | null }, eventos: { total: 0, ok: true, quebraEm: null as number | null }, saldos: { ok: true, divergentes: [] as { lote: string; material: string; saldo: number; razao: number }[] } };
  let anterior: string | null = null;
  const movs = await db.tfMovimento.findMany({ orderBy: { seq: 'asc' } });
  resultado.movimentos.total = movs.length;
  const somaPorLote = new Map<string, number>();
  for (const m of movs) {
    if (m.loteId) somaPorLote.set(m.loteId, r3((somaPorLote.get(m.loteId) || 0) + m.quantidade));
    if (!resultado.movimentos.ok) continue;
    const esperado = sha(anterior, camposMov(m));
    if (m.hashAnterior !== anterior || m.hash !== esperado) { resultado.movimentos.ok = false; resultado.movimentos.quebraEm = m.seq; continue; }
    anterior = m.hash;
  }
  anterior = null;
  const evts = await db.tfEvento.findMany({ orderBy: { seq: 'asc' } });
  resultado.eventos.total = evts.length;
  for (const e of evts) {
    const esperado = sha(anterior, camposEvt(e));
    if (e.hashAnterior !== anterior || e.hash !== esperado) { resultado.eventos.ok = false; resultado.eventos.quebraEm = e.seq; break; }
    anterior = e.hash;
  }
  // o saldo de cada lote tem que bater com a soma do razão
  const lotes = await db.tfLote.findMany({ include: { material: { select: { nome: true } } } });
  for (const l of lotes) {
    const razao = somaPorLote.get(l.id) || 0;
    if (Math.abs(r3(razao) - r3(l.saldo)) > 0.001) { resultado.saldos.ok = false; resultado.saldos.divergentes.push({ lote: l.codigo, material: l.material.nome, saldo: l.saldo, razao }); }
  }
  return { ...resultado, integro: resultado.movimentos.ok && resultado.eventos.ok && resultado.saldos.ok, verificadoEm: new Date() };
}

// ------------------------------------------------------------ migração do módulo antigo (idempotente)
export async function migrarTransformacaoAntiga() {
  const antigos = await prisma.transformacaoItem.findMany();
  const pendentes: typeof antigos = [];
  for (const a of antigos) if (!(await prisma.tfMaterial.findUnique({ where: { legadoId: a.id } }))) pendentes.push(a);
  if (!pendentes.length) return 0;
  const sistema: Quem = { id: null, nome: 'Migração automática', admin: true };
  await prisma.$transaction(async tx => {
    await travar(tx);
    for (const a of pendentes) {
      let codigo = a.sku.trim().toUpperCase();
      if (await tx.tfMaterial.findUnique({ where: { codigo } })) codigo = `${codigo}-ANT`;
      const material = await tx.tfMaterial.create({ data: { codigo, nome: a.nome, tipo: a.tipo === 'INSUMO' ? 'MATERIA_PRIMA' : 'PRODUTO', unidade: 'UN', legadoId: a.id } });
      await evento(tx, { entidade: 'Material', entidadeId: material.id, acao: 'Migração', resumo: `Material [${codigo}] ${a.nome} trazido do módulo antigo com saldo ${a.quantidade}.` }, sistema);
      if (a.quantidade > 0) {
        const lote = await tx.tfLote.create({ data: { materialId: material.id, codigo: (a.lote || 'MIGRADO').toUpperCase(), origem: 'Migração', saldo: 0 } });
        await movimentar(tx, { tipo: 'ENTRADA', materialId: material.id, loteId: lote.id, quantidade: a.quantidade, documento: 'MIGRAÇÃO', motivo: 'Saldo migrado do módulo antigo de transformação' }, sistema);
      }
    }
  }, { timeout: 60000 });
  return pendentes.length;
}
