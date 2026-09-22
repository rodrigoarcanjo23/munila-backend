import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import fornecedorRoutes from './routes/fornecedor.routes';
import nodemailer from 'nodemailer';
import transformacaoRoutes from './routesTransformacao';

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'seu-email@gmail.com',
    pass: process.env.EMAIL_PASS || 'sua-senha-de-app'
  }
});

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
  return `${tipo}${String(sequencia).padStart(4, '0')}${anoAtual}`;
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
  return `PC${String(sequencia).padStart(4, '0')}${anoAtual}`;
}

async function gerarCodigoOS(): Promise<string> {
  const anoAtual = new Date().getFullYear().toString().slice(-2);
  const ultimaOS = await prisma.ordemTransferencia.findFirst({
    where: { codigo: { startsWith: 'OS', endsWith: anoAtual } },
    orderBy: { createdAt: 'desc' }
  });
  let sequencia = 1;
  if (ultimaOS && ultimaOS.codigo) {
    const numeroExtraido = ultimaOS.codigo.slice(2, -2);
    const numeroAtual = parseInt(numeroExtraido, 10);
    if (!isNaN(numeroAtual)) sequencia = numeroAtual + 1;
  }
  return `OS${String(sequencia).padStart(4, '0')}${anoAtual}`;
}

app.use('/fornecedores', fornecedorRoutes);
app.use('/transformacao', transformacaoRoutes);

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

// ✨ NOVA ROTA: REGISTRAR TOKEN DO CELULAR ✨
app.put('/usuarios/:id/push-token', async (req, res) => {
  try {
    const { token } = req.body;
    await prisma.usuario.update({
      where: { id: req.params.id },
      data: { pushToken: token }
    });
    return res.send();
  } catch (error) { return res.status(500).json({ error: 'Erro ao salvar token.' }); }
});

app.get('/produtos', async (req, res) => {
  try {
    const produtos = await prisma.produto.findMany({ 
      include: { categoria: true, fornecedor: true, ingredientes: { include: { produtoFilho: true } } } 
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
      return acumulador + (item.quantidade * (item.produto?.precoCusto || 0));
    }, 0);
    const totaisRuptura = await prisma.estoque.aggregate({ where: { status: 'Ruptura' }, _sum: { quantidade: true } });
    return res.json({ totalItensCadastrados: totalProdutos, custoTotal: custoTotalImobilizado, totalRupturas: totaisRuptura._sum.quantidade || 0 });
  } catch (error) { return res.status(500).json({ error: 'Erro no dashboard.' }); }
});

app.post('/produtos', async (req, res) => {
  try {
    const { sku, nome, descricao, codigoBarras, categoriaId, tipo, precoCusto, precoVenda, lote, enderecoLocalizacao, fornecedorId, dataCadastro, ingredientes } = req.body;
    if (await prisma.produto.findUnique({ where: { sku } })) return res.status(400).json({ error: 'SKU já cadastrado.' });
    if (codigoBarras && await prisma.produto.findUnique({ where: { codigoBarras } })) return res.status(400).json({ error: 'Código de Barras já cadastrado.' });
    const novoProduto = await prisma.produto.create({ 
      data: { 
        sku, nome, descricao: descricao || null, codigoBarras: codigoBarras || null, categoriaId, tipo: tipo || 'ACABADO', 
        precoCusto: precoCusto || 0, precoVenda: precoVenda || 0, lote: lote || null, enderecoLocalizacao: enderecoLocalizacao || null, fornecedorId: fornecedorId || null, dataCadastro: dataCadastro ? new Date(dataCadastro) : new Date(),
        ingredientes: ingredientes && ingredientes.length > 0 ? { create: ingredientes.map((ing: any) => ({ produtoFilhoId: ing.produtoFilhoId, quantidade: ing.quantidade })) } : undefined
      } 
    });
    return res.status(201).json(novoProduto);
  } catch (error: any) { return res.status(500).json({ error: 'Erro do Banco: ' + (error.message || 'Desconhecido') }); }
});

app.put('/produtos/:id', async (req, res) => {
  try {
    const { sku, nome, tipo, categoriaId, descricao, codigoBarras, precoCusto, precoVenda, lote, enderecoLocalizacao, fornecedorId, dataCadastro } = req.body;
    const skuExistente = await prisma.produto.findUnique({ where: { sku } });
    if (skuExistente && skuExistente.id !== req.params.id) return res.status(400).json({ error: 'SKU pertence a outro produto.' });
    const cbExistente = codigoBarras ? await prisma.produto.findUnique({ where: { codigoBarras } }) : null;
    if (cbExistente && cbExistente.id !== req.params.id) return res.status(400).json({ error: 'Código de Barras pertence a outro produto.' });
    
    const atualizado = await prisma.produto.update({
      where: { id: req.params.id },
      data: { sku, nome, tipo, categoriaId, descricao: descricao || null, codigoBarras: codigoBarras || null, precoCusto: precoCusto || 0, precoVenda: precoVenda || 0, lote: lote || null, enderecoLocalizacao: enderecoLocalizacao || null, fornecedorId: fornecedorId || null, dataCadastro: dataCadastro ? new Date(dataCadastro) : undefined }
    });
    return res.json(atualizado);
  } catch (error) { return res.status(500).json({ error: 'Erro ao atualizar produto' }); }
});

app.delete('/produtos/:id', async (req, res) => {
  try {
    const produtoId = req.params.id;
    const { motivo, usuarioId } = req.body;
    if (!motivo || !usuarioId) return res.status(400).json({ error: 'Motivo e usuário obrigatórios.' });
    const produto = await prisma.produto.findUnique({ where: { id: produtoId } });
    const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
    if (!produto) return res.status(404).json({ error: 'Produto não encontrado.' });
    const nomeResponsavel = usuario ? usuario.nome : 'Sistema / Desconhecido';
    await prisma.$transaction([
      prisma.logAuditoria.create({ data: { acao: 'EXCLUSÃO DE PRODUTO', itemNome: `[${produto.sku}] ${produto.nome}`, usuarioNome: nomeResponsavel, motivo: motivo } }),
      prisma.composicao.deleteMany({ where: { produtoPaiId: produtoId } }),
      prisma.composicao.deleteMany({ where: { produtoFilhoId: produtoId } }),
      prisma.pedidoCompra.deleteMany({ where: { produtoId } }),
      prisma.movimentacao.deleteMany({ where: { produtoId } }),
      prisma.estoque.deleteMany({ where: { produtoId } }),
      prisma.produto.delete({ where: { id: produtoId } })
    ]);
    return res.status(204).send();
  } catch (error) { return res.status(500).json({ error: 'Erro ao excluir.' }); }
});

app.post('/categorias', async (req, res) => {
  try { const nova = await prisma.categoria.create({ data: req.body }); return res.status(201).json(nova); } 
  catch (error) { return res.status(500).json({ error: 'Erro ao criar categoria' }); }
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
  catch (error) { return res.status(400).json({ error: 'Usuário possui histórico vinculado.' }); }
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
    if (pedido?.status === 'Recebido') return res.status(400).json({ error: 'Pedido já recebido.' });
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
    if (pedido?.status === 'Recebido') return res.status(400).json({ error: 'Pedido já recebido.' });
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
      } else if (['Saída de mercadoria', 'Ajuste de Saída de Inventário', 'Saída para demonstração'].includes(tipoAcao)) {
        if (estoque.quantidade < qtdNum) throw new Error("Saldo insuficiente no armazém.");
        novoSaldo -= qtdNum;
        codigoGerado = await gerarCodigoRequisicao('RS');
        if (tipoAcao === 'Saída para demonstração') {
          await tx.estoque.create({ data: { produtoId, quantidade: qtdNum, status: 'Em Demonstração', responsavelId: usuarioId } });
        }
      } else if (tipoAcao === 'Perdas/Avarias') {
        if (estoque.quantidade < qtdNum) throw new Error("Saldo insuficiente.");
        novoSaldo -= qtdNum;
        codigoGerado = await gerarCodigoRequisicao('RS');
        const estoqueRuptura = await tx.estoque.findFirst({ where: { produtoId, status: 'Ruptura' } });
        if (estoqueRuptura) {
          await tx.estoque.update({ where: { id: estoqueRuptura.id }, data: { quantidade: estoqueRuptura.quantidade + qtdNum } });
        } else {
          await tx.estoque.create({ data: { produtoId, quantidade: qtdNum, status: 'Ruptura' } });
        }
      } else {
        throw new Error("Tipo de ação não reconhecido.");
      }
      await tx.estoque.update({ where: { id: estoqueId }, data: { quantidade: novoSaldo } });
      return await tx.movimentacao.create({
        data: { produtoId, usuarioId, quantidade: qtdNum, tipoAcao, codigo: codigoGerado, observacao: observacao || `${tipoAcao} registrada.` }
      });
    });
    return res.status(201).json(resultado);
  } catch (error: any) { return res.status(400).json({ error: error.message || 'Erro ao registrar movimentação.' }); }
});

app.post('/producao/executar', async (req, res) => {
  const { produtoFinalId, quantidadeProduzir, usuarioId } = req.body;
  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const composicao = await tx.composicao.findMany({ where: { produtoPaiId: produtoFinalId }, include: { produtoFilho: true } });
      if (composicao.length === 0) throw new Error("Produto sem receita configurada.");
      for (const item of composicao) {
        const qtdNecessaria = item.quantidade * quantidadeProduzir;
        const estoqueItem = await tx.estoque.findFirst({ where: { produtoId: item.produtoFilhoId, status: 'Disponível' } });
        if (!estoqueItem || estoqueItem.quantidade < qtdNecessaria) {
          throw new Error(`Estoque insuficiente de [${item.produtoFilho.sku}].`);
        }
        await tx.estoque.update({ where: { id: estoqueItem.id }, data: { quantidade: { decrement: qtdNecessaria } } });
        await tx.movimentacao.create({ data: { produtoId: item.produtoFilhoId, usuarioId, quantidade: qtdNecessaria, tipoAcao: 'Saída para produção', observacao: `Matéria-prima consumida` } });
      }
      const estoqueFinal = await tx.estoque.findFirst({ where: { produtoId: produtoFinalId, status: 'Disponível' } });
      if (estoqueFinal) {
        await tx.estoque.update({ where: { id: estoqueFinal.id }, data: { quantidade: { increment: quantidadeProduzir } } });
      } else {
        await tx.estoque.create({ data: { produtoId: produtoFinalId, quantidade: quantidadeProduzir, status: 'Disponível' } });
      }
      const codigoGerado = await gerarCodigoRequisicao('RE');
      await tx.movimentacao.create({ data: { produtoId: produtoFinalId, usuarioId, quantidade: quantidadeProduzir, tipoAcao: 'Entrada por produção', codigo: codigoGerado, observacao: `Lote de produção finalizado.` } });
      return { success: true, mensagem: `Produção finalizada com sucesso.` };
    });
    res.json(resultado);
  } catch (error: any) { res.status(400).json({ error: error.message }); }
});

app.get('/wms/ordens', async (req, res) => {
  try {
    const ordens = await prisma.ordemTransferencia.findMany({
      include: { solicitante: { select: { nome: true } }, separador: { select: { nome: true } }, itens: { include: { produto: true } } },
      orderBy: { createdAt: 'desc' }
    });
    return res.json(ordens);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar ordens.' }); }
});

app.post('/wms/ordens', async (req, res) => {
  try {
    const { solicitanteId, itens, tipo, prioridade } = req.body; 
    if (!itens || itens.length === 0) return res.status(400).json({ error: 'Ordem vazia.' });

    const codigoOS = await gerarCodigoOS();

    const novaOrdem = await prisma.ordemTransferencia.create({
      data: {
        codigo: codigoOS, solicitanteId, status: 'Pendente', tipo: tipo || 'SAIDA', prioridade: prioridade || 'Normal', 
        itens: { create: itens.map((item: any) => ({ produtoId: item.produtoId, quantidade: Number(item.quantidade) })) }
      },
      include: { itens: true }
    });

    // ✨ GATILHO DINÂMICO PUSH EXPO ✨
    try {
      const operadores = await prisma.usuario.findMany({ where: { pushToken: { not: null } } });
      const tokensValidos = operadores.map(op => op.pushToken).filter(Boolean) as string[];

      if (tokensValidos.length > 0) {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: tokensValidos, 
            title: '🚨 Nova OS no Armazém!',
            body: `A Ordem ${codigoOS} (${prioridade || 'Normal'}) foi solicitada.`,
            sound: 'default',
            priority: 'high'
          })
        });
      }
    } catch (pushError) {
      console.error("Falha ao disparar a notificação para a Expo:", pushError);
    }

    return res.status(201).json(novaOrdem);
  } catch (error: any) { return res.status(500).json({ error: 'Erro ao gerar Ordem.' }); }
});

app.put('/wms/ordens/:id', async (req, res) => {
  try {
    const { itens, tipo, prioridade } = req.body;
    const ordemId = req.params.id;
    if (!itens || itens.length === 0) return res.status(400).json({ error: 'Ordem vazia.' });
    const ordemAtual = await prisma.ordemTransferencia.findUnique({ where: { id: ordemId } });
    if (!ordemAtual || ordemAtual.status !== 'Pendente') return res.status(400).json({ error: 'Apenas ordens Pendentes podem ser editadas.' });

    const atualizada = await prisma.$transaction(async (tx) => {
      await tx.itemOrdemTransferencia.deleteMany({ where: { ordemId } });
      return await tx.ordemTransferencia.update({
        where: { id: ordemId },
        data: { tipo: tipo || 'SAIDA', prioridade: prioridade || 'Normal', itens: { create: itens.map((item: any) => ({ produtoId: item.produtoId, quantidade: Number(item.quantidade) })) } },
        include: { itens: true }
      });
    });
    return res.json(atualizada);
  } catch (error) { return res.status(500).json({ error: 'Erro ao atualizar OS.' }); }
});

app.delete('/wms/ordens/:id', async (req, res) => {
  try {
    const ordem = await prisma.ordemTransferencia.findUnique({ where: { id: req.params.id } });
    if (!ordem) return res.status(404).json({ error: 'Ordem não encontrada.' });
    if (ordem.status === 'Concluída') return res.status(400).json({ error: 'Não é possível excluir OS concluída.' });
    await prisma.ordemTransferencia.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (error) { return res.status(500).json({ error: 'Erro ao excluir ordem.' }); }
});

app.put('/wms/ordens/:id/status', async (req, res) => {
  try {
    const { status, separadorId } = req.body;
    const ordem = await prisma.ordemTransferencia.update({ where: { id: req.params.id }, data: { status, separadorId: separadorId || undefined } });
    return res.json(ordem);
  } catch (error) { return res.status(500).json({ error: 'Erro ao atualizar status.' }); }
});

app.put('/wms/ordens/:id/pausar', async (req, res) => {
  try {
    const ordem = await prisma.ordemTransferencia.update({ where: { id: req.params.id }, data: { status: 'Pendente', separadorId: null } });
    return res.json(ordem);
  } catch (error) { return res.status(500).json({ error: 'Erro ao pausar OS.' }); }
});

app.post('/wms/ordens/:id/concluir', async (req, res) => {
  try {
    const { usuarioId } = req.body; 
    const resultado = await prisma.$transaction(async (tx) => {
      const ordem = await tx.ordemTransferencia.findUnique({ where: { id: req.params.id }, include: { itens: true } });
      if (!ordem) throw new Error("Ordem não encontrada.");
      if (ordem.status === 'Concluída') throw new Error("Ordem já concluída.");

      for (const item of ordem.itens) {
        const estoqueExistente = await tx.estoque.findFirst({ where: { produtoId: item.produtoId, status: 'Disponível' } });
        let tipoAcaoAuditoria = 'Saída de mercadoria';
        let observacaoAuditoria = `OS Retirada #${ordem.codigo}`;

        if (ordem.tipo === 'ENTRADA' || ordem.tipo === 'DEVOLUCAO') {
          tipoAcaoAuditoria = ordem.tipo === 'ENTRADA' ? 'Entrada de mercadoria' : 'Devolução VIAPRO';
          observacaoAuditoria = `OS ${ordem.tipo === 'ENTRADA' ? 'Entrada' : 'Devolução'} #${ordem.codigo}`;
          if (estoqueExistente) {
            await tx.estoque.update({ where: { id: estoqueExistente.id }, data: { quantidade: { increment: item.quantidade } } });
          } else {
            await tx.estoque.create({ data: { produtoId: item.produtoId, quantidade: item.quantidade, status: 'Disponível' } });
          }
        } 
        else { 
          if (!estoqueExistente || estoqueExistente.quantidade < item.quantidade) {
            throw new Error(`Estoque insuficiente.`);
          }
          await tx.estoque.update({ where: { id: estoqueExistente.id }, data: { quantidade: { decrement: item.quantidade } } });
        }

        await tx.movimentacao.create({ data: { produtoId: item.produtoId, usuarioId: usuarioId, quantidade: item.quantidade, tipoAcao: tipoAcaoAuditoria, codigo: ordem.codigo, observacao: observacaoAuditoria } });
      }

      const ordemAtualizada = await tx.ordemTransferencia.update({ where: { id: ordem.id }, data: { status: 'Concluída', separadorId: usuarioId } });
      return ordemAtualizada;
    });

    return res.json(resultado);
  } catch (error: any) { return res.status(400).json({ error: error.message || 'Erro ao concluir.' }); }
});

const porta = process.env.PORT || 3333;
app.listen(porta, () => console.log(`🚀 Servidor ViaPro rodando na porta ${porta}`));