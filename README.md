# 📦 ViaPro ERP - API (Back-end)

> Cérebro do sistema corporativo de Gestão de Armazém, Supply Chain e Inteligência Financeira.

Este repositório contém a API RESTful do sistema ViaPro. Construída em arquitetura monolítica focada em estabilidade e altíssima performance, ela é responsável por gerenciar regras de negócios críticas, trilhas de auditoria (Caixa Preta), disparos de e-mail e persistência de dados.

## 🚀 Tecnologias Utilizadas

* **Node.js & Express:** Roteamento e criação da API.
* **TypeScript:** Tipagem estática para maior segurança no código.
* **Prisma ORM:** Modelagem e comunicação simplificada com o banco de dados (PostgreSQL/SQLite).
* **Nodemailer:** Integração SMTP para disparo automático de e-mails de Pedidos de Compra para fornecedores.
* **Cors:** Segurança e liberação de acesso para o Web e Mobile.

## ⚙️ Regras de Negócio e Inteligência (Core)

O arquivo principal `src/server.ts` concentra rotas blindadas com validações rigorosas:
* **Prevenção de Duplicidade:** Bloqueio automático de cadastro de produtos com SKU ou Código de Barras já existentes.
* **Movimentação Inteligente:** Lógica avançada de inventário que processa Entradas, Saídas, Demonstrações e calcula automaticamente **Perdas e Avarias (Rupturas)**, isolando o saldo perdido.
* **Supply Chain:** Geração sequencial de códigos (ex: `PC000126`) e cálculo de caixa comprometido.
* **Auditoria (Caixa Preta):** Qualquer exclusão de produto ou usuário exige a gravação de um motivo e do responsável, criando um log inalterável no banco de dados.

## 🛠️ Como rodar o projeto localmente

1. Clone o repositório:
   ```bash
   git clone [https://github.com/rodrigoarcanjo23/controle-estoque-api.git](https://github.com/rodrigoarcanjo23/controle-estoque-api.git)
