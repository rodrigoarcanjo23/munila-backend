import 'dotenv/config';
import { criarApp } from './app';
import { garantirArmazens } from './lib/estoque';
import { atualizarFichasRegistro, migrarTransformacaoAntiga } from './lib/tf';

const porta = process.env.PORT || 3333;

// ✨ FASE 2: cria os armazéns iniciais (Munila e VIAPRO) e vincula o saldo antigo ao armazém padrão.
garantirArmazens()
  .catch(err => console.error('Não foi possível preparar os armazéns:', err?.message))
  // ✨ FASE 6: leva os itens do módulo antigo de transformação para o novo razão auditável (uma vez só)
  .then(() => migrarTransformacaoAntiga().then(n => n && console.log(`Transformação: ${n} item(ns) migrado(s) do módulo antigo.`)))
  .catch(err => console.error('Não foi possível migrar a transformação antiga:', err?.message))
  // ✨ FASE 9: nomes oficiais dos produtos e 946 como produto único (uma vez só)
  .then(() => atualizarFichasRegistro().then(f => f.length && console.log(`Registro de transformação atualizado: ${f.join(', ')}.`)))
  .catch(err => console.error('Não foi possível atualizar as fichas do registro:', err?.message))
  .finally(() => criarApp().listen(porta, () => console.log(`🚀 Servidor ViaPro rodando na porta ${porta}`)));
