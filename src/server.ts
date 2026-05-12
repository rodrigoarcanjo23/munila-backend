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

app.use('/fornecedores', fornecedorRoutes);

app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const usuario = await prisma.usuario.findUnique({ where: { email } });
    if (!usuario || usuario.senha !== senha) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    return res.json({ id: usuario.id, nome: usuario.nome, cargo: usuario.cargo, email: usuario.email });
  } catch (error) { return res.status(500).json({ error: 'Erro interno no login.' }); }
});

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

// ✨ ATUALIZADO: Agora busca as receitas junto com os produtos ✨
app.get('/produtos', async (req, res) => {
  try {
    const produtos = await prisma.produto.findMany({ 
      include: { 
        categoria: true, 
        fornecedor: true,
        ingredientes: { include: { produtoFilho: true } } // Traz a receita (Composicao)
      } 
    });
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

app.get('/logs-auditoria', async (req, res) => {
  try {
    const logs = await prisma.logAuditoria.findMany({ orderBy: { dataHora: 'desc' } });
    return res.json(logs);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar histórico de exclusões.' }); }
});

app.get('/dashboard/resumo', async (req, res) => {
  try {
    const totalProdutos = await prisma.produto.count();
    const estoques = await prisma.estoque.findMany({ include: { produto: true } });

    const custoTotalImobilizado = estoques.reduce((acumulador, item) => {
      const precoCusto = item.produto?.precoCusto || 0;
      return acumulador + (item.quantidade * precoCusto);
    }, 0);

    const totaisRuptura = await prisma.estoque.aggregate({
      where: { status: 'Ruptura' },
      _sum: { quantidade: true }
    });

    return res.json({
      totalItensCadastrados: totalProdutos,
      custoTotal: custoTotalImobilizado,
      totalRupturas: totaisRuptura._sum.quantidade || 0
    });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao buscar métricas do dashboard.' });
  }
});

// ✨ ATUALIZADO: Agora salva a receita (ingredientes) no momento do cadastro ✨
app.post('/produtos', async (req, res) => {
  try {
    const { sku, nome, descricao, codigoBarras, categoriaId, tipo, precoCusto, precoVenda, lote, enderecoLocalizacao, fornecedorId, dataCadastro, ingredientes } = req.body;
    
    const skuExistente = await prisma.produto.findUnique({ where: { sku } });
    if (skuExistente) return res.status(400).json({ error: `O SKU '${sku}' já está cadastrado no sistema.` });

    if (codigoBarras) {
      const cbExistente = await prisma.produto.findUnique({ where: { codigoBarras } });
      if (cbExistente) return res.status(400).json({ error: `O Código de Barras '${codigoBarras}' já está sendo utilizado.` });
    }

    const novoProduto = await prisma.produto.create({ 
      data: { 
        sku, nome, descricao: descricao || null, codigoBarras: codigoBarras || null, categoriaId, tipo: tipo || 'ACABADO', 
        precoCusto: precoCusto || 0, precoVenda: precoVenda || 0,
        lote: lote || null, enderecoLocalizacao: enderecoLocalizacao || null, fornecedorId: fornecedorId || null,
        dataCadastro: dataCadastro ? new Date(dataCadastro) : new Date(),
        // Grava a receita se existir
        ingredientes: ingredientes && ingredientes.length > 0 ? {
          create: ingredientes.map((ing: any) => ({
            produtoFilhoId: ing.produtoFilhoId,
            quantidade: ing.quantidade
          }))
        } : undefined
      } 
    });
    return res.status(201).json(novoProduto);
  } catch (error: any) { return res.status(500).json({ error: 'Erro do Banco: ' + (error.message || 'Desconhecido') }); }
});

app.put('/produtos/:id', async (req, res) => {
  try {
    const { sku, nome, tipo, categoriaId, descricao, codigoBarras, precoCusto, precoVenda, lote, enderecoLocalizacao, fornecedorId, dataCadastro } = req.body;
    
    const skuExistente = await prisma.produto.findUnique({ where: { sku } });
    if (skuExistente && skuExistente.id !== req.params.id) return res.status(400).json({ error: `O SKU '${sku}' pertence a outro produto.` });

    if (codigoBarras) {
      const cbExistente = await prisma.produto.findUnique({ where: { codigoBarras } });
      if (cbExistente && cbExistente.id !== req.params.id) return res.status(400).json({ error: `O Código de Barras '${codigoBarras}' pertence a outro produto.` });
    }

    const atualizado = await prisma.produto.update({
      where: { id: req.params.id },
      data: { 
        sku, nome, tipo, categoriaId, descricao: descricao || null, codigoBarras: codigoBarras || null, 
        precoCusto: precoCusto || 0, precoVenda: precoVenda || 0,
        lote: lote || null, enderecoLocalizacao: enderecoLocalizacao || null, fornecedorId: fornecedorId || null,
        dataCadastro: dataCadastro ? new Date(dataCadastro) : undefined
      }
    });
    return res.json(atualizado);
  } catch (error) { return res.status(500).json({ error: 'Erro ao atualizar produto' }); }
});

// ✨ ATUALIZADO: Limpa a tabela de Composição antes de excluir o produto ✨
app.delete('/produtos/:id', async (req, res) => {
  try {
    const produtoId = req.params.id;
    const { motivo, usuarioId } = req.body;

    if (!motivo || !usuarioId) return res.status(400).json({ error: 'Motivo e identificação do utilizador são obrigatórios para exclusão.' });

    const produto = await prisma.produto.findUnique({ where: { id: produtoId } });
    const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
    
    if (!produto) return res.status(404).json({ error: 'Produto não encontrado.' });
    const nomeResponsavel = usuario ? usuario.nome : 'Sistema / Desconhecido';

    await prisma.$transaction([
      prisma.logAuditoria.create({
        data: { acao: 'EXCLUSÃO DE PRODUTO', itemNome: `[${produto.sku}] ${produto.nome}`, usuarioNome: nomeResponsavel, motivo: motivo }
      }),
      // Remove dependências da receita
      prisma.composicao.deleteMany({ where: { produtoPaiId: produtoId } }),
      prisma.composicao.deleteMany({ where: { produtoFilhoId: produtoId } }),
      prisma.pedidoCompra.deleteMany({ where: { produtoId } }),
      prisma.movimentacao.deleteMany({ where: { produtoId } }),
      prisma.estoque.deleteMany({ where: { produtoId } }),
      prisma.produto.delete({ where: { id: produtoId } })
    ]);

    return res.status(204).send();
  } catch (error) { return res.status(500).json({ error: 'Erro interno ao processar a exclusão auditável.' }); }
});

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
    return res.status(201).json(novoPedido);
  } catch (error) { return res.status(500).json({ error: 'Erro ao emitir pedido.' }); }
});

app.put('/pedidos-compra/:id', async (req, res) => {
  try {
    const { fornecedorId, produtoId, quantidade, custoTotal, dataPrevisao } = req.body;
    const pedido = await prisma.pedidoCompra.findUnique({ where: { id: req.params.id } });
    if (pedido?.status === 'Recebido') return res.status(400).json({ error: 'Não é possível editar um pedido que já foi recebido no estoque.' });

    const atualizado = await prisma.pedidoCompra.update({
      where: { id: req.params.id },
      data: { fornecedorId, produtoId, quantidade: Number(quantidade), custoTotal: Number(custoTotal), dataPrevisao: dataPrevisao ? new Date(dataPrevisao) : null }
    });
    return res.json(atualizado);
  } catch (error) { return res.status(500).json({ error: 'Erro ao atualizar pedido.' }); }
});

app.delete('/pedidos-compra/:id', async (req, res) => {
  try {
    const pedido = await prisma.pedidoCompra.findUnique({ where: { id: req.params.id } });
    if (pedido?.status === 'Recebido') return res.status(400).json({ error: 'Não é possível excluir um pedido que já foi recebido no estoque. Faça uma devolução.' });

    await prisma.pedidoCompra.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (error) { return res.status(500).json({ error: 'Erro ao excluir pedido.' }); }
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
        
        if (tipoAcao === 'Saída para demonstração') {
          await tx.estoque.create({ data: { produtoId, quantidade: qtdNum, status: 'Em Demonstração', responsavelId: usuarioId } });
        }
      } 
      else if (tipoAcao === 'Perdas/Avarias') {
        if (estoque.quantidade < qtdNum) throw new Error("Não é possível registrar perda maior que o saldo disponível.");
        novoSaldo -= qtdNum;
        codigoGerado = await gerarCodigoRequisicao('RS');

        const estoqueRuptura = await tx.estoque.findFirst({ where: { produtoId, status: 'Ruptura' } });
        if (estoqueRuptura) {
          await tx.estoque.update({ where: { id: estoqueRuptura.id }, data: { quantidade: estoqueRuptura.quantidade + qtdNum } });
        } else {
          await tx.estoque.create({ data: { produtoId, quantidade: qtdNum, status: 'Ruptura' } });
        }
      }
      else {
        throw new Error("Tipo de ação não reconhecido pelo sistema.");
      }

      await tx.estoque.update({
        where: { id: estoqueId },
        data: { quantidade: novoSaldo }
      });

      return await tx.movimentacao.create({
        data: {
          produtoId, usuarioId, quantidade: qtdNum, tipoAcao, codigo: codigoGerado,
          observacao: observacao || `${tipoAcao} registrada.`
        }
      });
    });

    return res.status(201).json(resultado);
  } catch (error: any) { 
    return res.status(400).json({ error: error.message || 'Erro ao registrar movimentação.' }); 
  }
});

// ✨ NOVA ROTA MESTRE: ORDEM DE PRODUÇÃO ✨
app.post('/producao/executar', async (req, res) => {
  const { produtoFinalId, quantidadeProduzir, usuarioId } = req.body;

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Procura a receita do produto
      const composicao = await tx.composicao.findMany({
        where: { produtoPaiId: produtoFinalId },
        include: { produtoFilho: true }
      });

      if (composicao.length === 0) {
        throw new Error("Este produto não possui uma receita de produção configurada.");
      }

      // 2. Valida se tem estoque suficiente de cada componente
      for (const item of composicao) {
        const qtdNecessaria = item.quantidade * quantidadeProduzir;
        const estoqueItem = await tx.estoque.findFirst({
          where: { produtoId: item.produtoFilhoId, status: 'Disponível' }
        });

        if (!estoqueItem || estoqueItem.quantidade < qtdNecessaria) {
          throw new Error(`Estoque insuficiente de [${item.produtoFilho.sku}]. Necessário: ${qtdNecessaria}, Disponível: ${estoqueItem?.quantidade || 0}`);
        }

        // 3. Dá baixa nos componentes
        await tx.estoque.update({
          where: { id: estoqueItem.id },
          data: { quantidade: { decrement: qtdNecessaria } }
        });

        // 4. Registra a saída da matéria-prima
        await tx.movimentacao.create({
          data: {
            produtoId: item.produtoFilhoId,
            usuarioId,
            quantidade: qtdNecessaria,
            tipoAcao: 'Saída para produção',
            observacao: `Matéria-prima consumida para lote de produção`
          }
        });
      }

      // 5. Dá entrada no produto final (Nacional/Montado)
      const estoqueFinal = await tx.estoque.findFirst({
        where: { produtoId: produtoFinalId, status: 'Disponível' }
      });

      if (estoqueFinal) {
        await tx.estoque.update({
          where: { id: estoqueFinal.id },
          data: { quantidade: { increment: quantidadeProduzir } }
        });
      } else {
        await tx.estoque.create({
          data: { produtoId: produtoFinalId, quantidade: quantidadeProduzir, status: 'Disponível' }
        });
      }

      // 6. Registra a entrada do produto final
      const codigoGerado = await gerarCodigoRequisicao('RE');
      await tx.movimentacao.create({
        data: {
          produtoId: produtoFinalId,
          usuarioId,
          quantidade: quantidadeProduzir,
          tipoAcao: 'Entrada por produção',
          codigo: codigoGerado,
          observacao: `Lote de produção finalizado internamente.`
        }
      });

      return { success: true, mensagem: `Produção de ${quantidadeProduzir} unidades finalizada com sucesso.` };
    });

    res.json(resultado);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

const porta = process.env.PORT || 3333;
app.listen(porta, () => console.log(`🚀 Servidor ViaPro rodando na porta ${porta}`));