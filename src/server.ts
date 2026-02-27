import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import fornecedorRoutes from './routes/fornecedor.routes';
import nodemailer from 'nodemailer';

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURAÇÃO DO ROBÔ CARTEIRO
// ==========================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'seu-email@gmail.com',
    pass: process.env.EMAIL_PASS || 'sua-senha-de-app'
  }
});

// ==========================================
// FUNÇÕES GERADORAS DE CÓDIGOS SEQUENCIAIS
// ==========================================
async function gerarCodigoRequisicao(tipo: 'RE' | 'RS'): Promise<string> {
  const anoAtual = new Date().getFullYear().toString().slice(-2);
  const ultimaMovimentacao = await prisma.movimentacao.findFirst({
    where: { codigo: { startsWith: tipo, endsWith: anoAtual } },
    orderBy: { dataHora: 'desc' }
  });

  let sequencia = 1;
  if (ultimaMovimentacao && ultimaMovimentacao.codigo) {
    const numeroExtraido = ultimaMovimentacao.codigo.slice(2, -2);
    const numeroAtual = parseInt(numeroExtraido, 10);
    if (!isNaN(numeroAtual)) sequencia = numeroAtual + 1;
  }
  const numeroFormatado = String(sequencia).padStart(4, '0');
  return `${tipo}${numeroFormatado}${anoAtual}`;
}

async function gerarCodigoPedidoCompra(): Promise<string> {
  const anoAtual = new Date().getFullYear().toString().slice(-2);
  const ultimoPedido = await prisma.pedidoCompra.findFirst({
    where: { codigo: { startsWith: 'PC', endsWith: anoAtual } },
    orderBy: { createdAt: 'desc' }
  });

  let sequencia = 1;
  if (ultimoPedido && ultimoPedido.codigo) {
    const numeroExtraido = ultimoPedido.codigo.slice(2, -2);
    const numeroAtual = parseInt(numeroExtraido, 10);
    if (!isNaN(numeroAtual)) sequencia = numeroAtual + 1;
  }
  const numeroFormatado = String(sequencia).padStart(4, '0');
  return `PC${numeroFormatado}${anoAtual}`;
}

// ==========================================
// MÓDULO DE FORNECEDORES
// ==========================================
app.use('/fornecedores', fornecedorRoutes);

// ==========================================
// ROTA DE AUTENTICAÇÃO
// ==========================================
app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const usuario = await prisma.usuario.findUnique({ where: { email } });
    if (!usuario || usuario.senha !== senha) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    return res.json({ id: usuario.id, nome: usuario.nome, cargo: usuario.cargo, email: usuario.email });
  } catch (error) { return res.status(500).json({ error: 'Erro interno no login.' }); }
});

// ==========================================
// ROTAS DE CONSULTA (GET)
// ==========================================
app.get('/categorias', async (req, res) => {
  try { return res.json(await prisma.categoria.findMany()); } 
  catch (error) { return res.status(500).json({ error: 'Erro ao buscar categorias' }); }
});

app.get('/localizacoes', async (req, res) => {
  try { return res.json(await prisma.localizacao.findMany()); } 
  catch (error) { return res.status(500).json({ error: 'Erro ao buscar localizacoes' }); }
});

app.get('/usuarios', async (req, res) => {
  try { return res.json(await prisma.usuario.findMany()); } 
  catch (error) { return res.status(500).json({ error: 'Erro ao buscar usuários' }); }
});

app.get('/produtos', async (req, res) => {
  try {
    const produtos = await prisma.produto.findMany({ include: { categoria: true, fornecedor: true } });
    return res.json(produtos);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar produtos' }); }
});

app.get('/estoque', async (req, res) => {
  try {
    const inventario = await prisma.estoque.findMany({ include: { produto: true, localizacao: true, responsavel: true } });
    return res.json(inventario);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar inventário' }); }
});

app.get('/movimentacoes', async (req, res) => {
  try {
    const historico = await prisma.movimentacao.findMany({ include: { produto: true, usuario: true }, orderBy: { dataHora: 'desc' } });
    return res.json(historico);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar histórico' }); }
});

// ==========================================
// ROTA DA CAIXA PRETA (AUDITORIA DE EXCLUSÕES)
// ==========================================
app.get('/logs-auditoria', async (req, res) => {
  try {
    const logs = await prisma.logAuditoria.findMany({ 
      orderBy: { dataHora: 'desc' } 
    });
    return res.json(logs);
  } catch (error) { 
    return res.status(500).json({ error: 'Erro ao buscar histórico de exclusões.' }); 
  }
});

// ==========================================
// ROTAS DE CADASTRO (POST) E EDIÇÃO (PUT) DE PRODUTOS
// ==========================================
app.post('/produtos', async (req, res) => {
  try {
    const { sku, nome, descricao, codigoBarras, categoriaId, tipo, precoCusto, precoVenda, lote, enderecoLocalizacao, fornecedorId } = req.body;
    const novoProduto = await prisma.produto.create({ 
      data: { 
        sku, nome, descricao: descricao || null, codigoBarras: codigoBarras || null, categoriaId, tipo: tipo || 'ACABADO', 
        precoCusto: precoCusto || 0, precoVenda: precoVenda || 0,
        lote: lote || null, enderecoLocalizacao: enderecoLocalizacao || null, fornecedorId: fornecedorId || null
      } 
    });
    return res.status(201).json(novoProduto);
  } catch (error: any) { return res.status(500).json({ error: 'Erro do Banco: ' + (error.message || 'Desconhecido') }); }
});

app.put('/produtos/:id', async (req, res) => {
  try {
    const { sku, nome, tipo, categoriaId, descricao, codigoBarras, precoCusto, precoVenda, lote, enderecoLocalizacao, fornecedorId } = req.body;
    const atualizado = await prisma.produto.update({
      where: { id: req.params.id },
      data: { 
        sku, 
        nome, 
        tipo, 
        categoriaId, 
        descricao: descricao || null, 
        codigoBarras: codigoBarras || null, 
        precoCusto: precoCusto || 0, 
        precoVenda: precoVenda || 0,
        lote: lote || null, 
        enderecoLocalizacao: enderecoLocalizacao || null, 
        fornecedorId: fornecedorId || null
      }
    });
    return res.json(atualizado);
  } catch (error) { 
    console.error("Erro ao atualizar produto:", error);
    return res.status(500).json({ error: 'Erro ao atualizar produto' }); 
  }
});

// ==========================================
// EXCLUSÃO EM CASCATA COM AUDITORIA
// ==========================================
app.delete('/produtos/:id', async (req, res) => {
  try {
    const produtoId = req.params.id;
    const { motivo, usuarioId } = req.body;

    if (!motivo || !usuarioId) {
      return res.status(400).json({ error: 'Motivo e identificação do utilizador são obrigatórios para exclusão.' });
    }

    const produto = await prisma.produto.findUnique({ where: { id: produtoId } });
    const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
    
    if (!produto) return res.status(404).json({ error: 'Produto não encontrado.' });
    const nomeResponsavel = usuario ? usuario.nome : 'Sistema / Desconhecido';

    // A Mágica da Cascata Segura
    await prisma.$transaction([
      prisma.logAuditoria.create({
        data: {
          acao: 'EXCLUSÃO DE PRODUTO',
          itemNome: `[${produto.sku}] ${produto.nome}`,
          usuarioNome: nomeResponsavel,
          motivo: motivo
        }
      }),
      prisma.pedidoCompra.deleteMany({ where: { produtoId } }),
      prisma.movimentacao.deleteMany({ where: { produtoId } }),
      prisma.estoque.deleteMany({ where: { produtoId } }),
      prisma.produto.delete({ where: { id: produtoId } })
    ]);

    return res.status(204).send();
  } catch (error) {
    console.error("Erro na exclusão em cascata:", error);
    return res.status(500).json({ error: 'Erro interno ao processar a exclusão auditável.' });
  }
});

// Outras rotas básicas (Categorias, Usuarios, Locais, Estoque)...
app.post('/categorias', async (req, res) => {
  try { const nova = await prisma.categoria.create({ data: req.body }); return res.status(201).json(nova); } 
  catch (error) { return res.status(500).json({ error: 'Erro ao criar' }); }
});
app.post('/usuarios', async (req, res) => {
  try { const novoUsuario = await prisma.usuario.create({ data: req.body }); return res.status(201).json(novoUsuario); } 
  catch (error) { return res.status(500).json({ error: 'Erro ao criar usuário' }); }
});
app.put('/usuarios/:id', async (req, res) => {
  try { const atualizado = await prisma.usuario.update({ where: { id: req.params.id }, data: req.body }); return res.json(atualizado); } 
  catch (error) { return res.status(500).json({ error: 'Erro ao atualizar usuário' }); }
});
app.delete('/usuarios/:id', async (req, res) => {
  try { await prisma.usuario.delete({ where: { id: req.params.id } }); return res.status(204).send(); } 
  catch (error) { return res.status(400).json({ error: 'Não é possível excluir usuário com histórico.' }); }
});
app.post('/estoque', async (req, res) => {
  try { const novoEstoque = await prisma.estoque.create({ data: req.body }); return res.status(201).json(novoEstoque); } 
  catch (error) { return res.status(500).json({ error: 'Erro ao criar estoque' }); }
});

// ==========================================
// MÓDULO SUPPLY CHAIN: PEDIDOS DE COMPRA
// ==========================================
app.get('/pedidos-compra', async (req, res) => {
  try { return res.json(await prisma.pedidoCompra.findMany({ include: { fornecedor: true, produto: true }, orderBy: { createdAt: 'desc' } })); } 
  catch (error) { return res.status(500).json({ error: 'Erro ao buscar pedidos.' }); }
});

app.post('/pedidos-compra', async (req, res) => {
  try {
    const { fornecedorId, produtoId, quantidade, custoTotal, dataPrevisao } = req.body;
    const codigoGerado = await gerarCodigoPedidoCompra();
    const novoPedido = await prisma.pedidoCompra.create({
      data: { codigo: codigoGerado, fornecedorId, produtoId, quantidade: Number(quantidade), custoTotal: Number(custoTotal), dataPrevisao: dataPrevisao ? new Date(dataPrevisao) : null, status: 'Pendente' },
      include: { fornecedor: true, produto: true }
    });

    try {
      const emailFornecedor = novoPedido.fornecedor?.email || '';
      const destinatarios = [emailFornecedor, 'gerencia.producao@viapro.com', 'pcp@viapro.com', 'supplychain@viapro.com'].filter(Boolean).join(', ');
      transporter.sendMail({
        from: process.env.EMAIL_USER || 'viapro@seu-dominio.com', to: destinatarios, subject: `[ViaPro ERP] Novo Pedido de Compra: ${codigoGerado}`,
        text: `Olá, ${novoPedido.fornecedor?.nomeEmpresa}!\n\nUm novo Pedido de Compra foi gerado.\n\n📄 Código: ${codigoGerado}\n📦 Produto: ${novoPedido.produto?.nome}\n🔢 Quantidade: ${quantidade} un\n\nAtenciosamente,\nEquipe ViaPro`
      }).catch(console.error);
    } catch (e) {}

    return res.status(201).json(novoPedido);
  } catch (error) { return res.status(500).json({ error: 'Erro ao emitir pedido.' }); }
});

app.put('/pedidos-compra/:id/receber', async (req, res) => {
  try {
    const { usuarioId } = req.body; 
    const resultado = await prisma.$transaction(async (tx) => {
      const pedido = await tx.pedidoCompra.update({ where: { id: req.params.id }, data: { status: 'Recebido' } });
      const estoqueExistente = await tx.estoque.findFirst({ where: { produtoId: pedido.produtoId, status: 'Disponível' } });
      if (estoqueExistente) await tx.estoque.update({ where: { id: estoqueExistente.id }, data: { quantidade: estoqueExistente.quantidade + pedido.quantidade } });
      else await tx.estoque.create({ data: { produtoId: pedido.produtoId, quantidade: pedido.quantidade, status: 'Disponível' } });
      
      await tx.movimentacao.create({ data: { produtoId: pedido.produtoId, usuarioId, quantidade: pedido.quantidade, tipoAcao: 'Entrada de mercadoria', observacao: `Recebimento via Pedido ${pedido.codigo || ''}` } });
      return pedido;
    });
    return res.json(resultado);
  } catch (error) { return res.status(500).json({ error: 'Erro ao receber a mercadoria.' }); }
});

// ==========================================
// A NOVA SUPER ROTA INTELIGENTE DE MOVIMENTAÇÃO
// ==========================================
app.post('/movimentacoes/operacao', async (req, res) => {
  try {
    const { produtoId, usuarioId, estoqueId, quantidade, tipoAcao, observacao } = req.body;
    const qtdNum = Number(quantidade);

    const resultado = await prisma.$transaction(async (tx) => {
      const estoque = await tx.estoque.findUnique({ where: { id: estoqueId } });
      if (!estoque) throw new Error("Estoque não encontrado.");

      let novoSaldo = estoque.quantidade;
      let codigoGerado = null;

      if (['Entrada de mercadoria', 'Devolução VIAPRO', 'Ajuste de Entrada de Inventário'].includes(tipoAcao)) {
        novoSaldo += qtdNum;
        codigoGerado = await gerarCodigoRequisicao('RE');
      } 
      else if (['Saída de mercadoria', 'Ajuste de Saída de Inventário', 'Saída para demonstração'].includes(tipoAcao)) {
        if (estoque.quantidade < qtdNum) throw new Error("Saldo insuficiente no armazém para esta saída.");
        novoSaldo -= qtdNum;
        codigoGerado = await gerarCodigoRequisicao('RS');
      } else {
        throw new Error("Tipo de ação não reconhecido pelo sistema.");
      }

      await tx.estoque.update({
        where: { id: estoqueId },
        data: { quantidade: novoSaldo }
      });

      if (tipoAcao === 'Saída para demonstração') {
        await tx.estoque.create({
          data: { produtoId, quantidade: qtdNum, status: 'Em Demonstração', responsavelId: usuarioId }
        });
      }

      return await tx.movimentacao.create({
        data: {
          produtoId,
          usuarioId,
          quantidade: qtdNum,
          tipoAcao,
          codigo: codigoGerado,
          observacao: observacao || `${tipoAcao} registrada.`
        }
      });
    });

    return res.status(201).json(resultado);
  } catch (error: any) { 
    return res.status(400).json({ error: error.message || 'Erro ao registrar movimentação.' }); 
  }
});

const porta = process.env.PORT || 3333;
app.listen(porta, () => console.log(`🚀 Servidor ViaPro rodando na porta ${porta}`));