import 'dotenv/config';
import { criarApp } from './app';
import { garantirArmazens } from './lib/estoque';

const porta = process.env.PORT || 3333;

// ✨ FASE 2: cria os armazéns iniciais (Munila e VIAPRO) e vincula o saldo antigo ao armazém padrão.
garantirArmazens()
  .catch(err => console.error('Não foi possível preparar os armazéns:', err?.message))
  .finally(() => criarApp().listen(porta, () => console.log(`🚀 Servidor ViaPro rodando na porta ${porta}`)));
