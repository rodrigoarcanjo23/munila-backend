import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { somenteAdmin } from '../lib/auth';
import { somenteDigitos } from '../lib/financeiro';

/**
 * ✨ FASE 2: DADOS DA EMPRESA E PREPARAÇÃO FISCAL
 * A emissão de NF-e será feita por um provedor (ex.: Focus NFe) — aqui ficam os dados que ele exige
 * e um checklist do que falta no cadastro para emitir notas.
 */
const router = Router();
const CAMPOS = ['razaoSocial', 'nomeFantasia', 'cnpj', 'inscricaoEstadual', 'regimeTributario', 'cep', 'logradouro', 'numero', 'bairro', 'cidade', 'uf', 'telefone', 'email', 'emissorNFe', 'ambienteNFe'] as const;

router.get('/empresa', async (_req, res) => {
  const cfg = await prisma.configuracaoEmpresa.findUnique({ where: { id: 'empresa' } });
  return res.json(cfg ?? { id: 'empresa' });
});

router.put('/empresa', somenteAdmin, async (req, res) => {
  const data = Object.fromEntries(CAMPOS.filter(c => req.body?.[c] !== undefined).map(c => [c, req.body[c] === '' ? null : String(req.body[c]).trim()]));
  if (data.uf) data.uf = data.uf.toUpperCase().slice(0, 2);
  const cfg = await prisma.configuracaoEmpresa.upsert({ where: { id: 'empresa' }, update: data, create: { id: 'empresa', ...data } });
  return res.json(cfg);
});

/** Checklist do que falta para emitir NF-e. */
router.get('/fiscal/pendencias', async (_req, res) => {
  const [cfg, produtos] = await Promise.all([
    prisma.configuracaoEmpresa.findUnique({ where: { id: 'empresa' } }),
    prisma.produto.findMany({ select: { id: true, sku: true, nome: true, ncm: true, origemFiscal: true, codigoBarras: true, cfopPadrao: true } }),
  ]);
  const obrigatorios: [keyof NonNullable<typeof cfg>, string][] = [
    ['razaoSocial', 'Razão social'], ['cnpj', 'CNPJ'], ['inscricaoEstadual', 'Inscrição estadual'], ['regimeTributario', 'Regime tributário'],
    ['cep', 'CEP'], ['logradouro', 'Logradouro'], ['numero', 'Número'], ['bairro', 'Bairro'], ['cidade', 'Cidade'], ['uf', 'UF'],
  ];
  const empresaFaltando = obrigatorios.filter(([k]) => !cfg?.[k]).map(([, n]) => n);
  if (cfg?.cnpj && somenteDigitos(cfg.cnpj).length !== 14) empresaFaltando.push('CNPJ com 14 dígitos');
  const produtosPendentes = produtos
    .map(p => ({
      id: p.id, sku: p.sku, nome: p.nome,
      faltando: [
        !p.ncm || somenteDigitos(p.ncm).length !== 8 ? 'NCM (8 dígitos)' : null,
        p.origemFiscal === null || p.origemFiscal === undefined ? 'Origem' : null,
        !p.cfopPadrao ? 'CFOP padrão' : null,
      ].filter(Boolean),
    }))
    .filter(p => p.faltando.length);
  return res.json({
    empresaFaltando, produtosPendentes, totalProdutos: produtos.length,
    pronto: empresaFaltando.length === 0 && produtosPendentes.length === 0,
    emissor: cfg?.emissorNFe || null,
  });
});

export default router;
