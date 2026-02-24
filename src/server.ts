import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import fornecedorRoutes from './routes/fornecedor.routes'; // Importação do módulo de fornecedores

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// ==========================================
// MÓDULO DE FORNECEDORES
// ==========================================
app.use('/fornecedores', fornecedorRoutes);

// ==========================================
// ROTA DE AUTENTICAÇÃO (LOGIN)
// ==========================================
app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const usuario = await prisma.usuario.findUnique({ where: { email } });
    
    if (!usuario || usuario.senha !== senha) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    
    return res.json({
      id: usuario.id,
      nome: usuario.nome,
      cargo: usuario.cargo,
      email: usuario.email
    });
  } catch (error) { 
    return res.status(500).json({ error: 'Erro interno ao tentar fazer login.' }); 
  }
});

// ==========================================
// ROTAS DE CONSULTA (GET)
// ==========================================
app.get('/categorias', async (req, res) => {
  try {
    const categorias = await prisma.categoria.findMany();
    return res.json(categorias);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar categorias' }); }
});

app.get('/localizacoes', async (req, res) => {
  try {
    const localizacoes = await prisma.localizacao.findMany();
    return res.json(localizacoes);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar localizacoes' }); }
});

app.get('/produtos', async (req, res) => {
  try {
    const produtos = await prisma.produto.findMany({ include: { categoria: true } });
    return res.json(produtos);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar produtos' }); }
});

app.get('/usuarios', async (req, res) => {
  try {
    const usuarios = await prisma.usuario.findMany();
    return res.json(usuarios);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar usuários' }); }
});

app.get('/estoque', async (req, res) => {
  try {
    const inventario = await prisma.estoque.findMany({ 
      include: { produto: true, localizacao: true, responsavel: true } 
    });
    return res.json(inventario);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar inventário' }); }
});

app.get('/movimentacoes', async (req, res) => {
  try {
    const historico = await prisma.movimentacao.findMany({ 
      include: { produto: true, usuario: true }, 
      orderBy: { dataHora: 'desc' } 
    });
    return res.json(historico);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar histórico' }); }
});

// ==========================================
// ROTAS DE CADASTRO (POST)
// ==========================================
app.post('/categorias', async (req, res) => {
  try {
    const { nome, descricao } = req.body;
    const nova = await prisma.categoria.create({ data: { nome, descricao } });
    return res.status(201).json(nova);
  } catch (error) { return res.status(500).json({ error: 'Erro ao criar' }); }
});

app.post('/localizacoes', async (req, res) => {
  try {
    const { codigo, zona, corredor, prateleira } = req.body;
    const nova = await prisma.localizacao.create({ data: { codigo, zona, corredor, prateleira } });
    return res.status(201).json(nova);
  } catch (error) { return res.status(500).json({ error: 'Erro ao criar' }); }
});

app.post('/usuarios', async (req, res) => {
  try {
    const { nome, cargo, email, senha } = req.body;
    const novoUsuario = await prisma.usuario.create({ data: { nome, cargo, email, senha } });
    return res.status(201).json(novoUsuario);
  } catch (error) { return res.status(500).json({ error: 'Erro ao criar usuário' }); }
});

app.post('/produtos', async (req, res) => {
  try {
    const { sku, nome, descricao, codigoBarras, categoriaId, tipo, precoCusto, precoVenda } = req.body;
    const novoProduto = await prisma.produto.create({ 
      data: { 
        sku, 
        nome, 
        descricao: descricao || null, 
        codigoBarras: codigoBarras || null, 
        categoriaId, 
        tipo: tipo || 'ACABADO',
        precoCusto: precoCusto || 0,
        precoVenda: precoVenda || 0
      } 
    });
    return res.status(201).json(novoProduto);
  } catch (error: any) {
    return res.status(500).json({ error: 'Erro do Banco de Dados: ' + (error.message || 'Erro desconhecido') });
  }
});

app.post('/estoque', async (req, res) => {
  try {
    const { produtoId, quantidade, status, localizacaoId } = req.body;
    const novoEstoque = await prisma.estoque.create({ 
      data: { produtoId, quantidade, status, localizacaoId } 
    });
    return res.status(201).json(novoEstoque);
  } catch (error) { return res.status(500).json({ error: 'Erro ao criar estoque' }); }
});

// ==========================================
// ROTAS DE EDIÇÃO E EXCLUSÃO (PUT / DELETE)
// ==========================================
app.put('/usuarios/:id', async (req, res) => {
  try {
    const { nome, cargo, email } = req.body;
    const atualizado = await prisma.usuario.update({
      where: { id: req.params.id },
      data: { nome, cargo, email }
    });
    return res.json(atualizado);
  } catch (error) { return res.status(500).json({ error: 'Erro ao atualizar usuário' }); }
});

app.delete('/usuarios/:id', async (req, res) => {
  try {
    await prisma.usuario.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (error) { 
    return res.status(400).json({ error: 'Não é possível excluir usuário com histórico.' }); 
  }
});

app.put('/produtos/:id', async (req, res) => {
  try {
    const { sku, nome, tipo, categoriaId, descricao, precoCusto, precoVenda } = req.body;
    const atualizado = await prisma.produto.update({
      where: { id: req.params.id },
      data: { 
        sku, 
        nome, 
        tipo, 
        categoriaId, 
        descricao: descricao || null,
        precoCusto: precoCusto || 0,
        precoVenda: precoVenda || 0
      }
    });
    return res.json(atualizado);
  } catch (error) { return res.status(500).json({ error: 'Erro ao atualizar produto' }); }
});

app.delete('/produtos/:id', async (req, res) => {
  try {
    await prisma.estoque.deleteMany({
      where: { produtoId: req.params.id, quantidade: 0 }
    });
    await prisma.produto.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (error) { 
    return res.status(400).json({ error: 'Não é possível excluir um produto com histórico.' }); 
  }
});

// ==========================================
// MÓDULO SUPPLY CHAIN: PEDIDOS DE COMPRA E RECEBIMENTO
// ==========================================
app.get('/pedidos-compra', async (req, res) => {
  try {
    const pedidos = await prisma.pedidoCompra.findMany({
      include: { fornecedor: true, produto: true },
      orderBy: { createdAt: 'desc' }
    });
    return res.json(pedidos);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar pedidos.' }); }
});

app.post('/pedidos-compra', async (req, res) => {
  try {
    const { fornecedorId, produtoId, quantidade, custoTotal, dataPrevisao } = req.body;
    
    const novoPedido = await prisma.pedidoCompra.create({
      data: {
        fornecedorId,
        produtoId,
        quantidade: Number(quantidade),
        custoTotal: Number(custoTotal),
        dataPrevisao: dataPrevisao ? new Date(dataPrevisao) : null,
        status: 'Pendente'
      },
      include: { fornecedor: true, produto: true }
    });
    return res.status(201).json(novoPedido);
  } catch (error) { return res.status(500).json({ error: 'Erro ao emitir pedido de compra.' }); }
});

app.put('/pedidos-compra/:id/receber', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuarioId } = req.body; 

    if (!usuarioId) {
      return res.status(400).json({ error: 'O ID do usuário é obrigatório para registrar a auditoria.' });
    }
    
    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Marca pedido como Recebido
      const pedido = await tx.pedidoCompra.update({
        where: { id },
        data: { status: 'Recebido' }
      });

      // 2. Tenta encontrar o produto no armazém
      const estoqueExistente = await tx.estoque.findFirst({
        where: { produtoId: pedido.produtoId, status: 'Disponível' }
      });

      // 3. Atualiza ou Cria o estoque
      if (estoqueExistente) {
        await tx.estoque.update({
          where: { id: estoqueExistente.id },
          data: { quantidade: estoqueExistente.quantidade + pedido.quantidade }
        });
      } else {
        await tx.estoque.create({
          data: { produtoId: pedido.produtoId, quantidade: pedido.quantidade, status: 'Disponível' }
        });
      }

      // 4. Cria o registro na Auditoria (Histórico)
      await tx.movimentacao.create({
        data: {
          produtoId: pedido.produtoId,
          usuarioId: usuarioId, 
          quantidade: pedido.quantidade,
          tipoAcao: 'Entrada_Compra', 
          observacao: `Mercadoria recebida via Pedido de Compra`
        }
      });

      return pedido;
    });

    return res.json(resultado);
  } catch (error) { return res.status(500).json({ error: 'Erro ao receber a mercadoria no estoque.' }); }
});

// ==========================================
// OPERAÇÕES DE MOVIMENTAÇÃO DO ESTOQUE
// ==========================================
app.post('/movimentacoes/entrada', async (req, res) => {
  try {
    const { produtoId, usuarioId, estoqueDestinoId, quantidade, observacao } = req.body;
    const resultado = await prisma.$transaction(async (tx) => {
      const estoque = await tx.estoque.findUnique({ where: { id: estoqueDestinoId } });
      if (!estoque) throw new Error("Estoque não encontrado");
      
      await tx.estoque.update({ where: { id: estoqueDestinoId }, data: { quantidade: estoque.quantidade + quantidade } });
      return await tx.movimentacao.create({
        data: { produtoId, usuarioId, quantidade, tipoAcao: 'Entrada_Estoque', observacao: observacao || "Entrada Munila/VIAPRO" }
      });
    });
    return res.status(201).json(resultado);
  } catch (error) { return res.status(500).json({ error: 'Erro na entrada' }); }
});

app.post('/movimentacoes/saida-venda', async (req, res) => {
  try {
    const { produtoId, usuarioId, estoqueOrigemId, quantidade, observacao, cliente } = req.body;
    const resultado = await prisma.$transaction(async (tx) => {
      const estoque = await tx.estoque.findUnique({ where: { id: estoqueOrigemId } });
      if (!estoque || estoque.quantidade < quantidade) throw new Error("Saldo insuficiente");
      
      await tx.estoque.update({ where: { id: estoqueOrigemId }, data: { quantidade: estoque.quantidade - quantidade } });
      const obsFinal = cliente ? `Cliente: ${cliente} | ${observacao || ""}` : observacao;
      
      return await tx.movimentacao.create({
        data: { produtoId, usuarioId, quantidade, tipoAcao: 'Saida_Venda', observacao: obsFinal }
      });
    });
    return res.status(201).json(resultado);
  } catch (error) { return res.status(500).json({ error: 'Erro na venda' }); }
});

app.post('/movimentacoes/saida-demonstracao', async (req, res) => {
  try {
    const { produtoId, usuarioId, estoqueOrigemId, quantidade, dataPrevistaRetorno, observacao } = req.body;
    const resultado = await prisma.$transaction(async (tx) => {
      const estoquePrateleira = await tx.estoque.findUnique({ where: { id: estoqueOrigemId } });
      if (!estoquePrateleira || estoquePrateleira.quantidade < quantidade) throw new Error("Saldo insuficiente!");
      
      await tx.estoque.update({ where: { id: estoqueOrigemId }, data: { quantidade: estoquePrateleira.quantidade - quantidade } });
      await tx.estoque.create({ data: { produtoId, quantidade, status: 'Em Demonstração', responsavelId: usuarioId } });
      
      return await tx.movimentacao.create({
        data: { produtoId, usuarioId, quantidade, tipoAcao: 'Saida_Demonstracao', dataPrevistaRetorno: new Date(dataPrevistaRetorno), observacao }
      });
    });
    return res.status(201).json(resultado);
  } catch (error) { return res.status(500).json({ error: 'Erro na demonstração' }); }
});

app.post('/movimentacoes/ajuste', async (req, res) => {
  try {
    const { produtoId, usuarioId, estoqueId, novaQuantidade, observacao } = req.body;
    const resultado = await prisma.$transaction(async (tx) => {
      const estoque = await tx.estoque.findUnique({ where: { id: estoqueId } });
      if (!estoque) throw new Error("Estoque não encontrado");
      
      const diferenca = novaQuantidade - estoque.quantidade;
      await tx.estoque.update({ where: { id: estoqueId }, data: { quantidade: novaQuantidade } });
      
      return await tx.movimentacao.create({
        data: { produtoId, usuarioId, quantidade: diferenca, tipoAcao: 'Ajuste_Estoque', observacao: `Ajuste: ${observacao}` }
      });
    });
    return res.status(201).json(resultado);
  } catch (error) { return res.status(500).json({ error: 'Erro no ajuste' }); }
});

// ==========================================
// CONFIGURAÇÃO DA PORTA
// ==========================================
const porta = process.env.PORT || 3333;
app.listen(porta, () => console.log(`🚀 Servidor Munila rodando na porta ${porta}`));