import express from 'express';
import cors from 'cors';
import { autenticar } from './lib/auth';
import { errorHandler } from './lib/http';
import authRoutes from './routes/auth.routes';
import cadastrosRoutes from './routes/cadastros.routes';
import produtosRoutes from './routes/produtos.routes';
import estoqueRoutes from './routes/estoque.routes';
import comprasRoutes from './routes/compras.routes';
import wmsRoutes from './routes/wms.routes';
import inventarioRoutes from './routes/inventario.routes';
import gerencialRoutes from './routes/gerencial.routes';
import fornecedorRoutes from './routes/fornecedor.routes';
import transformacaoRoutes from './routes/transformacao.routes';
import armazensRoutes from './routes/armazens.routes';
import financeiroRoutes from './routes/financeiro.routes';
import empresaRoutes from './routes/empresa.routes';
import biRoutes from './routes/bi.routes';
import pcpRoutes from './routes/pcp.routes';

export function criarApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, horario: new Date().toISOString() }));

  app.use(autenticar);

  // Todas as rotas antigas foram mantidas com o mesmo caminho e contrato (web e mobile continuam funcionando).
  app.use(authRoutes);          // /login, /me, /usuarios
  app.use(cadastrosRoutes);     // /categorias, /localizacoes
  app.use(produtosRoutes);      // /produtos, /produtos/busca, /produtos/:id/kardex
  app.use(estoqueRoutes);       // /estoque, /movimentacoes, /movimentacoes/operacao, /producao/executar, /logs-auditoria
  app.use(comprasRoutes);       // /pedidos-compra, /compras/sugestao, /recebimentos/nfe
  app.use(wmsRoutes);           // /wms/ordens
  app.use(inventarioRoutes);    // /inventarios
  app.use(gerencialRoutes);     // /dashboard/resumo, /dashboard/painel, /gerencial/*
  app.use(armazensRoutes);       // ✨ /armazens
  app.use(financeiroRoutes);     // ✨ /financeiro/*
  app.use(empresaRoutes);        // ✨ /empresa, /fiscal/pendencias
  app.use(biRoutes);             // ✨ /bi/painel
  app.use(pcpRoutes);            // ✨ /pcp/* (ordens de produção, plano mestre, MRP, recursos, fichas técnicas)
  app.use('/fornecedores', fornecedorRoutes);
  app.use('/transformacao', transformacaoRoutes);

  app.use((_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use(errorHandler);
  return app;
}
