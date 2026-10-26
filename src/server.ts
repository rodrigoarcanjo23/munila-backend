import 'dotenv/config';
import { criarApp } from './app';

const porta = process.env.PORT || 3333;
criarApp().listen(porta, () => console.log(`🚀 Servidor ViaPro rodando na porta ${porta}`));
